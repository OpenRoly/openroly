import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMcpConfigAdapter,
  withInstructions,
  withSkills,
  type AdapterContext,
  type ExtensionAdapter,
} from "@openroly/adapter";

// Codex 用 official adapter。登録先は $CODEX_HOME/config.toml の [mcp_servers.<name>]。
// 書式は codex CLI に任せる(設定 file を直接書かない — 書式は CLI 側の都合で変わるため)。
//
// register / unregister / doctor / listExtensions / applyExtension は generic MCP-config
// adapter(PBI-0060 / W9b)が生やし、skill kind の materialize は packages/adapter/src/skill.ts
// の withSkills(W20 / PBI-0091)が生やす。codex CLI は Agent Skills を $CODEX_HOME/skills の
// SKILL.md(frontmatter name/description)でサポートするため claude と同じ形がそのまま刺さる
// (出典: https://community.openai.com/t/skills-for-codex-experimental-support-starting-today/1369367
//   https://learn.chatgpt.com/docs/build-skills)。
// ここに残るのは codex 固有の 3 点だけ:
//   ① config の場所(CODEX_HOME を見る)と形式(TOML の mcp_servers)
//   ② `codex mcp add|remove` の argv(env は `--env K=V`、name → `--` → command の順)
//   ③ skills/ の場所(config.toml と同じ CODEX_HOME base)

const codexHome = (ctx: AdapterContext): string =>
  ctx.env.CODEX_HOME ?? join(ctx.env.HOME ?? homedir(), ".codex");

const configPath = (ctx: AdapterContext): string => join(codexHome(ctx), "config.toml");

const skillsDir = (ctx: AdapterContext): string => join(codexHome(ctx), "skills");

// kind = "instructions" の書き先(PBI-0214)。codex の global 指示は $CODEX_HOME/AGENTS.md
const instructionsFile = (ctx: AdapterContext): { file: string } => ({ file: join(codexHome(ctx), "AGENTS.md") });

export const codexAdapter: ExtensionAdapter = withInstructions(
  withSkills(
    createMcpConfigAdapter({
      id: "codex",
      displayName: "Codex",
      bin: "codex",
      installHint: "codex CLI was not found (npm i -g @openai/codex)",
      configPath,
      format: "toml",
      serversKey: "mcp_servers",
      addArgs: ({ name, env, command, args }) => [
        "mcp",
        "add",
        name,
        ...env.flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        "--",
        command,
        ...args,
      ],
      removeArgs: (name) => ["mcp", "remove", name],
    }),
    skillsDir,
  ),
  instructionsFile,
);
