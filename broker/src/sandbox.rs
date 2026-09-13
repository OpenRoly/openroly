//! 閉じ込めの土台 = broker が掛ける OS sandbox(PBI-0238 / 図72)。
//!
//! 図57 の runtime 別 flag は「runtime が自分で守る」約束で、runtime を 1 つ足すたびに実測が要り、
//! codex のように「読める shell」が残る。この module は **runtime が何であれ同じ壁**を外から掛ける:
//! folder の中だけ write・外は deny(symlink 経由も実 path で deny)・`~/.ssh` 等は read deny・
//! network は loopback の proxy 1 port だけ。子 process(nested sh)にも継承される(実測 2026-09-04)。
//!
//! backend は macOS の seatbelt(`/usr/bin/sandbox-exec -f <profile>`)と、Linux の Landlock + seccomp
//! (`mod linux`・PBI-0331)。Windows / seatbelt 不在 / Landlock ABI 4 未満は `NoSandbox` で、`wrap` が
//! `sandbox_unavailable` を返す = dedicated wake は **起こさない**(fail-closed。丸腰で起こす選択はしない)。
//!
//! `self_test` は broker の起動時に 1 回、`/bin/sh` を実際に wrap して 4 probe を当てる
//! (folder 内 write ok / 外 write deny / 許可していない loopback port へ TCP deny / 許可した port ok)。
//! 1 つでも落ちれば main.rs が backend を `NoSandbox` に差し替え、全 dedicated wake が
//! `sandbox_unavailable` になり doctor に 1 行出る。probe の TCP 先を 1.1.1.1 ではなく broker が
//! 自分で開いた loopback listener にするのは、offline の機で「繋がらなかった = deny」と読み違えないため
//! (deny と unreachable を区別できる形にする)。

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use tokio::process::Command;

/// 1 session 分の閉じ込めの形。`folder` は agent が働く場所(cwd・唯一の書ける所)、
/// `session_dir` は broker の記録置き場(stdout.log / profile / scratch)。
#[derive(Debug, Clone)]
pub struct SandboxSpec {
    pub folder: PathBuf,
    pub session_dir: PathBuf,
    /// runtime の config / cache(`~/.claude` 等)。catalog の `native.writable_dirs` が来たら置換(PBI-0240)
    pub writable_extra: Vec<PathBuf>,
    /// read も禁じる path(`~/.ssh` 等)。`default_deny_read` が既定
    pub deny_read: Vec<PathBuf>,
    /// この session の egress proxy(127.0.0.1)。profile が唯一許す network の行き先
    pub proxy_port: u16,
}

pub trait SandboxBackend: Send + Sync {
    /// `cmd` を sandbox の中で起こす形に包む。stdio は包んだ後に呼び手が付ける(複製できない)。
    /// 失敗は bare token `sandbox_unavailable`(詳細は stderr)。
    fn wrap(&self, cmd: Command, spec: &SandboxSpec) -> Result<Command, String>;
    /// 起動時の 4 probe。Err の中身は doctor に出す短い理由(`unavailable(<理由>)`)。
    fn self_test(&self) -> Result<(), String>;
    /// doctor / stderr 用の 1 語(`seatbelt` / `none`)
    fn name(&self) -> &'static str;
    /// egress をどこまで絞れているか(PBI-0441)。hello と status file に載り、doctor / Your AI /
    /// session 開始の activity が名乗る。**値は backend の実装が決め、設定で上書きできない**。
    /// `port_scoped` = proxy の port 番号でしか絞れず、同じ番号で listen する外部 host へは直接届く /
    /// `host_scoped` = loopback の proxy 以外へ出られない / `none` = 閉じ込め無し(dedicated は起こさない)
    fn egress_enforcement(&self) -> &'static str;
}

/// macOS seatbelt。profile は session_dir に書き、`sandbox-exec -f` で読ませる。
pub struct Seatbelt;

/// backend が無い OS / seatbelt が壊れている機。`reason` は doctor に出す。
pub struct NoSandbox {
    pub reason: String,
}

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// この機で使う backend。macOS で `sandbox-exec` が在れば Seatbelt、Linux(x86_64 / aarch64)は Landlock、
/// それ以外は NoSandbox。Landlock が使えない kernel は起動時の `self_test` が落ちて NoSandbox に差し替わる。
pub fn backend() -> Box<dyn SandboxBackend> {
    if cfg!(target_os = "macos") && Path::new(SANDBOX_EXEC).exists() {
        Box::new(Seatbelt)
    } else if cfg!(target_os = "macos") {
        Box::new(NoSandbox { reason: "sandbox-exec not found".to_string() })
    } else {
        other_os_backend()
    }
}

#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
fn other_os_backend() -> Box<dyn SandboxBackend> {
    Box::new(linux::Landlock)
}

#[cfg(not(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
fn other_os_backend() -> Box<dyn SandboxBackend> {
    Box::new(NoSandbox {
        reason: format!("no sandbox backend for {} {}", std::env::consts::OS, std::env::consts::ARCH),
    })
}

