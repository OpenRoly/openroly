// PBI-0552 / CAP-15 Z2: Personal Agent Account Protocol v0.1 の conformance。
//  - specs/paap/v0.1/fixtures を validateCapsuleDir と ajv(schema だけ)の両方に通す(AC-2 / AC-X1 / AC-5)
//  - schema の enum・key 集合 = core の値集合と PAAP_SHAPES(両側を読んで比べる。値を書き写さない)(AC-3)
//  - hashCapsuleBody = sha256(JCS)を RFC 8785 の vector で(AC-4)
//  - specs/paap/ は公開 repo へ運ばれるので、外を指さない・README だけで L1 が書ける(AC-1 / AC-X2)
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { CAPSULE_FIELDS, hashCapsuleBody } from "../src/capsule.ts";
import { CLOUD_VISIBILITIES } from "../src/content.ts";
import { validateCapsuleDir } from "../src/node.ts";
import {
  HANDLE_STATUSES,
  HANDOFF_SOURCE_STATES,
  PAAP_REASONS,
  PAAP_SHAPES,
  PAAP_VERSION,
  summarizeCapsule,
  type Shape,
} from "../src/protocol.ts";
import { CONTEXT_PROFILES, TRANSFER_STATES, WORK_STATUSES } from "../src/work.ts";

