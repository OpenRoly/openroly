import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0631(dogfood F5): `openroly status` の `[AI on this machine]`。broker が起こした session だけが
// `[Live sessions]` に載るので、手元で立ち上げた 6 pane が動いていても `Idle` と出ていた。
// ここでは **`ps` を PATH の先頭で差し替えて**(CLI は `Bun.which("ps")` で引く ——
// broker-claim-ps-attack.test.ts と同じ型)、行の中身・似た名前の除外・「分からない」の名乗りを見る。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

let home = "";
let brokerHome = "";
let bin = "";
let stopServer: (() => void) | null = null;

/** `ps` の差し替え。`-A`(一覧)の時だけ fixture を出し、それ以外(pid 指定)は「該当なし」= exit 1 */
async function fakePs(body: string): Promise<void> {
  // `;;` は **body の次の行**に置く —— heredoc(`<<'EOF'`)の終端は行頭・単独でないと閉じない
  await writeFile(join(bin, "ps"), `#!/bin/sh\ncase "$*" in\n  *-A*)\n${body}\n    ;;\n  *)\n    exit 1\n    ;;\nesac\n`);
  await chmod(join(bin, "ps"), 0o755);
}

/** broker.sock の fake。status に渡した session 一覧で答える */
async function fakeBroker(sessions: unknown[]): Promise<void> {
  await stopBroker();
  const listener = Bun.listen({
    unix: join(brokerHome, "broker.sock"),
    socket: {
      data(socket, data) {
        const msg = JSON.parse(data.toString().split("\n")[0]!) as { type?: string };
        if (msg.type === "status") socket.write(JSON.stringify({ sessions, capacity: { max: 4, used: 0 } }) + "\n");
      },
    },
  });
  stopServer = () => listener.stop(true);
}

async function stopBroker(): Promise<void> {
  stopServer?.();
  stopServer = null;
  await rm(join(brokerHome, "broker.sock"), { force: true });
}

function liveSession(runtime: string, id: string) {
  return {
    request_id: id,
    lane: "owner",
    runtime,
    thread_id: "",
    started_at: Date.now() - 60_000,
    state: "running",
    last_tool: null,
    tool_count: 0,
  };
}

async function openroly(args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    // bin を **先頭**に置く(CLI の `Bun.which("ps")` がここの ps を引く)
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-running-"));
  brokerHome = await mkdtemp(join(tmpdir(), "openroly-running-broker-"));
  bin = await mkdtemp(join(tmpdir(), "openroly-running-bin-"));
  await mkdir(brokerHome, { recursive: true });
  // status は credential を 1 件以上要求する。base_url は届かない口でよい(runtime 行が error になるだけ)
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
});

afterEach(async () => {
  await stopBroker();
});

afterAll(async () => {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(brokerHome, { recursive: true, force: true }),
    rm(bin, { recursive: true, force: true }),
  ]);
});

/**
 * 1 つの fixture で AC-1 / AC-2 / AC-3 / AC-X2 / AC-X3 を同時に測る。
 * - claude 3 本(うち 1 本は 2 時間超) → 件数と最古の elapsed
 * - kiro-cli は **空白を含む絶対 path**(実測 2026-09-16 の `/Applications/Kiro CLI.app/…` と同じ形)
 * - `claude-flow` / `myclaude` / `xclaude` は **名前が似ているだけ** = 数えない
 */
const FIXTURE = `cat <<'EOF'
  101       01:50:28 claude
  102       02:11:56 claude
  103       00:00:30 claude
  104    03-15:22:01 /Applications/Kiro CLI.app/Contents/MacOS/kiro-cli
  105       00:10:00 claude-flow
  106       00:10:00 myclaude
  107       00:10:00 xclaude
  108       00:10:00 launchd
EOF`;

