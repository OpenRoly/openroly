//! 再スキャンのきっかけ(要件 §45.3 層 2・3・4 / アーキ §39 / 図18。PBI-0024)。
//!
//! 既存のきっかけは 2 つ —— T0(起動 / 接続確立。`run_once` の頭で registry 取得 → scan → hello)と
//! T2(heartbeat 15s)。本 module はそこへ 3 つ足す:
//!
//! - 層 2: `spawn_fs_watch` —— 一般的な install 先を `notify` で監視し、binary / app bundle が
//!   現れた瞬間に `Trigger::Fs` を流す(heartbeat を待たない)
//! - 層 3: `SleepWatch` + `heartbeat_action` —— sleep からの復帰を検出して **再接続** させる
//! - 層 4: `serve_hook_socket` —— shell hook が送る `{cmd, path}` の 1 行を受け、特殊な場所に
//!   install された binary を拾う
//!
//! 3 つとも「合流点 1 箇所」(`main.rs` の `rescan_and_hello`)へ流し込むだけで、hello から先
//! (自動登録・materialize・Activity)には一切触れない。**検出のきっかけが増えても Detect ≠ Grant は
//! 不変** —— この file は delegation も is_default も allowlist も参照しない(diagrams-check で機械検査)。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::discovery::ScanEnv;
use crate::registry::Registry;

/// 合流点へ流す値。`Fs` は「どこかが変わった」だけ(どの dir かは scan が見る)、`Hook` は
/// shell が実際に走らせた command の名前と実体 path。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    Fs,
    Hook { cmd: String, path: String },
}

/// trigger の嵐(`brew install` の数十イベント / shell prompt ごとの hook)を 1 回にまとめる待ち時間。
pub const RESCAN_DEBOUNCE: Duration = Duration::from_millis(500);
/// trigger 起因の scan の最小間隔。これ未満で来た分は **捨てる** —— 落としても heartbeat(15s)が
/// 必ず拾うので正しさは失われない(要件 §45.3「Event detection + Periodic reconciliation の両輪」。
/// trigger は latency を縮める役であって、正しさの担い手ではない)。
pub const RESCAN_MIN_GAP: Duration = Duration::from_secs(3);
/// sleep 復帰と見なす「壁時計だけが進んだ量」。NTP の時刻跳躍で誤検出しても余分な再接続 1 回で済む。
pub const SLEEP_SKEW: Duration = Duration::from_secs(60);
/// 監視する dir の上限(アーキ §39「≤ 8 箇所」。全 filesystem は監視しない — §45.8)。
pub const MAX_WATCH_DIRS: usize = 8;
/// shell hook が渡した path の親 dir を覚えておく上限(FIFO)。
pub const MAX_HOOK_DIRS: usize = 8;
/// hook の 1 行の上限。これを超える行は読まずに捨てる。
const HOOK_LINE_MAX: usize = 4096;
const HOOK_CMD_MAX: usize = 64;
const HOOK_PATH_MAX: usize = 1024;
/// socket file 名。置き場は `broker_home()`(`OPENROLY_BROKER_HOME` を尊重する) —— `~/.openroly/broker.sock` を
/// hard-code すると test / E2E がユーザー本物の socket を掴む(PBI-0034 と同じ罠)。
pub const HOOK_SOCKET_NAME: &str = "broker.sock";

// ---------------------------------------------------------------- 層 2: filesystem watch

/// 監視する dir を選ぶ(純関数)。`extra_dirs`(固定の install 先) → `app_dirs` → `path_dirs` の順に
/// 連結し、**実在する dir だけ**を重複排除して先頭 `max` 件。
///
/// 固定 dir を先に置くのは、PATH に同じ dir が何度も出てくる環境で枠を食い潰さないため。既定では
/// `/usr/local/bin` `/opt/homebrew/bin` `~/.local/bin` `~/.cargo/bin` npm global bin `/Applications`
/// `~/Applications` がちょうど枠に収まる。
pub fn watch_dirs(env: &ScanEnv, max: usize) -> Vec<PathBuf> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();
    for dir in env.extra_dirs.iter().chain(&env.app_dirs).chain(&env.path_dirs) {
        if out.len() >= max {
            break;
        }
        // 重複判定は canonicalize した実体で行う(symlink 違いの同じ dir を 2 枠使わない)。
        // canonicalize できない = 実在しないので、そこで落ちる。
        let Ok(real) = std::fs::canonicalize(dir) else { continue };
        if !real.is_dir() || !seen.insert(real) {
            continue;
        }
        out.push(dir.clone());
    }
    out
}

