use std::fs;
use std::path::{Path, PathBuf};

use tokio::process::{Child, Command};

use crate::discovery::Found;
use crate::egress::{self, Egress, EgressConfig};
use crate::openroly_cli::cli_argv;
use crate::registry::{self, Registry};
use crate::sandbox::{SandboxBackend, SandboxSpec, default_deny_read, default_writable_extra};

/// dedicated session の instruction の上限(argv 1 要素)。これを超えると OS の argv 上限で
/// spawn が `spawn failed` に埋もれるため、名前の付いた reason で手前で止める(PBI-0019 AC-11)。
/// Cloud 側は 21 件上限で ≤ 4KB を担保するので、16KB は多層防御の最終境界。
const MAX_INSTRUCTION_BYTES: usize = 16 * 1024;

/// dedicated session 起動時の 1 CLI あたりの最大 turn 数(コスト上限。実測 C: 3 turn で $0.31〜0.39)。
const MAX_TURNS: &str = "40";

/// dedicated session に載せる MCP server 名(runtime 側の登録名。install.ts の `MCP_SERVER_NAME`)。
const MCP_SERVER_NAME: &str = "openroly";

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

/// gemini の閉じ込め policy(PBI-0167)。**admin tier** に「openroly MCP 以外は全部 deny」を置く。
/// `toolName = "*"` + `mcpName = "openroly"` は「その server の任意の tool」に一致する(bundle の
/// `ruleMatches` 実測: mcpName で server を絞ってから toolName の `*` を素通しする)。
/// 最終 priority = tier base(admin = 5)+ priority/1000 なので、deny(5.000)< allow(5.900)。
/// workspace tier(`<cwd>/.gemini/policies`)は 0.46.0 時点で**機能しない**(docs の警告)ため、
/// session_dir に置いた file を `--admin-policy` で明示的に読ませる。
const GEMINI_POLICY_TOML: &str = r#"# Containment policy the openroly broker writes for each dedicated session.
# A notification body is attacker-controlled input, so no built-in tool
# (run_shell_command / write_file / …) is allowed — only the openroly MCP server's tools.
[[rule]]
toolName = "*"
decision = "deny"
priority = 0

[[rule]]
toolName = "*"
mcpName = "openroly"
decision = "allow"
priority = 900
"#;

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
    /// gemini の**標準** admin policy dir。ここに `.toml` が 1 つでも在ると、
    /// `--admin-policy` で渡す supplemental policy は **丸ごと無視される**(gemini の
    /// security guard: 中央 policy が既に在る所で flag 越しの上書きをさせない)。
    /// = 閉じ込めが効かないので、その時は起こさない(fail-closed)。
    pub gemini_admin_dirs: Vec<PathBuf>,
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
        gemini_admin_dirs: vec![
            // macOS / Linux / Windows の標準 admin policy dir(gemini docs)。
            // 3 つとも見るのは、broker が動く OS を argv 組み立ての条件にしないため
            // (存在しない path は「.toml 無し」と同じ扱いになるだけ)。
            PathBuf::from("/Library/Application Support/GeminiCli/policies"),
            PathBuf::from("/etc/gemini-cli/policies"),
            PathBuf::from(r"C:\ProgramData\gemini-cli\policies"),
        ],
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

/// dir に `.toml` が 1 つでも在るか(gemini の標準 admin policy の有無)。
fn has_toml(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("toml"))
            .unwrap_or(false)
    })
}

