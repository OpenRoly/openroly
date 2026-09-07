import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../src/contract.ts";
import { createMcpConfigAdapter } from "../src/mcp-config.ts";

// generic MCP-config adapter(PBI-0060 / W9b)。実 CLI には到達させず、PATH 先頭に置いた
// fake が受け取った argv を marker file で観測する(EP-0001 LEARN 13 / adopt.test.ts と同じ手)。

let root = "";
let bin = "";
let marker = "";
let configFile = "";

/** fake CLI: 受け取った argv を marker に 1 行追記して exit `code` */
async function installFakeCli(name: string, code = 0): Promise<void> {
  await writeFile(join(bin, name), `#!/bin/sh\necho "$@" >> ${marker}\nexit ${code}\n`);
  await chmod(join(bin, name), 0o755);
}

// OPENROLY_HOME を隔離する: resolveMcpServerCommand(PBI-0132)が dev 機の ~/.openroly/bin/openroly-mcp を
// 拾うと、この test の期待(`-- bun /repo/mcp.ts`)が機械ごとに揺れる
const ctx = (): AdapterContext => ({ env: { PATH: bin, HOME: root, OPENROLY_HOME: join(root, ".openroly") } });

const jsonSpec = () => ({
  id: "fakejson",
  displayName: "Fake JSON CLI",
  bin: "fakejson",
  installHint: "fakejson が見つかりません (test)",
  configPath: () => configFile,
  format: "json" as const,
  serversKey: "mcpServers",
  addArgs: ({ name, env, command, args }: any) => [
    "mcp", "add", "-s", "user", name,
    ...env.flatMap(([k, v]: [string, string]) => ["-e", `${k}=${v}`]),
    "--", command, ...args,
  ],
  removeArgs: (name: string) => ["mcp", "remove", "-s", "user", name],
});