/// `dirs` を非再帰で監視し、変化があれば `Trigger::Fs` を流す。返した watcher を **drop すると
/// 監視が止まる**ので、呼び出し元がプロセスの生存期間ずっと保持すること。
///
/// dir が 0 件・watcher を作れない環境では `None` を返して**起動を止めない**(層 2 が無くても
/// T0 / T2 で動く。§45.8 の built-in fallback と同じ思想)。
pub fn spawn_fs_watch(dirs: &[PathBuf], tx: UnboundedSender<Trigger>) -> Option<RecommendedWatcher> {
    if dirs.is_empty() {
        return None;
    }
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // イベントの中身は見ない —— 「どこかが変わった」以上のことを watcher に判断させると、
        // backend ごとの event 種別の差に実装が引きずられる。何が増えたかは scan が見る。
        if res.is_ok() {
            let _ = tx.send(Trigger::Fs);
        }
    })
    .map_err(|e| eprintln!("broker: cannot create the fs watch ({e}). Rescanning on heartbeat only"))
    .ok()?;
    let mut armed = 0usize;
    for dir in dirs {
        match watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => armed += 1,
            Err(e) => eprintln!("broker: fs watch failed dir={} ({e})", dir.display()),
        }
    }
    if armed == 0 {
        return None;
    }
    eprintln!("broker: fs watch = {armed} dirs {dirs:?}");
    Some(watcher)
}

// ---------------------------------------------------------------- 層 3: sleep からの復帰

/// 単調時計と壁時計のずれで sleep からの復帰を検出する。
///
/// macOS の `Instant` は sleep 中に進まないので、8 時間 sleep した後の tick では単調時計は
/// 15 秒しか進んでいないのに壁時計は 8 時間進む。この差が `SLEEP_SKEW` を超えたら復帰と見なす。
/// `Instant` が sleep 中も進む OS では差が出ないので、単に発火しないだけで害が無い。
#[derive(Debug)]
pub struct SleepWatch {
    last_mono: Instant,
    last_wall: SystemTime,
    skew: Duration,
}

impl SleepWatch {
    pub fn new(mono: Instant, wall: SystemTime, skew: Duration) -> SleepWatch {
        SleepWatch { last_mono: mono, last_wall: wall, skew }
    }

    /// tick ごとに呼ぶ。復帰していれば true。**呼ぶたびに内部の基準時刻を更新する**ので、
    /// 1 回の復帰を次の tick で二度数えない。
    pub fn woke(&mut self, mono: Instant, wall: SystemTime) -> bool {
        let mono_elapsed = mono.saturating_duration_since(self.last_mono);
        // 壁時計が巻き戻った場合(Err)は 0 扱い —— 巻き戻りは sleep 復帰ではない
        let wall_elapsed = wall.duration_since(self.last_wall).unwrap_or_default();
        self.last_mono = mono;
        self.last_wall = wall;
        wall_elapsed.saturating_sub(mono_elapsed) >= self.skew
    }
}

/// heartbeat tick でやること。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickAction {
    /// 接続を捨てて張り直す(理由は stderr に出す)
    Reconnect(&'static str),
    /// 再スキャンして差分があれば hello
    Rescan,
}

/// 「繋がっていた」と認めるまでの最短時間(PBI-0190 review)。これより短い接続は、clean close でも
/// **障害として数える** —— 下の `reconnect_wait` を参照。
pub const MIN_HEALTHY_CONNECTION: Duration = Duration::from_secs(30);

/// 再接続までの待ち時間と、次に使う backoff を決める(純関数)。
///
/// **clean close を無条件で「障害ではない」と読むと、handshake 直後に切る相手に張り付く**
/// (PBI-0190 review で発見)。1 接続ごとに registry fetch(HTTPS)+ discovery scan を走らせるので、
/// 500ms 間隔で回り続けると端末の CPU と Cloud の両方を焼く。しかも log には
/// `connected` → `connection closed` が並ぶだけで、**繋がっているように見える**。
/// deploy 中の proxy が 101 を返してすぐ切る・server が crash loop に居る、で普通に起きる。
///
/// 判定は 1 つだけ: **その接続が `MIN_HEALTHY_CONNECTION` 続いたか**。
///  - 続いた後の clean close = 正常な切断 → 即座に `initial` へ戻し、そのまま待つ(従来どおり)
///  - それより短い / `Err` = 障害 → 今の backoff だけ待ち、次を倍化(上限 `max`)
pub fn reconnect_wait(
    current: Duration,
    clean: bool,
    lasted: Duration,
    initial: Duration,
    max: Duration,
) -> (Duration, Duration) {
    if clean && lasted >= MIN_HEALTHY_CONNECTION {
        return (initial, initial);
    }
    (current, std::cmp::min(current * 2, max))
}

