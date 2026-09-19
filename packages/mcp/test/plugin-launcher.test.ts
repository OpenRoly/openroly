import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";
import { CONTRACT_TOOLS } from "./contract-tools.ts";
// PBI-0597: bundle は追跡していない生成物。clone を作る前に「無ければ作る」
import { ensurePluginBundle } from "./ensure-bundle.ts";

// PBI-0112: marketplace install(= node_modules を持たない clone、実 cache と同構造)から
// bundle を起動し、runtime と同じ stdio transport で MCP を往復する。
//
// PBI-0002/0007 時代は launcher が repo root 参照で bun install して再 exec していたが、
// cache は plugin dir だけを copy するため必ず壊れる(実測 2026-08-30)。PBI-0112 で
// 起動対象を 1 file bundle に替えたので bootstrap / re-exec は構造上消えた:
// 「bundle が依存無しで起きる」ことと「no-cred の失敗が stdout を汚さない」ことを見る。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE = "adapters/official/claude/mcp-server.bundle.js";

// stub Account。credential の token を検証する —— 固定値を返すだけだと
// 「子 process が credential を解決して Account まで到達した」証拠にならない
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (req.headers.get("authorization") !== "Bearer par_plugin") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (new URL(req.url).pathname === "/v1/whoami") {
      return Response.json({ agent_id: "agt_plugin", handle: "aya", unread: 3 });
    }
    return new Response("not found", { status: 404 });
  },
});

let clone = "";
let openrolyHome = "";

beforeAll(async () => {
  ensurePluginBundle(); // rsync の前に作る(clone に bundle が入っている事がこの test の前提)
  clone = await mkdtemp(join(tmpdir(), "openroly-plugin-"));
  const rsync = Bun.spawn(
    ["rsync", "-a", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".gstack",
     "--exclude", "target", "--exclude", "dist", repoRoot, `${clone}/`],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await rsync.exited).toBe(0);

  openrolyHome = await mkdtemp(join(tmpdir(), "openroly-plugin-home-"));
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_plugin",
      token: "par_plugin",
      base_url: `http://localhost:${stub.port}`,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: openrolyHome },
  );
}, 120_000);

afterAll(async () => {
  stub.stop(true);
  await Promise.all([clone, openrolyHome].filter(Boolean).map((d) => rm(d, { recursive: true, force: true })));
}, 120_000);

/** runtime と同じ形(stdio 越しの MCP client)で bundle を起動する */
async function connect(env: Record<string, string>) {
  const chunks: string[] = [];
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(clone, BUNDLE)],
    // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c: Buffer | string) => chunks.push(String(c)));
  const client = new Client({ name: "openroly-launcher-test", version: "0.0.0" });
  await client.connect(transport, { timeout: 60_000 });
  return { client, transport, stderr: () => chunks.join("") };
}

describe("plugin bundle の MCP 往復", () => {
  test("AC-1〜3: 依存の無い 1 file bundle が node_modules 無しの clone から起き、往復できる", async () => {
    const session = await connect({ OPENROLY_RUNTIME_KIND: "claude", OPENROLY_HOME: openrolyHome });

    // cache 内完結の証拠: bootstrap(bun install)も module 解決の失敗も出ない
    expect(session.stderr()).not.toContain("bun install");
    expect(session.stderr()).not.toContain("Cannot find module");
    expect(session.stderr()).not.toContain("package.json");

    // AC-1: handshake が成立する(stdout に JSON-RPC 以外が混ざっていたらここで落ちる)
    expect(session.client.getServerVersion()?.name).toBe("openroly-account");

    // AC-2: 要件 §16 の 21 tools が過不足なく並ぶ(memory.* / task.* 等を生やさない)
    const tools = (await session.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(CONTRACT_TOOLS);

    // AC-3: 子 process が credential を解決し Account API まで到達している
    const result = (await session.client.callTool({ name: "whoami", arguments: {} })) as any;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ handle: "aya", unread: 3 });

    await session.client.close();
  }, 60_000);

  test("AC-X1: credential が無ければ exit 1 で、stdout を汚さず対処を出す", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "openroly-plugin-empty-"));
    const proc = Bun.spawn(["bun", join(clone, BUNDLE)], {
      env: {
        PATH: process.env.PATH ?? "",
        // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
        HOME: process.env.HOME ?? "",
        OPENROLY_RUNTIME_KIND: "claude",
        OPENROLY_HOME: emptyHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("No OpenRoly credential was found");
    expect(stderr).toContain("openroly-mcp");
    expect(stderr).not.toContain("openroly install");
    // stdout は MCP の stdio transport 用。1 byte でも混ぜたら JSON-RPC が壊れる
    expect(stdout).toBe("");
    await rm(emptyHome, { recursive: true, force: true });
  }, 60_000);
});
