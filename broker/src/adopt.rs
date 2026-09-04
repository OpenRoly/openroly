//! 自動登録(PBI-0023 / REQ-19、図18)の materialize 面。Cloud が hello の応答で返した
//! `registered` を受け、kind ごとに `atn adopt` を起こして credential + MCP config を書かせる。
//!
//! credentials.json の書式・lock 手順・`claude mcp add` の呼び方の正本は TS 側(Common
//! Installation Engine)の 1 箇所に置く —— Rust に写すと正本が 2 枚になり、片方だけ直る。
//! ここがやるのは「起こして token を stdin へ渡し、exit code を見る」だけ。
//!
//! token を argv に載せないのは、argv が同一ホストの他プロセスから `ps` で見えるため。

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::paa_cli::cli_argv;

/// `registered.runtimes[]` の 1 件。
#[derive(Debug, Clone, PartialEq)]
pub struct Adoption {
    pub kind: String,
    pub runtime_id: String,
    pub token: String,
    pub base_url: String,
    pub name: String,
}

/// materialize 1 件の上限。CLI が対話待ちで固まっても WS ループを巻き込まない。
///
/// **5 秒では足りない**(PBI-0190 で本番実測): `atn adopt` は bun を起動し、その先で
/// `claude mcp add` のような **runtime 自身の CLI** を呼ぶ。その CLI の起動が数秒かかる機械では
/// 5 秒を超え、全部 `adopt_timeout` で落ちて **MCP が 1 つも登録されない**
/// (同じ機械で `claude --version` の probe も 5 秒で timeout していた)。
/// 60 秒に伸ばし(30 秒でも gemini が落ちた)、代わりに呼び出し側で **並行**に走らせて
/// WS ループの停止時間を 1 件分に抑える(件数の上限は `ADOPT_CONCURRENCY`)。
const ADOPT_TIMEOUT: Duration = Duration::from_secs(60);

/// **同時に走らせる materialize の上限**(PBI-0235)。`registered` の件数は Cloud が決めるので、
/// 1000 件返ってくれば端末で 1000 個の子プロセスが同時に立つ —— 1 件あたり `atn adopt`(bun)と
/// その先の runtime CLI(`claude mcp add` 等)で 2 プロセス以上、しかも `ADOPT_TIMEOUT` の 60 秒
/// 居座る。Cloud は信頼している(TLS + token)が、broker は「Cloud の言葉で**端末の process を
/// 起こす**」唯一の場所なので、信頼していても量の上限は持つ。
///
/// **4 にした根拠**: 端末に同時に立つ子を `2 × 4 = 8` プロセスに抑えつつ、catalog の
/// adapter 付き detector は現状 6 種(`apps/server/registry/detectors.v1.json`)なので
/// 実運用の最大 6 件でも 2 波(最悪 `2 × ADOPT_TIMEOUT`)で終わり、通常の 1〜3 件は待ちが
/// 一度も発生しない。
///
/// 上限は **総数ではなく同時実行数**に掛ける —— 件数で切り捨てると全件に `register_ack` を
/// 返す義務(PBI-0023。Cloud は ack の無い行を宙に浮かせる)を破るため。
pub const ADOPT_CONCURRENCY: usize = 4;

/// `registered` payload から取り出す。欠落・型不正の要素は捨てる(1 つ壊れていても残りは進める)。
/// `name` だけは空でも通す —— 表示名が無いことは materialize の失敗理由にならない。
pub fn parse_registered(msg: &Value) -> Vec<Adoption> {
    let Some(items) = msg.get("runtimes").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| {
            let field = |k: &str| {
                v.get(k)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            Some(Adoption {
                kind: field("kind")?,
                runtime_id: field("runtime_id")?,
                token: field("token")?,
                base_url: field("base_url")?,
                name: field("name").unwrap_or_default(),
            })
        })
        .collect()
}

/// 同時に起こす本数を決める(純関数)。件数より多い permit は要らず、**0 にはしない** ——
/// permit 0 の semaphore は誰も進めないので、全件が永久に待って `register_ack` が 1 つも
/// 返らなくなる(上限の入れ方を間違えた時に「静かに全滅」する唯一の経路)。
pub fn adopt_permits(count: usize, limit: usize) -> usize {
    limit.max(1).min(count.max(1))
}

/// `registered` 1 通分を materialize する。**戻り値は入力と同じ順序・同じ件数**
/// (呼び出し側が zip して 1 件ずつ `register_ack` を返す = 上限で待たされた件も取りこぼさない)。
pub async fn adopt_all(adoptions: &[Adoption]) -> Vec<(bool, String)> {
    adopt_all_with(&cli_argv(), ADOPT_CONCURRENCY, ADOPT_TIMEOUT, adoptions).await
}

