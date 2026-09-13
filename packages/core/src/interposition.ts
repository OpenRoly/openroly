// Runtime Interposition Capability(CAP-3 V16・PBI-0461・docs/direction/think.md §15 / §19)。
// **どこで止められるか**を runtime ごとに実測した表(`registry/evidence/interposition.v1.json`)の語彙と
// Level の規則だけを持つ。値は probe(`scripts/probes/interposition-probe.ts`)の実射でしか埋めない。

export const INTERPOSITION_CAPABILITIES = [
  "pre_action",
  "rewrite_action",
  "post_action",
  "inject_after_result",
  "post_batch",
  "pre_inference",
] as const;
export type InterpositionCapability = (typeof INTERPOSITION_CAPABILITIES)[number];
export type Measured = true | false | "unmeasured";

// A = hook で強制 / B = tool 境界の一部だけ / C = hook 無し(MCP で agent が自発的に呼ぶだけ) / D = observe-only。
export const INTERPOSITION_LEVELS = ["A", "B", "C", "D", "unmeasured"] as const;
export type InterpositionLevel = (typeof INTERPOSITION_LEVELS)[number];

/**
 * §19 の Level を capability の実測から決める。true / false でない列が 1 つでも在れば(unmeasured・欠けた列・崩れた JSON)A〜D を名乗らない。
 * pre_action の true は「deny で副作用が起きなかった」実測なので、それ自体が A の「強制」。
 * A でなくても hook で掴めた capability が 1 つでも在れば B(一部だけ保証)。C は 6 列とも false(hook では何も掴めない)の時だけ。
 * D は 6 列からは出ない(hook も MCP も無く記録を読むだけの runtime 用。今の 4 runtime には無い)。
 */
export function interpositionLevel(caps: Record<InterpositionCapability, Measured>): InterpositionLevel {
  const values: unknown[] = INTERPOSITION_CAPABILITIES.map((c) => caps[c]);
  if (values.some((v) => v !== true && v !== false)) return "unmeasured";
  if (caps.pre_action === true) return "A";
  if (values.includes(true)) return "B";
  return "C";
}
