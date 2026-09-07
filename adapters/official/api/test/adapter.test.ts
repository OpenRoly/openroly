import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PROVIDERS, apiProviderKind } from "@openroly/core";
import { apiAdapters, apiProviderAdapter } from "../src/index.ts";

// PBI-0070 / EP-0009 C: API provider の adapter は **native の設定を 1 つも書かない**。
// register/unregister が何かを書き始めたら、この runtime の設計(実体は openroly agent)が壊れている。

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).length;
}

describe("API provider adapter (PBI-0070 AC-5)", () => {
  test("provider は factory 1 つから作られ、id は <provider>-api(PBI-0298: 表から導出する)", () => {
    expect(apiAdapters.map((a) => a.id)).toEqual(API_PROVIDERS.map((p) => apiProviderKind(p.id)));
    expect(apiAdapters.map((a) => a.displayName)).toEqual(API_PROVIDERS.map((p) => `${p.label} (API)`));
    // 表が空になった / adapter を手書きで足したら気づけること(件数の下限だけは固定する)
    expect(apiAdapters.length).toBe(API_PROVIDERS.length);
    expect(apiAdapters.length).toBeGreaterThan(2);
    for (const a of apiAdapters) expect(a.id).toMatch(/-api$/);
  });

  test("detect は常に installed(端末に binary を持たない)", async () => {
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const result = await adapter.detect({ env: { HOME: "/nonexistent" } });
    expect(result.installed).toBe(true);
  });

  test("register / unregister はファイルを 1 つも書かない", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-api-adapter-"));
    const ctx = { env: { HOME: home } };
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const before = await countFiles(home);
    await adapter.register(ctx, {
      serverEntry: "/x/mcp-server.ts",
      runtimeKind: "openai-api",
      baseUrl: "http://localhost:8787",
      serverName: "openroly",
    });
    await adapter.unregister(ctx, "openroly");
    expect(await countFiles(home)).toBe(before);
    expect(await adapter.listExtensions(ctx)).toEqual([]);
    expect(adapter.extensionKinds).toEqual([]);
  });

  test("doctor は credential の有無を返す(未接続 → ok:false)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-api-doctor-"));
    const adapter = apiProviderAdapter("openai", "OpenAI (API)");
    const missing = await adapter.doctor({ env: { HOME: home, OPENROLY_HOME: join(home, ".openroly") } }, "openroly");
    expect(missing[0]!.ok).toBe(false);

    await mkdir(join(home, ".openroly"), { recursive: true });
    await writeFile(
      join(home, ".openroly", "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          "openai-api": { runtime_id: "rt_1", token: "par_x", base_url: "http://localhost:8787", name: "OpenAI (API)" },
        },
      }),
    );
    const found = await adapter.doctor({ env: { HOME: home, OPENROLY_HOME: join(home, ".openroly") } }, "openroly");
    expect(found[0]!.ok).toBe(true);
  });
});
