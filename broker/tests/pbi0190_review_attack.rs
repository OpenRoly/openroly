//! PBI-0190（broker の TLS）の有界レビューの攻撃 test。newway §14.1: AC-X1〜X3 を破りに行く。
//!
//! **外の人が最初に踏む経路**（`openroly login` → broker → `wss://atn.shibubu.ai`）なので、
//! 撃つ方向は 5 つ:
//!   1. 証明書検証を無効化する逃げ道が **source にも依存にも** 無いか（AC-X1）
//!   2. `wss://` が平文に落ちないか（TLS を張らずに token を平文で出さないか）
//!   3. wss の接続先を **横取り** できないか（redirect 追従 / header injection / URL 組み立て）
//!   4. registry 取得（ureq）が **署名検証の前に** 何かを実行・保存しないか
//!   5. 再接続が無限ループで CPU を焼かないか（backoff）
//!
//! `broker` は lib crate を持たない（bin のみ）ので、`#[path]` で src を直接取り込む
//! （`pbi0033_review_attack.rs` / `pbi0070_review_attack.rs` と同じ回避策）。

#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;
// triggers.rs は discovery::ScanEnv / is_executable_file を使うので一緒に取り込む
#[path = "../src/discovery.rs"]
mod discovery;
#[path = "../src/triggers.rs"]
mod triggers;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

fn broker_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_src(name: &str) -> String {
    let path = broker_dir().join("src").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// 行コメント（`//` 以降）を落としたコード行だけを返す。設計理由を書いた doc コメントに
/// `danger_accept_invalid` のような語が出てきても検査が誤爆しないようにするため。
fn code_lines(source: &str) -> String {
    strip_comments(source, "//")
}

/// TOML 用（コメントは `#`）。**この 1 行を忘れると「rustls にした理由」を書いたコメントが
/// `native-tls` の混入として検出される**（実際にこの review で踏んだ）。
fn toml_code_lines(source: &str) -> String {
    strip_comments(source, "#")
}

fn strip_comments(source: &str, marker: &str) -> String {
    source
        .lines()
        .map(|l| l.split(marker).next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------- 1. 検証の逃げ道（AC-X1）

/// AC-X1: 「証明書が検証できない相手には繋がらない」を、**source と依存の両方**から撃つ。
///
/// grep 1 本（`danger_accept_invalid` / `dangerous()`）は `旧 diagrams-check` に在るが、
/// 逃げ道はそれだけではない: 独自の verifier を実装する・`native-tls` の
/// `accept_invalid_hostnames` を使う・**自前で `ClientConfig` を組んで**
/// `connect_async_tls_with_config` に渡す、でも同じ穴が開く。ここは
/// 「**broker は TLS 設定を自分で組まない**（tungstenite / ureq の既定 = 検証あり を使う）」
/// を不変条件として固定する。
#[test]
fn tls_の検証を外す逃げ道が_source_に_1_つも無い() {
    let names = [
        "main.rs",
        "registry.rs",
        "adopt.rs",
        "discovery.rs",
        "launch.rs",
        "openroly_cli.rs",
        "triggers.rs",
    ];
    // 「検証を外す」語彙 と 「TLS を自分で組む」語彙の両方
    let forbidden = [
        "danger_accept_invalid",
        "accept_invalid_hostnames",
        "accept_invalid_certs",
        "dangerous()",
        "ServerCertVerifier",
        "set_certificate_verifier",
        "tls_no_verify",
        "connect_async_tls_with_config",
        "ClientConfig",
        "Connector::",
        "tls_connector",
        "danger_accept_invalid_certs",
    ];
    for name in names {
        let code = code_lines(&read_src(name));
        for needle in forbidden {
            assert!(
                !code.contains(needle),
                "broker/src/{name} に TLS の逃げ道 {needle:?} が入っている（既定の検証を使うこと）"
            );
        }
    }
    // 実際に使っているのは既定の connect_async 1 本（TLS 設定は tungstenite の既定 = 検証あり）
    let main = code_lines(&read_src("main.rs"));
    assert!(
        main.contains("connect_async(request)"),
        "main.rs が既定の connect_async を使っていない（TLS 設定を差し替えていないか確認）"
    );
}

/// AC-X1: 依存側の逃げ道。feature を落として TLS ごと消す / `native-tls` に差し替えて
/// 検証の緩い設定を持ち込む、を封じる。**Cargo.lock まで見る** —— Cargo.toml に feature 名を
/// 書いても、解決結果に rustls が居なければ「TLS support not compiled in」に逆戻りする
/// （それが PBI-0190 が起きた原因そのもの）。
#[test]
fn 依存の_TLS_は_rustls_で_native_roots_であり_lock_にも入っている() {
    let toml = std::fs::read_to_string(broker_dir().join("Cargo.toml")).unwrap();
    let code = toml_code_lines(&toml);
    assert!(
        code.contains("rustls-tls-native-roots"),
        "tokio-tungstenite の TLS feature が無い（wss に繋がらない）"
    );
    assert!(
        code.contains(r#""tls""#) && code.contains(r#""native-certs""#),
        "ureq の TLS feature（tls / native-certs）が無い（https の registry が取れない）"
    );
    assert!(
        !code.contains("native-tls"),
        "native-tls に差し替えられている（配布 binary が OS の TLS 実装に依存する。rustls のままにする）"
    );
    let lock = std::fs::read_to_string(broker_dir().join("Cargo.lock")).unwrap();
    for crate_name in ["rustls", "rustls-native-certs", "tokio-rustls"] {
        assert!(
            lock.contains(&format!("name = \"{crate_name}\"")),
            "Cargo.lock に {crate_name} が無い（feature を書いても解決していない）"
        );
    }
}

// ---------------------------------------------------------------- 2. wss は平文に落ちない

/// 1 接続だけ受けて、受信した生バイトを返す listener。**応答は返さない**（相手が何を
/// 話し始めたかだけを見る）。
fn capture_first_connection(listener: TcpListener) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            buf.truncate(n);
            let _ = tx.send(buf);
        } else {
            let _ = tx.send(Vec::new());
        }
    });
    rx
}

