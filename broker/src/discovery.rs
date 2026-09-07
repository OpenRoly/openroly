//! runtime discovery(要件 §21.1 / §45.3 層 1 / 図18)。registry の detector を PATH・固定 bin dir・
//! app dir で評価し、`Found{id, version, source, path}` の一覧を返す(PBI-0022)。
//! 実 CLI を spawn するのは version probe だけ(found path + mtime ごとに 1 回、3s timeout)。

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::registry::{ModelsSpec, Registry, ServiceProbe};

/// hello.runtimes の 1 要素。`PartialEq` で heartbeat ごとの差分判定をする(version も含む —
/// probe 結果は cache されるので binary が変わらない限り安定)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct Found {
    pub id: String,
    pub version: Option<String>,
    /// "path" / "brew" / "npm" / "dir" / "app" / "service"(図18: realpath で判定。service は PBI-0025)
    pub source: String,
    pub path: String,
    /// local model server(Ollama 等)の model 名一覧。**必ず sort + dedup 済み**で入れる —
    /// API 応答の順序をそのまま使うと同じ状態でも `Found` の等値が壊れ、heartbeat ごとに
    /// 差分ありと誤判定して hello を送り続ける(EP-0004 OBSERVE の「hello が毎 tick 送られる」)。
    /// binaries / apps 由来の `Found` では常に空(PBI-0025)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
}

/// scan が見る場所。env を引数に分離してあるのは unit test で実マシンの dir に触れないため。
#[derive(Debug, Clone, Default)]
pub struct ScanEnv {
    /// PATH の各 dir(順序どおり)
    pub path_dirs: Vec<PathBuf>,
    /// 固定 bin dir(`OPENROLY_SCAN_DIRS` で丸ごと置換。空文字 = なし)
    pub extra_dirs: Vec<PathBuf>,
    /// app bundle dir(`OPENROLY_APP_DIRS` で丸ごと置換。空文字 = なし)
    pub app_dirs: Vec<PathBuf>,
    /// `detect.dirs` の `~/` を解く HOME(PBI-0210)。None なら `~/` 形の dir は探さない
    pub home: Option<PathBuf>,
}

impl ScanEnv {
    pub fn from_env() -> ScanEnv {
        // 旧 `PAA_*` 名に倒す(PBI-0344 AC-3)。新名は var_os のまま(非 UTF-8 の path も受ける)。
        // fallback 側は env_compat を通し、旧名を使った時だけ 1 行警告する
        fn with_legacy(name: &str) -> Option<OsString> {
            env::var_os(name)
                .or_else(|| crate::env_compat::env_new_or_legacy(name).map(Into::into))
        }
        ScanEnv::from_vars(
            env::var_os("PATH"),
            with_legacy("OPENROLY_SCAN_DIRS"),
            with_legacy("OPENROLY_APP_DIRS"),
            env::var_os("HOME").map(PathBuf::from),
            env::var_os("NPM_CONFIG_PREFIX").map(PathBuf::from),
        )
    }

    /// env を引数に分離した純粋版(テストが `env::set_var` を使わずに済む — set_var は他スレッドの
    /// spawn 中の子プロセスの環境を壊す)。`OPENROLY_SCAN_DIRS` / `OPENROLY_APP_DIRS` は **set されていれば**
    /// 固定 dir を丸ごと置換する(空文字 = なし)。
    pub fn from_vars(
        path: Option<OsString>,
        scan_dirs: Option<OsString>,
        app_dirs: Option<OsString>,
        home: Option<PathBuf>,
        npm_prefix: Option<PathBuf>,
    ) -> ScanEnv {
        let path_dirs = path.map(|p| env::split_paths(&p).collect()).unwrap_or_default();
        let extra_dirs = match scan_dirs {
            Some(v) => env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).collect(),
            None => default_bin_dirs(home.as_deref(), npm_prefix.as_deref()),
        };
        let app_dirs = match app_dirs {
            Some(v) => env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).collect(),
            None => default_app_dirs(home.as_deref()),
        };
        ScanEnv { path_dirs, extra_dirs, app_dirs, home }
    }
}

/// 要件 §45.3 層 1 の一般的な binary 置き場(macOS 先行。Linux でも害は無い)。
fn default_bin_dirs(home: Option<&Path>, npm_prefix: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/opt/homebrew/bin")];
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".cargo/bin"));
        dirs.push(h.join(".npm-global/bin"));
    }
    if let Some(prefix) = npm_prefix.filter(|p| !p.as_os_str().is_empty()) {
        dirs.push(prefix.join("bin"));
    }
    dirs
}

fn default_app_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(h) = home {
        dirs.push(h.join("Applications"));
    }
    dirs
}

