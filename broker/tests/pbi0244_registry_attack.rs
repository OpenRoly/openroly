//! PBI-0244（Detector Registry の program deny / probe 引数 allowlist）の攻撃 test。
//!
//! 守っている性質: **署名鍵を 1 本持っているだけでは、全 broker で任意の command を起こせない。**
//! `is_safe_id` は小文字英数を通すので `sh` / `bash` / `python3` は**有効な id** であり、
//! id は `resolve_program` の bare name、`detect.binaries` は version probe の spawn 先になる。
//! つまり deny が無い間は「registry に 1 entry 足す」= 15 秒ごとに全端末で任意 command 実行だった。
//!
//! 撃つ方向:
//!   1. **署名は本物**のまま shell を仕込む（AC-1）
//!   2. probe 引数に `-c` 等を混ぜる（AC-2）
//!   3. `parse` を**迂回**して Registry を組み、scan の spawn 直前を裸で撃つ（AC-3 の二重）
//!   4. dev 鍵で署名した registry を届ける（AC-X1）
//!   5. 大文字 / 版付き / path 付き / 別 field への回り込み
//!
//! `broker` は lib crate を持たない（bin のみ）ので、`#[path]` で src を直接取り込む。

#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;
#[path = "../src/discovery.rs"]
mod discovery;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0244-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// marker を作る「攻撃 payload」。spawn されたかどうかは Err の文言ではなくこの file で見る。
/// **warm しない**(warm は実行そのものなので marker が出来てしまう)。
fn write_touch_script(path: &Path, marker: &Path) {
    fs::write(path, format!("#!/bin/sh\ntouch {}\necho v1.0.0\n", marker.display())).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// 陰性対照に使う「version を返すだけ」の binary。**書いた直後に 1 回空回しする**(warm) ——
/// macOS は新規実行ファイルの初回 exec を syspolicyd が数秒止めることがあり、並列 cargo test の
/// 下では probe の 3s timeout に落ちて version が None になる(discovery.rs の test と同じ対処)。
/// warm を忘れると「deny のせいで None」と「初回起動が遅くて None」を区別できない。
fn write_probe_script(path: &Path) {
    fs::write(path, "#!/bin/sh\necho v1.0.0\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    let _ = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output();
}

fn scan_env(dir: &Path) -> discovery::ScanEnv {
    // 実マシンの PATH / /Applications は見ない（本物の CLI を掴む事故を防ぐ。図18・LEARN 13）
    discovery::ScanEnv::from_vars(
        Some(dir.as_os_str().to_os_string()),
        Some("".into()),
        Some("".into()),
        None,
        None,
    )
}

fn test_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn sign_b64(key: &SigningKey, body: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key.sign(body).to_bytes())
}

/// marker が出来るのを最大 1.5 秒待つ。**「まだ出来ていない」を「起きなかった」と読み違えない**ため
/// （spawn は非同期に見えることがある。ここで待たずに assert すると、実際に起きていても緑になる）。
fn wait_for(marker: &Path) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1500) {
        if marker.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// ---------------------------------------------------------------------------
// 攻撃 1（AC-1）: 署名は**本物**。中身に shell を仕込む
// ---------------------------------------------------------------------------
#[test]
fn 攻撃1_署名が正しくても_shell_を仕込んだ_registry_は_丸ごと拒否される() {
    let dir = tmp("ac1");
    let marker = dir.join("pwned");
    let body = format!(
        r#"{{"version":9,"detectors":[
            {{"id":"claude","detect":{{"binaries":["claude"]}},"version":{{"args":["--version"]}},"adapter":"official/claude"}},
            {{"id":"sh","detect":{{"binaries":["sh"]}},"version":{{"args":["-c","touch {}"]}},"adapter":"x"}}
        ]}}"#,
        marker.display()
    );

    // (a) 署名は正しい —— 「鍵を持っている攻撃者」を実際に再現している事の確認。
    //     ここが Err だと、この後の Err が deny のおかげなのか署名のおかげなのか分からない
    let key = test_key();
    let sig = sign_b64(&key, body.as_bytes());
    assert!(
        registry::verify(body.as_bytes(), &sig, &key.verifying_key()).is_ok(),
        "攻撃の前提が崩れている: 署名が通っていない"
    );

    // (b) それでも parse は registry **ごと** 落とす（違反 entry だけ落として残りを配らない）
    let err = registry::parse(&body, "fetched").unwrap_err();
    assert_eq!(err, r#"registry: forbidden program "sh""#, "{err}");

    // (c) 落ちた後に broker が使うのは built-in。`sh` は allowlist にも ids にも居ない
    let reg = registry::builtin();
    assert_eq!(reg.ids(), vec!["claude", "codex"]);
    assert!(!reg.allowlist().contains(&"sh".to_string()));

    // (d) その registry で scan しても、仕掛けた sh は一度も起きない（marker が出来ない）
    write_touch_script(&dir.join("sh"), &marker);
    let mut cache = discovery::VersionCache::default();
    discovery::scan(&reg, &scan_env(&dir), &mut cache);
    assert!(!wait_for(&marker), "拒否したはずの sh が実行された");
    fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 攻撃 2（AC-2）: program は正規のまま、**引数**で任意コードを持ち込む
// ---------------------------------------------------------------------------
#[test]
fn 攻撃2_probe_引数の_allowlist_外は拒否され_version_は従来どおり取れる() {
    let dir = tmp("ac2");
    let marker = dir.join("pwned");
    let body = format!(
        r#"{{"version":9,"detectors":[{{"id":"claude","detect":{{"binaries":["claude"]}},
            "version":{{"args":["-c","touch {}"]}},"adapter":"official/claude"}}]}}"#,
        marker.display()
    );
    let err = registry::parse(&body, "fetched").unwrap_err();
    assert!(err.starts_with("registry: probe args not allowed"), "{err}");

    // `-p hi`（PBI の AC-2 の具体値）も同じ
    let err2 = registry::parse(
        r#"{"version":9,"detectors":[{"id":"claude","version":{"args":["-p","hi"]}}]}"#,
        "fetched",
    )
    .unwrap_err();
    assert!(err2.starts_with("registry: probe args not allowed"), "{err2}");

    // **陰性対照**: 従来の `--version` は通り、built-in の claude は今までどおり version を取る。
    // これが無いと「全部拒否する」実装でも上の 2 つは緑になる
    write_probe_script(&dir.join("claude"));
    let mut cache = discovery::VersionCache::default();
    let found = discovery::scan(&registry::builtin(), &scan_env(&dir), &mut cache);
    let claude = found.iter().find(|f| f.id == "claude").expect("claude が見つからない");
    assert_eq!(claude.version.as_deref(), Some("v1.0.0"));
    fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 攻撃 3（AC-3 の二重）: `parse` を**迂回**して Registry を組み、spawn 直前だけを裸で撃つ