/// AUTO / triage / draft / owner の dedicated session(PBI-0019 / PBI-0117)の起動引数と、
/// session_dir に置く**閉じ込め用の file** を runtime ごとに固定で組む(PBI-0167)。
///
/// argv は実測(PBI-0019 の実測 C / PBI-0061 の実測 D / PBI-0167 の実測 E)の通り。`instruction` は
/// argv の 1 要素として渡す前提 —— shell を経由させない(Cloud から届いた文字列を shell に解釈させると
/// 任意コマンド実行の口になる)。`session_dir` は codex の `-o`(結果ファイル)と、閉じ込め file の置き場に使う。
///
/// **閉じ込め(PBI-0167)**: dedicated session の入力(通知本文)は攻撃者が書ける。3 runtime とも
/// 「組込み tool は通さず openroly MCP だけ通す」に揃える —— 揃っていないと「gemini を既定にしている人
/// だけ mail 1 通で shell を握られる」という、user から見えない差になる。
///
/// 返り値は (argv, session_dir に置く file の (相対 path, 中身))。実測 argv を持たない runtime は
/// `dedicated_unsupported` —— registry で足しただけの新 runtime(PBI-0022)を instruction 無しで
/// bare spawn してしまうと「AUTO で起こしたのに何も指示していない」session になる。
/// 閉じ込めが組めない環境は `containment_unavailable`(fail-closed。起こさない)。
///
/// **PBI-0238 以降、ここで組む flag は上乗せ**(図72)。主の壁は broker が spawn の前に掛ける
/// OS sandbox + egress proxy(`launch_session_scoped_in` → `sandbox.wrap`)で、runtime が何であれ同じ。
/// `folder` は lane の作業 folder(cwd。codex は `-C` にも載せる)。
///
/// **generic 経路(PBI-0240 / 図84)**: official 3 種に当たらない runtime は registry の entry から
/// 起こす。`launch.headless` + `sandbox_verified` が有れば argv を要素内置換して返す。
/// `sandbox_verified` が無ければ `not_verified`、`launch.headless` 自体が無ければ `not_headless`
/// (旧 `dedicated_unsupported` の改名 —— 理由が伝わる語に)。どちらも spawn しない(fail-closed)。
pub fn dedicated_launch(
    registry: &Registry,
    runtime: &str,
    instruction: &str,
    session_dir: &str,
    folder: &str,
    env: &ContainmentEnv,
) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    // argv の要素は NUL を運べない(spawn が落とす)。official / generic のどの経路でも
    // 先に止める(AC-X2 = 起動して拒否されるより先)
    if instruction.bytes().any(|b| b == 0) {
        return Err("invalid_instruction".to_string());
    }
    let argv = |args: &[&str]| args.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    match runtime {
        // 実測 C(PBI-0019)+ 実測 E(PBI-0167, 2026-09-02, Claude Code 2.1.258):
        //   claude -p <instruction> --tools "" --setting-sources project --strict-mcp-config
        //          --mcp-config <dir>/openroly-mcp.json --permission-mode dontAsk --allowedTools mcp__openroly
        //          --output-format json --max-turns 40
        //
        // `--allowedTools mcp__openroly` **だけでは Bash が通る**(実測 E: `--permission-mode dontAsk` は
        // 「聞かずに実行する」であって allow list ではない。user の `~/.claude/settings.json` に
        // `allow: ["Bash"]` が有ろうと無かろうと Bash は動いた)。組込み tool を落とすのは
        // `--tools ""`(= 組込みを 1 つも積まない。MCP tool は別枠なので openroly は残る — 実測 E)。
        //
        // `--tools` / `--mcp-config` / `--allowedTools` は可変長引数なので、**直後には必ず別の flag を置く**
        // (positional が続くと flag が食う —— 実測 E で `--mcp-config <path> mcp list` が
        // "MCP config file not found: .../mcp" に化けた)。
        "claude" => {
            let mcp_config = claude_mcp_config(&env.claude_config, &env.claude_plugin_registry)?;
            let rel = "openroly-mcp.json";
            Ok((
                argv(&[
                    "-p",
                    instruction,
                    "--tools",
                    "",
                    "--setting-sources",
                    "project",
                    "--strict-mcp-config",
                    "--mcp-config",
                    &format!("{session_dir}/{rel}"),
                    "--permission-mode",
                    "dontAsk",
                    "--allowedTools",
                    "mcp__openroly",
                    "--output-format",
                    "json",
                    "--max-turns",
                    MAX_TURNS,
                ]),
                vec![(rel.to_string(), mcp_config)],
            ))
        }
        // codex exec --skip-git-repo-check --sandbox read-only -C <dir> -o <dir>/result.txt <instruction>
        //
        // `--sandbox read-only` は**明示する**(PBI-0167 AC-3)—— 既定も read-only だが、既定は
        // `~/.codex/config.toml` の `sandbox_mode` で user が上書きできる。攻撃者が書いた本文を
        // 読ませる session の権限を、user の設定 file 任せにしない。
        "codex" => {
            let mut args = argv(&["exec", "--skip-git-repo-check", "--sandbox", "read-only"]);
            // openroly 以外の MCP server を 1 つずつ落とす(review 指摘: `--sandbox read-only` は
            // MCP server に掛からない —— server は sandbox の外の別プロセスなので、
            // 攻撃者の本文から playwright / obsidian 越しに network も書込みも届く)。
            for name in codex_disabled_mcp_servers(&env.codex_config)? {
                args.push("-c".to_string());
                args.push(format!("mcp_servers.{name}.enabled=false"));
            }
            args.extend(argv(&[
                "-C",
                folder,
                "-o",
                &format!("{session_dir}/result.txt"),
                instruction,
            ]));
            Ok((args, vec![]))
        }
        // 実測 D(2026-08-28, gemini-cli 0.46.0。PBI-0061 / W9c)+ 実測 E(PBI-0167):
        //   gemini -p <instruction> --approval-mode yolo --skip-trust
        //          --allowed-mcp-server-names openroly --admin-policy <dir>/policies -o json
        //
        // `--skip-trust` は**必須** —— session_dir は必ず「信頼していないフォルダ」なので、
        // 無いと `Approval mode overridden to "default" because the current folder is not
        // trusted.` に落ちて tool 呼び出しが承認待ちで固まる(実測)。
        // `--allowed-mcp-server-names` は **MCP の絞りでしかない**(組込み tool は素通し)。
        // `--approval-mode yolo` は全 tool を自動承認するので、実測 E では
        // 「`run_shell_command` で date を実行しろ」の 1 文で **実際に shell が動いた**
        // (policy 無し: totalCalls 1 / policy 有り: totalCalls 0)。塞ぐのは policy engine。
        // claude の `--max-turns` に相当する flag は gemini に**無い**(help 実測) ——
        // 暴走の抑えは tool 制限と session timeout に委ねる。
        "gemini" => {
            if let Some(dir) = env.gemini_admin_dirs.iter().find(|d| has_toml(d)) {
                eprintln!(
                    "broker: a .toml exists in gemini's standard admin policy dir ({dir:?}), so \
                     --admin-policy would be ignored. Cannot contain the session, so not starting"
                );
                return Err("containment_unavailable".to_string());
            }
            let rel = "policies/openroly-containment.toml";
            Ok((
                argv(&[
                    "-p",
                    instruction,
                    "--approval-mode",
                    "yolo",
                    "--skip-trust",
                    "--allowed-mcp-server-names",
                    "openroly",
                    "--admin-policy",
                    &format!("{session_dir}/policies"),
                    "-o",
                    "json",
                ]),
                vec![(rel.to_string(), GEMINI_POLICY_TOML.to_string())],
            ))
        }
        // generic 経路(PBI-0240 / 図84): registry の entry が起こし方を持つ runtime。
        // argv は program を含まない(`resolve_program` が `detect.binaries` を解決する)。
        _ => {
            let Some(d) = registry.detector(runtime) else {
                return Err("not_headless".to_string());
            };
            let Some(h) = d.launch.headless.as_ref() else {
                return Err("not_headless".to_string());
            };
            if d.sandbox_verified.is_none() {
                return Err("not_verified".to_string());
            }
            Ok((substitute_elementwise(&h.argv, instruction, folder, session_dir), vec![]))
        }
    }
}

