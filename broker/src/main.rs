mod adopt;
mod c1;
mod discovery;
mod egress;
mod env_compat;
mod launch;
#[macro_use]
mod log;
mod openroly_cli;
mod procgroup;
mod profiles;
mod registry;
mod sandbox;
mod sessions;
mod sync;
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
use sync::CliJob;
use triggers::{RescanGate, SleepWatch, TickAction, Trigger};

const DEFAULT_WS_URL: &str = "ws://127.0.0.1:8787/v1/broker/ws";
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
// heartbeat / idle / connect の 3 つは `triggers::Timings`(knob は heartbeat 1 つ)。

/// 接続ごとに畳む tokio task。**drop で abort する**(PBI-0248 AC-X2)。`run_once` はどの
/// return 経路でもこの guard を通って抜けるので、古い接続の materialize が生き残って、
/// 再接続後の分と **二重に `openroly adopt` を起こす**ことがない(上限 ADOPT_CONCURRENCY は
/// task ごとなので、task が 2 つ在れば 8 本立って上限を素通りする)。
///
/// abort で future が drop されると、走っていた `openroly adopt` は `kill_on_drop(true)` で殺される
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
    /// 閉じ込めの土台(PBI-0238 / 図72)。起動時の self_test に通った backend。通らなかった機は
    /// `NoSandbox` に差し替えてあり、全 dedicated wake が `sandbox_unavailable` になる。
    sandbox: Box<dyn sandbox::SandboxBackend>,
    /// C1(PBI-0441 ③)の在り無し。起動時に 1 回決め、hello の runtime 別 enforcement と
    /// dedicated session の閉じ込め(専用 uid + pf)に使う。setup していない機では `available: false`。
    c1: c1::C1Status,
    /// OpenRoly server の host(ws url から)。egress allowlist に足す(MCP が Cloud に繋ぐ先)。
    server_host: String,
    /// user の HOME。sandbox の deny_read / writable_extra の既定に使う(env は起動時に 1 回だけ読む)。
    user_home: PathBuf,
    /// 「いま動いている session」の正本(PBI-0229)。child の handle を持ち、admission / cancel /
    /// presence(hello の sessions 一覧)は全部ここから出る。**main 所有** で接続を跨いで生存
    /// (切断しても session は動き続ける —— 再接続直後の hello が snapshot を運ぶ)。
    sessions: sessions::Sessions,
}

