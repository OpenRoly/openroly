//! PBI-0405 有界レビューの破れ: AC-3 は「`process_group` を通らない spawn 口が 0 件」
//! (`grep -rn "Command::new" broker/src`)を主張していたが、実装は `broker/src/{adopt,sync,launch}.rs`
//! の 3 file しか数えておらず、`broker/src/discovery.rs::run_version_probe`(`PROBE_TIMEOUT` = 3s)が
//! 対象外の根拠なしに漏れていた。`run_version_probe` は probe 対象の binary(claude/codex/ollama 等の
//! 任意 CLI)を spawn し timeout で見捨てる —— adopt_one/run_cli/ask_watch_paths と同じ形の門。
//! timeout 時は直の子だけを `child.kill()` していたので孫は孤児で残った。
//!
//! `process_group(0)`(spawn 前)+ timeout 時の `procgroup::kill_group` を足したので、ここは
//! 孫が **死ぬ** ことを実射する(sync/adopt の攻撃 test と同じ形)。
//!
//! `broker` は lib crate を持たないため `#[path]` で src を直接取り込む。`discovery.rs` が呼ぶ
//! `crate::procgroup::kill_group` を解決するため leaf module `procgroup.rs` も取り込む。

#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;
#[path = "../src/discovery.rs"]
mod discovery;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0405-discovery-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_exec(p: &Path, body: &str) {
    fs::write(p, body).unwrap();
    fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
}

fn scan_env(dir: &Path) -> discovery::ScanEnv {
    // 実マシンの PATH / /Applications は見ない(本物の CLI を掴む事故を防ぐ)
    discovery::ScanEnv::from_vars(
        Some(dir.as_os_str().to_os_string()),
        Some("".into()),
        Some("".into()),
        None,
        None,
    )
}

fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// 兄弟 test(adopt / sync)の `wait_gone` と同じ形。**1 回だけ見ない** —— Linux では SIGKILL された
/// 孫が init に回収されるまで zombie として残り、その間 `kill(pid, 0)` は 0 を返す(2026-09-12 CI 実測:
/// macOS では通り ubuntu-latest でだけ「孫が生き残った」)。死んだかどうかは待って判定する。
fn wait_gone(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !pid_alive(pid)
}

fn read_pid_within(path: &Path, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(s) = fs::read_to_string(path) {
            if let Ok(p) = s.trim().parse() {
                return Some(p);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

/// スクリプトの `$0` 判定で「どの id の probe から呼ばれたか」を見分ける(sync 攻撃 test と同じ形)。
fn grandchild_script(pidfile: &Path) -> String {
    format!(
        "#!/bin/sh\nsleep 120 >/dev/null 2>&1 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30\n",
        p = pidfile.display()
    )
}

/// AC-1/AC-2 相当: timeout した probe の孫は group ごと落ちる。
///
/// PBI-0468: 本番と同じ `PROBE_TIMEOUT`(3s、`scan()`経由)で測っていたところ、fork/exec 経路が
/// 詰まっている(他 test の同時 spawn 等)と孫を fork する所まで exec が届く前に timeout が発火し、
/// 「孫が起きていない」で無 signal のまま red になっていた(実測: 兄弟 test 同時実行で 6 回に 1 回。
/// CPU-bound busy loop だけの負荷では 0/5 = fork/exec の詰まりが原因で CPU 時間の競合ではない)。
/// 検証対象は「timeout が来たら孫ごと死ぬ」であって「本番の 3 秒以内に孫が fork できる」ではないので、
/// `run_version_probe_with_timeout` を大きい timeout で直接呼ぶ(registry 経由の existence 判定は
/// discovery.rs 自身の他 unit test が持つので、ここで scan()/registry を経由する必要はない)。
#[test]
fn version_probe_timeout_kills_the_grandchild() {
    let dir = tmp("kill");
    let pidfile = dir.join("grandchild.pid");
    write_exec(&dir.join("slow"), &grandchild_script(&pidfile));

    let probe_timeout = Duration::from_secs(10);
    let start = Instant::now();
    let version = discovery::run_version_probe_with_timeout(
        &dir.join("slow"),
        &["--version".to_string()],
        probe_timeout,
    );
    assert!(version.is_none(), "timeout した probe が version を返した: {version:?}");
    assert!(start.elapsed() < probe_timeout + Duration::from_secs(3), "probe が timeout で切り上げていない");

    let gpid = read_pid_within(&pidfile, Duration::from_secs(3))
        .expect("孫が起きていない = 何も測っていない(fork が timeout に間に合わなかった)");
    // group kill は同期(kill_group → child.wait())だが、**孫の回収は init の仕事**なので
    // scan() が返った瞬間はまだ zombie で見えうる。兄弟 test と同じく 5 秒まで待つ。
    let alive = !wait_gone(gpid, Duration::from_secs(5));
    if alive {
        unsafe { libc::kill(gpid, libc::SIGKILL) }; // 赤の時に孤児を共有機へ残さない(lessons 08)
    }
    let _ = fs::remove_dir_all(&dir);
    assert!(!alive, "孫({gpid})が生き残った —— run_version_probe の timeout が group ごと落とせていない");
}

/// 負の対照: timeout しない正常系(即座に version を返す)では孫を作らず結果を返す。
#[test]
fn version_probe_normal_exit_returns_version_負の対照() {
    let dir = tmp("normal");
    write_exec(&dir.join("fast"), "#!/bin/sh\necho v1.2.3\n");
    // 初回 exec の syspolicyd 遅延を吸収(discovery.rs 自身の test と同じ対処)
    let _ = std::process::Command::new(dir.join("fast")).arg("--version").stdin(std::process::Stdio::null()).output();

    let body = r#"{"version":1,"detectors":[
        {"id":"fast","detect":{"binaries":["fast"]},"version":{"args":["--version"]},"adapter":null}
    ]}"#;
    let reg = registry::parse(body, "t").expect("attack registry を parse できない");
    let mut cache = discovery::VersionCache::default();
    let found = discovery::scan(&reg, &scan_env(&dir), &mut cache);
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].version.as_deref(), Some("v1.2.3"));
}