/// read を禁じる既定(PBI-0238)。`~/.openroly/credentials.json` は入れない —— 今の MCP は credential
/// file から token を読むので、読めないと session が Cloud に繋げない(未決 1: broker 経由の
/// token 受け渡しは別 PBI)。
pub fn default_deny_read(home: &Path) -> Vec<PathBuf> {
    // `.atn/secrets.json` は改名前の置き場(PBI-0344 AC-3)。こちらを置いたままの端末でも同じ門
    [".ssh", ".aws", ".gnupg", ".openroly/secrets.json", ".atn/secrets.json", "Library/Keychains"]
        .iter()
        .map(|p| home.join(p))
        .collect()
}

/// write を許す既定(runtime の config / cache)。catalog の `native.writable_dirs` で置換(PBI-0240)。
pub fn default_writable_extra(home: &Path) -> Vec<PathBuf> {
    [
        ".claude",
        ".claude.json",
        ".codex",
        ".gemini",
        ".config",
        ".cache",
        ".local",
        "Library/Caches",
        "Library/Application Support",
        "Library/Logs",
    ]
    .iter()
    .map(|p| home.join(p))
    .collect()
}

/// profile に埋める path。seatbelt は **実 path** で判定する(`/tmp` → `/private/tmp`)ので
/// canonicalize する。無い path はそのまま(規則が当たらないだけで害は無い)。
/// `"` `\` 改行を含む path は profile の文法を壊す(= 別の規則を注入できる)ので拒む。
fn profile_path(p: &Path) -> Result<String, String> {
    let real = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = real.to_string_lossy().to_string();
    if s.is_empty()
        || !s.starts_with('/')
        || s.chars().any(|c| c == '"' || c == '\\' || c.is_control())
    {
        return Err(format!("path is not safe for a sandbox profile: {p:?}"));
    }
    Ok(s)
}

/// seatbelt profile(実測 2026-09-04 の `rt.sb` を template 化)。
///
/// `(deny default)` から始めて必要な物だけ開ける。file-read は全部許して deny_read を後から
/// 上書きする(後の規則が勝つ)。file-write は folder / session_dir / TMPDIR の親
/// (`/private/var/folders`。git / node / bun が要る)/ `/dev/null` / `/dev/tty*` / writable_extra だけ。
/// network は全部 deny してから proxy の 1 port だけ開ける。
pub fn profile(spec: &SandboxSpec) -> Result<String, String> {
    let mut out = String::new();
    out.push_str("(version 1)\n(deny default)\n");
    out.push_str("(allow process*)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow ipc-posix*)\n");
    out.push_str("(allow signal (target self))\n(allow file-ioctl)\n");
    out.push_str("(allow file-read*)\n");
    if !spec.deny_read.is_empty() {
        out.push_str("(deny file-read*");
        for p in &spec.deny_read {
            out.push_str(&format!(" (subpath \"{}\")", profile_path(p)?));
        }
        out.push_str(")\n");
    }
    out.push_str("(allow file-write*");
    out.push_str(&format!(" (subpath \"{}\")", profile_path(&spec.folder)?));
    out.push_str(&format!(" (subpath \"{}\")", profile_path(&spec.session_dir)?));
    out.push_str(" (subpath \"/private/var/folders\") (literal \"/dev/null\") (regex #\"^/dev/tty\")");
    for p in &spec.writable_extra {
        out.push_str(&format!(" (subpath \"{}\")", profile_path(p)?));
    }
    out.push_str(")\n");
    out.push_str("(deny network*)\n");
    // **host は `*`、protocol は `tcp`、port だけ pin**(PBI-0385)。`localhost:<port>` は profile の
    // parse こそ通るが **1 接続も通さない** —— 2026-09-07 に macOS 14.5 で実測: 接続先を 127.0.0.1 に
    // しても hostname `localhost` にしても deny、`network-bind` を足しても deny、`ip4` / `tcp` /
    // `tcp4` に変えても deny。`127.0.0.1:<port>` と書くと sandbox-exec が profile を拒否する
    // (host must be * or localhost)。通るのは host が `*` の時だけで、**別 port は deny のまま**。
    //
    // `remote ip` ではなく **`remote tcp`** なのは、`ip` が **UDP も一緒に開ける**から(有界レビュー
    // 実測 2026-09-07: `ip *:<port>` だと sandbox の中から `/dev/udp/8.8.8.8/<port>` が通る =
    // listener の要らない一方向の口が外へ空く)。proxy は HTTP over TCP なので `tcp` で何も失わない
    // (同実測: `tcp *:<port>` は loopback TCP ok / UDP は loopback も外部も deny / IPv6 も deny)。
    //
    // 残る代償: その session の proxy port と同じ番号で **TCP を listen している外部 host** へは
    // 直接繋げる。port は session ごとの ephemeral な乱数で、`(deny network*)` により他は全部
    // 閉じたまま。seatbelt の粒度では loopback に絞る手段が無い(上の実測)。
    out.push_str(&format!(
        "(allow network-outbound (remote tcp \"*:{}\"))\n",
        spec.proxy_port
    ));
    Ok(out)
}

/// profile の置き場(session_dir 直下)。
pub fn profile_path_in(session_dir: &Path) -> PathBuf {
    session_dir.join("sandbox.sb")
}

/// doctor が読む status file(`<broker home>/sandbox-status.json`)。`openroly doctor` は broker の
/// process に聞けない(socket は hook 用)ので、起動時の self_test の結果をここに残す。
pub const STATUS_FILE: &str = "sandbox-status.json";