#[tokio::main]
async fn main() {
    // shell hook(層 4)の snippet を出すだけの経路。**broker は shell rc を書き換えない** ——
    // 貼るかどうかは人が決める。token を要求する前に処理する(install 直後でも使える)。
    if env::args().skip(1).any(|a| a == "--print-shell-hook") {
        print!("{}", triggers::SHELL_HOOK_ZSH);
        return;
    }

    let ws_url =
        env_compat::env_new_or_legacy("OPENROLY_BROKER_WS_URL").unwrap_or_else(|| DEFAULT_WS_URL.to_string());
    let token = match env_compat::env_new_or_legacy("OPENROLY_RUNTIME_TOKEN") {
        Some(t) => t,
        None => {
            blog!("OPENROLY_RUNTIME_TOKEN is not set");
            std::process::exit(1);
        }
    };

    // Detector Registry(図18): cache を再検証して読む(無い / 改ざん → built-in)。
    let cache_dir = launch::broker_home();
    let registry = registry::load(&cache_dir);
    blog!("registry = {} detectors={:?}", registry.origin, registry.ids());
    let registry_url = env_compat::env_new_or_legacy("OPENROLY_REGISTRY_URL")
        .unwrap_or_else(|| registry::registry_url_from_ws(&ws_url));
    let refresh = env_compat::env_new_or_legacy("OPENROLY_REGISTRY_REFRESH_SECS")
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(registry::DEFAULT_REFRESH);
    let scan_env = ScanEnv::from_env();
    let hook_socket = cache_dir.join(triggers::HOOK_SOCKET_NAME);
    // 閉じ込めの土台(PBI-0238 / 図72): backend を決めて self_test(4 probe)。1 つでも落ちれば
    // **全 dedicated wake を断る**(丸腰で起こさない)。結果は stderr と doctor(status file)に出す。
    let sandbox = sandbox::backend();
    let sandbox_status = sandbox.self_test().map(|()| sandbox.name());
    let sandbox: Box<dyn sandbox::SandboxBackend> = match &sandbox_status {
        Ok(name) => {
            eprintln!("broker: sandbox: {name} ok");
            sandbox
        }
        Err(reason) => {
            eprintln!(
                "broker: sandbox: unavailable({reason}) — every dedicated session will be refused \
                 with sandbox_unavailable until this is fixed"
            );
            Box::new(sandbox::NoSandbox { reason: reason.clone() })
        }
    };
    let egress_check = std::net::TcpListener::bind("127.0.0.1:0")
        .map(|_| ())
        .map_err(|e| format!("loopback bind failed: {e}"));
    // C1(PBI-0441 ③): claude の dedicated session を専用 uid + pf で loopback egress だけに閉じられるか。
    // setup していない機(既定)は unavailable = claude も `port_scoped` のまま(正直な床)。
    // **write_status より前に決める** —— doctor が読む status file に runtime 別の表を載せるため。
    let c1 = c1::detect();
    if c1.available {
        eprintln!("broker: c1: available (claude dedicated sessions can be host-scoped)");
    } else {
        eprintln!("broker: c1: unavailable ({}) — claude egress stays port-scoped", c1.reason);
    }
    let raised = c1::raised_by_runtime(sandbox.egress_enforcement(), &c1);
    // PBI-0331 AC-X3: 同じ backend 名でも kernel ごとに掛かる壁が違う(Landlock の ABI)。self_test 落ちなら
    // NoSandbox に差し替わっているので None
    let strength = sandbox.strength();
    if let Some(s) = &strength {
        eprintln!("broker: sandbox strength: {s}");
    }
    sandbox::write_status(
        &cache_dir,
        &sandbox_status,
        &egress_check,
        sandbox.egress_enforcement(),
        &raised,
        strength.as_deref(),
    );
    let server_host = ws_url
        .parse::<http::Uri>()
        .ok()
        .and_then(|u| u.host().map(|h| h.to_string()))
        .unwrap_or_default();
    let user_home = PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    let mut state = BrokerState {
        registry,
        versions: Some(VersionCache::default()),
        registry_url,
        cache_dir,
        refresh,
        scan_env,
        hook_dirs: Vec::new(),
        sandbox,
        c1,
        server_host,
        user_home,
        sessions: sessions::Sessions::new(sessions::tool_cap_from_env(
            env_compat::env_new_or_legacy("OPENROLY_SESSION_TOOL_CAP").as_deref(),
        )),
    };

    // 再スキャンのきっかけ(層 2 / 層 4)。`results_tx` と同じく **main 所有** にして接続を跨いで
    // 生かす —— 再接続のたびに watcher と listener を作り直すと、その隙間のイベントを落とす。
    let (trigger_tx, mut trigger_rx) = tokio::sync::mpsc::unbounded_channel::<Trigger>();
    // watcher は drop すると監視が止まるのでプロセス終了まで持つ(`_fs_watch` の束縛が要る)。
    let _fs_watch = triggers::spawn_fs_watch(
        &triggers::watch_dirs(&state.scan_env, triggers::MAX_WATCH_DIRS),
        trigger_tx.clone(),
    );

    // session_result / session_update を接続を跨いで運ぶ channel。
    // 送信端は reaper(PBI-0229。child の exit を拾う)と hook socket(MCP の tool 記録)へ
    // clone され、受信端は run_once の select! が拾う。main で作るので spawn 後に切断・
    // 再接続しても結果は失われず、次の接続で flush される(PBI-0019 図15)。
    let (results_tx, mut results_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    // session の reaper(PBI-0229)。registry が持つ child の exit を 250ms 間隔の `try_wait`
    // で拾って `session_result` を channel へ流す。per-child の wait task にしない理由は
    // child の handle を registry が持つため(admission の生存判定と cancel がここに集約される)。
    state.sessions.spawn_reaper(results_tx.clone());

    // hook socket への引数はこの順序でないと作れない(results_tx が要る)ので、channel の後。
    // JSON 行への答え(status / cancel / tool)はここで束ねる —— triggers.rs は I/O だけを持ち、
    // crate:: を持たない(src を `#[path]` で取り込む攻撃 test crate でも compile できるように)
    let sessions_for_hook = state.sessions.clone();
    let results_for_hook = results_tx.clone();
    tokio::spawn(triggers::serve_hook_socket(hook_socket, trigger_tx, std::sync::Arc::new(move |v, now_ms| {
        sessions::handle_hook_json(&sessions_for_hook, &results_for_hook, v, now_ms, adopt::ADOPT_CONCURRENCY)
    })));

    let timings =
        triggers::timings_from_env(env_compat::env_new_or_legacy("OPENROLY_BROKER_HEARTBEAT_MS").as_deref());
    blog!(
        "timings heartbeat={:?} idle={:?} connect={:?}",
        timings.heartbeat,
        timings.idle,
        timings.connect
    );

    let mut backoff = INITIAL_BACKOFF;
    // 直前の接続が **どう終わったか**。次に繋がった時の hello で名乗る(AC-4)。
    let mut failure = LastFailure::default();
    loop {
        // 接続が「どれだけ続いたか」を測る(PBI-0190 review)。clean close でも **すぐ切れた**なら
        // 障害として数える —— そうしないと handshake 直後に切る相手に 500ms 間隔で張り付き、
        // 1 周ごとの registry fetch と discovery scan で CPU と Cloud を焼く
        let started = Instant::now();
        // **試行そのものを必ず書く**(AC-2)。以前は失敗した時しか行が出ず、
        // 「黙っている = 諦めた」のか「黙っている = 健全に繋がっている」のかを log から
        // 区別できなかった(PBI-0277 の調査で実際に詰まった点)
        blog!("connecting to {ws_url} (consecutive failures={})", failure.attempts);
        let outcome = run_once(
            &ws_url,
            &token,
            &mut state,
            &results_tx,
            &mut results_rx,
            &mut trigger_rx,
            timings,
            &failure,
        )
        .await;
        let lasted = started.elapsed();
        let clean = match &outcome {
            Ok(()) => {
                blog!("connection closed");
                true
            }
            Err(e) => {
                blog!("connection error: {e}");
                false
            }
        };
        // **繋がった接続だけが失敗の履歴を消す**。connect に失敗した周は attempts を積む ——
        // これが web の「Offline の間に何が起きていたか」の中身になる(AC-3/AC-4)
        if lasted >= triggers::MIN_HEALTHY_CONNECTION {
            failure = LastFailure::default();
        } else {
            failure.attempts = failure.attempts.saturating_add(1);
            failure.reason = outcome.err().or(Some("closed immediately".to_string()));
        }
        // clean close の即時リセットは「実際に繋がっていた接続」だけに効かせる(triggers.rs)。
        // 短命な接続は Err と同じく倍化する —— 判定は純関数 1 つに集約して test で固定する
        let (wait, next) =
            triggers::reconnect_wait(backoff, clean, lasted, INITIAL_BACKOFF, MAX_BACKOFF);
        backoff = next;
        blog!("connection lasted {lasted:?}; reconnecting in {wait:?}");
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
        FetchOutcome::NotModified => blog!("registry 304 (cache kept)"),
        FetchOutcome::Updated(reg) => {
            blog!(
                "registry updated issued_at={} detectors={:?}",
                reg.issued_at,
                reg.ids()
            );
            state.registry = reg;
        }
        FetchOutcome::Rejected(e) => {
            blog!("registry signature mismatch ({e}). Discarded; keeping the current registry ({})", state.registry.origin)
        }
        FetchOutcome::Failed(e) => {
            blog!("registry fetch failed {e}. Keeping the current registry ({})", state.registry.origin)
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
        let mut found = discovery::scan(&reg, &env, &mut cache);
        // runtime profile / local catalog(PBI-0211)。scan の結果に端末の file を重ねる
        profiles::merge(&reg, profiles::state_dir().as_deref(), &env, &mut found);
        (found, cache)
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), VersionCache::default()));
    state.versions = Some(cache);
    found
}

