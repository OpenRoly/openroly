//! PBI-0388: CAP-2 slice A0 — 「user の購読のまま ACP adapter が動くか」を実測する probe。
//!
//! **製品の経路をそのまま使う**: `sandbox::backend()` → `self_test()` → `egress::start()` →
//! `backend.wrap()` → `spawn()`(`spawn_contained` に集約)。allowlist(`egress::hosts_for`)・
//! sandbox の既定(`default_deny_read` / `default_writable_extra`)も製品と同じ関数を呼ぶ ——
//! profile や proxy をここで再実装したら測定にならない。
//!
//! ACP(agentclientprotocol)は newline 区切りの JSON-RPC を stdio でやり取りする(実測: 両 adapter
//! とも `@agentclientprotocol/sdk` の `LineBuffer` が改行区切りで parse する)。依存を足さず手で書く。
//!
//! 実行(重い・実 network / user login を使うので既定では走らない):
//!   `cargo test --manifest-path broker/Cargo.toml --test acp_probe claude -- --ignored --nocapture`
//!   `cargo test --manifest-path broker/Cargo.toml --test acp_probe codex  -- --ignored --nocapture`
//!   `cargo test --manifest-path broker/Cargo.toml --test acp_probe two_sessions -- --ignored --nocapture`

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

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use egress::{ConnectObservation, EgressConfig, Egress};
use sandbox::{SandboxSpec, default_deny_read, default_writable_extra};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

// ============================================================================
// report の形(secret の値は 1 文字も入れない。key 名と在否・短い enum 値だけ)
// ============================================================================

#[derive(Debug, Default, Serialize)]
struct ConnectRecord {
    host: String,
    port: u16,
    allowed: bool,
}

#[derive(Debug, Default, Serialize)]
struct Phases {
    initialize_ms: u128,
    new_ms: u128,
    prompt_ms: u128,
}

#[derive(Debug, Default, Serialize)]
struct ProbeReport {
    runtime: String,
    package: String,
    bin: String,
    /// この run の allowlist が製品の `hosts_for()` そのままか(true)、telemetry host を足した
    /// 2 回目か(false)。
    prod_allowlist: bool,
    allow: Vec<String>,
    /// 値は 1 文字も含まない(key 名 / 在否 / 短い enum だけ)。
    login_evidence: Vec<String>,
    /// "subscription" | "api_key_path" | "failed"
    conclusion: String,
    /// "measured" | "unmeasured"
    subscription: String,
    phases: Option<Phases>,
    exit_status: Option<i32>,
    stop_reason: Option<String>,
    /// `_auth/status_update` の `authStatus.kind`(vendor 拡張。account/email 等の入れ子は捨てる)。
    auth_status_kind: Option<String>,
    /// 応答本文(診断用。1000 文字で切る)。
    response_text: String,
    connects: Vec<ConnectRecord>,
    denied_hosts: Vec<String>,
    error: Option<String>,
    first_attempt_error: Option<String>,
    retried_with_expanded_allowlist: bool,
    stderr_tail: String,
}

/// report 全体を secret pattern で掃く(AC-3)。見つけたら理由を返す(値は返さない)。
fn find_secret_like(text: &str) -> Option<&'static str> {
    const PREFIXES: &[(&str, &str)] =
        &[("sk-ant-", "anthropic key prefix"), ("sk-proj-", "openai project key prefix"), ("ghp_", "github token prefix"), ("AKIA", "aws access key prefix"), ("eyJ", "jwt segment prefix")];
    for (p, why) in PREFIXES {
        if text.contains(p) {
            return Some(why);
        }
    }
    // 40+ 連続の英数 / `_` / `-`(token・key の生値の形。path の `/` はここに含めない)
    let mut run = 0;
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
            run += 1;
            if run >= 40 {
                return Some("40+ contiguous token-like characters");
            }
        } else {
            run = 0;
        }
    }
    None
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    // 多 byte 文字の途中で切ると panic する(有界レビュー実測:`&s[..n]` は boundary を守らない)。
    // 直前の char boundary まで下がってから切る。
    let mut n = n;
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    format!("{}…", &s[..n])
}

// ============================================================================
// JSON-RPC(newline-delimited)。ACP client 依存は足さず手で書く(PBI 技術設計)。
// ============================================================================

#[derive(Debug, Default)]
struct Exchange {
    response_text: String,
    auth_status_kind: Option<String>,
    stop_reason: Option<String>,
}