/// 接続の時計 3 つ(PBI-0277)。**knob は 1 つだけ** —— heartbeat を決めれば残り 2 つは比で決まる。
///
/// 既定は 15s / 40s / 20s で、PBI-0277 以前の定数と**同じ値**(15*8/3 = 40、15*4/3 = 20)。
/// 検査から縮められる口を開けるのは、AC-2 / AC-X1 が「**40 秒黙ったら張り直す**」という
/// 時間そのものを測る性質だから —— 本番の 40 秒を検査の deadline に流用すると 1 本 2 分かかり、
/// 誰も回さなくなる(= 一度も測っていないから緑、になる)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timings {
    /// ping を打つ間隔(discovery の再実行も相乗り)
    pub heartbeat: Duration,
    /// この間 **application frame を 1 つも受けなければ** half-open とみなして張り直す
    pub idle: Duration,
    /// connect + TLS handshake の上限。**これが無いと黒穴に張り付いて無音で止まる**
    pub connect: Duration,
}

/// 既定の heartbeat(PBI-0277 以前の `HEARTBEAT_INTERVAL`)。
pub const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(15);

/// `OPENROLY_BROKER_HEARTBEAT_MS` の生値 → Timings(純関数)。
///
/// 読めない / 0 / 桁が異常な値は **既定に落とす**。ここを素通しにすると、環境変数の打ち間違い
/// 1 つで「1ms ごとに再接続」= 自分で自分を DoS する経路が開く。
pub fn timings_from_env(raw: Option<&str>) -> Timings {
    let heartbeat = raw
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|ms| (100..=600_000).contains(ms))
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_HEARTBEAT);
    Timings {
        heartbeat,
        idle: heartbeat * 8 / 3,
        connect: heartbeat * 4 / 3,
    }
}

/// heartbeat tick の判定(純関数)。
///
/// **wake を idle より先に見る**のが要点: `last_activity` も単調時計なので、長時間 sleep した後の
/// tick では `idle` が 15 秒程度しか進んでおらず `IDLE_TIMEOUT` は決して発火しない。sleep 中に死んだ
/// TCP へ ping を打ち続ける経路を、ここで塞ぐ。
pub fn heartbeat_action(idle: Duration, idle_timeout: Duration, woke: bool) -> TickAction {
    if woke {
        return TickAction::Reconnect("wake from sleep");
    }
    if idle > idle_timeout {
        return TickAction::Reconnect("idle timeout (no response; treating the connection as half-open)");
    }
    TickAction::Rescan
}

// ---------------------------------------------------------------- 合流点の throttle

/// trigger 起因 scan の最小間隔を守る門(純関数相当。時刻を注入して単体検査する)。
#[derive(Debug, Default)]
pub struct RescanGate {
    last: Option<Instant>,
}

