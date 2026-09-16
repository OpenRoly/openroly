//! PBI-0070 レビュー(review: doing)の攻撃 test。newway §14.1: AC-X1/X2/X3 を破りに行く。
//! レビューは実装を直さない(newway §12.2)— ここは test ディレクトリへの追加のみ。
//!
//! `broker` は lib crate を持たないため `#[path]` で src を直接取り込む
//! (`pbi0033_review_attack.rs` と同じ回避策)。launch.rs 末尾の unit test も
//! 一緒にコンパイルされるが重複実行の害は無い。

#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;
#[path = "../src/discovery.rs"]
mod discovery;
#[path = "../src/openroly_cli.rs"]
mod openroly_cli;
#[path = "../src/launch.rs"]
mod launch;
#[path = "../src/c1.rs"]
mod c1;
#[path = "../src/egress.rs"]
mod egress;
#[path = "../src/sandbox.rs"]
mod sandbox;
// PBI-0403 有界レビューで実測: launch.rs の test が `crate::sessions::` を参照するようになった
// ため、sessions.rs も一緒に取り込まないとこのバイナリはコンパイルできない(E0433)。
#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/sessions.rs"]
mod sessions;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn reg_with_api() -> registry::Registry {
    registry::parse(
        r#"{"version":1,"detectors":[
            {"id":"openai-api","kind":"api","detect":{"always":true},"adapter":"official/api"}
        ]}"#,
        "t",
    )
    .unwrap()
    .merged_with_builtin()
}

/// 1 引数 1 行で argv を記録する fake CLI(`echo "$@"` だと引数内の空白が判別できない)。
/// 引数に細工された `touch` を仕込めるので、展開されていれば副作用 file が残る
fn fake_cli(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0070-atk-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("argv.log");
    let pwned = dir.join("pwned");
    let bin = dir.join("fake-openroly");
    fs::write(
        &bin,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}\nexit 0\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    (bin, marker, pwned)
}

/// X2 攻撃: threadId に shell metachar / 空白 / 先頭ダッシュを混ぜても 1 argv 要素のまま。
/// broker は shell を介さないので展開も分割も起きない。副作用 file も残らない。
#[tokio::test]
async fn x2_attack_thread_id_with_metachars_stays_one_argv_element() {
    let (bin, marker, pwned) = fake_cli("inject");
    let evil = format!("th_1; touch {}", pwned.display());
    let argv = vec![bin.to_string_lossy().to_string()];
    let mut child = launch::launch_api(&reg_with_api(), "openai-api", &evil, &argv, None).expect("spawn");
    let _ = child.wait().await;
    let logged = fs::read_to_string(&marker).unwrap();
    let lines: Vec<&str> = logged.lines().collect();
    assert_eq!(lines, vec!["agent", "openai", "--thread", evil.as_str()]);
    assert!(!pwned.exists(), "metachar が展開されてはいけない");
}

/// X2 攻撃 b: `--` に似せた threadId でも argv の末尾に置かれるだけ(先行引数の上書き不能)。
/// `agent` / provider / `--thread` の順は固定で、threadId 側からは触れない
#[tokio::test]
async fn x2_attack_dashdash_like_thread_id_cannot_reorder_argv() {
    let (bin, marker, _pwned) = fake_cli("dashdash");
    let argv = vec![bin.to_string_lossy().to_string()];
    let evil = "--help";
    let mut child = launch::launch_api(&reg_with_api(), "openai-api", evil, &argv, None).expect("spawn");
    let _ = child.wait().await;
    let logged = fs::read_to_string(&marker).unwrap();
    let lines: Vec<&str> = logged.lines().collect();
    assert_eq!(lines, vec!["agent", "openai", "--thread", "--help"]);
}

/// X1 攻撃: registry の外の runtime 名は kind:"api" に見せかけても allowlist が先に弾く。
/// `evil-api`(`-api` 接尾辞で API runtime に偽装)は unknown_runtime で spawn しない
#[tokio::test]
async fn x1_attack_suffixed_impostor_runtime_is_rejected() {
    let (bin, marker, _pwned) = fake_cli("impostor");
    let argv = vec![bin.to_string_lossy().to_string()];
    let result = launch::launch_api(&reg_with_api(), "evil-api", "th_1", &argv, None);
    assert_eq!(result.err(), Some("unknown_runtime".to_string()));
    assert!(!marker.exists(), "spawn してはいけない");
}