/// `adopt_all` の本体。argv / 上限 / timeout を引数で受けるので、test は env(`PAA_CLI`)を
/// 触らずに「同時に何本走ったか」と「1 件が timeout で詰まっても他が完了するか」を測れる ——
/// cargo test は同一プロセスでスレッド並列に走るため、env を書き換える test は互いを壊す。
pub async fn adopt_all_with(
    argv: &[String],
    limit: usize,
    timeout: Duration,
    adoptions: &[Adoption],
) -> Vec<(bool, String)> {
    let sem = Semaphore::new(adopt_permits(adoptions.len(), limit));
    // **並行は保つ**(PBI-0190: 直列だと `件数 × ADOPT_TIMEOUT` の間 WS ループが止まる)。
    // permit は guard として **束縛したまま** 1 件分を await する —— `let _ = ...` で受けると
    // その場で drop されて上限が消える。解放は Drop 任せなので、早期 return(CLI 不在・
    // stdin 書込失敗)も timeout も panic も permit を持ち逃げしない。
    futures_util::future::join_all(adoptions.iter().map(|a| {
        let sem = &sem;
        async move {
            // close しないので Err にはならない。仮に来ても上限無しで走らせる方(= 進む方)へ倒す
            let _permit = sem.acquire().await.ok();
            adopt_one(argv, timeout, a).await
        }
    }))
    .await
}

