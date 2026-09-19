import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// PBI-0334: status / doctor / runtimes / extensions / sync / share の --json。
//  - AC-1/AC-4: stdout **全体**を 1 回で JSON.parse する(進捗行が 1 行混ざっても最終行だけ
//    見れば parse は通ってしまうので、「全体を 1 回で」が測り方の本体)
//  - AC-2: flag 無しは人間向け出力のまま(既定を 1 文字も変えない)
//  - AC-3: NG は文言に埋めず構造(findings/failed/ok:false)で出る
//  - AC-5: status の JSON は全キーを toEqual で固定(本文 key が増えたら赤くなる)
//  - AC-X1: 表示名に " / 改行 / 制御文字を含む相手で全コマンドを 1 周する
//  - AC-X2: error 時も JSON 外枠で返る(半分だけテキストにしない)

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

let desiredResponse: unknown[] = [];
let extensionsGetStatus = 200;
let proposalCalls = 0;

const stub = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/whoami") {
      return Response.json({
        agent_id: "agt_j",
        handle: "jsontest",
        display_name: "JSON Test",
        unread: 3,
        actor: { kind: "runtime", runtime_id: "rt_j" },
      });
    }
    if (url.pathname === "/v1/inbox/messages") {
      return Response.json([
        { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false },
        { id: "msg_2", sender_display: "Shibu", bucket: "inbox", read: false },
        { id: "msg_3", sender_display: 'Bad"Name\n\u0007bell', bucket: "inbox", read: false },
      ]);
    }
    if (url.pathname === "/v1/extensions" && req.method === "GET") {
      return extensionsGetStatus === 200
        ? Response.json(desiredResponse)
        : new Response("boom", { status: extensionsGetStatus });
    }
    if (url.pathname === "/v1/extensions/proposals" && req.method === "POST") {
      proposalCalls += 1;
      return Response.json({ status: "pending" }, { status: 201 });
    }
    const m = url.pathname.match(/^\/v1\/extensions\/([^/]+)\/status$/);
    if (m && req.method === "POST") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});
const baseUrl = `http://localhost:${stub.port}`;
afterAll(() => stub.stop(true));

beforeEach(() => {
  desiredResponse = [];
  extensionsGetStatus = 200;
  proposalCalls = 0;
});

const EVIL = 'evil"quote\nline2\u0001ctl';

async function isolatedHome(name = "openroly-json-"): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

