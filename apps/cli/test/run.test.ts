import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionTokenEnvName } from "@openroly/core";

// PBI-0211: `openroly run <class> --bin <path> -- <argv>`(broker が variant の wake で起こす物)。
// Account API は stub、親 binary は env と argv を marker に書く fake。鍵は fake 値だけ。

const CLI = join(import.meta.dir, "../src/openroly.ts");
const FAKE_KEY = "fake-zai-key-not-a-real-secret-31aa";
const TOKEN = "par_run_test_token";

let resolveCalls: string[] = [];
let resolveQueue: { status: number; body: unknown }[] = [];

const account = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/resolve")) {
      resolveCalls.push(url.pathname);
      const next = resolveQueue.shift() ?? { status: 200, body: { env: { [connectionTokenEnvName("zhipu")]: FAKE_KEY } } };
      return Response.json(next.body, { status: next.status });
    }
    return new Response("not found", { status: 404 });
  },
});

let root = "";
let ohome = "";
let fake = "";
let marker = "";

const PROFILES = {
  version: 1,
  profiles: {
    "claude-zai": {
      name: "claude-zai",
      env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "connection:zhipu" },
    },
    "claude-proxy": { name: "claude-free", env: { ANTHROPIC_BASE_URL: "http://localhost:20128/api" }, secret_env: {} },
  },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-run-"));
  ohome = join(root, ".openroly");
  fake = join(root, "claude");
  marker = join(root, "marker.log");
  await mkdir(ohome, { recursive: true });
  // argv は 1 要素 1 行(空要素も区別できるよう [..] で囲む)・env は ANTHROPIC_* だけ
  await writeFile(fake, `#!/bin/sh\n{ for a in "$@"; do echo "ARG[$a]"; done; env | grep '^ANTHROPIC_'; } > ${marker}\nexit 7\n`);
  await chmod(fake, 0o755);
  await writeFile(
    join(ohome, "credentials.json"),
    JSON.stringify({ version: 1, runtimes: { claude: { runtime_id: "rt_claude", token: TOKEN, base_url: `http://127.0.0.1:${account.port}`, name: "M / Claude Code", paired_at: "2026-09-12T00:00:00Z" } } }),
  );
});

beforeEach(async () => {
  resolveCalls = [];
  resolveQueue = [];
  await rm(marker, { force: true });
  await writeFile(join(ohome, "profiles.json"), JSON.stringify(PROFILES));
});

afterAll(async () => {
  account.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = { ...process.env, OPENROLY_HOME: ohome };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
  const proc = Bun.spawn(["bun", CLI, "run", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const PARENT_ARGV = ["-p", "hello world", "--tools", "", "--output-format", "json"];

describe("openroly run(PBI-0211)", () => {
  test("AC-3: claude-zai は Connections の鍵と profile の env で親を起こし、argv は渡した物そのもの・exit code を返す", async () => {
    const res = await run(["claude-zai", "--bin", fake, "--", ...PARENT_ARGV]);
    expect(res.code, res.err).toBe(7);
    const lines = (await readFile(marker, "utf8")).trim().split("\n");
    expect(lines.filter((l) => l.startsWith("ARG["))).toEqual(PARENT_ARGV.map((a) => `ARG[${a}]`));
    expect(lines).toContain("ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic");
    expect(lines).toContain(`ANTHROPIC_AUTH_TOKEN=${FAKE_KEY}`);
    expect(lines).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3");
    expect(resolveCalls).toEqual(["/v1/connections/zhipu/resolve"]);
    expect(res.out.includes(FAKE_KEY) || res.err.includes(FAKE_KEY)).toBe(false);
  });

  test("AC-4: claude-proxy は resolve を叩かずに起こす", async () => {
    const res = await run(["claude-proxy", "--bin", fake, "--", "--continue"]);
    expect(res.code, res.err).toBe(7);
    expect(resolveCalls).toEqual([]);
    const text = await readFile(marker, "utf8");
    expect(text).toContain("ANTHROPIC_BASE_URL=http://localhost:20128/api");
    expect(text).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("AC-X1: Connections に zhipu が無い(404)→ 親を起こさない", async () => {
    resolveQueue = [{ status: 404, body: { error: "not_found" } }];
    const res = await run(["claude-zai", "--bin", fake, "--", ...PARENT_ARGV]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("connection_unavailable");
    expect(existsSync(marker)).toBe(false);
  });

  test("AC-X1: 承認待ち(202)→ 待たずに止まり、親を起こさない", async () => {
    resolveQueue = [{ status: 202, body: { status: "pending_approval", approval_id: "apr_1" } }];
    const res = await run(["claude-zai", "--bin", fake, "--", ...PARENT_ARGV]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("waiting for approval");
    expect(existsSync(marker)).toBe(false);
  });

  test("AC-X1: profile が消えた class の wake は profile_not_found で親を起こさない", async () => {
    await writeFile(join(ohome, "profiles.json"), JSON.stringify({ version: 1, profiles: {} }));
    const res = await run(["claude-zai", "--bin", fake, "--", ...PARENT_ARGV]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("profile_not_found");
    expect(existsSync(marker)).toBe(false);
  });

  test("AC-X1: class の provider 以外を指す参照(書き換えた profile)は解決せず、親を起こさない", async () => {
    const tampered = structuredClone(PROFILES);
    tampered.profiles["claude-zai"].secret_env = { ANTHROPIC_AUTH_TOKEN: "connection:openai" };
    await writeFile(join(ohome, "profiles.json"), JSON.stringify(tampered));
    const res = await run(["claude-zai", "--bin", fake, "--", ...PARENT_ARGV]);
    expect(res.code).not.toBe(0);
    expect(resolveCalls).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  // 公開 repo には apps/server が無い(sync-public の EXCLUDE)。無い所では走査する物が無いので skip(PBI-0469)。
  // main では dir が在るので従来どおり走り、`files.length > 10` が「空の dir で緑」を防ぐ
  const serverSrc = join(import.meta.dir, "../../server/src");
  test.skipIf(!existsSync(serverSrc))("AC-X1: profile は端末 file のみ —— server に /v1/profiles の route が無い", () => {
    const dir = serverSrc;
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => statSync(join(dir, f)).isFile() && readFileSync(join(dir, f), "utf8").includes("/v1/profiles"));
    expect(hits).toEqual([]);
  });
});
