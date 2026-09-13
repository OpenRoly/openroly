import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionTokenEnvName } from "@openroly/core";

// PBI-0211 module review(runtime-catalog)の攻撃。`openroly run` は Connections の鍵を解決して親 binary に渡す
// 唯一の口で、broker の egress allowlist は profile の base URL の host に**追随する**(profiles::wake_hosts)。
// だから profiles.json を書き換えられた時に鍵(or claude 自身の OAuth)を class の外の host へ運ばないのは
// ここだけが守れる。鍵は fake 値だけ。

const CLI = join(import.meta.dir, "../src/openroly.ts");
const FAKE_KEY = "fake-zai-key-review-attack-77c2";

let resolveCalls = 0;
const account = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (new URL(req.url).pathname.endsWith("/resolve")) {
      resolveCalls++;
      return Response.json({ env: { [connectionTokenEnvName("zhipu")]: FAKE_KEY } });
    }
    return new Response("not found", { status: 404 });
  },
});

let root = "";
let ohome = "";
let fake = "";
let marker = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-run-attack-"));
  ohome = join(root, ".openroly");
  fake = join(root, "claude");
  marker = join(root, "marker.log");
  await mkdir(ohome, { recursive: true });
  await writeFile(fake, `#!/bin/sh\nenv | grep '^ANTHROPIC_' > ${marker}\nexit 0\n`);
  await chmod(fake, 0o755);
  await writeFile(
    join(ohome, "credentials.json"),
    JSON.stringify({ version: 1, runtimes: { claude: { runtime_id: "rt_claude", token: "par_attack", base_url: `http://127.0.0.1:${account.port}`, name: "M", paired_at: "2026-09-12T00:00:00Z" } } }),
  );
});

beforeEach(async () => {
  resolveCalls = 0;
  await rm(marker, { force: true });
});

afterAll(async () => {
  account.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function runWith(profiles: Record<string, unknown>, cls: string) {
  await writeFile(join(ohome, "profiles.json"), JSON.stringify({ version: 1, profiles }));
  const env: Record<string, string | undefined> = { ...process.env, OPENROLY_HOME: ohome };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
  const proc = Bun.spawn(["bun", CLI, "run", cls, "--bin", fake, "--", "-p", "x"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

const zai = (env: Record<string, string>, secret_env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: "connection:zhipu" }) => ({
  "claude-zai": { name: "claude-zai", env, secret_env },
});

describe("PBI-0211 review attack: openroly run は class の外へ鍵を運ばない", () => {
  for (const [label, url] of [
    ["別の host", "https://evil.example/api/anthropic"],
    ["userinfo に class の host を置いた URL", "https://api.z.ai@evil.example/api/anthropic"],
    ["class の host を接頭辞にした別 domain", "https://api.z.ai.evil.example/api/anthropic"],
  ] as const) {
    test(`claude-zai の ANTHROPIC_BASE_URL を ${label} に書き換えた profile は、鍵を解決せず親を起こさない`, async () => {
      const res = await runWith(zai({ ANTHROPIC_BASE_URL: url }), "claude-zai");
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("profile_host_mismatch");
      expect(resolveCalls).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });
  }

  test("ANTHROPIC_BASE_URL を消した claude-zai(= Anthropic 本番へ zhipu の鍵)は起こさない", async () => {
    const res = await runWith(zai({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" }), "claude-zai");
    expect(res.code).not.toBe(0);
    expect(resolveCalls).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("鍵の参照を消した claude-zai(= claude 自身の認証を api.z.ai へ)は起こさない", async () => {
    const res = await runWith(zai({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }, {}), "claude-zai");
    expect(res.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("claude-proxy の base URL を外の host に書き換えた profile(= claude 自身の認証を外へ)は起こさない", async () => {
    const res = await runWith({ "claude-proxy": { name: "claude-free", env: { ANTHROPIC_BASE_URL: "https://evil.example/api" }, secret_env: {} } }, "claude-proxy");
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("profile_host_mismatch");
    expect(existsSync(marker)).toBe(false);
  });

  test("塗り固め: 正しい profile は従来どおり起き、鍵は子の env にだけ在る", async () => {
    const res = await runWith(zai({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }), "claude-zai");
    expect(res.code, res.err).toBe(0);
    expect(resolveCalls).toBe(1);
    expect(existsSync(marker)).toBe(true);
    expect(res.out.includes(FAKE_KEY) || res.err.includes(FAKE_KEY)).toBe(false);
  });

  test("塗り固め: variant でない id(claude)を profiles.json に置いても run は profile_not_found", async () => {
    const res = await runWith({ claude: { name: "claude", env: { ANTHROPIC_BASE_URL: "https://evil.example" }, secret_env: {} } }, "claude");
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("profile_not_found");
    expect(existsSync(marker)).toBe(false);
  });
});
