//! PBI-0405 攻撃 test(AC-1/AC-2 の adopt.rs 分)。newway §14.1。
//!
//! 出所は PBI-0403 有界レビュー(e7bc518)が実射した穴: `broker/src/adopt.rs` の `adopt_one`
//! (`Command::new` / `.spawn()`)は `launch_in` を経由しない**別の** spawn 口で、`openroly adopt`
//! 自身は adopt.rs から見て「孫」にあたる runtime CLI(`claude mcp add` 等)を起こす。timeout は
//! `kill_on_drop(true)` で **直の子(openroly CLI)だけ**を殺し、孫は孤児で生き残っていた
//! (旧ファイル名 `pbi0403_review_adopt_orphan_attack.rs` はこの穴を確認するだけの review 用
//! scaffolding だった)。
//!
//! PBI-0405 で `adopt_one` に `process_group(0)` + timeout 時の `procgroup::kill_group` を足したので、
//! **このファイルは期待の向きを反転**させる: 孫が **死ぬ** ことを実射する。直の子だけが死んで
//! 孫が生き残る旧来の壊れ方に戻ったら、ここが赤くなる。
//!
//! `adopt_one` は private なので統合 test からは呼べない。代わりに `pub` の `adopt_all_with`
//! (1 件 batch)経由で同じ経路を撃つ。`broker` は lib crate を持たないため `#[path]` で src を
//! 直接取り込む(`pbi0070_review_attack.rs` と同じ回避策)。`adopt.rs` が呼ぶ
//! `crate::procgroup::kill_group` を解決するため `procgroup.rs` も同じ取り込みに足す ——
//! `sessions.rs` を直接取り込むと `launch.rs`(→ egress / registry / sandbox / discovery)まで
//! 丸ごと引きずり込む(`kill_group` が leaf module `procgroup.rs` に居る理由そのもの。PBI-0405)。

#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/openroly_cli.rs"]
mod openroly_cli;
#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/adopt.rs"]
mod adopt;

use std::path::PathBuf;
use std::time::Duration;

/// `adopt_all_with` の acks は使わないが、`ok:false / detail:"adopt_timeout"` が来ることは
/// 見ておく(呼び出しが本当に timeout 経路を通ったことの確認)。
async fn adopt_one_via_public_api(cli: Vec<String>, timeout: Duration) -> (bool, String) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    adopt::adopt_all_with(&cli, 1, timeout, std::slice::from_ref(&sample()), &tx).await;
    let ack = rx.try_recv().expect("register_ack が来ていない");
    (
        ack["ok"].as_bool().unwrap(),
        ack["detail"].as_str().unwrap().to_string(),
    )
}

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0405-adopt-{tag}-{}", std::process::id()));
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

fn sample() -> adopt::Adoption {
    adopt::Adoption {
        kind: "codex".into(),
        runtime_id: "rt_1".into(),
        token: "par_x".into(),
        base_url: "http://127.0.0.1:1".into(),
        name: "M / Codex".into(),
        native: None,
    }
}

/// **本件の急所(AC-1/AC-2)**: `openroly adopt`(の代わりに立てる fake CLI)が自分の孫を fork して
/// から timeout を超えて居座った時、`adopt_one` は直の子(fake CLI)を group ごと(SIGKILL)落とす
/// ので、孫も一緒に死ぬ。直の子だけ死んで孫が生き残る旧来の壊れ方に戻ったらここが赤くなる。
#[tokio::test]
async fn adopt_timeout_は孫もgroupごと落とす() {
    let dir = tmp_dir("orphan");
    let pidfile = dir.join("grandchild.pid");
    // fake CLI: stdin を読み捨ててから孫を fork し、自分は timeout(2秒)より長く居座る
    // (`openroly adopt` が `claude mcp add` を起こしてから終了を待つ形の再現)
    let script = format!(
        "cat >/dev/null; sleep 120 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30",
        p = pidfile.display()
    );
    let cli: Vec<String> = vec!["/bin/sh".into(), "-c".into(), script];

    let (ok, detail) = adopt_one_via_public_api(cli, Duration::from_secs(2)).await;
    assert!(!ok, "timeout のはずが成功した: {detail}");
    assert_eq!(detail, "adopt_timeout");

    let gpid: u32 = std::fs::read_to_string(&pidfile)
        .expect("孫が起きていない = 何も測っていない(fork が timeout に間に合わなかった)")
        .trim()
        .parse()
        .unwrap();
    let gone = wait_gone(gpid, Duration::from_secs(5)).await;
    // 赤の時に孤児を共有機へ残さない(lessons 08)
    unsafe { libc::kill(gpid as i32, libc::SIGKILL) };
    let _ = std::fs::remove_dir_all(&dir);
    assert!(gone, "孫({gpid})が生き残った —— adopt.rs の timeout が group ごと落とせていない(PBI-0405 AC-1/AC-2)");
}

