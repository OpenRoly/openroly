//! PBI-0388 有界レビューの攻撃 test。
//!
//! 審査対象: AC-X1(proxy 素通しの口)/ AC-X3(host 集合の混ざり)/ observe tap の盲点。
//! AC-X2(fail-closed)と AC-3(secret scan)の境界攻撃は、攻撃対象の関数が `acp_probe.rs`
//! の private にあるため、そちらの file 内に置いた(directory を binary として渡す /
//! secret scan の両側境界 / truncate の多 byte 境界)。
//!
//! 全部 offline(`#[ignore]` 無し)。実 network は使わない —— の的は自分で bind した listener。

#![cfg(target_os = "macos")]

#[path = "../src/c1.rs"]
mod c1;
#[path = "../src/egress.rs"]
mod egress;
// egress.rs の Drop が外の masking server を group ごと落とす(PBI-0558)
#[path = "../src/procgroup.rs"]
mod procgroup;
#[path = "../src/sandbox.rs"]
mod sandbox;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use egress::{ConnectObservation, EgressConfig};
use sandbox::{SandboxSpec, default_deny_read, default_writable_extra};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

fn user_home() -> PathBuf {
    // machine-ok: 実 runtime を起こす probe（#[ignore]）。実機の HOME がそのまま測る対象
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()))
}

