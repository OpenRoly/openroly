import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEEK_FOOTER } from "../src/peek.ts";

// PBI-0224 `openroly peek` の CLI 側(AC-2 / AC-3)。fixture の sessions dir 3 つ(instruction.txt / peek.jsonl /
// result.txt の有無)を OPENROLY_BROKER_HOME に置き、stdout の行と順序、値が 0 回である事を見る。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));
const SECRET = "山田太郎";

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

let brokerHome = "";
const sessionsDir = () => join(brokerHome, "sessions");

const line = (v: unknown) => JSON.stringify(v) + "\n";
const OUTPUT_A = JSON.stringify({ id: "m1", content: { text: "call ⟨s:1⟩ at 090-1234-5678" } }, null, 2);

async function session(id: string, opts: { runtime: string; started: string; mtimeSec: number; done: boolean }) {
  const dir = join(sessionsDir(), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "instruction.txt"), `You are @aya. Handle message m1 (session ${id}).\n`);
  await writeFile(
    join(dir, "peek.jsonl"),
    line({ session: id, runtime: opts.runtime, started: opts.started }) +
      line({ tool: "inbox_read", input: { message_id: "m1" }, output: OUTPUT_A }) +
      line({ tool: "reply", input: { thread_id: "t1", text: "Told ⟨s:1⟩ ok" }, output: JSON.stringify({ status: "sent" }) }),
  );
  if (opts.done) await writeFile(join(dir, "result.txt"), "done\n");
  await utimes(dir, opts.mtimeSec, opts.mtimeSec);
  return dir;
}

beforeAll(async () => {
  brokerHome = await mkdtemp(join(tmpdir(), "openroly-peek-cli-"));
  const t = 1_700_000_000;
  await session("req_old", { runtime: "codex", started: "2026-09-04T00:00:00Z", mtimeSec: t, done: true });
  await session("req_a", { runtime: "claude", started: "2026-09-04T01:00:00Z", mtimeSec: t + 100, done: false });
  await session("req_new", { runtime: "opencode", started: "2026-09-04T02:00:00Z", mtimeSec: t + 200, done: false });
});
afterAll(() => rm(brokerHome, { recursive: true, force: true }));