/// 接続が **どう終わったか** を次の接続へ運ぶ(PBI-0277 AC-4)。切れている間 broker は Cloud へ
/// 何も言えないので、owner の画面に理由を出す道は「次に繋がった時に名乗る」しか無い。
#[derive(Debug, Default, Clone)]
struct LastFailure {
    /// 直近の失敗理由(`tls handshake eof` / `no native root CA certificates found` など)
    reason: Option<String>,
    /// 連続で失敗した回数(繋がったら 0 に戻す)
    attempts: u32,
}

/// `last_failure` は **接続確立直後の 1 通目にだけ** 載せる(以後の差分 hello は None)。
/// sessions(PBI-0229)は逆に **毎回** 載せる —— これが server 側 cache の reconcile の正本。
/// 旧 server は未知の key を読まないので互換は壊れない。capacity.max は dedicated session の
/// 同時実行上限(adopt と同じ ADOPT_CONCURRENCY)。`egress_enforcement` は sandbox backend が
/// 名乗る値(PBI-0441)で、毎回載せる(server は hello ごとに写し直す)。
fn hello_message(
    found: &[Found],
    last_failure: Option<&LastFailure>,
    sessions: &sessions::Sessions,
    egress_enforcement: &str,
    egress_by_runtime: &[(&str, &str)],
) -> String {
    let mut msg = json!({ "type": "hello", "runtimes": found, "egress_enforcement": egress_enforcement });
    // 床より上げた runtime だけの表(C1。PBI-0441 ③)。**上げる物が無ければ key ごと出さない** ——
    // その時の wire は旧 broker と 1 byte も変わらない(server / web / CLI は無改修で今までどおり)
    if !egress_by_runtime.is_empty() {
        msg["egress_enforcement_by_runtime"] = Value::Object(
            egress_by_runtime.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect(),
        );
    }
    let (live, capacity) = sessions.hello_snapshot(adopt::ADOPT_CONCURRENCY);
    msg["sessions"] = live;
    msg["capacity"] = capacity;
    if let Some(f) = last_failure.filter(|f| f.attempts > 0) {
        msg["last_error"] = json!(f.reason.as_deref().unwrap_or("unknown"));
        msg["failed_attempts"] = json!(f.attempts);
    }
    msg.to_string()
}

