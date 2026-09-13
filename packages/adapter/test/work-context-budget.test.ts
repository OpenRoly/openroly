// PBI-0438: 索引 → 値の 2 段取得と、1 回の search で agent に渡す量の上限。
// resolveContextEntries は MCP と CLI が共用する 1 箇所なので、ここで並び・予算・index_only を固定する。
// value は本物の CAS(一時 OPENROLY_HOME)に書き、server の索引行の形で渡す。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_SEARCH_OMITTED_MAX,
  hashSourceFile,
  prepareContextValue,
  resolveContextEntries,
  type ContextIndexRow,
} from "../src/work-context.ts";

let home = "";
let cwd = "";
let env: Record<string, string | undefined> = {};

const row = async (key: string, value: unknown, scope?: string): Promise<ContextIndexRow> => {
  const p = await prepareContextValue(key, value, env);
  return {
    kind: "context",
    key,
    version: 1,
    value_hash: p.value_hash,
    size: p.size,
    run_id: null,
    runtime_id: null,
    actor: "user",
    updated_at: "2026-09-12T00:00:00.000Z",
    ...(scope ? { scope } : {}),
  };
};

const sourceRow = async (path: string, scope?: string): Promise<ContextIndexRow> => {
  const hashed = await hashSourceFile(cwd, path);
  return {
    kind: "source",
    key: path,
    version: 1,
    value_hash: hashed!.sha256,
    size: hashed!.size,
    run_id: null,
    runtime_id: null,
    actor: "user",
    updated_at: "2026-09-12T00:00:00.000Z",
    ...(scope ? { scope } : {}),
  };
};

const LONG_GOAL = "word ".repeat(800); // 4,000 字

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-0438-home-"));
  cwd = await mkdtemp(join(tmpdir(), "openroly-0438-repo-"));
  env = { OPENROLY_HOME: home };
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "docs/a.md"), "# a\n");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("1 段目: index_only", () => {
  test("AC-1: 値を返さず、各行に est_tokens と preview(≤80 字)。source は source_status 付き", async () => {
    const rows = [await row("auto/git", { branch: "main" }), await row("goal", LONG_GOAL), await row("next_step", "run it"), await sourceRow("docs/a.md")];
    const r = await resolveContextEntries(rows, { cwd, env, indexOnly: true, maxTokens: 20_000 });
    expect(r.entries.map((e) => e.key)).toEqual(["goal", "next_step", "docs/a.md", "auto/git"]);
    for (const e of r.entries) {
      expect("value" in e).toBe(false);
      expect(e.est_tokens).toBeGreaterThan(0);
    }
    const goal = r.entries[0]!;
    expect(goal.preview?.length).toBe(80);
    expect(goal.est_tokens).toBeGreaterThan(1_000);
    expect(r.entries[2]).toMatchObject({ kind: "source", source_status: "same" });
    expect(r.entries[3]?.preview).toBe('{"branch":"main"}');
    // 4,000 字の値は preview の 80 字を超えては出ない
    expect(JSON.stringify(r)).not.toContain("word ".repeat(20));
  });
});

describe("上限 max_tokens", () => {
  test("AC-2: 既定 2,000。約 600 token × 10 行 → 合計 ≤ 2,000・値は全文・外れた行は名前と est_tokens", async () => {
    const value = (i: number) => `lorem${i} `.repeat(460);
    const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => row(`k${i}`, value(i))));
    const r = await resolveContextEntries(rows, { cwd, env });
    expect(r.budget.max_tokens).toBe(2_000);
    expect(r.budget.used_tokens).toBeLessThanOrEqual(2_000);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.length).toBeLessThan(10);
    for (const e of r.entries) expect(e.value).toBe(value(Number(e.key.slice(1))));
    expect(r.budget.omitted_count).toBe(10 - r.entries.length);
    expect([...r.entries.map((e) => e.key), ...r.budget.omitted.map((o) => o.key)]).toEqual(rows.map((x) => x.key));
    for (const o of r.budget.omitted) expect(o.est_tokens).toBeGreaterThan(500);
    expect(r.budget.hint).toContain("left out whole");
  });

  test("AC-3: 並びは work → project、同じ scope の中は 決まった key(定数の順)→ 自由 key → source → auto/ → inbox/", async () => {
    // server の並び(work 先 · kind · key の字順)で渡す
    const rows = [
      await row("auto/tests", [], "work"),
      await row("decisions", "d", "work"),
      await row("goal", "task goal", "work"),
      await row("next_step", "n", "work"),
      await row("zeta", "z", "work"),
      await row("auto/git", {}, "project"),
      await row("goal", "project goal", "project"),
      await row("inbox/wrk_x/1", "hi", "project"),
      await row("zeta", "z", "project"),
      await sourceRow("docs/a.md", "project"),
    ];
    const r = await resolveContextEntries(rows, { cwd, env });
    expect(r.entries.map((e) => `${e.scope}:${e.key}`)).toEqual([
      "work:goal",
      "work:next_step",
      "work:decisions",
      "work:zeta",
      "work:auto/tests",
      "project:goal",
      "project:zeta",
      "project:docs/a.md",
      "project:auto/git",
      "project:inbox/wrk_x/1",
    ]);
  });

  test("AC-4: 2 段目 —— keys で選んだ 1 行を max_tokens を上げて全文で取る", async () => {
    const r = await resolveContextEntries([await row("goal", LONG_GOAL)], { cwd, env, maxTokens: 5_000 });
    expect(r.entries.map((e) => e.value)).toEqual([LONG_GOAL]);
    expect(r.budget.omitted_count).toBe(0);
    expect(r.budget.hint).toBeUndefined();
  });

  test("AC-X1: max_tokens が 0・負・小数・20,000 超 → 値を 1 行も読む前に invalid_max_tokens", async () => {
    // kind を読んだ瞬間に throw する行: 検査が行の読み取りより前でなければ別の message になる
    const trap = {
      get kind(): string {
        throw new Error("row was read");
      },
    } as unknown as ContextIndexRow;
    for (const maxTokens of [0, -1, 1.5, 20_001, Number.NaN]) {
      const err = await resolveContextEntries([trap], { cwd, env, maxTokens }).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect({ maxTokens, err: err?.split(":")[0] }).toEqual({ maxTokens, err: "invalid_max_tokens" });
    }
  });

  test("AC-X2: 1 行が上限より大きい → 切り詰めて返さず、外して est_tokens と hint を残す", async () => {
    const r = await resolveContextEntries([await row("goal", LONG_GOAL)], { cwd, env, maxTokens: 100 });
    expect(r.entries).toEqual([]);
    expect(r.budget.omitted).toEqual([{ kind: "context", key: "goal", est_tokens: expect.any(Number) }]);
    expect(r.budget.omitted[0]!.est_tokens).toBeGreaterThan(100);
    expect(r.budget.hint).toContain("keys");
    expect(r.budget.hint).toContain("max_tokens");
    expect(JSON.stringify(r)).not.toContain("word word");
  });

  test("AC-X3: 外れた行が 120 個でも receipt の名前は 50 件まで・omitted_count は 120", async () => {
    const rows = await Promise.all(Array.from({ length: 120 }, (_, i) => row(`many-${i}`, "x ".repeat(50))));
    const r = await resolveContextEntries(rows, { cwd, env, maxTokens: 1 });
    expect(r.entries).toEqual([]);
    expect(r.budget.omitted_count).toBe(120);
    expect(r.budget.omitted).toHaveLength(CONTEXT_SEARCH_OMITTED_MAX);
  });
});
