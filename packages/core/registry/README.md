# Detector registry — how to add a runtime

`detectors.v1.json` is **generated**. Do not edit it by hand: `diagrams-check.sh` runs
`bun scripts/catalog-build.ts --check` and fails on any drift.

```
upstream/agent-catalog/*.csv   (upstream lists, refreshed by the site-api recipes)
overrides.json                 (hand-verified entries — the only place `native` may appear)
packages/core/src/providers.ts (the API provider table -> the `<id>-api` entries)
        |
        v  bun scripts/catalog-build.ts
detectors.v1.json              (signed and served by GET /v1/registry/detectors)
```

## Adding a runtime

**Detection only** (it shows up in "Your AI", nothing is wired): nothing to do — if the runtime is in
one of the upstream lists with a marker directory under `$HOME`, it is already generated with
`adapter: null` and `detect.dirs`. Binary names are never guessed from the id.

**Wiring it up** (OpenRoly registers its MCP server, ships skills): add an entry to `overrides.json` with
`adapter: "generic/native"` and a `native` block, then run `bun scripts/catalog-build.ts` and commit
both files. No TypeScript package is needed — `packages/adapter/src/native.ts` builds the adapter
from that one entry (see `docs/diagrams.md` figure 66).

```jsonc
{
  "id": "example",                       // [a-z0-9_-], unique across the whole catalog
  "display_name": "Example",
  "kind": "cli",                         // cli | app | api | local_model_server
  "aliases": ["example-cli"],            // upstream ids folded into this entry (their dirs are absorbed)
  "detect": { "binaries": ["example"], "apps": [], "services": [] },
  "adapter": "generic/native",
  "native": {
    "home": { "env": "EXAMPLE_HOME", "default": "~/.example" },
    "bin": "example",
    "install": "npm i -g example",       // shown when the CLI is missing
    "mcp": {
      "strategy": "file",                // "file" writes the config, "cli" shells out to the runtime
      "path": "~/.example/mcp.json",
      "format": "json",                  // json | jsonc | json5 | yaml | toml
      "key": "mcpServers",               // dotted path, e.g. "amp.mcpServers"
      "shape": "map",                    // "map" -> key.<name>; "list" -> array matched on `match`
      "entry": { "command": "${command}", "args": "${args}", "env": "${env}" }
    },
    "skills": { "dir": "~/.example/skills" }
  },
  "sources": ["https://example.com/docs/mcp"],   // required for generic entries
  "verified": "cli:1.2.3"                        // cli:<ver> | file:<path> | docs
}
```

### Template placeholders

| In a `file` entry | In a `cli` argv |
|---|---|
| `${name}` `${command}` — substituted inside strings | same |
| `"${args}"` `"${env}"` `"${json}"` — replaced by the value (array / object / JSON string) | same |
| `"${args...}"` `"${env...}"` — spliced element-wise into the surrounding array | same |
| — | `"--env...", "${env}"` — repeats the flag once per element (`--env K=V --env K2=V2`) |

### Rules

- **Never guess.** Leave a field out rather than inventing it — the adapter treats a missing field as
  unsupported (fail-closed). `verified` must say how you know: you ran the CLI, you read a real config
  file, or you only have docs (then `sources` must carry the URL).
- One entry per config file. Two ids writing the same file (a CLI and its desktop app) must be folded
  into one entry with both `binaries` and `apps`.
- Formats that cannot round-trip comments (TOML) should declare `"comments_preserved": false` so
  `openroly doctor` warns instead of silently dropping a user's comments.

## Headless wake and egress (PBI-0240)

The containment wall is runtime-independent (broker OS sandbox + egress proxy, PBI-0238), so wiring
up a new runtime's dedicated wake is one entry:

```jsonc
{
  "launch": {
    "existing": ["--continue"],
    "headless": { "argv": ["run", "${instruction}"] }   // no program name — detect.binaries is used
  },
  "egress": { "hosts": ["models.opencode.ai"] },        // union with the broker's built-in table
  "sandbox_verified": "2026-09-04 opencode 1.18.10"     // maintainer-measured; without it the
                                                         // generic path stays closed (not_verified)
}
```

- `launch.headless.argv` is substituted element-wise: `${instruction}` (exactly once — the build
  fails otherwise), `${folder}`, `${session_dir}`. No shell is involved; one element stays one
  argument. The official pair (claude / codex) keeps its measured argv in the broker and
  does **not** set `launch.headless`.
- `egress.hosts` entries are hostnames: a leading `*.` wildcard is the only wildcard allowed; URLs
  and mid-label wildcards fail the build (and the broker's `validate` rejects them even in a signed
  catalog).
- `sandbox_verified` records the date + CLI + version of the sandbox measurement. A maintainer adds
  it after running the runtime inside the broker sandbox; an entry with `launch.headless` but no
  `sandbox_verified` reports `not_verified` instead of starting.


## Refreshing the upstream lists

The CSVs come from the `site-api` recipes in `~/.claude/skills/site-api/recipes/agent-catalog/`
(`site_api.py run <name>`; `check` reports upstream drift). Re-run the recipe, replace the CSV, run
`bun scripts/catalog-build.ts`, and commit the diff.
