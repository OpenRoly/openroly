// **上流の写しではない。** `bootstrap-budget.ts` の bare import
// (`@openclaw/normalization-core/string-coerce`)を解決する為の最小 stub(PBI-0401)。
// `analyzeBootstrapBudget` はこれを 1 度も呼ばない(呼ぶのは `buildBootstrapInjectionStats` と
// `resolveBootstrapWarningSignaturesSeen`)。写していない物を黙って別の実装で埋めない → throw。
export function normalizeOptionalString(_value: unknown): string | undefined {
  throw new Error(
    "third_party/openclaw: normalization-core/string-coerce は写していない(PBI-0401 が借りたのは analyzeBootstrapBudget だけ)",
  );
}
