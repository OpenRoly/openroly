# Changelog

Notable changes to OpenRoly. Entries are tagged with the work unit that produced them
(`PBI-NNNN`); in a checkout with history, `git log --grep=PBI-NNNN` finds the commits.

## v0.2.5 — 2026-09-16

159 commits since `v0.2.4`. The theme is the one on the tin: **a job now outlives the AI that
started it, and you can prove it left with everything it needed.**

Two items below need the account server behind your account to be updated before they work —
they are marked **(server)**. Everything else runs from the released binary.

### New

**Work that survives the AI**

- `openroly continue` — one step when an AI stalls. It picks the work its dead-or-live lease points
  at (live first, then a lapsed lease on an unfinished work), transfers it, and waits for the next
  AI to pick it up. No work id to look up, no re-explaining. (PBI-0547, PBI-0557)
- A handoff that fails no longer strands the work. The same `openroly continue` picks it back up,
  and six kinds of handoff failure are injected and measured rather than assumed. (PBI-0571, PBI-0578)
- A session cut off right after a tool call now records how it ended and wakes the same runtime
  once more, instead of leaving the work mid-step. (PBI-0583)
- `openroly work rollback <id>` — put the working tree back to an earlier capsule version. Your
  current state is saved as a version first, so nothing is lost, and HEAD and branches are never
  moved. (PBI-0550)
- `openroly work start "<title>"` — start a job yourself instead of waiting for one to arrive. Only
  a person can start one; a runtime credential gets `403 human_only` and adds a task under an
  existing work. (PBI-0623)
- Sessions woken for a work are handed the same Context Package your other AIs get, so a job
  started by mail no longer begins with an empty head. (PBI-0602)
- A job records who it belongs to, separately from the agent that runs it — the seam shared places
  will need later. Every place is *Personal* today. (PBI-0467)

**PAAP v0.1 — the account as an open spec**

- `specs/paap/` is the Personal Agent Account Protocol v0.1: identity, work, checkpoints and
  handoffs, with conformance fixtures. (PBI-0552)
- Two independent implementations read it, written from the spec and fixtures alone —
  `examples/miniroly` (TypeScript, one file, no dependencies) and `examples/miniroly-py`
  (Python standard library only). (PBI-0554, PBI-0555)
- Conformance runs on every push, in this repo and in the public clone. (PBI-0556)
- **(server)** `openroly export` writes your agent out as a PAAP v0.1 capsule directory — identity,
  works, checkpoints, handoffs, public keys only, secrets listed by name to re-enter. Nothing is
  written if a checkpoint's content is missing from this device. `openroly capsule verify <dir>`
  checks any capsule against the spec, and `--continued-from` also checks it continues that
  capsule's routed handoff. (PBI-0553)

**The first published continuity numbers**

- The README now carries the PAAP Continuity Benchmark: when one AI hands an unfinished job to
  another, does the next AI start the right next step without anyone explaining the job again?
  Each run is judged by what the next AI *does* — its tool calls and the tests after it stops —
  not by what it says, and the same job is also handed over as a summary and as a full transcript
  for comparison. Continuation success **93.3%** for a PAAP handoff against **73.3%** for a summary
  written by the source AI (n=30 each); final task success **86.7%** against **66.7%** (n=30 each).
  (PBI-0568, PBI-0569, PBI-0570, PBI-0572, PBI-0573)
- Every number in that table is generated from the measurement JSON, and a check fails the build if
  the README's table and the measurement disagree — the table cannot be written by hand any more.
  (PBI-0573)
- Figures are distributions, not a lone median: p50, p90 and a 95% interval, from one place.
  (PBI-0604)
- Two first-class columns joined the table: how often a session is cut off mid-job (PBI-0603), and
  what one finished job costs in tokens and credits (PBI-0605, PBI-0608).
- The "engineering smoke benchmark" lines under *Coming next* are now named as what they are — a
  simpler, earlier check that the handoff arrived and was acted on. (PBI-0568)

**(server) Shared memory**

- What one AI learns can be proposed as a memory, approved by you, and recalled by a different AI
  on a different day (`memory_propose` / `memory_search`). Bodies are sealed the same way your mail
  is; approval is yours, not the model's. A cross-engine benchmark measures whether the second AI
  actually uses what the first one remembered. (PBI-0378, PBI-0592)

