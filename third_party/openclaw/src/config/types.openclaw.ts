// **上流の写しではない。** `bootstrap-budget.ts` の `import type` を解決する為の最小 stub(PBI-0401)。
// 上流の設定 schema は数千行あり、我々は上限を引数で渡すので 1 field も読まない。
export type OpenClawConfig = {
  agents?: {
    defaults?: { bootstrapMaxChars?: number; bootstrapTotalMaxChars?: number };
  };
};