impl RescanGate {
    /// 通してよければ true(通した時刻を記録する)。false = 捨てる —— 落とした分は heartbeat が拾う。
    pub fn allow(&mut self, now: Instant, min_gap: Duration) -> bool {
        if let Some(last) = self.last
            && now.saturating_duration_since(last) < min_gap
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

/// 合流点の最終判定(純関数)。`new_dir`(まだ一度も見ていない install 先が見つかった)なら
/// gate の可否に関わらず即時 scan させる —— layer 4 の存在理由(AC-4「5 秒以内に検出」)が
/// この即時性に依存する。
///
/// **`gate.allow()` は必ず呼ぶ**(`new_dir` が true でも呼んでから結果を捨てる)。呼ばずに
/// 短絡評価で済ませると gate の内部時計(last)が更新されないまま残り、直後に来た**無関係な
/// fs storm**(この gate が本来守るべき相手)が「一度も scan していない」扱いの古い last と
/// 比較されて 3s 未満でも通ってしまう —— 独立レビューで実測(PBI-0024 AC-14)。呼び出し順を
/// 誤ると再発するので、判定を 1 箇所のこの関数に集約する。
pub fn should_scan(rescan: bool, new_dir: bool, gate: &mut RescanGate, now: Instant, min_gap: Duration) -> bool {
    let gate_ok = gate.allow(now, min_gap);
    rescan && (new_dir || gate_ok)
}

// ---------------------------------------------------------------- 層 4: shell hook socket

/// hook が送ってよいのは `{"cmd":"<name>","path":"<abs>"}` の 1 行だけ(要件 §45.8)。
/// **`cmd` と `path` 以外の key は読まない** —— 送られてきても捨てる。
///
/// `cmd` は `/` を含まない `[A-Za-z0-9._-]{1,64}`、`path` は絶対パスで `≤ 1024`。
pub fn parse_hook_line(line: &str) -> Option<Trigger> {
    if line.len() > HOOK_LINE_MAX {
        return None;
    }
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let cmd = v.get("cmd")?.as_str()?;
    let path = v.get("path")?.as_str()?;
    if cmd.is_empty() || cmd.len() > HOOK_CMD_MAX || !cmd.bytes().all(is_cmd_byte) {
        return None;
    }
    if path.len() > HOOK_PATH_MAX || !Path::new(path).is_absolute() {
        return None;
    }
    Some(Trigger::Hook { cmd: cmd.to_string(), path: path.to_string() })
}

fn is_cmd_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_'
}

/// `cmd` が registry のどれかの detector の `binaries` に載っているか。載っていない command では
/// **scan を起こさない**(そうしないと shell prompt ごとに PATH を歩くことになる)。
pub fn hook_matches_registry(registry: &Registry, cmd: &str) -> bool {
    registry.detectors.iter().any(|d| d.detect.binaries.iter().any(|b| b == cmd))
}

/// hook が渡した path の親 dir(実行可能ファイルの時だけ)。これを scan dir に足すのが層 4 の
/// 存在理由 —— 足さなければ「どの scan dir にも無い場所に install された binary」は結局出てこない
/// (要件 §45.3 層 4「install 場所が特殊でも拾える」)。
pub fn hook_dir(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() || !crate::discovery::is_executable_file(p) {
        return None;
    }
    p.parent().map(Path::to_path_buf)
}

/// `hook_dirs` へ FIFO で足す(既にあれば何もしない)。上限は `MAX_HOOK_DIRS`。
pub fn push_hook_dir(dirs: &mut Vec<PathBuf>, dir: PathBuf) -> bool {
    if dirs.contains(&dir) {
        return false;
    }
    if dirs.len() >= MAX_HOOK_DIRS {
        dirs.remove(0);
    }
    dirs.push(dir);
    true
}

/// 溜まった trigger を吸収し、`(再スキャンする理由があるか, 新しい dir が増えたか)` を返す。
///
/// 層 4 の `Hook` は **registry の `binaries` に載っている command だけ**を見る(そうしないと
/// shell prompt ごとに PATH を歩くことになる)。実行可能な絶対 path なら、その親 dir を
/// `hook_dirs` に足す —— これが層 4 の存在理由(要件 §45.3「install 場所が特殊でも拾える」)。
pub fn absorb(registry: &Registry, hook_dirs: &mut Vec<PathBuf>, batch: &[Trigger]) -> (bool, bool) {
    let mut rescan = false;
    let mut new_dir = false;
    for t in batch {
        match t {
            Trigger::Fs => rescan = true,
            Trigger::Hook { cmd, path } => {
                if !hook_matches_registry(registry, cmd) {
                    continue;
                }
                rescan = true;
                if let Some(dir) = hook_dir(path)
                    && push_hook_dir(hook_dirs, dir.clone())
                {
                    eprintln!("broker: hook dir added {}", dir.display());
                    new_dir = true;
                }
            }
        }
    }
    (rescan, new_dir)
}

/// shell hook の受け口。1 接続につき 1 行だけ読んで閉じる。パースできない行は無視して
/// **listener は生かし続ける**(1 通の壊れた行で層 4 が永久に死なない)。
///
/// bind の前に既存 path を unlink する —— 前回の異常終了で残った socket file があると
/// `AddrInUse` で bind が失敗し、以後 hook が二度と繋がらなくなる。
pub async fn serve_hook_socket(sock: PathBuf, tx: UnboundedSender<Trigger>) {
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;

    if let Some(parent) = sock.parent() {
        let _ = std::fs::create_dir_all(parent);
        set_mode(parent, 0o700);
    }
    let _ = std::fs::remove_file(&sock); // 残骸(socket でも通常ファイルでも)を消す
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("broker: cannot bind the hook socket path={} ({e})", sock.display());
            return;
        }
    };
    set_mode(&sock, 0o600); // 同一ホストの他ユーザーから再スキャンを叩けないようにする
    eprintln!("broker: hook socket = {}", sock.display());
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; HOOK_LINE_MAX];
            let mut len = 0usize;
            // 1 行(改行まで、または上限まで)。相手が閉じなくても上限で打ち切る。
            while len < buf.len() {
                match stream.read(&mut buf[len..]).await {
                    Ok(0) => break,
                    Ok(n) => {
                        len += n;
                        if buf[..len].contains(&b'\n') {
                            break;
                        }
                    }
                    Err(_) => return,
                }
            }
            let line = String::from_utf8_lossy(&buf[..len]);
            let line = line.split('\n').next().unwrap_or("");
            if let Some(t) = parse_hook_line(line) {
                let _ = tx.send(t);
            }
        });
    }
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_p: &Path, _mode: u32) {}

