import { describe, expect, test } from "bun:test";
import { matchWorkId, mcpSessionRunId, isMcpSessionRun, pickContinueWork, stallOf, uniqueWorkIdPrefix, type ContinueWorkInput, type Stall } from "../src/work.ts";

// PBI-0547: one-step continue の選択の正本(pickContinueWork)。表の期待は AC から書く(実装を写さない)。
// 箱は 2 つ —— live lease の最新 → 無ければ lapsed で done でない最新 → どちらも複数なら ambiguous。
// PBI-0557: live が複数でも usage limit で止まっている物が 1 本だけならそれを選ぶ(止まった物が
// 続ける理由が明確なので ambiguous より強い)。2 本以上止まっていたら今どおり ambiguous。

const NOW = new Date("2026-09-14T12:00:00Z");
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

const w = (id: string, over: Partial<ContinueWorkInput> = {}): ContinueWorkInput => ({
  id,
  title: `t-${id}`,
  status: "running",
  holderRun: `run-${id}`,
  leaseExpiresAt: FUTURE,
  updatedAt: new Date(NOW.getTime() - 60_000),
  ...over,
});

describe("pickContinueWork(PBI-0547)", () => {
  test("live lease が 1 本: それを lapsed=false で選ぶ", () => {
    const pick = pickContinueWork([w("a", { holderRun: null, leaseExpiresAt: null }), w("b")], NOW);
    expect(pick).toEqual({ kind: "work", work: w("b"), lapsed: false });
  });

  test("live が無ければ lapsed(done でない)を lapsed=true で選ぶ", () => {
    const pick = pickContinueWork([w("a", { leaseExpiresAt: PAST })], NOW);
    expect(pick).toEqual({ kind: "work", work: w("a", { leaseExpiresAt: PAST }), lapsed: true });
  });

  test("live と lapsed が混在: live が勝つ(箱の順)", () => {
    const pick = pickContinueWork([w("dead", { leaseExpiresAt: PAST }), w("live")], NOW);
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("live");
  });

  test("live が複数: ambiguous(新しい updated_at 順に並べる)", () => {
    const a = w("a", { updatedAt: new Date(100) });
    const b = w("b", { updatedAt: new Date(200) });
    const pick = pickContinueWork([a, b], NOW);
    expect(pick).toEqual({ kind: "ambiguous", works: [b, a], lapsed: false });
  });

  test("lapsed が複数(live 無し): ambiguous・新しい順に並べて lapsed=true", () => {
    const a = w("a", { leaseExpiresAt: PAST, updatedAt: new Date(100) });
    const b = w("b", { leaseExpiresAt: PAST, updatedAt: new Date(200) });
    const pick = pickContinueWork([a, b], NOW);
    expect(pick).toEqual({ kind: "ambiguous", works: [b, a], lapsed: true });
  });

  test("lease が切れた work でも done は続けない(lapsed の箱から外れる)", () => {
    expect(pickContinueWork([w("a", { leaseExpiresAt: PAST, status: "done" })], NOW)).toEqual({ kind: "none" });
  });

  test("done は live の箱からも外れる", () => {
    expect(pickContinueWork([w("a", { status: "done" }), w("b", { status: "done", leaseExpiresAt: PAST })], NOW)).toEqual({
      kind: "none",
    });
  });

  test("holder が居ない(free)work はどちらの箱にも入らない", () => {
    expect(pickContinueWork([w("a", { holderRun: null, leaseExpiresAt: null })], NOW)).toEqual({ kind: "none" });
  });

  test("holder が居て expires が null(切れない lease)は live", () => {
    const pick = pickContinueWork([w("a", { leaseExpiresAt: null })], NOW);
    expect(pick).toEqual({ kind: "work", work: w("a", { leaseExpiresAt: null }), lapsed: false });
  });

  test("空の配列: none", () => {
    expect(pickContinueWork([], NOW)).toEqual({ kind: "none" });
  });

  test("期限の境界: expires_at ちょうど今は lapsed(<= で測る)", () => {
    const pick = pickContinueWork([w("a", { leaseExpiresAt: NOW })], NOW);
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.lapsed).toBe(true);
  });
});

