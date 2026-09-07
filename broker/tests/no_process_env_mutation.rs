//! broker の source から「プロセス全体の環境変数の書き換え」を締め出す guard(PBI-0034 / PBI-0040)。
//!
//! Rust の test harness は `#[test]` を**複数スレッドで並列実行する**。`std::env::set_var` /
//! `remove_var` はプロセス全体に効くので、1 つのテストが env を差し替えている最中に別のテストが
//! それを読むと、どちらのテストも書いた人の意図と違う値を見る。実害はレースで終わらない —
//! PBI-0019 が入れた `set_var("OPENROLY_BROKER_HOME", tmp_file)` は、隣のテストの `remove_var` が
//! 割り込むと `broker_home()` が実 `$HOME/.openroly/broker` を返し、`session_dir_failed` で止まるはずの
//! 経路が **PATH 上の実 claude CLI の spawn まで進んだ**(`launch.rs` が明示的に避けている事故)。
//!
//! そのため broker では env を読むのを呼び出し口だけに閉じ、テストは値を**引数で**渡す
//! (`launch_session_scoped_in(home, …)` / `ScanEnv::from_vars(…)`)。この guard はその設計が
//! 後から崩されないようにするためのもので、`--test-threads=1` や `serial_test` のような
//! 「並列を諦める」対処を入れずに済ませる代わりの縛りでもある。
//!
//! 走査対象は `broker/src/**` と `broker/tests/**` の両方(PBI-0040 — 元は `src` だけだったが、
//! integration test は `tests/` に置く物なので、そこに書かれた env 書き換えを見逃していた)。
//! `tests/` にはこの guard 自身も含まれるが、除外リストは持たない(除外すると「1 件も読めて
//! いない空振り」と区別が付かなくなる)。自己検査(下の `violations_ignores_comments_but_catches_real_calls`)
//! は `set_var(` という字面をこのファイルのソース上に残さない形(`format!` での組み立て)にして
//! guard が自分自身を誤検出しないようにしてある。
//!
//! 判定はコード行のみ(行コメント `//` 以降は対象外)。設計の理由を書いた doc コメントは
//! `set_var` という語を含むが、それを消させる guard は本末転倒なので通す。
//! 見分けは行単位の素朴な `//` 切りで、字句解析はしない(同じ行の文字列リテラルに `//` を
//! 含めてから `set_var` を呼べば擦り抜けるが、事故で再混入する形は `unsafe { std::env::set_var(…) }`
//! 単独行であり、それは確実に捕まる)。

use std::fs;
use std::path::{Path, PathBuf};

/// 1 ファイル分の違反を `(1-based 行番号, 行)` で返す。行コメント以降は見ない。
///
/// needle(検出対象の部分文字列)は関数名と `"("` を実行時に結合して作る(PBI-0040) ——
/// もし `"set_var("` をこの行に直接書くと、guard の走査対象が `tests/` に広がった時に
/// **この検出ロジック自身の行**が違反として拾われてしまう(検出器は自分の needle を
/// 素朴な substring 一致では避けられない。needle を 2 断片に割って結合する形にすることで
/// この行の生テキストには `"set_var("` という連続した文字列が現れないようにしている)。
fn violations(source: &str) -> Vec<(usize, String)> {
    let set_var = format!("{}{}", "set_var", "(");
    let remove_var = format!("{}{}", "remove_var", "(");
    source
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let code = line.split("//").next().unwrap_or("");
            let hit = code.contains(&set_var) || code.contains(&remove_var);
            hit.then(|| (i + 1, line.trim().to_string()))
        })
        .collect()
}

