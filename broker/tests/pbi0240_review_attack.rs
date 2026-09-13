//! PBI-0240 の有界レビュー(攻撃)。**AC-6(`ANTHROPIC_BASE_URL` の host 追加)を破りに行く。**
//!
//! 本体の unit test は path/query/port/scheme 無しの面しか測っていない。レビュー指示の急所は
//! 「URL でない値・userinfo 付き・別 port で**余計な host が足されないか**」。`base_url_host` は
//! `split(['/','?',':'])` の 1 手で host を取るので、authority の中に `:` が先に来る形
//! (userinfo)と bracket や wildcard がそのまま allowlist に載る。4 本撃つ:
//!   1. userinfo 付き(`https://user:secret@api.example.com/`)→「user」が足り、実 host が
//!      足らない。single-label が allowlist に入る(実 DNS の search domain 次第で外に繋がる)
//!   2. wildcard host(`https://*.example.com/`)→ allowlist が subdomain 全部に広がる
//!   3. IPv6 bracket(`http://[::1]:8080/`)→「[」が allowlist に入る
//!   4. 対(正常系): userinfo を除いた host は足る —— 直しすぎて AC-6 本体を壊していないか

#[path = "../src/egress.rs"]
mod egress;

use egress::hosts_for;

fn claude_allow(base_url: &str) -> Vec<String> {
    hosts_for(&[], "claude", "", Some(base_url))
}

#[test]
fn userinfo_in_base_url_does_not_add_userinfo_as_host() {
    let hosts = claude_allow("https://user:secret@api.example.com/v1");
    assert!(
        !hosts.iter().any(|h| h == "user"),
        "userinfo の user 部が allowlist に載った: {hosts:?}"
    );
    assert!(
        hosts.iter().any(|h| h == "api.example.com"),
        "実 host が allowlist に入っていない(実機の base url に追随できていない): {hosts:?}"
    );
}

#[test]
fn wildcard_base_url_host_is_not_added() {
    let hosts = claude_allow("https://*.example.com/x");
    assert!(
        !hosts.iter().any(|h| h.starts_with('*')),
        "wildcard が allowlist に載った(subdomain 全部に広がる): {hosts:?}"
    );
}

#[test]
fn ipv6_bracket_base_url_adds_no_bogus_host() {
    let hosts = claude_allow("http://[::1]:8080/v1");
    assert!(
        !hosts.iter().any(|h| h.contains('[') || h.contains(']') || h == "::1" || h.is_empty()),
        "bracket / IPv6 host が allowlist に載った: {hosts:?}"
    );
}

#[test]
fn normal_base_url_still_extends_claude_allowlist() {
    // 直しすぎ検査(対): AC-6 本体の形は今までどおり足る
    for (url, host) in [
        ("https://api.z.ai/api/anthropic", "api.z.ai"),
        ("https://host:8443/x", "host"),
        ("http://localhost:11434/v1", "localhost"),
    ] {
        let hosts = claude_allow(url);
        assert!(hosts.iter().any(|h| h == host), "{url} → {host} が入っていない: {hosts:?}");
    }
}