/// 起動時の判定を doctor 用に書く。`sandbox` = self_test の結果(Ok は backend 名)。
/// `egress_enforcement` = 実際に使う backend(self_test 落ちなら NoSandbox)が名乗る値(PBI-0441)。
pub fn write_status(
    dir: &Path,
    sandbox: &Result<&str, String>,
    egress: &Result<(), String>,
    egress_enforcement: &str,
) {
    let sandbox_line = match sandbox {
        Ok(name) => format!("{name} ok"),
        Err(reason) => format!("unavailable({reason})"),
    };
    let egress_line = match egress {
        Ok(()) => "ok".to_string(),
        Err(reason) => format!("unavailable({reason})"),
    };
    let status = serde_json::json!({
        "sandbox": sandbox_line,
        "egress": egress_line,
        "egress_enforcement": egress_enforcement,
        "checked_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let _ = fs::create_dir_all(dir);
    if let Err(e) = fs::write(dir.join(STATUS_FILE), status.to_string()) {
        eprintln!("broker: could not write {STATUS_FILE}: {e}");
    }
}

impl SandboxBackend for Seatbelt {
    fn wrap(&self, cmd: Command, spec: &SandboxSpec) -> Result<Command, String> {
        let text = profile(spec).map_err(|e| {
            eprintln!("broker: sandbox profile could not be built: {e}");
            "sandbox_unavailable".to_string()
        })?;
        let path = profile_path_in(&spec.session_dir);
        fs::write(&path, &text).map_err(|e| {
            eprintln!("broker: sandbox profile could not be written ({path:?}): {e}");
            "sandbox_unavailable".to_string()
        })?;
        let std = cmd.as_std();
        let mut wrapped = Command::new(SANDBOX_EXEC);
        wrapped.arg("-f").arg(&path).arg(std.get_program()).args(std.get_args());
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
        Ok(wrapped)
    }

    fn self_test(&self) -> Result<(), String> {
        // TMPDIR(`/private/var/folders`)は profile が常に書けるので、「外」の probe には使えない。
        // `/tmp`(実体 `/private/tmp`)に自分の dir を作り、folder だけを許す。
        //
        // pid だけだと同一 process 内で並行に self_test を呼ぶ複数 thread(cargo test の並列実行
        // など)が同じ dir を取り合い、片方の `remove_dir_all` がもう片方の probe を巻き添えで
        // 消す(PBI-0388 実装中に実測: `seatbelt_self_test_passes_on_this_mac` が
        // "loopback to the allowed port failed" で fail した)。呼び出しごとに増える連番を足して
        // 同一 process 内でも衝突しない dir にする。
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let base = PathBuf::from("/tmp").join(format!("openroly-sandbox-selftest-{}-{seq}", std::process::id()));
        let folder = base.join("folder");
        let outside = base.join("outside");
        let session_dir = base.join("session");
        let _ = fs::remove_dir_all(&base);
        for d in [&folder, &outside, &session_dir] {
            fs::create_dir_all(d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
        }
        let result = self.run_probes(&folder, &outside, &session_dir);
        let _ = fs::remove_dir_all(&base);
        result
    }

    fn name(&self) -> &'static str {
        "seatbelt"
    }

    /// profile は `remote tcp "*:<port>"` で port 番号しか pin できない(上の `profile` の注記)
    fn egress_enforcement(&self) -> &'static str {
        "port_scoped"
    }
}

impl Seatbelt {
    fn run_probes(&self, folder: &Path, outside: &Path, session_dir: &Path) -> Result<(), String> {
        // broker 自身が開く 2 つの loopback listener。allowed = profile が許す port(proxy の代わり)、
        // other = 許していない port。deny(EPERM)と「listener が無くて繋がらない」を混同しない。
        let allowed = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
        let other = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
        let allowed_port = allowed.local_addr().map_err(|e| e.to_string())?.port();
        let other_port = other.local_addr().map_err(|e| e.to_string())?.port();
        let spec = SandboxSpec {
            folder: folder.to_path_buf(),
            session_dir: session_dir.to_path_buf(),
            writable_extra: vec![],
            deny_read: vec![],
            proxy_port: allowed_port,
        };
        // bash の `/dev/tcp` で connect する(外部 binary に頼らない。macOS の /bin/bash 3.2 で実測)。
        let script = format!(
            "echo p > \"{f}/probe\" 2>/dev/null && echo 1=ok || echo 1=deny\n\
             echo p > \"{o}/probe\" 2>/dev/null && echo 2=ok || echo 2=deny\n\
             /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{other}' 2>/dev/null && echo 3=ok || echo 3=deny\n\
             /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{allowed}' 2>/dev/null && echo 4=ok || echo 4=deny\n",
            f = folder.display(),
            o = outside.display(),
            other = other_port,
            allowed = allowed_port,
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(&script);
        let wrapped = self.wrap(cmd, &spec)?;
        let mut std_cmd = wrapped.into_std();
        std_cmd.stdin(std::process::Stdio::null());
        let output = std_cmd.output().map_err(|e| format!("sandbox-exec did not start: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let has = |line: &str| stdout.lines().any(|l| l.trim() == line);
        if !output.status.success() && !has("4=ok") && !has("4=deny") {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "sandbox-exec failed: {}",
                stderr.lines().next().unwrap_or("no output").trim()
            ));
        }
        // 4 = 許可した port へ繋がる、は 3 の対照でもある(繋ぐ仕組み自体が動いている証拠)。
        if !has("1=ok") || !folder.join("probe").exists() {
            return Err("probe: write inside the folder was denied".to_string());
        }
        if !has("2=deny") || outside.join("probe").exists() {
            return Err("probe: write outside the folder was allowed".to_string());
        }
        if !has("4=ok") {
            return Err("probe: loopback to the allowed port failed".to_string());
        }
        if !has("3=deny") {
            return Err("probe: tcp to a non-allowed port was allowed".to_string());
        }
        Ok(())
    }
}

impl SandboxBackend for NoSandbox {
    fn wrap(&self, _cmd: Command, _spec: &SandboxSpec) -> Result<Command, String> {
        eprintln!("broker: cannot sandbox the session ({}), so not starting it", self.reason);
        Err("sandbox_unavailable".to_string())
    }

    fn self_test(&self) -> Result<(), String> {
        Err(self.reason.clone())
    }

    fn name(&self) -> &'static str {
        "none"
    }

    fn egress_enforcement(&self) -> &'static str {
        "none"
    }
}

