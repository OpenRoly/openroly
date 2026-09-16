// PBI-0378 / CAP-7(鎖の順 9 Memory v1・図86): AI が覚えた事 1 行(MemoryRecord)の形と、平文を持つ端末の判定。
//
// server は本文を持たない(E2EE)。だから **注入検査と中身の照合はここ 1 file** に置き、平文を持つ 3 か所
// (出す MCP `memory_propose`・承認する web card・引く MCP `memory_search`)が同じ関数を呼ぶ。
// server が見るのは scope / scope_key(hash)/ type / fingerprint だけで、値集合は migration 063 と
// scripts/value-sets-check.ts が突き合わせる。
// **node builtin を import しない**(web の bundle に入る。hash は WebCrypto で取る = Bun と browser の両方に在る)。

export const MEMORY_SCOPES = ["personal", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_TYPES = ["fact", "decision", "preference", "constraint"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_STATUSES = ["candidate", "active", "rejected", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 1 行に書ける本文の上限(文字数)。記憶は小さい事実 —— 長い物は Work context か skill の持ち分 */
export const MEMORY_CONTENT_MAX_CHARS = 2_000;

/** seal して預ける平文そのもの。fingerprint はこの 4 つの stable JSON の sha256 */
export interface MemoryPayload {
  scope: MemoryScope;
  scope_key: string | null;
  type: MemoryType;
  content: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** 空白の違いで別の記憶にしない(AC-3)。NFC + 連続空白(改行含む)を 1 つ + 前後を落とす */
export function canonicalMemoryContent(content: string): string {
  return content.normalize("NFC").replace(/\s+/g, " ").trim();
}

export type MemoryInputReason =
  | "invalid_scope"
  | "invalid_type"
  | "invalid_scope_key"
  | "empty_content"
  | "content_too_long";

/** 形の壁(AC-X7)。通った物は canonical 済みの payload になる */
export function validateMemoryInput(
  input: { scope?: unknown; scope_key?: unknown; type?: unknown; content?: unknown },
): { ok: true; payload: MemoryPayload } | { ok: false; reason: MemoryInputReason } {
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(input.scope)) return { ok: false, reason: "invalid_scope" };
  if (!(MEMORY_TYPES as readonly unknown[]).includes(input.type)) return { ok: false, reason: "invalid_type" };
  const scope = input.scope as MemoryScope;
  const key = input.scope_key ?? null;
  if (scope === "personal" ? key !== null : typeof key !== "string" || !HASH_RE.test(key)) {
    return { ok: false, reason: "invalid_scope_key" };
  }
  if (typeof input.content !== "string") return { ok: false, reason: "empty_content" };
  const content = canonicalMemoryContent(input.content);
  if (content === "") return { ok: false, reason: "empty_content" };
  if ([...content].length > MEMORY_CONTENT_MAX_CHARS) return { ok: false, reason: "content_too_long" };
  return { ok: true, payload: { scope, scope_key: key as string | null, type: input.type as MemoryType, content } };
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** payload を平文の bytes にする(key の順を固定 = 同じ中身 → 同じ bytes → 同じ hash) */
export function memoryPayloadBytes(p: MemoryPayload): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({ content: p.content, scope: p.scope, scope_key: p.scope_key, type: p.type }),
  );
}

/** 重複の判定(memory_records の unique)と封筒の置き場(work_context_sealed の content_hash)を兼ねる 1 つの hash */
export async function memoryFingerprint(p: MemoryPayload): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", memoryPayloadBytes(p)));
}

/** git の origin を host/path に揃える(`git@github.com:acme/foo.git` と `https://github.com/acme/foo` を同じ project にする) */
export function normalizeGitRemote(url: string): string {
  let s = url.trim();
  const scp = s.match(/^[^@/\s]+@([^:/\s]+):(.+)$/); // git@host:path
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  const slash = s.indexOf("/");
  const host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase().replace(/:\d+$/, "");
  const path = slash < 0 ? "" : s.slice(slash);
  return `${host}${path}`.replace(/\.git$/, "").replace(/\/+$/, "");
}

/** project の scope_key。server には repo の名前ではなくこの hash だけが行く */
export async function memoryScopeKey(projectId: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(projectId)));
}

// ---------- 注入検査(Hermes の port) ----------
// 取得元: https://github.com/NousResearch/hermes-agent/blob/e83816a4d1998245968949e88fa15f26d89800c0/tools/cronjob_prompt_scan.py
//         (`_CRON_THREAT_PATTERNS` / `_CRON_EXFIL_COMMAND_PATTERNS` / `_zwj_has_emoji_neighbour`)と
//         同 repo の tools/threat_patterns.py の `INVISIBLE_CHARS`(NFKC で全角を畳むのも同 file の scan_for_threats)。
// 2026-09-15 取得・MIT(Copyright (c) 2025 Nous Research)・THIRD_PARTY_NOTICES.md「Hermes Agent」節。
// 写さなかった物: `_strip_cron_safe_constructs`(Hermes 同梱の GitHub skill の curl を通す例外。記憶の本文には要らない)。
// Python の `\w` は Unicode なので `[\p{L}\p{N}_]`(u flag)に置き換えた —— JS の `\w` は ASCII だけで、
// 「ignore 以前の all instructions」の間の語を跨げない。

