//! C1 = macOS で **claude の dedicated session** を「pool の専用 uid + pf anchor」で
//! loopback egress だけに閉じ込める(PBI-0441 決定節 ③)。
//!
//! seatbelt の profile は `remote tcp "*:<port>"` で port 番号しか pin できず、同じ port 番号で
//! listen する外部 host へは素通り(`sandbox.rs` の残差 = `port_scoped`)。pf は発信 socket を
//! **開いた uid** で規則を当てられる(`man pf.conf(5)` の `user`)ので、claude を専用 uid で起こし、
//! その uid の非 loopback 出口を pf で drop すれば loopback の proxy 以外へ出られない(= `host_scoped`)。
//!
//! **なぜ claude だけか**: 専用 uid は本人の `~/.claude` も Keychain も読めない(C1 G2 の T6 実測)ので、
//! 資格情報を専用 uid に渡せる runtime だけを閉じられる。claude は購読の `.credentials.json` を
//! 専用 uid が読める形で置けば 1 turn 返る(owner の 2 回目 = `OK441=yes`)。codex は学生用 account で
//! 未測・gemini はこの機で未ログイン → **その 2 つは `port_scoped` のまま**(黙って host_scoped と
//! 名乗らない)。だから egress の絞り方は device 単位でなく **runtime 単位**で決まる。
//!
//! # 権限の形(2026-09-13 に組み直した)
//!
//! **root の操作は install 時に全部済ませる。** uid の pool を作るのも、pf anchor を uid 範囲 1 本で
//! load するのも、再起動後に load し直す LaunchDaemon を置くのも、`scripts/openroly-c1-setup.sh` が
//! owner の管理者確認 1 回の中で終える。**実行時に broker が持つ root 由来の力は
//! 「pool の uid として走る」事だけ**(`sudo -n -u <pool uid> --`)—— dscl も pfctl も chown も
//! 実行時には 1 度も打たない。資格情報は broker が自分の持ち物として 0600 で置き、専用 uid には
//! ACL 1 本(`chmod +a`・root 不要)で read,write だけ渡す。
//!
//! **なぜ組み直したか**: 前の形は sudoers に `dscl . -create /Users/_openroly_s* * *` と
//! `chown 5[5-9][0-9]:20 <state>/sessions/*` を残していた。**sudoers の wildcard は
//! 引数の中では `/` も空白も跨ぐ**(この機の `man sudoers`: "When matching the command line
//! arguments, however, a slash does get matched by wildcards … Wildcards can match any character,
//! including white space")。だから `dscl . -create /Users/_openroly_s550 UniqueID 0` が通り、
//! 続く `sudo -u _openroly_s550 <何でも>` が **password 無しの root** になっていた ——
//! login user で走る process は全部それを使えた。C1 の代金は「install 時の管理者確認 1 回」であって、
//! 常時の root ではない。今の sudoers には root の command が 1 つも無い
//! (`scripts/openroly-c1-setup.test.ts` が生成物を読んで測る)。
//!
//! この module が持つのは **形と規律**(pool から uid を借りる lease・sudo に渡す argv の固定・
//! 資格情報の 0600 + ACL と後始末・sig による rotation 検出・runtime 別 enforcement の判定)。
//! **実機で root op を通すのは owner script**(pane からは dscl も pfctl も security も動かせない)。

use std::collections::BTreeSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tokio::process::Command;

/// pool の専用ユーザー名の接頭辞。`sudo -n -u` に渡すので **この接頭辞 + 検証済み token** の
/// 形しか作らない(下の `session_user`)。
pub const USER_PREFIX: &str = "_openroly_s";

/// pool の uid 範囲。install 時にこの範囲の account が全部作られ、pf anchor 1 本がこの範囲を塞ぐ。
/// 501 から順に増える一般ユーザーとぶつからず、500 未満の system 帯も避ける。
pub const UID_MIN: u32 = 550;
pub const UID_MAX: u32 = 599;

/// pf anchor の名前。**session ごとには作らない** —— install 時に 1 本 load して置きっぱなし。
/// `/etc/pf.conf` は `anchor "com.apple/*"` しか評価しないので、この名前空間の下でないと
/// 黙って効かない(実測 2026-09-12)。
pub const ANCHOR: &str = "com.apple/500.openroly";

/// install script が置く root 所有の file。broker は **読む(stat する)だけ** ——
/// `/etc/pf.anchors` も `/Library/LaunchDaemons` も 755 なので root は要らない。
pub const ANCHOR_FILE: &str = "/etc/pf.anchors/openroly-c1";
/// 再起動後に anchor を load し直す root 所有の LaunchDaemon。
pub const LAUNCHD_PLIST: &str = "/Library/LaunchDaemons/com.openroly.c1.plist";

/// 専用 HOME の下の claude 資格情報の相対 path。後始末はこの 1 箇所を名指しする。
pub const CLAUDE_CRED_REL: &str = ".claude/.credentials.json";

/// C1 が使えるか。`available` が真の時だけ claude の dedicated session を `host_scoped` にできる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct C1Status {
    pub available: bool,
    /// doctor / log に出す短い理由(unavailable の時)。
    pub reason: String,
}

impl C1Status {
    fn unavailable(reason: impl Into<String>) -> Self {
        C1Status { available: false, reason: reason.into() }
    }
}

/// pool の uid から見て「非 loopback に出られるか」の実測(root 不要・`probe_pool_egress`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressProbe {
    /// 繋がらなかった(broker 自身は同じ listener に繋がった上で)= pf が今この uid を塞いでいる
    Blocked,
    /// 繋がった = anchor file は在っても規則が効いていない
    Reachable,
    /// 測れなかった(非 loopback の IP が無い・broker 自身も繋がらない・pool の uid が答えない)
    Unmeasured(String),
}

/// C1 の在り無しを 3 つの観測から決める(pure)。実機の shell はここに materialize してから渡す。
/// - `run_as_ok`: pool の uid として走れる(= sudoers の run-as 行が在り、pool の account も実在する)。
///   **実行時に要る grant はこれ 1 つだけ**。
/// - `pf_installed`: install script が置いた anchor file と LaunchDaemon が在る。
/// - `probe`: pool の uid が **今** 非 loopback に出られないか(`probe_pool_egress`)。
///
/// **全部揃い、probe が `Blocked` の時だけ available**。file が在るだけでは名乗らない —— 再起動で
/// LaunchDaemon が anchor を読み損ねた・誰かが `pfctl -d` した・verify が T0 の flush の直後に
/// 殺された、のどれでも file は在り穴は開いている(module review で見つけた fail-open)。
pub fn decide(run_as_ok: bool, pf_installed: bool, probe: &EgressProbe) -> C1Status {
    match (run_as_ok, pf_installed, probe) {
        (false, _, _) => C1Status::unavailable("no C1 uid pool (run scripts/openroly-c1-setup.sh)"),
        (true, false, _) => C1Status::unavailable("the pf anchor is not installed"),
        (true, true, EgressProbe::Blocked) => C1Status { available: true, reason: String::new() },
        (true, true, EgressProbe::Reachable) => C1Status::unavailable(
            "the pf anchor is installed but not blocking (a pool uid reached a non-loopback address)",
        ),
        (true, true, EgressProbe::Unmeasured(why)) => {
            C1Status::unavailable(format!("could not confirm the pf anchor is blocking ({why})"))
        }
    }
}

/// C1 で閉じられる runtime。**資格情報を専用 uid に渡せると実測できた物だけ**を載せる ——
/// claude は購読の `.credentials.json` を渡して 1 turn 返る事を owner の 2 回目の probe で
/// 実測した(`OK441=yes`)。codex は学生用 account で未測・gemini はこの機で未ログインなので載せない
/// (黙って `host_scoped` と名乗らない = PBI-0441 が殺そうとしている嘘)。
pub const C1_RUNTIMES: &[&str] = &["claude"];