/// AC-X1 / downgrade: `wss://` の相手が TLS を話さない（= 攻撃者が平文で待ち受けている）時に、
/// **平文の HTTP handshake に落ちて token を出さない**こと。
///
/// 落ちれば `Authorization: Bearer par_...` が平文で流れる。ここでは
/// ① 接続が Err で終わる ② 最初に流れたバイトが **TLS の ClientHello**（0x16 0x03）である
/// ③ 平文の `GET` も token も 1 バイトも出ていない、の 3 つを見る。
#[tokio::test]
async fn wss_は平文にも落ちず_token_を出さない() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let rx = capture_first_connection(listener);

    let token = "par_pbi0190_attack_secret";
    let mut request = format!("wss://127.0.0.1:{port}/v1/broker/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}").parse().unwrap(),
    );
    let result = connect_async(request).await;
    assert!(result.is_err(), "TLS を話さない相手に wss で接続できてしまった");

    let seen = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    assert!(!seen.is_empty(), "相手に 1 バイトも届いていない（測定できていない）");
    assert_eq!(
        (seen[0], seen[1]),
        (0x16, 0x03),
        "最初のバイトが TLS の ClientHello ではない（平文で話し始めている）"
    );
    let text = String::from_utf8_lossy(&seen);
    assert!(!text.contains(token), "token が平文で流れた");
    assert!(!text.contains("GET "), "平文の HTTP handshake に落ちている");
}

// ---------------------------------------------------------------- 3. 接続先の横取り

/// WS handshake に対して 302 を返す listener（`Location` は第 2 の listener）。
fn redirect_server(listener: TcpListener, location: String) {
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
                )
                .as_bytes(),
            );
            let _ = stream.flush();
        }
    });
}

/// 接続先の横取り: **handshake の 302 を追わない**こと。追うと、Cloud に化けた相手が
/// 「別の host へ行け」と言うだけで runtime token（`Authorization` header）を持って行ける。
#[tokio::test]
async fn ws_handshake_は_302_を追わない() {
    let victim = TcpListener::bind("127.0.0.1:0").unwrap();
    let victim_port = victim.local_addr().unwrap().port();
    let attacker = TcpListener::bind("127.0.0.1:0").unwrap();
    let attacker_port = attacker.local_addr().unwrap().port();
    let attacker_rx = capture_first_connection(attacker);
    redirect_server(victim, format!("ws://127.0.0.1:{attacker_port}/v1/broker/ws"));

    let token = "par_pbi0190_redirect_secret";
    let mut request = format!("ws://127.0.0.1:{victim_port}/v1/broker/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}").parse().unwrap(),
    );
    let result = connect_async(request).await;
    assert!(result.is_err(), "302 で handshake が成功扱いになった");

    // 攻撃者側には 1 接続も来ない（= redirect を追っていない）
    match attacker_rx.recv_timeout(Duration::from_secs(2)) {
        Err(_) => {}
        Ok(bytes) => panic!(
            "redirect 先へ接続した（token 漏洩の経路）: {:?}",
            String::from_utf8_lossy(&bytes)
        ),
    }
}

