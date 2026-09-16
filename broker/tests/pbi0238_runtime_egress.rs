//! PBI-0238 AC-3: **実物の runtime CLI を broker の閉じ込め(seatbelt + egress proxy)そのままで起こし**、
//! その runtime が model host へ出ようとする CONNECT が proxy に届く事を見る。proxy の allowlist は空
//! (= 全部 403)なので token は 1 つも消費しない。届いた host の集合が内蔵表(`egress::builtin_hosts`)と
//! 交わる = 「この runtime は proxy を通る」の証明。交わらない runtime は proxy を迂回している
//! (HTTPS_PROXY を読まない client)ので、内蔵表か env の載せ方を直す対象になる。
//!
//! 既定では走らせない(`#[ignore]`): 実 CLI が要る。runtime が在る macOS で
//!   `OPENROLY_ATTACK_RUNTIMES=claude,codex,opencode,kiro cargo test --manifest-path broker/Cargo.toml \
//!      --test pbi0238_runtime_egress -- --ignored --nocapture`
//! と明示した時だけ、名前を挙げた runtime を実際に起こす。
//!
//! 対照(Node 製 runtime は `NODE_USE_ENV_PROXY=1` 無しだと proxy に来ない)は launch_in が env を常に載せるので
//! この test からは組めない —— 実測 2026-09-04(auto memory `project_sandbox_egress_measurements`)を正本にする。

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

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc::unbounded_channel;

#[tokio::test]
#[ignore = "実 runtime CLI を起こす。OPENROLY_ATTACK_RUNTIMES で明示した時だけ"]
async fn every_named_runtime_reaches_its_model_host_through_the_proxy() {
    let wanted = std::env::var("OPENROLY_ATTACK_RUNTIMES").unwrap_or_default();
    let wanted: Vec<&str> = wanted.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    assert!(!wanted.is_empty(), "OPENROLY_ATTACK_RUNTIMES に起こす runtime を挙げること(例: OPENROLY_ATTACK_RUNTIMES=claude,codex)");

    let home = std::env::temp_dir().join(format!("openroly-broker-0238-egress-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    let reg = registry::builtin();
    // machine-ok: 実 runtime CLI を起こして egress を見る実射（#[ignore]）。機械の設定ごと測る
    let env = launch::containment_env();
    // machine-ok: 実 runtime CLI を起こして egress を見る実射（#[ignore]）。機械の設定ごと測る
    let user_home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));
    // PBI-0331 AC-1: 製品と同じ backend(macOS = seatbelt / Linux = Landlock + seccomp)を main.rs と同じ順で
    // 決める。self_test に落ちた機で「起きなかった」を runtime の所為にしない —— 最初に赤くする
    // (Linux の backend 選択から Landlock を外すとここで赤 = AC-X2 の振る舞い側)
    let backend = sandbox::backend();
    assert_eq!(backend.self_test(), Ok(()), "{} の self_test が落ちた", backend.name());

    for runtime in wanted {
        let (tx, mut rx) = unbounded_channel();
        let iso = launch::Isolation {
            sandbox: backend.as_ref(),
            // allowlist 空 = 全部 403。token 消費 0 で「どこへ出ようとしたか」だけを見る
            egress: egress::EgressConfig { allow: vec![], events: Some(tx), upstream_override: None, observe: None },
            folder: None,
            lane: "manual",
            user_home: user_home.clone(),
            c1: &C1_OFF,
        };
        let request_id = format!("req-0238-{runtime}");
        let result = launch::launch_session_scoped_in(
            &home,
            &reg,
            &[],
            runtime,
            "Reply with the single word OK.",
            &request_id,
            None,
            &env,
            &iso, None,
        );
        // 名指しした runtime が起きないのは失敗(PBI-0331 AC-1)。`continue` で飛ばすと、Linux で
        // `sandbox_unavailable` / `containment_unavailable` になっても 1 本も assert せず緑になる
        let (mut child, egress, _hub) = result.unwrap_or_else(|reason| panic!("{runtime}: 起こせなかった({reason})"));
        // model に届かない runtime は自分で諦めるまで待つ。上限を置く(retry を続ける client が在る)
        let status = tokio::time::timeout(Duration::from_secs(180), child.wait()).await;
        if status.is_err() {
            let _ = child.kill().await;
        }
        drop(egress);
        let session_dir = home.join("sessions").join(&request_id);
        let stderr = fs::read_to_string(session_dir.join("stderr.log")).unwrap_or_default();
        let tail: Vec<&str> = stderr.lines().rev().take(15).collect();
        println!("· {runtime}: exit = {status:?} / stderr の末尾(新しい順) = {tail:?}");
        // seccomp の filter に殺された(SIGSYS)なら、CONNECT が届いていても「起きた」とは言わない
        if let Ok(Ok(st)) = &status {
            use std::os::unix::process::ExitStatusExt;
            assert_ne!(st.signal(), Some(libc::SIGSYS), "{runtime}: sandbox の seccomp に殺された");
        }
        let mut hosts = BTreeSet::new();
        while let Ok(ev) = rx.try_recv() {
            if let Some(h) = ev["host"].as_str() {
                hosts.insert(h.to_string());
            }
        }
        let table: Vec<String> = egress::builtin_hosts(runtime).iter().map(|s| s.to_string()).collect();
        let reached: Vec<&String> = hosts.iter().filter(|h| egress::allows(&table, h)).collect();
        println!("· {runtime}: proxy に来た host = {hosts:?} / 内蔵表と一致 = {reached:?}");
        assert!(
            !reached.is_empty(),
            "{runtime}: model host への CONNECT が proxy に来ていない(来た host: {hosts:?} / 内蔵表: {table:?})。\n\
             proxy を迂回している(HTTPS_PROXY を読まない)か、内蔵表の host が古い"
        );
    }
    let _ = fs::remove_dir_all(&home);
}