/// この runtime / この session に効いている egress の絞り方(PBI-0441 の runtime 別 enforcement)。
/// `base` は sandbox backend の床(`port_scoped` = seatbelt/landlock・`none` = NoSandbox)。
///
/// C1 が使えて、**`C1_RUNTIMES` の runtime** で、床が `port_scoped` の時だけ `host_scoped` に上げる。
/// - codex / gemini は資格情報を専用 uid に渡せない → `base`(= `port_scoped`)のまま。
/// - `none`(NoSandbox)は dedicated を起こさないので C1 も無い → `none` のまま。
pub fn effective_enforcement(runtime: &str, base: &'static str, c1: &C1Status) -> &'static str {
    if c1.available && C1_RUNTIMES.contains(&runtime) && base == "port_scoped" {
        "host_scoped"
    } else {
        base
    }
}

/// hello / status file に載せる **床より上げた runtime だけ**の表(PBI-0441 ③)。
/// 上げる物が無ければ空 —— その時の wire は旧 broker と 1 byte も変わらない(既存の読み手は無改修)。
/// 読み手は「表に在ればそれ・無ければ床」で合流する(`packages/core/src/egress.ts` が正本)。
pub fn raised_by_runtime(base: &'static str, c1: &C1Status) -> Vec<(&'static str, &'static str)> {
    C1_RUNTIMES
        .iter()
        .filter_map(|r| {
            let eff = effective_enforcement(r, base, c1);
            (eff != base).then_some((*r, eff))
        })
        .collect()
}

/// token から専用ユーザー名を作る。`sudo -n -u` の引数になるので、
/// **`-` で始まる option 化・path 区切り・shell メタ文字を一切通さない**(lessons 13: 弱い側から来た値を
/// 強い側が CLI に渡す時は形を検証する)。ascii 英数のみ・1〜32 文字。それ以外は `None`。
pub fn session_user(token: &str) -> Option<String> {
    safe_token(token).map(|t| format!("{USER_PREFIX}{t}"))
}

/// `sudo -n -u` に載せてよい token だけを通す。英数のみ・1〜32 文字。
fn safe_token(token: &str) -> Option<&str> {
    let ok = (1..=32).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then_some(token)
}

/// pool の uid から専用ユーザー名を作る(**request_id からは作らない** —— request_id は `_` を含むので
/// `safe_token` を通らず、削って通しても 2 つの id が同じ名前に化けうる。同じ名前を共有した
/// 2 session は、片方の teardown が他方の資格情報を消す)。
pub fn user_for_uid(uid: u32) -> Option<String> {
    session_user(&uid.to_string())
}

// pool 全体の egress を塞ぐ pf 規則の**正本は `scripts/openroly-c1-setup.sh` の `anchor_rules()`**。
// broker は実行時に pf を 1 度も触らない(触れる grant を残す事自体が破れだった)ので、ここには
// 写しを置かない —— 2 箇所に書くと必ずずれる。規則の形の検査は
// `scripts/openroly-c1-setup.test.ts`(生成物を読む)が持つ。形の要点だけ記す:
//   - `user <a> >< <b>` は **境界を含まない**ので pool 550..599 は `549 >< 600` と書く。
//     `user 550:599` は通らない —— man の文法表は binary-op を許すと読めるが、この機の pfctl は
//     `unknown user 550:599` で落ちる(実測 2026-09-13 `pfctl -n -f`)。
//   - inet と inet6 の **2 行**が要る(v6 の行が無いと IPv6 の出口が素通り・probe 実測 2026-09-12)。

/// broker が読んだ claude 購読 `.credentials.json`(値)を、専用 HOME へ 0600 で置く。
/// **値は log に出さない**(呼び手は Keychain から読んだ文字列をそのまま渡し、ここは file に書くだけ)。
///
/// **持ち主は broker(本人 uid)のまま** —— `chown` しない。使い捨ての uid に資格情報の所有権を渡すと、
/// 後始末に root が要る所まで戻ってしまう。専用 uid には呼び手が ACL 1 本で read,write を渡す。
pub fn drop_claude_credentials(agent_home: &Path, cred_json: &str) -> io::Result<PathBuf> {
    let path = agent_home.join(CLAUDE_CRED_REL);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_0600(&path, cred_json.as_bytes())?;
    Ok(path)
}

#[cfg(unix)]
fn write_0600(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(bytes)
}

#[cfg(not(unix))]
fn write_0600(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)
}

/// session 終了時: 専用 HOME に置いた資格情報 file を **名指しで消し**、HOME の下に残った
/// 通常 file の数を返す(0 でなければ後始末が漏れている = 呼び手が警告する)。
/// **root は要らない** —— file の持ち主は broker のままなので普通に消せる。
pub fn cleanup_credentials(agent_home: &Path) -> io::Result<usize> {
    let cred = agent_home.join(CLAUDE_CRED_REL);
    match fs::remove_file(&cred) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(count_files(agent_home))
}

/// dir の下の通常 file の数(後始末の残数確認用)。辿れない所は数えない(fail は 0 でなく残数側に倒さない ——
/// 呼び手は「0 でない = 残っている」で警告するので、読めない dir を「0」と偽らないよう在る物だけ数える)。
fn count_files(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            n += count_files(&e.path());
        } else if ft.is_file() {
            n += 1;
        }
    }
    n
}

/// claude 資格情報の `refreshToken` の指紋(値を出さずに rotation を検出する為)。
/// **crypto の境界ではない** —— 同じ process 内 / 前後で「変わったか」だけを見るので、std の hasher で足りる
/// (値は返さない・log には prefix だけ載る)。JSON を読めない / field が無い時は `"none"`。
///
/// C1 G2 ③ の docs 結論: copy 側で refresh が走ると本人の token が入れ替わりうる。session 終了時に
/// drop 時の sig と比べ、変わっていたら 1 行出す(本人 Keychain へは書き戻さない)。
pub fn refresh_token_sig(cred_json: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(cred_json) else {
        return "none".to_string();
    };
    match v.get("claudeAiOauth").and_then(|o| o.get("refreshToken")).and_then(|t| t.as_str()) {
        Some(tok) if !tok.is_empty() => {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            tok.hash(&mut h);
            format!("{:016x}", h.finish())
        }
        _ => "none".to_string(),
    }
}

// ---- 実行時に打つ物(root の command は 1 つも無い)-------------------------------------------

/// `sudo -n -u <pool uid>` に渡す絶対 path。相対名を渡すと PATH を握れる者が別の binary を
/// 走らせられる。**sudoers が許すのは run-as だけ** —— ここに root の command は無い。
const SUDO: &str = "/usr/bin/sudo";
/// ACL の付け外し(`chmod +a` / `chmod -a`)。**root は要らない**(対象を書ける本人 uid で打てる)。
const CHMOD: &str = "/bin/chmod";
/// 購読の資格情報を読む(本人 uid の Keychain)。値は返り値の中だけに在り、log には出さない。
const SECURITY: &str = "/usr/bin/security";
/// run-as の grant と pool account の実在を 1 回で確かめる無害な command。
const TRUE_BIN: &str = "/usr/bin/true";

/// claude が読む Keychain 項目(PBI-0441 ② で binary から特定・owner の 2 回目で実測)。
/// account は `$USER`、service はこの名前。**`-a` と `-s` の両方を付けて読む** ——
/// service だけで読むと別 account の古い項目(refresh token 空)を拾う(1 回目の probe の欠陥)。
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// dir に渡す ACL の権限(agent が lane の folder と session HOME に書ける最低限 + 継承)。
const ACL_DIR: &str = "list,add_file,search,delete,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,read,write,append,execute,file_inherit,directory_inherit";
/// 資格情報 file に渡す ACL。**読めて、refresh で書き戻せる分だけ** —— dir の権限一式は渡さない。
const ACL_CRED: &str = "read,write";

