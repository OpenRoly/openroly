//! 常時同期の端末側(PBI-0213 / 図18)。**人が `openroly sync` / `openroly share` を打たなくても揃う**。
//!
//! きっかけは 4 つで、行き先は 1 つ:
//!
//! - Cloud の `extensions_changed`(web で足した / 承認した)  → `openroly sync`
//! - `register_ack ok:true`(新しい runtime が adopt された)  → `openroly sync` + `openroly share --auto`
//! - 接続確立(T0)                                            → `openroly sync` + `openroly share --auto`
//! - 端末側の native が変わった(config file / skills dir)     → `openroly share --auto`
//!
//! 4 つ目だけが端末発なので、見張る場所が要る。**場所の正本は adapter 側(TS)1 箇所**で、
//! broker は `openroly watch-dirs` に訊く —— 76 agent 分の config path を Rust に写すと正本が
//! 2 枚になり、片方だけ直る(`adopt.rs` の冒頭と同じ理由)。
//!
//! 見張り方は **notify ではなく stat の巡回**。層 2 の `spawn_fs_watch` は「binary が現れた」を
//! 見るので install 先の dir を非再帰で見張れば足りるが、こちらが見たいのは
//! **`~/.claude.json` のような file 自身**と **まだ存在しない `~/.claude/skills`** で、
//! - file を見張るには file が既に無いといけない(親を見張ると `$HOME` になり、
//!   `.zsh_history` の書き込みで毎秒発火する)
//! - 存在しない path は watcher を張れないので、現れたことに気付けない
//! の 2 つが watcher では解けない。`stat` を 32 本 2 秒ごと(= 16 回/秒)は無視できる負荷で、
//! **watcher を作れない環境という失敗経路ごと消える**(AC-X2 の前提が無くなる)。
//!
//! CLI を起こす口はこの 1 本(worker task)だけ。**同時に 1 本**しか走らないのは
//! task が 1 つで await が直列だからで、上限を別に持たない(3 連発は 1 本 + 再予約 1 回)。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use tokio::process::Command;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{MissedTickBehavior, interval};

/// worker に投げる仕事。**中身を持たない** —— 何が変わったかは CLI が取り直す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliJob {
    /// desired → native(`openroly sync`)
    Sync,
    /// native → 提案(`openroly share --auto`)
    Share,
}

/// 溜まった仕事を「種類ごとに 1 回」に潰した物。3 連発の `Sync` は 1 本になる(AC-X3)。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Want {
    pub sync: bool,
    pub share: bool,
}

impl Want {
    pub fn add(&mut self, job: CliJob) {
        match job {
            CliJob::Sync => self.sync = true,
            CliJob::Share => self.share = true,
        }
    }

    pub fn any(&self) -> bool {
        self.sync || self.share
    }
}

/// 1 回分の CLI 実行の上限。`openroly sync` は bun を起こし、その先で runtime 自身の CLI
/// (`claude mcp add` 等)を全 runtime 分呼ぶので、`adopt` の 60 秒より長く取る。
/// **超えても WS ループは無関係**(worker は別 task) —— 落ちた分は次の trigger が拾う。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(120);

/// native を見に行く間隔。AC-2/AC-3 の「10 秒以内」に対する余裕 + 嵐(editor の swap file・
/// `brew install` の数十イベント)を 1 回にまとめる debounce を兼ねる。
pub const NATIVE_POLL: Duration = Duration::from_secs(2);

/// 見張る path の上限(PBI-0213 技術設計)。接続済み runtime が増えても stat の本数を頭打ちにする。
/// 超えた分は捨てる —— 落としても正しさは失われない(次の T0 / adopt / `extensions_changed` で
/// 取り直す。層 2 の `RESCAN_MIN_GAP` と同じ「trigger は latency の役であって正しさの担い手ではない」)。
pub const MAX_WATCH_PATHS: usize = 32;

/// `openroly watch-dirs` の stdout を path の列にする(純関数)。空行・相対 path を捨て、
/// 重複を潰して先頭 `max` 件。**実在は問わない** —— まだ無い skills dir が現れたことを
/// 見張るのがこの列の役目なので、ここで存在を見ると「後から作られた物」を永久に拾えない。
pub fn parse_watch_paths(stdout: &str, max: usize) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('/') {
            continue;
        }
        if out.len() >= max {
            break;
        }
        if seen.insert(line.to_string()) {
            out.push(PathBuf::from(line));
        }
    }
    out
}