/// 1 件を materialize する。戻り値 `(ok, detail)` の `detail` は `register_ack` に載る短い理由。
/// CLI 不在は `paa_cli_not_found`(配布で PATH に paa が無い、を運用で名指しできるようにする)。
async fn adopt_one(argv: &[String], timeout: Duration, a: &Adoption) -> (bool, String) {
    let Some((program, leading)) = argv.split_first() else {
        return (false, "paa_cli_not_found".to_string());
    };
    let mut cmd = Command::new(program);
    cmd.args(leading);
    cmd.arg("adopt")
        .arg("--kind")
        .arg(&a.kind)
        .arg("--runtime-id")
        .arg(&a.runtime_id)
        .arg("--base-url")
        .arg(&a.base_url)
        .arg("--name")
        .arg(&a.name)
        .arg("--token-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // timeout で future を drop した時に子を確実に殺す(credential を書きかけたまま
        // 取り残さない)
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("broker: cannot start the atn CLI ({e})");
            return (false, "paa_cli_not_found".to_string());
        }
    };
    // token は stdin へ 1 行書いて close する(EOF を送らないと CLI 側の読み取りが返らない)
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(format!("{}\n", a.token).as_bytes()).await {
            return (false, format!("stdin write failed: {e}"));
        }
        drop(stdin);
    }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => (false, "adopt_timeout".to_string()),
        Ok(Err(e)) => (false, format!("wait failed: {e}")),
        Ok(Ok(out)) if out.status.success() => (true, String::new()),
        Ok(Ok(out)) => {
            // stderr の 1 行目だけを理由にする(任意長の出力を Cloud へ送らない)
            let stderr = String::from_utf8_lossy(&out.stderr);
            let first: String = stderr
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(200)
                .collect();
            let detail = if first.is_empty() {
                format!("exit {}", out.status.code().unwrap_or(-1))
            } else {
                first
            };
            (false, detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(kind: &str) -> Adoption {
        Adoption {
            kind: kind.to_string(),
            runtime_id: "rt_1".into(),
            token: "par_x".into(),
            base_url: "http://127.0.0.1:1".into(),
            name: "M / Codex".into(),
        }
    }

    #[test]
    fn parse_registered_は不正要素を捨てて有効な分だけ返す() {
        let msg = json!({
            "type": "registered",
            "runtimes": [
                {"kind": "codex", "runtime_id": "rt_1", "token": "par_x",
                 "base_url": "http://h", "name": "M / Codex"},
                {"kind": "claude", "runtime_id": "rt_2", "token": "", "base_url": "http://h"},
                {"kind": "claude"},
                "claude",
                42
            ]
        });
        let got = parse_registered(&msg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "codex");
        assert_eq!(got[0].token, "par_x");
        assert_eq!(got[0].name, "M / Codex");
    }

    #[test]
    fn parse_registered_は_runtimes_が無ければ空() {
        assert!(parse_registered(&json!({"type": "registered"})).is_empty());
        assert!(parse_registered(&json!({"runtimes": "x"})).is_empty());
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    // PBI-0023 AC-4b: CLI が居ない環境でも broker は落ちず、名前の付いた reason を返す
    #[tokio::test]
    async fn adopt_は_cli_が無ければ_paa_cli_not_found() {
        let (ok, detail) = adopt_one(
            &argv(&["/nonexistent/atn-broker-test"]),
            ADOPT_TIMEOUT,
            &sample("codex"),
        )
        .await;
        assert!(!ok);
        assert_eq!(detail, "paa_cli_not_found");
        // PAA_CLI が空文字(= 分割後 0 要素)でも同じ扱い
        let (ok2, detail2) = adopt_one(&[], ADOPT_TIMEOUT, &sample("codex")).await;
        assert!(!ok2);
        assert_eq!(detail2, "paa_cli_not_found");
    }

    // PBI-0023 AC-4: exit != 0 は stderr の 1 行目を detail にして ok:false
    #[tokio::test]
    async fn adopt_は_exit_非0_を_stderr_の1行目付きで返す() {
        let cli = argv(&["/bin/sh", "-c", "echo no config >&2; exit 3"]);
        let (ok, detail) = adopt_one(&cli, ADOPT_TIMEOUT, &sample("codex")).await;
        assert!(!ok);
        assert_eq!(detail, "no config");
    }

    // 成功時は stdin から token を受け取れている(CLI 側で読める形で渡している)
    #[tokio::test]
    async fn adopt_は_成功時に_ok_true_と_空_detail_を返し_token_を_stdin_で渡す() {
        let dir = std::env::temp_dir().join(format!("paa-adopt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let out = dir.join("stdin.txt");
        let cli = argv(&["/bin/sh", "-c", &format!("cat > {}", out.display())]);
        let (ok, detail) = adopt_one(&cli, ADOPT_TIMEOUT, &sample("codex")).await;
        assert!(ok, "detail={detail}");
        assert_eq!(detail, "");
        assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "par_x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------ PBI-0235: registered の件数に上限を持つ

    #[test]
    fn adopt_permits_は_0_を返さない() {
        // 件数より多い permit は要らない
        assert_eq!(adopt_permits(3, ADOPT_CONCURRENCY), 3);
        assert_eq!(adopt_permits(1, ADOPT_CONCURRENCY), 1);
        // 件数が多ければ上限で頭打ち
        assert_eq!(adopt_permits(100, ADOPT_CONCURRENCY), 4);
        assert_eq!(adopt_permits(1000, 4), 4);
        // **0 は返さない**。limit 0 は「上限」ではなく「全件を永久に待たせる」なので 1 に戻す
        assert_eq!(adopt_permits(100, 0), 1);
        assert_eq!(adopt_permits(0, 0), 1);
        assert_eq!(adopt_permits(0, 4), 1);
    }

    fn sample_n(i: usize, kind: &str) -> Adoption {
        Adoption {
            kind: kind.to_string(),
            runtime_id: format!("rt_{i}"),
            token: "par_x".into(),
            base_url: "http://127.0.0.1:1".into(),
            name: format!("M / {i}"),
        }
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("paa-adopt-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("live")).unwrap();
        dir
    }

    /// **同時実行数を子プロセスの入口で数える** fake CLI。起動したら `live/<自分の pid>` を作り、
    /// その瞬間の `live` の件数を `peak` へ 1 行書き、`hold` 秒居座ってから消す。
    /// record の写しではなく実行体そのものを数えるので、「permit を握ったまま await している」
    /// を測れる(握らずに spawn していれば件数がそのまま上がる)。
    fn counting_cli(dir: &std::path::Path, hold: &str) -> Vec<String> {
        let d = dir.display().to_string();
        let script = format!(
            "cat >/dev/null; t=\"{d}/live/$$\"; : > \"$t\"; \
             ls \"{d}/live\" | wc -l >> \"{d}/peak\"; sleep {hold}; rm -f \"$t\""
        );
        vec!["/bin/sh".to_string(), "-c".to_string(), script]
    }

    fn peak(dir: &std::path::Path) -> usize {
        std::fs::read_to_string(dir.join("peak"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse::<usize>().ok())
            .max()
            .unwrap_or(0)
    }

    // AC-1: registered に 100 件来ても、同時に走る `atn adopt` は上限以下
    #[tokio::test]
    async fn adopt_all_は同時に走る_adopt_を上限以下に抑える() {
        let items: Vec<Adoption> = (0..20).map(|i| sample_n(i, "codex")).collect();

        let dir = tmp_dir("cap");
        let results = adopt_all_with(
            &counting_cli(&dir, "0.15"),
            4,
            Duration::from_secs(30),
            &items,
        )
        .await;
        assert_eq!(results.len(), items.len());
        assert!(
            results.iter().all(|(ok, _)| *ok),
            "fake CLI が失敗した: {results:?}"
        );
        let capped = peak(&dir);
        assert!(capped > 0, "fake CLI が 1 度も走っていない(検査が空振り)");
        assert!(capped <= 4, "同時に走った adopt が上限を超えた: {capped}");
        let _ = std::fs::remove_dir_all(&dir);

        // **負の対照**: 上限を外す(= 件数と同じ permit を渡す)と、同じ fake で同時実行数が
        // 上限を超える。ここが超えないなら数え方が壊れていて、上の `capped <= 4` は
        // 何も測っていない(PBI-0190 以前の join_all そのままの形が緑になる)。
        let dir2 = tmp_dir("cap-nc");
        let _ = adopt_all_with(
            &counting_cli(&dir2, "0.4"),
            items.len(),
            Duration::from_secs(30),
            &items,
        )
        .await;
        let uncapped = peak(&dir2);
        assert!(
            uncapped > 4,
            "負の対照が上限を超えなかった(同時実行数を数えられていない): {uncapped}"
        );
        let _ = std::fs::remove_dir_all(&dir2);
    }

    // AC-2: 上限で待たされた件も含めて全件に結果が返る(= 全件に register_ack を返せる)。
    // 順序も入力どおり —— 呼び出し側は zip して kind/runtime_id を貼るので、ずれると
    // 「別の runtime の ack」を Cloud へ送ることになる。
    #[tokio::test]
    async fn adopt_all_は待たされた件も含めて全件に順序どおり結果を返す() {
        // $2 = --kind の値。okk は成功、それ以外は runtime_id($4)を stderr に出して exit 7
        let cli = argv(&[
            "/bin/sh",
            "-c",
            "cat >/dev/null; case \"$2\" in okk) exit 0;; *) echo \"ng $4\" >&2; exit 7;; esac",
        ]);
        let items: Vec<Adoption> = (0..12)
            .map(|i| sample_n(i, if i % 2 == 0 { "okk" } else { "ngg" }))
            .collect();

        let results = adopt_all_with(&cli, 4, Duration::from_secs(30), &items).await;

        assert_eq!(results.len(), items.len());
        for (i, (ok, detail)) in results.iter().enumerate() {
            if i % 2 == 0 {
                assert!(ok, "{i} 件目が失敗: {detail}");
                assert_eq!(detail, "");
            } else {
                assert!(!ok, "{i} 件目が成功してしまった");
                assert_eq!(
                    detail,
                    &format!("ng rt_{i}"),
                    "{i} 件目の detail がずれている"
                );
            }
        }
    }

    // AC-X1: 1 件が timeout で詰まっても、他の件は巻き込まれず完了する。
    // timeout を差し替えて測る(本番の ADOPT_TIMEOUT = 60 秒を待たない)。
    //
    // 3 つの assert がそれぞれ別の壊れ方を殺す:
    //   - 全件 timeout でない  → timeout を batch 全体に掛ける形(1 件の詰まりで全滅)
    //   - 件数が揃う          → 詰まった件を捨てて ack を返さない形
    //   - 20 秒以内に返る      → permit を持ち逃げして後続が永久に待つ形(枯渇)
    #[tokio::test]
    async fn 一件が_timeout_で詰まっても他の件は完了する() {
        let cli = argv(&[
            "/bin/sh",
            "-c",
            "cat >/dev/null; case \"$2\" in slow) sleep 30;; *) exit 0;; esac",
        ]);
        let mut items = vec![sample_n(0, "slow")];
        items.extend((1..13).map(|i| sample_n(i, "fast")));

        // timeout は 2 秒 —— 混んだ機械では `/bin/sh` の spawn だけで数百 ms かかるので、
        // ここを詰めすぎると健全な件まで adopt_timeout になる(300ms で実測して踏んだ)
        let started = std::time::Instant::now();
        let results = tokio::time::timeout(
            Duration::from_secs(20),
            adopt_all_with(&cli, 4, Duration::from_secs(2), &items),
        )
        .await
        .expect("permit を持ち逃げして後続が進めなくなっている(枯渇)");
        let elapsed = started.elapsed();

        assert_eq!(results.len(), items.len());
        assert_eq!(results[0], (false, "adopt_timeout".to_string()));
        for (i, (ok, detail)) in results.iter().enumerate().skip(1) {
            assert!(ok, "{i} 件目が詰まりに巻き込まれた: {detail}");
        }
        // 詰まった 1 件は permit を 1 つ抱えたままだが、残り 3 permit が回るので
        // 全体は timeout 1 回分 + spawn の実費で終わる(全員が詰まりを待つ形なら 12 × 2 秒以上)
        assert!(
            elapsed < Duration::from_secs(6),
            "後続が詰まった件を待っている: {elapsed:?}"
        );
    }
}
