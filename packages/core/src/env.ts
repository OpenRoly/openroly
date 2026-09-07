// 改名の互換(PBI-0344 AC-3)。旧 env 名(`PAA_*`)と旧 state dir(`~/.atn`)は**少なくとも
// 1 release は読み続け、使った時だけ 1 行警告する**。「旧を読める」は release note ではなく
// test で保証する。新名が在る時は常に新名が勝つ(両方在る時の所属を曖昧にしない)。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "OPENROLY_";
export const LEGACY_ENV_PREFIX = "PAA_";
export const STATE_DIR = ".openroly";
export const LEGACY_STATE_DIR = ".atn";

type Env = Record<string, string | undefined>;

/** 警告は種別ごとに 1 process 1 行。毎回出すと log が警告で埋れる */
function onceWarn(): (line: string) => void {
  let done = false;
  return (line: string) => {
    if (done) return;
    done = true;
    console.error(line);
  };
}

/**
 * 旧 env 名(`PAA_*`)を新名(`OPENROLY_*`)へ採り込む。entrypoint(CLI / MCP server / server)の
 * 最初に 1 回呼ぶ。**新名が既に在る key は触らない**ので、両方在る時は新名が勝つ。
 * 採用した旧名は 1 行にまとめて stderr へ出す。
 * @returns 採用した旧 env 名の一覧(test が値で検査する)
 */
export function adoptLegacyEnv(env: Env = process.env, warn = onceWarn()): string[] {
  const adopted: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) continue;
    const newName = `${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[newName] !== undefined) continue;
    env[newName] = env[name]!;
    adopted.push(name);
  }
  if (adopted.length > 0) {
    warn(`[openroly] legacy env names were read (support ends in a future release): ${adopted.join(" ")}`);
  }
  return adopted;
}

/**
 * 「新しい場所を既定に、旧の場所だけが在る端末ではそれを引き継ぐ」1 関数。state dir の互換
 * (`~/.openroly` ← `~/.atn`)はこれ 1 本で表す。新が在る/両方無い → 新。旧だけ在る → 旧 + 警告 1 行。
 */
export function legacyDir(
  fresh: string,
  legacy: string,
  exists: (p: string) => boolean = existsSync,
  warn: (line: string) => void = onceWarn(),
): string {
  if (exists(fresh) || !exists(legacy)) return fresh;
  warn(
    `[openroly] legacy state directory ${legacy} is in use — move it to ${fresh} (support ends in a future release)`,
  );
  return legacy;
}
