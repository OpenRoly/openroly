//! 旧 env 名(`PAA_*`)と旧 state dir(`~/.atn`)の読み替え(PBI-0344 AC-3)。
//! broker は **process env を書き換えない**(tests/no_process_env_mutation.rs)ので、
//! TS 側の `adoptLegacyEnv`(採り込んで書き換える)と違い、**読む口の 1 関数で fallback する**。
//! 新名が在れば常にそれが勝つ。旧名を使った時だけ stderr に 1 行(1 process 1 回)。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

const NEW_PREFIX: &str = "OPENROLY_";
const LEGACY_PREFIX: &str = "PAA_";

static LEGACY_ENV_WARNED: AtomicBool = AtomicBool::new(false);
static LEGACY_DIR_WARNED: AtomicBool = AtomicBool::new(false);

/// 新名から旧名を計算する純粋部品。`OPENROLY_BROKER_WS_URL` → `PAA_BROKER_WS_URL`
pub fn legacy_env_name(name: &str) -> String {
    debug_assert!(name.starts_with(NEW_PREFIX), "新名の key だけを渡す: {name}");
    format!("{LEGACY_PREFIX}{}", &name[NEW_PREFIX.len()..])
}

/// 「新名が在ればそれ・無ければ旧名」の選択の純粋部品。戻り値の bool は「旧名を使った」
/// (= 警告を出すべき)。IO を持たないので unit test で直接測る。
pub fn pick_new_or_legacy(new_value: Option<&str>, legacy_value: Option<&str>) -> (Option<String>, bool) {
    match (new_value, legacy_value) {
        (Some(v), _) => (Some(v.to_string()), false),
        (None, Some(v)) => (Some(v.to_string()), true),
        (None, None) => (None, false),
    }
}

/// `$OPENROLY_X` を読む。無ければ旧名 `$PAA_X` に倒す(1 行警告)。
/// 呼び口は新名の key だけを渡す(旧名の key を渡した物は debug_assert で止まる)。
pub fn env_new_or_legacy(name: &str) -> Option<String> {
    let (picked, legacy_used) = pick_new_or_legacy(
        std::env::var(name).ok().as_deref(),
        std::env::var(legacy_env_name(name)).ok().as_deref(),
    );
    if legacy_used && !LEGACY_ENV_WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "[openroly] legacy env name {} was read (support ends in a future release)",
            legacy_env_name(name)
        );
    }
    picked
}

/// 「新しい場所を既定に、旧の場所だけが在る端末ではそれを引き継ぐ」(TS 側 `legacyDir` と同じ規則)。
/// 新が在る/両方無い → 新。旧だけ在る → 旧 + 警告 1 行。
pub fn legacy_dir(fresh: PathBuf, legacy: PathBuf) -> PathBuf {
    if fresh.exists() || !legacy.exists() {
        return fresh;
    }
    if !LEGACY_DIR_WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "[openroly] legacy state directory {} is in use — move it to {} (support ends in a future release)",
            legacy.display(),
            fresh.display()
        );
    }
    legacy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_name_keeps_the_suffix() {
        assert_eq!(legacy_env_name("OPENROLY_BROKER_WS_URL"), "PAA_BROKER_WS_URL");
        assert_eq!(legacy_env_name("OPENROLY_A"), "PAA_A");
    }

    #[test]
    fn new_wins_and_never_warns() {
        let (picked, legacy_used) = pick_new_or_legacy(Some("new"), Some("old"));
        assert_eq!(picked.as_deref(), Some("new"));
        assert!(!legacy_used);
    }

    #[test]
    fn legacy_only_is_used_and_flags_a_warning() {
        let (picked, legacy_used) = pick_new_or_legacy(None, Some("old"));
        assert_eq!(picked.as_deref(), Some("old"));
        assert!(legacy_used);
    }

    #[test]
    fn neither_is_none_without_warning() {
        assert_eq!(pick_new_or_legacy(None, None), (None, false));
    }
}
