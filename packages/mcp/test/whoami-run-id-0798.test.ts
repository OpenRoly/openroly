import { afterAll, describe, expect, test } from "bun:test";
import { createAccountTools } from "../src/tools.ts";

// PBI-0798 / dogfood F108: work_proof は「自分の run id を名乗れ、work から読んだ値を写すな」と
// 要求するのに、自分の run id を教える口が work_accept(transfer / fork)しか無かった。
// 普通に claim して働く道では、通る値は 1 つしかなく、それは説明書が禁じている値だった。

/** works を読めない stub —— whoami が work を一度も読まない事を測る為に 500 を返す */
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/whoami") return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
    if (path === "/v1/inbox/messages") return Response.json([]);
    return new Response("nope", { status: 500 });
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

const whoamiWith = (runtimeKind?: string) =>
  createAccountTools({ baseUrl: base, token: "t", ...(runtimeKind ? { runtimeKind } : {}) }).whoami() as Promise<
    Record<string, unknown>
  >;

describe("whoami が自分の run id を名乗れるようにする(PBI-0798)", () => {
  test("AC-1: claim に使うのと同じ名前を返す", async () => {
    expect((await whoamiWith("claude")).run_id).toBe("mcp-claude");
    expect((await whoamiWith("codex")).run_id).toBe("mcp-codex");
  });

  test("AC-2: work を一度も読まずに出る(/v1/works が 500 でも同じ値)", async () => {
    // stub は /v1/whoami と /v1/inbox/messages 以外を 500 にしている ——
    // work を読む実装なら、この呼び出しはそもそも通らない
    await expect(whoamiWith("claude")).resolves.toMatchObject({ run_id: "mcp-claude", handle: "aya" });
  });

  test("AC-3: kind が分からなくても黙らない — claim と同じ既定を名乗る", async () => {
    expect((await whoamiWith()).run_id).toBe("mcp-runtime");
  });

  test("AC-4(回帰): unread / requests の数は今までどおり", async () => {
    await expect(whoamiWith("claude")).resolves.toMatchObject({ unread: 0, requests: 0 });
  });
});