/// generic 経路の argv 組み立て(PBI-0240)。各要素の中の `${instruction}` / `${folder}` /
/// `${session_dir}` を置換する —— **shell は経由しない**(1 要素 = 1 引数のまま。`format!` で
/// 1 文字列に繋ぐと Cloud から届いた instruction を shell に解釈させる口になる)。
fn substitute_elementwise(argv: &[String], instruction: &str, folder: &str, session_dir: &str) -> Vec<String> {
    argv.iter()
        .map(|a| {
            a.replace("${instruction}", instruction)
                .replace("${folder}", folder)
                .replace("${session_dir}", session_dir)
        })
        .collect()
}

/// `not_headless` の wake に添える代替(PBI-0240 AC-2)。hello で見つかった runtime のうち、
/// catalog 上 headless 可(official 3 種 ∪ `launch.headless` を持つ entry)で、起こそうとした
/// runtime と別の id の最初の 1 つ。owner は仕事を folder 単位で渡すので runtime は替えられる。
pub fn headless_alternative(registry: &Registry, found: &[Found], runtime: &str) -> Option<String> {
    found
        .iter()
        .find(|f| f.id != runtime && is_headless_capable(registry, &f.id))
        .map(|f| f.id.clone())
}

/// dedicated wake で instruction 付きで起こせる runtime か(official 3 種は hard-code の実測 argv)。
fn is_headless_capable(registry: &Registry, id: &str) -> bool {
    matches!(id, "claude" | "codex" | "gemini")
        || registry
            .detector(id)
            .and_then(|d| d.launch.headless.as_ref())
            .is_some()
}

