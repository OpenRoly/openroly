import { afterAll, describe, expect, test } from "bun:test";
import { createAccountTools } from "../src/tools.ts";

// PBI-0795 / dogfood F106: whoami が「未読 N」と言う一方、inbox_list の行には
// 未読を表す欄が 1 つも無く、どの行が N なのかを製品が言えなかった。
// server の listThreads は thread ごとの `unread` を既に返している —— MCP が捨てていた。

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/inbox") return new Response("not found", { status: 404 });
    const bucket = url.searchParams.get("bucket");
    const token = req.headers.get("authorization");
    const last = (id: string) => ({
      id,
      content: { text: "secret body" },
      sender_display: "msg sender",
      direction: "in",
      created_at: "2026-09-19T00:00:00.000Z",
      kind: "chat",
      source: null,
    });
    // t-old = unread を寄越さない古い server
    if (token === "Bearer t-old") {
      return Response.json(bucket === "inbox" ? [{ id: "thr_o", peer_display: "Old", last_message: last("msg_o") }] : []);
    }
    if (bucket === "inbox") {
      return Response.json([
        { id: "thr_a", peer_display: "Aya", unread: 2, last_message: last("msg_a") },
        { id: "thr_b", peer_display: "Bo", unread: 0, last_message: last("msg_b") },
      ]);
    }
    return Response.json([{ id: "thr_r", peer_display: "Req", unread: 1, last_message: last("msg_r") }]);
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

const listWith = (token: string) => createAccountTools({ baseUrl: base, token }).inbox_list();

describe("inbox_list が未読の印を運ぶ(PBI-0795)", () => {
  test("AC-1: thread の unread がそのまま行に乗る", async () => {
    const rows = (await listWith("t-me")) as Record<string, unknown>[];
    expect(rows.find((r) => r.thread_id === "thr_a")?.unread).toBe(2);
    expect(rows.find((r) => r.thread_id === "thr_b")?.unread).toBe(0);
  });

  test("AC-2: 寄越さない server では 0 と書かず欄ごと出さない", async () => {
    const rows = (await listWith("t-old")) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect("unread" in rows[0]!).toBe(false);
  });

  test("AC-3: requests bucket の行も同じ欄で出る", async () => {
    const rows = (await listWith("t-me")) as Record<string, unknown>[];
    const req = rows.find((r) => r.bucket === "requests");
    expect(req?.unread).toBe(1);
    // 数の合計が、その一覧の中で辿れる(「未読 3」がどの行かを行だけで言える)
    expect(rows.reduce((n, r) => n + (typeof r.unread === "number" ? r.unread : 0), 0)).toBe(3);
  });

  test("AC-4: 既存の形は変わらない — 本文は出さず、thread_id / bucket / sender_display は thread 側", async () => {
    const rows = (await listWith("t-me")) as Record<string, unknown>[];
    for (const r of rows) {
      expect("content" in r).toBe(false);
      expect(typeof r.thread_id).toBe("string");
      expect(["inbox", "requests"]).toContain(r.bucket);
    }
    expect(rows.find((r) => r.thread_id === "thr_a")?.sender_display).toBe("Aya");
  });
});
