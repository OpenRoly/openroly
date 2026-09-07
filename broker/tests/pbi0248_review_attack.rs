//! PBI-0248 の有界レビュー(攻撃)。**AC-X2(古い worker を畳む)と AC-2(ack の取りこぼし)を破りに行く。**
//!
//! 本体の検査(`pbi0248_materialize_off_loop.rs`)が測っていない面を 4 つ撃つ:
//!   1. 切断を **2 回** 跨ぐ。畳み損ねが 1 接続分でなく積み上がる形なら、3 接続目で 3 倍走る
//!      (上限 4 は task ごとなので、task が 3 本残れば同時 12 本 = PBI-0235 の素通り)
//!   2. AC-1 の SBE 表は **100 件**と書いてあるが本体の検査は 8 件しか投げていない
//!   3. **`IDLE_TIMEOUT`(40 秒)を跨ぐ materialize** —— この PBI が存在する理由そのものなのに、
//!      本体の検査は数秒で終わるので一度も跨いでいない(「接続も落ちない」は散文だけだった)
//!   4. 詰まっている間に `registered` を積み上げる。worker が 1 本で直列なら取りこぼさない
//!
//! 測り方は本体と同じで **順序と件数**。閾値は hang 止めにしか使わない。
//! 数えるのは **子プロセスの入口**(fake CLI 自身が書く file)—— broker 側の写しは
//! 「渡したつもり」までしか守らない。

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

type Ws = WebSocketStream<TcpStream>;

/// frame 1 つを待つ上限。**hang 止め** —— ループが止まる形は `ADOPT_TIMEOUT`(60 秒)単位で
/// 沈黙するので、ここで赤くして原因を名前で出す。
const FRAME_DEADLINE: Duration = Duration::from_secs(25);
/// 最初の接続を待つ上限。build 直後の 1 回目は署名検査 + 高負荷で数十秒かかる(cold start を
/// 測っているのではない)。
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);
/// broker 側の定数の写し。ここを跨いでも接続が落ちないことを攻撃 3 で測る。
const IDLE_TIMEOUT: Duration = Duration::from_secs(40);

// ---------------------------------------------------------------- 足場(本体の検査と同じ形)

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0248atk-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("live")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir
}

