# openroly-mask

A tiny stdio proxy that sits in front of **any** MCP server and masks secrets before they ever
reach an LLM's context — then restores them right before a tool call sends something back out.

```
Claude Code / Codex / any MCP client
        │  stdio (JSON-RPC)
        ▼
    openroly-mask   ← masks tool results, restores placeholders in tool call params
        │  stdio (JSON-RPC)
        ▼
  <any MCP server>
```

No account, no signup, no network calls — it runs entirely on your machine. It works the same
way in front of every MCP client, which is the point: the same secrets stay hidden no matter
which AI you're talking to today.

## Why

If an MCP tool's response contains a credential, an email address, a phone number, or a card
number, that text lands in the model's context — and in whatever logs that session produces.
`openroly-mask` masks the **values** in a tool's JSON result with a placeholder (`⟨s:0⟩`, `⟨s:1⟩`, …)
before the model ever sees them, and restores the real value only when the model echoes the
placeholder back in a tool call's arguments (e.g. to actually send a message that quotes it).

Object shape is never touched — only string values are masked, so tool responses keep parsing the
same way for the client.

## Install

Not on npm yet. It runs from a checkout of this repository and needs [Bun](https://bun.sh) — the CLI's
shebang is `#!/usr/bin/env bun`, so plain `node` will not run it:

```bash
git clone https://github.com/OpenRoly/openroly && cd openroly
bun packages/mcp-mask/src/cli.ts -- <your-mcp-server-command>
```

To get the short name the rest of this page uses, link it once:

```bash
cd packages/mcp-mask && bun link      # then `openroly-mask` is on your PATH
```

## Use

Wrap any MCP server's command with `openroly-mask --`:

```bash
openroly-mask -- node ./my-mcp-server.js
openroly-mask -- python -m my_mcp_server
```

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "openroly-mask",
      "args": ["--", "node", "./my-mcp-server.js"]
    }
  }
}
```

### Codex (`.codex/config.toml`)

```toml
[mcp_servers.my-server]
command = "openroly-mask"
args = ["--", "node", "./my-mcp-server.js"]
```

## What gets masked

Configure `~/.openroly/secrets.json` (must be `chmod 600` — openroly-mask refuses to start otherwise):

```json
{
  "SECRETS": ["sk-...", "ghp_..."],
  "PRIVATE": ["Taro Yamada", "123 Main St"],
  "PATTERNS": { "email": true, "phone": true, "card": true, "keys": true }
}
```

- **SECRETS** — credential strings you already have (API keys, tokens). Masked verbatim.
- **PRIVATE** — your own dictionary of names, addresses, or any other string you want hidden.
- **PATTERNS** — on by default, no dictionary needed: email addresses, phone numbers (E.164 /
  JP / US), card numbers (validated with a Luhn check, so ordinary 16-digit numbers that aren't
  real cards are left alone), and key-shaped strings (`sk-…`, `ghp_…`, `xoxb-…`, JWTs).

If the file doesn't exist, `openroly-mask` runs with no masking (same as not using it). The legacy flat
format — a bare array or `{key: value}` object of secret strings — is still accepted as `SECRETS`.

Check what would be masked without running a server:

```bash
echo "call me at +81 90 1234 5678" | openroly-mask --dry-run
# call me at ⟨s:0⟩
```

## What it doesn't do

- No content filtering or "looks sensitive" heuristics — only the dictionary and the pattern list
  above.
- No per-pattern placeholder types (`⟨s:0⟩` only, never `⟨email:0⟩`) — a typed placeholder is a
  hint to the model about what it's holding.
- Placeholder ↔ value mapping lives only for the life of the proxy process; nothing is written to
  disk.

## License

Apache-2.0
