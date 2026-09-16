import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0558: sandbox の中の relay → 外の masking server。
// relay は実物: seatbelt で secrets.json を deny した `bun server.ts` に OPENROLY_MCP_RELAY を渡して起こす。
// broker の egress proxy(broker/src/egress.rs の mask_tunnel)の役はここでは小さな CONNECT 受け口が持ち、token が合えば
// `bun server.ts`(secrets.json を読める = 外)の stdio に繋ぐ。token / 1 接続 / 後始末の実物は egress.rs の unit test が測る

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const NAME = "山田太郎";
const PHONE = "090-1234-5678";
const MAIL = "bob@example.com";
const TOKEN = "relay-token-0558";
const isDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const replies: string[] = [];
const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    if (req.headers.get("authorization") !== "Bearer par_0558") return Response.json({ error: "unauthorized" }, { status: 401 });
    const path = new URL(req.url).pathname;
    if (path === "/v1/messages/m1") {
      return Response.json({ id: "m1", sender_display: NAME, content: { text: `call ${NAME} at ${PHONE} or ${MAIL}` } });
    }
    if (path === "/v1/works/w1") return Response.json({ id: "w1", title: "transfer drill", status: "open" });
    if (path === "/v1/threads/t1" && req.method === "GET") return Response.json({ id: "t1", peer_handle: null });
    if (path === "/v1/threads/t1/reply" && req.method === "POST") {
      replies.push(((await req.json()) as { text?: string }).text ?? "");
      return Response.json({ status: "sent", message_id: "m2", thread_id: "t1" });
    }
    return new Response("not found", { status: 404 });
  },
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "openroly-0558-")));
const secretsPath = join(root, "secrets.json");
writeFileSync(secretsPath, JSON.stringify([NAME]));
chmodSync(secretsPath, 0o600);
const DENY_SECRETS = `(version 1)(allow default)(deny file-read* (literal "${secretsPath}"))`;

const env = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: root,
  OPENROLY_HOME: join(root, "home"),
  OPENROLY_BROKER_HOME: join(root, "broker"),
  OPENROLY_TOKEN: "par_0558",
  OPENROLY_URL: `http://localhost:${stub.port}`,
  OPENROLY_SECRETS_PATH: secretsPath,
  ...extra,
});

// broker の egress proxy の役: token が合う CONNECT だけ 200 を返し、外の server の stdio へ素通し。違えば 1 byte も書かずに切る
const proxy: Server = createServer((socket) => {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    socket.off("data", onData);
    if (!head.subarray(0, end).toString("latin1").includes(`\r\nProxy-Authorization: Bearer ${TOKEN}`)) return void socket.destroy();
    const outside = Bun.spawn({ cmd: ["bun", SERVER], env: env({ OPENROLY_SESSION_ID: "req_outside" }), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const rest = head.subarray(end + 4);
    if (rest.length > 0) outside.stdin.write(rest);
    socket.on("data", (d: Buffer) => {
      outside.stdin.write(d);
      void outside.stdin.flush();
    });
    socket.on("close", () => outside.kill());
    void (async () => {
      const reader = outside.stdout.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) socket.write(r.value);
      socket.end();
    })();
  };
  socket.on("data", onData);
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as { port: number }).port;

afterAll(() => {
  stub.stop(true);
  proxy.close();
  rmSync(root, { recursive: true, force: true });
});

/** runtime が起こす形: seatbelt(secrets.json を deny)の中の `bun server.ts` に relay の env */
async function relay(extra: Record<string, string>) {
  const cmd = isDarwin ? { command: "/usr/bin/sandbox-exec", args: ["-p", DENY_SECRETS, "bun", SERVER] } : { command: "bun", args: [SERVER] };
  const transport = new StdioClientTransport({ ...cmd, env: env(extra), stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: "relay-0558", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const readText = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("PBI-0558: sandbox の中の relay 越しに、辞書を読める外の server で本文を読む", () => {
  test("AC-1 / AC-2: inbox_read は辞書の語・電話番号・mail address が 0 回で読め、reply の placeholder は送信本文で戻る", async () => {
    const s = await relay({ OPENROLY_MCP_RELAY: `127.0.0.1:${proxyPort}`, OPENROLY_MASK_TOKEN: TOKEN, OPENROLY_SESSION_ID: "req_relay" });
    try {
      const r = await s.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
      expect(r.isError ?? false).toBe(false);
      const out = JSON.stringify(r);
      for (const raw of [NAME, PHONE, MAIL]) expect({ raw, leaked: out.includes(raw) }).toEqual({ raw, leaked: false });
      expect(out).toContain("⟨s:");
      expect(out).not.toContain("masking_unavailable");
      const sent = await s.client.callTool({ name: "reply", arguments: { thread_id: "t1", text: "Told ⟨s:0⟩ ok" } });
      expect(sent.isError ?? false).toBe(false);
      expect(replies).toContain(`Told ${NAME} ok`);
      expect(s.stderr()).not.toContain("masking server not reachable");
    } finally {
      await s.client.close();
    }
    if (isDarwin) {
      const cat = spawnSync("/usr/bin/sandbox-exec", ["-p", DENY_SECRETS, "cat", secretsPath], { encoding: "utf8" });
      expect(cat.status).not.toBe(0);
      expect(cat.stderr).toContain("Operation not permitted");
    }
  }, 60_000);

  test.skipIf(!isDarwin)(
    "AC-X1: relay 先に誰も居ない / token が違い何も返されずに切られる → 中の server に戻り、本文 tool は masking_unavailable・work の tool は動く・理由が masking.txt に 1 行",
    async () => {
      const nobody = createServer();
      await new Promise<void>((r) => nobody.listen(0, "127.0.0.1", r));
      const deadPort = (nobody.address() as { port: number }).port;
      await new Promise((r) => nobody.close(r));
      const cases = [
        { id: "req_no_listener", OPENROLY_MCP_RELAY: `127.0.0.1:${deadPort}`, OPENROLY_MASK_TOKEN: TOKEN },
        { id: "req_wrong_token", OPENROLY_MCP_RELAY: `127.0.0.1:${proxyPort}`, OPENROLY_MASK_TOKEN: "not-the-token" },
      ];
      for (const { id, ...extra } of cases) {
        const s = await relay({ ...extra, OPENROLY_SESSION_ID: id });
        try {
          const r = await s.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
          expect({ id, text: readText(r) }).toMatchObject({ id, text: expect.stringContaining("masking_unavailable") });
          expect(JSON.stringify(r)).not.toContain(NAME);
          const got = await s.client.callTool({ name: "work_get", arguments: { work_id: "w1" } });
          expect(readText(got)).toContain("transfer drill");
          expect(readFileSync(join(root, "broker", "sessions", id, "masking.txt"), "utf8")).toStartWith("masking: unavailable — ");
        } finally {
          await s.client.close();
        }
      }
    },
    90_000,
  );
});
