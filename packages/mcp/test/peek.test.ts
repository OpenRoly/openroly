import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskText } from "openroly-mask";

// PBI-0224 `openroly peek` の MCP 側(AC-1 / AC-5 / AC-X2 / AC-X3)。
// broker が dedicated session の env に載せる OPENROLY_SESSION_ID を受けた MCP server が、model に返した
// masked 済み text そのものを session_dir/peek.jsonl に 1 行ずつ残す。値は一度も復元されない。
// 実 server は立てず、fake HTTP API(Bun.serve)+ tmp の OPENROLY_BROKER_HOME + secrets.json fixture。

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const SECRET = "山田太郎";
const PHONE = "090-1234-5678";
const BODY = `call ${SECRET} at ${PHONE}`;
const SECRETS = [SECRET];
const PLACEHOLDER = maskText(SECRET, SECRETS); // ⟨s:0⟩(secrets 1 件)

/** reply が最終的に server へ POST した text(restore 後)。log には**入らない**方の値 */
const repliesReceived: string[] = [];

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== "Bearer par_peek") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (path === "/v1/whoami") return Response.json({ agent_id: "agt_x", handle: "aya", unread: 1 });
    if (path === "/v1/messages/m1") {
      return Response.json({ id: "m1", sender_display: "Shibu", content: { text: BODY } });
    }
    // **PBI-0261 の追随**(merge 時に足した): reply は seal 先を `GET /v1/threads/:id` の
    // `peer_handle` から引くようになった。この route が無いと reply が「thread が読めないので
    // 送らない」で throw し、**peek の行が 1 本足りない**(3 行のはずが 2 行)。
    // `peer_handle: null` = 外部 peer 相当 = 平文 —— この test が測るのは peek に写る面であって
    // 封の中身ではないので、封をしない枝で足りる
    if (path === "/v1/threads/t1" && req.method === "GET") {
      return Response.json({ id: "t1", peer_handle: null });
    }
    if (path === "/v1/threads/t1/reply" && req.method === "POST") {
      const body = (await req.json()) as { text?: string };
      repliesReceived.push(body.text ?? "");
      return Response.json({ status: "sent", message_id: "m2", thread_id: "t1" });
    }
    // /v1/handles/aya/account-key → 404 = 宛先が account 鍵を持たない = 平文 fallback(E2EE の設計どおり)
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => stub.stop(true));

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "openroly-peek-"));
  const secretsPath = join(home, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify(SECRETS));
  chmodSync(secretsPath, 0o600);
  return { home, secretsPath };
}

