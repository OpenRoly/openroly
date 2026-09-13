//! PBI-0238 AC-1 / AC-2 / AC-X1 / AC-X3: **実 seatbelt の中で fake runtime(sh)を起こし**、broker が掛ける壁
//! (folder の外は write deny・symlink / nested sh も同じ・`~/.ssh` は read deny・raw TCP は deny・
//! network は自分の egress proxy の 1 port だけ)を、profile の文言ではなく **振る舞い**で見る。
//!
//! macOS でだけ走る(seatbelt は macOS の物。他 OS は `NoSandbox` = `sandbox_unavailable` で、
//! `launch.rs` の unit test `dedicated_launch_sandbox_unavailable_spawns_nothing` が見る)。
//! `broker` は lib crate を持たないため `#[path]` で src を直接取り込む(`pbi0033_review_attack.rs` と同じ)。
#![cfg(target_os = "macos")]

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
// PBI-0403 有界レビューで実測: launch.rs の test が `crate::sessions::` を参照するようになった
// ため、sessions.rs も一緒に取り込まないとこのバイナリはコンパイルできない(E0433)。
#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/sessions.rs"]
mod sessions;

use std::fs;
use std::net::{SocketAddr, TcpListener};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use discovery::Found;
use egress::EgressConfig;
use launch::{ContainmentEnv, Isolation, launch_session_scoped_in};
use sandbox::{Seatbelt, SandboxBackend};
use tokio::sync::mpsc::unbounded_channel;

/// `launch.rs` の unit test `test_env()` と同じ形(claude の閉じ込め用 config)。dedicated_launch が
/// `--mcp-config` を組めるだけの最小の内容。fake runtime は argv を読まない。
fn containment(dir: &Path) -> ContainmentEnv {
    let config = dir.join(".claude.json");
    fs::write(
        &config,
        r#"{"mcpServers":{"openroly":{"type":"stdio","command":"bun","args":["/x/server.ts"],
           "env":{"OPENROLY_RUNTIME_KIND":"claude","OPENROLY_URL":"http://localhost:8787"}}}}"#,
    )
    .unwrap();
    let codex_config = dir.join("codex-config.toml");
    fs::write(&codex_config, "[mcp_servers.openroly]\ncommand = \"bun\"\n").unwrap();
    ContainmentEnv {
        claude_config: config,
        claude_plugin_registry: dir.join("no-such-plugins.json"),
        codex_config,
        gemini_admin_dirs: vec![dir.join("no-such-admin-policies")],
    }
}

/// `claude` の名前で found に載せる fake runtime(sh script)。found の path が bare name より優先される
/// ので実 claude は起こさない。script は broker が渡す argv を読まず、probe を順に試して stdout に出す
/// (stdout は session_dir/stdout.log に残る)。
fn fake_claude(dir: &Path, script: &str) -> Vec<Found> {
    let bin = dir.join("claude");
    fs::write(&bin, format!("#!/bin/sh\n{script}")).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    vec![Found { id: "claude".into(), version: None, source: "dir".into(), path: bin.to_string_lossy().into(), models: vec![] }]
}

