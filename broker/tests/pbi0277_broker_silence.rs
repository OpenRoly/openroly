//! PBI-0277: **黙って Offline のまま止まらない**。
//!
//! 2026-09-05 の実測(owner の機械): broker の process は生きていて、TCP は Fly へ
//! ESTABLISHED のまま、select ループも回っていた(fs trigger を撃つと log が伸びた)。
//! それでも web は 5 時間 Offline のままで、log には 1 行も出なかった。
//! 原因は「**WS の Pong が返る = 相手の application が自分を知っている**」と読んでいた事 ——
//! Pong は socket が開いてさえいれば返る(Cloud 側で後着の接続に上書きされていても返る)。
//!
//! だから測るのは 2 つ:
//!   1. **application が答えない相手からは自分で離れる**(AC-X1) —— WS 層が生きていても。
//!   2. **答える相手からは離れない**(1 の裏。離れるだけなら「常に再接続」でも通ってしまう)
//!   3. **繋がらない相手にも黙らない**(AC-2) —— handshake を返さない黒穴で無限に pending
//!      にならず、上限で諦めて log に書いて次の試行へ進む
//!   4. 次に繋がった時、**直前の失敗を名乗る**(AC-4)
//!
//! `run_once` は bin crate の private な async fn なので、`pbi0248_materialize_off_loop.rs`
//! と同じく **本物の broker binary を起こして fake の Cloud から話しかける**。
//! 時計は `OPENROLY_BROKER_HEARTBEAT_MS` で縮める —— 本番の 40 秒を検査の deadline に流用すると
//! 1 本 2 分かかり、誰も回さなくなる(= 一度も測っていないから緑、になる)。

use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

type Ws = WebSocketStream<TcpStream>;

/// 検査中の heartbeat。idle = 8/3 倍 = 800ms、connect 上限 = 4/3 倍 = 400ms。
const HEARTBEAT_MS: u64 = 300;
/// broker が最初の接続を張るまでの上限。**cold start を測っているのではない**(hang 止め)。
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);
/// frame 1 つを待つ上限(hang 止め)。
const FRAME_DEADLINE: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------- 足場

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0277-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir
}

struct BrokerProc(Child, PathBuf);

impl Drop for BrokerProc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl BrokerProc {
    fn log(&self) -> String {
        std::fs::read_to_string(self.1.join("broker.log")).unwrap_or_default()
    }
}

