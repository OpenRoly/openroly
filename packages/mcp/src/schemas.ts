import { CONTEXT_SEARCH_DEFAULT_MAX_TOKENS, CONTEXT_SEARCH_MAX_TOKENS } from "@openroly/adapter";
import { MEMORY_CONTENT_MAX_CHARS, MEMORY_SCOPES, MEMORY_TYPES } from "@openroly/core";
import { z } from "zod";

// server.ts の各 tool 登録で使う zod shape。副作用(credential 解決・process.exit・stdio connect)を
// 一切持たない純粋な定義だけをここに置き、server.ts とテストの双方から import する。
// こうしておくことで「schema と実装(SendInput/pickContent)のドリフト」をテストで機械検査できる。

export const fileRefShape = z.object({
  name: z.string(),
  ref: z.string(),
  size: z.number().optional(),
  mime: z.string().optional(),
});

export const sendInputShape = {
  to: z.string().describe("@handle"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("force-send to a thread that is already_handled"),
};

export const replyInputShape = {
  thread_id: z.string().describe("thread id to reply to (including the thread shared with the owner)"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("force-send to a thread that is already_handled"),
  refs: z
    .array(z.string())
    .optional()
    .describe("ids of the notification items that were handled (marks them done when reporting to the owner instruction thread)"),
};

// triage(EP-0013 W3)の label 付け。MCP からは "none" を見せない(label 無し状態への復帰は
// human の web UI / API が担う — triage agent が未処理に戻す経路は作らない)。
export const labelInputShape = {
  message_id: z.string().describe("message id of the notification item"),
  label: z.enum(["action", "fyi", "discard"]).describe("action = needs handling / fyi = for information / discard = not needed"),
  summary: z
    .string()
    .optional()
    .describe("short summary (140 chars or less recommended). The MCP server seals it with the device key before sending"),
};

// 自然言語 rule(EP-0013 W4 / REQ-54)。runtime が owner の言葉を JSON に compile して渡す。
// server が layer(metadata / content)を導出し、正規化済み rule を応答として返す ——
// それを owner に 1 文で echo する(REQ-54「解釈を同一 thread で返す」)のが runtime の仕事。
// 同じ nl の再 put は更新になる(rule は増えない)
export const rulesPutInputShape = {
  nl: z.string().describe("the owner's words verbatim (e.g. 'batch newsletters at 9 every morning')"),
  scope: z
    .object({
      source_kind: z.enum(["mail", "openroly", "webhook", "android", "windows", "macos", "ios", "digest"]).optional(),
      app_id: z.string().optional().describe("source app (e.g. com.example.app). Values given here are stored in the clear as metadata"),
      time_window: z.string().optional(),
      sender: z.string().optional().describe("a sender term. Setting it makes this a content rule, stored encrypted on the server"),
      keywords: z.array(z.string()).optional().describe("body terms. Setting them makes this a content rule"),
    })
    .optional(),
  action: z.object({
    type: z.enum(["immediate", "digest", "discard", "cloud_visibility"]),
    schedule: z.string().optional().describe("\"HH:MM\" for digests (e.g. 09:00)"),
    tz: z.string().optional().describe("IANA timezone for digests (e.g. America/Los_Angeles; default UTC)"),
    visibility: z.enum(["full", "masked", "local_only", "none"]).optional().describe("for cloud_visibility"),
  }),
};

// Work Core の proof(PBI-0400 / CAP-3 V9)。**run_id は必須** —— work の lease_holder_run を
// 黙って写すと、lease を持たない Run の proof が holder の名前で残る(誰が打ったかが嘘になる)。
// 名乗りとして受け取り、server の 1 文が lease holder と照合して落とす
export const workProofInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  run_id: z.string().describe("the id of the run that is doing the work (the run that holds the lease)"),
  status: z
    .enum(["passed", "failed", "skipped", "unknown"])
    .describe("whether the check passed. Do not parse test output into anything finer"),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  detail: z.string().max(2000).optional().describe("one line of context (e.g. the command that was run)"),
};

// Immutable Work Capsule(PBI-0406 / CAP-3 V2). **run_id は必須**(work_proof と同じ理由 —
// lease holder を黙って写さない)。8 要素はどれも optional — 打ちたい分だけ渡す。それ以外の
// key(conversation / messages / transcript を含む)は server の buildCapsule が壁を持つ
// (会話は throw、他の未知 key は黙って落として dropped_keys で返す)
export const workCapsuleInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  run_id: z.string().describe("the id of the run that is doing the work (the run that holds the lease)"),
  goal: z.unknown().optional(),
  current_state: z.unknown().optional(),
  decisions: z.unknown().optional(),
  unresolved_questions: z.unknown().optional(),
  relevant_artifacts: z.unknown().optional(),
  relevant_memory: z.unknown().optional(),
  git_state: z.unknown().optional(),
  capability_requirements: z.unknown().optional(),
};

