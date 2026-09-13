import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { legacyDir, LEGACY_STATE_DIR, STATE_DIR } from "@openroly/core";

// pairing で得た runtime credential のローカル保管(要件 §15.2「API key の copy/paste を
// 標準 UX にしない」)。runtime kind ごとに 1 entry —— 1 runtime = 1 credential = 1 runtime_id
// (要件 §15.1)。単一 token にすると 2 つ目の pair が 1 つ目を上書きし、
// per-actor read state(§23.1)が 1 actor に潰れる。
//
// 書き込みは「1 file に複数 kind の map」なので read-modify-write になる。
// `openroly install claude` と `openroly install codex` は同時に走りうるため、load〜write を
// lock file で直列化し、temp file 名はプロセス固有にする(共有 temp 名だと後発の
// rename が ENOENT で落ち、先発の内容も失われる)。

export interface RuntimeCredential {
  runtime_id: string;
  token: string;
  base_url: string;
  /** §32.4 の "MacBook / Claude Code" 表示に使う */
  name: string;
  paired_at: string;
}

export interface CredentialFile {
  version: 1;
  /**
   * `openroly login` が決めた account の server URL(PBI-0246・図7.1)。**runtime ごとの
   * credential とは別の面** —— まだ pair していない runtime には引き継ぐ credential が
   * 無いので、`openroly pair claude` が既定値の localhost へ落ちる。account に 1 つ持つ。
   * URL 自体は秘密ではないが、token と同じ file に置く以上は同じ 0600・同じ lock に従う。
   */
  account_url?: string;
  runtimes: Record<string, RuntimeCredential>;
}

type Env = Record<string, string | undefined>;

/** lock 待ちの上限。超えたら「別プロセスが使用中」として明示的に失敗する */
const LOCK_TIMEOUT_MS = 5_000;
/** 保持者が死んで取り残された lock を壊すまでの経過時間 */
const LOCK_STALE_MS = 30_000;

export function openrolyHome(env: Env = process.env): string {
  // PBI-0414 review: `bun test` は既定で NODE_ENV=test を立てる(apps/server/src/db.ts と同じ
  // 判定 — このリポジトリで既に信用されている検知法)。isolate し忘れて OPENROLY_HOME が
  // 未設定のまま in-process test がここを通ると、実行者本人の本物の ~/.openroly に書き込む
  // (PBI-0414 実装中に実際に発生した事故)。呼び出し側(test file)ごとに isolate を足す運用は
  // 次の PBI で必ず再発するので、ここ 1 箇所で拒否する。
  // **`process.env.NODE_ENV` と書かない**: この file は packages/mcp/src/server.ts 経由で配布
  // plugin の bundle(`bun build --target=bun`)に含まれる。bun のバンドラは `process.env.NODE_ENV`
  // の**字面**を build 時点の値で静的に inline する(実測: NODE_ENV=test で bundle すると
  // `=== "test"` が `true` に固定される)。build 環境にたまたま NODE_ENV=test が立っていると、
  // 配布物が実行時の NODE_ENV に関係なく常に throw する壊れた plugin になる。key を変数経由の
  // bracket access にすると bun は特別扱いせず、素直な実行時参照のまま残る(実測で確認済み)
  const nodeEnvKey = "NODE_ENV";
  if (env.OPENROLY_HOME === undefined && process.env[nodeEnvKey] === "test") {
    throw new Error(
      "openrolyHome: OPENROLY_HOME is not set while running under `bun test`. " +
        "This would fall back to the real ~/.openroly. Set OPENROLY_HOME (e.g. via mkdtemp) before this code runs.",
    );
  }
  // 旧 `~/.atn` だけが在る端末ではそれを引き継ぐ(PBI-0344 AC-3。警告は legacyDir が 1 行出す)
  return env.OPENROLY_HOME ?? legacyDir(join(homedir(), STATE_DIR), join(homedir(), LEGACY_STATE_DIR), existsSync);
}

export function credentialsPath(env: Env = process.env): string {
  return join(openrolyHome(env), "credentials.json");
}

export async function loadCredentials(env: Env = process.env): Promise<CredentialFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8")) as CredentialFile;
    if (parsed?.version !== 1 || typeof parsed.runtimes !== "object") {
      throw new Error(`unsupported credentials file: ${credentialsPath(env)}`);
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runtimes: {} };
    throw e;
  }
}

export async function getCredential(
  kind: string,
  env: Env = process.env,
): Promise<RuntimeCredential | undefined> {
  return (await loadCredentials(env)).runtimes[kind];
}

/**
 * `openroly login` が決めた account の URL。無ければ undefined。
 * 手で編集された file(数値・空文字)は「無い」として扱う —— 壊れた 1 行で全 command を
 * 落とすより、既定へ落ちて **URL を名乗って**失敗する方が直せる
 */
export async function getAccountUrl(env: Env = process.env): Promise<string | undefined> {
  const saved = (await loadCredentials(env)).account_url;
  return typeof saved === "string" && saved !== "" ? saved : undefined;
}

/**
 * account の URL を書く。credential と同じ lock の中で read-modify-write するので、
 * 同時に走る `openroly login` / `openroly install` が互いの entry を消さない(後勝ち・半端な file を残さない)
 */
export async function saveAccountUrl(url: string, env: Env = process.env): Promise<void> {
  const clean = url.replace(/\/$/, "");
  await withCredentialLock(env, async () => {
    const file = await loadCredentials(env);
    file.account_url = clean;
    await writeCredentials(file, env);
  });
}

