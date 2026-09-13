//! session ごとの egress proxy(PBI-0238 / 図72)。
//!
//! sandbox(sandbox.rs)は network を loopback の 1 port 以外全部 deny する。その 1 port が
//! ここ —— 127.0.0.1 の空き port で HTTP CONNECT proxy を立て、allowlist(runtime の model host
//! + OpenRoly server)の host だけ upstream へ繋ぐ。他は `403` + broker → server `egress_denied{host}`
//! (host と件数だけ。本文は見ない・運ばない。CONNECT のトンネルは TLS のまま素通し)。
//!
//! CONNECT 以外(absolute-form の平文 HTTP)は **全部 403** —— 平文を中継すると proxy が本文を
//! 運ぶ事になり「proxy で本文を見ない」(スコープ外)の線が崩れる。model API も OpenRoly も https。
//!
//! port は session ごと(AC-X1: 固定 1 port だと別 session の profile が同じ port を許してしまう)。
//! `Egress` を drop すると listener task が abort され port が閉じる = session 終了で proxy を閉じる。

use std::net::SocketAddr;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;

/// runtime → model host(PBI-0240 で catalog の `egress.hosts` に移す。それまでの内蔵表)。
/// 実測 2026-09-04: codex は起動時に chatgpt.com の cloud config bundle が取れないと起動を拒む。
pub fn builtin_hosts(runtime: &str) -> &'static [&'static str] {
    match runtime {
        "claude" => &["api.anthropic.com"],
        "codex" => &["chatgpt.com", "api.openai.com"],
        "gemini" => &["generativelanguage.googleapis.com", "oauth2.googleapis.com"],
        "opencode" => &["models.opencode.ai"],
        "kiro" | "kiro-cli" => &["*.kiro.dev", "*.amazonaws.com"],
        _ => &[],
    }
}

/// 1 session の allowlist = 内蔵表 + OpenRoly server の host(MCP が Cloud に繋ぐ先)。
pub fn hosts_for(runtime: &str, server_host: &str) -> Vec<String> {
    let mut hosts: Vec<String> = builtin_hosts(runtime).iter().map(|s| s.to_string()).collect();
    if !server_host.is_empty() {
        hosts.push(server_host.to_string());
    }
    hosts
}

/// `*.example.com` は subdomain だけ(`example.com` 自身と `evil-example.com` には当たらない)。
/// それ以外は完全一致。大文字小文字は無視、末尾の `.` は落とす。
pub fn allows(allow: &[String], host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    allow.iter().any(|pat| {
        let pat = pat.trim_end_matches('.').to_ascii_lowercase();
        match pat.strip_prefix("*.") {
            Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
            None => host == pat,
        }
    })
}

/// CONNECT の request-target(`host:port`)。host は server へ送る前に形を絞る(攻撃者 = session の
/// 中の runtime が書ける文字列なので、長さと文字種を落として activity に流す)。
fn parse_connect(request_line: &str) -> Option<(String, u16)> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "CONNECT" {
        return None;
    }
    let target = parts.next()?;
    let (host, port) = target.rsplit_once(':')?;
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let port: u16 = port.parse().ok()?;
    if host.is_empty() || host.len() > 253 || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    Some((host.to_ascii_lowercase(), port))
}

/// 1 CONNECT の観測(PBI-0388)。`observe` に流れる形は host/port/allowed だけ ——
/// CONNECT のトンネルは TLS のまま素通しなので、これ以上の中身(header 本文等)は元々見えない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectObservation {
    pub host: String,
    pub port: u16,
    pub allowed: bool,
}

#[derive(Clone)]
pub struct EgressConfig {
    pub allow: Vec<String>,
    /// broker → server の channel(main.rs の results_tx)。`egress_denied` を流す。None = 数えない(test)
    pub events: Option<UnboundedSender<Value>>,
    /// test 用: allowed host を全部この loopback に繋ぐ(実 DNS / 実 network を使わない)
    pub upstream_override: Option<SocketAddr>,
    /// PBI-0388: 1 CONNECT ごとに host/port/allowed を流す測定口。既定 `None` = 製品の挙動は
    /// 1 ミリも変わらない(probe だけがこれを `Some` にする)。
    pub observe: Option<UnboundedSender<ConnectObservation>>,
}

