mod adopt;
mod discovery;
mod launch;
mod paa_cli;
mod registry;
mod triggers;

use std::env;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::time::{Instant, MissedTickBehavior, interval};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use discovery::{Found, ScanEnv, VersionCache};
use registry::{FetchOutcome, Registry};
use triggers::{RescanGate, SleepWatch, TickAction, Trigger};

const DEFAULT_WS_URL: &str = "ws://127.0.0.1:8787/v1/broker/ws";
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
// heartbeat: ping を打つ間隔。discovery の再実行(runtime の後発インストール検知)も相乗りさせる。
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
// この間 何も受信しなければ(pong 含む)half-open とみなして接続を切って再接続させる。
const IDLE_TIMEOUT: Duration = Duration::from_secs(40);

/// 接続ごとに畳む tokio task。**drop で abort する**(PBI-0248 AC-X2)。`run_once` はどの
/// return 経路でもこの guard を通って抜けるので、古い接続の materialize が生き残って、
/// 再接続後の分と **二重に `atn adopt` を起こす**ことがない(上限 ADOPT_CONCURRENCY は
/// task ごとなので、task が 2 つ在れば 8 本立って上限を素通りする)。
///
/// abort で future が drop されると、走っていた `atn adopt` は `kill_on_drop(true)` で殺される
/// —— credential を書きかけた子を置き去りにしない。
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 接続を跨いで生きる状態(PBI-0022)。registry は cache / fetch で差し替わり、version cache は
/// scan の probe 結果を binary の mtime 単位で覚える(heartbeat ごとに `--version` を叩かない)。
struct BrokerState {
    registry: Registry,
    versions: Option<VersionCache>,
    registry_url: String,
    cache_dir: PathBuf,
    refresh: Duration,
    /// scan が見る場所(起動時に env から 1 回作る)。層 4 の hook が渡した dir をここへ足す。
    scan_env: ScanEnv,
    /// shell hook が教えてくれた「特殊な install 先」(PBI-0024 層 4)。FIFO で最大 8 件。
    hook_dirs: Vec<PathBuf>,
}