const SPEC = resolve(import.meta.dir, "../../../specs/paap");
const V01 = `${SPEC}/v0.1`;
const OBJECTS = ["identity", "work", "checkpoint", "handoff", "manifest"] as const;
type Obj = (typeof OBJECTS)[number];

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const schemas = Object.fromEntries(OBJECTS.map((o) => [o, readJson(`${V01}/${o}.schema.json`)])) as Record<Obj, any>;
const sorted = (xs: Iterable<string>) => [...xs].sort();
const listFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => resolve(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
const cases = (kind: "valid" | "invalid") =>
  readdirSync(`${V01}/fixtures/${kind}`)
    .filter((n) => !n.startsWith("."))
    .sort();
const expectation = (name: string) => readJson(`${V01}/fixtures/invalid/${name}/expect.json`);
const schemaOf = (path: string): Obj | null =>
  path === "manifest.json"
    ? "manifest"
    : path === "identity.json"
      ? "identity"
      : /^works\/[^/]+\/work\.json$/.test(path)
        ? "work"
        : /^works\/[^/]+\/checkpoints\/[^/]+\.json$/.test(path)
          ? "checkpoint"
          : /^works\/[^/]+\/handoffs\/[^/]+\.json$/.test(path)
            ? "handoff"
            : null;

describe("AC-2 valid fixtures: validateCapsuleDir が ok・summarizeCapsule が expect.summary.json と一致", () => {
  test.each(cases("valid"))("%s", (name) => {
    const r = validateCapsuleDir(`${V01}/fixtures/valid/${name}/capsule`);
    if (!r.ok) throw new Error(`${r.reason} at ${r.path}${r.at}`);
    expect(summarizeCapsule(r.capsule)).toEqual(readJson(`${V01}/fixtures/valid/${name}/expect.summary.json`));
  });
});

describe("AC-X1 invalid fixtures: ok=false で reason と path が expect.json と一致", () => {
  test.each(cases("invalid"))("%s", (name) => {
    const r = validateCapsuleDir(`${V01}/fixtures/invalid/${name}/capsule`);
    expect(r.ok ? { ok: true } : { ok: false, reason: r.reason, path: r.path }).toEqual({ ok: false, ...expectation(name) });
  });

  test("valid は basic / handoff-routed / reviewer-blind を含み、invalid の reason の集合 = PAAP_REASONS(全 reason が 1 度は立つ)", () => {
    expect(cases("valid")).toEqual(expect.arrayContaining(["basic", "handoff-routed", "reviewer-blind"]));
    expect(sorted(new Set(cases("invalid").map((n) => expectation(n).reason)))).toEqual(sorted(PAAP_REASONS));
  });
});

describe("AC-3 schema と core の値集合・判定の形が同値", () => {
  test("enum と checkpoint body の key", () => {
    const pairs: [string, readonly string[], readonly string[]][] = [
      ["work.status", schemas.work.properties.status.enum, WORK_STATUSES],
      ["work.visibility", schemas.work.properties.visibility.enum, CLOUD_VISIBILITIES],
      ["work.profile", schemas.work.properties.profile.enum, Object.keys(CONTEXT_PROFILES)],
      ["handoff.state", schemas.handoff.properties.state.enum, TRANSFER_STATES],
      ["handoff.source_state", schemas.handoff.properties.source_state.enum, HANDOFF_SOURCE_STATES],
      ["identity.handles.status", schemas.identity.properties.handles.items.properties.status.enum, HANDLE_STATUSES],
      ["checkpoint.body", Object.keys(schemas.checkpoint.properties.body.properties), CAPSULE_FIELDS],
    ];
    const drift = pairs
      .filter(([, a, b]) => sorted(a).join() !== sorted(b).join())
      .map(([name, a, b]) => `${name}: schema=[${sorted(a)}] core=[${sorted(b)}]`);
    expect(drift).toEqual([]);
  });

  test("PAAP_SHAPES の required / 全 key = schema の required / properties(入れ子まで)", () => {
    const deref = (node: any, root: any) =>
      typeof node?.$ref === "string" ? node.$ref.slice(2).split("/").reduce((n: any, k: string) => n[k], root) : node;
    const isShape = (k: unknown): k is Shape =>
      typeof k === "object" && k !== null && !Array.isArray(k) && !(k instanceof RegExp) && "required" in k;
    const drift: string[] = [];
    const walk = (shape: Shape, raw: any, root: any, at: string) => {
      const node = deref(raw, root);
      const all = { ...shape.required, ...shape.optional };
      if (sorted(node.required ?? []).join() !== sorted(Object.keys(shape.required)).join()) drift.push(`${at} required`);
      if (sorted(Object.keys(node.properties ?? {})).join() !== sorted(Object.keys(all)).join()) drift.push(`${at} properties`);
      for (const [key, kind] of Object.entries(all)) {
        const child = node.properties?.[key];
        if (child === undefined) continue;
        if (isShape(kind)) walk(kind, child, root, `${at}/${key}`);
        else if (typeof kind === "object" && "items" in kind && isShape(kind.items)) {
          walk(kind.items, deref(child, root).items, root, `${at}/${key}[]`);
        }
      }
    };
    for (const o of OBJECTS) walk(PAAP_SHAPES[o], schemas[o], schemas[o], o);
    expect(drift).toEqual([]);
  });
});

describe("AC-4 hashCapsuleBody = sha256(JCS(body))(RFC 8785 の vector)", () => {
  const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  const ieee = (hex: string) =>
    new DataView(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)).buffer).getFloat64(0);

  test("① key は UTF-16 code unit の順(§3.2.3 の例)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    const jcs =
      '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis",' +
      '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
    expect(hashCapsuleBody(input)).toBe(sha(jcs));
  });

  test("② 文字列の escape・数値・literal(§3.2.2 の例)", () => {
    // 制御文字と escape は書き写さず code point で組む(escape が実文字に化けても vector が壊れない)
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    const [BS, Q, EURO] = [ch(0x5c), ch(0x22), ch(0x20ac)];
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: `${EURO}$${ch(0x0f, 0x0a)}A'B${Q}${BS}${BS}${Q}/`,
      literals: [null, true, false],
    };
    const jcs =
      `{${Q}literals${Q}:[null,true,false],${Q}numbers${Q}:[333333333.3333333,1e+30,4.5,0.002,1e-27],${Q}string${Q}:${Q}` +
      `${EURO}$${BS}u000f${BS}nA'B${BS}${Q}${BS}${BS}${BS}${BS}${BS}${Q}/${Q}}`;
    expect(hashCapsuleBody(input)).toBe(sha(jcs));
  });

  test("③ 入れ子の object も並べ、配列の順は保つ・数値は Appendix B の IEEE 754 表", () => {
    const b = [
      "8000000000000000", "4340000000000000", "444b1ae4d6e2ef50", "3eb0c6f7a0b5ed8c", "3eb0c6f7a0b5ed8d",
      "41b3de4355555554", "becbf647612f3696", "0000000000000001", "ffefffffffffffff", "4430000000000000",
      "44b52d02c7e14af5",
    ].map(ieee);
    const input = { z: { b, a: { y: 1, x: [{ d: true, c: null }] } } };
    const jcs =
      '{"z":{"a":{"x":[{"c":null,"d":true}],"y":1},"b":[0,9007199254740992,1e+21,9.999999999999997e-7,0.000001,' +
      '333333333.33333325,-0.0000033333333333333333,5e-324,-1.7976931348623157e+308,295147905179352830000,9.999999999999997e+22]}}';
    expect(hashCapsuleBody(input)).toBe(sha(jcs));
  });
});

describe("AC-5 ajv(JSON Schema 2020-12 だけ・OpenRoly の判定を使わない)が同じ verdict", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const o of OBJECTS) ajv.addSchema(schemas[o]);
  const schemaError = (o: Obj, doc: unknown) => {
    const validate = ajv.getSchema(schemas[o].$id);
    if (!validate) throw new Error(`schema not registered: ${o}`);
    return validate(doc) ? null : ajv.errorsText(validate.errors);
  };
  const failingFiles = (dir: string) =>
    listFiles(dir).flatMap((p) => {
      const o = schemaOf(p);
      const e = o && schemaError(o, readJson(`${dir}/${p}`));
      return e ? [`${p}: ${e}`] : [];
    });
  /** schema で表せる破れ(形・版・private key)。他は不変条件で schema は通す = validator が要る */
  const SCHEMA_REASONS = ["unsupported_protocol", "unknown_key", "missing_field", "invalid_field", "private_key_in_export"];

  test.each(cases("valid"))("valid/%s: 全 file が schema に通る", (name) => {
    expect(failingFiles(`${V01}/fixtures/valid/${name}/capsule`)).toEqual([]);
  });

  test.each(cases("invalid"))("invalid/%s: 形の破れは schema もその file だけで落ち、不変条件の破れは schema を通る", (name) => {
    const { reason, path } = expectation(name);
    if (reason === "missing_file" || reason === "invalid_json") return;
    const failing = failingFiles(`${V01}/fixtures/invalid/${name}/capsule`).map((line) => line.split(": ")[0]);
    expect(failing).toEqual(SCHEMA_REASONS.includes(reason) ? [path] : []);
  });
});