/// 子に持たせる env の名前。`sudo` は既定で env を落とすので名指しで通す(**値はここに書かない**)。
/// proxy の 4 変数と `NO_PROXY` が落ちると、閉じ込めた子が proxy を通らず「繋がらない」だけになる。
pub const PRESERVE_ENV: &[&str] = &[
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "OPENROLY_SESSION_SCOPE",
    "OPENROLY_SESSION_ID",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
];

/// 今このプロセスが借りている pool の uid。
///
/// ponytail: 端末に broker は 1 本、という前提の in-process lease。2 本目の broker を支える必要が
/// 出たら state dir の `O_EXCL` file lease に上げる(crash 後の stale 回収が要るのはその時だけ)。
static LEASED: Mutex<BTreeSet<u32>> = Mutex::new(BTreeSet::new());

/// pool から借りた uid。**drop で pool に返る**。
pub struct Lease {
    uid: u32,
}

impl Lease {
    pub fn uid(&self) -> u32 {
        self.uid
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut held) = LEASED.lock() {
            held.remove(&self.uid);
        }
    }
}

/// pool の空き uid を 1 つ借りる。**同じ uid を 2 session が同時に使わない** ——
/// 共有すると片方の teardown が他方の資格情報を消し、ACL も外す(閉じ込めたまま仕事だけ壊れる)。
/// 全部埋まっていれば `None`(呼び手は session を起こさない)。
pub fn lease_uid() -> Option<Lease> {
    let mut held = LEASED.lock().ok()?;
    let uid = (UID_MIN..=UID_MAX).find(|u| !held.contains(u))?;
    held.insert(uid);
    Some(Lease { uid })
}

/// 専用 uid に path への書き込みを許す ACL(**root 不要**・teardown で外す)。
///
/// 専用 uid は folder の所有者でも group でもないので、POSIX の permission だけでは
/// owner の project folder に 1 byte も書けない(= agent が仕事をできない)。所有権は
/// **変えない** —— owner の folder を使い捨ての uid に渡すのは戻せない操作。ACL なら
/// 1 エントリの足し引きで済み、`chmod -a` で元に戻る。
pub fn acl_grant_argv(user: &str, path: &Path, perms: &str) -> Vec<String> {
    vec![
        CHMOD.to_string(),
        "+a".to_string(),
        format!("user:{user} allow {perms}"),
        path.to_string_lossy().to_string(),
    ]
}

/// 足した ACL を外す(teardown)。`+a` と同じ文字列を `-a` に渡す。
pub fn acl_revoke_argv(user: &str, path: &Path, perms: &str) -> Vec<String> {
    let mut v = acl_grant_argv(user, path, perms);
    v[1] = "-a".to_string();
    v
}

/// 専用 uid で起こす形(pure)。`--` の後ろは option として読まれない ——
/// program / args が `-` で始まっても sudo の flag に化けない。
pub fn spawn_as_user_argv(user: &str, program: &str, args: &[String]) -> (String, Vec<String>) {
    let mut out = vec![
        "-n".to_string(),
        "-u".to_string(),
        user.to_string(),
        format!("--preserve-env={}", PRESERVE_ENV.join(",")),
        "--".to_string(),
        program.to_string(),
    ];
    out.extend(args.iter().cloned());
    (SUDO.to_string(), out)
}

/// `cmd` を専用 uid で起こす形に包む。`sandbox.wrap` と同じ約束 —— **program / args / env / cwd しか
/// 写さない**ので、stdio と process_group は呼び手が包んだ後に付ける。
///
/// **`sandbox.wrap` の後に呼ぶ**(sudo が一番外側)。順番を逆にすると sandbox の中から setuid を
/// 叩く形になり、profile がそれを deny するので session がそもそも起きない。
pub fn wrap_as_user(cmd: Command, user: &str) -> Command {
    let std = cmd.as_std();
    let args: Vec<String> = std.get_args().map(|a| a.to_string_lossy().to_string()).collect();
    let (program, args) = spawn_as_user_argv(user, &std.get_program().to_string_lossy(), &args);
    let mut wrapped = Command::new(program);
    wrapped.args(args);
    for (k, v) in std.get_envs() {
        match v {
            Some(v) => {
                wrapped.env(k, v);
            }
            None => {
                wrapped.env_remove(k);
            }
        }
    }
    if let Some(dir) = std.get_current_dir() {
        wrapped.current_dir(dir);
    }
    wrapped
}

