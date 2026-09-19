import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHubSkills, ingestAndLink, listHubMcps, listHubSkills, readHubSkill, wellKnownSkillRoots, writeHubSkill } from "../src/hub.ts";

let home = "";
const env = (): Record<string, string> => ({ HOME: home, OPENROLY_HOME: join(home, ".openroly") });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-hub-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ingestAndLink", () => {
  test("AC-1: Claude の skill を hub に吸い、Grok home があれば symlink する", async () => {
    await mkdir(join(home, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(
      join(home, ".claude", "skills", "foo", "SKILL.md"),
      '---\nname: "foo"\ndescription: "d"\n---\nbody\n',
    );
    await mkdir(join(home, ".grok"), { recursive: true });
    const r = await ingestAndLink(env());
    expect(r.ingested).toBe(1);
    expect((await listHubSkills(env())).map((s) => s.name)).toEqual(["foo"]);
    const dest = join(home, ".grok", "skills", "foo");
    expect((await lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await readFile(dest + "/SKILL.md", "utf8")).toContain("body");
  });

  test("AC-X1: unmanaged 同名 dir は潰さない", async () => {
    await mkdir(join(home, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "---\ndescription: d\n---\nx\n");
    await mkdir(join(home, ".grok", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".grok", "skills", "foo", "SKILL.md"), "human\n");
    const r = await ingestAndLink(env());
    expect(r.skipped.some((s) => s.endsWith("/foo"))).toBe(true);
    expect(await readFile(join(home, ".grok", "skills", "foo", "SKILL.md"), "utf8")).toBe("human\n");
  });

  test("AC-X2: agent home が無い path は mkdir しない", async () => {
    await ingestAndLink(env());
    expect(wellKnownSkillRoots(env()).some((p) => p.includes(".codex"))).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });

  test("AC-X3: 名前に / は throw", async () => {
    await expect(writeHubSkill("a/b", { description: "d", instructions: "x" }, env())).rejects.toThrow(/invalid name/);
    expect(await readHubSkill("a/b", env())).toBeNull();
  });

  test("HTTP MCP は grok CLI 無しで config.toml に url を書く", async () => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          obsidian: { type: "http", url: "http://127.0.0.1:9101/mcp" },
          openroly: { command: "bun", args: ["/repo/mcp.ts"] },
          atn: { command: "bun", args: ["/repo/packages/mcp/src/server.ts"] },
        },
      }),
    );
    await mkdir(join(home, ".grok"), { recursive: true });
    const r = await ingestAndLink(env());
    expect(r.mcpApplied?.some((s) => s.includes("obsidian"))).toBe(true);
    expect((await listHubMcps(env())).map((s) => s.name)).toEqual(["obsidian"]);
    const toml = await readFile(join(home, ".grok", "config.toml"), "utf8");
    expect(toml).toContain("obsidian");
    expect(toml).toContain("http://127.0.0.1:9101/mcp");
    expect(toml).toContain(`${home}/.local/bin/openroly-mcp`);
    expect(toml).not.toContain("mcp/src/server.ts");
    expect(toml).toContain("OPENROLY_RUNTIME_KIND");
    expect(toml).not.toContain("/repo/mcp.ts");
    expect(toml).not.toContain("[mcp_servers.atn]");
  });

  test("dest の atn（同じ server.ts）は消す", async () => {
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeFile(
      join(home, ".grok", "config.toml"),
      '[mcp_servers.atn]\ncommand = "bun"\nargs = [ "/repo/packages/mcp/src/server.ts" ]\n',
    );
    await ingestAndLink(env());
    const toml = await readFile(join(home, ".grok", "config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.atn]");
    expect(toml).toContain("openroly-mcp");
  });

  test("catalog native の opencode / cursor / kiro にも配る", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), '{ "mcp": {} }\n');
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), "{}\n");
    await mkdir(join(home, ".kiro"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { obsidian: { type: "http", url: "http://x/mcp" } } }));
    await writeFile(join(home, ".claude", "CLAUDE.md"), "rule body\n");
    const r = await ingestAndLink(env());
    expect(r.mcpApplied?.some((s) => s.includes("opencode.json") && s.includes("obsidian"))).toBe(true);
    expect(r.mcpApplied?.some((s) => s.includes("mcp.json") && s.includes("obsidian"))).toBe(true);
    const oc = await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8");
    expect(oc).toContain("obsidian");
    const cur = await readFile(join(home, ".cursor", "mcp.json"), "utf8");
    expect(cur).toContain("obsidian");
    expect((await lstat(join(home, ".kiro", "steering", "openroly-common-rules.md"))).isSymbolicLink()).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".aider"))).toBe(false);
  });

  test("壊れた dest json は skip し、他は進む", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), "{ not json");
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { obsidian: { url: "http://x" } } }));
    const r = await ingestAndLink(env());
    expect(r.skipped.some((s) => s.includes("opencode.json"))).toBe(true);
    expect(r.mcpApplied?.some((s) => s.includes("config.toml") && s.includes("obsidian"))).toBe(true);
  });

  test("native 無しの aider は既存 home に skill を付け、mcp.json は作らない", async () => {
    await mkdir(join(home, ".aider"), { recursive: true });
    await mkdir(join(home, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "---\ndescription: d\n---\nx\n");
    await ingestAndLink(env());
    expect((await lstat(join(home, ".aider", "skills", "foo"))).isSymbolicLink()).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".aider", "mcp.json"))).toBe(false);
  });

  test("aider の mcp.json が既にあれば openroly を付ける", async () => {
    await mkdir(join(home, ".aider"), { recursive: true });
    await writeFile(join(home, ".aider", "mcp.json"), "{}\n");
    await ingestAndLink(env());
    const text = await readFile(join(home, ".aider", "mcp.json"), "utf8");
    expect(text).toContain("openroly");
    expect(text).toContain("aider");
  });

  test("PBI-0695: exportHubSkills は hub の skill を出す", async () => {
    await writeHubSkill("foo", { description: "d", instructions: "body" }, env());
    const items = await exportHubSkills(env());
    expect(items.some((i) => i.kind === "skill" && i.name === "foo")).toBe(true);
  });

  test("F38: dest の壊れた skill symlink は消し、生きている archive link は残す", async () => {
    await mkdir(join(home, ".grok", "skills"), { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink("/no/such/skill-dir", join(home, ".grok", "skills", "busho"));
    const archive = join(home, "archive", "gstack");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "SKILL.md"), "---\ndescription: archive\n---\ngo\n");
    await symlink(archive, join(home, ".claude", "skills", "gstack"));
    await mkdir(join(home, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "---\ndescription: d\n---\nx\n");
    const r = await ingestAndLink(env());
    expect(r.removed?.some((p) => p.endsWith("/busho"))).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".grok", "skills", "busho"))).toBe(false);
    expect((await lstat(join(home, ".claude", "skills", "gstack"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(home, ".claude", "skills", "gstack", "SKILL.md"), "utf8")).toContain("go");
  });

  test("PBI-0699 AC-1: compiled があれば dest の command は bin の path で server.ts を書かない", async () => {
    await mkdir(join(home, ".openroly", "bin"), { recursive: true });
    await writeFile(join(home, ".openroly", "bin", "openroly-mcp"), "x".repeat(10_001), { mode: 0o755 });
    await mkdir(join(home, ".grok"), { recursive: true });
    await ingestAndLink(env());
    const toml = await readFile(join(home, ".grok", "config.toml"), "utf8");
    expect(toml).toContain(`${home}/.openroly/bin/openroly-mcp`);
    expect(toml).not.toContain(`${home}/.local/bin/openroly-mcp`);
    expect(toml).not.toContain("mcp/src/server.ts");
  });

  // PBI-0796: MCP server は起動直後に ingestAndLink を待たずに投げる。env を絞った session
  // (sandbox / dedicated。HOME を渡さない)では、配り先の探索が `env.HOME ?? homedir()` で
  // **OS の passwd から実行者本人の home を引いて**しまい、owner の持ち物が OPENROLY_HOME へ
  // 写っていた。負の対照 = hub.ts の `env.HOME === undefined` の門を外すと ingested が 1 になる。
  test("PBI-0796 AC-3: HOME を宣言していない env では 1 件も吸わず OPENROLY_HOME に何も作らない", async () => {
    const claudeDir = join(home, "claude-config");
    await mkdir(join(claudeDir, "skills", "foo"), { recursive: true });
    await writeFile(
      join(claudeDir, "skills", "foo", "SKILL.md"),
      "---\nname: foo\ndescription: d\n---\nbody",
    );
    await writeFile(join(claudeDir, "CLAUDE.md"), "rule");
    const orHome = join(home, ".openroly");
    // HOME 無し・配り先だけを明示した env(CLAUDE_CONFIG_DIR は HOME に依存しないので、
    // 実行者の機械に skill が在るかに関係なく同じ結果になる)
    const r = await ingestAndLink({ OPENROLY_HOME: orHome, CLAUDE_CONFIG_DIR: claudeDir });
    expect(r.ingested).toBe(0);
    expect(r.linked).toEqual([]);
    const { existsSync } = await import("node:fs");
    expect(existsSync(orHome)).toBe(false);
  });

  test("Grok home が無ければ config.toml を作らない", async () => {
    const { writeHubMcp } = await import("../src/hub.ts");
    await writeHubMcp("obsidian", { url: "http://x", transport: "http" }, env());
    await ingestAndLink(env());
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, ".grok"))).toBe(false);
  });
});
