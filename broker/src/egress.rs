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

/// runtime → model host(PBI-0240 以降は catalog の `egress.hosts` が正本で、これは offline /
/// cache 腐りでも claude が api host を失わない為の内蔵 fallback。撤去しない = registry.rs の
/// built-in と同じ不変条件)。実測 2026-09-04: codex は起動時に chatgpt.com の cloud config bundle
/// が取れないと起動を拒む。
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

/// 1 session の allowlist = 内蔵表 ∪ catalog の `egress.hosts`(`catalog_hosts`。呼び出し側が
/// 署名検証済み registry から引き出す)∪ OpenRoly server の host(MCP が Cloud に繋ぐ先)。
/// runtime が claude の時は `ANTHROPIC_BASE_URL`(`base_url_env`)の host も足す —— PBI-0388 の実測:
/// 内蔵表が陳腐化すると api.z.ai 経由の機の claude が proxy 403 で落ちる。実機の設定に追随する
/// (無い時は従来どおり内蔵表のみ)。
pub fn hosts_for(
    catalog_hosts: &[String],
    runtime: &str,
    server_host: &str,
    base_url_env: Option<&str>,
) -> Vec<String> {
    let mut hosts: Vec<String> = builtin_hosts(runtime).iter().map(|s| s.to_string()).collect();
    for h in catalog_hosts {
        if !hosts.iter().any(|x| x == h) {
            hosts.push(h.clone());
        }
    }
    if runtime == "claude" {
        if let Some(host) = base_url_env.and_then(base_url_host) {
            if !hosts.iter().any(|x| x == &host) {
                hosts.push(host);
            }
        }
    }
    if !server_host.is_empty() && !hosts.iter().any(|x| x == server_host) {
        hosts.push(server_host.to_string());
    }
    hosts
}

/// `https://api.z.ai/api/anthropic` → `api.z.ai`。scheme が無い / host が空なら None。
/// port は剥がす(allowlist は host 単位。CONNECT の port は対象側で決まる)。
/// userinfo(`user:pass@`)は先に剥がす(review 実測: `:` で split すると `user` が host として
/// 足る = single-label が allowlist に載る)。`*` / bracket / `_` 等の文字は CONNECT 先の host
/// 文字種(`parse_connect` と同じ)に絞って落とす —— wildcard が env から allowlist に広がらない。
fn base_url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or_default().to_ascii_lowercase();
    (!host.is_empty()
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'))
        .then_some(host)
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
///
/// `c1` は同じ session の **pf による host 絞り込み**(PBI-0441 ③)。proxy と同じ寿命で持つ ——
/// どちらも「この session の egress をどこに閉じるか」の機構で、reaper が child を wait した後に
/// この struct を drop すると、proxy の task が止まり `c1::Session` の drop が専用 uid と pf 規則を
/// 戻す。**別の場所で持つと片方だけ残る**(閉じ込めだけ生きて proxy が死ぬ / uid が端末に溜まる)。
pub struct Egress {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
    pub c1: Option<crate::c1::Session>,
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
    Ok(Egress { port, task, c1: None })
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
        let hosts = hosts_for(&[], "gemini", "openroly.example", None);
        assert!(hosts.contains(&"generativelanguage.googleapis.com".to_string()));
        assert!(hosts.contains(&"openroly.example".to_string()));
        assert!(!hosts_for(&[], "claude", "", None).contains(&"".to_string()));
    }

    // PBI-0240 AC-1: catalog の `egress.hosts` は内蔵表と union する(重複しない・catalog が
    // 無くても内蔵が効く)。registry から hosts を引き出す所(main.rs)はここでは測らず slice で受ける
    #[test]
    fn hosts_for_unions_catalog_egress_with_builtin() {
        let hosts = hosts_for(&v(&["api.foo.example"]), "foo", "openroly.example", None);
        assert!(hosts.contains(&"api.foo.example".to_string()));
        assert!(hosts.contains(&"openroly.example".to_string()));
        // 内蔵表を持つ runtime の catalog 側の追加 host も入る(union・重複しない)
        let hosts2 = hosts_for(&v(&["api.anthropic.com", "stats.anthropic.com"]), "claude", "", None);
        assert_eq!(
            hosts2.iter().filter(|h| *h == "api.anthropic.com").count(),
            1,
            "重複して入る: {hosts2:?}"
        );
        assert!(hosts2.contains(&"stats.anthropic.com".to_string()));
        // catalog に hosts が無い runtime は従来どおり内蔵表だけ
        assert!(hosts_for(&[], "codex", "", None).iter().all(|h| h != "api.foo.example"));
    }

    // PBI-0240 AC-6 / PBI-0388 の機序: 端末の ANTHROPIC_BASE_URL(api.z.ai 等の中継)の host を
    // claude の allowlist に足す。codex 等の別 runtime には影響しない
    #[test]
    fn base_url_env_extends_claude_allowlist_only() {
        let hosts = hosts_for(&[], "claude", "", Some("https://api.z.ai/api/anthropic"));
        assert!(hosts.contains(&"api.z.ai".to_string()), "api.z.ai が入っていない: {hosts:?}");
        assert!(hosts.contains(&"api.anthropic.com".to_string()), "内蔵表が消えた: {hosts:?}");
        // codex には載らない(ANTHROPIC_BASE_URL は claude の env)
        let codex = hosts_for(&[], "codex", "", Some("https://api.z.ai/api/anthropic"));
        assert!(!codex.contains(&"api.z.ai".to_string()));
        // 形式: path/query は落ちる・port は剥がす・scheme 無し・空は無視
        assert_eq!(base_url_host("https://api.example.com/v1?x=1"), Some("api.example.com".to_string()));
        assert_eq!(base_url_host("http://API.Example.COM/"), Some("api.example.com".to_string()));
        assert_eq!(base_url_host("https://host:8443/x"), Some("host".to_string()));
        assert_eq!(base_url_host("api.example.com"), None);
        assert_eq!(base_url_host("https://"), None);
        assert_eq!(base_url_host(""), None);
        // review fix: userinfo は剥がして実 host を足す(`user` は足さない)・wildcard / bracket は無視
        assert_eq!(base_url_host("https://user:secret@api.example.com/v1"), Some("api.example.com".to_string()));
        assert_eq!(base_url_host("https://*.example.com/x"), None);
        assert_eq!(base_url_host("http://[::1]:8080/v1"), None);
        assert_eq!(base_url_host("http://localhost:11434/v1"), Some("localhost".to_string()));
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
