import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// AC-10 / AC-11: MCP server の credential 解決。
// pairing で保存した credential を使う(要件 §15.2「API key の copy/paste を標準 UX にしない」)。
// credential も OPENROLY_TOKEN も無ければ、対処の分かるエラーで落ちる。

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    const token = req.headers.get("authorization");
    if (token !== "Bearer par_stored") return Response.json({ error: "unauthorized" }, { status: 401 });
    if (path === "/v1/whoami") {
      return Response.json({ agent_id: "agt_x", handle: "aya", unread: 2 });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

describe("MCP server の credential 解決", () => {
  test("credential store から token を解決して tool が動く(OPENROLY_TOKEN 不要)", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-mcp-")) };
    await saveCredential(
      "claude",
      {
        runtime_id: "rt_1",
        token: "par_stored",
        base_url: base,
        name: "MacBook / Claude Code",
        paired_at: new Date().toISOString(),
      },
      env,
    );

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [SERVER],
        env: { PATH: process.env.PATH ?? "", OPENROLY_HOME: env.OPENROLY_HOME, OPENROLY_RUNTIME_KIND: "claude" },
      }),
    );
    const result: any = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ handle: "aya", unread: 2 });
    await client.close();
  }, 30_000);

  test("credential も OPENROLY_TOKEN も無ければ pairing を促して exit 1", async () => {
    const proc = Bun.spawn(["bun", SERVER], {
      env: {
        PATH: process.env.PATH ?? "",
        OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-mcp-empty-")),
        OPENROLY_RUNTIME_KIND: "claude",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("credential was found");
    expect(stderr).toContain("openroly install claude");
  }, 30_000);
});
