import { afterAll, describe, expect, test } from "bun:test";
import { apiCall } from "../src/api.ts";

// PBI-0234 の有界レビュー。
//
// 「`whoami` は待つ上限を持つ」(決め事 3)は、**`apiCall` が `signal` を `fetch` へ渡して初めて**
// 効く。ところが機械検査も CLI の攻撃 test も**呼び出し元(openroly.ts)しか見ていなかった**ので、
// 伝播の 1 行を消しても両方とも緑のままだった(実測)。上限そのものをここで測る。

const slow = Bun.serve({
  port: 0,
  // server 側から切らない —— 切ると「上限が効いた」と「server が諦めた」が区別できない
  idleTimeout: 255,
  fetch: async () => {
    await Bun.sleep(3_000);
    return Response.json({ handle: "aya" });
  },
});
const BASE = `http://localhost:${slow.port}`;
afterAll(() => slow.stop(true));

describe("apiCall: 呼び手の上限が fetch まで届く", () => {
  test("上限を渡すと、応答が来るより先に切れる", async () => {
    const started = Date.now();
    await expect(apiCall(BASE, "/v1/whoami", { signal: AbortSignal.timeout(300) })).rejects.toThrow();
    // 3s の応答を待たずに戻る(伝播が無いと 3s 経ってから 200 で解決してしまう)
    expect(Date.now() - started).toBeLessThan(2_500);
  }, 30_000);

  test("既に abort された signal なら、応答を待たずに落ちる", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(apiCall(BASE, "/v1/whoami", { signal: ac.signal })).rejects.toThrow();
  }, 30_000);

  test("渡さなければ従来どおり —— 遅くても待って 200 を受け取る", async () => {
    const res = await apiCall<{ handle: string }>(BASE, "/v1/whoami", {});
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe("aya");
  }, 30_000);
});
