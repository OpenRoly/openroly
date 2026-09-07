import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0263 有界レビューの攻撃 test。狙いは `reapLock` / `stillHeld`(PBI-0263)と、その足元の
// 「生死判定は ps に掛かっている」の 2 つ。broker-claim-attack.test.ts(PBI-0218 review)は 2 本同時までなので、
// ここでは (1) 3 本同時で回収の rename が他人の生きた lock を巻き込まないか、(2) 巻き込んだ時に**戻す**枝が
// 本当に踏まれて戻るか(遅い `ps` で判断の窓を 1 秒に広げて決定論的に踏む)を測る。判定は broker-claim-attack と
// 同じく CLI 自身の申告。(3) `ps` が走らない時の生死判定は broker-claim-ps-attack.test.ts(PBI-0270)

const CLI = join(import.meta.dir, "../src/openroly.ts");
const LOCK_NAME = "broker.pid.lock";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-claim-reap-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// **起こした broker は少しの間だけ生きる**(PBI-0312)。即 exit だと、勝者が spawn した直後に
// broker が死ぬので、**遅れて来た 2 本目が「死んだ broker を正しく起こし直す」のは正しい振る舞い**
// になり、`started=2` が相互排他の破れなのか正しい再起動なのか区別できない。
// 実測(2026-09-06 CI): Linux では bun の起動が速く 2 本が重ならないので**毎 round** `started=2` に
// なり、macOS では重なるので `1/1` になっていた —— 実装ではなく **この fixture の寿命**が原因だった。
// 生かしておけば、2 本目は pid file が指す **生きた** broker を見て譲るので、`started=2` は
// 相互排他の破れだけを意味する
const fakeBrokerScript = `#!/bin/sh\necho "spawn pid=$$"\nsleep 2\nexit 0\n`;

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
      runtime_id: "rt_broker_claim_reap",
      token: "par_claim_reap",
      base_url: "http://127.0.0.1:9",
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

