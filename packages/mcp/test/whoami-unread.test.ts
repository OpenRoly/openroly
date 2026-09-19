import { afterAll, describe, expect, test } from "bun:test";
import { createAccountTools } from "../src/tools.ts";

// PBI-0707 / dogfood F54: MCP whoami の unread は CLI status と同じ inbox + requests。

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    const token = req.headers.get("authorization");
    if (path === "/v1/whoami") {
      if (token === "Bearer t-me") return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
      if (token === "Bearer t-inbox") return Response.json({ agent_id: "agt_x", handle: "aya", unread: 2 });
      if (token === "Bearer t-401msg") return Response.json({ agent_id: "agt_x", handle: "aya", unread: 3 });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (path === "/v1/inbox/messages") {
      if (token === "Bearer t-401msg") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (token !== "Bearer t-me") return new Response("not found", { status: 404 });
      return Response.json([
        { id: "msg_in", sender_display: "Your AI", bucket: "inbox", read: true, direction: "out" },
        { id: "msg_req", sender_display: "Ryosuke Shibuya", bucket: "requests", read: false, direction: "in" },
      ]);
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

describe("MCP whoami unread(PBI-0707)", () => {
  test("AC-1: whoami.unread 0 でも requests 未読 1 なら unread 1", async () => {
    const tools = createAccountTools({ baseUrl: base, token: "t-me" });
    await expect(tools.whoami()).resolves.toMatchObject({ handle: "aya", unread: 1, requests: 1 });
  });

  test("AC-2: messages が 404 なら inbox 件数のまま whoami は落ちない", async () => {
    const tools = createAccountTools({ baseUrl: base, token: "t-inbox" });
    await expect(tools.whoami()).resolves.toMatchObject({ unread: 2, requests: 0 });
  });

  test("AC-X2: messages が 401 でも whoami は inbox 件数を返す", async () => {
    const tools = createAccountTools({ baseUrl: base, token: "t-401msg" });
    await expect(tools.whoami()).resolves.toMatchObject({ unread: 3, requests: 0 });
  });

  test("AC-X1: 別 token は他人の requests を足さない（whoami 自体が 401）", async () => {
    const tools = createAccountTools({ baseUrl: base, token: "t-other" });
    await expect(tools.whoami()).rejects.toThrow(/401/);
  });
});
