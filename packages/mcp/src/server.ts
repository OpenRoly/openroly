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
  workCapsuleInputShape,
  workContextPutInputShape,
  workContextSearchInputShape,
  workHandoffInputShape,
  workMessageInputShape,
  workProofInputShape,
  workTaskCreateInputShape,
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
const json = (tool: string, input: unknown, v: unknown) => {
  const text = JSON.stringify(maskValue(v, secrets), null, 2);
  peek?.record({ tool, input: maskValue(input, secrets), output: text });
  reportTool?.(tool);
  return { content: [{ type: "text" as const, text }] };
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
// 裏が実在する動詞だけ。checkpoint(30 秒の定期打ち。V3)/ transfer(V5)/ fork / start_review(V8)は
// まだ裏が無いので **口も作らない** —— not_implemented を返す死んだ path は「在る」と読まれる
// 分だけ害になる。work_capsule / work_capsules(PBI-0406・V2)は「1 回打つ口」— checkpoint とは
// 別の名前(定期 checkpoint が来た時に意味が割れないよう、口の名前を先に分けてある)

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
  "Publish key/value context and/or source file paths into this work's Work Project without handing it off (e.g. while working in parallel). Writing a key again with different content makes a new version; pass expected_versions {key: n} to refuse overwriting a newer value (409 stale_version — nothing in the call is written). Values stay on this device; the server only keeps key, hash and writer. Never put conversation/messages/transcript here; reference a secret as {credential_ref: \"env:NAME\"}",
  workContextPutInputShape,
  async ({ work_id, ...input }) => json("work_context_put", { work_id, ...input }, await tools.work_context_put(work_id, input)),
);

server.tool(
  "work_context_search",
  "Pull only what you need from this work's Work Project before you start, in two steps: index_only:true lists every key with est_tokens and a short preview (no values), then pull the keys you chose. Each call returns at most max_tokens (default 2000, up to 20000), highest priority first — goal, next_step, decisions, open_questions, failed_attempts, verified_findings, then other keys, sources, auto/, inbox/ — and entries that do not fit are left out whole and named in budget.omitted. Filter by exact keys, a key prefix or kind (context / source); query matches key and value text on this device. Each context entry comes with its value — or value null + missing_on_device:true when it was written on another device. Each source comes with source_status same / changed / missing (re-hashed against the file here). work_assigned already shows each work's key index — pull goal and next_step first. auto/ keys (git, files_touched, tests) are machine-recorded facts: read them, never write them",
  workContextSearchInputShape,
  async ({ work_id, ...input }) =>
    json("work_context_search", { work_id, ...input }, await tools.work_context_search(work_id, input)),
);

server.tool(
  "work_assigned",
  "Works whose standing owner is this runtime (handed to you by runtime id or by kind) — where to look when you start and nothing is leased yet. Returns work_id, title, status, handoff_note, project_id, lease_live and context_index (which keys exist, without their values). Then pull what you need with work_context_search",
  {},
  async () => json("work_assigned", {}, await tools.work_assigned()),
);

// Work Project の task と住所(PBI-0434・手描き 2 枚目)。分担した agent が同じ project の context を持って始め、互いに届く
server.tool(
  "work_task_create",
  "Split a Work Project: create one task under it (parent_work_id) and, if you pass to/note/context/sources, hand it to a runtime in the same call. A task cannot itself have tasks. If the task is created but handing it off fails, the error names the task id so you can retry work_handoff on it",
  workTaskCreateInputShape,
  async ({ parent_work_id, ...input }) =>
    json("work_task_create", { parent_work_id, ...input }, await tools.work_task_create(parent_work_id, input)),
);

server.tool(
  "work_team",
  "Who else is working on the same Work Project: the project and every task under it, each with its address (the task's work id), who it is assigned to, whether a run is live on it, and is_you. Use an address with work_message to reach that agent",
  { work_id: z.string().describe("any task or the project itself") },
  async ({ work_id }) => json("work_team", { work_id }, await tools.work_team(work_id)),
);

server.tool(
  "work_message",
  "Send a note to another agent on the same Work Project (to_work_id = their address from work_team, from_work_id = your own task). It lands in their task's Work Project context under inbox/<your task>/..., which they read with work_context_search prefix \"inbox/\" — agents coordinate through work state, not a chat. The text stays on this device like other context values. Refused (nothing sent) when the address is not on your project",
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