/// version probe の結果 cache。key = (path, mtime)。binary が置き換われば mtime が変わり再 probe される。
#[derive(Debug, Default)]
pub struct VersionCache {
    entries: HashMap<(PathBuf, Option<SystemTime>), Option<String>>,
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_MAX_CHARS: usize = 64;

impl VersionCache {
    fn probe(&mut self, path: &Path, args: &[String]) -> Option<String> {
        if args.is_empty() {
            return None;
        }
        let mtime = fs::metadata(path).and_then(|m| m.modified()).ok();
        let key = (path.to_path_buf(), mtime);
        if let Some(v) = self.entries.get(&key) {
            return v.clone();
        }
        let v = run_version_probe(path, args);
        self.entries.insert(key, v.clone());
        v
    }
}

/// `<path> <args>` を stdin null で実行し stdout の 1 行目(≤ 64 文字)を返す。3s で kill。
///
/// **pipe を使わない**: stdout を一時ファイルへ向け、子の終了を try_wait で待ってからファイルを読む。
/// pipe 方式は write end が「別スレッドが同時に spawn した無関係な子プロセス」に継承されると
/// EOF が来ずに読み手が固まる(macOS の std は pipe の FD_CLOEXEC 付与に隙間があり、broker 起動時の
/// tokio worker / blocking pool の spawn と競合して実測で hang した)。ファイルなら継承の有無に
/// 関係なく、子が exit した時点で内容が確定する。
fn run_version_probe(path: &Path, args: &[String]) -> Option<String> {
    // 一意な一時ファイル(probe は同時に 1 本だが、念のため pid + nanos で衝突を避ける)
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_path = std::env::temp_dir().join(format!("openroly-probe-{}-{nanos}.out", std::process::id()));
    let out_file = match fs::File::create(&out_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("broker: version probe could not create a temp file {}: {e}", out_path.display());
            return None;
        }
    };
    let spawned = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(out_file)
        .stderr(Stdio::null())
        // Claude Code の中から broker を起動した時、CLAUDECODE が残っていると nested 判定で落ちる
        .env_remove("CLAUDECODE")
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            eprintln!("broker: version probe spawn failed {}: {e}", path.display());
            let _ = fs::remove_file(&out_path);
            return None;
        }
    };
    let start = Instant::now();
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) => {
                if start.elapsed() > PROBE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("broker: version probe timeout {}", path.display());
                    break false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                eprintln!("broker: version probe wait failed {}: {e}", path.display());
                break false;
            }
        }
    };
    let result = if exited {
        fs::read_to_string(&out_path).ok().and_then(|out| {
            let line = out.lines().next().map(str::trim).unwrap_or("");
            if line.is_empty() {
                None
            } else {
                Some(line.chars().take(VERSION_MAX_CHARS).collect())
            }
        })
    } else {
        None
    };
    let _ = fs::remove_file(&out_path);
    result
}

#[cfg(unix)]
pub fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_executable_file(p: &Path) -> bool {
    p.is_file()
}

/// realpath(symlink の先)で install 元を判定する。brew は `/Cellar/` `/Caskroom/`、npm は
/// `/node_modules/` を通る。どちらでもなければ見つけた場所の種別(`default`: "path" / "dir")。
fn infer_source(p: &Path, default: &str) -> String {
    match fs::canonicalize(p) {
        Ok(real) => {
            let s = real.to_string_lossy();
            if s.contains("/Cellar/") || s.contains("/Caskroom/") {
                "brew".to_string()
            } else if s.contains("/node_modules/") {
                "npm".to_string()
            } else {
                default.to_string()
            }
        }
        Err(_) => default.to_string(),
    }
}

/// `Found.path` は **絶対パス**にする(symlink は解かない — AC-4 は symlink 側の path を期待する)。
/// PATH / `OPENROLY_SCAN_DIRS` に相対 entry が混じっていると、cwd を session_dir に固定する dedicated
/// 経路(launch.rs)だけが空の session_dir 基準で解決して `spawn failed` になるため、scan の時点で
/// broker の cwd を基準に固定する。
fn absolutize(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        return p;
    }
    std::path::absolute(&p).unwrap_or(p)
}

fn find_binary(names: &[String], env: &ScanEnv) -> Option<(PathBuf, String)> {
    for name in names {
        for dir in &env.path_dirs {
            let p = dir.join(name);
            if is_executable_file(&p) {
                return Some((absolutize(p.clone()), infer_source(&p, "path")));
            }
        }
        for dir in &env.extra_dirs {
            let p = dir.join(name);
            if is_executable_file(&p) {
                return Some((absolutize(p.clone()), infer_source(&p, "dir")));
            }
        }
    }
    None
}