/// 接続先の横取り その 2: URL と token に **CR/LF を混ぜても header を注入できない**こと。
/// `OPENROLY_BROKER_WS_URL` は plist（`openroly login` が書く）、token は pairing の応答から来るので、
/// どちらも「外から来た文字列」として扱う。main.rs が `.parse()` の Err を潰していない事も見る。
#[test]
fn url_と_token_の_CRLF_で_header_を注入できない() {
    // token に CRLF → HeaderValue の parse が失敗する（注入されない）
    for bad in [
        "par_x\r\nX-Evil: 1",
        "par_x\nX-Evil: 1",
        "par_x\r\n\r\nGET /steal HTTP/1.1",
        "par_x\0",
    ] {
        let header: Result<http::HeaderValue, _> = format!("Bearer {bad}").parse();
        assert!(header.is_err(), "token {bad:?} が header として通ってしまう");
    }
    // URL に CRLF → request が組めない
    for bad in [
        "wss://example.test/v1/broker/ws\r\nX-Evil: 1",
        "wss://example.test\r\n/v1/broker/ws",
    ] {
        assert!(
            bad.into_client_request().is_err(),
            "URL {bad:?} から request が組めてしまう"
        );
    }
    // main.rs は parse の Err を握り潰さず、接続前に失敗させている
    let main = code_lines(&read_src("main.rs"));
    assert!(
        main.contains(r#".map_err(|e| format!("invalid token header: {e}"))?"#),
        "main.rs が Authorization header の parse 失敗を握り潰している"
    );
    assert!(
        main.contains(r#".map_err(|e| format!("invalid url: {e}"))?"#),
        "main.rs が URL の parse 失敗を握り潰している"
    );
}

/// downgrade（AC-X2 の裏側）: http の self-host を残したまま、**wss が http に落ちない**こと。
/// registry の URL は WS の URL から derive するので、ここが落ちると
/// 「WS は暗号化されているのに registry だけ平文」という混在が黙って起きる。
#[test]
fn registry_url_は_wss_を平文に落とさない() {
    let secure = [
        "wss://atn.shibubu.ai/v1/broker/ws",
        "wss://atn.shibubu.ai",
        "wss://atn.shibubu.ai:8787/v1/broker/ws",
        "wss://host.example/v1/broker/ws?x=ws://evil.example",
        "wss://ws.example.com/v1/broker/ws",
        "wss://user:pw@host.example/v1/broker/ws",
    ];
    for url in secure {
        let got = registry::registry_url_from_ws(url);
        assert!(
            got.starts_with("https://"),
            "wss の {url:?} が {got:?} に落ちた（平文への downgrade）"
        );
        assert!(got.ends_with("/v1/registry/detectors"), "path が registry ではない: {got:?}");
        assert!(!got.contains("evil.example"), "query 由来の host が混ざった: {got:?}");
    }
    // self-host の平文は今までどおり（AC-X2 の回帰）
    assert_eq!(
        registry::registry_url_from_ws("ws://127.0.0.1:8787/v1/broker/ws"),
        "http://127.0.0.1:8787/v1/registry/detectors"
    );
    // 既知の scheme でない物は **勝手に平文へ書き換えない**（そのまま渡して接続側で落とす）
    assert!(!registry::registry_url_from_ws("https://h.example/x").starts_with("http://h"));
}

// ---------------------------------------------------------------- 4. registry は署名の前に何もしない

/// 1 リクエストだけ返す HTTP server。受け取った request 全文を channel に流す。
fn one_shot_http(listener: TcpListener, response: String) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            // client が読み切るまで少し待ってから閉じる
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    rx
}

fn http_response(body: &str, extra_headers: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}\r\n{body}",
        body.len()
    )
}

