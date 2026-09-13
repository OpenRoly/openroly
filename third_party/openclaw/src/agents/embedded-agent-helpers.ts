// **上流の写しではない。** `bootstrap-budget.ts` の `import type` を解決する為の最小 stub(PBI-0401)。
// 上流本体が読む field だけを持つ(`buildBootstrapInjectionStats` が `.path` / `.content` を見る)。
export type EmbeddedContextFile = {
  path?: string;
  content: string;
};