/// zsh 用の shell hook(要件 §45.3 層 4)。`openroly-broker --print-shell-hook` が stdout に出す。
///
/// **broker は shell rc を書き換えない** —— 入れるかどうかは人が決める(不可逆・外向きの操作)。
/// 送るのは **command 名と実体 path だけ**(§45.8)。引数・cwd・env・履歴本文は一切送らない。
/// 外部 binary(`nc` 等)に依存しないよう zsh 組込みの `zsh/net/socket` を使う —— prompt ごとに
/// 走るので fork も避ける。
///
/// **この文字列は grep だけでなく実 zsh で実行して検査すること**(E2E AC-13)。文字列としては
/// 正しく見えるのに既定の zsh では 1 バイトも送らない、という壊れ方をする —— 実測 2 件:
/// `[A-Za-z0-9._-]##` は `EXTENDED_GLOB` が要る(既定 off、`emulate -L zsh` が更に既定へ戻す)、
/// `$history[$HISTCMD]` は precmd 時点で「次の番号」を指し、`HISTSIZE=0` なら常に空。
pub const SHELL_HOOK_ZSH: &str = r#"# OpenRoly shell hook — paste into ~/.zshrc.
# It sends only the name of the command you just ran and the path of its binary.
# Arguments, cwd, and environment variables are never sent.
#
# The command name is taken from the first word of the command line preexec receives
# (no dependency on history): the $history[$HISTCMD] approach dies silently with
# HISTSIZE=0, and HISTCMD at precmd time is "the next number", so it is off by one.
# preexec does a single variable assignment and no I/O.
typeset -g _openroly_last_cmd=""

_openroly_preexec() {
  emulate -L zsh
  _openroly_last_cmd=${${(z)1}[1]}
}