/// requestId は session_dir のパス要素になる(信頼境界を跨ぐ Cloud からの文字列)。
/// path traversal(`../`)や区切り文字を弾き、安全な id だけを通す。
fn is_safe_request_id(request_id: &str) -> bool {
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
    found
        .iter()
        .find(|f| f.id == runtime && f.source != "app")
        .map(|f| f.path.clone())
        .unwrap_or_else(|| runtime.to_string())
}

/// registry に照らした起動可否。判定順序(図18): registry に無い → `unknown_runtime`、
/// 有るが `adapter: null`(Ollama 等 — 検出・表示のみ)→ `not_launchable`。
fn check_launchable(registry: &Registry, runtime: &str) -> Result<(), String> {
    match registry.detector(runtime) {
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
/// `x-openroly-session-scope` header で Cloud へ返す。REQ-61 enforcement ②)。無い時は env を
/// 触らない = Manual / AUTO / owner lane の dedicated session は従来どおり全権。
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
    launch_in(runtime, program, args, allowlist, session_dir, scope, session_id, None)
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
    contained: Option<(&dyn SandboxBackend, &SandboxSpec)>,
) -> Result<Child, String> {
    if !allowlist.contains(&runtime.to_string()) {
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
    if let Some((sandbox, spec)) = contained {
        // 閉じ込め(図72): cwd = lane の folder(sandbox が唯一 write を許す所)。network は
        // profile が proxy の 1 port しか許さないので、runtime の HTTP client を全部そこへ向ける。
        // `NO_PROXY=""` は「proxy を迂回する host は無い」の明示(user の env に NO_PROXY が有っても
        // 継がない)。`NODE_USE_ENV_PROXY=1` は gemini(Node)の API key fetch が HTTPS_PROXY だけでは
        // proxy を通らない実測(2026-09-04)への対処。
        cmd.current_dir(&spec.folder);
        let proxy = format!("http://127.0.0.1:{}", spec.proxy_port);
        for key in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] {
            cmd.env(key, &proxy);
        }
        cmd.env("NO_PROXY", "");
        cmd.env("no_proxy", "");
        cmd.env("NODE_USE_ENV_PROXY", "1");
        cmd = sandbox.wrap(cmd, spec)?;
    } else if let Some(dir) = session_dir {
        // 閉じ込め無しで session_dir を渡す経路(test の cwd / env probe)。cwd は session_dir。
        cmd.current_dir(dir);
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

/// Cloud から受けた wake 要求(Manual routing / instruction 無し)に応じて runtime CLI を
/// bare spawn する(要件 §21.1 runtime launch)。`session_mode` は Manual routing(§20.1)の
/// New/Existing 選択。AUTO 経路は必ず `launch_session`(instruction 付き)を通る。
/// allowlist・起動引数は registry(署名検証済み ∪ built-in)から、program は scan 結果から引く(PBI-0022)。
pub fn launch(
    registry: &Registry,
    found: &[Found],
    runtime: &str,
    session_mode: &str,
) -> Result<Child, String> {
    check_launchable(registry, runtime)?;
    let args = registry.session_args(runtime, session_mode);
    let program = resolve_program(found, runtime);
    launch_with_allowlist(runtime, &program, &args, &registry.allowlist(), None)
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
    launch_in(runtime, program, &args, &allowlist, None, None, None, None)
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
pub fn launch_api_env(registry: &Registry, runtime: &str, thread_id: &str) -> Result<Child, String> {
    launch_api(registry, runtime, thread_id, &cli_argv())
}

/// dedicated session(PBI-0019 の AUTO と PBI-0117 の triage)を起動する。判定順序(図15):
/// invalid_request_id → instruction_too_long → session_dir_failed → unknown_runtime / not_launchable
/// (registry)→ dedicated_unsupported → spawn。
///
/// session_dir(`$OPENROLY_BROKER_HOME/sessions/<requestId>/`)を作り、instruction.txt を残してから
/// spawn する。stdout/stderr は session_dir のファイルへ向ける。返すのは起動した `Child` で、
/// 終了の wait と session_result 送信は呼び出し側(main.rs)の reaper が引き受ける。
///
/// `scope` は triage session の token(PBI-0117)。`Some` の時だけ子 env `OPENROLY_SESSION_SCOPE` が
/// 載る(launch_with_scope)。AUTO / owner lane からは `None` で呼ぶ = env に載らない = 全権。
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
) -> Result<(Child, Egress), String> {
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
    /// user の HOME。`deny_read` / `writable_extra` の既定を組む(env は呼び出し口で 1 回だけ読む)。
    pub user_home: PathBuf,
}

/// lane の作業 folder を決める(AC-4)。`folder` 無し = `session_dir/scratch`(空で作る)。
/// 有りは **rule に照らす前の最低限の門**(PBI-0239 が server 側の rule を持ち込むまでの土台):
/// 絶対 path・実在する dir・`/` や HOME そのものでない・`deny_read` / `~/Library` / `~/.openroly` /
/// broker home の下でない。triage(scope 有り)は folder を持たない —— 通知本文を読む lane に
/// owner の folder を渡す理由が無いので、来たら `folder_not_allowed`。
fn resolve_folder(
    folder: Option<&str>,
    scope: Option<&str>,
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
    if scope.is_some() {
        return Err(refuse("triage sessions never get a folder"));
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
    if fenced.iter().any(|f| real.starts_with(f)) {
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
) -> Result<(Child, Egress), String> {
    if !is_safe_request_id(request_id) {
        return Err("invalid_request_id".to_string());
    }
    if instruction.len() > MAX_INSTRUCTION_BYTES {
        return Err("instruction_too_long".to_string());
    }
    let session_dir = home.join("sessions").join(request_id);
    fs::create_dir_all(&session_dir).map_err(|e| {
        eprintln!("broker: session_dir mkdir failed ({session_dir:?}): {e}");
        "session_dir_failed".to_string()
    })?;
    let dir_str = session_dir.to_string_lossy().to_string();
    fs::write(session_dir.join("instruction.txt"), instruction).map_err(|e| {
        eprintln!("broker: could not write instruction.txt: {e}");
        "session_dir_failed".to_string()
    })?;
    check_launchable(registry, runtime)?;
    // PBI-0244: dedicated 経路は launch_in を直に呼ぶので、ここで deny を見る(spawn 直前の 2 本目)
    let program = resolve_program(found, runtime);
    check_program(&program).inspect_err(|_| discard_session_dir(&session_dir))?;
    // lane の folder(AC-4)。rule に無い path は起こさない(半端な session_dir も残さない)。
    let folder = resolve_folder(isolation.folder, scope, &session_dir, home, &isolation.user_home)
        .inspect_err(|_| discard_session_dir(&session_dir))?;
    let folder_str = folder.to_string_lossy().to_string();
    let (args, files) = dedicated_launch(registry, runtime, instruction, &dir_str, &folder_str, env)
        .inspect_err(|_| discard_session_dir(&session_dir))?;
    // 閉じ込め用の file(claude の `--mcp-config` / gemini の admin policy)を session_dir に置く。
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
    // 閉じ込めの土台(PBI-0238 / 図72): session の egress proxy を先に立て(port が profile に要る)、
    // その port だけを許す sandbox で包んでから spawn する。proxy が立たない / 包めない(Windows・
    // Landlock ABI 4 未満の Linux・seatbelt が壊れた機)は **何も spawn せず** `sandbox_unavailable`(AC-X2)。
    let egress = egress::start(isolation.egress.clone(), request_id)
        .inspect_err(|_| discard_session_dir(&session_dir))?;
    let spec = SandboxSpec {
        folder,
        session_dir: session_dir.clone(),
        writable_extra: default_writable_extra(&isolation.user_home),
        deny_read: default_deny_read(&isolation.user_home),
        proxy_port: egress.port,
    };
    let child = launch_in(
        runtime,
        &program,
        &args,
        &registry.allowlist(),
        Some(&dir_str),
        scope,
        Some(request_id),
        Some((isolation.sandbox, &spec)),
    )
    .inspect_err(|e| {
        if e == "sandbox_unavailable" {
            discard_session_dir(&session_dir);
        }
    })?;
    Ok((child, egress))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;

    /// dedicated_launch の test 用 wrapper(official 3 種は registry を読まないので builtin で足りる。
    /// generic 経路の test は registry を直に組む)
    fn dedicated(
        runtime: &str,
        instruction: &str,
        session_dir: &str,
        folder: &str,
        env: &ContainmentEnv,
    ) -> Result<(Vec<String>, Vec<(String, String)>), String> {
        dedicated_launch(&registry::builtin(), runtime, instruction, session_dir, folder, env)
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

    // PBI-0117: triage session は scope token を子 env `OPENROLY_SESSION_SCOPE` で受け取る(MCP が
    // 全 request の `x-openroly-session-scope` header で Cloud へ返す)。scope 無しの起動は env を
    // 載せない(Manual / AUTO / owner lane が従来どおり全権であることの片側確認)。
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
        // **PBI-0238 の追随**(merge 時): 引数に `Isolation` が増え、返りが `(Child, Egress)` に
        // なった。ここは peek の env(PBI-0224)を測る test なので閉じ込めは要らず、
        // `test_isolation()`(NoSandbox / allowlist 空)で足りる
        let iso = Isolation { sandbox: &crate::sandbox::Seatbelt, ..test_isolation() };
        let (mut child, _egress) = launch_session_scoped_in(
            &home,
            &registry::builtin(),
            &found,
            "claude",
            "instr",
            "req_peek_1",
            None,
            &test_env(),
            &iso,
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
        let mut child = launch(&reg, &found, "superagent", "new").expect("spawn by found path");
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
        assert_eq!(launch(&reg, &[], "ollama", "new").err(), Some("not_launchable".to_string()));
        assert_eq!(launch(&reg, &[], "hermes", "new").err(), Some("unknown_runtime".to_string()));
        assert_eq!(launch(&reg, &[], "rm", "existing").err(), Some("unknown_runtime".to_string()));
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
        let mut child = launch(&reg, &found, "superagent", "new").expect("spawn by found path");
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
    // 3 runtime とも閉じ込め(組込み tool を通さない)が argv / file として載ること。

    /// openroly MCP が登録済みの claude user config と、admin policy の無い gemini を模した env。
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
            gemini_admin_dirs: vec![dir.join("no-such-admin-policies")],
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
            gemini_admin_dirs: vec![],
        };
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &missing).err(),
            Some("containment_unavailable".to_string())
        );
        let broken = dir.join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &ContainmentEnv { claude_config: broken, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml"), gemini_admin_dirs: vec![] }).err(),
            Some("containment_unavailable".to_string())
        );
        let no_openroly = dir.join("no-openroly.json");
        fs::write(&no_openroly, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        assert_eq!(
            dedicated("claude", "I", "/tmp/s", "/tmp/work", &ContainmentEnv { claude_config: no_openroly, claude_plugin_registry: no_plugin.clone(), codex_config: dir.join("no-such-codex.toml"), gemini_admin_dirs: vec![] }).err(),
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
            gemini_admin_dirs: vec![],
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
                gemini_admin_dirs: vec![],
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
            gemini_admin_dirs: vec![],
        };
        let (args, _) = dedicated("codex", "I", "/tmp/s", "/tmp/work", &none).unwrap();
        assert!(!args.iter().any(|a| a == "-c"));
        let _ = fs::remove_dir_all(&dir);
    }

    // PBI-0061 / W9c: 2026-08-28 に gemini-cli 0.46.0 を実際に叩いて確かめた argv。
    // `--skip-trust` が落ちると untrusted folder 判定で承認モードが default に戻り、
    // AUTO の session が tool 呼び出しの承認待ちで固まる(実測した失敗)。
    // PBI-0167 AC-1: `--approval-mode yolo` は組込み tool も自動承認するので、
    // admin tier の deny policy が唯一の壁になる(実測 E: policy 無しで shell が動いた)。
    #[test]
    fn dedicated_launch_gemini_matches_measured_argv() {
        let (args, files) = dedicated("gemini", "INSTR", "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "INSTR",
                "--approval-mode",
                "yolo",
                "--skip-trust",
                "--allowed-mcp-server-names",
                "openroly",
                "--admin-policy",
                "/tmp/sess/policies",
                "-o",
                "json",
            ]
        );
        // 承認待ちで固まらないための必須 flag(単独でも守る)
        assert!(args.iter().any(|a| a == "--skip-trust"));
        // policy は session_dir に置く(workspace tier は 0.46.0 では機能しない)
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "policies/openroly-containment.toml");
        assert!(files[0].1.contains("decision = \"deny\""), "{}", files[0].1);
        assert!(files[0].1.contains("mcpName = \"openroly\""), "{}", files[0].1);
    }

    // AC-4(gemini 側): 標準 admin policy dir に .toml が在ると --admin-policy は無視される
    // (gemini の security guard)= 閉じ込められないので起こさない。
    #[test]
    fn dedicated_launch_gemini_with_system_policy_is_containment_unavailable() {
        let dir = std::env::temp_dir().join(format!("openroly-broker-admin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("corp.toml"), "").unwrap();
        let env = ContainmentEnv {
            claude_config: dir.join(".claude.json"),
            claude_plugin_registry: dir.join("no-such-plugins.json"),
            codex_config: dir.join("no-such-codex.toml"),
            gemini_admin_dirs: vec![dir.clone()],
        };
        assert_eq!(
            dedicated("gemini", "I", "/tmp/s", "/tmp/work", &env).err(),
            Some("containment_unavailable".to_string())
        );
        // .toml 以外しか無い dir は素通し(閉じ込めは効く)
        fs::remove_file(dir.join("corp.toml")).unwrap();
        fs::write(dir.join("README.md"), "").unwrap();
        assert!(dedicated("gemini", "I", "/tmp/s", "/tmp/work", &env).is_ok());
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
        let (args, files) = dedicated_launch(&reg, "foo", instruction, "/tmp/sess", "/tmp/work", &test_env()).unwrap();
        assert_eq!(files, vec![]);
        assert_eq!(args[0], "--run");
        assert_eq!(args[1], instruction, "instruction 全文が 1 要素で無い: {args:?}");
        assert_eq!(args[3], "/tmp/work");
        assert_eq!(args[5], "/tmp/sess");
        assert_eq!(args.len(), 6);
    }

    // AC-4: sandbox_verified が無い entry は generic 経路に入らない(fail-closed)
    #[test]
    fn unverified_is_not_generic() {
        let reg = generic_registry(true, false);
        assert_eq!(
            dedicated_launch(&reg, "foo", "I", "/tmp/s", "/tmp/work", &test_env()).err(),
            Some("not_verified".to_string())
        );
        // verified が有れば通る(対)
        let ok = generic_registry(true, true);
        assert!(dedicated_launch(&ok, "foo", "I", "/tmp/s", "/tmp/work", &test_env()).is_ok());
    }

    // AC-X2: instruction に NUL が含まれる時は spawn の前に弾く(official 3 種でも同じ門)
    #[test]
    fn invalid_instruction_nul() {
        let reg = generic_registry(true, true);
        assert_eq!(
            dedicated_launch(&reg, "foo", "a\0b", "/tmp/s", "/tmp/work", &test_env()).err(),
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
    }

    // registry で足した runtime を AUTO で起こそうとしても bare spawn にはならない(not_headless。
    // PBI-0240 で dedicated_unsupported から改名 —— entry が起こし方を持たない事が伝わる語に)
    #[test]
    fn launch_session_refuses_runtime_without_dedicated_argv() {
        let tmp = std::env::temp_dir().join(format!("openroly-broker-ded-{}", std::process::id()));
        let result = launch_session_scoped_in(&tmp, &reg_with_ollama(), &[], "superagent", "instr", "req-ded", None, &test_env(), &test_isolation());
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
        let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", &big, "req-1", None, &test_isolation());
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
            launch_session_scoped_in(&tmp, &registry::builtin(), &[], "not-a-real-runtime", &at_limit, "req-limit", None, &test_env(), &test_isolation());
        // instruction_too_long ではないこと(registry で弾かれるのが正しい)
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn launch_session_rejects_unsafe_request_id() {
        // runtime は registry 外のダミー名(PBI-0040) —— invalid_request_id は他の全判定より先に
        // 確定するので実 runtime 名である必要が無い。
        for bad in ["", "../escape", "a/b", "with space", &"z".repeat(129)] {
            let result = launch_session_scoped(&registry::builtin(), &[], "not-a-real-runtime", "instr", bad, None, &test_isolation());
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
            launch_session_scoped_in(&home, &registry::builtin(), &[], "not-a-real-runtime", "INSTR", "req-ok", None, &test_env(), &test_isolation());
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
            launch_session_scoped_in(&tmp_file, &registry::builtin(), &[], "not-a-real-runtime", "instr", "req-dir", None, &test_env(), &test_isolation());
        // AC-11: reason は bare token 'session_dir_failed'(詳細は付けない)。
        assert_eq!(result.err(), Some("session_dir_failed".to_string()));
        let _ = fs::remove_file(&tmp_file);
    }

    // ---- PBI-0238: 閉じ込めの土台(図72)—— lane の folder / sandbox_unavailable / proxy env ----

    static NO_SANDBOX: crate::sandbox::NoSandbox = crate::sandbox::NoSandbox { reason: String::new() };

    fn test_isolation() -> Isolation<'static> {
        Isolation {
            sandbox: &NO_SANDBOX,
            egress: EgressConfig { allow: vec![], events: None, upstream_override: None, observe: None },
            folder: None,
            user_home: std::env::temp_dir(),
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
                "#!/bin/sh\n: > \"{}\"\npwd\necho \"$HTTPS_PROXY|$NO_PROXY|$NODE_USE_ENV_PROXY\"\n",
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
        let (mut child, egress) = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-scratch", Some("pst_scope"), &test_env(), &iso,
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
        let (child, _egress) = launch_session_scoped_in(
            &dir.join("home"),
            &registry::builtin(),
            &found,
            "claude",
            "instr",
            "req-sandbox-grandchild",
            None,
            &test_env(),
            &iso,
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
        let (mut child, _egress) = launch_session_scoped_in(
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-owner", None, &test_env(), &iso,
        )
        .expect("spawn");
        assert!(child.wait().await.unwrap().success());
        let out = fs::read_to_string(dir.join("home/sessions/req-owner/stdout.log")).unwrap();
        assert_eq!(fs::canonicalize(out.lines().next().unwrap()).unwrap(), fs::canonicalize(&proj).unwrap());
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
                &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", &rid, *scope, &test_env(), &iso,
            );
            assert_eq!(r.err(), Some("folder_not_allowed".to_string()), "case {i}: {folder:?}");
            assert!(!dir.join("home").join("sessions").join(&rid).exists(), "case {i}: 半端な session_dir が残った");
        }
        assert!(!marker.exists(), "folder_not_allowed で何かが spawn された");
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
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-nosb", None, &test_env(), &iso,
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
            &dir.join("home"), &registry::builtin(), &found, "claude", "INSTR", "req-inject", None, &test_env(), &iso,
        );
        assert_eq!(r.err(), Some("sandbox_unavailable".to_string()));
        assert!(!marker.exists());
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
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_1", &argv).expect("spawn");
        let _ = child.wait().await;
        let logged = fs::read_to_string(&marker).unwrap();
        assert_eq!(logged.trim(), "agent openai --thread th_1");
    }

    #[tokio::test]
    async fn api_runtime_keeps_leading_argv_from_openroly_cli() {
        // OPENROLY_CLI="bun:<path>" 相当。argv0 の後ろの先行引数を落とさない
        let (bin, marker) = fake_cli("leading");
        let argv = vec![bin.to_string_lossy().to_string(), "/repo/openroly.ts".to_string()];
        let mut child = launch_api(&reg_with_api(), "openai-api", "th_2", &argv).expect("spawn");
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
            launch_api(&reg_with_api(), "custom-omnirouter-api", "th_c", &argv).expect("spawn");
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
            let result = launch_api(&reg_with_api(), bad, "th_c", &argv);
            assert_eq!(result.err(), Some("unknown_runtime".to_string()), "{bad}");
        }
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn custom_api_runtime_still_needs_a_thread() {
        let (bin, marker) = fake_cli("custom-nothread");
        let argv = vec![bin.to_string_lossy().to_string()];
        assert_eq!(
            launch_api(&reg_with_api(), "custom-omnirouter-api", "", &argv).err(),
            Some("thread_required".to_string())
        );
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_unknown_name_is_rejected_before_spawn() {
        let (bin, marker) = fake_cli("unknown");
        let argv = vec![bin.to_string_lossy().to_string()];
        let result = launch_api(&reg_with_api(), "evil-api", "th_1", &argv);
        assert_eq!(result.err(), Some("unknown_runtime".to_string()));
        assert!(!marker.exists(), "spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_without_thread_or_cli_never_spawns() {
        let (bin, marker) = fake_cli("guard");
        let argv = vec![bin.to_string_lossy().to_string()];
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "", &argv).err(),
            Some("thread_required".to_string())
        );
        assert_eq!(
            launch_api(&reg_with_api(), "openai-api", "th_1", &[]).err(),
            Some("openroly_cli_not_found".to_string())
        );
        // adapter: null(検出のみ)の api runtime も起こさない
        assert_eq!(
            launch_api(&reg_with_api(), "noadapter-api", "th_1", &argv).err(),
            Some("not_launchable".to_string())
        );
        assert!(!marker.exists(), "どの経路でも spawn してはいけない");
    }

    #[tokio::test]
    async fn api_runtime_two_wakes_spawn_independently() {
        let (bin, marker) = fake_cli("parallel");
        let argv = vec![bin.to_string_lossy().to_string()];
        let reg = reg_with_api();
        let mut a = launch_api(&reg, "openai-api", "th_a", &argv).expect("spawn a");
        let mut b = launch_api(&reg, "openai-api", "th_b", &argv).expect("spawn b");
        let (ra, rb) = tokio::join!(a.wait(), b.wait());
        assert!(ra.is_ok() && rb.is_ok());
        let logged = fs::read_to_string(&marker).unwrap();
        assert!(logged.contains("--thread th_a"), "logged={logged}");
        assert!(logged.contains("--thread th_b"), "logged={logged}");
    }
}