describe("AC-1 / AC-X2 README と schema だけで実装できる(specs/paap/ の外を指さない)", () => {
  const readme = readFileSync(`${SPEC}/README.md`, "utf8");

  test("specs/paap/ の全 file に非公開の場所・絶対 path・社内の番号が 0", () => {
    const FORBIDDEN = [/\/Users\//, /(?:^|[\s("'`[])(?:\.\.\/)*(?:docs|backlog)\//m, /\bPBI-\d+/, /\bCAP-\d+/];
    const hits = listFiles(SPEC).flatMap((p) => {
      const t = readFileSync(`${SPEC}/${p}`, "utf8");
      return FORBIDDEN.filter((re) => re.test(t)).map((re) => `${p}: ${re}`);
    });
    expect(hits).toEqual([]);
  });

  test("README の相対 link は specs/paap/ の中の実在 path・schema の $ref は文書内だけ", () => {
    // inline code は link ではない(§2 の時刻の正規表現に `](` が在る)
    const links = [...readme.replace(/`[^`\n]*`/g, "").matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((l) => !/^[a-z]+:/.test(l) && !l.startsWith("#"));
    const outside = links.filter((l) => {
      const abs = resolve(SPEC, l.split("#")[0] ?? "");
      return !abs.startsWith(`${SPEC}/`) || !existsSync(abs);
    });
    const externalRefs = OBJECTS.flatMap((o) =>
      [...JSON.stringify(schemas[o]).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] ?? ""),
    ).filter((r) => !r.startsWith("#/"));
    expect({ links: links.length > 0, outside, externalRefs }).toEqual({ links: true, outside: [], externalRefs: [] });
  });

  test("README は 5 schema の $id・I-1〜I-12・L1〜L3・handoff の 5 状態・参照実装の 1 文・版の識別子を持つ", () => {
    const missing = [
      ...OBJECTS.map((o) => schemas[o].$id as string),
      ...Array.from({ length: 12 }, (_, i) => `**I-${i + 1}**`),
      "L1 Reader",
      "L2 Writer",
      "L3 Continuer",
      "OpenRoly is the reference implementation of the Personal Agent Account Protocol",
      `\`${PAAP_VERSION}\``,
    ].filter((s) => !readme.includes(s));
    const mermaid = readme.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
    missing.push(...TRANSFER_STATES.filter((s) => !new RegExp(`\\b${s}\\b`).test(mermaid)).map((s) => `mermaid: ${s}`));
    expect(missing).toEqual([]);
  });

  test("付録 A は informative と名乗り、表の MCP tool は全部 packages/mcp に実在する", () => {
    const appendix = readme.split(/^## /m).find((s) => s.startsWith("Appendix A. ")) ?? "";
    const named = [...appendix.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] ?? "");
    const server = readFileSync(resolve(import.meta.dir, "../../mcp/src/server.ts"), "utf8");
    const registered = new Set([...server.matchAll(/^\s*"([a-z_]+)",$/gm)].map((m) => m[1] ?? ""));
    expect({
      informative: appendix.includes("**informative**"),
      named: named.length >= 4,
      unknown: named.filter((t) => !registered.has(t)),
    }).toEqual({ informative: true, named: true, unknown: [] });
  });

  test("brief の節順 = CAPSULE_FIELDS・失敗理由の表 = PAAP_REASONS・I-8 は reviewer_blind の allowlist を名乗る", () => {
    const section = (n: string) => readme.split(/^## /m).find((s) => s.startsWith(`${n}. `)) ?? "";
    // §5 の箇条 1 つ分だけ(§4 の表も **I-8** を名乗るので、段落で探すと表に当たる)
    const i8 = section("5").split("\n- ").find((p) => p.startsWith("**I-8**")) ?? "";
    expect({
      brief: [...section("7").matchAll(/^\d+\. `([a-z_]+)`/gm)].map((m) => m[1] ?? ""),
      reasons: sorted([...section("9").matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] ?? "")),
      i8: CONTEXT_PROFILES.reviewer_blind.capsuleFields.filter((f) => !i8.includes(`\`${f}\``)),
    }).toEqual({ brief: [...CAPSULE_FIELDS], reasons: sorted(PAAP_REASONS), i8: [] });
  });
});