/// 見張っている path の「今の姿」。存在しない = `None`。file なら mtime + size、dir なら mtime
/// (dir の mtime は直下の増減で動く = skill が 1 つ増えた / 消えた)。
///
/// **中身は読まない**。skill の中の 1 file を書き換えただけでは dir の mtime は動かない ——
/// PBI-0213 の不確実性表どおり、その分は adopt 時 / 手動 `openroly share` に任せる。
///
/// size も見るのは、同じ秒の中で config を 2 回書く形(sync が書いた直後に人が書く)で
/// mtime の解像度に負けないため。
pub fn stat_paths(paths: &[PathBuf]) -> Vec<Option<(SystemTime, u64)>> {
    paths
        .iter()
        .map(|p| {
            std::fs::metadata(p)
                .ok()
                .and_then(|m| m.modified().ok().map(|t| (t, m.len())))
        })
        .collect()
}

/// CLI を 1 本起こして完走を待つ。stdout / stderr は捨てる(log は broker の 1 行だけ)。
/// **timeout で future を drop すると `kill_on_drop` が子を殺す** —— 対話待ちで固まった
/// CLI を残さない(`adopt.rs` と同じ扱い)。
async fn run_cli(argv: &[String], timeout: Duration, args: &[&str]) -> Result<(), String> {
    let Some((program, leading)) = argv.split_first() else {
        return Err("openroly_cli_not_found".to_string());
    };
    let mut cmd = Command::new(program);
    cmd.args(leading)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("cannot start the openroly CLI ({e})"))?;
    match tokio::time::timeout(timeout, child.wait()).await {
        Err(_) => Err(format!("timed out after {timeout:?}")),
        Ok(Err(e)) => Err(format!("wait failed: {e}")),
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("exit {}", status.code().unwrap_or(-1))),
    }
}

/// `openroly watch-dirs` に「見張る場所」を訊く。**訊けなかった時は `None`** ——「見張る場所が
/// 無い」(`Some(vec![])`)と区別する。同じにすると、sync のたびの訊き直しが 1 回失敗しただけで
/// **その接続の見張りが丸ごと消える**(次に繋ぎ直すまで AC-2 / AC-3 が死ぬ。有界レビューで実測)。
/// 起動時に訊けなかった時だけは空で始める —— `extensions_changed` / T0 / adopt の 3 経路は生きている。
async fn ask_watch_paths(argv: &[String], timeout: Duration) -> Option<Vec<PathBuf>> {
    let Some((program, leading)) = argv.split_first() else {
        return None;
    };
    let mut cmd = Command::new(program);
    cmd.args(leading)
        .arg("watch-dirs")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(child) = cmd.spawn() else {
        eprintln!("broker: cannot ask the openroly CLI for the watch paths");
        return None;
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => Some(parse_watch_paths(
            &String::from_utf8_lossy(&out.stdout),
            MAX_WATCH_PATHS,
        )),
        _ => {
            eprintln!("broker: openroly watch-dirs failed; keeping the paths we already watch");
            None
        }
    }
}

