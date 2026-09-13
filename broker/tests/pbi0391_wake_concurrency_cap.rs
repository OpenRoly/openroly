//! PBI-0391: wake→spawn 経路に ADOPT_CONCURRENCY(4)の同時実行上限の enforcement を足す。
//!
//! 0229 review の破れ: hello の `capacity {max, used}` は **表示**にしか使われておらず
//! (web の "No capacity right now"・AC-A5-2)、wake lane の spawn は admission((account, lane)
//! の重複)しか見ない —— **別 account・別 lane の 5 本目は used==max のまま spawn する**。
//!
//! 測る対象は main.rs の wake lane(実物の WS ループ)なので、本物の broker binary を起こして
//! fake の Cloud(WS server)から 5 本の wake を撃つ(PBI-0248 と同じ型。`run_once` は bin crate
//! の private fn なので `#[path]` では呼べない)。**spawn したかどうかは子プロセスの入口で数える**
//! —— fake `claude` が起動のたびに 1 行書く file を数える。broker 側の record の写しは
//! 「渡したつもり」までしか守らない。
//!
//! 順序で測る(時間の閾値で測ると混んだ機械で偽の赤になる):
//!   1. 別 account × lane "auto" の 4 wake は全部 ok:true(どの 2 本も admission には引っかからない)
//!   2. 5 本目は `ok:false reason:"capacity_full"` で **spawn しない**(started は 4 行のまま)
//!   3. manual lane は used に数えないので満杯でも通る(免除 = admission と同じ・スコープ外)
//!   4. 1 本 cancel → session_result(reaper が掃く)→ 枠が 1 つ戻り次の wake は通る
//!      (= 上限は件数ではなく **同時実行数**。PBI-0235 の決定)

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

/// frame 1 つを待つ上限。**測定の閾値ではなく hang 止め**(PBI-0248 と同じ決め)。
const FRAME_DEADLINE: Duration = Duration::from_secs(20);
/// broker が最初の接続を張るまでの上限(cold start の署名検査・高負荷を拾う hang 止め)。
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------- 足場

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0391-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    dir
}

/// fake `claude` runtime binary。**子プロセスの入口で数える**: 起動のたびに 1 行 `started` へ
/// 書き(deadline 付きで並べる = 後から行数だけ読める)、30 秒居座る(session が生きている事が
/// capacity を消費する前提)。discovery の version probe(`--version`)には即答して終わる
/// —— probe に失敗すると `Found` から落ちて wake が unknown_runtime になる。
fn write_fake_claude(dir: &Path) -> PathBuf {
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
    let child = Command::new(env!("CARGO_BIN_EXE_openroly-broker"))
        .env("OPENROLY_BROKER_WS_URL", format!("ws://127.0.0.1:{port}/v1/broker/ws"))
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0391")
        // sync / share --auto も同じ argv を使うが、この検査は adopt を起こさないので
        // 即座に成功する物を指す(不在だと spawn error が broker.log に積まれるだけ)
        .env("OPENROLY_CLI", "/bin/true")
        .env("OPENROLY_BROKER_HOME", dir.join("home").display().to_string())
        // registry は閉じた port へ(取れなくても built-in で進む)。built-in の claude は
        // adapter 付きなので bare spawn できる
        .env("OPENROLY_REGISTRY_URL", "http://127.0.0.1:1/v1/registry/detectors.v1.json")
        .env("OPENROLY_REGISTRY_REFRESH_SECS", "86400")
        // fake claude を置いた dir だけを見る(実マシンの CLI を probe させない)
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
            "broker が接続して来ない。broker.log = {:?}",
            std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
        ),
    };
    tokio_tungstenite::accept_async(stream).await.expect("ws handshake")
}

/// 次の **text frame** を返す(ping には pong を返して読み飛ばす —— PBI-0277)。
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

/// `predicate` を満たす frame が来るまで読む(それ以外の frame は読み飛ばす)。
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

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

