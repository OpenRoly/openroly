import { describe, expect, test } from "bun:test";
import {
  WORK_STATUSES,
  WORK_EVENT_KINDS,
  WORK_EVENT_ROUTE_KINDS,
  WORK_ATTEMPT_STATUSES,
  WORK_PROOF_STATUSES,
  validateEventPayload,
  validateProofCounts,
  decideWrite,
  AUTHORITY_ACTIONS,
  AUTHORITY_TIERS,
  decideAuthority,
  WORK_OWNER_KINDS,
  workOwnerId,
  decideWorkOwner,
  decideWorkCreator,
  isHumanHandActor,
  resolvePairedRuntimeKind,
  isWakeableKind,
  type WorkLease,
  type IntentTokenState,
} from "../src/work.ts";

// PBI-0393: decideWrite の分岐の正本は core に 1 つ。ここは純関数の 4 分岐 +
// 「未来の epoch も拒否」を測る。負の対照(比較を >= に戻して赤を見る)は
// work-lease.test.ts 側の AC-2 / 攻撃 test が受け持つ(実装の戻しは 1 箇所で両方赤になる)。

const NOW = new Date("2026-09-08T00:00:00Z");

describe("decideWrite(PBI-0393)", () => {
  const held: WorkLease = { epoch: 1, holderRun: "run-1", expiresAt: null };

  test("no_lease: epoch 0 は誰も持っていない", () => {
    expect(decideWrite({ epoch: 0, holderRun: null, expiresAt: null }, { runId: "run-1", expectedWriteEpoch: 0 }, NOW))
      .toEqual({ ok: false, reason: "no_lease" });
  });

  test("stale_epoch: 古い epoch を名乗る命令は拒否(核心)", () => {
    expect(decideWrite({ ...held, epoch: 2 }, { runId: "run-1", expectedWriteEpoch: 1 }, NOW))
      .toEqual({ ok: false, reason: "stale_epoch" });
  });

  test("stale_epoch: 未来の epoch も拒否(等価で測る — >= だと未来が通る)", () => {
    expect(decideWrite(held, { runId: "run-1", expectedWriteEpoch: 2 }, NOW))
      .toEqual({ ok: false, reason: "stale_epoch" });
  });

  test("not_holder: epoch が合っていても holder でない", () => {
    expect(decideWrite(held, { runId: "run-2", expectedWriteEpoch: 1 }, NOW))
      .toEqual({ ok: false, reason: "not_holder" });
  });

  test("lease_expired: 期限を過ぎていたら拒否", () => {
    const expired: WorkLease = { epoch: 1, holderRun: "run-1", expiresAt: new Date("2026-09-07T23:59:59Z") };
    expect(decideWrite(expired, { runId: "run-1", expectedWriteEpoch: 1 }, NOW))
      .toEqual({ ok: false, reason: "lease_expired" });
  });

  test("ok: holder が今の epoch を名乗る時だけ通る", () => {
    expect(decideWrite(held, { runId: "run-1", expectedWriteEpoch: 1 }, NOW)).toEqual({ ok: true });
  });

  // PBI-0401: 値集合は `third_party/openclaw/` の実物から derive するようになった。
  // ここの literal は**我々の契約**(migration 047 / 048 の check と同じ並び)で、
  // 上流が 1 値足したり消したりすると derive 側が動いてこの pin が赤くなる ——
  // 手写しだった間は上流がずれても永久に緑だった(AC-X1 の負の対照はここで実射する)。
  test("WORK_STATUSES は 10 値(上流 9 + needs_user)・migration 047 の check と同じ並び", () => {
    expect(WORK_STATUSES).toHaveLength(10);
    expect(WORK_STATUSES).toEqual([
      "triage", "backlog", "todo", "scheduled", "ready",
      "running", "review", "blocked", "done", "needs_user",
    ]);
  });

  test("WORK_ATTEMPT_STATUSES は 5 値(上流そのもの)", () => {
    expect(WORK_ATTEMPT_STATUSES).toHaveLength(5);
    expect(WORK_ATTEMPT_STATUSES).toEqual(["running", "succeeded", "failed", "blocked", "stopped"]);
  });
});