/// 指定 dir 配下の `.rs` を再帰的に全部集める(新しく足された module/test file も自動で対象になる)。
fn rust_sources(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn tests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

/// guard が走査する全ファイル(`src/**` ∪ `tests/**`)。
fn all_sources() -> Vec<PathBuf> {
    let mut out = rust_sources(&src_dir());
    out.extend(rust_sources(&tests_dir()));
    out
}

#[test]
fn broker_sources_never_mutate_process_env() {
    let files = all_sources();
    let found: Vec<String> = files
        .iter()
        .flat_map(|path| {
            let source = fs::read_to_string(path).expect("read source");
            // 表示名は "src/foo.rs" / "tests/bar.rs" のように親 dir 付きで出す(file:line だけだと
            // src と tests の同名衝突を区別できない)。
            let parent = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string());
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let label = match parent {
                Some(p) => format!("{p}/{name}"),
                None => name,
            };
            violations(&source).into_iter().map(move |(line, text)| format!("{label}:{line}: {text}"))
        })
        .collect();
    assert!(
        found.is_empty(),
        "プロセス env を書き換えている({} 件)。並列テストが互いの env を壊すため、値は引数で渡すこと\
         (例: launch_session_scoped_in(home, …) / ScanEnv::from_vars(…)):\n{}",
        found.len(),
        found.join("\n")
    );
}

/// guard が「何も読めていないのに pass」する形で腐らないようにする(空 dir を走査して緑、が最悪)。
/// 中身の形（特定の関数名）は見ない —— それは env 書き換えの検査ではなく、別 PBI の API 名への結合。
#[test]
fn guard_actually_reads_the_broker_sources() {
    let src_files = rust_sources(&src_dir());
    let src_names: Vec<String> =
        src_files.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
    // crate の長寿命 module(module が増減しても、この 3 つは常に在る)
    for expected in ["main.rs", "launch.rs", "discovery.rs"] {
        assert!(src_names.iter().any(|n| n == expected), "src に {expected} が見えていない: {src_names:?}");
    }

    // tests/ 側も同様に空振りしていないことを確認する(PBI-0040 —
    // このファイル自身が tests/ に居るので、最低 1 件(自分)は必ず見えるはず)。
    let test_files = rust_sources(&tests_dir());
    assert!(!test_files.is_empty(), "tests/ の走査が 0 件(自分自身すら見えていない)");
    let test_names: Vec<String> =
        test_files.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
    assert!(
        test_names.iter().any(|n| n == "no_process_env_mutation.rs"),
        "tests/ の走査に自分自身が含まれていない: {test_names:?}"
    );

    for path in src_files.iter().chain(test_files.iter()) {
        let source = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        assert!(!source.trim().is_empty(), "{} が空(走査が空振りしている)", path.display());
    }
}

/// 判定式の自己検査 — 偽陽性(コメント)と偽陰性(実物)の両方を固定する。
///
/// 走査対象が tests/ にも広がった(PBI-0040)ため、ここで検査に使う文字列リテラルは
/// `format!` で組み立てる —— `"set_var("` を直接この行に書くと、guard が **このファイル自身**の
/// ソースを走査した時にこの行を偽陽性として拾ってしまう(自己検査が自己違反になる)。
#[test]
fn violations_ignores_comments_but_catches_real_calls() {
    let sv = "set_var";
    let rv = "remove_var";
    // 偽陽性: 設計の理由を書いた doc コメントは通す(現に launch.rs / discovery.rs に 3 行ある)
    assert!(violations(&format!("/// `env::{sv}` で差し替える方式は並列テストを壊す\n")).is_empty());
    assert!(violations(&format!("    // env は触らない({sv}(…) は他スレッドの spawn を壊す)\n")).is_empty());
    // 偽陰性: 実際の呼び出しは行番号付きで捕まえる
    let hits =
        violations(&format!("fn t() {{\n    unsafe {{ std::env::{sv}(\"OPENROLY_BROKER_HOME\", \"/tmp/x\"); }}\n}}\n"));
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, 2);
    assert_eq!(violations(&format!("        std::env::{rv}(\"OPENROLY_BROKER_HOME\");\n")).len(), 1);
    // 行の途中にコメントが始まっても、その手前のコードは見る
    assert_eq!(violations(&format!("    env::{sv}(\"A\", \"b\"); // 一時的に\n")).len(), 1);
}