describe("pickContinueWork × 失敗した handoff(PBI-0578)", () => {
  const released = (id: string, over: Partial<ContinueWorkInput> = {}) =>
    w(id, { holderRun: null, leaseExpiresAt: null, failedHandoff: true, ...over });

  test("AC-2: 失敗した handoff が解放した work 1 本だけ → none にならずそれを選ぶ(lapsed: true)", () => {
    expect(pickContinueWork([released("a")], NOW)).toEqual({ kind: "work", work: released("a"), lapsed: true });
  });

  test("AC-X2: holder が居なくても解放でない(freeze で止めた等)work は選ばない・done の解放も選ばない", () => {
    expect(pickContinueWork([released("a", { failedHandoff: false })], NOW)).toEqual({ kind: "none" });
    expect(pickContinueWork([released("a", { status: "done" })], NOW)).toEqual({ kind: "none" });
  });

  test("AC-X4: live / lapsed が在ればそちらが勝つ。解放が 2 本なら ambiguous(新しい順)", () => {
    const pickLive = pickContinueWork([released("r"), w("live")], NOW);
    expect(pickLive.kind === "work" && pickLive.work.id).toBe("live");
    const pickLapsed = pickContinueWork([released("r"), w("dead", { leaseExpiresAt: PAST })], NOW);
    expect(pickLapsed.kind === "work" && pickLapsed.work.id).toBe("dead");
    const a = released("a", { updatedAt: new Date(100) });
    const b = released("b", { updatedAt: new Date(200) });
    expect(pickContinueWork([a, b], NOW)).toEqual({ kind: "ambiguous", works: [b, a], lapsed: true });
  });
});

describe("pickContinueWork × stalled(PBI-0557)", () => {
  const stall: Stall = {
    reason: "usage_limit",
    at: new Date(NOW.getTime() - 5 * 60_000),
    runtime: "claude",
    resetsAt: null,
  };

  test("live が 2 本・止まっているのが 1 本だけなら ambiguous にならずそれを選ぶ", () => {
    const pick = pickContinueWork([w("stuck", { stalled: stall }), w("running")], NOW);
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("stuck");
  });

  test("止まっている物が 2 本なら今どおり ambiguous(黙って選ばない)", () => {
    const pick = pickContinueWork([w("a", { stalled: stall }), w("b", { stalled: stall })], NOW);
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: false });
  });

  test("live が 1 本なら stalled に関係なくそれを選ぶ(絞りは不要)", () => {
    const pick = pickContinueWork([w("solo", { stalled: stall })], NOW);
    expect(pick).toMatchObject({ kind: "work" });
  });

  test("lapsed の箱では stalled を絞りに使わない(session 死亡は別の話)", () => {
    const pick = pickContinueWork(
      [w("a", { leaseExpiresAt: PAST, stalled: stall }), w("b", { leaseExpiresAt: PAST })],
      NOW,
    );
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: true });
  });

  test("stalled は stallOf の結果と同型で渡される(接続の型: null は止まっていないのと同じ)", () => {
    const events = [
      { kind: "diagnostic", payload: { code: "orphaned_session", reason: "usage_limit", runtime: "claude" }, createdAt: new Date() },
    ] as const;
    const s = stallOf(events);
    expect(s).not.toBeNull();
    const pick = pickContinueWork([w("x", { stalled: s }), w("y", { stalled: null })], NOW);
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("x");
  });
});

