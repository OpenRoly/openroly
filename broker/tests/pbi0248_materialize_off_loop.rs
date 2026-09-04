//! PBI-0248: `registered` の materialize を **WS ループの外**へ出す。
//!
//! 測る対象は実物の WS ループなので、**本物の broker binary を起こして fake の Cloud
//! (WS server)から話しかける**。`run_once` は bin crate の private な async fn なので
//! `#[path]` で src を取り込む形では呼べず、純関数の test では「ループが止まらない」を
//! 一度も測れない(止まるのはループの側であって adopt.rs の側ではない)。
//!
//! 測り方は **時間ではなく順序**: 「materialize が終わる前に別の frame へ応答したか」
//! 「gate を開けるまで 1 件も完了していないか」を見る。閾値で測ると、混んだ機械で
//! 健全な実行が偽の赤になる。
//!
//! 数えるのは **子プロセスの入口**(fake CLI 自身が書く file)。broker 側の record の写しは
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

/// frame 1 つを待つ上限。**測定の閾値ではなく hang 止め** —— ループが止まる形(旧実装)は
/// `ADOPT_TIMEOUT`(60 秒)単位で沈黙するので、ここで赤くして原因を名前で出す。
/// 健全な実行はこの何十分の 1 で返るので、混んだ機械のために大きく取ってよい
/// (本番の timeout を検査の deadline に流用すると、健全な件まで赤くなる)。
const FRAME_DEADLINE: Duration = Duration::from_secs(20);

/// broker が最初の接続を張るまでの上限。**cold start を測っているのではない** ——
/// build 直後の 1 回目は macOS の署名検査 + 高負荷で 20 秒を超える(実測: load 478 で
/// broker.log が 0 byte のまま accept が空振りした)。ここも hang 止め。
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------- 足場

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("paa-0240-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("live")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir
}

/// fake `atn adopt`。**子プロセスの入口で数える**:
///   - `live/<runtime_id>` を作る(既に在れば `overlap` へ 1 行 = 同じ相手が 2 本同時に走った)
///   - その瞬間の `live` の件数を `peak` へ 1 行(= 同時実行数)
///   - `started` / `done` に runtime_id を 1 行ずつ(起きた / 完走した)
///
/// `hold`:
///   - `None`  = `gate` file が現れるまで居座る(順序で測る検査用。開けるまで 1 件も完了しない)
///   - `Some(s)` = `s` 秒だけ居座る(同時実行数を観測可能にする検査用)
///
/// **abort された子は SIGKILL される**ので `done` にも `rmdir` にも到達しない —— それが
/// 「古い task が畳まれた」の証拠になる(逆に `live/` の残骸は残るので、殺す検査の中で
/// `overlap` / `peak` は読まない)。
fn write_fake_cli(dir: &Path, hold: Option<&str>) -> PathBuf {
    let d = dir.display().to_string();
    let wait = match hold {
        None => format!("while [ ! -f \"{d}/gate\" ]; do sleep 0.05; done"),
        Some(secs) => format!("sleep {secs}"),
    };
    let script = format!(
        "#!/bin/sh\n\
         # PBI-0248 の fake `atn adopt`。token は stdin から読み捨てる(本物と同じ入口)\n\
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
         {wait}\n\
         echo \"$rt\" >> \"{d}/done\"\n\
         rmdir \"{d}/live/$rt\" 2>/dev/null\n\
         exit 0\n"
    );
    let path = dir.join("fake-atn");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(script.as_bytes()).unwrap();
    drop(f);
    // 実行ビットは内容と別の属性 —— 書き直しでは付かないので明示する
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// broker binary。落とす時に必ず殺す(test が失敗しても常駐を残さない)。
struct BrokerProc(Child);

impl Drop for BrokerProc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_broker(dir: &Path, port: u16) -> BrokerProc {
    let log = std::fs::File::create(dir.join("broker.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_atn-broker"))
        .env("PAA_BROKER_WS_URL", format!("ws://127.0.0.1:{port}/v1/broker/ws"))
        .env("PAA_RUNTIME_TOKEN", "par_pbi0248")
        .env("PAA_CLI", dir.join("fake-atn").display().to_string())
        .env("PAA_BROKER_HOME", dir.join("home").display().to_string())
        // registry は閉じた port へ向ける(取れなくても built-in で進む = 図18)
        .env("PAA_REGISTRY_URL", "http://127.0.0.1:1/v1/registry/detectors.v1.json")
        .env("PAA_REGISTRY_REFRESH_SECS", "86400")
        // 実マシンの CLI を scan させない(`--version` の probe に数秒取られる)
        .env("PAA_SCAN_DIRS", "")
        .env("PAA_APP_DIRS", "")
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
        // 原因は broker 側にしか出ないので、log を持って落ちる(0 byte なら起動前で詰まっている)
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
            Message::Text(t) => return serde_json::from_str(&t).expect("json でない frame"),
            Message::Close(_) => panic!("broker が接続を閉じた"),
            _ => continue,
        }
    }
}