async function seedCredential(
  home: string,
  opts: { runtimeId?: string; credentialName?: string } = {},
): Promise<void> {
  await saveCredential(
    "claude",
    {
      runtime_id: opts.runtimeId ?? "rt_j",
      token: "par_json",
      base_url: baseUrl,
      name: opts.credentialName ?? "rt_j / Claude Code",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
}

async function openroly(args: string[], home: string, extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OPENROLY_HOME: home, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

/** AC-4 の測り方: stdout 全体を 1 回で parse する(部分 parse を許さない) */
function parseDoc(stdout: string): any {
  return JSON.parse(stdout);
}

describe("PBI-0334 --json: status", () => {
  test("AC-1/AC-4/AC-5: 全キーを固定した 1 つの JSON document が stdout だけに出る(本文を含まない)", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    // PBI-0631 の `running` は **この機械で実際に走っている AI** なので、全キーを toEqual で
    // 固定するここでは `ps` を差し替えて空にする(測っているのは key の集合であって機械の中身ではない)
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const res = await openroly(["status", "--json"], home, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    // toEqual が全キーの列挙(AC-5)。SessionBrief は件数だけの形で、本文 key は存在しない
    expect(parseDoc(res.stdout)).toEqual({
      ok: true,
      data: {
        runtimes: [
          {
            kind: "claude",
            name: "rt_j / Claude Code",
            brief: {
              agent_id: "agt_j",
              handle: "jsontest",
              display_name: "JSON Test",
              runtime_id: "rt_j",
              unread: 3,
              senders: [
                { name: "Shibu", count: 2 },
                { name: 'Bad"Name\nbell', count: 1 },
              ],
              requests: 0,
            },
          },
        ],
        // PBI-0229: broker が「いま動いている session」の正本。未接続なら空配列(key は固定で列挙)
        live_sessions: [],
        // PBI-0631: この機械で走っている AI の process。**null(ps が答えない = 分からない)と
        // [](数えて 0 件)を分ける**ので、key は固定で列挙する
        running: [],
      },
    });
    expect(res.stdout).not.toContain("msg_"); // 通知の id も本文側の metadata も載せない
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-2: flag 無しは人間向けのまま(既定を変えない)", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["status"], home);
    expect(res.exitCode).toBe(0);
    // PBI-0424 で人間向けは identity 見出しになった(runtime は下の一覧)。JSON 側は変えていない
    expect(res.stdout).toContain("[Attached runtimes]");
    expect(res.stdout).toContain("Claude Code · rt_j / Claude Code");
    expect(res.stdout).toContain("Unread: 3");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-3: brief の取得に失敗した runtime は error として構造で出る", async () => {
    const home = await isolatedHome();
    // 到達不能な server への credential: fetchBrief が throw し人間向けは「NG <message>」
    await saveCredential(
      "claude",
      {
        runtime_id: "rt_dead",
        token: "par_dead",
        base_url: "http://127.0.0.1:1",
        name: "rt_dead / Claude Code",
        paired_at: new Date().toISOString(),
      },
      { OPENROLY_HOME: home },
    );
    const res = await openroly(["status", "--json"], home);
    expect(res.exitCode).toBe(0); // 人間向けと同じ: 行ごとの NG でコマンドは落ちない
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    // 文言は apiCall 依存。**性質で測る**(PBI-0640 で 1 箇所に集めた) —— 届かない先を名指しし、
    // bun の生 message("Unable to connect. Is the computer able to access the url?")を出さない
    expect(doc.data.runtimes[0].error).toContain("http://127.0.0.1:1");
    expect(doc.data.runtimes[0].error).not.toContain("Unable to connect");
    expect(doc.data.runtimes[0].brief).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  }, 30_000);
});

describe("PBI-0334 --json: extensions / sync", () => {
  test("AC-1/AC-3: extensions は flags を bool で、materializations を構造で出す。0 件は空配列", async () => {
    desiredResponse = [
      {
        id: "ext_a",
        kind: "mcp",
        name: 'we"ird\nname',
        spec: {},
        credential_ref: null,
        enabled: false,
        revision: 3,
        deleted_at: "2026-09-06T00:00:00Z",
        materializations: [{ runtime_id: "rt_j", status: "applied", applied_revision: 2, detail: null }],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["extensions", "--json"], home);
    expect(res.exitCode).toBe(0);
    expect(parseDoc(res.stdout)).toEqual({
      ok: true,
      data: {
        extensions: [
          {
            name: 'we"ird\nname',
            kind: "mcp",
            revision: 3,
            enabled: false,
            deleted: true,
            materializations: [{ runtime_id: "rt_j", status: "applied" }],
          },
        ],
      },
    });

    desiredResponse = [];
    const empty = await openroly(["extensions", "--json"], home);
    expect(parseDoc(empty.stdout)).toEqual({ ok: true, data: { extensions: [] } });
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-2: extensions の人間向け出力は変わらない", async () => {
    desiredResponse = [
      {
        id: "ext_a",
        kind: "mcp",
        name: "github",
        spec: {},
        credential_ref: null,
        enabled: true,
        revision: 3,
        deleted_at: null,
        materializations: [{ runtime_id: "rt_j", status: "applied", applied_revision: 3, detail: null }],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["extensions"], home);
    expect(res.stdout).toContain("github");
    expect(res.stdout).toContain("rev3");
    expect(res.stdout).toContain("rt_j:applied");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-1/AC-3: sync の plan(noop 込み)と failed が構造で出る。1 件でも failed なら ok:false + exit 1", async () => {
    // credential_ref 未解決は native CLI を呼ばずに failed になる経路(extensions.test.ts と同じ手)
    desiredResponse = [
      {
        id: "ext_ok",
        kind: "mcp",
        name: "github",
        spec: { command: "npx", args: ["-y", "gh-mcp"] },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [
          { runtime_id: "rt_j", status: "applied", applied_revision: 1, detail: null },
        ],
      },
      {
        id: "ext_fail",
        kind: "mcp",
        name: 'needs"secret\nnow',
        spec: { command: "npx" },
        credential_ref: "env:MISSING_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home);
    // github は native・DB とも一致させて noop にする(実 claude CLI を spawn させない)
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: {} } },
      }),
    );

    const res = await openroly(["sync", "claude", "--json"], home);
    expect(res.exitCode).toBe(1);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.data.dry_run).toBe(false);
    expect(doc.data.targets).toHaveLength(1);
    expect(doc.data.targets[0].runtime).toBe("claude");
    // noop も plan に残る(機械は自分で filter する)
    expect(doc.data.targets[0].plan).toEqual([
      { action: "noop", name: "github" },
      { action: "install", name: 'needs"secret\nnow' },
    ]);
    expect(doc.data.targets[0].failed).toEqual([
      { name: 'needs"secret\nnow', detail: expect.stringContaining("MISSING_TOKEN") },
    ]);

    // dry-run は data に反映される。reconcile は dry-run では何も適用しないので failed も exit 0 も
    // 人間向けと同じ(dry-run: nothing was written で終わる)
    const dry = await openroly(["sync", "claude", "--json", "--dry-run"], home);
    expect(dry.exitCode).toBe(0);
    const dryDoc = parseDoc(dry.stdout);
    expect(dryDoc.ok).toBe(true);
    expect(dryDoc.data.dry_run).toBe(true);
    expect(dryDoc.data.targets[0].failed).toEqual([]);
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  test("AC-1: 全部 noop の sync は ok:true + exit 0", async () => {
    desiredResponse = [
      {
        id: "ext_ok",
        kind: "mcp",
        name: "github",
        spec: { command: "npx", args: ["-y", "gh-mcp"] },
        credential_ref: null,
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [
          { runtime_id: "rt_j", status: "applied", applied_revision: 1, detail: null },
        ],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: {} } },
      }),
    );
    const res = await openroly(["sync", "claude", "--json"], home);
    expect(res.exitCode).toBe(0);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.data.targets[0].failed).toEqual([]);
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  test("AC-2: sync の人間向け出力は変わらない(NG 行・dry-run 行)", async () => {
    desiredResponse = [
      {
        id: "ext_fail",
        kind: "mcp",
        name: "needs-secret",
        spec: { command: "npx" },
        credential_ref: "env:MISSING_TOKEN",
        enabled: true,
        revision: 1,
        deleted_at: null,
        materializations: [],
      },
    ];
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["sync", "claude", "--dry-run"], home);
    expect(res.stdout).toContain("[Claude Code]"); // runtime 見出し行ごと変わっていない事も見る
    expect(res.stdout).toContain("dry-run: nothing was written");
    const wet = await openroly(["sync", "claude"], home);
    expect(wet.exitCode).toBe(1);
    expect(wet.stdout).toContain("NG needs-secret");
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});

describe("PBI-0334 --json: runtimes / doctor", () => {
  test("AC-1: runtimes は detect / connected を構造で出す", async () => {
    const home = await isolatedHome();
    await seedCredential(home, { runtimeId: "rt_r" });
    const res = await openroly(["runtimes", "--json"], home);
    expect(res.exitCode).toBe(0);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    const claude = doc.data.runtimes.find((r: any) => r.id === "claude");
    expect(Object.keys(claude).sort()).toEqual(["connected", "detected", "display_name", "id", "runtime_id"]);
    expect(claude.connected).toBe(true);
    expect(claude.runtime_id).toBe("rt_r");
    // seed していない runtime は connected:false / runtime_id:null
    const codex = doc.data.runtimes.find((r: any) => r.id === "codex");
    expect(codex.connected).toBe(false);
    expect(codex.runtime_id).toBe(null);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-2: runtimes の人間向け出力は変わらない", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["runtimes"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/claude\s+Claude Code\s+(detected|not detected) \/ connected \(rt_j\)/);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-1/AC-3: doctor は findings を構造で出し、NG が有れば ok:false + exit 1", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const brokerHome = join(home, "broker");
    await mkdir(brokerHome, { recursive: true });

    // sandbox status file が無い = broker 未起動 → broker findings は NG(人間向けと同じ判定)
    const res = await openroly(["doctor", "claude", "--json"], home, { OPENROLY_BROKER_HOME: brokerHome });
    expect(res.exitCode).toBe(1);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(false);
    const broker = doc.data.targets.find((t: any) => t.runtime === "broker");
    expect(broker.findings.every((f: any) => typeof f.ok === "boolean" && f.label && f.detail)).toBe(true);
    expect(broker.findings.every((f: any) => !f.ok)).toBe(true);
    const claude = doc.data.targets.find((t: any) => t.runtime === "claude");
    expect(claude.findings.length).toBeGreaterThan(0);
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  test("AC-X1: sandbox status file の制御文字入り detail が壊れた JSON にならない", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const brokerHome = join(home, "broker");
    await mkdir(brokerHome, { recursive: true });
    await writeFile(
      join(brokerHome, "sandbox-status.json"),
      JSON.stringify({ sandbox: 'seatbeltok"x\ny', egress: "ok" }),
    );
    const res = await openroly(["doctor", "claude", "--json"], home, { OPENROLY_BROKER_HOME: brokerHome });
    const doc = parseDoc(res.stdout); // parse が通ること自体が AC-X1
    const broker = doc.data.targets.find((t: any) => t.runtime === "broker");
    expect(broker.findings[0].detail).toBe('seatbeltok"x\ny'); // 往復して同じ文字列
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  // PBI-0441 AC-1 / AC-X2: broker が status file に書いた egress_enforcement を名乗る。
  // 名乗らない旧 broker は unknown(NG)—— host-scoped と推測して出さない
  test("PBI-0441 AC-1/AC-X2: egress scope は broker の値を名乗り、欠落は unknown", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const brokerHome = join(home, "broker");
    await mkdir(brokerHome, { recursive: true });
    const writeStatus = (status: Record<string, unknown>) =>
      writeFile(join(brokerHome, "sandbox-status.json"), JSON.stringify(status));
    const scopeOf = async () => {
      const res = await openroly(["doctor", "claude", "--json"], home, { OPENROLY_BROKER_HOME: brokerHome });
      const broker = parseDoc(res.stdout).data.targets.find((t: any) => t.runtime === "broker");
      return broker.findings.find((f: any) => f.label === "egress scope");
    };
    await writeStatus({ sandbox: "seatbelt ok", egress: "ok", egress_enforcement: "port_scoped" });
    const port = await scopeOf();
    expect(port).toMatchObject({ ok: true, detail: "port-scoped (a process inside can reach any host on the proxy's port)" });
    // 人間向けの 1 行も同じ語
    const human = await openroly(["doctor", "claude"], home, { OPENROLY_BROKER_HOME: brokerHome });
    expect(human.stdout).toContain("egress scope: port-scoped (a process inside can reach any host on the proxy's port)");
    // AC-X2: 旧 broker(key 無し)
    await writeStatus({ sandbox: "seatbelt ok", egress: "ok" });
    const old = await scopeOf();
    expect(old.ok).toBe(false);
    expect(old.detail).toMatch(/^unknown/);
    // PBI-0441 ③: C1 で claude だけ閉じた端末は、**床の文に claude を名指しで添える** ——
    // 床だけ言うと閉じている事を黙り、床を上げて言うと codex について嘘になる
    await writeStatus({
      sandbox: "seatbelt ok",
      egress: "ok",
      egress_enforcement: "port_scoped",
      egress_enforcement_by_runtime: { claude: "host_scoped" },
    });
    const c1 = await scopeOf();
    expect(c1.detail).toBe(
      "port-scoped (a process inside can reach any host on the proxy's port) — host-scoped for: claude",
    );
    // OK/NG は **床**で決める(claude だけ閉じても「閉じた」とは言わせない)
    expect(c1.ok).toBe(true);
    await rm(home, { recursive: true, force: true });
  }, 90_000);

  // PBI-0331 AC-X3: 同じ「landlock ok」でも kernel ごとに掛かる壁が違うので、broker が名乗った強さを出す。
  // 名乗らない broker(seatbelt = 機械ごとの差が無い)には行ごと出さない(macOS の doctor は変わらない)
  test("PBI-0331 AC-X3: sandbox strength は broker の 1 行を名乗り、名乗らなければ出さない", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const brokerHome = join(home, "broker");
    await mkdir(brokerHome, { recursive: true });
    const writeStatus = (status: Record<string, unknown>) =>
      writeFile(join(brokerHome, "sandbox-status.json"), JSON.stringify(status));
    const labelsAndStrength = async () => {
      const res = await openroly(["doctor", "claude", "--json"], home, { OPENROLY_BROKER_HOME: brokerHome });
      const broker = parseDoc(res.stdout).data.targets.find((t: any) => t.runtime === "broker");
      return {
        labels: broker.findings.map((f: any) => f.label),
        strength: broker.findings.find((f: any) => f.label === "sandbox strength"),
      };
    };
    const strength =
      "landlock ABI 4 + seccomp: files, TCP connect by port, TCP sockets only; not confined: device ioctl (needs ABI 5 = Linux 6.10), signals to your other processes (needs ABI 6 = Linux 6.12)";
    await writeStatus({ sandbox: "landlock ok", egress: "ok", egress_enforcement: "port_scoped", sandbox_strength: strength });
    const linux = await labelsAndStrength();
    expect(linux.strength).toMatchObject({ ok: true, detail: strength });
    const human = await openroly(["doctor", "claude"], home, { OPENROLY_BROKER_HOME: brokerHome });
    expect(human.stdout).toContain(`sandbox strength: ${strength}`);
    // seatbelt の broker は名乗らない = 行が無い(推測で埋めない)
    await writeStatus({ sandbox: "seatbelt ok", egress: "ok", egress_enforcement: "port_scoped" });
    expect((await labelsAndStrength()).labels).toEqual(["sandbox", "egress", "egress scope"]);
    await rm(home, { recursive: true, force: true });
  }, 90_000);

  test("AC-2: doctor の人間向け出力は変わらない(Broker 節・sandbox 行)", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["doctor", "claude"], home, { OPENROLY_BROKER_HOME: join(home, "broker") });
    expect(res.exitCode).toBe(1); // sandbox file 無しと同じ既定の挙動
    expect(res.stdout).toContain("[Broker]");
    expect(res.stdout).toContain("sandbox");
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});

describe("PBI-0334 --json: share", () => {
  async function seedLocalMcp(home: string, name: string): Promise<void> {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: "npx", args: [], env: {} } } }),
    );
  }

  test("AC-1: share --json --dry-run は plan を構造で出し、何も送らない", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    await seedLocalMcp(home, EVIL);
    const res = await openroly(["share", "claude", "--json", "--dry-run"], home);
    expect(res.exitCode).toBe(0);
    expect(proposalCalls).toBe(0);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.data.dry_run).toBe(true);
    expect(doc.data.plan).toEqual([
      {
        name: EVIL,
        kind: "mcp",
        original_name: EVIL,
        runtime_kind: "claude",
        credential_ref: null,
      },
    ]);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-1: share --json(実送信)は sent を出す", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    await seedLocalMcp(home, "plain-server");
    const res = await openroly(["share", "claude", "--json"], home);
    expect(res.exitCode).toBe(0);
    expect(proposalCalls).toBe(1);
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.data.dry_run).toBe(false);
    expect(doc.data.sent).toEqual([{ name: "plain-server", status: "pending", created: true }]);
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-2: share の人間向け出力は変わらない", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    await seedLocalMcp(home, "plain-server");
    const res = await openroly(["share", "claude", "--dry-run"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("plain-server from claude");
    expect(res.stdout).toContain("dry-run: nothing was sent");
    await rm(home, { recursive: true, force: true });
  }, 30_000);
});

