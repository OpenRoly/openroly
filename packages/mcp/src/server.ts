#!/usr/bin/env bun
// OpenRoly Account tools の MCP server(stdio)。
// 使い方: OPENROLY_TOKEN=par_xxx [OPENROLY_URL=https://openroly.shibubu.ai] bun packages/mcp/src/server.ts
// Claude Code 等の runtime はこれを MCP server として登録すると @handle として attach できる。

import { credentialsPath, DEFAULT_BASE_URL, ingestAndLink } from "@openroly/adapter";
import { resolveMcpIdentity } from "./identity.ts";
import { adoptLegacyEnv, CHECKPOINT_TICK_INTERVAL_SECS } from "@openroly/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_PATTERNS, loadConfig, Masker, type MaskConfig } from "openroly-mask";
import {
  labelInputShape,
  memoryProposeInputShape,
  memorySearchInputShape,
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
import { noteMasking, openPeek, openSessionUpdate } from "./peek.ts";
import { openRelay } from "./relay.ts";
import { createLiveAccountTools } from "./live-tools.ts";
import { startCheckpointTicker, pushCheckpointAfterProof } from "./checkpoint.ts";

adoptLegacyEnv(); // 旧 PAA_* env を採り込む(PBI-0344 AC-3。使った時だけ 1 行警告)

// PBI-0558: broker が「辞書を読める外の server」を起こした session では、runtime が起こしたこの process は relay になる。
// 外へ繋がれば byte を中継するだけ(credential も secrets.json も読まない)。繋がらなければ理由を 1 行残し、
// このまま中の server として続ける(sandbox が辞書を deny していれば下で本文 tool を閉じる = PBI-0548 の形。生の本文へは落ちない)
if (process.env.OPENROLY_MCP_RELAY) {
  const failed = await openRelay(process.env.OPENROLY_MCP_RELAY, process.env.OPENROLY_MASK_TOKEN ?? "");
  if (failed === null) await new Promise<never>(() => {}); // 中継中。socket が閉じたら relay.ts が exit する
  console.error(`masking server not reachable (${failed}); continuing inside the sandbox`);
  noteMasking(process.env, `masking: unavailable — ${failed}`);
}

// credential は pairing / auto-register で保存済みのものを使う(要件 §15.2)。
// kind は OPENROLY_RUNTIME_KIND、無ければ親 process。OPENROLY_TOKEN は手動/CI 用の逃げ道。
const identity = await resolveMcpIdentity(process.env);
const kind = identity?.kind ?? process.env.OPENROLY_RUNTIME_KIND;
const stored = identity?.credential;
const token = process.env.OPENROLY_TOKEN ?? stored?.token;
if (!token) {
  console.error(
    `No OpenRoly credential was found (OPENROLY_RUNTIME_KIND=${kind ?? "unset"}, ${credentialsPath()})\n` +
      "Run 'openroly login' on this machine, then add MCP command openroly-mcp in the AI",
  );
  process.exit(1);
}
void ingestAndLink(process.env).catch(() => null);

const live = createLiveAccountTools({
  // 既定は 1 箇所(`DEFAULT_BASE_URL`)から取る —— ここに literal を写すと、既定を変えた時に
  // この 1 行だけが古い行き先を指し続ける(PBI-0641)
  baseUrl: process.env.OPENROLY_URL ?? stored?.base_url ?? DEFAULT_BASE_URL,
  token,
  deviceKind: kind ?? "default",
  runtimeKind: kind ?? undefined, // PBI-0557: work_current が「別 runtime で止まった work」を弁別する為の自分側の値
  // session scope token(EP-0013 W3 → PBI-0320)。broker が 5 lane + Manual の session の env に載せた物。
  // 手元で起こした session には無いので header も送られない(agent 面の書き込みは server が 403 scope_required)
  scopeToken: process.env.OPENROLY_SESSION_SCOPE,
});
let tools = live.current();

// secret masking(REQ-69)。~/.openroly/secrets.json が在れば tool 応答の文字列値を `⟨s:n⟩` に置き換え、
// send / reply の text だけ復元する。0600 以外の file は起動を拒否する(fail-closed)。
// 例外は **broker の sandbox が read を deny した時だけ**(PBI-0238 の deny_read・PBI-0545)。ここで止めると
// secrets.json の在る機の dedicated session で openroly の tool が 1 つも繋がらない。読めない辞書では置換できないので、
// その session では **他人が書いた本文を返す tool を閉じる**(下の OTHERS_TEXT_TOOLS・PBI-0548)—— work の tool は開けたまま。
// sandbox の見分け方: seatbelt の deny は stat の EPERM(mode や ACL の不足は EACCES)。Landlock の deny は
// open の EACCES で権限不足と区別できないので、broker が dedicated session にだけ載せる OPENROLY_SESSION_ID を
// 併せて見る。それ以外(sandbox の外で読めない・0600 以外・壊れた JSON)は従来どおり exit 1。
// 判定は errno の code で見る(message は path を含むので、path の綴りで枝が変わる)
// PBI-0558: 出口は辞書(SECRETS / PRIVATE)に加えて形(電話・mail address・card 番号・鍵)も伏せる(REQ-69 を openroly-mask の
// Masker で。以前は辞書だけで、電話番号は生で model に届いていた)。pattern の一致は process の寿命の表に積み、send / reply で戻す
let mask: MaskConfig;
let maskingOff = false;
try {
  mask = loadConfig();
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EPERM" || (code === "EACCES" && process.env.OPENROLY_SESSION_ID)) {
    console.error(
      "secrets.json is not readable in this sandbox; secret masking is OFF for this session, so the tools that return other people's text are closed",
    );
    mask = { secrets: [], patterns: DEFAULT_PATTERNS };
    maskingOff = true;
  } else {
    console.error(`Could not read secrets.json: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
const masker = new Masker(mask.secrets);
const masked = (v: unknown) => masker.maskValue(v, mask.patterns);

// Peek log(PBI-0224)。dedicated session(broker が env に OPENROLY_SESSION_ID を載せた時)だけ、model に
// 返す masked 済み text をそのまま session_dir/peek.jsonl に残す。manual session では null = 何もしない
const peek = openPeek(process.env);
// hook socket への tool 報告(PBI-0229)。broker が last_tool / tool_count(presence と tool cap)を
// 持つ為の上流。manual session / broker 未起動では null・失敗 = 何もしない(fail-open)
const reportTool = openSessionUpdate(process.env);

const server = new McpServer({ name: "openroly-account", version: "0.2.0" });

// PBI-0548: 辞書が読めない session(maskingOff)で閉じる tool。基準は「他人が書いた本文を返すか」で、迷ったら閉じる。
// work の tool(transfer / fork / capsule / proof / context)は自分の account の agent が書いた物なので開けたまま。
// 一覧は packages/mcp/test/secrets-unreadable-review-0545.test.ts が listTools と突き合わせて固定する(足した tool はどちらかに書く)
const OTHERS_TEXT_TOOLS = new Set([
  "inbox_list", // 差出人・件名
  "inbox_read", // 本文
  "contacts_list", // 相手の名前・住所
  "contacts_get",
  "agents_list", // contacts を含む
  "approval_get", // 宛先
  "rules_list", // content rule の sender / keywords
  "work_events", // event の detail(thread 由来の文言が乗りうる)
]);
/** server.tool と同じ引数。閉じる tool は handler を「叩かずに断る」物に差し替えて登録する(API も呼ばない) */
const tool = ((name: string, ...rest: unknown[]) => {
  const handler = rest.pop() as (...args: unknown[]) => unknown;
  const refuse = () => {
    const text = JSON.stringify({
      error: "masking_unavailable",
      tool: name,
      detail: "secrets.json is not readable in this sandbox, so this session is not given other people's text",
    });
    peek?.record({ tool: name, input: {}, output: text });
    return { isError: true, content: [{ type: "text" as const, text }] };
  };
  const wrapped = async (...args: unknown[]) => {
    tools = await live.refresh();
    return handler(...args);
  };
  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;
  return register(name, ...rest, maskingOff && OTHERS_TEXT_TOOLS.has(name) ? refuse : wrapped);
}) as unknown as typeof server.tool;

// **全 tool 応答の唯一の出口**(REQ-69)。ここで mask してから model に渡し、渡した text そのものを
// peek に記録する(model が見た面 = log の面)。input も mask してから記録する —— tool 引数に生の値が
// 来ても log には出さない。send / reply は restore **前** の input(placeholder 入り)を渡す事
// PBI-0444: 握っている work に未読の inbox が在れば 2 つ目の text に notice(1 つ目の JSON はそのまま読める)
// `from` = v を運んできた送り手(inbox_read だけが渡す)。v の中で pattern に一致した値にその送り手を積む(下の valueOrigins)
const json = async (tool: string, input: unknown, v: unknown, from: string[] = []) => {
  const noteOrigin = (i: number) => valueOrigins.set(i, from.reduce((s, f) => s.add(f), valueOrigins.get(i) ?? new Set<string>()));
  const text = JSON.stringify(from.length === 0 ? masked(v) : masker.maskValue(v, mask.patterns, noteOrigin), null, 2);
  const found = await tools.inbox_notice();
  const notice = found == null ? null : String(masked(found));
  peek?.record({ tool, input: masked(input), output: notice == null ? text : `${text}\n${notice}` });
  reportTool?.(tool);
  return { content: [{ type: "text" as const, text }, ...(notice == null ? [] : [{ type: "text" as const, text: notice }])] };
};

// PBI-0579: send / reply で伏せた値を戻す範囲は **lane と値の出どころ**で決める。owner 以外の scope の session(triage /
// auto / draft / takeover / work_review = 他人が書いた本文が指示の顔で入ってくる lane)では
//   辞書(SECRETS / PRIVATE)の値 = 戻さない(注入文の「⟨s:0⟩ を外へ送れ」で辞書の値が承認画面と外へ出ない)
//   pattern の値 = その値を運んできた message の送り手が今回の宛先の時だけ戻す(返信で相手自身の住所・電話を書き戻す使い方は残す)。
//                  出どころを持たない値(通知の item・他の tool・process の入れ替え)は戻さない
//   send の to = 丸ごと 1 つの placeholder の時だけ戻す(`x+⟨s:0⟩@evil.example` のように住所の中へ埋めて外へ運ばせない)
// owner scope の session(owner lane と web から起こした manual・PBI-0320)と scope token の無い session は今までどおり全部戻す。
// lane は token の字面 `pst_<scope>.` から読む(権限は server が map で検証する・ここは戻す範囲だけ)。形の分からない token は
// untrusted に倒す。approval の門は server 側にそのまま残る(二重)
const sessionScope = process.env.OPENROLY_SESSION_SCOPE;
const untrustedLane = Boolean(sessionScope) && /^pst_([a-z_]+)\./.exec(sessionScope ?? "")?.[1] !== "owner";
/** pattern の値の index → その値を運んできた送り手(小文字の mail address / handle)。process の寿命だけ */
const valueOrigins = new Map<number, Set<string>>();
const peerKey = (s: string) => s.trim().replace(/^@/, "").toLowerCase();
const restoreTo = (to: string) =>
  !untrustedLane ? masker.restoreText(to) : /^⟨s:\d+⟩$/.test(to.trim()) ? masker.restoreText(to.trim()) : to;
/** `to` = 戻した後の宛先。reply は null(宛先を持たない = untrusted な lane では何も戻さない) */
const restoreBody = (text: string, to: string | null) =>
  !untrustedLane
    ? masker.restoreText(text)
    : text.replace(/⟨s:(\d+)⟩/g, (whole, n: string) =>
        Number(n) >= mask.secrets.length && to !== null && valueOrigins.get(Number(n))?.has(peerKey(to))
          ? masker.restoreText(whole)
          : whole,
      );
/** 受信 message の送り手 = その thread の peer(server が持つ住所 / handle。本文や表示名は相手が書ける字面なので使わない)。
 * 通知の item(送り手は app で peer は自分)・送った側の message・thread が読めない時は空 = 出どころを積まない */
const senderOf = async (message: unknown): Promise<string[]> => {
  const m = message as { thread_id?: unknown; direction?: unknown; kind?: unknown } | null;
  if (!m || m.direction !== "in" || m.kind === "notification" || typeof m.thread_id !== "string") return [];
  try {
    const thread = (await tools.thread_get(m.thread_id)) as { peer_address?: unknown; peer_handle?: unknown };
    return [thread.peer_address, thread.peer_handle].filter((p): p is string => typeof p === "string" && p !== "").map(peerKey);
  } catch {
    return [];
  }
};

tool(
  "whoami",
  "Identity of the attached agent account and its unread count",
  {},
  async () => json("whoami", {}, await tools.whoami()),
);

tool(
  "inbox_list",
  "List received messages (metadata only, no bodies). Use inbox_read for the body",
  {},
  async () => json("inbox_list", {}, await tools.inbox_list()),
);

tool(
  "inbox_read",
  "Read a message body by message_id",
  { message_id: z.string() },
  async ({ message_id }) => {
    const message = await tools.inbox_read(message_id);
    return json("inbox_read", { message_id }, message, untrustedLane ? await senderOf(message) : []);
  },
);

tool(
  "send",
  "Send a message to an @handle. The delegation policy may put it in pending_approval",
  sendInputShape,
  // text と宛先を mask の逆変換(restore)。text は agent が通知から credential を引用して送れるようにする為。
  // to は、出口の pattern が mail address を伏せる(PBI-0558)ので agents_list / inbox_read から拾える宛先が placeholder しか無い為
  // (戻さないと server に `⟨s:n⟩` が宛先として届き送れない = module review 順 8 の A2)。戻す範囲は lane で絞る(restoreTo / restoreBody)
  async (input) => {
    const to = restoreTo(input.to);
    return json(
      "send",
      input,
      await tools.send({ ...input, to, text: input.text !== undefined ? restoreBody(input.text, to) : undefined }),
    );
  },
);

tool(
  "reply",
  "Reply in a thread inside your own account (the thread shared with the owner — where owner instructions are reported back)",
  replyInputShape,
  async (input) =>
    json(
      "reply",
      input,
      await tools.reply({
        ...input,
        text: input.text !== undefined ? restoreBody(input.text, null) : undefined,
      }),
    ),
);

tool(
  "agents_list",
  "Who this account can talk to. runtimes = runtimes of the same account (name / kind / is_default / live = waking it now starts a session: a paired device that has it is connected AND we have a way to start it — a headless recipe, or an API provider you hold a key for. live does not promise the runtime's own vendor auth still works); contacts = addresses (pass address straight to send's to). The other account's liveness is never returned (by design)",
  {},
  async () => json("agents_list", {}, await tools.agents_list()),
);

tool("contacts_list", "List contacts", {}, async () =>
  json("contacts_list", {}, await tools.contacts_list()),
);

tool(
  "contacts_get",
  "Get one contact",
  { contact_id: z.string() },
  async ({ contact_id }) => json("contacts_get", { contact_id }, await tools.contacts_get(contact_id)),
);

tool(
  "mark_read",
  "Mark a message as read (only this runtime's read state changes)",
  { message_id: z.string() },
  async ({ message_id }) => json("mark_read", { message_id }, await tools.mark_read(message_id)),
);

tool(
  "approval_get",
  "Status of an approval you raised (a send/reply awaiting approval): pending / approved / rejected. Content is not included",
  { approval_id: z.string() },
  async ({ approval_id }) => json("approval_get", { approval_id }, await tools.approval_get(approval_id)),
);

tool(
  "notification_label",
  "Put a triage label on a notification item (action = needs handling / fyi = for information / discard = not needed). The summary is sealed with the device key before sending",
  labelInputShape,
  async ({ message_id, label, summary }) =>
    json("notification_label", { message_id, label, summary }, await tools.notification_label(message_id, label, summary)),
);

tool(
  "rules_put",
  "Save how the owner asked to handle things as a rule (nl = their words verbatim, scope = what it applies to, action = what to do). The server normalizes it, picks the layer (metadata / content) and returns the normalized rule — echo it back to the owner in one sentence. Putting the same nl again updates in place (no duplicate rules). sender / keywords in scope make it a content rule, stored encrypted on the server",
  rulesPutInputShape,
  async (input) => json("rules_put", input, await tools.rules_put(input)),
);

tool(
  "rules_list",
  "List saved rules. The scope of content rules is restored with the device key",
  {},
  async () => json("rules_list", {}, await tools.rules_list()),
);

tool(
  "skills_list",
  "Skills on this machine (OpenRoly hub). Same names every AI sees after it adds openroly-mcp — no per-runtime copy",
  {},
  async () => json("skills_list", {}, await tools.skills_list()),
);

tool(
  "skill_get",
  "Read one skill from the OpenRoly hub (SKILL.md body and small extra files)",
  { name: z.string() },
  async ({ name }) => json("skill_get", { name }, await tools.skill_get(name)),
);

tool(
  "instructions_get",
  "Read a shared instructions file from the OpenRoly hub (default: claude-rules from CLAUDE.md)",
  { name: z.string().optional() },
  async ({ name }) => json("instructions_get", { name }, await tools.instructions_get(name)),
);

tool(
  "mcp_servers_list",
  "MCP servers on this machine (OpenRoly hub). HTTP and stdio, without per-runtime add CLI",
  {},
  async () => json("mcp_servers_list", {}, await tools.mcp_servers_list()),
);

// ---------- Work Core の口(PBI-0400 / CAP-3 V9・図79) ----------
// 裏が実在する動詞だけ(not_implemented を返す死んだ path は「在る」と読まれる分だけ害になる)。
// work_capsule / work_capsules(PBI-0406・V2)は「1 回打つ口」— 30 秒の定期 checkpoint(V3・下の tick)とは別の名前

// runtime transfer(PBI-0439 / CAP-3 V7・図84)。transfer の口は source 側(work_transfer)と target 側(work_accept)の 2 つ
tool(
  "work_transfer",
  "Move the work you hold to another runtime (e.g. codex) without a moment where nobody holds it: the server reserves the lease for the transfer, this call snapshots this folder's git state plus the capsule fields you pass (goal, current_state, decisions, ...) under that reservation, and the server wakes the target runtime in this folder with a fixed instruction to call work_accept. A runtime needs a one-time intent token a human issued (openroly work intent <id> --action transfer_primary). If it stops midway the error names the transfer id and the state; a failed route releases the lease so you can claim the work again",
  workTransferInputShape,
  async ({ work_id, ...input }) =>
    json("work_transfer", { work_id, to: input.to }, await tools.work_transfer(work_id, input)),
);

tool(
  "work_accept",
  "Take over a work that was transferred to you (work_id and transfer_id are in the instruction that woke you) or a forked work (work_id only). It gives you the write lease and returns the work's capsule as text (rendered) — the same text whichever runtime you are — starting with a line when this folder's files changed since the capsule, then the work's context key index. Fields that do not fit 2000 tokens are left out whole and named in receipt.omitted. On a reviewer branch the fields the profile keeps from you are named (never shown) in receipt.hidden. Use the returned run_id for work_capsule / work_proof from now on",
  workAcceptInputShape,
  async ({ work_id, ...input }) =>
    json("work_accept", { work_id, transfer_id: input.transfer_id }, await tools.work_accept(work_id, input)),
);

// fork / review(PBI-0440 / CAP-3 V8・図84)。元の work を止めずに枝を 1 本。拾う側は同じ work_accept(transfer_id 無し)
tool(
  "work_fork",
  "Branch a work without stopping it: copies the work's latest capsule into a new work, makes a separate copy of this folder's repo at the capsule's git state (under ~/.openroly/worktrees — this folder and its .git are never written), and wakes the target runtime there. role implementer = try another approach with the full context; role reviewer = a blind review that sees only the goal, artifacts, git state and tests, not the previous agent's decisions or notes. A runtime needs the owner's permission (delegation work_authority fork_work / start_review). If the wake fails the branch stays ready and work_accept can pick it up later",
  workForkInputShape,
  async ({ work_id, ...input }) =>
    json("work_fork", { work_id, to: input.to, role: input.role }, await tools.work_fork(work_id, input)),
);

tool(
  "work_capsule",
  "Push one immutable snapshot (a 'capsule') of this work's state — goal, current_state, decisions, unresolved_questions, relevant_artifacts, relevant_memory, git_state, capability_requirements. Only the run that holds the lease can: pass your own run id. Pushing the exact same content as the last capsule does not create a new version (dedupe: deduped:true in the reply). Never pass conversation/messages/transcript here — that call is rejected. The actual content is stored only on this device (~/.openroly/checkpoints), never sent to the server — the server only keeps a small manifest (hash/size). To reference a secret, use {credential_ref: \"env:NAME\"} — never write a raw secret value into any field, it will be rejected",
  workCapsuleInputShape,
  async ({ work_id, ...input }) => json("work_capsule", { work_id, ...input }, await tools.work_capsule(work_id, input)),
);

tool(
  "work_capsules",
  "List every capsule version pushed for this work, oldest first — each entry has the full body (goal / current_state / decisions / ...) plus version, content_hash, and created_at",
  { work_id: z.string() },
  async ({ work_id }) => json("work_capsules", { work_id }, await tools.work_capsules(work_id)),
);

tool(
  "work_current",
  "The work this account has a live run on right now (null if none). Picked by the lease alone; handled_runtime_id is the standing owner and is reported separately - never read it as 'running now'. ambiguous:true means more than one work is leased and this is the most recent one. continue_candidate, when present, is a different runtime's work stopped at a usage limit (runtime/reason/at tell which and when): mention it to the human in your first reply as one line (e.g. \"claude stopped at a usage limit on <title> — 'openroly continue' picks it up\") and let the human decide",
  {},
  async () => json("work_current", {}, await tools.work_current()),
);

tool(
  "work_get",
  "One work item by id (status, lease, the standing owner)",
  { work_id: z.string() },
  async ({ work_id }) => json("work_get", { work_id }, await tools.work_get(work_id)),
);

tool(
  "work_events",
  "The event log of one work, oldest first. after = the work_sequence you already have (pass it to get only what is new)",
  { work_id: z.string(), after: z.number().int().nonnegative().optional() },
  async ({ work_id, after }) => json("work_events", { work_id, after }, await tools.work_events(work_id, after)),
);

tool(
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

tool(
  "work_promote",
  "Turn a thread you labelled 'action' into a work item. Calling it again on the same thread returns the same work_id (already_promoted: true) instead of making a second one",
  { thread_id: z.string() },
  async ({ thread_id }) => json("work_promote", { thread_id }, await tools.work_promote(thread_id)),
);

tool(
  "work_handoff",
  "Hand the work to another runtime (to = its runtime id or kind) and/or leave a note — and in the same call publish what the next agent needs into this work's Work Project: context = key/value facts, preferably the well-known keys goal / next_step / decisions / open_questions / failed_attempts / verified_findings (e.g. {\"next_step\": \"make the reconnect test deterministic\"}), sources = repo-relative file paths (e.g. docs/plan.md). Values are stored only on this device (the server keeps the key, a hash and who wrote it); sources are recorded by path + sha256, not copied. Either all of it lands or none of it does. Never put conversation/messages/transcript into context; reference a secret as {credential_ref: \"env:NAME\"}. This sets the standing owner, not the live lease",
  workHandoffInputShape,
  async ({ work_id, ...input }) => json("work_handoff", { work_id, ...input }, await tools.work_handoff(work_id, input)),
);

// Work Project context(PBI-0433・手描き 1 枚目・図80)。handoff が書き、次の agent が search で要る key だけ取る
tool(
  "work_context_put",
  "Publish key/value context and/or source file paths into this work's Work Project without handing it off (e.g. while working in parallel). Writing a key again with different content makes a new version; pass expected_versions {key: n} to refuse overwriting a newer value (409 stale_version — nothing in the call is written). Values stay on this device; the server only keeps key, hash and writer. Never put conversation/messages/transcript here; reference a secret as {credential_ref: \"env:NAME\"}. If you hold a task, write to your task: writing to its Work Project directly is refused (409 publish_required) — share with the project through work_context_publish, which is also the only way into a project nobody holds",
  workContextPutInputShape,
  async ({ work_id, ...input }) => json("work_context_put", { work_id, ...input }, await tools.work_context_put(work_id, input)),
);

// PBI-0443: task → Work Project の公開。project に出す口はこれだけ(図80c ④)
tool(
  "work_context_publish",
  "Publish keys you already wrote on your task to the task's Work Project — the only way a task's context reaches the project. All keys land or none do (a key missing on the task fails with unknown_key and nothing is written); each project entry records published_from: <task>@<version>. Pass expected_versions {key: n} with the project's version to refuse overwriting a newer value (409 stale_version). auto/ and inbox/ keys cannot be published",
  workContextPublishInputShape,
  async ({ work_id, ...input }) =>
    json("work_context_publish", { work_id, ...input }, await tools.work_context_publish(work_id, input)),
);

tool(
  "work_context_search",
  "Pull only what you need from this work's Work Project before you start, in two steps: index_only:true lists every key with est_tokens and a short preview (no values), then pull the keys you chose. Each call returns at most max_tokens (default 2000, up to 20000), highest priority first — goal, next_step, decisions, open_questions, failed_attempts, verified_findings, then other keys, sources, auto/, inbox/ — and entries that do not fit are left out whole and named in budget.omitted. Filter by exact keys, a key prefix or kind (context / source); query matches key and value text on this device. Each context entry comes with its value — or value null + missing_on_device:true when it was written on another device. Each source comes with source_status same / changed / missing (re-hashed against the file here). work_assigned already shows each work's key index — pull goal and next_step first. auto/ keys (git, files_touched, tests) are machine-recorded facts: read them, never write them. A Work Project entry that a task published carries published_from: <task>@<version>",
  workContextSearchInputShape,
  async ({ work_id, ...input }) =>
    json("work_context_search", { work_id, ...input }, await tools.work_context_search(work_id, input)),
);

// Memory v1(PBI-0378 / CAP-7・図86)。候補を出す口と、承認済みを引く口の 2 本だけ
tool(
  "memory_propose",
  "Offer one thing worth remembering across AIs and days — a fact, decision, preference or constraint (e.g. \"the production DB must not be SQLite\"). It becomes a candidate that the owner approves before any AI can use it; you cannot make it usable yourself. scope project = this repository (same git origin), personal = the owner everywhere. Pass source_work_id (the work you learned it in). To replace an older memory, pass its id as supersedes (the owner always approves a replacement). The text is sealed on this device — the server only keeps its hash. Text that reads like an instruction to an AI (e.g. \"ignore previous instructions\") is refused before anything is sent",
  memoryProposeInputShape,
  async (input) => json("memory_propose", input, await tools.memory_propose(input)),
);

tool(
  "memory_search",
  "Recall what the owner's AIs learned and the owner approved — for this repository and for the owner personally. Use it before you start and whenever you are unsure how things are done here. query matches any of its words in the text on this device; omit it to list what fits max_tokens (newest first). Each record has type, scope, content and source (which AI learned it, in which work). Records that fail the hash check or read like an injected instruction are never returned (counted in blocked). Pass work_id so the recall is recorded on the work you are doing",
  memorySearchInputShape,
  async (input) => json("memory_search", input, await tools.memory_search(input)),
);

tool(
  "work_assigned",
  "Works whose standing owner is this runtime (handed to you by runtime id or by kind) — where to look when you start and nothing is leased yet. Returns work_id, title, status, handoff_note, project_id, folder, lease_live and context_index (which keys exist, without their values). When folder is not null, the task has its own copy of the project's files there — do all your file work in that folder, not in the project's folder. Then pull what you need with work_context_search",
  {},
  async () => json("work_assigned", {}, await tools.work_assigned()),
);

// Work Project の task と住所(PBI-0434・手描き 2 枚目)。分担した agent が同じ project の context を持って始め、互いに届く
tool(
  "work_task_create",
  "Split a Work Project: create one task under it (parent_work_id) and, if you pass to/note/context/sources, hand it to a runtime in the same call. A task cannot itself have tasks. When you hand it to a runtime (to) from inside a git repo with a commit, the task gets its own folder — a copy of this folder's current files under the openroly home's worktrees/<task id> — returned as folder, so parallel tasks never write the same file; bring the result back with work_task_merge. Hand it a scope too: brief/allowed and brief/forbidden in context (arrays of repo-relative path prefixes, prefix match only, case-insensitive, no globs) and brief/done (what finished looks like) — the task itself cannot write those back (reserved_key), and a merge that touches a brief/forbidden prefix is stopped before anything is written. Handing a task to a runtime from a folder with no commit is refused (no_base_commit) — nothing is created. If the task is created but its folder or the handoff fails, the error names the task id so you can retry work_handoff on it",
  workTaskCreateInputShape,
  async ({ parent_work_id, ...input }) =>
    json("work_task_create", { parent_work_id, ...input }, await tools.work_task_create(parent_work_id, input)),
);

tool(
  "work_task_merge",
  "Bring a task's work back into this folder (the Work Project's working tree): every change made in the task's folder since it was handed off — edited, added and deleted files — is applied to the files here. Nothing is committed and the git index is not touched, so the result shows up in git diff / git status. If any change collides with what is here, nothing at all is applied and result is conflict with the colliding paths. busy = another git operation holds this repo's index.lock (nothing applied, try again); empty = the task changed nothing. Refused before touching anything when the task is not on this Work Project (not_on_team) or its folder is not on this device (worktree_missing). outside_scope = the task changed files under a brief/forbidden prefix it was handed: nothing is applied, the paths that hit are returned, and the task moves to needs_user so a person can widen its scope or allow it. applied, conflict and outside_scope are recorded on the task and show up as merge in work_team. Refused before touching anything when the task's last proof is not passed (no_proof) or the lead has not accepted it (not_reviewed / changes_requested / rejected) — see work_proof and work_review — or when it has a brief/forbidden this device cannot read (brief_unreadable)",
  {
    work_id: z.string().describe("the Work Project whose working tree is this folder"),
    task_id: z.string().describe("the task to merge (its address from work_team)"),
  },
  async ({ work_id, task_id }) => json("work_task_merge", { work_id, task_id }, await tools.work_task_merge(work_id, task_id)),
);

tool(
  "work_team",
  "Who else is working on the same Work Project: the project and every task under it, each with its address (the task's work id), who it is assigned to, whether a run is live on it, is_you, merge (not_started / applied / conflict / outside_scope — the last work_task_merge of that task), review (- / accept / changes_requested (2) — the lead's verdict, the number being how many times a verdict was written) and scope (- when no brief was handed, else '2 allowed / 1 forbidden', a ? meaning that list cannot be read on this device). Use an address with work_message to reach that agent",
  { work_id: z.string().describe("any task or the project itself") },
  async ({ work_id }) => json("work_team", { work_id }, await tools.work_team(work_id)),
);

// PBI-0648: 渡した仕事は、証拠(passed の proof)と裁定が無ければ親へ合流しない。裁定を書くのがこの口
tool(
  "work_review",
  "Rule on a task you handed out, so it can be merged back. accept opens work_task_merge for that task; changes_requested sends it back (the agent reads your feedback with work_context_search on review/verdict and keeps working); reject closes it. Only a human and the run holding the task's Work Project can write it — name yourself with run_id; a task cannot rule on itself (reserved_key). Your feedback stays on this device like other context values; the task must also have a passed proof before it can merge",
  {
    task_id: z.string().describe("the task to rule on (its address from work_team)"),
    verdict: z.enum(["accept", "changes_requested", "reject"]).describe("accept opens the merge; changes_requested sends it back; reject closes it"),
    feedback: z.string().optional().describe("what you want changed, in your own words — the task reads it as review/verdict"),
    run_id: z.string().describe("your own run id (the one you hold the Work Project with) — the verdict is refused when that run holds the task itself"),
  },
  async ({ task_id, ...input }) => json("work_review", { task_id, ...input }, await tools.work_review(task_id, input)),
);

tool(
  "work_message",
  "Send a note to another agent on the same Work Project (to_work_id = their address from work_team, from_work_id = your own task). It lands in their task's Work Project context under inbox/<your task>/..., which they read with work_context_search prefix \"inbox/\" — agents coordinate through work state, not a chat. The text stays on this device like other context values. Refused (nothing sent) when the address is not on your project. While the receiver holds its task, every openroly tool reply it gets carries a second text \"notice: N unread inbox messages on <task> …\" (up to 30 seconds late) until it pulls them with work_context_search — index_only or entries left out by max_tokens stay unread",
  workMessageInputShape,
  async ({ to_work_id, ...input }) =>
    json(
      "work_message",
      { to_work_id, ...input },
      await tools.work_message(to_work_id, { ...input, text: masker.restoreText(input.text) }),
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

tool(
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