/// 接続 1 本分の CLI worker(`main.rs` が `AbortOnDrop` で持つ)。
///
/// ここが **WS ループの外**である理由は `adopt` の materialize worker と同じ: `openroly sync` は
/// 全 runtime 分の CLI を呼ぶので分単位で掛かることがあり、ループの中で待つと `IDLE_TIMEOUT`
/// を跨いで接続が落ちる(PBI-0248 で塞いだ口)。
pub async fn run_cli_worker(
    argv: Vec<String>,
    timeout: Duration,
    poll: Duration,
    mut rx: UnboundedReceiver<CliJob>,
) {
    let mut paths = ask_watch_paths(&argv, timeout).await.unwrap_or_default();
    eprintln!("broker: watching {} native path(s) every {poll:?}", paths.len());
    let mut seen = stat_paths(&paths);
    let mut tick = interval(poll);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tick.tick().await; // 起動直後の即時 tick を消費

    loop {
        let mut want = Want::default();
        tokio::select! {
            job = rx.recv() => {
                // 送信端は接続ごと。None = 接続が畳まれた
                let Some(job) = job else { return };
                want.add(job);
            }
            _ = tick.tick() => {
                let now = stat_paths(&paths);
                if now != seen {
                    seen = now;
                    want.share = true;
                }
            }
        }
        // 溜まっている分を **走る前に** 全部吸う = 3 連発が 3 本にならない(AC-X3)
        while let Ok(job) = rx.try_recv() {
            want.add(job);
        }
        if !want.any() {
            continue;
        }
        if want.sync {
            match run_cli(&argv, timeout, &["sync"]).await {
                Ok(()) => eprintln!("broker: openroly sync done"),
                // **止まらない**(AC-X2): 次の trigger で再試行する。接続には触らない
                Err(e) => eprintln!("broker: openroly sync failed ({e})"),
            }
            // 新しい runtime が繋がっていれば見張る場所も増える。訊けなかった時は
            // **今の場所を残す**(空で上書きすると見張りが丸ごと消える)
            if let Some(fresh) = ask_watch_paths(&argv, timeout).await {
                paths = fresh;
            }
            // **自分の書き込みを次の周の変化として数えない**。`openroly sync` は config を書くので、
            // 基準を取り直さないと sync のたびに share が 1 本立つ(PBI-0213 の未決の問い)。
            seen = stat_paths(&paths);
            // ただし **取り直しは「人が sync の最中に書いた分」も一緒に飲む**。飲まれた変化は
            // もう誰も見ていないので、AC-2 の「10 秒以内に Found」が遅れるのではなく永久に来ない。
            // だから sync の直後は必ず share を 1 本立てて、今の native を読み直させる ——
            // 配ったばかりの物は `alreadyDesired` が提案から外す(PBI-0212 / 図67 の循環防止)。
            want.share = true;
        }
        if want.share {
            match run_cli(&argv, timeout, &["share", "--auto"]).await {
                Ok(()) => eprintln!("broker: openroly share --auto done"),
                Err(e) => eprintln!("broker: openroly share --auto failed ({e})"),
            }
        }
        // share の**後では**基準を取り直さない。share は見張る path を書かない(提案を送るだけ)
        // ので取り直す理由が無く、取り直すと share の実行中に人が書いた分まで飲む。
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn want_は種類ごとに_1_回へ潰す() {
        let mut w = Want::default();
        for _ in 0..3 {
            w.add(CliJob::Sync);
        }
        assert_eq!(w, Want { sync: true, share: false });
        w.add(CliJob::Share);
        assert!(w.any() && w.share);
    }

    #[test]
    fn parse_watch_paths_は絶対_path_だけを重複無しで上限まで返す() {
        let out = "/a\n\n  /b  \nrelative/c\n/a\n/d\n";
        assert_eq!(
            parse_watch_paths(out, 32),
            vec![PathBuf::from("/a"), PathBuf::from("/b"), PathBuf::from("/d")]
        );
        assert_eq!(parse_watch_paths(out, 2), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert!(parse_watch_paths("", 32).is_empty());
    }

    #[test]
    fn stat_paths_は存在しない_path_を_none_にし_変化で値が変わる() {
        let dir = std::env::temp_dir().join(format!("openroly-0213-stat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        let skills = dir.join("skills");
        let paths = vec![file.clone(), skills.clone()];

        // どちらも無い
        assert_eq!(stat_paths(&paths), vec![None, None]);

        // file が現れた
        std::fs::File::create(&file).unwrap().write_all(b"{}").unwrap();
        let after_create = stat_paths(&paths);
        assert!(after_create[0].is_some() && after_create[1].is_none());

        // 中身が増えた(同じ秒でも size で気付く)
        std::fs::write(&file, b"{\"mcpServers\":{}}").unwrap();
        assert_ne!(stat_paths(&paths), after_create);

        // skills dir が現れた → dir 直下に 1 つ足すと dir の姿も変わる
        std::fs::create_dir_all(&skills).unwrap();
        let after_dir = stat_paths(&paths);
        assert!(after_dir[1].is_some());
        std::fs::create_dir_all(skills.join("foo")).unwrap();
        assert_ne!(stat_paths(&paths), after_dir);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