describe("openroly status の [AI on this machine](PBI-0631)", () => {
  test("AC-1 / AC-3 / AC-X2 / AC-X3: kind ごとに 件数・最古・broker 起こし分の 1 行", async () => {
    await fakePs(FIXTURE);
    await fakeBroker([liveSession("claude", "wr_a".padEnd(34, "0"))]);
    const r = await openroly(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[AI on this machine]");
    // AC-1(3 本・最古 2h) + AC-3(broker の live 1 件)
    expect(r.stdout).toContain("Claude Code · 3 running · oldest 2h · 1 of them started by OpenRoly");
    // AC-X2: comm が空白入りの絶対 path でも basename で kind が決まる(3 日 15 時間 = 3d)
    expect(r.stdout).toMatch(/(Kiro|kiro) · 1 running · oldest 3d · 0 of them started by OpenRoly/);
    // AC-X3: 似た名前は 1 本も数えない(claude は 3 本のまま)
    expect(r.stdout).not.toContain("claude-flow");
    expect(r.stdout).not.toContain("myclaude");
    expect(r.stdout).not.toContain("4 running");
  }, 30_000);

  test("AC-2: --json は kind / pid / elapsed_ms の配列(人向けの文字列を作らない)", async () => {
    await fakePs(FIXTURE);
    await fakeBroker([]);
    const r = await openroly(["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const running = (JSON.parse(r.stdout) as { data: { running: { kind: string; pid: number; elapsed_ms: number }[] } })
      .data.running;
    expect(running).toEqual([
      { kind: "claude", pid: 101, elapsed_ms: 6_628_000 },
      { kind: "claude", pid: 102, elapsed_ms: 7_916_000 },
      { kind: "claude", pid: 103, elapsed_ms: 30_000 },
      { kind: "kiro", pid: 104, elapsed_ms: 314_521_000 },
    ]);
  }, 30_000);

  test("AC-X1: broker の live が ps の件数を超えても、件数を超えて名乗らない", async () => {
    // claude は ps に 1 本だけ。broker は 2 件 live と言う(子が先に死んだ後の窓)
    await fakePs(`printf '%s\\n' '  201       00:05:00 claude'`);
    await fakeBroker([liveSession("claude", "wr_b".padEnd(34, "0")), liveSession("claude", "wr_c".padEnd(34, "0"))]);
    const r = await openroly(["status"]);
    expect(r.stdout).toContain("Claude Code · 1 running · oldest 5m · 1 of them started by OpenRoly");
    expect(r.stdout).not.toContain("2 of them");
  }, 30_000);

  test("AC-4: broker に聞けない時は started by OpenRoly を名乗らない", async () => {
    await fakePs(FIXTURE);
    await stopBroker(); // socket 無し = 数えられない
    const r = await openroly(["status"]);
    expect(r.stdout).toContain("Claude Code · 3 running · oldest 2h");
    expect(r.stdout).not.toContain("started by OpenRoly");
  }, 30_000);

  test("AC-5: 1 本も走っていない時は節を出したうえで「無い」と言う", async () => {
    await fakePs(`printf '%s\\n' '  301       00:10:00 launchd'`);
    await fakeBroker([]);
    const r = await openroly(["status"]);
    expect(r.stdout).toContain("[AI on this machine]");
    expect(r.stdout).toContain("No AI processes found");
  }, 30_000);

  test("AC-X4: ps が答えない時は「0 件」と言わず「分からない」と言う(exit code は変えない)", async () => {
    await fakePs("exit 2"); // 走ったが答えなかった(混雑・usage error)
    await fakeBroker([]);
    const r = await openroly(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Could not be checked (ps did not answer)");
    expect(r.stdout).not.toContain("No AI processes found");
    const j = await openroly(["status", "--json"]);
    // JSON でも null([] ではない)。「分からない」を「0 件」に潰さない
    expect((JSON.parse(j.stdout) as { data: { running: unknown } }).data.running).toBeNull();
  }, 30_000);
});
