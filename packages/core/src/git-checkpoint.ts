// PBI-0410 / CAP-3 V4: dirty working tree を content-addressed に固める/戻す。
//
// **ユーザーの branch / HEAD / index / working tree を書き換えない**(この capability の壁 —
// PBI-0410 のスコープ外の壁を参照)。「打つ」側(packages/mcp/src/git-state.ts の
// computeGitState)と「戻す」側(ここの applyGitCheckpoint)が同じ上限を見る必要が在る
// (CAPSULE_FIELDS と同じ理由 — 2 箇所に別々に書くと drift する)。apps/cli と packages/mcp は
// どちらも既に @openroly/core に依存しているので、ここに置けば新しい依存 edge を足さずに
// 両側から同じ実装を呼べる。
//
// **ref は 1 つも作らない**(実測 2026-09-09・この G1 の初版は `refs/openroly/checkpoints/*` へ
// pin する設計だったが、`git log --all` は「refs/ 配下の**全** ref」を無条件に辿る ——
// 本物の `git stash push` が作る `refs/stash` ですら同じ理由で `git log --all` に 2 行増える。
// refs/notes・refs/bisect 等どの namespace で試しても同じで、「pin しつつ log --all に出さない」
// は git の構造上できない。AC-2(この slice の中心)を優先し、`git stash create` /
// `hash-object -w` が作る dangling object は **何もしない**(ref を張らない)。GC(既定
// `gc.pruneExpire` = 2 週間)より先に checkpoint が消費される運用を前提にする — 完全な永続化
// (デバイスをまたいだ運搬)は V5(provider transfer)の役目)。
//
// ponytail: 天井 — **`git gc --prune=now`(または `--aggressive`)を打った瞬間、その repo の
// dangling checkpoint は年齢に関係なく即死する。**「2 週間の猶予」は `gc.pruneExpire` の既定値の
// 話で、`--prune=now` はそれを無視する。この project の CLAUDE.md 自身が secret 漏洩時の手順として
// `git reflog expire --expire=now --all && git gc --prune=now --aggressive` を明記しており、
// **同じ repo で checkpoint が「引き継ぎ待ち」の最中にこれを打つと、適用側は 404 相当の fetch 失敗で
// 気付くだけで、内容は復元できない**(致命的ではなく検知可能 — fetch が失敗するので silent
// corruption にはならない。ただし操作した本人には何も警告が出ない)。恒久な運搬(GC に依存しない
// 保存)は V5 の役目のまま — ただし V5 を素通りさせず、少なくとも「このコマンドを打つ前に
// pending checkpoint が無いか確認する」運用注記を secret 漏洩手順側に足すことを検討する
// (レビュー 2026-09-09 で発見。修正は本 PBI のスコープ外 — 次 slice か運用手順側で拾う)。
// あわせて **`origin` 既定の fetch は「元の作業者の repo が `origin` の URL でも到達できる」ことが
// 前提**(実測でこれが成立するのは AC-4 のように clone の origin が capture 元そのものを指す時だけ)。
// 実運用の「別デバイスへの引き継ぎ」で `origin` が GitHub 等の共有 remote を指す場合、そこには
// dangling object は存在しない(capture 側は一度も push していない)ので fetch は失敗する —
// これも V5(実際に使う transport を配線する)の役目として明示的に残っている。
//
// 借りる物(G1「借りる物」節): git 本体に接続する(`git stash create` / `hash-object -w` /
// `fetch <bare sha>` / `stash apply` / `cat-file`)。patch 形式も content-address も git が
// 既に持っているので、TS で patch parser を自作しない。**bare sha を dest 無しで fetch できる**
// (実測: ローカル transport は `uploadpack.allowAnySHA1InWant` 無しでも通る)ので ref は要らない。
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { decideMerge, type MergeDecision } from "./work.ts";

export const CHECKPOINT_MAX_UNTRACKED_BYTES = 1024 * 1024; // 1 MiB(v0 の既定上限。AC-6)
export const CHECKPOINT_MAX_UNTRACKED_FILES = 64; // AC-6

export type UntrackedMode = "100644" | "100755" | "120000";

export interface UntrackedEntry {
  path: string;
  mode: UntrackedMode;
}

export interface OmittedEntry {
  path: string;
  reason: "too_large" | "too_many";
}

/**
 * dirty:0 の時は `baseCommit` と `dirty` だけ(patch 系 key を 1 つも持たない — AC-3)。
 * dirty>0 の時だけ `trackedPatch` / `stagedPatch` / `untrackedFiles` / `hashes` / `omitted` が揃う(AC-1)。
 */
