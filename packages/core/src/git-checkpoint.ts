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
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { decideMerge, decideMergePaths, type MergeDecision } from "./work.ts";

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

// ---------- 固める(PBI-0408 / 0410。PBI-0550 で packages/mcp の git-state.ts から移した —— CLI の rollback が
// 同じ実装で今の tree を固める。apps/cli は @openroly/mcp に依存しない) ----------
// git の外から見える事実だけを見る —— LLM に何も尋ねない。`git stash create`(index / working tree に触らずに
// commit object を 1 つ作るだけ)と `git hash-object -w`(object を足すだけ)だけを使い、ref は 1 つも作らない。

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
 * **ユーザーの branch / HEAD を触らない** —— 置き方は 2 つで、どちらも commit しない・branch を作らない・stash list に積まない。
 * 版と同じ場所(HEAD = baseCommit・tracked が clean)なら `read-tree` で exact に置く(staged は staged のまま・PBI-0575)。
 * それ以外は `git stash apply`(3-way。今の tracked の変更を残し、進んだ HEAD の上にも当たる)。
 */
export function applyGitCheckpoint(cwd: string, checkpoint: GitState, opts: ApplyCheckpointOptions = {}): void {
  if (checkpoint.dirty === 0) return;
  const remote = opts.remote ?? "origin";

  if (checkpoint.trackedPatch) {
    fetchObject(cwd, remote, checkpoint.trackedPatch);
    // plain の stash apply は staged を unstaged に落とし .git/AUTO_MERGE を残す(実測・PBI-0550 G2)。上書きして失う物が無い時だけ exact
    if (sameSpotAsVersion(cwd, checkpoint)) placeTrackedExact(cwd, checkpoint);
    else execFileSync("git", ["stash", "apply", checkpoint.trackedPatch], { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
  assertEntriesWithinCwd(cwd, files);
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
 * conflict marker を当てる(実測)。folder に base が無ければ `worktree_missing` で throw(project に触らない)。
 * `forbidden`(PBI-0649・task の `brief/forbidden`)に当たる path が 1 本でも在れば、**`index.lock` を取る前に**
 * `outside_scope` を返す —— 2 本の task が同時に合流しても、両方が「busy」ではなく持ち場の外として断られる(AC-X3)
 */
export function mergeTaskFolder(folder: string, projectCwd: string, forbidden: readonly string[] = []): MergeDecision {
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
  // PBI-0649: 持ち場の門。lock も patch も取る前に断る(断った時は 1 byte も当たらない・他の合流も止めない)
  const scope = decideMergePaths(changed, forbidden);
  if (!scope.ok) return { result: "outside_scope", paths: scope.hit };
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

/** 版の path(信用しない入力)が working tree の外へ出る形を拒む。3 つ:
 * ① `..` traversal(`relative` で判定。絶対 path は `join` が `cwd` 配下へ畳み込む = node の仕様)
 * ② `.git` の中(hook を置けば次の git 操作が sandbox の外の権限で走る。大文字小文字を区別しない fs が在るので小文字で比べる)
 * ③ 途中の dir が disk 上の symlink(tree に在る symlink を辿って外へ書く / 消す)。最後の要素は見ない ——
 *    untracked の symlink そのもの(mode 120000)は正当に置き換える対象
 * ②③ は module review 順 8 の A4(rollback の「CAS の payload は信用しない」が ① しか持っていなかった) */
function resolveWithinCwd(cwd: string, entryPath: string): string {
  const abs = join(cwd, entryPath);
  const rel = relative(cwd, abs);
  const parts = rel.split("/");
  if (rel === ".." || rel.startsWith(".." + "/") || parts.some((p) => p.toLowerCase() === ".git")) {
    throw new Error(`checkpoint apply refused: path escapes working tree: ${entryPath}`);
  }
  for (let i = 1; i < parts.length; i++) {
    if (lstatSync(join(cwd, ...parts.slice(0, i)), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`checkpoint apply refused: path goes through a symlink: ${entryPath}`);
    }
  }
  return abs;
}

/** 版の untracked を書く前に全件を検証する(1 件でも外に出るなら 1 file も書かない)。resolveWithinCwd に加え、
 * **同じ版が先に置く symlink の下**を指す path も拒む —— 書く順に disk へ現れるので、書く前の lstat では見えない */
function assertEntriesWithinCwd(cwd: string, files: readonly (UntrackedEntry | null | undefined)[]): void {
  const norm = (p: string) => relative(cwd, join(cwd, p));
  const links = files.flatMap((f) => (f?.mode === "120000" ? [norm(f.path)] : []));
  for (const entry of files) {
    if (!entry) continue;
    resolveWithinCwd(cwd, entry.path);
    const rel = norm(entry.path);
    if (links.some((l) => rel.startsWith(`${l}/`))) {
      throw new Error(`checkpoint apply refused: path goes through a symlink: ${entry.path}`);
    }
  }
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

// ---------- rollback(PBI-0550 / CAP-3 V7 の続き・図84) ----------
// 1 つ前の版へ戻す。**戻す前の今を先に固める**(呼び手が CAS へ書いてから tree を触る)ので、戻すのに失敗しても・
// 戻したのが間違いでも何も失わない。HEAD / branch / stash list / refs は触らない(PBI-0410 の壁)。

export type RollbackPlan =
  | { kind: "ok" }
  | { kind: "no_git_state" }
  | { kind: "base_mismatch"; head: string; base: string }
  | { kind: "would_lose"; paths: string[] };

/**
 * 今(current)を捨てずに版(target)へ戻せるか。判定の正本はここ 1 つ(CLI は結果を言うだけ)。
 * - git の外 / commit の無い repo / 版に git_state が無い → no_git_state(戻す起点の HEAD が無い)
 * - HEAD ≠ 版の baseCommit → base_mismatch(HEAD を動かすのは git 本体の仕事。名指しするだけ)
 * - 固めきれない物が在る → would_lose: current.omitted(上限超過の untracked)と clobbered(版が untracked として
 *   書く path に、今の状態に入っていない file が在る — ignore に掛かった .env 等。上書きするとどこにも残らない)
 */
export function planRollback(input: {
  current: GitState | null;
  target: GitState | null;
  clobbered: readonly string[];
}): RollbackPlan {
  const { current, target } = input;
  if (!current?.baseCommit || !target?.baseCommit) return { kind: "no_git_state" };
  if (current.baseCommit !== target.baseCommit) {
    return { kind: "base_mismatch", head: current.baseCommit, base: target.baseCommit };
  }
  const paths = [...(current.omitted ?? []).map((o) => o.path), ...input.clobbered];
  return paths.length > 0 ? { kind: "would_lose", paths } : { kind: "ok" };
}

export interface PreparedRollback {
  /** repo の root(porcelain の path は root 基準 — subdir のまま固めると hash-object が別の file を読む) */
  cwd: string;
  current: GitState | null;
  plan: RollbackPlan;
}

/**
 * 今を固めて(git の object を足すだけ・ref 0)判定する。**tree には触らない**。
 * 版の untracked の path が working tree の外を指していれば throw する(判定の前に拒む — CAS の payload は信用しない)。
 */
export function prepareRollback(cwd: string, target: GitState | null): PreparedRollback {
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return { cwd, current: null, plan: { kind: "no_git_state" } };
  }
  const current = computeGitState(top);
  const clobbered = current && target ? clobberedPaths(top, current, target) : [];
  return { cwd: top, current, plan: planRollback({ current, target, clobbered }) };
}

/** 版が書く path(untracked と、tracked の変更)のうち、今 disk に在るのに current に入っていない物。
 * `read-tree --reset -u` は tree の path に在る ignore / untracked の file を**黙って上書きする**(実測 2026-09-14)ので、
 * tracked の変更の path も数える。index に在る path は current.trackedPatch が固めているので数えない */
function clobberedPaths(cwd: string, current: GitState, target: GitState): string[] {
  const untracked = untrackedPaths(target);
  // 判定の前に拒む(tree に触る前 = rollback は exit 2 で 1 file も動かさない)。当てる段の applyGitCheckpoint も同じ検証を持つ
  assertEntriesWithinCwd(cwd, target.untrackedFiles ?? []);
  const captured = new Set(untrackedPaths(current));
  const onDisk = [...new Set([...untracked, ...trackedChanges(cwd, target)])].filter(
    (p) => !captured.has(p) && lstatSync(join(cwd, p), { throwIfNoEntry: false }) !== undefined,
  );
  if (onDisk.length === 0) return [];
  const tracked = execFileSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", ...onDisk], { cwd, encoding: "utf8" });
  const trackedSet = new Set(tracked.split("\0"));
  return onDisk.filter((p) => !trackedSet.has(p));
}

const untrackedPaths = (s: GitState): string[] =>
  (s.untrackedFiles ?? []).flatMap((f) => (f && typeof f.path === "string" ? [f.path] : []));

/** 版の tracked が HEAD から変えた path。object が無い / id でない時は空(当てる段で落ちて当て直しに入る) */
function trackedChanges(cwd: string, state: GitState): string[] {
  if (!state.trackedPatch || !OBJECT_ID_RE.test(state.trackedPatch)) return [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "-z", "HEAD", state.trackedPatch], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export class RollbackFailedError extends Error {
  readonly code = "rollback_failed";
  /** restored = 当て直しが通り tree は実行前と同じ。false = 当て直しも落ちた(今の状態は呼び手が先に書いた CAS に在る) */
  constructor(
    readonly restored: boolean,
    readonly reason: string,
  ) {
    super(`rollback_failed: ${reason}`);
    this.name = "RollbackFailedError";
  }
}

/** 版と同じ場所か(PBI-0575): HEAD = 版の baseCommit で、tracked に未 commit の変更が無い(untracked は数えない ——
 * 書くのは版の untracked の path だけで、そこは assertEntriesWithinCwd が見る)。ここでだけ tracked を exact に置いてよい
 * (read-tree は tree を上書きするので、今の tracked の変更が在れば消え、HEAD が違えば進んだ commit の変更を版の base に戻す) */
function sameSpotAsVersion(cwd: string, state: GitState): boolean {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd, encoding: "utf8" });
    return head === state.baseCommit && dirty === "";
  } catch {
    return false;
  }
}

/**
 * 版の tracked を exact に置く(rollback と、版と同じ場所への apply・PBI-0550 / 0575)。working tree = stash commit の tree
 * (`read-tree --reset -u`)・index = staged の tree(`read-tree --reset`)。`stash apply` と違い staged を staged のまま置き、
 * reflog / ORIG_HEAD / AUTO_MERGE を書かない(`stash apply --index` は staged が在ると内部で reset を打つ = 実測 2026-09-14)。
 * **tree を上書きする** —— 呼び手が「今の変更は失われない」を確かめてから呼ぶ(rollback = 先に固めた / apply = sameSpotAsVersion)。
 * CAS の payload は信用しない: object id 以外(`--output=…` 等の option・rev の式)を git に渡さない・stash commit の親が
 * baseCommit でなければ置かない(read-tree は 3-way merge をしない)
 */
function placeTrackedExact(cwd: string, state: GitState): void {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_OUTPUT_MAX_BYTES }).trim();
  const w = state.dirty > 0 ? state.trackedPatch : null;
  if (!w) {
    git(["read-tree", "--reset", "-u", "HEAD^{tree}"]);
    return;
  }
  const staged = state.stagedPatch ?? state.baseCommit;
  if (!OBJECT_ID_RE.test(w) || !staged || !OBJECT_ID_RE.test(staged)) throw new Error("the version's tracked changes are not object ids");
  const parent = git(["rev-parse", "--verify", `${w}^1`]);
  if (parent !== state.baseCommit) {
    throw new Error(`the version's tracked changes were taken on ${parent.slice(0, 7)}, not on ${String(state.baseCommit).slice(0, 7)}`);
  }
  git(["read-tree", "--reset", "-u", `${w}^{tree}`]);
  git(["read-tree", "--reset", `${staged}^{tree}`]);
}

/**
 * `prepareRollback` が ok を返し、呼び手が current を CAS へ書いた後に呼ぶ。untracked(current と target の path)を消し、
 * tracked は **`git stash apply` を使わず** `read-tree` で直接置く: working tree = stash commit の tree(`--reset -u`)、
 * index = staged の tree(`--reset`)。`stash apply --index` は staged の変更が在ると内部で reset を打ち、HEAD の reflog
 * (`reset: moving to HEAD`)・ORIG_HEAD・AUTO_MERGE を書く(実測 2026-09-14)ので、HEAD 周りを書かない壁が破れる。
 * read-tree は 3-way merge をしないので、stash commit の親が版の baseCommit でなければ当てない(別の base の上の変更を
 * 黙って置かない)。途中で落ちたら**同じ手順で current を当て直して** throw する。
 * 当て直しに使うのは引数の current だけ(tree を触った後に固め直すと、崩れた tree を「元」として当てる)。
 */
export function rollbackWorkingTree(cwd: string, current: GitState, target: GitState): void {
  const paths = [...new Set([...untrackedPaths(current), ...untrackedPaths(target)])];
  for (const p of paths) resolveWithinCwd(cwd, p);
  const putBack = (state: GitState): void => {
    for (const p of paths) removeUntracked(cwd, p);
    placeTrackedExact(cwd, state);
    applyGitCheckpoint(cwd, { ...state, trackedPatch: null }); // untracked だけを書く(tracked は上で置いた)
  };
  const why = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? "").trim() || (e instanceof Error ? e.message : String(e));
  try {
    putBack(target);
  } catch (e) {
    try {
      putBack(current);
    } catch (e2) {
      throw new RollbackFailedError(false, why(e2));
    }
    throw new RollbackFailedError(true, why(e));
  }
}

/** untracked の 1 path を消し、空になった親 dir を cwd の手前まで畳む(残ると同じ名前の file を当てられない) */
function removeUntracked(cwd: string, path: string): void {
  const abs = join(cwd, path);
  rmSync(abs, { force: true });
  for (let dir = dirname(abs); relative(cwd, dir) !== "" && !relative(cwd, dir).startsWith(".."); dir = dirname(dir)) {
    try {
      rmdirSync(dir);
    } catch {
      break; // 空でない(= 他の file が在る)ならそこで止める
    }
  }
}
