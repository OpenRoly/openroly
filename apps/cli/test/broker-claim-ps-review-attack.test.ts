import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0270 有界レビュー(c2)の攻撃 test。helper は broker-claim-ps-attack.test.ts の写し。
// 攻撃9 / 10(同 file)は「ps が答えない時に取らない」を測る。ここは残りの 4 面:
//   攻撃11: ps が**返らない**(hang)時も上限で降りる(AC-X1「永久に待たない」は exit≠0 だけでなく hang にも要る)
//   攻撃12: 降りる時の文言が嘘を言わない(ps が走らないのに「another openroly process is holding the lock」と言わない)
//   攻撃13: unknown は**retry**であって諦めではない —— ps が途中で直れば同じ 1 回の openroly broker が起動する
//           (攻撃9 / 10 は「undetermined で降りる」しか見ないので、unknown → 即 undetermined の変異も緑になる)
//   攻撃14: psColumn の 3 値の境界 —— exit 0 で空 / exit 1 で出力あり、は「居ない」ではなく「分からない」

const CLI = join(import.meta.dir, "../src/openroly.ts");

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-claim-ps-rv-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fakeBrokerScript = `#!/bin/sh\necho "spawn pid=$$"\nexit 0\n`;

/** `ps` の差し替え(CLI は `Bun.which("ps")` で PATH から引く)。呼ばれた回数は `calls` dir に 1 file ずつ残す */
async function psShim(body: string): Promise<{ bin: string; calls: string }> {
  const dir = await mkdtemp(join(root, "shim-"));
  const bin = join(dir, "psbin");
  const calls = join(dir, "ps-calls");
  await mkdir(bin, { recursive: true });
  await mkdir(calls, { recursive: true });
  await writeFile(join(bin, "ps"), `#!/bin/sh\nCALLS=${JSON.stringify(calls)}\ntouch "$CALLS/$$"\n${body}`);
  await chmod(join(bin, "ps"), 0o755);
  return { bin, calls };
}

async function freshEnv(ps: { bin: string }, extra: Record<string, string> = {}) {
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
      runtime_id: "rt_broker_claim_ps_rv",
      token: "par_claim_ps_rv",
      base_url: "http://127.0.0.1:9",
      // machine-ok: 実装側（openroly.ts の hostname()）と同じ値なので両辺が一緒に動く
      name: hostname(),
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
  return {
    brokerHome,
    brokerPid: join(brokerHome, "broker.pid"),
    lock: join(brokerHome, "broker.pid.lock"),
    env: {
      PATH: `${ps.bin}:${process.env.PATH ?? ""}`,
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_URL: "http://127.0.0.1:9",
      ...extra,
    } as Record<string, string>,
  };
}

/** `openroly broker`(前景)。`capMs` を過ぎたら kill して `hung=true`(hang を test の timeout でなく値で見る) */
async function brokerFg(env: Record<string, string>, capMs = 0) {
  const began = performance.now();
  const proc = Bun.spawn(["bun", CLI, "broker"], { env, stdout: "pipe", stderr: "pipe" });
  let hung = false;
  const timer = capMs
    ? setTimeout(() => {
        hung = true;
        proc.kill();
      }, capMs)
    : null;
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, out, err, hung, ms: Math.round(performance.now() - began) };
}
type Run = Awaited<ReturnType<typeof brokerFg>>;
const started = (r: Run) => /^spawn pid=\d+/m.test(r.out);
const yielded = (r: Run) => r.err.includes("The broker is already running");
const couldNotTell = (r: Run) => r.err.includes("could not tell whether a broker is running");
const gist = (r: Run) =>
  r.err
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(error:|NG |The broker|[A-Za-z]*Error\b)/.test(l)) ?? r.err.replace(/\s+/g, " ").slice(0, 300);

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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, ms: number, step = 50): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}
async function withLive<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const alive = Bun.spawn(["/bin/sh", "-c", "sleep 120"], { stdout: "ignore", stderr: "ignore" });
  try {
    return await fn(alive.pid);
  } finally {
    alive.kill();
    await alive.exited;
  }
}