// ---------------------------------------------------------------------------
#[test]
fn 攻撃3_parse_を迂回しても_probe_は_forbidden_な_program_を_spawn_しない() {
    let dir = tmp("ac3");
    let marker = dir.join("pwned");
    write_touch_script(&dir.join("sh"), &marker);
    write_probe_script(&dir.join("claude"));

    // `parse` を通さずに serde で直接組む = 将来「parse を迂回する経路」が生えた状態の再現
    let reg: registry::Registry = serde_json::from_str(
        r#"{"version":9,"detectors":[
            {"id":"sh","detect":{"binaries":["sh"]},"version":{"args":["--version"]},"adapter":"x"},
            {"id":"claude","detect":{"binaries":["claude"]},"version":{"args":["--version"]},"adapter":"official/claude"}
        ]}"#,
    )
    .unwrap();

    let mut cache = discovery::VersionCache::default();
    let found = discovery::scan(&reg, &scan_env(&dir), &mut cache);

    // 見つけはする（存在の報告は検出の仕事）が、**実行はしない** = version は None
    let sh = found.iter().find(|f| f.id == "sh").expect("sh の Found が無い");
    assert_eq!(sh.version, None, "forbidden な program を probe した");
    assert!(!wait_for(&marker), "迂回経路で sh が実行された");

    // 陰性対照: 同じ scan の中で claude は従来どおり実行され version が取れている
    let claude = found.iter().find(|f| f.id == "claude").expect("claude の Found が無い");
    assert_eq!(claude.version.as_deref(), Some("v1.0.0"));
    fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 攻撃 4（AC-X1）: dev 鍵（`apps/server/.env.local` の平文 seed）で署名した registry を届ける