describe("openroly peek(PBI-0224)", () => {
  test("AC-2: peek <id> は instruction 全文 → 番号付き tool 往復 → 固定の末尾文。値は 0 回", async () => {
    const r = await openroly(["peek", "req_a"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    const out = r.stdout;
    const iHead = out.indexOf("session req_a  runtime claude  started 2026-09-04T01:00:00Z");
    const iInstr = out.indexOf("You are @aya. Handle message m1 (session req_a).");
    const iCall1 = out.indexOf('1. inbox_read {"message_id":"m1"}');
    const iOut1 = out.indexOf("→ {");
    const iCall2 = out.indexOf('2. reply {"thread_id":"t1","text":"Told ⟨s:1⟩ ok"}');
    const iFooter = out.indexOf(PEEK_FOOTER);
    expect([iHead, iInstr, iCall1, iOut1, iCall2, iFooter].every((i) => i >= 0)).toBe(true);
    expect(iHead < iInstr && iInstr < iCall1 && iCall1 < iOut1 && iOut1 < iCall2 && iCall2 < iFooter).toBe(true);
    expect(out).toContain("⟨s:1⟩");
    expect(out.split(SECRET).length - 1).toBe(0);
  }, 30_000);

  test("AC-3: --list は mtime 降順 3 行(id / runtime / started / exit。result.txt 無しは running)+ 件数", async () => {
    const r = await openroly(["peek", "--list"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    const rows = r.stdout.trimEnd().split("\n");
    expect(rows.slice(0, 3)).toEqual([
      "req_new  opencode  2026-09-04T02:00:00Z  running",
      "req_a  claude  2026-09-04T01:00:00Z  running",
      "req_old  codex  2026-09-04T00:00:00Z  done",
    ]);
    expect(rows[3]).toBe(`3 sessions in ${sessionsDir()}`);
  }, 30_000);

  test("AC-3: 引数無しは最新 1 件を AC-2 の形で出す", async () => {
    const r = await openroly(["peek"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("session req_new  runtime opencode");
    expect(r.stdout).toContain("(session req_new).");
    expect(r.stdout).not.toContain("session req_a ");
    expect(r.stdout).toContain(PEEK_FOOTER);
  }, 30_000);

  test("--json は生の jsonl をそのまま出す(値は含まれない)", async () => {
    const r = await openroly(["peek", "req_a", "--json"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(await Bun.file(join(sessionsDir(), "req_a", "peek.jsonl")).text());
    expect(r.stdout.split("\n").filter((l) => l.length > 0).length).toBe(3);
    expect(r.stdout).not.toContain(SECRET);
  }, 30_000);

  test("--follow は result.txt が現れた時点で tail を終える", async () => {
    const dir = join(sessionsDir(), "req_follow");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instruction.txt"), "follow me\n");
    await writeFile(join(dir, "peek.jsonl"), line({ session: "req_follow", runtime: "claude", started: "x" }));
    const proc = Bun.spawn(["bun", CLI, "peek", "req_follow", "--follow"], {
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OPENROLY_BROKER_HOME: brokerHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    // 走っている間に 1 行足し、その後 result.txt を置く
    await new Promise((r) => setTimeout(r, 700));
    await writeFile(join(dir, "peek.jsonl"), line({ tool: "whoami", input: {}, output: "{}" }), { flag: "a" });
    await new Promise((r) => setTimeout(r, 700));
    await writeFile(join(dir, "result.txt"), "done\n");
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("follow me");
    expect(stdout).toContain("1. whoami {}");
    expect(stdout.trimEnd().endsWith(PEEK_FOOTER)).toBe(true);
  }, 30_000);

  test("無い id / sessions の外を指す id は失敗する(何も読まない)", async () => {
    const missing = await openroly(["peek", "req_nope"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No session req_nope");
    const traversal = await openroly(["peek", "../x"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain("Invalid session id");
  }, 30_000);

  test("PBI-0548: broker が起こさなかった session(skipped.txt)は --list で skipped・peek <id> で理由 1 行", async () => {
    const dir = join(sessionsDir(), "req_skip");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instruction.txt"), "triage m1\n");
    await writeFile(
      join(dir, "skipped.txt"),
      'skipped: lane_not_contained — opencode is woken only for work you hand it (this wake\'s lane: "triage"); claude can take this lane\n',
    );
    const list = await openroly(["peek", "--list"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(list.stdout).toContain("req_skip  -  -  skipped");
    const r = await openroly(["peek", "req_skip"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(not started) skipped: lane_not_contained");
    expect(r.stdout).toContain("claude can take this lane");
    expect(r.stdout).not.toContain("(no tool calls recorded)");
  }, 30_000);

  test("PBI-0558: masking.txt の 1 行が header の下に出る", async () => {
    const dir = join(sessionsDir(), "req_mask");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instruction.txt"), "triage m1\n");
    await writeFile(join(dir, "peek.jsonl"), line({ session: "req_mask", runtime: "claude", started: "x" }));
    await writeFile(join(dir, "masking.txt"), "masking: outside sandbox\n");
    const r = await openroly(["peek", "req_mask"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toStartWith("session req_mask  runtime claude");
    expect(lines[1]).toBe("masking: outside sandbox");
  }, 30_000);

  test("PBI-0616: egress.txt(allowlist の出所)の 1 行が header の下に出る", async () => {
    const dir = join(sessionsDir(), "req_egress");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "instruction.txt"), "triage e1\n");
    await writeFile(join(dir, "peek.jsonl"), line({ session: "req_egress", runtime: "claude", started: "x" }));
    await writeFile(join(dir, "egress.txt"), "egress: registry_unavailable — the allowlist came from the broker's built-in table\n");
    const r = await openroly(["peek", "req_egress"], { OPENROLY_BROKER_HOME: brokerHome });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toStartWith("session req_egress  runtime claude");
    expect(lines[1]).toContain("registry_unavailable");
  }, 30_000);

  test("usage に peek が載る", async () => {
    const r = await openroly(["--help"], {});
    expect(r.stdout).toContain("peek [id] [--list] [--follow] [--json]");
  }, 30_000);
});
