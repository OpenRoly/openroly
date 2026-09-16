//! PBI-0213 の有界レビュー: **AC-X を破りに行く**。
//!
//! 実装は「`openroly sync` は自分で config を書くので、走った直後に見張りの基準を取り直す」で
//! 循環を止めている。攻撃の的はそこ —— **基準の取り直しは「自分の書き込み」だけを飲むのか**。
//! 飲む相手を間違えると、AC-2 / AC-3 の「10 秒以内に Found が出る」は遅れるのではなく
//! **永久に出ない**（次に別の変化が起きるまで誰も気付けない）。
//!
//! もう 1 本は「見張る場所を訊く口」の失敗経路。`openroly watch-dirs` は sync のたびに訊き直すので、
//! 1 回の失敗が **その接続の見張りを丸ごと消す** かどうかを測る。
//!
//! 測り方は `pbi0213_always_sync.rs` と同じ: 本物の broker binary + fake の Cloud、
//! 数えるのは fake CLI 自身が書く file（broker 側の写しは「渡したつもり」しか守らない）。

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

const CONNECT_DEADLINE: Duration = Duration::from_secs(90);
/// file が現れるのを待つ上限。native poll は 2s なので、その数周分（測定の閾値ではない）。
const OBSERVE_DEADLINE: Duration = Duration::from_secs(30);

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0213atk-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::create_dir_all(dir.join("native")).unwrap();
    std::fs::write(dir.join("native/config.json"), b"{}").unwrap();
    dir
}

/// fake `openroly`。本家の test の物に **2 つの摘み** を足した:
///   - `hold-<cmd>` が在る間 `<cmd>` は返らない（`holding-<cmd>` で「今掴んでいる」が外から見える）
///   - `fail-watch-dirs` が在る間 `watch-dirs` は非 0 で落ちる
fn write_fake_cli(dir: &Path) -> PathBuf {
    let d = dir.display().to_string();
    let script = format!(
        "#!/bin/sh\n\
         cmd=\"$1\"\n\
         case \"$cmd\" in\n\
         \x20 watch-dirs)\n\
         \x20   if [ -f \"{d}/fail-watch-dirs\" ]; then exit 7; fi\n\
         \x20   echo \"{d}/native/config.json\"\n\
         \x20   echo \"{d}/native/skills\"\n\
         \x20   exit 0 ;;\n\
         \x20 adopt)\n\
         \x20   cat >/dev/null\n\
         \x20   exit 0 ;;\n\
         esac\n\
         echo \"$cmd\" >> \"{d}/$cmd-count\"\n\
         if [ -f \"{d}/hold-$cmd\" ]; then\n\
         \x20 : > \"{d}/holding-$cmd\"\n\
         \x20 while [ -f \"{d}/hold-$cmd\" ] && kill -0 \"$PPID\" 2>/dev/null; do sleep 0.05; done\n\
         \x20 rm -f \"{d}/holding-$cmd\"\n\
         fi\n\
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
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0213atk")
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
    tokio_tungstenite::accept_async(stream).await.expect("ws handshake")
}

async fn hello_then_pong(mut ws: Ws) -> tokio::sync::mpsc::UnboundedSender<Value> {
    let first = tokio::time::timeout(CONNECT_DEADLINE, ws.next())
        .await
        .expect("hello が来ない")
        .expect("接続が切れた")
        .expect("recv error");
    let Message::Text(t) = first else { panic!("hello が text でない") };
    let v: Value = serde_json::from_str(&t).unwrap();
    assert_eq!(v["type"], "hello");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                out = rx.recv() => {
                    let Some(msg) = out else { return };
                    if ws.send(Message::Text(msg.to_string().into())).await.is_err() { return }
                }
                incoming = ws.next() => {
                    let Some(Ok(Message::Text(t))) = incoming else { return };
                    let v: Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                    if v["type"] == "ping" {
                        let _ = ws.send(Message::Text(json!({"type":"pong"}).to_string().into())).await;
                    }
                }
            }
        }
    });
    tx
}

