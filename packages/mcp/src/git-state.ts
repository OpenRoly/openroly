// PBI-0408 / CAP-3 V3: checkpoint tick が読む objective state。git の外から見える事実だけを
// 見る —— LLM に何も尋ねない(current_state 等の自己申告 field はここでは触らない)。
//
// PBI-0410 / CAP-3 V4: dirty tree を content-addressed に固める(trackedPatch / stagedPatch /
// untrackedFiles / hashes)。**ユーザーの branch / HEAD / index / working tree を書き換えない** ——
// `git stash create`(index/working tree に触らずに commit object を 1 つ作るだけ)と
// `git hash-object -w`(object を足すだけ)だけを使う。**ref は 1 つも作らない**(実測
// 2026-09-09: `git log --all` は refs/ 配下の全 ref を無条件に辿るので、pin すると本物の
// `git stash push` の `refs/stash` と同じ理由で AC-2 が壊れる — 詳細は @openroly/core の
// git-checkpoint.ts のコメント参照)。dangling のまま残る object は git の既定 GC 猶予
// (`gc.pruneExpire` 2 週間)に守られる —— 恒久な運搬は V5(provider transfer)の役目。
// 上限の定義は @openroly/core に置く(apps/cli の再適用側と 2 箇所に書かない)。
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINT_MAX_UNTRACKED_BYTES, CHECKPOINT_MAX_UNTRACKED_FILES, type GitState, type OmittedEntry, type UntrackedEntry, type UntrackedMode } from "@openroly/core/node";

export type { GitState } from "@openroly/core/node";

export interface PorcelainEntry {
  code: string;
  path: string;
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` の出力を解析する。`-z` は改行 / `"` /
 * 先頭 `-` / 非 ASCII を含む path も escape せず生 byte のまま返す(quote 形式に頼ると PBI-0231 で
 * 踏んだ改行 path のような特殊文字で壊れる)。rename/copy(status の 1 文字目 or 2 文字目が
 * `R`/`C`)は直後に「旧 path」の追加 token が来る(status prefix を持たない)ので、次の token を
 * path としてではなく skip する。
 */
export function parsePorcelainZ(output: string): PorcelainEntry[] {
  const tokens = output.split("\0");
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || tok === "") {
      i++;
      continue;
    }
    const code = tok.slice(0, 2);
    entries.push({ code, path: tok.slice(3) });
    i += code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C" ? 2 : 1;
  }
  return entries;
}

/**
 * cwd の git 状態。cwd が git worktree でなければ `null`(checkpoint 自体をスキップする合図)。
 * commit が 1 つも無い repo は `baseCommit: null` のまま dirty だけ数える。
 *
 * dirty === 0(clean)なら `{baseCommit, dirty}` だけを返す(patch 系 key を 1 つも持たない — AC-3)。
 * dirty > 0(B: dirty working tree)なら、tracked の変更は `git stash create` で 1 つの commit
 * object に固め(index/working tree には一切触れない)、untracked は 1 file ずつ `hash-object -w`
 * する。**どちらも ref は張らない**(AC-2 — 上のコメント参照)。
 */
export function computeGitState(cwd: string): GitState | null {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    return null;
  }
  let baseCommit: string | null;
  try {
    baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["pipe", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    baseCommit = null; // まだ commit が無い repo
  }
  const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  const entries = parsePorcelainZ(porcelain);
  const dirty = entries.length;
  if (dirty === 0) return { baseCommit, dirty };

  const { trackedPatch, stagedPatch } = buildTrackedPatch(cwd);
  const { untrackedFiles, hashes, omitted } = buildUntracked(cwd, entries);
  return { baseCommit, dirty, trackedPatch, stagedPatch, untrackedFiles, hashes, omitted };
}

/**
 * capsule に積まれた git_state と今の tree を比べ、変わった path を返す(PBI-0439 AC-6 / REHYDRATE)。
 * tracked は「stash create の commit(無ければ HEAD)」同士の tree を `git diff --name-only` で、untracked は
 * path → blob hash で比べる。どちらも同じ端末に在る object を読むだけで、tree にも ref にも触らない。
 * 古い object がこの端末に無い(GC 済み)時は何が変わったかは言えないので `(HEAD)` を 1 つ返す
 * (「変わっていない」と黙らない)。cwd が git worktree でなければ null。
 */
export function changedSinceGitState(saved: GitState, cwd: string): string[] | null {
  const current = computeGitState(cwd);
  if (!current) return null;
  const changed = new Set<string>();
  const before = saved.trackedPatch ?? saved.baseCommit;
  const after = current.trackedPatch ?? current.baseCommit;
  if (before !== after) {
    try {
      if (!before || !after) throw new Error("one side has no commit");
      const out = execFileSync("git", ["diff", "--name-only", "-z", before, after], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const path of out.split("\0")) if (path) changed.add(path);
    } catch {
      changed.add("(HEAD)");
    }
  }
  const untracked = (s: GitState) => new Map((s.untrackedFiles ?? []).map((f, i) => [f.path, s.hashes?.[i] ?? ""]));
  const was = untracked(saved);
  const now = untracked(current);
  for (const [path, hash] of was) if (now.get(path) !== hash) changed.add(path);
  for (const [path, hash] of now) if (was.get(path) !== hash) changed.add(path);
  return [...changed].sort();
}

