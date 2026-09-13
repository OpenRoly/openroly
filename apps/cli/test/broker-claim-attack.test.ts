import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "@openroly/adapter";

// PBI-0218 有界レビューの攻撃 test。狙いは `claimBrokerPidFile` の**相互排他そのもの**で、
// login.test.ts の攻撃(pairing / whoami を通す)より 1 段下を、server 無しで直接叩く ——
// `openroly broker`(前景)は credential さえ在れば `claimBrokerPidFile` へ直行するので、
// HTTP も pairing も挟まずに「同時に何本が claim を勝ち取ったか」だけを測れる。
//
// 判定は **CLI 自身の申告**で行う(PBI-0218 と同じ数え方)。claim を勝った側だけが fake broker を
// 起こし、その stdout に `spawn pid=` が出る。負けた側は fail() で exit 1 + stderr。

const CLI = join(import.meta.dir, "../src/openroly.ts");
/** `brokerClaimLockPath()` と同じ path(openroly.ts の実装に合わせる) */
const LOCK_NAME = "broker.pid.lock";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-claim-attack-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 即 exit する fake broker。前景起動なので「起きたか」は stdout の 1 行で足りる */
// **起こした broker は少しの間だけ生きる**(PBI-0312)。即 exit だと、勝者が spawn した直後に
// broker が死ぬので、**遅れて来た 2 本目が「死んだ broker を正しく起こし直す」のは正しい振る舞い**
// になり、`started=2` が相互排他の破れなのか正しい再起動なのか区別できない。
// 実測(2026-09-06 CI): Linux では bun の起動が速く 2 本が重ならないので**毎 round** `started=2` に
// なり、macOS では重なるので `1/1` になっていた —— 実装ではなく **この fixture の寿命**が原因だった。
// 生かしておけば、2 本目は pid file が指す **生きた** broker を見て譲るので、`started=2` は
// 相互排他の破れだけを意味する
const fakeBrokerScript = `#!/bin/sh\necho "spawn pid=$$"\nsleep 2\nexit 0\n`;

async function freshEnv() {
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
      runtime_id: "rt_broker_claim_attack",
      token: "par_claim_attack",
      base_url: "http://127.0.0.1:9",
      name: hostname(),
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
  return {
    brokerHome,
    brokerPid: join(brokerHome, "broker.pid"),
    lock: join(brokerHome, LOCK_NAME),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      OPENROLY_HOME: home,
      OPENROLY_BROKER_HOME: brokerHome,
      OPENROLY_BROKER_BIN: bin,
      OPENROLY_URL: "http://127.0.0.1:9",
      OPENROLY_CLAIM_TRACE: "1", // PBI-0312: CI が赤い時に claim の判断を stderr から読む窓(この誤診を決着させた手段。env が無ければ 1 行も出ない)
    } as Record<string, string>,
  };
}

/** `since` は round の起点。各本の開始 / 終了をその相対で残す(負け側が勝者の exit 後に起きたか、が読める) */
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

/**
 * claim を勝った本数(fake broker が前景で吐いた行)と、譲った本数、**どちらでもない出口**の本数。
 * `other` を数えないと、負けた側が「lock を握れずに諦めた」(`could not tell whether a broker is
 * running`)のか、例外で落ちたのかが赤から読めない(PBI-0263: 負荷下で `started=1 yielded=0` が
 * 8 回中 4 回出たが、負け側が何で exit したかを 4 回とも取り損ねた)
 */
function tally(rs: Run[]) {
  const started = rs.filter((r) => /^spawn pid=\d+/m.test(r.out)).length;
  const yielded = rs.filter((r) => r.err.includes("The broker is already running")).length;
  return { started, yielded, other: rs.length - started - yielded };
}

/**
 * 1 本の結末を 1 行に(赤の assertion message に載せる。負け側の出口を名指しできる粒度)。
 * 例外で落ちた stderr は Bun が **source の抜粋を先に**出すので、先頭 400 字では本文が見えない ——
 * `error:` / `NG ` / 製品の文言の行を先に拾い、残りは末尾を添える
 */
function describeRun(r: Run): string {
  const squash = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
  const lines = r.err.split("\n").map((l) => l.trim());
  const gist = lines.find((l) => /^(error:|NG |The broker|[A-Za-z]*Error\b)/.test(l));
  const err = gist ? `${squash(gist, 240)} … ${squash(r.err.slice(-160), 160)}` : squash(r.err, 400);
  return `code=${r.code} t=${r.from}..${r.to}ms out="${squash(r.out, 120)}" err="${err}"`;
}

/**
 * `work` の間じゅう `ps -o lstart=` を 200ms 毎に叩いて、**その round の `ps` の所要(最大)**を測る。
 * claim の生死判定は全部 `ps` の exec に掛かっているので、負け側が諦めた時にこれが CLI の
 * 締切(20s)に迫っていれば環境由来、遠ければ実物(相互排他の穴)と分けられる(PBI-0263 AC-2)
 */
