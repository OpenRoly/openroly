import { describe, expect, test } from "bun:test";
import { adoptLegacyEnv, legacyDir, LEGACY_STATE_DIR, STATE_DIR } from "../src/env.ts";

// PBI-0344 AC-3: 「旧 env / 旧 dir を読める」は release note ではなく test で保証する。
// 新名が在る時は常に新名が勝つ(AC-3 の 所属の規律)。

describe("adoptLegacyEnv(PBI-0344 AC-3・env の互換)", () => {
  test("新名が無い key だけ旧名を採用し、1 行の警告を出す", () => {
    const env: Record<string, string | undefined> = {
      PAA_HOME: "/legacy",
      PAA_DATABASE_URL: "postgres://x",
      OPENROLY_DATABASE_URL: "postgres://new",
      UNRELATED: "1",
    };
    const lines: string[] = [];
    const adopted = adoptLegacyEnv(env, (l) => lines.push(l));
    expect(env.OPENROLY_HOME).toBe("/legacy");
    expect(env.OPENROLY_DATABASE_URL).toBe("postgres://new"); // 新名が在れば新名が勝つ(上書きしない)
    expect(adopted).toEqual(["PAA_HOME"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PAA_HOME");
  });

  test("旧名が無ければ何も採用せず警告も出さない", () => {
    const env: Record<string, string | undefined> = { OPENROLY_HOME: "/fresh" };
    const lines: string[] = [];
    expect(adoptLegacyEnv(env, (l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual([]);
    expect(env.PAA_HOME).toBeUndefined();
  });

  test("process.env 既定でも落ちない(実環境に PAA_* が混ざっていても構わない)", () => {
    expect(adoptLegacyEnv({})).toEqual([]);
  });
});

describe("legacyDir(PBI-0344 AC-3・state dir の互換)", () => {
  const home = "/h";
  const fresh = `${home}/${STATE_DIR}`;
  const legacy = `${home}/${LEGACY_STATE_DIR}`;

  test("旧 dir だけが在る端末ではそれを引き継ぎ、1 行警告", () => {
    const lines: string[] = [];
    expect(legacyDir(fresh, legacy, (p) => p === legacy, (l) => lines.push(l))).toBe(legacy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(legacy);
  });

  test("新 dir が在れば新 dir(旧が有っても新が勝つ)。どちらも無ければ新 dir", () => {
    expect(legacyDir(fresh, legacy, () => true, () => {})).toBe(fresh);
    expect(legacyDir(fresh, legacy, () => false, () => {})).toBe(fresh);
  });
});