// Work Project context(PBI-0433・手描き 1 枚目)。value は MCP が端末の CAS に書き、server には索引だけが行く
const contextShape = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "key → value facts for the next agent. Prefer the well-known keys, which the next agent reads first: goal, next_step, decisions, open_questions, failed_attempts, verified_findings (other names are allowed). auto/, inbox/, review/ and brief/ are reserved — the machine and whoever hands the work out write those. Key: letters, digits and _ . : / -, up to 128 chars",
  );

/** PBI-0649: 渡す時だけ書ける 3 key を足した context(work_task_create 専用 —— 受け取った task は reserved_key で落ちる) */
const taskContextShape = contextShape.describe(
  "key → value facts for the agent taking this task, plus the three keys only the side handing it out may write: brief/done (what finished looks like, free text), brief/allowed and brief/forbidden (its scope — arrays of repo-relative path prefixes, matched by prefix only, case-insensitively, no globs). A merge that changes a file under a brief/forbidden prefix is stopped as outside_scope before a single byte is written, and the task then needs a human. Also: goal, next_step, decisions, open_questions, failed_attempts, verified_findings",
);
const sourcesShape = z
  .array(z.string())
  .optional()
  .describe("repo-relative paths of files the next agent should read (e.g. docs/plan.md)");
const expectedVersionsShape = z
  .record(z.string(), z.number().int().nonnegative())
  .optional()
  .describe("key → the version you last saw (0 = must not exist yet). A newer value makes the whole call fail with stale_version");

export const workHandoffInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  to: z.string().optional().describe("runtime id or kind that should carry this work from now on"),
  note: z.string().optional().describe("what the next runtime needs to know"),
  context: contextShape,
  sources: sourcesShape,
  run_id: z.string().optional().describe("your own run id, recorded as the writer"),
  expected_versions: expectedVersionsShape,
};

export const workContextPutInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  context: contextShape,
  sources: sourcesShape,
  run_id: z.string().optional().describe("your own run id, recorded as the writer"),
  expected_versions: expectedVersionsShape,
};

// PBI-0443: task → Work Project の公開。project に出す口はこれだけ
export const workContextPublishInputShape = {
  work_id: z.string().describe("your task's work id (wrk_...) — its rows are copied to the task's Work Project"),
  keys: z.array(z.string()).min(1).describe("keys already written on the task to publish (e.g. [\"decisions\"])"),
  run_id: z.string().optional().describe("your own run id, recorded as the writer"),
  expected_versions: expectedVersionsShape,
};

export const workContextSearchInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  keys: z.array(z.string()).optional().describe("exact keys to pull (e.g. [\"A\", \"B\"])"),
  prefix: z.string().optional().describe("pull keys that start with this"),
  kind: z.enum(["context", "source"]).optional(),
  query: z.string().optional().describe("substring matched against key and value on this device"),
  index_only: z
    .boolean()
    .optional()
    .describe("step 1: return every matching key with est_tokens and a short preview instead of its value"),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(CONTEXT_SEARCH_MAX_TOKENS)
    .optional()
    .describe(
      `the most this call returns (default ${CONTEXT_SEARCH_DEFAULT_MAX_TOKENS}). Entries that do not fit are left out whole and listed in budget.omitted`,
    ),
};

