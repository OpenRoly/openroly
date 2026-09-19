use std::fs;
use std::path::{Path, PathBuf};

use tokio::process::{Child, Command};

use crate::c1;
use crate::discovery::Found;
use crate::egress::{self, Egress, EgressConfig};
use crate::openroly_cli::cli_argv;
use crate::registry::{self, McpInject, Registry, catalog_kind};
use crate::sandbox::{SandboxBackend, SandboxSpec, default_deny_read, writable_extra};

/// dedicated session の instruction の上限(argv 1 要素)。これを超えると OS の argv 上限で
/// spawn が `spawn failed` に埋もれるため、名前の付いた reason で手前で止める(PBI-0019 AC-11)。
/// Cloud 側は 21 件上限で ≤ 4KB を担保するので、16KB は多層防御の最終境界。
const MAX_INSTRUCTION_BYTES: usize = 16 * 1024;

/// dedicated session 起動時の 1 CLI あたりの最大 turn 数(コスト上限。実測 C: 3 turn で $0.31〜0.39)。
const MAX_TURNS: &str = "40";

/// dedicated session に載せる MCP server 名(runtime 側の登録名。install.ts の `MCP_SERVER_NAME`)。
const MCP_SERVER_NAME: &str = "openroly";

/// claude の `--mcp-config` を置く session_dir 内の名前(PBI-0558 が relay 向けに差し替える file)
const CLAUDE_MCP_CONFIG: &str = "openroly-mcp.json";

/// `launch.headless.argv` の中で、`launch.mcp_inject` が組んだ引数を差し込む位置(PBI-0618)。
/// **要素まるごとがこの綴り**の時だけ 0..N 要素へ展開する。
const MCP_ARGV_SLOT: &str = "${mcp_argv}";

/// 旧 server 名(PBI-0344)。**旧名で登録された自分たちの server は「他人」とは別扱い**:
/// claude の discovery は読み先として受け(reinstall していない端末でも dedicated session が
/// 止まらないように)、codex の disable 一覧には載せない(落とすと旧名登録の端末から
/// 自分の tools が消える)。案内は 1 行で「reinstall して新名へ」と出す。
const LEGACY_MCP_SERVER_NAMES: [&str; 2] = ["paa", "atn"];

/// 新名を先に探す helper。旧名に当たった時だけ 1 行案内を出す。
fn mcp_server_by_name(servers: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(v) = servers.get(MCP_SERVER_NAME) {
        return Some(v.clone());
    }
    LEGACY_MCP_SERVER_NAMES.iter().find_map(|legacy| {
        let v = servers.get(*legacy)?.clone();
        eprintln!(
            "broker: the MCP server is registered under the legacy name \"{legacy}\" — run 'openroly install' again to update it"
        );
        Some(v)
    })
}

/// 閉じ込めの成否を決める外部の状態(path)。実環境の既定は `containment_env()`、test は値で差し替える。
pub struct ContainmentEnv {
    /// claude の user config(`$CLAUDE_CONFIG_DIR` か `$HOME` の `.claude.json`)。
    /// openroly MCP server の定義をここから読んで session_dir へ複製する。
    pub claude_config: PathBuf,
    /// claude の plugin 台帳(`<claude 設定 dir>/plugins/installed_plugins.json`)。
    /// **配布戦略 §7.1 は plugin-first**(図10)で、plugin が持ち込む MCP server は
    /// `.claude.json` の `mcpServers` には**書かれない**(実測 2026-09-02: 同じ機の
    /// fakechat plugin の server が top-level に無い)。台帳の `installPath` から
    /// plugin 同梱の `.mcp.json` を読んで複製元にする —— 無いと plugin で入れた人だけ
    /// 全 dedicated session が containment_unavailable になり、AUTO が黙って止まる。
    pub claude_plugin_registry: PathBuf,
    /// codex の user config(`$CODEX_HOME` か `$HOME/.codex` の `config.toml`)。
    /// codex には claude の `--strict-mcp-config` に相当する flag が無く、dedicated session でも
    /// **user が設定した MCP server を全部載せる**(実測 2026-09-02: `codex mcp list` に playwright /
    /// obsidian / unityMCP … が並ぶ)。MCP server は sandbox の外で動く別プロセスなので、
    /// `--sandbox read-only` を掛けても攻撃者の本文から network 越しの書込み・持ち出しができる。
    /// ここから server 名を読み、openroly 以外を `-c mcp_servers.<name>.enabled=false` で落とす。
    pub codex_config: PathBuf,
}

/// 実環境の `ContainmentEnv`。
pub fn containment_env() -> ContainmentEnv {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let claude_home = std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| home.clone());
    // plugin dir は CLAUDE_CONFIG_DIR 未設定時だけ `~/.claude/` の下(adapter の skillsDir と同じ規則)。
    let plugin_root = match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => PathBuf::from(&home).join(".claude"),
    };
    ContainmentEnv {
        claude_config: PathBuf::from(claude_home).join(".claude.json"),
        claude_plugin_registry: plugin_root.join("plugins").join("installed_plugins.json"),
        codex_config: match std::env::var("CODEX_HOME") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => PathBuf::from(&home).join(".codex"),
        }
        .join("config.toml"),
    }
}

/// claude の openroly MCP server の定義を抜き、`--mcp-config` に渡せる JSON にする。
/// 探す順序は ① user config(`.claude.json` の `mcpServers.openroly` = `openroly install claude` 経路)
/// → ② plugin 台帳(`installed_plugins.json` → `<installPath>/.mcp.json` = **plugin-first** 経路。
/// 図10 / 配布戦略 §7.1)。どちらでも見つからなければ `containment_unavailable` —— **user settings を
/// 落とすと MCP 登録ごと消える**(実測 2026-09-02: `--setting-sources project` で `openroly` が tool 一覧から
/// 消える)ので、定義を複製できないなら「閉じ込めたまま仕事ができる session」を作れない。
/// 閉じ込めを緩めて起こす選択はしない(便利さより「mail 1 通で shell」を塞ぐ)。
///
/// ② を見るのは、plugin で入れた人の `.claude.json` に `mcpServers.openroly` が**無い**ため
/// (実測 2026-09-02: 同じ機で plugin 由来の fakechat server は top-level `mcpServers` に無く、
/// `openroly install claude` で入れた openroly だけが在る)。① だけだと plugin-first の user は
/// 全 dedicated session が fail-closed になり、AUTO が dispatch_skip の log 1 行だけ残して止まる。
fn claude_mcp_config(config_path: &Path, plugin_registry: &Path) -> Result<String, String> {
    let server = claude_user_mcp_server(config_path)
        .or_else(|| claude_plugin_mcp_server(plugin_registry))
        .ok_or_else(|| {
            eprintln!(
                "broker: the openroly MCP server definition was not found (neither in the user config {config_path:?} \
                 nor in the plugin registry {plugin_registry:?}). Cannot start it contained, so not starting it"
            );
            "containment_unavailable".to_string()
        })?;
    Ok(serde_json::json!({ "mcpServers": { MCP_SERVER_NAME: server } }).to_string())
}

/// ①: `.claude.json`(`claude mcp add -s user` が書く場所)の `mcpServers.openroly`。
/// 旧名(`mcpServers.paa` / `.atn`)も読み先に受ける(PBI-0344)。
fn claude_user_mcp_server(config_path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(config_path)
        .map_err(|e| eprintln!("broker: cannot read the claude config ({config_path:?}): {e}"))
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| eprintln!("broker: the claude config is not valid JSON ({config_path:?}): {e}"))
        .ok()?;
    mcp_server_by_name(parsed.get("mcpServers")?)
}

/// ②: plugin 台帳 → plugin 同梱の `.mcp.json` の `mcpServers.openroly`。
/// 台帳の key は `<plugin 名>@<marketplace 名>`、値は install ごとの配列(scope: user / local)。
/// `${CLAUDE_PLUGIN_ROOT}` は claude が展開する変数なので、複製する時に **broker が実 path へ畳む**
/// (`--mcp-config` で渡す JSON は plugin の文脈で読まれないため、展開されないまま渡すと command が
/// 見つからず、閉じ込めただけで何も出来ない session になる)。
fn claude_plugin_mcp_server(registry_path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(registry_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| eprintln!("broker: the claude plugin registry is broken ({registry_path:?}): {e}"))
        .ok()?;
    let plugins = parsed.get("plugins")?.as_object()?;
    let is_ours = |plugin: Option<&str>| {
        plugin == Some(MCP_SERVER_NAME) || LEGACY_MCP_SERVER_NAMES.contains(&plugin.unwrap_or(""))
    };
    let mut candidates: Vec<&serde_json::Value> = plugins
        .iter()
        .filter(|(key, _)| is_ours(key.split('@').next()))
        .filter_map(|(_, installs)| installs.as_array())
        .flatten()
        .collect();
    // scope:"user" を先に見る(local は「その project でだけ入れた」もの。dedicated session の
    // cwd は session_dir なので、user scope の install の方が実態に近い)。
    candidates.sort_by_key(|i| i.get("scope").and_then(|s| s.as_str()) != Some("user"));
    for install in candidates {
        let Some(root) = install.get("installPath").and_then(|p| p.as_str()) else { continue };
        let Ok(text) = fs::read_to_string(Path::new(root).join(".mcp.json")) else { continue };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(server) = parsed.get("mcpServers").and_then(mcp_server_by_name) else {
            continue;
        };
        return Some(expand_plugin_root(&server, root));
    }
    None
}

/// JSON の文字列すべてで `${CLAUDE_PLUGIN_ROOT}` を実 path に置き換える(command / args / env 横断)。
fn expand_plugin_root(value: &serde_json::Value, root: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            serde_json::Value::String(s.replace("${CLAUDE_PLUGIN_ROOT}", root))
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|v| expand_plugin_root(v, root)).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter().map(|(k, v)| (k.clone(), expand_plugin_root(v, root))).collect(),
        ),
        other => other.clone(),
    }
}

/// codex の config.toml から **openroly 以外の MCP server 名**を拾う(PBI-0167 review 指摘)。
/// codex には claude の `--strict-mcp-config` に相当する flag が無いので、`-c
/// mcp_servers.<name>.enabled=false` を 1 つずつ積んで落とす(実測 2026-09-02, codex-cli 0.151.0:
/// `codex mcp list --json -c 'mcp_servers.playwright.enabled=false'` で該当 server だけ
/// `"enabled": false` になる)。**`codex mcp list` を broker から引く形は採らない** ——
/// 実測 7.1 秒かかり、auth 状態を見るために server を実際に起こしてしまう(wake の度に
/// user の playwright / obsidian が立ち上がる)。
///
/// 読めない config は「MCP server が 1 つも無い」ではなく **判定不能**として扱い、
/// `[mcp_servers.<name>]` 以外の書き方(inline table `mcp_servers = {…}` / quoted key)が
/// 現れたら名前を取り切れないので `containment_unavailable` で止める(fail-closed。
/// 「落とし忘れた server が 1 つ」は静かな全開放になるため、曖昧なら起こさない)。
fn codex_disabled_mcp_servers(config_path: &Path) -> Result<Vec<String>, String> {
    let Ok(text) = fs::read_to_string(config_path) else {
        // config.toml が無い = MCP server の設定も無い(openroly は plugin 側から来る)。落とす相手が居ない。
        return Ok(vec![]);
    };
    let mut names: Vec<String> = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let header = line.strip_prefix('[').and_then(|l| l.split(']').next());
        if let Some(header) = header {
            let header = header.trim_start_matches('[');
            let mut parts = header.split('.');
            if parts.next().map(str::trim) != Some("mcp_servers") {
                continue;
            }
            let Some(name) = parts.next().map(str::trim) else {
                eprintln!("broker: cannot read the server names under [mcp_servers] in the codex config ({config_path:?})");
                return Err("containment_unavailable".to_string());
            };
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                // quoted key(`["mcp_servers"."x y"]`)等。`-c` の key に安全に埋められない
                // = 落とし切れないので起こさない。
                eprintln!("broker: unexpected MCP server name in the codex config ({name:?} in {config_path:?})");
                return Err("containment_unavailable".to_string());
            }
            if name != MCP_SERVER_NAME
                && !LEGACY_MCP_SERVER_NAMES.contains(&&*name)
                && !names.iter().any(|n| n == name)
            {
                names.push(name.to_string());
            }
            continue;
        }
        if line.starts_with("mcp_servers") {
            // inline table(`mcp_servers = { github = { … } }`)は行単位では名前を取り切れない。
            eprintln!("broker: mcp_servers in the codex config is an inline table ({config_path:?}); cannot strip it safely, so not starting");
            return Err("containment_unavailable".to_string());
        }
    }
    Ok(names)
}

/// entry の `launch.mcp_inject`(PBI-0617)。**catalog が正**で、持っていない時だけ compile-in の
/// built-in を見る —— built-in fallback は撤去しない(registry.rs の不変条件。offline / 署名 NG / 503 でも
/// official 2 種は起きる)。`merged_with_builtin` は **id 単位**なので、catalog が同じ id の entry を
/// 持つと built-in の entry ごと落ちる。ここは field 単位で拾い直す(catalog が渡し方をまだ持たない間も
/// claude / codex が MCP 無しの session にならない)。
fn mcp_inject(registry: &Registry, runtime: &str) -> Option<McpInject> {
    let of = |r: &Registry| r.detector(runtime).and_then(|d| d.launch.mcp_inject.clone());
    of(registry).or_else(|| of(&registry::builtin()))
}

/// entry の `launch.headless.argv`(PBI-0618)。`mcp_inject` と同じ理由で **field 単位**に拾い直す ——
/// id 単位の merge のままだと、catalog が claude の entry を持った瞬間に built-in の argv ごと落ち、
/// 署名済み catalog が配られた端末だけ `not_headless` になる(dev 機では built-in が拾うので気付けない穴)。
fn headless_argv(registry: &Registry, runtime: &str) -> Option<Vec<String>> {
    let of = |r: &Registry, rt: &str| r.detector(rt).and_then(|d| d.launch.headless.as_ref()).map(|h| h.argv.clone());
    let kind = catalog_kind(runtime);
    of(registry, runtime)
        .or_else(|| of(registry, kind))
        .or_else(|| of(&registry::builtin(), kind))
}

/// 組込み tool を落とす起こし方と、MCP の**集め方**を broker が実測で持っている runtime。
/// 他人の本文が入る lane(triage / auto / draft / …)で起こしてよいのはこの 2 つだけ(PBI-0548)。
/// **argv はもう data**(PBI-0618)—— ここに残るのは「どの門を免除するか」の判断だけ。
fn is_official(runtime: &str) -> bool {
    matches!(runtime, "claude" | "codex")
}

/// `config_flag` が session_dir に書く file 名。**path を渡させない** —— data 側の 1 文字で
/// session_dir の外(`../` や絶対 path)に書ける口にしない。
fn is_safe_mcp_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

/// `launch.mcp_inject`(PBI-0617)を解く。`None` = 渡す物が無い(`prewired` / 宣言なし = 端末側で事前配線済み)、
/// `Some((argv, files))` = `${mcp_argv}` に差し込む引数と session_dir に置く file。
///
/// **中身の集め方は data にしない**(実測の塊なので Rust に残す): claude の user config / plugin 台帳、
/// codex の他 server の列挙は config の場所も書式も runtime 固有で、data にすると「推測で埋める」余地が増える。
/// 集め方を持たない相手が方式を名乗っても解かない = `mcp_inject_unresolved`(起こさない)。
fn resolve_mcp_inject(
    registry: &Registry,
    runtime: &str,
    session_dir: &str,
    env: &ContainmentEnv,
) -> Result<Option<(Vec<String>, Vec<(String, String)>)>, String> {
    let Some(inject) = mcp_inject(registry, runtime) else {
        return Ok(None);
    };
    match (runtime, inject.strategy.as_str()) {
        // 端末側の native config に `openroly install` が書いた設定を使う(何も足さない)
        (_, "prewired") => Ok(None),
        // claude: user settings を落とすと MCP 登録ごと消える(実測 E)ので、openroly の定義を
        // session_dir に複製して `--mcp-config` でそれだけを読ませる。`${mcp_file}` はちょうど 1 回
        // (0 回 = file を書くのに渡さない、2 回以上 = flag の形が不明)。
        ("claude", "config_flag")
            if is_safe_mcp_file(&inject.file)
                && inject.argv.iter().filter(|a| a.contains("${mcp_file}")).count() == 1 =>
        {
            let mcp_config = claude_mcp_config(&env.claude_config, &env.claude_plugin_registry)?;
            let path = format!("{session_dir}/{}", inject.file);
            let argv = inject.argv.iter().map(|a| a.replace("${mcp_file}", &path)).collect();
            Ok(Some((argv, vec![(inject.file.clone(), mcp_config)])))
        }
        // codex: `--strict-mcp-config` に相当する flag が無いので、openroly 以外の MCP server を
        // 1 つずつ落とす(review 指摘: server は `--sandbox read-only` の外の別プロセスなので、
        // 攻撃者の本文から playwright / obsidian 越しに network も書込みも届く)。
        ("codex", "disable_others") if inject.argv_template.iter().any(|a| a.contains("${name}")) => {
            let mut argv = vec![];
            for name in codex_disabled_mcp_servers(&env.codex_config)? {
                argv.extend(inject.argv_template.iter().map(|a| a.replace("${name}", &name)));
            }
            Ok(Some((argv, vec![])))
        }
        _ => Err(mcp_unresolved(runtime, &format!("launch.mcp_inject: {:?}", inject.strategy))),
    }
}

/// `mcp_inject_unresolved` を返す前に理由を 1 行残す(理由は reason 名に載らないので log でだけ分かる)。
fn mcp_unresolved(runtime: &str, why: &str) -> String {
    eprintln!("broker: cannot hand the openroly MCP server to {runtime} ({why})");
    "mcp_inject_unresolved".to_string()
}

