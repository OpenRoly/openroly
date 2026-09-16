import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distribution, quantile, wilson } from "../src/stats.ts";
import {
  classifyResume,
  continuationSuccess,
  humanRecovered,
  STATE_LOSS_FIELDS,
  stateLoss,
  ttua,
  zeroLoss,
  type ContinuityAction,
  type ContinuityContextWrite,
  type ContinuityEvent,
  type ContinuityRun,
} from "../src/continuity-metrics.ts";
import {
  BENCHMARK_METRICS,
  creditsSpent,
  humanStepsOf,
  nextHumanStep,
  summarizeBenchmark,
  summarizeHumanLadder,
  type BenchmarkInput,
  type CreditReading,
  type HumanSteps,
  type InputOrigins,
  type TokenUsage,
} from "../src/benchmark-summary.ts";
import { FAILURE_INJECTIONS, formatRecovery, judgeRecovery, summarizeRecovery, type RecoveryRun } from "../src/recovery-metrics.ts";
import { formatResumeRate, listResumes, measureWork, summarizeResumes } from "../src/resume-metrics.ts";

// PBI-0464: no-reexplanation resume rate の判定。合成 event 列で AC 表を当てる(期待は PBI の AC 表から書く)。

const T0 = new Date("2026-09-13T00:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const ev = (kind: string, actor: string, s: number, transferId: string | null = null): ContinuityEvent => ({
  kind,
  actor,
  at: at(s),
  transferId,
});
const put = (key: string, actor: string, s: number): ContinuityContextWrite => ({ kind: "context", key, actor, at: at(s) });

describe("PBI-0464 classifyResume", () => {
  test("AC-1: resume の後に run の attempt_started が最初 → 説明し直し無し・差の秒", () => {
    expect(classifyResume({ resumeAt: at(0), events: [ev("attempt_started", "run", 14)], contextWrites: [] })).toEqual({
      reexplained: false,
      firstUsefulAt: at(14),
      secondsToUseful: 14,
    });
  });

  test("AC-2: user の comment_added が run の進捗より先 → reexplained・firstUsefulAt は run の進捗の時刻", () => {
    const events = [ev("comment_added", "user", 5), ev("proof_added", "run", 30)];
    expect(classifyResume({ resumeAt: at(0), events, contextWrites: [] })).toEqual({
      reexplained: true,
      firstUsefulAt: at(30),
      secondsToUseful: 30,
    });
  });

  test("AC-2: user の goal / next_step put も説明し直し。進捗より後の user の comment は数えない", () => {
    expect(
      classifyResume({ resumeAt: at(0), events: [ev("attempt_started", "run", 20)], contextWrites: [put("next_step", "user", 3)] })
        .reexplained,
    ).toBe(true);
    expect(
      classifyResume({ resumeAt: at(0), events: [ev("attempt_started", "run", 20), ev("comment_added", "user", 21)], contextWrites: [] })
        .reexplained,
    ).toBe(false);
  });

  test("auto/* の context 書き込み(run / server)は有効な作業。user の auto/* と resume より前の進捗は数えない", () => {
    expect(classifyResume({ resumeAt: at(0), events: [], contextWrites: [put("auto/git", "server", 9)] }).firstUsefulAt).toEqual(at(9));
    expect(
      classifyResume({ resumeAt: at(10), events: [ev("attempt_started", "run", 5)], contextWrites: [put("auto/git", "user", 12)] }),
    ).toEqual({ reexplained: false, firstUsefulAt: null, secondsToUseful: null });
  });

  test("AC-X1: actor = server / run の comment_added と specified は説明し直しに数えない(user だけ)", () => {
    for (const actor of ["server", "run"]) {
      const events = [ev("comment_added", actor, 1), ev("specified", actor, 2), ev("attempt_started", "run", 3)];
      expect(classifyResume({ resumeAt: at(0), events, contextWrites: [put("goal", actor, 1)] }).reexplained).toBe(false);
    }
  });
});

describe("PBI-0464 listResumes / measureWork", () => {
  test("AC-3: 初回 claim は resume に数えない。前の claim が在る claim は数え、transfer の claimed は transfer と 1 回", () => {
    expect(listResumes({ transfers: [], events: [ev("claimed", "server", 0)] })).toEqual([]);
    const events = [ev("claimed", "server", 0), ev("claimed", "server", 100), ev("claimed", "server", 200, "xfer1")];
    const transfers = [
      { id: "xfer1", state: "committed", updatedAt: at(200) },
      { id: "xfer0", state: "failed", updatedAt: at(50) },
    ];
    expect(listResumes({ transfers, events })).toEqual([
      { at: at(100), via: "claim" },
      { at: at(200), via: "transfer" },
    ]);
  });

  test("AC-X3: 同じ work に resume 2 回 → 2 件独立。2 回目の窓の event を 1 回目に数えない", () => {
    const transfers = [
      { id: "a", state: "committed", updatedAt: at(0) },
      { id: "b", state: "committed", updatedAt: at(100) },
    ];
    const events = [ev("comment_added", "user", 110), ev("attempt_started", "run", 120)];
    expect(measureWork({ transfers, events, contextWrites: [] }).map((m) => m.result)).toEqual([
      { reexplained: false, firstUsefulAt: null, secondsToUseful: null },
      { reexplained: true, firstUsefulAt: at(120), secondsToUseful: 20 },
    ]);
  });
});