describe("pickContinueWork × --to(PBI-0684)", () => {
  test("toKind が有り live が複数なら、そこに居ない最新を選ぶ", () => {
    const pick = pickContinueWork(
      [
        w("on-grok", { runtimeKind: "local-grok", updatedAt: NOW }),
        w("claude", { runtimeKind: "claude", updatedAt: new Date(NOW.getTime() - 10_000) }),
        w("opencode", { runtimeKind: "opencode", updatedAt: new Date(NOW.getTime() - 1000) }),
      ],
      NOW,
      { toKind: "local-grok" },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("opencode");
  });

  test("stalled が 1 本なら --to より stall が先", () => {
    const stall: Stall = { reason: "usage_limit", at: NOW, runtime: "claude", resetsAt: null };
    const pick = pickContinueWork(
      [
        w("stuck", { runtimeKind: "claude", stalled: stall, updatedAt: new Date(NOW.getTime() - 10_000) }),
        w("fresh", { runtimeKind: "opencode", updatedAt: NOW }),
        w("on-grok", { runtimeKind: "local-grok", updatedAt: NOW }),
      ],
      NOW,
      { toKind: "local-grok" },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("stuck");
  });

  test("toKind が無い live 2 本は今どおり ambiguous", () => {
    const pick = pickContinueWork([w("a", { runtimeKind: "claude" }), w("b", { runtimeKind: "opencode" })], NOW);
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: false });
  });

  test("runtimeKind が全部不明なら --to でも ambiguous", () => {
    const pick = pickContinueWork([w("a"), w("b")], NOW, { toKind: "local-grok" });
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: false });
  });

  test("負の対照: toKind を見ないと 3 本 live は ambiguous のまま", () => {
    const rows = [
      w("on-grok", { runtimeKind: "local-grok" }),
      w("claude", { runtimeKind: "claude" }),
      w("opencode", { runtimeKind: "opencode" }),
    ];
    expect(pickContinueWork(rows, NOW).kind).toBe("ambiguous");
    expect(pickContinueWork(rows, NOW, { toKind: "local-grok" }).kind).toBe("work");
  });
});

describe("pickContinueWork × lapsed --to(PBI-0686)", () => {
  test("AC-1: lapsed 2 本で toKind 先に居ない方が 1 本ならそれを選ぶ", () => {
    const pick = pickContinueWork(
      [
        w("on-grok", { leaseExpiresAt: PAST, runtimeKind: "local-grok", updatedAt: NOW }),
        w("claude", { leaseExpiresAt: PAST, runtimeKind: "claude", updatedAt: new Date(NOW.getTime() - 1000) }),
      ],
      NOW,
      { toKind: "local-grok" },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") {
      expect(pick.work.id).toBe("claude");
      expect(pick.lapsed).toBe(true);
    }
  });

  test("AC-2: lapsed 2 本がどちらも toKind 先に居ないなら ambiguous（黙って最新を取らない）", () => {
    const pick = pickContinueWork(
      [
        w("a", { leaseExpiresAt: PAST, runtimeKind: "claude", updatedAt: new Date(100) }),
        w("b", { leaseExpiresAt: PAST, runtimeKind: "claude", updatedAt: new Date(200) }),
      ],
      NOW,
      { toKind: "local-grok" },
    );
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: true });
    if (pick.kind === "ambiguous") expect(pick.works.map((x) => x.id)).toEqual(["b", "a"]);
  });

  test("負の対照: toKind を外すと lapsed 2 本は今どおり ambiguous", () => {
    const rows = [
      w("on-grok", { leaseExpiresAt: PAST, runtimeKind: "local-grok" }),
      w("claude", { leaseExpiresAt: PAST, runtimeKind: "claude" }),
    ];
    expect(pickContinueWork(rows, NOW).kind).toBe("ambiguous");
    expect(pickContinueWork(rows, NOW, { toKind: "local-grok" }).kind).toBe("work");
  });

  test("解放済み 2 本も --to で 1 本に絞る", () => {
    const pick = pickContinueWork(
      [
        w("on-grok", { holderRun: null, leaseExpiresAt: null, failedHandoff: true, runtimeKind: "local-grok" }),
        w("claude", { holderRun: null, leaseExpiresAt: null, failedHandoff: true, runtimeKind: "claude" }),
      ],
      NOW,
      { toKind: "local-grok" },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("claude");
  });
});

