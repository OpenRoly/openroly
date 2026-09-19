// PBI-0436: agent が書けない時にも Work Project context を埋める「agent の外の書き手」。
//
// 30 秒 tick(checkpoint.ts)は runtime とは別の OS process で、rate limit 中も動き続ける。ここは
// その tick が呼ぶ判定本体で、**device 側の事実だけ**を 3 つの key にする:
//   auto/git            branch / HEAD / 変更中の path(git)
//   auto/files_touched  agent が Edit / Write した path(Claude Code の transcript の tool_use)
//   auto/tests          テストらしき command と成否(transcript の Bash tool_use + tool_result.is_error)
// **LLM を使わない。会話の本文を読まない** —— transcript から触るのは tool_use の `input.file_path` /
// `input.command` と、tool_result の `is_error` / `tool_use_id` だけ。user / assistant の text、
// tool_result の content、Edit の old/new string、Write の content は値として一切拾わない
// (Capsule の「会話を Work state に入れない」C4 #13 と同じ線)。
// PBI-0445: runtime が Codex(`OPENROLY_RUNTIME_KIND=codex`)の時は transcript の代わりに Codex の rollout から
// 同じ 2 key を埋める。線は同じ —— patch の header 行の path・exec_command の cmd・終了コードだけを見る。
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parsePorcelainZ } from "@openroly/core/node";
import type { AccountTools } from "./tools.ts";

export const AUTO_KEYS = {
  git: "auto/git",
  filesTouched: "auto/files_touched",
  tests: "auto/tests",
} as const;

export const AUTO_FILES_MAX = 50;
export const AUTO_TESTS_MAX = 10;
export const AUTO_DIRTY_MAX = 50;
/** 同じ folder の変更がこれを超えたら 1 行に畳む(PBI-0775) */
export const AUTO_DIRTY_DIR_COLLAPSE = 3;
/** command の文字列は 200 字で切る(秘密が混じる余地を狭める。値は端末の CAS にしか置かれない) */
export const AUTO_COMMAND_MAX = 200;
/** session を env で特定できない時、「直近に更新された transcript が 1 つだけ」を見る窓 */
export const TRANSCRIPT_RECENT_MS = 10 * 60 * 1000;

/** 字面でテストと分かる command だけ(出力は読まないので、成否は is_error だけで決める) */
const TEST_COMMAND_RE =
  /(^|[\s;&|(])(bun (run )?test|npm (run )?test|pnpm (run )?test|yarn test|pytest|python -m pytest|cargo test|go test|vitest|jest|mix test|rspec)(\s|$)/;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

type Env = Record<string, string | undefined>;

/** Claude Code が transcript を置く dir(cwd の英数字以外を `-` に置き換えた名前) */
export function claudeProjectDir(cwd: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

export type TranscriptPick =
  | { path: string; by: "session_env" | "only_recent" }
  | { path: null; reason: "no_transcript_dir" | "no_transcript" | "ambiguous_transcript" };

/**
 * どの transcript がこの session の物か。**推測しない**:
 *  1. `CLAUDE_CODE_SESSION_ID`(Claude Code が子 process に渡す env)が在れば `<id>.jsonl` そのもの
 *  2. 無ければ、直近 10 分に更新された transcript が **ちょうど 1 つ** の時だけ採る
 *     (2 つ以上 = 同じ repo で並列 session が動いている。取り違えるくらいなら書かない)
 */
export function pickTranscript(cwd: string, opts: { env?: Env; home?: string; now?: number } = {}): TranscriptPick {
  const dir = claudeProjectDir(cwd, opts.home);
  if (!existsSync(dir)) return { path: null, reason: "no_transcript_dir" };
  const sid = (opts.env ?? process.env).CLAUDE_CODE_SESSION_ID;
  if (sid && /^[A-Za-z0-9-]{1,100}$/.test(sid)) {
    const path = join(dir, `${sid}.jsonl`);
    return existsSync(path) ? { path, by: "session_env" } : { path: null, reason: "no_transcript" };
  }
  const now = opts.now ?? Date.now();
  const recent = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .filter((p) => now - statSync(p).mtimeMs <= TRANSCRIPT_RECENT_MS);
  if (recent.length === 0) return { path: null, reason: "no_transcript" };
  if (recent.length > 1) return { path: null, reason: "ambiguous_transcript" };
  return { path: recent[0] as string, by: "only_recent" };
}

export interface FileTouched {
  path: string;
  tool: string;
  at: string | null;
}

export interface TestRun {
  command: string;
  /** true = 成功 / false = 失敗(is_error)/ null = 結果がまだ無い(実行中に止まった等) */
  ok: boolean | null;
  at: string | null;
}

/** cwd の中の path なら cwd 相対にして返す。外(`..`・別の絶対 path)は null */
function insideCwd(cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * transcript(JSONL)から事実だけを取り出す。**cwd が一致しない行は数えない**(同じ dir に別の worktree の
 * session が混ざる事がある)。新しい順に上限まで。`cwd_rows` = cwd が一致した行数(0 = この transcript は
 * この cwd の session の物では無い。Claude Code は全行に cwd を書くので、0 行なら採ってはいけない)。
 */
export function readTranscriptFacts(
  text: string,
  cwd: string,
): { files_touched: FileTouched[]; tests: TestRun[]; cwd_rows: number } {
  const files = new Map<string, FileTouched>(); // path → 最新(delete + set で末尾に回す)
  const pending = new Map<string, { command: string; at: string | null }>(); // tool_use_id → テスト command
  const tests: TestRun[] = [];
  let cwdRows = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 書きかけの末尾行など
    }
    if (row?.cwd !== cwd) continue;
    cwdRows++;
    const at = typeof row.timestamp === "string" ? row.timestamp : null;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use") {
        const input = part.input ?? {};
        if (FILE_TOOLS.has(part.name) && typeof input.file_path === "string") {
          const rel = insideCwd(cwd, input.file_path);
          if (rel) {
            files.delete(rel);
            files.set(rel, { path: rel, tool: part.name, at });
          }
        } else if (part.name === "Bash" && typeof input.command === "string" && typeof part.id === "string") {
          if (TEST_COMMAND_RE.test(input.command)) {
            pending.set(part.id, { command: input.command.slice(0, AUTO_COMMAND_MAX), at });
          }
        }
      } else if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
        const run = pending.get(part.tool_use_id);
        if (run) {
          tests.push({ command: run.command, ok: part.is_error !== true, at: run.at });
          pending.delete(part.tool_use_id);
        }
      }
    }
  }
  // 結果が返らないまま止まったテスト(429 で途切れた等)も「走らせた」事実として残す
  for (const run of pending.values()) tests.push({ command: run.command, ok: null, at: run.at });
  tests.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return {
    files_touched: [...files.values()].reverse().slice(0, AUTO_FILES_MAX),
    tests: tests.slice(0, AUTO_TESTS_MAX),
    cwd_rows: cwdRows,
  };
}