describe("PBI-0464 summary", () => {
  test("AC-4 の形: 0 件は 0% と書かない", () => {
    expect(formatResumeRate(summarizeResumes([]))).toEqual([
      "resumes 0",
      "no-reexplanation 0 (n/a)",
      "median seconds to useful action n/a",
      "resumes without any useful action 0",
    ]);
  });

  test("率は有効な作業を始めて説明し直しが無かった物だけ・中央値は偶数件で真ん中 2 つの平均", () => {
    const s = summarizeResumes([
      { reexplained: false, firstUsefulAt: at(10), secondsToUseful: 10 },
      { reexplained: true, firstUsefulAt: at(30), secondsToUseful: 30 },
      { reexplained: false, firstUsefulAt: null, secondsToUseful: null },
      { reexplained: false, firstUsefulAt: at(20), secondsToUseful: 20 },
    ]);
    expect(s).toEqual({ resumes: 4, noReexplanation: 2, medianSecondsToUseful: 20, withoutUsefulAction: 1 });
    expect(formatResumeRate(s)[1]).toBe("no-reexplanation 2 (50.0%)");
  });
});

// PBI-0568: Continuity Benchmark の判定。合成の tool-call 列で AC 表を当てる。
describe("PBI-0568 Continuity Benchmark", () => {
  const SESSION = "src/auth/session.ts";
  const spec = { usefulTargets: [SESSION, "bun test test/auth.test.ts"] };
  const act = (kind: ContinuityAction["kind"], s: number, target?: string): ContinuityAction => ({ kind, at: at(s), target });
  const body = {
    goal: "login が 2 回目で落ちる bug を直す",
    decisions: ["JWT に戻さない"],
    unresolved_questions: ["cookie の SameSite"],
    failed_attempts: ["token の期限延長"],
    relevant_artifacts: [SESSION],
    git_state: { baseCommit: "abc123", dirty: true },
    capability_requirements: ["github.pr.create"],
  };
  const run = (over: Partial<ContinuityRun> = {}): ContinuityRun => ({
    t0: at(0),
    actions: [act("read", 9, SESSION)],
    sourceCheckpoint: { work_id: "wrk_1", content_hash: "h1", body },
    targetView: Object.values(STATE_LOSS_FIELDS),
    userEvents: [],
    checkpointStillPresent: true,
    ...over,
  });

  test("AC-1: say は有効 action に数えない。read が 9 秒 → ttua 9", () => {
    expect(ttua(run({ actions: [act("say", 2, "続きをやります"), act("read", 9, SESSION)] }), spec)).toBe(9);
    const sayOnly = run({ actions: [act("say", 2, "続きをやります")] });
    expect(ttua(sayOnly, spec)).toBeNull();
    expect(continuationSuccess(sayOnly, spec)).toBe(false);
    // 有効集合の file を口にしただけ(say の target が集合に在る)でも数えない
    const saysTheFile = run({ actions: [act("say", 2, SESSION)] });
    expect(ttua(saysTheFile, spec)).toBeNull();
    expect(continuationSuccess(saysTheFile, spec)).toBe(false);
  });

  test("AC-2: 8 カテゴリ全部 + 元 checkpoint → [] / decisions だけ無い → [decisions] / 元 checkpoint が消えた → false", () => {
    expect(stateLoss(run())).toEqual([]);
    expect(zeroLoss(run())).toBe(true);
    const noDecisions = run({ targetView: Object.values(STATE_LOSS_FIELDS).filter((f) => f !== "decisions") });
    expect(stateLoss(noDecisions)).toEqual(["decisions"]);
    expect(zeroLoss(noDecisions)).toBe(false);
    const gone = run({ checkpointStillPresent: false });
    expect(stateLoss(gone)).toEqual([]);
    expect(zeroLoss(gone)).toBe(false);
    // source に無かった field は落としようが無い
    const { failed_attempts: _, ...noAttempts } = body;
    expect(
      stateLoss(run({ sourceCheckpoint: { work_id: "wrk_1", content_hash: "h1", body: noAttempts }, targetView: ["work_id"] })),
    ).toEqual(["checkpoint", "git_changes", "decisions", "artifacts", "open_questions", "capability_requirements"]);
  });

  test("AC-3: handoff 後 30 秒に user が decisions を put → humanRecovered / 0464 の classifyResume と同じ判定", () => {
    const r = run({ actions: [act("read", 40, SESSION)], userEvents: [{ kind: "edit", key: "decisions", at: at(30) }] });
    expect(humanRecovered(r, spec)).toBe(true);
    expect(continuationSuccess(r, spec)).toBe(false);
    expect(
      classifyResume({ resumeAt: at(0), events: [ev("attempt_started", "run", 40)], contextWrites: [put("decisions", "user", 30)] })
        .reexplained,
    ).toBe(humanRecovered(r, spec));
    expect(humanRecovered(run({ actions: [act("read", 40, SESSION)], userEvents: [{ kind: "message", at: at(5) }] }), spec)).toBe(true);
  });

  test("AC-X1: target の runtime が何でも同じ判定", () => {
    const base = summarizeBenchmark([{ run: run(), caseSpec: spec }]);
    for (const runtime of ["claude", "opencode", "codex"]) {
      expect(summarizeBenchmark([{ run: { ...run(), runtime } as ContinuityRun, caseSpec: spec }])).toEqual(base);
    }
  });

  test("AC-X2: tool-call log が取れない run は unmeasured で分母から外れる", () => {
    const s = summarizeBenchmark([
      { run: run(), caseSpec: spec },
      { run: run({ actions: null, checkpointStillPresent: false }), caseSpec: spec },
    ]);
    expect(s).toEqual({
      runs: 2,
      unmeasured: 1,
      cutoff: { n: 0, cut: 0, rewakeN: 0, rewoken: 0, rewokenFinished: 0 },
      dist: { time_to_useful_action: { n: 1, p50: 9, p90: null } },
      cost: { tokens: null, credits: null },
      metrics: {
        continuation_success: 1,
        time_to_useful_action: 9,
        human_recovery: 0,
        state_loss: 0,
        recovery_after_failed_handoff: null,
        final_task_success: null,
        cutoff_rate: null,
      },
    });
    expect(summarizeBenchmark([{ run: run({ actions: null }), caseSpec: spec }]).metrics.continuation_success).toBeNull();
  });

  test("PBI-0572: final_task_success = 結果品質の判定が付いた run の率(判定の無い run・unmeasured は分母外)", () => {
    const s = summarizeBenchmark([
      { run: run(), caseSpec: spec, finalTaskSuccess: true },
      { run: run(), caseSpec: spec, finalTaskSuccess: false },
      { run: run(), caseSpec: spec, finalTaskSuccess: null },
      { run: run({ actions: null }), caseSpec: spec, finalTaskSuccess: true },
    ]);
    expect(s.metrics.final_task_success).toBe(0.5);
  });

  test("AC-5: specs/paap/benchmark.md の 6 指標名・8 カテゴリ名(と field 名)は core と同じ集合", () => {
    const md = readFileSync(join(import.meta.dir, "../../../specs/paap/benchmark.md"), "utf8");
    const section = (title: string) => md.split(/^## /m).find((s) => s.startsWith(title)) ?? "";
    expect({
      metrics: [...section("2. Metrics").matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort(),
      categories: [...section("3. State loss categories").matchAll(/^\| `([a-z_]+)` \| `([a-z_]+)` \|/gm)]
        .map((m) => `${m[1]}=${m[2]}`)
        .sort(),
    }).toEqual({
      metrics: [...BENCHMARK_METRICS].sort(),
      categories: Object.entries(STATE_LOSS_FIELDS)
        .map(([c, f]) => `${c}=${f}`)
        .sort(),
    });
  });
});

// PBI-0571: 失敗の注入からの取り戻し。合成の RecoveryRun で AC 表を当てる。
describe("PBI-0571 Recovery after failed handoff", () => {
  const PROOF = "work_proof:KUMQUAT-0571-R1";
  const spec = { usefulTargets: [PROOF] };
  const target = (actions: ContinuityAction[] | null): ContinuityRun => ({
    t0: at(0),
    actions,
    sourceCheckpoint: { work_id: "wrk_1", content_hash: "h1", body: { goal: "report the code word" } },
    targetView: ["work_id", "content_hash", "goal"],
    userEvents: [],
    checkpointStillPresent: true,
  });
  const proved = { run: target([{ kind: "tool", at: at(20), target: PROOF }]), caseSpec: spec };
  const rec = (over: Partial<RecoveryRun> = {}): RecoveryRun => ({
    injection: "process_kill",
    fired: true,
    handoff: { state: "failed", reason: "commit_timeout" },
    checkpointKept: true,
    recovery: proved,
    unmeasured: null,
    ...over,
  });

  test("AC-X2: 注入が効かなかった run は injection_missed で分母から外れ、成功に数えない", () => {
    const beforeKill = rec({ handoff: { state: "committed", reason: null } });
    expect(judgeRecovery(beforeKill)).toEqual({ kind: "injection_missed" });
    expect(judgeRecovery(rec({ fired: false }))).toEqual({ kind: "injection_missed" });
    // usage_limit は源が止まる注入 = handoff は committed でよい(missed にしない)
    expect(judgeRecovery(rec({ injection: "usage_limit", handoff: { state: "committed", reason: null } }))).toEqual({ kind: "recovered" });
    const s = summarizeRecovery([beforeKill, rec()]);
    expect(s.rows.process_kill).toMatchObject({ runs: 2, missed: 1, recovered: 1, checkpointKept: 1 });
    expect([s.injected, s.recoverable, s.lost, s.rate]).toEqual([1, 1, 0, 1]);
  });

  test("AC-3: 取り戻せなかった run は lost に数え、段を 1 語で出す", () => {
    expect(judgeRecovery(rec({ checkpointKept: false }))).toEqual({ kind: "lost", stage: "no_checkpoint" });
    expect(judgeRecovery(rec({ recovery: null }))).toEqual({ kind: "lost", stage: "claim_failed" });
    expect(judgeRecovery(rec({ recovery: { run: target([]), caseSpec: spec } }))).toEqual({ kind: "lost", stage: "recovery_failed" });
    const lines = formatRecovery(summarizeRecovery([rec({ injection: "network_cut", recovery: null }), rec({ injection: "network_cut" })]));
    expect(lines.find((l) => l.startsWith("network_cut:"))).toContain("lost (claim_failed 1)");
    expect(lines.slice(-3)).toEqual(["work recoverable: 1", "work lost: 1", "Recovery success: 50.0%"]);
  });

  test("unmeasured(429・handoff が立たない・target の log が無い)は分母外。recovery_after_failed_handoff は rate", () => {
    expect(judgeRecovery(rec({ unmeasured: "zai 429" }))).toEqual({ kind: "unmeasured", reason: "zai 429" });
    expect(judgeRecovery(rec({ handoff: null }))).toEqual({ kind: "unmeasured", reason: "handoff did not start" });
    expect(judgeRecovery(rec({ recovery: { run: target(null), caseSpec: spec } }))).toEqual({ kind: "unmeasured", reason: "no tool-call log" });
    expect(summarizeRecovery([rec({ unmeasured: "zai 429" })]).rate).toBeNull();
    // 率は summarizeRecovery が出す(PBI-0614: 表はこの JSON から直に読む。本測定の集計はもう recovery を呼ばない ——
    // 呼ぶと判定集合が繋がり、費用の欄を足しただけで recovery の 30 run が測り直しになる)
    expect(summarizeRecovery([rec(), rec({ recovery: null })]).rate).toBe(0.5);
    expect(summarizeBenchmark([]).metrics.recovery_after_failed_handoff).toBeNull();
  });

  test("AC-1: 6 種 × 5 run → 種ごと 1 行 + 集計 4 行。target_start_fail で handoff が通っても続きが無い run は取り戻しに数えない", () => {
    const committed = { state: "committed", reason: null };
    const runs: RecoveryRun[] = [
      ...Array.from({ length: 5 }, () => rec({ injection: "normal", handoff: committed })),
      ...Array.from({ length: 5 }, () => rec({ injection: "usage_limit", handoff: committed })),
      ...Array.from({ length: 5 }, () => rec({ injection: "process_kill" })),
      ...Array.from({ length: 4 }, () => rec({ injection: "network_cut", handoff: { state: "failed", reason: "route_failed:no_broker" } })),
      rec({ injection: "network_cut", handoff: committed }),
      ...Array.from({ length: 3 }, () => rec({ injection: "target_start_fail" })),
      // 取り戻しの handoff は committed になったが target は合言葉を届けていない
      ...Array.from({ length: 2 }, () => rec({ injection: "target_start_fail", recovery: { run: target([]), caseSpec: spec } })),
      ...Array.from({ length: 5 }, () => rec({ injection: "handoff_timeout" })),
    ];
    const lines = formatRecovery(summarizeRecovery(runs));
    expect(lines.length).toBe(FAILURE_INJECTIONS.length + 4);
    expect(lines.slice(0, 6).map((l) => l.split(":")[0])).toEqual([...FAILURE_INJECTIONS]);
    expect(lines[1]).toBe("usage_limit: runs 5 · states [committed 5] · I-7 5/5 · recovered 5/5 · zero-loss 5/5");
    expect(lines[3]).toBe(
      "network_cut: runs 5 · states [committed 1, failed:route_failed:no_broker 4] · I-7 4/4 · recovered 4/4 · zero-loss 4/4 · injection_missed 1",
    );
    expect(lines[4]).toBe(
      "target_start_fail: runs 5 · states [failed:commit_timeout 5] · I-7 5/5 · recovered 3/5 · zero-loss 5/5 · lost (recovery_failed 2)",
    );
    expect(lines.slice(-4)).toEqual([
      "handoff failure injected: 24",
      "work recoverable: 22",
      "work lost: 2",
      "Recovery success: 91.7%",
    ]);
  });
});

describe("PBI-0584 台本の人(Human nudge / Human re-explanation)", () => {
  const spec = { usefulTargets: ["src/checkout.ts"] };
  // 有効 action(9 秒の edit)の後に止まった run。人の段は有効 action の後なので 0464 の窓の外
  const run: ContinuityRun = {
    t0: at(0),
    actions: [{ kind: "edit", at: at(9), target: "src/checkout.ts" }],
    sourceCheckpoint: { work_id: "w", content_hash: "h", body: {} },
    targetView: ["work_id", "content_hash"],
    userEvents: [],
    checkpointStillPresent: true,
  };
  /** outcomes = 段 0・1・2 の後の結果品質。bench の climbLadder と同じく nextHumanStep が返す段だけを踏む */
  const climb = (outcomes: boolean[]) => {
    const finals = [outcomes[0]!];
    const interventions: { actor: string }[] = [];
    for (let step = nextHumanStep(finals); step !== null; step = nextHumanStep(finals)) {
      interventions.push({ actor: "user" });
      finals.push(outcomes[step]!);
    }
    return { humanSteps: humanStepsOf(interventions), finalTaskSuccess: finals.at(-1)! };
  };

  test("AC-1: 段 0 ✗ → 段 1 ✓ / 段 0 ✗ → 段 1 ✗ → 段 2 ✓ / 段 0 ✓ → nudge 1/3・re-explanation 1/3・段 0 で済んだ 1/3", () => {
    const runs = [climb([false, true, false]), climb([false, false, true]), climb([true, false, false])];
    expect(runs.map((r) => r.humanSteps)).toEqual([1, 2, 0]);
    expect(summarizeHumanLadder(runs)).toEqual({ attended: 3, unreachable: 0, n: 3, noHelp: 1, nudge: 1, reexplanation: 1, stillFailing: 0 });
    // 段 2 の後も ✗ は re-explanation の内数・段 2 の先は無い
    expect(climb([false, false, false])).toEqual({ humanSteps: 2, finalTaskSuccess: false });
    expect(summarizeHumanLadder([climb([false, false, false])]).stillFailing).toBe(1);
    expect(nextHumanStep([])).toBeNull();

    // 表の human_recovery は段 2 まで要った率。0464 の proxy(有効 action までの人の message)では 0 にしかならない run
    expect(humanRecovered(run, spec)).toBe(false);
    const s = summarizeBenchmark(runs.map((r) => ({ run, caseSpec: spec, humanSteps: r.humanSteps })));
    expect(s.metrics.human_recovery).toBeCloseTo(1 / 3);
    // continuation success は段 0 のまま(人が割り込む前に続きを始めていた)
    expect(s.metrics.continuation_success).toBe(1);
  });

  test("AC-X1 別 actor: PBI-0583 の自動の起こし直し(actor = system)は段に数えない", () => {
    expect(humanStepsOf([{ actor: "system" }])).toBe(0);
    expect(humanStepsOf([{ actor: "system" }, { actor: "user" }, { actor: "system" }])).toBe(1);
    expect(humanStepsOf([{ actor: "user" }, { actor: "user" }, { actor: "user" }])).toBe(2);
  });

  test("AC-X2 失敗経路: 段を届けられなかった run(humanSteps null)は分母から外す —— 人の介入 0 と数えない", () => {
    expect(summarizeHumanLadder([{ humanSteps: null, finalTaskSuccess: false }, { humanSteps: 2, finalTaskSuccess: true }])).toEqual({
      attended: 2,
      unreachable: 1,
      n: 1,
      noHelp: 0,
      nudge: 0,
      reexplanation: 1,
      stillFailing: 0,
    });
    const steps = (hs: (HumanSteps | null)[]) => summarizeBenchmark(hs.map((humanSteps) => ({ run, caseSpec: spec, humanSteps }))).metrics.human_recovery;
    expect(steps([null, 2])).toBe(1);
    expect(steps([null])).toBeNull();
    // 人の居ない run(humanSteps が無い)は今まで通り 0464 の判定
    expect(summarizeBenchmark([{ run, caseSpec: spec }]).metrics.human_recovery).toBe(0);
  });
});

// PBI-0605: 完了 1 件あたりの費用。分子は測った run 全部の消費・分母は完了した run。
describe("PBI-0605 完了 1 件あたりの費用", () => {
  const spec = { usefulTargets: ["src/checkout.ts"] };
  const base: ContinuityRun = {
    t0: at(0),
    actions: [{ kind: "read", at: at(5), target: "src/checkout.ts" }],
    sourceCheckpoint: { work_id: "w", content_hash: "h", body: {} },
    targetView: ["work_id", "content_hash"],
    userEvents: [],
    checkpointStillPresent: true,
  };
  const tok = (input: number, cacheRead = 0): TokenUsage => ({ input, output: 0, reasoning: 0, cacheRead, cacheWrite: 0 });
  const cred = (spent: number): CreditReading => ({ before: { window: 0, week: 1000 }, after: { window: 0, week: 1000 + spent } });
  const runOf = (finalTaskSuccess: boolean, over: Partial<BenchmarkInput> = {}): BenchmarkInput => ({
    run: base,
    caseSpec: spec,
    finalTaskSuccess,
    tokens: tok(100, 1000),
    credits: cred(10),
    ...over,
  });
  const many = (n: number, r: BenchmarkInput) => Array.from({ length: n }, () => r);

  test("AC-1: 完了 8 / 未完了 2 → 分子は 10 本の消費・分母は完了した 8 本・未完了の消費は別欄", () => {
    const s = summarizeBenchmark([...many(8, runOf(true)), ...many(2, runOf(false))]);
    expect(s.cost.tokens).toMatchObject({ n: 10, finished: 8 });
    expect(s.cost.tokens!.total.input).toBe(1000);
    expect(s.cost.tokens!.perFinished!.input).toBe(125); // 1000 / 8 —— 未完了 2 本が使った分も分子に入る
    expect(s.cost.tokens!.wasted.input).toBe(200);
    expect(s.cost.credits).toEqual({ n: 10, finished: 8, total: 100, perFinished: 12.5, wasted: 20 });
  });

  test("AC-3: runtime が消費を返さない run は unmeasured —— 分子にも分母にも入れない", () => {
    const s = summarizeBenchmark([runOf(true), runOf(true, { tokens: null }), runOf(true, { tokens: undefined })]);
    expect(s.cost.tokens).toMatchObject({ n: 1, finished: 1 });
    expect(s.cost.tokens!.perFinished!.input).toBe(100); // 3 で割らない
    expect(summarizeBenchmark([runOf(true, { tokens: null, credits: null })]).cost).toEqual({ tokens: null, credits: null });
  });

  test("AC-X1 失敗経路: credit の口が無い runtime は credits が null(token だけ出す・推定しない)", () => {
    const s = summarizeBenchmark([runOf(true, { credits: null }), runOf(false, { credits: null })]);
    expect(s.cost.credits).toBeNull();
    expect(s.cost.tokens!.perFinished!.cacheRead).toBe(2000); // 2 本分の cache 読みを、完了した 1 本で割る
  });

  test("窓が戻った / 同じ鍵を他が使った run(差が負)は credit を unmeasured にする", () => {
    expect(creditsSpent({ before: { window: 0, week: 100 }, after: { window: 0, week: 90 } })).toBeNull();
    expect(creditsSpent({ before: { window: 0, week: 100 }, after: { window: 0, week: 143 } })).toBe(43);
    expect(summarizeBenchmark([runOf(true, { credits: { before: { window: 0, week: 100 }, after: { window: 0, week: 90 } } })]).cost.credits).toBeNull();
  });
});

// PBI-0608: 入力 token の内訳。どこを削れば効くかを方式ごとに名指しできる(内訳の分母は費用の分母と別)。
describe("PBI-0608 入力 token の内訳", () => {
  const spec = { usefulTargets: ["src/checkout.ts"] };
  const base: ContinuityRun = {
    t0: at(0),
    actions: [{ kind: "read", at: at(5), target: "src/checkout.ts" }],
    sourceCheckpoint: { work_id: "w", content_hash: "h", body: {} },
    targetView: ["work_id", "content_hash"],
    userEvents: [],
    checkpointStillPresent: true,
  };
  const by = (passed: number, fixed: number, read = 0, other = 0, unknown = 0): InputOrigins => ({ passed, fixed, read, other, unknown });
  /** inputBy を渡さない = 消費は記録したが内訳を記録していない古い行 */
  const tokOf = (input: number, inputBy?: InputOrigins): TokenUsage => ({
    input,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...(inputBy ? { inputBy } : {}),
  });
  const runOf = (finalTaskSuccess: boolean, tokens: TokenUsage | null): BenchmarkInput => ({
    run: base,
    caseSpec: spec,
    finalTaskSuccess,
    tokens,
    credits: null,
  });
  const many = (n: number, r: BenchmarkInput) => Array.from({ length: n }, () => r);

  test("AC-2: 方式ごとに内訳が並ぶ —— 渡した物だけでなく固定費も見える", () => {
    // 実測の形(2026-09-15 impact-long): 渡す物は A 約 900 / Cc 約 78,800 token = 88 倍違うのに、入力は 1.45 倍しか違わない
    const a = summarizeBenchmark(many(2, runOf(true, tokOf(46_016, by(900, 27_900, 17_016, 200)))));
    const cc = summarizeBenchmark(many(2, runOf(true, tokOf(66_806, by(78_800, 27_900, 0, 106)))));
    expect(a.cost.tokens!.inputBy!.perFinished).toEqual(by(900, 27_900, 17_016, 200));
    expect(cc.cost.tokens!.inputBy!.perFinished).toEqual(by(78_800, 27_900, 0, 106));
    // 固定費は方式を変えても動かない = 渡す物を小さくしても減らない所(この PBI が名指したい構造)
    expect(a.cost.tokens!.inputBy!.perFinished!.fixed).toBe(cc.cost.tokens!.inputBy!.perFinished!.fixed);
    // 和は入力そのもの(2 本分の total が input の 2 倍)
    const t = a.cost.tokens!.inputBy!.total;
    expect(t.passed + t.fixed + t.read + t.other + t.unknown).toBe(2 * 46_016);
  });

  test("AC-1: 分子は測った run 全部・分母は完了した run(費用の行と同じ数え方)", () => {
    const s = summarizeBenchmark([...many(8, runOf(true, tokOf(100, by(10, 90)))), ...many(2, runOf(false, tokOf(100, by(10, 90))))]);
    expect(s.cost.tokens!.inputBy).toMatchObject({ n: 10, finished: 8 });
    expect(s.cost.tokens!.inputBy!.total.fixed).toBe(900); // 未完了 2 本の固定費も分子に入る
    expect(s.cost.tokens!.inputBy!.perFinished!.fixed).toBe(112.5); // 900 / 8
  });

  test("AC-4 / AC-X1: 内訳を記録していない run は内訳の分母から外れる(0 と数えない・費用の分母には残る)", () => {
    const s = summarizeBenchmark([runOf(true, tokOf(100, by(10, 90))), runOf(true, tokOf(100))]);
    expect(s.cost.tokens!.n).toBe(2); // 費用は 2 本とも測れている
    expect(s.cost.tokens!.inputBy!.n).toBe(1); // 内訳は 1 本だけ
    expect(s.cost.tokens!.inputBy!.perFinished).toEqual(by(10, 90)); // 2 で割らない
    // 1 件も記録が無ければ null = 内訳は unmeasured(0 の内訳を書かない)
    expect(summarizeBenchmark([runOf(true, tokOf(100))]).cost.tokens!.inputBy).toBeNull();
    expect(summarizeBenchmark([runOf(true, null)]).cost.tokens).toBeNull();
  });

  test("AC-X2 別 actor: credit の口が無い側(claude の枠)でも内訳は出る", () => {
    const s = summarizeBenchmark([runOf(true, tokOf(100, by(10, 90)))]);
    expect(s.cost.credits).toBeNull();
    expect(s.cost.tokens!.inputBy!.perFinished).toEqual(by(10, 90));
  });
});

// PBI-0604: 中央値 1 つでは隠れる裾。p50 / p90 と 95% の幅を stats.ts の 1 か所から。
describe("PBI-0604 分布(p50 / p90)", () => {
  const spec = { usefulTargets: ["src/checkout.ts"] };
  /** sec = 有効 action までの秒。null = 発言だけ(時間が取れない run) */
  const runAt = (sec: number | null): ContinuityRun => ({
    t0: at(0),
    actions: [sec === null ? { kind: "say", at: at(1), target: "続きをやります" } : { kind: "edit", at: at(sec), target: "src/checkout.ts" }],
    sourceCheckpoint: { work_id: "w", content_hash: "h", body: {} },
    targetView: ["work_id", "content_hash"],
    userEvents: [],
    checkpointStillPresent: true,
  });
  // 中央値 17 秒の裏に 120 秒が 1 本(10 回に 1 回 2 分待たされた)
  const TAIL = [10, 12, 14, 15, 16, 18, 20, 22, 24, 120];
  /** 補間なので p90 は浮動小数(表は toFixed(1) で出す)。n と p50 は厳密に */
  const expectTail = (d: { n: number; p50: number; p90: number | null } | null) => {
    expect([d!.n, d!.p50]).toEqual([10, 17]);
    expect(d!.p90).toBeCloseTo(33.6, 6);
  };

  test("AC-1: p50 と p90 の両方・n も返る —— 裾の 1 本が p90 に出る", () => {
    expectTail(distribution(TAIL));
    const s = summarizeBenchmark(TAIL.map((sec) => ({ run: runAt(sec), caseSpec: spec })));
    expectTail(s.dist.time_to_useful_action);
    expect(s.metrics.time_to_useful_action).toBe(17); // 表の中央値は p50 と同じ物(2 か所で計算しない)
  });

  test("AC-2: n < 10 は p90 を出さない(外挿しない)・p50 は今までの中央値と同じ", () => {
    expect(distribution([1, 2, 3])).toEqual({ n: 3, p50: 2, p90: null });
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5); // 偶数件は真ん中 2 つの平均
    expect(distribution([])).toBeNull(); // 0 件は 0 と言わない
    expect(summarizeBenchmark([1, 2, 3, 200].map((sec) => ({ run: runAt(sec), caseSpec: spec }))).dist.time_to_useful_action!.p90).toBeNull();
  });

  test("AC-X1 失敗経路: 時間が取れなかった run は分母から外す(0 秒と数えない)", () => {
    const s = summarizeBenchmark([...TAIL, null, null].map((sec) => ({ run: runAt(sec), caseSpec: spec })));
    expectTail(s.dist.time_to_useful_action); // n=12 にならない
    expect(summarizeBenchmark([{ run: runAt(null), caseSpec: spec }]).dist.time_to_useful_action).toBeNull();
  });

  test("AC-X2 別 actor: 率の 95% の幅も同じ stats.ts から(PBI-0585 / 0592 と二重に実装しない)", () => {
    const w = wilson(28, 30)!; // README の 93.3% (n=30)
    expect([+(100 * w.lo).toFixed(1), +(100 * w.hi).toFixed(1)]).toEqual([78.7, 98.2]);
    expect(wilson(0, 0)).toBeNull();
  });
});

// PBI-0603: 途切れ(次の AI が tool を呼んだ直後に黙って止まった run)。run 行の sessionEnd / guardRewake を数える。
describe("PBI-0603 途切れ(cutoff_rate)", () => {
  const spec = { usefulTargets: ["src/checkout.ts"] };
  const base: ContinuityRun = {
    t0: at(0),
    actions: [{ kind: "read", at: at(5), target: "src/checkout.ts" }],
    sourceCheckpoint: { work_id: "w", content_hash: "h", body: {} },
    targetView: ["work_id", "content_hash"],
    userEvents: [],
    checkpointStillPresent: true,
  };
  /** target の最初の session の終わり方。tool = 返事が来ないまま終わった */
  const end = (lastPart: "tool" | "text") => ({ exit: 0, lastPart, error: null });
  const many = (n: number, r: BenchmarkInput): BenchmarkInput[] => Array.from({ length: n }, () => r);
  const cut = (finalTaskSuccess = true): BenchmarkInput => ({ run: base, caseSpec: spec, sessionEnd: end("tool"), guardRewake: 1, finalTaskSuccess });
  const ok = (): BenchmarkInput => ({ run: base, caseSpec: spec, sessionEnd: end("text"), guardRewake: 0, finalTaskSuccess: true });

  test("AC-1: 途切れ 2 / 正常 8 → cutoff_rate 0.2(n=10)・guard_rewake の件数も別に出る", () => {
    const s = summarizeBenchmark([...many(2, cut()), ...many(8, ok())]);
    expect(s.metrics.cutoff_rate).toBe(0.2);
    expect(s.cutoff).toEqual({ n: 10, cut: 2, rewakeN: 10, rewoken: 2, rewokenFinished: 2 });
  });

  test("AC-2: 「途切れた率」と「起こし直しで戻った率」は別の欄 —— 戻っても途切れた事実は消えない", () => {
    const s = summarizeBenchmark([cut(true), cut(false), ...many(8, ok())]);
    expect(s.metrics.cutoff_rate).toBe(0.2);
    expect([s.cutoff.rewoken, s.cutoff.rewokenFinished]).toEqual([2, 1]);
  });

  test("AC-X1 失敗経路: sessionEnd を持たない古い行は分母から外す(0 と数えない)", () => {
    const old = many(90, { run: base, caseSpec: spec, finalTaskSuccess: true });
    const s = summarizeBenchmark([...many(2, cut()), ...many(8, ok()), ...old]);
    expect([s.cutoff.n, s.metrics.cutoff_rate]).toEqual([10, 0.2]); // 90 本に薄まって 0.02 にならない
    expect(summarizeBenchmark(old).metrics.cutoff_rate).toBeNull(); // 1 件も記録が無ければ 0% と言わない
  });

  test("AC-X2 別 actor: 起こし直しが無効の run は guard_rewake が unmeasured・cutoff_rate は出る", () => {
    const noGuard = (lastPart: "tool" | "text"): BenchmarkInput => ({ run: base, caseSpec: spec, sessionEnd: end(lastPart) });
    const s = summarizeBenchmark([noGuard("tool"), ...many(4, noGuard("text"))]);
    expect(s.metrics.cutoff_rate).toBe(0.2);
    expect([s.cutoff.rewakeN, s.cutoff.rewoken]).toEqual([0, 0]);
  });

  test("tool-call log が取れない run は途切れの分母にも入らない(0568 の unmeasured と同じ分母)", () => {
    const s = summarizeBenchmark([{ ...cut(), run: { ...base, actions: null } }, ...many(2, ok())]);
    expect([s.cutoff.n, s.cutoff.cut]).toEqual([2, 0]);
  });
});