/// 引数の先頭を program として静かに実行する(後始末用・失敗しても続ける)。
fn run_quiet(argv: &[String]) {
    if let Some((program, args)) = argv.split_first() {
        let _ = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// 引数の先頭を program として実行し、失敗を理由付きで返す(setup 用)。
fn run_checked(argv: &[String], what: &str) -> Result<(), String> {
    let (program, args) = argv.split_first().ok_or_else(|| format!("empty argv for {what}"))?;
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("{what}: could not run {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// pool の account の primary group(`scripts/openroly-c1-setup.sh` の `PrimaryGroupID 20` = staff)。
/// dir の group x がこの gid に付いていれば、pool の uid はその dir を辿れる。
pub const POOL_GID: u32 = 20;
const SH: &str = "/bin/sh";
const KILL: &str = "/bin/kill";
/// 祖先 dir に渡す ACL(辿るだけ・一覧も書き込みも渡さない)。
const ACL_SEARCH: &str = "search";

/// **pool の uid として走らせる唯一の口**(`sudo -n -u <user> -- <argv>`)。返すのは (成否, stdout)。
/// `None` = sudo そのものを起こせなかった。**password は聞かない**(`-n`)ので grant が無ければ即失敗に倒れる。
#[cfg(not(test))]
fn run_as(user: &str, argv: &[&str]) -> Option<(bool, String)> {
    let out = std::process::Command::new(SUDO)
        .args(["-n", "-u", user, "--"])
        .args(argv)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    Some((out.status.success(), String::from_utf8_lossy(&out.stdout).to_string()))
}

// test build では sudo を叩かない —— 特権の境界を test から越えない(pane の auto mode もそれを拒む)。
// argv を thread ごとに記録し、台本の答えを返す。形は本番の `run_as` と同じ `sudo -n -u <user> -- …`。
#[cfg(test)]
thread_local! {
    static RUN_AS_LOG: std::cell::RefCell<Vec<Vec<String>>> = const { std::cell::RefCell::new(Vec::new()) };
    static RUN_AS_REPLY: std::cell::RefCell<Option<(bool, String)>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_as(user: &str, argv: &[&str]) -> Option<(bool, String)> {
    let mut full = vec![SUDO.to_string(), "-n".into(), "-u".into(), user.to_string(), "--".into()];
    full.extend(argv.iter().map(|a| a.to_string()));
    RUN_AS_LOG.with(|l| l.borrow_mut().push(full));
    RUN_AS_REPLY.with(|r| r.borrow().clone())
}

#[cfg(test)]
pub(crate) fn take_run_as_log() -> Vec<Vec<String>> {
    RUN_AS_LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

#[cfg(test)]
pub(crate) fn set_run_as_reply(reply: Option<(bool, String)>) {
    RUN_AS_REPLY.with(|r| *r.borrow_mut() = reply);
}

/// pool の uid として走れるか(= sudoers の run-as 行が在り、その account も実在する)。
fn can_run_as(user: &str) -> bool {
    run_as(user, &[TRUE_BIN]).is_some_and(|(ok, _)| ok)
}

/// run-as の 1 行 script が最後に書く `probe:<終了コード>` を読む。**行が無い = 測れていない** ——
/// sudo が断った時の失敗を「繋がらなかった」と読むと、grant が消えた機で host_scoped と名乗る。
fn probe_exit(stdout: &str) -> Option<i32> {
    stdout.lines().rev().find_map(|l| l.trim().strip_prefix("probe:")?.parse().ok())
}

/// pool の uid が非 loopback の listener に繋がるか。ip / port は **位置引数**で渡す(script に埋めない)。
const EGRESS_PROBE_SH: &str = r#"/usr/bin/nc -z -G 1 "$1" "$2" >/dev/null 2>&1; echo "probe:$?""#;
/// pool の uid が HOME と folder に書け、資格情報を読めるか(祖先を辿れる事まで含む = access(2) の実物)。
const REACH_PROBE_SH: &str = r#"[ -w "$1" ] && [ -w "$2" ] && [ -r "$3" ]; echo "probe:$?""#;
/// broker 自身が probe の listener に繋がるかの上限(陽性対照)。同じ機の IP なので即時に返る。
const PROBE_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// 既定 route の送信元 IPv4。UDP の `connect` は packet を 1 つも出さない(経路を引くだけ)。
/// 無い(offline)なら `None`。
fn local_nonloopback_ipv4() -> Option<std::net::Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?; // TEST-NET-1。送らない
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4),
        _ => None,
    }
}

/// **pf が今この pool の uid を塞いでいるか**を root 無しで測る(module review の攻め所 1)。
///
/// install の file(anchor / LaunchDaemon)が在る事は証拠にならないので、pool の uid 自身に
/// **この機の非 loopback の IP で broker が待つ listener** へ繋がせる(規則 `to ! 127.0.0.0/8` の内側)。
/// 先に broker 自身がその listener に繋がる事を確かめる(陽性対照)—— 自分も繋がらないなら
/// 「pool が繋がらない」は何も証明しない。IPv4 だけ測る: anchor file は inet / inet6 の 2 行を
/// 1 回の `pfctl -f` で読むので、v4 の行が効いていれば同じ file の v6 の行も読まれている。
///
/// ponytail: pf の `user` 一致が lo0 経由の自機 IP 宛にも当たる事は owner の verify(T15)が実機で測る。
/// 当たらない機では `Reachable` に倒れる = host_scoped を名乗らない側(嘘にならない側)に外れる。
pub fn probe_pool_egress(user: &str) -> EgressProbe {
    let Some(ip) = local_nonloopback_ipv4() else {
        return EgressProbe::Unmeasured("no non-loopback IPv4 address".into());
    };
    let listener = match std::net::TcpListener::bind((ip, 0)) {
        Ok(l) => l,
        Err(e) => return EgressProbe::Unmeasured(format!("could not listen on {ip}: {e}")),
    };
    let Ok(addr) = listener.local_addr() else {
        return EgressProbe::Unmeasured("the probe listener has no address".into());
    };
    if std::net::TcpStream::connect_timeout(&addr, PROBE_CONNECT_TIMEOUT).is_err() {
        return EgressProbe::Unmeasured(format!("the broker itself cannot reach {addr}"));
    }
    let (ip_s, port_s) = (ip.to_string(), addr.port().to_string());
    probe_verdict(run_as(user, &[SH, "-c", EGRESS_PROBE_SH, "sh", &ip_s, &port_s]))
}

/// run-as の答えを判定に写す(pure)。`probe:0` = 繋がった / 他の終了コード = 塞がれた / 行が無い = 測れていない。
fn probe_verdict(reply: Option<(bool, String)>) -> EgressProbe {
    match reply.as_ref().and_then(|(_, out)| probe_exit(out)) {
        Some(0) => EgressProbe::Reachable,
        Some(_) => EgressProbe::Blocked,
        None => EgressProbe::Unmeasured("the pool uid did not answer the probe".into()),
    }
}

/// pool の uid の process に signal を送る —— **その uid として** `kill -<sig> -1` を打つ。
///
/// broker(login uid)の `killpg` は C1 の session に 1 つも届かない: 起こした group の頭は root で走る
/// `sudo`、その下は pool の uid で、kill(2) は送り手と受け手の uid が合う時しか通らない。だから
/// cancel は「止めた」と言って止まらず、session の孫は次にこの uid を借りた session まで生き残って、
/// その session の資格情報と folder を ACL 越しに読める。uid は同時に 1 session しか借りない
/// (`lease_uid`)ので、届くのはその session の process だけ(+ launchd がこの uid に起こす `distnoted`。
/// KeepAlive で起き直し、害は無い)。
pub fn signal_pool(user: &str, sig: &str) {
    let flag = format!("-{sig}");
    let _ = run_as(user, &[KILL, &flag, "-1"]);
}

/// その dir を pool の uid が辿れるか(mode と group だけで決まる分。pure)。
/// other の x、または group が staff(`POOL_GID`)で group の x。
pub fn pool_can_search(mode: u32, gid: u32) -> bool {
    mode & 0o001 != 0 || (gid == POOL_GID && mode & 0o010 != 0)
}

/// `target` とその祖先のうち **pool の uid が辿れない dir**。
///
/// broker は session dir を `~/.openroly/broker/sessions/<id>` に置き、`~/.openroly` は 700。
/// lane の folder も `~/Downloads`(macOS の既定で 700)の下に在りうる。folder に ACL を足しても
/// 祖先を辿れなければ pool の uid は 1 byte も読み書きできない —— sandbox-exec は session dir の
/// profile を読めず、claude は HOME の資格情報を読めず、session は起きない。
/// 自分の持ち物でない dir が塞いでいたら `Err`(ACL を足せない)。
#[cfg(unix)]
pub fn dirs_blocking_pool(target: &Path) -> Result<Vec<PathBuf>, String> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid は引数も失敗も無い
    let me = unsafe { libc::geteuid() };
    let mut out = Vec::new();
    for dir in target.ancestors().filter(|d| !d.as_os_str().is_empty()) {
        let meta = fs::metadata(dir).map_err(|e| format!("could not stat {}: {e}", dir.display()))?;
        if pool_can_search(meta.mode(), meta.gid()) {
            continue;
        }
        if meta.uid() != me {
            return Err(format!("{} is not searchable by the C1 pool and is not ours to grant", dir.display()));
        }
        out.push(dir.to_path_buf());
    }
    Ok(out)
}

/// 本人 uid の Keychain から claude 購読の資格情報を読む。**値は返り値の中だけ**に在り、log にも
/// error にも出さない(失敗しても中身を貼らない)。
fn read_claude_credentials() -> Result<String, String> {
    let user = std::env::var("USER").map_err(|_| "USER is not set".to_string())?;
    let out = std::process::Command::new(SECURITY)
        .args(["find-generic-password", "-a", &user, "-w", "-s", CLAUDE_KEYCHAIN_SERVICE])
        .output()
        .map_err(|e| format!("could not run security: {e}"))?;
    if !out.status.success() {
        return Err(format!("Keychain item {CLAUDE_KEYCHAIN_SERVICE:?} for {user:?} could not be read"));
    }
    let json = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if json.is_empty() {
        return Err("the Keychain item is empty".to_string());
    }
    Ok(json)
}

/// 走っている C1 の 1 session。**drop で全部戻す** —— 戻し忘れると ACL と資格情報が端末に残り、
/// 借りた uid が pool に返らない。**root op は 1 つも無い**(uid も pf 規則も install 時の持ち物で、
/// session は借りて返すだけ)。
pub struct Session {
    pub user: String,
    pub uid: u32,
    home: PathBuf,
    /// ACL を足した所(teardown で外す)。
    folder: Option<PathBuf>,
    home_acl: bool,
    cred_acl: Option<PathBuf>,
    /// 辿れるように `search` を足した祖先 dir(`dirs_blocking_pool`)。teardown で外す。
    search_acl: Vec<PathBuf>,
    /// drop した時の refreshToken の指紋。teardown で変わっていたら 1 行出す(値は出さない)。
    cred_sig: String,
    /// 借りた uid。drop で pool に返る。
    _lease: Lease,
}

/// test 用の C1 session(root op も Keychain も通らない)。lease は **pool の外の uid** で持つ ——
/// pool を満杯にする c1 の test と同時に走っても、pool の数を 1 つも食わない。
#[cfg(test)]
pub(crate) fn fake_session_for_test(user: &str, home: &Path) -> Session {
    Session {
        user: user.to_string(),
        uid: u32::MAX,
        home: home.to_path_buf(),
        folder: None,
        home_acl: false,
        cred_acl: None,
        search_acl: Vec::new(),
        cred_sig: "none".to_string(),
        _lease: Lease { uid: u32::MAX },
    }
}

impl Session {
    /// 後始末の本体。返すのは **(rotation が起きたか, HOME に残った file 数)**。
    /// **どれかが失敗しても残りを全部試す**(最初の失敗で諦めると ACL が端末に残る)。
    ///
    /// **最初に pool の uid の process を止める** —— reaper が見たのは直の子(sudo)の exit だけで、
    /// session の孫はまだ pool の uid で走りうる。止めずに uid を pool へ返すと、次にこの uid を
    /// 借りた session の資格情報と folder をその孫が読める(`signal_pool`)。
    ///
    /// **rotation は資格情報を消す前に読む** —— 消してから読むと `credential_rotated` は必ず
    /// `"none"` を返し、**毎回「rotated」と嘘をつく**。順序そのものが性質なので、
    /// test が読める形にして返す(log を grep させない)。
    fn teardown_report(&mut self) -> (bool, usize) {
        signal_pool(&self.user, "KILL");
        let rotated = self.credential_rotated();
        // 資格情報は **名指しで消して残数を見る**。消せなかった時は 0 と偽らず、在る物を数える。
        let left = match cleanup_credentials(&self.home) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("broker: c1: could not remove the dropped credential: {e}");
                count_files(&self.home)
            }
        };
        if let Some(cred) = self.cred_acl.take() {
            run_quiet(&acl_revoke_argv(&self.user, &cred, ACL_CRED));
        }
        if let Some(folder) = self.folder.take() {
            run_quiet(&acl_revoke_argv(&self.user, &folder, ACL_DIR));
        }
        if self.home_acl {
            run_quiet(&acl_revoke_argv(&self.user, &self.home, ACL_DIR));
            self.home_acl = false;
        }
        // 祖先の `search` は **この uid の entry だけ**外れる(別の uid の session が同じ祖先に足した
        // entry は残る)。同じ entry を 2 度足しても 1 つに畳まれる事は実測済み(2026-09-13)
        for dir in std::mem::take(&mut self.search_acl) {
            run_quiet(&acl_revoke_argv(&self.user, &dir, ACL_SEARCH));
        }
        (rotated, left)
    }

    fn teardown(&mut self) {
        let (rotated, left) = self.teardown_report();
        // ③ の docs 結論: copy 側で refresh が走ると本人の token と分岐しうる。**本人の Keychain へは
        // 書き戻さない**(書き込みは本人のログインを壊す方向で、まだ測れていない)—— 起きた事だけ言う。
        if rotated {
            eprintln!(
                "broker: c1: the dropped claude credential rotated during session {} — \
                 the login Keychain was not written back (PBI-0441 ③)",
                self.user
            );
        }
        if left > 0 {
            eprintln!("broker: c1: {left} file(s) left under the session HOME after cleanup");
        }
        eprintln!("broker: c1: session {} torn down (uid {} returned to the pool)", self.user, self.uid);
    }

    /// drop 時と今で refreshToken が入れ替わったか。本人の Keychain へは **書き戻さない**。
    pub fn credential_rotated(&self) -> bool {
        let now = fs::read_to_string(self.home.join(CLAUDE_CRED_REL))
            .map(|j| refresh_token_sig(&j))
            .unwrap_or_else(|_| "none".to_string());
        now != self.cred_sig
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.teardown();
    }
}

