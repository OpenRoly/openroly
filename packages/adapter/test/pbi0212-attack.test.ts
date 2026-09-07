import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../src/contract.ts";
import type { RuntimeCredential } from "../src/credentials.ts";
import { secretsPath } from "../src/credentials.ts";
import { createNativeAdapter } from "../src/native.ts";
import { shareExtensions } from "../src/share.ts";

// PBI-0212 有界レビュー: AC-1 / AC-X2 の「**秘密が Account へ 1 byte も出ない**」を破りに行く。
// 実装の主張は「辞書で選り分けない fail-closed」。env については本当にそうだが、
// **env 以外の口**(argv・skill dir の file)が同じ強さで閉じているかは誰も測っていなかった。

let root = "";
let env: Record<string, string | undefined> = {};
let bodies: any[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;

const ctx = (): AdapterContext => ({ env });

/** claude 相当(json・`mcpServers.<name>` = {command,args,env}) */
const claudeLikeNative = () => ({
  home: { default: join(root, "claudeish") },
  bin: "claudeish",
  mcp: {
    strategy: "file",
    path: ".claude.json",
    format: "json",
    key: "mcpServers",
    entry: { command: "${command}", args: "${args}", env: "${env}" },
  },
  skills: { dir: join(root, "claudeish", "skills") },
});

const adapter = () => createNativeAdapter("claude", "claude", claudeLikeNative());

const credentials = (): Record<string, RuntimeCredential> => ({
  claude: {
    runtime_id: "rt_claude",
    token: "tok_claude",
    base_url: server!.url.toString().replace(/\/$/, ""),
    name: "Test / claude",
    paired_at: new Date().toISOString(),
  },
});

async function writeMcp(servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, "claudeish"), { recursive: true });
  await writeFile(join(root, "claudeish", ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

async function putSkill(name: string, body: string): Promise<string> {
  const dir = join(root, "claudeish", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
  return dir;
}

/** 送られた物すべて(提案 body + 端末に残った secrets.json)を 1 本の文字列にする */
async function everythingSent(): Promise<string> {
  return JSON.stringify(bodies);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-0212-attack-"));
  env = { HOME: root, OPENROLY_HOME: join(root, ".openroly"), PATH: join(root, "bin") };
  bodies = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/extensions") return Response.json([]);
      bodies.push(await req.json().catch(() => null));
      return Response.json({ id: `exp_${bodies.length}`, status: "pending" }, { status: 201 });
    },
  });
  await writeMcp({});
});

afterEach(async () => {
  server?.stop(true);
  await rm(root, { recursive: true, force: true });
});

describe("攻撃: env 以外の口から秘密が Account へ出ないか", () => {
  test("攻撃1: argv に載った生の credential(`--token ghp_…`)は提案に出さない", async () => {
    await writeMcp({
      github: { command: "npx", args: ["-y", "@mcp/github", "--token", "ghp_ATTACK1234567890abcd"] },
    });
    const result = await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(await everythingSent()).not.toContain("ghp_ATTACK1234567890abcd");
    expect(result.skipped.map((s) => s.name)).toContain("github");
  });

  test("攻撃2: `--api-key=sk-…` の 1 語形も同じ", async () => {
    await writeMcp({ ai: { command: "npx", args: ["--api-key=sk-live-ATTACK2xyz"] } });
    await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(await everythingSent()).not.toContain("sk-live-ATTACK2xyz");
  });

  test("攻撃3: 接続 URL に埋まった password(`postgres://u:pw@host/db`)も出さない", async () => {
    await writeMcp({ pg: { command: "npx", args: ["postgresql://app:ATTACK3pw@db.example.com/app"] } });
    await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(await everythingSent()).not.toContain("ATTACK3pw");
  });

  test("攻撃4: 辞書に載らない env 名(`GH_PAT`)は剥がれる(fail-closed の主張の裏取り)", async () => {
    await writeMcp({ gh: { command: "npx", args: ["@mcp/gh"], env: { GH_PAT: "ATTACK4value" } } });
    await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(await everythingSent()).not.toContain("ATTACK4value");
    expect(bodies[0]?.credential_ref).toBe("env:GH_PAT");
    expect(JSON.parse(await readFile(secretsPath(env), "utf8")).env.GH_PAT).toBe("ATTACK4value");
  });

  test("攻撃5: skill dir に紛れた `.env` の中身は Account へ行かない", async () => {
    const dir = await putSkill("deploy", '---\nname: "deploy"\ndescription: "ship it"\n---\nrun it\n');
    await writeFile(join(dir, ".env"), "AWS_SECRET_ACCESS_KEY=ATTACK5value\n");
    await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(await everythingSent()).not.toContain("ATTACK5value");
  });

  test("攻撃7: `env` を渡さない呼び手は ctx.env の HOME に書く(本物の ~/.openroly を汚さない)", async () => {
    await writeMcp({ gh: { command: "npx", args: ["@mcp/gh"], env: { GH_PAT: "ATTACK7value" } } });
    await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials() });
    expect(JSON.parse(await readFile(secretsPath(env), "utf8")).env.GH_PAT).toBe("ATTACK7value");
  });

  test("攻撃6: git clone で入れた skill(`.git` に binary)が黙って消えない", async () => {
    const dir = await putSkill("cloned", '---\nname: "cloned"\ndescription: "from github"\n---\nx\n');
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    await writeFile(join(dir, ".git", "objects", "blob"), Buffer.from([0x78, 0x9c, 0xff, 0xfe, 0x00, 0x01]));
    const result = await shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: credentials(), env });
    expect(result.plan.map((p) => p.name)).toContain("cloned");
  });
});