async function withPsLatency<T>(work: Promise<T>): Promise<{ value: T; psMaxMs: number; psSamples: number }> {
  let done = false;
  let psMaxMs = 0;
  let psSamples = 0;
  const sampler = (async () => {
    while (!done) {
      const t = performance.now();
      await lstartOf(process.pid);
      psMaxMs = Math.max(psMaxMs, Math.round(performance.now() - t));
      psSamples++;
      await Bun.sleep(200);
    }
  })();
  const value = await work;
  done = true;
  await sampler;
  return { value, psMaxMs, psSamples };
}

/** 確実に死んでいる pid。stale pid file の材料 */
async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

/** `ps -o lstart=` の 1 行(pid file / lock の名札はこの形で起動時刻まで持つ) */
async function lstartOf(pid: number): Promise<string> {
  const out = await new Response(
    Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe" }).stdout,
  ).text();
  return out.trim().replace(/\s+/g, " ");
}

/**
 * `withStaleTakeoverLock` が書くのと同じ形の lock を置く —— **1 行目 = 名札 / 2 行目 =
 * `<pid> <lstart>`** の file(dir ではない)。持ち主の生死は 2 行目で判定される
 */
async function writeLock(lock: string, pid: number, lstart: string): Promise<void> {
  await writeFile(lock, `someoneelse${pid}\n${pid} ${lstart}`);
}

/** `<死んだ pid> <本物の起動時刻>` = 誰も生きていない pid file */
async function writeStalePid(path: string): Promise<void> {
  const dead = await reapedPid();
  const lstart = await new Response(
    Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe" }).stdout,
  ).text();
  await writeFile(path, `${dead} ${lstart.trim().replace(/\s+/g, " ")}`);
}

