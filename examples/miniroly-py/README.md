# miniroly-py

A [Personal Agent Account Protocol](../../specs/paap/README.md) v0.1 **L1 Reader** in one Python file,
standard library only. It is the second, independent reader of the protocol: it was written from the
specification and the JSON Schemas alone, in a different language from the reference implementation.

## Requirements

Python 3.9 or newer. No packages, no `pip install`.

## Usage

```sh
python3 miniroly.py read path/to/alice.capsule          # summary + the checkpoint brief
python3 miniroly.py read path/to/alice.capsule --json   # the L1 summary (spec §8.1)
```

| Exit | Meaning |
|---|---|
| 0 | The capsule was read |
| 1 | The capsule is broken. stderr says `error: <reason> <path>` with a reason from spec §9 |
| 2 | Usage |

## What it checks, and what it does not

It will not read a broken capsule quietly:

- every file is listed in `manifest.json`, once, and its SHA-256 matches its bytes (I-11)
- no key outside the schema, at any level; unknown `ext` keys are ignored (I-10, §10)
- each file sits where its `id`, `work_id` and `version` say (I-1)
- `protocol` is `paap/0.1`, files are UTF-8 I-JSON

It does not check required fields that the summary does not use, value formats (including the
`<vendor>.<key>` form of `ext` keys), `content_hash`, `reenter`, private JWK members, or invariants I-2 to I-9. An L2 validator rejects those capsules; this reader may read them.

## Spec sections it was written from

§2 conventions (timestamps compare as instants, sorting by UTF-16 code units), §3 capsule directory,
§4 objects, §5 I-1 / I-10 / I-11, §7 brief, §8.1 L1 summary, §9 failure reasons, §10 extensions.

## Conformance test

From the repository root, the fixtures in `specs/paap/v0.1/fixtures/valid` are read and compared with
their `expect.summary.json`:

```sh
bun test packages/core/test/miniroly-py.test.ts
```
