// PBI-0408 / CAP-3 V3: checkpoint tick が読む objective state。固める側(computeGitState)は
// @openroly/core の git-checkpoint.ts に在る —— CLI の rollback(PBI-0550)も同じ実装で今の tree を
// 固めるので、apps/cli から届く core に置く(apps/cli は @openroly/mcp に依存しない)。
// ここに残るのは REHYDRATE の 1 行を作る差分だけ。
import { execFileSync } from "node:child_process";
import { computeGitState, type GitState } from "@openroly/core/node";

export type { GitState } from "@openroly/core/node";

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