async fn write_msg(stdin: &mut ChildStdin, value: Value) -> std::io::Result<()> {
    let mut line = serde_json::to_string(&value).expect("json-rpc message must serialize");
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// `want_id` の応答(`result` か `error`)が来るまで読む。副作用として:
/// `session/request_permission` には最小の "cancelled" を返す(無いと turn が止まる)、
/// `session/update` の `agent_message_chunk` は `ex.response_text` に積む、
/// `_auth/status_update` は `authStatus.kind` だけ拾う(account/email 等の入れ子は捨てる)。
async fn wait_for_id(
    reader: &mut Lines<BufReader<ChildStdout>>,
    stdin: &mut ChildStdin,
    ex: &mut Exchange,
    want_id: i64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("timeout waiting for id={want_id}"));
        }
        let line = match tokio::time::timeout(remaining, reader.next_line()).await {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => return Err(format!("eof waiting for id={want_id} (process exited)")),
            Ok(Err(e)) => return Err(format!("read error waiting for id={want_id}: {e}")),
            Err(_) => return Err(format!("timeout waiting for id={want_id}")),
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue; // adapter が stdout に非 JSON-RPC 行(banner 等)を混ぜても無視する
        };
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            match method {
                "session/request_permission" => {
                    if let Some(id) = msg.get("id").cloned() {
                        let resp = json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "cancelled"}}});
                        let _ = write_msg(stdin, resp).await;
                    }
                }
                "session/update" => {
                    if let Some(update) = msg.get("params").and_then(|p| p.get("update"))
                        && update.get("sessionUpdate").and_then(|s| s.as_str()) == Some("agent_message_chunk")
                        && let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str())
                    {
                        ex.response_text.push_str(text);
                    }
                }
                "_auth/status_update" => {
                    if let Some(kind) = msg
                        .get("params")
                        .and_then(|p| p.get("authStatus"))
                        .and_then(|a| a.get("kind"))
                        .and_then(|k| k.as_str())
                    {
                        ex.auth_status_kind = Some(kind.to_string());
                    }
                }
                _ => {}
            }
        }
        if msg.get("id").and_then(Value::as_i64) == Some(want_id)
            && (msg.get("result").is_some() || msg.get("error").is_some())
        {
            if let Some(err) = msg.get("error") {
                return Err(format!("jsonrpc error for id={want_id}: {err}"));
            }
            return Ok(msg);
        }
    }
}

/// `initialize` → `session/new` → `session/prompt`("Reply with exactly: OK")の 1 turn。
/// 各 phase が完走するたびに `phases` を埋める(**途中で失敗しても済んだ phase の壁時間は report に残る**。
/// 有界レビュー実測: AC-1 が prompt で失敗した時、済んだ initialize/new の壁時間が捨てられていた)。
async fn run_session(
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    folder: &str,
    phases: &mut Phases,
) -> Result<Exchange, String> {
    let mut reader = BufReader::new(stdout).lines();
    let mut ex = Exchange::default();

    let t0 = Instant::now();
    write_msg(&mut stdin, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}}}))
        .await
        .map_err(|e| format!("write initialize: {e}"))?;
    wait_for_id(&mut reader, &mut stdin, &mut ex, 1, Duration::from_secs(20)).await?;
    phases.initialize_ms = t0.elapsed().as_millis();

    let t1 = Instant::now();
    write_msg(&mut stdin, json!({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": folder, "mcpServers": []}}))
        .await
        .map_err(|e| format!("write session/new: {e}"))?;
    let new_resp = wait_for_id(&mut reader, &mut stdin, &mut ex, 2, Duration::from_secs(30)).await?;
    phases.new_ms = t1.elapsed().as_millis();
    let session_id = new_resp
        .get("result")
        .and_then(|r| r.get("sessionId"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| "session/new: result has no sessionId".to_string())?
        .to_string();

    let t2 = Instant::now();
    write_msg(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "Reply with exactly: OK"}]}}),
    )
    .await
    .map_err(|e| format!("write session/prompt: {e}"))?;
    let prompt_resp = wait_for_id(&mut reader, &mut stdin, &mut ex, 3, Duration::from_secs(45)).await?;
    phases.prompt_ms = t2.elapsed().as_millis();
    ex.stop_reason = prompt_resp.get("result").and_then(|r| r.get("stopReason")).and_then(|s| s.as_str()).map(String::from);

    Ok(ex)
}

// ============================================================================
// sandbox + egress + spawn(製品の経路そのまま。PBI-0238 の launch_in の contained 分岐と同じ組み方)
// ============================================================================

fn user_home() -> PathBuf {
    // machine-ok: 実 runtime を起こす probe（#[ignore]）。実機の HOME がそのまま測る対象
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()))
}

