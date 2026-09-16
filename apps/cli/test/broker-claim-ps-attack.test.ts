import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0270(PBI-0263 有界レビューの範囲外の破れ)の攻撃 test。helper は broker-claim-reap-attack.test.ts の写し。
// 元の説明:狙いは `reapLock` / `stillHeld`(PBI-0263)と、その足元の
// 「生死判定は ps に掛かっている」の 2 つ。broker-claim-attack.test.ts(PBI-0218 review)は 2 本同時までなので、
// ここでは (1) 3 本同時で回収の rename が他人の生きた lock を巻き込まないか、(2) 巻き込んだ時に**戻す**枝が
// 本当に踏まれて戻るか(遅い `ps` で判断の窓を 1 秒に広げて決定論的に踏む)を測る。判定は broker-claim-attack と
// 同じく CLI 自身の申告。(3) `ps` が走らない時の生死判定は broker-claim-ps-attack.test.ts(PBI-0270)

const CLI = join(import.meta.dir, "../src/openroly.ts");
const LOCK_NAME = "broker.pid.lock";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-claim-ps-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fakeBrokerScript = `#!/bin/sh\necho "spawn pid=$$"\nexit 0\n`;

/**
 * `ps` の差し替え。CLI は `Bun.which("ps")` で PATH から引くので、先頭に置いた dir の `ps` が全ての生死判定に
 * 使われる。`slowForOthersMs` は **CLI 自身以外の pid** を訊かれた時だけ寝る(自分の名札を書く `pidRecord(self)`
 * は遅くしない)。呼ばれた回数は `calls` dir に 1 file ずつ残す(test 側が「今 ps の中に居る」を知る為)
 */
async function psShim(dir: string, body: string): Promise<{ bin: string; calls: string }> {
  const bin = join(dir, "psbin");
  const calls = join(dir, "ps-calls");
  await mkdir(bin, { recursive: true });
  await mkdir(calls, { recursive: true });
  await writeFile(join(bin, "ps"), `#!/bin/sh\nCALLS=${JSON.stringify(calls)}\n${body}`);
  await chmod(join(bin, "ps"), 0o755);
  return { bin, calls };
}

