import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMcpConfigAdapter,
  withInstructions,
  withSkills,
  type AdapterContext,
  type RuntimeAdapter,
} from "@openroly/adapter";

// Claude Code 用 official adapter。runtime 固有なのは「MCP server をどう登録するか」と
// 「skill をどこに置くか」だけ。登録は claude CLI に任せる(設定 file の書式は CLI 側の
// 都合で変わるため直接書かない)。
//
// MCP 系の 5 op は generic MCP-config adapter(PBI-0060 / W9b)が生やし、skill kind の
// materialize(path safety / .openroly-managed marker / SKILL.md 組み立て)は
// packages/adapter/src/skill.ts の withSkills(W20 / PBI-0091 に共通化)が生やす。
// ここに残るのは claude 固有の 3 点: ① config の場所と形式 ② `claude mcp add|remove`
// の argv ③ skills/ の場所。

// CLAUDE_CONFIG_DIR を設定すると claude CLI は .claude.json をその配下に読み書きする
// (実測確認済み — 未対応だと native state の listExtensions/doctor が嘘をつく)
const userConfigPath = (ctx: AdapterContext): string =>
  join(ctx.env.CLAUDE_CONFIG_DIR ?? ctx.env.HOME ?? homedir(), ".claude.json");

// kind = "skill" の materialize 先(PBI-0008)。CLAUDE_CONFIG_DIR 設定時は userConfigPath と同じ
// base 配下(実測: .claude.json と同じ階層に skills/ が来る前提。不確実性は PBI-0008 参照)。
const skillsDir = (ctx: AdapterContext): string =>
  ctx.env.CLAUDE_CONFIG_DIR
    ? join(ctx.env.CLAUDE_CONFIG_DIR, "skills")
    : join(ctx.env.HOME ?? homedir(), ".claude", "skills");

// kind = "instructions" の書き先(PBI-0214)。global の指示ファイル = CLAUDE.md。
// skills/ と同じく CLAUDE_CONFIG_DIR 設定時はその配下(実測: 設定 dir の直下に CLAUDE.md が来る)
const instructionsFile = (ctx: AdapterContext): { file: string } => ({
  file: ctx.env.CLAUDE_CONFIG_DIR
    ? join(ctx.env.CLAUDE_CONFIG_DIR, "CLAUDE.md")
    : join(ctx.env.HOME ?? homedir(), ".claude", "CLAUDE.md"),
});

/** MCP 系 5 op の実体。skill を含む最終形は withSkills が重ねる(PBI-0091 で共通化) */
const base = createMcpConfigAdapter({
  id: "claude",
  displayName: "Claude Code",
  bin: "claude",
  installHint: "claude CLI was not found (https://claude.com/claude-code)",
  configPath: userConfigPath,
  format: "json",
  serversKey: "mcpServers",
  addArgs: ({ name, env, command, args }) => [
    "mcp",
    "add",
    "-s",
    "user",
    name,
    ...env.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--",
    command,
    ...args,
  ],
  removeArgs: (name) => ["mcp", "remove", "-s", "user", name],
});

// skill を materialize できるのは PBI-0008 時点では claude だけだった → W20(PBI-0091)で codex も加わる
export const claudeAdapter: RuntimeAdapter = withInstructions(withSkills(base, skillsDir), instructionsFile);