/// `sandbox::backend()` → `self_test()` → `egress::start()` → `backend.wrap()` → `spawn()`。
/// stdin/stdout/stderr は piped(呼び出し側が JSON-RPC を話すか、単に drop するかを選ぶ)。
fn spawn_contained(
    program: &Path,
    args: &[&str],
    folder: &Path,
    session_dir: &Path,
    allow: Vec<String>,
) -> Result<(Child, Egress, UnboundedReceiver<ConnectObservation>), String> {
    // 実行可能な file 以外は先に弾く(AC-X2)。`sandbox-exec` は binary の欠落を **自分の exit code** で
    // 報告するので、wrap 後に spawn しても Rust の `spawn()` 自体は成功してしまい(起きるのは
    // sandbox-exec であって adapter ではない)、"session を起こさず" の契約が崩れる。
    // 有界レビュー実測: `exists()` は directory も通す → directory を指した path で 20s の
    // session timeout まで黙って待たされていた。`is_file()` に締める。
    if !program.is_file() {
        return Err(format!("adapter_launch_failed: {} is not a file", program.display()));
    }
    let backend = sandbox::backend();
    backend.self_test().map_err(|e| format!("sandbox_unavailable: {e}"))?;
    let (tx, rx) = unbounded_channel();
    let egress = egress::start(EgressConfig { allow, events: None, upstream_override: None, observe: Some(tx) }, "acp-probe")
        .map_err(|e| format!("sandbox_unavailable: {e}"))?;
    let spec = SandboxSpec {
        folder: folder.to_path_buf(),
        session_dir: session_dir.to_path_buf(),
        writable_extra: default_writable_extra(&user_home()),
        deny_read: default_deny_read(&user_home()),
        proxy_port: egress.port,
    };
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.current_dir(folder);
    let proxy = format!("http://127.0.0.1:{}", egress.port);
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
        cmd.env(key, &proxy);
    }
    cmd.env("NO_PROXY", "").env("no_proxy", "").env("NODE_USE_ENV_PROXY", "1");
    // `wrap()` は新しい `Command::new(SANDBOX_EXEC)` を組み立てて返す(program/args/env/cwd しか
    // 写せない ——`Command` は stdio の設定を読み返す口を持たない)。stdio は**wrap の後**に
    // 付ける契約(sandbox.rs の `SandboxBackend::wrap` doc)。ここより前に呼んでも黙って捨てられる。
    let mut wrapped = backend.wrap(cmd, &spec).map_err(|e| format!("adapter_launch_failed: sandbox wrap: {e}"))?;
    wrapped.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = wrapped.spawn().map_err(|e| format!("adapter_launch_failed: spawn: {e}"))?;
    Ok((child, egress, rx))
}

#[derive(Debug, Default)]
struct AttemptOutcome {
    phases: Option<Phases>,
    exit_status: Option<i32>,
    stop_reason: Option<String>,
    response_text: String,
    auth_status_kind: Option<String>,
    connects: Vec<ConnectRecord>,
    error: Option<String>,
    stderr_tail: String,
}

async fn run_one_attempt(adapter_bin: &Path, folder: &Path, session_dir: &Path, allow: Vec<String>, budget: Duration) -> AttemptOutcome {
    let (mut child, egress, mut rx) = match spawn_contained(adapter_bin, &[], folder, session_dir, allow) {
        Ok(v) => v,
        Err(e) => return AttemptOutcome { error: Some(e), ..Default::default() },
    };
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_tail_writer = stderr_tail.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut buf = stderr_tail_writer.lock().unwrap();
            if buf.len() < 4000 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    });

    let folder_str = folder.to_string_lossy().to_string();
    let mut phases = Phases::default();
    let session_result = tokio::time::timeout(budget, run_session(stdin, stdout, &folder_str, &mut phases)).await;

    let _ = child.start_kill();
    let exit_status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await.ok().and_then(|r| r.ok()).and_then(|s| s.code());
    stderr_task.abort();
    drop(egress); // proxy port を閉じる(AC-X3: session ごとに閉じて他 session と混ざらない)

    let mut connects = Vec::new();
    while let Ok(obs) = rx.try_recv() {
        connects.push(ConnectRecord { host: obs.host, port: obs.port, allowed: obs.allowed });
    }
    let stderr_tail_final = stderr_tail.lock().unwrap().clone();

    match session_result {
        Ok(Ok(ex)) => AttemptOutcome {
            phases: Some(phases),
            exit_status,
            stop_reason: ex.stop_reason,
            response_text: ex.response_text,
            auth_status_kind: ex.auth_status_kind,
            connects,
            error: None,
            stderr_tail: stderr_tail_final,
        },
        // spawn が成功した以上、済んだ phase の壁時間は部分でも report に残す(失敗の位置の証拠)。
        Ok(Err(e)) => AttemptOutcome { phases: Some(phases), exit_status, connects, error: Some(e), stderr_tail: stderr_tail_final, ..Default::default() },
        Err(_) => AttemptOutcome { phases: Some(phases), exit_status, connects, error: Some("turn_timeout".to_string()), stderr_tail: stderr_tail_final, ..Default::default() },
    }
}

// ============================================================================
// 実 adapter(claude / codex)を回す probe 本体
// ============================================================================

struct ProbeSpec {
    runtime: &'static str,
    package: &'static str,
    bin: &'static str,
    login_evidence: Vec<String>,
    /// この機の login state から「購読が測れているか」(false = codex の未 login 機。AC-2 の既定)。
    subscription_measured: bool,
    /// login_evidence から読める「購読らしさ」の既定推定(`_auth/status_update` が来なかった時の保険)。
    login_looks_like_subscription: bool,
}

