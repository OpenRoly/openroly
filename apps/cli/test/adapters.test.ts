import { describe, expect, test } from "bun:test";
import { API_PROVIDERS } from "@openroly/core";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTERS, findAdapter, SUPPORTED_IDS } from "../src/registry.ts";
import { ADAPTER_OPS } from "@openroly/adapter";

// AC-14 / AC-15 / AC-16: Extension Adapter Contract(配布戦略 §8)の conformance。
// community adapter が増えてもこの検査に通ることを条件にする。

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe("runtime adapter contract", () => {
  test("official adapter が contract op を全て備える", () => {
    for (const adapter of ADAPTERS) {
      for (const op of ADAPTER_OPS) {
        expect(adapter[op as keyof typeof adapter]).toBeDefined();
      }
      expect(typeof adapter.id).toBe("string");
      expect(typeof adapter.displayName).toBe("string");
      for (const fn of ["detect", "register", "unregister", "doctor"] as const) {
        expect(typeof adapter[fn]).toBe("function");
      }
    }
  });

  test("Stage 0 では wake 系 capability を宣言しない(Device Broker 不在)", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.capabilities).toMatchObject({
        pair: true,
        status: true,
        notify: false,
        wake: false,
        createSession: false,
        sendInstruction: false,
      });
    }
  });

  test("id は一意で、未対応 runtime は解決できない", () => {
    expect(new Set(SUPPORTED_IDS).size).toBe(SUPPORTED_IDS.length);
    // 外部 API provider(PBI-0070 / EP-0009 C)は factory 1 つから 3 つ載る。実体は `openroly agent`
    // PBI-0061 / W9c: gemini が 3 つ目の official CLI adapter(generic MCP-config の第 1 実例)
    // PBI-0210 AC-7: `<id>-api` は core の provider 表から導出(cli / api adapter / server / web で 1 つ)。
    // bundled catalog の generic entry(`adapter: "generic/native"` + `native`)はその後ろに並ぶ
    const apiIds = API_PROVIDERS.map((p) => `${p.id}-api`);
    expect(SUPPORTED_IDS.slice(0, 3 + apiIds.length)).toEqual(["claude", "codex", "gemini", ...apiIds]);
    expect(apiIds).toContain("openrouter-api");
    expect(apiIds).toContain("ollama-local-api");
    expect(findAdapter("CLAUDE")?.id).toBe("claude");
    // catalog に載っている generic entry は TS を 1 行も書かずに解決する(PBI-0210 の主張そのもの)
    expect(findAdapter("hermes")?.id).toBe("hermes");
    expect(findAdapter("kiro")?.id).toBe("kiro");
    // catalog にも official にも無い id は解決しない。**例を名前で書かない**(PBI-0296) ——
    // 検知のみの entry は catalog の引き直しでいつでも昇格する側なので、名指しした瞬間から
    // 「昇格したら赤くなるが、赤の理由はこの test が測りたい性質と無関係」になる
    const detectors = (
      JSON.parse(readFileSync(repo("packages/core/registry/detectors.v1.json"), "utf8")) as {
        detectors: { id: string }[];
      }
    ).detectors.map((d) => d.id);
    const detectOnly = detectors.find((id) => !SUPPORTED_IDS.includes(id));
    // 例が 1 つも無い(= 全 entry が adapter を持った)なら、この行は何も測っていない
    expect(detectOnly).toBeTruthy();
    expect(findAdapter(detectOnly!)).toBeUndefined();
    expect(findAdapter("no-such-runtime")).toBeUndefined();
  });
});

describe("plugin 配布物(配布戦略 §7.1 plugin-first)", () => {
  test("plugin manifest と .mcp.json が妥当で、起動 file が実在する", async () => {
    const dir = "adapters/official/claude";
    const plugin = JSON.parse(await readFile(repo(`${dir}/.claude-plugin/plugin.json`), "utf8"));
    expect(plugin.name).toBe("openroly");
    expect(typeof plugin.description).toBe("string");

    const mcp = JSON.parse(await readFile(repo(`${dir}/.mcp.json`), "utf8"));
    const server = mcp.mcpServers.openroly;
    // PBI-0132: command は launcher(sh)。args は bun fallback 経路の材料として bundle のまま
    expect(server.command).toBe("${CLAUDE_PLUGIN_ROOT}/openroly-mcp");
    expect(server.args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(server.env.OPENROLY_RUNTIME_KIND).toBe("claude");

    const launcher = await stat(server.command.replace("${CLAUDE_PLUGIN_ROOT}", repo(dir)));
    expect(launcher.isFile()).toBe(true);
    expect(launcher.mode & 0o111).toBeGreaterThan(0); // 実行権が無いと runtime は起動できない

    const entry = server.args[0].replace("${CLAUDE_PLUGIN_ROOT}", repo(dir));
    expect((await stat(entry)).isFile()).toBe(true);
  });

  test("marketplace が plugin の実在する source を指す", async () => {
    const marketplace = JSON.parse(await readFile(repo(".claude-plugin/marketplace.json"), "utf8"));
    expect(marketplace.name).toBe("openroly");
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const entry of marketplace.plugins) {
      const manifest = repo(`${entry.source}/.claude-plugin/plugin.json`.replace("./", ""));
      expect((await stat(manifest)).isFile()).toBe(true);
    }
  });
});
