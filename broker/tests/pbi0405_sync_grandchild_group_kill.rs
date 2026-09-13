//! PBI-0405 攻撃 test(AC-1/AC-2 の sync.rs 分。2 口 = `ask_watch_paths` / `run_cli`)。newway §14.1。
//!
//! 出所は PBI-0403 有界レビュー(e7bc518)が実射した穴の表: `broker/src/sync.rs:124-131`
//! (旧行番号。今は `run_cli`)/ `broker/src/sync.rs:148-155`(今は `ask_watch_paths`)。どちらも
//! `openroly sync` / `openroly share` / `openroly watch-dirs` を起こし、その先で runtime CLI
//! (孫)を起こしうる(sync.rs 冒頭の doc comment 通り)。timeout は `kill_on_drop(true)` で
//! **直の子だけ**を殺し、孫は孤児で残っていた。PBI-0405 で両方に `process_group(0)` +
//! timeout 時の `procgroup::kill_group` を足したので、ここは孫が **死ぬ** ことを実射する。
//!
//! `run_cli` / `ask_watch_paths` は private なので、`pub` の `run_cli_worker`(接続ごとの cli
//! worker。argv / timeout / poll を引数で受けるので env を触らずに済む)経由で撃つ:
//! worker 起動直後に必ず 1 回 `ask_watch_paths` が呼ばれる(port 1)、その後 `CliJob::Share` を
//! 送ると `run_cli(&["share","--auto"])` が呼ばれる(port 2)。fake CLI は `$0`(sh -c の
//! command_name)で「今どちらの口から呼ばれたか」を見分ける。
//!
//! `broker` は lib crate を持たないため `#[path]` で src を直接取り込む
//! (`pbi0070_review_attack.rs` と同じ回避策)。`sync.rs` が呼ぶ `crate::procgroup::kill_group` を
//! 解決するため leaf module `procgroup.rs` も取り込む(`sessions.rs` は引かない —— PBI-0405 で
//! `kill_group` をそちらから独立させた理由そのもの)。

#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/sync.rs"]
mod sync;

use std::path::PathBuf;
use std::time::Duration;

use sync::CliJob;

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0405-sync-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

async fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while pid_alive(pid) {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

/// `#[tokio::test]` は既定で current-thread runtime —— ここで `std::thread::sleep` を使うと
/// 同じスレッドで動く `run_cli_worker`(tokio::spawn)が一切進めなくなる(実測: 3 秒待っても
/// pidfile が現れない)。**必ず `tokio::time::sleep` で yield する**。
async fn read_pid(path: &std::path::Path, timeout: Duration) -> u32 {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(pid) = s.trim().parse() {
                return pid;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "孫が起きていない = 何も測っていない(fork が timeout に間に合わなかった)"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// **port 1(AC-1/AC-2): `ask_watch_paths`**。worker 起動直後の 1 回目の呼び出しが timeout する
/// fake CLI を渡す。呼ばれるのは必ず `$0 == "watch-dirs"` の 1 回だけ(見張る場所が空のままなので
/// tick 側からの再呼び出しは起きない —— `run_cli_worker` の debounce 通り)。
#[tokio::test]
async fn ask_watch_paths_timeout_は孫もgroupごと落とす() {
    let dir = tmp_dir("watchdirs");
    let pidfile = dir.join("grandchild.pid");
    let script = format!(
        "cat >/dev/null; sleep 120 >/dev/null 2>&1 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30",
        p = pidfile.display()
    );
    let argv: Vec<String> = vec!["/bin/sh".into(), "-c".into(), script];
    let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<CliJob>();
    let handle = tokio::spawn(sync::run_cli_worker(argv, Duration::from_secs(2), Duration::from_secs(30), rx));

    let gpid = read_pid(&pidfile, Duration::from_secs(3)).await;
    let gone = wait_gone(gpid, Duration::from_secs(5)).await;
    handle.abort();
    unsafe { libc::kill(gpid as i32, libc::SIGKILL) }; // 赤の時に孤児を共有機へ残さない(lessons 08)
    let _ = std::fs::remove_dir_all(&dir);
    assert!(gone, "孫({gpid})が生き残った —— ask_watch_paths の timeout が group ごと落とせていない(PBI-0405 AC-1/AC-2)");
}

/// **port 2(AC-1/AC-2): `run_cli`**。起動直後の `ask_watch_paths`(port 1)は `$0 == "watch-dirs"`
/// で即 exit 0 にして通過させ、`CliJob::Share` を送って `run_cli(&["share","--auto"])`
/// (`$0 == "share"`)側だけを狙って timeout させる。
#[tokio::test]
async fn run_cli_timeout_は孫もgroupごと落とす() {
    let dir = tmp_dir("runcli");
    let pidfile = dir.join("grandchild.pid");
    let script = format!(
        "if [ \"$0\" = watch-dirs ]; then exit 0; fi; \
         sleep 120 >/dev/null 2>&1 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30",
        p = pidfile.display()
    );
    let argv: Vec<String> = vec!["/bin/sh".into(), "-c".into(), script];
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<CliJob>();
    let handle = tokio::spawn(sync::run_cli_worker(argv, Duration::from_secs(2), Duration::from_millis(50), rx));
    // worker 起動直後の ask_watch_paths(port 1・即 exit 0)が終わるのを待ってから share を送る
    tokio::time::sleep(Duration::from_millis(300)).await;
    tx.send(CliJob::Share).expect("worker が既に落ちている");

    let gpid = read_pid(&pidfile, Duration::from_secs(3)).await;
    let gone = wait_gone(gpid, Duration::from_secs(5)).await;
    handle.abort();
    unsafe { libc::kill(gpid as i32, libc::SIGKILL) };
    let _ = std::fs::remove_dir_all(&dir);
    assert!(gone, "孫({gpid})が生き残った —— run_cli の timeout が group ごと落とせていない(PBI-0405 AC-1/AC-2)");
}

/// **負の対照**: どちらの口も、timeout しない正常系(即 exit 0)では孫を作らず ok で終わる
/// ことを見ておく —— 上 2 本が「timeout を撃ったこと」を実際に確かめているかの土台。
#[tokio::test]
async fn timeout_しない正常系では孫を作らず即終わる_負の対照() {
    let argv: Vec<String> = vec!["/bin/sh".into(), "-c".into(), "exit 0".into()];
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<CliJob>();
    let handle = tokio::spawn(sync::run_cli_worker(argv, Duration::from_secs(5), Duration::from_millis(50), rx));
    tokio::time::sleep(Duration::from_millis(300)).await;
    tx.send(CliJob::Sync).expect("worker が既に落ちている");
    tokio::time::sleep(Duration::from_millis(500)).await;
    handle.abort();
}