describe("PBI-0218 review: claim の相互排他を破りにいく", () => {
  test(
    "攻撃1: 閾値を超えて古い lock dir が残っていると、同時の 2 本が両方「lock を取った」と思い込む",
    async () => {
      // `withStaleTakeoverLock` は名札の読めない lock(旧版が残した dir)を「mtime が STALE_LOCK_MS より
      // 古い = 持ち主のクラッシュ」と見て回収してから `link` する。回収と link に排他が無いと、
      // 2 本が同時に「古い」と判定した時に後発の回収が先発の link 済み lock を消し、**両方が lock を
      // 握ったつもりで takeOver に入る**。takeOver の中身は `runningBrokerPid → rm(pid file) → link` で、
      // 後発の rm が先発の link 済み file を消せば **両方が claim を勝つ**(= broker が 2 本上がる)。
      // PBI-0263: 回収は `rename` で掴んでから私有 path で消す形にした(2 本が同じ dir を同時に
      // `rm(recursive)` すると Bun が EFAULT を投げて負け側が落ちる = `started=1 yielded=0` の正体)
      const ROUNDS = 15;
      const seen: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const { env, brokerPid, lock } = await freshEnv();
        await writeStalePid(brokerPid);
        // 「持ち主がクラッシュして残った」lock を仕込む(mtime を 30s 前に倒す)
        await mkdir(lock);
        const past = new Date(Date.now() - 30_000);
        await utimes(lock, past, past);
        const since = performance.now();
        const { value: rs, psMaxMs, psSamples } = await withPsLatency(
          Promise.all([brokerFg(env, since), brokerFg(env, since)]),
        );
        const { started, yielded, other } = tally(rs);
        // 1/1 以外の round は **負け側の出口ごと**残す(started / yielded の数字だけでは第 3 の出口が
        // 「lock を握れず諦めた」か「例外で落ちた」か分からない。PBI-0263 AC-1)。
        // 実測した正体: 2 本が同じ古い lock dir を同時に `rm(recursive)` すると Bun が EFAULT を投げ、
        // 負け側が「already running」を言う前に stack trace で exit 1 していた(= `other`)。
        // `started=2` が出た時は t= の並びを見る —— 負け側が勝者の exit 後に始まっていれば相互排他の
        // 穴ではなく、死んだ fake broker を正しく起こし直しただけ(bun の起動が数秒ずれる混雑)
        const detail =
          started === 1 && yielded === 1
            ? ""
            : ` other=${other} ps_max=${psMaxMs}ms(${psSamples} samples)\n` +
              rs.map((r, i) => `    [${i}] ${describeRun(r)}`).join("\n");
        seen.push(`round ${round}: started=${started} yielded=${yielded}${detail}`);
      }
      expect(seen.join("\n")).toBe(
        Array.from({ length: ROUNDS }, (_, i) => `round ${i}: started=1 yielded=1`).join("\n"),
      );
    },
    300_000,
  );

  test(
    "攻撃2: 回収の根拠は持ち主の生死であって時限ではない(死んだ持ち主の lock を、時限に関係なく回収する)",
    async () => {
      // CLI が claim の途中で落ちると lock が残る。回収の根拠が **時限だけ** だと、
      // 持ち主が既に死んでいても STALE_LOCK_MS(10s)を丸ごと待たされ、置き土産 1 個で
      // CLAIM_DEADLINE_MS(20s)の予算を半分食う(実測 11s)。次の 1 個で **0 本**になる。
      //
      // 「何秒かかったか」を閾値にすると混雑した機で嘘の赤になる(実測: load 616 では bun の起動だけで
      // 12s)。そこで時間ではなく **時限が絶対に効かない条件**で測る —— lock の mtime を
      // **未来**に置くと、時限による回収(`now - mtime > STALE_LOCK_MS`)は永久に成立しない。
      // 生死で決める実装だけがここを抜けられる
      const { env, brokerPid, lock } = await freshEnv();
      await writeStalePid(brokerPid);
      const dead = await reapedPid();
      await writeLock(lock, dead, await lstartOf(process.pid));
      const future = new Date(Date.now() + 3_600_000);
      await utimes(lock, future, future);
      const rs = await Promise.all([brokerFg(env), brokerFg(env)]);
      expect(`${tally(rs).started} started / ${tally(rs).yielded} yielded`).toBe("1 started / 1 yielded");
      // 回収した後は自分の名札に置き換わる(死んだ持ち主の lock が残り続けない)
      expect(`lock left behind: ${await readFile(lock, "utf8").catch(() => "(none)")}`).toBe(
        "lock left behind: (none)",
      );
    },
    120_000,
  );

  test(
    "攻撃3: stale pid file の下で 5 本同時(AC-1 の 3 本より強い) — ちょうど 1 本",
    async () => {
      const { env, brokerPid } = await freshEnv();
      await writeStalePid(brokerPid);
      const rs = await Promise.all(Array.from({ length: 5 }, () => brokerFg(env)));
      expect(`${tally(rs).started} started / ${tally(rs).yielded} yielded`).toBe("1 started / 4 yielded");
      // 勝った 1 本の pid file が残る(誰の物でもない状態で終わらない)
      expect((await readFile(brokerPid, "utf8")).trim()).toMatch(/^\d+/);
    },
    120_000,
  );

  test(
    "攻撃4: pid file が「生きているが broker ではない」プロセスを旧形式(pid のみ)で指す — 起動する",
    async () => {
      const { env, brokerPid } = await freshEnv();
      const alive = Bun.spawn(["/bin/sh", "-c", "sleep 60"], { stdout: "ignore", stderr: "ignore" });
      try {
        await writeFile(brokerPid, String(alive.pid));
        const r = await brokerFg(env);
        // comm が openroly-broker でなければ「broker ではない」= 譲らない(0 本にしない)
        expect(`${r.code} ${/^spawn pid=\d+/m.test(r.out)}`).toBe("0 true");
      } finally {
        alive.kill();
        await alive.exited;
      }
    },
    120_000,
  );

  test(
    "攻撃5: lock を握られ続けて決められなくても、嘘の「already running」で正常終了しない",
    async () => {
      // 誰も broker を起こしていないのに claim が「他が走っている」を返すと、CLI は
      // 「The broker is already running」と言って **exit 0** で終わる = 0 本のまま user には
      // 成功に見え、住所に届いても誰も起きない(hero ③ が黙って崩れる)。
      // ここでは持ち主の分からない lock を握り続け(mtime を更新して時限回収も封じる)、
      // pid file は stale にしておく = 「生きた broker はどこにも居ない」
      const { env, brokerPid, lock } = await freshEnv();
      await writeStalePid(brokerPid);
      await mkdir(lock);
      const holder = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => {}), 1_000);
      try {
        const r = await brokerFg(env);
        const started = /^spawn pid=\d+/m.test(r.out);
        // 起動できなかったのなら、**「既に走っている」とは言わない**し、成功で終わらない
        const lied = !started && (r.err.includes("The broker is already running") || r.code === 0);
        expect(`started=${started} lied=${lied}`).toBe("started=false lied=false");
        expect(r.err).toContain("could not tell whether a broker is running");
      } finally {
        clearInterval(holder);
        await rm(lock, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "攻撃6: 生きた持ち主が lock を長く握っていても、時限で奪わずに待ってから起動する",
    async () => {
      // 時限だけで lock を奪うと、**遅い持ち主と後発の 2 本が同時に takeOver に入る** ——
      // takeOver の中身は `runningBrokerPid → rm(pid file) → link` なので、後発の rm が
      // 先発の link 済み file を消せば両方が claim を勝つ(= broker が 2 本)。
      // 生きている持ち主の lock は、どれだけ古くても奪ってはいけない
      const { env, brokerPid, lock } = await freshEnv();
      await writeStalePid(brokerPid);
      const alive = Bun.spawn(["/bin/sh", "-c", "sleep 60"], { stdout: "ignore", stderr: "ignore" });
      await writeLock(lock, alive.pid, await lstartOf(alive.pid));
      const began = Date.now();
      // 時限(10s)を十分に超えてから手放す。奪う実装なら 10s 前後で起動してしまう
      const release = setTimeout(() => void rm(lock, { recursive: true, force: true }).catch(() => {}), 25_000);
      try {
        const r = await brokerFg(env);
        const waited = Math.round((Date.now() - began) / 1000);
        expect(`started=${/^spawn pid=\d+/m.test(r.out)} stolen=${waited < 20}`).toBe(
          "started=true stolen=false",
        );
      } finally {
        clearTimeout(release);
        alive.kill();
        await alive.exited;
        await rm(lock, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
