import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAccountUrl, saveCredential } from "../src/credentials.ts";
import {
  accountBaseUrl,
  DEFAULT_BASE_URL,
  installRuntime,
  doctorRuntime,
  uninstallRuntime,
} from "../src/install.ts";
import {
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type RegisterInput,
  type ExtensionAdapter,
} from "../src/contract.ts";

// AC-13: 診断(diagnostics)。credential が revoke 済み(401)なら「再 pair せよ」を出す。
// runtime CLI に依存せず engine の判定だけを見るため、fake adapter を使う。

let revoked = false;
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (revoked) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
  },
});
const base = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

const calls: string[] = [];
const registered: RegisterInput[] = [];
const fakeAdapter: ExtensionAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: STAGE0_CAPABILITIES,
  detect: async () => ({ installed: true, detail: "fake 1.0.0" }),
  register: async (_ctx, input) => {
    calls.push("register");
    registered.push(input);
  },
  unregister: async () => {
    calls.push("unregister");
  },
  doctor: async () => [{ ok: true, label: "MCP 登録", detail: "あり" }],
  extensionKinds: ["mcp"],
  listExtensions: async () => [],
  applyExtension: async () => {},
  exportExtensions: async () => [],
  watchPaths: () => [],
};
const ctx: AdapterContext = { env: {} };

async function envWithCredential() {
  // OPENROLY_BINARY_BASE_URL は誰も listen していない port に向ける —— installRuntime は
  // binary(PBI-0137)を取りに行くので、指定しないと unit test が公開 Release を叩く
  const env = {
    OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-doctor-")),
    OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1",
  };
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_1",
      token: "par_x",
      base_url: base,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    env,
  );
  return env;
}

describe("doctor", () => {
  test("未 pair なら pairing を促す", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-doctor-")) };
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env });
    const credential = findings.find((f) => f.label === "credential")!;
    expect(credential.ok).toBe(false);
    expect(credential.detail).toContain("openroly install claude");
  });

  test("credential が有効なら全て OK", async () => {
    revoked = false;
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env: await envWithCredential() });
    expect(findings.every((f) => f.ok)).toBe(true);
    expect(findings.map((f) => f.label)).toContain("Account connection");
  });

  test("revoke 済み credential は失効として検出し再 pair を促す(要件 §15.3)", async () => {
    revoked = true;
    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env: await envWithCredential() });
    const connection = findings.find((f) => f.label === "Account connection")!;
    expect(connection.ok).toBe(false);
    expect(connection.detail).toContain("revoked");
    revoked = false;
  });
});

describe("uninstall", () => {
  test("MCP 登録とローカル credential の両方を落とす", async () => {
    const env = await envWithCredential();
    const outcome = await uninstallRuntime({ adapter: fakeAdapter, ctx, env });
    expect(outcome).toEqual({ unregistered: true, credentialRemoved: true });
    expect(calls).toContain("unregister");
    // 2 回目は credential が無い
    expect((await uninstallRuntime({ adapter: fakeAdapter, ctx, env })).credentialRemoved).toBe(false);
  });
});

// ---- PBI-0004 ----

// pairing まで応答する 2 台目。--url で「別の Account server」を指した状況を作る
const other = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pair/start") {
      return Response.json(
        {
          device_code: "pdc_other",
          user_code: "WXYZ6789",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          expires_in: 600,
          interval: 2,
          verification_uri: "http://localhost:5173/connect",
        },
        { status: 201 },
      );
    }
    if (path === "/v1/pair/claim") {
      return Response.json({ status: "approved", token: "par_other", runtime_id: "rt_other" });
    }
    return Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 });
  },
});
const otherBase = `http://localhost:${other.port}`;
afterAll(() => other.stop(true));

const installOptions = (env: { OPENROLY_HOME: string; OPENROLY_BINARY_BASE_URL: string }, baseUrl: string) => ({
  adapter: fakeAdapter,
  ctx,
  env,
  baseUrl,
  onPrompt: () => {},
  sleep: async () => {},
  now: () => 0,
});

