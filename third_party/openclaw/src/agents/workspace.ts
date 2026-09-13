// **上流の写しではない。** `bootstrap-budget.ts` の `import type` を解決する為の最小 stub(PBI-0401)。
// 上流本体が読む field だけを持つ(`buildBootstrapInjectionStats` が
// `.path` / `.name` / `.missing` / `.content` を見る)。
export type WorkspaceBootstrapFile = {
  name?: string;
  path?: string;
  content?: string;
  missing: boolean;
};