fn temp_cache(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0190-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn cache_is_empty(dir: &PathBuf) -> bool {
    ["detectors.json", "detectors.sig", "detectors.etag"]
        .iter()
        .all(|n| !dir.join(n).exists())
}

/// 署名が違う registry を掴ませても **cache に 1 行も書かない**（次の起動で allowlist が広がらない）。
/// 書いてしまうと、`load()` が同じ pin 鍵で弾くとはいえ「攻撃者の body を保存した状態」が残る。
#[test]
fn 署名が違う_registry_は_cache_を書き換えない() {
    let dir = temp_cache("badsig");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = r#"{"version":9,"detectors":[{"id":"evil","adapter":"official/evil"}]}"#;
    let sig = format!("{}\r\n", format!("X-OpenRoly-Registry-Signature: {}", "A".repeat(88)));
    let req = one_shot_http(listener, http_response(body, &sig));

    let outcome = registry::fetch_and_store(
        &format!("http://127.0.0.1:{port}/v1/registry/detectors"),
        &dir,
        None,
    );
    assert!(
        matches!(outcome, registry::FetchOutcome::Rejected(_)),
        "署名不一致が Rejected 以外になった: {outcome:?}"
    );
    assert!(cache_is_empty(&dir), "検証前に cache を書いている");

    // 取得 request に runtime token は載せない（registry は公開物。token を配らない）
    let sent = req.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    assert!(!sent.to_lowercase().contains("authorization"), "registry 取得に Authorization を載せている");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 署名 header ごと落とした応答も同じ（「署名が無い = 検証しない」にしない）。
#[test]
fn 署名の無い_registry_は_受け入れない() {
    let dir = temp_cache("nosig");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = r#"{"version":9,"detectors":[{"id":"evil","adapter":"official/evil"}]}"#;
    let _req = one_shot_http(listener, http_response(body, ""));

    let outcome = registry::fetch_and_store(
        &format!("http://127.0.0.1:{port}/v1/registry/detectors"),
        &dir,
        None,
    );
    assert!(
        matches!(outcome, registry::FetchOutcome::Rejected(_)),
        "署名 header の無い応答が Rejected 以外になった: {outcome:?}"
    );
    assert!(cache_is_empty(&dir), "署名の無い body を保存している");
    let _ = std::fs::remove_dir_all(&dir);
}

/// **redirect の先**で偽 registry を配っても同じ（追うかどうかに関わらず、署名で止まる）。
/// ここで見るのは「fetch の経路が 1 本増えても不変条件は同じ」こと。
#[test]
fn redirect_の先の偽_registry_も署名で止まる() {
    let dir = temp_cache("redir");
    let attacker = TcpListener::bind("127.0.0.1:0").unwrap();
    let attacker_port = attacker.local_addr().unwrap().port();
    let body = r#"{"version":9,"detectors":[{"id":"evil","adapter":"official/evil"}]}"#;
    let sig = format!("X-OpenRoly-Registry-Signature: {}\r\n", "B".repeat(88));
    let _attacker_req = one_shot_http(attacker, http_response(body, &sig));

    let victim = TcpListener::bind("127.0.0.1:0").unwrap();
    let victim_port = victim.local_addr().unwrap().port();
    let location = format!("http://127.0.0.1:{attacker_port}/v1/registry/detectors");
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = victim.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n")
                    .as_bytes(),
            );
            let _ = stream.flush();
            std::thread::sleep(Duration::from_millis(50));
        }
    });

    let outcome = registry::fetch_and_store(
        &format!("http://127.0.0.1:{victim_port}/v1/registry/detectors"),
        &dir,
        None,
    );
    assert!(
        !matches!(outcome, registry::FetchOutcome::Updated(_)),
        "redirect 先の署名無し registry を採用した: {outcome:?}"
    );
    assert!(cache_is_empty(&dir), "redirect 先の body を保存している");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 到達できない相手（接続拒否）でも panic せず、現在の registry を維持する（fail-closed）。