describe("pickContinueWork × standing current(PBI-0701)", () => {
  const self = { runtimeId: "rt_g", kind: "grok" as const };
  const grokLapsed = (id: string, acquired: number): ContinueWorkInput =>
    w(id, {
      leaseExpiresAt: PAST,
      runtimeKind: "grok",
      handledRuntimeId: "rt_g",
      leaseAcquiredAt: new Date(acquired),
      updatedAt: new Date(acquired),
    });

  test("AC-1: lapsed が全部 grok なら係の newest を取る", () => {
    const pick = pickContinueWork(
      [grokLapsed("old", 100), grokLapsed("mid", 200), grokLapsed("dogfood", 400), grokLapsed("probe", 300)],
      NOW,
      { toKind: "grok", self },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") {
      expect(pick.work.id).toBe("dogfood");
      expect(pick.lapsed).toBe(true);
    }
  });

  test("AC-2 F51: 係が自分なら switchable より standing", () => {
    const pick = pickContinueWork(
      [
        grokLapsed("dogfood", 400),
        w("claude", { leaseExpiresAt: PAST, runtimeKind: "claude", handledRuntimeId: "rt_c", updatedAt: new Date(100) }),
      ],
      NOW,
      { toKind: "grok", self },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("dogfood");
  });

  test("AC-3: 居ない箱が複数なら 0686 どおり ambiguous", () => {
    const pick = pickContinueWork(
      [
        w("a", { leaseExpiresAt: PAST, runtimeKind: "claude", updatedAt: new Date(100) }),
        w("b", { leaseExpiresAt: PAST, runtimeKind: "claude", updatedAt: new Date(200) }),
      ],
      NOW,
      { toKind: "grok", self },
    );
    expect(pick).toMatchObject({ kind: "ambiguous", lapsed: true });
  });

  test("AC-X1: 別 runtime の係は取らない", () => {
    const pick = pickContinueWork(
      [
        w("other", { leaseExpiresAt: PAST, runtimeKind: "grok", handledRuntimeId: "rt_other", leaseAcquiredAt: new Date(500) }),
        w("other2", { leaseExpiresAt: PAST, runtimeKind: "grok", handledRuntimeId: "rt_other", leaseAcquiredAt: new Date(400) }),
      ],
      NOW,
      { toKind: "grok", self },
    );
    expect(pick.kind).toBe("ambiguous");
  });

  test("F53: live が grok 3 本でも --to grok は係の newest", () => {
    const pick = pickContinueWork(
      [
        w("old", { runtimeKind: "grok", handledRuntimeId: "rt_g", leaseAcquiredAt: new Date(100) }),
        w("mid", { runtimeKind: "grok", handledRuntimeId: "rt_g", leaseAcquiredAt: new Date(200) }),
        w("new", { runtimeKind: "grok", handledRuntimeId: "rt_g", leaseAcquiredAt: new Date(400) }),
      ],
      NOW,
      { toKind: "grok", self },
    );
    expect(pick.kind).toBe("work");
    if (pick.kind === "work") expect(pick.work.id).toBe("new");
  });

  test("AC-X2: self 無しは 0686 の ambiguous のまま", () => {
    const pick = pickContinueWork(
      [grokLapsed("a", 100), grokLapsed("b", 200)],
      NOW,
      { toKind: "grok" },
    );
    expect(pick.kind).toBe("ambiguous");
  });
});

describe("mcpSessionRunId(PBI-0703)", () => {
  test("AC-X2: kind が空なら mcp-runtime。mcp- だけが session run", () => {
    expect(mcpSessionRunId("grok")).toBe("mcp-grok");
    expect(mcpSessionRunId(null)).toBe("mcp-runtime");
    expect(mcpSessionRunId("  ")).toBe("mcp-runtime");
    expect(isMcpSessionRun("mcp-grok")).toBe(true);
    expect(isMcpSessionRun("continue-wtr_x")).toBe(false);
  });
});

describe("matchWorkId / uniqueWorkIdPrefix(PBI-0686)", () => {
  const a = "wrk_01a0aa4410cb721a8acdc9a45ec1f9ae";
  const b = "wrk_01a0aa468f1d755aaf66093a4e28f064";

  test("unique prefix と省略記号付きを 1 本に畳む", () => {
    expect(matchWorkId([a, b], "wrk_01a0aa44")).toEqual({ kind: "one", id: a });
    expect(matchWorkId([a, b], "wrk_01a0aa44…")).toEqual({ kind: "one", id: a });
  });

  test("共有 prefix は many、無い物は none", () => {
    expect(matchWorkId([a, b], "wrk_01a0aa")).toEqual({ kind: "many", ids: [a, b] });
    expect(matchWorkId([a, b], "wrk_nope")).toEqual({ kind: "none" });
  });

  test("list は衝突するまで id を伸ばす", () => {
    expect(uniqueWorkIdPrefix([a, b], a)).toBe("wrk_01a0aa44");
    expect(uniqueWorkIdPrefix([a, a.slice(0, 14) + "ffffffffffffffff"], a).length).toBeGreaterThan(12);
  });
});

