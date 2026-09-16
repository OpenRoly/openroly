import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { bundlePath, ensurePluginBundle } from "./ensure-bundle.ts";

// PBI-0112 → PBI-0597: plugin に入れる `mcp-server.bundle.js` は cache が plugin dir だけを copy する
// 構造上、source と同期していないと「install した環境でだけ壊れる」バグになる。
//
// PBI-0112 はそれを「commit 済み bundle と再 build の byte 一致」で刺していた。**検出はできていたが
// 止められなかった** —— 作り直しが手作業で、赤くなるのは commit の後だったので、3 度 main に載った
// (PBI-0581 / 0594 / PBI-0230 の取り込み)。PBI-0597 で **追跡そのものをやめた**ので、この file が
// 守るのは「生成物が git に戻っていないか」と「plugin dir の中身の形」になる。
// 同期そのものは「使う時に作る」で構造的に保たれる(ensure-bundle.ts / install / CI の 1 step)。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE = "mcp-server.bundle.js";

/** repo が追跡している file 一覧(`git ls-files`)。生成物が戻っていないかを見る */
function trackedFiles(pattern: string): string[] {
  const out = Bun.spawnSync(["git", "ls-files", pattern], { cwd: repoRoot, stdout: "pipe" });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString().split("\n").filter(Boolean);
}

describe("plugin bundle は生成物 (PBI-0597)", () => {
  test("AC-1: bundle は git で追跡されていない(追跡し直すとここが赤くなる)", () => {
    expect(trackedFiles("*.bundle.js")).toEqual([]);
    // .gitignore が効いている = 作った後も `git status` を汚さない(commit に紛れ込まない)
    ensurePluginBundle();
    const ignored = Bun.spawnSync(
      ["git", "check-ignore", "adapters/official/claude/mcp-server.bundle.js"],
      { cwd: repoRoot, stdout: "pipe" },
    );
    expect(ignored.exitCode).toBe(0);
  }, 120_000);

  test("AC-2: 無ければ作られ、両 plugin dir に同じ中身が置かれる", () => {
    ensurePluginBundle();
    for (const runtime of ["claude", "codex"] as const) {
      expect(existsSync(bundlePath(runtime))).toBe(true);
    }
    // cache がどちらの runtime を copy しても同じ物が動く
    expect(readFileSync(bundlePath("codex"))).toEqual(readFileSync(bundlePath("claude")));
  }, 120_000);

  test("PBI-0132: 両 plugin の launcher が source と byte 一致し、実行可能である", () => {
    // launcher(5 KB の sh)は **追跡したまま**: 中身が読める text で、diff が意味を持ち、
    // churn も 2 commit しかない。bundle(1.1 MB の binary)と同じ扱いにする理由が無い
    ensurePluginBundle(); // plugin:build が launcher の copy も作る(手順の正本は 1 つ)
    const source = readFileSync(join(repoRoot, "packages/mcp/openroly-mcp"));
    for (const dir of ["adapters/official/claude", "adapters/official/codex"]) {
      const copy = join(repoRoot, dir, "openroly-mcp");
      expect(readFileSync(copy)).toEqual(source);
      expect(statSync(copy).mode & 0o111).toBeGreaterThan(0);
    }
  }, 120_000);

  test("AC-1(旧): 両 .mcp.json の args が各自の plugin root 変数の bundle を指す", () => {
    const claude = JSON.parse(
      readFileSync(join(repoRoot, "adapters/official/claude/.mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { args: string[]; command: string }> };
    const codex = JSON.parse(
      readFileSync(join(repoRoot, "adapters/official/codex/.mcp.json"), "utf8"),
    ) as { mcp_servers: Record<string, { args: string[]; command: string }> };
    expect(claude.mcpServers.openroly!.args).toEqual([`\${CLAUDE_PLUGIN_ROOT}/${BUNDLE}`]);
    expect(codex.mcp_servers.openroly!.args).toEqual([`\${PLUGIN_ROOT}/${BUNDLE}`]);
    // PBI-0132: command 側は launcher。args(bundle)は fallback 経路の材料として残す
    expect(claude.mcpServers.openroly!.command).toBe("${CLAUDE_PLUGIN_ROOT}/openroly-mcp");
    expect(codex.mcp_servers.openroly!.command).toBe("${PLUGIN_ROOT}/openroly-mcp");
  });
});
