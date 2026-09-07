import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMcpConfigAdapter,
  withInstructions,
  type AdapterContext,
  type RuntimeAdapter,
} from "@openroly/adapter";

// Gemini CLI 用 official adapter(PBI-0061 / W9c)。generic MCP-config adapter(PBI-0060)の
// 第 1 実例 —— 機構の上に spec だけを載せる(register / unregister / doctor / listExtensions /
// applyExtension は factory が生やす)。
//
// 実測(2026-08-28, gemini-cli 0.46.0):
// - `gemini mcp add [-s user] [-e K=V ...] <name> <commandOrUrl> [args...]`。**`--` は不要**
//   (`-e` は greedy にならず `-e A=1 -e B=2 openroly bun /x.ts` が正しく分解される)
// - `gemini mcp remove [-s user] <name>` は対象が無くても **exit 0**(claude / codex は非 0)
// - config は JSON の `mcpServers`(claude と同形)。user scope は
//   `<GEMINI_CLI_HOME または $HOME>/.gemini/settings.json`
//
// **必ず `-s user`**: 既定の project scope は cwd 依存で、broker が起こす `openroly adopt` の cwd は
// launchd 経由だと `/` になる。さらに project scope は「信頼していないフォルダ」だと
// `mcp list` / `mcp remove` が対象を見つけられない(実測: "MCP servers are configured but
// disabled because this folder is untrusted")。user scope なら add / remove とも正常に効く。

/** `GEMINI_CLI_HOME` は gemini CLI 自身の差し替え口(bundle 実測:
 * `process.env["GEMINI_CLI_HOME"] || join(os.homedir(), ".gemini")`)。test はこれで実 `~/.gemini` を汚さない */
const configPath = (ctx: AdapterContext): string =>
  join(ctx.env.GEMINI_CLI_HOME ?? ctx.env.HOME ?? homedir(), ".gemini", "settings.json");

// kind = "instructions" の書き先(PBI-0214)。gemini の global 指示は settings.json と同じ
// `<GEMINI_CLI_HOME または $HOME>/.gemini` 配下の GEMINI.md
const instructionsFile = (ctx: AdapterContext): { file: string } => ({
  file: join(ctx.env.GEMINI_CLI_HOME ?? ctx.env.HOME ?? homedir(), ".gemini", "GEMINI.md"),
});

export const geminiAdapter: RuntimeAdapter = withInstructions(
  createMcpConfigAdapter({
    id: "gemini",
    displayName: "Gemini CLI",
    bin: "gemini",
    installHint: "gemini CLI was not found (npm i -g @google/gemini-cli)",
    configPath,
    format: "json",
    serversKey: "mcpServers",
    addArgs: ({ name, env, command, args }) => [
      "mcp",
      "add",
      "-s",
      "user",
      ...env.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      name,
      command,
      ...args,
    ],
    removeArgs: (name) => ["mcp", "remove", "-s", "user", name],
  }),
  instructionsFile,
);