fn fresh(name: &str) -> PathBuf {
    // TMPDIR(`/private/var/folders`)は profile が常に書けるので「外」の probe には使えない。
    // `/tmp`(実体 `/private/tmp`)に自分の dir を作る(sandbox.rs::self_test と同じ理由)。
    let dir = PathBuf::from("/tmp").join(format!("openroly-0238-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// upstream 役(AC-2)。1 接続受けて banner を書いて閉じる。proxy(broker 側 = sandbox の外)が繋ぐ。
fn upstream() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    std::thread::spawn(move || {
        use std::io::Write;
        for s in l.incoming().flatten() {
            let mut s = s;
            let _ = s.write_all(b"UPSTREAM\n");
        }
    });
    addr
}

fn seatbelt_available() -> bool {
    match Seatbelt.self_test() {
        Ok(()) => true,
        Err(reason) => {
            eprintln!("skip: seatbelt self_test failed on this machine: {reason}");
            false
        }
    }
}

fn stdout_of(home: &Path, request_id: &str) -> String {
    fs::read_to_string(home.join("sessions").join(request_id).join("stdout.log")).unwrap_or_default()
}

fn has(out: &str, line: &str) -> bool {
    out.lines().any(|l| l.trim() == line)
}

// AC-1 / AC-2: folder 内だけ write できる。外・symlink 経由・nested sh は deny、`~/.ssh` は read deny、
// 許可していない loopback port への raw TCP は deny。proxy 経由の CONNECT は allowlist だけ通り、
// evil は 403 + `egress_denied{host}` が 1 件。
#[tokio::test]
async fn fake_runtime_inside_seatbelt_can_only_write_its_folder_and_talk_to_its_proxy() {
    if !seatbelt_available() {
        return;
    }
    let dir = fresh("probe");
    let home = dir.join("home");
    let user_home = dir.join("userhome");
    let folder = dir.join("proj");
    let outside = dir.join("outside");
    for d in [&user_home.join(".ssh"), &folder, &outside] {
        fs::create_dir_all(d).unwrap();
    }
    fs::write(user_home.join(".ssh").join("id_ed25519"), "SECRET").unwrap();
    // folder の中の symlink が外を指す(seatbelt は実 path で判定するので deny のはず)
    std::os::unix::fs::symlink(&outside, folder.join("link")).unwrap();
    // 許可していない loopback port(listener は在る = 「繋がらない」ではなく「deny」を見る)
    let other = TcpListener::bind("127.0.0.1:0").unwrap();
    let other_port = other.local_addr().unwrap().port();
    let up = upstream();
    let (tx, mut rx) = unbounded_channel();

    let script = format!(
        "echo \"cwd=$(pwd)\"\n\
         echo p > \"{f}/inside\" 2>/dev/null && echo 1=ok || echo 1=deny\n\
         echo p > \"{o}/outside\" 2>/dev/null && echo 2=ok || echo 2=deny\n\
         echo p > \"{f}/link/via-symlink\" 2>/dev/null && echo 3=ok || echo 3=deny\n\
         ls \"{h}/.ssh\" >/dev/null 2>&1 && echo 4=ok || echo 4=deny\n\
         /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{other}' 2>/dev/null && echo 5=ok || echo 5=deny\n\
         /bin/sh -c 'echo p > \"{o}/nested\"' 2>/dev/null && echo 6=ok || echo 6=deny\n\
         pp=${{HTTPS_PROXY##*:}}\n\
         /bin/bash -c \"exec 3<>/dev/tcp/127.0.0.1/$pp; printf 'CONNECT allowed.example:443 HTTP/1.1\\r\\n\\r\\n' >&3; cat <&3\" 2>/dev/null | tr -d '\\r' | sed 's/^/7=/'\n\
         /bin/bash -c \"exec 3<>/dev/tcp/127.0.0.1/$pp; printf 'CONNECT evil.example:443 HTTP/1.1\\r\\n\\r\\n' >&3; cat <&3\" 2>/dev/null | tr -d '\\r' | sed 's/^/8=/'\n",
        f = folder.display(),
        o = outside.display(),
        h = user_home.display(),
        other = other_port,
    );
    let found = fake_claude(&dir, &script);
    let folder_str = folder.to_string_lossy().to_string();
    let iso = Isolation {
        sandbox: &Seatbelt,
        egress: EgressConfig { allow: vec!["allowed.example".to_string()], events: Some(tx), upstream_override: Some(up), observe: None },
        folder: Some(&folder_str),
        user_home: user_home.clone(),
    };
    let (mut child, egress) =
        launch_session_scoped_in(&home, &registry::builtin(), &found, "claude", "INSTR", "req-probe", None, &containment(&dir), &iso)
            .expect("spawn inside seatbelt");
    let status = child.wait().await.unwrap();
    let out = stdout_of(&home, "req-probe");
    assert!(status.success(), "fake runtime が正常終了していない: {status:?}\n{out}");

    // cwd = folder(AC-4 の owner 側)
    let cwd = out.lines().find_map(|l| l.strip_prefix("cwd=")).expect("cwd 行");
    assert_eq!(fs::canonicalize(cwd).unwrap(), fs::canonicalize(&folder).unwrap(), "cwd が folder でない\n{out}");
    assert!(has(&out, "1=ok") && folder.join("inside").exists(), "folder 内の write が deny された\n{out}");
    assert!(has(&out, "2=deny") && !outside.join("outside").exists(), "folder の外に書けた\n{out}");
    assert!(has(&out, "3=deny") && !outside.join("via-symlink").exists(), "symlink 経由で外に書けた\n{out}");
    assert!(has(&out, "4=deny"), "~/.ssh が読めた\n{out}");
    assert!(has(&out, "5=deny"), "許可していない port へ raw TCP が繋がった\n{out}");
    assert!(has(&out, "6=deny") && !outside.join("nested").exists(), "nested sh が外に書けた\n{out}");
    // AC-2: allowed は proxy が upstream へ繋ぐ(200 + upstream の banner)、evil は 403
    assert!(has(&out, "7=HTTP/1.1 200 Connection Established"), "allowed.example の CONNECT が通らない\n{out}");
    assert!(has(&out, "7=UPSTREAM"), "proxy が upstream に繋いでいない\n{out}");
    assert!(has(&out, "8=HTTP/1.1 403 Forbidden"), "evil.example の CONNECT が 403 でない\n{out}");
    assert!(!out.contains("8=UPSTREAM"), "evil.example が upstream に繋がった\n{out}");
    let ev = rx.try_recv().expect("egress_denied が 1 件");
    assert_eq!(ev["type"], "egress_denied");
    assert_eq!(ev["host"], "evil.example");
    assert_eq!(ev["requestId"], "req-probe");
    assert!(rx.try_recv().is_err(), "allowed の分まで数えている");
    // 記録は session_dir に残る(stdout.log / profile)
    let session = home.join("sessions").join("req-probe");
    assert!(session.join("sandbox.sb").exists());
    assert!(fs::read_to_string(session.join("sandbox.sb")).unwrap().contains(&format!("remote tcp \"*:{}\"", egress.port)));
    drop(egress);
    let _ = fs::remove_dir_all(&dir);
}

// AC-X1 / AC-X3: 同時に走る別 session(B)の proxy port と folder には、session A の中から届かない。
// port も profile も folder も session ごとに独立(2 つ起こしても互いの壁は共有されない)。
#[tokio::test]
async fn a_session_cannot_reach_another_sessions_port_or_folder() {
    if !seatbelt_available() {
        return;
    }
    let dir = fresh("two");
    let home = dir.join("home");
    let folder_a = dir.join("a");
    let folder_b = dir.join("b");
    fs::create_dir_all(&folder_a).unwrap();
    fs::create_dir_all(&folder_b).unwrap();
    let env = containment(&dir);
    let user_home = dir.join("userhome");
    fs::create_dir_all(&user_home).unwrap();

    // B を先に起こす(script は即終了。proxy は `Egress` を持っている間は開いたまま = 同時に走っている扱い)
    fs::create_dir_all(dir.join("b-bin")).unwrap();
    let found_b = fake_claude(&dir.join("b-bin"), "echo b\n");
    let folder_b_str = folder_b.to_string_lossy().to_string();
    let iso_b = Isolation {
        sandbox: &Seatbelt,
        egress: EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None },
        folder: Some(&folder_b_str),
        user_home: user_home.clone(),
    };
    let (mut child_b, egress_b) =
        launch_session_scoped_in(&home, &registry::builtin(), &found_b, "claude", "B", "req-b", None, &env, &iso_b).expect("spawn B");
    assert!(child_b.wait().await.unwrap().success());
    let port_b = egress_b.port;

    // A の中から B の port と folder を突く
    let script = format!(
        "/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{port_b}' 2>/dev/null && echo port=ok || echo port=deny\n\
         echo p > \"{b}/from-a\" 2>/dev/null && echo folder=ok || echo folder=deny\n\
         echo p > \"{sb}/from-a\" 2>/dev/null && echo session=ok || echo session=deny\n\
         pp=${{HTTPS_PROXY##*:}}\n\
         /bin/bash -c \"exec 3<>/dev/tcp/127.0.0.1/$pp\" 2>/dev/null && echo own=ok || echo own=deny\n",
        b = folder_b.display(),
        sb = home.join("sessions").join("req-b").display(),
    );
    fs::create_dir_all(dir.join("a-bin")).unwrap();
    let found_a = fake_claude(&dir.join("a-bin"), &script);
    let folder_a_str = folder_a.to_string_lossy().to_string();
    let iso_a = Isolation {
        sandbox: &Seatbelt,
        egress: EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None },
        folder: Some(&folder_a_str),
        user_home: user_home.clone(),
    };
    let (mut child_a, egress_a) =
        launch_session_scoped_in(&home, &registry::builtin(), &found_a, "claude", "A", "req-a", None, &env, &iso_a).expect("spawn A");
    assert!(child_a.wait().await.unwrap().success());
    assert_ne!(egress_a.port, port_b, "2 session が同じ proxy port");
    let out = stdout_of(&home, "req-a");
    assert!(has(&out, "port=deny"), "A から B の proxy port に繋がった\n{out}");
    assert!(has(&out, "folder=deny") && !folder_b.join("from-a").exists(), "A から B の folder に書けた\n{out}");
    assert!(has(&out, "session=deny"), "A から B の session_dir に書けた\n{out}");
    assert!(has(&out, "own=ok"), "A が自分の proxy port に繋げない(対照)\n{out}");
    // profile は session ごと(B の port は A の profile に無い)
    let prof_a = fs::read_to_string(home.join("sessions").join("req-a").join("sandbox.sb")).unwrap();
    assert!(prof_a.contains(&format!("remote tcp \"*:{}\"", egress_a.port)));
    assert!(!prof_a.contains(&format!("remote tcp \"*:{port_b}\"")));
    drop(egress_a);
    drop(egress_b);
    let _ = fs::remove_dir_all(&dir);
}
