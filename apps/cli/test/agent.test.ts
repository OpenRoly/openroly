import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeyPair, open, seal } from "@paa/crypto-envelope";

// `atn agent <provider>`(PBI-0057 / EP-0009 B)。実 provider には到達させない ——
// OpenAI 互換の fake server と stub Account API を立て、CLI が何を送ったかを観測する。

const CLI = join(import.meta.dir, "../src/paa.ts");
const TOKEN = "par_agent_test_token";

// ---- stub Account API ----
let threadResponse: any = null;
let threadStatus = 200;
let resolveQueue: { status: number; body: any }[] = [];
let approvalStatus = "approved";
let replyResponse: { status: number; body: any } = { status: 202, body: { status: "sent" } };
let accountCalls: { path: string; body: any }[] = [];
// 相手 handle の device 一覧。空 = 相手に device 無し = 平文 fallback(攻撃 test で差し替える)
/** 宛先 account の seal 先(PBI-0247: account 鍵 1 本。null = 鍵なし → 平文 fallback) */
let peerAccountKey: { id: string; public_key_jwk: unknown } | null = null;
/** POST /v1/devices を 409 にする(PBI-0253)。null = 従来どおり通る */
let deviceRegisterError: string | null = null;
/**
 * 送信者(= この agent の owner)の account 鍵。PBI-0254 で seal 経路が **grant ではなく
 * handle 経由の公開鍵**を引く様になったので、stub 側にも自分の鍵と whoami が要る。
 * null にすると「自分の鍵がまだ無い」= 送信を止める(平文にはしない)経路になる。
 */
let ownAccountKey: { id: string; public_key_jwk: unknown } | null = null;
const OWN_HANDLE = "alice";

const account = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    accountCalls.push({ path: url.pathname, body });
    if (url.pathname.startsWith("/v1/threads/") && url.pathname.endsWith("/reply")) {
      return Response.json(replyResponse.body, { status: replyResponse.status });
    }
    if (url.pathname.startsWith("/v1/threads/")) {
      return Response.json(threadResponse, { status: threadStatus });
    }
    if (url.pathname.endsWith("/resolve")) {
      const next = resolveQueue.shift() ?? { status: 200, body: { env: { OPENAI_TOKEN: API_KEY } } };
      return Response.json(next.body, { status: next.status });
    }
    if (url.pathname.startsWith("/v1/approvals/")) {
      return Response.json({ id: "apr_1", status: approvalStatus });
    }
    if (url.pathname === "/v1/whoami") return Response.json({ handle: OWN_HANDLE });
    if (url.pathname.startsWith("/v1/handles/")) {
      const key = url.pathname.startsWith(`/v1/handles/${OWN_HANDLE}/`) ? ownAccountKey : peerAccountKey;
      return key ? Response.json(key) : Response.json({ error: "not_found" }, { status: 404 });
    }
    // 人が承認していない agent には account 鍵の包みが降りてこない(AC-X2)。
    // それでも L1(自分の device 鍵宛)の envelope は device 鍵で開ける
    if (url.pathname === "/v1/me/account-key/grant") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/v1/devices") {
      // 人が Revoke を押した device は自力で戻れない(PBI-0253)。409 の理由は body に載る
      return deviceRegisterError
        ? Response.json({ error: deviceRegisterError }, { status: 409 })
        : Response.json([]);
    }
    return new Response("not found", { status: 404 });
  },
});

// ---- fake provider(OpenAI 互換) ----
let providerCalls: any[] = [];
let providerStatus = 200;
let providerContent = "こちらが下書きです";

const provider = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = await req.json().catch(() => null);
    providerCalls.push({ body, auth: req.headers.get("authorization") });
    if (providerStatus !== 200) return Response.json({ error: "boom" }, { status: providerStatus }); // gitleaks:allow (header 名への誤検知)
    return Response.json({ choices: [{ message: { content: providerContent } }] });
  },
});

/** owner の account 公開鍵(seal を実際に通す必要があるので本物の鍵対から取る) */
const OWN_KEYPAIR = await generateDeviceKeyPair();
const OWN_PUBLIC_JWK = OWN_KEYPAIR.publicJwk;

const API_KEY = "sk-pbi0057-secret"; // gitleaks:allow(test fixture・実在しない key)
const ACCOUNT_URL = `http://localhost:${account.port}`;
const PROVIDER_URL = `http://localhost:${provider.port}`;