/// fake `openroly adopt`。`gate` file が現れるまで居座る。
///   - `live/<runtime_id>` を作る(既に在れば `overlap` へ 1 行 = 同じ相手が 2 本同時に走った)
///   - その瞬間の `live` の件数を `peak` へ 1 行(= 同時実行数)
///   - `started` / `done` に runtime_id を 1 行ずつ(起きた / 完走した)
///
/// **abort された子は SIGKILL される**ので `done` にも `rmdir` にも到達しない —— これが
/// 「古い task が畳まれた」の唯一の外から見える証拠になる(殺す検査では `live/` に残骸が
/// 残るので `overlap` / `peak` を読まない)。
fn write_fake_cli(dir: &Path) -> PathBuf {
    let d = dir.display().to_string();
    let script = format!(
        "#!/bin/sh\n\
         # PBI-0213: broker は adopt 以外に sync / share --auto / watch-dirs でも **同じ CLI** を\n\
         # 起こす。この fake が数えているのは adopt の同時実行だけなので、他は即 exit する ——\n\
         # 通すと `--runtime-id` の無い呼びが `live/`(親 dir そのもの)を作ろうとして overlap に\n\
         # 空行を積み、最後の rmdir で `live/` ごと消して以後の adopt を全部 overlap にする\n\
         case \"$1\" in adopt) ;; *) exit 0 ;; esac\n\
         cat >/dev/null\n\
         rt=\"\"\n\
         while [ $# -gt 0 ]; do\n\
         \x20 case \"$1\" in\n\
         \x20   --runtime-id) rt=\"$2\"; shift 2 ;;\n\
         \x20   *) shift ;;\n\
         \x20 esac\n\
         done\n\
         mkdir \"{d}/live/$rt\" 2>/dev/null || echo \"$rt\" >> \"{d}/overlap\"\n\
         ls \"{d}/live\" | wc -l >> \"{d}/peak\"\n\
         echo \"$rt\" >> \"{d}/started\"\n\
         while [ ! -f \"{d}/gate\" ]; do sleep 0.05; done\n\
         echo \"$rt\" >> \"{d}/done\"\n\
         rmdir \"{d}/live/$rt\" 2>/dev/null\n\
         exit 0\n"
    );
    let path = dir.join("fake-openroly");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(script.as_bytes()).unwrap();
    drop(f);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

struct BrokerProc(Child);

impl Drop for BrokerProc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_broker(dir: &Path, port: u16) -> BrokerProc {
    let log = std::fs::File::create(dir.join("broker.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_openroly-broker"))
        .env("OPENROLY_BROKER_WS_URL", format!("ws://127.0.0.1:{port}/v1/broker/ws"))
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0248_attack")
        .env("OPENROLY_CLI", dir.join("fake-openroly").display().to_string())
        .env("OPENROLY_BROKER_HOME", dir.join("home").display().to_string())
        .env("OPENROLY_REGISTRY_URL", "http://127.0.0.1:1/v1/registry/detectors.v1.json")
        .env("OPENROLY_REGISTRY_REFRESH_SECS", "86400")
        .env("OPENROLY_SCAN_DIRS", "")
        .env("OPENROLY_APP_DIRS", "")
        .env("PATH", "/bin:/usr/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .expect("broker binary を起こせない");
    BrokerProc(child)
}

async fn accept(dir: &Path, listener: &TcpListener) -> Ws {
    let accepted = tokio::time::timeout(CONNECT_DEADLINE, listener.accept()).await;
    let (stream, _) = match accepted {
        Ok(r) => r.expect("accept"),
        Err(_) => panic!(
            "broker が接続して来ない。broker.log = {:?}",
            std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
        ),
    };
    tokio_tungstenite::accept_async(stream)
        .await
        .expect("ws handshake")
}

/// 次の **text frame** を返す(ping/pong は読み飛ばす)。
async fn next_json(ws: &mut Ws) -> Value {
    let deadline = Instant::now() + FRAME_DEADLINE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = tokio::time::timeout(left, ws.next())
            .await
            .expect("frame が来ない(WS ループが materialize を待って止まっている可能性)")
            .expect("接続が切れた")
            .expect("recv error");
        match msg {
            Message::Text(t) => {
                // PBI-0277: broker は heartbeat ごとに application の ping を打つ。
                // 生存確認の frame なので **pong を返して読み飛ばす** —— これを数えると
                // 「次に来る register_ack」を取り違える
                let v: Value = serde_json::from_str(&t).expect("json でない frame");
                if v["type"] == "ping" {
                    let _ = ws.send(Message::Text(json!({ "type": "pong" }).to_string().into())).await;
                    continue;
                }
                return v;
            }
            Message::Close(_) => panic!("broker が接続を閉じた"),
            _ => continue,
        }
    }
}

/// `register_ack` を n 件集めて `runtime_id -> 件数` と ok/kind の一致を返す。
async fn collect_acks(ws: &mut Ws, n: usize) -> Vec<Value> {
    let mut out = Vec::new();
    while out.len() < n {
        let v = next_json(ws).await;
        assert_eq!(v["type"], "register_ack", "register_ack 以外が来た: {v}");
        assert_eq!(v["ok"], true, "ack が ok:false: {v}");
        assert_eq!(v["kind"], "codex", "ack の kind がずれている: {v}");
        out.push(v);
    }
    out
}

fn ack_ids(acks: &[Value]) -> Vec<String> {
    let mut v: Vec<String> = acks
        .iter()
        .map(|a| a["runtime_id"].as_str().unwrap().to_string())
        .collect();
    v.sort();
    v
}

fn registered(ids: &[String]) -> Message {
    let runtimes: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({
                "kind": "codex",
                "runtime_id": id,
                "token": "par_secret",
                "base_url": "http://127.0.0.1:1",
                "name": "M / Codex",
            })
        })
        .collect();
    Message::Text(json!({ "type": "registered", "runtimes": runtimes }).to_string().into())
}

