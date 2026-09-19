// PBI-0657 AC-2: Run の判定(core/run.ts)。**数を数える判定はここに無い** ——
// 「生きている primary は work ごと 1 本」は migration 064 の partial unique index の持ち場で、
// ここで先に数えると index を外しても緑になる(= index が一度も測られない)。
import { describe, expect, test } from "bun:test";
import {
  RUN_STATUSES,
  RUN_WRITE_SCOPES,
  RUN_TERMINAL_STATUSES,
  isRunOver,
  decideRunStatus,
  writeScopeForWork,
  canHoldPrimary,
} from "../src/run.ts";

describe("値集合", () => {
  test("status 6 値 / write_scope 3 値。終端は status の部分集合", () => {
    expect([...RUN_STATUSES]).toEqual(["starting", "working", "blocked", "idle", "done", "failed"]);
    expect([...RUN_WRITE_SCOPES]).toEqual(["primary", "isolated", "readonly"]);
    for (const t of RUN_TERMINAL_STATUSES) expect(RUN_STATUSES).toContain(t);
    expect(RUN_TERMINAL_STATUSES.length).toBe(2);
  });

  test("isRunOver は終端だけ true(生きている 4 値は false)", () => {
    for (const s of RUN_STATUSES) {
      expect(isRunOver(s)).toBe((RUN_TERMINAL_STATUSES as readonly string[]).includes(s));
    }
    expect(isRunOver("")).toBe(false);
  });
});

describe("decideRunStatus", () => {
  test("生きている値どうしは全部通る(runtime ごとの立ち上がり方を決め打たない)", () => {
    const live = RUN_STATUSES.filter((s) => !isRunOver(s));
    for (const from of live) for (const to of RUN_STATUSES) expect(decideRunStatus(from, to).ok).toBe(true);
  });

  test("終端からはどこへも動けない —— **自分自身へも**(done → done は run_over)", () => {
    for (const from of RUN_TERMINAL_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(decideRunStatus(from, to)).toEqual({ ok: false, reason: "run_over" });
      }
    }
  });

  test("知らない値は通さない。**判定順序は unknown が先**(終わった run に変な値を送っても unknown_status)", () => {
    expect(decideRunStatus("working", "WORKING")).toEqual({ ok: false, reason: "unknown_status" });
    expect(decideRunStatus("working", "")).toEqual({ ok: false, reason: "unknown_status" });
    expect(decideRunStatus("working", "__proto__")).toEqual({ ok: false, reason: "unknown_status" });
    expect(decideRunStatus("done", "zzz")).toEqual({ ok: false, reason: "unknown_status" });
    // from が壊れていても通さない側に倒れる(知らない from は生きている扱いだが、to は必ず検査される)
    expect(decideRunStatus("zzz", "working").ok).toBe(true);
  });
});

describe("writeScopeForWork(既存の振る舞いを言い直すだけ・AC-X1)", () => {
  test("親 Work = primary / 子 Work = isolated / reviewer の枝 = readonly", () => {
    expect(writeScopeForWork({ parentWorkId: null, contextProfile: "full" })).toBe("primary");
    expect(writeScopeForWork({ parentWorkId: "wrk_p", contextProfile: "full" })).toBe("isolated");
    expect(writeScopeForWork({ parentWorkId: null, contextProfile: "reviewer_blind" })).toBe("readonly");
  });

  test("reviewer は親子より強い(子 Work の reviewer も readonly)。profile 未設定は primary", () => {
    expect(writeScopeForWork({ parentWorkId: "wrk_p", contextProfile: "reviewer_blind" })).toBe("readonly");
    expect(writeScopeForWork({ parentWorkId: null, contextProfile: null })).toBe("primary");
  });
});

describe("canHoldPrimary", () => {
  const root = { id: "wrk_1", parentWorkId: null, contextProfile: "full", leaseHolderRun: null };
  const run = { id: "run_1", workId: "wrk_1", status: "working" };

  test("親 Work で空いていれば ok。自分が holder でも ok(再送は冪等)", () => {
    expect(canHoldPrimary(root, run)).toEqual({ ok: true });
    expect(canHoldPrimary({ ...root, leaseHolderRun: "run_1" }, run)).toEqual({ ok: true });
  });

  test("判定順序: 生死 → 相手の work → work の形 → lease。終わった run は他が何であれ run_over", () => {
    expect(canHoldPrimary(root, { ...run, status: "done" })).toEqual({ ok: false, reason: "run_over" });
    // 全部外れている入力でも先頭の理由が返る(順序が入れ替わったら赤くなる)
    expect(
      canHoldPrimary({ ...root, parentWorkId: "wrk_p", leaseHolderRun: "other" }, { ...run, workId: "wrk_9", status: "failed" }),
    ).toEqual({ ok: false, reason: "run_over" });
    expect(canHoldPrimary({ ...root, parentWorkId: "wrk_p", leaseHolderRun: "other" }, { ...run, workId: "wrk_9" })).toEqual({
      ok: false,
      reason: "other_work",
    });
    expect(canHoldPrimary({ ...root, parentWorkId: "wrk_p", leaseHolderRun: "other" }, run)).toEqual({
      ok: false,
      reason: "not_primary_work",
    });
    expect(canHoldPrimary({ ...root, leaseHolderRun: "other" }, run)).toEqual({ ok: false, reason: "lease_held" });
  });

  test("常駐 run(work を持たない)は work の primary を名乗れない", () => {
    expect(canHoldPrimary(root, { ...run, workId: null })).toEqual({ ok: false, reason: "other_work" });
  });

  test("**数は数えない** —— 同じ入力を何度渡しても ok(1 本目か 2 本目かを知らない = index の持ち場)", () => {
    for (let i = 0; i < 3; i++) expect(canHoldPrimary(root, run)).toEqual({ ok: true });
  });
});