export interface GitState {
  baseCommit: string | null;
  dirty: number;
  trackedPatch?: string | null;
  stagedPatch?: string | null;
  untrackedFiles?: UntrackedEntry[];
  hashes?: string[];
  omitted?: OmittedEntry[];
}

export interface ApplyCheckpointOptions {
  /** どこから git object を取ってくるか(既定 "origin" — `git clone` が自動で張る remote 名と同じ)。
   * 実際の provider transfer(cross-machine / cross-account の運搬)は V5 の話 —— ここは
   * git 自身の fetch に乗るだけ(自作しない)。 */
  remote?: string;
}

/**
 * capsule に積まれた `GitState` を、別の(同じ baseCommit の)clean な working tree に戻す
 * (V4 の C: 引き継いだ側)。dirty:0(積む物が無い)なら何もしない。
 *
 * **ユーザーの branch / HEAD / index を触らない** —— `git stash apply` は index と working tree
 * だけを更新する(commit しない・branch を作らない・新しい stash entry を stash list に積まない)。
 */
export function applyGitCheckpoint(cwd: string, checkpoint: GitState, opts: ApplyCheckpointOptions = {}): void {
  if (checkpoint.dirty === 0) return;
  const remote = opts.remote ?? "origin";

  if (checkpoint.trackedPatch) {
    fetchObject(cwd, remote, checkpoint.trackedPatch);
    execFileSync("git", ["stash", "apply", checkpoint.trackedPatch], { cwd, stdio: ["ignore", "ignore", "pipe"] });
  }

  const files = checkpoint.untrackedFiles ?? [];
  const hashes = checkpoint.hashes ?? [];
  // レビュー 2026-09-09(PBI-0410 有界レビュー): `git_state` は capsule 経由で DB を往復する ——
  // `buildCapsule`(packages/core/src/capsule.ts)は top-level key の許可リストしか見ず、
  // `git_state` の中身(untrackedFiles[].path 等)は検証しない。apply する側からは**信用できない
  // 入力**。tracked 側は `git stash apply` が git 自身の checkout 経路を通るので `..` を含む path は
  // git が `invalid path` で拒否する(実測済み)。untracked 側はここで自前に `join(cwd, path)` して
  // 書いているので、その保護を持たない。実測: `path: "../../../escaped.txt"` を含む untrackedFiles
  // で呼ぶと working tree の外(cwd の親)に任意内容を書けた(path traversal)。**書き込む前に全件を
  // 検証**する(1 件でも外に出るなら 1 file も書かずに投げる — 部分適用で「壊れていない物だけ」を
  // 装わせない)。
  for (const entry of files) {
    if (entry) resolveWithinCwd(cwd, entry.path);
  }
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const hash = hashes[i];
    if (!entry || !hash) continue;
    fetchObject(cwd, remote, hash);
    writeUntrackedFile(cwd, entry, hash);
  }
}

/** ref を経由せず bare sha を直接 fetch する(source 側に ref を作らずに済む — AC-2 の理由)。
 * 既にこの repo から読める object は取りに行かない(fork folder は clone --shared で元の object を共有する = PBI-0440)。*/
