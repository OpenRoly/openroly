// PBI-0254 有界レビュー(c4)の攻撃 test(`openroly agent` 側)。**実装には触らない**。
// 0253 と 0254 が同じ 1 行(`could not encrypt the reply — …`)に期待を持つので、両方の語が
// 同じ出力に揃って出る事をここで凍結する。stub は agent.test.ts の物を seal 経路の分だけに削った写し。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeyPair } from "@openroly/crypto-envelope";

const CLI = join(import.meta.dir, "../src/openroly.ts");
const PEER = await generateDeviceKeyPair();
const OWN = await generateDeviceKeyPair();
let ownKey: unknown | null = null;
let deviceError: string | null = null;
let calls: { path: string; body: any }[] = [];

const account = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    calls.push({ path: p, body });
    if (p.endsWith("/reply")) return Response.json({ status: "sent" }, { status: 202 });
    if (p.startsWith("/v1/threads/")) {
      return Response.json({ id: "th_1", peer_handle: "bob", messages: [{ id: "m1", direction: "in", content: { text: "hi" } }] });
    }
    if (p.endsWith("/resolve")) return Response.json({ env: { OPENAI_TOKEN: "sk-attack-fixture" } }); // gitleaks:allow
    if (p === "/v1/whoami") return Response.json({ handle: "alice" });
    if (p === "/v1/handles/alice/account-key") {
      return ownKey ? Response.json(ownKey) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (p === "/v1/handles/bob/account-key") return Response.json({ id: "ack_bob", public_key_jwk: PEER.publicJwk });
    if (p === "/v1/me/account-key/grant") return Response.json({ error: "not_found" }, { status: 404 });
    if (p === "/v1/devices") {
      return deviceError ? Response.json({ error: deviceError }, { status: 409 }) : Response.json([]);
    }
    return new Response("not found", { status: 404 });
  },
});
const provider = Bun.serve({
  port: 0,
  fetch: async () => Response.json({ choices: [{ message: { content: "draft" } }] }),
});
afterAll(() => {
  account.stop(true);
  provider.stop(true);
});

async function runCli(): Promise<{ code: number; said: string }> {
  const home = await mkdtemp(join(tmpdir(), "openroly-agent-attack-"));
  await mkdir(join(home, ".openroly"), { recursive: true });
  await writeFile(
    join(home, ".openroly", "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: { "openai-api": { runtime_id: "rt_openai", token: "par_attack", base_url: `http://localhost:${account.port}`, name: "OpenAI (API)" } },
    }),
  );
  const proc = Bun.spawn(["bun", CLI, "agent", "openai", "--thread", "th_1"], {
    env: { ...process.env, HOME: home, OPENROLY_HOME: join(home, ".openroly"), OPENROLY_AGENT_BASE_URL: `http://localhost:${provider.port}`, OPENROLY_NO_BROWSER: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code: await proc.exited, said: out + err };
}
const replies = () => calls.filter((c) => c.path.endsWith("/reply"));

beforeEach(() => {
  calls = [];
  deviceError = null;
  ownKey = { id: "ack_own", public_key_jwk: OWN.publicJwk };
});

describe("openroly agent の失敗の名乗り(PBI-0254 AC-X1 × PBI-0253 AC-X1)", () => {
  test("陽性対照: 揃っていれば reply は envelope で、送信者の鍵が入る", async () => {
    const res = await runCli();
    expect(res.code).toBe(0);
    expect(replies().length).toBe(1);
    expect(replies()[0]!.body.envelope.recipients.map((r: any) => r.device_key_id).sort()).toEqual(["ack_bob", "ack_own"]);
  });

  test("自分の鍵が無い → `could not encrypt` と理由を名乗って exit 1。reply は 1 本も出ない", async () => {
    ownKey = null;
    const res = await runCli();
    expect(res.code).toBe(1);
    expect(res.said).toMatch(/could not encrypt the reply/);
    expect(res.said).toMatch(/has no account key yet/);
    expect(res.said).toMatch(/@alice/); // 誰の鍵が無いかを名指しする
    expect(replies()).toEqual([]);
  });

  test("revoke された device → 0253 の語(revoked / openroly pair)と 0254 の語(could not encrypt)が同じ出力に揃う", async () => {
    deviceError = "device_revoked";
    const res = await runCli();
    expect(res.code).toBe(1);
    expect(res.said).toMatch(/could not encrypt the reply/);
    expect(res.said).toMatch(/revoked from the account/);
    expect(res.said).toMatch(/openroly pair openai-api/); // PBI-0253 review: openroly login は device 鍵に触らない
    expect(replies()).toEqual([]);
    // 平文で送っていないだけでなく、自分の鍵を引く前に止まっている(revoke が先)
    expect(calls.some((c) => c.path === "/v1/handles/alice/account-key")).toBe(false);
  });
});
