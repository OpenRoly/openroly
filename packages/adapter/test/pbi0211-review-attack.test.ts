import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catalog from "@openroly/core/registry/detectors.v1.json" with { type: "json" };
import { importShellProfiles, loadProfiles, profilesPath, variantClasses } from "../src/profiles.ts";

// PBI-0211 module review(runtime-catalog)の攻撃: import が鍵を profiles.json に落とす経路と、class 判定の host 取り違え。
// 鍵は fake 値だけ。

const FAKE_KEY = "fake-header-key-review-attack-4be0";
const CLASSES = variantClasses(catalog.detectors as unknown[]);

const roots: string[] = [];
async function freshEnv(): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "openroly-profiles-attack-"));
  roots.push(root);
  return { OPENROLY_HOME: join(root, ".openroly") };
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const wrapper = (assigns: string) => `claude-x() {\n  ${assigns} command claude "$@"\n}\n`;

describe("PBI-0211 review attack: profiles import", () => {
  // Claude Code の gateway 認証は ANTHROPIC_CUSTOM_HEADERS でも渡せる(名前に KEY / TOKEN を含まない)
  test("ANTHROPIC_CUSTOM_HEADERS に入った鍵は profiles.json にも結果にも出ない", async () => {
    const env = await freshEnv();
    const result = await importShellProfiles(
      wrapper(`ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" ANTHROPIC_CUSTOM_HEADERS="Authorization: Bearer ${FAKE_KEY}"`),
      CLASSES,
      env,
    );
    expect(result.imported).toEqual([{ name: "claude-x", class: "claude-zai" }]);
    expect((await readFile(profilesPath(env), "utf8")).includes(FAKE_KEY)).toBe(false);
    expect(JSON.stringify(result).includes(FAKE_KEY)).toBe(false);
    expect(result.dropped).toEqual([{ name: "claude-x", vars: ["ANTHROPIC_CUSTOM_HEADERS"] }]);
    // header の var に Connections の鍵を生で差さない(参照にもしない)
    expect((await loadProfiles(env)).profiles["claude-zai"]!.secret_env).toEqual({});
  });

  test("鍵入りの userinfo を持つ base URL は保存しない(class が決まっても URL ごと採らない)", async () => {
    const env = await freshEnv();
    const result = await importShellProfiles(wrapper(`ANTHROPIC_BASE_URL="https://u:${FAKE_KEY}@api.z.ai/api/anthropic"`), CLASSES, env);
    expect(JSON.stringify(result).includes(FAKE_KEY)).toBe(false);
    const text = await readFile(profilesPath(env), "utf8").catch(() => "");
    expect(text.includes(FAKE_KEY)).toBe(false);
  });

  for (const url of ["https://api.z.ai.evil.example/api", "https://api.z.ai@evil.example/api", "https://evil.example/?h=api.z.ai"]) {
    test(`class の host に似せた ${url} は class に当たらない`, async () => {
      const env = await freshEnv();
      const result = await importShellProfiles(wrapper(`ANTHROPIC_BASE_URL="${url}"`), CLASSES, env);
      expect(result.imported).toEqual([]);
    });
  }
});