function fetchObject(cwd: string, remote: string, sha: string): void {
  if (hasObject(cwd, sha)) return;
  execFileSync("git", ["fetch", "--no-tags", remote, sha], { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function hasObject(cwd: string, spec: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", spec], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * fork の枝の folder を作る(PBI-0440・図84)。`repoCwd`(fork 元の作業 dir)の repo を `dir` へ `clone --shared`
 * (object は元の repo を alternates で読む = 写さない)し、capsule の baseCommit に detach して git_state を戻す。
 * **元の repo の refs / tree / .git には書かない**(clone の refs は dir の中にだけ出来る)。
 * `git worktree` にしないのは、worktree の管理 file(HEAD / index)が元の .git/worktrees の下に在り、broker の
 * sandbox(folder の中だけ write)が枝の commit も 30 秒 tick の stash create も拒むから。
 * baseCommit がこの repo に無い / 戻せない時は dir を残さず throw する(呼び手は server に POST しない)。
 * 作った直後の tree を元の repo の object に snapshot し、hash を元の repo の git dir の `openroly-task-base/<dir 名>` に置く —— task の合流
 * (`mergeTaskFolder`・PBI-0447)の起点。task の folder も同じ関数で作る(worktree にしない理由も同じ)。
 * ponytail: alternates なので、元の repo で `git gc --prune=now` を打つと枝からも dangling な checkpoint object が
 * 消える(上の天井と同じ。base の tree も同じく dangling)。枝を長く持つ運用が来たら `git repack -a -d` で object を枝へ写す
 */
export function checkoutForkFolder(repoCwd: string, checkpoint: GitState, dir: string): void {
  const base = checkpoint.baseCommit;
  if (!base) throw new Error("fork refused: the capsule's git_state has no baseCommit (the repo had no commit yet)");
  if (!hasObject(repoCwd, `${base}^{commit}`)) {
    throw new Error(`fork refused: baseCommit ${base} is not in the repo at ${repoCwd}`);
  }
  if (existsSync(dir)) throw new Error(`fork refused: ${dir} already exists`);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoCwd, encoding: "utf8" }).trim();
  mkdirSync(dirname(dir), { recursive: true });
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", top, dir], { stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("git", ["checkout", "--quiet", "--detach", base], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    applyGitCheckpoint(dir, checkpoint);
    const gitDir = gitDirOf(top);
    const baseFile = mergeBaseFileOf(gitDir, dir);
    mkdirSync(dirname(baseFile), { recursive: true });
    writeFileSync(baseFile, `${snapshotTree(gitDir, dir, base)}\n`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 合流の起点(作った直後の tree の hash)の置き場。**元の repo の git dir の中**(ref ではない plain file = refs は増えない)。
 * folder の中に置かないのは、folder が task の agent の書ける場所だから —— 起点を書き換えられると合流する側の
 * `git diff` に option(`--output=<任意の file>`)を渡され、sandbox の外の file を合流する側の権限で上書きされた(review 実測)
 */
const mergeBaseFileOf = (gitDir: string, folder: string): string => join(gitDir, "openroly-task-base", basename(folder));
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// patch と path 一覧を読む上限(execFileSync の既定 1MiB は数千 file の repo で溢れる)
const GIT_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;

function gitDirOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" }).trim();
}

/**
 * `workTree` の今の中身を tree object にして hash を返す。`seed`(起点の commit / tree)を一時 index に読み、tracked は
 * `add -u`(**.gitignore に掛かっていても tracked のまま**・消した file は消える)、untracked は .gitignore を除いて足す。
 * seed 無しで untracked だけ数えると、tracked で ignore に掛かる file の編集が落ち、task が ignore を足すと tracked file が
 * 「消した」ことになって合流が project から消していた(review 実測)。object は `gitDir` の repo に書き、
 * **`workTree` にも `gitDir` の index にも書かない**(一時 index)。ref は作らない。
 * sandbox が project の中だけ write を許す merger でも task の folder を読むだけで済む(実測 2026-09-13)
 */
function snapshotTree(gitDir: string, workTree: string, seed: string): string {
  const index = join(gitDir, `openroly-snapshot-${randomUUID()}`);
  const opts = { cwd: workTree, env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_INDEX_FILE: index }, maxBuffer: GIT_OUTPUT_MAX_BYTES };
  try {
    execFileSync("git", ["read-tree", seed], { ...opts, stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("git", ["add", "-u"], { ...opts, stdio: ["ignore", "ignore", "pipe"] });
    const files = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], opts);
    execFileSync("git", ["update-index", "-z", "--add", "--stdin"], { ...opts, input: files, stdio: ["pipe", "ignore", "pipe"] });
    return execFileSync("git", ["write-tree"], { ...opts, encoding: "utf8" }).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * task の folder を project の作業ツリーへ合流する(PBI-0447・図80c ⑥)。base(`checkoutForkFolder` が置いた起点)→ 今の folder の
 * 差分を project の repo の object で取り(folder には書かない)、project の `index.lock` を取ってから `git apply --check` →
 * 通った時だけ `git apply`。**working tree だけを書き、index / HEAD / refs は触らない**(commit しない)。ぶつかれば 1 byte も当てない。
 * `--3way` は使わない —— `--index` を含むので project の未 stage の変更を一律に断り、staged の衝突では check が通って
 * conflict marker を当てる(実測)。folder に base が無ければ `worktree_missing` で throw(project に触らない)
 */
export function mergeTaskFolder(folder: string, projectCwd: string): MergeDecision {
  const missing = `worktree_missing: ${folder} is not a task folder of this repo on this device — nothing was merged`;
  // patch の path は repo の root 基準。subdir で git apply すると外の path を黙って飛ばす
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectCwd, encoding: "utf8" }).trim();
  const gitDir = gitDirOf(top);
  const baseFile = mergeBaseFileOf(gitDir, folder);
  if (!existsSync(folder) || !existsSync(baseFile)) throw new Error(missing);
  const base = readFileSync(baseFile, "utf8").trim();
  // 起点は object id だけ。それ以外(`--output=…` などの option・rev の式)は git に渡さない
  if (!OBJECT_ID_RE.test(base)) throw new Error(missing);
  const now = snapshotTree(gitDir, folder, base);
  const git = { cwd: top, maxBuffer: GIT_OUTPUT_MAX_BYTES };
  const changed = execFileSync("git", ["diff", "--name-only", "-z", base, now], { ...git, encoding: "utf8" }).split("\0").filter(Boolean);
  if (changed.length === 0) return decideMerge({ changed, busy: false, checkError: null });
  const lockPath = join(gitDir, "index.lock");
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return decideMerge({ changed, busy: true, checkError: null });
    throw e;
  }
  try {
    const patch = execFileSync("git", ["diff", "--binary", base, now], git);
    const check = spawnSync("git", ["apply", "--check"], { ...git, input: patch });
    const d = decideMerge({ changed, busy: false, checkError: check.status === 0 ? null : String(check.stderr ?? "") });
    if (d.result !== "applied") return d;
    // check が通っても書き込みは途中で落ちうる(書けない dir・sandbox が拒む path)。git apply は落ちる前に書いた file を
    // 戻さないので、当てる前の姿を持っておき、落ちたら戻す(review 実測: 1 file 目だけ当たって throw していた)。
    // ponytail: 変わる file を全部 memory に読む・apply が作った空 dir は残る。巨大な binary の合流が来たら一時 dir に写す
    const before = changed.map((p) => savePath(join(top, p)));
    const applied = spawnSync("git", ["apply"], { ...git, input: patch });
    if (applied.status !== 0) {
      for (const s of before) restorePath(s);
      throw new Error(`merge_failed: git apply stopped part way (${String(applied.stderr ?? "").trim()}) — every file was put back, nothing was merged`);
    }
    return d;
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

type SavedPath =
  | { abs: string; kind: "absent" }
  | { abs: string; kind: "file"; data: Buffer; mode: number }
  | { abs: string; kind: "link"; target: string }
  | { abs: string; kind: "other" };

function savePath(abs: string): SavedPath {
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return { abs, kind: "absent" };
  if (st.isSymbolicLink()) return { abs, kind: "link", target: readlinkSync(abs) };
  if (st.isFile()) return { abs, kind: "file", data: readFileSync(abs), mode: st.mode & 0o7777 };
  return { abs, kind: "other" }; // dir 等は apply が file に替えない(check が already exists で落とす)
}

/** 合流が途中で落ちた時、当てる前の姿に戻す。変わっていない path(書けなかった path を含む)には触らない */
function restorePath(s: SavedPath): void {
  const st = lstatSync(s.abs, { throwIfNoEntry: false });
  if (s.kind === "other") return;
  if (s.kind === "absent") {
    if (st) rmSync(s.abs, { force: true });
    return;
  }
  if (s.kind === "file" && st?.isFile() && (st.mode & 0o7777) === s.mode && readFileSync(s.abs).equals(s.data)) return;
  if (s.kind === "link" && st?.isSymbolicLink() && readlinkSync(s.abs) === s.target) return;
  if (st) rmSync(s.abs, { force: true });
  mkdirSync(dirname(s.abs), { recursive: true });
  if (s.kind === "link") symlinkSync(s.target, s.abs);
  else {
    writeFileSync(s.abs, s.data);
    chmodSync(s.abs, s.mode);
  }
}

/** `cwd` の外に出る path(`..` traversal)を拒む。絶対 path は `join` が `cwd` 配下へ畳み込む
 * (node の仕様)ので実害は無いが、`relative` の結果で一律に判定する方が読みやすい。 */
function resolveWithinCwd(cwd: string, entryPath: string): string {
  const abs = join(cwd, entryPath);
  const rel = relative(cwd, abs);
  if (rel === ".." || rel.startsWith(".." + "/")) {
    throw new Error(`checkpoint apply refused: path escapes working tree: ${entryPath}`);
  }
  return abs;
}

function writeUntrackedFile(cwd: string, entry: UntrackedEntry, hash: string): void {
  const abs = resolveWithinCwd(cwd, entry.path);
  mkdirSync(dirname(abs), { recursive: true });
  if (entry.mode === "120000") {
    const target = execFileSync("git", ["cat-file", "-p", hash], { cwd, encoding: "utf8" });
    try {
      unlinkSync(abs); // symlinkSync は path が既に在ると EEXIST — 無ければ何もしない
    } catch {
      /* 元々無ければ良い */
    }
    symlinkSync(target, abs);
    return;
  }
  const content = execFileSync("git", ["cat-file", "-p", hash], { cwd }); // encoding 未指定 = Buffer(byte 一致・AC-4)
  writeFileSync(abs, content);
  if (entry.mode === "100755") chmodSync(abs, 0o755);
}