async function freshEnv(ps?: { bin: string }) {
  const dir = await mkdtemp(join(root, "case-"));
  const home = join(dir, "home");
  const brokerHome = join(dir, "broker-home");
  await mkdir(home, { recursive: true });
  await mkdir(brokerHome, { recursive: true });
  const bin = join(dir, "openroly-broker-fake");
  await writeFile(bin, fakeBrokerScript);
  await chmod(bin, 0o755);
  await saveCredential(
    "broker",
    {
      runtime_id: "rt_broker_claim_ps",
      token: "par_claim_ps",
      base_url: "http://127.0.0.1:9",
      // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
      name: hostname(),
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
  return {
    dir,
    brokerHome,
    brokerPid: join(brokerHome, "broker.pid"),
    lock: join(brokerHome, LOCK_NAME),
    env: {
      PATH: `${ps ? `${ps.bin}:` : ""}${process.env.PATH ?? ""}`,
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_URL: "http://127.0.0.1:9",
    } as Record<string, string>,
  };
}

async function brokerFg(env: Record<string, string>, since = performance.now()) {
  const began = performance.now();
  const proc = Bun.spawn(["bun", CLI, "broker"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err, from: Math.round(began - since), to: Math.round(performance.now() - since) };
}
type Run = Awaited<ReturnType<typeof brokerFg>>;
const started = (r: Run) => /^spawn pid=\d+/m.test(r.out);
const yielded = (r: Run) => r.err.includes("The broker is already running");

function tally(rs: Run[]) {
  const s = rs.filter(started).length;
  const y = rs.filter(yielded).length;
  return { started: s, yielded: y, other: rs.length - s - y };
}
function describeRun(r: Run): string {
  const squash = (x: string, n: number) => x.replace(/\s+/g, " ").trim().slice(0, n);
  const gist = r.err
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(error:|NG |The broker|[A-Za-z]*Error\b)/.test(l));
  return `code=${r.code} t=${r.from}..${r.to}ms out="${squash(r.out, 80)}" err="${gist ? squash(gist, 200) : squash(r.err, 300)}"`;
}

async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}
async function lstartOf(pid: number): Promise<string> {
  const out = await new Response(
    Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe" }).stdout,
  ).text();
  return out.trim().replace(/\s+/g, " ");
}
const lockBody = (pid: number, lstart: string) => `someoneelse${pid}\n${pid} ${lstart}`;
async function writeStalePid(path: string): Promise<void> {
  await writeFile(path, `${await reapedPid()} ${await lstartOf(process.pid)}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, ms: number, step = 20): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}

describe("PBI-0270: ps が走らない時の生死判定を破りにいく", () => {
  test(
    "攻撃9: ps が走らない時、生きた broker を「死んだ」と読んで 2 本目を起こさない(不明は死ではない)",
    async () => {
      // 生死判定は全部 `ps` の exec に掛かっている。混雑で spawn が EAGAIN を返す / ps が OOM で殺される時、
      // 「答えが無い」を「死んでいる」に倒すと、生きた broker の pid file を消して 2 本目を起こす。
      // 譲る根拠が「生きた broker を確認できた」だけ(PBI-0218)なのと同じで、**取る根拠も「死んだと確認できた」
      // だけ**でなければならない。決められない時は undetermined で降りる(0 本を成功に見せない・嘘の
      // already running も言わない)。ps が exit 2 で何も返さない = 「走らせられなかった」の模型
      const ps = await psShim(await mkdtemp(join(root, "shim-")), `exit 2\n`);
      const { env, brokerPid } = await freshEnv(ps);
      const alive = Bun.spawn(["/bin/sh", "-c", "sleep 90"], { stdout: "ignore", stderr: "ignore" });
      try {
        await writeFile(brokerPid, `${alive.pid} ${await lstartOf(alive.pid)}`);
        const r = await brokerFg(env);
        const lied = !started(r) && (yielded(r) || r.code === 0);
        expect(`started=${started(r)} lied=${lied} code=${r.code}`).toBe("started=false lied=false code=1");
        expect(r.err).toContain("could not tell whether a broker is running");
        // 生きた broker の記録を消していない
        expect((await readFile(brokerPid, "utf8")).startsWith(`${alive.pid} `)).toBe(true);
      } finally {
        alive.kill();
        await alive.exited;
      }
    },
    120_000,
  );

  test(
    "攻撃10: ps が走らない間、生きた持ち主の lock は回収されず deadline も延びない(上限で undetermined)",
    async () => {
      // 名札の持ち主が生きているのに `ps` が答えない。時限(mtime を未来に置いて封じる)でも生死でも回収できず、
      // かつ「生きた持ち主が握っている」と確かめてもいないので deadline は延びない → 20s で undetermined。
      // 回収する実装(不明 = 死)なら数秒で起動してしまう
      const ps = await psShim(await mkdtemp(join(root, "shim-")), `exit 2\n`);
      const { env, brokerPid, lock } = await freshEnv(ps);
      await writeStalePid(brokerPid);
      const owner = Bun.spawn(["/bin/sh", "-c", "sleep 90"], { stdout: "ignore", stderr: "ignore" });
      try {
        await writeFile(lock, lockBody(owner.pid, await lstartOf(owner.pid)));
        const future = new Date(Date.now() + 3_600_000);
        await utimes(lock, future, future);
        const began = Date.now();
        const r = await brokerFg(env);
        const waited = Math.round((Date.now() - began) / 1000);
        expect(`started=${started(r)} code=${r.code} gaveUpWithin=${waited >= 15 && waited < 60}`).toBe(
          "started=false code=1 gaveUpWithin=true",
        );
        expect(r.err).toContain("could not tell whether a broker is running");
        expect(`lock left: ${(await readFile(lock, "utf8")).startsWith("someoneelse")}`).toBe("lock left: true");
      } finally {
        owner.kill();
        await owner.exited;
        await rm(lock, { force: true });
      }
    },
    120_000,
  );
});
