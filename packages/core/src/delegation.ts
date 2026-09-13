// Delegation Policy(要件 §22-25)。Human is owner. Agent is a delegated actor.
// 決定順序は docs/diagrams.md 図4(v2)と一致させる:
// human → allow / draft=false → deny(read_only) / unknown sender → ask /
// contact override → allow / account policy(send_reply) → auto なら allow, ask なら ask。

export type DelegationDecision = "allow" | "ask" | "deny";

export type DelegationStage = "read" | "ask" | "auto";

export type DelegationReason =
  | "human_owner"
  | "read_only"
  | "unknown_sender"
  | "contact_auto_reply"
  | "account_ask"
  | "account_auto"
  /** 宛先が自分自身の account(owner instruction thread。PBI-0094)。外への副作用が無い為 allow */
  | "self_thread";

export interface DelegationResult {
  decision: DelegationDecision;
  reason: DelegationReason;
  stage: DelegationStage;
  /** 決定を左右した key(draft / send_reply)が runtime override 由来か(PBI-0030) */
  override: boolean;
}

export interface MailDelegationPolicy {
  receive: "auto";
  agent_read: boolean;
  draft: boolean;
  send_reply: "ask" | "auto";
  auto_reply: boolean;
}

/**
 * mail の実効 stage(要件 §22.2 の 3 択)。`draft:false` が最優先(読むだけが常に安全側 —
 * `draft:false` かつ `send_reply:"auto"` の矛盾状態も `read` に倒す)。
 */
export function mailStage(p: MailDelegationPolicy): DelegationStage {
  if (!p.draft) return "read";
  return p.send_reply === "auto" ? "auto" : "ask";
}

export interface AccountDelegationPolicy {
  mail: MailDelegationPolicy;
  /** Advanced setting(PBI-0030): runtime 単位の override。`receive` は override 不可 */
  runtime_overrides?: Record<string, Partial<Omit<MailDelegationPolicy, "receive">>>;
  /** Connection-scoped ASK の Always grant(PBI-0055 / W7)。
   * connection_grants[runtimeId][provider] === true で以後 resolve が gate を通らず即座に許可される */
  connection_grants?: Record<string, Record<string, boolean>>;
  /** v0 Authority(PBI-0413 / CAP-3 V10・CAP-9 の v0 部分集合)の policy 段。
   * 未設定 = 拒否(fail-closed。AC-5)。CAP-9 が後で同じ表に乗る(不確実性 #3) */
  work_authority?: Partial<Record<"start_review" | "fork_work", boolean>>;
}

/**
 * mail の実効 policy(要件 §34 Advanced provider-specific override)。account policy に
 * runtime 単位の override を重ねる。read gate(agentCanRead)・send gate(decideSend)・
 * AUTO opt-in gate(deliver)・whoami の全部がこれ 1 関数を経由する(図4 v2 / 図20)。
 */
export function resolveMailPolicy(
  policy: AccountDelegationPolicy,
  runtimeId?: string,
): MailDelegationPolicy {
  const override = runtimeId ? policy.runtime_overrides?.[runtimeId] : undefined;
  return { ...policy.mail, ...override };
}

// 要件 §23.1 の default
export const DEFAULT_DELEGATION_POLICY: AccountDelegationPolicy = {
  mail: {
    receive: "auto",
    agent_read: true,
    draft: true,
    send_reply: "ask",
    auto_reply: false,
  },
};

export interface ContactDelegationOverride {
  auto_reply?: boolean;
}

export type SendActor =
  | { kind: "human" }
  | { kind: "runtime"; runtimeId: string };

export interface ReplyDecisionInput {
  actor: SendActor;
  /** 送信相手が既知 contact か。unknown sender は AUTO 対象にしない(要件 §10, §13) */
  peerKnownContact: boolean;
  policy: AccountDelegationPolicy;
  contactOverride?: ContactDelegationOverride;
  /** 宛先が自分自身の account か(owner instruction thread。PBI-0094)。unknown sender /
   * read_only より前に判定する — owner の自分宛て thread は外への副作用が無く、human が
   * 同一 thread 内で直接指示しているので draft:false でも返信を許す */
  peerIsSelf?: boolean;
}

export function decideSend(input: ReplyDecisionInput): DelegationResult {
  const runtimeId = input.actor.kind === "runtime" ? input.actor.runtimeId : undefined;
  const mail = resolveMailPolicy(input.policy, runtimeId);
  const stage = mailStage(mail);
  const overrideKeys = new Set(
    Object.keys((runtimeId && input.policy.runtime_overrides?.[runtimeId]) || {}),
  );
  if (input.actor.kind === "human") {
    return { decision: "allow", reason: "human_owner", stage, override: false };
  }
  // 自分宛て thread(owner instruction。PBI-0094)は read_only(draft:false)より前に許可する。
  // 返信先が owner 自身で外への配送が発生しない為、read_only runtime も同一 thread に報告できる
  if (input.peerIsSelf) {
    return { decision: "allow", reason: "self_thread", stage, override: false };
  }
  if (!mail.draft) {
    return { decision: "deny", reason: "read_only", stage, override: overrideKeys.has("draft") };
  }
  if (!input.peerKnownContact) {
    return { decision: "ask", reason: "unknown_sender", stage, override: false };
  }
  if (input.contactOverride?.auto_reply) {
    return { decision: "allow", reason: "contact_auto_reply", stage, override: false };
  }
  return mail.send_reply === "auto"
    ? { decision: "allow", reason: "account_auto", stage, override: overrideKeys.has("send_reply") }
    : { decision: "ask", reason: "account_ask", stage, override: overrideKeys.has("send_reply") };
}
