import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHubRule, writeHubSkill } from "@openroly/adapter";
import { createAccountTools } from "../src/tools.ts";

describe("MCP skills hub", () => {
  let home = "";
  const prevHome = process.env.OPENROLY_HOME;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
    if (prevHome === undefined) delete process.env.OPENROLY_HOME;
    else process.env.OPENROLY_HOME = prevHome;
  });

  test("skills_list / skill_get / instructions_get は hub を読み Account を叩かない", async () => {
    home = await mkdtemp(join(tmpdir(), "openroly-mcp-skills-"));
    await mkdir(home, { recursive: true });
    const env = { OPENROLY_HOME: home, HOME: home };
    process.env.OPENROLY_HOME = home;
    await writeHubSkill("foo", { description: "d", instructions: "do foo\n" }, env);
    await writeHubRule("claude-rules", "human rule\n", env);
    const tools = createAccountTools({ baseUrl: "http://127.0.0.1:9", token: "par_x" });
    expect(await tools.skills_list()).toEqual([{ name: "foo", description: "d" }]);
    expect(await tools.skill_get("foo")).toMatchObject({ name: "foo", instructions: "do foo\n" });
    expect(await tools.instructions_get("claude-rules")).toBe("human rule\n");
    expect(await tools.instructions_get()).toBe("human rule\n");
    const { writeHubMcp } = await import("@openroly/adapter");
    await writeHubMcp("obsidian", { url: "http://127.0.0.1/mcp", transport: "http" }, env);
    expect(await tools.mcp_servers_list()).toEqual([
      { name: "obsidian", url: "http://127.0.0.1/mcp", transport: "http" },
    ]);
  });
});
