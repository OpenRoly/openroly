import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catalog from "@openroly/core/registry/detectors.v1.json" with { type: "json" };

// PBI-0211: `openroly profiles import|list` / `openroly runtimes add` / `openroly adopt`(variant と local-*)。
// 実 claude には到達させない(PATH 先頭の fake が argv を marker に書く)。HOME / OPENROLY_HOME は隔離する。

const CLI = join(import.meta.dir, "../src/openroly.ts");
const TOKEN = "par_profiles_test_token";
const FAKE_KEY = "fake-zai-key-not-a-real-secret-77c2";

let root = "";
let bin = "";
let marker = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-cli-profiles-"));
  bin = join(root, "bin");
  marker = join(root, "claude-argv.log");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 0\n`);
  await writeFile(join(bin, "foo"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "claude"), 0o755);
  await chmod(join(bin, "foo"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function home(): Promise<Record<string, string>> {
  const h = await mkdtemp(join(root, "home-"));
  return { HOME: h, OPENROLY_HOME: join(h, ".openroly") };
}

async function cli(args: string[], env: Record<string, string>, stdin = ""): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe("openroly profiles(PBI-0211)", () => {
  test("AC-X2: rc が読めなければ 0 件で exit 0(profiles.json を作らない)", async () => {
    const env = await home();
    const res = await cli(["profiles", "import", "--shell", join(env.HOME!, "no-such-rc")], env);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("Imported 0 profiles");
    expect(existsSync(join(env.OPENROLY_HOME!, "profiles.json"))).toBe(false);
  });

  test("AC-1/AC-2: import → list に label と共有の注記。鍵の値は stdout / file に出ない", async () => {
    const env = await home();
    const rc = join(env.HOME!, ".zshrc");
    await writeFile(rc, `claude-zai() {\n  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \\\n  ANTHROPIC_AUTH_TOKEN="${FAKE_KEY}" \\\n  command claude "$@"\n}\n`);
    const res = await cli(["profiles", "import", "--shell", rc], env);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("Imported claude-zai as claude-zai (Claude Code · Z.AI (GLM))");
    const list = await cli(["profiles", "list"], env);
    expect(list.out).toContain("shares claude's config");
    expect(list.out).toContain("ANTHROPIC_AUTH_TOKEN ← connection:zhipu");
    const file = await readFile(join(env.OPENROLY_HOME!, "profiles.json"), "utf8");
    for (const text of [res.out, res.err, list.out, file]) expect(text.includes(FAKE_KEY)).toBe(false);
  });

  test("AC-2: catalog の class は adapter variant・label は Claude Code · Z.AI (GLM)", () => {
    const zai = (catalog.detectors as { id: string; adapter: string | null; display_name: string }[]).find((d) => d.id === "claude-zai");
    expect(zai).toMatchObject({ adapter: "variant", display_name: "Claude Code · Z.AI (GLM)" });
  });

  test("AC-2: adopt --kind claude-zai は credential を保存し、claude mcp add を呼ばない", async () => {
    const env = await home();
    const res = await cli(
      ["adopt", "--kind", "claude-zai", "--runtime-id", "rt_zai_1", "--base-url", "http://localhost:9999/", "--name", "MacBook / Claude Code · Z.AI (GLM)", "--token-stdin"],
      env,
      `${TOKEN}\n`,
    );
    expect(res.code, res.err).toBe(0);
    const creds = JSON.parse(await readFile(join(env.OPENROLY_HOME!, "credentials.json"), "utf8"));
    expect(creds.runtimes["claude-zai"]).toMatchObject({ runtime_id: "rt_zai_1", token: TOKEN, base_url: "http://localhost:9999" });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("openroly runtimes add(PBI-0211 AC-5)", () => {
  test("runtimes add foo → catalog.local.json → adopt --kind local-foo(native は broker が端末の file から添える)→ mcp.json に openroly", async () => {
    const env = await home();
    const mcpFile = join(env.HOME!, ".foo", "mcp.json");
    const add = await cli(["runtimes", "add", "foo", "--binary", "foo", "--mcp-file", mcpFile, "--format", "json", "--key", "mcpServers"], env);
    expect(add.code, add.err).toBe(0);
    const local = JSON.parse(await readFile(join(env.OPENROLY_HOME!, "catalog.local.json"), "utf8"));
    const entry = local.entries.find((e: { id: string }) => e.id === "local-foo");
    expect(entry?.detect).toEqual({ binaries: ["foo"] });

    const adopt = await cli(
      ["adopt", "--kind", "local-foo", "--runtime-id", "rt_foo_1", "--base-url", "http://localhost:9999", "--name", "MacBook / foo", "--spec-stdin"],
      env,
      `${JSON.stringify({ token: TOKEN, native: entry.native })}\n`,
    );
    expect(adopt.code, adopt.err).toBe(0);
    const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
    expect(mcp.mcpServers.openroly).toMatchObject({ env: { OPENROLY_RUNTIME_KIND: "local-foo", OPENROLY_URL: "http://localhost:9999" } });
  });

  test("引数が足りなければ exit 1 で使い方を出す", async () => {
    const env = await home();
    const res = await cli(["runtimes", "add", "foo"], env);
    expect(res.code).toBe(1);
    expect(res.err).toContain("runtimes add <name> --binary");
  });
});
