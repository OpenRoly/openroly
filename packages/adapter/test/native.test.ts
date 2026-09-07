import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { AdapterContext } from "../src/contract.ts";
import { createNativeAdapter, expandTemplate } from "../src/native.ts";

// generic native adapter(PBI-0210 / EP-0017)。runtime = registry の 1 entry(`native`)。
// file strategy は **1 entry だけ**を置換し他 key とコメントを保つ(AC-1 / AC-2)、cli strategy は
// argv template どおりに runtime CLI を叩く(AC-3)、壊れた config には 1 byte も書かない(AC-X2)、
// 同じ file への 2 本は lock で直列(AC-X3)。実 CLI には到達させない(PATH 先頭の fake だけ)。

let root = "";
let bin = "";
let marker = "";

async function installFakeCli(name: string, code = 0): Promise<void> {
  await writeFile(join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\necho "$@" >> ${marker}\nexit ${code}\n`);
  await chmod(join(bin, name), 0o755);
}

// OPENROLY_HOME を隔離する(dev 機の ~/.openroly/bin/openroly-mcp を拾うと `bun <entry>` の期待が揺れる。PBI-0132)
const ctx = (): AdapterContext => ({ env: { PATH: bin, HOME: root, OPENROLY_HOME: join(root, ".openroly") } });

const INPUT = { serverEntry: "/repo/mcp.ts", runtimeKind: "x", baseUrl: "http://localhost:8787", serverName: "openroly" };
const input = (runtimeKind: string) => ({ ...INPUT, runtimeKind });

/** opencode(jsonc・map 形・`mcp.<name>` = `{type:"local",command:[…],environment,enabled}`) */
const opencodeNative = () => ({
  home: { default: "~/.config/opencode" },
  bin: "opencode",
  mcp: {
    strategy: "file",
    path: "opencode.json",
    format: "jsonc",
    key: "mcp",
    entry: { type: "local", command: ["${command}", "${args...}"], environment: "${env}", enabled: true },
  },
  skills: { dir: "~/.config/opencode/skills" },
});

const OPENCODE_BEFORE = `{
  // my settings — keep this comment
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp"], // trailing comment
      "enabled": true
    }
  },
  "provider": { "anthropic": { "options": { "timeout": 30 } } }
}
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-native-"));
  bin = join(root, "bin");
  marker = join(root, "argv.log");
  await mkdir(bin, { recursive: true });
  await writeFile(marker, "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const argvLines = async (): Promise<string[]> => (await readFile(marker, "utf8")).split("\n").filter(Boolean);

describe("expandTemplate", () => {
  const m = { name: "openroly", command: "bun", args: ["/repo/mcp.ts"], env: [["A", "1"], ["B", "2"]] as [string, string][] };
  test("要素展開: ${args...} / ${env...} / `--flag...` + ${env} の対 / ${json}", () => {
    expect(expandTemplate(["mcp", "add", "${name}", "--env...", "${env}", "--", "${command}", "${args...}"], m)).toEqual([
      "mcp", "add", "openroly", "--env", "A=1", "--env", "B=2", "--", "bun", "/repo/mcp.ts",
    ]);
    expect(expandTemplate(["${env...}"], m)).toEqual(["A=1", "B=2"]);
    expect(expandTemplate(["add-json", "${name}", "${json}"], m)).toEqual([
      "add-json", "openroly", JSON.stringify({ command: "bun", args: ["/repo/mcp.ts"], env: { A: "1", B: "2" } }),
    ]);
  });
  test("object template: ${args} は配列、${env} は object、文字列の中の ${name} ${command} は置換", () => {
    expect(expandTemplate({ command: "${command}", args: "${args}", env: "${env}", label: "mcp:${name}" }, m)).toEqual({
      command: "bun", args: ["/repo/mcp.ts"], env: { A: "1", B: "2" }, label: "mcp:openroly",
    });
  });
});

describe("file strategy — jsonc(opencode)AC-1: 1 entry だけ増減し、他 key とコメントは 1 byte も変わらない", () => {
  test("register → mcp.openroly が template どおり / unregister → 元の bytes に戻る", async () => {
    await installFakeCli("opencode");
    const dir = join(root, ".config", "opencode");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "opencode.json");
    await writeFile(path, OPENCODE_BEFORE);
    const a = createNativeAdapter("opencode", "OpenCode", opencodeNative());

    expect(await a.detect(ctx())).toMatchObject({ installed: true, detail: "9.9.9", configPath: path });
    expect(await a.doctor(ctx(), "openroly")).toEqual([
      { ok: false, label: "OpenCode MCP registration", detail: `"openroly" is missing from ${path}. Run 'openroly install opencode'` },
    ]);

    await a.register(ctx(), input("opencode"));
    const after = await readFile(path, "utf8");
    const parsed = parseJsonc(after);
    expect(parsed.mcp.openroly).toEqual({
      type: "local",
      command: ["bun", "/repo/mcp.ts"],
      environment: { OPENROLY_RUNTIME_KIND: "opencode", OPENROLY_URL: "http://localhost:8787" },
      enabled: true,
    });
    // 他 key はそのまま(値も並びも)、コメントも残る
    expect(parsed.mcp.playwright).toEqual({ type: "local", command: ["npx", "@playwright/mcp"], enabled: true });
    expect(parsed.provider).toEqual({ anthropic: { options: { timeout: 30 } } });
    expect(after).toContain("// my settings — keep this comment");
    expect(after).toContain("// trailing comment");
    // 元の全行が同じ順で残っている(足したのは openroly の行だけ)
    const afterLines = after.split("\n");
    let cursor = 0;
    for (const line of OPENCODE_BEFORE.split("\n")) {
      const found = afterLines.indexOf(line, cursor);
      expect(found, `元の行が消えた / 変わった: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
    expect((await a.listExtensions(ctx())).map((e) => e.name)).toEqual(["playwright", "openroly"]);
    expect(await a.doctor(ctx(), "openroly")).toEqual([{ ok: true, label: "OpenCode MCP registration", detail: `"openroly" in ${path}` }]);

    // 同じ name をもう 1 度 register = 置換(2 つにならない)
    await a.register(ctx(), input("opencode"));
    expect((await a.listExtensions(ctx())).map((e) => e.name)).toEqual(["playwright", "openroly"]);

    await a.unregister(ctx(), "openroly");
    expect(await readFile(path, "utf8")).toBe(OPENCODE_BEFORE);
    // 無い物の unregister は失敗しない(冪等)
    await a.unregister(ctx(), "openroly");
    expect(await readFile(path, "utf8")).toBe(OPENCODE_BEFORE);
    // fake CLI は --version 以外呼ばれていない(file strategy は CLI を叩かない)
    expect(await argvLines()).toEqual([]);
  });

  test("config が無ければ dir ごと作る。空 file / 空 object / key の鎖が無い時も 1 entry を作る", async () => {
    const a = createNativeAdapter("opencode", "OpenCode", opencodeNative());
    const path = join(root, ".config", "opencode", "opencode.json");
    expect(existsSync(path)).toBe(false);
    await a.register(ctx(), input("opencode"));
    expect(parseJsonc(await readFile(path, "utf8")).mcp.openroly.enabled).toBe(true);

    await writeFile(path, '{\n  "theme": "dark"\n}\n');
    await a.register(ctx(), input("opencode"));
    const doc = parseJsonc(await readFile(path, "utf8"));
    expect(doc.theme).toBe("dark");
    expect(doc.mcp.openroly.type).toBe("local");
    // dotted key(`a.b.c`)の鎖が途中まで在る / 無い
    const deep = createNativeAdapter("amp", "Amp", {
      home: { default: "~/.config/amp" },
      mcp: { strategy: "file", path: "settings.json", format: "json", key: "amp.mcpServers", entry: { command: "${command}", args: "${args}", env: "${env}" } },
    });
    const ampPath = join(root, ".config", "amp", "settings.json");
    await mkdir(join(root, ".config", "amp"), { recursive: true });
    await writeFile(ampPath, '{ "amp": { "theme": "x" } }\n');
    await a.register(ctx(), input("opencode"));
    await deep.register(ctx(), input("amp"));
    const amp = parseJsonc(await readFile(ampPath, "utf8"));
    expect(amp.amp.theme).toBe("x");
    expect(amp.amp.mcpServers.openroly).toEqual({ command: "bun", args: ["/repo/mcp.ts"], env: { OPENROLY_RUNTIME_KIND: "amp", OPENROLY_URL: "http://localhost:8787" } });
  });
});

describe("file strategy — AC-2: format × shape ごとに同じ(1 entry だけ増減)", () => {
  test("json map(cursor)", async () => {
    const a = createNativeAdapter("cursor-agent", "Cursor", {
      mcp: { strategy: "file", path: "~/.cursor/mcp.json", format: "json", key: "mcpServers", entry: { command: "${command}", args: "${args}", env: "${env}" } },
    });
    const path = join(root, ".cursor", "mcp.json");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(path, '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    await a.register(ctx(), input("cursor-agent"));
    const doc = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(doc.mcpServers)).toEqual(["other", "openroly"]);
    expect(doc.mcpServers.openroly.command).toBe("bun");
    await a.unregister(ctx(), "openroly");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { other: { command: "x" } } });
  });

  test("yaml map(hermes)— コメントを保つ", async () => {
    const a = createNativeAdapter("hermes", "Hermes", {
      home: { default: "~/.hermes" },
      mcp: { strategy: "file", path: "config.yaml", format: "yaml", key: "mcp_servers", entry: { command: "${command}", args: "${args}", env: "${env}" } },
    });
    const path = join(root, ".hermes", "config.yaml");
    await mkdir(join(root, ".hermes"), { recursive: true });
    await writeFile(path, "# hermes config\nmodel: gpt\nmcp_servers:\n  other:\n    command: x # keep\n");
    await a.register(ctx(), input("hermes"));
    const text = await readFile(path, "utf8");
    expect(text).toContain("# hermes config");
    expect(text).toContain("# keep");
    const doc = parseYaml(text);
    expect(doc.model).toBe("gpt");
    expect(Object.keys(doc.mcp_servers)).toEqual(["other", "openroly"]);
    expect(doc.mcp_servers.openroly).toEqual({ command: "bun", args: ["/repo/mcp.ts"], env: { OPENROLY_RUNTIME_KIND: "hermes", OPENROLY_URL: "http://localhost:8787" } });
    expect((await a.listExtensions(ctx())).map((e) => e.name)).toEqual(["other", "openroly"]);
    await a.unregister(ctx(), "openroly");
    expect(Object.keys(parseYaml(await readFile(path, "utf8")).mcp_servers)).toEqual(["other"]);
  });

  test("yaml list(continue)— match field で 1 要素", async () => {
    const a = createNativeAdapter("continue", "Continue", {
      home: { default: "~/.continue" },
      mcp: { strategy: "file", path: "config.yaml", format: "yaml", key: "mcpServers", shape: "list", match: "name", entry: { command: "${command}", args: "${args}", env: "${env}" } },
    });
    const path = join(root, ".continue", "config.yaml");
    await mkdir(join(root, ".continue"), { recursive: true });
    await writeFile(path, "name: me\nmcpServers:\n  - name: other\n    command: x\n");
    await a.register(ctx(), input("continue"));
    let doc = parseYaml(await readFile(path, "utf8"));
    expect(doc.mcpServers.map((s: { name: string }) => s.name)).toEqual(["other", "openroly"]);
    expect(doc.mcpServers[1]).toEqual({ name: "openroly", command: "bun", args: ["/repo/mcp.ts"], env: { OPENROLY_RUNTIME_KIND: "continue", OPENROLY_URL: "http://localhost:8787" } });
    // 置換(2 つにならない)
    await a.register(ctx(), input("continue"));
    doc = parseYaml(await readFile(path, "utf8"));
    expect(doc.mcpServers.map((s: { name: string }) => s.name)).toEqual(["other", "openroly"]);
    await a.unregister(ctx(), "openroly");
    expect(parseYaml(await readFile(path, "utf8")).mcpServers.map((s: { name: string }) => s.name)).toEqual(["other"]);
  });

  test("toml map(vibe)— 他 table は残る(コメントは消える = doctor が 1 行言う)", async () => {
    const a = createNativeAdapter("vibe", "Vibe", {
      home: { default: "~/.vibe" },
      comments_preserved: false,
      mcp: { strategy: "file", path: "config.toml", format: "toml", key: "mcp_servers", entry: { command: "${command}", args: "${args}", env: "${env}" } },
    });
    const path = join(root, ".vibe", "config.toml");
    await mkdir(join(root, ".vibe"), { recursive: true });
    await writeFile(path, 'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n');
    await a.register(ctx(), input("vibe"));
    const doc = parseToml(await readFile(path, "utf8")) as any;
    expect(doc.model).toBe("m");
    expect(Object.keys(doc.mcp_servers).sort()).toEqual(["openroly", "other"]);
    expect(doc.mcp_servers.openroly.command).toBe("bun");
    const findings = await a.doctor(ctx(), "openroly");
    expect(findings[0]).toMatchObject({ ok: true, label: "Vibe MCP registration" });
    expect(findings[1]?.detail).toContain("comments");
    await a.unregister(ctx(), "openroly");
    expect(Object.keys((parseToml(await readFile(path, "utf8")) as any).mcp_servers)).toEqual(["other"]);
  });

  test("json list(zed の context_servers は map だが、list 形の json も同じ経路)", async () => {
    const a = createNativeAdapter("listjson", "ListJson", {
      mcp: { strategy: "file", path: "~/.listjson/servers.json", format: "json", key: "servers", shape: "list", match: "id", entry: { command: "${command}" } },
    });
    const path = join(root, ".listjson", "servers.json");
    await mkdir(join(root, ".listjson"), { recursive: true });
    await writeFile(path, '{\n  "servers": [\n    { "id": "other", "command": "x" }\n  ]\n}\n');
    await a.register(ctx(), input("listjson"));
    const doc = JSON.parse(await readFile(path, "utf8"));
    expect(doc.servers).toEqual([{ id: "other", command: "x" }, { id: "openroly", command: "bun" }]);
    await a.unregister(ctx(), "openroly");
    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([{ id: "other", command: "x" }]);
  });
});

describe("cli strategy(openclaw / grok)AC-3: argv template どおりに runtime CLI を叩く", () => {
  test("`--env...` の要素展開と remove → add の順(冪等)。read の場所が無ければ doctor は「登録済み」と言う", async () => {
    await installFakeCli("openclaw");
    const a = createNativeAdapter("openclaw", "OpenClaw", {
      bin: "openclaw",
      mcp: {
        strategy: "cli",
        add: ["mcp", "add", "${name}", "--command", "${command}", "--arg...", "${args}", "--env...", "${env}"],
        remove: ["mcp", "unset", "${name}"],
      },
    });
    await a.register(ctx(), input("openclaw"));
    expect(await argvLines()).toEqual([
      "mcp unset openroly",
      "mcp add openroly --command bun --arg /repo/mcp.ts --env OPENROLY_RUNTIME_KIND=openclaw --env OPENROLY_URL=http://localhost:8787",
    ]);
    expect(await a.doctor(ctx(), "openroly")).toEqual([
      { ok: true, label: "OpenClaw MCP registration", detail: "registered through 'openclaw mcp add' (the config file is not declared, so it is not re-read)" },
    ]);
    await a.unregister(ctx(), "openroly");
    expect((await argvLines()).at(-1)).toBe("mcp unset openroly");
  });

  test("add-json は JSON 1 引数(grok)。CLI が exit 非 0 なら throw、CLI 不在なら runtime CLI の不在として失敗", async () => {
    await installFakeCli("grok");
    const a = createNativeAdapter("grok", "Grok", {
      bin: "grok",
      mcp: { strategy: "cli", add: ["mcp", "add-json", "${name}", "${json}"], remove: ["mcp", "remove", "${name}"] },
    });
    await a.register(ctx(), input("grok"));
    const line = (await argvLines()).at(-1)!;
    expect(line.startsWith("mcp add-json openroly ")).toBe(true);
    expect(JSON.parse(line.slice("mcp add-json openroly ".length))).toEqual({
      command: "bun", args: ["/repo/mcp.ts"], env: { OPENROLY_RUNTIME_KIND: "grok", OPENROLY_URL: "http://localhost:8787" },
    });
    await installFakeCli("grok", 3);
    await expect(a.register(ctx(), input("grok"))).rejects.toThrow(/grok mcp add failed/);
    await rm(join(bin, "grok"));
    await expect(a.register(ctx(), input("grok"))).rejects.toThrow();
  });
});

describe("失敗経路 AC-X2 / 並行 AC-X3", () => {
  test("壊れた JSON / YAML には 1 byte も書かず、理由付きで throw する", async () => {
    const a = createNativeAdapter("opencode", "OpenCode", opencodeNative());
    const path = join(root, ".config", "opencode", "opencode.json");
    await mkdir(join(root, ".config", "opencode"), { recursive: true });
    const broken = '{ "mcp": { "x": }\n';
    await writeFile(path, broken);
    await expect(a.register(ctx(), input("opencode"))).rejects.toThrow(/could not be parsed, so nothing was written/);
    expect(await readFile(path, "utf8")).toBe(broken);
    // unregister も同じ(壊れた物を「消せた」ことにしない)
    await expect(a.unregister(ctx(), "openroly")).rejects.toThrow(/could not be parsed/);
    expect(await readFile(path, "utf8")).toBe(broken);
    // 読む側は「無い」として扱う(doctor は install の案内に繋ぐ)
    expect((await a.doctor(ctx(), "openroly"))[0]?.ok).toBe(false);
    expect(await a.listExtensions(ctx())).toEqual([]);

    const y = createNativeAdapter("hermes", "Hermes", {
      home: { default: "~/.hermes" },
      mcp: { strategy: "file", path: "config.yaml", format: "yaml", key: "mcp_servers", entry: { command: "${command}" } },
    });
    const ypath = join(root, ".hermes", "config.yaml");
    await mkdir(join(root, ".hermes"), { recursive: true });
    const ybroken = "mcp_servers:\n  other: [\n";
    await writeFile(ypath, ybroken);
    await expect(y.register(ctx(), input("hermes"))).rejects.toThrow(/could not be parsed/);
    expect(await readFile(ypath, "utf8")).toBe(ybroken);
  });

  test("`key` が object でない(配列)なら書かない", async () => {
    const a = createNativeAdapter("cursor-agent", "Cursor", {
      mcp: { strategy: "file", path: "~/.cursor/mcp.json", format: "json", key: "mcpServers", entry: { command: "${command}" } },
    });
    const path = join(root, ".cursor", "mcp.json");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(path, '{ "mcpServers": [] }\n');
    await expect(a.register(ctx(), input("cursor-agent"))).rejects.toThrow(/is not an object/);
    expect(await readFile(path, "utf8")).toBe('{ "mcpServers": [] }\n');
  });

  test("同じ file への register 2 本同時 = 両方残り、file は壊れない(lock + temp→rename)", async () => {
    const mk = (id: string) =>
      createNativeAdapter(id, id, {
        mcp: { strategy: "file", path: "~/.shared/mcp.json", format: "json", key: "mcpServers", entry: { command: "${command}", env: "${env}" } },
      });
    const path = join(root, ".shared", "mcp.json");
    await Promise.all([
      mk("one").register(ctx(), { ...input("one"), serverName: "openroly-one" }),
      mk("two").register(ctx(), { ...input("two"), serverName: "openroly-two" }),
    ]);
    const doc = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["openroly-one", "openroly-two"]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("壊れた native は組めない(throw = adopt は exit 2)。mcp: null は「配線できない」を doctor が言う", () => {
    expect(() => createNativeAdapter("x", "X", { mcp: { strategy: "file", path: "p", format: "ini", key: "k", entry: {} } })).toThrow(/native\(x\)/);
    expect(() => createNativeAdapter("x", "X", "not an object")).toThrow(/native\(x\)/);
    expect(() => createNativeAdapter("x", "X", { mcp: { strategy: "cli", add: [], remove: ["a"] } })).toThrow(/mcp.add/);
  });

  test("mcp: null(pi のような extension 機構だけの runtime)は register が理由付きで失敗し、doctor は catalog の不足を言う", async () => {
    const a = createNativeAdapter("pi", "pi", { mcp: null, skills: { dir: "~/.pi/agent/skills" } });
    await expect(a.register(ctx(), input("pi"))).rejects.toThrow(/no MCP configuration in the catalog/);
    expect((await a.doctor(ctx(), "openroly"))[0]).toMatchObject({ ok: false, label: "pi MCP registration" });
  });
});