async fn collect_acks(ws: &mut Ws, n: usize) -> Vec<Value> {
    let mut out = Vec::new();
    while out.len() < n {
        let v = next_json(ws).await;
        assert_eq!(v["type"], "register_ack", "register_ack 以外が来た: {v}");
        out.push(v);
    }
    out
}

fn registered(ids: &[&str]) -> Message {
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
    Message::Text(
        json!({ "type": "registered", "runtimes": runtimes })
            .to_string()
            .into(),
    )
}

/// 応答が返る事だけが要る probe。allowlist 外の名前なので **何も spawn されない**
/// (`wake_result{ok:false, reason:'unknown_runtime'}` が返る)。
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

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

async fn wait_for_lines(path: &Path, n: usize) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(20);
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

// ---------------------------------------------------------------- AC-1 / AC-2

/// AC-1: `registered` を受けた直後でも、WS ループは別の frame に応答し続ける。
/// AC-2: gate を開けば、上限で待たされた件も含めて **全件に** `register_ack` が返る。
///
/// 順序で測る: 「まだ 1 件も materialize が完了していない」状態で `wake` を投げ、
/// **`register_ack` より先に** `wake_result` が返ることを見る。旧実装(ループの中で
/// `adopt_all` を await する形)では、gate が開くまで frame が 1 つも返らない。
#[tokio::test]
async fn ws_ループは_materialize_中でも別の_frame_に応答する() {
    let dir = tmp_dir("ac1");
    write_fake_cli(&dir, None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");

    // 8 件 = 上限 4 の 2 波。fake CLI は gate が開くまで返らない
    let ids: Vec<String> = (0..8).map(|i| format!("rt_{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    ws.send(registered(&refs)).await.unwrap();

    // **materialize が実際に走り始めてから**測る(始まる前に「速い」を見ても何も測らない)
    wait_for_lines(&dir.join("started"), 4).await;

    ws.send(wake_probe("probe-1")).await.unwrap();
    let reply = next_json(&mut ws).await;
    assert_eq!(
        reply["type"], "wake_result",
        "materialize の完了を待ってから応答している: {reply}"
    );
    assert_eq!(reply["requestId"], "probe-1");
    // 応答した時点で 1 件も完了していない = 本当に materialize の最中だった(空振り検出)
    assert!(
        !dir.join("done").exists(),
        "wake_result が返る前に materialize が終わっていた(検査が空振り)"
    );

    // AC-2: gate を開けば全 8 件に ack が返る。ack には相手が貼ってある
    open_gate(&dir);
    let acks = collect_acks(&mut ws, ids.len()).await;
    let mut seen: Vec<String> = acks
        .iter()
        .map(|a| {
            assert_eq!(a["ok"], true, "ack が ok:false: {a}");
            assert_eq!(a["kind"], "codex", "ack の kind がずれている: {a}");
            a["runtime_id"].as_str().unwrap().to_string()
        })
        .collect();
    seen.sort();
    assert_eq!(seen, ids, "全件に ack が返っていない / 相手がずれている");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- AC-3 / AC-X3

/// AC-3: `registered` が **2 通**来ても、同時に走る `atn adopt` は上限(4)を超えない。
/// AC-X3: 同じ runtime_id が 2 通に居ても、2 本同時には走らない。
///
/// ここが PBI-0248 で新しく開く穴 —— 通ごとに task を起こすと上限が「通ごとに 4 本」になり、
/// 同じ相手の materialize が重なって credentials.json を取り合う。worker 1 本で batch を
/// 順に処理していることを、子プロセスの入口で測る。
#[tokio::test]
async fn registered_が_2_通来ても上限を超えず同じ_runtime_id_は重ならない() {
    let dir = tmp_dir("ac3");
    // 0.3 秒居座らせる(即返ると重なりが観測できず、検査が何も測らない)
    write_fake_cli(&dir, Some("0.3"));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");

    let ids = ["rt_a", "rt_b", "rt_c", "rt_d", "rt_e", "rt_f"];
    // 2 通を **続けて** 投げる(ループが止まらないので両方すぐ受理される)
    ws.send(registered(&ids)).await.unwrap();
    ws.send(registered(&ids)).await.unwrap();

    let acks = collect_acks(&mut ws, ids.len() * 2).await;
    assert!(acks.iter().all(|a| a["ok"] == true), "ack が ok:false: {acks:?}");

    let observed = peak(&dir);
    assert!(observed > 0, "fake CLI が 1 度も走っていない(検査が空振り)");
    assert!(
        observed <= 4,
        "2 通に分けると同時実行が上限を超える(通ごとに task を起こしていないか): {observed}"
    );
    assert!(
        !dir.join("overlap").exists(),
        "同じ runtime_id の materialize が 2 本同時に走った: {:?}",
        lines(&dir.join("overlap"))
    );
    assert_eq!(lines(&dir.join("done")).len(), ids.len() * 2);

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- AC-X2

/// AC-X2: materialize の途中で接続が切れたら、**古い task は畳まれる**。
///
/// 畳み損ねると再接続後の分と二重に走り、上限(task ごと)を素通りする。
/// 測り方: 古い子を gate で止めたまま接続を切り、再接続を待ってから gate を開ける。
/// 古い task が生きていれば古い子が完走して `done` が 2 行になる。畳まれていれば
/// 子は SIGKILL(`kill_on_drop`)で死ぬので、`done` は新しい接続の 1 行だけ。
///
/// (殺された子は `live/` の残骸を残すので、この検査では `overlap` / `peak` を読まない)
#[tokio::test]
async fn 接続が切れたら古い_materialize_は畳まれ二重に_spawn_しない() {
    let dir = tmp_dir("acx2");
    write_fake_cli(&dir, None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    // --- 接続 1: materialize を走らせて、途中で切る
    let mut ws = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws).await["type"], "hello");
    ws.send(registered(&["rt_a"])).await.unwrap();
    wait_for_lines(&dir.join("started"), 1).await;
    drop(ws);

    // --- 接続 2(backoff 500ms 後)。ここへ来た時点で古い task は abort 済みのはず
    let mut ws2 = accept(&dir, &listener).await;
    assert_eq!(next_json(&mut ws2).await["type"], "hello");

    // gate を開ける: 古い子が生き残っていれば、ここで完走して `done` に 1 行書く
    open_gate(&dir);
    ws2.send(registered(&["rt_a"])).await.unwrap();
    let acks = collect_acks(&mut ws2, 1).await;
    assert_eq!(acks[0]["runtime_id"], "rt_a");
    assert_eq!(acks[0]["ok"], true, "再接続後の materialize が失敗した: {acks:?}");

    // 古い子が完走しうる猶予を与えてから数える(与えないと「まだ書いていない」を
    // 「畳まれた」と読んでしまう)。両方の子は同じ瞬間に gate を通れる状態なので、
    // 新しい方が終わってから更に 3 秒待てば、生きている古い方も書き終わっている。
    //
    // **`done` の件数だけが判定に使える**: 古い task が持つ ack の受信端は古い接続と一緒に
    // 落ちているので、生き残っていても ack は新しい接続には現れない(= ack を数えても
    // 生死が測れない)。子プロセスが完走したかどうかだけが、外から見える差になる。
    tokio::time::sleep(Duration::from_secs(3)).await;
    let done = lines(&dir.join("done"));
    assert_eq!(
        done.len(),
        1,
        "古い接続の materialize が生き残って二重に走った: {done:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
