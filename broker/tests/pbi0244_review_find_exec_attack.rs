//! PBI-0244 有界レビューの攻撃 test(review 2026-09-07)。
//!
//! `pbi0244_registry_attack.rs` は shell / interpreter(`sh` / `bash` / `python3` …)を deny 表で
//! 止められることを撃つ。ここで撃ったのは違う角度: **deny 表は「shell / interpreter」の名前だけを
//! 見る blocklist で、GTFOBins 系の「shell でも interpreter でもないが自分の引数だけで任意コマンドを
//! 実行できる program」は 1 件も載っていなかった。** `validate()` は `launch.new` / `launch.existing`
//! を `-c` / `-e` / `--eval` の 3 トークンだけで見るので、program 固有の実行 flag(`-exec` / `-o` /
//! `BEGIN{...}` 自体が program の引数)は素通りしていた。
//!
//! **実 spawn まで確認した(fix 前に赤で確認済み。この機・macOS Darwin 上):**
//!   - `find -maxdepth 0 -exec <cmd> \;` → 実行された
//!   - `awk 'BEGIN{system("<cmd>")}'` → 実行された
//!   - `ssh -o ProxyCommand=<cmd> <host>` → 実行された(接続不要)
//!   - `scp -o ProxyCommand=<cmd> <local> <host>:<path>` → 実行された(接続不要)
//!   - `rsync -e <cmd> <host>:<path> <path>` → 実行された(接続不要)
//!
//! fix: `packages/core/src/forbidden-programs.txt` に `find` / `awk` / `gawk` / `mawk` / `nawk` /
//! `ssh` / `scp` / `sftp` / `rsync` を追加(broker と Cloud が同じ file を読むので両方に効く)。
//! この test は **fix 後に green** であることを見る(= id にも launch.new にも 1 つでも仕込むと
//! registry ごと拒否される)。
//!
//! `broker` は lib crate を持たない(bin のみ)ので、`#[path]` で src を直接取り込む
//! (`pbi0244_registry_attack.rs` と同じ形)。

#[path = "../src/env_compat.rs"]
mod env_compat;
#[path = "../src/registry.rs"]
mod registry;

use std::fs;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("openroly-pbi0244-review-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// (1) GTFOBins 系 program は id 単体でも deny される(resolve_program の bare-name fallback の元)。
#[test]
fn 攻撃6_gtfobins系_program_は_id_でも_binaries_でも拒否される() {
    for name in ["find", "awk", "gawk", "mawk", "nawk", "ssh", "scp", "sftp", "rsync"] {
        assert!(registry::is_forbidden_program(name), "{name} が deny 表に無い(GTFOBins 系の穴)");
        let by_id = format!(r#"{{"version":1,"detectors":[{{"id":"{name}","adapter":"x"}}]}}"#);
        assert!(registry::parse(&by_id, "t").is_err(), "id={name} が parse を通った");
        let by_bin = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{name}"]}}}}]}}"#);
        assert!(registry::parse(&by_bin, "t").is_err(), "binaries=[{name}] が parse を通った");
    }
    // 陰性対照: 正規 catalog の binary はこの追加で巻き込まれない
    for b in ["nodemon", "opencode", "codex", "openclaw", "cursor-agent", "kiro-cli"] {
        let body = format!(r#"{{"version":1,"detectors":[{{"id":"a","detect":{{"binaries":["{b}"]}}}}]}}"#);
        assert!(registry::parse(&body, "t").is_ok(), "{b} を誤って落とした");
    }
}

/// (2) 元の攻撃経路そのもの: `id:"find"` + `launch.new` に `-exec` を仕込んだ registry が、
/// fix 後は registry ごと拒否される(= 実 spawn まで一度も到達しない)。
#[test]
fn 攻撃7_find_exec_を仕込んだ_launch_new_の_registry_は_fix_後は_parse_で丸ごと拒否される() {
    let dir = tmp("find-exec");
    let marker = dir.join("pwned");
    let body = format!(
        r#"{{"version":1,"detectors":[{{"id":"find","adapter":"x",
            "launch":{{"new":["{}","-maxdepth","0","-exec","touch","{}",";"]}}}}]}}"#,
        dir.display(),
        marker.display()
    );
    let err = registry::parse(&body, "fetched").unwrap_err();
    assert_eq!(err, r#"registry: forbidden program "find""#, "{err}");
    assert!(!marker.exists(), "拒否したはずの find が実行された");
    fs::remove_dir_all(&dir).unwrap();
}

/// (3) 同じ穴を突く別の 3 経路(awk の system() / ssh・rsync の `-o`/`-e`)も、id 側で丸ごと拒否される。
/// (launch 引数の形は program ごとに違うので、ここは id 単体の拒否だけを見る —— 攻撃6 と併せて
/// 「program 名で拒否 = launch args の中身に関係なく registry ごと落ちる」を担保する)
#[test]
fn 攻撃8_awk_ssh_rsync_も_id_で拒否され_該当_launch_引数まで到達しない() {
    let cases = [
        (
            "awk",
            r#"["BEGIN{system(\"touch /tmp/should-not-run\")}", "/dev/null"]"#,
        ),
        ("ssh", r#"["-o", "ProxyCommand=/usr/bin/touch /tmp/should-not-run", "x"]"#),
        ("rsync", r#"["-e", "/usr/bin/touch /tmp/should-not-run", "x:y", "z"]"#),
    ];
    for (id, launch_new) in cases {
        let body = format!(r#"{{"version":1,"detectors":[{{"id":"{id}","adapter":"x","launch":{{"new":{launch_new}}}}}]}}"#);
        let err = registry::parse(&body, "t").unwrap_err();
        assert_eq!(err, format!(r#"registry: forbidden program "{id}""#), "{id}: {err}");
    }
}
