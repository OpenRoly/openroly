//! PBI-0213: 常時同期。**人が `openroly sync` / `openroly share` を打たなくても揃う**。
//!
//! 測る対象は実物の WS ループと worker なので、`pbi0248` と同じく **本物の broker binary を
//! 起こして fake の Cloud(WS server)から話しかける**。数えるのは **子プロセスの入口**
//! (fake CLI 自身が書く file) —— broker 側の写しは「渡したつもり」までしか守らない。
//!
//! 同時実行は **時間ではなく重なりで測る**: fake CLI が `live/` を作り、既に在れば
//! `overlap` に 1 行 = 2 本同時に走った。閾値で測ると混んだ機械で偽の赤になる。

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

/// hang 止め(測定の閾値ではない)。健全な実行はこの何十分の 1 で返る。
const CONNECT_DEADLINE: Duration = Duration::from_secs(90);
/// file が現れるのを待つ上限。native poll は 2s なので、その数周分。
const OBSERVE_DEADLINE: Duration = Duration::from_secs(30);

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0213-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("live")).unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    // 見張られる側(fake の native config / skills dir)。**skills は最初は作らない** ——
    // 「後から現れた dir」を拾えるかが AC-3 の本体
    std::fs::create_dir_all(dir.join("native")).unwrap();
    std::fs::write(dir.join("native/config.json"), b"{}").unwrap();
    dir
}