**Connecting AIs**

- Adding a runtime no longer needs Rust. How to launch it, how to hand it the MCP server, and where
  it is allowed to reach on the network all come from catalog data now, so a new AI is a catalog
  entry. (PBI-0616, PBI-0617, PBI-0618)
- `openroly runtimes prune` clears the roster your account shows of rows no connected machine
  claims any more. Machines connected right now — and this one — are kept. (PBI-0625)
- `openroly status` also lists the AIs actually running on this machine, matched against the same
  catalog `detect.binaries` used to find them in the first place. (PBI-0631)
- The bundled catalog recognizes 91 AI tools, engines and API providers.
- The AI that reads incoming mail can now be run in one sandbox while the MCP server that can read
  the dictionary runs in another, with the masked body relayed across an egress proxy. (PBI-0558)

**Web**

- Static responses carry `Cache-Control`: hashed assets are immutable for a year, `index.html`,
  `sw.js` and the SPA fallback are `no-cache`. (PBI-0223)

### Fixed

- The 30-second checkpoint tick dropped the previous version's goal and current state, so the AI
  receiving a handoff was not told what the job was. (PBI-0596)
- An account server that cannot be reached now prints one line saying so, from every command,
  instead of a stack trace. (PBI-0640)
- `install` failed on a machine without `bun` on `PATH`. (PBI-0610)
- Owner-lane wake-ups are chosen by lane again; a merge had made "holds no token, therefore owner"
  permanently false. (PBI-0630)
- A sandboxed session worked in the directory the broker was started from instead of the folder it
  was given. (PBI-0577)
- Signing out of the web app now unsubscribes this browser from push first — notification kinds and
  sender names kept arriving at signed-out browsers. (PBI-0490)
- Signing in at a bare Fly hostname returned `403 Invalid origin`. (PBI-0226)
- The Google sign-in return path is folded onto a same-origin path, and `/connect` no longer claims
  a code will remain when it will not. (PBI-0228)
- Rate limiting read a client-supplied `cf-connecting-ip`, so a client could split its own IP
  bucket. (PBI-0243)
- `openroly export` names the required field the server did not send, instead of failing blankly.
  (PBI-0626)
- `agents_list` reported runtimes as live that could not actually be woken. (PBI-0622)
- A triage or work-review reply could return dictionary values; masked values now go back only to
  the party that brought them. (PBI-0579)
- A session that cannot read the dictionary can no longer reach a tool that returns someone else's
  message body, and the catalog engine is only woken in the work lane. (PBI-0548)
- The plugin's MCP bundle is built from source at install time rather than tracked in the repo,
  after the tracked copy drifted from source for the third time. (PBI-0581, PBI-0597)
- Host-scoped egress: detection no longer claims a scope from install files alone, the dedicated
  user can traverse `0700` ancestors, and cancel and cleanup reach both the root `sudo` and the
  pool user. (PBI-0441)
- Quickstart no longer leaves three files behind in the repo root. (PBI-0621)
- The stalled-session helper looked for its checkout under `adapters/`, so a machine without the
  binary silently stopped recording usage limits. (PBI-0565)
- The web sign-up page and hero claimed a handoff target and a notification source the product does
  not have; both now say what the README says. (PBI-0563, PBI-0566)

### Breaking

- **Gemini CLI is no longer a supported runtime.** It is out of the adapters, the detection list,
  the launch paths and `THIRD_PARTY_NOTICES`. Pair `claude`, `codex` or a catalog runtime instead.
  (PBI-0543)
- **A runtime credential now needs a session scope.** The default moved from "let it through" to
  "closed", on every lane including the owner lane; a request without the right scope gets
  `403 scope_required`, and a bare runtime token can no longer change the agent's own surface.
  (PBI-0320, PBI-0633, PBI-0635)
- **Handles are no longer silently repaired.** `@@alice` is rejected as `422 invalid_handle`
  instead of being read as `alice`; for external addresses only the domain is lower-cased.
  (PBI-0347)
- **Bare Fly hostnames redirect.** `paa-cloud.fly.dev` and `<hash>.paa-cloud.fly.dev` now `301` to
  the canonical host. (PBI-0226)
- **The plugin's MCP bundle is not in the repo any more.** It is built where it is needed; anything
  that read the tracked file has to build it. (PBI-0597)