/** 既存 entry を保ったまま 1 kind を書き換える。file mode は 0600(他 user から読めない) */
export async function saveCredential(
  kind: string,
  credential: RuntimeCredential,
  env: Env = process.env,
): Promise<void> {
  await withCredentialLock(env, async () => {
    const file = await loadCredentials(env);
    file.runtimes[kind] = credential;
    await writeCredentials(file, env);
  });
}

export async function removeCredential(kind: string, env: Env = process.env): Promise<boolean> {
  return withCredentialLock(env, async () => {
    const file = await loadCredentials(env);
    if (!(kind in file.runtimes)) return false;
    delete file.runtimes[kind];
    await writeCredentials(file, env);
    return true;
  });
}

/** load〜write を直列化する。同時 install が互いの entry を消さないための唯一の砦 */
async function withCredentialLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, fn);
}

/**
 * `<path>.lock` を wx-open で取り、`fn` の間だけ保持する(credentials.json と、generic adapter が
 * 書く runtime の config file(PBI-0210)が同じ型で read-modify-write を直列化する)。
 * 派生 file の綴り(`.lock` / `.tmp`)はこの file の 2 関数だけが作る —— `with_extension` 型の
 * 「拡張子を置き換える」綴りにすると `x.json` と `x.yaml` の lock が衝突する。
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      // wx = 既存なら EEXIST。これが lock の獲得そのもの
      await (await open(lockPath, "wx", 0o600)).close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lockPath)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The file is in use by another process: ${lockPath}\n` +
            "Wait for the other 'openroly install' to finish, or delete the lock if it is stale",
        );
      }
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function writeCredentials(file: CredentialFile, env: Env): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/**
 * 途中で落ちても壊れた file を残さないよう temp → rename で書く(credentials.json と、generic
 * adapter が書く runtime の config(PBI-0210)の共通の型)。temp 名はプロセス固有
 * (共有名だと同時実行が互いの temp を上書きし rename が ENOENT)。`mode` を渡した時だけ
 * 0600 等に固定する。**渡さない時は既存 file の mode を引き継ぐ** —— rename は inode ごと
 * 差し替えるので、引き継がないと人が `chmod 600` した file(runtime の config・CLAUDE.md)が
 * 黙って umask 既定(0644)に開く(PBI-0214 有界レビューで実測: 0600 → 0644)。
 */
export async function writeFileAtomic(path: string, text: string, mode?: number): Promise<void> {
  const keep = mode ?? (await stat(path).then((s) => s.mode & 0o7777).catch(() => undefined));
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, text, keep !== undefined ? { mode: keep } : {});
    if (keep !== undefined) await chmod(tmp, keep);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  if (keep !== undefined) await chmod(path, keep);
}

// ---------- 端末に留まる秘密(PBI-0212 / アーキ §40) ----------

/**
 * 吸い上げた env の値を置く場所。**Account へは `env:NAME` という名前しか行かない**ので、
 * 値の唯一の在り処がこの file になる。credentials.json と同じ dir・同じ 0600・同じ lock
 * (`~/.openroly` は 0700 で作られる)。
 */
export function secretsPath(env: Env = process.env): string {
  return join(openrolyHome(env), "secrets.json");
}

interface SecretsFile {
  version: 1;
  env: Record<string, string>;
}

/**
 * 保存済みの env 値。**壊れている file は throw する**(空として扱わない) —— 空に倒すと
 * `openroly share` の merge が既存の秘密を丸ごと消し、他の extension が次の sync で無言で壊れる。
 */
export async function loadSecrets(env: Env = process.env): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(secretsPath(env), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const parsed = JSON.parse(text) as SecretsFile;
  if (parsed?.version !== 1 || parsed.env == null || typeof parsed.env !== "object") {
    throw new Error(`unsupported secrets file: ${secretsPath(env)}`);
  }
  return parsed.env;
}

/**
 * env 値を足す(既存は残す・同名は上書き)。**後勝ち**でよい —— 同じ名前の別の値が 2 つの
 * runtime に在る時は、そもそも Account 側で 1 本の `env:NAME` に潰れるので、端末側で
 * 分けても意味が無い(分けたいなら名前を変えるのが唯一の道)。
 */
export async function mergeSecrets(entries: Record<string, string>, env: Env = process.env): Promise<void> {
  const path = secretsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withFileLock(path, async () => {
    const merged: SecretsFile = { version: 1, env: { ...(await loadSecrets(env)), ...entries } };
    await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  });
}

/**
 * 前回 share した提案の fingerprint 集合(`openroly share --auto` の差分用)。
 * **消えた物は提案しない**(削除は配らない)ので、集合は「今回送った物」で毎回置き換える。
 * 壊れていたら空に倒す —— こちらは秘密ではなく再送の抑制でしかないので、最悪 1 回多く送るだけ。
 */
export function shareStatePath(env: Env = process.env): string {
  return join(openrolyHome(env), "share-state.json");
}

export async function loadShareState(env: Env = process.env): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(shareStatePath(env), "utf8")) as { fingerprints?: unknown };
    return new Set(Array.isArray(parsed?.fingerprints) ? parsed.fingerprints.map(String) : []);
  } catch {
    return new Set();
  }
}

export async function saveShareState(fingerprints: Iterable<string>, env: Env = process.env): Promise<void> {
  const path = shareStatePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, fingerprints: [...fingerprints] }, null, 2)}\n`, 0o600);
}