/// C1 をこの session に掛ける(live seam)。**掛からない時は `Ok(None)`** = 床のまま起こす。
///
/// 掛ける条件は `effective_enforcement` と同じ 3 つ(C1 が使える・`C1_RUNTIMES` の runtime・
/// 床が `port_scoped`)。**掛ける条件を満たしたのに失敗したら `Err`** —— そこで床のまま起こすと、
/// hello が既に名乗った `host_scoped` と実物が食い違う(AC-3 が殺そうとしている嘘)。
/// 呼び手はこの Err を `sandbox_unavailable` にして **session を起こさない**(fail-closed)。
///
/// **root op は 1 つも打たない** —— uid の pool も pf 規則も install 時の持ち物で、ここは
/// ① pool から uid を借り ② 前の持ち主の process を止め ③ pf が今も塞いでいるかを測り直し
/// ④ 資格情報を自分の持ち物として置き ⑤ ACL を足し ⑥ その uid で本当に届くかを測るだけ。
pub fn setup_session(
    runtime: &str,
    base: &'static str,
    c1: &C1Status,
    session_dir: &Path,
    folder: &Path,
) -> Result<Option<Session>, String> {
    if effective_enforcement(runtime, base, c1) == base {
        return Ok(None);
    }
    let lease = lease_uid().ok_or_else(|| format!("every C1 uid in {UID_MIN}..={UID_MAX} is in use"))?;
    let uid = lease.uid();
    let user = user_for_uid(uid).ok_or_else(|| format!("uid {uid} makes an unsafe user name"))?;
    // **資格情報を読む前に** pool の account に届くかを確かめる(届かない機で Keychain を開かない)
    if !can_run_as(&user) {
        return Err(format!("cannot run as {user} (is scripts/openroly-c1-setup.sh installed?)"));
    }
    // lease は process 内の記録でしかない。crash した前の broker の session の孫が同じ uid で
    // 生きていれば、これから置く資格情報と folder を読める —— 資格情報が現れる **前に** 止める
    signal_pool(&user, "KILL");
    // hello は起動時の `detect` で host_scoped と名乗った。起動後に `pfctl -d` された機で名乗りだけ
    // 残して穴の開いた session を起こさないよう、**この uid で今** 塞がっているかを測り直す
    match probe_pool_egress(&user) {
        EgressProbe::Blocked => {}
        other => return Err(format!("the pf anchor is not blocking {user} right now ({other:?})")),
    }
    // 辿れない祖先(`~/.openroly` / `~/Downloads` は 700)。自分の持ち物でなければ ACL を足せないので、
    // Keychain を開く前に決める
    let mut blocking = dirs_blocking_pool(session_dir)?;
    for dir in dirs_blocking_pool(folder)? {
        if !blocking.contains(&dir) {
            blocking.push(dir);
        }
    }
    let home = session_dir.join("c1-home");
    fs::create_dir_all(&home).map_err(|e| format!("could not create the session HOME: {e}"))?;

    // ここから先は戻す物が在るので、Session を先に組んで drop に後始末を任せる
    let cred = read_claude_credentials()?;
    let mut session = Session {
        user: user.clone(),
        uid,
        home: home.clone(),
        folder: None,
        home_acl: false,
        cred_acl: None,
        search_acl: Vec::new(),
        cred_sig: refresh_token_sig(&cred),
        _lease: lease,
    };
    for dir in blocking {
        run_checked(&acl_grant_argv(&user, &dir, ACL_SEARCH), "granting search on an ancestor dir")?;
        session.search_acl.push(dir);
    }
    // HOME: claude は `~/.claude` の下に自分の state を書くので、専用 uid に書かせる
    run_checked(&acl_grant_argv(&user, &home, ACL_DIR), "granting the session HOME ACL")?;
    session.home_acl = true;
    // 資格情報: broker が 0600 で置き(持ち主は broker のまま)、専用 uid には read,write だけ渡す
    let cred_path = drop_claude_credentials(&home, &cred).map_err(|e| format!("credential drop: {e}"))?;
    run_checked(&acl_grant_argv(&user, &cred_path, ACL_CRED), "granting the credential ACL")?;
    session.cred_acl = Some(cred_path);
    // lane の folder: 所有権は変えず ACL 1 本で通す
    run_checked(&acl_grant_argv(&user, folder, ACL_DIR), "granting the folder ACL")?;
    session.folder = Some(folder.to_path_buf());
    // ACL の足し算が正しくても、届くかは access(2) の実物でしか分からない(TCC・既存の deny ACE・
    // 読み違えた祖先)。**その uid で** HOME と folder に書け、資格情報を読めるかを測る
    let (home_s, folder_s) = (home.to_string_lossy().to_string(), folder.to_string_lossy().to_string());
    let cred_s = session.cred_acl.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let reach = run_as(&user, &[SH, "-c", REACH_PROBE_SH, "sh", &home_s, &folder_s, &cred_s]);
    if reach.as_ref().and_then(|(_, out)| probe_exit(out)) != Some(0) {
        return Err(format!("{user} cannot reach its HOME, the folder or the credential even with the ACL grants"));
    }
    eprintln!("broker: c1: session {user} (uid {uid}) is host-scoped by {ANCHOR}");
    Ok(Some(session))
}

