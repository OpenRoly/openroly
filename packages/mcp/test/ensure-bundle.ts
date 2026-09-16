import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0597: plugin の MCP bundle は **生成物なので git で追跡しない**。追跡していた頃は
// `packages/mcp/src` を触る commit が 1.1 MB を道連れにし、作り直し忘れが 3 度 main に載った
// (PBI-0581 / 0594 / #22 の取り込み)。検査は在ったが「commit の後に赤くなる」形だった。
//
// 追跡をやめた代わりに、**bundle を要る test は自分で作ってから使う**。作るのは
// `bun run plugin:build`(手順の正本は package.json の 1 箇所。ここで build 行を写さない)。
// 既に在れば作り直さない —— 1 回の build が 3〜10 秒あり、4 file が毎回やると suite が伸びる。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** plugin dir の bundle(claude / codex)。`.mcp.json` の args が指す file */
export const bundlePath = (runtime: "claude" | "codex"): string =>
  join(repoRoot, "adapters/official", runtime, "mcp-server.bundle.js");

/**
 * 両 plugin dir の bundle と launcher を「無ければ作る」。返すのは claude 側の path
 * (呼び手の多くが 1 本しか使わない)。build に失敗したら投げる —— 黙って進むと
 * 「bundle が無いから落ちた」が「実装が壊れている」に化ける。
 */
export function ensurePluginBundle(): string {
  const claude = bundlePath("claude");
  if (!existsSync(claude) || !existsSync(bundlePath("codex"))) {
    const built = Bun.spawnSync(["bun", "run", "plugin:build"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (built.exitCode !== 0) {
      throw new Error(`bun run plugin:build failed: ${built.stderr.toString()}`);
    }
  }
  return claude;
}
