//! PBI-0385 有界レビュー: seatbelt profile の network 行を **文言ではなく振る舞い**で破りに行く。
//!
//! 8eea41b は `remote ip "localhost:<port>"`(1 接続も通さない)を `remote ip "*:<port>"` に変えた。
//! それで self_test は通ったが、`remote ip` は **UDP も一緒に開ける** —— sandbox の中から
//! `/dev/udp/<外部 host>/<proxy port>` が通り、listener の要らない一方向の口が外へ空いていた。
//! `(deny network*)` + 1 行 allow という骨は同じでも、AC-2「profile が許すのは proxy の 1 port だけ」の
//! **protocol の次元が一度も測られていなかった**(= 測っていないから緑)。ここで振る舞いを凍結する。
//!
//! `broker` は lib crate を持たないため `#[path]` で src を直接取り込む(pbi0238_sandbox_probe.rs と同じ)。
#![cfg(target_os = "macos")]

#[path = "../src/sandbox.rs"]
mod sandbox;

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use sandbox::{SandboxBackend, SandboxSpec, Seatbelt, profile_path_in};

fn seatbelt_available() -> bool {
    Path::new("/usr/bin/sandbox-exec").exists()
}

fn fresh(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-0385-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("folder")).unwrap();
    fs::create_dir_all(dir.join("session")).unwrap();
    dir
}

/// profile を書いて `/bin/bash -c <script>` を seatbelt の中で走らせ、stdout を返す。
/// 各 probe は `<名前>=ok` / `<名前>=deny` を 1 行ずつ出す。
fn probe(dir: &Path, proxy_port: u16, script: &str) -> String {
    let spec = SandboxSpec {
        folder: dir.join("folder"),
        session_dir: dir.join("session"),
        writable_extra: vec![],
        deny_read: vec![],
        proxy_port,
    };
    let mut cmd = tokio::process::Command::new("/bin/bash");
    cmd.arg("-c").arg(script);
    let wrapped = Seatbelt.wrap(cmd, &spec).expect("wrap");
    let mut std_cmd = wrapped.into_std();
    std_cmd.stdin(std::process::Stdio::null());
    let out = std_cmd.output().expect("sandbox-exec did not start");
    // profile が実際に書かれたことも確かめる(wrap が黙って素通しした形ではない)
    assert!(profile_path_in(&dir.join("session")).exists(), "profile が書かれていない");
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn has(out: &str, line: &str) -> bool {
    out.lines().any(|l| l.trim() == line)
}

/// 攻撃 1〜4 をまとめて 1 回の sandbox 起動で撃つ(seatbelt の起動は遅いので probe は 1 本にまとめる)。
///
/// - 攻撃 1: **proxy port へ UDP**(外部 host 宛)。`remote ip` だと通っていた口。deny でなければならない
/// - 攻撃 2: **proxy port へ UDP**(loopback 宛)。同上
/// - 攻撃 3: proxy port **以外**へ TCP を 3 本(self_test は 1 本しか試していない)。全部 deny
/// - 攻撃 4: proxy port へ TCP = **ok**(陽性対照。これが deny なら probe 自体が壊れていて、
///   1〜3 の deny は「閉じている」の証拠にならない)
#[test]
fn only_tcp_to_the_proxy_port_gets_out_of_the_sandbox() {
    if !seatbelt_available() {
        return;
    }
    let dir = fresh("pin");
    // 陽性対照の相手は broker 自身が開く listener(繋がらない = deny と読み違えないため)
    let allowed = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = allowed.local_addr().unwrap().port();
    let others: Vec<u16> = (0..3)
        .map(|_| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let p = l.local_addr().unwrap().port();
            Box::leak(Box::new(l)); // test の間 開けたままにする
            p
        })
        .collect();

    let script = format!(
        "exec 3<>/dev/udp/8.8.8.8/{port} 2>/dev/null && echo udp_ext=ok || echo udp_ext=deny\n\
         exec 3<>/dev/udp/127.0.0.1/{port} 2>/dev/null && echo udp_lo=ok || echo udp_lo=deny\n\
         exec 3<>/dev/tcp/127.0.0.1/{o0} 2>/dev/null && echo tcp_o0=ok || echo tcp_o0=deny\n\
         exec 3<>/dev/tcp/127.0.0.1/{o1} 2>/dev/null && echo tcp_o1=ok || echo tcp_o1=deny\n\
         exec 3<>/dev/tcp/127.0.0.1/{o2} 2>/dev/null && echo tcp_o2=ok || echo tcp_o2=deny\n\
         exec 3<>/dev/tcp/127.0.0.1/{port} 2>/dev/null && echo tcp_allowed=ok || echo tcp_allowed=deny\n",
        port = port,
        o0 = others[0],
        o1 = others[1],
        o2 = others[2],
    );
    let out = probe(&dir, port, &script);

    // 陽性対照が先(これが落ちていたら以下の deny は何も意味しない)
    assert!(has(&out, "tcp_allowed=ok"), "許可した port へ TCP が通らない = probe が壊れている\n{out}");
    // 攻撃 1: UDP は外へ出られない。`remote ip "*:port"` だと ここが ok になる
    assert!(
        has(&out, "udp_ext=deny"),
        "proxy port 宛の UDP で外部 host に届いた(listener 不要の一方向の口)\n{out}"
    );
    // 攻撃 2: loopback 宛の UDP も同じく閉じている
    assert!(has(&out, "udp_lo=deny"), "proxy port 宛の UDP が loopback に通った\n{out}");
    // 攻撃 3: port の pin は 1 本だけの偶然ではない
    for (i, p) in others.iter().enumerate() {
        assert!(has(&out, &format!("tcp_o{i}=deny")), "許可していない port {p} へ TCP が通った\n{out}");
    }

    let _ = fs::remove_dir_all(&dir);
}

/// 攻撃 5: profile の network の口は **1 行だけ**で、その 1 行が `remote tcp`(= UDP を含まない)。
/// 文言側の凍結 —— `network-bind` 等を後から足して口を増やす変異を殺す。
#[test]
fn the_profile_has_exactly_one_network_allow_and_it_is_tcp_only() {
    let dir = fresh("text");
    let spec = SandboxSpec {
        folder: dir.join("folder"),
        session_dir: dir.join("session"),
        writable_extra: vec![],
        deny_read: vec![],
        proxy_port: 40385,
    };
    let text = sandbox::profile(&spec).unwrap();
    assert_eq!(text.matches("(allow network").count(), 1, "network の口が 1 つでない\n{text}");
    assert!(text.contains("(deny network*)\n"), "deny network* が消えている\n{text}");
    assert!(
        text.contains("(allow network-outbound (remote tcp \"*:40385\"))"),
        "network の 1 行が `remote tcp \"*:<port>\"` でない\n{text}"
    );
    assert!(!text.contains("remote ip"), "`remote ip` は UDP も開ける(PBI-0385 実測)\n{text}");
    assert!(!text.contains("localhost:"), "`localhost:` は seatbelt が 1 接続も通さない\n{text}");
    let _ = fs::remove_dir_all(&dir);
}