describe("PBI-0263 review: 回収の rename と stillHeld を破りにいく", () => {
  test(
    "攻撃7: 古い lock dir の下で 3 本同時 — ちょうど 1 本、落ちる本も無く、回収の残骸も残らない",
    async () => {
      // 2 本(攻撃1)では「先発が回収して link し直した lock」を後発 1 本が rename で掴んで戻す間、lock の path が
      // 一瞬空く。その隙に **3 本目**が link すると 2 本が takeOver に入る(stillHeld が最後の砦)。
      // 3 本で回して、started がちょうど 1・第 3 の出口(例外 / 諦め)が 0・`.reap.*` の残骸が 0 を見る
      const ROUNDS = 10;
      const seen: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const { env, brokerPid, lock, brokerHome } = await freshEnv();
        await writeStalePid(brokerPid);
        await mkdir(lock);
        const past = new Date(Date.now() - 30_000);
        await utimes(lock, past, past);
        const since = performance.now();
        const rs = await Promise.all([brokerFg(env, since), brokerFg(env, since), brokerFg(env, since)]);
        const t = tally(rs);
        // 回収の私有 path(`broker.pid.lock.reap.*`)・名札の temp(`*.tmp`)が残っていない = 全員が自分の物を消せた
        const left = (await readdir(brokerHome)).filter((f) => f !== "broker.pid").sort();
        const ok = t.started === 1 && t.yielded === 2 && left.length === 0;
        seen.push(
          `round ${round}: started=${t.started} yielded=${t.yielded} other=${t.other} left=[${left.join(",")}]` +
            (ok ? "" : `\n${rs.map((r, i) => `    [${i}] ${describeRun(r)}`).join("\n")}`),
        );
      }
      expect(seen.join("\n")).toBe(
        Array.from({ length: ROUNDS }, (_, i) => `round ${i}: started=1 yielded=2 other=0 left=[]`).join("\n"),
      );
    },
    300_000,
  );

  test(
    "攻撃8: 「死んだ」と判断した後に張り替わった生きた lock を rename で掴んでも、消さずに戻して待つ",
    async () => {
      // reapLock の「違えば戻す」枝は、2 本同時の test では踏むか踏まないかが運(数 ms の窓)。ここでは
      // `ps` を 1 秒遅くして **判断(stat → 名札を読む → ps)と回収(rename)の間**を 1 秒に広げ、その間に
      // test が lock を「生きた持ち主の物」に張り替える。CLI は古い判断(死んでいる)のまま rename で
      // 生きた lock を掴む —— 掴んだ物が判断した物と違うので **戻して**、持ち主が死ぬまで待たなければならない。
      // 戻さない(消す / 私有 path に置き去り)なら、CLI は即座に自分の lock を張って起動する(= 奪った)
      const ps = await psShim(
        await mkdtemp(join(root, "shim-")),
        // 自分(親 = CLI)以外の pid を訊かれた時だけ 1 秒寝る。呼び出しは 1 file ずつ数える
        `pid=$4\n` +
          `if [ "$pid" != "$PPID" ]; then : > "$CALLS/$$"; sleep 1; fi\n` +
          `exec /bin/ps "$@"\n`,
      );
      const { env, brokerPid, lock } = await freshEnv(ps);
      await writeStalePid(brokerPid);
      const dead = await reapedPid();
      await writeFile(lock, lockBody(dead, await lstartOf(process.pid)));
      const owner = Bun.spawn(["/bin/sh", "-c", "sleep 60"], { stdout: "ignore", stderr: "ignore" });
      const liveBody = lockBody(owner.pid, await lstartOf(owner.pid));
      const began = Date.now();
      const run = brokerFg(env);
      let swappedAt = -1;
      let killedAt = -1;
      try {
        // 他人の pid を訊く ps の 2 回目 = lock の名札(死んだ持ち主)の生死判定 = **stat(lock) の後・rename の前**。
        // 1 回目は pid file の判定(runningBrokerPid)。ここで張り替えると、CLI は「死んでいる」と読み終えた
        // 直後に、生きた持ち主の lock を rename で掴む
        const inDecision = await waitFor(async () => (await readdir(ps.calls)).length >= 2, 15_000);
        expect(`reached the lock decision: ${inDecision}`).toBe("reached the lock decision: true");
        const tmp = `${lock}.swap`;
        await writeFile(tmp, liveBody);
        await rename(tmp, lock);
        swappedAt = Date.now() - began;
        // ps が返って回収に入り、掴んで戻す → 以後は「生きた持ち主」を見て待つ。2.5 秒後に lock を見る:
        // 生きた持ち主の名札のまま(消されても・自分の名札に置き換わっても・path が空でも NG)
        await sleep(2_500);
        const body = await readFile(lock, "utf8").catch((e) => `(${(e as NodeJS.ErrnoException).code})`);
        expect(`lock 2.5s after the swap: ${body === liveBody ? "live owner's" : body}`).toBe(
          "lock 2.5s after the swap: live owner's",
        );
        // 掴んで戻した後の私有 path が残っていない(戻したのであって置き去りではない)
        const left = (await readdir(join(lock, ".."))).filter((f) => f.includes(".reap."));
        expect(`reap residue: [${left.join(",")}]`).toBe("reap residue: []");
      } finally {
        owner.kill();
        await owner.exited;
        killedAt = Date.now() - began;
      }
      const r = await run;
      const finished = Date.now() - began;
      // 持ち主が死んだ後にだけ起動する(= 奪っていない)。起動時刻は「exit した時刻 - fake broker の分」では
      // 出せないので、**持ち主を殺した時刻より前に終わっていない**事で見る
      expect(
        `started=${started(r)} code=${r.code} stole=${finished < killedAt} swappedAt=${swappedAt > 0}`,
      ).toBe("started=true code=0 stole=false swappedAt=true");
    },
    120_000,
  );
});