const W = "[\\p{L}\\p{N}_]";
const SECRET_VAR = "\\$\\{?[\\p{L}\\p{N}_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)[\\p{L}\\p{N}_]*\\}?";
const MEMORY_THREAT_PATTERNS: readonly (readonly [string, string])[] = [
  [`ignore\\s+(?:${W}+\\s+)*(?:previous|all|above|prior)\\s+(?:${W}+\\s+)*instructions`, "prompt_injection"],
  ["do\\s+not\\s+tell\\s+the\\s+user", "deception_hide"],
  ["system\\s+prompt\\s+override", "sys_prompt_override"],
  ["disregard\\s+(your|all|any)\\s+(instructions|rules|guidelines)", "disregard_rules"],
  ["cat\\s+[^\\n]*(\\.env|credentials|\\.netrc|\\.pgpass|id_rsa|id_ed25519|id_ecdsa)", "read_secrets"],
  ["authorized_keys", "ssh_backdoor"],
  ["/etc/sudoers|visudo", "sudoers_mod"],
  ["rm\\s+-rf\\s+/", "destructive_root_rm"],
  [`curl\\s+[^\\n]*https?://[^\\s"'\`]*${SECRET_VAR}`, "exfil_curl_url"],
  [`wget\\s+[^\\n]*https?://[^\\s"'\`]*${SECRET_VAR}`, "exfil_wget_url"],
  [`curl\\s+[^\\n]*(?:--data(?:-raw|-binary|-urlencode)?|-d|--form|-F)\\s+[^\\n]*${SECRET_VAR}`, "exfil_curl_data"],
  [`wget\\s+[^\\n]*--post-(?:data|file)=[^\\n]*${SECRET_VAR}`, "exfil_wget_post"],
  [`curl\\s+[^\\n]*(?:-H|--header)\\s+["']Authorization:\\s*(?:Bearer|token)\\s+${SECRET_VAR}["']`, "exfil_curl_auth_header"],
];
const COMPILED = MEMORY_THREAT_PATTERNS.map(([p, id]) => [new RegExp(p, "iu"), id] as const);

/** zero-width space / non-joiner / joiner・word joiner・invisible times/separator/plus・BOM・方向制御 12 種 */
const INVISIBLE_CHARS = new Set([..."​‌‍⁠⁢⁣⁤﻿‪‫‬‭‮⁦⁧⁨⁩"]);
const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f000, 0x1ffff], [0x2600, 0x27bf], [0x2300, 0x23ff], [0x1f1e6, 0x1f1ff], [0x20e3, 0x20e3],
];

/** ZWJ が絵文字の間に居るか(👨‍👩‍👧 は通す)。VS16 は飛ばす */
function zwjBetweenEmoji(cps: readonly string[], i: number): boolean {
  const isEmoji = (ch: string) => EMOJI_RANGES.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi);
  let l = i - 1;
  while (l >= 0 && cps[l] === "️") l -= 1;
  let r = i + 1;
  while (r < cps.length && cps[r] === "️") r += 1;
  return l >= 0 && r < cps.length && isEmoji(cps[l]!) && isEmoji(cps[r]!);
}

export type MemoryScanResult = { ok: true } | { ok: false; reason: string };

/** 本文が命令の顔をした注入か。block は理由(pattern id / `invisible_unicode`)だけを返し、本文は返さない */
export function scanMemoryContent(content: string): MemoryScanResult {
  const cps = [...content];
  for (let i = 0; i < cps.length; i++) {
    if (INVISIBLE_CHARS.has(cps[i]!) && !(cps[i] === "‍" && zwjBetweenEmoji(cps, i))) {
      return { ok: false, reason: "invisible_unicode" };
    }
  }
  const normalized = content.normalize("NFKC");
  for (const [re, id] of COMPILED) if (re.test(normalized)) return { ok: false, reason: id };
  return { ok: true };
}

export type OpenedMemoryReview =
  | { ok: true; payload: MemoryPayload }
  | { ok: false; reason: "does_not_match" | string };

/**
 * 開けた平文を使ってよいか(card と memory_search が呼ぶ 1 関数)。**開けた事は中身の証明にならない**
 * (server は account の公開鍵を持つので別の中身を seal し直せる)ので、hash を計算し直して行と照合し、
 * 行の scope / scope_key / type とも照合してから注入検査を掛ける
 */
export async function reviewOpenedMemory(
  row: { fingerprint: string; scope: string; scope_key: string | null; type: string },
  plaintext: Uint8Array,
): Promise<OpenedMemoryReview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return { ok: false, reason: "does_not_match" };
  }
  const p = (parsed ?? {}) as Record<string, unknown>;
  const checked = validateMemoryInput(p);
  if (!checked.ok || checked.payload.content !== p.content) return { ok: false, reason: "does_not_match" };
  const payload = checked.payload;
  if (
    (await memoryFingerprint(payload)) !== row.fingerprint ||
    payload.scope !== row.scope ||
    payload.scope_key !== row.scope_key ||
    payload.type !== row.type
  ) {
    return { ok: false, reason: "does_not_match" };
  }
  const scan = scanMemoryContent(payload.content);
  return scan.ok ? { ok: true, payload } : { ok: false, reason: scan.reason };
}
