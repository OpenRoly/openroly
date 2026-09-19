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

  test("AC-1 補足 / PBI-0558 AC-3: 電話番号も server.ts の json() で pattern mask される(model にも log にも生で出ない)", async () => {
    // placeholder は ⟨s:n⟩ の 1 種のみ(openroly-mask)。PBI-0558 までは json() が辞書だけを掛け、電話番号は生で model に
    // 届いていた(REQ-69 のずれ)。今は Masker(辞書 + pattern)なので、model が見た面にも peek にも番号は 0 回
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
    expect(text(read)).not.toContain(PHONE);
    expect(row1.output).not.toContain(PHONE);
    expect(text(read)).toContain("⟨s:1⟩"); // 辞書が ⟨s:0⟩、見つかった番号がその次
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
    // PBI-0558 AC-3: 電話番号も pattern で伏せる(辞書が ⟨s:0⟩、見つかった番号がその次)
    expect(JSON.parse(text(read))).toMatchObject({ id: "m1", content: { text: `call ${PLACEHOLDER} at ⟨s:1⟩` } });
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

// PBI-0644: broker が先に置いた peek file に足す形(C1 = 専用 uid の session)。
// **持ち主は broker** なので session 側は chmod できない —— 既に 0600 なら打たない、が性質。
describe("openPeek(既に在る peek file・PBI-0644)", () => {
  test("broker が置いた 0600 の file には chmod を打たずに足す(前の行を消さない)", async () => {
    const { home } = await fixture();
    try {
      const { openPeek } = await import("../src/peek.ts");
      const dir = join(home, "sessions", "req_pre");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "peek.jsonl");
      writeFileSync(path, '{"session":"req_pre","turn":1}\n', { mode: 0o600 });
      chmodSync(path, 0o600);
      // **chmod を打たない事そのものは e2e が測る**(C1 の session は所有者でないので、打てば
      // EPERM で peek ごと落ちる = `scripts/e2e-auto-session.sh` の PBI-0224 step が赤)。
      // ここが測るのは、その形で前の行が消えず 0600 のまま足される事
      const peek = openPeek({ OPENROLY_SESSION_ID: "req_pre" }, home);
      expect(peek).not.toBeNull();
      peek!.record({ tool: "inbox_read", input: {}, output: "ok" });
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
      // 前の turn の行 + header + record
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0]!)).toMatchObject({ turn: 1 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("0644 で在る file は 0600 に寄せる(負の対照: 条件を外すと緩いまま)", async () => {
    const { home } = await fixture();
    try {
      const { openPeek } = await import("../src/peek.ts");
      const dir = join(home, "sessions", "req_loose");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "peek.jsonl");
      writeFileSync(path, "", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(openPeek({ OPENROLY_SESSION_ID: "req_loose" }, home)).not.toBeNull();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// PBI-0229 の tool 報告(hook socket)。openSessionUpdate は in-process で直接叩く
// (送信の上流は broker の cargo test が根拠。ここが測るのは「止めない」側 = fail-open)
describe("openSessionUpdate(MCP 側・PBI-0229 AC-X2)", () => {
  test("OPENROLY_SESSION_ID が無ければ null(manual session は何もしない)", async () => {
    const { home } = await fixture();
    try {
      const { openSessionUpdate } = await import("../src/peek.ts");
      expect(openSessionUpdate({}, home)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("id が境界外(dir traversal・過長)なら null", async () => {
    const { home } = await fixture();
    try {
      const { openSessionUpdate } = await import("../src/peek.ts");
      expect(openSessionUpdate({ OPENROLY_SESSION_ID: "../escape" }, home)).toBeNull();
      expect(openSessionUpdate({ OPENROLY_SESSION_ID: "a".repeat(65) }, home)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("socket が無い端末でも function を返し、呼んでも throw しない(fail-open・fire-and-forget)", async () => {
    const { home } = await fixture();
    try {
      const { openSessionUpdate } = await import("../src/peek.ts");
      const report = openSessionUpdate({ OPENROLY_SESSION_ID: "req_hook" }, home);
      expect(report).not.toBeNull();
      // broker 未起動 = connect error。それでも tool 実行側は止まらない
      expect(() => report!("inbox_read")).not.toThrow();
      // socket が出来るのを待たずに終わっても process が落ちない(error handler 済み)
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// PBI-0230: hub turn dir への peek。broker が hub wake の env に載せる OPENROLY_SESSION_DIR を
// 優先して使う事と、env は信頼境界の外なので門(絶対 path・home/sessions 配下・.. 禁止)を
// 持つ事を in-process で検査する(server.ts → openPeek の env 受け渡しは OS が担う)
// 負の対照(実測): checkedSessionDir の .. 検査を外すと「門外は null・file を作らない」が赤
describe("OPENROLY_SESSION_DIR(hub turn dir・PBI-0230)", () => {
  test("home/sessions/hub 配下ならそこに peek.jsonl が落ち、標準位置には作らない", async () => {
    const { home } = await fixture();
    try {
      const { openPeek } = await import("../src/peek.ts");
      const dir = join(home, "sessions", "hub", "acc-hub", "claude");
      mkdirSync(dir, { recursive: true });
      const peek = openPeek({ OPENROLY_SESSION_ID: "req_hub", OPENROLY_SESSION_DIR: dir }, home);
      expect(peek).not.toBeNull();
      peek!.record({ tool: "inbox_read", input: { message_id: "m1" }, output: "masked" });
      const lines = readFileSync(join(dir, "peek.jsonl"), "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ session: "req_hub" });
      expect(JSON.parse(lines[1]!)).toMatchObject({ tool: "inbox_read" });
      // 標準位置(sessions/<id>/)には落ちない(2 箇所に散らばらない)
      expect(existsSync(join(home, "sessions", "req_hub"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("門外(相対 / sessions 自身 / .. / broker home の外)は stderr 1 行で null・file を作らない(fail-open)", async () => {
    const { home } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "openroly-peek-out-"));
    try {
      const { openPeek } = await import("../src/peek.ts");
      const cases = [
        "sessions/hub/acc/claude", // 相対 path
        join(home, "sessions"), // leaf 無し(peek.jsonl が sessions 直下に散る)
        `${home}/sessions/../escape`, // .. を含む(join が正規化して消すので生文字列で作る)
        join(outside, "hub", "acc", "claude"), // broker home の外
      ];
      for (const dir of cases) {
        expect(openPeek({ OPENROLY_SESSION_ID: "req_bad", OPENROLY_SESSION_DIR: dir }, home)).toBeNull();
      }
      // どの case も標準位置へフォールバックしていない(怪しい env は黙って別の場所に書かない)
      expect(existsSync(join(home, "sessions", "req_bad"))).toBe(false);
      expect(existsSync(join(outside, "hub"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
