// PBI-0775 / CAP-3: auto/git の dirty が生成物の file 名で context package の予算を食う件(dogfood F94)。
// 実測 2026-09-19: dirty 50 件のうち 47 件が同じ checkpoints/ folder で、2000 token 中およそ 1050 を
// 使い、auto/tests(125) を丸ごと押し出した。ここで測るのは **畳んだ後の形と大きさ**。
import { describe, expect, test } from "bun:test";
import { AUTO_DIRTY_DIR_COLLAPSE, AUTO_DIRTY_MAX, foldDirtyPaths } from "../src/auto-context.ts";

/** 実測と同じ形: 1 つの folder に生成物が N 件 + 手で触った file が 2 件 */
const realShape = (n: number): string[] => [
  "apps/cli/src/openroly.ts",
  "packages/mcp/src/auto-context.ts",
  ...Array.from({ length: n }, (_, i) => `shibubu.capsule/works/wrk_x/checkpoints/${i}.json`),
];

describe("PBI-0775 dirty の畳み", () => {
  test("AC-1: 同じ folder が閾値を超えたら 1 行・手で触った 2 件はそのまま・dirty_total は別の欄が持つ", () => {
    const folded = foldDirtyPaths(realShape(60));
    expect(folded).toContain("shibubu.capsule/works/wrk_x/checkpoints/ (60 files)");
    expect(folded).toContain("apps/cli/src/openroly.ts");
    expect(folded).toContain("packages/mcp/src/auto-context.ts");
    expect(folded).toHaveLength(3);
    // 畳んだ物は 1 行 —— 個別の checkpoint path は 1 つも残らない
    expect(folded.some((p) => p.endsWith(".json"))).toBe(false);
  });

  test("AC-2: 大きさが桁で落ちる(同じ tree で 1/10 以下)", () => {
    const raw = realShape(60);
    const before = JSON.stringify(raw.slice(0, AUTO_DIRTY_MAX)).length; // 今までの形
    const after = JSON.stringify(foldDirtyPaths(raw)).length;
    expect(after * 10).toBeLessThan(before);
  });

  test("AC-3: 閾値以下の folder は path のまま(畳んで情報を失わない)", () => {
    const few = Array.from({ length: AUTO_DIRTY_DIR_COLLAPSE }, (_, i) => `docs/a${i}.md`);
    expect(foldDirtyPaths(few).sort()).toEqual(few.sort());
  });

  test("AC-4: 件数の上限は畳んだ後に効く(別々の folder が 60 なら 50 行)", () => {
    const spread = Array.from({ length: 60 }, (_, i) => `d${i}/only.ts`);
    expect(foldDirtyPaths(spread)).toHaveLength(AUTO_DIRTY_MAX);
  });

  test("root 直下の file は folder を持たないので畳まない", () => {
    const roots = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
    expect(foldDirtyPaths(roots)).toHaveLength(10);
  });
});