/// AUTO / triage / draft / owner の dedicated session(PBI-0019 / PBI-0117)の起動引数と、
/// session_dir に置く**閉じ込め用の file** を組む。
///
/// **起こし方は registry の data**(PBI-0618)。claude / codex も opencode / kiro と同じ
/// `launch.headless.argv` から組む —— runtime を足すのに要る Rust は 0 行で、broker に残るのは
/// 「方式を解く」側(置換・MCP の集め方・門)だけ。実測の理由(なぜ `--tools ""` が要るか等)は
/// entry の `note` と `sources` に在る。
///
/// argv は program を含まない(`resolve_program` が `detect.binaries` を解決する)。`instruction` は
/// argv の 1 要素として渡す —— shell を経由させない(Cloud から届いた文字列を shell に解釈させると
/// 任意コマンド実行の口になる)。`session_dir` は結果 file(codex の `-o`)と閉じ込め file の置き場。
///
/// **閉じ込め(PBI-0167)**: dedicated session の入力(通知本文)は攻撃者が書ける。official 2 種の argv は
/// 「組込み tool は通さず openroly MCP だけ通す」に揃えてある —— 揃っていないと「片方を既定にしている人
/// だけ mail 1 通で shell を握られる」という、user から見えない差になる。
/// **PBI-0238 以降、ここで組む flag は上乗せ**(図72)。主の壁は broker が spawn の前に掛ける
/// OS sandbox + egress proxy(`launch_session_scoped_in` → `sandbox.wrap`)で、runtime が何であれ同じ。
/// `folder` は lane の作業 folder(cwd。codex は `-C` にも載せる)。
///
/// **門は data 化しない**(PBI-0618 スコープ外): `launch.headless` を持たない entry は `not_headless`
/// (registry で足しただけの新 runtime を instruction 無しで bare spawn しない)、official 以外で
/// `sandbox_verified` が無ければ `not_verified`、official 以外が lane work の外なら `lane_not_contained`
/// (PBI-0548: generic の engine は組込み tool を落とす起こし方を持たない)。どれも spawn しない(fail-closed)。
pub fn dedicated_launch(
    registry: &Registry,
    runtime: &str,
    lane: &str,
    instruction: &str,
    session_dir: &str,
    folder: &str,
    env: &ContainmentEnv,
) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    // argv の要素は NUL を運べない(spawn が落とす)。どの runtime でも先に止める
    // (AC-X2 = 起動して拒否されるより先)
    if instruction.bytes().any(|b| b == 0) {
        return Err("invalid_instruction".to_string());
    }
    let Some(template) = headless_argv(registry, runtime) else {
        return Err("not_headless".to_string());
    };
    let kind = catalog_kind(runtime);
    if !is_official(kind) {
        // work lane（continue / 人が渡した仕事）は OS sandbox + egress が主の壁。
        // sandbox_verified が無い generic をここで落とすと、catalog に載せた grok が
        // `unknown_runtime` の次に `not_verified` でまた止まる（PBI-0680 実測）。
        // 他人の本文が入る lane は今までどおり未検証を起こさない。
        if lane != "work" {
            if registry.detector(kind).and_then(|d| d.sandbox_verified.as_ref()).is_none() {
                return Err("not_verified".to_string());
            }
            return Err("lane_not_contained".to_string());
        }
    }
    let inject = resolve_mcp_inject(registry, runtime, session_dir, env)?;
    let slot = template.iter().any(|a| a == MCP_ARGV_SLOT);
    let (mcp_argv, files) = match inject {
        // 渡し方は解けたのに argv に差し込む場所が無い = 黙って落ちる(MCP の載っていない session を
        // 「載った」と思って起こす)。data 側の 1 文字で起きるので、起こさない
        Some(_) if !slot => return Err(mcp_unresolved(runtime, "launch.headless.argv に ${mcp_argv} が無い")),
        Some(pair) => pair,
        // official は openroly MCP を渡せないと「閉じ込めただけで何も出来ない session」になる。
        // 端末側の事前配線(prewired)では代わりにならない —— `--setting-sources project` で
        // user settings を落とすと MCP 登録ごと消える(実測 E)
        None if is_official(runtime) => {
            return Err(mcp_unresolved(runtime, "official runtime に launch.mcp_inject が無い"))
        }
        None => (vec![], vec![]),
    };
    Ok((substitute_elementwise(&template, instruction, folder, session_dir, &mcp_argv), files))
}

/// argv の組み立て(PBI-0240 / PBI-0618)。各要素の中の `${instruction}` / `${folder}` /
/// `${session_dir}` / `${max_turns}` を置換し、`${mcp_argv}` **ちょうど 1 要素**は
/// `resolve_mcp_inject` が組んだ 0..N 要素に展開する —— **shell は経由しない**(1 要素 = 1 引数のまま。
/// `format!` で 1 文字列に繋ぐと Cloud から届いた instruction を shell に解釈させる口になる)。
/// 展開は**要素まるごとが一致する時だけ**(部分一致にすると「どこまでが 1 引数か」が data の書き方で変わる)。
fn substitute_elementwise(
    argv: &[String],
    instruction: &str,
    folder: &str,
    session_dir: &str,
    mcp_argv: &[String],
) -> Vec<String> {
    let mut out = Vec::with_capacity(argv.len() + mcp_argv.len());
    for a in argv {
        if a == MCP_ARGV_SLOT {
            out.extend(mcp_argv.iter().cloned());
            continue;
        }
        out.push(
            a.replace("${instruction}", instruction)
                .replace("${folder}", folder)
                .replace("${session_dir}", session_dir)
                .replace("${max_turns}", MAX_TURNS),
        );
    }
    out
}

/// 起こせなかった wake に添える代替(PBI-0240 AC-2 / PBI-0548)。owner は仕事を folder 単位で渡すので runtime は替えられる。
/// `not_headless` = headless 可の別 runtime / `lane_not_contained` = hello で見つかった claude か codex
/// (generic entry を出すと同じ門でまた止まる)。他の理由は代替を持たない。
pub fn wake_alternative(registry: &Registry, found: &[Found], runtime: &str, reason: &str) -> Option<String> {
    match reason {
        // PBI-0616: 通信先を data で持たない runtime(端末の `local-*` 等)も「起こせない」の仲間。
        // この門は argv の門(`not_headless`)より先に効くので、ここに足さないと代替を失う
        "not_headless" | "no_egress_hosts" => headless_alternative(registry, found, runtime),
        "lane_not_contained" => found.iter().find(|f| matches!(f.id.as_str(), "claude" | "codex")).map(|f| f.id.clone()),
        _ => None,
    }
}

/// `not_headless` の代替。hello で見つかった runtime のうち、`launch.headless` を持つ entry で、
/// 起こそうとした runtime と別の id の最初の 1 つ。
fn headless_alternative(registry: &Registry, found: &[Found], runtime: &str) -> Option<String> {
    found
        .iter()
        .find(|f| f.id != runtime && is_headless_capable(registry, &f.id))
        .map(|f| f.id.clone())
}

/// dedicated wake で instruction 付きで起こせる runtime か。**判定は data 1 本**(PBI-0618)——
/// official 2 種の argv も `launch.headless` に在るので、hard-code の列挙は要らない。
fn is_headless_capable(registry: &Registry, id: &str) -> bool {
    headless_argv(registry, id).is_some()
}

/// requestId は session_dir のパス要素になる(信頼境界を跨ぐ Cloud からの文字列)。
/// path traversal(`../`)や区切り文字を弾き、安全な id だけを通す。
/// PBI-0230: hub の account_id(`sessions/hub/<account_id>/`)も同じ門を通る —— main.rs が
/// hub 分岐の前に呼ぶ。
pub fn is_safe_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `$OPENROLY_BROKER_HOME`(default `~/.openroly/broker`)。sessions/<requestId>/ と registry cache の親。
/// 旧 env 名(`PAA_BROKER_HOME`)と旧 dir(`~/.atn/broker`)は env_compat が引き継ぐ(PBI-0344 AC-3)。
pub fn broker_home() -> PathBuf {
    if let Some(dir) = crate::env_compat::env_new_or_legacy("OPENROLY_BROKER_HOME") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    crate::env_compat::legacy_dir(
        PathBuf::from(&home).join(".openroly").join("broker"),
        PathBuf::from(home).join(".atn").join("broker"),
    )
}

/// spawn する program。scan で見つかった path があればそれ(PATH に無い brew / npm の binary も
/// 起こせる — PBI-0022 AC-4b)、無ければ bare name(従来どおり PATH 解決)。app bundle(`source:"app"`)は
/// 実行ファイルではないので bare name に落とす。
pub fn resolve_program(found: &[Found], runtime: &str) -> String {
    let kind = catalog_kind(runtime);
    found
        .iter()
        .find(|f| (f.id == runtime || f.id == kind) && f.source != "app")
        .map(|f| f.path.clone())
        .unwrap_or_else(|| kind.to_string())
}

/// runtime profile の class(PBI-0211)なら親 runtime。registry の `adapter: "variant"` と `variant.of` の両方が要る
pub fn variant_of<'a>(registry: &'a Registry, runtime: &str) -> Option<&'a str> {
    let d = registry.detector(runtime)?;
    (d.adapter.as_deref() == Some("variant")).then_some(d.variant.as_ref()?.of.as_str())
}

/// variant の wake を `openroly run <class> --bin <親 path> -- <親の argv>` に包む(PBI-0211)。親の argv は
/// 呼び出し側が親 runtime として組んだ物を **そのまま** 渡す(hardening flag を 1 つも変えない)。
pub fn variant_argv(
    found: &[Found],
    class: &str,
    parent: &str,
    cli: &[String],
    parent_args: Vec<String>,
) -> Result<(String, Vec<String>), String> {
    let Some((program, leading)) = cli.split_first() else {
        return Err("openroly_cli_not_found".to_string());
    };
    let mut args = leading.to_vec();
    args.extend(["run".to_string(), class.to_string(), "--bin".to_string(), resolve_program(found, parent), "--".to_string()]);
    args.extend(parent_args);
    Ok((program.clone(), args))
}

/// registry に照らした起動可否。判定順序(図18): registry に無い → `unknown_runtime`、
/// 有るが `adapter: null`(Ollama 等 — 検出・表示のみ)→ `not_launchable`。
fn check_launchable(registry: &Registry, runtime: &str) -> Result<(), String> {
    match registry.detector(catalog_kind(runtime)) {
        Some(d) if d.adapter.is_none() => Err("not_launchable".to_string()),
        Some(_) => Ok(()),
        None => Err("unknown_runtime".to_string()),
    }
}

/// `runtime` は Cloud から WS メッセージで届く未検証の文字列(信頼境界を跨ぐ)。
/// Broker はローカルで強い権限を持つため(アーキ §16)、`allowlist` に無い名前は
/// 一切 spawn しない(任意コマンド実行の口にしない)。テストから安全なダミー名で
/// allowlist ごと差し替えられるよう、実 spawn を伴う検証を本物の CLI 名から分離する。
///
/// `program` は `resolve_program` が返した path か bare name。`args` は `session_args`/
/// `dedicated_launch` が組んだものだけを渡す前提(Cloud から届いた文字列を allowlist 検査なしに引数へ
/// 混ぜない)。`session_dir` を渡すと (a) 子プロセスの **cwd をそこに固定** し、(b) stdout/stderr を
/// その配下のファイルへ向ける(dedicated session。None なら両方とも broker から継承)。
///
/// cwd を固定するのは安全のため(PBI-0033)。`claude -p` は **workspace trust dialog をスキップする**
/// (`claude --help` の `-p`: *The workspace trust dialog is skipped when Claude is run in
/// non-interactive mode … Only use this in directories you trust. Settings files that fail
/// validation are silently ignored*)。cwd を継承したままだと、broker daemon を起動したディレクトリの
/// `.claude/settings.json`(**hooks を含む**)・`CLAUDE.md`・project scope の `.mcp.json` を、
/// user の実 credential で走る無人 session が黙って読み込む。session_dir は broker が作った空
/// ディレクトリなので、そこに固定すれば読み込まれる設定は HOME 側(user scope)だけに決まる
/// —— PBI-0019 の実測 C(cwd = scratchpad)と同じ条件を再現する。codex に渡している
/// `-C <session_dir>` の claude 版でもある(左右非対称の解消)。MCP server の登録は絶対パス
/// (`MCP_SERVER_ENTRY` = `fileURLToPath(new URL(...))`)＋ user scope 登録なので cwd に依存しない
/// (コード確認。この機には openroly MCP server が未登録なので実登録での実測はしていない)。
///
/// `resolve_program` が返す `Found.path` は scan 側(discovery.rs `absolutize`)で絶対化済みなので、
/// cwd を session_dir に固定しても `PATH` / `OPENROLY_SCAN_DIRS` の相対 entry で解決が壊れない(PBI-0039)。
///
/// **Manual routing(`launch()`)では None のまま**にすること: `claude --continue` /
/// `codex resume --last` は「**そのディレクトリの**直近 session」を継ぐので、cwd を変えると
/// human が続けたかった会話とは別の(あるいは存在しない)session に繋がる。
///
/// 起動した子プロセスの `Child` を返す。reaper(終了 wait と session_result 送信)は
/// 呼び出し側(main.rs)が tokio task で引き受ける —— PBI-0015 は別スレッドで捨てるだけだったが、
/// PBI-0019 で終了を Cloud へ報告するため wait を呼び出し側の管理下に移した。
pub fn launch_with_allowlist(
    runtime: &str,
    program: &str,
    args: &[String],
    allowlist: &[String],
    session_dir: Option<&str>,
) -> Result<Child, String> {
    launch_with_scope(runtime, program, args, allowlist, session_dir, None, None)
}

/// `launch_with_allowlist` の本体 + triage session の scope token(EP-0013 W3 / PBI-0117)。
/// `scope` が有る時だけ子プロセスの env `OPENROLY_SESSION_SCOPE` に載せる(MCP server が全 request の
/// `x-openroly-session-scope` header で Cloud へ返す。REQ-61 enforcement ②)。PBI-0320 以降は
/// **5 lane + Manual + API provider が scope を持つ**ので、`None` で来るのは work lane の implementer・
/// scope を発行しない古い Cloud・単体テストだけ。
///
/// `session_id` は dedicated session の request_id(PBI-0224 peek)。`Some` の時だけ子 env
/// `OPENROLY_SESSION_ID` に載せ、MCP server が session_dir/peek.jsonl に tool 往復を残す。manual `launch`
/// からは `None` = env に無い = 何も記録しない(人が画面で見ている面を二重に記録しない)。
pub fn launch_with_scope(
    runtime: &str,
    program: &str,
    args: &[String],
    allowlist: &[String],
    session_dir: Option<&str>,
    scope: Option<&str>,
    session_id: Option<&str>,
) -> Result<Child, String> {
    check_program(program)?;
    launch_in(runtime, program, args, allowlist, session_dir, scope, session_id, None, None, None)
}

/// PBI-0244 の二重の 2 本目。**registry 由来の program**(id の bare name / scan で見つけた path)は
/// spawn の直前でもう一度 deny を見る —— `parse` を迂回する経路(cache の読み方が変わる・
/// 別の口が生える)が将来できても、shell / interpreter は起きない。
///
/// **`launch_api` はここを通さない**: あれが起こすのは registry の program ではなく
/// `OPENROLY_CLI` の argv(dev / E2E では `bun <path>`)で、env を握れる者は既に何でも起こせる。
/// 表で `bun` を止めても安全は 1mm も増えず、代わりに開発と E2E の API provider 経路が全部死ぬ。
fn check_program(program: &str) -> Result<(), String> {
    if registry::is_forbidden_program(program) {
        eprintln!("broker: refused to launch a forbidden program {program:?}");
        return Err("forbidden_program".to_string());
    }
    Ok(())
}

/// spawn の唯一の口。`contained` が有る時(= dedicated session。PBI-0238)は spawn の前に
/// **必ず** `sandbox.wrap` を通し、cwd を lane の folder にし、egress proxy の env を載せる。
/// `Command::new` から `spawn` までがここ 1 箇所なので、dedicated 経路に「wrap を通らない spawn」は無い
/// (旧 diagrams-check の規則 (a) が固定する)。Manual(`launch`)/ API provider(`launch_api`)は None。
fn launch_in(
    runtime: &str,
    program: &str,
    args: &[String],
    allowlist: &[String],
    session_dir: Option<&str>,
    scope: Option<&str>,
    // dedicated session の request_id(PBI-0224 peek)。`Some` の時だけ子 env に載る
    session_id: Option<&str>,
    // PBI-0230: hub の peek 置き場 = turn dir。`Some` の時だけ子 env `OPENROLY_SESSION_DIR` に載る
    // (claude `--continue` の会話 key は cwd のため、hub の cwd は固定 dir —— ID から導く
    // 通常の peek path とは食い違う)
    peek_dir: Option<&Path>,
    contained: Option<(&dyn SandboxBackend, &SandboxSpec)>,
    // C1(PBI-0441 ③)の専用 uid。`Some` の時だけ `sudo -n -u <uid>` で包む(sandbox の **外側**)
    as_user: Option<&str>,
) -> Result<Child, String> {
    let kind = catalog_kind(runtime);
    if !allowlist.iter().any(|id| id == runtime || id == kind) {
        return Err("unknown_runtime".to_string());
    }
    let mut cmd = Command::new(program);
    cmd.args(args);
    // Claude Code の中から broker を起動した時、CLAUDECODE が残っていると nested 判定で落ちる。
    cmd.env_remove("CLAUDECODE");
    if let Some(scope) = scope {
        cmd.env("OPENROLY_SESSION_SCOPE", scope);
    }
    if let Some(id) = session_id {
        cmd.env("OPENROLY_SESSION_ID", id);
    }
    if let Some(dir) = peek_dir {
        cmd.env("OPENROLY_SESSION_DIR", dir);
    }
    if let Some((sandbox, spec)) = contained {
        cmd = contain(cmd, sandbox, spec)?;
    } else if let Some(dir) = session_dir {
        // 閉じ込め無しで session_dir を渡す経路(test の cwd / env probe)。cwd は session_dir。
        cmd.current_dir(dir);
    }
    // C1(PBI-0441 ③): 専用 uid で起こす。**`sandbox.wrap` の後 = sudo が一番外側** ——
    // 逆にすると sandbox の中から setuid を叩く形になり、profile が deny して session が起きない。
    // stdio / process_group はこの後に付ける(wrap と同じ理由 —— 包み直しは program / args / env / cwd
    // しか写せないので、先に付けると sudo 経路でだけ消える)。
    if let Some(user) = as_user {
        cmd = c1::wrap_as_user(cmd, user);
    }
    // **止める単位を process group にする**(PBI-0403)。起こす子は `claude` / `codex` の CLI で、
    // その下に tool 実行 / MCP server / node が付く —— 直の子だけに signal を送ると孫が孤児で
    // 生き残るのに `reap_once` は直の子の `try_wait()` しか見ないので、`session_result` は
    // 「終わった」と報告する(止めたと言って止まっていない)。`process_group(0)` = 子を新しい
    // group の leader にする(pgid == 子の pid)ので、`sessions::cancel_with_escalate` が
    // `kill(-pgid)` で group ごと落とせる。**wrap の後に置く**(stdio と同じ理由 ——
    // `sandbox.wrap` は SANDBOX_EXEC を新しい起点にして cmd を丸ごと作り直すので、
    // program / args / env / cwd 以外はここで付けないと sandboxed 経路(dedicated session
    // = 孫を持つ経路そのもの)でだけ消える。unix だけ(broker は macOS / Linux)。
    #[cfg(unix)]
    cmd.process_group(0);
    // 両 CLI とも非 TTY stdin を読みに行って hang するため null に落とす(実測 — codex exec は
    // "Reading additional input from stdin..." で待つ / claude -p も同様)。stdio も同じ理由で
    // wrap の後に付ける(wrap は program / args / env / cwd しか写せない)。
    cmd.stdin(std::process::Stdio::null());
    if let Some(dir) = session_dir {
        // dedicated session の出力は session_dir に残す(Cloud へは送らない — cost/内容の集計は
        // スコープ外)。open に失敗したら継承にフォールバックせず session_dir_failed 相当で扱う
        // ため、ここでは Result を上へ返す。
        // reason は AC-11 が literal 'session_dir_failed' を期待する(OBSERVE の grep 対象でもある)。
        // 詳細は eprintln へ逃がし、返す reason は bare token に保つ。
        let stdout = fs::File::create(format!("{dir}/stdout.log")).map_err(|e| {
            eprintln!("broker: could not create session_dir stdout.log: {e}");
            "session_dir_failed".to_string()
        })?;
        let stderr = fs::File::create(format!("{dir}/stderr.log")).map_err(|e| {
            eprintln!("broker: could not create session_dir stderr.log: {e}");
            "session_dir_failed".to_string()
        })?;
        cmd.stdout(stdout);
        cmd.stderr(stderr);
    }
    cmd.spawn().map_err(|e| format!("spawn failed: {e}"))
}