fn count(dir: &Path, name: &str) -> usize {
    std::fs::read_to_string(dir.join(name)).map(|s| s.lines().count()).unwrap_or(0)
}

async fn wait_count(dir: &Path, name: &str, at_least: usize, why: &str) -> usize {
    let deadline = Instant::now() + OBSERVE_DEADLINE;
    loop {
        let n = count(dir, name);
        if n >= at_least {
            return n;
        }
        if Instant::now() >= deadline {
            panic!(
                "{why}\n{name} が {at_least} 行に届かない(今 {n} 行)。broker.log = {:?}",
                std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_file(dir: &Path, name: &str, why: &str) {
    let deadline = Instant::now() + OBSERVE_DEADLINE;
    while !dir.join(name).exists() {
        if Instant::now() >= deadline {
            panic!(
                "{why}\n{name} が現れない。broker.log = {:?}",
                std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// T0(接続確立)の sync + share が走り切るまで待って、以後の数の基準を返す。
async fn settle(dir: &Path) -> (usize, usize) {
    wait_count(dir, "sync-count", 1, "T0 の sync が走らない").await;
    wait_count(dir, "share-count", 1, "T0 の share が走らない").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    (count(dir, "sync-count"), count(dir, "share-count"))
}

async fn connect(dir: &Path) -> (BrokerProc, tokio::sync::mpsc::UnboundedSender<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let broker = spawn_broker(dir, port);
    let ws = accept(dir, &listener).await;
    let tx = hello_then_pong(ws).await;
    // listener を落とすと再接続が繋がらないので test の間持ち続ける
    std::mem::forget(listener);
    (broker, tx)
}

// ---------------------------------------------------------------- 攻撃 1

/// **攻撃**: `openroly sync` が走っている最中に、人が手で config を書き換えたら？
///
/// 実装は sync の**後**に `seen = stat_paths(&paths)` で基準を取り直す。狙いは「自分の書き込みを
/// 次の周の変化に数えない」だが、**同じ取り直しが人の書き込みも一緒に飲む**。飲まれた変化は
/// もう誰も見ていないので、AC-2 の「10 秒以内に Found」は遅れるのではなく **永久に来ない**。
#[tokio::test]
async fn sync_の実行中に人が書いた_config_が飲まれない() {
    let dir = tmp_dir("during-sync");
    write_fake_cli(&dir);
    let (_broker, tx) = connect(&dir).await;
    let (base_sync, base_share) = settle(&dir).await;

    // 次の sync を掴ませる
    std::fs::write(dir.join("hold-sync"), b"1").unwrap();
    tx.send(json!({ "type": "extensions_changed" })).unwrap();
    wait_file(&dir, "holding-sync", "extensions_changed で sync が起きない").await;
    assert_eq!(count(&dir, "sync-count"), base_sync + 1);

    // **人が手で MCP を 1 つ足した**(sync が掴まれている間)
    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"playwright":{}}}"#).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // sync を放す → 実装はここで基準を取り直す
    std::fs::remove_file(dir.join("hold-sync")).unwrap();

    wait_count(
        &dir,
        "share-count",
        base_share + 1,
        "sync の実行中に人が書いた config の変化が、基準の取り直しに飲まれて \
         誰にも提案されないまま消えた(AC-2 の「10 秒以内に Found」が永久に来ない)",
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 2

/// **攻撃**: `openroly share --auto` が走っている最中に、人がもう 1 回 config を書き換えたら？
///
/// share は見張る path を書かない(提案を送るだけ)。にもかかわらず実装は share の**後**にも
/// 基準を取り直すので、share の実行中の書き込みが同じように飲まれる。
#[tokio::test]
async fn share_の実行中に人が書いた_config_が飲まれない() {
    let dir = tmp_dir("during-share");
    write_fake_cli(&dir);
    // `_tx` は落とさない —— 落とすと pong を返す task ごと畳まれて接続が切れ、
    // worker が作り直されるので「飲まれたか」を一度も測らないまま赤くなる
    let (_broker, _tx) = connect(&dir).await;
    let (_base_sync, base_share) = settle(&dir).await;

    // 次の share を掴ませてから 1 回目の編集
    std::fs::write(dir.join("hold-share"), b"1").unwrap();
    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"a":{}}}"#).unwrap();
    wait_file(&dir, "holding-share", "config を書き換えても share が起きない(AC-2)").await;
    assert_eq!(count(&dir, "share-count"), base_share + 1);

    // **share が掴まれている間に 2 回目の編集**。この share は 1 回目しか見ていない
    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"a":{},"b":{}}}"#).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::remove_file(dir.join("hold-share")).unwrap();

    wait_count(
        &dir,
        "share-count",
        base_share + 2,
        "share の実行中に人が書いた 2 回目の変化が基準の取り直しに飲まれた \
         (その share は 1 回目の中身しか見ていないので、2 つ目の MCP は誰にも提案されない)",
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 3

/// **攻撃**: `openroly watch-dirs` が 1 回だけ失敗したら、その接続の見張りは戻るか？
///
/// 見張る場所は sync のたびに訊き直す。訊けなかった時に「空」を採ると、**一度の失敗が
/// その接続の native 監視を丸ごと殺す**(次に切れて繋ぎ直すまで AC-2 / AC-3 が死ぬ)。
/// 失敗は「分からない」であって「見張る場所が無い」ではない。
#[tokio::test]
async fn watch_dirs_の一度の失敗で見張りが消えない() {
    let dir = tmp_dir("watch-fail");
    write_fake_cli(&dir);
    let (_broker, tx) = connect(&dir).await;
    let (base_sync, _base_share) = settle(&dir).await;

    // 次に訊かれた時だけ落ちる
    std::fs::write(dir.join("fail-watch-dirs"), b"1").unwrap();
    tx.send(json!({ "type": "extensions_changed" })).unwrap();
    wait_count(&dir, "sync-count", base_sync + 1, "extensions_changed で sync が起きない").await;
    tokio::time::sleep(Duration::from_secs(2)).await; // 訊き直しが済むのを待つ
    std::fs::remove_file(dir.join("fail-watch-dirs")).unwrap();

    // ここから改めて基準を取る(sync に付随する share は数に入れない)
    tokio::time::sleep(Duration::from_secs(2)).await;
    let before = count(&dir, "share-count");

    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"playwright":{}}}"#).unwrap();
    wait_count(
        &dir,
        "share-count",
        before + 1,
        "`openroly watch-dirs` が 1 回失敗しただけで、その接続の native 監視が \
         永久に止まった(見張る場所を「空」で上書きした)",
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 攻撃 4

/// **攻撃**: 中身だけ変わって **大きさが同じ** config を拾えるか？
///
/// 見張りは `(mtime, size)` の組。size が動かない書き換え(サーバ名の付け替え)で mtime の
/// 解像度に負けると、AC-2 は「10 秒以内」ではなく **一生来ない**。
#[tokio::test]
async fn 大きさの変わらない書き換えも拾う() {
    let dir = tmp_dir("same-size");
    write_fake_cli(&dir);
    let (_broker, _tx) = connect(&dir).await;

    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"aaa":{}}}"#).unwrap();
    let (_s, base_share) = settle(&dir).await;

    let before = br#"{"mcpServers":{"aaa":{}}}"#.len();
    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"bbb":{}}}"#).unwrap();
    assert_eq!(
        std::fs::metadata(dir.join("native/config.json")).unwrap().len() as usize,
        before,
        "この test の前提(大きさが同じ)が崩れている"
    );

    wait_count(
        &dir,
        "share-count",
        base_share + 1,
        "大きさの変わらない書き換え(サーバ名の付け替え)を見張りが拾えない",
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
}