/// `detect.dirs`(PBI-0210): `~/x` は HOME、絶対 path はそのまま。実在する dir が 1 つでも在れば
/// 「入っている」(vercel-labs/skills の表の検知 path = その agent の設定 dir)。相対 path は見ない
/// (cwd 依存の検知は broker の起動場所で結果が変わるので不採用)。
fn find_dir(dirs: &[String], home: Option<&Path>) -> Option<PathBuf> {
    for d in dirs {
        let p = if let Some(rest) = d.strip_prefix("~/") {
            let Some(h) = home else { continue };
            h.join(rest)
        } else if d == "~" {
            let Some(h) = home else { continue };
            h.to_path_buf()
        } else {
            PathBuf::from(d)
        };
        if p.is_absolute() && p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn find_app(names: &[String], app_dirs: &[PathBuf]) -> Option<PathBuf> {
    for name in names {
        for dir in app_dirs {
            let p = dir.join(name);
            if p.is_dir() {
                return Some(absolutize(p));
            }
        }
    }
    None
}

/// local HTTP service(Ollama :11434 等)の probe timeout。localhost なので短くてよい —
/// heartbeat の scan がここで長く block すると再スキャン全体が詰まる(PBI-0025)。
const SERVICE_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// 悪意ある / 壊れた応答での payload 膨張を防ぐ(VERSION_MAX_CHARS と同じ思想。PBI-0025)。
const MODEL_NAME_MAX_CHARS: usize = 128;
const MAX_MODELS: usize = 200;

#[derive(Deserialize)]
struct ServiceModelsResponse {
    /// Ollama `/api/tags` の形 `{"models":[{"name":"…"}]}`
    #[serde(default)]
    models: Vec<ServiceModel>,
    /// OpenAI 互換 `/v1/models` の形 `{"data":[{"id":"…"}]}`(LM Studio / Jan / llama.cpp / vLLM。PBI-0210)
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct ServiceModel {
    name: String,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

/// `{"models":[{"name":"..."}]}` 形(Ollama `/api/tags` の実形)と `{"data":[{"id":"..."}]}` 形
/// (OpenAI 互換 `/v1/models`)を読み、名前を sort + dedup して返す(`Found.models` の doc コメント
/// どおり、等値の安定性のため)。パース失敗・空は空配列。
fn parse_service_models(body: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<ServiceModelsResponse>(body) else {
        return Vec::new();
    };
    let mut names: Vec<String> = parsed
        .models
        .into_iter()
        .map(|m| m.name)
        .chain(parsed.data.into_iter().map(|m| m.id))
        .map(|name| name.chars().take(MODEL_NAME_MAX_CHARS).collect::<String>())
        .collect();
    names.sort();
    names.dedup();
    names.truncate(MAX_MODELS);
    names
}

/// `detect.services` を順に GET する(最初に応答した 1 つを採用)。接続失敗 / timeout / 非 2xx は
/// 無視して次を試す(全滅なら `None` — エラーを外に漏らさず「見つからなかった」として scan を続ける)。
/// `models` が `source == "service"` かつ同じ path を指していれば、その応答 body をそのまま
/// models 抽出に使う(二重 GET を避ける)。path が別なら同じ host へもう 1 回 GET する。
fn probe_service(services: &[ServiceProbe], models: Option<&ModelsSpec>) -> Option<(String, Vec<String>)> {
    let agent = ureq::AgentBuilder::new().timeout(SERVICE_PROBE_TIMEOUT).build();
    for svc in services {
        let base = format!("http://127.0.0.1:{}", svc.port);
        let url = format!("{base}{}", svc.path);
        let Ok(resp) = agent.get(&url).call() else { continue };
        let model_names = match models {
            Some(spec) if spec.source == "service" && spec.path == svc.path => {
                resp.into_string().ok().map(|b| parse_service_models(&b)).unwrap_or_default()
            }
            Some(spec) if spec.source == "service" => {
                let models_url = format!("{base}{}", spec.path);
                agent
                    .get(&models_url)
                    .call()
                    .ok()
                    .and_then(|r| r.into_string().ok())
                    .map(|b| parse_service_models(&b))
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        };
        return Some((base, model_names));
    }
    None
}

/// registry の detector を id 順に評価する。existence(見つかる/見つからない・path・source)は
/// binary → app bundle → local HTTP service の順(最初に見つかったものを採用)。`detect.services`
/// が空でなければ existence の判定に関わらず必ず probe する(models フィールドの有無を条件に
/// しない — さもないと「services はあるが models フィールドが無い detector」で existence の
/// fallback が一生発火しなくなり、このコメント自体が嘘になる)。
/// **models だけは独立**: `models.source == "service"` の detector は、existence が binary/app
/// 経由で決まっていても services を必ず probe して models を補う(PBI-0025)。binary/app を優先して
/// services を skip すると、「CLI はインストール済みだが実際に daemon が起動していて何のモデルを
/// 持っているか」を一生確認しないまま `models` が常に空になる —— インストール方法(brew の
/// `ollama` 等)がある環境ほど頻発する。
pub fn scan(registry: &Registry, env: &ScanEnv, versions: &mut VersionCache) -> Vec<Found> {
    let mut out = Vec::new();
    for d in &registry.detectors {
        // `detect.always`(PBI-0070): 探索せずに常に見つかったことにする。外部 API provider は
        // 端末に binary を持たない —— 実体は `openroly agent <provider>` で、端末の device key が
        // あれば必ず使える(EP-0009 C)。path は空(spawn 先は OPENROLY_CLI が決める)
        if d.detect.always {
            out.push(Found {
                id: d.id.clone(),
                version: None,
                source: "always".to_string(),
                path: String::new(),
                models: Vec::new(),
            });
            continue;
        }
        let mut found = find_binary(&d.detect.binaries, env)
            .map(|(path, source)| {
                let version = d.version.as_ref().and_then(|v| versions.probe(&path, &v.args));
                Found { id: d.id.clone(), version, source, path: path.to_string_lossy().to_string(), models: Vec::new() }
            })
            .or_else(|| {
                find_app(&d.detect.apps, &env.app_dirs).map(|path| Found {
                    id: d.id.clone(),
                    version: None,
                    source: "app".to_string(),
                    path: path.to_string_lossy().to_string(),
                    models: Vec::new(),
                })
            })
            .or_else(|| {
                // PBI-0210 AC-9: binary も app も無ければ marker dir(`~/.kiro` 等)の実在で見つける
                find_dir(&d.detect.dirs, env.home.as_deref()).map(|path| Found {
                    id: d.id.clone(),
                    version: None,
                    source: "dir".to_string(),
                    path: path.to_string_lossy().to_string(),
                    models: Vec::new(),
                })
            });
        if !d.detect.services.is_empty() {
            if let Some((base, models)) = probe_service(&d.detect.services, d.models.as_ref()) {
                match &mut found {
                    // 既に binary/app で見つかっている: source/path(existence の証拠)はそのまま、
                    // models だけ生きている service の応答で上書きする
                    Some(f) => f.models = models,
                    // binary/app どちらも無い: service の応答そのものが existence の証拠になる
                    None => {
                        found = Some(Found {
                            id: d.id.clone(),
                            version: None,
                            source: "service".to_string(),
                            path: base,
                            models,
                        })
                    }
                }
            }
        }
        if let Some(f) = found {
            out.push(f);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry;
    use std::os::unix::fs::symlink;

    fn tmp(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("openroly-broker-scan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_exec(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// 書いたばかりの実行ファイルを 1 度実行して macOS の初回起動チェック(syspolicyd)を吸収する。
    /// 実測: 並列 cargo test で新規 script の初回 exec が数秒待たされ、3s の probe timeout に落ちた
    /// (本番の CLI は既存 binary なのでこの遅延は無い)。version を assert するテストだけが呼ぶ。
    fn warm(p: &Path) {
        let _ = Command::new(p).arg("--version").stdin(Stdio::null()).output();
    }

    fn reg() -> Registry {
        registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"claude","detect":{"binaries":["claude"]},"version":{"args":["--version"]},"adapter":"a"},
                {"id":"codex","detect":{"binaries":["codex"]},"version":{"args":["--version"]},"adapter":"b"},
                {"id":"ollama","detect":{"binaries":["ollama"],"apps":["Ollama.app"]},"adapter":null}
            ]}"#,
            "t",
        )
        .unwrap()
    }

    // AC-1 相当: PATH に codex だけ → Found 1 件、source path、version は probe 結果
    #[test]
    fn finds_binary_on_path_with_version() {
        let dir = tmp("path");
        write_exec(&dir.join("codex"), "#!/bin/sh\necho 1.2.3\n");
        warm(&dir.join("codex"));
        let env = ScanEnv { path_dirs: vec![dir.clone()], ..Default::default() };
        let mut cache = VersionCache::default();
        let found = scan(&reg(), &env, &mut cache);
        assert_eq!(
            found,
            vec![Found {
                id: "codex".into(),
                version: Some("1.2.3".into()),
                source: "path".into(),
                path: dir.join("codex").to_string_lossy().into(),
                models: vec![],
            }]
        );
        // AC-7: 2 回目も等値(probe は cache、差分判定が壊れない)
        assert_eq!(scan(&reg(), &env, &mut cache), found);
        assert_eq!(cache.entries.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    // PBI-0210 AC-9: binary も app も無い runtime は `detect.dirs`(`~/.kiro` 等)の実在で見つかる(source dir)。
    // HOME が無ければ `~/` 形は探さない。dir も無ければ載らない
    #[test]
    fn finds_marker_dir_under_home_when_no_binary_or_app() {
        let dir = tmp("dirs");
        let reg = crate::registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"kiro","adapter":"generic/native","detect":{"binaries":["kiro-cli"],"dirs":["~/.kiro"]}},
                {"id":"amp","adapter":"generic/native","detect":{"binaries":["amp"],"dirs":["~/.config/amp"]}}]}"#,
            "t",
        )
        .unwrap();
        fs::create_dir_all(dir.join("home").join(".kiro")).unwrap();
        let env = ScanEnv { home: Some(dir.join("home")), ..Default::default() };
        let mut cache = VersionCache::default();
        let found = scan(&reg, &env, &mut cache);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].id, "kiro");
        assert_eq!(found[0].source, "dir");
        assert_eq!(found[0].path, dir.join("home").join(".kiro").to_string_lossy());
        assert!(found[0].version.is_none());
        // HOME 無し = `~/` の dir は探さない(絶対 path の dirs だけ見る)
        assert!(scan(&reg, &ScanEnv::default(), &mut cache).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    // PBI-0210 AC-6: OpenAI 互換 `/v1/models`(LM Studio / Jan / llama.cpp / vLLM)の `{data:[{id}]}` も読める
    #[test]
    fn parse_service_models_reads_openai_data_form_too() {
        assert_eq!(
            parse_service_models(r#"{"object":"list","data":[{"id":"b","object":"model"},{"id":"a"}]}"#),
            vec!["a", "b"]
        );
        // Ollama 形と混在しても 1 つの sort + dedup
        assert_eq!(parse_service_models(r#"{"models":[{"name":"a"}],"data":[{"id":"a"},{"id":"c"}]}"#), vec!["a", "c"]);
        assert!(parse_service_models(r#"{"data":"x"}"#).is_empty());
    }

    #[test]
    fn non_executable_file_is_not_found() {
        let dir = tmp("noexec");
        fs::write(dir.join("claude"), "#!/bin/sh\n").unwrap();
        let env = ScanEnv { path_dirs: vec![dir.clone()], ..Default::default() };
        assert!(scan(&reg(), &env, &mut VersionCache::default()).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_env_finds_nothing() {
        assert!(scan(&reg(), &ScanEnv::default(), &mut VersionCache::default()).is_empty());
    }

    // AC-4: 固定 dir(PATH に無い)で見つけ、realpath で brew / npm / dir を判定する。path は symlink 側
    #[test]
    fn source_is_inferred_from_realpath_in_extra_dirs() {
        let dir = tmp("src");
        // brew: <dir>/Cellar/codex/1.0/bin/codex ← <dir>/bin/codex
        write_exec(&dir.join("Cellar/codex/1.0/bin/codex"), "#!/bin/sh\necho 9\n");
        fs::create_dir_all(dir.join("bin")).unwrap();
        symlink(dir.join("Cellar/codex/1.0/bin/codex"), dir.join("bin/codex")).unwrap();
        // npm: <dir>/lib/node_modules/@anthropic-ai/claude-code/cli.js ← <dir>/bin/claude
        write_exec(&dir.join("lib/node_modules/@anthropic-ai/claude-code/cli.js"), "#!/bin/sh\necho 8\n");
        symlink(dir.join("lib/node_modules/@anthropic-ai/claude-code/cli.js"), dir.join("bin/claude")).unwrap();
        // dir: symlink 無しの実体
        write_exec(&dir.join("bin/ollama"), "#!/bin/sh\n");
        warm(&dir.join("bin/codex"));
        warm(&dir.join("bin/claude"));
        let env = ScanEnv { extra_dirs: vec![dir.join("bin")], ..Default::default() };
        let found = scan(&reg(), &env, &mut VersionCache::default());
        let by_id: HashMap<_, _> = found.iter().map(|f| (f.id.as_str(), f)).collect();
        assert_eq!(by_id["codex"].source, "brew");
        assert_eq!(by_id["codex"].path, dir.join("bin/codex").to_string_lossy());
        assert_eq!(by_id["codex"].version.as_deref(), Some("9"));
        assert_eq!(by_id["claude"].source, "npm");
        assert_eq!(by_id["ollama"].source, "dir");
        assert_eq!(by_id["ollama"].version, None); // version.args 無し → probe しない
        fs::remove_dir_all(&dir).unwrap();
    }

    // PATH で見つかった brew symlink も source は brew(install 元の判定が優先)
    #[test]
    fn brew_symlink_on_path_is_brew() {
        let dir = tmp("brewpath");
        write_exec(&dir.join("Caskroom/x/bin/codex"), "#!/bin/sh\n");
        fs::create_dir_all(dir.join("bin")).unwrap();
        symlink(dir.join("Caskroom/x/bin/codex"), dir.join("bin/codex")).unwrap();
        let env = ScanEnv { path_dirs: vec![dir.join("bin")], ..Default::default() };
        let found = scan(&reg(), &env, &mut VersionCache::default());
        assert_eq!(found[0].source, "brew");
        fs::remove_dir_all(&dir).unwrap();
    }

    // AC-4c: app bundle は dir の実在で検出、version 無し、source app
    #[test]
    fn app_bundle_is_found_without_version() {
        let dir = tmp("apps");
        fs::create_dir_all(dir.join("Ollama.app/Contents")).unwrap();
        let env = ScanEnv { app_dirs: vec![dir.clone()], ..Default::default() };
        let found = scan(&reg(), &env, &mut VersionCache::default());
        assert_eq!(
            found,
            vec![Found {
                id: "ollama".into(),
                version: None,
                source: "app".into(),
                path: dir.join("Ollama.app").to_string_lossy().into(),
                models: vec![],
            }]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    // PBI-0039 AC-2: PATH / app dir が相対でも Found.path は絶対(dedicated session は cwd を
    // session_dir に固定するので、相対のままだと spawn failed になる)
    #[test]
    fn found_path_is_absolute_even_for_relative_scan_dirs() {
        let dir = tmp("rel");
        write_exec(&dir.join("codex"), "#!/bin/sh\n");
        fs::create_dir_all(dir.join("Ollama.app")).unwrap();
        // cwd から temp dir への相対パス(cwd の深さぶん `..` を積んで root からの残りを繋ぐ)
        let cwd = env::current_dir().unwrap();
        let mut rel = PathBuf::new();
        for _ in cwd.components().skip(1) {
            rel.push("..");
        }
        for c in dir.components().skip(1) {
            rel.push(c);
        }
        assert!(rel.is_relative());
        let env = ScanEnv { path_dirs: vec![rel.clone()], app_dirs: vec![rel.clone()], ..Default::default() };
        let found = scan(&reg(), &env, &mut VersionCache::default());
        assert_eq!(found.len(), 2, "{found:?}");
        for f in &found {
            assert!(Path::new(&f.path).is_absolute(), "{} が相対のまま", f.path);
        }
        assert_eq!(fs::canonicalize(&found[0].path).unwrap(), fs::canonicalize(dir.join("codex")).unwrap());
        assert_eq!(found[1].source, "app");
        assert_eq!(fs::canonicalize(&found[1].path).unwrap(), fs::canonicalize(dir.join("Ollama.app")).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    // version probe: 3s を超える binary は None(hang させない)、失敗も None
    #[test]
    fn version_probe_times_out_and_tolerates_failure() {
        let dir = tmp("probe");
        write_exec(&dir.join("slow"), "#!/bin/sh\nsleep 10\n");
        write_exec(&dir.join("fail"), "#!/bin/sh\nexit 3\n");
        write_exec(&dir.join("long"), &format!("#!/bin/sh\necho {}\n", "v".repeat(200)));
        warm(&dir.join("long"));
        let args = vec!["--version".to_string()];
        let start = Instant::now();
        assert_eq!(run_version_probe(&dir.join("slow"), &args), None);
        assert!(start.elapsed() < Duration::from_secs(6));
        assert_eq!(run_version_probe(&dir.join("fail"), &args), None);
        assert_eq!(run_version_probe(&dir.join("long"), &args).unwrap().len(), VERSION_MAX_CHARS);
        fs::remove_dir_all(&dir).unwrap();
    }

    // `OPENROLY_SCAN_DIRS=""` は固定 dir を空にする(E2E が実マシンの /opt/homebrew/bin 等を見ないための契約)
    #[test]
    fn empty_scan_dirs_env_disables_default_dirs() {
        // env は触らない(set_var は並列テストの spawn を壊す)。from_vars に値を渡して検証する
        let e = ScanEnv::from_vars(
            Some("/a:/b".into()),
            Some("".into()),
            Some("".into()),
            Some(PathBuf::from("/h")),
            None,
        );
        assert_eq!(e.path_dirs, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert!(e.extra_dirs.is_empty());
        assert!(e.app_dirs.is_empty());
        // set されていなければ固定 dir(HOME 配下と NPM_CONFIG_PREFIX/bin を含む)
        let d = ScanEnv::from_vars(None, None, None, Some(PathBuf::from("/h")), Some(PathBuf::from("/npm")));
        assert!(d.path_dirs.is_empty());
        assert!(d.extra_dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(d.extra_dirs.contains(&PathBuf::from("/h/.cargo/bin")));
        assert!(d.extra_dirs.contains(&PathBuf::from("/npm/bin")));
        assert_eq!(d.app_dirs, vec![PathBuf::from("/Applications"), PathBuf::from("/h/Applications")]);
        // 置換は丸ごと(既定に足すのではない)
        let r = ScanEnv::from_vars(None, Some("/x:/y".into()), Some("/apps".into()), Some(PathBuf::from("/h")), None);
        assert_eq!(r.extra_dirs, vec![PathBuf::from("/x"), PathBuf::from("/y")]);
        assert_eq!(r.app_dirs, vec![PathBuf::from("/apps")]);
    }

    // ---------- PBI-0025: local HTTP service(Ollama)の検出 ----------
    //
    // 実 Ollama(port 11434)には依存しない — `TcpListener::bind("127.0.0.1:0")` で毎回別の空き port を
    // もらい、その port を registry の `services[].port` に埋め込む(LEARN 13 と同型の hermetic 設計)。

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    struct FakeHttpServer {
        port: u16,
    }

    fn write_response(mut stream: TcpStream, body: &str) {
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf); // request は使わない。読み捨てるだけ
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
    }

    impl FakeHttpServer {
        /// 接続ごとに `body` を 200 で返す(最大 8 件。scan() の複数回呼び出しをまかなえれば十分)。
        fn start_static(body: &'static str) -> FakeHttpServer {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten().take(8) {
                    write_response(stream, body);
                }
            });
            FakeHttpServer { port }
        }

        /// 接続だけ受けて何も書かない(timeout を起こす)。
        fn start_hanging() -> FakeHttpServer {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Some(stream) = listener.incoming().flatten().next() {
                    std::thread::sleep(Duration::from_secs(3));
                    drop(stream);
                }
            });
            FakeHttpServer { port }
        }

        /// bind した直後に drop して「未起動(connection refused)」を作る。port 番号だけ返す。
        fn unused_port() -> u16 {
            TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
        }
    }

    fn reg_with_service(port: u16, path: &str) -> Registry {
        registry::parse(
            &format!(
                r#"{{"version":1,"detectors":[{{"id":"ollama","detect":{{"services":[{{"port":{port},"path":"{path}"}}]}},"models":{{"source":"service","path":"{path}"}},"adapter":null}}]}}"#
            ),
            "t",
        )
        .unwrap()
    }

    // AC-1 / AC-7: service が応答すれば Found{source:"service", models:sort済み}。adapter:null は
    // allowlist に入らない(wake 非対象の回帰)
    #[test]
    fn service_found_with_sorted_models_when_running() {
        let srv = FakeHttpServer::start_static(r#"{"models":[{"name":"mistral"},{"name":"llama3"}]}"#);
        let reg = reg_with_service(srv.port, "/api/tags");
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(
            found,
            vec![Found {
                id: "ollama".into(),
                version: None,
                source: "service".into(),
                path: format!("http://127.0.0.1:{}", srv.port),
                models: vec!["llama3".into(), "mistral".into()],
            }]
        );
        assert!(!reg.allowlist().contains(&"ollama".to_string()));
    }

    // AC-2: 未起動(connection refused)なら Found に含まれない。panic もしない
    #[test]
    fn service_absent_when_not_running() {
        let port = FakeHttpServer::unused_port();
        let reg = reg_with_service(port, "/api/tags");
        assert!(scan(&reg, &ScanEnv::default(), &mut VersionCache::default()).is_empty());
    }

    // AC-3: 起動しているが models が 0 件 → Found は在るが models は空
    #[test]
    fn service_found_with_zero_models() {
        let srv = FakeHttpServer::start_static(r#"{"models":[]}"#);
        let reg = reg_with_service(srv.port, "/api/tags");
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, "service");
        assert!(found[0].models.is_empty());
    }

    // AC-4: 200 だが body が壊れた JSON → Found は在る(service 自体は生きている)、models は空
    #[test]
    fn service_found_with_malformed_body_yields_empty_models() {
        let srv = FakeHttpServer::start_static("not json");
        let reg = reg_with_service(srv.port, "/api/tags");
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(found.len(), 1);
        assert!(found[0].models.is_empty());
    }

    // AC-5: 接続だけ受けて応答しない → SERVICE_PROBE_TIMEOUT(800ms)級で諦める。scan 全体が長時間 block しない
    #[test]
    fn service_probe_times_out_and_is_absent() {
        let srv = FakeHttpServer::start_hanging();
        let reg = reg_with_service(srv.port, "/api/tags");
        let start = Instant::now();
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert!(found.is_empty());
        assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());
    }

    // AC-6: 同じ状態で scan() を 2 回呼んでも Found が完全に等値(heartbeat の差分判定が壊れない)
    #[test]
    fn repeated_scan_of_stable_service_is_equal() {
        let srv = FakeHttpServer::start_static(r#"{"models":[{"name":"b"},{"name":"a"},{"name":"a"}]}"#);
        let reg = reg_with_service(srv.port, "/api/tags");
        let mut cache = VersionCache::default();
        let first = scan(&reg, &ScanEnv::default(), &mut cache);
        let second = scan(&reg, &ScanEnv::default(), &mut cache);
        assert_eq!(first, second);
        // dedup も確認(同名が 2 回返っても 1 件)
        assert_eq!(first[0].models, vec!["a".to_string(), "b".to_string()]);
    }

    fn reg_with_binary_and_service(port: u16, path: &str) -> Registry {
        registry::parse(
            &format!(
                r#"{{"version":1,"detectors":[{{"id":"ollama","detect":{{"binaries":["ollama"],"services":[{{"port":{port},"path":"{path}"}}]}},"models":{{"source":"service","path":"{path}"}},"adapter":null}}]}}"#
            ),
            "t",
        )
        .unwrap()
    }

    // binary(CLI)が見つかっていても、models.source=="service" なら services を必ず probe して
    // models を補う。existence の証拠(source/path)は binary 側を優先して残す(見つけ方の実態を保つ)
    #[test]
    fn models_are_enriched_from_service_even_when_binary_already_found() {
        let dir = tmp("ollama-bin-and-service");
        write_exec(&dir.join("ollama"), "#!/bin/sh\n");
        let srv = FakeHttpServer::start_static(r#"{"models":[{"name":"llama3"}]}"#);
        let reg = reg_with_binary_and_service(srv.port, "/api/tags");
        let env = ScanEnv { path_dirs: vec![dir.clone()], ..Default::default() };
        let found = scan(&reg, &env, &mut VersionCache::default());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, "path"); // binary 由来のまま(service に上書きされない)
        assert_eq!(found[0].path, dir.join("ollama").to_string_lossy());
        assert_eq!(found[0].models, vec!["llama3".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    // binary は見つかるが daemon(service)が起動していない: 前は models が常に空になっていた
    // (services を一切 probe しない設計だった)ことの回帰。source は binary のまま、models は空
    #[test]
    fn binary_found_but_service_down_yields_empty_models_not_error() {
        let dir = tmp("ollama-bin-only");
        write_exec(&dir.join("ollama"), "#!/bin/sh\n");
        let port = FakeHttpServer::unused_port();
        let reg = reg_with_binary_and_service(port, "/api/tags");
        let env = ScanEnv { path_dirs: vec![dir.clone()], ..Default::default() };
        let found = scan(&reg, &env, &mut VersionCache::default());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, "path");
        assert!(found[0].models.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---------- AC-X1〜X3: 独立レビューの攻撃 test(review-fix) ----------

    // AC-X1: `services` はあるが `models` field が無い detector(既存 registry には無い形だが、
    // scan() の doc comment は「existence は binary → app → service の順」を無条件に謳っている。
    // models フィールドの有無をゲートに使うと、この comment が嘘になる回帰を防ぐ)
    #[test]
    fn service_is_probed_for_existence_even_without_models_field() {
        let srv = FakeHttpServer::start_static(r#"{"models":[{"name":"llama3"}]}"#);
        let reg = registry::parse(
            &format!(
                r#"{{"version":1,"detectors":[{{"id":"ollama","detect":{{"services":[{{"port":{},"path":"/api/tags"}}]}},"adapter":null}}]}}"#,
                srv.port
            ),
            "t",
        )
        .unwrap();
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].source, "service");
        assert_eq!(found[0].path, format!("http://127.0.0.1:{}", srv.port));
        // models field が無いので抽出はしない(existence だけ成立する)
        assert!(found[0].models.is_empty());
    }

    // AC-X2: `services` に複数候補があり、先頭が未起動(connection refused)。probe_service が
    // 1 件目で諦めず 2 件目を試すことを検証する(既存テストは services 1 件のみだった)
    #[test]
    fn probe_service_falls_through_to_second_candidate_when_first_is_down() {
        let dead_port = FakeHttpServer::unused_port();
        let srv = FakeHttpServer::start_static(r#"{"models":[{"name":"llama3"}]}"#);
        let reg = registry::parse(
            &format!(
                r#"{{"version":1,"detectors":[{{"id":"ollama","detect":{{"services":[{{"port":{dead_port},"path":"/api/tags"}},{{"port":{},"path":"/api/tags"}}]}},"models":{{"source":"service","path":"/api/tags"}},"adapter":null}}]}}"#,
                srv.port
            ),
            "t",
        )
        .unwrap();
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].path, format!("http://127.0.0.1:{}", srv.port));
        assert_eq!(found[0].models, vec!["llama3".to_string()]);
    }

    // AC-X3: 応答 body に "models" key 自体が無い(`{}`)。明示的な空配列(AC-3)とは別の入力形 —
    // serde の `#[serde(default)]` が効いて空配列になり、panic しないことを確認する
    #[test]
    fn service_response_missing_models_key_yields_empty_models() {
        let srv = FakeHttpServer::start_static("{}");
        let reg = reg_with_service(srv.port, "/api/tags");
        let found = scan(&reg, &ScanEnv::default(), &mut VersionCache::default());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, "service");
        assert!(found[0].models.is_empty());
    }

    #[test]
    fn always_detector_is_found_without_probing_binaries() {
        // PBI-0070: 外部 API provider は端末に binary を持たない。探索せずに Found を返す
        let reg = registry::parse(
            r#"{"version":1,"detectors":[
                {"id":"openai-api","kind":"api","detect":{"always":true},"adapter":"official/api"},
                {"id":"nothere","detect":{"binaries":["openroly-broker-not-a-real-binary"]},"adapter":"official/x"}
            ]}"#,
            "t",
        )
        .unwrap();
        let dir = tmp("always");
        let env = ScanEnv {
            path_dirs: vec![dir.clone()],
            app_dirs: vec![dir.clone()],
            extra_dirs: Vec::new(),
            home: None,
        };
        let mut versions = VersionCache::default();
        let found = scan(&reg, &env, &mut versions);
        let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["openai-api"], "always だけが見つかる");
        assert_eq!(found[0].source, "always");
        assert!(found[0].path.is_empty(), "path は空(spawn 先は OPENROLY_CLI が決める)");
        let _ = fs::remove_dir_all(&dir);
    }
}
