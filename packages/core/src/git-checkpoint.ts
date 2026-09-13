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
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

/** ref を経由せず bare sha を直接 fetch する(source 側に ref を作らずに済む — AC-2 の理由)。*/
function fetchObject(cwd: string, remote: string, sha: string): void {
  execFileSync("git", ["fetch", "--no-tags", remote, sha], { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
