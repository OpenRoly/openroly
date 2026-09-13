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
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parsePorcelainZ } from "./git-state.ts";
import type { AccountTools } from "./tools.ts";

export const AUTO_KEYS = {
  git: "auto/git",
  filesTouched: "auto/files_touched",
  tests: "auto/tests",
} as const;

export const AUTO_FILES_MAX = 50;
export const AUTO_TESTS_MAX = 10;
export const AUTO_DIRTY_MAX = 50;
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

export interface GitFacts {
  branch: string | null;
  head: string | null;
  dirty: string[];
  dirty_total: number;
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
    dirty: paths.slice(0, AUTO_DIRTY_MAX),
    dirty_total: paths.length,
  };
}

export interface AutoContextResult {
  context: Record<string, unknown>;
  /** transcript を使えなかった理由(使えた時は "session_env" / "only_recent") */
  transcript: string;
}

/**
 * 1 回分の自動 context。git が読めなければ何も返さない(空 object)。transcript を決められなければ
 * `auto/git` だけ(transcript 由来の 2 key を**推測で**埋めない)。掴んだ transcript に 1 行も
 * cwd が一致する行が無ければ、その file はこの cwd の session の物では無いので同じく `auto/git` だけ。
 */
export function buildAutoContext(cwd: string, opts: { env?: Env; home?: string; now?: number } = {}): AutoContextResult {
  const git = readGitFacts(cwd);
  if (!git) return { context: {}, transcript: "not_a_git_worktree" };
  const context: Record<string, unknown> = { [AUTO_KEYS.git]: git };
  const pick = pickTranscript(cwd, opts);
  if (pick.path === null) return { context, transcript: pick.reason };
  const facts = readTranscriptFacts(readFileSync(pick.path, "utf8"), cwd);
  if (facts.cwd_rows === 0) return { context, transcript: "no_cwd_rows" };
  context[AUTO_KEYS.filesTouched] = facts.files_touched;
  context[AUTO_KEYS.tests] = facts.tests;
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