/// 走っている proxy。drop で閉じる。
pub struct Egress {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Egress {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 127.0.0.1 の空き port に bind して serve を始める。tokio runtime の中から呼ぶ。
/// bind 失敗は `sandbox_unavailable`(AC-X2: proxy 無しの session は起こさない)。
pub fn start(config: EgressConfig, request_id: &str) -> Result<Egress, String> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| {
        eprintln!("broker: egress proxy could not bind a loopback port: {e}");
        "sandbox_unavailable".to_string()
    })?;
    std_listener.set_nonblocking(true).map_err(|e| {
        eprintln!("broker: egress proxy listener: {e}");
        "sandbox_unavailable".to_string()
    })?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
    let listener = TcpListener::from_std(std_listener).map_err(|e| {
        eprintln!("broker: egress proxy listener: {e}");
        "sandbox_unavailable".to_string()
    })?;
    let request_id = request_id.to_string();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let config = config.clone();
            let request_id = request_id.clone();
            tokio::spawn(async move {
                let _ = handle(stream, &config, &request_id).await;
            });
        }
    });
    Ok(Egress { port, task })
}

/// 1 接続。request line + header を `\r\n\r\n` まで読み(上限 8KB)、CONNECT で allowlist なら
/// upstream へ繋いで双方向 copy、それ以外は 403。
async fn handle(mut client: TcpStream, config: &EgressConfig, request_id: &str) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = client.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8 * 1024 {
            client.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n").await?;
            return Ok(());
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let request_line = head.lines().next().unwrap_or("");
    let Some((host, port)) = parse_connect(request_line) else {
        // CONNECT でない(平文 HTTP を中継しない)/ 壊れた target。host が読めれば数える
        let host = request_line.split_whitespace().nth(1).unwrap_or("");
        deny(&mut client, config, request_id, &sanitize_host(host)).await;
        return Ok(());
    };
    let allowed = allows(&config.allow, &host);
    if let Some(tx) = &config.observe {
        let _ = tx.send(ConnectObservation { host: host.clone(), port, allowed });
    }
    if !allowed {
        deny(&mut client, config, request_id, &host).await;
        return Ok(());
    }
    let upstream = match config.upstream_override {
        Some(addr) => TcpStream::connect(addr).await,
        None => TcpStream::connect((host.as_str(), port)).await,
    };
    let mut upstream = match upstream {
        Ok(s) => s,
        Err(e) => {
            eprintln!("broker: egress upstream {host}:{port} unreachable: {e}");
            client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n").await?;
            return Ok(());
        }
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

/// activity に流す host の形(CONNECT 以外の行から拾った時用。URL なら host 部だけ)。
fn sanitize_host(target: &str) -> String {
    let t = target.trim_start_matches("http://").trim_start_matches("https://");
    let t = t.split('/').next().unwrap_or("");
    let t = t.rsplit_once(':').map(|(h, _)| h).unwrap_or(t);
    t.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .take(253)
        .collect::<String>()
        .to_ascii_lowercase()
}

async fn deny(client: &mut TcpStream, config: &EgressConfig, request_id: &str, host: &str) {
    let _ = client
        .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        .await;
    eprintln!("broker: egress denied host={host} requestId={request_id}");
    if let Some(tx) = &config.events {
        let _ = tx.send(json!({ "type": "egress_denied", "requestId": request_id, "host": host }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allowlist_is_exact_or_subdomain_only() {
        let allow = v(&["api.anthropic.com", "*.kiro.dev"]);
        assert!(allows(&allow, "api.anthropic.com"));
        assert!(allows(&allow, "API.Anthropic.COM."));
        assert!(!allows(&allow, "evil.api.anthropic.com"));
        assert!(!allows(&allow, "notapi.anthropic.com"));
        assert!(!allows(&allow, "api.anthropic.com.evil.example"));
        assert!(allows(&allow, "runtime.kiro.dev"));
        assert!(allows(&allow, "a.b.kiro.dev"));
        assert!(!allows(&allow, "kiro.dev"), "wildcard は subdomain だけ");
        assert!(!allows(&allow, "evil-kiro.dev"));
        assert!(!allows(&allow, ""));
        assert!(!allows(&[], "api.anthropic.com"));
    }

    #[test]
    fn builtin_table_and_server_host() {
        assert_eq!(builtin_hosts("claude"), &["api.anthropic.com"]);
        assert!(builtin_hosts("codex").contains(&"chatgpt.com"));
        assert!(builtin_hosts("unknown-runtime").is_empty());
        let hosts = hosts_for("gemini", "openroly.example");
        assert!(hosts.contains(&"generativelanguage.googleapis.com".to_string()));
        assert!(hosts.contains(&"openroly.example".to_string()));
        assert!(!hosts_for("claude", "").contains(&"".to_string()));
    }

    #[test]
    fn connect_parse_accepts_host_port_and_rejects_junk() {
        assert_eq!(parse_connect("CONNECT api.anthropic.com:443 HTTP/1.1"), Some(("api.anthropic.com".into(), 443)));
        assert_eq!(parse_connect("CONNECT Evil.Example:8443 HTTP/1.1"), Some(("evil.example".into(), 8443)));
        assert_eq!(parse_connect("GET http://x/ HTTP/1.1"), None);
        assert_eq!(parse_connect("CONNECT api.anthropic.com HTTP/1.1"), None);
        assert_eq!(parse_connect("CONNECT a\"b:443 HTTP/1.1"), None);
        assert_eq!(parse_connect(&format!("CONNECT {}:443 HTTP/1.1", "a".repeat(300))), None);
        assert_eq!(sanitize_host("http://evil.example:80/x"), "evil.example");
    }

    /// upstream 役: 1 接続受けて banner を書いて閉じる。
    async fn upstream() -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { break };
                let _ = s.write_all(b"UPSTREAM\n").await;
            }
        });
        addr
    }

    async fn talk(port: u16, request: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    }

    // AC-2: allowed は upstream へ繋ぎ、evil は 403 + egress_denied{host} が 1 件。
    #[tokio::test]
    async fn allowed_connect_tunnels_and_denied_connect_is_403_with_one_event() {
        let up = upstream().await;
        let (tx, mut rx) = unbounded_channel();
        let egress = start(
            EgressConfig { allow: v(&["allowed.example"]), events: Some(tx), upstream_override: Some(up), observe: None },
            "req-1",
        )
        .unwrap();
        let ok = talk(egress.port, "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("UPSTREAM"), "upstream に繋がっていない: {ok}");
        let no = talk(egress.port, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n").await;
        assert!(no.starts_with("HTTP/1.1 403"), "{no}");
        assert!(!no.contains("UPSTREAM"));
        let ev = rx.try_recv().expect("egress_denied が 1 件");
        assert_eq!(ev["type"], "egress_denied");
        assert_eq!(ev["host"], "evil.example");
        assert_eq!(ev["requestId"], "req-1");
        assert!(rx.try_recv().is_err(), "allowed の分は数えない・denied は 1 件だけ");
        // 平文 HTTP(absolute-form)は中継しない
        let plain = talk(egress.port, "GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n").await;
        assert!(plain.starts_with("HTTP/1.1 403"), "{plain}");
        assert_eq!(rx.try_recv().unwrap()["host"], "allowed.example");
    }

    // session 終了で proxy を閉じる: drop の後は port に繋がらない。
    #[tokio::test]
    async fn dropping_egress_closes_the_port() {
        let egress = start(EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None }, "r").unwrap();
        let port = egress.port;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());
        drop(egress);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err(), "drop 後も port が開いている");
    }

    // AC-X3: 2 session は別 port。
    #[tokio::test]
    async fn two_sessions_get_two_ports() {
        let cfg = EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None };
        let a = start(cfg.clone(), "a").unwrap();
        let b = start(cfg, "b").unwrap();
        assert_ne!(a.port, b.port);
    }
}
