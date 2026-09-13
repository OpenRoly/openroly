// `@openroly/core/node` —— **node builtin を使う物だけ**をここから出す(PBI-0427)。
// `@openroly/core`(= index.ts)は web(vite)の bundle にも入るので node builtin を 1 つも持たない
// (PBI-0380: env.ts / 2026-09-12: capsule.ts と git-checkpoint.ts が web build を殺した)。
// 足す時: node:fs / node:child_process / node:path 等を import する module はこちらへ。
export * from "./git-checkpoint.ts";
