//! PBI-0033 レビューステージ(review: doing)の固定 3 行を実際に破りに行く攻撃 test。
//! newway §14.1: (b) AC-X1(別actor) / AC-X2(失敗経路) / AC-X3(並行)。
//! レビューは実装を直さない(newway §12.2)。ここは test ディレクトリへの追加のみ。
//!
//! `broker` は lib crate を持たず bin のみ(`Cargo.toml` に `[lib]` が無い)ため、
//! integration test から `launch::launch_with_allowlist` 等を直接呼ぶには `#[path]` で
//! 対象 src を直接このテストバイナリへ取り込む(`no_process_env_mutation.rs` と同じ、
//! production code を書き換えずに済ませる標準的な回避策)。`launch.rs` 末尾の
//! `#[cfg(test)] mod tests` もこのバイナリ内で一緒にコンパイル・実行されるが、
//! 既存 unit test の重複実行が害になる副作用は無い。

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

/// PBI-0441 ③: test では C1 を掛けない(pane / CI は root op を打てない)。C1 の形は c1.rs の test が fake で武装する
static C1_OFF: c1::C1Status = c1::C1Status { available: false, reason: String::new() };
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

/// PBI-0238: dedicated session は sandbox backend を要る。この test は判定より手前で止まるので
/// backend 無し(`NoSandbox`)で足りる —— 万一すり抜けても `sandbox_unavailable` で spawn しない。
static NO_SANDBOX: sandbox::NoSandbox = sandbox::NoSandbox { reason: String::new() };
fn attack_isolation() -> launch::Isolation<'static> {
    launch::Isolation {
        sandbox: &NO_SANDBOX,
        egress: egress::EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None },
        folder: None,
        lane: "manual",
        user_home: std::env::temp_dir(),
        c1: &C1_OFF,
    }
}

/// 閉じ込め(PBI-0167)の判定に使う path。この test は判定より手前で止まることを見るので、
/// claude config も codex config も**存在しない** path で足りる。
fn attack_containment_env() -> launch::ContainmentEnv {
    launch::ContainmentEnv {
        claude_config: std::path::PathBuf::from("/nonexistent/.claude.json"),
        claude_plugin_registry: std::path::PathBuf::from("/nonexistent/installed_plugins.json"),
        codex_config: std::path::PathBuf::from("/nonexistent/config.toml"),
    }
}

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-broker-attack-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// AC-X1(別actor): registry に無い(=未承認の)runtime 名を名乗って dedicated session を
/// 起こそうとしても、cwd 固定(PBI-0033)の経路 —— `launch_with_allowlist` の spawn(と
/// stdout.log/stderr.log の作成)—— には一切到達しないことを破りに行く。runtime 名に
/// シェルメタ文字を混ぜても `Command::new` は shell を経由しないため無意味だが、
/// そもそも判定で止まることを確認する。
///
/// `stdout.log` の有無で見る(instruction.txt の有無では見ない): `launch_session_scoped_in` は
/// `create_dir_all` → `instruction.txt` 書込 → `check_launchable` の順で、判定より前の
/// 副作用(session_dir/instruction.txt が残る — PBI-0033 G2「未決の問い」)自体は
/// **直すべきバグ側**として指摘済みなので、それを固定するアサーションは書かない
/// (直った瞬間にこの攻撃 test が壊れて「修正を罰する」)。`stdout.log`/`stderr.log` は
/// `launch_with_allowlist` の `session_dir` 分岐(allowlist と `dedicated_args` の両方を
/// 通った後)でしか作られないので、無いことは「spawn/cwd 固定に到達していない」ことの
/// 直接証拠になる。
#[tokio::test]
async fn x1_unregistered_actor_never_reaches_spawn_or_cwd_fixation() {
    let home = tmp("x1");
    let result = launch::launch_session_scoped_in(
        &home,
        &registry::builtin(),
        &[],
        "evil-runtime; rm -rf /",
        "INSTR",
        "req-x1",
        None,
        &attack_containment_env(),
        &attack_isolation(), None,
    );
    assert_eq!(
        result.err(),
        Some("unknown_runtime".to_string()),
        "未登録 runtime は spawn 一歩手前(check_launchable)で拒否されるべき"
    );
    assert!(
        !home.join("sessions").join("req-x1").join("stdout.log").exists(),
        "spawn(cwd 固定を含む)に到達していないこと"
    );
    let _ = fs::remove_dir_all(&home);
}