/// AC-X1 相当: 別 binary(別 group)の孫には触れない(group を跨いで殺さない)。
///
/// PBI-0468: victim 側も上のテストと同じ理由(fork/exec 経路の詰まり下で本番の `PROBE_TIMEOUT` が
/// 孫の fork より先に発火しうる)で赤になりうるので、同じく `run_version_probe_with_timeout` を
/// 大きい timeout で直接呼ぶ。
#[test]
fn version_probe_timeout_leaves_the_bystander_alive() {
    let dir = tmp("bystander");
    let victim_pidfile = dir.join("victim.pid");
    let bystander_pidfile = dir.join("bystander.pid");
    write_exec(&dir.join("victim"), &grandchild_script(&victim_pidfile));

    // bystander は先に自分の孫(別 group)を作っておく
    write_exec(
        &dir.join("bystander_spawn"),
        &format!(
            "#!/bin/sh\nsleep 120 >/dev/null 2>&1 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"\n",
            p = bystander_pidfile.display()
        ),
    );
    let _ = std::process::Command::new(dir.join("bystander_spawn")).status();
    let bpid = read_pid_within(&bystander_pidfile, Duration::from_secs(3)).expect("bystander の孫が起きていない");

    let probe_timeout = Duration::from_secs(10);
    discovery::run_version_probe_with_timeout(&dir.join("victim"), &["--version".to_string()], probe_timeout);

    let vpid = read_pid_within(&victim_pidfile, Duration::from_secs(3)).expect("victim の孫が起きていない");
    // 兄弟 test(version_probe_timeout_kills_the_grandchild)と同じ理由(2026-09-12 CI 実測)。
    // Linux では SIGKILL された victim の孫が init に回収されるまで zombie で残り、1 回だけの
    // pid_alive は誤って「生きている」を返しうる。wait_gone で判定してから bystander を見る
    let victim_alive = !wait_gone(vpid, Duration::from_secs(5));
    let bystander_alive = pid_alive(bpid);
    unsafe {
        if victim_alive {
            libc::kill(vpid, libc::SIGKILL); // 赤の時に孤児を共有機へ残さない(lessons 08)
        }
        libc::kill(bpid, libc::SIGKILL);
    }
    let _ = fs::remove_dir_all(&dir);
    assert!(!victim_alive, "victim の孫({vpid})が生き残った");
    assert!(bystander_alive, "bystander の孫({bpid})まで殺された —— group を跨いで殺している");
}
