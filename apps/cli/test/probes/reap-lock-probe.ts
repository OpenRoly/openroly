// 機序 probe(PBI-0263 有界レビュー)。`bun test` は拾わない(file 名が *.test.ts でない)。openroly.ts の reapLock /
// withStaleTakeoverLock の lock 部分を写して(pid file は無し)、stale lock dir を N 本が同時に回収する時の
//   crash(EFAULT 等の例外) / overlap(2 本が同時に critical section) / misgrab(他人の生きた lock を rename で
//   掴んで戻した) / displaced(自分の lock が横から動かされて stillHeld が false になった) を数える。
// usage: bun apps/cli/test/probes/reap-lock-probe.ts parent <mode> <rounds> <workers> [--nostill] [--delay=<ms>] [--flaky-alive=<p>]
//        mode = old(PBI-0263 前: stat で照合して rm) | new(PBI-0263: rename で掴む) | precheck(レビュー後: rename の前にも stat)
//        --nostill = takeOver の stillHeld 無し / --delay = link と stillHeld の間(takeOver の ps 相当) /
//        --flaky-alive = 生死判定をその確率で「死」に誤らせる(混雑で ps が走らない模型)
// 実測 2026-09-05(3 本 × 200 回): old --nostill → EFAULT 22 / new → 掴み違い 0〜3・置き去り 1 回 / precheck → 0
//   --flaky-alive=0.1 --delay=5: new --nostill overlap 8 / new overlap 1 displaced 81 / precheck overlap 0 displaced 55
import { appendFile, link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_LOCK_MS = 10_000;
type Id = { ino: number; mtimeMs: number };
const rnd = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const [mode = "", ...a] = process.argv.slice(2);

if (mode === "parent") {
  const [kind = "new", roundsS = "200", workersS = "3", ...flags] = a;
  const rounds = Number(roundsS), workers = Number(workersS);
  const nostill = flags.includes("--nostill");
  const delay = Number((flags.find((f) => f.startsWith("--delay=")) ?? "--delay=0").slice(8));
  const flaky = Number((flags.find((f) => f.startsWith("--flaky-alive=")) ?? "--flaky-alive=0").slice(14));
  const root = join(tmpdir(), `openroly-reap-probe-${kind}-${Date.now()}`);
  await mkdir(root);
  const past = new Date(Date.now() - 30_000);
  for (let i = 0; i < rounds; i++) {
    const d = join(root, `r${i}`);
    await mkdir(d);
    await mkdir(join(d, "lock")); // 旧版が残した名札の無い lock dir
    await utimes(join(d, "lock"), past, past);
  }
  const ws = Array.from({ length: workers }, (_, s) =>
    Bun.spawn(["bun", import.meta.path, "worker", kind, String(rounds), String(s), String(workers), root, nostill ? "1" : "0", String(delay), String(flaky)], { stdout: "pipe", stderr: "pipe" }),
  );
  const errs = await Promise.all(ws.map((w) => new Response(w.stderr).text()));
  const codes = await Promise.all(ws.map((w) => w.exited));
  let crash = 0, overlap = 0, misgrab = 0, displaced = 0, gone = 0, reaped = 0, residue = 0, held = 0;
  const crashKinds: Record<string, number> = {};
  for (let i = 0; i < rounds; i++) {
    const log = await readFile(join(root, `r${i}`, "log"), "utf8").catch(() => "");
    const iv: { slot: string; from: number; to: number }[] = [];
    for (const l of log.split("\n")) {
      const [k = "", slot = "", x = "", y = ""] = l.split(" ");
      if (k === "crash") { crash++; crashKinds[x] = (crashKinds[x] ?? 0) + 1; }
      else if (k === "held") { held++; iv.push({ slot, from: Number(x), to: Number(y) }); }
      else if (k === "misgrab") misgrab++;
      else if (k === "displaced") displaced++;
      else if (k === "gone") gone++;
      else if (k === "reaped") reaped++;
    }
    for (let p = 0; p < iv.length; p++) for (let q = p + 1; q < iv.length; q++) {
      const A = iv[p]!, B = iv[q]!;
      if (A.from < B.to && B.from < A.to) overlap++;
    }
    const left = (await Array.fromAsync(new Bun.Glob("lock*").scan({ cwd: join(root, `r${i}`) }))).filter((f) => f !== "lock");
    residue += left.length;
  }
  console.log(JSON.stringify({ kind, rounds, workers, nostill, delay, flaky, codes, crash, crashKinds, overlap, misgrab, displaced, gone, reaped, held, residue, stderr: errs.map((e) => e.slice(0, 200)).filter(Boolean) }));
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}

// ---- worker ----
const [kind = "new", roundsS = "0", slotS = "0", workersS = "0", root = "", nostillS = "0", delayS = "0", flakyS = "0"] = a;
const rounds = Number(roundsS), slot = Number(slotS), workers = Number(workersS);
const nostill = nostillS === "1";
const delay = Number(delayS);
const flaky = Number(flakyS);
// 系全体で単調な時計(performance.now は process ごとの原点なので跨いで比べられない)
const clock = () => Number(process.hrtime.bigint() / 1000n) / 1000;

async function reapOld(lock: string, expect: Id): Promise<string> {
  const now = await stat(lock).catch(() => null);
  if (now && now.ino === expect.ino && now.mtimeMs === expect.mtimeMs) {
    await rm(lock, { recursive: true, force: true }); // ← ここで EFAULT が出る(PBI-0263 の主張)
    return "reaped";
  }
  return "someone_elses";
}
async function reapNew(lock: string, expect: Id, precheck: boolean): Promise<string> {
  if (precheck) {
    const now = await stat(lock).catch(() => null);
    if (!now || now.ino !== expect.ino || now.mtimeMs !== expect.mtimeMs) return "skipped";
  }
  const grab = `${lock}.reap.${process.pid}.${rnd()}`;
  try { await rename(lock, grab); } catch { return "gone"; }
  const got = await stat(grab).catch(() => null);
  if (got && got.ino === expect.ino && got.mtimeMs === expect.mtimeMs) {
    await rm(grab, { recursive: true, force: true }).catch(() => {});
    return "reaped";
  }
  await rename(grab, lock).catch(() => {});
  return "misgrab";
}
const reap = (lock: string, expect: Id) => kind === "old" ? reapOld(lock, expect) : reapNew(lock, expect, kind === "precheck");

// flaky: 混雑下で ps の spawn が失敗して「死んでいる」と誤判定する事を模す
const alive = (pid: number) => { if (flaky && Math.random() < flaky) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

for (let i = 0; i < rounds; i++) {
  const d = join(root, `r${i}`);
  const lock = join(d, "lock");
  const logf = join(d, "log");
  const log = (s: string) => appendFile(logf, s + "\n");
  // barrier
  await writeFile(join(d, `arrive.${slot}`), "");
  for (;;) {
    let n = 0;
    for (let s = 0; s < workers; s++) if (await stat(join(d, `arrive.${s}`)).then(() => true, () => false)) n++;
    if (n === workers) break;
    await sleep(1);
  }
  try {
    const me = `w${slot}${rnd()}\n${process.pid}`;
    const tmp = `${lock}.${process.pid}.${rnd()}.tmp`;
    await writeFile(tmp, me);
    const mine: Id = await stat(tmp);
    const stillHeld = async () => { const now = await stat(lock).catch(() => null); return now !== null && now.ino === mine.ino && now.mtimeMs === mine.mtimeMs; };
    let done = false;
    for (let attempt = 0; attempt < 400 && !done; attempt++) {
      try {
        await link(tmp, lock);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const st = await stat(lock).catch(() => null);
        const held = st ? await readFile(lock, "utf8").catch(() => null) : null;
        const heldByLive = held !== null && alive(Number(held.split("\n")[1] ?? "0"));
        if (st && !heldByLive && (held !== null || Date.now() - st.mtimeMs > STALE_LOCK_MS)) {
          const r = await reap(lock, st);
          await log(`${r} ${slot}`);
          continue;
        }
        await sleep(Math.random() * 2);
        continue;
      }
      try {
        // takeOver 相当: stillHeld を見てから critical section
        // takeOver の before / runningBrokerPid(ps) / after に当たる時間
        if (delay) await sleep(delay);
        if (!nostill && !(await stillHeld())) { await log(`displaced ${slot}`); continue; }
        const from = clock();
        await sleep(3);
        await log(`held ${slot} ${from} ${clock()}`);
        done = true;
      } finally {
        if (kind === "old") {
          if ((await readFile(lock, "utf8").catch(() => "")) === me) await rm(lock, { recursive: true, force: true });
        } else {
          await reapNew(lock, mine, kind === "precheck");
        }
      }
    }
    await rm(tmp, { force: true });
    if (!done) await log(`crash ${slot} gaveup`);
  } catch (e) {
    await log(`crash ${slot} ${(e as NodeJS.ErrnoException).code ?? String(e).slice(0, 40)}`);
  }
}