describe("install の base URL 解決", () => {
  test("AC-8: --url が既存 credential と違う server を指したら pair し直す", async () => {
    revoked = false;
    const env = await envWithCredential(); // base_url = stub(= 旧 server)
    const outcome = await installRuntime(installOptions(env, otherBase));

    expect(outcome.status).toBe("installed");
    expect(outcome.status === "installed" && outcome.paired).toBe(true);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(otherBase);
    // runtime に登録される URL も新 server でなければ意味がない
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });

  test("AC-16: --url / OPENROLY_URL が無ければ既存 credential の server を尊重する", async () => {
    revoked = false;
    const env = await envWithCredential(); // base_url = stub(既定値 localhost:8787 ではない)
    // CLI は URL 未指定なら baseUrl を渡さない。ここで既定値に潰すと、リモートに
    // pair 済みの人が引数無しで install しただけで localhost へ張り替わる
    const outcome = await installRuntime({
      adapter: fakeAdapter,
      ctx,
      env,
      onPrompt: () => {},
      sleep: async () => {},
      now: () => 0,
    });
    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(base);
    expect(registered.at(-1)?.baseUrl).toBe(base);
  });

  test("AC-9: 同じ server なら有効な credential を再利用する(pair し直さない)", async () => {
    revoked = false;
    const env = await envWithCredential();
    await installRuntime(installOptions(env, otherBase)); // まず otherBase へ寄せる
    const outcome = await installRuntime(installOptions(env, otherBase));

    expect(outcome.status === "installed" && outcome.paired).toBe(false);
    expect(outcome.status === "installed" && outcome.credential.token).toBe("par_other");
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });
});

describe("uninstall の失敗理由", () => {
  test("AC-12: unregister の失敗を握り潰さず detail に載せる", async () => {
    const broken: ExtensionAdapter = {
      ...fakeAdapter,
      unregister: async () => {
        throw new Error("claude mcp remove failed: command not found");
      },
    };
    const env = await envWithCredential();
    const outcome = await uninstallRuntime({ adapter: broken, ctx, env });

    expect(outcome.unregistered).toBe(false);
    expect(outcome.detail).toContain("command not found");
    // credential 側は消えている(runtime CLI の故障に引きずられない)
    expect(outcome.credentialRemoved).toBe(true);
  });
});

// ---- PBI-0246: URL は account に 1 つ(図7.1) ----

describe("accountBaseUrl の優先順(図7.1)", () => {
  const EXPLICIT = "https://explicit.example";
  const SAVED = "https://saved.example";
  const CRED = "https://cred.example";

  const home = async () => ({ OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-url-")) });

  test("AC-3: 明示(--url / $OPENROLY_URL)は他の全部に勝つ", async () => {
    const env = await home();
    await saveAccountUrl(SAVED, env);
    expect(await accountBaseUrl(EXPLICIT, CRED, env)).toBe(EXPLICIT);
    // 末尾の / は 1 箇所で落とす
    expect(await accountBaseUrl(`${EXPLICIT}/`, CRED, env)).toBe(EXPLICIT);
  });

  test("AC-1: 明示が無ければ account の URL。**呼び手の credential より前**", async () => {
    const env = await home();
    await saveAccountUrl(SAVED, env);
    // credential は「その runtime が昔居た server」であって、今 login している account ではない
    expect(await accountBaseUrl(undefined, CRED, env)).toBe(SAVED);
    // まだ pair していない runtime(credential 無し)にも効くのがこの PBI の要点
    expect(await accountBaseUrl(undefined, undefined, env)).toBe(SAVED);
  });

  test("AC-4: login していなければ credential → 既定の順(今までと同じ)", async () => {
    const env = await home();
    expect(await accountBaseUrl(undefined, CRED, env)).toBe(CRED);
    expect(await accountBaseUrl(undefined, undefined, env)).toBe(DEFAULT_BASE_URL);
  });
});

describe("install が account の URL を継ぐ(図7.1)", () => {
  test("AC-2: まだ pair していない runtime でも account の URL に pair しに行く", async () => {
    revoked = false;
    // credential が 1 つも無い端末 = README の quickstart の状態
    const env = {
      OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-install-url-")),
      OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1",
    };
    await saveAccountUrl(otherBase, env);

    const outcome = await installRuntime({
      adapter: fakeAdapter,
      ctx,
      env,
      onPrompt: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(outcome.status === "installed" && outcome.paired).toBe(true);
    // 既定値(localhost:8787)へ落ちていない
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(otherBase);
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });

  test("AC-2: doctor は未 pair の runtime にも行き先の URL を名乗る", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-doctor-url-")) };
    await saveAccountUrl(otherBase, env);

    const findings = await doctorRuntime({ adapter: fakeAdapter, ctx, env });
    const credential = findings.find((f) => f.label === "credential")!;

    expect(credential.ok).toBe(false);
    expect(credential.detail).toContain(otherBase);
    expect(credential.detail).not.toContain(DEFAULT_BASE_URL);
  });

  test("AC-3: install でも --url の明示が account の URL に勝つ", async () => {
    revoked = false;
    const env = {
      OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-install-explicit-")),
      OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1",
    };
    // account は stub(= base)を指しているが、明示は other。credential はまだ無い
    await saveAccountUrl(base, env);

    const outcome = await installRuntime(installOptions(env, otherBase));

    expect(outcome.status === "installed" && outcome.paired).toBe(true);
    expect(outcome.status === "installed" && outcome.credential.base_url).toBe(otherBase);
    expect(registered.at(-1)?.baseUrl).toBe(otherBase);
  });
});
