//! PBI-0238 AC-3: **実物の runtime CLI を broker の閉じ込め(seatbelt + egress proxy)そのままで起こし**、
//! その runtime が model host へ出ようとする CONNECT が proxy に届く事を見る。proxy の allowlist は空
//! (= 全部 403)なので token は 1 つも消費しない。届いた host の集合が内蔵表(`egress::builtin_hosts`)と
//! 交わる = 「この runtime は proxy を通る」の証明。交わらない runtime は proxy を迂回している
//! (HTTPS_PROXY を読まない client)ので、内蔵表か env の載せ方を直す対象になる。
//!
//! 既定では走らせない(`#[ignore]`): 実 CLI が要る。runtime が在る macOS で
//!   `OPENROLY_ATTACK_RUNTIMES=claude,codex,gemini,opencode,kiro cargo test --manifest-path broker/Cargo.toml \
//!      --test pbi0238_runtime_egress -- --ignored --nocapture`
//! と明示した時だけ、名前を挙げた runtime を実際に起こす。
//!
//! 対照(gemini は `NODE_USE_ENV_PROXY=1` 無しだと proxy に来ない)は launch_in が env を常に載せるので
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
#[path = "../src/egress.rs"]
mod egress;
#[path = "../src/sandbox.rs"]
mod sandbox;

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
    let env = launch::containment_env();
    let user_home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));

    for runtime in wanted {
        let (tx, mut rx) = unbounded_channel();
        let iso = launch::Isolation {
            sandbox: &sandbox::Seatbelt,
            // allowlist 空 = 全部 403。token 消費 0 で「どこへ出ようとしたか」だけを見る
            egress: egress::EgressConfig { allow: vec![], events: Some(tx), upstream_override: None },
            folder: None,
            user_home: user_home.clone(),
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
            &iso,
        );
        let (mut child, egress) = match result {
            Ok(v) => v,
            Err(reason) => {
                println!("· {runtime}: 起こさなかった({reason})");
                continue;
            }
        };
        // model に届かない runtime は自分で諦めるまで待つ。上限を置く(retry し続ける client も在る)
        let status = tokio::time::timeout(Duration::from_secs(180), child.wait()).await;
        if status.is_err() {
            let _ = child.kill().await;
        }
        drop(egress);
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
