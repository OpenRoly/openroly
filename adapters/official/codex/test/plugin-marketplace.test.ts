import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ensurePluginBundle } from "../../../../packages/mcp/test/ensure-bundle.ts";

// PBI-0097 review(有界)の攻撃 test。marketplace install は codex CLI 0.150.1 でも plugin 本体を
// 検査しない(AC-X2 実測: cache dir だけ作る)ため「source path の正しさは機械で守る」が G2 の
// bash 実測のままで suite に入っていなかった —— 正本 repo の file 構造を test として固定する。
// repo root はこの file から 4 階層上(test → codex → official → adapters)。
const repoRoot = join(import.meta.dir, "../../../..");
const codexPluginDir = join(repoRoot, "adapters/official/codex");
const claudePluginDir = join(repoRoot, "adapters/official/claude");

describe("codex plugin marketplace の構造 (PBI-0097 review)", () => {
  test("marketplace.json の plugins[0] が codex plugin 本体を指す(AC-1 の機械固定・AC-X2 の代替検査)", () => {
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, ".agents/plugins/marketplace.json"), "utf8"),
    ) as {
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    };
    expect(marketplace.name).toBe("openroly");
    const entry = marketplace.plugins.find((p) => p.name === "openroly");
    expect(entry).toBeDefined();
    // source.path が実際に plugin 本体(.codex-plugin/plugin.json)へ解決する。CLI は検査しないので
    // path の typo / dir 移動への唯一の防壁がこの test(旧 diagrams-check の図7 規則は入口の存在だけ)
    expect(entry!.source.source).toBe("local");
    const resolved = join(repoRoot, entry!.source.path);
    expect(existsSync(join(resolved, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  test("plugin.json が install 可能な最小 field を持つ", () => {
    const plugin = JSON.parse(
      readFileSync(join(codexPluginDir, ".codex-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string; description: string };
    expect(plugin.name).toBe("openroly");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  test(".mcp.json は claude 版と同型で、plugin root 変数と runtime 名だけが codex 側の値(AC-3)", () => {
    const claude = JSON.parse(readFileSync(join(claudePluginDir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, McpEntry>;
    };
    const codex = JSON.parse(readFileSync(join(codexPluginDir, ".mcp.json"), "utf8")) as {
      mcp_servers: Record<string, McpEntry>;
    };
    // config の server 辞書の key 名だけが runtime 間で違う(mcpServers / mcp_servers)。
    // それ以外は command・args の形・env が同型 —— 片方だけ壊れたらこの test が刺す
    expect(Object.keys(claude.mcpServers)).toEqual(["openroly"]);
    expect(Object.keys(codex.mcp_servers)).toEqual(["openroly"]);
    const claudeEntry = claude.mcpServers.openroly!;
    const codexEntry = codex.mcp_servers.openroly!;
    // PBI-0132: command は plugin dir 内の launcher(sh)。binary → bun の分岐を静的 JSON の外に置く
    expect(claudeEntry.command).toBe("${CLAUDE_PLUGIN_ROOT}/openroly-mcp");
    expect(codexEntry.command).toBe("${PLUGIN_ROOT}/openroly-mcp");
    // 各 file は自分の runtime の plugin root 変数だけを参照する(他方の変数の混入 = 破れ)。
    // 起動対象は bundle(PBI-0112: cache が plugin dir だけを copy する構造上 repo 参照 launcher は不可)
    expect(claudeEntry.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp-server.bundle.js"]);
    expect(codexEntry.args).toEqual(["${PLUGIN_ROOT}/mcp-server.bundle.js"]);
    expect(JSON.stringify(codex)).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(JSON.stringify(claude)).not.toContain("${PLUGIN_ROOT}");
    // runtime 名の取り違え(claude 用 plugin で codex を起動する等)を刺す
    expect(claudeEntry.env?.OPENROLY_RUNTIME_KIND).toBe("claude");
    expect(codexEntry.env?.OPENROLY_RUNTIME_KIND).toBe("codex");
    // args が参照する bundle が plugin 本体 dir に実在する(cache 内完結性の前提・図7)。
    // PBI-0597: bundle は追跡していない生成物なので、ここで「無ければ作る」を通してから見る
    ensurePluginBundle();
    expect(existsSync(join(claudePluginDir, "mcp-server.bundle.js"))).toBe(true);
    expect(existsSync(join(codexPluginDir, "mcp-server.bundle.js"))).toBe(true);
    // command が指す launcher も同じく plugin dir 内に在る(PBI-0132。cache 内完結性は command 側にも要る)
    expect(existsSync(join(claudePluginDir, "openroly-mcp"))).toBe(true);
    expect(existsSync(join(codexPluginDir, "openroly-mcp"))).toBe(true);
  });
});

interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// PBI-0096 review(有界)。README は公開 repo(shibu003/openroly)側の成果物で正本 repo には無い。
// 公開 clone が兄弟 dir に在る環境でだけ順序を検査し、無い環境では skip(機械検査の不足を隠さない)。
const publicReadme = join(repoRoot, "..", "openroly", "README.md");
const hasPublicClone = existsSync(publicReadme);

describe("公開 repo README の quickstart 順序 (PBI-0096 review)", () => {
  test.skipIf(!hasPublicClone)(
    "plugin 2 行が git clone の block より先に在り・重複行は無い(AC-1 + AC-X1 の再検査)",
    () => {
      const readme = readFileSync(publicReadme, "utf8");
      const lines = readme.split("\n");
      const indexOfLine = (needle: string) =>
        lines.findIndex((l) => l.trim() === needle);
      // PBI-0108 の hero 再構成後も quickstart の順序が保たれている事(PBI-0108 側の改稿で壊れない)。
      // PBI-0154 で先頭は source clone ではなく binary の取得(curl)になった —— 順序の意図は
      // 「何も持っていない人の道が先・既に runtime の中に居る人の道が後」で変わらないので、
      // 基準を clone から binary quickstart に移す(clone 節は今の README には無い)。
      const binaryLine = lines.findIndex((l) => l.includes("releases/latest/download/openroly-"));
      const claudeLine = indexOfLine("claude plugin marketplace add openroly/openroly");
      const codexLine = indexOfLine("codex plugin marketplace add openroly/openroly");
      expect(binaryLine).toBeGreaterThanOrEqual(0);
      expect(claudeLine).toBeGreaterThan(binaryLine);
      expect(codexLine).toBeGreaterThan(claudeLine);
      // source からの道を戻す時も、それは plugin の後(先頭を占めない)
      const cloneLine = lines.findIndex((l) => l.includes("git clone"));
      if (cloneLine >= 0) expect(cloneLine).toBeGreaterThan(codexLine);
      // 重複行の混入を刺す(AC-X1 の「README 側に重複行は増えない」の機械固定)
      const countOf = (needle: string) => lines.filter((l) => l.trim() === needle).length;
      expect(countOf("claude plugin marketplace add openroly/openroly")).toBe(1);
      expect(countOf("codex plugin marketplace add openroly/openroly")).toBe(1);
    },
  );
});
