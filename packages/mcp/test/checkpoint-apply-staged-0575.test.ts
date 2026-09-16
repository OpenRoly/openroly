import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGitCheckpoint, checkoutForkFolder, computeGitState } from "@openroly/core/node";

// PBI-0575: checkpoint-apply / fork の folder は版の staged を staged のまま置き、.git/AUTO_MERGE を残さない。
// 版と同じ場所(HEAD = baseCommit・tracked が clean)なら exact(read-tree)・それ以外は今までどおり 3-way の stash apply。

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** base = s.txt / u.txt / o.txt を commit。版 = s.txt を staged で変更・u.txt を unstaged で変更・n.txt を untracked */
async function source() {
  const repo = await tmp("pbi0575-src-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  for (const f of ["s.txt", "u.txt", "o.txt"]) await writeFile(join(repo, f), `${f}\n`);
  git(repo, "add", "s.txt", "u.txt", "o.txt");
  git(repo, "commit", "-q", "-m", "base");
  await writeFile(join(repo, "s.txt"), "s.txt\nstaged\n");
  git(repo, "add", "s.txt");
  await writeFile(join(repo, "u.txt"), "u.txt\nunstaged\n");
  await writeFile(join(repo, "n.txt"), "untracked\n");
  return { repo, state: computeGitState(repo)! };
}

/** `--no-local`: fetch していない object を clone がたまたま持って来た、を緑と読まない(git-checkpoint.test.ts AC-4 と同じ) */
async function clone(repo: string): Promise<string> {
  const dir = join(await tmp("pbi0575-clone-"), "c");
  execFileSync("git", ["clone", "-q", "--no-local", "--no-hardlinks", repo, dir]);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}

const staged = (d: string) => git(d, "diff", "--cached", "--name-only");
const unstaged = (d: string) => git(d, "diff", "--name-only");
const text = (d: string, f: string) => readFile(join(d, f), "utf8");

describe("PBI-0575: 版の staged を staged のまま置く", () => {
  test("AC-1: HEAD = baseCommit の clean な clone → staged / unstaged / untracked が元どおり・AUTO_MERGE も reflog も書かない", async () => {
    const src = await source();
    const dir = await clone(src.repo);
    const reflog = git(dir, "reflog");
    applyGitCheckpoint(dir, src.state);
    expect(staged(dir)).toBe("s.txt\n");
    expect(unstaged(dir)).toBe("u.txt\n");
    expect(await text(dir, "n.txt")).toBe("untracked\n");
    expect(existsSync(join(dir, ".git", "AUTO_MERGE"))).toBe(false);
    expect(git(dir, "reflog")).toBe(reflog);
    expect(git(dir, "status", "--porcelain=v1", "--untracked-files=all")).toBe(git(src.repo, "status", "--porcelain=v1", "--untracked-files=all"));
  });

  test("AC-2: fork の folder も staged は staged", async () => {
    const src = await source();
    const dir = join(await tmp("pbi0575-fork-"), "f");
    checkoutForkFolder(src.repo, src.state, dir);
    expect(staged(dir)).toBe("s.txt\n");
    expect(unstaged(dir)).toBe("u.txt\n");
    expect(existsSync(join(dir, ".git", "AUTO_MERGE"))).toBe(false);
  });

  test("AC-X1: HEAD が 1 commit 進んだ tree → 今までどおり 3-way で当たり、進んだ commit の変更が残る", async () => {
    const src = await source();
    const dir = await clone(src.repo);
    await writeFile(join(dir, "o.txt"), "o.txt\nadvanced\n");
    git(dir, "commit", "-q", "-am", "advance");
    applyGitCheckpoint(dir, src.state);
    expect(await text(dir, "o.txt")).toBe("o.txt\nadvanced\n");
    expect(await text(dir, "s.txt")).toBe("s.txt\nstaged\n");
    expect(await text(dir, "u.txt")).toBe("u.txt\nunstaged\n");
  });

  test("AC-X2: tracked に未 commit の変更が在る tree → その変更が残る(read-tree で上書きしない)", async () => {
    const src = await source();
    const dir = await clone(src.repo);
    await writeFile(join(dir, "o.txt"), "o.txt\nmine\n");
    applyGitCheckpoint(dir, src.state);
    expect(await text(dir, "o.txt")).toBe("o.txt\nmine\n");
    expect(await text(dir, "u.txt")).toBe("u.txt\nunstaged\n");
  });
});