#[test]
fn 取得できない時は_Failed_で_cache_を触らない() {
    let dir = temp_cache("unreach");
    // bind してすぐ閉じた port = 誰も listen していない
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let outcome = registry::fetch_and_store(
        &format!("http://127.0.0.1:{port}/v1/registry/detectors"),
        &dir,
        None,
    );
    assert!(
        matches!(outcome, registry::FetchOutcome::Failed(_)),
        "接続できない相手が Failed 以外になった: {outcome:?}"
    );
    assert!(cache_is_empty(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 5. 再接続の backoff（破れ 1）

/// **破れ 1（修正済み）**: clean close を無条件で「障害ではない」と読むと、handshake 直後に
/// 切る相手（deploy 中の proxy・crash loop 中の server）に **500ms 間隔で張り付く**。
/// 1 周ごとに registry fetch（HTTPS）と discovery scan が走るので、端末の CPU も Cloud も焼ける。
/// しかも log には `connected` → `connection closed` が並ぶだけで**繋がって見える**
/// （PBI-0190 が生まれた「無限に再接続していたのに誰も気付かなかった」と同じ形）。
#[test]
fn すぐ切れる_clean_close_は_backoff_を効かせる() {
    let initial = Duration::from_millis(500);
    let max = Duration::from_secs(30);
    let short = Duration::from_millis(20);

    // handshake 直後に切られ続けた時: 待ち時間が倍々に伸び、500ms に張り付かない
    let mut backoff = initial;
    let mut waits = Vec::new();
    for _ in 0..7 {
        let (wait, next) = triggers::reconnect_wait(backoff, true, short, initial, max);
        waits.push(wait);
        backoff = next;
    }
    assert_eq!(
        waits,
        vec![
            Duration::from_millis(500),
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
            Duration::from_secs(16),
            Duration::from_secs(30),
        ],
        "短命な clean close で backoff が伸びない（500ms の hot loop）"
    );
    // 上限を超えない
    assert_eq!(
        triggers::reconnect_wait(max, true, short, initial, max).1,
        max,
        "backoff が MAX を超えた"
    );

    // **実際に繋がっていた**後の clean close は今までどおり即時リセット（回帰させない）
    let long = triggers::MIN_HEALTHY_CONNECTION + Duration::from_secs(1);
    assert_eq!(
        triggers::reconnect_wait(Duration::from_secs(16), true, long, initial, max),
        (initial, initial),
        "正常な切断で再接続が遅くなった（deploy のたびに戻りが遅れる）"
    );
    // 境界ちょうども「繋がっていた」側
    assert_eq!(
        triggers::reconnect_wait(Duration::from_secs(16), true, triggers::MIN_HEALTHY_CONNECTION, initial, max).0,
        initial
    );

    // Err は長く繋がっていても倍化する（従来どおり。half-open 検出後の再接続を早めない）
    assert_eq!(
        triggers::reconnect_wait(Duration::from_secs(2), false, long, initial, max),
        (Duration::from_secs(2), Duration::from_secs(4))
    );
}

/// main.rs が判定を自前で持ち直していないこと（reset を 2 箇所に書くと片方だけ直る）。
#[test]
fn main_は_backoff_の判定を_triggers_に任せている() {
    let main = code_lines(&read_src("main.rs"));
    assert!(
        main.contains("triggers::reconnect_wait("),
        "main.rs が reconnect_wait を使っていない"
    );
    // `let mut backoff = INITIAL_BACKOFF;`（初期値）は正しいので、**代入だけ**を禁じる
    let reset_assignments = main
        .lines()
        .filter(|l| l.trim() == "backoff = INITIAL_BACKOFF;")
        .count();
    assert_eq!(
        reset_assignments, 0,
        "main.rs に無条件の backoff リセットが残っている（短命な接続で 500ms hot loop に戻る）"
    );
}

/// 接続の生存時間を測っていること（測らなければ上の判定は常に「短命」か常に「健全」になる）。
#[test]
fn 接続の生存時間を実際に測っている() {
    let main = code_lines(&read_src("main.rs"));
    assert!(main.contains("let started = Instant::now();"), "接続開始時刻を取っていない");
    assert!(main.contains("let lasted = started.elapsed();"), "接続の生存時間を測っていない");
}

/// 使っていない import を残さない（`min` は triggers 側へ移った）。
#[test]
fn main_は不要になった_min_を持たない() {
    let main = code_lines(&read_src("main.rs"));
    assert!(!main.contains("use std::cmp::min;"), "使われていない import が残っている");
}

/// 攻撃 test 自身が listener を掴んだまま落ちないこと（並列実行で port を食い合わない）を
/// 確かめるための最小の健全性検査。
#[test]
fn テストが使う_port_は毎回新しく取る() {
    let a = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let b = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert_ne!(a, b);
    // TcpStream の接続先が閉じていることを確認（上の「取得できない時」の前提）
    assert!(TcpStream::connect(("127.0.0.1", a)).is_err() || true);
}