afterAll(() => {
  account.stop(true);
  provider.stop(true);
});

async function makeHome(withCredential = true): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "paa-agent-"));
  await mkdir(join(home, ".atn"), { recursive: true });
  if (withCredential) {
    await writeFile(
      join(home, ".atn", "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          "openai-api": {
            runtime_id: "rt_openai",
            token: TOKEN,
            base_url: ACCOUNT_URL,
            name: "OpenAI (API)",
          },
        },
      }),
    );
  }
  return home;
}

async function runCli(home: string, extra: string[] = [], provider: string = "openai") {
  const proc = Bun.spawn(["bun", CLI, "agent", provider, "--thread", "th_1", ...extra], {
    env: {
      ...process.env,
      HOME: home,
      PAA_HOME: join(home, ".atn"),
      PAA_AGENT_BASE_URL: PROVIDER_URL,
      PAA_NO_BROWSER: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code: await proc.exited, out, err };
}

beforeEach(() => {
  accountCalls = [];
  providerCalls = [];
  providerStatus = 200;
  providerContent = "こちらが下書きです";
  resolveQueue = [];
  approvalStatus = "approved";
  replyResponse = { status: 202, body: { status: "sent" } };
  threadStatus = 200;
  peerAccountKey = null;
  deviceRegisterError = null;
  ownAccountKey = { id: "ack_own", public_key_jwk: OWN_PUBLIC_JWK };
  threadResponse = {
    id: "th_1",
    peer_handle: "bob",
    messages: [{ id: "msg_1", direction: "in", content: { text: "会議は何時ですか" } }],
  };
});

describe("atn agent(PBI-0057 AC-1〜AC-5)", () => {
  test("AC-1: 1 turn で provider を 1 回だけ呼び、reply を 1 回送って sent で終わる", async () => {
    const res = await runCli(await makeHome());
    expect(res.code).toBe(0);
    expect(providerCalls.length).toBe(1);
    const sentMessages = providerCalls[0]!.body.messages;
    expect(sentMessages[sentMessages.length - 1]).toEqual({ role: "user", content: "会議は何時ですか" });
    expect(providerCalls[0]!.auth).toBe(`Bearer ${API_KEY}`);
    const replies = accountCalls.filter((c) => c.path.endsWith("/reply"));
    expect(replies.length).toBe(1);
    expect(replies[0]!.body.text).toBe("こちらが下書きです");
    expect(res.out).toContain("Sent");
  });

  test("AC-2: reply が ask_approval_required なら approval_id を出して exit 0", async () => {
    replyResponse = { status: 202, body: { status: "ask_approval_required", approval_id: "apr_9" } };
    const res = await runCli(await makeHome());
    expect(res.code).toBe(0);
    expect(res.out).toContain("ask_approval_required");
    expect(res.out).toContain("apr_9");
  });

  test("AC-3: envelope の message を device key で復号して provider に渡し、Account へ平文を書き戻さない", async () => {
    const home = await makeHome();
    // この端末の device key を作り、その key 宛に seal した message を stub に返させる
    const kp = await generateDeviceKeyPair();
    await writeFile(
      join(home, ".atn", "device-keys.json"),
      JSON.stringify({
        version: 1,
        devices: {
          "openai-api": {
            keyId: kp.keyId,
            publicJwk: kp.publicJwk,
            privateJwk: kp.privateJwk,
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    const envelope = await seal(
      new TextEncoder().encode(JSON.stringify({ text: "暗号化された本文" })),
      [{ keyId: kp.keyId, publicJwk: kp.publicJwk }],
    );
    threadResponse = {
      id: "th_1",
      peer_handle: "bob",
      messages: [{ id: "msg_1", direction: "in", content: { envelope } }],
    };
    const res = await runCli(home);
    expect(res.code).toBe(0);
    const sent = providerCalls[0]!.body.messages;
    expect(sent[sent.length - 1]!.content).toBe("暗号化された本文");
    // 相手に device が無い stub なので reply は平文 fallback(PBI-0006 AC-7)。
    // 「復号した相手の本文」を Account に書き戻していないことを確かめる
    const reply = accountCalls.find((c) => c.path.endsWith("/reply"))!;
    expect(JSON.stringify(reply.body)).not.toContain("暗号化された本文");
  });

  // PBI-0254 AC-2 / AC-X2: **grant される前が agent の既定状態**。承認がまだでも、
  // 送った物には送信者(owner)の account 鍵が入り、owner はそれを自分の鍵で開ける。
  // 前は写しを grant(= 承認済みの秘密鍵)に掛けていたので、初期の送信が全部
  // 「後で承認されても永久に開かない 1 通」だった。
  test("AC-2 / AC-X2: grant が無い agent の reply も owner の account 鍵で開ける", async () => {
    const theirs = await generateDeviceKeyPair();
    peerAccountKey = { id: "ack_bob", public_key_jwk: theirs.publicJwk };

    const res = await runCli(await makeHome());
    expect(res.code).toBe(0);
    // 人はまだ承認していない(stub の grant は 404)
    expect(accountCalls.some((c) => c.path === "/v1/me/account-key/grant")).toBe(false);

    const reply = accountCalls.find((c) => c.path.endsWith("/reply"))!;
    expect(reply.body.text).toBeUndefined();
    const ids = reply.body.envelope.recipients.map((r: any) => r.device_key_id).sort();
    expect(ids).toEqual(["ack_bob", "ack_own"].sort());
    // id が並んでいるだけでは足りない —— owner の秘密鍵で **実際に開く**
    const plain = await open(reply.body.envelope, {
      keyId: "ack_own",
      privateJwk: OWN_KEYPAIR.privateJwk,
    });
    expect(JSON.parse(new TextDecoder().decode(plain)).text).toBe("こちらが下書きです");
  });

  test("AC-X1: owner の account 鍵がまだ無ければ、平文で送らずに失敗する", async () => {
    const theirs = await generateDeviceKeyPair();
    peerAccountKey = { id: "ack_bob", public_key_jwk: theirs.publicJwk };
    ownAccountKey = null;

    const res = await runCli(await makeHome());
    expect(res.code).toBe(1);
    // reply を 1 本も送っていない(平文で残さない)
    expect(accountCalls.filter((c) => c.path.endsWith("/reply"))).toEqual([]);
  });

  test("AC-4: resolve が 202 pending なら承認を待ってから provider を呼ぶ", async () => {
    resolveQueue = [
      { status: 202, body: { status: "pending_approval", approval_id: "apr_1" } },
      { status: 200, body: { env: { OPENAI_TOKEN: API_KEY } } },
    ];
    const res = await runCli(await makeHome(), ["--wait", "10"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Waiting for approval");
    expect(providerCalls.length).toBe(1);
  });

  test("AC-5: --model で既定 model を上書きできる", async () => {
    const res = await runCli(await makeHome(), ["--model", "gpt-x"]);
    expect(res.code).toBe(0);
    expect(providerCalls[0]!.body.model).toBe("gpt-x");
  });
});

describe("atn agent の例外(PBI-0057 AC-X1〜X3)", () => {
  test("AC-X1: credential が無ければ Account も provider も 1 度も叩かずに exit 1", async () => {
    const res = await runCli(await makeHome(false));
    expect(res.code).toBe(1);
    expect(providerCalls.length).toBe(0);
    expect(accountCalls.length).toBe(0);
    expect(res.err).toContain("not connected");
  });

  test("AC-X2: resolve 403 / provider 500 / 空応答 は exit 1 で、出力に API key が出ず reply も送らない", async () => {
    resolveQueue = [{ status: 403, body: { error: "connection_use_denied" } }];
    const denied = await runCli(await makeHome());
    expect(denied.code).toBe(1);
    expect(denied.out + denied.err).not.toContain(API_KEY);
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);

    accountCalls = [];
    providerStatus = 500;
    const failed = await runCli(await makeHome());
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("provider_error(500)");
    expect(failed.out + failed.err).not.toContain(API_KEY);
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);

    accountCalls = [];
    providerStatus = 200;
    providerContent = "   ";
    const empty = await runCli(await makeHome());
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("empty_draft");
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);
  });

  test("AC-X3: 同じ thread に 2 本同時に走らせても device-keys.json が壊れない", async () => {
    const home = await makeHome();
    const [a, b] = await Promise.all([runCli(home), runCli(home)]);
    expect([0, 1]).toContain(a.code);
    expect([0, 1]).toContain(b.code);
    const raw = await readFile(join(home, ".atn", "device-keys.json"), "utf8").catch(() => "{}");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// レビュー(有界)の攻撃 test — 実装コードには触らない。X1/X2/X3 の行を破りに行く
describe("atn agent への攻撃 (PBI-0057 review)", () => {
  test("X1 攻撃: 別 provider の credential には乗り替えられない(agent gemini に openai-api の接続を使わせない)", async () => {
    // credentials.json に openai-api だけ → gemini 呼び出しは未接続で即 exit 1。
    // Account API も provider も 1 回も叩かせない
    const home = await makeHome(); // openai-api のみ
    const res = await runCli(home, [], "gemini");
    expect(res.code).toBe(1);
    expect(res.err).toContain("not connected");
    expect(accountCalls.length).toBe(0);
    expect(providerCalls.length).toBe(0);
  });

  test("X1 攻撃 b: resolve 応答が別 provider の key(OPENAI_TOKEN)を返しても gemini 呼び出しに流用しない", async () => {
    // gemini-api credential を同じ stub に足す。stub の resolve は常に OPENAI_TOKEN を返す
    // (= server 側が取り違えた体)。CLI は GEMINI_TOKEN を探すので鍵の取り違えでは provider を呼ばない
    const home = await makeHome();
    const cred = JSON.parse(await readFile(join(home, ".atn", "credentials.json"), "utf8"));
    cred.runtimes["gemini-api"] = {
      runtime_id: "rt_gemini_atk",
      token: TOKEN,
      base_url: ACCOUNT_URL,
      name: "Gemini (API)",
    };
    await writeFile(join(home, ".atn", "credentials.json"), JSON.stringify(cred));
    const res = await runCli(home, [], "gemini");
    expect(res.code).toBe(1);
    expect(res.err).toContain("connection_resolve_empty");
    expect(providerCalls.length).toBe(0);
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);
  });

  test("X2 攻撃: provider が API key を echo しても CLI 出力に出さない / thread 不在は provider を呼ばない", async () => {
    // provider の応答本文に key が混入した体 → stdout/stderr に出ない(応答本文は reply へ行くだけで出力しない)
    providerContent = `前に貰った key は ${API_KEY} です`;
    const leaked = await runCli(await makeHome());
    expect(leaked.code).toBe(0);
    expect(leaked.out + leaked.err).not.toContain(API_KEY);

    // thread が 404 → provider 呼び出しの前で止まる(key を手にしていても使わない)
    accountCalls = [];
    providerCalls = [];
    threadStatus = 404;
    const noThread = await runCli(await makeHome());
    expect(noThread.code).toBe(1);
    expect(providerCalls.length).toBe(0);
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);
  });

  test("PBI-0253 AC-X1: revoke された device は黙って止まらず、`atn pair openai-api` を名乗って落ちる", async () => {
    // 相手に account 鍵を置くと seal 経路が ensureOwnDevice を通る = POST /v1/devices を打つ
    const theirs = await generateDeviceKeyPair();
    peerAccountKey = { id: "ack_theirs", public_key_jwk: theirs.publicJwk };
    deviceRegisterError = "device_revoked";
    const res = await runCli(await makeHome());
    expect(res.code).toBe(1);
    const said = res.out + res.err;
    expect(said).toMatch(/revoked from the account/);
    expect(said).toMatch(/atn pair openai-api/); // 復帰の手順(= 人が承認し直す pairing)が error 文言そのものに在る(無人の相手が読む)
    // 平文で送っていない(reply が 1 本も出ていない = revoke が本当に止めている)
    expect(accountCalls.filter((c) => c.path.endsWith("/reply")).length).toBe(0);
  });

  test("X3 攻撃: 2 プロセスが同じ kind の device key を同時作成しても 1 つの有効な鍵に収束する", async () => {
    // 相手に account 鍵を置くと seal 経路が ensureOwnDevice を通る = 両プロセスが
    // device-keys.json を同時に作成・読み出す(既存 AC-X3 は平文で鍵ファイルを作らない経路だった)
    const theirs = await generateDeviceKeyPair();
    peerAccountKey = { id: "ack_theirs", public_key_jwk: theirs.publicJwk };
    const home = await makeHome();
    const [a, b] = await Promise.all([runCli(home), runCli(home)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const raw = await readFile(join(home, ".atn", "device-keys.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.devices)).toEqual(["openai-api"]);
    expect(parsed.devices["openai-api"].keyId).toBeString();
    // reply は両方とも envelope(平文 fallback に落ちない)
    const replies = accountCalls.filter((c) => c.path.endsWith("/reply"));
    expect(replies.length).toBe(2);
    for (const r of replies) expect(r.body.envelope).toBeDefined();
  });
});
