import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiAdapter } from "../src/index.ts";

// Gemini CLI adapter(PBI-0061 / W9c)。generic MCP-config adapter の第 1 実例。
// 実 gemini には到達させない —— PATH 先頭の fake が受け取った argv を marker で観測する。
// argv は 2026-08-28 に実 CLI(0.46.0)を叩いて確かめた形を固定する。

let root = "";
let bin = "";
let marker = "";
let geminiHome = "";
let openrolyHome = "";

// PBI-0414 review が openrolyHome() に足したガード(OPENROLY_HOME 未設定 + bun test なら throw
// — 実 ~/.openroly への誤書き込みを防ぐ)を register() 経由(resolveMcpServerCommand)で踏むので、
// 専用の置き場を渡す(PBI-0419 AC-2。ガード自体は外さない)
const ctx = () => ({ env: { PATH: bin, HOME: root, GEMINI_CLI_HOME: geminiHome, OPENROLY_HOME: openrolyHome } });
const settingsPath = () => join(geminiHome, ".gemini", "settings.json");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-gemini-"));
  bin = join(root, "bin");
  marker = join(root, "argv.log");
  geminiHome = join(root, "gemini-home");
  openrolyHome = join(root, "openroly-home");
  await mkdir(bin, { recursive: true });
  await mkdir(join(geminiHome, ".gemini"), { recursive: true });
  await writeFile(marker, "");
  await writeFile(join(bin, "gemini"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 0\n`);
  await chmod(join(bin, "gemini"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const argvLines = async (): Promise<string[]> =>
  (await readFile(marker, "utf8")).split("\n").filter(Boolean);

describe("geminiAdapter (PBI-0061)", () => {
  test("AC-1: register の argv が実測形(-s user・`--` 無し・-e は name より前)", async () => {
    await geminiAdapter.register(ctx(), {
      serverEntry: "/repo/packages/mcp/src/server.ts",
      runtimeKind: "gemini",
      baseUrl: "http://localhost:8787",
      serverName: "openroly",
    });
    const lines = await argvLines();
    expect(lines[0]).toBe("mcp remove -s user openroly");
    // 実測: gemini mcp add [-s user] [-e K=V ...] <name> <commandOrUrl> [args...]
    // `--` を挟むと commandOrUrl が "--" になってしまう(claude / codex との違い)
    expect(lines[1]).toBe(
      "mcp add -s user -e OPENROLY_RUNTIME_KIND=gemini -e OPENROLY_URL=http://localhost:8787 openroly bun /repo/packages/mcp/src/server.ts",
    );
    expect(lines[1]).not.toContain(" -- ");
  });

  test("AC-1: project scope を使わない(cwd 依存と untrusted folder の罠を持ち込まない)", async () => {
    await geminiAdapter.unregister(ctx(), "openroly");
    const lines = await argvLines();
    expect(lines[0]).toBe("mcp remove -s user openroly");
    expect(lines[0]).not.toContain("project");
  });

  test("AC-2: GEMINI_CLI_HOME 配下の settings.json を読む(実 ~/.gemini を触らない)", async () => {
    await writeFile(settingsPath(), JSON.stringify({ mcpServers: { openroly: {}, unityMCP: {} } }));
    expect((await geminiAdapter.listExtensions(ctx())).map((e) => e.name).sort()).toEqual([
    "openroly",
      "unityMCP",
    ]);
    const [ok] = await geminiAdapter.doctor(ctx(), "openroly");
    expect(ok!.ok).toBe(true);
    expect(ok!.detail).toContain(settingsPath());
    expect(ok!.label).toBe("Gemini CLI MCP registration");
  });

  test("AC-2: 未登録なら doctor が install 案内を出す", async () => {
    await writeFile(settingsPath(), JSON.stringify({ mcpServers: {} }));
    const [ng] = await geminiAdapter.doctor(ctx(), "openroly");
    expect(ng!.ok).toBe(false);
    expect(ng!.detail).toContain("openroly install gemini");
  });

  test("detect: CLI が有れば version、無ければ install 案内", async () => {
    const found = await geminiAdapter.detect(ctx());
    expect(found.installed).toBe(true);
    expect(found.configPath).toBe(settingsPath());

    // OPENROLY_EXTRA_PATH_DIRS="" で補強を無効化(review 2026-08-28)— 空けたままだと PBI-0050 の
    // extraPathDirs が実 /usr/local/bin の gemini(この Mac に在る)へ届き、「実 gemini には
    // 到達させない」が self-defeating になり full suite の load 下で timeout していた
    const missing = await geminiAdapter.detect({
      env: { PATH: "/nonexistent", HOME: root, OPENROLY_EXTRA_PATH_DIRS: "" },
    });
    expect(missing).toEqual({
      installed: false,
      detail: "gemini CLI was not found (npm i -g @google/gemini-cli)",
    });
  });

  test("AC-X2: settings.json が無い / 壊れていても throw せず 0 件・ok:false", async () => {
    await rm(settingsPath(), { force: true });
    expect(await geminiAdapter.listExtensions(ctx())).toEqual([]);
    expect((await geminiAdapter.doctor(ctx(), "openroly"))[0]!.ok).toBe(false);
    await writeFile(settingsPath(), "{ broken");
    expect(await geminiAdapter.listExtensions(ctx())).toEqual([]);
  });

  test("contract: mcp と instructions(skill は claude / codex 固有なので持たない)", () => {
    expect(geminiAdapter.id).toBe("gemini");
    expect(geminiAdapter.displayName).toBe("Gemini CLI");
    // PBI-0214 で instructions(~/.gemini/GEMINI.md の管理ブロック)が加わった。skill は持たない
    expect(geminiAdapter.extensionKinds).toEqual(["mcp", "instructions"]);
  });
});
