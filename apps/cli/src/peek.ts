// `openroly peek`(PBI-0224)— dedicated session で model が実際に受け取った面を、model が見たのと同じ
// masked 形で後から見せる(Newio の Peek mode を OpenRoly の秘匿境界に合わせて持ち込んだ物)。
//
// 読むのは broker の session_dir(`$OPENROLY_BROKER_HOME/sessions/<request_id>/`)だけ:
//   instruction.txt … broker が渡した指示(session 開始時に model が受け取る面)
//   peek.jsonl      … MCP server が残した tool 往復(1 行目 header、以後 1 tool 呼び出し 1 行)
//   result.txt      … 在れば session は終わっている(codex の `-o`)。無ければ running と表示する
// **値は一度も復元しない**。placeholder(⟨s:n⟩)は log に在るまま出す(`--reveal` の類は作らない —
// 本人は secrets.json を見れば分かる。ここで戻すと「cloud AI に何が渡ったか」の証明でなくなる)。
// server にも web にも送らない(log は端末にしか無い。送ると E2EE の意味が消える)。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PEEK_FOOTER =
  "Placeholders (⟨s:n⟩) are shown exactly as the model saw them; the values never appear here.";

/** broker 側 is_safe_request_id / MCP 側 openPeek と同じ境界。`openroly peek ../x` で sessions/ の外を読まない */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SessionEntry {
  id: string;
  dir: string;
  mtime: number;
  runtime: string;
  started: string;
  /** result.txt が在れば done、無ければ running */
  exit: "done" | "running";
}

interface PeekHeader {
  session?: string;
  runtime?: string | null;
  started?: string;
}

interface PeekRow {
  tool: string;
  input: unknown;
  output: string;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

function parseHeader(dir: string): PeekHeader {
  const [first] = readLines(join(dir, "peek.jsonl"));
  if (!first) return {};
  try {
    return JSON.parse(first) as PeekHeader;
  } catch {
    return {};
  }
}

/** sessions/ 直下の dir を mtime 降順で返す(上限 limit) */
export function listSessions(sessionsDir: string, limit = 20): { entries: SessionEntry[]; total: number } {
  if (!existsSync(sessionsDir)) return { entries: [], total: 0 };
  const dirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(sessionsDir, d.name);
      return { name: d.name, dir, mtime: statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const entries = dirs.slice(0, limit).map(({ name, dir, mtime }) => {
    const header = parseHeader(dir);
    return {
      id: name,
      dir,
      mtime,
      runtime: header.runtime ?? "-",
      started: header.started ?? "-",
      exit: (existsSync(join(dir, "result.txt")) ? "done" : "running") as SessionEntry["exit"],
    };
  });
  return { entries, total: dirs.length };
}

export function renderList(sessionsDir: string, limit = 20): string {
  const { entries, total } = listSessions(sessionsDir, limit);
  if (total === 0) return `No sessions in ${sessionsDir}`;
  const lines = entries.map((e) => `${e.id}  ${e.runtime}  ${e.started}  ${e.exit}`);
  lines.push(`${total} session${total === 1 ? "" : "s"} in ${sessionsDir}${total > limit ? ` (showing ${limit})` : ""}`);
  return lines.join("\n");
}

/** header 行 + instruction.txt 全文。--follow は先にこれを出してから tail に入る */
function renderHead(dir: string): string {
  const header = parseHeader(dir);
  const id = header.session ?? dir.split("/").pop() ?? dir;
  const out: string[] = [`session ${id}  runtime ${header.runtime ?? "-"}  started ${header.started ?? "-"}`, ""];
  out.push("--- instruction (what the broker handed to the model) ---");
  const instr = join(dir, "instruction.txt");
  out.push(existsSync(instr) ? readFileSync(instr, "utf8").trimEnd() : "(no instruction.txt)");
  out.push("", "--- tool calls (exactly what the model sent and received) ---");
  return out.join("\n");
}

function renderRow(n: number, raw: string): string {
  let row: PeekRow;
  try {
    row = JSON.parse(raw) as PeekRow;
  } catch {
    return `${n}. (unparseable line) ${raw}`;
  }
  const output = row.output.split("\n").join("\n   ");
  return `${n}. ${row.tool} ${JSON.stringify(row.input)}\n   → ${output}`;
}

/** `openroly peek <id>` の本体。header → instruction → 番号付き tool 往復 → 固定の末尾文 */
export function renderSession(dir: string): string {
  const rows = readLines(join(dir, "peek.jsonl")).slice(1);
  const body = rows.length === 0 ? ["(no tool calls recorded)"] : rows.map((raw, i) => renderRow(i + 1, raw));
  return [renderHead(dir), ...body, "", PEEK_FOOTER].join("\n");
}

/** `--json`: 生の jsonl をそのまま(他 tool へ渡す用)。無ければ空文字 */
export function rawPeek(dir: string): string {
  const path = join(dir, "peek.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * `--follow`: 実行中 session の peek.jsonl を tail する。result.txt が現れたら残りを吐いて終了。
 * fs.watch は macOS で取りこぼすので短い poll(未決: claude は result.txt を書かないので、その時は
 * Ctrl-C で抜ける。stdout.log の inode 監視を fallback に置くかは PBI の未決の問い)
 */
export async function followSession(
  dir: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  pollMs = 300,
): Promise<void> {
  write(renderHead(dir) + "\n");
  let seen = 0;
  const drain = () => {
    const rows = readLines(join(dir, "peek.jsonl")).slice(1);
    for (; seen < rows.length; seen++) write(renderRow(seen + 1, rows[seen]!) + "\n");
  };
  for (;;) {
    drain();
    if (existsSync(join(dir, "result.txt"))) {
      drain();
      write(`\n${PEEK_FOOTER}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
