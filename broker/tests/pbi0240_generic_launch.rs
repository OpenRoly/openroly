//! PBI-0240 実 runtime 検証: **generic 経路**(catalog の `launch.headless` → argv 要素置換 →
//! PBI-0238 の sandbox + egress)で opencode / kiro を実際に起こす。catalog
//! (`packages/core/registry/detectors.v1.json`)の entry がそのまま起動に足りる事と、model host への
//! CONNECT が proxy に届く事(allowlist 空 = 403 = token 消費 0)を見る。
//!
//! 既定では走らせない(`#[ignore]`): 実 CLI が要る。runtime が在る macOS で
//!   `OPENROLY_ATTACK_RUNTIMES=opencode,kiro cargo test --manifest-path broker/Cargo.toml \
//!      --test pbi0240_generic_launch -- --ignored --nocapture`
//! と明示した時だけ、名前を挙げた runtime を実際に起こす。

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
// launch.rs の test が `crate::sessions::` を参照するため sessions も一緒に取り込む(E0433。pbi0238 と同じ)
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
async fn generic_path_starts_catalog_runtimes_and_reaches_model_host() {
    let wanted = std::env::var("OPENROLY_ATTACK_RUNTIMES").unwrap_or_default();
    let wanted: Vec<&str> = wanted.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    assert!(!wanted.is_empty(), "OPENROLY_ATTACK_RUNTIMES に起こす runtime を挙げること(例: OPENROLY_ATTACK_RUNTIMES=opencode,kiro)");

    // catalog をそのまま registry にする(署名はこの test の対象外 — 形式は parse が検査する)
    let catalog = concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/core/registry/detectors.v1.json");
    let reg = registry::parse(&fs::read_to_string(catalog).expect("detectors.v1.json"), "catalog")
        .expect("catalog が parse できる")
        .merged_with_builtin();

    let home = std::env::temp_dir().join(format!("openroly-broker-0240-generic-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    // machine-ok: catalog の実 runtime を起こす実射（#[ignore]）。機械の設定ごと測る
    let env = launch::containment_env();
    // machine-ok: catalog の実 runtime を起こす実射（#[ignore]）。機械の設定ごと測る
    let user_home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));

    // catalog の binary(kiro は id ≠ binary 名)を解決する為に 1 回 scan する
    let scan_env = discovery::ScanEnv::from_env();
    let mut versions = discovery::VersionCache::default();
    let found = discovery::scan(&reg, &scan_env, &mut versions);

    for runtime in wanted {
        let (tx, mut rx) = unbounded_channel();
        let iso = launch::Isolation {
            sandbox: &sandbox::Seatbelt,
            // allowlist 空 = 全部 403。token 消費 0 で「どこへ出ようとしたか」だけを見る
            egress: egress::EgressConfig { allow: vec![], events: Some(tx), upstream_override: None, observe: None },
            folder: None,
            // PBI-0548 以降、generic entry は lane work でしか起きない(他は lane_not_contained)。
            // ここが "manual" のままだと opencode / kiro が起こされず、この test は
            // **generic 経路を一度も測らないまま緑**になる(2026-09-16 PBI-0618 の実機確認で発覚)
            lane: "work",
            user_home: user_home.clone(),
            c1: &C1_OFF,
        };
        let request_id = format!("req-0240-{runtime}");
        let result = launch::launch_session_scoped_in(
            &home,
            &reg,
            &found,
            runtime,
            "Reply with the single word OK.",
            &request_id,
            None,
            &env,
            &iso,
            None,
        );
        let (mut child, egress, _hub) = match result {
            Ok(v) => v,
            Err(reason) => {
                println!("· {runtime}: 起こさなかった({reason})");
                // catalog entry を持つ runtime が generic 経路で落ちたら実装の破れ(not_headless /
                // not_verified は entry の書き間違い)
                if matches!(reason.as_str(), "not_headless" | "not_verified") {
                    panic!("{runtime}: catalog に launch.headless + sandbox_verified が要る ({reason})");
                }
                continue;
            }
        };
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
        // catalog の egress.hosts(PBI-0616: registry が正本。pbi0238 と同じ見方)
        let catalog_hosts: Vec<String> = reg
            .detector(runtime)
            .and_then(|d| d.egress.as_ref())
            .map(|e| e.hosts.clone())
            .unwrap_or_default();
        let table = egress::hosts_for(&catalog_hosts, true, runtime, "", None)
            .unwrap_or_else(|e| panic!("{runtime}: catalog に egress.hosts が要る ({e})"));
        let reached: Vec<&String> = hosts.iter().filter(|h| egress::allows(&table, h)).collect();
        println!("· {runtime}: proxy に来た host = {hosts:?} / catalog+内蔵表と一致 = {reached:?}");
        assert!(
            !reached.is_empty(),
            "{runtime}: model host への CONNECT が proxy に来ていない(来た host: {hosts:?} / 表: {table:?})"
        );
    }
    let _ = fs::remove_dir_all(&home);
}
