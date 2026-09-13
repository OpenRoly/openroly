//! PBI-0391 有界レビューの攻撃 test(AC-X)。実装 test(pbi0391_wake_concurrency_cap.rs)が
//! 測っていない 3 つの急所を、本物の broker binary + fake Cloud で破りに行く:
//!
//! 1. **パイプライン burst + 同一 account × 別 lane**(admission は全通過する組み合わせ):
//!    5 wake を読み出し無しで一気に撃つ。WS loop が逐次処理で無い・門が lane/account ごとに
//!    分かれて数えている・どちらかだと 5 本全部が spawn する。拒否された wake が registry に
//!    **幻の行**を残していれば presence が実際と矛盾するので status で測る。
//! 2. **presence(hello)が実際と一致**(AC-1 の本体): 満杯の状態で接続を作り直すと、再接続の
//!    hello は capacity.used==4・sessions がちょうど 4 行(拒否された分は載らない)。
//!    cancel→reap で 1 枠戻し→次の wake が通る→再接続 hello がまた used==4(3 旧 + 1 新)。
//!    表示の正本は hello なので、ここを測らず「wake_result と一致」とは言えない。
//! 3. **manual の免除の対称性**(used にも数えない・門にも掛けない): manual 4 本が並んでいても
//!    auto は通り(used==0)、hello の list には manual の 4 行が **載る**(presence の正本は
//!    registry・used は別物)。片側だけ免除すると表示と実際が逆に矛盾する(G2 の主張)。

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

const FRAME_DEADLINE: Duration = Duration::from_secs(20);
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------- 足場(0391 と同じ型)

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0391rev-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir
}

fn write_fake_claude(dir: &Path) {
    let d = dir.display().to_string();
    let script = format!(
        "#!/bin/sh\n\
         case \"$1\" in --version) echo 'Fake Claude 1.0'; exit 0;; esac\n\
         echo started >> \"{d}/started\"\n\
         sleep 30\n"
    );
    let path = dir.join("bin/claude");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(script.as_bytes()).unwrap();
    drop(f);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
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
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0391rev")
        .env("OPENROLY_CLI", "/bin/true")
        .env("OPENROLY_BROKER_HOME", dir.join("home").display().to_string())
        .env("OPENROLY_REGISTRY_URL", "http://127.0.0.1:1/v1/registry/detectors.v1.json")
        .env("OPENROLY_REGISTRY_REFRESH_SECS", "86400")
        .env("OPENROLY_SCAN_DIRS", dir.join("bin").display().to_string())
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
            "broker が再接続して来ない。broker.log = {:?}",
            std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
        ),
    };
    tokio_tungstenite::accept_async(stream).await.expect("ws handshake")
}