/// hello に載せる「床」と「床より上げた runtime の表」(PBI-0441 ③)。**2 箇所で同じ組み方をしない** ——
/// 片方だけ直すと、接続直後の 1 通目と差分 hello が違う値を名乗る。
fn egress_advert(state: &BrokerState) -> (&'static str, Vec<(&'static str, &'static str)>) {
    let floor = state.sandbox.egress_enforcement();
    (floor, c1::raised_by_runtime(floor, &state.c1))
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
    blog!("discovery updated = {}", serde_json::to_string(known).unwrap_or_default());
    let (floor, raised) = egress_advert(state);
    write
        .send(Message::Text(hello_message(known, None, &state.sessions, floor, &raised).into()))
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
    timings: triggers::Timings,
    failure: &LastFailure,
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

    // **上限を付ける**(AC-2): TCP は繋がるが TLS handshake が返らない相手(黒穴・落ちかけた
    // proxy)に当たると、`connect_async` は永久に pending になる。await が返らない以上
    // 再接続の loop は 1 周も回らず、log にも何も出ない —— 外から見ると「黙って止まった」。
    let (ws_stream, _resp) = match tokio::time::timeout(timings.connect, connect_async(request)).await
    {
        Ok(r) => r.map_err(|e| format!("connect failed: {e}"))?,
        Err(_) => return Err(format!("connect timed out after {:?}", timings.connect)),
    };
    blog!("connected");

    let (mut write, mut read) = ws_stream.split();

    // 接続確立ごとに registry を取り直す(= 再起動と同じ fetch 経路。図18 T0)。
    refresh_registry(state).await;

    let mut known_runtimes = scan_now(state).await;
    blog!("discovery = {}", serde_json::to_string(&known_runtimes).unwrap_or_default());
    let (floor, raised) = egress_advert(state);
    write
        .send(Message::Text(hello_message(&known_runtimes, Some(failure), &state.sessions, floor, &raised).into()))
        .await
        .map_err(|e| format!("hello send failed: {e}"))?;

    // materialize(`registered` → `openroly adopt`)は **WS ループの外**で回す(PBI-0248)。
    // 同時実行に上限を入れた(PBI-0235)結果、ループの中で待つと停止時間が
    // `ceil(件数 / ADOPT_CONCURRENCY) × ADOPT_TIMEOUT` まで伸びる。IDLE_TIMEOUT(40 秒)を
    // 跨ぐと接続が落ちて次の hello からやり直しになり、PBI-0190 で塞いだばかりの
    // 「再接続が増える口」を別の理由で開けてしまう。
    //
    // worker は **1 本**で、batch を 1 通ずつ順に処理する。ここが要点:
    //   - 上限 4 が接続全体で 1 つになる(`registered` が 2 通来ても 8 本立たない)
    //   - 同じ runtime_id が 2 通に居ても `openroly adopt` が 2 本同時に立たない
    // 通ごとに task を起こすと、この 2 つが両方とも壊れる。
    let (adopt_tx, mut adopt_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<adopt::Adoption>>();
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    // 送信端は **worker だけが持つ**(PBI-0248 review)。この関数でも clone を握ると
    // `ack_rx.recv()` は永久に pending になり、下の「worker が消えた」枝が **到達不能な死んだ
    // 枝**になる —— worker が panic しても誰も気付かず、以後の `registered` は全部
    // 黙って捨てられ `register_ack` が二度と返らない(接続は heartbeat で生き続けるので
    // 外からは正常に見える)。None を 1 回受けたら即 return するので空回りもしない。
    let _materialize = AbortOnDrop(tokio::spawn(async move {
        while let Some(batch) = adopt_rx.recv().await {
            // `local-*`(PBI-0211)は端末の catalog.local.json の native を添える(server は native を持たない)
            let dir = profiles::state_dir();
            let batch: Vec<adopt::Adoption> =
                batch.iter().cloned().map(|a| profiles::with_local_native(a, dir.as_deref())).collect();
            adopt::adopt_all(&batch, &ack_tx).await;
        }
    }));

    // 常時同期の CLI worker(PBI-0213 / 図18)。`openroly sync` / `openroly share --auto` を起こす口は
    // **ここ 1 本**で、materialize と同じく WS ループの外に置く —— `openroly sync` は全 runtime 分の
    // CLI を呼ぶので、ループの中で待つと `IDLE_TIMEOUT` を跨いで接続が落ちる(PBI-0248 の型)。
    let (cli_tx, cli_rx) = tokio::sync::mpsc::unbounded_channel::<CliJob>();
    let cli_argv = openroly_cli::cli_argv();
    let _cli_worker = AbortOnDrop(tokio::spawn(sync::run_cli_worker(
        cli_argv,
        sync::CLI_TIMEOUT,
        sync::NATIVE_POLL,
        cli_rx,
    )));
    // T0: 接続確立の直後に両方向を 1 回ずつ(AC-5 —— 切れている間に web で足された物はここで載り、
    // 切れている間に端末へ入れた物はここで提案に上がる)
    let _ = cli_tx.send(CliJob::Sync);
    let _ = cli_tx.send(CliJob::Share);

    let mut heartbeat = interval(timings.heartbeat);
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
                match triggers::heartbeat_action(last_activity.elapsed(), timings.idle, woke) {
                    TickAction::Reconnect(reason) => return Err(reason.to_string()),
                    TickAction::Rescan => {}
                }
                // discovery を再実行し、起動後にインストールされた runtime を拾う(図15/図18)。
                rescan_and_hello(&mut write, state, &mut known_runtimes).await?;
                // **WS の Ping ではなく application frame を打つ**(PBI-0277 AC-X1)。
                // WS の Pong は socket が開いてさえいれば返る —— Cloud 側が「この接続はもう
                // 自分の registry に居ない」(後から来た接続に上書きされた / 別 instance が
                // 応答している)状態でも返る。実測(2026-09-05)ではそれで **5 時間**、
                // process も TCP も生きたまま hello だけが捨てられ、web は Offline のまま
                // 黙っていた。「相手の application が自分を知っている」ことだけを生存の証拠にする。
                write
                    .send(Message::Text(json!({ "type": "ping" }).to_string().into()))
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
                    blog!("trigger rescan n={}", batch.len() + more.len());
                    rescan_and_hello(&mut write, state, &mut known_runtimes).await?;
                }
            }
            msg = read.next() => {
                let Some(msg) = msg else { return Ok(()); };
                let msg = msg.map_err(|e| format!("recv error: {e}"))?;
                let Message::Text(text) = msg else { continue };
                // **生存の時計は application frame だけで進める**(PBI-0277 AC-X1)。
                // ここを Ping/Pong でも進めると、Cloud の application が自分を見失っていても
                // socket が開いている限り idle 判定が永久に発火しない。
                last_activity = Instant::now();
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // 自動登録(PBI-0023 図18): Cloud が hello の応答で credential を返してきた。
                // kind ごとに `openroly adopt` を起こして materialize し、1 件ごとに register_ack を
                // 返す(Cloud は ok:false の行を revoke して次の hello で再試行させる)。
                // 同時実行数は ADOPT_CONCURRENCY で頭打ち(PBI-0235) —— 件数は Cloud が決めるので、
                // 上限が無いと 1000 件の registered が端末で 1000 個の子プロセスになる。
                //
                // **ここでは待たない**(PBI-0248): worker へ渡してすぐ次の frame に戻る。
                // ack は 1 件終わるごとに `ack_rx` から戻ってきて、下の枝が現在の接続へ送る。
                if parsed.get("type").and_then(Value::as_str) == Some("registered") {
                    let adoptions = adopt::parse_registered(&parsed);
                    blog!(
                        "received registered count={} concurrency={}",
                        adoptions.len(),
                        adopt::ADOPT_CONCURRENCY
                    );
                    // **捨てない**(PBI-0248 review): send が Err = worker が死んでいる。
                    // 握り潰すと registered は二度と materialize されず ack も返らないまま、
                    // 接続だけが生き続ける。接続を作り直して worker ごと立て直す。
                    if adopt_tx.send(adoptions).is_err() {
                        return Err("materialize worker gone".to_string());
                    }
                    continue;
                }
                // desired が変わった(PBI-0213 AC-1)。**中身は載っていない** —— `openroly sync` が
                // `GET /v1/extensions` で取り直すので、配送経路は HTTP の 1 本のまま。
                if parsed.get("type").and_then(Value::as_str) == Some("extensions_changed") {
                    blog!("received extensions_changed");
                    // worker が消えていたら接続ごと作り直す(materialize worker と同じ扱い ——
                    // 握り潰すと以後の sync が黙って全部落ちる)
                    if cli_tx.send(CliJob::Sync).is_err() {
                        return Err("cli worker gone".to_string());
                    }
                    continue;
                }
                // cancel(PBI-0229 / AC-3): server の human 操作。SIGTERM → 5 秒 → SIGKILL。
                // 終了そのものは reaper が session_result(reason:"cancelled")で伝える。
                // request_id は accountId で絞る(AC-X1: 他人の request_id を知った接続が
                // cancel / status で触れない。broker は 1 接続で複数 account を serve しうる)
                if parsed.get("type").and_then(Value::as_str) == Some("cancel") {
                    let rid = parsed.get("requestId").and_then(Value::as_str).unwrap_or("");
                    let account_id = parsed.get("accountId").and_then(Value::as_str).unwrap_or("");
                    let ok = state.sessions.cancel_scoped(rid, account_id, "cancelled");
                    blog!("cancel requestId={rid} accepted={ok}");
                    continue;
                }
                // status(AC-2): server の timeout handler からの生存確認。registry に居て
                // try_wait が None を返す child の時だけ true。応答が戻らない時は server 側の
                // 締切が fail-closed に倒す(問い合わせは「閉じる」方向の安全側で失敗する)。
                if parsed.get("type").and_then(Value::as_str) == Some("status") {
                    let rid = parsed.get("requestId").and_then(Value::as_str).unwrap_or("");
                    let account_id = parsed.get("accountId").and_then(Value::as_str).unwrap_or("");
                    let alive = state.sessions.status_alive_scoped(rid, account_id);
                    blog!("status requestId={rid} alive={alive}");
                    let response = json!({ "type": "status_result", "requestId": rid, "alive": alive });
                    write
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .map_err(|e| format!("status_result send failed: {e}"))?;
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
                blog!(
                    "received wake runtime={runtime} sessionMode={session_mode} \
                     requestId={request_id} dedicated={}",
                    instruction.is_some()
                );
                // 外部 API provider(PBI-0070)は端末に binary を持たない —— `openroly agent` を
                // OPENROLY_CLI で起こす。返信先の thread は wake payload の threadId から来る
                let thread_id = parsed.get("threadId").and_then(Value::as_str).unwrap_or("");
                // triage session の scope token(EP-0013 W3 / PBI-0117)。有る時だけ dedicated
                // session の子 env `OPENROLY_SESSION_SCOPE` へ載る(API provider 経路には載せない —
                // scope は CLI runtime の dedicated session だけが運ぶ v1)。
                let scope_token = parsed
                    .get("scopeToken")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                // lane(PBI-0229)。server は wake payload に載せる。欠落時は "manual" —— 旧 server
                // の wake(bare spawn も含む)は全て admission 対象外に倒す = 現行挙動を守る安全側。
                let lane = parsed.get("lane").and_then(Value::as_str).unwrap_or("manual");
                // 1 接続 1 account だが broker は account_id を知らないので payload に載る。
                // 欠落時は空文字列(manual と同じく admission の対象外として働く)。
                let account_id = parsed.get("accountId").and_then(Value::as_str).unwrap_or("");
                // lane の folder(PBI-0238 AC-4)。owner / work lane だけが持つ(server が rule から
                // 解決する = PBI-0239)。無ければ session_dir/scratch。
                let folder = parsed
                    .get("folder")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let is_api = state
                    .registry
                    .detector(runtime)
                    .map(|d| d.kind == "api")
                    .unwrap_or(false);
                // **admission は broker が判定**(PBI-0229 / AC-X3)。同じ (account, lane) の
                // dedicated session が生きていれば 2 本目を起こさず `running:<id>` を返す
                // —— 判定は child の handle(try_wait)で、pid ではない。manual は免除(人在室)。
                if let Some(running) = state.sessions.admission_check(account_id, lane) {
                    blog!("wake denied session_active requestId={request_id} running={running} lane={lane}");
                    let response = json!({
                        "type": "wake_result",
                        "requestId": request_id,
                        "ok": false,
                        "reason": "session_active",
                        "running": running,
                    });
                    write
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .map_err(|e| format!("wake_result send failed: {e}"))?;
                    continue;
                }
                // **同時実行上限の enforcement**(PBI-0391 / AC-1)。admission((account, lane) の
                // 2 本目禁止)とは別の門で、端末全体の本数を hello の capacity {used, max} と
                // 同じ数え方(sessions::admission_used)で数える —— used==max で web が
                // 「No capacity right now」(AC-A5-2)と出しているのに 5 本目を spawn する矛盾
                // (0229 review)を閉じる。満杯の wake は spawn せず capacity_full を返す
                // (presence に新しい状態は作らない = 4 状態のまま。行が無い = idle)。
                if state.sessions.capacity_full(lane, adopt::ADOPT_CONCURRENCY) {
                    blog!("wake denied capacity_full requestId={request_id} lane={lane}");
                    let response = json!({
                        "type": "wake_result",
                        "requestId": request_id,
                        "ok": false,
                        "reason": "capacity_full",
                    });
                    write
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .map_err(|e| format!("wake_result send failed: {e}"))?;
                    continue;
                }
                // dedicated session は (child, egress proxy) の対。proxy は child と同じ寿命
                // (reaper が wait の後に drop = 閉じる)。Manual / API 経路は proxy 無し。
                let launch_result = if is_api {
                    launch::launch_api_env(&state.registry, runtime, thread_id).map(|c| (c, None))
                } else {
                    match instruction {
                        Some(instr) => {
                            let isolation = launch::Isolation {
                                sandbox: state.sandbox.as_ref(),
                                egress: egress::EgressConfig {
                                    // allowlist = 内蔵表 ∪ catalog の egress.hosts ∪ server host ∪
                                    // claude の ANTHROPIC_BASE_URL(PBI-0240 / PBI-0388)。variant(PBI-0211)は
                                    // broker env ではなく profile の base URL の host
                                    allow: profiles::wake_hosts(
                                        &state.registry,
                                        runtime,
                                        &state.server_host,
                                        std::env::var("ANTHROPIC_BASE_URL").ok().as_deref(),
                                        profiles::state_dir().as_deref(),
                                    ),
                                    events: Some(results_tx.clone()),
                                    upstream_override: None,
                                    observe: None,
                                },
                                folder,
                                lane,
                                user_home: state.user_home.clone(),
                                c1: &state.c1,
                            };
                            launch::launch_session_scoped(&state.registry, &known_runtimes, runtime, instr, request_id, scope_token, &isolation)
                                .map(|(c, e)| (c, Some(e)))
                        }
                        None => launch::launch(&state.registry, &known_runtimes, runtime, session_mode).map(|c| (c, None)),
                    }
                };
                let response = match launch_result {
                    Ok((child, egress)) => {
                        // registry へ 1 行(PBI-0229)。child の handle は registry が持ち、exit は
                        // reaper(250ms poll try_wait)が session_result にして流す —— 経路は旧
                        // per-child wait task から 1 本に集約される。Manual routing の bare spawn
                        // もここを通す(session_result は Cloud 側で active session の requestId と
                        // 一致した時だけ作用するので、active 未登録の分は無視される。無害・一本化)。
                        // egress proxy は行と同じ寿命(reap で drop = 閉じる / PBI-0238)。
                        let started_at = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        state.sessions.insert(sessions::Session {
                            request_id: request_id.to_string(),
                            lane: lane.to_string(),
                            account_id: account_id.to_string(),
                            thread_id: thread_id.to_string(),
                            runtime: runtime.to_string(),
                            started_at,
                            child: Some(child),
                            egress,
                            last_tool: None,
                            tool_count: 0,
                            exit: None,
                            cancel_reason: None,
                        });
                        json!({ "type": "wake_result", "requestId": request_id, "ok": true })
                    }
                    Err(reason) => {
                        // PBI-0240 AC-2: 起こし方が無い runtime には代替を 1 つ添えて返す
                        // (hello で見つかった headless 可の別 runtime。web の 1 tap がこれで組める)
                        let alternative = (reason == "not_headless")
                            .then(|| launch::headless_alternative(&state.registry, &known_runtimes, runtime))
                            .flatten()
                            .map(|kind| json!({ "kind": kind }));
                        json!({
                            "type": "wake_result",
                            "requestId": request_id,
                            "ok": false,
                            "reason": reason,
                            "alternative": alternative,
                        })
                    }
                };
                write
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .map_err(|e| format!("wake_result send failed: {e}"))?;
            }
            maybe_ack = ack_rx.recv() => {
                // 送信端は worker だけが持つので、None = worker が消えた(panic)。次の
                // `registered` を待たずにここで気付いて接続を作り直す(PBI-0248 review)。
                let Some(ack) = maybe_ack else {
                    return Err("materialize worker gone".to_string());
                };
                // adopt が通った = 新しい runtime が繋がった(AC-4)。既存 extension をその
                // runtime へ載せ(sync)、その runtime に元から在った物を提案に上げる(share)。
                // **失敗した ack では起こさない** —— credential が無い runtime に sync しても
                // 落ちるだけで、次の hello の再試行が本筋
                if ack.get("ok").and_then(Value::as_bool) == Some(true)
                    && (cli_tx.send(CliJob::Sync).is_err() || cli_tx.send(CliJob::Share).is_err())
                {
                    return Err("cli worker gone".to_string());
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use sandbox::SandboxBackend;

    // PBI-0441: hello は sandbox backend が名乗る egress_enforcement を **毎回**運ぶ(接続直後の 1 通目も
    // 差分 hello も)。server は hello ごとに端末の行へ写し直す
    #[test]
    fn hello_carries_the_backends_egress_enforcement() {
        let sessions = sessions::Sessions::new(None);
        let backend = sandbox::NoSandbox { reason: "test".into() };
        let failure = LastFailure { reason: Some("x".into()), attempts: 1 };
        for last_failure in [None, Some(&failure)] {
            let msg: Value =
                serde_json::from_str(&hello_message(&[], last_failure, &sessions, backend.egress_enforcement(), &[])).unwrap();
            assert_eq!(msg["egress_enforcement"], "none");
        }
    }
}