/// AC-X1(別actor・cwd 選択の乗っ取り): 未承認の actor(Cloud からの wake メッセージ)が
/// 直接コントロールできる唯一の cwd 因子は `requestId` —— そこに path traversal /
/// 絶対パスを混ぜて `session_dir`(= 固定される cwd)を actor が選んだ場所へ逃がせないかを
/// 破りに行く。`is_safe_request_id` が英数と `_`/`-` 以外を全部弾く前提なので、
/// `invalid_request_id` で止まり、`home` の外は疎か `home/sessions/` の外にも
/// 何も作られないはず。
#[tokio::test]
async fn x1b_actor_cannot_steer_cwd_via_request_id_path_traversal() {
    let home = tmp("x1b");
    for evil_id in ["../../evil", "/etc", "..%2f..%2fevil", "a/../../b"] {
        let result = launch::launch_session_scoped_in(
            &home,
            &registry::builtin(),
            &[],
            "claude",
            "INSTR",
            evil_id,
            None,
            &attack_containment_env(),
            &attack_isolation(), None,
        );
        assert_eq!(
            result.err(),
            Some("invalid_request_id".to_string()),
            "request_id {evil_id:?} は cwd 選択の乗っ取りとして拒否されるべき"
        );
    }
    // home/sessions/ の外は疎か、home 自体すら作られていない(invalid_request_id は
    // session_dir 計算より前に確定する)。
    assert!(!home.exists(), "invalid な request_id では home すら作られてはいけない");
}

/// AC-X2(失敗経路): session_dir が存在してもファイルシステムが書き込みを拒む(依存先の失敗)時、
/// cwd 固定を諦めて broker の cwd へ継承フォールバックしていないかを破りに行く。
/// フォールバックしてしまうと PBI-0033 が塞いだ脆弱性(無人 session が broker 起動ディレクトリの
/// `.claude/settings.json` 等を黙って読む)がそのまま復活する。
#[tokio::test]
async fn x2_unwritable_session_dir_fails_closed_without_cwd_fallback() {
    let dir = tmp("x2");
    fs::create_dir_all(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    let dir_str = dir.to_string_lossy().to_string();
    let result =
        launch::launch_with_allowlist("pwd", "pwd", &[], &vec!["pwd".to_string()], Some(&dir_str));
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        result.err(),
        Some("session_dir_failed".to_string()),
        "書き込めない session_dir は fail-closed であるべき(broker の cwd へ継承フォールバックしない)"
    );
    let _ = fs::remove_dir_all(&dir);
}

/// AC-X3(並行) — 該当なし: broker(Rust)層は同一 requestId の重複排除を一切行わない
/// (single-flight の保証は無い。重複排除は Cloud 側 `dispatchWake` の in-flight map の責務 —
/// 図16 で機械検査済み)。この層の不変条件は「cwd 固定」だけなので、並行実行が
/// **その不変条件を壊さない**ことだけを見る(instruction.txt の内容整合性はスコープ外)。
/// 「どちらか 1 本だけ効く」という AC-X3 の定型文どおりの単一化はこの層には存在しないため、
/// 破れず/破れたではなく「該当なし」の裏取りとして書く。
#[tokio::test]
async fn x3_concurrent_identical_request_id_keeps_cwd_fixation_safe() {
    let home = tmp("x3");
    let dir = home.join("sessions").join("req-x3");
    fs::create_dir_all(&dir).unwrap();
    let dir_str = dir.to_string_lossy().to_string();
    let allow = vec!["pwd".to_string()];
    let (a, b) = tokio::join!(
        async { launch::launch_with_allowlist("pwd", "pwd", &[], &allow, Some(&dir_str)) },
        async { launch::launch_with_allowlist("pwd", "pwd", &[], &allow, Some(&dir_str)) },
    );
    let mut oks = 0;
    for r in [a, b] {
        if let Ok(mut child) = r {
            assert!(child.wait().await.unwrap().success());
            oks += 1;
        }
    }
    assert_eq!(
        oks, 2,
        "cwd 固定の安全性は同時実行でも壊れない(両方 spawn できる。重複排除は Cloud 側の責務)"
    );
    let _ = fs::remove_dir_all(&home);
}
