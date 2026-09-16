//! runtime profile(PBI-0211)と local catalog の broker 側。正本は端末の file 2 つ(書くのは CLI):
//!
//! - `~/.openroly/profiles.json` —— 同じ binary の provider 差し替え(`claude-zai` 等)。class は署名済み
//!   registry の `adapter: "variant"` entry が持ち、端末の file は「この機に在る」と env(非秘密)だけを持つ
//! - `~/.openroly/catalog.local.json` —— user が `openroly runtimes add` で足した `local-*`
//!
//! ここがやるのは 4 つ: scan への merge(hello に載せる)・variant の wake を `openroly run` に包む・
//! variant の wake の egress allowlist・`local-*` の adopt に端末の native を添える。
//! **file が壊れていても何も止めない**(profile / local を 0 件として続ける = 親の検知は生きる)。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::adopt::Adoption;
use crate::discovery::{self, Found, ScanEnv};
use crate::egress;
use crate::launch::variant_of;
use crate::registry::{self, Registry};

pub const LOCAL_PREFIX: &str = "local-";

/// `$OPENROLY_HOME`(CLI の `openrolyHome` と同じ)→ `~/.openroly`(旧 `~/.atn` だけが在れば引き継ぐ)
pub fn state_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENROLY_HOME") {
        return Some(PathBuf::from(dir));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(crate::env_compat::legacy_dir(home.join(".openroly"), home.join(".atn")))
}

#[derive(Deserialize)]
struct ProfilesFile {
    #[serde(default)]
    profiles: BTreeMap<String, Profile>,
}

#[derive(Deserialize)]
struct Profile {
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct LocalCatalog {
    #[serde(default)]
    entries: Vec<LocalEntry>,
}

#[derive(Deserialize)]
struct LocalEntry {
    id: String,
    #[serde(default)]
    detect: LocalDetect,
    #[serde(default)]
    native: Option<Value>,
}

#[derive(Deserialize, Default)]
struct LocalDetect {
    #[serde(default)]
    binaries: Vec<String>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text)
        .inspect_err(|e| eprintln!("broker: ignoring {path:?} (not readable as JSON: {e})"))
        .ok()
}

fn profiles(dir: &Path) -> BTreeMap<String, Profile> {
    read_json::<ProfilesFile>(&dir.join("profiles.json")).map(|f| f.profiles).unwrap_or_default()
}

fn local_entries(dir: &Path) -> Vec<LocalEntry> {
    read_json::<LocalCatalog>(&dir.join("catalog.local.json")).map(|c| c.entries).unwrap_or_default()
}

/// `local-` + id の文字種。registry と同じ門(id は hello / adopt の kind になる)。shell / interpreter は探さない
fn local_entry_ok(e: &LocalEntry) -> bool {
    e.id.len() > LOCAL_PREFIX.len()
        && e.id.len() <= 64
        && e.id.starts_with(LOCAL_PREFIX)
        && e.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !e.detect.binaries.is_empty()
        && e.detect.binaries.iter().all(|b| !registry::is_forbidden_program(b))
}

/// scan の直後に呼ぶ(main.rs の scan_now)。profile は **親が Found の時だけ**(親の path / version を借りる)、local は
/// registry に無い `local-*` を `detect.binaries` で探す。
pub fn merge(registry: &Registry, dir: Option<&Path>, env: &ScanEnv, found: &mut Vec<Found>) {
    let Some(dir) = dir else { return };
    for class in profiles(dir).keys() {
        let Some(parent) = variant_of(registry, class) else { continue };
        if found.iter().any(|f| &f.id == class) {
            continue;
        }
        let Some(p) = found.iter().find(|f| f.id == parent && f.source != "app").cloned() else { continue };
        found.push(Found { id: class.clone(), version: p.version, source: "profile".to_string(), path: p.path, models: Vec::new() });
    }
    for e in local_entries(dir) {
        if !local_entry_ok(&e) || registry.detector(&e.id).is_some() || found.iter().any(|f| f.id == e.id) {
            continue;
        }
        if let Some((path, source)) = discovery::find_binary(&e.detect.binaries, env) {
            found.push(Found { id: e.id, version: None, source, path: path.to_string_lossy().to_string(), models: Vec::new() });
        }
    }
}

