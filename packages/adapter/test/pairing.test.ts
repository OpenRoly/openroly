import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential } from "../src/credentials.ts";
import { pairRuntime } from "../src/pairing.ts";

// AC-6 / AC-7(PBI-0002): device code flow(図 6)。interval を尊重して polling し、
// approved なら credential を書いてから成功を返す。denied / expired を成功にしない。
//
// AC-4〜7(PBI-0004): 人が承認画面を操作している 10 分の間に起きる一過性の失敗で
// pairing を畳まない。畳む時も "expired" を騙らない。

type HttpStep = { __http: number; __body?: unknown };
type ClaimStep = Record<string, unknown> | HttpStep;

/** script の 1 手が「HTTP status を指定した応答」かどうか */
const isHttpStep = (step: ClaimStep): step is HttpStep =>
  typeof (step as HttpStep).__http === "number";

let claims = 0;
let script: ClaimStep[] = [];
const START = {
  device_code: "pdc_test",
  user_code: "ABCD2345",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  expires_in: 6,
  interval: 2,
  verification_uri: "http://localhost:5173/connect",
};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pair/start") return Response.json(START, { status: 201 });
    if (path === "/v1/pair/claim") {
      const step = script[claims] ?? script.at(-1) ?? { status: "pending" };
      claims++;
      if (isHttpStep(step)) {
        return Response.json(step.__body ?? { error: "boom" }, { status: step.__http });
      }
      return Response.json(step);
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

async function pair(steps: ClaimStep[], options: { expiresIn?: number } = {}) {
  claims = 0;
  script = steps;
  START.expires_in = options.expiresIn ?? 6;
  const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-pair-")) };
  let clock = 0;
  let sleeps = 0;
  const prompts: unknown[] = [];
  const outcome = await pairRuntime({
    baseUrl: base,
    kind: "claude",
    name: "MacBook / Claude Code",
    env,
    onPrompt: (p) => prompts.push(p),
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
    },
    now: () => clock,
  });
  return { outcome, env, prompts, polls: claims, sleeps };
}

