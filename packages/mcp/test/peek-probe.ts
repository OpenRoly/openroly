// PBI-0224 e2e の probe。`scripts/e2e-auto-session.ts` の fakebin claude が、dedicated session の env
// (OPENROLY_SESSION_ID / OPENROLY_BROKER_HOME は broker から継承)を持ったまま **実物の MCP server** を 1 回叩く:
// inbox_list → 先頭の message を inbox_read。これで session_dir/peek.jsonl に header + inbox_read 行が残る。
// `bun test` の対象ではない(*.test.ts でない)。packages/mcp 配下に置くのは SDK の解決 root がここだから。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

// PBI-0639: C1(専用 uid)の session からは repo(`~/Downloads` は 700)が 1 byte も読めないので、
// e2e は probe と server を **bundle** して読める所に置き、server の在処をここで渡す。
// 渡されなければ今までどおり repo の source(手元で直に叩く時の道)
const SERVER = process.env.OPENROLY_PEEK_PROBE_SERVER ?? fileURLToPath(new URL("../src/server.ts", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined));
const client = new Client({ name: "e2e-peek-probe", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "inherit" }));
const list = (await client.callTool({ name: "inbox_list", arguments: {} })) as { content: { text: string }[] };
const ids = (JSON.parse(list.content[0]!.text) as { id: string }[]).map((m) => m.id);
if (ids[0]) await client.callTool({ name: "inbox_read", arguments: { message_id: ids[0] } });
await client.close();
console.log(`peek-probe: read ${ids[0] ?? "(no message)"} in session ${process.env.OPENROLY_SESSION_ID ?? "(none)"}`);