async fn wait_for_lines(path: &Path, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if lines(path).len() >= n {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} が {n} 行に届かない(今 {} 行)",
            path.display(),
            lines(path).len()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------- AC-1

/// 満杯(used==max==4)の状態で 5 本目の wake が **spawn せず** `capacity_full` で返る事と、
/// 枠が同時実行数である事(1 本掃ければ次は通る)を、実物の broker で測る。
#[tokio::test]
async fn 満杯の_5_本目_wake_は_spawn_せず_掃ければ_また_通る() {
    let dir = tmp_dir("ac1");
    write_fake_claude(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);

    let mut ws = accept(&dir, &listener).await;
    let hello = next_json(&mut ws).await;
    assert_eq!(hello["type"], "hello");
    assert!(
        hello["runtimes"]
            .as_array()
            .map(|a| a.iter().any(|r| r["id"] == json!("claude")))
            .unwrap_or(false),
        "fake claude が discovery に載らない(この先の wake が全部 unknown_runtime になる): {hello}"
    );

    // --- 1. 別 account × lane "auto" の 4 wake: どの 2 本も admission に引っかからないので
    //     全部 ok:true で spawn する(= 満杯になる。壊れはこの先)
    for i in 0..4 {
        ws.send(wake(&format!("wr-{i}"), &format!("acc-{i}"), "auto")).await.unwrap();
        let r = next_json(&mut ws).await;
        assert_eq!(r["type"], "wake_result", "wake_result 以外が来た: {r}");
        assert_eq!(r["requestId"], json!(format!("wr-{i}")));
        assert_eq!(r["ok"], json!(true), "4 本目までの wake が落ちた: {r}");
    }
    // 子プロセスの入口で 4 本を確認(broker の返事だけでは spawn を測った事にならない)
    wait_for_lines(&dir.join("started"), 4).await;

    // --- 2. 5 本目(さらに別の account/lane): 表示は used==4==max(満杯)なので、
    //     spawn せず capacity_full で返る —— ここが 0229 review の破れそのもの
    ws.send(wake("wr-5", "acc-5", "auto")).await.unwrap();
    let r5 = next_json(&mut ws).await;
    assert_eq!(r5["type"], "wake_result", "wake_result 以外が来た: {r5}");
    assert_eq!(r5["requestId"], json!("wr-5"));
    assert_eq!(r5["ok"], json!(false), "満杯の 5 本目が受理された: {r5}");
    assert_eq!(r5["reason"], json!("capacity_full"), "拒否の理由: {r5}");
    // **spawn していない事** を子の入口で確認(拒否応答と spawn は別の事なので)
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        lines(&dir.join("started")).len(),
        4,
        "5 本目の wake が spawn した(= enforcement が表示と矛盾する)"
    );

    // --- 3. manual lane は used に数えない(admission の免除と同じ)ので満杯でも通る。
    //     used に数えるのに門で断つ(またはその逆)と表示と実際が逆に矛盾する
    ws.send(wake("wr-6", "acc-6", "manual")).await.unwrap();
    let r6 = next_json(&mut ws).await;
    assert_eq!(r6["type"], "wake_result", "wake_result 以外が来た: {r6}");
    assert_eq!(r6["ok"], json!(true), "manual は満杯でも門を通るはず: {r6}");
    wait_for_lines(&dir.join("started"), 5).await;

    // --- 4. 1 本 cancel → reaper が掃いて session_result が返る → 枠が 1 つ戻る。
    //     上限が「件数」ならこの wake は断られる(**同時実行数**なので通る = PBI-0235)
    ws.send(Message::Text(
        json!({ "type": "cancel", "requestId": "wr-1", "accountId": "acc-1" })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let result = next_matching(&mut ws, |v| v["type"] == json!("session_result")).await;
    assert_eq!(result["requestId"], json!("wr-1"), "cancel した session の結果が来ない: {result}");
    ws.send(wake("wr-7", "acc-7", "auto")).await.unwrap();
    let r7 = next_json(&mut ws).await;
    assert_eq!(r7["type"], "wake_result", "wake_result 以外が来た: {r7}");
    assert_eq!(r7["ok"], json!(true), "掃けた枠に次の wake が入らない(件数上限になっていないか): {r7}");
    wait_for_lines(&dir.join("started"), 6).await;

    let _ = std::fs::remove_dir_all(&dir);
}