fn spawn_broker(dir: &Path, port: u16) -> BrokerProc {
    let log = std::fs::File::create(dir.join("broker.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_openroly-broker"))
        .env("OPENROLY_BROKER_WS_URL", format!("ws://127.0.0.1:{port}/v1/broker/ws"))
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0277")
        .env("OPENROLY_BROKER_HOME", dir.join("home").display().to_string())
        .env("OPENROLY_BROKER_HEARTBEAT_MS", HEARTBEAT_MS.to_string())
        // registry は閉じた port へ向ける(取れなくても built-in で進む = 図18)
        .env("OPENROLY_REGISTRY_URL", "http://127.0.0.1:1/v1/registry/detectors.v1.json")
        .env("OPENROLY_REGISTRY_REFRESH_SECS", "86400")
        // 実マシンの CLI を scan させない(`--version` の probe に数秒取られる)
        .env("OPENROLY_SCAN_DIRS", "")
        .env("OPENROLY_APP_DIRS", "")
        .env("PATH", "/bin:/usr/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .expect("broker binary を起こせない");
    BrokerProc(child, dir.to_path_buf())
}

async fn accept(proc: &BrokerProc, listener: &TcpListener) -> Ws {
    let accepted = tokio::time::timeout(CONNECT_DEADLINE, listener.accept()).await;
    let (stream, _) = match accepted {
        Ok(r) => r.expect("accept"),
        Err(_) => panic!("broker が接続して来ない。broker.log = {:?}", proc.log()),
    };
    tokio_tungstenite::accept_async(stream)
        .await
        .expect("ws handshake")
}

/// 次の text frame を 1 つ返す(WS の Ping/Pong は読み飛ばす)。
async fn next_json(ws: &mut Ws) -> Value {
    let deadline = tokio::time::Instant::now() + FRAME_DEADLINE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let msg = tokio::time::timeout(left, ws.next())
            .await
            .expect("frame が来ない")
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

/// hello を 1 通受けるまで読む。
async fn hello(ws: &mut Ws) -> Value {
    let v = next_json(ws).await;
    assert_eq!(v["type"], "hello", "1 通目は hello のはず: {v}");
    v
}

// ---------------------------------------------------------------- 1. 沈黙する相手から離れる

/// AC-X1: **WS 層は生きていて Pong も返るが、application が答えない**相手。
///
/// これが実測した本番の形そのもの —— Cloud 側では後着の接続に上書きされていて hello は
/// 捨てられているが、socket は開いているので Pong だけは返る。旧実装は Pong を「生きている
/// 証拠」に数えたので `IDLE_TIMEOUT` が永久に発火せず、**5 時間黙った**。
///
/// 測るのは「**2 本目の接続が来るか**」。tungstenite の server 側は Ping に自動で Pong を返す
/// ので、この fake は Bun の WS 層と同じ振る舞いをする(= 何もしない、が正しい再現)。
#[tokio::test]
async fn application_が答えない接続からは自分で離れる() {
    let dir = tmp_dir("silent");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let proc = spawn_broker(&dir, port);

    let mut ws = accept(&proc, &listener).await;
    hello(&mut ws).await;

    // application の ping には **答えない**。WS の Ping には tungstenite が自動で Pong する。
    // frame を読み続けるのは、読まないと自動 Pong が flush されず「socket が詰まった」形に
    // なってしまい、測りたい形(Pong は返る)から外れるため。
    let drain = tokio::spawn(async move { while let Some(Ok(_)) = ws.next().await {} });

    // idle = HEARTBEAT * 8/3。余裕を持って待ち、**2 本目の接続**が来ることを見る。
    let second = tokio::time::timeout(
        Duration::from_millis(HEARTBEAT_MS * 40),
        listener.accept(),
    )
    .await;
    drain.abort();
    assert!(
        second.is_ok(),
        "application が沈黙しても張り直さなかった(旧実装の形)。broker.log = {:?}",
        proc.log()
    );
    // **無音で諦めない**(AC-2): 離れた理由と次の試行が log に出る
    let log = proc.log();
    assert!(log.contains("idle timeout"), "離れた理由が log に無い: {log}");
    assert!(log.contains("connecting to ws://"), "次の試行が log に無い: {log}");
}

/// 1 の**片方だけ**を武装する検査。相手が **WS の Ping を送ってくる**(= 途中の proxy や
/// Bun の WS 層が生きている)が application は答えない、という形。
///
/// これが無いと「生存の時計を application frame だけで進める」の 1 行を戻しても検査は緑のまま
/// になる —— 上の検査は「app ping を送る」側の変更だけでも通ってしまう(等価変異)。
#[tokio::test]
async fn 途中の層が_ping_を返してくるだけでは生存とみなさない() {
    let dir = tmp_dir("wsping");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let proc = spawn_broker(&dir, port);

    let mut ws = accept(&proc, &listener).await;
    hello(&mut ws).await;

    // application には答えず、**WS の Ping だけ**を送り続ける(broker は自動で Pong を返し、
    // 受信もする)。旧実装はこの Pong / Ping で `last_activity` が進み、永久に離れなかった。
    let noise = tokio::spawn(async move {
        loop {
            if ws.send(Message::Ping(Vec::new().into())).await.is_err() {
                break;
            }
            // 送るだけでなく読む(相手の Pong と app ping を捨てる)
            let _ = tokio::time::timeout(Duration::from_millis(50), ws.next()).await;
        }
    });

    let second = tokio::time::timeout(
        Duration::from_millis(HEARTBEAT_MS * 40),
        listener.accept(),
    )
    .await;
    noise.abort();
    assert!(
        second.is_ok(),
        "WS の Ping/Pong を生存とみなして張り付いた(旧実装の形)。broker.log = {:?}",
        proc.log()
    );
}

// ---------------------------------------------------------------- 2. 答える相手からは離れない

/// 1 の裏。**答える相手からは離れない** —— これが無いと「常に再接続する」実装でも 1 が通り、
/// 何も測っていない事になる(等価変異)。
#[tokio::test]
async fn application_が答える限り接続を保つ() {
    let dir = tmp_dir("answers");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let proc = spawn_broker(&dir, port);

    let mut ws = accept(&proc, &listener).await;
    hello(&mut ws).await;

    // ping に pong で答え続ける係。idle の何倍もの間 動かす。
    let answer = tokio::spawn(async move {
        let mut pings = 0u32;
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                if v["type"] == "ping" {
                    pings += 1;
                    if ws
                        .send(Message::Text(json!({ "type": "pong" }).to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        pings
    });

    // idle(8/3 倍)の 5 倍以上の間、**2 本目が来ない**事を見る
    let second = tokio::time::timeout(
        Duration::from_millis(HEARTBEAT_MS * 20),
        listener.accept(),
    )
    .await;
    assert!(
        second.is_err(),
        "pong を返しているのに張り直した(= 常に再接続しているだけ)。broker.log = {:?}",
        proc.log()
    );
    answer.abort();
}

// ---------------------------------------------------------------- 3. 繋がらない相手にも黙らない

/// AC-2: TCP は繋がるが **handshake の応答を返さない**黒穴。
///
/// 旧実装の `connect_async` には上限が無く、この形では await が永久に返らない ——
/// 再接続の loop は 1 周も回らず log にも何も出ない(外から見ると「黙って止まった」)。
/// 測るのは「**上限で諦めて次の試行へ進むか**」= accept が 2 回以上起きる事。
#[tokio::test]
async fn handshake_を返さない相手には上限で見切りを付ける() {
    let dir = tmp_dir("blackhole");
    // 受けるが **何も返さない** listener(std のまま握って放置する)
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let proc = spawn_broker(&dir, port);

    // accept した stream を握り潰す(閉じると相手に EOF が渡って「繋がらない」ではなくなる)。
    // **join しない** —— `accept()` は次の接続が来るまで返らないので、broker を落とした後に
    // join すると検査そのものが永久に止まる。detach して process 終了に任せる。
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        while let Ok((s, _)) = listener.accept() {
            kept.push(s);
        }
    });

    // connect 上限 = HEARTBEAT * 4/3。2 回目の accept まで見届ける
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut attempts = 0;
    while std::time::Instant::now() < deadline {
        attempts = proc.log().matches("connecting to ws://").count();
        if attempts >= 2 && proc.log().contains("connect timed out") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let log = proc.log();
    assert!(
        log.contains("connect timed out"),
        "handshake を返さない相手に無限に張り付いた。broker.log = {log:?}"
    );
    assert!(attempts >= 2, "次の試行へ進まなかった(attempts={attempts})。log = {log:?}");
}

// ---------------------------------------------------------------- 4. 次に繋がったら名乗る

/// AC-4: 切れている間 broker は Cloud へ何も言えないので、**次に繋がった時の hello** で
/// 直前の失敗を名乗る。これが web の「Last failure: …」の中身になる。
#[tokio::test]
async fn 次に繋がった時に直前の失敗を名乗る() {
    let dir = tmp_dir("names");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let proc = spawn_broker(&dir, port);

    // 1 本目: hello だけ受けて **即切る**(= 短命な接続 = 失敗として数える)
    let mut ws = accept(&proc, &listener).await;
    hello(&mut ws).await;
    drop(ws);

    // 2 本目: hello に last_error / failed_attempts が載る
    let mut ws2 = accept(&proc, &listener).await;
    let v = hello(&mut ws2).await;
    assert_eq!(
        v["failed_attempts"], 1,
        "直前の失敗回数を名乗っていない: {v}. log = {:?}",
        proc.log()
    );
    assert!(
        v["last_error"].as_str().is_some_and(|s| !s.is_empty()),
        "直前の失敗理由を名乗っていない: {v}"
    );
}