/// fake `openroly`。broker が起こす 4 つの口を全部持つ:
///   - `watch-dirs` … 見張る場所を 1 行 1 path で返す(config file と まだ無い skills dir)
///   - `sync` / `share` … `<cmd>-count` に 1 行。`live/<cmd>` の重なりを `overlap` に記録
///   - `adopt` … stdin を読み捨てて成功する(materialize の入口は PBI-0248 で測り済み)
fn write_fake_cli(dir: &Path) -> PathBuf {
    let d = dir.display().to_string();
    let script = format!(
        "#!/bin/sh\n\
         cmd=\"$1\"\n\
         case \"$cmd\" in\n\
         \x20 watch-dirs)\n\
         \x20   echo \"{d}/native/config.json\"\n\
         \x20   echo \"{d}/native/skills\"\n\
         \x20   exit 0 ;;\n\
         \x20 adopt)\n\
         \x20   cat >/dev/null\n\
         \x20   exit 0 ;;\n\
         esac\n\
         mkdir \"{d}/live/$cmd\" 2>/dev/null || echo \"$cmd\" >> \"{d}/overlap\"\n\
         echo \"$cmd\" >> \"{d}/$cmd-count\"\n\
         if [ -f \"{d}/hold-$cmd\" ]; then\n\
         \x20 while [ ! -f \"{d}/gate\" ]; do sleep 0.05; done\n\
         fi\n\
         sleep 0.2\n\
         rmdir \"{d}/live/$cmd\" 2>/dev/null\n\
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
        .env("OPENROLY_RUNTIME_TOKEN", "par_pbi0213")
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

/// hello(1 通目)を待つ。以後この test は frame をほとんど読まないので、ping には答え続ける
/// 別 task を回す —— 答えないと broker が idle で切って T0 をやり直し、数が二重になる。
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

/// `name` の行数が `at_least` に届くまで待つ。届かなければ log を持って落ちる。
async fn wait_count(dir: &Path, name: &str, at_least: usize) -> usize {
    let deadline = Instant::now() + OBSERVE_DEADLINE;
    loop {
        let n = count(dir, name);
        if n >= at_least {
            return n;
        }
        if Instant::now() >= deadline {
            panic!(
                "{name} が {at_least} 行に届かない(今 {n} 行)。broker.log = {:?}",
                std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------- AC-5 / AC-1 / AC-X3

/// AC-5: 接続確立(T0)だけで `openroly sync` と `openroly share --auto` が 1 本ずつ走る。
/// AC-1: `extensions_changed` を受けると `openroly sync` がもう 1 本走る(Cloud は中身を送らない)。
/// AC-X3: 3 連発でも **同時 1 本 + 再予約 1 回** —— 3 本走らないし重ならない。
#[tokio::test]
async fn t0_と_extensions_changed_で_sync_が走り_3連発でも重ならない() {
    let dir = tmp_dir("burst");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let ws = accept(&dir, &listener).await;
    let tx = hello_then_pong(ws).await;

    // AC-5: 誰も何も送っていないのに T0 で両方向が 1 回ずつ
    wait_count(&dir, "sync-count", 1).await;
    wait_count(&dir, "share-count", 1).await;

    // ここまでを基準にする(T0 の分を burst の数に混ぜない)
    tokio::time::sleep(Duration::from_millis(600)).await; // 走行中の 1 本を終わらせる
    let base_sync = count(&dir, "sync-count");

    // AC-1 / AC-X3: 3 連発
    for _ in 0..3 {
        tx.send(json!({ "type": "extensions_changed" })).unwrap();
    }
    wait_count(&dir, "sync-count", base_sync + 1).await;
    tokio::time::sleep(Duration::from_secs(3)).await; // 再予約分が走り切るのを待つ

    let after = count(&dir, "sync-count") - base_sync;
    assert!(
        (1..=2).contains(&after),
        "3 連発の `extensions_changed` で sync が {after} 本走った(1 本 + 再予約 1 回まで)。\
         broker.log = {:?}",
        std::fs::read_to_string(dir.join("broker.log")).unwrap_or_default()
    );
    assert!(
        !dir.join("overlap").exists(),
        "sync / share が同時に 2 本走った: {:?}",
        std::fs::read_to_string(dir.join("overlap")).unwrap_or_default()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- AC-2 / AC-3

/// AC-2 / AC-3: **端末側の変化**(config file の編集 / まだ無かった skills dir の出現)で
/// `openroly share --auto` が走る。人は `openroly share` を打たない。
#[tokio::test]
async fn native_の変化で_share_が走る() {
    let dir = tmp_dir("native");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let ws = accept(&dir, &listener).await;
    let _tx = hello_then_pong(ws).await;

    wait_count(&dir, "share-count", 1).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let base = count(&dir, "share-count");

    // AC-2: config に MCP を 1 つ手で足した
    std::fs::write(dir.join("native/config.json"), br#"{"mcpServers":{"playwright":{}}}"#).unwrap();
    let after_config = wait_count(&dir, "share-count", base + 1).await;

    tokio::time::sleep(Duration::from_millis(800)).await;
    let base2 = count(&dir, "share-count").max(after_config);

    // AC-3: **接続時には存在しなかった** skills dir が現れ、その中に skill が 1 つ
    std::fs::create_dir_all(dir.join("native/skills/foo")).unwrap();
    wait_count(&dir, "share-count", base2 + 1).await;

    assert!(
        !dir.join("overlap").exists(),
        "share が同時に 2 本走った: {:?}",
        std::fs::read_to_string(dir.join("overlap")).unwrap_or_default()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- AC-4

/// AC-4: `registered` を materialize して ok を返した直後に、sync と share が走る
/// (新しい runtime に既存 extension が載り、その runtime に在った物が提案に上がる)。
#[tokio::test]
async fn adopt_成功の直後に_sync_と_share_が走る() {
    let dir = tmp_dir("adopt");
    write_fake_cli(&dir);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let ws = accept(&dir, &listener).await;
    let tx = hello_then_pong(ws).await;

    wait_count(&dir, "sync-count", 1).await;
    wait_count(&dir, "share-count", 1).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (base_sync, base_share) = (count(&dir, "sync-count"), count(&dir, "share-count"));

    tx.send(json!({
        "type": "registered",
        "runtimes": [{
            "kind": "opencode", "runtime_id": "rt_new", "token": "par_x",
            "base_url": "http://127.0.0.1:1", "name": "M"
        }]
    }))
    .unwrap();

    wait_count(&dir, "sync-count", base_sync + 1).await;
    wait_count(&dir, "share-count", base_share + 1).await;
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- AC-X2

/// AC-X2: `openroly sync` が返らなくても **WS ループは止まらない**。返らない sync を掴ませたまま
/// wake を投げ、`wake_result` が返ることで確かめる(旧実装のようにループの中で待つと、
/// この frame は sync が終わるまで返らない)。
#[tokio::test]
async fn 返らない_sync_を掴んでも_ws_ループは応答する() {
    let dir = tmp_dir("hang");
    write_fake_cli(&dir);
    // T0 の sync を `gate` が現れるまで居座らせる
    std::fs::write(dir.join("hold-sync"), b"1").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _broker = spawn_broker(&dir, port);
    let mut ws = accept(&dir, &listener).await;

    // hello を読み飛ばす
    let first = tokio::time::timeout(CONNECT_DEADLINE, ws.next()).await.unwrap().unwrap().unwrap();
    assert!(matches!(first, Message::Text(_)));
    wait_count(&dir, "sync-count", 1).await; // sync は掴まれたまま

    ws.send(Message::Text(
        json!({ "type": "wake", "runtime": "nope", "requestId": "wr_1" }).to_string().into(),
    ))
    .await
    .unwrap();

    // sync が居座っている間に wake_result が返る = ループは動いている
    let deadline = Instant::now() + Duration::from_secs(20);
    let got = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = tokio::time::timeout(left, ws.next())
            .await
            .expect("wake_result が返らない(WS ループが sync を待って止まっている)")
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == "ping" {
                ws.send(Message::Text(json!({"type":"pong"}).to_string().into())).await.unwrap();
                continue;
            }
            if v["type"] == "wake_result" {
                break v;
            }
        }
    };
    // **前提そのものを測る**: sync がまだ居座っているか。ここを見ないと、fake の hold が
    // 効いていない(= sync が一瞬で終わった)時にこの test が「ループは止まらない」を
    // 一度も測らないまま緑になる
    assert!(
        dir.join("live/sync").exists(),
        "wake_result が返った時点で sync が既に終わっていた(hold が効いていない = 何も測っていない)"
    );
    assert_eq!(got["requestId"], "wr_1");
    assert_eq!(got["ok"], false, "未知の runtime は起こさない");
    assert_eq!(count(&dir, "sync-count"), 1, "居座っている間に 2 本目が立った");

    std::fs::write(dir.join("gate"), b"1").unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