const tomlSpec = () => ({
  ...jsonSpec(),
  id: "faketoml",
  displayName: "Fake TOML CLI",
  bin: "faketoml",
  format: "toml" as const,
  serversKey: "mcp_servers",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-mcpcfg-"));
  bin = join(root, "bin");
  marker = join(root, "argv.log");
  configFile = join(root, "config");
  await mkdir(bin, { recursive: true });
  await writeFile(marker, "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const argvLines = async (): Promise<string[]> =>
  (await readFile(marker, "utf8")).split("\n").filter(Boolean);

describe("createMcpConfigAdapter — argv の組み立て (PBI-0060 AC-1)", () => {
  test("register は remove → add の順に spec どおりの argv を渡す", async () => {
    await installFakeCli("fakejson");
    const a = createMcpConfigAdapter(jsonSpec());
    await a.register(ctx(), {
      serverEntry: "/repo/mcp.ts",
      runtimeKind: "fakejson",
      baseUrl: "http://localhost:8787",
      serverName: "openroly",
    });
    const lines = await argvLines();
    expect(lines[0]).toBe("mcp remove -s user openroly");
    expect(lines[1]).toBe(
      "mcp add -s user openroly -e OPENROLY_RUNTIME_KIND=fakejson -e OPENROLY_URL=http://localhost:8787 -- bun /repo/mcp.ts",
    );
  });

  test("add が非 0 で終われば Error を投げる(失敗を握り潰さない)", async () => {
    await installFakeCli("fakejson", 3);
    const a = createMcpConfigAdapter(jsonSpec());
    await expect(
      a.register(ctx(), { serverEntry: "/x", runtimeKind: "k", baseUrl: "http://h", serverName: "openroly" }),
    ).rejects.toThrow(/fakejson mcp add failed/);
  });

  test("unregister は remove の失敗をそのまま Error にする", async () => {
    await installFakeCli("fakejson", 1);
    const a = createMcpConfigAdapter(jsonSpec());
    await expect(a.unregister(ctx(), "openroly")).rejects.toThrow(/fakejson mcp remove failed/);
  });

  test("detect は CLI の有無を返す(見つからなければ installHint)", async () => {
    const a = createMcpConfigAdapter(jsonSpec());
    expect(await a.detect(ctx())).toEqual({
      installed: false,
      detail: "fakejson が見つかりません (test)",
    });
    await installFakeCli("fakejson");
    const found = await a.detect(ctx());
    expect(found.installed).toBe(true);
    expect(found.configPath).toBe(configFile);
  });
});

describe("createMcpConfigAdapter — config の読み (PBI-0060 AC-2 / AC-3)", () => {
  test("AC-2: JSON config の serversKey から一覧と doctor を返す", async () => {
    await writeFile(configFile, JSON.stringify({ mcpServers: { openroly: {}, other: {} } }));
    const a = createMcpConfigAdapter(jsonSpec());
    expect((await a.listExtensions(ctx())).map((e) => e.name).sort()).toEqual(["openroly", "other"]);
    const [ok] = await a.doctor(ctx(), "openroly");
    expect(ok).toMatchObject({ ok: true, label: "Fake JSON CLI MCP registration" });
    expect(ok!.detail).toContain(configFile);
    const [ng] = await a.doctor(ctx(), "missing");
    expect(ng!.ok).toBe(false);
    expect(ng!.detail).toContain("openroly install fakejson");
  });

  test("AC-3: TOML config でも同じ結果(形式の違いが呼び出し側に漏れない)", async () => {
    await writeFile(configFile, '[mcp_servers.openroly]\ncommand = "bun"\n[mcp_servers.other]\ncommand = "x"\n');
    const a = createMcpConfigAdapter(tomlSpec());
    expect((await a.listExtensions(ctx())).map((e) => e.name).sort()).toEqual(["openroly", "other"]);
    expect((await a.doctor(ctx(), "openroly"))[0]!.ok).toBe(true);
  });

  test("AC-X2: config が無い / 壊れていても throw せず 0 件・ok:false", async () => {
    const a = createMcpConfigAdapter(jsonSpec());
    // 存在しない
    expect(await a.listExtensions(ctx())).toEqual([]);
    expect((await a.doctor(ctx(), "openroly"))[0]!.ok).toBe(false);
    // 壊れた JSON
    await writeFile(configFile, "{{{");
    expect(await a.listExtensions(ctx())).toEqual([]);
    // 壊れた TOML
    await writeFile(configFile, "[[[not toml");
    expect(await createMcpConfigAdapter(tomlSpec()).listExtensions(ctx())).toEqual([]);
    // serversKey が object でない
    await writeFile(configFile, JSON.stringify({ mcpServers: "nope" }));
    expect(await a.listExtensions(ctx())).toEqual([]);
  });
});

describe("createMcpConfigAdapter — applyExtension (PBI-0060 AC-5)", () => {
  test("AC-5: config に無い name の uninstall は CLI を 1 度も呼ばない(冪等)", async () => {
    await installFakeCli("fakejson");
    await writeFile(configFile, JSON.stringify({ mcpServers: {} }));
    const a = createMcpConfigAdapter(jsonSpec());
    await a.applyExtension(ctx(), { action: "uninstall", name: "openroly" });
    expect(await argvLines()).toEqual([]);
  });

  test("config に有る name の uninstall は remove を呼ぶ", async () => {
    await installFakeCli("fakejson");
    await writeFile(configFile, JSON.stringify({ mcpServers: { openroly: {} } }));
    const a = createMcpConfigAdapter(jsonSpec());
    await a.applyExtension(ctx(), { action: "uninstall", name: "openroly" });
    expect(await argvLines()).toEqual(["mcp remove -s user openroly"]);
  });

  test("install は env と spec.args を argv に載せ、消してから足す", async () => {
    await installFakeCli("fakejson");
    const a = createMcpConfigAdapter(jsonSpec());
    await a.applyExtension(ctx(), {
      action: "install",
      name: "gh",
      kind: "mcp",
      spec: { command: "npx", args: ["-y", "gh-mcp"] },
      env: { GH_TOKEN: "t1" },
    });
    const lines = await argvLines();
    expect(lines[0]).toBe("mcp remove -s user gh");
    expect(lines[1]).toBe("mcp add -s user gh -e GH_TOKEN=t1 -- npx -y gh-mcp");
  });

  test("spec.command が文字列でなければ Error(CLI を呼ばない)", async () => {
    await installFakeCli("fakejson");
    const a = createMcpConfigAdapter(jsonSpec());
    await expect(
      a.applyExtension(ctx(), { action: "install", name: "bad", kind: "mcp", spec: {}, env: {} }),
    ).rejects.toThrow(/spec\.command is not a string/);
    expect(await argvLines()).toEqual([]);
  });
});
