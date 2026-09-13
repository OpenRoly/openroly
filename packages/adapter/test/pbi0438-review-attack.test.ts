// PBI-0438 有界レビューの攻撃 test。急所: 上限の境界(ちょうど / 1 超え)と receipt の形。
// PBI-0439(work_accept の render)は「index_only + 既定 2,000」と receipt の est_tokens を
// そのまま使う —— 1 段目の est_tokens が 2 段目の cost と一致する事が契約(AT-3)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_SEARCH_DEFAULT_MAX_TOKENS,
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

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-0438-atk-home-"));
  cwd = await mkdtemp(join(tmpdir(), "openroly-0438-atk-repo-"));
  env = { OPENROLY_HOME: home };
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "docs/a.md"), "# a\n");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("PBI-0438 review 攻撃", () => {
  test("AT-1: used + cost == max_tokens ちょうどで入り、1 超えで優先順が最後の 1 行だけ外れる", async () => {
    const rows = [
      await row("goal", "one ".repeat(40)),
      await row("next_step", "two ".repeat(30)),
      await row("zeta", "three ".repeat(20)),
    ];
    // 1 段目で実測した est_tokens がそのまま 2 段目の判定 cost になる(<= が < だとちょうどで外れる)
    const idx = await resolveContextEntries(rows, { cwd, env, indexOnly: true, maxTokens: 20_000 });
    const est = idx.entries.map((e) => e.est_tokens!);
    const total = est.reduce((a, b) => a + b, 0);
    const exact = await resolveContextEntries(rows, { cwd, env, maxTokens: total });
    expect(exact.entries.map((e) => e.key)).toEqual(["goal", "next_step", "zeta"]);
    expect(exact.budget.used_tokens).toBe(total);
    expect(exact.budget.omitted_count).toBe(0);
    expect(exact.budget.hint).toBeUndefined();
    // 1 超え: 末尾の行だけ外れ、前の行は入ったまま(詰め直しをしない)
    const oneOver = await resolveContextEntries(rows, { cwd, env, maxTokens: total - 1 });
    expect(oneOver.entries.map((e) => e.key)).toEqual(["goal", "next_step"]);
    expect(oneOver.budget.omitted).toEqual([{ kind: "context", key: "zeta", est_tokens: est[2] }]);
    expect(oneOver.budget.used_tokens).toBe(est[0]! + est[1]!);
  });

  test("AT-2: 外した行の receipt は kind / key / scope / est_tokens だけ。project も値の断片も失われない", async () => {
    const secret = `SECRET-FRAGMENT-${"x".repeat(300)}`;
    const rows = [await row("goal", "small"), await row("blob", secret, "project")];
    const idx = await resolveContextEntries(rows, { cwd, env, indexOnly: true, maxTokens: 20_000 });
    const estGoal = idx.entries[0]!.est_tokens!;
    const estBlob = idx.entries[1]!.est_tokens!;
    const r = await resolveContextEntries(rows, { cwd, env, maxTokens: estGoal });
    expect(r.entries.map((e) => e.key)).toEqual(["goal"]);
    expect(r.budget.omitted).toEqual([{ kind: "context", key: "blob", scope: "project", est_tokens: estBlob }]);
    expect(Object.keys(r.budget.omitted[0]!).sort()).toEqual(["est_tokens", "key", "kind", "scope"]);
    expect(JSON.stringify(r)).not.toContain("SECRET-FRAGMENT");
  });

  test("AT-3: index_only の行は渡る形(preview 付き)の大きさで予算に入り、est_tokens の合計は 2 段目の used_tokens と一致する", async () => {
    const value = (i: number) => `filler${i} `.repeat(460); // 値は約 600 tokens
    const rows = await Promise.all(Array.from({ length: 6 }, (_, i) => row(`k${i}`, value(i))));
    const idx = await resolveContextEntries(rows, { cwd, env, indexOnly: true }); // 既定のまま
    expect(idx.budget.max_tokens).toBe(CONTEXT_SEARCH_DEFAULT_MAX_TOKENS);
    expect(idx.entries).toHaveLength(6); // 値ではなく preview の大きさで判定するので 6 行全部入る
    expect(idx.entries.every((e) => !("value" in e))).toBe(true);
    // 行数が増えれば index_only も既定 2,000 で切れる(無制限ではない)
    const many = await Promise.all(Array.from({ length: 120 }, (_, i) => row(`m${i}`, value(i % 6))));
    const idxMany = await resolveContextEntries(many, { cwd, env, indexOnly: true });
    expect(idxMany.budget.max_tokens).toBe(CONTEXT_SEARCH_DEFAULT_MAX_TOKENS);
    expect(idxMany.budget.omitted_count).toBeGreaterThan(0);
    expect(idxMany.budget.used_tokens).toBeLessThanOrEqual(CONTEXT_SEARCH_DEFAULT_MAX_TOKENS);
    // 0439 は receipt から 2 段目の予算を組む: est_tokens(値の cost)の合計 == 全行を値で取った時の used_tokens
    const all = await resolveContextEntries(rows, { cwd, env, maxTokens: 20_000 });
    const estSum = [...idx.entries.map((e) => e.est_tokens!)].reduce((a, b) => a + b, 0);
    expect(estSum).toBe(all.budget.used_tokens);
  });

  test("AT-4: 並びは入力順に依存しない。定数の後半(open_questions 以降)も定数順", async () => {
    const wanted = [
      "work:goal",
      "work:next_step",
      "work:decisions",
      "work:open_questions",
      "work:failed_attempts",
      "work:verified_findings",
      "work:zeta",
      "work:auto/tests",
      "project:goal",
      "project:zeta",
      "project:docs/a.md",
      "project:auto/git",
      "project:inbox/wrk_x/1",
    ];
    const rows = [
      await row("inbox/wrk_x/1", "hi", "project"),
      await row("auto/git", {}, "project"),
      await sourceRow("docs/a.md", "project"),
      await row("zeta", "z", "project"),
      await row("goal", "project goal", "project"),
      await row("auto/tests", [], "work"),
      await row("zeta", "z", "work"),
      await row("verified_findings", "vf", "work"),
      await row("failed_attempts", "fa", "work"),
      await row("open_questions", "oq", "work"),
      await row("decisions", "de", "work"),
      await row("next_step", "n", "work"),
      await row("goal", "task goal", "work"),
    ]; // 優先順の完全な逆順で渡す
    const r = await resolveContextEntries(rows, { cwd, env, maxTokens: 20_000 });
    expect(r.entries.map((e) => `${e.scope}:${e.key}`)).toEqual(wanted);
  });
});