/** rollout の 1 行目(session_meta)を読む上限。base_instructions を含むので数十 KB になる(実測で最大 22 KB) */
const ROLLOUT_META_MAX_BYTES = 256 * 1024;

// Codex の apply_patch の header の綴り。openai/codex@1715e55 の値の写し:
// codex-rs/apply-patch/src/parser.rs(ADD_FILE / DELETE_FILE / UPDATE_FILE / MOVE_TO / ENVIRONMENT_ID_MARKER)と
// streaming_parser.rs(Add / Delete / Update は `line.trim()` に、Move to は `line.trim_end()` に strip_prefix)
const APPLY_PATCH_HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;
const APPLY_PATCH_MOVE_TO = "*** Move to: ";
/** 別の実行環境に当てる patch。この端末の cwd の file ではないので 1 行も数えない */
const APPLY_PATCH_ENVIRONMENT = "*** Environment ID:";

/** Codex が rollout を置く dir。Codex は MCP の子に HOME 等の既定の env しか渡さないので、普段は ~/.codex */
export function codexSessionsDir(env: Env, home: string = homedir()): string {
  return join(env.CODEX_HOME || join(home, ".codex"), "sessions");
}

export type RolloutPick =
  | { path: string; by: "only_recent_rollout" }
  | { path: null; reason: "no_rollout_dir" | "no_rollout" | "ambiguous_rollout" };

