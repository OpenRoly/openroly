import { describe, expect, test } from "bun:test";
import {
  TRANSFER_IN_PROGRESS_STATES,
  TRANSFER_STATES,
  decideTransferStep,
  isTransferHolderId,
  transferHolderId,
  type TransferOp,
  type TransferState,
} from "../src/work.ts";
import { CAPSULE_FIELDS, CapsuleConversationError, renderCapsule, type CapsuleBody } from "../src/capsule.ts";
import { estimateTokens } from "../src/context.ts";

// PBI-0439: transfer の分岐の正本(decideTransferStep)を state × op × 期限の全組み合わせで測る。
// 表の期待は図84 の辺から書く(実装を写さない)。

const NOW = new Date("2026-09-12T00:00:00Z");
const LATER = new Date(NOW.getTime() + 60_000);
const EARLIER = new Date(NOW.getTime() - 1);

const row = (state: TransferState, expiresAt: Date, reason: string | null = null) => ({
  state,
  reason,
  expiresAt,
  toRuntimeKind: "codex",
});

/** 期限内の期待(図84): validate は frozen だけ / route は capsule_ready だけ / commit は routed だけ */
const LIVE: Record<TransferState, Record<Exclude<TransferOp, "expire">, string>> = {
  frozen: { validate: "capsule_ready", route: "transfer_not_routable", commit: "transfer_not_routed" },
  capsule_ready: { validate: "transfer_not_routable", route: "routed", commit: "transfer_not_routed" },
  routed: { validate: "transfer_not_routable", route: "transfer_not_routable", commit: "committed" },
  committed: {
    validate: "transfer_already_committed",
    route: "transfer_already_committed",
    commit: "transfer_already_committed",
  },
  failed: { validate: "transfer_not_routable", route: "transfer_not_routable", commit: "transfer_not_routed" },
};

const outcome = (d: ReturnType<typeof decideTransferStep>) => (d.ok ? d.next : d.reason);

describe("decideTransferStep(PBI-0439)", () => {
  for (const state of TRANSFER_STATES) {
    for (const op of ["validate", "route", "commit"] as const) {
      test(`期限内: ${state} × ${op} → ${LIVE[state][op]}`, () => {
        expect<string>(outcome(decideTransferStep(row(state, LATER), op, NOW, { runtimeKind: "codex" }))).toBe(LIVE[state][op]);
      });
    }
  }

  test("期限切れ: 進行中の 3 state はどの op(validate / route / commit)も transfer_expired", () => {
    for (const state of TRANSFER_IN_PROGRESS_STATES) {
      for (const op of ["validate", "route", "commit"] as const) {
        expect(outcome(decideTransferStep(row(state, EARLIER), op, NOW, { runtimeKind: "codex" }))).toBe("transfer_expired");
      }
    }
  });

  test("期限の境界: expires_at ちょうどは期限切れ(>= で測る)", () => {
    expect(outcome(decideTransferStep(row("routed", NOW), "commit", NOW, { runtimeKind: "codex" }))).toBe("transfer_expired");
  });

  test("expire: routed は commit_timeout・frozen / capsule_ready は route_timeout で failed", () => {
    expect(decideTransferStep(row("routed", EARLIER), "expire", NOW)).toEqual({ ok: true, next: "failed", failReason: "commit_timeout" });
    expect(decideTransferStep(row("frozen", EARLIER), "expire", NOW)).toEqual({ ok: true, next: "failed", failReason: "route_timeout" });
    expect(decideTransferStep(row("capsule_ready", EARLIER), "expire", NOW)).toEqual({ ok: true, next: "failed", failReason: "route_timeout" });
  });

  test("expire: 期限内の進行中・終わった行(committed / failed)は畳まない", () => {
    for (const state of TRANSFER_STATES) {
      const expiresAt = (TRANSFER_IN_PROGRESS_STATES as readonly string[]).includes(state) ? LATER : EARLIER;
      expect(outcome(decideTransferStep(row(state, expiresAt), "expire", NOW))).toBe("transfer_not_expired");
    }
  });

  test("期限で failed になった行への遅れた op は transfer_expired(route_failed は not_routable / not_routed のまま)", () => {
    for (const reason of ["commit_timeout", "route_timeout"]) {
      expect(outcome(decideTransferStep(row("failed", EARLIER, reason), "commit", NOW, { runtimeKind: "codex" }))).toBe("transfer_expired");
      expect(outcome(decideTransferStep(row("failed", EARLIER, reason), "route", NOW))).toBe("transfer_expired");
    }
    expect(outcome(decideTransferStep(row("failed", EARLIER, "route_failed:no_broker"), "commit", NOW, { runtimeKind: "codex" }))).toBe(
      "transfer_not_routed",
    );
  });

  test("commit: kind が to_runtime_kind と違う(claude)・human(null)は transfer_target_mismatch", () => {
    expect(outcome(decideTransferStep(row("routed", LATER), "commit", NOW, { runtimeKind: "claude" }))).toBe("transfer_target_mismatch");
    expect(outcome(decideTransferStep(row("routed", LATER), "commit", NOW))).toBe("transfer_target_mismatch");
  });
});

describe("transferHolderId(PBI-0439)", () => {
  test("予約 id は transfer id から 1 通りに決まり、isTransferHolderId で見分けられる", () => {
    const id = transferHolderId("wtr_abc");
    expect(id).not.toBe("wtr_abc");
    expect(transferHolderId("wtr_abc")).toBe(id);
    expect(isTransferHolderId(id)).toBe(true);
    expect(isTransferHolderId("run-1")).toBe(false);
    expect(isTransferHolderId(null)).toBe(false);
  });
});

describe("renderCapsule(PBI-0439 AC-4)", () => {
  const full: CapsuleBody = {
    goal: "ship transfer",
    current_state: { step: 3 },
    decisions: ["two-phase"],
    unresolved_questions: ["timeout?"],
    relevant_artifacts: ["docs/diagrams/083-fig84.md"],
    relevant_memory: "none",
    git_state: { baseCommit: "abc", dirty: 0 },
    capability_requirements: ["git"],
  };

  test("全 field が CAPSULE_FIELDS の順の節で並ぶ・preamble が先頭", () => {
    const r = renderCapsule(full, { maxTokens: 2000, preamble: ["context index: goal"] });
    expect(r.rendered.startsWith("context index: goal\n\n## goal\nship transfer")).toBe(true);
    const positions = CAPSULE_FIELDS.map((f) => r.rendered.indexOf(`## ${f}\n`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(r.omitted).toEqual([]);
  });

  test("同じ body は同じ byte(runtime を受け取る口が無い)", () => {
    expect(renderCapsule(full, { maxTokens: 2000 }).rendered).toBe(renderCapsule({ ...full }, { maxTokens: 2000 }).rendered);
  });

  test("上限を超える field は丸ごと外して omitted に名前だけ残し、後ろの小さい field は載せる", () => {
    const big = { ...full, decisions: "x ".repeat(5000) };
    const r = renderCapsule(big, { maxTokens: 2000 });
    expect(r.omitted).toEqual(["decisions"]);
    expect(r.rendered).not.toContain("## decisions");
    expect(r.rendered).toContain("## capability_requirements");
    expect(r.est_tokens).toBeLessThanOrEqual(2000);
    expect(r.est_tokens).toBe(estimateTokens(r.rendered));
  });

  test("会話の key が紛れた body は文面にしない(CapsuleConversationError)", () => {
    expect(() => renderCapsule({ current_state: { messages: ["hi"] } }, { maxTokens: 2000 })).toThrow(CapsuleConversationError);
  });
});
