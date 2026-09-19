import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AdapterContext } from "../src/contract.ts";
import { copyExtensions, stripOpenrolyBlocks } from "../src/copy.ts";
import { createNativeAdapter } from "../src/native.ts";

let root = "";
let bin = "";
let marker = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-copy-"));
  bin = join(root, "bin");
  marker = join(root, "argv.log");
  await mkdir(bin, { recursive: true });
  await writeFile(marker, "");
  await writeFile(
    join(bin, "grok"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\necho "$@" >> ${marker}\nexit 0\n`,
  );
  await chmod(join(bin, "grok"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): AdapterContext => ({
  env: { PATH: bin, HOME: root, GROK_HOME: join(root, "grok-home"), OPENROLY_HOME: join(root, ".openroly") },
});

const destNative = () => ({
  home: { env: "GROK_HOME", default: "~/.grok" },
  bin: "grok",
  mcp: {
    strategy: "cli" as const,
    bin: "grok",
    add: ["mcp", "add", "--scope", "user", "${name}", "-e...", "${env}", "--", "${command}", "${args...}"],
    add_url: ["mcp", "add", "--scope", "user", "--transport", "${transport}", "${name}", "${url}"],
    remove: ["mcp", "remove", "--scope", "user", "${name}"],
    read: { path: "config.toml", format: "toml" as const, key: "mcp_servers", shape: "map" as const },
  },
  skills: { dir: "skills" },
  instructions: { dir: "rules", filename: "openroly-${name}.md" },
});

const srcNative = () => ({
  home: { default: "~/.src" },
  mcp: {
    strategy: "file" as const,
    path: "mcp.json",
    format: "json" as const,
    key: "mcpServers",
    entry: { command: "${command}", args: "${args}", env: "${env}" },
  },
  skills: { dir: "skills" },
});

describe("copyExtensions", () => {
  test("stdio MCP・HTTP MCP・symlink skill を dest へ install する", async () => {
    const srcHome = join(root, ".src");
    await mkdir(join(srcHome, "skills"), { recursive: true });
    await writeFile(
      join(srcHome, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: "/bin/echo", args: ["hi"], env: { TOKEN: "secret" } },
          obsidian: { type: "http", url: "http://127.0.0.1:9101/mcp" },
          openroly: { command: "bun", args: ["/repo/mcp.ts"] },
        },
      }),
    );
    await mkdir(join(srcHome, "skills", "own"), { recursive: true });
    await writeFile(
      join(srcHome, "skills", "own", "SKILL.md"),
      '---\nname: "own"\ndescription: "mine"\n---\ndo it\n',
    );
    const archive = join(root, "archive", "linked");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "SKILL.md"), '---\nname: "linked"\ndescription: "from link"\n---\ngo\n');
    await symlink(archive, join(srcHome, "skills", "linked"));

    await mkdir(join(root, "grok-home"), { recursive: true });
    const from = createNativeAdapter("src", "Src", srcNative());
    const to = createNativeAdapter("grok", "Grok Build", destNative());
    const result = await copyExtensions({ from, to, ctx: ctx() });
    expect(result.failed).toEqual([]);
    expect(result.applied.map((a) => a.name).sort()).toEqual(["echo", "linked", "obsidian", "own"]);

    const argv = (await readFile(marker, "utf8")).split("\n").filter(Boolean);
    expect(argv.filter((l) => l.includes("mcp add"))).toEqual([]);

    const toml = await readFile(join(root, "grok-home", "config.toml"), "utf8");
    expect(toml).toContain("obsidian");
    expect(toml).toContain("http://127.0.0.1:9101/mcp");
    expect(toml).toContain("/bin/echo");
    expect(toml).toContain(".local/bin/openroly-mcp");
    expect(toml).not.toContain("mcp/src/server.ts");
    expect(toml).not.toContain("/repo/mcp.ts");

    const skill = await readFile(join(root, "grok-home", "skills", "linked", "SKILL.md"), "utf8");
    expect(skill).toContain("from link");
  });

  test("add_url が無い dest でも HTTP は hub 経由で toml に入る", async () => {
    const srcHome = join(root, ".src");
    await mkdir(srcHome, { recursive: true });
    await writeFile(
      join(srcHome, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: "/bin/echo", args: ["hi"] },
          obsidian: { url: "http://127.0.0.1/mcp" },
        },
      }),
    );
    const noUrl = destNative();
    delete (noUrl.mcp as { add_url?: string[] }).add_url;
    const from = createNativeAdapter("src", "Src", srcNative());
    const to = createNativeAdapter("grok", "Grok Build", noUrl);
    await mkdir(join(root, "grok-home"), { recursive: true });
    const result = await copyExtensions({ from, to, ctx: ctx() });
    expect(result.failed).toEqual([]);
    expect(result.applied.map((a) => a.name).sort()).toEqual(["echo", "obsidian"]);
    const toml = await readFile(join(root, "grok-home", "config.toml"), "utf8");
    expect(toml).toContain("obsidian");
  });

  test("dest adapter が無くても skill は hub に入る", async () => {
    const srcHome = join(root, ".src");
    await mkdir(join(srcHome, "skills", "own"), { recursive: true });
    await writeFile(
      join(srcHome, "mcp.json"),
      JSON.stringify({ mcpServers: { obsidian: { url: "http://127.0.0.1/mcp" } } }),
    );
    await writeFile(
      join(srcHome, "skills", "own", "SKILL.md"),
      '---\nname: "own"\ndescription: "mine"\n---\ndo it\n',
    );
    await mkdir(join(root, "grok-home"), { recursive: true });
    const from = createNativeAdapter("src", "Src", srcNative());
    const result = await copyExtensions({ from, to: null, ctx: ctx() });
    expect(result.failed).toEqual([]);
    expect(result.applied.map((a) => a.name).sort()).toEqual(["obsidian", "own"]);
    const toml = await readFile(join(root, "grok-home", "config.toml"), "utf8");
    expect(toml).toContain("obsidian");
    const { readHubSkill } = await import("../src/hub.ts");
    const skill = await readHubSkill("own", ctx().env);
    expect(skill?.instructions).toContain("do it");
  });
});

describe("stripOpenrolyBlocks", () => {
  test("openroly ブロックと孤立 marker 行を除く", () => {
    const text = [
      "keep",
      "<!-- openroly:begin x -->",
      "managed",
      "<!-- openroly:end x -->",
      "also",
      "<!-- openroly:begin stray -->",
    ].join("\n");
    const out = stripOpenrolyBlocks(text);
    expect(out).toContain("keep");
    expect(out).toContain("also");
    expect(out).not.toContain("managed");
    expect(out).not.toContain("openroly");
  });
});