#[tokio::main]
async fn main() {
    // shell hook(層 4)の snippet を出すだけの経路。**broker は shell rc を書き換えない** ——
    // 貼るかどうかは人が決める。token を要求する前に処理する(install 直後でも使える)。
    if env::args().skip(1).any(|a| a == "--print-shell-hook") {
        print!("{}", triggers::SHELL_HOOK_ZSH);
        return;
    }

    let ws_url = env::var("PAA_BROKER_WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
    let token = match env::var("PAA_RUNTIME_TOKEN") {
        Ok(t) => t,
        Err(_) => {
            eprintln!("broker: PAA_RUNTIME_TOKEN is not set");
            std::process::exit(1);
        }
    };

    // Detector Registry(図18): cache を再検証して読む(無い / 改ざん → built-in)。
    let cache_dir = launch::broker_home();
    let registry = registry::load(&cache_dir);
    eprintln!("broker: registry = {} detectors={:?}", registry.origin, registry.ids());
    let registry_url =
        env::var("PAA_REGISTRY_URL").unwrap_or_else(|_| registry::registry_url_from_ws(&ws_url));
    let refresh = env::var("PAA_REGISTRY_REFRESH_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(registry::DEFAULT_REFRESH);
    let scan_env = ScanEnv::from_env();
    let hook_socket = cache_dir.join(triggers::HOOK_SOCKET_NAME);
    let mut state = BrokerState {
        registry,
        versions: Some(VersionCache::default()),
        registry_url,
        cache_dir,
        refresh,
        scan_env,
        hook_dirs: Vec::new(),
    };

    // 再スキャンのきっかけ(層 2 / 層 4)。`results_tx` と同じく **main 所有** にして接続を跨いで
    // 生かす —— 再接続のたびに watcher と listener を作り直すと、その隙間のイベントを落とす。
    let (trigger_tx, mut trigger_rx) = tokio::sync::mpsc::unbounded_channel::<Trigger>();
    // watcher は drop すると監視が止まるのでプロセス終了まで持つ(`_fs_watch` の束縛が要る)。
    let _fs_watch = triggers::spawn_fs_watch(
        &triggers::watch_dirs(&state.scan_env, triggers::MAX_WATCH_DIRS),
        trigger_tx.clone(),
    );
    tokio::spawn(triggers::serve_hook_socket(hook_socket, trigger_tx));

    // session_result(dedicated session の終了通知)を接続を跨いで運ぶ channel。
    // 送信端は各 reaper(child.wait() する tokio task)へ clone され、受信端は run_once の
    // select! が拾う。main で作るので spawn 後に切断・再接続しても結果は失われず、次の接続で
    // flush される(PBI-0019 図15)。
    let (results_tx, mut results_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    let mut backoff = INITIAL_BACKOFF;
    loop {
        // 接続が「どれだけ続いたか」を測る(PBI-0190 review)。clean close でも **すぐ切れた**なら
        // 障害として数える —— そうしないと handshake 直後に切る相手に 500ms 間隔で張り付き、
        // 1 周ごとの registry fetch と discovery scan で CPU と Cloud を焼く
        let started = Instant::now();
        let outcome = run_once(
            &ws_url,
            &token,
            &mut state,
            &results_tx,
            &mut results_rx,
            &mut trigger_rx,
        )
        .await;
        let lasted = started.elapsed();
        let clean = match &outcome {
            Ok(()) => {
                eprintln!("broker: connection closed");
                true
            }
            Err(e) => {
                eprintln!("broker: connection error: {e}");
                false
            }
        };
        // clean close の即時リセットは「実際に繋がっていた接続」だけに効かせる(triggers.rs)。
        // 短命な接続は Err と同じく倍化する —— 判定は純関数 1 つに集約して test で固定する
        let (wait, next) =
            triggers::reconnect_wait(backoff, clean, lasted, INITIAL_BACKOFF, MAX_BACKOFF);
        backoff = next;
        eprintln!("broker: connection lasted {lasted:?}; reconnecting in {wait:?}");
        tokio::time::sleep(wait).await;
    }
}

/// registry を Cloud から取得する(図18: 接続確立ごと + refresh 間隔)。blocking の HTTP は
/// spawn_blocking へ逃がす。検証 OK の時だけ state.registry を差し替える。
async fn refresh_registry(state: &mut BrokerState) {
    let url = state.registry_url.clone();
    let cache_dir = state.cache_dir.clone();
    let etag = registry::cached_etag(&cache_dir);
    let outcome = tokio::task::spawn_blocking(move || {
        registry::fetch_and_store(&url, &cache_dir, etag.as_deref())
    })
    .await
    .unwrap_or_else(|e| FetchOutcome::Failed(format!("task: {e}")));
    match outcome {
        FetchOutcome::NotModified => eprintln!("broker: registry 304 (cache kept)"),
        FetchOutcome::Updated(reg) => {
            eprintln!(
                "broker: registry updated issued_at={} detectors={:?}",
                reg.issued_at,
                reg.ids()
            );
            state.registry = reg;
        }
        FetchOutcome::Rejected(e) => {
            eprintln!("broker: registry signature mismatch ({e}). Discarded; keeping the current registry ({})", state.registry.origin)
        }
        FetchOutcome::Failed(e) => {
            eprintln!("broker: registry fetch failed {e}. Keeping the current registry ({})", state.registry.origin)
        }
    }
}

/// scan を blocking task で回す(version probe が最大 3s block しうるため WS ループを止めない)。
/// 層 4 の hook が教えてくれた dir(`hook_dirs`)を固定 dir の後ろに足して見る —— これが無いと
/// 「どの scan dir にも無い場所に install された binary」は結局見つからない(要件 §45.3 層 4)。
async fn scan_now(state: &mut BrokerState) -> Vec<Found> {
    let reg = state.registry.clone();
    let mut cache = state.versions.take().unwrap_or_default();
    let mut env = state.scan_env.clone();
    env.extra_dirs.extend(state.hook_dirs.iter().cloned());
    let (found, cache) = tokio::task::spawn_blocking(move || {
        let found = discovery::scan(&reg, &env, &mut cache);
        (found, cache)
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), VersionCache::default()));
    state.versions = Some(cache);
    found
}

fn hello_message(found: &[Found]) -> String {
    json!({ "type": "hello", "runtimes": found }).to_string()
}

/// **再スキャンの合流点**(図18)。T0 / heartbeat / registry 更新 / 層 2・4 の trigger は全部ここへ
/// 来る。差分が無ければ何も送らない(hello を毎 tick 送らない — PBI-0023 AC-9)。
///
/// ここ 1 箇所に集約してあるのが要点: きっかけが 5 つに増えても「scan → 差分判定 → hello」の
/// 書き方は 1 通りしか無い。
async fn rescan_and_hello<S>(
    write: &mut S,
    state: &mut BrokerState,
    known: &mut Vec<Found>,
) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let current = scan_now(state).await;
    if current == *known {
        return Ok(());
    }
    *known = current;
    eprintln!("broker: discovery updated = {}", serde_json::to_string(known).unwrap_or_default());
    write
        .send(Message::Text(hello_message(known).into()))
        .await
        .map_err(|e| format!("hello send failed: {e}"))
}

/// 1 回分の接続ライフサイクル(接続 → registry 取得 → scan → hello → 受信ループ)。
/// 戻り値が Ok/Err どちらでも呼び出し元(main)が backoff 付きで再接続する(図15 B3-B4)。
///
/// `results_tx`/`results_rx` は session_result を運ぶ mpsc(main 所有・接続を跨いで生存)。
/// reaper への clone 元と、select! での受信に使う。
async fn run_once(
    ws_url: &str,
    token: &str,
    state: &mut BrokerState,
    results_tx: &tokio::sync::mpsc::UnboundedSender<Value>,
    results_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    trigger_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Trigger>,
) -> Result<(), String> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("invalid url: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|e| format!("invalid token header: {e}"))?,
    );

    let (ws_stream, _resp) = connect_async(request)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    eprintln!("broker: connected");

    let (mut write, mut read) = ws_stream.split();

    // 接続確立ごとに registry を取り直す(= 再起動と同じ fetch 経路。図18 T0)。
    refresh_registry(state).await;

    let mut known_runtimes = scan_now(state).await;
    eprintln!("broker: discovery = {}", serde_json::to_string(&known_runtimes).unwrap_or_default());
    write
        .send(Message::Text(hello_message(&known_runtimes).into()))
        .await
        .map_err(|e| format!("hello send failed: {e}"))?;

    // materialize(`registered` → `atn adopt`)は **WS ループの外**で回す(PBI-0248)。
    // 同時実行に上限を入れた(PBI-0235)結果、ループの中で待つと停止時間が
    // `ceil(件数 / ADOPT_CONCURRENCY) × ADOPT_TIMEOUT` まで伸びる。IDLE_TIMEOUT(40 秒)を
    // 跨ぐと接続が落ちて次の hello からやり直しになり、PBI-0190 で塞いだばかりの
    // 「再接続が増える口」を別の理由で開けてしまう。
    //
    // worker は **1 本**で、batch を 1 通ずつ順に処理する。ここが要点:
    //   - 上限 4 が接続全体で 1 つになる(`registered` が 2 通来ても 8 本立たない)
    //   - 同じ runtime_id が 2 通に居ても `atn adopt` が 2 本同時に立たない
    // 通ごとに task を起こすと、この 2 つが両方とも壊れる。
    let (adopt_tx, mut adopt_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<adopt::Adoption>>();
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    // 送信端をこの関数でも 1 本持つ。worker が消えても `ack_rx.recv()` が None を返し続けて
    // select! が空回りしない(500ms で張り付く hot loop と同じ形を作らない。PBI-0190)。
    let _ack_keepalive = ack_tx.clone();
    let _materialize = AbortOnDrop(tokio::spawn(async move {
        while let Some(batch) = adopt_rx.recv().await {
            adopt::adopt_all(&batch, &ack_tx).await;
        }
    }));

    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await; // 起動直後の即時 tick を消費(hello 直後にすぐ ping しない)
    let mut registry_tick = interval(state.refresh);
    registry_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    registry_tick.tick().await; // 接続直後は上で取得済み
    let mut last_activity = Instant::now();
    // 層 3 / 合流点の状態は接続ごとに作り直してよい(sleep 復帰は再接続で解決するので、
    // 再接続直後の基準時刻がその接続の起点になる)。
    let mut sleep_watch = SleepWatch::new(Instant::now().into_std(), SystemTime::now(), triggers::SLEEP_SKEW);
    let mut rescan_gate = RescanGate::default();

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                // 層 3(PBI-0024): sleep から復帰していたら **再接続** する。`last_activity` も
                // 単調時計なので、長時間 sleep 後は idle 判定が決して発火せず、死んだ TCP へ
                // ping を打ち続ける。再接続すれば T0 が registry 取得と scan を両方やり直す。
                let woke = sleep_watch.woke(Instant::now().into_std(), SystemTime::now());
                match triggers::heartbeat_action(last_activity.elapsed(), IDLE_TIMEOUT, woke) {
                    TickAction::Reconnect(reason) => return Err(reason.to_string()),
                    TickAction::Rescan => {}
                }
                // discovery を再実行し、起動後にインストールされた runtime を拾う(図15/図18)。
                rescan_and_hello(&mut write, state, &mut known_runtimes).await?;
                write
                    .send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|e| format!("ping send failed: {e}"))?;
            }
            _ = registry_tick.tick() => {
                // 定期取得(既定 6h)。差し替わったら scan し直して差分があれば hello。
                refresh_registry(state).await;
                rescan_and_hello(&mut write, state, &mut known_runtimes).await?;
            }
            // 層 2 / 層 4(PBI-0024): fs watch と shell hook。嵐(`brew install` の数十イベント /
            // prompt ごとの hook)を潰すのはここ 1 箇所。
            Some(first) = trigger_rx.recv() => {
                let mut batch = vec![first];
                while let Ok(t) = trigger_rx.try_recv() {
                    batch.push(t);
                }
                let (rescan, new_dir) =
                    triggers::absorb(&state.registry, &mut state.hook_dirs, &batch);
                // 新しい dir が増えた時だけ throttle を無視する(その dir はまだ一度も見ていない)。
                // **落とす判断を debounce より先に**やる —— socket を連打された時に受信ループが
                // sleep で止まり続けないため。落とした分は heartbeat(15s)が拾う。
                // 判定は `triggers::should_scan` に集約(gate.allow を必ず呼ぶ理由はそこのコメント。
                // 独立レビューで見つかった bug: PBI-0024 AC-14)。
                if triggers::should_scan(
                    rescan,
                    new_dir,
                    &mut rescan_gate,
                    Instant::now().into_std(),
                    triggers::RESCAN_MIN_GAP,
                ) {
                    // burst を 1 回の scan にまとめる。
                    tokio::time::sleep(triggers::RESCAN_DEBOUNCE).await;
                    let mut more = Vec::new();
                    while let Ok(t) = trigger_rx.try_recv() {
                        more.push(t);
                    }
                    triggers::absorb(&state.registry, &mut state.hook_dirs, &more);
                    eprintln!("broker: trigger rescan n={}", batch.len() + more.len());
                    rescan_and_hello(&mut write, state, &mut known_runtimes).await?;
                }
            }
            msg = read.next() => {
                let Some(msg) = msg else { return Ok(()); };
                let msg = msg.map_err(|e| format!("recv error: {e}"))?;
                last_activity = Instant::now();
                let Message::Text(text) = msg else { continue };
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // 自動登録(PBI-0023 図18): Cloud が hello の応答で credential を返してきた。
                // kind ごとに `atn adopt` を起こして materialize し、1 件ごとに register_ack を
                // 返す(Cloud は ok:false の行を revoke して次の hello で再試行させる)。
                // 同時実行数は ADOPT_CONCURRENCY で頭打ち(PBI-0235) —— 件数は Cloud が決めるので、
                // 上限が無いと 1000 件の registered が端末で 1000 個の子プロセスになる。
                //
                // **ここでは待たない**(PBI-0248): worker へ渡してすぐ次の frame に戻る。
                // ack は 1 件終わるごとに `ack_rx` から戻ってきて、下の枝が現在の接続へ送る。
                if parsed.get("type").and_then(Value::as_str) == Some("registered") {
                    let adoptions = adopt::parse_registered(&parsed);
                    eprintln!(
                        "broker: received registered count={} concurrency={}",
                        adoptions.len(),
                        adopt::ADOPT_CONCURRENCY
                    );
                    let _ = adopt_tx.send(adoptions);
                    continue;
                }
                if parsed.get("type").and_then(Value::as_str) != Some("wake") {
                    continue;
                }
                let runtime = parsed.get("runtime").and_then(Value::as_str).unwrap_or("");
                let request_id = parsed
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                // Manual routing(§20.1)の New/Existing。欠落時は "new" 扱い
                // (Cloud が旧 payload を送ってきても既存 session へ注入しない安全側)。
                let session_mode = parsed
                    .get("sessionMode")
                    .and_then(Value::as_str)
                    .unwrap_or("new");
                // AUTO の dedicated session(PBI-0019)は instruction を持つ。空/欠落なら
                // Manual routing の bare spawn 経路(launch)。
                let instruction = parsed
                    .get("instruction")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                eprintln!(
                    "broker: received wake runtime={runtime} sessionMode={session_mode} \
                     requestId={request_id} dedicated={}",
                    instruction.is_some()
                );
                // 外部 API provider(PBI-0070)は端末に binary を持たない —— `atn agent` を
                // PAA_CLI で起こす。返信先の thread は wake payload の threadId から来る
                let thread_id = parsed.get("threadId").and_then(Value::as_str).unwrap_or("");
                // triage session の scope token(EP-0013 W3 / PBI-0117)。有る時だけ dedicated
                // session の子 env `PAA_SESSION_SCOPE` へ載る(API provider 経路には載せない —
                // scope は CLI runtime の dedicated session だけが運ぶ v1)。
                let scope_token = parsed
                    .get("scopeToken")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let is_api = state
                    .registry
                    .detector(runtime)
                    .map(|d| d.kind == "api")
                    .unwrap_or(false);
                let launch_result = if is_api {
                    launch::launch_api_env(&state.registry, runtime, thread_id)
                } else {
                    match instruction {
                        Some(instr) => launch::launch_session_scoped(&state.registry, &known_runtimes, runtime, instr, request_id, scope_token),
                        None => launch::launch(&state.registry, &known_runtimes, runtime, session_mode),
                    }
                };
                let response = match launch_result {
                    Ok(child) => {
                        // reaper: 子の終了を待って session_result を送る(zombie 回収も兼ねる)。
                        // Manual routing の bare spawn も同じ reaper を通す —— session_result は
                        // Cloud 側で active session の requestId と一致した時だけ作用するので、
                        // Manual(active 未登録)の分は無視される(無害・経路を一本化)。
                        let tx = results_tx.clone();
                        let rid = request_id.to_string();
                        let mut child = child;
                        tokio::spawn(async move {
                            let exit_code = match child.wait().await {
                                // signal 終了は code() が None → JSON null
                                Ok(status) => status.code(),
                                Err(_) => None,
                            };
                            let _ = tx.send(json!({
                                "type": "session_result",
                                "requestId": rid,
                                "exit_code": exit_code,
                            }));
                        });
                        json!({ "type": "wake_result", "requestId": request_id, "ok": true })
                    }
                    Err(reason) => json!({
                        "type": "wake_result",
                        "requestId": request_id,
                        "ok": false,
                        "reason": reason,
                    }),
                };
                write
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .map_err(|e| format!("wake_result send failed: {e}"))?;
            }
            maybe_ack = ack_rx.recv() => {
                // keepalive を持っているので None は来ない。来たら worker が消えた証なので、
                // 空回りさせずに接続を作り直す。
                let Some(ack) = maybe_ack else {
                    return Err("materialize worker gone".to_string());
                };
                // last_activity は **受信** の時計なので、自分の送信では更新しない
                // (session_result と同じ理由。PBI-0033)
                write
                    .send(Message::Text(ack.to_string().into()))
                    .await
                    .map_err(|e| format!("register_ack send failed: {e}"))?;
            }
            maybe_result = results_rx.recv() => {
                // main で作った channel は tx が生きている限り閉じないが、念のため None を扱う。
                let Some(result) = maybe_result else { return Ok(()); };
                // last_activity は **受信** を根拠に half-open connection を検出する時計なので、
                // 自分の送信(session_result)では更新しない(PBI-0033)。half-open では送信だけが
                // 成功しうるため、ここで更新すると 40 秒の idle 検出がその分だけ遅れる。
                if let Err(e) = write.send(Message::Text(result.to_string().into())).await {
                    // 送信失敗 = 接続が壊れている。結果を channel 末尾へ戻して次の接続で flush する
                    // (spawn 後に切断していても session 終了通知を落とさない。図15)。
                    let _ = results_tx.send(result);
                    return Err(format!("session_result send failed: {e}"));
                }
            }
        }
    }
}
