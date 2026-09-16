import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0229 `openroly status` / `openroly cancel` の CLI 側。live session は **server を経由せず**
// broker の hook socket(broker.sock・0600)に聞く —— broker が「いま動いている session」の
// 正本。ここでは broker を UNIX socket の fake で偽装し、行の中身(4 状態・lane・tool 進捗)と
// 未起動時の文言を見る。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

async function openroly(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

let home = "";
let brokerHome = "";
let stopServer: (() => void) | null = null;

/** broker.sock の fake。status に 1 行で答える(cancel には ok:true) */
const LIVE_SESSIONS = [
  {
    request_id: "wr_live0000000000000000000000000001",
    lane: "owner",
    runtime: "claude",
    thread_id: "thr_live1",
    started_at: Date.now() - 90_000,
    state: "running",
    last_tool: "inbox_read",
    tool_count: 2,
  },
  {
    request_id: "wr_start000000000000000000000000002",
    lane: "triage",
    runtime: "codex",
    thread_id: "",
    started_at: Date.now(),
    state: "starting",
    last_tool: null,
    tool_count: 0,
  },
];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-status-cli-"));
  brokerHome = await mkdtemp(join(tmpdir(), "openroly-status-cli-broker-"));
  // status は credential 1 件以上を要求する。base_url は届かない口でよい(error 行になるだけ)
  await writeFile(
    join(home, "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: {
        claude: {
          runtime_id: "rt_test",
          token: "par_test",
          base_url: "http://127.0.0.1:9",
          name: "test",
          paired_at: new Date().toISOString(),
        },
      },
    }),
    { mode: 0o600 },
  );
  const listener = Bun.listen({
    unix: join(brokerHome, "broker.sock"),
    socket: {
      data(socket, data) {
        const msg = JSON.parse(data.toString().split("\n")[0]!) as { type?: string; session?: string };
        if (msg.type === "status") {
          socket.write(JSON.stringify({ sessions: LIVE_SESSIONS, capacity: { max: 4, used: 2 } }) + "\n");
        } else if (msg.type === "cancel") {
          socket.write(JSON.stringify({ ok: msg.session === LIVE_SESSIONS[0]!.request_id }) + "\n");
        }
      },
    },
  });
  stopServer = () => listener.stop(true);
});

afterAll(async () => {
  stopServer?.();
  await rm(home, { recursive: true, force: true });
  await rm(brokerHome, { recursive: true, force: true });
});

const env = () => ({ OPENROLY_HOME: home, OPENROLY_BROKER_HOME: brokerHome });

describe("openroly status の live session(PBI-0229)", () => {
  test("--json は broker の正本を live_sessions にそのまま出す", async () => {
    const r = await openroly(["status", "--json"], env());
    expect(r.exitCode).toBe(0);
    // jsonOut は {ok, data} で包む
    const parsed = JSON.parse(r.stdout) as { data: { live_sessions: unknown[] } };
    expect(parsed.data.live_sessions).toEqual(LIVE_SESSIONS);
  }, 30_000);

  test("人間向け出力は 4 状態・lane・tool 進捗の 1 行(boolean にしない)", async () => {
    const r = await openroly(["status"], env());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[Live sessions]");
    // running + tool 経歴の行(elapsed は formatElapsed の短い形。90 秒 = 1m)
    expect(r.stdout).toContain(
      `${LIVE_SESSIONS[0]!.request_id}  owner · claude · running · 1m · thr_live1 · 2 tools · inbox_read`,
    );
    // starting + tool 0 回の行(tool 列は出ない)
    expect(r.stdout).toContain(`${LIVE_SESSIONS[1]!.request_id}  triage · codex · starting ·`);
    expect(r.stdout).not.toContain("· 0 tools");
  }, 30_000);

  test("broker 未起動(socket 無し)は live を黙って落とさず「無し」と名乗る", async () => {
    await mkdir(join(brokerHome, "keep"), { recursive: true }); // dir は在るが sock が無い状態
    await rm(join(brokerHome, "broker.sock"), { force: true });
    stopServer?.();
    const rJson = await openroly(["status", "--json"], env());
    expect(rJson.exitCode).toBe(0);
    expect((JSON.parse(rJson.stdout) as { data: { live_sessions: unknown[] } }).data.live_sessions).toEqual([]);
    const r = await openroly(["status"], env());
    expect(r.stdout).toContain("No live sessions (broker not running)");
  }, 30_000);
});

describe("openroly cancel(PBI-0229 AC-3 の CLI 口)", () => {
  test("既知の id は OK、無い id は失敗(socket 応答の ok をそのまま出す)", async () => {
    // broker.sock は上の test で消したので立て直す
    const listener = Bun.listen({
      unix: join(brokerHome, "broker.sock"),
      socket: {
        data(socket, data) {
          const msg = JSON.parse(data.toString().split("\n")[0]!) as { type?: string; session?: string };
          if (msg.type === "cancel") {
            socket.write(JSON.stringify({ ok: msg.session === LIVE_SESSIONS[0]!.request_id }) + "\n");
          }
        },
      },
    });
    stopServer = () => listener.stop(true);
    const ok = await openroly(["cancel", LIVE_SESSIONS[0]!.request_id], env());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain(`OK stop requested: ${LIVE_SESSIONS[0]!.request_id}`);
    const ng = await openroly(["cancel", "wr_nosuch"], env());
    expect(ng.exitCode).toBe(1);
    expect(ng.stderr).toContain("no such session");
  }, 30_000);
});