async fn next_json(ws: &mut Ws) -> Value {
    let deadline = Instant::now() + FRAME_DEADLINE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = tokio::time::timeout(left, ws.next())
            .await
            .expect("frame が来ない(WS ループが止まっている可能性)")
            .expect("接続が切れた")
            .expect("recv error");
        match msg {
            Message::Text(t) => {
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

async fn next_matching<F: Fn(&Value) -> bool>(ws: &mut Ws, predicate: F) -> Value {
    loop {
        let v = next_json(ws).await;
        if predicate(&v) {
            return v;
        }
    }
}

fn wake(request_id: &str, account_id: &str, lane: &str) -> Message {
    Message::Text(
        json!({
            "type": "wake",
            "runtime": "claude",
            "requestId": request_id,
            "sessionMode": "new",
            "accountId": account_id,
            "lane": lane,
        })
        .to_string()
        .into(),
    )
}

fn lines(path: &Path) -> usize {
    std::fs::read_to_string(path).unwrap_or_default().lines().count()
}

async fn wait_for_lines(path: &Path, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if lines(path) >= n {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} が {n} 行に届かない(今 {} 行)",
            path.display(),
            lines(path)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 接続を開き、最初の frame の hello を返す。再接続の
/// hello は接続ごとに 1 通だけなので、ここで読んだ物をそのまま検査に使う(2 通目は無い)。
async fn connect_hello(dir: &Path, listener: &TcpListener) -> (Ws, Value) {
    let mut ws = accept(dir, listener).await;
    let hello = next_json(&mut ws).await;
    assert_eq!(hello["type"], "hello", "hello 以外が来た: {hello}");
    assert!(
        hello["runtimes"]
            .as_array()
            .map(|a| a.iter().any(|r| r["id"] == json!("claude")))
            .unwrap_or(false),
        "fake claude が discovery に載らない: {hello}"
    );
    (ws, hello)
}

// ---------------------------------------------------------------- 攻撃 1

/// 同一 account × 別 lane 4 本(admission は全部通す)を **読み出し無しの一気送り**で撃つ。
/// WS loop が逐次で無いか・門が「端末全体」でなく lane/account ごとに数えていたら 5 本目まで
/// spawn する。拒否された wake が registry に行を残せば presence が嘘になる → status で測る。
#[tokio::test]
async fn 同一account_別laneの一気送り_は5本目を断り_幻の行を残さない() {
    let dir = tmp_dir("burst");
    write_fake_claude(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let (mut ws, _hello0) = connect_hello(&dir, &listener).await;

    // 5 wake を一気に送る(返事を読まずに)。lane が全部違うので admission_check は全部 None
    let lanes = ["auto", "draft", "owner", "work", "takeover"];
    for (i, lane) in lanes.iter().enumerate() {
        ws.send(wake(&format!("wr-{i}"), "acc-same", lane)).await.unwrap();
    }
    // 5 本の wake_result を requestId で引く(並び順は保証外として扱う)
    let mut results: Vec<Value> = Vec::new();
    while results.len() < 5 {
        let r = next_matching(&mut ws, |v| v["type"] == json!("wake_result")).await;
        assert!(
            results.iter().all(|x| x["requestId"] != r["requestId"]),
            "同じ requestId の wake_result が 2 回来た: {r}"
        );
        results.push(r);
    }
    let by = |id: &str| -> Value {
        results
            .iter()
            .find(|r| r["requestId"] == json!(id))
            .unwrap_or_else(|| panic!("wake_result {id} が来ない: {results:?}"))
            .clone()
    };
    for i in 0..4 {
        assert_eq!(by(&format!("wr-{i}"))["ok"], json!(true), "4 本目までが落ちた: {}", by(&format!("wr-{i}")));
    }
    let r4 = by("wr-4");
    assert_eq!(r4["ok"], json!(false), "別 lane の 5 本目が受理された(門が lane ごとに分かれている・逐次でない): {r4}");
    assert_eq!(r4["reason"], json!("capacity_full"), "拒否の理由: {r4}");

    // spawn は子の入口で計数(4 のまま = 5 本目は spawn していない)
    wait_for_lines(&dir.join("started"), 4).await;
    assert_eq!(lines(&dir.join("started")), 4, "5 本目が spawn した");

    // 拒否された wake の行が registry に残っていない(presence に幻の行 = 表示と実際の矛盾)
    ws.send(Message::Text(
        json!({ "type": "status", "requestId": "wr-4", "accountId": "acc-same" })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let st = next_matching(&mut ws, |v| v["type"] == json!("status_result")).await;
    assert_eq!(st["requestId"], json!("wr-4"));
    assert_eq!(st["alive"], json!(false), "拒否された wake に registry の行が有る: {st}");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 2

/// presence の正本(hello)が実際と一致するかを、session の寿命で追う。満杯(4)→再接続 hello
/// used==4・4 行ちょうど → cancel→reap で 1 枠戻し→wake 通過→再接続 hello used==4(3 旧 + 1 新)。
#[tokio::test]
async fn helloのcapacityとsessions_が実際のspawn_と一致する() {
    let dir = tmp_dir("presence");
    write_fake_claude(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let (mut ws, _hello0) = connect_hello(&dir, &listener).await;

    let lanes = ["auto", "draft", "owner", "work"];
    for (i, lane) in lanes.iter().enumerate() {
        ws.send(wake(&format!("wr-{i}"), &format!("acc-{i}"), lane)).await.unwrap();
        let r = next_matching(&mut ws, |v| v["type"] == json!("wake_result")).await;
        assert_eq!(r["requestId"], json!(format!("wr-{i}")));
        assert_eq!(r["ok"], json!(true), "埋めの wake が落ちた: {r}");
    }
    wait_for_lines(&dir.join("started"), 4).await;

    // 接続を作り直す(表示の正本は再接続 hello)。registry は接続を跨いで生存する
    drop(ws);
    let (mut ws2, hello) = connect_hello(&dir, &listener).await;
    assert_eq!(hello["capacity"]["max"], json!(4), "max = ADOPT_CONCURRENCY: {hello}");
    assert_eq!(
        hello["capacity"]["used"], json!(4),
        "満杯(4 本 spawn 中)なのに hello の used が違う = 表示と実際が矛盾: {hello}"
    );
    let ids: Vec<String> = hello["sessions"]
        .as_array()
        .map(|a| a.iter().map(|s| s["request_id"].as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_default();
    assert_eq!(ids.len(), 4, "presence の行数が spawn と違う: {ids:?}");
    for i in 0..4 {
        assert!(ids.contains(&format!("wr-{i}")), "presence に wr-{i} が無い: {ids:?}");
    }

    // 1 本 cancel → reaper が掃いて session_result → 枠が 1 つ戻る → 次は通る
    ws2.send(Message::Text(
        json!({ "type": "cancel", "requestId": "wr-1", "accountId": "acc-1" })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let result = next_matching(&mut ws2, |v| v["type"] == json!("session_result")).await;
    assert_eq!(result["requestId"], json!("wr-1"), "cancel した行の session_result が来ない: {result}");
    ws2.send(wake("wr-new", "acc-new", "takeover")).await.unwrap();
    let rn = next_matching(&mut ws2, |v| v["type"] == json!("wake_result")).await;
    assert_eq!(rn["ok"], json!(true), "掃けた枠に次の wake が入らない: {rn}");
    wait_for_lines(&dir.join("started"), 5).await;

    // 再び接続を作り直す: used==4(3 旧 + 1 新)・wr-1 はもう載らない
    drop(ws2);
    let (mut ws3, hello3) = connect_hello(&dir, &listener).await;
    assert_eq!(hello3["capacity"]["used"], json!(4), "refill 後の used が実際と違う: {hello3}");
    let ids3: Vec<String> = hello3["sessions"]
        .as_array()
        .map(|a| a.iter().map(|s| s["request_id"].as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_default();
    assert_eq!(ids3.len(), 4, "refill 後の presence の行数が違う: {ids3:?}");
    assert!(!ids3.contains(&"wr-1".to_string()), "reap 済みの wr-1 が presence に残る: {ids3:?}");
    assert!(ids3.contains(&"wr-new".to_string()), "wr-new が presence に載らない: {ids3:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 3

/// manual の免除は対称か(used に数えない ∧ 門に掛けない ∧ presence には載る)。
/// manual 4 本が並んでいても auto は通り、hello は list 5 行・used 1。片側だけ免除すると
/// 「満杯表示なのに manual は通る / 空き表示なのに auto が断られる」が復活する。
#[tokio::test]
async fn manual_はusedに数えず門にも掛けない_presenceには載る() {
    let dir = tmp_dir("manual");
    write_fake_claude(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let (mut ws, _hello0) = connect_hello(&dir, &listener).await;

    for i in 0..4 {
        ws.send(wake(&format!("wm-{i}"), &format!("acc-m{i}"), "manual")).await.unwrap();
        let r = next_matching(&mut ws, |v| v["type"] == json!("wake_result")).await;
        assert_eq!(r["requestId"], json!(format!("wm-{i}")));
        assert_eq!(r["ok"], json!(true), "manual の wake が落ちた: {r}");
    }
    wait_for_lines(&dir.join("started"), 4).await;

    // manual 4 本は used を消費しないので、auto の 5 本目(spawn にすれば端末 5 process)は通る
    ws.send(wake("wa-0", "acc-a", "auto")).await.unwrap();
    let ra = next_matching(&mut ws, |v| v["type"] == json!("wake_result")).await;
    assert_eq!(
        ra["ok"], json!(true),
        "manual を used に数えていると、ここで capacity_full が出る(免除が門だけの矛盾): {ra}"
    );
    wait_for_lines(&dir.join("started"), 5).await;

    // presence には manual も載る(行の正本 = registry)。used は auto の 1 だけ
    drop(ws);
    let (_, hello) = connect_hello(&dir, &listener).await;
    assert_eq!(hello["capacity"]["used"], json!(1), "used が auto だけを数えていない: {hello}");
    let ids: Vec<String> = hello["sessions"]
        .as_array()
        .map(|a| a.iter().map(|s| s["request_id"].as_str().unwrap_or("").to_string()).collect())
        .unwrap_or_default();
    assert_eq!(ids.len(), 5, "presence が registry と違う(manual の行が消える?): {ids:?}");
    for i in 0..4 {
        assert!(ids.contains(&format!("wm-{i}")), "manual wm-{i} が presence に載らない: {ids:?}");
    }

    let _ = std::fs::remove_dir_all(&dir);
}