// ---------------------------------------------------------------------------
#[test]
fn 攻撃4_pin_されていない鍵で署名した_registry_は_fetch_で捨てられ_cache_も汚れない() {
    let dir = tmp("acx1");
    let cache_dir = dir.join("cache");
    fs::create_dir_all(&cache_dir).unwrap();
    let body = r#"{"version":9,"detectors":[{"id":"evil","adapter":"x"}]}"#;
    let sig = sign_b64(&test_key(), body.as_bytes());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{}: {sig}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
        registry::SIGNATURE_HEADER
    );
    let server = std::thread::spawn(move || {
        if let Ok((mut s, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(resp.as_bytes());
            let _ = s.flush();
        }
    });

    let outcome = registry::fetch_and_store(&format!("http://127.0.0.1:{port}/v1/registry/detectors"), &cache_dir, None);
    let _ = server.join();
    assert!(
        matches!(outcome, registry::FetchOutcome::Rejected(_)),
        "pin されていない鍵の registry を受け入れた: {outcome:?}"
    );
    // verify が store より前 = cache に 1 byte も書かれていない
    assert!(!cache_dir.join("detectors.json").exists(), "捨てたはずの body が cache に書かれた");
    assert!(!cache_dir.join("detectors.sig").exists());
    assert_eq!(registry::load(&cache_dir).origin, "builtin");
    fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 攻撃 5: 表の書き方を突く（大文字 / 版付き / path / 別 field / 空白）
// ---------------------------------------------------------------------------
#[test]
fn 攻撃5_大文字や版付きや_path_での回り込みが全部落ちる() {
    // id 側（`resolve_program` の bare name になる）
    for id in ["sh", "bash", "python3", "node", "bun", "osascript", "env", "sudo", "npx"] {
        let body = format!(r#"{{"version":1,"detectors":[{{"id":"{id}","adapter":"x"}}]}}"#);
        assert!(registry::parse(&body, "t").is_err(), "id {id} が通った");
    }
    // binaries 側（probe の spawn 先になる）。大文字・版付き・絶対 path・相対 path
    for b in [
        "SH", "Bash", "python3.12", "python3.13", "node-22", "/bin/sh", "/usr/bin/env",
        "../../../bin/zsh", "/opt/homebrew/bin/deno",
    ] {
        let body = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{b}"]}}}}]}}"#);
        assert!(registry::parse(&body, "t").is_err(), "binary {b} が通った");
    }
    // **陰性対照**: 表の語を接頭辞に持つだけの正規 binary は落とさない
    // （素朴な `starts_with` 実装なら nodemon / opencode がここで落ちる = 検出が壊れる）
    for b in ["nodemon", "opencode", "openclaw", "codex", "claude", "cursor-agent", "kiro-cli", "envoy"] {
        let body = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{b}"]}}}}]}}"#);
        assert!(registry::parse(&body, "t").is_ok(), "正規の binary {b} を落とした");
    }
    // 配布中の catalog と built-in がこの deny を 1 件も踏まないこと（踏むと broker が起動しない）
    let catalog = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/core/registry/detectors.v1.json"),
    )
    .expect("配布 catalog が読めない");
    registry::parse(&catalog, "t").expect("配布中の catalog が deny に掛かっている");
    assert_eq!(registry::builtin().ids(), vec!["claude", "codex"]);
}