/// 実機の観測から C1 の在り無しを決める(live seam)。broker 起動時に一度呼ぶ。
///
/// **root は 1 度も通らない** —— 実行時に要る grant は「pool の uid として走る」1 つだけなので、
/// それを `sudo -n` で直に試す。pf の規則は **読まない**(`pfctl` は root でしか読めず、
/// 読める grant を残す事自体が前の破れだった)—— install の file を stat し、効いているかは
/// pool の uid に非 loopback へ繋がせて測る(`probe_pool_egress`)。
/// setup していない機(既定の全端末・この pane)では `available: false` = 床のまま(正直な床)。
///
/// ponytail: 起動時に 1 回だけ測る。offline で起動した broker は再起動まで claude も port_scoped
/// (嘘にならない側)。起動後に pf が外れた機は `setup_session` が session ごとに測り直して断る。
pub fn detect() -> C1Status {
    let Some(user) = user_for_uid(UID_MIN) else {
        return decide(false, false, &EgressProbe::Unmeasured("no pool user name".into()));
    };
    let run_as_ok = can_run_as(&user);
    let pf_installed = Path::new(ANCHOR_FILE).exists() && Path::new(LAUNCHD_PLIST).exists();
    // probe の 1 秒を払うのは install が揃った機だけ
    let probe = if run_as_ok && pf_installed {
        probe_pool_egress(&user)
    } else {
        EgressProbe::Unmeasured("C1 is not installed".into())
    };
    decide(run_as_ok, pf_installed, &probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pool を触る test 同士を直列にする。`LEASED` は process 全体で 1 つなので、pool を満杯にする
    /// test と lease を 1 本要る test が **並列に走ると偽の赤**が出る(満杯側が先に全部借りると
    /// もう片方の `lease_uid()` が None になる)。混雑由来の赤を実装のバグと読まない為の門。
    static POOL_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// poison(他の test が panic した後)でも進む —— 守りたいのは順番だけで、中身は空。
    fn pool_guard() -> std::sync::MutexGuard<'static, ()> {
        POOL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    // decide: pool・pf の file・probe の Blocked が全部揃った時だけ available(嘘を言わない)。
    #[test]
    fn decide_available_only_when_pool_pf_and_probe_all_hold() {
        let blocked = EgressProbe::Blocked;
        assert!(decide(true, true, &blocked).available);
        assert!(!decide(false, true, &blocked).available);
        assert!(!decide(true, false, &blocked).available);
        assert!(!decide(false, false, &blocked).available);
        // **file が揃っていても、pool の uid が外に届くなら名乗らない**(module review の fail-open)
        assert!(!decide(true, true, &EgressProbe::Reachable).available);
        assert!(!decide(true, true, &EgressProbe::Unmeasured("x".into())).available);
        // 理由が付く(doctor に出す)
        assert!(decide(false, true, &blocked).reason.contains("pool"));
        assert!(decide(true, false, &blocked).reason.contains("pf"));
        assert!(decide(true, true, &EgressProbe::Reachable).reason.contains("not blocking"));
    }

    // probe の答え: probe:0 = 繋がった / 他の終了コード = 塞がれた / 行が無い = 測れていない。
    // **行が無い(sudo が断った)のを「塞がれた」と読むと、grant の消えた機で host_scoped と名乗る**
    #[test]
    fn probe_verdict_never_reads_silence_as_blocked() {
        assert_eq!(probe_verdict(Some((true, "probe:0\n".into()))), EgressProbe::Reachable);
        assert_eq!(probe_verdict(Some((true, "probe:1\n".into()))), EgressProbe::Blocked);
        assert_eq!(probe_verdict(Some((true, "noise\nprobe:124\n".into()))), EgressProbe::Blocked);
        for silent in [None, Some((false, String::new())), Some((false, "sudo: a password is required\n".into()))] {
            assert!(
                matches!(probe_verdict(silent.clone()), EgressProbe::Unmeasured(_)),
                "{silent:?} を測れた事にした"
            );
        }
    }

    // probe は **pool の uid として**、非 loopback の IP と port を **位置引数**で渡して走る。
    #[test]
    fn probe_pool_egress_asks_the_pool_uid_with_positional_args() {
        if local_nonloopback_ipv4().is_none() {
            eprintln!("skip: no non-loopback IPv4 on this machine");
            return;
        }
        let _ = take_run_as_log();
        set_run_as_reply(Some((true, "probe:1\n".into())));
        assert_eq!(probe_pool_egress("_openroly_s550"), EgressProbe::Blocked);
        set_run_as_reply(Some((true, "probe:0\n".into())));
        assert_eq!(probe_pool_egress("_openroly_s550"), EgressProbe::Reachable);
        set_run_as_reply(None);
        assert!(matches!(probe_pool_egress("_openroly_s550"), EgressProbe::Unmeasured(_)));
        let log = take_run_as_log();
        assert_eq!(log.len(), 3, "{log:?}");
        let a = &log[0];
        assert_eq!(&a[..8], &["/usr/bin/sudo", "-n", "-u", "_openroly_s550", "--", "/bin/sh", "-c", EGRESS_PROBE_SH]);
        assert_eq!(a[8], "sh");
        let ip: std::net::Ipv4Addr = a[9].parse().expect("ip は位置引数");
        assert!(!ip.is_loopback(), "loopback は規則 `to ! 127.0.0.0/8` の外 = 何も証明しない");
        assert!(a[10].parse::<u16>().is_ok(), "port は位置引数");
        assert!(!a[7].contains(&a[9]), "ip を script に埋め込んだ");
    }

    // probe の script そのもの(nc の flag・位置引数・`probe:$?`)が、この機で開いた口と閉じた口を
    // 分けられる事。sudo を挟まず **自分として** 走らせる(pool の uid での実測は owner の verify T15)。
    #[cfg(target_os = "macos")]
    #[test]
    fn egress_probe_script_tells_open_from_closed_on_this_mac() {
        let Some(ip) = local_nonloopback_ipv4() else { return };
        let listener = std::net::TcpListener::bind((ip, 0)).unwrap();
        let open = listener.local_addr().unwrap().port();
        let closed = std::net::TcpListener::bind((ip, 0)).unwrap().local_addr().unwrap().port(); // drop 済み
        let run = |port: u16| {
            let out = std::process::Command::new(SH)
                .args(["-c", EGRESS_PROBE_SH, "sh", &ip.to_string(), &port.to_string()])
                .output()
                .unwrap();
            probe_verdict(Some((out.status.success(), String::from_utf8_lossy(&out.stdout).to_string())))
        };
        assert_eq!(run(open), EgressProbe::Reachable, "開いた口を繋がらないと読んだ");
        assert_eq!(run(closed), EgressProbe::Blocked, "閉じた口を繋がったと読んだ");
    }

    // 祖先: pool の uid が辿れない dir(700)だけを挙げる。staff の group x は辿れる側。
    #[cfg(unix)]
    #[test]
    fn ancestors_the_pool_cannot_search_are_listed() {
        use std::os::unix::fs::PermissionsExt;
        assert!(pool_can_search(0o755, 0));
        assert!(pool_can_search(0o750, POOL_GID), "staff の group x は辿れる");
        assert!(!pool_can_search(0o750, 0));
        assert!(!pool_can_search(0o700, POOL_GID));

        let root = std::env::temp_dir().join(format!("openroly-c1-anc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let private = root.join("private");
        let leaf = private.join("open").join("leaf");
        fs::create_dir_all(&leaf).unwrap();
        for d in [&root, &private.join("open"), &leaf] {
            fs::set_permissions(d, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        // temp の上(macOS の `$TMPDIR` は 700)は見ない —— この test が作った範囲だけを比べる
        let ours = |got: Vec<PathBuf>| got.into_iter().filter(|d| d.starts_with(&root)).collect::<Vec<_>>();
        assert_eq!(ours(dirs_blocking_pool(&leaf).unwrap()), vec![private.clone()]);
        // 負の対照: 700 を開けると挙がらない
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ours(dirs_blocking_pool(&leaf).unwrap()).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    // setup_session: pf が **今** 塞いでいなければ、HOME も資格情報も触る前に断る。
    // 順序: run-as の確認 → 前の持ち主の process を KILL → probe。
    #[test]
    fn setup_session_refuses_an_open_hole_before_touching_credentials() {
        let _serial = pool_guard();
        let _ = take_run_as_log();
        let up = C1Status { available: true, reason: String::new() };
        set_run_as_reply(Some((true, "probe:0\n".into())));
        let dir = std::env::temp_dir().join(format!("openroly-c1-setup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let err = setup_session("claude", "port_scoped", &up, &dir, &dir).err().expect("穴が開いているのに起こした");
        assert!(err.contains("not blocking"), "{err}");
        assert!(!dir.join("c1-home").exists(), "HOME を作ってから断った");
        let log = take_run_as_log();
        assert!(log.len() >= 2, "{log:?}");
        assert_eq!(&log[0][5..], &["/usr/bin/true"]);
        assert_eq!(&log[1][5..], &["/bin/kill", "-KILL", "-1"], "前の持ち主の process を止めずに進んだ");
        set_run_as_reply(None);
    }

    // effective_enforcement: claude + available + port_scoped の時だけ host_scoped。負の対照を各軸で。
    #[test]
    fn effective_enforcement_raises_only_claude_under_c1() {
        let up = C1Status { available: true, reason: String::new() };
        let down = C1Status::unavailable("x");
        // 上がる 1 通り
        assert_eq!(effective_enforcement("claude", "port_scoped", &up), "host_scoped");
        // 負の対照: 各軸を 1 つ崩すと port_scoped に戻る
        assert_eq!(effective_enforcement("claude", "port_scoped", &down), "port_scoped", "C1 無しは上げない");
        assert_eq!(effective_enforcement("codex", "port_scoped", &up), "port_scoped", "codex は上げない");
        assert_eq!(effective_enforcement("gemini", "port_scoped", &up), "port_scoped", "gemini は上げない");
        // none(NoSandbox)は claude でも none のまま(dedicated を起こさない)
        assert_eq!(effective_enforcement("claude", "none", &up), "none");
    }

    // session_user: 弱い側から来た値が sudo の option に化けない(security 境界)。
    #[test]
    fn names_reject_unsafe_tokens() {
        assert_eq!(session_user("req42").as_deref(), Some("_openroly_sreq42"));
        // 危険な形は全部 None(1 つでも通ると sudo に注入できる)
        for bad in ["-rf", "a b", "a/b", "a.b", "a;b", "../x", "a-b", "a_b", "", &"x".repeat(33)] {
            assert_eq!(session_user(bad), None, "session_user({bad:?}) を通した");
        }
    }

    // pf 規則の形(範囲が pool ちょうどか・inet6 の行が在るか)は、**正本である install script の
    // 生成物**を `scripts/openroly-c1-setup.test.ts` が読んで測る。broker は pf を触らないので、
    // ここに写しを置いて 2 箇所で検査しない。

    // lease: 同じ uid を 2 つ同時に貸さない・drop で pool に返る・全部埋まれば None。
    #[test]
    fn lease_never_hands_the_same_uid_to_two_sessions() {
        let _serial = pool_guard();
        let a = lease_uid().expect("1 本目");
        let b = lease_uid().expect("2 本目");
        assert_ne!(a.uid(), b.uid(), "同じ uid を 2 session に貸した");
        let first = a.uid();
        drop(a);
        let c = lease_uid().expect("返った分を借り直す");
        assert_eq!(c.uid(), first, "drop した uid が pool に返っていない");
        // 全部埋めると None(呼び手は session を起こさない)
        let mut all: Vec<Lease> = Vec::new();
        while let Some(l) = lease_uid() {
            all.push(l);
            assert!(all.len() <= (UID_MAX - UID_MIN + 1) as usize, "pool の外まで貸した");
        }
        assert_eq!(all.len() + 2, (UID_MAX - UID_MIN + 1) as usize, "貸した総数が pool と合わない");
        assert!(lease_uid().is_none(), "満杯なのに貸した");
    }

    // uid から作る名前(request_id からは作らない)。
    #[test]
    fn user_names_come_from_the_pool_uid() {
        assert_eq!(user_for_uid(556).as_deref(), Some("_openroly_s556"));
        assert_eq!(user_for_uid(UID_MIN).as_deref(), Some("_openroly_s550"));
        // **request_id をそのまま token にしない**事の確認: 実際の request_id は `_` を含み通らない
        assert_eq!(session_user("wr_live0001"), None, "request_id が名前に化けた");
    }

    // 資格情報の file-drop: 0600 で置き、内容は渡した通り。持ち主は broker のまま(chown しない)。
    #[cfg(unix)]
    #[test]
    fn drop_credentials_writes_0600_with_the_given_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("openroly-c1-drop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        // 偽の資格情報(実 Keychain には触れない)
        let fake = r#"{"claudeAiOauth":{"refreshToken":"FAKE-TOKEN-abc","accessToken":"FAKE","expiresAt":0,"scopes":[]}}"#;
        let path = drop_claude_credentials(&home, fake).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), fake);
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "0600 で置いていない: {mode:o}");
        let _ = fs::remove_dir_all(&home);
    }

    // 後始末: 資格情報を名指しで消して残数 0。負の対照: 消さずに数えると > 0。
    #[test]
    fn cleanup_removes_the_credential_and_reports_zero() {
        let home = std::env::temp_dir().join(format!("openroly-c1-clean-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let fake = r#"{"claudeAiOauth":{"refreshToken":"FAKE"}}"#;
        drop_claude_credentials(&home, fake).unwrap();
        assert_eq!(count_files(&home), 1, "drop 後は 1 file(負の対照: 消す前は残っている)");
        assert_eq!(cleanup_credentials(&home).unwrap(), 0, "後始末後は 0 file");
        assert!(!home.join(CLAUDE_CRED_REL).exists());
        // 無い所を消しても error にしない(冪等)
        assert_eq!(cleanup_credentials(&home).unwrap(), 0);
        let _ = fs::remove_dir_all(&home);
    }

    // raised_by_runtime: 上げた runtime だけが載る。**上げる物が無ければ空**(wire が旧 broker と同じ)。
    #[test]
    fn raised_by_runtime_lists_only_what_went_above_the_floor() {
        let up = C1Status { available: true, reason: String::new() };
        let down = C1Status::unavailable("x");
        assert_eq!(raised_by_runtime("port_scoped", &up), vec![("claude", "host_scoped")]);
        // 負の対照: C1 無し / 床が none(NoSandbox)なら 1 件も載らない
        assert!(raised_by_runtime("port_scoped", &down).is_empty(), "C1 無しで表が出た");
        assert!(raised_by_runtime("none", &up).is_empty(), "NoSandbox で表が出た");
        // 載るのは C1_RUNTIMES の物だけ(codex / gemini は入らない)
        for (kind, _) in raised_by_runtime("port_scoped", &up) {
            assert!(C1_RUNTIMES.contains(&kind), "{kind} は C1_RUNTIMES に無い");
        }
    }

    // **実行時に打つ argv に root の command が 1 つも無い**(この PBI の破れそのもの)。
    // ACL は chmod(root 不要)・spawn は run-as だけ。dscl / pfctl / chown はどこにも出てこない。
    #[test]
    fn runtime_argv_never_asks_for_root() {
        let dir = acl_grant_argv("_openroly_s556", Path::new("/proj"), ACL_DIR);
        let cred = acl_grant_argv("_openroly_s556", Path::new("/h/.claude/.credentials.json"), ACL_CRED);
        let (spawn_program, spawn_args) =
            spawn_as_user_argv("_openroly_s556", "/usr/bin/sandbox-exec", &["-f".into(), "/p/x.sb".into()]);
        let mut every: Vec<String> = Vec::new();
        every.extend(dir.clone());
        every.extend(cred.clone());
        every.extend(acl_revoke_argv("_openroly_s556", Path::new("/proj"), ACL_DIR));
        every.push(spawn_program.clone());
        every.extend(spawn_args.clone());
        for forbidden in ["dscl", "pfctl", "chown", "/usr/sbin/", "/sbin/"] {
            assert!(
                !every.iter().any(|a| a.contains(forbidden)),
                "実行時の argv に {forbidden} が居る(root の操作は install 時だけのはず): {every:?}"
            );
        }
        // ACL は chmod で、root を通さない
        assert_eq!(dir[0], CHMOD, "ACL が chmod でない");
        assert_ne!(dir[0], SUDO, "ACL に root を使っている");
        assert_eq!(dir[1], "+a");
        assert_eq!(acl_revoke_argv("_openroly_s556", Path::new("/proj"), ACL_DIR)[1], "-a", "外す側が +a のまま");
        // 資格情報の ACL は read,write だけ(dir の権限一式を渡さない)
        assert!(cred[2].ends_with("allow read,write"), "cred の ACL が広い: {:?}", cred[2]);
        assert!(!cred[2].contains("delete_child"), "cred に dir の権限を渡している: {:?}", cred[2]);
        // sudo が使うのは run-as だけ
        assert_eq!(spawn_program, SUDO);
        assert_eq!(&spawn_args[1..3], &["-u".to_string(), "_openroly_s556".to_string()]);
    }

    // 専用 uid で起こす形: sudo が一番外側・`--` の後ろは option に化けない・env は名指しで通る。
    #[test]
    fn spawn_as_user_puts_sudo_outside_and_stops_option_injection() {
        let (program, args) =
            spawn_as_user_argv("_openroly_s556", "/usr/bin/sandbox-exec", &["-f".into(), "/p/x.sb".into()]);
        assert_eq!(program, "/usr/bin/sudo", "sudo が一番外側でない");
        assert_eq!(args[0], "-n");
        assert_eq!(&args[1..3], &["-u".to_string(), "_openroly_s556".to_string()]);
        // env を名指しで通す(sudo は既定で落とす)。proxy の 4 変数が落ちると閉じ込めが「繋がらない」に化ける
        let preserve = args.iter().find(|a| a.starts_with("--preserve-env=")).expect("--preserve-env が無い");
        for key in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "HOME"] {
            assert!(preserve.contains(key), "{key} を通していない: {preserve}");
        }
        // `--` の後ろが program。`-` で始まる program / args でも sudo の flag に化けない
        let sep = args.iter().position(|a| a == "--").expect("-- が無い");
        assert_eq!(args[sep + 1], "/usr/bin/sandbox-exec");
        let (_, evil) = spawn_as_user_argv("_openroly_s556", "-u", &["--login".into()]);
        let esep = evil.iter().position(|a| a == "--").expect("-- が無い");
        assert_eq!(&evil[esep + 1..], &["-u".to_string(), "--login".to_string()], "option 化を止めていない");
    }

    // refresh_token_sig: 値を出さずに rotation を検出。同じ token は同じ sig・違う token は違う sig・
    // field 欠落と空は "none"。
    #[test]
    fn refresh_token_sig_detects_rotation_without_revealing() {
        let cred = |t: &str| format!(r#"{{"claudeAiOauth":{{"refreshToken":"{t}"}}}}"#);
        let a = refresh_token_sig(&cred("TOK-1"));
        let a2 = refresh_token_sig(&cred("TOK-1"));
        let b = refresh_token_sig(&cred("TOK-2"));
        assert_eq!(a, a2, "同じ token は同じ sig");
        assert_ne!(a, b, "違う token は違う sig(rotation を検出できる)");
        assert_ne!(a, "none");
        // sig は token を含まない(値の非露出)
        assert!(!a.contains("TOK-1"));
        // 欠落・空・壊れた JSON は none
        assert_eq!(refresh_token_sig(r#"{"claudeAiOauth":{}}"#), "none");
        assert_eq!(refresh_token_sig(r#"{"claudeAiOauth":{"refreshToken":""}}"#), "none");
        assert_eq!(refresh_token_sig("not json"), "none");
    }

    // teardown の順: **資格情報を消す前に** rotation を見る。逆にすると `credential_rotated` は
    // 消えた file を読んで必ず `"none"` を返すので、**何も変わっていない session でも毎回
    // 「rotated」と報告する**(log に嘘が残り、誰も気づけない)。log を grep せず、teardown 本体の
    // 返り値で測る。**変わった側 ② も置く** —— ① だけだと「常に false」でも緑になる。
    #[test]
    fn teardown_reads_rotation_before_it_removes_the_credential() {
        let _serial = pool_guard();
        let new_home = |tag: &str| {
            let home = std::env::temp_dir().join(format!("openroly-c1-rot-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&home);
            fs::create_dir_all(&home).unwrap();
            home
        };
        let session = |home: &Path, sig: String| Session {
            user: "_openroly_s550".to_string(),
            uid: 550,
            home: home.to_path_buf(),
            folder: None,
            home_acl: false,
            cred_acl: None,
            search_acl: Vec::new(),
            cred_sig: sig,
            _lease: lease_uid().expect("lease"),
        };
        let tok1 = r#"{"claudeAiOauth":{"refreshToken":"TOK-1"}}"#;

        // ① 何も変わっていない session: rotation 無しと報告し、file も残さない
        let quiet = new_home("quiet");
        drop_claude_credentials(&quiet, tok1).unwrap();
        let mut s = session(&quiet, refresh_token_sig(tok1));
        let _ = take_run_as_log();
        let (rotated, left) = s.teardown_report();
        // **最初に** pool の uid の process を止める(孫を生かしたまま uid を pool へ返さない)
        let log = take_run_as_log();
        assert_eq!(
            log.first().map(|a| &a[3..]),
            Some(&["_openroly_s550", "--", "/bin/kill", "-KILL", "-1"].map(String::from)[..]),
            "teardown が pool の uid の process を止めていない: {log:?}"
        );
        assert!(!rotated, "変わっていないのに rotated と報告した(消してから読んでいる)");
        assert_eq!(left, 0, "資格情報が残った");
        s.cred_sig = "none".to_string(); // drop が走る時に嘘の警告を出さない為
        drop(s);

        // ② session の途中で入れ替わった: ちゃんと検出する
        let turned = new_home("turned");
        drop_claude_credentials(&turned, tok1).unwrap();
        let mut s2 = session(&turned, refresh_token_sig(tok1));
        drop_claude_credentials(&turned, r#"{"claudeAiOauth":{"refreshToken":"TOK-2"}}"#).unwrap();
        let (rotated2, left2) = s2.teardown_report();
        assert!(rotated2, "入れ替わったのに検出しない");
        assert_eq!(left2, 0, "資格情報が残った");
        s2.cred_sig = "none".to_string();
        drop(s2);

        let _ = fs::remove_dir_all(&quiet);
        let _ = fs::remove_dir_all(&turned);
    }
}