/// 応答が返る事だけが要る probe。allowlist 外の名前なので何も spawn されない。
fn wake_probe(request_id: &str) -> Message {
    Message::Text(
        json!({
            "type": "wake",
            "runtime": "no-such-runtime-pbi0248",
            "requestId": request_id,
            "sessionMode": "new",
        })
        .to_string()
        .into(),
    )
}

fn ids(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}_{i}")).collect()
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

async fn wait_for_lines(path: &Path, n: usize) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let got = lines(path);
        if got.len() >= n {
            return got;
        }
        assert!(
            Instant::now() < deadline,
            "{} が {n} 行に届かない(今 {} 行)",
            path.display(),
            got.len()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn open_gate(dir: &Path) {
    std::fs::write(dir.join("gate"), b"open").unwrap();
}

fn peak(dir: &Path) -> usize {
    lines(&dir.join("peak"))
        .iter()
        .filter_map(|l| l.trim().parse::<usize>().ok())
        .max()
        .unwrap_or(0)
}

fn count_with_prefix(v: &[String], prefix: &str) -> usize {
    v.iter().filter(|s| s.starts_with(prefix)).count()
}

// ---------------------------------------------------------------- 攻撃 1(AC-X2)

/// AC-X2 を **2 回の切断**で撃つ。本体の検査は「1 件を 1 回切る」までしか見ていないので、
/// 畳み損ねが接続ごとに **積み上がる**形(task が 3 本残る = 同時 12 本 = 上限 4 の 3 倍)を
/// 一度も踏んでいない。
///
/// 各接続で id を変える —— 殺された子は `live/<id>` の残骸を残すので、同じ id を使い回すと
/// 新しい子の `mkdir` が必ず失敗して `overlap` が偽陽性になる。判定は **`done` の構成**:
/// 生き残った古い task が居れば、gate を開けた時に古い id も完走して `done` に現れる。
#[tokio::test]
async fn 切断を_2_回跨いでも古い_materialize_は積み上がらない() {
    let dir = tmp_dir("atk1");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let round_a = ids("a", 6);
    let round_b = ids("b", 6);
    let round_c = ids("c", 6);

    // --- 接続 1: 6 件(上限 4 なので 4 本が走り 2 本が permit 待ち)を走らせて切る
    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");
    ws.send(registered(&round_a)).await.unwrap();
    wait_for_lines(&dir.join("started"), 4).await;
    drop(ws);

    // --- 接続 2: 同じことをもう一度(ここで 2 本目の task が残っていれば 8 本走る)
    let mut ws2 = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws2).await["type"], "hello");
    ws2.send(registered(&round_b)).await.unwrap();
    wait_for_lines(&dir.join("started"), 8).await;
    drop(ws2);

    // --- 接続 3: ここで gate を開ける
    let mut ws3 = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws3).await["type"], "hello");
    ws3.send(registered(&round_c)).await.unwrap();
    wait_for_lines(&dir.join("started"), 12).await;

    // 空振り検出: 古い 2 接続の子は **確かに起きていた**(起きていなければ「畳まれた」を
    // 何も測っていない)
    let started = lines(&dir.join("started"));
    assert_eq!(count_with_prefix(&started, "a_"), 4, "接続 1 の子が 4 本起きていない: {started:?}");
    assert_eq!(count_with_prefix(&started, "b_"), 4, "接続 2 の子が 4 本起きていない: {started:?}");

    open_gate(&dir);
    let acks = collect_acks(&mut ws3, round_c.len()).await;
    assert_eq!(ack_ids(&acks), round_c, "3 本目の接続で全件に ack が返っていない");

    // 古い子が完走しうる猶予。両方の子は同じ瞬間に gate を通れる状態なので、新しい方が
    // 終わってから更に待てば、生きている古い方も書き終わっている。
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut done = lines(&dir.join("done"));
    done.sort();
    assert_eq!(
        done, round_c,
        "古い接続の materialize が生き残って積み上がった(a_/b_ が完走している): {done:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 2(AC-1 / AC-2 / AC-3)

/// AC-1 の SBE 表は **「`registered` に 100 件」**と書いてあるのに、本体の検査は 8 件しか
/// 投げていない。表どおりの件数で撃つ —— 100 件は上限 4 で **25 波**なので、旧実装(ループの中で
/// await)なら最悪 25 × `ADOPT_TIMEOUT` 沈黙する。
///
/// 同時に AC-3(上限 4)と AC-2(全件に ack・二重 ack が無い)も 100 件の側から測る。
#[tokio::test]
async fn 百件の_registered_でも_ws_ループは止まらず全件に_ack_が返る() {
    let dir = tmp_dir("atk2");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");

    let all = ids("rt", 100);
    // 期待値も辞書順に揃える(`ack_ids` が sort するので、rt_10 < rt_2 の側に合わせる)
    let mut expected = all.clone();
    expected.sort();
    ws.send(registered(&all)).await.unwrap();
    wait_for_lines(&dir.join("started"), 4).await;

    // 上限を守っているので、gate を開けるまで 5 本目は起きない(件数が増えても増えない)
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(
        lines(&dir.join("started")).len(),
        4,
        "100 件で上限 4 を超えて子が起きている: {:?}",
        lines(&dir.join("started"))
    );

    // materialize の最中に別の frame へ応答する(順序で測る)
    ws.send(wake_probe("probe-100")).await.unwrap();
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["type"], "wake_result", "100 件で応答が返らない: {reply}");
    assert_eq!(reply["requestId"], "probe-100");
    assert!(
        !dir.join("done").exists(),
        "wake_result が返る前に materialize が終わっていた(検査が空振り)"
    );

    open_gate(&dir);
    let acks = collect_acks(&mut ws, all.len()).await;
    assert_eq!(ack_ids(&acks), expected, "100 件の一部が取りこぼされた / 相手がずれた");
    assert!(
        !dir.join("overlap").exists(),
        "同じ runtime_id の materialize が 2 本同時に走った: {:?}",
        lines(&dir.join("overlap"))
    );
    let observed = peak(&dir);
    assert!(observed > 0, "fake CLI が 1 度も走っていない(検査が空振り)");
    assert!(observed <= 4, "100 件で同時実行が上限を超えた: {observed}");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 3(AC-X1: 接続も落ちない)

/// **この PBI が存在する理由そのもの**を測る: materialize が `IDLE_TIMEOUT`(40 秒)を跨いでも
/// 接続は落ちない。
///
/// 本体の検査は数秒で終わるので一度も跨いでおらず、G2 は「接続も落ちないことは AC-1 の test が
/// 同じ形で見ている」と散文で書いているだけだった。旧実装ではループが止まって **ping を 1 本も
/// 打たない**ため、materialize が終わった瞬間に `last_activity.elapsed() > IDLE_TIMEOUT` で
/// 再接続する —— つまり跨がない検査では旧実装と新実装の差が出ない。
///
/// 判定は 2 つ: (a) 46 秒の間に **broker からの ping が 2 本以上**届く(heartbeat が生きている)、
/// (b) その間 `listener.accept()` が **一度も起きない**(再接続していない)。
#[tokio::test]
async fn materialize_が_idle_timeout_を跨いでも接続は落ちない() {
    let dir = tmp_dir("atk3");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");

    let all = ids("idle", 6);
    ws.send(registered(&all)).await.unwrap();
    wait_for_lines(&dir.join("started"), 4).await;

    // IDLE_TIMEOUT + 6 秒。ping(15 秒間隔)は 3 本来るはずなので 2 本で判定する
    let until = Instant::now() + IDLE_TIMEOUT + Duration::from_secs(6);
    let mut pings = 0usize;
    while Instant::now() < until {
        let left = until.saturating_duration_since(Instant::now());
        tokio::select! {
            biased;
            _ = listener.accept() => panic!(
                "materialize の途中で再接続した(接続が IDLE_TIMEOUT で落ちた)。ping={pings}"
            ),
            msg = ws.next() => {
                let msg = msg.expect("接続が切れた").expect("recv error");
                match msg {
                    // 明示的に pong を返す(実物の Cloud と同じ。tungstenite の自動 pong が
                    // flush されるまで待たない)
                    Message::Ping(p) => {
                        ws.send(Message::Pong(p)).await.unwrap();
                    }
                    Message::Close(_) => panic!("broker が接続を閉じた(ping={pings})"),
                    // PBI-0277: keepalive は **application frame** になった(WS の Pong は
                    // socket が開いてさえいれば返るので生存の証拠にならない)。数える対象も
                    // 答える相手もここへ移る —— 答えないと IDLE_TIMEOUT で接続が落ちる
                    Message::Text(t) => {
                        let v: Value = serde_json::from_str(&t).expect("json でない frame");
                        if v["type"] == "ping" {
                            pings += 1;
                            ws.send(Message::Text(json!({ "type": "pong" }).to_string().into()))
                                .await
                                .unwrap();
                        } else {
                            panic!("materialize 中に予期しない text frame: {t}");
                        }
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(left) => break,
        }
    }
    assert!(
        pings >= 2,
        "materialize 中に heartbeat が動いていない(ping {pings} 本。ループが止まっている)"
    );
    // 空振り検出: 46 秒経っても materialize は本当にまだ終わっていない
    assert!(
        !dir.join("done").exists(),
        "gate を開けていないのに materialize が終わった(検査が空振り)"
    );

    // 同じ接続のまま全件に ack が返る(落ちていないことの裏取り)
    open_gate(&dir);
    let acks = collect_acks(&mut ws, all.len()).await;
    assert_eq!(ack_ids(&acks), all, "跨いだ後の ack が揃わない");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 4(AC-2 / AC-X3)

/// 詰まっている最中に `registered` を **3 通**積み上げる。worker が接続ごとに 1 本で
/// batch を直列に処理しているなら、
///   - 取りこぼしが無い(18 件全部に ack)
///   - 同じ runtime_id が 3 通に居ても同時には走らない(`overlap` が空)
///   - 同時実行は 4 本以下のまま(通ごとに task を起こしていれば 12 本になる)
///
/// 本体の AC-3 検査は「即返る fake CLI で 2 通」なので、**1 通目が止まったまま次が積む**形を
/// 一度も通っていない(積んだ分が捨てられていても緑になる)。
#[tokio::test]
async fn 詰まっている間に積んだ_registered_も取りこぼさず直列に走る() {
    let dir = tmp_dir("atk4");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");

    let batch = ids("q", 6);
    // 1 通目が gate で止まっている状態で 2 通目 / 3 通目を積む
    ws.send(registered(&batch)).await.unwrap();
    wait_for_lines(&dir.join("started"), 4).await;
    ws.send(registered(&batch)).await.unwrap();
    ws.send(registered(&batch)).await.unwrap();

    // 積んでもループは止まらない
    ws.send(wake_probe("probe-queue")).await.unwrap();
    let reply = next_json(&mut ws).await;
    assert_eq!(reply["type"], "wake_result", "積んだ後に応答が返らない: {reply}");

    open_gate(&dir);
    let acks = collect_acks(&mut ws, batch.len() * 3).await;
    let got = ack_ids(&acks);
    for id in &batch {
        assert_eq!(
            got.iter().filter(|g| *g == id).count(),
            3,
            "{id} の ack が 3 通来ていない(積んだ分が捨てられた): {got:?}"
        );
    }
    assert!(
        !dir.join("overlap").exists(),
        "同じ runtime_id の materialize が 2 本同時に走った: {:?}",
        lines(&dir.join("overlap"))
    );
    let observed = peak(&dir);
    assert!(observed > 0, "fake CLI が 1 度も走っていない(検査が空振り)");
    assert!(
        observed <= 4,
        "積んだ通ごとに task を起こしている(同時実行 {observed} 本)"
    );
    assert_eq!(lines(&dir.join("done")).len(), batch.len() * 3);

    let _ = std::fs::remove_dir_all(&dir);
}
