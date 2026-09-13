// work-project-sharing module review(PBI-0443〜0447)の攻撃 test。AC の外から「ぶつかれば 1 byte も当てない」と
// 「task の context は task に留まる」を破りに行く。実物は一時 git repo(server は使わない)。
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutForkFolder, mergeTaskFolder } from "../src/git-checkpoint.ts";
import { decideContextWrite } from "../src/work-context.ts";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

/** 作業ツリーの中身の hash。git を通さず file を歩く(実装と同じ道具で測らない)・.git は数えない */
function treeOf(dir: string): string {
  const h = new Bun.CryptoHasher("sha256");
  const paths = (readdirSync(dir, { recursive: true }) as string[]).filter((p) => !p.split("/").includes(".git")).sort();
  for (const p of paths) {
    const abs = join(dir, p);
    h.update(p);
    try {
      h.update(readFileSync(abs));
    } catch {
      h.update("<dir>");
    }
  }
  return h.digest("hex");
}

/** project C(commit 1 本)と、そこから作った task の folder F */
function setup(files: Record<string, string>): { root: string; C: string; F: string } {
  const root = mkdtempSync(join(tmpdir(), "openroly-review-wps-"));
  const C = join(root, "C");
  mkdirSync(C);
  git(C, "init", "-q");
  for (const [p, v] of Object.entries(files)) {
    mkdirSync(join(C, p, ".."), { recursive: true });
    writeFileSync(join(C, p), v);
  }
  git(C, "add", "-f", "-A");
  git(C, "commit", "-qm", "init");
  const F = join(root, "worktrees", "task-1");
  checkoutForkFolder(C, { baseCommit: git(C, "rev-parse", "HEAD").trim(), dirty: 0 }, F);
  return { root, C, F };
}

describe("合流の起点を task の agent が書き換えられない", () => {
  test("起点は task の folder の中に無い —— folder の .git に置いた偽の起点(--output=外の file)は読まれず、外の file は無傷", () => {
    const { root, C, F } = setup({ "src/a.ts": "a\n" });
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "precious\n");
    writeFileSync(join(F, "src/a.ts"), "changed\n");
    writeFileSync(join(F, ".git", "openroly-base"), `--output=${victim}\n`);
    expect(mergeTaskFolder(F, C)).toEqual({ result: "applied", paths: ["src/a.ts"] });
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(readFileSync(join(C, "src/a.ts"), "utf8")).toBe("changed\n");
  });

  test("起点の file が object id でなければ git に渡さず worktree_missing・外の file も C も無傷", () => {
    const { root, C, F } = setup({ "src/a.ts": "a\n" });
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "precious\n");
    writeFileSync(join(F, "src/a.ts"), "changed\n");
    const baseDir = join(git(C, "rev-parse", "--absolute-git-dir").trim(), "openroly-task-base");
    expect(readdirSync(baseDir)).toEqual(["task-1"]);
    writeFileSync(join(baseDir, "task-1"), `--output=${victim}\n`);
    const before = treeOf(C);
    expect(() => mergeTaskFolder(F, C)).toThrow(/^worktree_missing:/);
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(treeOf(C)).toBe(before);
  });

  test("起点を置いても C の refs は増えない(plain file であって ref ではない)", () => {
    const { C } = setup({ "src/a.ts": "a\n" });
    expect(git(C, "for-each-ref").trim().split("\n")).toHaveLength(1);
  });
});

describe("tracked の file は .gitignore に掛かっても tracked のまま合流する", () => {
  test("tracked で ignore に掛かる file の編集が落ちない(empty にならない)", () => {
    const { C, F } = setup({ ".gitignore": "*.log\n", "keep.log": "v1\n", "src/a.ts": "a\n" });
    writeFileSync(join(F, "keep.log"), "v2\n");
    expect(mergeTaskFolder(F, C)).toEqual({ result: "applied", paths: ["keep.log"] });
    expect(readFileSync(join(C, "keep.log"), "utf8")).toBe("v2\n");
  });

  test("task が .gitignore に足した規則で、C の tracked file が消されない", () => {
    const { C, F } = setup({ "fixtures/x.log": "data\n", "src/a.ts": "a\n" });
    writeFileSync(join(F, ".gitignore"), "*.log\n");
    expect(mergeTaskFolder(F, C)).toEqual({ result: "applied", paths: [".gitignore"] });
    expect(readFileSync(join(C, "fixtures/x.log"), "utf8")).toBe("data\n");
  });

  test("対照: task が本当に消した tracked file は消える・ignore された新しい file は載らない", () => {
    const { C, F } = setup({ ".gitignore": "*.log\n", "gone.ts": "g\n", "src/a.ts": "a\n" });
    execFileSync("rm", [join(F, "gone.ts")]);
    writeFileSync(join(F, "junk.log"), "junk\n");
    expect(mergeTaskFolder(F, C)).toEqual({ result: "applied", paths: ["gone.ts"] });
    expect(existsSync(join(C, "gone.ts"))).toBe(false);
    expect(existsSync(join(C, "junk.log"))).toBe(false);
  });
});

describe("書き込みが途中で落ちても 1 byte も残さない", () => {
  test("check は通るが 2 つ目の file を書けない(書けない dir)→ merge_failed・C の tree も status も前と同じ", () => {
    const { C, F } = setup({ "a/one.ts": "1\n", "z/two.ts": "2\n" });
    writeFileSync(join(F, "a/one.ts"), "1 changed\n");
    writeFileSync(join(F, "z/new.ts"), "new\n");
    const before = treeOf(C);
    chmodSync(join(C, "z"), 0o555);
    try {
      expect(() => mergeTaskFolder(F, C)).toThrow(/^merge_failed:/);
    } finally {
      chmodSync(join(C, "z"), 0o755);
    }
    expect(treeOf(C)).toBe(before);
    expect(git(C, "status", "--porcelain")).toBe("");
    expect(existsSync(join(git(C, "rev-parse", "--absolute-git-dir").trim(), "index.lock"))).toBe(false);
  });
});

describe("decideContextWrite — 兄弟の task へは message だけ(review で塞いだ)", () => {
  const T = { id: "T", parentWorkId: "P" };
  const T2 = { id: "T2", parentWorkId: "P" };
  const P = { id: "P", parentWorkId: null };
  test("task の holder が兄弟の task の decisions を直接書く → publish_required", () => {
    expect(decideContextWrite(T2, [T], ["decisions"])).toEqual({ ok: false, reason: "publish_required" });
  });
  test("inbox/ に 1 つでも他の key が混ざれば publish_required", () => {
    expect(decideContextWrite(T2, [T], ["inbox/T/1", "goal"])).toEqual({ ok: false, reason: "publish_required" });
  });
  test("対照: 兄弟への message・project の holder が task へ書くのは今まで通り", () => {
    expect(decideContextWrite(T2, [T], ["inbox/T/1"])).toEqual({ ok: true });
    expect(decideContextWrite(T2, [P], ["decisions"])).toEqual({ ok: true });
    expect(decideContextWrite(T2, [T, T2], ["decisions"])).toEqual({ ok: true });
  });
});
