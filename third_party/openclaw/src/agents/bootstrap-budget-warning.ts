// **上流の写しではない。** `bootstrap-budget.ts` を**改変せずに**動かす為の最小 stub(PBI-0401)。
// この repo が上流から呼ぶのは `analyzeBootstrapBudget` の 1 本だけで、ここの 2 本はその経路に
// 入らない —— だが ESM は module 全体を評価するので、import が解決しないと上流 file を読めない。
// 「使わない」を黙って no-op にすると、いつか誰かが呼んだ時に**上流と違う答えが静かに返る**ので
// **呼ばれたら throw する**(上流本体が要る日は、その日に本物を取り寄せる)。
import type {
  BootstrapBudgetAnalysis,
  BootstrapPromptWarning,
  BootstrapPromptWarningMode,
} from "./bootstrap-budget.types.js";

const NOT_VENDORED =
  "third_party/openclaw: bootstrap-budget-warning.ts は写していない(PBI-0401 が借りたのは analyzeBootstrapBudget だけ)";

export function normalizeBootstrapWarningSignatures(_signatures?: string[]): string[] {
  throw new Error(NOT_VENDORED);
}

export function buildBootstrapPromptWarning(_params: {
  analysis: BootstrapBudgetAnalysis;
  mode: BootstrapPromptWarningMode;
  previousSignature?: string;
  seenSignatures?: string[];
  maxFiles?: number;
}): BootstrapPromptWarning {
  throw new Error(NOT_VENDORED);
}
