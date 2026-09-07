import { readFileSync, existsSync, rmSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

// PBI-0112: plugin に入れる `mcp-server.bundle.js` は cache が plugin dir だけを copy する
// 構造上、source と同期していないと「install した環境でだけ壊れる」バグになる。
// それを機械で刺す: tmp で再 build して byte 比較し、両 plugin dir の bundle の同一性と
// `.mcp.json` の args も一緒に固定する(手順の正本は `bun run plugin:build`)。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE = "mcp-server.bundle.js";
const claudeBundle = join(repoRoot, "adapters/official/claude", BUNDLE);
const codexBundle = join(repoRoot, "adapters/official/codex", BUNDLE);

/** `bun run plugin:build` と同じ command を 1 dir 分だけ tmp 向けに実行する */
function buildToTmp(outfile: string): void {
  const proc = Bun.spawnSync(
    ["bun", "build", "packages/mcp/src/server.ts", "--target=bun", "--outfile", outfile],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  expect(proc.exitCode).toBe(0);
}

describe("plugin bundle の同期 (PBI-0112)", () => {
  test("AC-4: commit 済み bundle は source からの再 build と byte 一致する", () => {
    expect(existsSync(claudeBundle)).toBe(true);
    expect(existsSync(codexBundle)).toBe(true);
    const tmp = join(repoRoot, "packages/mcp/test/.bundle-sync-tmp");
    try {
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      // claude 側の実 build を 1 度だけ回し、codex 側は同一性 test で賄う(重い build を 2 回やらない)
      buildToTmp(join(tmp, BUNDLE));
      expect(readFileSync(claudeBundle)).toEqual(readFileSync(join(tmp, BUNDLE)));

      // 両 plugin dir の bundle が互いに一致(cache がどちらの runtime でも同じ中身を運ぶ)
      expect(readFileSync(codexBundle)).toEqual(readFileSync(claudeBundle));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test("PBI-0132: 両 plugin の launcher が source と byte 一致し、実行可能である", () => {
    // bundle と同じ理由: cache は plugin dir だけを copy するので、source(packages/mcp/openroly-mcp)と
    // ずれると「install した環境でだけ起動しない」になる。実行権が落ちるのも同じ壊れ方
    const source = readFileSync(join(repoRoot, "packages/mcp/openroly-mcp"));
    for (const dir of ["adapters/official/claude", "adapters/official/codex"]) {
      const copy = join(repoRoot, dir, "openroly-mcp");
      expect(readFileSync(copy)).toEqual(source);
      expect(statSync(copy).mode & 0o111).toBeGreaterThan(0);
    }
  });

  test("AC-1: 両 .mcp.json の args が各自の plugin root 変数の bundle を指す", () => {
    const claude = JSON.parse(
      readFileSync(join(repoRoot, "adapters/official/claude/.mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { args: string[]; command: string }> };
    const codex = JSON.parse(
      readFileSync(join(repoRoot, "adapters/official/codex/.mcp.json"), "utf8"),
    ) as { mcp_servers: Record<string, { args: string[]; command: string }> };
    expect(claude.mcpServers.openroly!.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp-server.bundle.js"]);
    expect(codex.mcp_servers.openroly!.args).toEqual(["${PLUGIN_ROOT}/mcp-server.bundle.js"]);
    // PBI-0132: command 側は launcher。args(bundle)は fallback 経路の材料として残す
    expect(claude.mcpServers.openroly!.command).toBe("${CLAUDE_PLUGIN_ROOT}/openroly-mcp");
    expect(codex.mcp_servers.openroly!.command).toBe("${PLUGIN_ROOT}/openroly-mcp");
  });
});
