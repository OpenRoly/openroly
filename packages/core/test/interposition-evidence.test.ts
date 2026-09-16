import { describe, expect, test } from "bun:test";
import rows from "../registry/evidence/interposition.v1.json";
import {
  INTERPOSITION_CAPABILITIES,
  INTERPOSITION_LEVELS,
  interpositionLevel,
  type InterpositionCapability,
  type Measured,
} from "../src/interposition.ts";

// PBI-0461: 実測表(scripts/probes/interposition-probe.ts が書く)の形と「文書の写しを true にしない」を守る。

const RUNTIMES = ["claude", "codex", "kimi"];

function evidenceViolations(table: any[]): string[] {
  const out: string[] = [];
  for (const r of table) {
    const at = `${r.runtime}`;
    if (!RUNTIMES.includes(r.runtime)) out.push(`${at}: runtime が 3 つの外`);
    if (!r.version || !r.measured_at) out.push(`${at}: version / measured_at が無い`);
    if (!INTERPOSITION_LEVELS.includes(r.level)) out.push(`${at}: level ${r.level} が値集合の外`);
    const keys = Object.keys(r.capabilities ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...INTERPOSITION_CAPABILITIES].sort())) out.push(`${at}: capability の列が 6 つと一致しない`);
    for (const c of INTERPOSITION_CAPABILITIES) {
      const v = r.capabilities?.[c];
      if (v !== true && v !== false && v !== "unmeasured") out.push(`${at}.${c}: 値 ${v} が true|false|"unmeasured" の外`);
      const e = r.evidence?.[c];
      if (!e?.how?.trim() || !e?.source_url?.trim()) out.push(`${at}.${c}: how / source_url が無い`);
      if (v === true && !e?.observed?.trim()) out.push(`${at}.${c}: true なのに observed が空(文書の写し)`);
    }
    if (r.level !== interpositionLevel(r.capabilities)) out.push(`${at}: level ${r.level} が規則の結果 ${interpositionLevel(r.capabilities)} と違う`);
    if (r.level === "unmeasured" && !r.unmeasured_reason) out.push(`${at}: unmeasured なのに unmeasured_reason が無い`);
  }
  return out;
}

const all = (v: Measured) => Object.fromEntries(INTERPOSITION_CAPABILITIES.map((c) => [c, v])) as Record<InterpositionCapability, Measured>;

describe("interposition.v1.json(実測表)", () => {
  test("AC-4: 3 runtime が 1 行ずつ在り、値集合・observed・level が全部守られている", () => {
    expect(rows.map((r) => r.runtime).sort()).toEqual(RUNTIMES);
    expect(evidenceViolations(rows)).toEqual([]);
  });

  test("AC-X1: observed が空の true 行は赤くなる", () => {
    const copied = structuredClone(rows[0]) as any;
    copied.capabilities.pre_action = true;
    copied.evidence.pre_action.observed = "";
    copied.level = interpositionLevel(copied.capabilities);
    expect(evidenceViolations([copied])).toContain(`${copied.runtime}.pre_action: true なのに observed が空(文書の写し)`);
  });
});

describe("interpositionLevel(§19)", () => {
  test("AC-X3: 1 つでも unmeasured なら A〜D を名乗らない", () => {
    expect(interpositionLevel({ ...all(true), post_batch: "unmeasured" })).toBe("unmeasured");
    expect(interpositionLevel({ ...all(false), pre_inference: "unmeasured" })).toBe("unmeasured");
  });

  test("pre_action → A / post_action だけ → B / 何も無い → C", () => {
    expect(interpositionLevel({ ...all(false), pre_action: true })).toBe("A");
    expect(interpositionLevel({ ...all(false), post_action: true })).toBe("B");
    expect(interpositionLevel(all(false))).toBe("C");
  });
});
