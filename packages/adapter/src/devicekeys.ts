import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateDeviceKeyPair } from "@paa/crypto-envelope";
import { paaHome } from "./credentials.ts";

// E2EE device keypair のローカル保管(要件 §9-11、PBI-0006)。
// `credentials.json` とは**別ファイル**にする: saveCredential は entry 丸ごと置換なので、
// もし同居させると `atn install claude` の再実行(通常の再pairing経路)で private key が
// 黙って消え、その鍵で seal 済みの過去メッセージが恒久的に復号不能になる
// (EP-0001 LEARN #5「credential を単一 token で持つと壊れる」と同型の事故)。
// lock/atomic-write は credentials.ts と同じパターンをこのファイル内に個別実装する
// (既存の安定モジュールへの変更リスクを避けるため、本 PBI では共通化を見送る)。

export interface DeviceKeyRecord {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  createdAt: string;
}

interface DeviceKeyFile {
  version: 1;
  devices: Record<string, DeviceKeyRecord>;
}

type Env = Record<string, string | undefined>;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export function deviceKeysPath(env: Env = process.env): string {
  return join(paaHome(env), "device-keys.json");
}

async function loadFile(env: Env): Promise<DeviceKeyFile> {
  try {
    const parsed = JSON.parse(await readFile(deviceKeysPath(env), "utf8")) as DeviceKeyFile;
    if (parsed?.version !== 1 || typeof parsed.devices !== "object") {
      throw new Error(`unsupported device-keys file: ${deviceKeysPath(env)}`);
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, devices: {} };
    throw e;
  }
}

async function writeFileAtomic(file: DeviceKeyFile, env: Env): Promise<void> {
  const path = deviceKeysPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await chmod(path, 0o600);
}

async function withLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const path = deviceKeysPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
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
        throw new Error(`The device-keys store is in use by another process: ${lockPath}`);
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

async function freshRecord(): Promise<DeviceKeyRecord> {
  const kp = await generateDeviceKeyPair();
  return {
    keyId: kp.keyId,
    publicJwk: kp.publicJwk,
    privateJwk: kp.privateJwk,
    createdAt: new Date().toISOString(),
  };
}

/** kind(runtime credential と同じ単位)ごとに device keypair を 1 つ持つ。無ければ生成して永続化する */
export async function getOrCreateDeviceKey(
  kind: string,
  env: Env = process.env,
): Promise<DeviceKeyRecord> {
  const existing = (await loadFile(env)).devices[kind];
  if (existing) return existing;

  return withLock(env, async () => {
    const file = await loadFile(env);
    const found = file.devices[kind];
    if (found) return found;
    const record = await freshRecord();
    file.devices[kind] = record;
    await writeFileAtomic(file, env);
    return record;
  });
}

/** その kind の鍵を手元に持っているか(**作らない**。pairing の後に「名乗る鍵が在るか」を見る為) */
export async function hasDeviceKey(kind: string, env: Env = process.env): Promise<boolean> {
  return (await loadFile(env)).devices[kind] !== undefined;
}

/**
 * その kind の鍵を **捨てて作り直す**(PBI-0253 有界レビュー)。呼んでよいのは
 * **人が pairing を承認し直した直後**だけ(`pairRuntime` → `reconnectOwnDevice`)。
 * 人が Revoke を押した device の鍵は server 側で二度と登録できない(409 device_revoked)が、
 * 秘密鍵は手元に残るので、作り直す口が無いとその runtime は永久に詰む。
 * agent が自分の判断でここを呼ぶと、押した Revoke が新しい id で黙って取り消される —— 呼び出し元を増やさない
 * (diagrams-check が `reconnectOwnDevice` 以外の呼び出しを数える)。
 */
export async function rotateDeviceKey(kind: string, env: Env = process.env): Promise<DeviceKeyRecord> {
  return withLock(env, async () => {
    const file = await loadFile(env);
    const record = await freshRecord();
    file.devices[kind] = record;
    await writeFileAtomic(file, env);
    return record;
  });
}