/// 閉じ込めの中で起こす形にする(図72)。cwd = lane の folder(sandbox が唯一 write を許す所)。network は
/// profile が proxy の 1 port しか許さないので、子の HTTP client を全部そこへ向ける。
/// `NO_PROXY=""` は「proxy を迂回する host は無い」の明示(user の env に NO_PROXY が有っても
/// 継がない)。`NODE_USE_ENV_PROXY=1` は Node 製 runtime の fetch が HTTPS_PROXY だけでは
/// proxy を通らない実測(2026-09-04)への対処。runtime と外の masking server(PBI-0558)の 2 つがここを通る。
fn contain(mut cmd: Command, sandbox: &dyn SandboxBackend, spec: &SandboxSpec) -> Result<Command, String> {
    cmd.current_dir(&spec.folder);
    // PWD も folder に揃える(PBI-0577)。env は broker のを丸ごと継ぐので、揃えないと broker を起こした shell の dir が残る ——
    // OpenCode 1.18 の `run` は session を cwd ではなく `$PWD` で作る(実測: 渡した folder を読まずに別の dir で働いた)
    cmd.env("PWD", &spec.folder);
    let proxy = format!("http://127.0.0.1:{}", spec.proxy_port);
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
        cmd.env(key, &proxy);
    }
    cmd.env("NO_PROXY", "");
    cmd.env("no_proxy", "");
    cmd.env("NODE_USE_ENV_PROXY", "1");
    sandbox.wrap(cmd, spec)
}

/// PBI-0558: この session は外の masking server を使うか。claude(MCP 設定を broker が session_dir に書く runtime)で、
/// sandbox が read を deny する secrets.json(`default_deny_read` の 2 つ)が在る時だけ。
/// codex / catalog の engine は MCP 設定を broker が書かないので今のまま(辞書が読めなければ本文 tool を閉じる)
fn outside_masking(runtime: &str, user_home: &Path) -> bool {
    runtime == "claude" && default_deny_read(user_home).iter().any(|p| p.ends_with("secrets.json") && p.exists())
}

/// PBI-0558 の配線。外の masking server を起こして egress proxy に繋ぎ、`openroly-mcp.json` を relay 向けに差し替える。
/// どこかで失敗したら files はそのまま返す(= 中の server が辞書を読めず本文 tool を閉じる 0548 の形。生の本文へは落ちない)。
/// 状態は session_dir/masking.txt に 1 行(`openroly peek` が出す)
fn with_outside_masking(
    mut files: Vec<(String, String)>,
    egress: &mut Egress,
    sandbox: &dyn SandboxBackend,
    spec: &SandboxSpec,
    scope: Option<&str>,
    request_id: &str,
) -> Vec<(String, String)> {
    let note = |line: String| {
        let _ = fs::write(spec.session_dir.join("masking.txt"), format!("{line}\n"));
    };
    let Some(i) = files.iter().position(|(rel, _)| rel == CLAUDE_MCP_CONFIG) else {
        return files;
    };
    let wired = mask_token().and_then(|token| {
        let relayed = relay_mcp_config(&files[i].1, egress.port, &token)?;
        let child = spawn_mask_server(&files[i].1, sandbox, spec, scope, request_id)?;
        Ok((token, relayed, child))
    });
    match wired {
        Ok((token, relayed, child)) => {
            egress.attach_mask(child, token);
            files[i].1 = relayed;
            note("masking: outside sandbox".to_string());
        }
        Err(e) => {
            eprintln!("broker: the masking server could not be started ({e}); this session is not given other people's text");
            note(format!("masking: unavailable — {e}"));
        }
    }
    files
}

/// session ごとの relay の token(32 byte の乱数を hex で)。relay の MCP 設定と broker の memory にだけ置く
fn mask_token() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("no random source: {e}"))?;
    Ok(hex::encode(bytes))
}

/// runtime に渡す MCP 設定を relay 向けにする。起こす物は同じ定義(command / args)で、env を 2 つ足すだけ ——
/// relay は server と同じ entry(plugin の launcher は binary に引数を渡さないので、印は env で運ぶ)
fn relay_mcp_config(config: &str, proxy_port: u16, token: &str) -> Result<String, String> {
    let mut parsed: serde_json::Value = serde_json::from_str(config).map_err(|e| format!("MCP config: {e}"))?;
    let def = parsed
        .get_mut("mcpServers")
        .and_then(|s| s.get_mut(MCP_SERVER_NAME))
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("the MCP config has no openroly server")?;
    let env = def
        .entry("env")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("the openroly server's env is not an object")?;
    env.insert("OPENROLY_MCP_RELAY".to_string(), serde_json::json!(format!("127.0.0.1:{proxy_port}")));
    env.insert("OPENROLY_MASK_TOKEN".to_string(), serde_json::json!(token));
    Ok(parsed.to_string())
}