interface Session {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

async function connect(env: Record<string, string>): Promise<Session> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      // stderr の pipe が閉じるまで一瞬待つ(close 直後は最後の行が届いていない事がある)
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

const text = (result: any): string => result.content[0].text as string;

describe("peek.jsonl(MCP 側・PBI-0224)", () => {
  test("AC-1: dedicated session の tool 往復が model と同じ masked 形で 0600 の peek.jsonl に残り、値は 0 回", async () => {
    const { home, secretsPath } = await fixture();
    const session = await connect({
      OPENROLY_TOKEN: "par_peek",
      OPENROLY_URL: `http://localhost:${stub.port}`,
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: home,
      OPENROLY_SECRETS_PATH: secretsPath,
      OPENROLY_RUNTIME_KIND: "claude",
      OPENROLY_SESSION_ID: "req_a",
    });
    const read = await session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
    const replyText = `Told ${PLACEHOLDER} ok`;
    await session.client.callTool({ name: "reply", arguments: { thread_id: "t1", text: replyText } });
    await session.close();

    // model が見た面: 値は placeholder。log の面 = それと同一
    expect(text(read)).toContain(PLACEHOLDER);
    expect(text(read)).not.toContain(SECRET);

    const path = join(home, "sessions", "req_a", "peek.jsonl");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const [header, row1, row2] = lines.map((l) => JSON.parse(l));
    expect(header).toMatchObject({ session: "req_a", runtime: "claude" });
    expect(typeof header.started).toBe("string");
    expect(row1.tool).toBe("inbox_read");
    expect(row1.input).toEqual({ message_id: "m1" });
    expect(row1.output).toBe(text(read)); // 記録 = model に返した text そのもの
    expect(row1.output).toContain(PLACEHOLDER);
    expect(row2.tool).toBe("reply");
    expect(row2.input.text).toBe(replyText); // restore **前**(placeholder 入り)
    // file 全体で値は 0 回。restore 後の値は server へは届いている(= 復元は log を迂回して動いている)
    expect(raw.split(SECRET).length - 1).toBe(0);
    expect(repliesReceived).toContain(`Told ${SECRET} ok`);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-1 補足: 電話番号は server.ts の json() では pattern mask されない(model にもそのまま渡っている)= log も同じ面", async () => {
    // PBI 本文の「⟨p:…⟩」は openroly-mask に無い placeholder(placeholder は ⟨s:n⟩ の 1 種のみ)。
    // server.ts の json() は静的 secrets の maskValue だけを掛けるので、pattern(電話)は mask されない。
    // peek は「model が見た面」を写す物であって mask を増やす物ではないので、その事実をここで凍結する
    // (server.ts が pattern mask を掛ける様になったらこの test が赤くなり、log も同時に変わる)。
    const { home, secretsPath } = await fixture();
    const session = await connect({
      OPENROLY_TOKEN: "par_peek",
      OPENROLY_URL: `http://localhost:${stub.port}`,
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: home,
      OPENROLY_SECRETS_PATH: secretsPath,
      OPENROLY_RUNTIME_KIND: "claude",
      OPENROLY_SESSION_ID: "req_phone",
    });
    const read = await session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
    await session.close();
    const [, row1] = readFileSync(join(home, "sessions", "req_phone", "peek.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(text(read).includes(PHONE)).toBe(row1.output.includes(PHONE));
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X3: 同一 session で tool 2 本を同時に呼んでも各行が完全な JSON で残る", async () => {
    const { home, secretsPath } = await fixture();
    const session = await connect({
      OPENROLY_TOKEN: "par_peek",
      OPENROLY_URL: `http://localhost:${stub.port}`,
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: home,
      OPENROLY_SECRETS_PATH: secretsPath,
      OPENROLY_RUNTIME_KIND: "codex",
      OPENROLY_SESSION_ID: "req_par",
    });
    await Promise.all([
      session.client.callTool({ name: "whoami", arguments: {} }),
      session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } }),
    ]);
    await session.close();
    const lines = readFileSync(join(home, "sessions", "req_par", "peek.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const rows = lines.map((l) => JSON.parse(l)); // どれか 1 行でも混ざっていれば throw
    expect(rows[0]).toMatchObject({ session: "req_par", runtime: "codex" });
    expect(new Set(rows.slice(1).map((r) => r.tool))).toEqual(new Set(["whoami", "inbox_read"]));
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-5: OPENROLY_SESSION_ID 無し(manual session)では sessions/ に何も作らず、tool 応答は同一", async () => {
    const { home, secretsPath } = await fixture();
    const session = await connect({
      OPENROLY_TOKEN: "par_peek",
      OPENROLY_URL: `http://localhost:${stub.port}`,
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: home,
      OPENROLY_SECRETS_PATH: secretsPath,
      OPENROLY_RUNTIME_KIND: "claude",
    });
    const read = await session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
    await session.close();
    expect(existsSync(join(home, "sessions"))).toBe(false);
    expect(session.stderr()).not.toContain("peek:");
    // 応答は peek 有りの時と同じ masked 形(mask は peek と独立に効く)
    expect(JSON.parse(text(read))).toMatchObject({ id: "m1", content: { text: `call ${PLACEHOLDER} at ${PHONE}` } });
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: OPENROLY_SESSION_ID が ../x なら stderr に peek: invalid session id、file はどこにも作られず、tool は正常応答", async () => {
    const { home, secretsPath } = await fixture();
    const before = readdirSync(home);
    const session = await connect({
      OPENROLY_TOKEN: "par_peek",
      OPENROLY_URL: `http://localhost:${stub.port}`,
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: join(home, "broker"),
      OPENROLY_SECRETS_PATH: secretsPath,
      OPENROLY_RUNTIME_KIND: "claude",
      OPENROLY_SESSION_ID: "../x",
    });
    const read = await session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
    await session.close();
    expect(text(read)).toContain(PLACEHOLDER);
    expect(session.stderr()).toContain("peek: invalid session id");
    // <broker>/sessions/../x = <broker>/x にも、<home>/x にも、<broker>/sessions にも何も無い
    expect(existsSync(join(home, "broker"))).toBe(false);
    expect(existsSync(join(home, "x"))).toBe(false);
    expect(readdirSync(home).sort()).toEqual(before.sort());
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: broker home が読み取り専用でも tool は正常応答し、stderr に peek: 1 行(fail-open)", async () => {
    const { home, secretsPath } = await fixture();
    const ro = join(home, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      const session = await connect({
        OPENROLY_TOKEN: "par_peek",
        OPENROLY_URL: `http://localhost:${stub.port}`,
        OPENROLY_HOME: home,
        OPENROLY_BROKER_HOME: ro,
        OPENROLY_SECRETS_PATH: secretsPath,
        OPENROLY_RUNTIME_KIND: "claude",
        OPENROLY_SESSION_ID: "req_ro",
      });
      const read = await session.client.callTool({ name: "inbox_read", arguments: { message_id: "m1" } });
      await session.close();
      expect(text(read)).toContain(PLACEHOLDER);
      const peekLines = session.stderr().split("\n").filter((l) => l.startsWith("peek: "));
      expect(peekLines.length).toBe(1);
      expect(existsSync(join(ro, "sessions"))).toBe(false);
    } finally {
      chmodSync(ro, 0o700);
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
