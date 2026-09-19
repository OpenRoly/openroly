import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

let extensionGets = 0;
const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/extensions" && req.method === "GET") {
      extensionGets++;
      return Response.json([]);
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => stub.stop(true));

async function openroly(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: env.PATH, HOME: env.HOME, OPENROLY_HOME: env.OPENROLY_HOME, GROK_HOME: env.GROK_HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("openroly sync --from", () => {
  test("Account を叩かず Claude の HTTP MCP・symlink skill・CLAUDE.md を Grok へ写す", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-sync-from-"));
    const bin = join(home, "bin");
    const grokHome = join(home, ".grok");
    const marker = join(home, "argv.log");
    await mkdir(bin, { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await mkdir(grokHome, { recursive: true });
    await writeFile(marker, "");
    await writeFile(
      join(bin, "grok"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.34; exit 0; fi\necho "$@" >> ${marker}\nexit 0\n`,
    );
    await chmod(join(bin, "grok"), 0o755);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          obsidian: { type: "http", url: "http://127.0.0.1:9101/servers/obsidian/mcp" },
          echo: { command: "/bin/echo", args: ["hi"] },
          openroly: { command: "bun", args: ["/repo/mcp.ts"] },
        },
      }),
    );
    await mkdir(join(home, ".claude", "skills", "own"), { recursive: true });
    await writeFile(
      join(home, ".claude", "skills", "own", "SKILL.md"),
      '---\nname: "own"\ndescription: "mine"\n---\ndo it\n',
    );
    const archive = join(home, "archive", "linked");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "SKILL.md"), '---\nname: "linked"\ndescription: "from archive"\n---\ngo\n');
    await symlink(archive, join(home, ".claude", "skills", "linked"));
    await writeFile(
      join(home, ".claude", "CLAUDE.md"),
      "human rule\n<!-- openroly:begin x -->\nmanaged\n<!-- openroly:end x -->\n",
    );

    extensionGets = 0;
    const result = await openroly(["sync", "grok", "--from", "claude", "--json"], {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      OPENROLY_HOME: join(home, ".openroly"),
      GROK_HOME: grokHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { from: string; to: string; applied: { name: string }[]; failed: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.from).toBe("claude");
    expect(body.data.to).toBe("grok");
    expect(body.data.failed).toEqual([]);
    expect(body.data.applied.map((a) => a.name).sort()).toEqual(["common-rules", "echo", "linked", "obsidian", "own"]);
    expect(extensionGets).toBe(0);

    // PBI-0691: grok の `mcp add` は呼ばない。MCP は hub。argv は空でよい。
    const argv = (await readFile(marker, "utf8")).split("\n").filter(Boolean);
    expect(argv).toEqual([]);
    const skill = await readFile(join(grokHome, "skills", "linked", "SKILL.md"), "utf8");
    expect(skill).toContain("from archive");
    const rules = await readFile(join(grokHome, "rules", "openroly-common-rules.md"), "utf8");
    expect(rules).toContain("human rule");
    expect(rules).not.toContain("managed");
  }, 30_000);

  test("PBI-0689 AC-1: dest だけ（--from 無し）も同じ機械の Claude から写し Account を叩かない", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-sync-implicit-"));
    const bin = join(home, "bin");
    const grokHome = join(home, ".grok");
    const marker = join(home, "argv.log");
    await mkdir(bin, { recursive: true });
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await mkdir(grokHome, { recursive: true });
    await writeFile(marker, "");
    await writeFile(
      join(bin, "grok"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.34; exit 0; fi\necho "$@" >> ${marker}\nexit 0\n`,
    );
    await chmod(join(bin, "grok"), 0o755);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          obsidian: { type: "http", url: "http://127.0.0.1:9101/servers/obsidian/mcp" },
        },
      }),
    );
    await mkdir(join(home, ".claude", "skills", "own"), { recursive: true });
    await writeFile(
      join(home, ".claude", "skills", "own", "SKILL.md"),
      '---\nname: "own"\ndescription: "mine"\n---\ndo it\n',
    );

    extensionGets = 0;
    const result = await openroly(["sync", "grok", "--json"], {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      OPENROLY_HOME: join(home, ".openroly"),
      GROK_HOME: grokHome,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { from: string; to: string; applied: { name: string }[]; failed: unknown[] };
    };
    expect(body.data.from).toBe("claude");
    expect(body.data.to).toBe("grok");
    expect(body.data.failed).toEqual([]);
    expect(body.data.applied.map((a) => a.name)).toContain("own");
    expect(body.data.applied.map((a) => a.name)).toContain("obsidian");
    expect(extensionGets).toBe(0);
  }, 30_000);

  test("PBI-0689 AC-X1: dest が claude なら --from を捏造しない", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-sync-claude-dest-"));
    extensionGets = 0;
    const result = await openroly(["sync", "claude", "--json"], {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      OPENROLY_HOME: join(home, ".openroly"),
      GROK_HOME: join(home, ".grok"),
    });
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { data: { from?: string; targets?: { runtime: string; connected: boolean }[] } };
    expect(body.data.from).toBeUndefined();
    expect(body.data.targets).toEqual([{ runtime: "claude", connected: false }]);
    expect(extensionGets).toBe(0);
  }, 15_000);
});