describe("pairing engine", () => {
  test("PBI-0046 AC-X2: pair/start 自体が不達(fetch reject)でも throw せず、撃ち直しの後 failed を返す", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-pair-")) };
    const sleeps: number[] = [];
    const outcome = await pairRuntime({
      baseUrl: "http://127.0.0.1:9", // 閉じている port
      kind: "claude",
      name: "test",
      onPrompt: () => {
        throw new Error("prompt は出ないはず");
      },
      sleep: async (ms) => void sleeps.push(ms),
      env,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.detail).toContain("cannot connect to http://127.0.0.1:9");
    expect(outcome.detail).toContain("5 times in a row");
    // 生の fetch message(stack trace と見分けが付かない)は出さない
    expect(outcome.detail).not.toContain("Unable to connect");
    // 0.5 → 1 → 2 → 4 秒の backoff で 4 回待って 5 回撃つ
    expect(sleeps).toEqual([500, 1000, 2000, 4000]);
    expect(await getCredential("claude", env)).toBeUndefined();
  });

  test("PBI-0046 AC-X2: pair/start の 4xx は撃ち直さず即 failed(throw しない)", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-pair-")) };
    const bad = Bun.serve({ port: 0, fetch: () => Response.json({ error: "invalid_kind" }, { status: 400 }) });
    try {
      const outcome = await pairRuntime({
        baseUrl: `http://localhost:${bad.port}`,
        kind: "claude",
        name: "test",
        onPrompt: () => {},
        sleep: async () => {},
        env,
      });
      expect(outcome).toEqual({ status: "failed", detail: 'pair/start returned 400: {"error":"invalid_kind"}' });
    } finally {
      bad.stop(true);
    }
  });

  test("承認されるまで interval 秒で polling し、credential を保存してから成功を返す", async () => {
    const { outcome, env, prompts, polls } = await pair([
      { status: "pending" },
      { status: "pending" },
      { status: "approved", token: "par_abc", runtime_id: "rt_1" },
    ]);
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(3);
    expect(prompts[0]).toMatchObject({
      user_code: "ABCD2345",
      verification_uri: START.verification_uri,
      interval: 2,
    });
    // PBI-0237: **code の入った URL は組み立てない**。人に渡せるのは code の文字列だけで、
    // URL は打つ欄だけの定数 path —— prompt のどの field にも code が混ざらない事まで見る
    expect(prompts[0]).not.toHaveProperty("verification_uri_complete");
    // `prompts` は unknown[](実物の形を型で先取りしない)ので、**値として**取り出して見る ——
    // どの field にも code が混ざっていないことまで数える(1 つでも在れば送りつけられる)
    const shown = prompts[0] as Record<string, unknown>;
    for (const value of Object.values(shown)) {
      if (typeof value === "string" && value.includes("http")) expect(value).not.toContain("ABCD2345");
    }
    expect(shown.verification_uri).toBe("http://localhost:5173/connect");
    const saved = await getCredential("claude", env);
    expect(saved).toMatchObject({ runtime_id: "rt_1", token: "par_abc", base_url: base });
  });

  test("human が拒否したら denied を返し credential を書かない", async () => {
    const { outcome, env } = await pair([{ status: "pending" }, { status: "denied" }]);
    expect(outcome.status).toBe("denied");
    expect(await getCredential("claude", env)).toBeUndefined();
  });

  test("期限内に承認されなければ expired(無限 polling しない)", async () => {
    const { outcome, env, polls } = await pair([{ status: "pending" }], { expiresIn: 4 });
    expect(outcome.status).toBe("expired");
    // 0s / 2s / 4s の 3 回。3 回目で deadline に到達して打ち切る
    expect(polls).toBe(3);
    expect(await getCredential("claude", env)).toBeUndefined();
  });

  test("server が expired を返した場合も expired", async () => {
    const { outcome } = await pair([{ status: "expired" }]);
    expect(outcome.status).toBe("expired");
  });

  // ---- PBI-0004 ----

  test("AC-7: 1 回目の poll は interval を待たずに撃つ", async () => {
    const { outcome, polls, sleeps } = await pair([
      { status: "approved", token: "par_abc", runtime_id: "rt_1" },
    ]);
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("AC-4: 一過性の 500 は期限切れにせず polling を続ける", async () => {
    const { outcome, env, polls } = await pair(
      [
        { __http: 500 },
        { status: "pending" },
        { status: "approved", token: "par_abc", runtime_id: "rt_1" },
      ],
      { expiresIn: 60 },
    );
    expect(outcome.status).toBe("paired");
    expect(polls).toBe(3);
    expect((await getCredential("claude", env))?.token).toBe("par_abc");
  });

  test("AC-5: 500 が続いたら failed(expired を騙らない)", async () => {
    const { outcome, polls } = await pair([{ __http: 500 }], { expiresIn: 600 });
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.detail).toContain("500");
    expect(polls).toBe(5);
  });

  test("AC-6: 4xx は retry せず即 failed", async () => {
    const { outcome, polls } = await pair(
      [{ __http: 422, __body: { error: "device_code required" } }],
      { expiresIn: 600 },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.detail).toContain("422");
    expect(polls).toBe(1);
  });

  test("約束外の status は failed(黙って expired にしない)", async () => {
    const { outcome } = await pair([{ status: "teapot" }]);
    expect(outcome.status).toBe("failed");
  });
});

// ---- PBI-0046 再レビュー(有界)の攻撃 test(2026-08-28)。レビューセッションが追加 ----
describe("PBI-0046 再レビュー: AC-X2 攻撃", () => {
  test(
    "pair/start が 2 回不達(503)した後に復旧したら pairing は成功する(撃ち直しが成功を拾う)",
    async () => {
      // 修正の成功経路の裏側: retry が「諦める条件」だけでなく「復旧したら通す」ことも確認する。
      // ここが破れると retry は実質失敗固定で、server の一瞬の揺らぎでも login が必ず死ぬ
      let startCalls = 0;
      const flaky = Bun.serve({
        port: 0,
        fetch: (req) => {
          const path = new URL(req.url).pathname;
          if (path === "/v1/pair/start") {
            startCalls++;
            if (startCalls <= 2) return new Response("down", { status: 503 });
            return Response.json(START, { status: 201 });
          }
          if (path === "/v1/pair/claim") {
            return Response.json({ status: "approved", token: "par_flaky_recovery", runtime_id: "rt_flaky" });
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-pair-")) };
        const sleeps: number[] = [];
        const outcome = await pairRuntime({
          baseUrl: `http://localhost:${flaky.port}`,
          kind: "claude",
          name: "test",
          onPrompt: () => {},
          sleep: async (ms) => void sleeps.push(ms),
          env,
        });
        expect(outcome.status).toBe("paired");
        expect(startCalls).toBe(3);
        // 2 回の失敗の間に backoff(0.5 → 1 秒)を 2 回挟んでいる
        expect(sleeps).toEqual([500, 1000]);
        expect(await getCredential("claude", env)).toMatchObject({
          token: "par_flaky_recovery",
          runtime_id: "rt_flaky",
        });
      } finally {
        flaky.stop(true);
      }
    },
    30_000,
  );
});