// Memory v1(PBI-0378 / CAP-7・図86)
export const memoryProposeInputShape = {
  scope: z.enum(MEMORY_SCOPES).describe("project = this repository (same git origin) / personal = the owner everywhere"),
  type: z.enum(MEMORY_TYPES),
  content: z.string().describe(`one short statement (up to ${MEMORY_CONTENT_MAX_CHARS} characters)`),
  source_work_id: z.string().optional().describe("the work you learned this in (wrk_...) — required when an AI proposes"),
  run_id: z.string().optional().describe("your own run id, recorded as the source"),
  supersedes: z.string().optional().describe("id of an active memory this replaces (the owner always approves a replacement)"),
};

export const memorySearchInputShape = {
  query: z.string().optional().describe("words matched against the text on this device (any word)"),
  work_id: z.string().optional().describe("the work you are doing (wrk_...) — the recall is recorded on it"),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(CONTEXT_SEARCH_MAX_TOKENS)
    .optional()
    .describe(`the most this call returns (default ${CONTEXT_SEARCH_DEFAULT_MAX_TOKENS}); records that do not fit are counted in omitted`),
};

// Work Project の task と住所(PBI-0434・手描き 2 枚目)
export const workTaskCreateInputShape = {
  parent_work_id: z.string().describe("the Work Project (a work id) this task belongs to"),
  title: z.string().describe("what this task is"),
  to: z.string().optional().describe("runtime id or kind that should carry this task"),
  note: z.string().optional().describe("what that runtime needs to know"),
  context: taskContextShape,
  sources: sourcesShape,
  run_id: z.string().optional().describe("your own run id, recorded as the writer"),
};

// runtime transfer(PBI-0439 / CAP-3 V7・図84)。work_transfer は client 3 段を 1 回で回すので capsule の
// 要素も同じ呼び出しで受ける。git_state は受けない —— この folder の事実を MCP が取る(自己申告にしない)
export const workTransferInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  to: z.string().describe("runtime kind to move the work to (e.g. codex)"),
  run_id: z.string().describe("your own run id — the run that holds the lease now"),
  intent: z
    .string()
    .optional()
    .describe("one-time token from `openroly work intent <id> --action transfer_primary` (a human issues it; required when a runtime calls this)"),
  note: z.string().optional().describe("what the next runtime needs to know (kept as the work's handoff note)"),
  goal: z.unknown().optional(),
  current_state: z.unknown().optional(),
  decisions: z.unknown().optional(),
  unresolved_questions: z.unknown().optional(),
  relevant_artifacts: z.unknown().optional(),
  relevant_memory: z.unknown().optional(),
  capability_requirements: z.unknown().optional(),
};

export const workAcceptInputShape = {
  work_id: z.string().describe("work id (wrk_...)"),
  transfer_id: z
    .string()
    .optional()
    .describe("the transfer id from the instruction that woke you — omit it for a forked work (work_fork)"),
  run_id: z.string().optional().describe("the run id you will use from now on (one is made for you when omitted)"),
};

// fork / review(PBI-0440 / CAP-3 V8・図84)。拾う側は work_accept(transfer_id 無し)
export const workForkInputShape = {
  work_id: z.string().describe("the work to branch from (wrk_...) — it keeps running untouched"),
  to: z.string().describe("runtime kind that works on the branch (e.g. codex, claude)"),
  role: z
    .enum(["implementer", "reviewer"])
    .describe(
      "implementer: the branch gets the whole context and tries another approach. reviewer: a blind review — the branch sees only the goal, artifacts, git state and tests, not the previous agent's decisions or notes",
    ),
  note: z.string().optional().describe("what to do on the branch (kept as the branch's handoff note)"),
};

export const workMessageInputShape = {
  to_work_id: z.string().describe("the other agent's address = their task's work id (from work_team)"),
  from_work_id: z.string().describe("your own task's work id — replies come back to it"),
  text: z.string().max(4000).describe("what they need to know"),
};