_openroly_notify() {
  emulate -L zsh
  local c=$_openroly_last_cmd p
  _openroly_last_cmd=""
  [[ -n $c ]] || return 0
  local sock=${OPENROLY_BROKER_HOME:-$HOME/.openroly/broker}/broker.sock
  [[ -S $sock ]] || return 0
  if [[ $c == */* ]]; then p=${c:A}; c=${c:t}; else p=${commands[$c]}; fi
  [[ -n $p && -x $p ]] || return 0
  # Same character set as is_cmd_byte on the broker side. Written as a negation so it does not
  # depend on EXTENDED_GLOB (off by default; emulate -L zsh resets it) — `[A-Za-z0-9._-]##`
  # never matches in a default zsh.
  [[ $c != *[^A-Za-z0-9._-]* ]] || return 0
  zmodload -F zsh/net/socket b:zsocket 2>/dev/null || return 0
  zsocket "$sock" 2>/dev/null || return 0
  print -u $REPLY -r -- "{\"cmd\":\"$c\",\"path\":\"$p\"}"
  exec {REPLY}>&-
}

typeset -ga preexec_functions precmd_functions
preexec_functions+=(_openroly_preexec)
precmd_functions+=(_openroly_notify)
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tokio::sync::mpsc::unbounded_channel;

    /// PBI-0277: knob 1 つで 3 つの時計が決まる。**既定は改修前と同じ 15s / 40s / 20s**。
    #[test]
    fn timings_の既定は改修前と同じ値() {
        let t = timings_from_env(None);
        assert_eq!(t.heartbeat, Duration::from_secs(15));
        assert_eq!(t.idle, Duration::from_secs(40));
        assert_eq!(t.connect, Duration::from_secs(20));
    }

    /// 打ち間違い(0 / 負 / 文字 / 桁外れ)は既定へ落とす —— 素通しにすると
    /// 「1ms ごとに再接続」= 自分で自分を DoS する経路が開く。
    #[test]
    fn timings_の壊れた値は既定へ落ちる() {
        for raw in ["", "0", "-1", "abc", "99", "600001", "1e3", " "] {
            let t = timings_from_env(Some(raw));
            assert_eq!(t.heartbeat, DEFAULT_HEARTBEAT, "raw={raw:?} は既定に落ちるべき");
        }
        // 端(100ms / 600s)は通す。比も保つ
        assert_eq!(timings_from_env(Some("100")).heartbeat, Duration::from_millis(100));
        let t100 = timings_from_env(Some("100"));
        assert!(t100.idle > t100.heartbeat * 2 && t100.idle < t100.heartbeat * 3);
        assert_eq!(timings_from_env(Some(" 600000 ")).heartbeat, Duration::from_secs(600));
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("openroly-broker-trig-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_exec(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "#!/bin/sh\n").unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    // AC-2: 実在する dir だけ・重複を 1 回・8 件で打ち切り・順序は extra → app → path
    #[test]
    fn watch_dirs_dedups_skips_missing_and_caps() {
        let base = tmp("dirs");
        let mk = |n: &str| {
            let d = base.join(n);
            fs::create_dir_all(&d).unwrap();
            d
        };
        let (a, c) = (mk("a"), mk("c"));
        let path: Vec<PathBuf> = ["d", "e", "f", "g", "h", "i", "j", "k"].iter().map(|n| mk(n)).collect();
        let env = ScanEnv {
            extra_dirs: vec![a.clone(), base.join("missing"), a.clone()],
            app_dirs: vec![c.clone()],
            path_dirs: path.iter().cloned().chain([c.clone()]).collect(),
            home: None,
        };
        let got = watch_dirs(&env, MAX_WATCH_DIRS);
        let want: Vec<PathBuf> =
            [a, c].into_iter().chain(path.iter().take(6).cloned()).collect();
        assert_eq!(got, want, "{got:?}");
        assert_eq!(got.len(), 8);
        fs::remove_dir_all(&base).unwrap();
    }

    // AC-1(単体): watch した dir に binary が現れたら Trigger::Fs が来る
    #[tokio::test]
    async fn fs_watch_fires_on_new_binary() {
        let dir = tmp("watch");
        let (tx, mut rx) = unbounded_channel();
        let _w = spawn_fs_watch(&[dir.clone()], tx).expect("watcher");
        write_exec(&dir.join("codex"));
        let got = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert_eq!(got.expect("timeout"), Some(Trigger::Fs));
        fs::remove_dir_all(&dir).unwrap();
    }

    // dir が 0 件 / 実在しない dir だけなら None(起動は止めない)
    #[test]
    fn fs_watch_is_optional() {
        let (tx, _rx) = unbounded_channel();
        assert!(spawn_fs_watch(&[], tx.clone()).is_none());
        assert!(spawn_fs_watch(&[PathBuf::from("/nonexistent/openroly-watch")], tx).is_none());
    }

    // AC-3: 最小間隔 3s。落ちた分は heartbeat が拾う前提
    #[test]
    fn rescan_gate_keeps_min_gap() {
        let mut gate = RescanGate::default();
        let t0 = Instant::now();
        assert!(gate.allow(t0, RESCAN_MIN_GAP));
        assert!(!gate.allow(t0 + Duration::from_millis(100), RESCAN_MIN_GAP));
        assert!(!gate.allow(t0 + Duration::from_millis(500), RESCAN_MIN_GAP));
        assert!(!gate.allow(t0 + Duration::from_millis(2900), RESCAN_MIN_GAP));
        assert!(gate.allow(t0 + Duration::from_millis(3100), RESCAN_MIN_GAP));
    }

    // AC-14(独立レビューで追加): should_scan は new_dir=true でも gate.allow を必ず呼ぶ。
    // 呼ばずに済ませる実装(短絡評価)だと、直後の無関係な fs storm が gate の古い(未更新の)
    // last と比較されて RESCAN_MIN_GAP 未満でも通ってしまう(main.rs で実際に踏んだ bug)。
    #[test]
    fn should_scan_lets_new_dir_through_but_keeps_throttling_unrelated_fs_storms() {
        let mut gate = RescanGate::default();
        let t0 = Instant::now();

        // 新規 dir(rescan=true, new_dir=true): gate の可否に関わらず即時通す
        assert!(should_scan(true, true, &mut gate, t0, RESCAN_MIN_GAP));

        // その 0.1 秒後、無関係な fs storm(rescan=true, new_dir=false)。gate.allow が
        // 呼ばれずに last が更新されていない実装だとここが誤って true になる。
        let t1 = t0 + Duration::from_millis(100);
        assert!(
            !should_scan(true, false, &mut gate, t1, RESCAN_MIN_GAP),
            "new_dir bypass の直後に来た無関係な fs storm が RESCAN_MIN_GAP(3s)未満で通ってしまった"
        );

        // 3.1 秒後なら通常どおり通る
        let t2 = t0 + Duration::from_millis(3100);
        assert!(should_scan(true, false, &mut gate, t2, RESCAN_MIN_GAP));
    }

    // AC-8: 壁時計だけが進んだ tick を復帰と見なす。1 回の復帰を 2 回数えない
    #[test]
    fn sleep_watch_detects_wall_clock_jump_once() {
        let m0 = Instant::now();
        let w0 = SystemTime::UNIX_EPOCH;
        let mut sw = SleepWatch::new(m0, w0, SLEEP_SKEW);
        let s = Duration::from_secs(1);
        assert!(!sw.woke(m0 + 15 * s, w0 + 15 * s), "通常の tick を復帰と誤判定した");
        assert!(sw.woke(m0 + 30 * s, w0 + 15 * s + Duration::from_secs(8 * 3600)));
        assert!(
            !sw.woke(m0 + 45 * s, w0 + 30 * s + Duration::from_secs(8 * 3600)),
            "1 回の復帰を 2 回数えた(内部の基準時刻が更新されていない)"
        );
        // 壁時計が巻き戻っても復帰扱いにしない
        assert!(!sw.woke(m0 + 60 * s, w0));
    }

    // AC-9: wake は idle より先に判定される
    #[test]
    fn heartbeat_action_prefers_wake_over_idle() {
        let idle_timeout = Duration::from_secs(40);
        assert_eq!(
            heartbeat_action(Duration::from_secs(1), idle_timeout, true),
            TickAction::Reconnect("wake from sleep")
        );
        // 長時間 sleep 後は idle が単調時計のせいで小さいまま —— それでも再接続させる
        assert!(matches!(
            heartbeat_action(Duration::from_secs(41), idle_timeout, false),
            TickAction::Reconnect(r) if r.starts_with("idle timeout")
        ));
        assert_eq!(heartbeat_action(Duration::from_secs(1), idle_timeout, false), TickAction::Rescan);
    }

    // AC-5: 不正な行は全て None。余分な key は読まれず捨てられる
    #[test]
    fn parse_hook_line_rejects_bad_input() {
        for bad in [
            "",
            "not json",
            "{}",
            r#"{"cmd":"../x","path":"/a"}"#,
            r#"{"cmd":"x/y","path":"/a"}"#,
            r#"{"cmd":"codex","path":"rel/codex"}"#,
            r#"{"cmd":"codex"}"#,
            r#"{"path":"/a/codex"}"#,
            r#"{"cmd":123,"path":"/a"}"#,
        ] {
            assert_eq!(parse_hook_line(bad), None, "受理してはいけない: {bad}");
        }
        let long_cmd = format!(r#"{{"cmd":"{}","path":"/a"}}"#, "a".repeat(200));
        assert_eq!(parse_hook_line(&long_cmd), None);
        let long_path = format!(r#"{{"cmd":"codex","path":"/{}"}}"#, "b".repeat(2000));
        assert_eq!(parse_hook_line(&long_path), None);
        let huge = format!(r#"{{"cmd":"codex","path":"/a","x":"{}"}}"#, "c".repeat(8000));
        assert_eq!(parse_hook_line(&huge), None, "行長の上限を超えたら読まない");
        // 余分な key(§45.8 で送ってはいけないもの)が来ても cmd / path しか読まない
        assert_eq!(
            parse_hook_line(r#"{"cmd":"codex","path":"/x/codex","cwd":"/secret","argv":["--k","v"]}"#),
            Some(Trigger::Hook { cmd: "codex".into(), path: "/x/codex".into() })
        );
    }

    // AC-6: registry の binaries に無い command では scan を起こさない
    #[test]
    fn hook_matches_only_registry_binaries() {
        let reg = registry::builtin();
        assert!(hook_matches_registry(&reg, "codex"));
        assert!(hook_matches_registry(&reg, "claude"));
        assert!(!hook_matches_registry(&reg, "ls"));
    }

    // 層 4 の本体: 実行可能なら親 dir を scan 対象に足す。FIFO・重複なし・上限あり
    #[test]
    fn hook_dir_and_push() {
        let dir = tmp("hookdir");
        let bin = dir.join("codex");
        write_exec(&bin);
        assert_eq!(hook_dir(bin.to_str().unwrap()), Some(dir.clone()));
        assert_eq!(hook_dir("rel/codex"), None);
        assert_eq!(hook_dir(dir.join("missing").to_str().unwrap()), None);
        assert_eq!(hook_dir(dir.to_str().unwrap()), None, "dir 自体は実行ファイルではない");

        let mut dirs = Vec::new();
        assert!(push_hook_dir(&mut dirs, dir.clone()));
        assert!(!push_hook_dir(&mut dirs, dir.clone()), "重複は足さない");
        for i in 0..MAX_HOOK_DIRS {
            push_hook_dir(&mut dirs, PathBuf::from(format!("/x/{i}")));
        }
        assert_eq!(dirs.len(), MAX_HOOK_DIRS);
        assert!(!dirs.contains(&dir), "上限を超えたら古いものから落ちる");
        fs::remove_dir_all(&dir).unwrap();
    }

    // AC-6 + 層 4 の吸収: 未知 cmd は scan を起こさず dir も増やさない。既知 cmd は両方
    #[test]
    fn absorb_ignores_unknown_commands() {
        let reg = registry::builtin();
        let dir = tmp("absorb");
        let bin = dir.join("codex");
        write_exec(&bin);
        let mut dirs = Vec::new();

        let unknown = [Trigger::Hook { cmd: "ls".into(), path: bin.to_string_lossy().into() }];
        assert_eq!(absorb(&reg, &mut dirs, &unknown), (false, false));
        assert!(dirs.is_empty());

        let known = [Trigger::Hook { cmd: "codex".into(), path: bin.to_string_lossy().into() }];
        assert_eq!(absorb(&reg, &mut dirs, &known), (true, true));
        assert_eq!(dirs, vec![dir.clone()]);
        // 2 回目は dir が増えないので new_dir は false(throttle を毎回すり抜けない)
        assert_eq!(absorb(&reg, &mut dirs, &known), (true, false));

        // fs event 単体は scan の理由になるが dir は増やさない
        assert_eq!(absorb(&reg, &mut dirs, &[Trigger::Fs]), (true, false));
        fs::remove_dir_all(&dir).unwrap();
    }

    // AC-4 / AC-7: 残骸を unlink して bind し、mode 0600 / 親 dir 0700。壊れた行でも listener は死なない
    #[tokio::test]
    async fn hook_socket_serves_after_stale_file_and_survives_garbage() {
        use tokio::io::AsyncWriteExt;
        let home = tmp("sock");
        let sock = home.join(HOOK_SOCKET_NAME);
        fs::write(&sock, "stale").unwrap(); // 前回の異常終了の残骸(通常ファイル)
        let (tx, mut rx) = unbounded_channel();
        tokio::spawn(serve_hook_socket(sock.clone(), tx));
        // 残骸を unlink して bind し直せていれば「繋がる」= socket として使える
        let send = async |line: &str| {
            let mut s = tokio::net::UnixStream::connect(&sock).await.unwrap();
            s.write_all(line.as_bytes()).await.unwrap();
            s.shutdown().await.unwrap();
        };
        for i in 0..50 {
            if tokio::net::UnixStream::connect(&sock).await.is_ok() {
                break;
            }
            assert!(i < 49, "hook socket に繋がらない(残骸を unlink できていない)");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700);

        send("garbage not json\n").await;
        send("{\"cmd\":\"codex\",\"path\":\"/opt/codex\"}\n").await;
        let got = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.expect("timeout");
        assert_eq!(
            got,
            Some(Trigger::Hook { cmd: "codex".into(), path: "/opt/codex".into() }),
            "壊れた行の後でも正常な行で発火する"
        );
        fs::remove_dir_all(&home).unwrap();
    }

    // AC-10: snippet は cmd / path 以外を送らない(§45.8)
    #[test]
    fn shell_hook_sends_only_cmd_and_path() {
        assert!(SHELL_HOOK_ZSH.contains("precmd_functions"));
        // socket へ流す行は 1 本だけで、載るのは cmd と path の 2 つの変数だけ
        let sent: Vec<&str> = SHELL_HOOK_ZSH.lines().filter(|l| l.contains("print -u")).collect();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(
            sent[0].trim(),
            r#"print -u $REPLY -r -- "{\"cmd\":\"$c\",\"path\":\"$p\"}""#,
            "送出行が cmd / path 以外を載せている(§45.8)"
        );
        for banned in ["$PWD", "$PS1", "$@", "printenv", "$OLDPWD"] {
            assert!(!SHELL_HOOK_ZSH.contains(banned), "snippet が {banned} を送っている");
        }
        // 既定の zsh で無言で死ぬ 2 つの罠を再発させない(実測。E2E AC-13 が実行で確かめる)。
        // 罠の説明は snippet 内のコメントにも書いてあるので、**実行される行だけ**を見る。
        let code: String =
            SHELL_HOOK_ZSH.lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join("\n");
        assert!(
            !code.contains("]##"),
            "EXTENDED_GLOB(既定 off)が要る `##` を使っている —— 既定の zsh では決して一致しない"
        );
        assert!(
            !code.contains("HISTCMD"),
            "履歴に依存している —— HISTSIZE=0 で無言で死に、precmd 時点の HISTCMD は 1 ずれる"
        );
    }
}