// PBI-0395: event payload / proof 数値の検証。fail-closed の正本は core の 1 ファイル。
// route 側の allowed list(6 種)を戻した時に赤くなる負の対照は work-events.test.ts の AC-5。
describe("validateEventPayload / validateProofCounts(PBI-0395)", () => {
  test("WORK_EVENT_KINDS は 24 値・migration 048 の check と同じ並び", () => {
    expect(WORK_EVENT_KINDS).toHaveLength(24);
    expect(WORK_EVENT_KINDS).toEqual([
      "created", "edited", "moved", "linked", "specified", "decomposed", "claimed", "heartbeat",
      "execution_updated", "attempt_started", "attempt_updated", "comment_added", "link_added",
      "proof_added", "artifact_added", "attachment_added", "diagnostic", "notification", "dispatch",
      "orchestration", "protocol_violation", "archived", "unarchived", "stale",
    ]);
  });

  test("WORK_EVENT_ROUTE_KINDS は 6 種(この slice で口を開ける分だけ)", () => {
    expect(WORK_EVENT_ROUTE_KINDS).toEqual([
      "comment_added", "proof_added", "artifact_added",
      "attempt_started", "attempt_updated", "diagnostic",
    ]);
  });

  test("payload は object だけ: 文字列 / 配列は拒否・null は {} と同じ扱い", () => {
    expect(validateEventPayload("comment_added", "文字列")).toEqual({ ok: false, reason: "payload_not_object" });
    expect(validateEventPayload("comment_added", ["x"])).toEqual({ ok: false, reason: "payload_not_object" });
    expect(validateEventPayload("comment_added", null)).toEqual({ ok: false, reason: "body_required" });
  });

  test("comment_added は非空の body が必須(fail-closed)", () => {
    expect(validateEventPayload("comment_added", {})).toEqual({ ok: false, reason: "body_required" });
    expect(validateEventPayload("comment_added", { body: "   " })).toEqual({ ok: false, reason: "body_required" });
    expect(validateEventPayload("comment_added", { body: "started auth refactor" })).toEqual({ ok: true });
  });

  test("proof_added は proof と同じ検証を共用する", () => {
    expect(validateEventPayload("proof_added", { status: "passed", passed: 32, failed: 2 })).toEqual({ ok: true });
    expect(validateEventPayload("proof_added", { status: "hoge" })).toEqual({ ok: false, reason: "invalid_status" });
    expect(validateEventPayload("proof_added", { status: "skipped", passed: 1 })).toEqual({ ok: false, reason: "counts_not_allowed" });
  });

  test("artifact_added は name / attempt は attemptId(+attempt_updated は status 5 値)/ diagnostic は code が必須", () => {
    expect(validateEventPayload("artifact_added", {})).toEqual({ ok: false, reason: "name_required" });
    expect(validateEventPayload("artifact_added", { name: "patch.diff" })).toEqual({ ok: true });
    expect(validateEventPayload("attempt_started", {})).toEqual({ ok: false, reason: "attemptId_required" });
    expect(validateEventPayload("attempt_started", { attemptId: "a1" })).toEqual({ ok: true });
    expect(validateEventPayload("attempt_updated", { attemptId: "a1" })).toEqual({ ok: false, reason: "invalid_attempt_status" });
    expect(validateEventPayload("attempt_updated", { status: "running" })).toEqual({ ok: false, reason: "attemptId_required" });
    expect(validateEventPayload("attempt_updated", { attemptId: "a1", status: "succeeded" })).toEqual({ ok: true });
    expect(validateEventPayload("diagnostic", {})).toEqual({ ok: false, reason: "code_required" });
    expect(validateEventPayload("diagnostic", { code: "running_without_heartbeat" })).toEqual({ ok: true });
  });

  test("口を開けない kind は形だけ検査する(必須 field をこの slice で決めない)", () => {
    expect(validateEventPayload("claimed", {})).toEqual({ ok: true });
    expect(validateEventPayload("stale", { anything: 1 })).toEqual({ ok: true });
  });

  test("validateProofCounts: 0 以上の整数だけ・skipped/unknown は数値を持たない", () => {
    expect(WORK_PROOF_STATUSES).toHaveLength(4);
    expect(WORK_PROOF_STATUSES).toEqual(["passed", "failed", "skipped", "unknown"]);
    expect(validateProofCounts({ status: "passed", passed: 0, failed: 0 })).toEqual({ ok: true }); // 0 は正当
    expect(validateProofCounts({ status: "passed" })).toEqual({ ok: true }); // 数えられない証拠もある
    expect(validateProofCounts({ status: "passed", passed: -1 })).toEqual({ ok: false, reason: "invalid_passed" });
    expect(validateProofCounts({ status: "failed", failed: 1.5 })).toEqual({ ok: false, reason: "invalid_failed" });
    expect(validateProofCounts({ status: "failed", passed: "3" })).toEqual({ ok: false, reason: "invalid_passed" });
    expect(validateProofCounts({ status: "skipped" })).toEqual({ ok: true });
    expect(validateProofCounts({ status: "unknown", failed: 0 })).toEqual({ ok: false, reason: "counts_not_allowed" });
    expect(validateProofCounts({})).toEqual({ ok: false, reason: "invalid_status" });
    expect(validateProofCounts({ status: 3 })).toEqual({ ok: false, reason: "invalid_status" });
  });
});