async fn run_probe(spec: ProbeSpec, adapter_bin: PathBuf) -> ProbeReport {
    let base = std::env::temp_dir().join(format!("openroly-acp-probe-{}-{}", spec.runtime, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    let session_dir = base.join("session");
    for d in [&folder, &session_dir] {
        let _ = std::fs::create_dir_all(d);
    }

    // catalog の egress.hosts 分は main.rs が registry から足す(この test binary は registry module
        // を持たない)。ここでは内蔵表 + server host の面を測る
        let prod_allow = egress::hosts_for(&[], false, spec.runtime, "", None).unwrap_or_default();
    let attempt1 = run_one_attempt(&adapter_bin, &folder, &session_dir, prod_allow.clone(), Duration::from_secs(55)).await;
    let success1 = attempt1.error.is_none() && attempt1.response_text.trim() == "OK";

    let denied: Vec<String> = {
        let mut d: Vec<String> = attempt1.connects.iter().filter(|c| !c.allowed).map(|c| c.host.clone()).collect();
        d.sort();
        d.dedup();
        d
    };

    let (final_attempt, retried, first_attempt_error, prod_allowlist, allow_used, mut connects) = if !success1 && !denied.is_empty() {
        let mut expanded = prod_allow.clone();
        expanded.extend(denied.iter().cloned());
        let attempt2 = run_one_attempt(&adapter_bin, &folder, &session_dir, expanded.clone(), Duration::from_secs(55)).await;
        (attempt2, true, attempt1.error.clone(), false, expanded, attempt1.connects)
    } else {
        // attempt1 がそのまま final_attempt になる(下で final_attempt.connects を足す)ので、
        // ここでの持ち出しは空にする —— 両方に入れると同じ connect が二重に report へ乗る。
        (attempt1, false, None, true, prod_allow.clone(), Vec::new())
    };
    connects.extend(final_attempt.connects.iter().map(|c| ConnectRecord { host: c.host.clone(), port: c.port, allowed: c.allowed }));

    let _ = std::fs::remove_dir_all(&base);

    let success = final_attempt.error.is_none() && final_attempt.response_text.trim() == "OK";
    let subscription_signal = subscription_signal(final_attempt.auth_status_kind.as_deref(), spec.login_looks_like_subscription);
    let conclusion = if success {
        if subscription_signal { "subscription" } else { "api_key_path" }
    } else {
        "failed"
    }
    .to_string();
    let error = final_attempt.error.clone().or_else(|| {
        (!success).then(|| format!("reply was not exactly \"OK\": {:?}", truncate(&final_attempt.response_text, 200)))
    });

    ProbeReport {
        runtime: spec.runtime.to_string(),
        package: spec.package.to_string(),
        bin: spec.bin.to_string(),
        prod_allowlist,
        allow: allow_used,
        login_evidence: spec.login_evidence,
        conclusion,
        subscription: if spec.subscription_measured { "measured" } else { "unmeasured" }.to_string(),
        phases: final_attempt.phases,
        exit_status: final_attempt.exit_status,
        stop_reason: final_attempt.stop_reason,
        auth_status_kind: final_attempt.auth_status_kind,
        response_text: truncate(&final_attempt.response_text, 1000),
        connects,
        denied_hosts: denied,
        error,
        first_attempt_error,
        retried_with_expanded_allowlist: retried,
        stderr_tail: truncate(&final_attempt.stderr_tail, 2000),
    }
}

/// npm package を temp dir に install して bin の実 path を返す(sandbox の**外**で 1 回。
/// PBI 技術設計: install は sandbox 内でやると `~/.npm` cache への書込みで落ちる)。
/// 既にその bin が在れば再 install しない(実行のたびに 15〜20 秒待たない)。
async fn ensure_adapter_installed(package: &str, bin_name: &str) -> Result<PathBuf, String> {
    let safe = package.replace(['/', '@'], "_");
    let dir = std::env::temp_dir().join(format!("openroly-acp-probe-install-{safe}"));
    let bin_path = dir.join("node_modules").join(".bin").join(bin_name);
    if bin_path.exists() {
        return Ok(bin_path);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create install dir {dir:?}: {e}"))?;
    let dir2 = dir.clone();
    let package_for_cmd = package.to_string();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("npm")
            .args(["install", "--prefix"])
            .arg(&dir2)
            .arg(&package_for_cmd)
            .args(["--no-audit", "--no-fund"])
            .output()
    })
    .await
    .map_err(|e| format!("npm install task panicked: {e}"))?
    .map_err(|e| format!("npm install did not start: {e}"))?;
    if !output.status.success() {
        return Err(format!("npm install {package} failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    if !bin_path.exists() {
        return Err(format!("npm install {package} did not produce {bin_path:?}"));
    }
    Ok(bin_path)
}

fn claude_login_evidence() -> (Vec<String>, bool) {
    let has_key = std::env::var("ANTHROPIC_API_KEY").is_ok();
    (vec![format!("ANTHROPIC_API_KEY env set={has_key}")], !has_key)
}

fn codex_home() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => user_home().join(".codex"),
    }
}

/// `~/.codex/auth.json` の**形だけ**を読む(値は 1 文字も持ち出さない)。
fn codex_login_evidence() -> (Vec<String>, bool /* subscription_measured */, bool /* looks like subscription */) {
    let path = codex_home().join("auth.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (vec![format!("{} not readable", path.display())], false, false);
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return (vec!["auth.json is not valid JSON".to_string()], false, false);
    };
    let has_tokens = v.get("tokens").map(Value::is_object).unwrap_or(false);
    let has_api_key = v.get("OPENAI_API_KEY").map(|k| !k.is_null()).unwrap_or(false);
    let mut evidence = vec![format!("tokens field present={has_tokens}"), format!("OPENAI_API_KEY field non-null={has_api_key}")];
    if let Some(mode) = v.get("auth_mode").and_then(Value::as_str) {
        evidence.push(format!("auth_mode={mode}"));
    }
    (evidence, has_tokens, has_tokens)
}

fn subscription_signal(kind: Option<&str>, looks: bool) -> bool {
    match kind {
        Some("account") => true,
        // 実測 2026-09-07: claude は turn が**成功**しても `_auth/status_update` の kind を
        // "none" で流す(「identity signal 無し」= 測定不能なので、login evidence の既定推定に落ちる)。
        // これを api-key path の証拠にすると、成功 turn まで「api_key_path」と嘘をつく。
        Some("none") | None => looks,
        // vendor 拡張で別の kind が来たら購読の証拠には使えない(unknown は否定的に取る)。
        Some(_) => false,
    }
}

#[cfg(test)]
mod subscription_signal_tests {
    use super::subscription_signal;

    // 実測の凍結: claude は成功 turn でも kind "none" を流す → evidence に落ちる。
    #[test]
    fn claude_none_kind_falls_back_to_login_evidence() {
        assert!(subscription_signal(Some("none"), true), "成功 turn + evidence が購読らしければ購読と結論すべき(実測: kind=none は成功 turn でも流れる)");
        assert!(!subscription_signal(Some("none"), false));
        assert!(subscription_signal(None, true));
        assert!(subscription_signal(Some("account"), false), "account は evidence がどうであれ購読の証拠");
        assert!(!subscription_signal(Some("email"), false), "未知の kind は購読の証拠にならない");
    }
}

fn print_report(report: &ProbeReport) {
    let json = serde_json::to_string_pretty(report).unwrap();
    println!("=== acp probe report: {} ===\n{json}", report.runtime);
    assert!(
        find_secret_like(&json).is_none(),
        "report contains a secret-like pattern for {}: {json}",
        report.runtime
    );
}

// ============================================================================
// AC-1 / AC-2: 実 adapter を実際に起こす(実 network・user login を使うので既定では走らない)
// ============================================================================

#[tokio::test]
#[ignore = "実 npm install + 実 claude-agent-acp + 実 network/login を使う"]
async fn acp_probe_claude() {
    let bin = ensure_adapter_installed("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")
        .await
        .expect("claude-agent-acp install");
    let (evidence, looks_subscription) = claude_login_evidence();
    let report = run_probe(
        ProbeSpec {
            runtime: "claude",
            package: "@agentclientprotocol/claude-agent-acp",
            bin: "claude-agent-acp",
            login_evidence: evidence,
            subscription_measured: true, // claude は env の在否だけで常に判定できる(AC-1 に「未測定」枝は無い)
            login_looks_like_subscription: looks_subscription,
        },
        bin,
    )
    .await;
    print_report(&report);
    assert!(report.phases.is_some() || report.error.is_some(), "no phases and no error — probe did not run");
    if let Some(phases) = &report.phases {
        let total = phases.initialize_ms + phases.new_ms + phases.prompt_ms;
        assert!(total < 60_000, "AC-1: turn did not finish within 60s (took {total}ms)");
    }
}

#[tokio::test]
#[ignore = "実 npm install + 実 codex-acp + 実 network/login を使う"]
async fn acp_probe_codex() {
    let bin = ensure_adapter_installed("@agentclientprotocol/codex-acp", "codex-acp").await.expect("codex-acp install");
    let (evidence, subscription_measured, looks_subscription) = codex_login_evidence();
    let report = run_probe(
        ProbeSpec {
            runtime: "codex",
            package: "@agentclientprotocol/codex-acp",
            bin: "codex-acp",
            login_evidence: evidence,
            subscription_measured,
            login_looks_like_subscription: looks_subscription,
        },
        bin,
    )
    .await;
    print_report(&report);
    if report.subscription == "unmeasured" {
        println!("· codex: 購読は未測定(`codex login` 待ち)");
    }
    assert!(report.phases.is_some() || report.error.is_some(), "no phases and no error — probe did not run");
}

// ============================================================================
// AC-X3: 2 session を同時に起こし、observe が混ざらない事を見る
// ============================================================================

#[tokio::test]
#[ignore = "実 npm install + 実 claude-agent-acp/codex-acp + 実 network/login を同時に使う"]
async fn acp_probe_two_sessions() {
    let claude_bin = ensure_adapter_installed("@agentclientprotocol/claude-agent-acp", "claude-agent-acp").await.expect("claude-agent-acp install");
    let codex_bin = ensure_adapter_installed("@agentclientprotocol/codex-acp", "codex-acp").await.expect("codex-acp install");
    let (claude_evidence, claude_looks_sub) = claude_login_evidence();
    let (codex_evidence, codex_sub_measured, codex_looks_sub) = codex_login_evidence();

    let claude_fut = run_probe(
        ProbeSpec {
            runtime: "claude",
            package: "@agentclientprotocol/claude-agent-acp",
            bin: "claude-agent-acp",
            login_evidence: claude_evidence,
            subscription_measured: true,
            login_looks_like_subscription: claude_looks_sub,
        },
        claude_bin,
    );
    let codex_fut = run_probe(
        ProbeSpec {
            runtime: "codex",
            package: "@agentclientprotocol/codex-acp",
            bin: "codex-acp",
            login_evidence: codex_evidence,
            subscription_measured: codex_sub_measured,
            login_looks_like_subscription: codex_looks_sub,
        },
        codex_bin,
    );
    let (claude_report, codex_report) = tokio::join!(claude_fut, codex_fut);
    print_report(&claude_report);
    print_report(&codex_report);

    // AC-X3: 互いの CONNECT host が混ざらない。claude / codex の内蔵 host 表は互いに素なので、
    // 相手の host が自分の connects に出たら proxy(port ごとに別 = AC-X1)か observe channel が
    // 混線している(直接の membership 検査 —— allowlist 経由の判定は disjoint な表では常に真になり
    // 何も検出できない)。
    let claude_hosts: Vec<&str> = claude_report.connects.iter().map(|c| c.host.as_str()).collect();
    let codex_hosts: Vec<&str> = codex_report.connects.iter().map(|c| c.host.as_str()).collect();
    for h in egress::builtin_hosts("codex") {
        assert!(!claude_hosts.contains(h), "claude 側の connects に codex 専用 host {h} が混入(混線)");
    }
    for h in egress::builtin_hosts("claude") {
        assert!(!codex_hosts.contains(h), "codex 側の connects に claude 専用 host {h} が混入(混線)");
    }
    println!("· claude connects: {claude_hosts:?}");
    println!("· codex connects: {codex_hosts:?}");
}

// ============================================================================
// AC-3: report の形と secret-scan(実 network 不要。fixture で armed を確かめる)
// ============================================================================

#[test]
fn acp_probe_report_shape() {
    let safe = ProbeReport {
        runtime: "claude".to_string(),
        package: "@agentclientprotocol/claude-agent-acp".to_string(),
        bin: "claude-agent-acp".to_string(),
        prod_allowlist: true,
        allow: vec!["api.anthropic.com".to_string()],
        login_evidence: vec!["ANTHROPIC_API_KEY env set=false".to_string()],
        conclusion: "subscription".to_string(),
        subscription: "measured".to_string(),
        phases: Some(Phases { initialize_ms: 1500, new_ms: 11000, prompt_ms: 7000 }),
        exit_status: Some(0),
        stop_reason: Some("end_turn".to_string()),
        auth_status_kind: Some("account".to_string()),
        response_text: "OK".to_string(),
        connects: vec![ConnectRecord { host: "api.anthropic.com".to_string(), port: 443, allowed: true }],
        denied_hosts: vec![],
        error: None,
        first_attempt_error: None,
        retried_with_expanded_allowlist: false,
        stderr_tail: String::new(),
    };
    let json = serde_json::to_string_pretty(&safe).unwrap();
    assert!(json.contains("\"conclusion\": \"subscription\""));
    assert!(json.contains("\"connects\""));
    assert!(find_secret_like(&json).is_none(), "false positive on a clean report: {json}");

    // 負の対照(armed-tests): 明らかな secret 形を混ぜたら本当に検出できるか
    let mut dirty = safe;
    dirty.response_text = "leaked sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    let dirty_json = serde_json::to_string_pretty(&dirty).unwrap();
    assert!(find_secret_like(&dirty_json).is_some(), "secret scan did not fire on an injected sk-ant- pattern — the scan is not armed");

    let dirty2 = ProbeReport { stderr_tail: "x".repeat(45), ..ProbeReport::default() };
    assert!(find_secret_like(&serde_json::to_string(&dirty2).unwrap()).is_some(), "secret scan did not fire on a 45-char token-like run");
}

// 有界レビュー攻撃(AC-3 の境界): 負の対照が **両側** で武装しているか。発火の直前 1 文字違い
// を通す側も無いと「何でも fire する過剰一致」か「境界が藪」か分からない。
#[test]
fn acp_probe_secret_scan_boundary_is_two_sided() {
    // 発火する側(prefix 3 種 + 40 文字の閾値そのもの)
    assert!(find_secret_like("jwt eyJhbGciOiJIUzI1NiJ9.payload.sig").is_some(), "jwt segment prefix did not fire");
    assert!(find_secret_like("key = sk-proj-abcdefghij").is_some(), "openai project key prefix did not fire");
    assert!(find_secret_like(&"a".repeat(40)).is_some(), "40-char run did not fire");
    // 通す側(直前の 1 文字違い)。ここで fire したら scan が過剰で report が実用に耐えない。
    assert_eq!(find_secret_like("jwt eyKhbGciOiJIUzI1NiJ9"), None, "eyJ から 1 文字違いで fire した(過剰一致)");
    assert_eq!(find_secret_like("key = sk-proX-abcdefghij"), None, "sk-proj- の綴り違いで fire した(過剰一致)");
    assert_eq!(find_secret_like(&"a".repeat(39)), None, "39-char run fired (boundary loose)");
    // 連続 run は区切りで切れる(39+区切り+39 は 40 を越えない)。
    assert_eq!(find_secret_like(&format!("{}={}{}", "a".repeat(39), "=", "b".repeat(39))), None, "runs separated by a delimiter must not concatenate");
}

// 有界レビュー攻撃(truncate): 多 byte 文字の境界。旧実装 `&s[..n]` は boundary の途中で切って
// panic した(AC-1 の response_text に日本語が混ざった時点で probe が死ぬ = 測定が消える)。
#[test]
fn acp_probe_truncate_survives_multibyte_boundary() {
    let s = "あ".repeat(600); // 1800 byte
    let out = truncate(&s, 1000);
    assert!(out.ends_with('…'), "truncated output should end with the ellipsis");
    assert!(out.len() <= 1000 + 3, "truncated output must not exceed n + ellipsis: {}", out.len());
    assert_eq!(out.chars().count(), 333 + 1, "333 全角 + …のはず");

    // 境界のぴったり側: len == n は切らない・省略なし。
    let exact = "あ".repeat(333); // 999 byte
    assert_eq!(truncate(&exact, 999), exact, "len == n は切らない");

    // n が boundary の真ん中に来る時は 1 文字手前まで下がって切る(999 byte → 333 文字ぶん)。
    let out2 = truncate(&s, 999);
    assert!(out2.len() <= 999 + 3 && out2.ends_with('…'), "{out2}");
}

// ============================================================================
// AC-X2: fail-closed(実 network 不要)
// ============================================================================

#[tokio::test]
async fn acp_probe_fail_closed_on_missing_binary() {
    let base = std::env::temp_dir().join(format!("openroly-acp-probe-failclosed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    let session_dir = base.join("session");
    for d in [&folder, &session_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    let missing = base.join("no-such-adapter-binary");
    let outcome = run_one_attempt(&missing, &folder, &session_dir, vec!["api.anthropic.com".to_string()], Duration::from_secs(5)).await;
    assert!(outcome.error.as_deref().unwrap_or("").contains("adapter_launch_failed"), "missing binary should fail closed with adapter_launch_failed, got {:?}", outcome.error);
    assert!(outcome.connects.is_empty(), "a session that never spawned should have no CONNECT observations");
    let _ = std::fs::remove_dir_all(&base);
}

// 有界レビュー攻撃(AC-X2 の裏口): `exists()` は directory も true。directory を adapter binary として
// 渡すと旧実装では spawn が進み、sandbox-exec が黙って落ちるか 20s の session timeout まで待たされて
// `adapter_launch_failed` 以外の error になった。`is_file()` で締まった事を凍結する。
#[tokio::test]
async fn acp_probe_fail_closed_on_directory_as_binary() {
    let base = std::env::temp_dir().join(format!("openroly-acp-probe-dirclosed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    let session_dir = base.join("session");
    for d in [&folder, &session_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    let outcome = run_one_attempt(&folder, &folder, &session_dir, vec!["api.anthropic.com".to_string()], Duration::from_secs(5)).await;
    assert!(outcome.error.as_deref().unwrap_or("").contains("adapter_launch_failed"), "directory as binary should fail closed with adapter_launch_failed, got {:?}", outcome.error);
    assert!(outcome.connects.is_empty(), "a session that never spawned should have no CONNECT observations");
    let _ = std::fs::remove_dir_all(&base);
}

/// AC-4 / prod_allowlist の retry ロジックを、実 adapter なしで測る: 偽 adapter が
/// 製品 allowlist(`api.anthropic.com`)には無い telemetry host へも CONNECT しようとする形にし、
/// `run_probe` が (a) 1 回目を製品 allowlist で回す (b) denied host を足した 2 回目を回す
/// (c) 両方の CONNECT を report に残す、を確かめる。ACP を話さない偽 adapter なので 1 回目は
/// 必ず `initialize` 待ちで失敗する(= retry 条件を満たす)。
#[tokio::test]
async fn acp_probe_prod_allowlist_retries_on_denied_telemetry_host() {
    let base = std::env::temp_dir().join(format!("openroly-acp-probe-prodallow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    std::fs::create_dir_all(&folder).unwrap();
    let script = folder.join("fake-adapter.sh");
    // api.anthropic.com は claude の内蔵 allowlist に在る(allowed) / telemetry.example は無い(denied)。
    // 実 network は要らない(egress の allows() 判定は upstream に繋ぐ前に確定するので、
    // 繋がらなくても observe は正しく記録される)。ACP の JSON-RPC は一切話さないので
    // `initialize` 待ちで必ずタイムアウトし、run_probe の retry 条件(失敗 + denied 有り)に入る。
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/'\"$OPENROLY_PROBE_PROXY_PORT\"' && printf \"CONNECT api.anthropic.com:443 HTTP/1.1\\r\\n\\r\\n\" >&3' 2>/dev/null\n\
         /bin/bash -c 'exec 4<>/dev/tcp/127.0.0.1/'\"$OPENROLY_PROBE_PROXY_PORT\"' && printf \"CONNECT telemetry.example:443 HTTP/1.1\\r\\n\\r\\n\" >&4' 2>/dev/null\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    // 書いた直後の実行ファイルは macOS が初回起動を数秒止めることがある(lessons 04)。
    // 陰性対照(seatbelt 内の測定)の前に 1 回素で空回しして、その遅延をここで消化しておく
    // (port=0 は繋がらない事が確定な値。空回しは実行そのものが目的で、繋がるかは見ない)。
    let _ = std::process::Command::new(&script).env("OPENROLY_PROBE_PROXY_PORT", "0").current_dir(&folder).output();

    // fake-adapter.sh は proxy の port を `$OPENROLY_PROBE_PROXY_PORT` から読む形にしてある
    // (spawn_contained が載せる `HTTPS_PROXY` は URL 形なので、この script には直値の env を渡す)。
    // egress の port は spawn の前に確定させる必要があるため、`spawn_contained` を使わず
    // sandbox::backend() → self_test → egress::start → backend.wrap() → spawn をここで直に組む。
    let allow = egress::hosts_for(&[], false, "claude", "", None).expect("claude は内蔵表に host を持つ");
    let session_dir = base.join("session");
    std::fs::create_dir_all(&session_dir).unwrap();
    let backend = sandbox::backend();
    backend.self_test().unwrap();
    let (tx, mut rx2) = unbounded_channel();
    let egress_handle = egress::start(EgressConfig { allow: allow.clone(), events: None, upstream_override: None, observe: Some(tx) }, "acp-probe-fake").unwrap();
    let spec = SandboxSpec {
        folder: folder.clone(),
        session_dir: session_dir.clone(),
        writable_extra: default_writable_extra(&user_home()),
        deny_read: default_deny_read(&user_home()),
        proxy_port: egress_handle.port,
    };
    let mut cmd = Command::new(&script);
    cmd.current_dir(&folder);
    cmd.env("OPENROLY_PROBE_PROXY_PORT", egress_handle.port.to_string());
    let mut wrapped = backend.wrap(cmd, &spec).unwrap();
    wrapped.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child2 = wrapped.spawn().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), child2.wait_with_output()).await.expect("fake adapter script hung").unwrap();
    assert!(output.status.success(), "fake adapter script exited non-zero: {output:?}");
    drop(egress_handle);

    let mut hosts = Vec::new();
    while let Ok(obs) = rx2.try_recv() {
        hosts.push((obs.host, obs.allowed));
    }
    println!("· fake adapter connects: {hosts:?}");
    assert!(hosts.contains(&("api.anthropic.com".to_string(), true)), "allowed host was not observed: {hosts:?}");
    assert!(hosts.contains(&("telemetry.example".to_string(), false)), "denied telemetry host was not observed: {hosts:?}");

    let _ = std::fs::remove_dir_all(&base);
}

// ============================================================================
// AC-X1: sandbox 内から proxy を経由しない直接 egress は EPERM で落ち、observe に現れない
// ============================================================================

#[tokio::test]
async fn acp_probe_no_direct_egress_bypasses_the_proxy() {
    let base = std::env::temp_dir().join(format!("openroly-acp-probe-noegress-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("folder");
    let session_dir = base.join("session");
    for d in [&folder, &session_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    // proxy を経由しない直接 TCP の的(deny と unreachable を区別するため、自分で開いた loopback
    // listener を使う。sandbox.rs の self_test と同じ理由)。
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let other_port = other.local_addr().unwrap().port();

    let script = folder.join("bypass.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\n/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/{other_port}' 2>/dev/null && echo bypass=ok || echo bypass=deny\n"),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let (child, egress_handle, mut rx) = spawn_contained(&script, &[], &folder, &session_dir, vec!["api.anthropic.com".to_string()]).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await.expect("bypass script hung").unwrap();
    drop(egress_handle);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("bypass=deny"), "seatbelt did not deny a direct TCP connect that bypasses the proxy: {stdout}");
    let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(events.is_empty(), "a direct (non-proxied) connect attempt should never reach the egress proxy's observe channel: {events:?}");
    let _ = std::fs::remove_dir_all(&base);
}