/** rollout の 1 行目(session_meta)の cwd。書きかけ・形が違う時は null(= この cwd の物と数えない) */
function rolloutSessionCwd(path: string): string | null {
  const buf = Buffer.alloc(ROLLOUT_META_MAX_BYTES);
  const fd = openSync(path, "r");
  let text: string;
  try {
    text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const nl = text.indexOf("\n");
  try {
    const row = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    return row?.type === "session_meta" && typeof row.payload?.cwd === "string" ? row.payload.cwd : null;
  } catch {
    return null;
  }
}

/**
 * どの rollout がこの session の物か。Codex は session を特定する env を MCP に渡さない(上流の rmcp-client は
 * DEFAULT_ENV_VARS だけを通す)ので、**`session_meta.cwd` がこの cwd で、直近 10 分に更新された rollout が
 * ちょうど 1 つ** の時だけ採る。cwd の違う rollout は数えない。2 つ以上 = 同じ repo で並列の session(書かない)。
 */
export function pickRollout(cwd: string, opts: { env?: Env; home?: string; now?: number } = {}): RolloutPick {
  const dir = codexSessionsDir(opts.env ?? process.env, opts.home);
  if (!existsSync(dir)) return { path: null, reason: "no_rollout_dir" };
  const now = opts.now ?? Date.now();
  // ponytail: 全 rollout を毎 tick stat する(実測 151 本で数 ms)。数万本になったら mtime の索引を持つ
  //(resume は開始日の dir の file に追記するので、日付 dir で打ち切る近道は取れない)
  const mine = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /^rollout-.*\.jsonl$/.test(basename(f)))
    .map((f) => join(dir, f))
    .filter((p) => now - statSync(p).mtimeMs <= TRANSCRIPT_RECENT_MS && rolloutSessionCwd(p) === cwd);
  if (mine.length === 0) return { path: null, reason: "no_rollout" };
  if (mine.length > 1) return { path: null, reason: "ambiguous_rollout" };
  return { path: mine[0] as string, by: "only_recent_rollout" };
}

/** patch の header 行の path だけ。中身の行(` ` / `+` / `-` / `@@` で始まる)は判定して捨てる */
function applyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(APPLY_PATCH_ENVIRONMENT)) return [];
    const header = APPLY_PATCH_HEADERS.find((h) => trimmed.startsWith(h));
    if (header) paths.push(trimmed.slice(header.length));
    else if (line.trimEnd().startsWith(APPLY_PATCH_MOVE_TO)) paths.push(line.trimEnd().slice(APPLY_PATCH_MOVE_TO.length));
  }
  return paths;
}

/**
 * Codex の rollout(JSONL)から事実だけを取り出す。触るのは:
 *  - `session_meta` / `turn_context` の `cwd`(この cwd の turn の行だけ数える。`cwd_rows` = 一致した行数)
 *  - `custom_tool_call` の `apply_patch` の `input` のうち **header 行の path だけ**
 *  - `function_call` の `exec_command` の `arguments.cmd`(と、判定だけに使う `workdir`)
 *  - `event_msg` / `item_completed` の `CommandExecution` の `id` と `exit_code`(成否。出力は読まない)
 * message / reasoning / `*_output` の本文、patch の中身、cmd 以外の引数は値として拾わない。
 * 形は Codex の版で動く(実測 2 週間で 0.147〜0.153 の 5 版)ので版では絞らず、上の形に合わない行を数えない。
 */
export function parseCodexRollout(
  text: string,
  cwd: string,
): { files_touched: FileTouched[]; tests: TestRun[]; cwd_rows: number } {
  const files = new Map<string, FileTouched>();
  const runs = new Map<string, TestRun>(); // call_id → テスト command(成否は item_completed が来たら埋める)
  let turnCwd: string | null = null;
  let cwdRows = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 書きかけの末尾行など
    }
    const p = row?.payload;
    if (row?.type === "session_meta" || row?.type === "turn_context") {
      if (typeof p?.cwd === "string") turnCwd = p.cwd;
      if (turnCwd === cwd) cwdRows++;
      continue;
    }
    if (turnCwd !== cwd) continue;
    const at = typeof row.timestamp === "string" ? row.timestamp : null;
    if (row.type === "response_item" && p?.type === "custom_tool_call" && p.name === "apply_patch" && typeof p.input === "string") {
      for (const path of applyPatchPaths(p.input)) {
        const rel = insideCwd(cwd, path);
        if (rel) {
          files.delete(rel);
          files.set(rel, { path: rel, tool: "apply_patch", at });
        }
      }
    } else if (row.type === "response_item" && p?.type === "function_call" && p.name === "exec_command" && typeof p.call_id === "string") {
      let args: any = null;
      try {
        args = JSON.parse(p.arguments);
      } catch {
        continue;
      }
      const workdir = args?.workdir;
      const here = typeof workdir !== "string" || resolve(cwd, workdir) === cwd || insideCwd(cwd, workdir) !== null;
      if (here && typeof args?.cmd === "string" && TEST_COMMAND_RE.test(args.cmd)) {
        runs.set(p.call_id, { command: args.cmd.slice(0, AUTO_COMMAND_MAX), ok: null, at });
      }
    } else if (row.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "CommandExecution") {
      const run = runs.get(p.item.id);
      if (run && typeof p.item.exit_code === "number") run.ok = p.item.exit_code === 0;
    }
  }
  const tests = [...runs.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return {
    files_touched: [...files.values()].reverse().slice(0, AUTO_FILES_MAX),
    tests: tests.slice(0, AUTO_TESTS_MAX),
    cwd_rows: cwdRows,
  };
}

