# MiniRoly

A second, independent implementation of the [Personal Agent Account Protocol](../../specs/paap/README.md)
(PAAP) v0.1. One TypeScript file, no dependencies, and no code shared with OpenRoly.

It claims **L1 Reader** and **L2 Writer** (spec §8):

- **L1**: read a capsule directory and say who the agent is, what it is working on, how far it got, and who the
  work was handed to.
- **L2**: append the next checkpoint to a work. The whole capsule, including the new file and the updated
  manifest, is validated before a single byte is written, so a refused write leaves the directory untouched.

## Use

Requires [Bun](https://bun.sh).

```sh
# Brief for a model: identity, current work, last handoff, then one "## <field>" section per body field
bun examples/miniroly/main.ts read path/to/agent.capsule

# The L1 summary of spec §8.1, as JSON
bun examples/miniroly/main.ts read path/to/agent.capsule --json

# Append checkpoint version + 1 to a work. Values are JSON when they parse as JSON, otherwise strings
bun examples/miniroly/main.ts checkpoint path/to/agent.capsule wrk_123 \
  --set current_state="tests pass, docs left" \
  --set 'failed_attempts=[{"tried":"retry on 429","why":"quota, not rate limit"}]'
```

Every failure exits with status 1 and prints one line, `miniroly: <reason> <file><json pointer>`, where
`<reason>` is a name from spec §9. For example:

```text
miniroly: conversation_in_checkpoint works/wrk_123/checkpoints/4.json/body/decisions/log/transcript
```

The same runs against the conformance fixtures:

```sh
bun examples/miniroly/main.ts read specs/paap/v0.1/fixtures/valid/basic/capsule --json
```

## What it was written from

Only the specification text and the JSON Schemas in `specs/paap/`:

| Part of `main.ts` | Spec section |
|---|---|
| `SHAPES`: fields, required, enums, formats | §4 Objects and `v0.1/*.schema.json` |
| Capsule layout, dot files ignored, unknown listed paths ignored | §3 Capsule directory |
| `validate`: I-1 to I-12, one reason per fault | §5 Invariants and §9 Failure reasons |
| `checkpoint` refuses a work whose handoff is in progress | §6 Handoff state machine, §8 L2 Writer |
| `jcs`: the hash input | I-3 and RFC 8785 |
| `brief`: section order and formatting | §7 Brief |
| `summarize`: current work, latest checkpoint, last handoff | §8.1 L1 summary |
| `ext` ignored, `protocol` checked | §10 Versioning and extensions |

## Notes

- `read` validates the capsule first, so the reader and the writer share one definition of "valid".
- A checkpoint carries the previous body forward; `--set` replaces one field at a time.
- While a handoff is `frozen`, `capsule_ready`, or `routed`, nobody holds the work's lease, so `checkpoint`
  refuses with `handoff_in_progress` (§6). Continuing a routed handoff is L3, which MiniRoly does not claim.
- The manifest is written to a dot file and renamed into place. Dot files are not part of a capsule (§3), so an
  interrupted write never leaves an unlisted file behind.
