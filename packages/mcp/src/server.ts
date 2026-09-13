#!/usr/bin/env bun
// OpenRoly Account tools の MCP server(stdio)。
// 使い方: OPENROLY_TOKEN=par_xxx [OPENROLY_URL=http://localhost:8787] bun packages/mcp/src/server.ts
// Claude Code 等の runtime はこれを MCP server として登録すると @handle として attach できる。

import { credentialsPath, getCredential } from "@openroly/adapter";
import { adoptLegacyEnv, CHECKPOINT_TICK_INTERVAL_SECS } from "@openroly/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSecrets, maskValue, restoreText } from "openroly-mask";
import {
  labelInputShape,
  replyInputShape,
  rulesPutInputShape,
  sendInputShape,
  workAcceptInputShape,
  workCapsuleInputShape,
  workContextPublishInputShape,
  workContextPutInputShape,
  workContextSearchInputShape,
  workForkInputShape,
  workHandoffInputShape,
  workMessageInputShape,
  workProofInputShape,
  workTaskCreateInputShape,
  workTransferInputShape,
} from "./schemas.ts";
import { openPeek, openSessionUpdate } from "./peek.ts";
import { createAccountTools } from "./tools.ts";
import { startCheckpointTicker, pushCheckpointAfterProof } from "./checkpoint.ts";

adoptLegacyEnv(); // 旧 PAA_* env を採り込む(PBI-0344 AC-3。使った時だけ 1 行警告)

// credential は pairing で保存済みのものを使う(要件 §15.2: API key の copy/paste を標準 UX に
// しない)。OPENROLY_RUNTIME_KIND が credential store の entry を選ぶ。OPENROLY_TOKEN は手動/CI 用の逃げ道。
const kind = process.env.OPENROLY_RUNTIME_KIND;
const stored = kind ? await getCredential(kind) : undefined;
const token = process.env.OPENROLY_TOKEN ?? stored?.token;
if (!token) {
  console.error(
    `No OpenRoly credential was found (OPENROLY_RUNTIME_KIND=${kind ?? "unset"}, ${credentialsPath()})\n` +
      "Run 'openroly install claude' / 'openroly install codex' to pair this runtime first",
  );
  process.exit(1);
}
const tools = createAccountTools({
  baseUrl: process.env.OPENROLY_URL ?? stored?.base_url ?? "http://localhost:8787",
  token,
  deviceKind: kind ?? "default",
  // triage session(EP-0013 W3)。broker が dedicated session の env に載せた scope token。
  // 普通に起動した session には無いので header も送られない = 全権のまま
  scopeToken: process.env.OPENROLY_SESSION_SCOPE,
});