/// `local-*` の adopt にだけ端末の native を添える(server は native を持たない)。server が
/// `local-*` に native を載せてきても端末の物で置き換え、`local-` 以外には端末の native を触らせない。
pub fn with_local_native(mut a: Adoption, dir: Option<&Path>) -> Adoption {
    if a.kind.starts_with(LOCAL_PREFIX) {
        a.native = dir
            .map(local_entries)
            .unwrap_or_default()
            .into_iter()
            .find(|e| e.id == a.kind && local_entry_ok(e))
            .and_then(|e| e.native)
            .filter(Value::is_object);
    }
    a
}

/// profile の base URL(`ANTHROPIC_BASE_URL` を優先し、無ければ最初の `*_BASE_URL`)
fn base_url(dir: Option<&Path>, class: &str) -> Option<String> {
    let env = dir.map(profiles)?.remove(class)?.env;
    env.get("ANTHROPIC_BASE_URL")
        .or_else(|| env.iter().find(|(k, _)| k.ends_with("_BASE_URL")).map(|(_, v)| v))
        .cloned()
}

/// 1 wake の egress allowlist。variant は **broker process の `ANTHROPIC_BASE_URL` を見ない** ——
/// その wake の provider は profile の base URL なので、そちらの host を足す(PBI-0388 と同じ機序:
/// 足さないと proxy の 403 が認証エラーに化ける)。catalog の hosts は class と親の union。
///
/// PBI-0616: model host の正本は registry の `egress.hosts`。`is_builtin_only`(= 配布 registry を
/// 読めていない)の時だけ内蔵表に退避し、どちらでも model host が 0 なら `no_egress_hosts` で起こさない。
pub fn wake_hosts(
    registry: &Registry,
    runtime: &str,
    server_host: &str,
    broker_base_url: Option<&str>,
    dir: Option<&Path>,
) -> Result<Vec<String>, String> {
    let registry_ok = !registry.is_builtin_only();
    let catalog = |id: &str| -> Vec<String> {
        registry.detector(id).and_then(|d| d.egress.as_ref()).map(|e| e.hosts.clone()).unwrap_or_default()
    };
    match variant_of(registry, runtime) {
        Some(parent) => {
            let mut hosts = catalog(runtime);
            hosts.extend(catalog(parent));
            egress::hosts_for(&hosts, registry_ok, parent, server_host, base_url(dir, runtime).as_deref())
        }
        None => egress::hosts_for(&catalog(runtime), registry_ok, runtime, server_host, broker_base_url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch::{self, variant_argv};
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openroly-profiles-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reg() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"claude","detect":{"binaries":["claude"]},"adapter":"official/claude","egress":{"hosts":["api.anthropic.com"]}},
                {"id":"claude-zai","display_name":"Claude Code · Z.AI (GLM)","adapter":"variant","variant":{"of":"claude"},"egress":{"hosts":["api.z.ai"]}},
                {"id":"claude-proxy","adapter":"variant","variant":{"of":"claude"}}
            ]}"#,
            "t",
        )
        .unwrap()
    }

    fn claude_found() -> Found {
        Found { id: "claude".into(), version: Some("2.1".into()), source: "npm".into(), path: "/opt/bin/claude".into(), models: vec![] }
    }

    const ZAI: &str = r#"{"version":1,"profiles":{"claude-zai":{"name":"claude-zai","env":{"ANTHROPIC_BASE_URL":"https://api.z.ai/api/anthropic","ANTHROPIC_DEFAULT_OPUS_MODEL":"glm-5.3"},"secret_env":{"ANTHROPIC_AUTH_TOKEN":"connection:zhipu"}}}}"#;

    // AC-2: 親が Found なら class が source profile で載る(path / version は親の物)
    #[test]
    fn profile_is_found_on_top_of_its_parent() {
        let dir = tmp("found");
        fs::write(dir.join("profiles.json"), ZAI).unwrap();
        let mut found = vec![claude_found()];
        merge(&reg(), Some(&dir), &ScanEnv::default(), &mut found);
        let zai = found.iter().find(|f| f.id == "claude-zai").expect("claude-zai が載っていない");
        assert_eq!((zai.source.as_str(), zai.path.as_str(), zai.version.as_deref()), ("profile", "/opt/bin/claude", Some("2.1")));
    }

    // AC-X2: 親が無い / file が壊れている / registry に class が無い → profile 0 件、親の Found はそのまま
    #[test]
    fn missing_parent_broken_file_or_unknown_class_add_nothing() {
        let dir = tmp("x2");
        fs::write(dir.join("profiles.json"), ZAI).unwrap();
        let mut none: Vec<Found> = vec![];
        merge(&reg(), Some(&dir), &ScanEnv::default(), &mut none);
        assert!(none.is_empty(), "親が無いのに載った: {none:?}");

        fs::write(dir.join("profiles.json"), "{ not json").unwrap();
        let mut found = vec![claude_found()];
        merge(&reg(), Some(&dir), &ScanEnv::default(), &mut found);
        assert_eq!(found, vec![claude_found()]);

        fs::write(dir.join("profiles.json"), r#"{"version":1,"profiles":{"claude-evil":{"env":{}},"claude":{"env":{}}}}"#).unwrap();
        let mut found = vec![claude_found()];
        merge(&reg(), Some(&dir), &ScanEnv::default(), &mut found);
        assert_eq!(found, vec![claude_found()], "registry の variant でない id が profile で載った");
    }

    fn write_exec(p: &Path) {
        fs::write(p, "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    const LOCAL_FOO: &str = r#"{"version":1,"entries":[{"id":"local-foo","display_name":"foo","detect":{"binaries":["foo"]},"native":{"bin":"foo","mcp":{"strategy":"file","path":"~/.foo/mcp.json","format":"json","key":"mcpServers","shape":"map","entry":{"command":"${command}"}}}},{"id":"local-sh","detect":{"binaries":["bash"]},"native":{}},{"id":"claude","detect":{"binaries":["foo"]},"native":{}}]}"#;

    // AC-5: local-foo は binary が在れば Found。shell を探す entry と local- で始まらない id は載せない
    #[test]
    fn local_entries_are_found_by_binary_and_fenced() {
        let dir = tmp("local");
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        write_exec(&bin.join("foo"));
        write_exec(&bin.join("bash"));
        fs::write(dir.join("catalog.local.json"), LOCAL_FOO).unwrap();
        let env = ScanEnv { path_dirs: vec![bin.clone()], ..ScanEnv::default() };
        let mut found = vec![];
        merge(&reg(), Some(&dir), &env, &mut found);
        let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["local-foo"]);
        assert_eq!(found[0].path, bin.join("foo").to_string_lossy());
    }

    fn adoption(kind: &str, native: Option<Value>) -> Adoption {
        Adoption { kind: kind.into(), runtime_id: "rt".into(), token: "par_fake".into(), base_url: "http://h".into(), name: "n".into(), native }
    }

    // AC-5 / AC-X1: local-* には端末の native。server が載せた native は置き換え、local- 以外は触らない
    #[test]
    fn local_native_goes_only_to_local_kinds() {
        let dir = tmp("native");
        fs::write(dir.join("catalog.local.json"), LOCAL_FOO).unwrap();
        let foo = with_local_native(adoption("local-foo", Some(serde_json::json!({"mcp": "from-server"}))), Some(&dir));
        assert_eq!(foo.native.as_ref().and_then(|n| n.pointer("/mcp/path")).and_then(Value::as_str), Some("~/.foo/mcp.json"));
        let claude = with_local_native(adoption("claude", None), Some(&dir));
        assert_eq!(claude.native, None, "local- 以外に端末の native を添えた");
        let unknown = with_local_native(adoption("local-bar", Some(serde_json::json!({"mcp": {}}))), Some(&dir));
        assert_eq!(unknown.native, None, "端末に無い local-* に server の native が残った");
    }

    // AC-3(broker 側): variant の argv は `run <class> --bin <親 path> --` + 親として組んだ argv そのもの
    #[test]
    fn variant_wake_wraps_the_exact_parent_argv() {
        let dir = tmp("argv");
        fs::write(dir.join(".claude.json"), r#"{"mcpServers":{"openroly":{"type":"stdio","command":"bun","args":["/x/server.ts"]}}}"#).unwrap();
        let env = launch::ContainmentEnv {
            claude_config: dir.join(".claude.json"),
            claude_plugin_registry: dir.join("no-plugins.json"),
            codex_config: dir.join("no-codex.toml"),
        };
        let (claude_args, _) = launch::dedicated_launch(&registry::builtin(), "claude", "triage", "hi", "/s", "/f", &env).unwrap();
        let cli = vec!["bun".to_string(), "/repo/openroly.ts".to_string()];
        let (program, args) = variant_argv(&[claude_found()], "claude-zai", "claude", &cli, claude_args.clone()).unwrap();
        assert_eq!(program, "bun");
        let head = ["/repo/openroly.ts", "run", "claude-zai", "--bin", "/opt/bin/claude", "--"];
        assert_eq!(&args[..head.len()], head.map(String::from).as_slice());
        assert_eq!(&args[head.len()..], claude_args.as_slice());
        assert_eq!(variant_argv(&[], "claude-zai", "claude", &[], vec![]).err().as_deref(), Some("openroly_cli_not_found"));
    }

    // AC-6: variant の allowlist は profile の base URL の host。broker env の host は入らない。claude は従来どおり
    #[test]
    fn variant_allowlist_uses_the_profile_base_url_not_the_broker_env() {
        let dir = tmp("egress");
        fs::write(dir.join("profiles.json"), r#"{"version":1,"profiles":{"claude-proxy":{"env":{"ANTHROPIC_BASE_URL":"http://localhost:20128/api"}},"claude-zai":{"env":{"ANTHROPIC_BASE_URL":"https://gw.example.org/anthropic"}}}}"#).unwrap();
        let broker_env = Some("https://broker-env.example.net");
        let zai = wake_hosts(&reg(), "claude-zai", "openroly.example.com", broker_env, Some(&dir)).unwrap();
        assert!(zai.contains(&"gw.example.org".to_string()), "{zai:?}");
        assert!(zai.contains(&"api.z.ai".to_string()) && zai.contains(&"api.anthropic.com".to_string()), "{zai:?}");
        assert!(!zai.contains(&"broker-env.example.net".to_string()), "variant の allowlist に broker env の host: {zai:?}");
        // PBI-0616: class 側に hosts が無い variant も、親の registry の hosts で起きる
        let proxy = wake_hosts(&reg(), "claude-proxy", "openroly.example.com", broker_env, Some(&dir)).unwrap();
        assert!(proxy.contains(&"localhost".to_string()) && !proxy.contains(&"broker-env.example.net".to_string()), "{proxy:?}");
        assert!(proxy.contains(&"api.anthropic.com".to_string()), "親の registry の host が無い: {proxy:?}");
        let claude = wake_hosts(&reg(), "claude", "openroly.example.com", broker_env, Some(&dir)).unwrap();
        assert!(claude.contains(&"broker-env.example.net".to_string()), "{claude:?}");
    }

    // PBI-0616 AC-3 / AC-4: 退避するのは配布 registry を読めない機だけ。読めたのに model host を
    // 持たない entry は起こさない(内蔵表から拾って「起きるが 403」にしない)
    #[test]
    fn wake_hosts_uses_the_builtin_table_only_when_the_registry_is_unreadable() {
        // AC-3: load が built-in に落ちた機(cache 無し / 署名不一致)。内蔵表 + server host で起こす
        let builtin = registry::builtin();
        assert!(builtin.is_builtin_only());
        let claude = wake_hosts(&builtin, "claude", "openroly.example.com", None, None).unwrap();
        assert!(claude.contains(&"api.anthropic.com".to_string()), "内蔵表に退避していない: {claude:?}");
        assert!(claude.contains(&"openroly.example.com".to_string()), "{claude:?}");
        // registry を読めた機では registry の値だけ(同じ id でも内蔵表は混ざらない)
        let reg = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","adapter":"official/claude","egress":{"hosts":["gw.example.org"]}}]}"#,
            "cache",
        )
        .unwrap();
        assert!(!reg.is_builtin_only());
        assert_eq!(wake_hosts(&reg, "claude", "", None, None).unwrap(), vec!["gw.example.org".to_string()]);
        // AC-4: entry は在るが hosts が空 → 起こさない
        let empty = registry::parse(
            r#"{"version":1,"detectors":[{"id":"opencode","adapter":"generic/native","egress":{"hosts":[]}}]}"#,
            "cache",
        )
        .unwrap();
        assert_eq!(
            wake_hosts(&empty, "opencode", "openroly.example.com", None, None).err().as_deref(),
            Some("no_egress_hosts")
        );
        // entry ごと無い runtime も同じ(kiro-cli のように内蔵表にだけ在る id を data 抜きで起こさない)
        assert_eq!(
            wake_hosts(&empty, "kiro-cli", "openroly.example.com", None, None).err().as_deref(),
            Some("no_egress_hosts")
        );
    }

    // PBI-0616 AC-X3: 決めるのは **その時に読めた 1 版**(registry は snapshot で渡る)。
    // 更新中の版が混ざらない = 古い registry は古い答え・新しい registry は新しい答えのまま
    #[test]
    fn each_registry_snapshot_answers_for_itself() {
        let old = registry::parse(r#"{"version":1,"detectors":[{"id":"opencode","egress":{"hosts":["models.opencode.ai"]}}]}"#, "cache").unwrap();
        let new = registry::parse(r#"{"version":2,"detectors":[{"id":"opencode","egress":{"hosts":["models.opencode.ai","api.z.ai"]}}]}"#, "fetched").unwrap();
        assert_eq!(wake_hosts(&old, "opencode", "", None, None).unwrap(), vec!["models.opencode.ai".to_string()]);
        assert_eq!(
            wake_hosts(&new, "opencode", "", None, None).unwrap(),
            vec!["models.opencode.ai".to_string(), "api.z.ai".to_string()]
        );
    }

    // PBI-0544 AC-X2(実 catalog に対する測定): 配布 detectors.v1.json の opencode entry が
    // api.z.ai(Z.AI Coding Plan の model host)を持ち、wake の allowlist に入る。api.z.ai が開くのは
    // opencode の session だけ —— claude(base_url_env 無し)も codex も変わらない。
    // catalog からこの行が消えると、Z.AI 経由の opencode session が proxy 403(= 認証 error に化ける)ので
    // catalog 側の陳腐化をここで赤くする(evidence 検査ではなく broker の判定に近い側で測る)。
    #[test]
    fn opencode_wake_allowlist_has_api_z_ai_and_claude_codex_are_unchanged() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/core/registry/detectors.v1.json"
        );
        let body = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        let reg = registry::parse(&body, "repo").expect("repo catalog が parse を通らない");
        let opencode = wake_hosts(&reg, "opencode", "openroly.example.com", None, None).unwrap();
        assert!(
            opencode.contains(&"api.z.ai".to_string()) && opencode.contains(&"models.opencode.ai".to_string()),
            "opencode の allowlist に model host が足りない: {opencode:?}"
        );
        // claude は base_url_env が無ければ api.anthropic.com のまま(base_url_env 有りの機は
        // hosts_for の別 test が持つ)。codex は常に無関係。
        let claude = wake_hosts(&reg, "claude", "openroly.example.com", None, None).unwrap();
        assert!(!claude.contains(&"api.z.ai".to_string()), "claude に api.z.ai が載った: {claude:?}");
        assert!(claude.contains(&"api.anthropic.com".to_string()), "claude の catalog の host が消えた: {claude:?}");
        let codex = wake_hosts(&reg, "codex", "openroly.example.com", None, None).unwrap();
        assert!(!codex.contains(&"api.z.ai".to_string()), "codex に api.z.ai が載った: {codex:?}");
    }
}