// PBI-0413 / CAP-3 V10: v0 Authority(direction/v0.md §7)の 3 段。DB I/O は呼び出し側の責任
// (decideWrite が WorkLease を引数で受けるのと同じ形)なので、ここは純関数として全分岐を測る。
// 統合(実際の route・token の発行/消費)は apps/server/test/work.test.ts 側の攻撃 test が持つ。
describe("decideAuthority(PBI-0413)", () => {
  const workId = "wrk_1";
  const validIntent = (action: "transfer_primary" | "stop_primary"): IntentTokenState => ({
    status: "valid", workId, action,
  });

  test("3 段の割り当てが v0 §7 の表と一致する", () => {
    expect(AUTHORITY_ACTIONS).toHaveLength(6);
    expect(AUTHORITY_TIERS).toEqual({
      checkpoint: "auto",
      read_context: "auto",
      start_review: "policy",
      fork_work: "policy",
      transfer_primary: "explicit_user_intent",
      stop_primary: "explicit_user_intent",
    });
  });

  test("auto(checkpoint / read_context)は人に聞かない —— policy/intent が何であっても通る", () => {
    expect(decideAuthority("checkpoint", workId, { policyGranted: false, intent: null })).toEqual({ ok: true });
    expect(decideAuthority("read_context", workId, { policyGranted: false, intent: { status: "expired" } }))
      .toEqual({ ok: true });
  });

  test("policy(start_review / fork_work)は未設定なら拒否・設定すれば通る(AC-5)", () => {
    expect(decideAuthority("start_review", workId, { policyGranted: false, intent: null }))
      .toEqual({ ok: false, reason: "policy_not_granted" });
    expect(decideAuthority("start_review", workId, { policyGranted: true, intent: null })).toEqual({ ok: true });
    expect(decideAuthority("fork_work", workId, { policyGranted: false, intent: null }))
      .toEqual({ ok: false, reason: "policy_not_granted" });
    expect(decideAuthority("fork_work", workId, { policyGranted: true, intent: null })).toEqual({ ok: true });
  });

  test("explicit_user_intent(transfer_primary / stop_primary): token が無ければ拒否(AC-2)", () => {
    expect(decideAuthority("transfer_primary", workId, { policyGranted: true, intent: null }))
      .toEqual({ ok: false, reason: "explicit_user_intent_required" });
    expect(decideAuthority("stop_primary", workId, { policyGranted: true, intent: { status: "not_found" } }))
      .toEqual({ ok: false, reason: "explicit_user_intent_required" });
  });

  test("有効な token(同じ work・同じ動詞)なら通る(AC-3)。**policyGranted:true は無視する**(別の段の値を混ぜない)", () => {
    expect(decideAuthority("transfer_primary", workId, { policyGranted: false, intent: validIntent("transfer_primary") }))
      .toEqual({ ok: true });
    expect(decideAuthority("stop_primary", workId, { policyGranted: false, intent: validIntent("stop_primary") }))
      .toEqual({ ok: true });
  });

  test("使い済みの token は拒否(AC-4)", () => {
    expect(decideAuthority("transfer_primary", workId, { policyGranted: true, intent: { status: "consumed" } }))
      .toEqual({ ok: false, reason: "intent_already_consumed" });
  });

  test("期限切れの token は拒否", () => {
    expect(decideAuthority("stop_primary", workId, { policyGranted: true, intent: { status: "expired" } }))
      .toEqual({ ok: false, reason: "intent_expired" });
  });

  test("別 work / 別動詞への使い回しは拒否(mismatch)。resolveWorkIntent が status で返す場合と、呼び出し側が形だけ valid を渡した場合の両方", () => {
    expect(decideAuthority("transfer_primary", workId, { policyGranted: true, intent: { status: "mismatch" } }))
      .toEqual({ ok: false, reason: "intent_mismatch" });
    // stop_primary の token(status は valid)を transfer_primary へ差し出す
    expect(decideAuthority("transfer_primary", workId, { policyGranted: true, intent: validIntent("stop_primary") }))
      .toEqual({ ok: false, reason: "intent_mismatch" });
    // 別 work の token
    expect(decideAuthority("transfer_primary", "wrk_other", { policyGranted: true, intent: validIntent("transfer_primary") }))
      .toEqual({ ok: false, reason: "intent_mismatch" });
  });

  test("負の対照(AC-X2 相当): tier を auto に書き換えると intent 必須の検査が意味を失う(=検査が武装している証拠)", () => {
    const brokenTiers = { ...AUTHORITY_TIERS, transfer_primary: "auto" as const };
    const brokenDecide = (action: keyof typeof brokenTiers, id: string, ctx: Parameters<typeof decideAuthority>[2]) =>
      brokenTiers[action] === "auto" ? { ok: true as const } : decideAuthority(action, id, ctx);
    // 壊した版は token 無しでも通ってしまう(= 本物の decideAuthority はここで拒否している事の対照)
    expect(brokenDecide("transfer_primary", workId, { policyGranted: false, intent: null })).toEqual({ ok: true });
    expect(decideAuthority("transfer_primary", workId, { policyGranted: false, intent: null }))
      .toEqual({ ok: false, reason: "explicit_user_intent_required" });
  });
});