fn write_executable(path: &Path, body: &str) {
    std::fs::write(path, body).expect("write script");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// 書いた直後の実行 file は macOS が初回起動を数秒止める(lessons 04)。
/// sandbox 内の測定の前に 1 回素で空回しして遅延をここで消化する。
fn dry_run(script: &Path) {
    let _ = std::process::Command::new(script).env("OPENROLY_ATTACK_DRYRUN", "1").output();
}

/// 製品の経路そのまま: sandbox::backend() → self_test → wrap → spawn(stdin null / stdout piped)。
fn sandboxed_spawn(script: &Path, folder: &Path, session_dir: &Path, proxy_port: u16) -> tokio::process::Child {
    let backend = sandbox::backend();
    backend.self_test().expect("seatbelt self_test");
    let spec = SandboxSpec {
        folder: folder.to_path_buf(),
        session_dir: session_dir.to_path_buf(),
        writable_extra: default_writable_extra(&user_home()),
        deny_read: default_deny_read(&user_home()),
        proxy_port,
    };
    let mut cmd = Command::new(script);
    cmd.current_dir(folder);
    let mut wrapped = backend.wrap(cmd, &spec).expect("sandbox wrap");
    wrapped.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    wrapped.spawn().expect("spawn sandboxed script")
}

/// rx を欲しい件数まで最大 `grace` 待ってから排空する(接続処理は非同期なので直後の try_recv は空)。
async fn drain_with_grace(mut rx: UnboundedReceiver<ConnectObservation>, want: usize, grace: Duration) -> Vec<ConnectObservation> {
    let deadline = Instant::now() + grace;
    let mut out = Vec::new();
    while out.len() < want && Instant::now() < deadline {
        match rx.try_recv() {
            Ok(obs) => out.push(obs),
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    while let Ok(obs) = rx.try_recv() {
        out.push(obs);
    }
    out
}

/// 空で無い事を確認する用の猶予付き drain(rx が本当に空である事の陽性対照に使う)。
async fn drain_all(rx: UnboundedReceiver<ConnectObservation>) -> Vec<ConnectObservation> {
    drain_with_grace(rx, usize::MAX, Duration::from_millis(700)).await
}

// ============================================================================
// AC-X1: proxy 素通しの口 —— sandbox は port **番号** でしか絞れない。外部 host が同じ番号で
// listen していれば直接届く(sandbox.rs が 2026-09-07 実測で記録した residual)。
// ここで凍結するのは 2 点: (1) その口が今も在る事(勝手に塞がったら測定の前提が変わる)、
// (2) その直接 egress は **proxy を経由しないので observe に 1 件も現れない事**
// (broker の telemetry から見えない egress = この口の本当の怖さ)。
// ============================================================================

fn en0_ip() -> Option<String> {
    for iface in ["en0", "en1"] {
        if let Ok(out) = std::process::Command::new("ipconfig").args(["getifaddr", iface]).output() {
            let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !ip.is_empty() {
                return Some(ip);
            }
        }
    }
    None
}

#[tokio::test]
async fn review_attack_same_port_external_host_is_reachable_and_invisible() {
    let Some(ip) = en0_ip() else {
        panic!("非 loopback の自機 IP が取れない(en0/en1)。この攻撃は外部 host の同じ port への直接接続を測るので、IP 無しでは成立しない");
    };

    let base = std::env::temp_dir().join(format!("openroly-acp-attack-sameport-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    let session_dir = base.join("session");
    for d in [&folder, &session_dir] {
        std::fs::create_dir_all(d).unwrap();
    }

    // 的を 2 つ: (ip, proxy と同じ port 番号) と (ip, 別の port)。
    let (obs_tx, rx) = unbounded_channel();
    let egress_handle = egress::start(
        EgressConfig { allow: vec!["api.anthropic.com".to_string()], events: None, upstream_override: None, observe: Some(obs_tx) },
        "attack-sameport",
    )
    .unwrap();
    let same_port = egress_handle.port;
    let other = std::net::TcpListener::bind((ip.as_str(), 0)).expect("bind trap on en0 IP");
    let other_port = other.local_addr().unwrap().port();
    // 同じ port 番号の的(en0 IP 側)。egress は 127.0.0.1:{same_port} を掴んでいるので衝突しない。
    let _trap = std::net::TcpListener::bind((ip.as_str(), same_port)).expect("bind trap on en0 IP at the proxy port");

    // sandbox 内から両方に /dev/tcp で繋ぎに行く script(1 行目は dry-run 用の早期 return)。
    let script = folder.join("attack.sh");
    write_executable(
        &script,
        format!(
            "#!/bin/sh\n\
             [ \"${{OPENROLY_ATTACK_DRYRUN}}\" = \"1\" ] && exit 0\n\
             /bin/bash -c 'exec 3<>/dev/tcp/{ip}/{same_port}' 2>/dev/null && echo sameport=ok || echo sameport=deny\n\
             /bin/bash -c 'exec 4<>/dev/tcp/{ip}/{other_port}' 2>/dev/null && echo otherport=ok || echo otherport=deny\n"
        )
        .as_str(),
    );
    dry_run(&script);

    let child = sandboxed_spawn(&script, &folder, &session_dir, same_port);
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .expect("attack script hung in sandbox")
        .expect("wait sandboxed script");
    drop(egress_handle);
    let stdout = String::from_utf8_lossy(&output.stdout);

    // (1) PBI-0441 AC-3: **backend が名乗る値と実物が食い違ったら赤**。`port_scoped` を名乗る間は
    // 同じ port 番号の外部 host に素通りする事を、`host_scoped` を名乗るなら繋がらない事を期待する
    // (pf を入れて host_scoped に変えた時、この検査がそのまま「本当に閉じたか」を測る)。
    let enforcement = sandbox::backend().egress_enforcement();
    match enforcement {
        "port_scoped" => assert!(
            stdout.contains("sameport=ok"),
            "backend は port_scoped と名乗るのに同じ port の外部 host に繋がらない(表示と実物が食い違い): {stdout}"
        ),
        "host_scoped" => assert!(
            stdout.contains("sameport=deny"),
            "backend は host_scoped と名乗るのに同じ port の外部 host に繋がった(表示と実物が食い違い): {stdout}"
        ),
        other => panic!("seatbelt の端末で想定していない egress_enforcement: {other}"),
    }
    if enforcement == "host_scoped" {
        // 閉じた backend では下の「observe に現れない直接 egress」は起きないので、ここで終わる
        let _ = std::fs::remove_dir_all(&base);
        return;
    }
    // 対照: 同じ IP の別 port は seatbelt が deny する(許可が port 番号で scoped している事の確認)。
    assert!(stdout.contains("otherport=deny"), "別 port への直接接続が許されてしまった — sandbox が port で絞れていない: {stdout}");

    // (2) その直接 egress は proxy を経由しないので observe に現れない(= telemetry の盲点)。
    let events = drain_all(rx).await;
    assert!(events.is_empty(), "proxy を経由しない接続が observe に現れた — tap の意味が変わった: {events:?}");

    let _ = std::fs::remove_dir_all(&base);
}

// ============================================================================
// AC-X3: host 集合の混ざり —— 2 session が同時に動いても、session ごとの observe channel は
// 自分の session の CONNECT だけを見る(混線したら AC-1/AC-2 の connects 記録が嘘になる)。
// 両方の session に共通 host を喋らせ、固有 host の行き先だけで判定する
// (membership だけだと共通 host が 2 つの channel に乗った事を検出できないので、件数も数える)。
// ============================================================================

#[tokio::test]
async fn review_attack_two_sessions_observe_channels_do_not_mix() {
    let base = std::env::temp_dir().join(format!("openroly-acp-attack-mix-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    std::fs::create_dir_all(&folder).unwrap();

    let mut handles = Vec::new();
    let mut rxs = Vec::new();
    let mut ports = Vec::new();
    for who in ["a", "b"] {
        let (tx, rx) = unbounded_channel();
        let egress_handle = egress::start(
            EgressConfig { allow: vec![], events: None, upstream_override: None, observe: Some(tx) },
            &format!("attack-mix-{who}"),
        )
        .unwrap();
        ports.push(egress_handle.port);
        rxs.push(rx);
        handles.push(egress_handle);
    }

    let mut scripts = Vec::new();
    for (who, port) in ["a", "b"].iter().zip(&ports) {
        let dir = folder.join(who);
        let session_dir = dir.join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let script = dir.join("adapter.sh");
        write_executable(
            &script,
            format!(
                "#!/bin/sh\n\
                 [ \"${{OPENROLY_ATTACK_DRYRUN}}\" = \"1\" ] && exit 0\n\
                 /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{port} && printf \"CONNECT shared.example:443 HTTP/1.1\\r\\n\\r\\n\" >&3' 2>/dev/null\n\
                 /bin/bash -c 'exec 4<>/dev/tcp/127.0.0.1/{port} && printf \"CONNECT unique-{who}.example:443 HTTP/1.1\\r\\n\\r\\n\" >&4' 2>/dev/null\n"
            )
            .as_str(),
        );
        dry_run(&script);
        scripts.push((dir, session_dir, script));
    }

    let mut children = Vec::new();
    for (i, (dir, session_dir, script)) in scripts.iter().enumerate() {
        children.push((i, sandboxed_spawn(script, dir, session_dir, ports[i])));
    }
    for (_, child) in children {
        let out = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .expect("mix script hung in sandbox")
            .expect("wait mix script");
        assert!(out.status.success(), "mix script exited non-zero: {out:?}");
    }
    drop(handles);

    let a = drain_with_grace(rxs.remove(0), 2, Duration::from_secs(2)).await;
    let b = drain_with_grace(rxs.remove(0), 2, Duration::from_secs(2)).await;
    let hosts = |v: &[ConnectObservation]| -> Vec<String> { v.iter().map(|o| o.host.clone()).collect() };
    let (ha, hb) = (hosts(&a), hosts(&b));
    println!("· session a saw: {ha:?} / session b saw: {hb:?}");

    // 件数まで一致させる(共通 host が両方に見えるのは正しい。固有 host が混ざったら混線)。
    assert_eq!(ha.len(), 2, "session a の観測が 2 件でない: {ha:?}");
    assert_eq!(hb.len(), 2, "session b の観測が 2 件でない: {hb:?}");
    assert!(ha.contains(&"shared.example".to_string()) && ha.contains(&"unique-a.example".to_string()), "a の観測が壊れた: {ha:?}");
    assert!(hb.contains(&"shared.example".to_string()) && hb.contains(&"unique-b.example".to_string()), "b の観測が壊れた: {hb:?}");
    assert!(!ha.contains(&"unique-b.example".to_string()), "b 専用 host が a の observe に混線: {ha:?}");
    assert!(!hb.contains(&"unique-a.example".to_string()), "a 専用 host が b の observe に混線: {hb:?}");

    let _ = std::fs::remove_dir_all(&base);
}

// ============================================================================
// observe tap の盲点: CONNECT 以外(平文 HTTP)の deny は **製品の events では数えるが、
// probe の observe tap には現れない**。これが現状の契約(parse 出来た CONNECT だけ観測)。
// 勝手に変わったら probe の connects[] の意味が変わるので凍結しておく。
// ============================================================================

#[tokio::test]
async fn review_attack_plain_http_denial_is_counted_but_not_observed() {
    let (events_tx, mut events_rx) = unbounded_channel();
    let (obs_tx, obs_rx) = unbounded_channel();
    let egress_handle = egress::start(
        EgressConfig { allow: vec!["allowed.example".to_string()], events: Some(events_tx), upstream_override: None, observe: Some(obs_tx) },
        "attack-plain",
    )
    .unwrap();

    let mut s = TcpStream::connect(("127.0.0.1", egress_handle.port)).await.unwrap();
    s.write_all(b"GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n").await.unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out).await;
    assert!(out.starts_with("HTTP/1.1 403"), "平文 HTTP が中継されてしまった: {out}");

    // 製品 telemetry(events)は拾う —— deny の事実は server に届く。
    let ev = events_rx.try_recv().expect("egress_denied が events に流れていない");
    assert_eq!(ev["type"], "egress_denied");
    assert_eq!(ev["host"], "allowed.example");

    // が、observe tap は空白(parse 出来た CONNECT だけが観測対象 = 現在の契約)。
    drop(egress_handle);
    let events = drain_all(obs_rx).await;
    assert!(events.is_empty(), "平文 HTTP の deny が observe に現れた — tap の契約が変わった: {events:?}");
}
