// `@openroly/core/node` —— **node builtin を使う物だけ**をここから出す(PBI-0427)。
// `@openroly/core`(= index.ts)は web(vite)の bundle にも入るので node builtin を 1 つも持たない
// (PBI-0380: env.ts / 2026-09-12: capsule.ts と git-checkpoint.ts が web build を殺した)。
// 足す時: node:fs / node:child_process / node:path 等を import する module はこちらへ。
export * from "./git-checkpoint.ts";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { validateCapsule, type CapsuleVerdict } from "./protocol.ts";

/** PAAP capsule directory を読んで validateCapsule に渡す(PBI-0552)。判定は protocol.ts、ここは file を集めるだけ。
 * symlink は辿らない(file として数えない = manifest に載っていれば contents mismatch で落ちる) */
export function validateCapsuleDir(dir: string): CapsuleVerdict {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    files[relative(dir, abs).split(sep).join("/")] = readFileSync(abs);
  }
  return validateCapsule(files);
}