/** commit の author/committer date を固定する — `stash create` は実際に commit object を作るので、
 * 日時を「今」のまま使うと**中身が同じでも呼ぶたびに違う sha**になる(実測 2026-09-09: このままだと
 * AC-5 の content-addressed が壊れ、0408 の dedupe(content_hash 比較)も 30 秒 tick のたびに
 * 無駄な新版を積んでしまう)。tree/parent/message が同じなら sha も同じになる。 */
const DETERMINISTIC_COMMIT_ENV = { GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" };

/** AC-1 の tracked 側。`stash create` は index/working tree/HEAD/branch に一切触らない読み取り
 * 専用の固め方(実測済み・G1 不確実性 #1)。戻り値が空文字列 = tracked の変更が 0 件(untracked
 * だけの dirty)。detached HEAD で対象が無い/commit が 1 つも無い等は例外を投げるので catch する
 * (「落ちない」— AC-6 と同じ精神。tracked 側が取れなくても untracked 側は続行する)。 */
function buildTrackedPatch(cwd: string): { trackedPatch: string | null; stagedPatch: string | null } {
  let sha: string;
  try {
    sha = execFileSync("git", ["stash", "create"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...DETERMINISTIC_COMMIT_ENV },
    }).trim();
  } catch {
    return { trackedPatch: null, stagedPatch: null };
  }
  if (!sha) return { trackedPatch: null, stagedPatch: null };
  // `stash create` の commit は常に parent が 2 つ以上(1=base, 2=index の状態)。2 番目の parent は
  // 「何が staged か」だけを表す(tracked.txt が unstaged で変更されていても ^2 には出ない)。
  let stagedPatch: string | null;
  try {
    stagedPatch = execFileSync("git", ["rev-parse", `${sha}^2`], { cwd, encoding: "utf8" }).trim();
  } catch {
    stagedPatch = null;
  }
  return { trackedPatch: sha, stagedPatch };
}

/** AC-6: untracked は 1 file ずつ扱えるので、上限(既定 1 MiB / 64 件)を超えた分だけ `omitted[]`
 * に理由付きで残し、trackedPatch には触らない(tracked 側は `stash create` が丸ごと固めるので
 * 個別の file だけを除外する事はできない — 巨大 file の完全対応は v0 外というスコープの壁どおり)。*/
function buildUntracked(
  cwd: string,
  entries: PorcelainEntry[],
): { untrackedFiles: UntrackedEntry[]; hashes: string[]; omitted: OmittedEntry[] } {
  const untrackedFiles: UntrackedEntry[] = [];
  const hashes: string[] = [];
  const omitted: OmittedEntry[] = [];
  const candidates = entries.filter((e) => e.code === "??");

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const path = candidate.path;
    if (i >= CHECKPOINT_MAX_UNTRACKED_FILES) {
      omitted.push({ path, reason: "too_many" });
      continue;
    }

    const abs = join(cwd, path);
    let mode: UntrackedMode;
    let size: number;
    let symlinkTarget: string | null = null;
    try {
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink()) {
        symlinkTarget = readlinkSync(abs);
        mode = "120000";
        size = Buffer.byteLength(symlinkTarget, "utf8");
      } else {
        const st = statSync(abs);
        mode = st.mode & 0o111 ? "100755" : "100644";
        size = st.size;
      }
    } catch {
      continue; // 並行操作で消えた(攻撃①) — 無かった事にする。壊さない・落ちない
    }
    if (size > CHECKPOINT_MAX_UNTRACKED_BYTES) {
      omitted.push({ path, reason: "too_large" });
      continue;
    }

    let hash: string;
    try {
      // symlink は素直に hash-object へ path を渡すと OS が追跡先の実体を読んでしまう(実測: 2026-09-09
      // この環境。git 自身の内部表現は「リンク先の文字列」を blob にする)ので、readlink した文字列を
      // --stdin で渡す。通常 file は `--` 付きで path を渡す(先頭 `-` の file 名対策・攻撃②)
      hash =
        symlinkTarget !== null
          ? execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: symlinkTarget, encoding: "utf8" }).trim()
          : execFileSync("git", ["hash-object", "-w", "--", path], { cwd, encoding: "utf8" }).trim();
    } catch {
      continue;
    }
    untrackedFiles.push({ path, mode });
    hashes.push(hash);
  }

  return { untrackedFiles, hashes, omitted };
}