/// **負の対照**: `adopt_one` の timeout が直の子には確実に効いていることも同じ実射で確認する。
/// これが失敗する(直の子が生き残る)なら上のテストは「何も測っていない」赤 —— kill_on_drop /
/// group kill 自体が動いていないだけの偽の緑になる。
#[tokio::test]
async fn adopt_timeout_は直の子は殺す_負の対照() {
    let dir = tmp_dir("direct-child");
    let pidfile = dir.join("child.pid");
    let script = format!("echo $$ > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30", p = pidfile.display());
    let cli: Vec<String> = vec!["/bin/sh".into(), "-c".into(), script];

    let (ok, _detail) = adopt_one_via_public_api(cli, Duration::from_secs(2)).await;
    assert!(!ok);

    let cpid: u32 = std::fs::read_to_string(&pidfile)
        .expect("直の子が起きていない")
        .trim()
        .parse()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pid_alive(cpid) {
        assert!(std::time::Instant::now() < deadline, "直の子({cpid})が死なない");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// **AC-X1 別 actor**: 別の adopt 呼び出し(= 別の group)が timeout で落ちても、
/// 同時に走っている別件の孫には触れない(group を跨いで殺さない)。
#[tokio::test]
async fn adopt_timeout_は別groupの孫に触れない() {
    let dir = tmp_dir("other-actor");
    let victim_pidfile = dir.join("victim.pid");
    let bystander_pidfile = dir.join("bystander.pid");

    // bystander: timeout しない(1 本だけ先に落として exit 0)。背景 job の stdio は
    // 継承させない(継承すると pipe の write 端を握ったまま生き残り、`wait_with_output` が
    // 孫の exit を待つ形になって親の exit だけでは終わらず、この bystander 自身が timeout する —
    // 実測。discovery.rs の「pipe 方式は継承で読み手が固まる」と同じ形)
    let bystander_script = format!(
        "sleep 120 >/dev/null 2>&1 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"",
        p = bystander_pidfile.display()
    );
    let (ok, _detail) = adopt_one_via_public_api(
        vec!["/bin/sh".into(), "-c".into(), bystander_script],
        Duration::from_secs(5),
    )
    .await;
    assert!(ok, "bystander は成功で終わるはず(exit 0)");
    let bpid: u32 = std::fs::read_to_string(&bystander_pidfile).unwrap().trim().parse().unwrap();
    assert!(pid_alive(bpid), "bystander の孫が起きていない = 何も測っていない");

    // victim: timeout する
    let victim_script = format!(
        "cat >/dev/null; sleep 120 & echo $! > \"{p}.tmp\"; mv \"{p}.tmp\" \"{p}\"; sleep 30",
        p = victim_pidfile.display()
    );
    let (ok, detail) = adopt_one_via_public_api(
        vec!["/bin/sh".into(), "-c".into(), victim_script],
        Duration::from_secs(2),
    )
    .await;
    assert!(!ok, "timeout のはずが成功した: {detail}");
    let vpid: u32 = std::fs::read_to_string(&victim_pidfile).unwrap().trim().parse().unwrap();

    let victim_gone = wait_gone(vpid, Duration::from_secs(5)).await;
    let bystander_alive = pid_alive(bpid);
    unsafe {
        libc::kill(vpid as i32, libc::SIGKILL);
        libc::kill(bpid as i32, libc::SIGKILL);
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(victim_gone, "victim の孫({vpid})が生き残った");
    assert!(bystander_alive, "別 group の bystander({bpid})まで巻き込んで殺した(AC-X1)");
}