// PBI-0467 / CAP-3 V18: Project.owner。値集合は core の 1 箇所(WORK_OWNER_KINDS)だけが持つ
describe("decideWorkOwner(PBI-0467)", () => {
  test("値集合は account の 1 つだけ(今の最小の所有主体)", () => {
    expect(WORK_OWNER_KINDS).toEqual(["account"]);
  });

  test("root(親を持たない) work は作成した account が owner", () => {
    expect(decideWorkOwner({ accountId: "acc_a" })).toEqual({ ok: true, owner: "account:acc_a" });
    expect(decideWorkOwner({ accountId: "acc_a", parent: null })).toEqual({ ok: true, owner: "account:acc_a" });
  });

  test("task(親を持つ)は親の owner をそのまま継承する", () => {
    expect(decideWorkOwner({ accountId: "acc_a", parent: { owner: workOwnerId("account", "acc_a") } }))
      .toEqual({ ok: true, owner: "account:acc_a" });
  });

  test("AC-3: 親と違う owner を渡すと owner_mismatch で拒否(作成した account の owner が返らない)", () => {
    expect(decideWorkOwner({ accountId: "acc_a", parent: { owner: "account:acc_b" } }))
      .toEqual({ ok: false, reason: "owner_mismatch" });
  });

  test("負の対照: 親の owner を検査せず常に自分の account を返すと、AC-3 の mismatch が消える(赤で確認して元に戻す)", () => {
    const broken = (input: { accountId: string; parent?: { owner: string } | null }) =>
      ({ ok: true as const, owner: workOwnerId("account", input.accountId) }); // 親を見ない壊れた版
    expect(broken({ accountId: "acc_a", parent: { owner: "account:acc_b" } })).toEqual({ ok: true, owner: "account:acc_a" });
    // 本物は同じ入力を拒否する(壊れた版との差が「親を見ている」証拠)
    expect(decideWorkOwner({ accountId: "acc_a", parent: { owner: "account:acc_b" } }).ok).toBe(false);
  });
});

describe("isHumanHandActor / resolvePairedRuntimeKind(PBI-0679)", () => {
  test("human と broker だけが人の手。claude は違う", () => {
    expect(isHumanHandActor("human", null)).toBe(true);
    expect(isHumanHandActor("runtime", "broker")).toBe(true);
    expect(isHumanHandActor("runtime", "claude")).toBe(false);
    expect(isHumanHandActor("runtime", "local-grok")).toBe(false);
  });

  test("root work は broker で作れ、claude では human_only", () => {
    expect(decideWorkCreator({ actorKind: "runtime", runtimeKind: "broker", hasParent: false })).toEqual({ ok: true });
    expect(decideWorkCreator({ actorKind: "runtime", runtimeKind: "claude", hasParent: false }))
      .toEqual({ ok: false, reason: "human_only" });
  });

  test("grok 要求で pair 済みが local-grok ならそちらへ畳む。逆も。在る方は触らない", () => {
    expect(resolvePairedRuntimeKind("grok", ["local-grok"])).toBe("local-grok");
    expect(resolvePairedRuntimeKind("local-grok", ["grok"])).toBe("grok");
    expect(resolvePairedRuntimeKind("grok", ["grok", "local-grok"])).toBe("grok");
    expect(resolvePairedRuntimeKind("codex", ["claude"])).toBe("codex");
  });

  test("local-grok は catalog の grok が headless なら起こせる", () => {
    expect(isWakeableKind("grok", ["grok", "claude"])).toBe(true);
    expect(isWakeableKind("local-grok", ["grok", "claude"])).toBe(true);
    expect(isWakeableKind("local-foo", ["grok"])).toBe(false);
  });

  test("負の対照: 接頭辞を見ないと grok→local-grok が畳めない", () => {
    const broken = (requested: string, paired: string[]) => (paired.includes(requested) ? requested : requested);
    expect(broken("grok", ["local-grok"])).toBe("grok");
    expect(resolvePairedRuntimeKind("grok", ["local-grok"])).toBe("local-grok");
  });
});