export interface GitFacts {
  branch: string | null;
  head: string | null;
  dirty: string[];
  dirty_total: number;
}

/**
 * 変更中の path を**次に入る人が読める形**に畳む(PBI-0775)。
 * 実測(dogfood F94・2026-09-19): 生成物 313 件が 1 つの folder に居る tree で、`dirty` の 50 件のうち
 * 47 件が `…/checkpoints/NNN.json` になり、context package の 2000 token 中およそ 1050 を食って
 * `auto/tests` を丸ごと押し出した。**`AUTO_DIRTY_MAX` は「件数」の上限で、読む人の予算も、
 * 47 件が同じ folder である事も見ていない。** 同じ folder が 4 件を超えたら `folder/ (N files)` の
 * 1 行にする —— 次の人に届く情報は増え、大きさは桁で落ちる。件数の上限は畳んだ後に効かせる。
 */
export function foldDirtyPaths(paths: readonly string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const cut = p.lastIndexOf("/");
    const dir = cut < 0 ? "" : p.slice(0, cut + 1);
    const group = byDir.get(dir);
    if (group) group.push(p);
    else byDir.set(dir, [p]);
  }
  const out: string[] = [];
  for (const [dir, group] of byDir) {
    if (dir !== "" && group.length > AUTO_DIRTY_DIR_COLLAPSE) out.push(`${dir} (${group.length} files)`);
    else out.push(...group);
  }
  return out.sort().slice(0, AUTO_DIRTY_MAX);
}

/** git の事実。worktree でなければ null */
export function readGitFacts(cwd: string): GitFacts | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  const paths = parsePorcelainZ(porcelain).map((e) => e.path).sort();
  return {
    branch: branch === "HEAD" ? null : branch, // detached
    head: git(["rev-parse", "HEAD"]),
    dirty: foldDirtyPaths(paths),
    dirty_total: paths.length,
  };
}

export interface AutoContextResult {
  context: Record<string, unknown>;
  /** 会話記録(transcript / rollout)を使えなかった理由(使えた時は "session_env" / "only_recent" / "only_recent_rollout") */
  transcript: string;
}

/**
 * 1 回分の自動 context。git が読めなければ何も返さない(空 object)。runtime の記録(Claude Code の transcript /
 * Codex の rollout)を決められなければ `auto/git` だけ(記録由来の 2 key を**推測で**埋めない)。掴んだ記録に 1 行も
 * cwd が一致する行が無ければ、その file はこの cwd の session の物では無いので同じく `auto/git` だけ。
 */
export function buildAutoContext(cwd: string, opts: { env?: Env; home?: string; now?: number } = {}): AutoContextResult {
  const git = readGitFacts(cwd);
  if (!git) return { context: {}, transcript: "not_a_git_worktree" };
  const context: Record<string, unknown> = { [AUTO_KEYS.git]: git };
  // mcp-config が runtime ごとに MCP の env へ書く名乗り。codex 以外(claude・名乗りの無い手動起動)は今までどおり transcript
  const codex = (opts.env ?? process.env).OPENROLY_RUNTIME_KIND === "codex";
  const pick = codex ? pickRollout(cwd, opts) : pickTranscript(cwd, opts);
  if (pick.path === null) return { context, transcript: pick.reason };
  const text = readFileSync(pick.path, "utf8");
  const facts = codex ? parseCodexRollout(text, cwd) : readTranscriptFacts(text, cwd);
  if (facts.cwd_rows === 0) return { context, transcript: "no_cwd_rows" };
  if (facts.files_touched.length > 0) context[AUTO_KEYS.filesTouched] = facts.files_touched;
  if (facts.tests.length > 0) context[AUTO_KEYS.tests] = facts.tests;
  return { context, transcript: pick.by };
}

/**
 * tick の 1 回分: 事実を組み、Work Project context(PBI-0433 の口)に置く。同じ中身なら server が版を
 * 進めない(PBI-0433 の dedupe)ので、ここで前回との差分を持たない。書く物が無ければ呼ばない。
 */
export async function runAutoContext(
  tools: AccountTools,
  workId: string,
  cwd: string,
  opts: { env?: Env; home?: string; now?: number } = {},
): Promise<{ written: string[]; transcript: string }> {
  const auto = buildAutoContext(cwd, opts);
  const keys = Object.keys(auto.context);
  if (keys.length === 0) return { written: [], transcript: auto.transcript };
  await tools.work_context_put(workId, { context: auto.context }, { allowReserved: true });
  return { written: keys, transcript: auto.transcript };
}

