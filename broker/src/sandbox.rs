//! 閉じ込めの土台 = broker が掛ける OS sandbox(PBI-0238 / 図72)。
//!
//! 図57 の runtime 別 flag は「runtime が自分で守る」約束で、runtime を 1 つ足すたびに実測が要り、
//! codex のように「読める shell」が残る。この module は **runtime が何であれ同じ壁**を外から掛ける:
//! folder の中だけ write・外は deny(symlink 経由も実 path で deny)・`~/.ssh` 等は read deny・
//! network は loopback の proxy 1 port だけ。子 process(nested sh)にも継承される(実測 2026-09-04)。
//!
//! backend は macOS の seatbelt(`/usr/bin/sandbox-exec -f <profile>`)だけ。Linux / Windows /
//! seatbelt 不在は `NoSandbox` で、`wrap` が `sandbox_unavailable` を返す = dedicated wake は
//! **起こさない**(fail-closed。丸腰で起こす選択はしない)。
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
}

/// macOS seatbelt。profile は session_dir に書き、`sandbox-exec -f` で読ませる。
pub struct Seatbelt;

/// backend が無い OS / seatbelt が壊れている機。`reason` は doctor に出す。
pub struct NoSandbox {
    pub reason: String,
}

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// この機で使う backend。macOS で `sandbox-exec` が在れば Seatbelt、それ以外は NoSandbox。
pub fn backend() -> Box<dyn SandboxBackend> {
    if cfg!(target_os = "macos") && Path::new(SANDBOX_EXEC).exists() {
        Box::new(Seatbelt)
    } else if cfg!(target_os = "macos") {
        Box::new(NoSandbox { reason: "sandbox-exec not found".to_string() })
    } else {
        Box::new(NoSandbox { reason: format!("no sandbox backend for {}", std::env::consts::OS) })
    }
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
    out.push_str(&format!(
        "(allow network-outbound (remote ip \"localhost:{}\"))\n",
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
pub fn write_status(dir: &Path, sandbox: &Result<&str, String>, egress: &Result<(), String>) {
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
        let base = PathBuf::from("/tmp").join(format!("openroly-sandbox-selftest-{}", std::process::id()));
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
        assert!(text.contains("(allow network-outbound (remote ip \"localhost:18238\"))"));
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