/// 外の masking server を起こす。**起こす物は runtime に渡すのと同じ MCP server の定義**(command / args / env)で、
/// 違いは 2 つだけ: stdio を broker が持つ(egress proxy が relay に渡す)・sandbox が secrets.json を deny しない。
/// sandbox の外へ出すのではなく **別の sandbox**(書ける所・network は runtime と同じ)に置く —— tool には folder に
/// 書く物(work_task_merge 等)が在るので、辞書を読ませるために書き込みと network の壁まで外さない。
/// profile は `session_dir/mask/` に置く(同じ `sandbox.sb` を runtime の wrap が上書きすると、どちらかが相手の profile で起きる)
fn spawn_mask_server(
    config: &str,
    sandbox: &dyn SandboxBackend,
    spec: &SandboxSpec,
    scope: Option<&str>,
    request_id: &str,
) -> Result<Child, String> {
    let parsed: serde_json::Value = serde_json::from_str(config).map_err(|e| format!("MCP config: {e}"))?;
    let def = &parsed["mcpServers"][MCP_SERVER_NAME];
    let command = def["command"].as_str().ok_or("the openroly server has no command")?;
    let mut cmd = Command::new(command);
    cmd.args(def["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str()));
    for (key, value) in def["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            cmd.env(key, value);
        }
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env("OPENROLY_SESSION_ID", request_id);
    if let Some(scope) = scope {
        cmd.env("OPENROLY_SESSION_SCOPE", scope);
    }
    let own_dir = spec.session_dir.join("mask");
    fs::create_dir_all(&own_dir).map_err(|e| format!("mask dir: {e}"))?;
    let own = SandboxSpec {
        session_dir: own_dir.clone(),
        writable_extra: std::iter::once(spec.session_dir.clone()).chain(spec.writable_extra.iter().cloned()).collect(),
        deny_read: spec.deny_read.iter().filter(|p| !p.ends_with("secrets.json")).cloned().collect(),
        ..spec.clone()
    };
    let mut cmd = contain(cmd, sandbox, &own)?;
    #[cfg(unix)]
    cmd.process_group(0);
    let log = fs::File::create(own_dir.join("stderr.log")).map_err(|e| format!("mask log: {e}"))?;
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(log)
        .kill_on_drop(true);
    cmd.spawn().map_err(|e| format!("spawn failed: {e}"))
}

/// Cloud から受けた wake 要求(Manual routing / instruction 無し)に応じて runtime CLI を
/// bare spawn する(要件 §21.1 runtime launch)。`session_mode` は Manual routing(§20.1)の
/// New/Existing 選択。AUTO 経路は必ず `launch_session`(instruction 付き)を通る。
/// allowlist・起動引数は registry(署名検証済み ∪ built-in)から、program は scan 結果から引く(PBI-0022)。
/// Manual routing(§20.1)の bare spawn。`scope` は Cloud が発行した session scope token
/// (PBI-0320) —— human が web で起こした session も lane(owner)を持つので、
/// dedicated と同じ穴(子 env `OPENROLY_SESSION_SCOPE`)で渡す。無い時は env に載らない。
pub fn launch(
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    session_mode: &str,
    scope: Option<&str>,
) -> Result<Child, String> {
    check_launchable(registry, runtime)?;
    // variant(PBI-0211): 親の起動引数を `openroly run <class>` に包む。deny は親 program に掛ける
    if let Some(parent) = variant_of(registry, runtime) {
        check_program(&resolve_program(found, parent))?;
        let (program, args) =
            variant_argv(found, runtime, parent, &cli_argv(), registry.session_args(parent, session_mode))?;
        return launch_in(runtime, &program, &args, &registry.allowlist(), None, scope, None, None, None, None);
    }
    let args = registry.session_args(runtime, session_mode);
    let program = resolve_program(found, runtime);
    launch_with_scope(runtime, &program, &args, &registry.allowlist(), None, scope, None)
}

/// 外部 API provider の runtime(`kind: "api"`。PBI-0070 / EP-0009 C)を起こす。
///
/// 実体は端末側の `openroly agent <provider> --thread <id>`(PBI-0057) —— 端末に binary は無いので
/// `resolve_program`(scan の path)ではなく **`OPENROLY_CLI` の argv** で起こす(`openroly adopt` と同じ解決)。
/// runtime id は `<provider>-api` の規約で、provider 名はその接頭辞。
///
/// 判定順序: unknown_runtime / not_launchable(registry。Cloud から来た名前を先に潰す)→
/// thread_required(thread 無しでは返信先が無い)→ openroly_cli_not_found → spawn。
/// wake payload に thread が無い時に bare spawn しない —— 何に返信するか決まっていない
/// session を起こしても、下書きの宛先が無い。
pub fn launch_api(
    registry: &Registry,
    runtime: &str,
    thread_id: &str,
    argv: &[String],
    scope: Option<&str>,
) -> Result<Child, String> {
    let custom = is_custom_api_runtime(runtime);
    if !custom {
        check_launchable(registry, runtime)?;
    }
    if thread_id.is_empty() {
        return Err("thread_required".to_string());
    }
    let provider = runtime.strip_suffix("-api").unwrap_or(runtime);
    let Some((program, leading)) = argv.split_first() else {
        return Err("openroly_cli_not_found".to_string());
    };
    let mut args: Vec<String> = leading.to_vec();
    args.extend([
        "agent".to_string(),
        provider.to_string(),
        "--thread".to_string(),
        thread_id.to_string(),
    ]);
    // 持ち込みは registry に載らないので allowlist を作れない。**起こす物は他の API provider と
    // 完全に同じ `OPENROLY_CLI agent <provider> --thread <id>`** で、runtime 名は argv の値にしか
    // ならない —— だから `is_custom_api_runtime` の狭い形が唯一の門になる
    let allowlist = if custom {
        vec![runtime.to_string()]
    } else {
        registry.allowlist()
    };
    // `check_program` を通す `launch_with_allowlist` ではなく launch_in を直に呼ぶ(理由は check_program の doc)。
    launch_in(runtime, program, &args, &allowlist, None, scope, None, None, None, None)
}

/// 持ち込みの endpoint(PBI-0276)の runtime か。名前は account ごとに決まるので**署名済み
/// registry に載せられない**。Cloud から届く未検証の文字列なので、形を厳しく固定して
/// それ以外は一切通さない: `custom-` + 英数と `-`(先頭末尾は英数)・slug は 2〜32 文字。
/// 正本は `packages/core/src/providers.ts` の `isCustomProviderId`(この関数はその写し)。
pub fn is_custom_api_runtime(runtime: &str) -> bool {
    let Some(slug) = runtime
        .strip_prefix("custom-")
        .and_then(|r| r.strip_suffix("-api"))
    else {
        return false;
    };
    let ok_char = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
    (2..=32).contains(&slug.len())
        && slug.chars().all(ok_char)
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

/// `launch_api` の env を読む面(`OPENROLY_CLI`)。test は argv を値で渡せるよう本体と分ける。
pub fn launch_api_env(
    registry: &Registry,
    runtime: &str,
    thread_id: &str,
    scope: Option<&str>,
) -> Result<Child, String> {
    launch_api(registry, runtime, thread_id, &cli_argv(), scope)
}

/// dedicated session(PBI-0019 の AUTO と PBI-0117 の triage)を起動する。判定順序(図15):
/// invalid_request_id → instruction_too_long → session_dir_failed → unknown_runtime / not_launchable
/// (registry)→ dedicated_unsupported → spawn。
///
/// session_dir(`$OPENROLY_BROKER_HOME/sessions/<requestId>/`)を作り、instruction.txt を残してから
/// spawn する。stdout/stderr は session_dir のファイルへ向ける。返すのは起動した `Child` で、
/// 終了の wait と session_result 送信は呼び出し側(main.rs)の reaper が引き受ける。
///
/// `scope` は session scope token(PBI-0117 → PBI-0320)。`Some` の時だけ子 env
/// `OPENROLY_SESSION_SCOPE` が載る(launch_with_scope)。5 lane が発行するので通常は `Some`。
///
/// 返り値の `Egress` は session の proxy。**child と同じ寿命で持つ**(reaper が wait の後に drop = 閉じる)。
pub fn launch_session_scoped(
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    instruction: &str,
    request_id: &str,
    scope: Option<&str>,
    isolation: &Isolation,
    hub: Option<&HubContext>,
) -> Result<(Child, Egress, Option<HubSpawn>), String> {
    launch_session_scoped_in(
        &broker_home(),
        registry,
        found,
        runtime,
        instruction,
        request_id,
        scope,
        &containment_env(),
        isolation,
        hub,
    )
}

/// dedicated session の閉じ込めの材料(PBI-0238 / 図72)。main.rs が起動時に決めた backend と、
/// wake ごとの egress 設定・lane の folder。test は backend と home を値で差し替える。
pub struct Isolation<'a> {
    /// 起動時の self_test に通った backend。通らなかった機は `NoSandbox`(= 全 dedicated wake が
    /// `sandbox_unavailable`)。
    pub sandbox: &'a dyn SandboxBackend,
    pub egress: EgressConfig,
    /// wake payload の `folder`(owner / work lane。server が rule から解決する = PBI-0239)。
    /// None = `session_dir/scratch`(triage / AUTO / draft)。
    pub folder: Option<&'a str>,
    /// wake payload の `lane`(PBI-0229)。scope token 付きの session に folder を渡してよいかを lane で決める
    /// (work lane の reviewer の枝だけ = PBI-0440)。
    pub lane: &'a str,
    /// user の HOME。`deny_read` / `writable_extra` の既定を組む(env は呼び出し口で 1 回だけ読む)。
    pub user_home: PathBuf,
    /// C1(PBI-0441 ③)の在り無し。`available` かつ `C1_RUNTIMES` の runtime なら、この session を
    /// 専用 uid + pf anchor で loopback egress だけに閉じる(= `host_scoped`)。
    /// setup していない機(既定の全端末・この pane)では常に `available: false` = 床のまま。
    pub c1: &'a c1::C1Status,
}

/// hub session の文脈(PBI-0230)。owner lane だけが立てる。server が wake payload の
/// `session_mode:"hub"` で運び、main.rs が account_id を門に通して渡す。
pub struct HubContext<'a> {
    /// hub dir の path 要素(`sessions/hub/<account_id>/<runtime>/`)。path traversal を弾く門は
    /// launch 側でも掛ける(is_safe_request_id と同じ門)
    pub account_id: &'a str,
    /// `/new`(server の in-memory rotate 要求)。turn を 1 に戻して fresh で起こす
    pub rotate: bool,
}

/// hub session の生まれ(PBI-0230)。hub 経路でだけ Some になる。wake_result の `resumed` /
/// `turn` の材料で、reaper が resume 失敗 30 秒内を quick-fail 判定する時の材料でもある。
#[derive(Debug, Clone, PartialEq)]
pub struct HubSpawn {
    /// runtime resume(registry `existing` の引数。claude `--continue` / codex `resume --last`)で
    /// 前の turn の会話を引き継いだ
    pub resumed: bool,
    /// この spawn が hub の何回目の turn か(fresh = 1。resume = 前回 + 1)
    pub turn: u32,
    /// hub dir。reaper が resume 失敗時に `turn` file を 0 に書き戻す先(sessions.rs)
    pub dir: PathBuf,
}

/// lane の作業 folder を決める(AC-4)。`folder` 無し = `session_dir/scratch`(空で作る)。
/// 有りは **rule に照らす前の最低限の門**(PBI-0239 が server 側の rule を持ち込むまでの土台):
/// 絶対 path・実在する dir・`/` や HOME そのものでない・`deny_read` / `~/Library` / `~/.openroly` /
/// broker home の下でない(**`~/.openroly/worktrees` の 1 段下 = fork の枝の folder だけは通す**・PBI-0440)。
/// scope token 付きの session が folder を持てるのは lane work だけ(reviewer の枝)—— triage は持たない
/// (通知本文を読む lane に owner の folder を渡す理由が無い)。どれかに当たれば `folder_not_allowed`。
fn resolve_folder(
    folder: Option<&str>,
    scope: Option<&str>,
    lane: &str,
    session_dir: &Path,
    broker_home: &Path,
    user_home: &Path,
) -> Result<PathBuf, String> {
    let Some(folder) = folder else {
        let scratch = session_dir.join("scratch");
        fs::create_dir_all(&scratch).map_err(|e| {
            eprintln!("broker: could not create the scratch folder ({scratch:?}): {e}");
            "session_dir_failed".to_string()
        })?;
        return Ok(scratch);
    };
    let refuse = |why: &str| {
        eprintln!("broker: folder {folder:?} is not allowed for a dedicated session: {why}");
        "folder_not_allowed".to_string()
    };
    if scope.is_some() && lane != "work" {
        return Err(refuse("a scoped session gets a folder only in the work lane"));
    }
    if !folder.starts_with('/') {
        return Err(refuse("not an absolute path"));
    }
    let real = fs::canonicalize(folder).map_err(|e| refuse(&format!("cannot resolve: {e}")))?;
    if !real.is_dir() {
        return Err(refuse("not a directory"));
    }
    let home = fs::canonicalize(user_home).unwrap_or_else(|_| user_home.to_path_buf());
    if real == Path::new("/") || real == home {
        return Err(refuse("the root or the home directory itself"));
    }
    let mut fenced = default_deny_read(&home);
    fenced.push(home.join("Library"));
    fenced.push(home.join(".openroly"));
    // 旧 state dir も丸ごと読ませない(PBI-0344 AC-3。改名後も secrets はこちらに在る)
    fenced.push(home.join(".atn"));
    fenced.push(fs::canonicalize(broker_home).unwrap_or_else(|_| broker_home.to_path_buf()));
    // fork の枝(PBI-0440)は `<state dir>/worktrees/<id>` に作られる。**その 1 段下の dir そのものだけ**を通す ——
    // worktrees 自身も、その奥も通さない(sandbox の write は folder の subpath なので兄弟の枝にも書けない)。
    // state dir は MCP の openrolyHome と同じ 2 つ: `~/.atn` だけが在る端末では枝も `~/.atn/worktrees` に立つ(PBI-0344)
    let is_fork_folder = [".openroly", ".atn"]
        .iter()
        .any(|state| real.parent() == Some(home.join(state).join("worktrees").as_path()));
    if !is_fork_folder && fenced.iter().any(|f| real.starts_with(f)) {
        return Err(refuse("inside a protected directory"));
    }
    Ok(real)
}

/// 起こせなかった session の置き場を消す(AC-X2: 半端な session_dir を残さない)。
fn discard_session_dir(session_dir: &Path) {
    let _ = fs::remove_dir_all(session_dir);
}

/// `launch_session_scoped` の本体。broker home と `ContainmentEnv` を引数で受けるのはテストのため —— `env::set_var` で
/// `OPENROLY_BROKER_HOME` を差し替える方式は、並列に走る他テストの spawn 中の子プロセスの環境を壊す
/// (実測: version probe の子 `sh` が落ちて出力が空になる)。
/// PBI-0230: `hub` が有る時は turn file を読んで resume / fresh を決め、session_dir は
/// `hub dir/turns/<request_id>` にし、cwd は固定の hub dir にする。
pub fn launch_session_scoped_in(
    home: &Path,
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    instruction: &str,
    request_id: &str,
    scope: Option<&str>,
    env: &ContainmentEnv,
    isolation: &Isolation,
    hub: Option<&HubContext>,
) -> Result<(Child, Egress, Option<HubSpawn>), String> {
    if !is_safe_request_id(request_id) {
        return Err("invalid_request_id".to_string());
    }
    if instruction.len() > MAX_INSTRUCTION_BYTES {
        return Err("instruction_too_long".to_string());
    }
    // PBI-0230: hub 分岐。turn file は **spawn 成功後にのみ** 書く(値 = 直前の成功 spawn の
    // turn)。読めた数字は「その turn の会話が実際に保存済み」を意味し、0 / 読めない = 会話が
    // 無い = fresh。resume の 3 条件 = turn ≥ 1・rotate 無し・registry に `existing` 引数が在る
    // runtime(claude / codex。無い runtime は常に fresh = AC-5)。
    // dir が作れない / account_id が門を通らない時は AC-X2: log 1 行で通常の fresh 経路に落ちる。
    let mut session_dir: Option<PathBuf> = None;
    let mut peek_dir: Option<PathBuf> = None;
    let mut hub_spawn: Option<HubSpawn> = None;
    if let Some(hub) = hub {
        if !is_safe_request_id(hub.account_id) {
            eprintln!(
                "broker: hub account_id is not a safe path element, falling back to a fresh session_dir"
            );
        } else {
            let dir = home.join("sessions").join("hub").join(hub.account_id).join(runtime);
            match fs::create_dir_all(dir.join("turns")) {
                Ok(()) => {
                    let last: u32 = fs::read_to_string(dir.join("turn"))
                        .ok()
                        .and_then(|s| s.trim().parse::<u32>().ok())
                        .unwrap_or(0);
                    // variant(PBI-0211)は親の resume 引数(argv は親のものを組んでから包む)
                    let existing = registry.session_args(variant_of(registry, runtime).unwrap_or(runtime), "existing");
                    let resume = last >= 1 && !hub.rotate && !existing.is_empty();
                    let turn = if resume { last + 1 } else { 1 };
                    hub_spawn = Some(HubSpawn {
                        resumed: resume,
                        turn,
                        dir: dir.clone(),
                    });
                    session_dir = Some(dir.join("turns").join(request_id));
                    peek_dir = Some(dir.clone());
                }
                Err(e) => eprintln!(
                    "broker: could not create the hub dir ({dir:?}), falling back to a fresh session_dir: {e}"
                ),
            }
        }
    }
    let session_dir = session_dir.unwrap_or_else(|| home.join("sessions").join(request_id));
    let peek_dir = peek_dir.as_deref();
    fs::create_dir_all(&session_dir).map_err(|e| {
        eprintln!("broker: session_dir mkdir failed ({session_dir:?}): {e}");
        "session_dir_failed".to_string()
    })?;
    let dir_str = session_dir.to_string_lossy().to_string();
    fs::write(session_dir.join("instruction.txt"), instruction).map_err(|e| {
        eprintln!("broker: could not write instruction.txt: {e}");
        "session_dir_failed".to_string()
    })?;
    // PBI-0616: allowlist が registry でなく内蔵表から来た session は、その事を 1 行残す
    // (`openroly peek` が header の下に出す)。内蔵表は砦であって正本ではないので、記録に
    // 残り続けるなら直すのは cache / 署名の側
    if registry.is_builtin_only() {
        let _ = fs::write(
            session_dir.join("egress.txt"),
            "egress: registry_unavailable — the allowlist came from the broker's built-in table\n",
        );
    }
    check_launchable(registry, runtime)?;
    // variant(PBI-0211)は親として argv と閉じ込め file を組み、最後に `openroly run <class>` で包む
    let parent = variant_of(registry, runtime);
    let base = parent.unwrap_or(catalog_kind(runtime));
    // PBI-0244: dedicated 経路は launch_in を直に呼ぶので、ここで deny を見る(spawn 直前の 2 本目)
    let program = resolve_program(found, base);
    check_program(&program).inspect_err(|_| discard_session_dir(&session_dir))?;
    // lane の folder(AC-4)。rule に無い path は起こさない(半端な session_dir も残さない)。
    // PBI-0230: hub の cwd は **固定**(turn で動かさない)。claude `--continue` は cwd を会話の
    // key にするため、turn dir / scratch では resume が効かない。payload の folder より hub dir を
    // 優先する(resume が壊れる物を cwd に渡さない)
    let folder = match &hub_spawn {
        Some(hs) => hs.dir.clone(),
        None => resolve_folder(isolation.folder, scope, isolation.lane, &session_dir, home, &isolation.user_home)
            .inspect_err(|_| discard_session_dir(&session_dir))?,
    };
    let folder_str = folder.to_string_lossy().to_string();
    let (mut args, files) = dedicated_launch(registry, base, isolation.lane, instruction, &dir_str, &folder_str, env)
        .inspect_err(|e| {
            if e != "lane_not_contained" {
                return discard_session_dir(&session_dir);
            }
            // PBI-0548: 起こさなかった理由を session_dir に 1 行残す(`openroly peek` が読む。instruction は id だけ = §19)
            let alt = wake_alternative(registry, found, runtime, e)
                .map(|kind| format!("; {kind} can take this lane"))
                .unwrap_or_default();
            let _ = fs::write(
                session_dir.join("skipped.txt"),
                format!("skipped: lane_not_contained — {base} is woken only for work you hand it (this wake's lane: {:?}){alt}\n", isolation.lane),
            );
        })?;
    // PBI-0230: resume の引数(registry `existing`)を dedicated argv に挿入する(variant は包む前の親の argv)。
    // 挿入位置は argv[0] が flag(`-` 始まり)なら先頭(claude: `claude --continue -p …`)、positional なら
    // その直後(codex: `codex exec resume --last …`)
    if let Some(hs) = hub_spawn.as_ref().filter(|hs| hs.resumed) {
        let existing = registry.session_args(base, "existing");
        let at = if args.first().is_some_and(|a| a.starts_with('-')) { 0 } else { 1 }.min(args.len());
        for (i, a) in existing.iter().enumerate() {
            args.insert(at + i, a.clone());
        }
        let _ = hs;
    }
    let (program, args) = match parent {
        Some(p) => variant_argv(found, runtime, p, &cli_argv(), args)
            .inspect_err(|_| discard_session_dir(&session_dir))?,
        None => (program, args),
    };
    // 閉じ込めの土台(PBI-0238 / 図72): session の egress proxy を先に立て(port が profile に要る)、
    // その port だけを許す sandbox で包んでから spawn する。proxy が立たない / 包めない(Windows・
    // Landlock ABI 4 未満の Linux・seatbelt が壊れた機)は **何も spawn せず** `sandbox_unavailable`(AC-X2)。
    let mut egress = egress::start(isolation.egress.clone(), request_id)
        .inspect_err(|_| discard_session_dir(&session_dir))?;
    let spec = SandboxSpec {
        folder,
        session_dir: session_dir.clone(),
        // 置き場の env(XDG_*_HOME / KIRO_HOME)は子が継ぐ broker の env と同じ瞬間に読む
        writable_extra: writable_extra(base, &isolation.user_home, &|k| std::env::var(k).ok()),
        deny_read: default_deny_read(&isolation.user_home),
        proxy_port: egress.port,
    };
    // PBI-0558: 辞書(secrets.json)を sandbox が deny する機の claude は、辞書を読める外の MCP server を broker が起こし、
    // runtime の MCP 設定を relay に向ける(起きなければ設定はそのまま)
    let files = if outside_masking(base, &isolation.user_home) {
        with_outside_masking(files, &mut egress, isolation.sandbox, &spec, scope, request_id)
    } else {
        files
    };
    // 閉じ込め用の file(claude の `--mcp-config`)を session_dir に置く。
    // spawn より **前** に全部書く —— 置けなかった runtime を「flag だけ付いた丸腰」で起こさない。
    for (rel, content) in &files {
        let path = session_dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                eprintln!("broker: could not create the dir for a containment file ({parent:?}): {e}");
                "session_dir_failed".to_string()
            })?;
        }
        fs::write(&path, content).map_err(|e| {
            eprintln!("broker: could not write a containment file ({path:?}): {e}");
            "session_dir_failed".to_string()
        })?;
    }
    // C1(PBI-0441 ③): claude なら専用 uid + pf anchor + 資格情報の file-drop + folder の ACL。
    // **掛ける条件を満たしたのに失敗したら起こさない**(fail-closed)—— hello は既に
    // `host_scoped` と名乗っているので、床のまま起こすと表示と実物が食い違う(AC-3 が殺す嘘)。
    // 掛からない runtime / C1 の無い機は `Ok(None)` = 今までどおり床で起こす。
    // peek の置き場は hub なら turn を跨ぐ会話 dir(`peek_dir`)、それ以外は session_dir
    // (`peek.ts` が同じ規則で開く)。C1 の session は **broker が置いた file** に書く(PBI-0644)
    let peek_file = peek_dir.unwrap_or(&session_dir).join(c1::PEEK_FILE);
    let c1_session = c1::setup_session(
        runtime,
        isolation.sandbox.egress_enforcement(),
        isolation.c1,
        &session_dir,
        &spec.folder,
        &peek_file,
    )
    .map_err(|e| {
        eprintln!("broker: c1 setup failed ({e}); refusing the session instead of running it unconfined");
        discard_session_dir(&session_dir);
        "sandbox_unavailable".to_string()
    })?;
    let as_user = c1_session.as_ref().map(|s| s.user.clone());
    // 専用 uid と pf 規則は proxy と同じ寿命で持つ(reaper が drop = 後始末)
    egress.c1 = c1_session;
    let child = launch_in(
        runtime,
        &program,
        &args,
        &registry.allowlist(),
        Some(&dir_str),
        scope,
        Some(request_id),
        peek_dir.as_deref(),
        Some((isolation.sandbox, &spec)),
        as_user.as_deref(),
    )
    .inspect_err(|e| {
        if e == "sandbox_unavailable" {
            discard_session_dir(&session_dir);
        }
    })?;
    // PBI-0230: turn file は spawn 成功後にのみ書く。書けなくても session は殺さない —— 次の
    // wake が 0 を読んで fresh に落ちる自己修復に任せる
    if let Some(hs) = &hub_spawn {
        if let Err(e) = fs::write(hs.dir.join("turn"), hs.turn.to_string()) {
            eprintln!(
                "broker: could not write the hub turn file ({:?}): {e}",
                hs.dir.join("turn")
            );
        }
    }
    Ok((child, egress, hub_spawn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;

    /// dedicated_launch の test 用 wrapper(official 2 種は registry を読まないので builtin で足りる。
    /// generic 経路の test は registry を直に組む)
    fn dedicated(
        runtime: &str,
        instruction: &str,
        session_dir: &str,
        folder: &str,
        env: &ContainmentEnv,
    ) -> Result<(Vec<String>, Vec<(String, String)>), String> {
        // official 2 種は lane を見ない(triage でも起きる)ので、lane は untrusted な方で固定
        dedicated_launch(&registry::builtin(), runtime, "triage", instruction, session_dir, folder, env)
    }

    // 実 claude/codex には触れない(テストプロセスの PATH 上に本物が存在しうるため、
    // built-in registry をそのまま使う spawn 検証は事故のもと — allowlist ごと差し替えて検証する)。

    fn allow(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn reg_with_ollama() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"ollama","detect":{"binaries":["ollama"]},"adapter":null},
                {"id":"superagent","detect":{"binaries":["superagent"]},"adapter":"official/superagent"}
            ]}"#,
            "t",
        )
        .unwrap()
        .merged_with_builtin()
    }

    #[tokio::test]
    async fn name_outside_allowlist_is_rejected_without_spawning() {
        let result = launch_with_allowlist("not-allowed", "not-allowed", &[], &allow(&["allowed-name"]), None);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
    }

    #[tokio::test]
    async fn local_kind_is_allowed_when_catalog_parent_is_on_the_allowlist() {
        let name = "openroly-broker-definitely-not-a-real-binary";
        let result = launch_with_allowlist("local-grok", name, &[], &allow(&["grok"]), None);
        assert_ne!(result.err(), Some("unknown_runtime".to_string()));
        let denied = launch_with_allowlist("local-foo", name, &[], &allow(&["grok"]), None);
        assert_eq!(denied.err(), Some("unknown_runtime".to_string()));
    }

    // PBI-0244 AC-3: **allowlist を通っていても** shell / interpreter は spawn しない。
    // registry の parse を迂回した Found(`id:"bash"`)を直接渡す = 二重の 2 本目だけを裸で測る。
    // 「spawn していない」は marker file で見る(Err を返しても子が動いていたら意味が無い)。
    #[tokio::test]
    async fn forbidden_program_is_not_spawned_even_if_allowlisted() {
        let marker = std::env::temp_dir().join(format!("openroly-pbi0244-launch-{}", std::process::id()));
        let _ = fs::remove_file(&marker);
        let args = allow(&["-c", &format!("touch {}", marker.display())]);
        let result = launch_with_allowlist("bash", "/bin/bash", &args, &allow(&["bash"]), None);
        assert_eq!(result.err(), Some("forbidden_program".to_string()));
        // bare name(PATH 解決)でも、版付きでも、大文字でも同じ
        for program in ["bash", "sh", "python3.12", "/usr/bin/env", "ZSH"] {
            let r = launch_with_allowlist("bash", program, &args, &allow(&["bash"]), None);
            assert_eq!(r.err(), Some("forbidden_program".to_string()), "{program} が通った");
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!marker.exists(), "forbidden な program を実際に spawn した");
    }

    #[tokio::test]
    async fn name_in_allowlist_but_missing_binary_returns_spawn_error() {
        // allowlist は通るが、そんな名前の実行可能ファイルは存在しない
        let name = "openroly-broker-definitely-not-a-real-binary";
        let result = launch_with_allowlist(name, name, &[], &allow(&[name]), None);
        assert!(result.is_err());
        assert_ne!(result.err(), Some("unknown_runtime".to_string()));
    }

    // PBI-0033 AC-1/AC-2: dedicated session は session_dir を cwd にし、Manual の bare spawn は
    // broker の cwd を継承すること(`claude -p` は trust dialog を出さずに cwd の設定・hooks を
    // 読むので、無人 session を broker daemon のカレントディレクトリで走らせない)。
    // 実 CLI は起動しない —— cwd を出力するだけの POSIX コマンド(pwd)を allowlist ごと注入する。

    #[tokio::test]
    async fn dedicated_session_runs_in_session_dir() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-cwd-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        let mut child = launch_with_allowlist("pwd", "pwd", &[], &allow(&["pwd"]), Some(&dir_str))
            .expect("pwd should spawn");
        assert!(child.wait().await.unwrap().success());
        let printed = fs::read_to_string(dir.join("stdout.log")).unwrap();
        // macOS の temp は /var → /private/var の symlink なので実体パスで比較する。
        assert_eq!(
            fs::canonicalize(printed.trim()).unwrap(),
            fs::canonicalize(&dir).unwrap(),
            "dedicated session の cwd が session_dir になっていない"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn manual_bare_spawn_keeps_broker_cwd() {
        // session_dir を渡さない経路(Manual routing の --continue / resume --last)では cwd を
        // 変えてはいけない —— 継ぐべき「直近 session」はディレクトリごとに決まるため。
        // stdout は継承なので、ここでは起動できることだけを見る(cwd の実体は AC-1 側で観測済み)。
        let mut child =
            launch_with_allowlist("pwd", "pwd", &[], &allow(&["pwd"]), None).expect("spawn");
        assert!(child.wait().await.unwrap().success());
    }

    // PBI-0320: Manual routing(bare spawn)と外部 API provider も scope token を子 env で受け取る。
    // 床を閉じた後は scope の無い session が agent 面に書けないので、この 2 経路で env が
    // 落ちると「起こしたのに何も書けない session」が生まれる(負の対照: `None` で起こすと
    // printenv が非 0 で終わる = env に載っていない、を同じ test で見る)。
    #[tokio::test]
    async fn manual_and_api_launch_pass_scope_env() {
        let reg = reg_with_api();
        // Manual: launch() は registry の session_args を使うので、ここは launch_with_scope の
        // 同じ穴(launch_in)を通る事を allowlist 経由で見る。program は check_program(PBI-0244)を通るので
        // shell ではなく printenv(未設定の変数では非 0 で終わる)
        let print_scope = vec!["OPENROLY_SESSION_SCOPE".to_string()];
        let mut manual = launch_with_scope(
            "env-probe",
            "printenv",
            &print_scope,
            &allow(&["env-probe"]),
            None,
            Some("pst_manual"),
            None,
        )
        .expect("printenv should spawn");
        assert!(manual.wait().await.unwrap().success(), "Manual 経路の子 env に scope が無い");

        // API provider: launch_api は `OPENROLY_CLI` の argv で起こす。argv を sh に差し替えて
        // 子 env だけを見る(引数の組み立ては別 test が見ている)
        let argv = vec!["sh".to_string(), "-c".to_string(), "printenv OPENROLY_SESSION_SCOPE > /dev/null".to_string()];
        let mut api = launch_api(&reg, "openai-api", "th_scope", &argv, Some("pst_api"))
            .expect("api spawn");
        assert!(api.wait().await.unwrap().success(), "API provider の子 env に scope が無い");

        // 負の対照: scope を渡さない起動では env に載らない(printenv が非 0)
        let mut none = launch_api(&reg, "openai-api", "th_scope", &argv, None).expect("api spawn");
        assert!(!none.wait().await.unwrap().success(), "scope 無しなのに env に載っている");
    }

    // PBI-0117: triage session は scope token を子 env `OPENROLY_SESSION_SCOPE` で受け取る(MCP が
    // 全 request の `x-openroly-session-scope` header で Cloud へ返す)。scope 無しの起動は env を
    // 載せない(work lane の implementer と scope を発行しない古い Cloud の片側確認)。
    #[tokio::test]
    async fn scoped_session_passes_env_and_unscoped_leaves_it_unset() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-scope-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        // **`sh -c` は使えない**(PBI-0244 の deny が spawn 直前で止める。それが正しい)。
        // env を印字するだけの実行ファイルを 1 本置いて、それを program にする
        let probe = dir.join("env-probe");
        fs::write(&probe, "#!/bin/sh\nprintenv OPENROLY_SESSION_SCOPE\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&probe, fs::Permissions::from_mode(0o755)).unwrap();
        let probe_path = probe.to_string_lossy().to_string();
        let print_scope: Vec<String> = vec![];

        let mut child = launch_with_scope(
            "env-probe",
            &probe_path,
            &print_scope,
            &allow(&["env-probe"]),
            Some(&dir_str),
            Some("pst_test_scope_token"),
            None,
        )
        .expect("env-probe should spawn");
        assert!(child.wait().await.unwrap().success());
        assert_eq!(
            fs::read_to_string(dir.join("stdout.log")).unwrap().trim(),
            "pst_test_scope_token",
            "scope token が子プロセスの env に載っていない"
        );

        let mut child = launch_with_scope(
            "env-probe",
            &probe_path,
            &print_scope,
            &allow(&["env-probe"]),
            Some(&dir_str),
            None,
            None,
        )
        .expect("env-probe should spawn");
        // printenv は未設定の変数で非 0 終了する = env に載っていない
        assert!(!child.wait().await.unwrap().success());
        assert_eq!(fs::read_to_string(dir.join("stdout.log")).unwrap().trim(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0224 AC-4: dedicated session の子 env に `OPENROLY_SESSION_ID=<request_id>` が載る(MCP server が
    // session_dir/peek.jsonl を書く鍵)。実 CLI は起動しない —— found の path に「env を印字するだけ」の
    // fake claude を置き、launch_session_scoped_in の実経路(instruction.txt → dedicated argv → spawn)で
    // stdout.log に何が出るかを見る。
    // **PBI-0238 の追随**(merge 時): dedicated 経路は必ず sandbox を通るので、
    // 働く backend が要る = **macOS だけ**(他 OS は NoSandbox = sandbox_unavailable。
    // `tests/pbi0238_sandbox_probe.rs` と同じ線引き)
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_session_env_has_session_id() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-peekenv-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        fs::write(&bin, "#!/bin/sh\nprintenv OPENROLY_SESSION_ID\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "claude".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        let home = dir.join("home");
        // **PBI-0238 の追随**(merge 時): 引数に `Isolation` が増え、返りが `(Child, Egress, Option<HubSpawn>)` に
        // なった(PBI-0230)。ここは peek の env(PBI-0224)を測る test なので閉じ込めは要らず、
        // `test_isolation()`(NoSandbox / allowlist 空)で足りる
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() };
        let (mut child, _egress, _hub) = launch_session_scoped_in(
            &home,
            &registry::builtin(),
            &found,
            "claude",
            "instr",
            "req_peek_1",
            None,
            &test_env(),
            &iso,
            None,
        )
        .expect("fake claude should spawn");
        assert!(child.wait().await.unwrap().success(), "printenv OPENROLY_SESSION_ID が非 0 = env に無い");
        let printed = fs::read_to_string(home.join("sessions").join("req_peek_1").join("stdout.log")).unwrap();
        assert_eq!(printed.trim(), "req_peek_1", "dedicated session の子 env OPENROLY_SESSION_ID が request_id でない");
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0224 AC-4 の裏側: manual `launch`(bare spawn)の子 env には OPENROLY_SESSION_ID が**無い**。
    // stdout は継承なので marker file に printenv の結果と exit code を書かせる。
    #[tokio::test]
    async fn manual_launch_env_has_no_session_id() {
        let reg = reg_with_ollama();
        let dir = std::env::temp_dir().join(format!("openroly-broker-nopeekenv-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("env.out");
        let bin = dir.join("superagent");
        fs::write(
            &bin,
            format!("#!/bin/sh\nprintenv OPENROLY_SESSION_ID > \"{m}\"; echo \"rc=$?\" >> \"{m}\"\n", m = marker.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "superagent".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        let mut child = launch(&reg, &found, "superagent", "new", None).expect("spawn by found path");
        child.wait().await.unwrap();
        let out = fs::read_to_string(&marker).unwrap();
        // printenv は未設定の変数で非 0 終了し、何も印字しない
        assert_eq!(out.trim(), "rc=1", "manual launch の子 env に OPENROLY_SESSION_ID が載っている: {out:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0022 AC-4c: adapter: null の id は allowlist に入らず not_launchable、registry 外は unknown_runtime
    #[tokio::test]
    async fn adapter_null_is_not_launchable_and_unknown_is_unknown() {
        let reg = reg_with_ollama();
        assert_eq!(launch(&reg, &[], "ollama", "new", None).err(), Some("not_launchable".to_string()));
        assert_eq!(launch(&reg, &[], "hermes", "new", None).err(), Some("unknown_runtime".to_string()));
        assert_eq!(launch(&reg, &[], "rm", "existing", None).err(), Some("unknown_runtime".to_string()));
        assert!(!reg.allowlist().contains(&"ollama".to_string()));
        assert!(reg.allowlist().contains(&"superagent".to_string()));
    }

    // PBI-0022 AC-3 / AC-4b: registry で足した id は allowlist を通り、found の path で spawn される
    #[tokio::test]
    async fn registry_added_runtime_launches_by_found_path() {
        let reg = reg_with_ollama();
        let dir = std::env::temp_dir().join(format!("openroly-broker-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("ran");
        let bin = dir.join("superagent");
        fs::write(&bin, format!("#!/bin/sh\n: > \"{}\"\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "superagent".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        // PATH には無い名前なので、found の path で起動できたことが marker で分かる
        let mut child = launch(&reg, &found, "superagent", "new", None).expect("spawn by found path");
        child.wait().await.unwrap();
        assert!(marker.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_program_prefers_found_path_but_not_app_bundles() {
        let found = vec![
            Found { id: "codex".into(), version: None, source: "brew".into(), path: "/opt/homebrew/bin/codex".into(), models: vec![] },
            Found { id: "ollama".into(), version: None, source: "app".into(), path: "/Applications/Ollama.app".into(), models: vec![] },
        ];
        assert_eq!(resolve_program(&found, "codex"), "/opt/homebrew/bin/codex");
        assert_eq!(resolve_program(&found, "ollama"), "ollama");
        assert_eq!(resolve_program(&found, "claude"), "claude");
    }

    // PBI-0019 AC-1/AC-2 + PBI-0167 AC-1〜AC-4: dedicated session の argv が実測どおりに組まれ、
    // 2 runtime とも閉じ込め(組込み tool を通さない)が argv / file として載ること。

    /// openroly MCP が登録済みの claude user config と codex config を模した env。
    fn test_env() -> ContainmentEnv {
        // 呼び出しごとに別の dir(PBI-0452 の公開 CI で実測)。pid だけだと同じ process で並列に走る
        // test が同じ `.claude.json` を取り合い、片方の `fs::write`(truncate → write)の途中を
        // もう片方が読んで「not valid JSON: EOF」→ `containment_unavailable` になる(ubuntu で 2 本赤)
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("openroly-broker-cenv-{}-{seq}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let config = dir.join(".claude.json");
        fs::write(
            &config,
            r#"{"mcpServers":{"openroly":{"type":"stdio","command":"bun","args":["/x/server.ts"],
               "env":{"OPENROLY_RUNTIME_KIND":"claude","OPENROLY_URL":"http://localhost:8787"}},
               "other":{"command":"other"}}}"#,
        )
        .unwrap();
        // codex は user の MCP server を全部載せる(--strict-mcp-config が無い)ので、
        // openroly 以外は `-c ….enabled=false` で落とす —— 実機の config.toml と同じ形で置く。
        let codex_config = dir.join("codex-config.toml");
        fs::write(
            &codex_config,
            "model = \"gpt-5\"\n\n[mcp_servers.playwright]\ncommand = \"npx\"\n\n\
             [mcp_servers.playwright.tools.browser_click]\nenabled = true\n\n\
             # [mcp_servers.commented-out]\n\
             [mcp_servers.openroly]\ncommand = \"bun\"\n\n[mcp_servers.obsidian]\ncommand = \"uvx\"\n",
        )
        .unwrap();
        ContainmentEnv {
            claude_config: config,
            claude_plugin_registry: dir.join("no-such-plugins.json"),
            codex_config,
        }
    }

    #[test]
    fn dedicated_launch_claude_matches_measured_argv() {
        let (args, files) = dedicated("claude", "INSTR", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--tools",
                "",
                "--setting-sources",
                "project",
                "--strict-mcp-config",
                "--mcp-config",
                "/tmp/sess/openroly-mcp.json",
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
                "mcp__openroly",
                "--output-format",
                "json",
                "--max-turns",
                "40",
            ]
        );
        // AC-2: 組込み tool を 1 つも積まない(`--allowedTools` は allow list ではないので
        // これが落ちると user の settings.json の有無に関わらず Bash が通る — 実測 E)
        let tools = args.iter().position(|a| a == "--tools").expect("--tools が無い");
        assert_eq!(args[tools + 1], "", "--tools が空文字でない = 組込み tool が積まれる");
        // AC-2: user / local の settings.json(allow 規則と hooks)を読ませない
        let sources = args.iter().position(|a| a == "--setting-sources").unwrap();
        assert_eq!(args[sources + 1], "project");
        // 可変長引数の直後は必ず別の flag(positional が続くと flag が食う — 実測 E)
        for flag in ["--tools", "--mcp-config", "--allowedTools"] {
            let i = args.iter().position(|a| a == flag).unwrap();
            assert!(
                args.get(i + 2).map(|a| a.starts_with('-')).unwrap_or(false),
                "{flag} の値の後ろが flag でない: {args:?}"
            );
        }
        // user settings を落とすと MCP 登録ごと消えるので、openroly の定義を session_dir に複製する
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "openroly-mcp.json");
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(cfg["mcpServers"]["openroly"]["command"], "bun");
        assert!(cfg["mcpServers"].get("other").is_none(), "openroly 以外の MCP まで持ち込まない");
    }

    // AC-4(claude 側): openroly MCP の定義を複製できない環境では起こさない。閉じ込めを緩めて
    // 起こす(user settings を読ませる)選択はしない。
    #[test]
    fn dedicated_launch_claude_without_openroly_mcp_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-cenv-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let no_plugin = dir.join("no-such-plugins.json");
        let missing = ContainmentEnv {
            claude_config: dir.join("absent.json"),
            claude_plugin_registry: no_plugin.clone(),
            codex_config: dir.join("no-such-codex.toml"),
        };
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &missing).err(),
            Some("containment_unavailable".to_string())
        );
        let broken = dir.join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &ContainmentEnv { claude_config: broken, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml") }).err(),
            Some("containment_unavailable".to_string())
        );
        let no_openroly = dir.join("no-openroly.json");
        fs::write(&no_openroly, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &ContainmentEnv { claude_config: no_openroly, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml") }).err(),
            Some("containment_unavailable".to_string())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // review 指摘(順95): **plugin-first**(配布戦略 §7.1・図10)で入れた claude は
    // `.claude.json` の `mcpServers` に openroly を持たない —— ① だけを見ていた実装では、
    // plugin で入れた user の全 dedicated session が containment_unavailable になり、
    // AUTO が dispatch_skip の log 1 行だけ残して黙って止まっていた。
    // ② plugin 台帳 → `<installPath>/.mcp.json` を複製元にし、`${CLAUDE_PLUGIN_ROOT}` を畳む。
    #[test]
    fn dedicated_launch_claude_falls_back_to_plugin_mcp_config() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-cenv-plugin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // local scope の install は壊れた plugin dir を指す(user scope が先に選ばれることの確認)
        let local_root = dir.join("cache/openroly/local");
        let user_root = dir.join("cache/openroly/0.1.0");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(
            user_root.join(".mcp.json"),
            r#"{"mcpServers":{"openroly":{"command":"${CLAUDE_PLUGIN_ROOT}/openroly-mcp",
               "args":["${CLAUDE_PLUGIN_ROOT}/mcp-server.bundle.js"],
               "env":{"OPENROLY_RUNTIME_KIND":"claude"}}}}"#,
        )
        .unwrap();
        let registry = dir.join("installed_plugins.json");
        fs::write(
            &registry,
            format!(
                r#"{{"version":2,"plugins":{{
                   "other@mkt":[{{"scope":"user","installPath":"{other}"}}],
                   "openroly@openroly-marketplace":[
                     {{"scope":"local","installPath":"{local}"}},
                     {{"scope":"user","installPath":"{user}"}}]}}}}"#,
                other = dir.join("cache/other").display(),
                local = local_root.display(),
                user = user_root.display(),
            ),
        )
        .unwrap();
        let env = ContainmentEnv {
            // user config は「有るが openroly は未登録」= plugin で入れた人の実態
            claude_config: {
                let c = dir.join(".claude.json");
                fs::write(&c, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
                c
            },
            claude_plugin_registry: registry,
            codex_config: dir.join("no-such-codex.toml"),
        };
        let (_, files) = dedicated("claude", "I", "/tmp/sess", "/tmp/work", &env).expect("起こせること");
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        let root = user_root.display().to_string();
        assert_eq!(cfg["mcpServers"]["openroly"]["command"], format!("{root}/openroly-mcp"));
        assert_eq!(cfg["mcpServers"]["openroly"]["args"][0], format!("{root}/mcp-server.bundle.js"));
        assert_eq!(cfg["mcpServers"]["openroly"]["env"]["OPENROLY_RUNTIME_KIND"], "claude");
        assert!(
            !files[0].1.contains("CLAUDE_PLUGIN_ROOT"),
            "変数が畳まれずに残ると command が見つからず、閉じ込めただけの丸腰 session になる: {}",
            files[0].1
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ① が有る時は ① を使う(plugin 台帳より user 登録が優先。`openroly install claude` した人の実態)。
    #[test]
    fn dedicated_launch_claude_prefers_user_config_over_plugin() {
        let (_, files) = dedicated("claude", "I", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(cfg["mcpServers"]["openroly"]["command"], "bun");
    }

    // AC-3: codex は既定に頼らず `--sandbox read-only` を明示する(既定は user の
    // ~/.codex/config.toml で上書きできる)。
    #[test]
    fn dedicated_launch_codex_matches_measured_argv() {
        let (args, files) = dedicated("codex", "INSTR", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                // review 指摘: openroly 以外の MCP server は sandbox の外で動くので明示的に落とす
                "-c",
                "mcp_servers.playwright.enabled=false",
                "-c",
                "mcp_servers.obsidian.enabled=false",
                "-C",
                "/tmp/work",
                "-o",
                "/tmp/sess/result.txt",
                "INSTR",
            ]
        );
        assert!(files.is_empty());
        let sandbox = args.iter().position(|a| a == "--sandbox").expect("--sandbox が無い");
        assert_eq!(args[sandbox + 1], "read-only");
        // openroly 自身は落とさない(落とすと閉じ込めただけで何も出来ない session になる)
        assert!(!args.iter().any(|a| a == "mcp_servers.openroly.enabled=false"));
        // instruction は最後(可変長の `-c` の直後に positional を置かない)
        assert_eq!(args.last().unwrap(), "INSTR");
    }

    // review 指摘(順95): codex の MCP は `--sandbox read-only` の外(別プロセス)なので、
    // 名前を取り切れない config は「server 無し」ではなく **判定不能**として起こさない。
    #[test]
    fn dedicated_launch_codex_with_unreadable_mcp_names_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-codex-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let env_with = |file: &str, body: &str| {
            let path = dir.join(file);
            fs::write(&path, body).unwrap();
            ContainmentEnv {
                claude_config: dir.join("no.json"),
                claude_plugin_registry: dir.join("no-plugins.json"),
                codex_config: path,
            }
        };
        // inline table: 行単位では名前を取り切れない
        let inline = env_with("inline.toml", "mcp_servers = { github = { command = \"x\" } }\n");
        assert_eq!(
            dedicated("codex", "I", "/tmp/s", "/tmp/work", &inline).err(),
            Some("containment_unavailable".to_string())
        );
        // quoted key: `-c` の key に埋められない
        let quoted = env_with("quoted.toml", "[mcp_servers.\"we ird\"]\ncommand = \"x\"\n");
        assert_eq!(
            dedicated("codex", "I", "/tmp/s", "/tmp/work", &quoted).err(),
            Some("containment_unavailable".to_string())
        );
        // config.toml 自体が無い = 落とす相手が居ない(openroly は plugin 側から来る)。起こしてよい
        let none = ContainmentEnv {
            claude_config: dir.join("no.json"),
            claude_plugin_registry: dir.join("no-plugins.json"),
            codex_config: dir.join("absent.toml"),
        };
        let (args, _) = dedicated("codex", "I", "/tmp/s", "/tmp/work", &none).unwrap();
        assert!(!args.iter().any(|a| a == "-c"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedicated_launch_unknown_runtime_is_unsupported() {
        let env = test_env();
        assert_eq!(
            dedicated("hermes", "INSTR", "/tmp/sess", "/tmp/work", &env).err(),
            Some("not_headless".to_string())
        );
        assert_eq!(
            dedicated("superagent", "INSTR", "/tmp/sess", "/tmp/work", &env).err(),
            Some("not_headless".to_string())
        );
        // PBI-0543: Gemini CLI は対応から外した —— official の実測 argv を持たない
        assert_eq!(
            dedicated("gemini", "INSTR", "/tmp/sess", "/tmp/work", &env).err(),
            Some("not_headless".to_string())
        );
    }

    // ---------- MCP の渡し方を launch の data に(PBI-0617) ----------
    //
    // AC-1 / AC-2 の argv と file は上の `dedicated_launch_claude_matches_measured_argv` /
    // `dedicated_launch_codex_matches_measured_argv` が見ている(built-in の `mcp_inject` を読んで
    // 実測と同じ argv になること)。ここは **data 側を動かした時に壊れる**ことを測る。

    /// `launch.mcp_inject` を差し替えた catalog entry(catalog は built-in より優先される)
    fn reg_inject(id: &str, adapter: &str, mcp_inject: &str) -> Registry {
        registry::parse(
            &format!(
                r#"{{"version":1,"detectors":[{{"id":"{id}","detect":{{"binaries":["{id}"]}},
                   "adapter":"{adapter}","sandbox_verified":"2026-09-16 t",
                   "launch":{{"headless":{{"argv":["--run","${{instruction}}"]}},"mcp_inject":{mcp_inject}}}}}]}}"#
            ),
            "t",
        )
        .unwrap()
    }

    // AC-4: 知らない strategy 名では起こさない —— 推測で claude の方式を当てはめると、MCP が載っていない
    // session を「載った」と思って起こす(閉じ込めただけで何も出来ない session が黙って出来上がる)。
    #[test]
    fn unknown_mcp_inject_strategy_is_unresolved() {
        for (id, adapter) in [("claude", "official/claude"), ("codex", "official/codex")] {
            let reg = reg_inject(id, adapter, r#"{"strategy":"telepathy"}"#);
            assert_eq!(
                dedicated_launch(&reg, id, "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
                Some("mcp_inject_unresolved".to_string()),
                "{id}: 知らない渡し方で起きてしまった"
            );
        }
        // generic 経路も同じ門。generic entry は claude の集め方(user config / plugin 台帳)を持たないので、
        // `config_flag` を名乗られても解決できない = 起こさない
        let reg = reg_inject(
            "foo",
            "generic/native",
            r#"{"strategy":"config_flag","file":"x.json","argv":["--mcp-config","${mcp_file}"]}"#,
        );
        assert_eq!(
            dedicated_launch(&reg, "foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("mcp_inject_unresolved".to_string()),
            "generic entry に claude の方式を当てはめて起こしてしまった"
        );
        // AC-3 の対: `prewired` は今までどおり argv だけ・生成 file 0
        let ok = reg_inject("foo", "generic/native", r#"{"strategy":"prewired"}"#);
        let (args, files) = dedicated_launch(&ok, "foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).unwrap();
        assert_eq!(files, vec![]);
        assert_eq!(args, vec!["--run", "I"]);
    }

    // 形が壊れている data でも起こさない(data に降ろした分だけ、data 側の 1 文字が穴になる)
    #[test]
    fn broken_mcp_inject_data_is_unresolved() {
        let broken = [
            // file 名に path を含める = session_dir の外に書く口
            r#"{"strategy":"config_flag","file":"../escape.json","argv":["--mcp-config","${mcp_file}"]}"#,
            r#"{"strategy":"config_flag","file":"/etc/openroly.json","argv":["--mcp-config","${mcp_file}"]}"#,
            // file は書くのに argv で渡さない = MCP 無しの session を「載った」と思って起こす
            r#"{"strategy":"config_flag","file":"openroly-mcp.json","argv":["--strict-mcp-config"]}"#,
        ];
        for case in broken {
            let reg = reg_inject("claude", "official/claude", case);
            assert_eq!(
                dedicated_launch(&reg, "claude", "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
                Some("mcp_inject_unresolved".to_string()),
                "壊れた data で起きてしまった: {case}"
            );
        }
        // codex: `${name}` を持たない template では他の server を落とし切れない(静かな全開放)
        let reg = reg_inject(
            "codex",
            "official/codex",
            r#"{"strategy":"disable_others","argv_template":["-c","mcp_servers.enabled=false"]}"#,
        );
        assert_eq!(
            dedicated_launch(&reg, "codex", "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("mcp_inject_unresolved".to_string())
        );
    }

    // catalog が渡し方をまだ持たない間も built-in が floor。`merged_with_builtin` は **id 単位**なので、
    // catalog の claude entry が built-in の entry ごと落とす —— field 単位で拾い直していないと、
    // 署名済み catalog が配られた端末だけ MCP 無しで起きる。
    #[test]
    fn catalog_without_mcp_inject_falls_back_to_builtin() {
        let reg = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["claude"]},
               "adapter":"official/claude","launch":{"new":[],"existing":["--continue"]}}]}"#,
            "t",
        )
        .unwrap();
        let (args, files) =
            dedicated_launch(&reg, "claude", "triage", "I", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert!(args.iter().any(|a| a == "--strict-mcp-config"), "MCP 無しで起きた: {args:?}");
        assert_eq!(files[0].0, CLAUDE_MCP_CONFIG);
    }

    // relay(PBI-0558)は生成 file を**名前で**探す。data 側の名前が動くと masking が黙って no-op になるので、
    // built-in の file 名と relay の anchor を 1 本に繋いでおく
    #[test]
    fn builtin_mcp_file_name_matches_relay_anchor() {
        let inject = mcp_inject(&registry::builtin(), "claude").expect("built-in に claude の渡し方が要る");
        assert_eq!(inject.strategy, "config_flag");
        assert_eq!(inject.file, CLAUDE_MCP_CONFIG);
    }

    // ---------- 起こし方を registry の data に(PBI-0618) ----------
    //
    // AC-1 / AC-2 の argv は上の `dedicated_launch_claude_matches_measured_argv` /
    // `dedicated_launch_codex_matches_measured_argv` が **期待値を変えずに** 見ている
    // (data から組み直しても実測と 1 要素も変わらない)。ここは data 側を動かした時の振る舞いを測る。

    // AC-4(この PBI の完成の文): **Rust を 1 行も変えずに**新しい runtime が起きる。
    // argv(全 placeholder)+ mcp_inject + egress.hosts + sandbox_verified だけを持つ架空の entry。
    #[test]
    fn a_new_runtime_launches_from_data_alone() {
        let reg = registry::parse(
            r#"{"version":1,"detectors":[{"id":"pi","detect":{"binaries":["pi"]},"adapter":"generic/native",
               "launch":{"headless":{"argv":["run","--turns","${max_turns}","--cwd","${folder}",
                          "--out","${session_dir}/r.txt","${mcp_argv}","--","${instruction}"]},
                         "mcp_inject":{"strategy":"prewired"}},
               "egress":{"hosts":["api.pi.example"]},
               "sandbox_verified":"2026-09-16 pi 1.0"}]}"#,
            "t",
        )
        .unwrap();
        let (args, files) =
            dedicated_launch(&reg, "pi", "work", "INSTR", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(
            args,
            vec!["run", "--turns", MAX_TURNS, "--cwd", "/tmp/work", "--out", "/tmp/sess/r.txt", "--", "INSTR"]
        );
        // prewired = 端末側で配線済み。`${mcp_argv}` は 0 要素に畳む(空文字の引数を残さない)
        assert!(!args.iter().any(|a| a == MCP_ARGV_SLOT || a.is_empty()), "{args:?}");
        assert_eq!(files, vec![]);
        // 定数は Rust に残す(catalog を署名し直さずに上限を動かせる)
        assert_eq!(MAX_TURNS, "40");
    }

    // 渡し方と差し込む場所は**噛み合っていなければ起こさない**。どちらの向きも
    // 「MCP の載っていない session を、載ったつもりで起こす」形になる。
    #[test]
    fn mcp_hand_over_and_argv_slot_must_line_up() {
        // ① 渡し方は在るのに argv に `${mcp_argv}` が無い = 黙って落ちる
        let no_slot = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["claude"]},"adapter":"official/claude",
               "launch":{"headless":{"argv":["-p","${instruction}","--tools",""]}}}]}"#,
            "t",
        )
        .unwrap();
        assert_eq!(
            dedicated_launch(&no_slot, "claude", "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("mcp_inject_unresolved".to_string()),
            "MCP を渡す場所の無い argv で起きた"
        );
        // ② official が「端末側で配線済み」を名乗る = 閉じ込めただけで何も出来ない session。
        // (entry に `mcp_inject` が**無い**時は built-in が floor として拾う ——
        // それは `catalog_without_mcp_inject_falls_back_to_builtin` が見ている)
        let prewired = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"binaries":["claude"]},"adapter":"official/claude",
               "launch":{"headless":{"argv":["-p","${instruction}","${mcp_argv}"]},"mcp_inject":{"strategy":"prewired"}}}]}"#,
            "t",
        )
        .unwrap();
        assert_eq!(
            dedicated_launch(&prewired, "claude", "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("mcp_inject_unresolved".to_string()),
            "official が MCP 無しで起きた"
        );
        // 対: generic は端末側の事前配線で起きてよい(slot は 0 要素に畳む)
        let generic = registry::parse(
            r#"{"version":1,"detectors":[{"id":"foo","detect":{"binaries":["foo"]},"adapter":"generic/native",
               "sandbox_verified":"2026-09-16 t",
               "launch":{"headless":{"argv":["--run","${instruction}","${mcp_argv}"]}}}]}"#,
            "t",
        )
        .unwrap();
        let (args, _) =
            dedicated_launch(&generic, "foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).unwrap();
        assert_eq!(args, vec!["--run", "I"]);
    }

    // ---------- generic 経路(PBI-0240) ----------

    fn generic_registry(launch_headless: bool, sandbox_verified: bool) -> Registry {
        let mut body = r#"{"version":1,"detectors":[
            {"id":"foo","detect":{"binaries":["foo"]},"adapter":"generic/native""#.to_string();
        if launch_headless {
            body.push_str(r#","launch":{"headless":{"argv":["--run","${instruction}","--folder","${folder}","--dir","${session_dir}"]}}"#);
        }
        if sandbox_verified {
            body.push_str(r#","sandbox_verified":"2026-09-12 foo 1.0""#);
        }
        body.push_str("}]}");
        registry::parse(&body, "t").unwrap()
    }

    // AC-1: argv の要素内置換。instruction 全文(改行・引用符を含む)が 1 要素のまま残る
    #[test]
    fn generic_headless_substitutes_elementwise() {
        let reg = generic_registry(true, true);
        let instruction = "line1\nline2 \"quoted\" $(pwd) `id`";
        let (args, files) = dedicated_launch(&reg, "foo", "work", instruction, "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(files, vec![]);
        assert_eq!(args[0], "--run");
        assert_eq!(args[1], instruction, "instruction 全文が 1 要素で無い: {args:?}");
        assert_eq!(args[3], "/tmp/work");
        assert_eq!(args[5], "/tmp/sess");
        assert_eq!(args.len(), 6);
    }

    // AC-4: sandbox_verified が無い generic は、他人の本文が入る lane では起こさない。
    // work lane（continue）は通す（PBI-0680。OS sandbox + egress が主の壁）。
    #[test]
    fn unverified_is_not_generic() {
        let reg = generic_registry(true, false);
        assert_eq!(
            dedicated_launch(&reg, "foo", "triage", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("not_verified".to_string())
        );
        assert!(dedicated_launch(&reg, "foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).is_ok());
        let ok = generic_registry(true, true);
        assert!(dedicated_launch(&ok, "foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).is_ok());
    }

    #[test]
    fn local_kind_uses_catalog_parent_for_headless() {
        let reg = generic_registry(true, false);
        assert!(dedicated_launch(&reg, "local-foo", "work", "I", "/tmp/s", "/tmp/work", &test_env()).is_ok());
        assert_eq!(
            dedicated_launch(&reg, "local-bar", "work", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("not_headless".to_string())
        );
    }

    // AC-X2: instruction に NUL が含まれる時は spawn の前に弾く(official 2 種でも同じ門)
    #[test]
    fn invalid_instruction_nul() {
        let reg = generic_registry(true, true);
        assert_eq!(
            dedicated_launch(&reg, "foo", "work", "a\0b", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("invalid_instruction".to_string())
        );
        assert_eq!(
            dedicated("claude", "a\0b", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("invalid_instruction".to_string())
        );
    }

    // AC-2: not_headless の代替 = hello found の headless 可(official ∪ launch.headless 有り)で別 id の最初
    #[test]
    fn not_headless_carries_alternative() {
        let reg = generic_registry(true, true);
        let found = |ids: &[&str]| {
            ids.iter()
                .map(|id| Found { id: id.to_string(), version: None, source: "path".to_string(), path: format!("/bin/{id}"), models: vec![] })
                .collect::<Vec<_>>()
        };
        // official が見つかっていればそれが代替になる
        assert_eq!(headless_alternative(&reg, &found(&["cursor-agent", "claude"]), "cursor-agent"), Some("claude".to_string()));
        // generic entry も代替になれる
        assert_eq!(headless_alternative(&reg, &found(&["cursor-agent", "foo"]), "cursor-agent"), Some("foo".to_string()));
        // wake された物自身・headless 不可の物は代替にならない
        assert_eq!(headless_alternative(&reg, &found(&["claude", "codex"]), "claude"), Some("codex".to_string()));
        assert_eq!(headless_alternative(&reg, &found(&["cursor-agent"]), "cursor-agent"), None);
        let reg_no = registry::parse(
            r#"{"version":1,"detectors":[{"id":"bar","adapter":"generic/native"}]}"#,
            "t",
        )
        .unwrap();
        assert_eq!(headless_alternative(&reg_no, &found(&["cursor-agent", "bar"]), "cursor-agent"), None);
        // PBI-0548: lane_not_contained の代替は claude / codex だけ(generic entry は同じ門でまた止まる)。他の理由は代替なし
        assert_eq!(wake_alternative(&reg, &found(&["opencode", "foo", "codex"]), "opencode", "lane_not_contained"), Some("codex".to_string()));
        assert_eq!(wake_alternative(&reg, &found(&["opencode", "foo"]), "opencode", "lane_not_contained"), None);
        assert_eq!(wake_alternative(&reg, &found(&["cursor-agent", "claude"]), "cursor-agent", "not_headless"), Some("claude".to_string()));
        assert_eq!(wake_alternative(&reg, &found(&["claude"]), "opencode", "sandbox_unavailable"), None);
    }

    // PBI-0548 AC-3: official 以外は lane work でしか起こさない(lane × runtime の表)。official 2 種は lane を見ない
    #[test]
    fn generic_runtime_is_refused_outside_work_lane() {
        let reg = generic_registry(true, true);
        let env = test_env();
        for lane in ["triage", "auto", "draft", "takeover", "manual", "owner", "Work", ""] {
            assert_eq!(
                dedicated_launch(&reg, "foo", lane, "I", "/tmp/s", "/tmp/work", &env).err(),
                Some("lane_not_contained".to_string()),
                "lane {lane:?} で generic runtime が起きる"
            );
            for official in ["claude", "codex"] {
                assert!(dedicated_launch(&reg, official, lane, "I", "/tmp/s", "/tmp/work", &env).is_ok(), "{official} が lane {lane:?} で止まった");
            }
        }
        assert!(dedicated_launch(&reg, "foo", "work", "I", "/tmp/s", "/tmp/work", &env).is_ok());
    }

    // PBI-0548 AC-3 / AC-X2: lane triage の catalog engine = spawn せず、理由と代替を session_dir の skipped.txt に残す
    #[cfg(unix)]
    #[tokio::test]
    async fn catalog_engine_in_triage_lane_spawns_nothing_and_leaves_the_reason() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("lane");
        let marker = dir.join("ran");
        let bin = dir.join("foo");
        fs::write(&bin, format!("#!/bin/sh\n: > \"{}\"\n", marker.display())).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = |id: &str, path: &str| Found { id: id.into(), version: None, source: "dir".into(), path: path.into(), models: vec![] };
        let found = vec![found("foo", &bin.to_string_lossy()), found("claude", "/bin/claude-not-here")];
        let iso = Isolation { lane: "triage", ..test_isolation() };
        let r = launch_session_scoped_in(
            &dir.join("home"), &generic_registry(true, true), &found, "foo", "INSTR", "req-lane", Some("pst_scope"), &test_env(), &iso, None,
        );
        assert_eq!(r.err(), Some("lane_not_contained".to_string()));
        assert!(!marker.exists(), "untrusted な lane で catalog engine が spawn された");
        let skipped = fs::read_to_string(dir.join("home/sessions/req-lane/skipped.txt")).expect("skipped.txt が残っていない");
        assert!(skipped.contains("lane_not_contained") && skipped.contains("\"triage\"") && skipped.contains("claude can take"), "{skipped}");
        let _ = fs::remove_dir_all(&dir);
    }

    // registry で足した runtime を AUTO で起こそうとしても bare spawn にはならない(not_headless。
    // PBI-0240 で dedicated_unsupported から改名 —— entry が起こし方を持たない事が伝わる語に)
    #[test]
    fn launch_session_refuses_runtime_without_dedicated_argv() {
        let tmp = std::env::temp_dir().join(format!("openroly-broker-ded-{}", std::process::id()));
        let result = launch_session_scoped_in(&tmp, &reg_with_ollama(), &[], "superagent", "instr", "req-ded", None, &test_env(), &test_isolation(), None);
        assert_eq!(result.err(), Some("not_headless".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    // PBI-0019 AC-11: dedicated session の境界(instruction 長・request_id 安全性・session_dir)。

    #[test]
    fn launch_session_rejects_oversized_instruction() {
        // runtime は registry 外のダミー名(PBI-0040) —— instruction_too_long は request_id/長さ判定
        // だけで確定するので実 runtime 名である必要が無い。判定順序を触る改修が入っても spawn に
        // 届かないための多層防御(launch_session_writes_instruction_file_and_reports_dir_failure と同じ意図)。
        let big = "x".repeat(MAX_INSTRUCTION_BYTES + 1);
        let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", &big, "req-1", None, &test_isolation(), None);
        assert_eq!(result.err(), Some("instruction_too_long".to_string()));
    }

    #[test]
    fn launch_session_accepts_instruction_at_limit_boundary() {
        // 16KB ちょうどは instruction_too_long にならない(> で判定。境界の 1 バイト差を守る)。
        // registry 外の名前を使い、instruction_too_long を通過した後で unknown_runtime に
        // 落ちることで「長さ判定は通った」ことだけを確認する(実 CLI は spawn しない)。
        let at_limit = "x".repeat(MAX_INSTRUCTION_BYTES);
        // request_id を安全な値にし、broker home を temp に向ける(env は触らない)
        let tmp = std::env::temp_dir().join(format!("openroly-broker-limit-{}", std::process::id()));
        let result =
            launch_session_scoped_in(&tmp, &registry::builtin(), &[], "not-a-real-runtime", &at_limit, "req-limit", None, &test_env(), &test_isolation(), None);
        // instruction_too_long ではないこと(registry で弾かれるのが正しい)
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn launch_session_rejects_unsafe_request_id() {
        // runtime は registry 外のダミー名(PBI-0040) —— invalid_request_id は他の全判定より先に
        // 確定するので実 runtime 名である必要が無い。
        for bad in ["", "../escape", "a/b", "with space", &"z".repeat(129)] {
            let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", "instr", bad, None, &test_isolation(), None);
            assert_eq!(
                result.err(),
                Some("invalid_request_id".to_string()),
                "request_id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn is_safe_request_id_accepts_generated_ids() {
        // generateId("wr") は wr_<uuidv7 hex/base32 相当>。英数と _/- のみ想定。
        assert!(is_safe_request_id("wr_01hxyz9abc"));
        assert!(is_safe_request_id("wr-ABC_123"));
        assert!(!is_safe_request_id("wr_/etc/passwd"));
    }

    #[test]
    fn launch_session_writes_instruction_file_and_reports_dir_failure() {
        // 前半 = 名前が主張しているもう半分(PBI-0034 で足され PBI-0022/0023 の launch_session_scoped_in
        // 6引数化で一度落ちたので PBI-0040 で復元): 成功経路では session_dir に instruction.txt が
        // 中身ごと残る。runtime は registry 外のダミー名 —— 万一 dir 判定をすり抜けても実 CLI に
        // 到達しない。
        let home = std::env::temp_dir().join(format!("openroly-broker-instr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let result =
            launch_session_scoped_in(&home, &registry::builtin(), &[], "not-a-real-runtime", "INSTR", "req-ok", None, &test_env(), &test_isolation(), None);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert_eq!(
            fs::read_to_string(home.join("sessions").join("req-ok").join("instruction.txt")).unwrap(),
            "INSTR",
            "instruction.txt が session_dir に残っていない、または中身が instruction と一致しない"
        );
        let _ = fs::remove_dir_all(&home);

        // 後半: session_dir が作れない状況(broker home が既存の通常ファイル)では session_dir_failed。
        // runtime は registry 外のダミー名 —— 万一 dir 判定をすり抜けても実 CLI に到達しない。
        let tmp_file = std::env::temp_dir().join(format!("openroly-broker-file-{}", std::process::id()));
        fs::write(&tmp_file, "not a dir").unwrap();
        let result =
            launch_session_scoped_in(&tmp_file, &registry::builtin(), &[], "not-a-real-runtime", "instr", "req-dir", None, &test_env(), &test_isolation(), None);
        // AC-11: reason は bare token 'session_dir_failed'(詳細は付けない)。
        assert_eq!(result.err(), Some("session_dir_failed".to_string()));
        let _ = fs::remove_file(&tmp_file);
    }

    // ---- PBI-0238: 閉じ込めの土台(図72)—— lane の folder / sandbox_unavailable / proxy env ----

    static NO_SANDBOX: crate::sandbox::NoSandbox = crate::sandbox::NoSandbox { reason: String::new() };
    /// test では C1 を掛けない(root op を打てない)。**掛かっていない事が既定**なので、
    /// 既存の spawn 検査は 1 本も形が変わらない —— C1 の形は `c1.rs` の test が fake で武装する。
    static C1_OFF: c1::C1Status = c1::C1Status { available: false, reason: String::new() };

    // PBI-0558: 外の masking server を使うのは claude で、sandbox が deny する secrets.json(旧置き場も)が在る時だけ
    #[test]
    fn outside_masking_only_for_claude_on_a_machine_with_a_secrets_file() {
        let home = tmp("mask-decide");
        assert!(!outside_masking("claude", &home), "secrets.json の無い機で外の server を起こす");
        fs::create_dir_all(home.join(".atn")).unwrap();
        fs::write(home.join(".atn/secrets.json"), "[]").unwrap();
        assert!(outside_masking("claude", &home));
        for other in ["codex", "opencode", "kiro"] {
            assert!(!outside_masking(other, &home), "{other} の MCP 設定は broker が書かない");
        }
        let _ = fs::remove_dir_all(&home);
    }

    // PBI-0558: relay 向けの設定は同じ server 定義のまま、env に relay 先と token の 2 つだけが足る
    #[test]
    fn relay_config_keeps_the_server_definition_and_adds_only_the_relay_env() {
        let (_, files) = dedicated("claude", "I", "/tmp/s", "/tmp/w", &test_env()).unwrap();
        let relayed: serde_json::Value = serde_json::from_str(&relay_mcp_config(&files[0].1, 41234, "tok").unwrap()).unwrap();
        let def = &relayed["mcpServers"]["openroly"];
        assert_eq!(def["command"], "bun");
        assert_eq!(def["args"][0], "/x/server.ts");
        assert_eq!(def["env"]["OPENROLY_RUNTIME_KIND"], "claude");
        assert_eq!(def["env"]["OPENROLY_MCP_RELAY"], "127.0.0.1:41234");
        assert_eq!(def["env"]["OPENROLY_MASK_TOKEN"], "tok");
    }

    // PBI-0558(実 seatbelt): secrets.json の在る機の claude session。runtime は secrets.json を読めず、MCP 設定の relay 先
    // (egress proxy)へ token 付きで CONNECT すると、secrets.json を読める外の server の stdio に届く。
    // 外の server は定義どおりの command(ここでは読めたかを 1 行書いてから byte を返す sh)
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_session_uses_outside_masking_server() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("mask-live");
        let home = dir.join("home");
        fs::create_dir_all(home.join(".openroly")).unwrap();
        let secrets = home.join(".openroly/secrets.json");
        fs::write(&secrets, "[\"yamada\"]").unwrap();
        let server = dir.join("server.sh");
        fs::write(&server, "#!/bin/sh\ncat \"$SECRETS\" >/dev/null 2>&1 && echo server=readable || echo server=denied\nexec cat\n").unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
        let config = dir.join(".claude.json");
        let def = serde_json::json!({ "mcpServers": { "openroly": { "command": server, "args": [], "env": { "SECRETS": secrets } } } });
        fs::write(&config, def.to_string()).unwrap();
        let env = ContainmentEnv { claude_config: config, claude_plugin_registry: dir.join("none.json"), codex_config: dir.join("none.toml") };
        let bin = dir.join("claude");
        fs::write(
            &bin,
            format!(
                "#!/bin/bash\n\
                 while [ $# -gt 0 ]; do [ \"$1\" = --mcp-config ] && cfg=\"$2\"; shift; done\n\
                 cat \"{s}\" >/dev/null 2>&1 && echo runtime=readable || echo runtime=denied\n\
                 relay=$(grep -o '\"OPENROLY_MCP_RELAY\":\"[^\"]*\"' \"$cfg\" | cut -d'\"' -f4)\n\
                 token=$(grep -o '\"OPENROLY_MASK_TOKEN\":\"[^\"]*\"' \"$cfg\" | cut -d'\"' -f4)\n\
                 exec 3<>/dev/tcp/${{relay%:*}}/${{relay#*:}} || exit 3\n\
                 printf 'CONNECT openroly-mask.invalid:1 HTTP/1.1\\r\\nProxy-Authorization: Bearer %s\\r\\n\\r\\nping\\n' \"$token\" >&3\n\
                 for i in 1 2 3 4; do IFS= read -r -t 10 line <&3 && echo \"got:$line\"; done\n",
                s = secrets.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found { id: "claude".into(), version: None, source: "dir".into(), path: bin.to_string_lossy().into(), models: vec![] }];
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, lane: "triage", user_home: home.clone(), ..test_isolation() };
        let broker = dir.join("broker");
        let (mut child, egress, _hub) =
            launch_session_scoped_in(&broker, &registry::builtin(), &found, "claude", "instr", "req_mask_1", Some("scope"), &env, &iso, None)
                .expect("fake claude should spawn");
        child.wait().await.unwrap();
        let session = broker.join("sessions/req_mask_1");
        let out = fs::read_to_string(session.join("stdout.log")).unwrap();
        assert!(out.contains("runtime=denied"), "runtime が secrets.json を読めた: {out}");
        assert!(out.contains("got:HTTP/1.1 200"), "relay 先で外の server に届かない: {out}");
        assert!(out.contains("got:server=readable"), "外の server が secrets.json を読めない: {out}");
        assert!(out.contains("got:ping"), "byte が素通しされない: {out}");
        assert_eq!(fs::read_to_string(session.join("masking.txt")).unwrap(), "masking: outside sandbox\n");
        drop(egress);
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0616: 通信先を data で持たない runtime の wake も代替を 1 つ添えて返す。`no_egress_hosts` の
    // 門は argv の門より先に効くので、足さないと `local-*` の wake が「起こせない上に次の手が無い」返事になる
    #[test]
    fn no_egress_hosts_still_offers_an_alternative() {
        let found = vec![
            Found { id: "local-foo".into(), version: None, source: "path".into(), path: "/opt/bin/foo".into(), models: vec![] },
            Found { id: "claude".into(), version: None, source: "npm".into(), path: "/opt/bin/claude".into(), models: vec![] },
        ];
        let reg = registry::builtin();
        assert_eq!(wake_alternative(&reg, &found, "local-foo", "no_egress_hosts").as_deref(), Some("claude"));
        // 代替を持たない理由には今までどおり添えない
        assert_eq!(wake_alternative(&reg, &found, "local-foo", "session_active"), None);
    }

    // PBI-0616 AC-3: allowlist が registry ではなく内蔵表から来た session は、その事が記録に 1 行残る
    // (`openroly peek` が header の下に出す)。registry を読めた機には残さない —— 残っていたら
    // 直す対象は cache / 署名の側で、runtime でも allowlist でもない
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_builtin_only_registry_leaves_one_line_about_where_the_allowlist_came_from() {
        let dir = tmp("egress-note");
        let (found, _marker) = fake_claude(&dir);
        let home = dir.join("home");
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() };
        let (mut child, _egress, _hub) = launch_session_scoped_in(
            &home, &registry::builtin(), &found, "claude", "INSTR", "req-note", None, &test_env(), &iso, None,
        )
        .expect("spawn");
        let _ = child.wait().await;
        assert_eq!(
            fs::read_to_string(home.join("sessions/req-note/egress.txt")).unwrap(),
            "egress: registry_unavailable — the allowlist came from the broker's built-in table\n"
        );
        let reg = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","adapter":"official/claude","egress":{"hosts":["api.anthropic.com"]}}]}"#,
            "cache",
        )
        .unwrap();
        let (mut child2, _egress2, _hub2) = launch_session_scoped_in(
            &home, &reg, &found, "claude", "INSTR", "req-registry", None, &test_env(), &iso, None,
        )
        .expect("spawn");
        let _ = child2.wait().await;
        assert!(
            !home.join("sessions/req-registry/egress.txt").exists(),
            "registry を読めた機に退避の記録が残った"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn test_isolation() -> Isolation<'static> {
        Isolation {
            sandbox: &NO_SANDBOX,
            egress: EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None },
            folder: None,
            lane: "manual",
            user_home: std::env::temp_dir(),
            c1: &C1_OFF,
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openroly-broker-0238-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `claude` の名前で found に載せる fake runtime(sh script)。found の path が bare name より
    /// 優先されるので実 claude は起こさない。cwd と proxy env を stdout に出し、`ran` marker を残す。
    fn fake_claude(dir: &Path) -> (Vec<Found>, PathBuf) {
        let marker = dir.join("ran");
        let bin = dir.join("claude");
        fs::write(
            &bin,
            format!(
                // perl で書く: sh は起動時に継いだ PWD を cwd に直してしまうので、sh の `$PWD` は broker が渡した値を映さない
                // (PBI-0577 の負の対照で実測 —— PWD を渡す行を外しても緑のままだった)。4 行目は argv(PBI-0230 の hub test が resume 引数を見る)
                "#!/usr/bin/perl\nuse Cwd;\nopen(my $m, '>', \"{}\") or die;\nclose $m;\nprint getcwd(), \"\\n\";\nprint \"$ENV{{HTTPS_PROXY}}|$ENV{{NO_PROXY}}|$ENV{{NODE_USE_ENV_PROXY}}\\n\";\nprint \"$ENV{{PWD}}\\n\";\nprint join(\" \", @ARGV), \"\\n\";\n",
                marker.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "claude".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        (found, marker)
    }

    // AC-4: folder 無し(triage)= cwd は session_dir/scratch(空)。proxy env が載り、profile が残る。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_launch_uses_scratch_for_triage() {
        let dir = tmp("scratch");
        let (found, marker) = fake_claude(&dir);
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() };
        let (mut child, egress, _hub) = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-scratch", Some("pst_scope"), &test_env(), &iso, None,
        )
        .expect("spawn");
        assert!(child.wait().await.unwrap().success());
        let session = dir.join("home").join("sessions").join("req-scratch");
        let out = fs::read_to_string(session.join("stdout.log")).unwrap();
        let mut lines = out.lines();
        assert_eq!(
            fs::canonicalize(lines.next().unwrap()).unwrap(),
            fs::canonicalize(session.join("scratch")).unwrap(),
            "triage の cwd が session_dir/scratch でない"
        );
        assert_eq!(lines.next().unwrap(), format!("http://127.0.0.1:{}||1", egress.port), "proxy env");
        // PBI-0577 AC-X1: PWD も cwd と同じ(broker の PWD を継がない)
        assert_eq!(
            fs::canonicalize(lines.next().unwrap()).unwrap(),
            fs::canonicalize(session.join("scratch")).unwrap(),
            "triage の PWD が session_dir/scratch でない"
        );
        assert!(marker.exists());
        assert!(fs::read_dir(session.join("scratch")).unwrap().next().is_none(), "scratch は空");
        assert!(fs::read_to_string(session.join("sandbox.sb")).unwrap().contains(&format!("remote tcp \"*:{}\"", egress.port)));
        let _ = fs::remove_dir_all(&dir);
    }

    // **PBI-0403 AC-2 の不確実性#2**: sandbox(seatbelt)配下の子でも process group が効くか。
    // `sandbox.wrap` は SANDBOX_EXEC を新しい起点にして cmd を丸ごと作り直すので、`process_group(0)`
    // を wrap の**前**に置くと sandboxed(= dedicated session。孫を持つ経路そのもの)でだけ黙って
    // 消える —— この test を書く前に実際にそれを踏んだ(wrap 前の位置では孫が生き残った)。
    // dedicated 経路の実 spawn(`launch_session_scoped_in`)で測る: fake claude が孫を fork し、
    // sessions::Sessions 経由の cancel で group ごと落ちるかを見る。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_session_cancel_kills_grandchild_through_sandbox() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;
        let dir = tmp("grandchild-sandbox");
        let pidfile = dir.join("grandchild.pid"); // TMPDIR 配下は profile が常に書ける(sandbox.rs:228)
        let bin = dir.join("claude");
        fs::write(
            &bin,
            format!(
                "#!/bin/sh\nsleep 120 &\necho $! > \"{p}.tmp\"\nmv \"{p}.tmp\" \"{p}\"\nexec sleep 120\n",
                p = pidfile.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let found = vec![Found {
            id: "claude".into(),
            version: None,
            source: "dir".into(),
            path: bin.to_string_lossy().into(),
            models: vec![],
        }];
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() };
        let (child, _egress, _hub) = launch_session_scoped_in(
            &dir.join("home"),
            &registry::builtin(),
            &found,
            "claude",
            "instr",
            "req-sandbox-grandchild",
            None,
            &test_env(),
            &iso,
            None,
        )
        .expect("fake claude should spawn under seatbelt");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let gpid = loop {
            if let Some(p) = fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<u32>().ok()) {
                break p;
            }
            assert!(std::time::Instant::now() < deadline, "sandboxed 経路で孫が起きない");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let alive = |pid: u32| unsafe { libc::kill(pid as i32, 0) == 0 };
        assert!(alive(gpid), "孫が起きていない = 何も測っていない");

        let sessions = crate::sessions::Sessions::new(None);
        sessions.insert(crate::sessions::Session {
            request_id: "req-sandbox-grandchild".to_string(),
            lane: "owner".to_string(),
            account_id: "acc-1".to_string(),
            thread_id: String::new(),
            runtime: "claude".to_string(),
            started_at: 0,
            child: Some(child),
            egress: None,
            last_tool: None,
            tool_count: 0,
            exit: None,
            cancel_reason: None,
            // PBI-0392 と同じ形(hub の 2 field を持たない初期化)。この test は main で後から入ったので、
            // 取り込みで同じ追従が要る —— dedicated session 相当の既定
            resumed: false,
            hub_dir: None,
        });
        assert!(sessions.cancel("req-sandbox-grandchild", "cancelled"));
        let cancel_deadline = std::time::Instant::now() + Duration::from_secs(10);
        while alive(gpid) {
            assert!(
                std::time::Instant::now() < cancel_deadline,
                "sandbox-exec 配下で起きた孫({gpid})が group kill で死なない(PBI-0403 AC-2 不確実性#2)"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-4: owner wake の folder = cwd。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_launch_owner_folder_is_cwd() {
        let dir = tmp("owner");
        let (found, _) = fake_claude(&dir);
        let proj = dir.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let proj_str = proj.to_string_lossy().to_string();
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, folder: Some(&proj_str), ..test_isolation() };
        let (mut child, _egress, _hub) = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-owner", None, &test_env(), &iso, None,
        )
        .expect("spawn");
        assert!(child.wait().await.unwrap().success());
        let out = fs::read_to_string(dir.join("home/sessions/req-owner/stdout.log")).unwrap();
        assert_eq!(fs::canonicalize(out.lines().next().unwrap()).unwrap(), fs::canonicalize(&proj).unwrap());
        // PBI-0577 AC-1: PWD も folder(broker を起こした shell の dir を継がない。OpenCode は session を $PWD に作る)
        assert_eq!(fs::canonicalize(out.lines().nth(2).unwrap()).unwrap(), fs::canonicalize(&proj).unwrap(), "PWD が folder でない");
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-4: rule に無い folder は起こさない(半端な session_dir も残さない)。
    #[tokio::test]
    async fn dedicated_launch_refuses_folder_not_allowed() {
        let dir = tmp("folder");
        let (found, marker) = fake_claude(&dir);
        let user_home = dir.join("userhome");
        fs::create_dir_all(user_home.join(".ssh")).unwrap();
        fs::create_dir_all(user_home.join("Library").join("x")).unwrap();
        let ok_folder = dir.join("proj");
        fs::create_dir_all(&ok_folder).unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        let cases: Vec<(String, Option<&str>)> = vec![
            ("/".to_string(), None),
            ("relative/x".to_string(), None),
            (s(&dir.join("does-not-exist")), None),
            (s(&user_home), None),
            (s(&user_home.join(".ssh")), None),
            (s(&user_home.join("Library").join("x")), None),
            (s(&dir.join("claude")), None),          // file であって dir でない
            (s(&dir.join("home")), None),            // broker home の下
            (s(&ok_folder), Some("pst_triage")),     // triage は folder を持たない
        ];
        for (i, (folder, scope)) in cases.iter().enumerate() {
            let iso = Isolation { folder: Some(folder), user_home: user_home.clone(), ..test_isolation() };
            let rid = format!("req-f{i}");
            let r = launch_session_scoped_in(
                &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", &rid, *scope, &test_env(), &iso, None,
            );
            assert_eq!(r.err(), Some("folder_not_allowed".to_string()), "case {i}: {folder:?}");
            assert!(!dir.join("home").join("sessions").join(&rid).exists(), "case {i}: 半端な session_dir が残った");
        }
        assert!(!marker.exists(), "folder_not_allowed で何かが spawn された");
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0440: ~/.openroly の下で通るのは fork の枝の folder(worktrees の 1 段下)だけ。scope token 付きで
    // folder を持てるのは lane work だけ(triage は今まで通り拒む)
    #[test]
    fn resolve_folder_passes_only_a_fork_folder_under_openroly_and_scoped_folders_only_in_the_work_lane() {
        let dir = tmp("fork-folder");
        let user_home = dir.join("userhome");
        let worktrees = user_home.join(".openroly").join("worktrees");
        let fork = worktrees.join("f1");
        let deeper = fork.join("sub");
        let checkpoints = user_home.join(".openroly").join("checkpoints");
        fs::create_dir_all(&deeper).unwrap();
        fs::create_dir_all(&checkpoints).unwrap();
        let session = dir.join("session");
        let home = dir.join("home");
        let refused = Err("folder_not_allowed".to_string());
        let resolve = |folder: &Path, scope: Option<&str>, lane: &str| {
            resolve_folder(Some(&folder.to_string_lossy()), scope, lane, &session, &home, &user_home)
        };
        assert_eq!(resolve(&fork, None, "work"), Ok(fs::canonicalize(&fork).unwrap()));
        assert_eq!(resolve(&fork, Some("pst_review"), "work"), Ok(fs::canonicalize(&fork).unwrap()));
        assert_eq!(resolve(&fork, Some("pst_triage"), "triage"), refused);
        assert_eq!(resolve(&fork, Some("pst_x"), "manual"), refused);
        assert_eq!(resolve(&worktrees, None, "work"), refused);
        assert_eq!(resolve(&deeper, None, "work"), refused);
        assert_eq!(resolve(&checkpoints, None, "work"), refused);
        let _ = fs::remove_dir_all(&dir);
    }

    // runtime-transfer module review: 柵の例外(worktrees の 1 段下)を symlink で柵の中へ向けても通らない・
    // `~/.atn` だけの端末(MCP の openrolyHome が旧 state dir を返す)でも枝の folder が通る
    #[test]
    fn resolve_folder_fork_exception_does_not_follow_symlinks_into_the_fence_and_covers_the_legacy_state_dir() {
        use std::os::unix::fs::symlink;
        let dir = tmp("fork-folder-attack");
        let user_home = dir.join("userhome");
        let ssh_keys = user_home.join(".ssh").join("keys");
        let worktrees = user_home.join(".openroly").join("worktrees");
        let legacy_worktrees = user_home.join(".atn").join("worktrees");
        let legacy_fork = legacy_worktrees.join("f2");
        for d in [&ssh_keys, &worktrees, &legacy_fork, &user_home.join(".atn").join("other")] {
            fs::create_dir_all(d).unwrap();
        }
        // 枝の名を名乗る symlink が柵の中(~/.ssh)を指す
        symlink(user_home.join(".ssh"), worktrees.join("evil")).unwrap();
        // worktrees 自身が柵の中を指す別の home
        let home2 = dir.join("userhome2");
        fs::create_dir_all(home2.join(".ssh").join("keys")).unwrap();
        fs::create_dir_all(home2.join(".openroly")).unwrap();
        symlink(home2.join(".ssh"), home2.join(".openroly").join("worktrees")).unwrap();
        let session = dir.join("session");
        let home = dir.join("home");
        let refused = Err("folder_not_allowed".to_string());
        let resolve = |folder: &Path, user_home: &Path| {
            resolve_folder(Some(&folder.to_string_lossy()), None, "work", &session, &home, user_home)
        };
        assert_eq!(resolve(&worktrees.join("evil"), &user_home), refused);
        assert_eq!(resolve(&home2.join(".openroly").join("worktrees").join("keys"), &home2), refused);
        assert_eq!(resolve(&legacy_fork, &user_home), Ok(fs::canonicalize(&legacy_fork).unwrap()));
        assert_eq!(resolve(&legacy_worktrees, &user_home), refused);
        assert_eq!(resolve(&user_home.join(".atn").join("other"), &user_home), refused);
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-5 / AC-X2: backend が無い(Windows / Landlock ABI 4 未満の Linux / seatbelt が壊れた機)= 何も spawn せず
    // `sandbox_unavailable`。session_dir も残さない。
    #[tokio::test]
    async fn dedicated_launch_sandbox_unavailable_spawns_nothing() {
        let dir = tmp("nosb");
        let (found, marker) = fake_claude(&dir);
        let proj = dir.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let proj_str = proj.to_string_lossy().to_string();
        let iso = Isolation { folder: Some(&proj_str), ..test_isolation() };
        let r = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-nosb", None, &test_env(), &iso, None,
        );
        assert_eq!(r.err(), Some("sandbox_unavailable".to_string()));
        assert!(!marker.exists(), "sandbox 無しで spawn された");
        assert!(!dir.join("home/sessions/req-nosb").exists(), "半端な session_dir が残った");
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-X1 の入口側: folder 名で profile に規則を注入できない(`"` を含む dir は起こさない)。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn dedicated_launch_refuses_folder_that_would_inject_profile_rules() {
        let dir = tmp("inject");
        let (found, marker) = fake_claude(&dir);
        let evil = dir.join("x\") (allow network*) (subpath \"");
        fs::create_dir_all(&evil).unwrap();
        let evil_str = evil.to_string_lossy().to_string();
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, folder: Some(&evil_str), ..test_isolation() };
        let r = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-inject", None, &test_env(), &iso, None,
        );
        assert_eq!(r.err(), Some("sandbox_unavailable".to_string()));
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- PBI-0230: hub session(owner lane 専用。runtime resume で文脈を引き継ぐ)----

    /// hub 経路の共通実行(claude・owner lane の形)。呼び手は macOS 限定(Seatbelt が要る)。
    fn hub_spawn(
        home: &Path,
        found: &[Found],
        request_id: &str,
        rotate: bool,
    ) -> Result<(Child, Egress, Option<HubSpawn>), String> {
        launch_session_scoped_in(
            home,
            &registry::builtin(),
            found,
            "claude",
            "INSTR",
            request_id,
            None,
            &test_env(),
            &Isolation {
                sandbox: &crate::sandbox::Seatbelt,
                ..test_isolation()
            },
            Some(&HubContext {
                account_id: "acc-hub",
                rotate,
            }),
        )
    }

    // AC-1: 初回の hub turn は fresh。argv に resume 引数は載らず、turn file は 1、cwd と
    // session_dir は hub dir / hub dir/turns/<rid>。peek の置き場を知らせる env も turn dir。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_first_turn_is_fresh() {
        let dir = tmp("hub1");
        let (found, marker) = fake_claude(&dir);
        let home = dir.join("home");
        let (mut child, _egress, hub) = hub_spawn(&home, &found, "req-h1", false).expect("spawn");
        let hub = hub.expect("hub spawn should carry HubSpawn");
        assert!(!hub.resumed, "初回なのに resumed");
        assert_eq!(hub.turn, 1);
        assert!(child.wait().await.unwrap().success());
        assert!(marker.exists(), "fake claude が動いていない");
        let hub_dir = home.join("sessions/hub/acc-hub/claude");
        assert_eq!(fs::read_to_string(hub_dir.join("turn")).unwrap(), "1");
        let turn_dir = hub_dir.join("turns").join("req-h1");
        assert!(turn_dir.join("instruction.txt").exists());
        assert!(turn_dir.join("stdout.log").exists());
        // cwd = hub dir(固定。resume の会話 key)
        let out = fs::read_to_string(turn_dir.join("stdout.log")).unwrap();
        let mut lines = out.lines();
        assert_eq!(
            fs::canonicalize(lines.next().unwrap()).unwrap(),
            fs::canonicalize(&hub_dir).unwrap(),
            "hub の cwd が hub dir でない"
        );
        assert!(lines.next().unwrap().contains(&format!("http://127.0.0.1:{}", _egress.port)), "proxy env が無い");
        let _pwd = lines.next();
        let argv = lines.next().expect("fake が argv を印字していない");
        assert!(argv.starts_with("-p "), "初回の argv が dedicated の形でない: {argv}");
        assert!(!argv.contains("--continue"), "初回なのに resume 引数が載った");
        // peek の置き場(PBI-0224)は OPENROLY_SESSION_DIR で turn dir へ向く。子 env の実測は
        // dedicated_session_env_has_session_id と同じ fake で見る —— ここは argv 経由で担保
        assert!(turn_dir.join("instruction.txt").exists(), "session_dir が turn dir でない");
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-2: 前の turn が保存済み(turn file ≥ 1)なら runtime resume。argv 先頭に `--continue`、
    // turn = 2、turn file は 2 に進む。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_second_turn_resumes() {
        let dir = tmp("hub2");
        let (found, marker) = fake_claude(&dir);
        let home = dir.join("home");
        let hub_dir = home.join("sessions/hub/acc-hub/claude");
        fs::create_dir_all(&hub_dir).unwrap();
        fs::write(hub_dir.join("turn"), "1").unwrap();
        let (mut child, _egress, hub) = hub_spawn(&home, &found, "req-h2", false).expect("spawn");
        let hub = hub.expect("hub spawn");
        assert!(hub.resumed, "turn file 1 なのに fresh になった");
        assert_eq!(hub.turn, 2);
        assert!(child.wait().await.unwrap().success());
        assert!(marker.exists());
        // 挿入位置: claude の argv[0] は flag(`-p`)なので先頭
        let out = fs::read_to_string(hub_dir.join("turns").join("req-h2").join("stdout.log")).unwrap();
        let argv = out.lines().nth(3).expect("fake が argv を印字していない");
        assert!(
            argv.starts_with("--continue -p "),
            "resume 引数が argv 先頭に載っていない: {argv}"
        );
        assert_eq!(fs::read_to_string(hub_dir.join("turn")).unwrap(), "2");
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-4: `/new`(rotate)は turn を 1 に戻して fresh で起こす。turn file は 1 に上書きされる。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_rotate_starts_fresh_turn_1() {
        let dir = tmp("hub3");
        let (found, _marker) = fake_claude(&dir);
        let home = dir.join("home");
        let hub_dir = home.join("sessions/hub/acc-hub/claude");
        fs::create_dir_all(&hub_dir).unwrap();
        fs::write(hub_dir.join("turn"), "5").unwrap();
        let (mut child, _egress, hub) = hub_spawn(&home, &found, "req-h3", true).expect("spawn");
        let hub = hub.expect("hub spawn");
        assert!(!hub.resumed, "rotate なのに resume した");
        assert_eq!(hub.turn, 1);
        assert!(child.wait().await.unwrap().success());
        assert_eq!(
            fs::read_to_string(hub_dir.join("turn")).unwrap(),
            "1",
            "rotate 後の turn file が 1 に戻っていない"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-5: registry に `existing` 引数が無い runtime は常に fresh。turn file が在っても resume しない
    // (web では「memory: not available on this runtime」= server の detail memory:"none")。
    // main の PBI-0548 で catalog engine(gemini 等)は owner lane で起こさない(lane_not_contained)ので、
    // 「resume 引数を持たない entry」は official の claude から `launch` を外した registry で作る
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_no_existing_args_falls_back_fresh() {
        let dir = tmp("hub4");
        let (found, marker) = fake_claude(&dir);
        let reg = registry::parse(
            r#"{"version":1,"detectors":[{"id":"claude","detect":{"always":true},"adapter":"official/claude"}]}"#,
            "t",
        )
        .unwrap();
        assert!(reg.session_args("claude", "existing").is_empty(), "前提: この registry の claude は resume 引数を持たない");
        let home = dir.join("home");
        let hub_dir = home.join("sessions/hub/acc-hub/claude");
        fs::create_dir_all(&hub_dir).unwrap();
        fs::write(hub_dir.join("turn"), "3").unwrap();
        let (mut child, _egress, hub) = launch_session_scoped_in(
            &home,
            &reg,
            &found,
            "claude",
            "INSTR",
            "req-h4",
            None,
            &test_env(),
            &Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() },
            Some(&HubContext {
                account_id: "acc-hub",
                rotate: false,
            }),
        )
        .expect("spawn");
        let hub = hub.expect("hub spawn");
        assert!(!hub.resumed, "existing 引数が無い runtime が resume した");
        assert_eq!(hub.turn, 1);
        assert!(child.wait().await.unwrap().success());
        assert!(marker.exists());
        assert_eq!(
            fs::read_to_string(hub_dir.join("turn")).unwrap(),
            "1",
            "fresh fallback なのに turn file が 1 でない"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-X2: hub dir が作れない(home が読み取り専用等)時は log 1 行で通常の fresh 経路に落ちる。
    // 半端な hub dir も session_dir も残らない。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_dir_failure_falls_back_to_fresh_session_dir() {
        let dir = tmp("hub5");
        let (found, marker) = fake_claude(&dir);
        let home = dir.join("home");
        fs::create_dir_all(home.join("sessions").join("hub")).unwrap();
        // 既存 **file** を hub dir の位置に置く → mkdir が必ず失敗する
        fs::write(home.join("sessions").join("hub").join("acc-hub"), "x").unwrap();
        let (mut child, _egress, hub) = launch_session_scoped_in(
            &home,
            &registry::builtin(),
            &found,
            "claude",
            "INSTR",
            "req-h5",
            None,
            &test_env(),
            &Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() },
            Some(&HubContext {
                account_id: "acc-hub",
                rotate: false,
            }),
        )
        .expect("fallback spawn should succeed");
        assert!(hub.is_none(), "hub dir 作成失敗なのに HubSpawn が返った");
        assert!(child.wait().await.unwrap().success());
        assert!(marker.exists());
        // 通常の session_dir に落ちている(turn dir ではない)
        assert!(home
            .join("sessions")
            .join("req-h5")
            .join("instruction.txt")
            .exists());
        assert!(!home.join("sessions").join("hub").join("acc-hub").join("claude").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // AC-X3: hub の 2 本目は broker の admission(同じ (account, lane))で断られる(hub が
    // 直列化を壊さない)。こちらは入口の門: unsafe な account_id は hub 経路に入らない。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn hub_account_id_gate_rejects_unsafe_path_element() {
        let dir = tmp("hub6");
        let (found, marker) = fake_claude(&dir);
        let home = dir.join("home");
        let r = launch_session_scoped_in(
            &home,
            &registry::builtin(),
            &found,
            "claude",
            "INSTR",
            "req-h6",
            None,
            &test_env(),
            // dedicated 経路は sandbox を要求する(hub_spawn と同じ。NO_SANDBOX だと
            // sandbox_unavailable が先に出て門を測れない)
            &Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() },
            Some(&HubContext {
                account_id: "../evil",
                rotate: false,
            }),
        );
        // launch 側の門では fresh への fallback(log 1 行)、main.rs 側の門では hub 無し。
        // ここでは「unsafe な account_id で hub dir が作られない」ことだけを測る
        let (mut child, _egress, hub) = r.expect("fallback spawn should succeed");
        assert!(hub.is_none(), "unsafe な account_id が HubSpawn を生んだ");
        assert!(child.wait().await.unwrap().success());
        assert!(!home.join("sessions").join("hub").join("..").join("evil").exists());
        assert!(marker.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- 外部 API provider runtime(PBI-0070 / EP-0009 C)----

    fn reg_with_api() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"openai-api","kind":"api","detect":{"always":true},"adapter":"official/api"},
                {"id":"noadapter-api","kind":"api","detect":{"always":true},"adapter":null}
            ]}"#,
            "t",
        )
        .unwrap()
        .merged_with_builtin()
    }

    /// argv を marker file に書くだけの fake CLI(実 openroly には到達させない。EP-0001 LEARN 13)
    fn fake_cli(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("openroly-launch-api-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("argv.log");
        let bin = dir.join("fake-openroly");
        fs::write(&bin, format!("#!/bin/sh\necho \"$@\" >> {}\nexit 0\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        (bin, marker)
    }

    #[tokio::test]
    async fn api_runtime_spawns_openroly_agent_with_thread() {
        let (bin, marker) = fake_cli("ok");
        let argv = vec![bin.to_string_lossy().to_string()];
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_1", &argv, None).expect("spawn");
        let _ = child.wait().await;
        let logged = fs::read_to_string(&marker).unwrap();
        assert_eq!(logged.trim(), "agent openai --thread th_1");
    }

    #[tokio::test]
    async fn api_runtime_keeps_leading_argv_from_openroly_cli() {
        // OPENROLY_CLI="bun:<path>" 相当。argv0 の後ろの先行引数を落とさない
        let (bin, marker) = fake_cli("leading");
        let argv = vec![bin.to_string_lossy().to_string(), "/repo/openroly.ts".to_string()];
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_2", &argv, None).expect("spawn");
        let _ = child.wait().await;
        assert_eq!(
            fs::read_to_string(&marker).unwrap().trim(),
            "/repo/openroly.ts agent openai --thread th_2"
        );
    }

    // ---- 持ち込みの endpoint(PBI-0276)----

    #[test]
    fn custom_api_runtime_shape_is_the_only_gate() {
        for ok in [
            "custom-omnirouter-api",
            "custom-work-gw-api",
            "custom-a1-api",
            "custom-01234567890123456789012345678901-api", // slug 32 文字
        ] {
            assert!(is_custom_api_runtime(ok), "{ok} は通るべき");
        }
        for bad in [
            "custom-api",                                    // slug が無い
            "custom--api",                                   // slug が空
            "custom-a-api",                                  // slug 1 文字
            "custom-A-api",                                  // 大文字
            "custom-a_b-api",                                // `_`
            "custom-a b-api",                                // 空白
            "custom-a;rm -rf-api",                           // shell の記号
            "custom--x-api",                                 // slug が `-` 始まり
            "custom-x--api",                                 // slug が `-` 終わり
            "custom-012345678901234567890123456789012-api",  // slug 33 文字
            "custom-omnirouter",                             // `-api` が無い
            "openai-api",                                    // 名前付きは registry 側で判定する
            "../../etc/passwd-api",
        ] {
            assert!(!is_custom_api_runtime(bad), "{bad} は通してはいけない");
        }
    }

    #[tokio::test]
    async fn custom_api_runtime_spawns_the_same_cli_without_registry() {
        // registry に載らない(名前が account ごと)ので allowlist は作れない。起こす物は
        // 他の API provider と完全に同じ `OPENROLY_CLI agent <provider> --thread <id>`
        let (bin, marker) = fake_cli("custom");
        let argv = vec![bin.to_string_lossy().to_string()];
        let mut child =
            launch_api(&reg_with_api(), "custom-omnirouter-api", "th_c", &argv, None).expect("spawn");
        let _ = child.wait().await;
        assert_eq!(
            fs::read_to_string(&marker).unwrap().trim(),
            "agent custom-omnirouter --thread th_c"
        );
    }

    #[tokio::test]
    async fn custom_api_runtime_off_shape_is_rejected_before_spawn() {
        let (bin, marker) = fake_cli("custom-bad");
        let argv = vec![bin.to_string_lossy().to_string()];
        for bad in ["custom-A-api", "custom-a;id-api", "custom--api"] {
            let result = launch_api(&reg_with_api(), bad, "th_c", &argv, None);
            assert_eq!(result.err(), Some("unknown_runtime".to_string()), "{bad}");
        }
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn custom_api_runtime_still_needs_a_thread() {
        let (bin, marker) = fake_cli("custom-nothread");
        let argv = vec![bin.to_string_lossy().to_string()];
        assert_eq!(
            launch_api(&reg_with_api(), "custom-omnirouter-api", "", &argv, None).err(),
            Some("thread_required".to_string())
        );
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_unknown_name_is_rejected_before_spawn() {
        let (bin, marker) = fake_cli("unknown");
        let argv = vec![bin.to_string_lossy().to_string()];
        let result = launch_api(&reg_with_api(), "evil-api", "th_1", &argv, None);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_without_thread_or_cli_never_spawns() {
        let (bin, marker) = fake_cli("guard");
        let argv = vec![bin.to_string_lossy().to_string()];
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "", &argv, None).err(),
            Some("thread_required".to_string())
        );
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "th_1", &[], None).err(),
            Some("openroly_cli_not_found".to_string())
        );
        // adapter: null(検出のみ)の api runtime も起こさない
        assert_eq!(
            launch_api(&reg_with_api(), "noadapter-api", "th_1", &argv, None).err(),
            Some("not_launchable".to_string())
        );
        assert!(!marker.exists(), "どの経路でも spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_two_wakes_spawn_independently() {
        let (bin, marker) = fake_cli("parallel");
        let argv = vec![bin.to_string_lossy().to_string()];
        let reg = reg_with_api();
        let mut a = launch_api(&reg, "openai-api", "th_a", &argv, None).expect("spawn a");
        let mut b = launch_api(&reg, "openai-api", "th_b", &argv, None).expect("spawn b");
        let (ra, rb) = tokio::join!(a.wait(), b.wait());
        assert!(ra.is_ok() && rb.is_ok());
        let logged = fs::read_to_string(&marker).unwrap();
        assert!(logged.contains("--thread th_a"), "logged={logged}");
        assert!(logged.contains("--thread th_b"), "logged={logged}");
    }
}
