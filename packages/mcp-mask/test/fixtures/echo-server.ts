#!/usr/bin/env bun
// proxy.test.ts 用の最小 MCP server(OpenRoly 以外の任意 server の代わり。PBI-0177 AC-4)。
// echo tool は params.text をそのまま result.text に返す(mask/restore の往復を検査する為)。
// text が "exit:<n>" なら process.exit(n) する(子の exit code 伝播を検査する為・AC-4)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.1" });

server.tool("echo", "input を result.text へそのまま返す", { text: z.string() }, async ({ text }) => {
  const m = /^exit:(\d+)$/.exec(text);
  if (m) process.exit(Number(m[1]));
  return { content: [{ type: "text" as const, text }] };
});

await server.connect(new StdioServerTransport());