/// `roots` から `deny` を抜いた「許してよい根」(Linux の Landlock 用・PBI-0331)。
///
/// Landlock は **許可の足し算しかできない** —— seatbelt の「全部読める、ただし `~/.ssh` は除く」を書けない。
/// だから deny を含む根を 1 段ずつ子に割り、deny そのものだけを落とす(`/` → `/home` → `$HOME` の子のうち
/// `.ssh` 以外)。**symlink の子は足さない**: 規則は辿った先の実体に掛かるので、`~/link -> ~/.ssh` を足すと
/// deny の中身を許してしまう(辿った先が許された場所なら、その場所の規則で読める)。
/// 代償: 割った後に作られた兄弟(sandbox の起動後に `$HOME` 直下へ増えた file)は許されない。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn carve(roots: &[PathBuf], deny: &[PathBuf]) -> Vec<PathBuf> {
    let real = |p: &PathBuf| fs::canonicalize(p).unwrap_or_else(|_| p.clone());
    let deny: Vec<PathBuf> = deny.iter().map(real).collect();
    let mut todo: Vec<PathBuf> = roots.iter().map(real).collect();
    let mut out = Vec::new();
    while let Some(root) = todo.pop() {
        if deny.iter().any(|d| root.starts_with(d)) {
            continue; // deny そのもの(かその中)
        }
        if !deny.iter().any(|d| d.starts_with(&root)) {
            out.push(root);
            continue;
        }
        // root が deny を含む = 子に割る。読めない dir は割れないので許さない(fail-closed)
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            if entry.file_type().map(|t| !t.is_symlink()).unwrap_or(false) {
                todo.push(entry.path());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Linux の閉じ込め(PBI-0331)。seatbelt と同じ壁を **Landlock(file と TCP)+ seccomp(socket の種類)** で掛ける。
/// 外部 binary も新しい crate も要らない(libc の syscall だけ。Cargo.toml の「crate を増やさない」と同じ線)。
///
/// | 壁 | seatbelt | ここ |
/// |---|---|---|
/// | folder の外へ write deny | `file-write*` の allow 列 | Landlock の write 規則を folder / session_dir / writable_extra / tmp だけに |
/// | `~/.ssh` 等を read deny | `deny file-read*` | deny を含む根を割る(`carve`) |
/// | network は proxy の 1 port | `remote tcp "*:port"` | Landlock ABI 4 の CONNECT_TCP を proxy port だけ・BIND_TCP は許可 0 |
/// | UDP / unix socket / raw | `deny network*` | seccomp: `socket()` は AF_INET / AF_INET6 の SOCK_STREAM だけ。io_uring も閉じる |
///
/// **Landlock ABI 4(Linux 6.7)未満は掛けない = NoSandbox**。TCP を port で縛れないと proxy 以外へ出られる
/// ので、弱い壁で起こすより起こさない方を選ぶ(fail-closed。doctor に理由が出る)。
/// 規則は spawn の前に作り(ruleset の fd と BPF)、fork 後の `pre_exec` では syscall 3 つだけを打つ
/// —— multi-thread の broker から fork した子で allocation しない。
#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
mod linux {
    use super::{carve, SandboxBackend, SandboxSpec};
    use std::fs;
    use std::io;
    use std::net::TcpListener;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use tokio::process::Command;

    pub struct Landlock;

    const CREATE_RULESET_VERSION: libc::c_uint = 1;
    const RULE_PATH_BENEATH: libc::c_int = 1;
    const RULE_NET_PORT: libc::c_int = 2;

    const FS_EXECUTE: u64 = 1 << 0;
    const FS_WRITE_FILE: u64 = 1 << 1;
    const FS_READ_FILE: u64 = 1 << 2;
    const FS_READ_DIR: u64 = 1 << 3;
    const FS_REFER: u64 = 1 << 13;
    const FS_TRUNCATE: u64 = 1 << 14;
    const FS_IOCTL_DEV: u64 = 1 << 15;
    const NET_BIND_TCP: u64 = 1 << 0;
    const NET_CONNECT_TCP: u64 = 1 << 1;
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    const SCOPE_SIGNAL: u64 = 1 << 1;

    /// file(dir でない物)に付けてよい権限。dir 用の権限を file の規則に含めると EINVAL
    const FILE_ONLY: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;
    const READ: u64 = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    #[repr(C)]
    struct NetPortAttr {
        allowed_access: u64,
        port: u64,
    }

    /// kernel の Landlock ABI の版。無効 / 未実装は doctor に出す理由
    fn abi() -> Result<i64, String> {
        let v = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                CREATE_RULESET_VERSION,
            )
        };
        if v >= 0 {
            return Ok(v);
        }
        let e = io::Error::last_os_error();
        Err(match e.raw_os_error() {
            Some(libc::ENOSYS) => "landlock is not built into this kernel".to_string(),
            Some(libc::EOPNOTSUPP) => "landlock is disabled on this kernel (add landlock to lsm=)".to_string(),
            _ => format!("landlock unavailable: {e}"),
        })
    }

    /// この ABI が扱える file 権限の全部 = 規則の無い所では全部 deny になる集合
    fn handled_fs(abi: i64) -> u64 {
        let mut all = (1u64 << 13) - 1; // ABI 1: EXECUTE … MAKE_SYM
        if abi >= 2 {
            all |= FS_REFER;
        }
        if abi >= 3 {
            all |= FS_TRUNCATE;
        }
        if abi >= 5 {
            all |= FS_IOCTL_DEV;
        }
        all
    }

    fn add_rule<T>(ruleset: &OwnedFd, kind: libc::c_int, attr: &T) -> io::Result<()> {
        let r = unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset.as_raw_fd(),
                kind,
                attr as *const T,
                0 as libc::c_uint,
            )
        };
        if r == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    /// `path` の下に `access` を許す。無い path と辿れない path は許さない(規則が当たらないだけ)
    fn allow_path(ruleset: &OwnedFd, path: &Path, access: u64) -> Result<(), String> {
        let file = match fs::OpenOptions::new().read(true).custom_flags(libc::O_PATH).open(path) {
            Ok(f) => f,
            Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) => return Ok(()),
            Err(e) => return Err(format!("open {path:?}: {e}")),
        };
        let is_dir = file.metadata().map_err(|e| format!("stat {path:?}: {e}"))?.is_dir();
        let attr = PathBeneathAttr {
            allowed_access: if is_dir { access } else { access & FILE_ONLY },
            parent_fd: file.as_raw_fd(),
        };
        add_rule(ruleset, RULE_PATH_BENEATH, &attr).map_err(|e| format!("landlock_add_rule {path:?}: {e}"))
    }

    /// `socket()` は AF_INET / AF_INET6 の SOCK_STREAM だけ(UDP・raw・unix・netlink は EACCES)。
    /// `io_uring_setup` を閉じるのは IORING_OP_SOCKET が seccomp を通らずに socket を作れるから。
    /// x32 の番号(0x40000000 以上)は同じ arch 値で来るので、番号の比較を迂回されないよう先に閉じる。
    fn socket_filter() -> Vec<libc::sock_filter> {
        const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
        const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
        const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
        const AND_K: u16 = 0x54; // BPF_ALU | BPF_AND | BPF_K
        const RET_K: u16 = 0x06; // BPF_RET | BPF_K
        #[cfg(target_arch = "x86_64")]
        const ARCH: u32 = 0xC000_003E; // AUDIT_ARCH_X86_64
        #[cfg(target_arch = "aarch64")]
        const ARCH: u32 = 0xC000_00B7; // AUDIT_ARCH_AARCH64
        const X32_SYSCALL_BIT: u32 = 0x4000_0000;
        let deny = libc::SECCOMP_RET_ERRNO | libc::EACCES as u32;
        let op = |code: u16, jt: u8, jf: u8, k: u32| libc::sock_filter { code, jt, jf, k };
        vec![
            op(LD_W_ABS, 0, 0, 4),                             // 0: seccomp_data.arch
            op(JEQ_K, 1, 0, ARCH),                             // 1
            op(RET_K, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),   // 2: 別 arch の番号表で来た
            op(LD_W_ABS, 0, 0, 0),                             // 3: seccomp_data.nr
            op(JGE_K, 0, 1, X32_SYSCALL_BIT),                  // 4
            op(RET_K, 0, 0, deny),                             // 5: x32
            op(JEQ_K, 0, 1, libc::SYS_io_uring_setup as u32),  // 6
            op(RET_K, 0, 0, deny),                             // 7
            op(JEQ_K, 1, 0, libc::SYS_socket as u32),          // 8
            op(RET_K, 0, 0, libc::SECCOMP_RET_ALLOW),          // 9: socket 以外
            op(LD_W_ABS, 0, 0, 16),                            // 10: args[0] の下位 32bit = domain
            op(JEQ_K, 1, 0, libc::AF_INET as u32),             // 11
            op(JEQ_K, 0, 3, libc::AF_INET6 as u32),            // 12: どちらでもなければ 16
            op(LD_W_ABS, 0, 0, 24),                            // 13: args[1] の下位 32bit = type
            op(AND_K, 0, 0, 0xF),                              // 14: SOCK_NONBLOCK / SOCK_CLOEXEC を落とす
            op(JEQ_K, 1, 0, libc::SOCK_STREAM as u32),         // 15
            op(RET_K, 0, 0, deny),                             // 16
            op(RET_K, 0, 0, libc::SECCOMP_RET_ALLOW),          // 17
        ]
    }

    /// spawn の前に作る物。`apply` は fork 後の子で syscall だけを打つ
    struct Prepared {
        ruleset: OwnedFd,
        bpf: Vec<libc::sock_filter>,
    }

    impl Prepared {
        fn build(spec: &SandboxSpec) -> Result<Self, String> {
            let abi = abi()?;
            if abi < 4 {
                return Err(format!("landlock ABI {abi} cannot restrict TCP (needs ABI 4 = Linux 6.7+)"));
            }
            let named = [&spec.folder, &spec.session_dir].into_iter();
            for p in named.chain(&spec.writable_extra).chain(&spec.deny_read) {
                if !p.is_absolute() {
                    return Err(format!("path is not absolute: {p:?}"));
                }
            }
            let fs_all = handled_fs(abi);
            let attr = RulesetAttr {
                handled_access_fs: fs_all,
                handled_access_net: NET_BIND_TCP | NET_CONNECT_TCP,
                scoped: if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 },
            };
            // ABI 6 未満の kernel は `scoped` を知らないので、構造体の長さで渡す field を決める
            let size: usize = if abi >= 6 { 24 } else { 16 };
            let fd = unsafe {
                libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, size, 0 as libc::c_uint)
            };
            if fd < 0 {
                return Err(format!("landlock_create_ruleset: {}", io::Error::last_os_error()));
            }
            let ruleset = unsafe { OwnedFd::from_raw_fd(fd as i32) };

            for root in carve(&[PathBuf::from("/")], &spec.deny_read) {
                allow_path(&ruleset, &root, READ)?;
            }
            let mut writable = vec![spec.folder.clone(), spec.session_dir.clone()];
            writable.extend(spec.writable_extra.iter().cloned());
            // git / node / bun の一時 file(macOS の profile が `/private/var/folders` を開けるのと同じ理由)
            writable.extend(["/tmp", "/var/tmp", "/dev/shm", "/dev/pts"].map(PathBuf::from));
            for root in carve(&writable, &spec.deny_read) {
                allow_path(&ruleset, &root, fs_all)?;
            }
            for dev in ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/ptmx"] {
                allow_path(&ruleset, Path::new(dev), fs_all)?;
            }
            let proxy = NetPortAttr { allowed_access: NET_CONNECT_TCP, port: u64::from(spec.proxy_port) };
            add_rule(&ruleset, RULE_NET_PORT, &proxy).map_err(|e| format!("landlock_add_rule(proxy port): {e}"))?;
            Ok(Prepared { ruleset, bpf: socket_filter() })
        }

        /// fork 後・exec 前の子で打つ。**allocation しない**(`last_os_error` も Os の値を持つだけ)
        fn apply(&self) -> io::Result<()> {
            let prog = libc::sock_fprog {
                len: self.bpf.len() as libc::c_ushort,
                filter: self.bpf.as_ptr() as *mut libc::sock_filter,
            };
            unsafe {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::syscall(libc::SYS_landlock_restrict_self, self.ruleset.as_raw_fd(), 0 as libc::c_uint) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER as libc::c_ulong, &prog as *const libc::sock_fprog) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        }
    }

    impl SandboxBackend for Landlock {
        fn wrap(&self, mut cmd: Command, spec: &SandboxSpec) -> Result<Command, String> {
            let prepared = Prepared::build(spec).map_err(|e| {
                eprintln!("broker: sandbox rules could not be built: {e}");
                "sandbox_unavailable".to_string()
            })?;
            // SAFETY: closure は fork 後の子で syscall だけを打つ(`Prepared::apply`)。seatbelt と違い
            // command を作り直さないので、program / args / env / cwd はそのまま残る
            unsafe {
                cmd.pre_exec(move || prepared.apply());
            }
            Ok(cmd)
        }

        fn self_test(&self) -> Result<(), String> {
            // `/tmp` は write を許す根なので「外」の probe に使えない(seatbelt が TMPDIR を避けるのと同じ理由)。
            // HOME の下に自分の dir を作る
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
            let base = home.join(".openroly").join(format!("sandbox-selftest-{}-{seq}", std::process::id()));
            let (folder, outside, session_dir, secret) =
                (base.join("folder"), base.join("outside"), base.join("session"), base.join("secret"));
            let _ = fs::remove_dir_all(&base);
            for d in [&folder, &outside, &session_dir, &secret] {
                fs::create_dir_all(d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
            }
            let result = fs::write(secret.join("key"), "k")
                .map_err(|e| format!("cannot write the probe secret: {e}"))
                .and_then(|()| self.run_probes(&folder, &outside, &session_dir, &secret));
            let _ = fs::remove_dir_all(&base);
            result
        }

        fn name(&self) -> &'static str {
            "landlock"
        }

        /// Landlock の NET_PORT は port 番号しか縛れない(seatbelt と同じ残差・PBI-0441)
        fn egress_enforcement(&self) -> &'static str {
            "port_scoped"
        }
    }

    impl Landlock {
        fn run_probes(&self, folder: &Path, outside: &Path, session_dir: &Path, secret: &Path) -> Result<(), String> {
            let bash = ["/bin/bash", "/usr/bin/bash"]
                .into_iter()
                .find(|p| Path::new(p).exists())
                .ok_or("bash not found (the sandbox self-test connects with /dev/tcp)")?;
            let allowed = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
            let other = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
            let allowed_port = allowed.local_addr().map_err(|e| e.to_string())?.port();
            let other_port = other.local_addr().map_err(|e| e.to_string())?.port();
            let spec = SandboxSpec {
                folder: folder.to_path_buf(),
                session_dir: session_dir.to_path_buf(),
                writable_extra: vec![],
                deny_read: vec![secret.to_path_buf()],
                proxy_port: allowed_port,
            };
            // 5 と 6 は対照を持つ: 7 = 同じ cat が folder の中なら読める / 4 = 同じ /dev/tcp が許した port なら繋がる
            let script = format!(
                "echo p > \"{f}/probe\" 2>/dev/null && echo 1=ok || echo 1=deny\n\
                 echo p > \"{o}/probe\" 2>/dev/null && echo 2=ok || echo 2=deny\n\
                 {bash} -c 'exec 3<>/dev/tcp/127.0.0.1/{other}' 2>/dev/null && echo 3=ok || echo 3=deny\n\
                 {bash} -c 'exec 3<>/dev/tcp/127.0.0.1/{allowed}' 2>/dev/null && echo 4=ok || echo 4=deny\n\
                 cat \"{s}/key\" >/dev/null 2>&1 && echo 5=ok || echo 5=deny\n\
                 {bash} -c 'exec 3<>/dev/udp/127.0.0.1/{allowed}' 2>/dev/null && echo 6=ok || echo 6=deny\n\
                 cat \"{f}/probe\" >/dev/null 2>&1 && echo 7=ok || echo 7=deny\n",
                f = folder.display(),
                o = outside.display(),
                s = secret.display(),
                other = other_port,
                allowed = allowed_port,
            );
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-c").arg(&script);
            let wrapped = self.wrap(cmd, &spec)?;
            let mut std_cmd = wrapped.into_std();
            std_cmd.stdin(std::process::Stdio::null());
            let output = std_cmd.output().map_err(|e| format!("sandboxed /bin/sh did not start: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let has = |line: &str| stdout.lines().any(|l| l.trim() == line);
            let checks = [
                ("1=ok", "write inside the folder was denied"),
                ("2=deny", "write outside the folder was allowed"),
                ("4=ok", "loopback to the allowed port failed"),
                ("3=deny", "tcp to a non-allowed port was allowed"),
                ("7=ok", "reading inside the folder was denied"),
                ("5=deny", "a deny_read path was readable"),
                ("6=deny", "a udp socket could be opened"),
            ];
            for (line, why) in checks {
                if !has(line) {
                    return Err(format!("probe: {why}"));
                }
            }
            if outside.join("probe").exists() {
                return Err("probe: write outside the folder was allowed".to_string());
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn landlock_self_test_passes_on_this_linux() {
            assert_eq!(Landlock.self_test(), Ok(()));
        }

        #[test]
        fn socket_filter_jumps_stay_inside_the_program() {
            let prog = socket_filter();
            for (i, ins) in prog.iter().enumerate() {
                if ins.code & 0x07 == 0x05 {
                    assert!(i + 1 + (ins.jt as usize) < prog.len(), "instruction {i} jt");
                    assert!(i + 1 + (ins.jf as usize) < prog.len(), "instruction {i} jf");
                }
            }
            assert_eq!(prog.last().map(|i| i.code), Some(0x06), "最後は RET");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(dir: &Path) -> SandboxSpec {
        SandboxSpec {
            folder: dir.join("folder"),
            session_dir: dir.join("session"),
            writable_extra: vec![dir.join("extra")],
            deny_read: vec![dir.join("secret")],
            proxy_port: 18238,
        }
    }

    #[test]
    fn profile_denies_default_and_network_and_allows_only_the_proxy_port() {
        let dir = std::env::temp_dir().join(format!("openroly-sb-prof-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for d in ["folder", "session", "extra", "secret"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        let text = profile(&spec(&dir)).unwrap();
        let real = fs::canonicalize(&dir).unwrap();
        assert!(text.starts_with("(version 1)\n(deny default)\n"));
        assert!(text.contains("(deny network*)\n"));
        // PBI-0385: host は `*`・protocol は `tcp`・port だけ pin(`localhost:` は seatbelt が 1 接続も
        // 通さない / `remote ip` は UDP まで開けてしまう。どちらも有界レビューで実測)
        assert!(text.contains("(allow network-outbound (remote tcp \"*:18238\"))"));
        assert!(!text.contains("remote ip "), "`remote ip` は UDP も開ける(PBI-0385)");
        assert!(!text.contains("localhost:"), "localhost 指定は seatbelt では機能しない(PBI-0385)");
        // 実 path(macOS の /var → /private/var)で書く
        assert!(text.contains(&format!("(subpath \"{}/folder\")", real.display())));
        assert!(text.contains(&format!("(deny file-read* (subpath \"{}/secret\"))", real.display())));
        assert!(text.contains(&format!("(subpath \"{}/extra\")", real.display())));
        assert!(text.contains("(literal \"/dev/null\")"));
        // network の allow は 1 行だけ(proxy 以外に口が無い)
        assert_eq!(text.matches("(allow network").count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn profile_refuses_paths_that_would_break_the_grammar() {
        let dir = std::env::temp_dir();
        let mut s = spec(&dir);
        s.folder = PathBuf::from("/tmp/x\") (allow network*) (subpath \"/");
        assert!(profile(&s).is_err(), "`\"` を含む path は profile に規則を注入できる");
        let mut s = spec(&dir);
        s.deny_read = vec![PathBuf::from("relative/path")];
        assert!(profile(&s).is_err(), "相対 path は subpath 規則として無意味");
    }

    #[test]
    fn defaults_cover_secrets_but_not_credentials() {
        let home = Path::new("/Users/x");
        let deny = default_deny_read(home);
        assert!(deny.contains(&PathBuf::from("/Users/x/.ssh")));
        assert!(deny.contains(&PathBuf::from("/Users/x/.openroly/secrets.json")));
        assert!(deny.contains(&PathBuf::from("/Users/x/.atn/secrets.json")));
        assert!(deny.contains(&PathBuf::from("/Users/x/Library/Keychains")));
        // 未決 1 の既定: credentials.json は読める(MCP が token を読む)
        assert!(!deny.iter().any(|p| p.ends_with("credentials.json")));
        let extra = default_writable_extra(home);
        assert!(extra.contains(&PathBuf::from("/Users/x/.claude")));
        assert!(extra.contains(&PathBuf::from("/Users/x/Library/Application Support")));
    }

    // PBI-0441: doctor が読む status file に、実際に使う backend が名乗る egress_enforcement が載る
    #[test]
    fn status_file_carries_the_backends_egress_enforcement() {
        let dir = std::env::temp_dir().join(format!("openroly-sb-status-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let backend = NoSandbox { reason: "test".into() };
        write_status(&dir, &Err("test".into()), &Ok(()), backend.egress_enforcement());
        let status: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(STATUS_FILE)).unwrap()).unwrap();
        assert_eq!(status["egress_enforcement"], "none");
        assert_eq!(status["sandbox"], "unavailable(test)");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn carve_drops_only_the_denied_path_and_keeps_its_siblings() {
        let dir = std::env::temp_dir().join(format!("openroly-sb-carve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for d in ["a/secret", "a/open", "b"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        std::os::unix::fs::symlink(dir.join("a/secret"), dir.join("a/link")).unwrap();
        let real = fs::canonicalize(&dir).unwrap();

        let out = carve(&[dir.clone()], &[dir.join("a/secret")]);
        assert!(out.contains(&real.join("a/open")), "{out:?}");
        assert!(out.contains(&real.join("b")), "{out:?}");
        assert!(!out.iter().any(|p| p.starts_with(real.join("a/secret"))), "deny の中身が許された: {out:?}");
        assert!(!out.contains(&real.join("a/link")), "symlink は辿った先(= deny)に規則が掛かる: {out:?}");
        assert!(!out.contains(&real) && !out.contains(&real.join("a")), "deny を含む根が割られていない: {out:?}");
        // deny が無ければ根はそのまま 1 本
        assert_eq!(carve(&[dir.clone()], &[]), vec![real.clone()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_sandbox_wrap_is_sandbox_unavailable() {
        let b = NoSandbox { reason: "test".into() };
        let err = b.wrap(Command::new("/bin/sh"), &spec(Path::new("/tmp"))).err();
        assert_eq!(err, Some("sandbox_unavailable".to_string()));
        assert_eq!(b.self_test().err(), Some("test".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_wrap_keeps_program_args_env_and_cwd() {
        let dir = std::env::temp_dir().join(format!("openroly-sb-wrap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("session")).unwrap();
        fs::create_dir_all(dir.join("folder")).unwrap();
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("a").arg("b").env("K", "v").env_remove("CLAUDECODE").current_dir(dir.join("folder"));
        let wrapped = Seatbelt.wrap(cmd, &spec(&dir)).unwrap();
        let std = wrapped.as_std();
        assert_eq!(std.get_program(), SANDBOX_EXEC);
        let args: Vec<String> = std.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args[0], "-f");
        assert_eq!(args[1], dir.join("session").join("sandbox.sb").to_string_lossy());
        assert_eq!(&args[2..], ["/bin/echo", "a", "b"]);
        let envs: Vec<_> = std.get_envs().collect();
        assert!(envs.iter().any(|(k, v)| k.to_str() == Some("K") && v.and_then(|v| v.to_str()) == Some("v")));
        assert!(envs.iter().any(|(k, v)| k.to_str() == Some("CLAUDECODE") && v.is_none()));
        assert_eq!(std.get_current_dir(), Some(dir.join("folder").as_path()));
        assert!(fs::read_to_string(dir.join("session").join("sandbox.sb")).unwrap().contains("(deny default)"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_self_test_passes_on_this_mac() {
        assert_eq!(Seatbelt.self_test(), Ok(()));
    }
}