describe("PBI-0270 有界レビュー: 3 値の残りの面を破りにいく", () => {
  test(
    "攻撃11: ps が返らない(hang)時も上限で降りる —— 永久に待たない(AC-X1)",
    async () => {
      // exit≠0 は 20s で undetermined(攻撃10)だが、ps が**返らない**と claim は最初の ps で永久に止まる。
      // 1 回の ps に上限(既定 120s。test は OPENROLY_PS_TIMEOUT_MS で縮める)を置き、超えたら unknown として扱う
      const ps = await psShim(`exec sleep 120\n`);
      const { env, brokerPid } = await freshEnv(ps, { OPENROLY_PS_TIMEOUT_MS: "1500" });
      await withLive(async (pid) => {
        await writeFile(brokerPid, `${pid} ${await lstartOf(pid)}`);
        const r = await brokerFg(env, 60_000);
        expect(`hung=${r.hung} started=${started(r)} code=${r.code} tell=${couldNotTell(r)} :: ${gist(r)}`).toMatch(
          /^hung=false started=false code=1 tell=true/,
        );
        // 生きた broker の記録は消していない
        expect((await readFile(brokerPid, "utf8")).startsWith(`${pid} `)).toBe(true);
      });
    },
    90_000,
  );

  test(
    "攻撃12: ps が走らずに降りた時、「another openroly process is holding the lock」と嘘を言わない",
    async () => {
      // 誰も lock を握っていない(自分が取って retry を繰り返しただけ)のに、文言が lock の持ち主のせいにすると
      // 人は run it again を繰り返すだけで原因(ps)に辿り着けない。broker status と同じく ps を名指しする
      const ps = await psShim(`exit 2\n`);
      const { env, brokerPid } = await freshEnv(ps);
      await withLive(async (pid) => {
        await writeFile(brokerPid, `${pid} ${await lstartOf(pid)}`);
        const r = await brokerFg(env);
        expect(`started=${started(r)} code=${r.code} tell=${couldNotTell(r)}`).toBe("started=false code=1 tell=true");
        expect(gist(r)).not.toContain("another openroly process is holding");
        expect(gist(r)).toContain("ps did not run");
      });
    },
    60_000,
  );

  test(
    "攻撃13: unknown は retry —— ps が途中で直れば同じ 1 回の openroly broker が(deadline 内に)起動する",
    async () => {
      // pid file は死んだ pid。ps が壊れている間は取らない(unknown → retry)が、直った瞬間に「死んだ」と確かめて
      // 取る。unknown を即 undetermined に倒す実装だと、直っても exit 1 のまま(攻撃9 / 10 はそれを緑にする)
      const ps = await psShim(`if [ -e "$CALLS/broken" ]; then exit 2; fi\nexec /bin/ps "$@"\n`);
      const { env, brokerPid } = await freshEnv(ps);
      await writeFile(brokerPid, `${await reapedPid()} ${await lstartOf(process.pid)}`);
      const broken = join(ps.calls, "broken");
      await writeFile(broken, "");
      const run = brokerFg(env, 60_000);
      // 壊れた ps を 6 回以上見てから(= retry に入ってから)直す
      const retried = await waitFor(async () => (await readdir(ps.calls)).length >= 7, 15_000);
      await rm(broken, { force: true });
      const r = await run;
      expect(`retried=${retried} started=${started(r)} code=${r.code} tell=${couldNotTell(r)}`).toBe(
        "retried=true started=true code=0 tell=false",
      );
    },
    90_000,
  );

  for (const [label, body] of [
    ["exit 0 で空", `exit 0\n`],
    ["exit 1 で出力あり", `echo "ps: illegal option -- p"\nexit 1\n`],
  ] as const) {
    test(
      `攻撃14: ps が ${label} を返す = 居ないではなく分からない(生きた broker を消さない)`,
      async () => {
        // 「居ない」と言えるのは exit 1 で空(ps の仕様)だけ。それ以外の組み合わせは全部「分からない」に倒す
        const ps = await psShim(body);
        const { env, brokerPid } = await freshEnv(ps);
        await withLive(async (pid) => {
          await writeFile(brokerPid, `${pid} ${await lstartOf(pid)}`);
          const r = await brokerFg(env, 60_000);
          expect(`hung=${r.hung} started=${started(r)} yielded=${yielded(r)} code=${r.code} tell=${couldNotTell(r)}`).toBe(
            "hung=false started=false yielded=false code=1 tell=true",
          );
          expect((await readFile(brokerPid, "utf8")).startsWith(`${pid} `)).toBe(true);
        });
      },
      90_000,
    );
  }
});