// secret masking(REQ-69)。~/.openroly/secrets.json が在れば tool 応答の文字列値を `⟨s:n⟩` に置き換え、
// send / reply の text だけ復元する。0600 以外の file は起動を拒否する(fail-closed)
let secrets: string[];
try {
  secrets = loadSecrets();
} catch (e) {
  console.error(`Could not read secrets.json: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// Peek log(PBI-0224)。dedicated session(broker が env に OPENROLY_SESSION_ID を載せた時)だけ、model に
// 返す masked 済み text をそのまま session_dir/peek.jsonl に残す。manual session では null = 何もしない
const peek = openPeek(process.env);
// hook socket への tool 報告(PBI-0229)。broker が last_tool / tool_count(presence と tool cap)を
// 持つ為の上流。manual session / broker 未起動では null・失敗 = 何もしない(fail-open)
const reportTool = openSessionUpdate(process.env);

const server = new McpServer({ name: "openroly-account", version: "0.2.0" });

// **全 tool 応答の唯一の出口**(REQ-69)。ここで mask してから model に渡し、渡した text そのものを
// peek に記録する(model が見た面 = log の面)。input も mask してから記録する —— tool 引数に生の値が
// 来ても log には出さない。send / reply は restore **前** の input(placeholder 入り)を渡す事
// PBI-0444: 握っている work に未読の inbox が在れば 2 つ目の text に notice(1 つ目の JSON はそのまま読める)
const json = async (tool: string, input: unknown, v: unknown) => {
  const text = JSON.stringify(maskValue(v, secrets), null, 2);
  const found = await tools.inbox_notice();
  const notice = found == null ? null : String(maskValue(found, secrets));
  peek?.record({ tool, input: maskValue(input, secrets), output: notice == null ? text : `${text}\n${notice}` });
  reportTool?.(tool);
  return { content: [{ type: "text" as const, text }, ...(notice == null ? [] : [{ type: "text" as const, text: notice }])] };
};

server.tool(
  "whoami",
  "Identity of the attached agent account and its unread count",
  {},
  async () => json("whoami", {}, await tools.whoami()),
);

server.tool(
  "inbox_list",
  "List received messages (metadata only, no bodies). Use inbox_read for the body",
  {},
  async () => json("inbox_list", {}, await tools.inbox_list()),
);

server.tool(
  "inbox_read",
  "Read a message body by message_id",
  { message_id: z.string() },
  async ({ message_id }) => json("inbox_read", { message_id }, await tools.inbox_read(message_id)),
);

server.tool(
  "send",
  "Send a message to an @handle. The delegation policy may put it in pending_approval",
  sendInputShape,
  // text だけ mask の逆変換(restore)。agent が通知から credential を引用して送れるようにする為
  async (input) =>
    json(
      "send",
      input,
      await tools.send({
        ...input,
        text: input.text !== undefined ? restoreText(input.text, secrets) : undefined,
      }),
    ),
);

server.tool(
  "reply",
  "Reply in a thread inside your own account (the thread shared with the owner — where owner instructions are reported back)",
  replyInputShape,
  async (input) =>
    json(
      "reply",
      input,
      await tools.reply({
        ...input,
        text: input.text !== undefined ? restoreText(input.text, secrets) : undefined,
      }),
    ),
);

server.tool(
  "agents_list",
  "Who this account can talk to. runtimes = runtimes of the same account (name / kind / is_default / live = whether a wake reaches it now); contacts = addresses (pass address straight to send's to). The other account's liveness is never returned (by design)",
  {},
  async () => json("agents_list", {}, await tools.agents_list()),
);

server.tool("contacts_list", "List contacts", {}, async () =>
  json("contacts_list", {}, await tools.contacts_list()),
);

server.tool(
  "contacts_get",
  "Get one contact",
  { contact_id: z.string() },
  async ({ contact_id }) => json("contacts_get", { contact_id }, await tools.contacts_get(contact_id)),
);

server.tool(
  "mark_read",
  "Mark a message as read (only this runtime's read state changes)",
  { message_id: z.string() },
  async ({ message_id }) => json("mark_read", { message_id }, await tools.mark_read(message_id)),
);

server.tool(
  "approval_get",
  "Status of an approval you raised (a send/reply awaiting approval): pending / approved / rejected. Content is not included",
  { approval_id: z.string() },
  async ({ approval_id }) => json("approval_get", { approval_id }, await tools.approval_get(approval_id)),
);

server.tool(
  "notification_label",
  "Put a triage label on a notification item (action = needs handling / fyi = for information / discard = not needed). The summary is sealed with the device key before sending",
  labelInputShape,
  async ({ message_id, label, summary }) =>
    json("notification_label", { message_id, label, summary }, await tools.notification_label(message_id, label, summary)),
);

server.tool(
  "rules_put",
  "Save how the owner asked to handle things as a rule (nl = their words verbatim, scope = what it applies to, action = what to do). The server normalizes it, picks the layer (metadata / content) and returns the normalized rule — echo it back to the owner in one sentence. Putting the same nl again updates in place (no duplicate rules). sender / keywords in scope make it a content rule, stored encrypted on the server",
  rulesPutInputShape,
  async (input) => json("rules_put", input, await tools.rules_put(input)),
);

server.tool(
  "rules_list",
  "List saved rules. The scope of content rules is restored with the device key",
  {},
  async () => json("rules_list", {}, await tools.rules_list()),
);

// ---------- Work Core の口(PBI-0400 / CAP-3 V9・図79) ----------
// 裏が実在する動詞だけ(not_implemented を返す死んだ path は「在る」と読まれる分だけ害になる)。
// work_capsule / work_capsules(PBI-0406・V2)は「1 回打つ口」— 30 秒の定期 checkpoint(V3・下の tick)とは別の名前

// runtime transfer(PBI-0439 / CAP-3 V7・図84)。transfer の口は source 側(work_transfer)と target 側(work_accept)の 2 つ
server.tool(
  "work_transfer",
  "Move the work you hold to another runtime (e.g. codex) without a moment where nobody holds it: the server reserves the lease for the transfer, this call snapshots this folder's git state plus the capsule fields you pass (goal, current_state, decisions, ...) under that reservation, and the server wakes the target runtime in this folder with a fixed instruction to call work_accept. A runtime needs a one-time intent token a human issued (openroly work intent <id> --action transfer_primary). If it stops midway the error names the transfer id and the state; a failed route releases the lease so you can claim the work again",
  workTransferInputShape,
  async ({ work_id, ...input }) =>
    json("work_transfer", { work_id, to: input.to }, await tools.work_transfer(work_id, input)),
);

server.tool(
  "work_accept",
  "Take over a work that was transferred to you (work_id and transfer_id are in the instruction that woke you) or a forked work (work_id only). It gives you the write lease and returns the work's capsule as text (rendered) — the same text whichever runtime you are — starting with a line when this folder's files changed since the capsule, then the work's context key index. Fields that do not fit 2000 tokens are left out whole and named in receipt.omitted. On a reviewer branch the fields the profile keeps from you are named (never shown) in receipt.hidden. Use the returned run_id for work_capsule / work_proof from now on",
  workAcceptInputShape,
  async ({ work_id, ...input }) =>
    json("work_accept", { work_id, transfer_id: input.transfer_id }, await tools.work_accept(work_id, input)),
);

// fork / review(PBI-0440 / CAP-3 V8・図84)。元の work を止めずに枝を 1 本。拾う側は同じ work_accept(transfer_id 無し)
server.tool(
  "work_fork",
  "Branch a work without stopping it: copies the work's latest capsule into a new work, makes a separate copy of this folder's repo at the capsule's git state (under ~/.openroly/worktrees — this folder and its .git are never written), and wakes the target runtime there. role implementer = try another approach with the full context; role reviewer = a blind review that sees only the goal, artifacts, git state and tests, not the previous agent's decisions or notes. A runtime needs the owner's permission (delegation work_authority fork_work / start_review). If the wake fails the branch stays ready and work_accept can pick it up later",
  workForkInputShape,
  async ({ work_id, ...input }) =>
    json("work_fork", { work_id, to: input.to, role: input.role }, await tools.work_fork(work_id, input)),
);

server.tool(
  "work_capsule",
  "Push one immutable snapshot (a 'capsule') of this work's state — goal, current_state, decisions, unresolved_questions, relevant_artifacts, relevant_memory, git_state, capability_requirements. Only the run that holds the lease can: pass your own run id. Pushing the exact same content as the last capsule does not create a new version (dedupe: deduped:true in the reply). Never pass conversation/messages/transcript here — that call is rejected. The actual content is stored only on this device (~/.openroly/checkpoints), never sent to the server — the server only keeps a small manifest (hash/size). To reference a secret, use {credential_ref: \"env:NAME\"} — never write a raw secret value into any field, it will be rejected",
  workCapsuleInputShape,
  async ({ work_id, ...input }) => json("work_capsule", { work_id, ...input }, await tools.work_capsule(work_id, input)),
);

server.tool(
  "work_capsules",
  "List every capsule version pushed for this work, oldest first — each entry has the full body (goal / current_state / decisions / ...) plus version, content_hash, and created_at",
  { work_id: z.string() },
  async ({ work_id }) => json("work_capsules", { work_id }, await tools.work_capsules(work_id)),
);

server.tool(
  "work_current",
  "The work this account has a live run on right now (null if none). Picked by the lease alone; handled_runtime_id is the standing owner and is reported separately - never read it as 'running now'. ambiguous:true means more than one work is leased and this is the most recent one",
  {},
  async () => json("work_current", {}, await tools.work_current()),
);

server.tool(
  "work_get",
  "One work item by id (status, lease, the standing owner)",
  { work_id: z.string() },
  async ({ work_id }) => json("work_get", { work_id }, await tools.work_get(work_id)),
);

server.tool(
  "work_events",
  "The event log of one work, oldest first. after = the work_sequence you already have (pass it to get only what is new)",
  { work_id: z.string(), after: z.number().int().nonnegative().optional() },
  async ({ work_id, after }) => json("work_events", { work_id, after }, await tools.work_events(work_id, after)),
);

server.tool(
  "work_proof",
  "Record what a check actually said on this work (e.g. 32 passed / 2 failed). Only the run that holds the lease can: pass your own run id, not the one you read off the work",
  workProofInputShape,
  async ({ work_id, ...input }) => {
    const result = await tools.work_proof(work_id, input);
    // PBI-0408 AC-5: 重要 event(tests.completed = proof)は 30 秒 tick を待たず即 checkpoint する
    // (best-effort。`tools.work_proof` 本体には置かない理由は checkpoint.ts のコメント参照)
    await pushCheckpointAfterProof(tools, work_id, input.run_id, process.cwd());
    return json("work_proof", { work_id, ...input }, result);
  },
);

server.tool(
  "work_promote",
  "Turn a thread you labelled 'action' into a work item. Calling it again on the same thread returns the same work_id (already_promoted: true) instead of making a second one",
  { thread_id: z.string() },
  async ({ thread_id }) => json("work_promote", { thread_id }, await tools.work_promote(thread_id)),
);

server.tool(
  "work_handoff",
  "Hand the work to another runtime (to = its runtime id or kind) and/or leave a note — and in the same call publish what the next agent needs into this work's Work Project: context = key/value facts, preferably the well-known keys goal / next_step / decisions / open_questions / failed_attempts / verified_findings (e.g. {\"next_step\": \"make the reconnect test deterministic\"}), sources = repo-relative file paths (e.g. docs/plan.md). Values are stored only on this device (the server keeps the key, a hash and who wrote it); sources are recorded by path + sha256, not copied. Either all of it lands or none of it does. Never put conversation/messages/transcript into context; reference a secret as {credential_ref: \"env:NAME\"}. This sets the standing owner, not the live lease",
  workHandoffInputShape,
  async ({ work_id, ...input }) => json("work_handoff", { work_id, ...input }, await tools.work_handoff(work_id, input)),
);

// Work Project context(PBI-0433・手描き 1 枚目・図80)。handoff が書き、次の agent が search で要る key だけ取る
server.tool(
  "work_context_put",
  "Publish key/value context and/or source file paths into this work's Work Project without handing it off (e.g. while working in parallel). Writing a key again with different content makes a new version; pass expected_versions {key: n} to refuse overwriting a newer value (409 stale_version — nothing in the call is written). Values stay on this device; the server only keeps key, hash and writer. Never put conversation/messages/transcript here; reference a secret as {credential_ref: \"env:NAME\"}. If you hold a task, write to your task: writing to its Work Project directly is refused (409 publish_required) — share with the project through work_context_publish, which is also the only way into a project nobody holds",
  workContextPutInputShape,
  async ({ work_id, ...input }) => json("work_context_put", { work_id, ...input }, await tools.work_context_put(work_id, input)),
);

// PBI-0443: task → Work Project の公開。project に出す口はこれだけ(図80c ④)
server.tool(
  "work_context_publish",
  "Publish keys you already wrote on your task to the task's Work Project — the only way a task's context reaches the project. All keys land or none do (a key missing on the task fails with unknown_key and nothing is written); each project entry records published_from: <task>@<version>. Pass expected_versions {key: n} with the project's version to refuse overwriting a newer value (409 stale_version). auto/ and inbox/ keys cannot be published",
  workContextPublishInputShape,
  async ({ work_id, ...input }) =>
    json("work_context_publish", { work_id, ...input }, await tools.work_context_publish(work_id, input)),
);

server.tool(
  "work_context_search",
  "Pull only what you need from this work's Work Project before you start, in two steps: index_only:true lists every key with est_tokens and a short preview (no values), then pull the keys you chose. Each call returns at most max_tokens (default 2000, up to 20000), highest priority first — goal, next_step, decisions, open_questions, failed_attempts, verified_findings, then other keys, sources, auto/, inbox/ — and entries that do not fit are left out whole and named in budget.omitted. Filter by exact keys, a key prefix or kind (context / source); query matches key and value text on this device. Each context entry comes with its value — or value null + missing_on_device:true when it was written on another device. Each source comes with source_status same / changed / missing (re-hashed against the file here). work_assigned already shows each work's key index — pull goal and next_step first. auto/ keys (git, files_touched, tests) are machine-recorded facts: read them, never write them. A Work Project entry that a task published carries published_from: <task>@<version>",
  workContextSearchInputShape,
  async ({ work_id, ...input }) =>
    json("work_context_search", { work_id, ...input }, await tools.work_context_search(work_id, input)),
);

server.tool(
  "work_assigned",
  "Works whose standing owner is this runtime (handed to you by runtime id or by kind) — where to look when you start and nothing is leased yet. Returns work_id, title, status, handoff_note, project_id, folder, lease_live and context_index (which keys exist, without their values). When folder is not null, the task has its own copy of the project's files there — do all your file work in that folder, not in the project's folder. Then pull what you need with work_context_search",
  {},
  async () => json("work_assigned", {}, await tools.work_assigned()),
);

// Work Project の task と住所(PBI-0434・手描き 2 枚目)。分担した agent が同じ project の context を持って始め、互いに届く
server.tool(
  "work_task_create",
  "Split a Work Project: create one task under it (parent_work_id) and, if you pass to/note/context/sources, hand it to a runtime in the same call. A task cannot itself have tasks. When you hand it to a runtime (to) from inside a git repo with a commit, the task gets its own folder — a copy of this folder's current files under the openroly home's worktrees/<task id> — returned as folder, so parallel tasks never write the same file; bring the result back with work_task_merge. If the task is created but its folder or the handoff fails, the error names the task id so you can retry work_handoff on it",
  workTaskCreateInputShape,
  async ({ parent_work_id, ...input }) =>
    json("work_task_create", { parent_work_id, ...input }, await tools.work_task_create(parent_work_id, input)),
);

server.tool(
  "work_task_merge",
  "Bring a task's work back into this folder (the Work Project's working tree): every change made in the task's folder since it was handed off — edited, added and deleted files — is applied to the files here. Nothing is committed and the git index is not touched, so the result shows up in git diff / git status. If any change collides with what is here, nothing at all is applied and result is conflict with the colliding paths. busy = another git operation holds this repo's index.lock (nothing applied, try again); empty = the task changed nothing. Refused before touching anything when the task is not on this Work Project (not_on_team) or its folder is not on this device (worktree_missing). applied and conflict are recorded on the task and show up as merge in work_team",
  {
    work_id: z.string().describe("the Work Project whose working tree is this folder"),
    task_id: z.string().describe("the task to merge (its address from work_team)"),
  },
  async ({ work_id, task_id }) => json("work_task_merge", { work_id, task_id }, await tools.work_task_merge(work_id, task_id)),
);

server.tool(
  "work_team",
  "Who else is working on the same Work Project: the project and every task under it, each with its address (the task's work id), who it is assigned to, whether a run is live on it, is_you, and merge (not_started / applied / conflict — the last work_task_merge of that task). Use an address with work_message to reach that agent",
  { work_id: z.string().describe("any task or the project itself") },
  async ({ work_id }) => json("work_team", { work_id }, await tools.work_team(work_id)),
);

server.tool(
  "work_message",
  "Send a note to another agent on the same Work Project (to_work_id = their address from work_team, from_work_id = your own task). It lands in their task's Work Project context under inbox/<your task>/..., which they read with work_context_search prefix \"inbox/\" — agents coordinate through work state, not a chat. The text stays on this device like other context values. Refused (nothing sent) when the address is not on your project. While the receiver holds its task, every openroly tool reply it gets carries a second text \"notice: N unread inbox messages on <task> …\" (up to 30 seconds late) until it pulls them with work_context_search — index_only or entries left out by max_tokens stay unread",
  workMessageInputShape,
  async ({ to_work_id, ...input }) =>
    json(
      "work_message",
      { to_work_id, ...input },
      await tools.work_message(to_work_id, { ...input, text: restoreText(input.text, secrets) }),
    ),
);

// v0 Authority(PBI-0413 / CAP-3 V10・direction/v0.md §7): freeze moves who holds the live
// lease(primary) — that always needs a human-issued one-time intent token, so it was never
// safe to expose until this gate existed(that's why V9 skipped it). Calling it without a
// valid `intent` always fails with explicit_user_intent_required — a runtime cannot mint its
// own token (that route requires a human-authenticated caller, which MCP callers never are).
// Get the token out-of-band(the human runs `openroly work intent <id> --action ...`).
// claim has no authority tier(it can never displace a held work — see server route comment)
// so it still has no MCP tool, same as V9 left it.

server.tool(
  "work_freeze",
  "Release the live lease (stop_primary) — the previous epoch is rejected forever after this. This always requires a one-time intent token a human already issued out-of-band (openroly work intent <id> --action stop_primary); without it this call is rejected with explicit_user_intent_required, no matter who calls it",
  {
    work_id: z.string(),
    intent: z.string().optional().describe("one-time token from `openroly work intent <id> --action stop_primary`"),
  },
  async ({ work_id, intent }) => json("work_freeze", { work_id }, await tools.work_freeze(work_id, { intent })),
);

// 30 秒 checkpoint tick(PBI-0408 / CAP-3 V3・C4 #27)。runtime(model の推論ループ)の気まぐれとは
// 無関係に、この process が生きている限り device 側の事実(git_state)だけを見て打つ。
// **runtime が死んだ後に新しい request を作らない**(AC-6)為に、stdio が閉じたら止める ——
// StdioServerTransport 自身も stdin の end/close で server を畳むが、この tick は
// それより早く自分の interval を止める(進行中の 1 回は中断しない。次を起こさないだけ)
const checkpointTicker = startCheckpointTicker(tools, {
  cwd: process.cwd(),
  intervalMs: CHECKPOINT_TICK_INTERVAL_SECS * 1000,
  onError: (e) => console.error(`checkpoint tick failed: ${e instanceof Error ? e.message : String(e)}`),
});
process.stdin.on("end", () => checkpointTicker.stop());
process.stdin.on("close", () => checkpointTicker.stop());

await server.connect(new StdioServerTransport());
