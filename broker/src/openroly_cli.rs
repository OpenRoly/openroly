//! `openroly` CLI をどう起こすかの 1 箇所(PBI-0070 で adopt.rs から切り出し)。
//!
//! broker は 2 つの用途で TS 側の CLI を起こす: 自動登録の materialize(`openroly adopt`。PBI-0023)と、
//! 外部 API provider を端末側 runtime として動かす wake(`openroly agent`。EP-0009 C)。どちらも
//! 「dev の repo checkout では `openroly` が PATH に無い」という同じ事情を抱えるので、argv0 の
//! 解決を 2 箇所に写さない。

/// 起こす CLI の argv。`OPENROLY_CLI`(既定 `openroly`)。`:` 区切りで argv0 + 先行引数も書ける ——
/// dev の repo checkout(`bun:<repo>/apps/cli/src/openroly.ts`)と、E2E が実 CLI へ到達しないための
/// fake 差し替え口を兼ねる(EP-0001 LEARN 13)。
pub fn cli_argv() -> Vec<String> {
    cli_argv_from(crate::env_compat::env_new_or_legacy("OPENROLY_CLI"))
}

/// env を読む面と分ける(test が値で渡せるように —— broker は「プロセス env を書き換えない」を
/// tests/no_process_env_mutation.rs で守っている)。
pub fn cli_argv_from(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_else(|| "openroly".to_string())
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_openroly() {
        assert_eq!(cli_argv_from(None), vec!["openroly".to_string()]);
    }

    #[test]
    fn splits_argv0_and_leading_args() {
        assert_eq!(
            cli_argv_from(Some("bun:/repo/apps/cli/src/openroly.ts".to_string())),
            vec!["bun".to_string(), "/repo/apps/cli/src/openroly.ts".to_string()]
        );
    }

    #[test]
    fn empty_value_yields_no_argv() {
        assert!(cli_argv_from(Some(String::new())).is_empty());
    }
}
