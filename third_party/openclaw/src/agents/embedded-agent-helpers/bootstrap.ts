// **上流の写しではない。** `bootstrap-budget.ts` の import を解決する為の最小 stub(PBI-0401)。
// 例外は `USER_BOOTSTRAP_MAX_CHARS` —— これは `effectiveBootstrapFileLimit` が実際に読むので
// **上流の実値をそのまま置く**(src/agents/embedded-agent-helpers/bootstrap.ts:93 の
// `export const USER_BOOTSTRAP_MAX_CHARS = 4_000;`)。ここが嘘だと等価検査が嘘になる。
// resolve* の 2 本は OpenClawConfig を読む係で、我々は上限を引数で渡すので通らない → throw。
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** 上流の実値(取得日 2026-09-09・commit d972ecf3ddabad80d53599dfc501db12552cc3ca) */
export const USER_BOOTSTRAP_MAX_CHARS = 4_000;

const NOT_VENDORED =
  "third_party/openclaw: embedded-agent-helpers/bootstrap.ts の config 解決は写していない(上限は引数で渡す)";

export function resolveBootstrapMaxChars(_cfg?: OpenClawConfig, _agentId?: string | null): number {
  throw new Error(NOT_VENDORED);
}

export function resolveBootstrapTotalMaxChars(
  _cfg?: OpenClawConfig,
  _agentId?: string | null,
): number {
  throw new Error(NOT_VENDORED);
}