describe("PBI-0334 --json: error と外枠の縁(AC-X2)", () => {
  test("AC-X2: 未接続の status --json は JSON の error 外枠で exit 1(stderr は空)", async () => {
    const home = await isolatedHome();
    const res = await openroly(["status", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("");
    expect(parseDoc(res.stdout)).toEqual({
      ok: false,
      error: { message: "Not connected. Start with 'openroly login'" },
    });
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: server が壊れた extensions --json も JSON の error 外枠で返る", async () => {
    extensionsGetStatus = 500;
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["extensions", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("");
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toContain("/v1/extensions returned 500");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("PBI-0678: share grok --json は Unsupported にならない(empty plan で ok)", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["share", "grok", "--dry-run", "--json"], home);
    expect(res.stderr).toBe("");
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(doc.error).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("PBI-0678 AC-X1: share の無い runtime は JSON の error 外枠で Unsupported", async () => {
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["share", "no-such-runtime", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("");
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toContain("Unsupported runtime: no-such-runtime");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("AC-X2: share が例外で落ちる時も JSON の error 外枠で返る(desired 一覧が読めない)", async () => {
    extensionsGetStatus = 500; // desiredNames が throw → CLI の fail()
    const home = await isolatedHome();
    await seedCredential(home);
    const res = await openroly(["share", "claude", "--json"], home);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("");
    const doc = parseDoc(res.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toContain("NG share:");
    await rm(home, { recursive: true, force: true });
  }, 30_000);

  test("外枠を出すのは 6 コマンドだけ: 対象外の command に --json を渡しても人はテキストのまま", async () => {
    const res = await openroly(["install", "not-a-real-runtime-0298", "--json"], await isolatedHome());
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(""); // JSON 外枠が出ない = 既定の人間向け経路のまま
    expect(res.stderr).toContain("Unsupported runtime");
  }, 30_000);
});
