#!/usr/bin/env bun
// MiniRoly: an independent implementation of the Personal Agent Account Protocol (PAAP) v0.1,
// conformance L1 Reader + L2 Writer. Zero dependencies; written from the spec README and JSON Schemas only.
//   bun main.ts read <capsule-dir> [--json]
//   bun main.ts checkpoint <capsule-dir> <work_id> --set key=value [--set key=value ...]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = any; // parsed JSON; validate() checks each record against SHAPES before it is used
type Files = Map<string, Uint8Array>; // capsule-relative path ("/"-separated) -> bytes
interface Work { work: Json; checkpoints: Json[]; handoffs: Json[] }
type Capsule = ReturnType<typeof validate>;

const PROTOCOL = "paap/0.1";
// §7 brief order, which is also the order of the checkpoint body fields (§4.4).
const BODY_FIELDS = ["goal", "current_state", "decisions", "unresolved_questions", "failed_attempts",
  "relevant_artifacts", "relevant_memory", "git_state", "capability_requirements"];
const BLIND_FIELDS = ["goal", "relevant_artifacts", "git_state", "capability_requirements"]; // I-8
const CONVERSATION_KEYS = ["conversation", "messages", "transcript"]; // I-2
const PRIVATE_JWK = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]; // I-9
const IN_PROGRESS = ["frozen", "capsule_ready", "routed"]; // I-6
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const CREDENTIAL_REF = new RegExp(`^env:${NAME}(,${NAME})*$`); // I-4

// Record shapes from §4 and the schemas. Types: s text, t timestamp, i integer >= 0, n integer >= 1,
// h sha-256 hex, k "<kind>:<id>", N env NAME, x ext, j public JWK, * any JSON, "a|b" enum,
// @name nested shape, [ array of, ? optional. A key not listed is unknown (I-10).
const SHAPES: Record<string, Record<string, string>> = {
  manifest: { protocol: PROTOCOL, exported_at: "t", exporter: "@exporter", contents: "[@entry", reenter: "@reenter", ext: "?x" },
  exporter: { name: "s", version: "s" }, entry: { path: "s", sha256: "h" }, reenter: { credential_refs: "[N", devices: "i" },
  identity: { protocol: PROTOCOL, account_id: "s", agent_id: "s", display_name: "s", owner: "?k",
    handles: "[@handle", keys: "@keys", exported_at: "t", ext: "?x" },
  handle: { handle: "s", status: "current|alias", authority: "?s" },
  keys: { account: "?@account", devices: "[@device" }, account: { key_id: "s", jwk: "j" },
  device: { id: "s", name: "s", jwk: "j", revoked_at: "?t" },
  work: { id: "s", owner: "k", title: "s", goal: "?s",
    status: "triage|backlog|todo|scheduled|ready|running|review|blocked|done|needs_user",
    visibility: "full|masked|local_only|none", lease: "@lease", profile: "full|reviewer_blind",
    parent_work_id: "?s", forked_from: "?@forked_from", created_at: "t", updated_at: "t", ext: "?x" },
  lease: { epoch: "i", holder_run: "?s", acquired_at: "?t", expires_at: "?t" },
  forked_from: { work_id: "s", checkpoint_version: "n" },
  checkpoint: { work_id: "s", version: "n", write_epoch: "i", run_id: "?s", content_hash: "h",
    based_on: "?@based_on", body: "@body", created_at: "t", ext: "?x" },
  based_on: { work_id: "?s", version: "n" },
  body: Object.fromEntries(BODY_FIELDS.map((field) => [field, "?*"])),
  handoff: { id: "s", work_id: "s", from_run: "?s", from_epoch: "i", reserved_epoch: "i", to_runtime: "s",
    source_state: "?held|lapsed", checkpoint_version: "?n", state: "frozen|capsule_ready|routed|committed|failed",
    reason: "?s", note: "?s", expires_at: "t", created_at: "t", updated_at: "t", ext: "?x" },
};
const isObject = (v: Json) => v !== null && typeof v === "object" && !Array.isArray(v);
const ATOMS: Record<string, (v: Json) => boolean> = {
  s: (v) => typeof v === "string" && v !== "",
  t: (v) => typeof v === "string" && /^(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?Z$/.test(v), // §2
  i: (v) => Number.isInteger(v) && v >= 0,
  n: (v) => Number.isInteger(v) && v >= 1,
  h: (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
  k: (v) => typeof v === "string" && /^[a-z]+:[^:]+$/.test(v),
  N: (v) => typeof v === "string" && new RegExp(`^${NAME}$`).test(v),
  x: (v) => isObject(v) && Object.keys(v).every((key) => /^[a-z0-9-]+\.[A-Za-z0-9_.-]+$/.test(key)),
  j: (v) => isObject(v) && typeof v.kty === "string" && v.kty !== "",
  "*": () => true,
};

class Fault extends Error {} // message: "<reason> <path><json pointer>", reasons from §9
function bad(reason: string, path: string, at = ""): never { throw new Fault(`${reason} ${path}${at}`); }
function fail(message: string): never { console.error(`miniroly: ${message}`); process.exit(1); }

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// RFC 8785 (JCS): no whitespace; strings and numbers as ECMAScript JSON.stringify; object members sorted by
// UTF-16 code units (the default Array#sort order), recursively; arrays keep their order. Members are joined
// by hand because a rebuilt object would enumerate integer-like keys ("10") before the others.
function jcs(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

function shape(value: Json, name: string, path: string, at: string) {
  if (!isObject(value)) bad("invalid_field", path, at);
  const fields = SHAPES[name] ?? bad("invalid_field", path, at);
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) bad("unknown_key", path, `${at}/${key}`);
  for (const [key, type] of Object.entries(fields)) {
    if (Object.hasOwn(value, key)) check(value[key], type.replace(/^\?/, ""), path, `${at}/${key}`);
    else if (!type.startsWith("?")) bad("missing_field", path, `${at}/${key}`);
  }
}
function check(value: Json, type: string, path: string, at: string) {
  if (type.startsWith("[")) {
    if (!Array.isArray(value)) bad("invalid_field", path, at);
    value.forEach((item: Json, i: number) => check(item, type.slice(1), path, `${at}/${i}`));
  } else if (type.startsWith("@")) shape(value, type.slice(1), path, at);
  else if (!(ATOMS[type]?.(value) ?? type.split("|").includes(value))) bad("invalid_field", path, at);
  if (type === "j" && PRIVATE_JWK.some((member) => Object.hasOwn(value, member))) bad("private_key_in_export", path, at);
}

// I-2, I-4 at any depth of a body. Adds the credential NAMEs it finds to `names`.
function walkBody(value: Json, path: string, at: string, names: Set<string>) {
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const here = `${at}/${key}`;
    if (CONVERSATION_KEYS.includes(key)) bad("conversation_in_checkpoint", path, here);
    if (key === "credential_ref") {
      if (typeof item !== "string" || !CREDENTIAL_REF.test(item)) bad("invalid_credential_ref", path, here);
      for (const credential of item.slice(4).split(",")) names.add(credential);
    }
    walkBody(item, path, here, names);
  }
}

// I-JSON (§2) beyond JSON.parse: no lone surrogate in any string, no member name twice in one object.
function iJson(text: string, path: string, open: Set<string>[] = []) {
  for (const [token, colon] of text.matchAll(/"(?:[^"\\]+|\\.)*"(\s*:)?|[{}]/g)) {
    if (token === "{" || token === "}") { if (token === "{") open.push(new Set()); else open.pop(); continue; }
    const value: string = JSON.parse(colon ? token.slice(0, -colon.length) : token);
    if (!value.isWellFormed()) bad("not_i_json", path);
    if (colon) { if (open.at(-1)!.has(value)) bad("invalid_json", path); open.at(-1)!.add(value); }
  }
}

function loadDir(dir: string, prefix = "", files: Files = new Map()): Files {
  let entries; try { entries = readdirSync(join(dir, prefix), { withFileTypes: true }); } catch { return fail(`cannot read ${join(dir, prefix)}`); }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // not part of the capsule (§3)
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) loadDir(dir, path, files);
    else if (entry.isFile()) files.set(path, readFileSync(join(dir, path)));
  }
  return files;
}

function validate(files: Files) {
  const record = (path: string, name: string): Json => {
    const bytes = files.get(path) ?? bad("missing_file", path);
    let text = "", value: Json;
    try { value = JSON.parse(text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return bad("invalid_json", path); }
    iJson(text, path); // ignoreBOM keeps a byte order mark in the text, so JSON.parse above rejects it (§2)
    if (isObject(value) && Object.hasOwn(value, "protocol") && value.protocol !== PROTOCOL) bad("unsupported_protocol", path, "/protocol");
    shape(value, name, path, "");
    return value;
  };
  const manifest = record("manifest.json", "manifest");
  const workIds = new Set([...files.keys()].flatMap((path) => path.match(/^works\/([^/]+)\//)?.[1] ?? []));
  for (const path of ["identity.json", ...[...workIds].map((id) => `works/${id}/work.json`)]) {
    if (!files.has(path)) bad("missing_file", path);
  }
  const listed = new Set<string>();
  manifest.contents.forEach(({ path, sha256: hash }: Json, i: number) => {
    if (path === "manifest.json" || listed.has(path) || !files.has(path)) bad("manifest_contents_mismatch", "manifest.json", `/contents/${i}`);
    if (sha256(files.get(path)!) !== hash) bad("manifest_hash_mismatch", path);
    listed.add(path);
  });
  for (const path of files.keys()) if (path !== "manifest.json" && !listed.has(path)) bad("manifest_contents_mismatch", path);

  const identity = record("identity.json", "identity");
  if (identity.handles.filter((h: Json) => h.status === "current").length > 1) bad("invalid_field", "identity.json", "/handles");
  const works = new Map<string, Work>();
  for (const id of workIds) {
    const work = record(`works/${id}/work.json`, "work");
    if (work.id !== id) bad("path_mismatch", `works/${id}/work.json`, "/id");
    works.set(id, { work, checkpoints: [], handoffs: [] });
  }
  const names = new Set<string>();
  for (const path of files.keys()) {
    const [, id, kind, file] = path.match(/^works\/([^/]+)\/(checkpoints|handoffs)\/([^/]+)\.json$/) ?? [];
    if (!id) continue; // a listed path v0.1 does not define: ignored (§3)
    const entry = works.get(id)!;
    if (kind === "handoffs") {
      const handoff = record(path, "handoff");
      if (handoff.id !== file || handoff.work_id !== id) bad("path_mismatch", path);
      if (handoff.reserved_epoch !== handoff.from_epoch + 1) bad("epoch_not_reserved", path, "/reserved_epoch");
      entry.handoffs.push(handoff);
      continue;
    }
    const checkpoint = record(path, "checkpoint");
    if (checkpoint.work_id !== id || String(checkpoint.version) !== file) bad("path_mismatch", path);
    const hidden = Object.keys(checkpoint.body).find((field) => !BLIND_FIELDS.includes(field));
    if (entry.work.profile === "reviewer_blind" && hidden) bad("profile_field_not_allowed", path, `/body/${hidden}`);
    walkBody(checkpoint.body, path, "/body", names);
    if (sha256(jcs(checkpoint.body)) !== checkpoint.content_hash) bad("content_hash_mismatch", path, "/content_hash");
    entry.checkpoints.push(checkpoint);
  }
  for (const [id, { work, checkpoints, handoffs }] of works) {
    checkpoints.sort((a, b) => a.version - b.version);
    const gap = checkpoints.find((checkpoint, i) => checkpoint.version !== i + 1);
    if (gap) bad("version_gap", `works/${id}/checkpoints/${gap.version}.json`, "/version");
    // I-12: an earlier version of this work (named by work_id or not), or a version of another work
    for (const { based_on: base, version } of checkpoints) {
      const found = base && works.get(base.work_id ?? id)?.checkpoints.some((c) => c.version === base.version);
      const earlier = (base?.work_id ?? id) !== id || base?.version < version;
      if (base && !(found && earlier)) bad("based_on_missing", `works/${id}/checkpoints/${version}.json`, "/based_on");
    }
    const busy = handoffs.filter((handoff) => IN_PROGRESS.includes(handoff.state));
    if (busy.length > 1) bad("handoff_in_progress_twice", `works/${id}/handoffs/${busy[1].id}.json`);
    for (const handoff of handoffs) {
      const path = `works/${id}/handoffs/${handoff.id}.json`;
      const version = handoff.checkpoint_version;
      if (version !== undefined && !checkpoints.some((c) => c.version === version)) bad("handoff_checkpoint_missing", path, "/checkpoint_version");
      const floor = handoff.state === "committed" ? handoff.reserved_epoch + 1 : handoff.state === "failed" ? 0 : handoff.reserved_epoch; // I-5
      if (work.lease.epoch < floor) bad("lease_behind_handoff", path);
    }
  }
  const devices = identity.keys.devices.filter((device: Json) => device.revoked_at === undefined).length;
  const refs = jcs([...names].sort());
  if (jcs(manifest.reenter.credential_refs) !== refs || manifest.reenter.devices !== devices) bad("reenter_mismatch", "manifest.json", "/reenter");
  return { manifest, identity, works, names };
}

// §8.1: the latest instant wins, ties go to the sorted-first id. Timestamps compare as instants (§2).
const instant = (t: string) => t.slice(0, 19) + (t.slice(19, -1) || ".").padEnd(10, "0");
function pick<T>(items: T[], at: (x: T) => string, id: (x: T) => string): T | null {
  return items.reduce<T | null>((best, x) => {
    if (best === null) return x;
    const [mine, theirs] = [instant(at(x)), instant(at(best))];
    return mine > theirs || (mine === theirs && id(x) < id(best)) ? x : best;
  }, null);
}

function summarize({ manifest, identity, works }: Capsule) {
  const handle = identity.handles.find((h: Json) => h.status === "current")?.handle;
  const open = [...works.values()].filter((entry) => entry.work.status !== "done");
  const current = pick(open, (entry) => entry.work.updated_at, (entry) => entry.work.id);
  const checkpoint = current?.checkpoints.at(-1);
  const handoff = current && pick(current.handoffs, (h) => h.created_at, (h) => h.id);
  return {
    protocol: manifest.protocol,
    handle: handle === undefined ? null : `@${handle}`,
    display_name: identity.display_name,
    current_work: current ? { id: current.work.id, title: current.work.title, status: current.work.status } : null,
    latest_checkpoint: checkpoint ? { version: checkpoint.version, write_epoch: checkpoint.write_epoch, content_hash: checkpoint.content_hash,
      brief_sections: BODY_FIELDS.filter((field) => Object.hasOwn(checkpoint.body, field)) } : null,
    last_handoff: handoff ? { id: handoff.id, state: handoff.state, to_runtime: handoff.to_runtime, reserved_epoch: handoff.reserved_epoch } : null,
    reenter: manifest.reenter,
  };
}

// §7: identity and work lines first, then one "## <field>" section per present body field.
function brief(capsule: Capsule): string {
  const s = summarize(capsule);
  const entry = s.current_work && capsule.works.get(s.current_work.id)!;
  const lines = [`${s.handle ?? "(no handle)"} (${s.display_name})`];
  lines.push(entry ? `work ${entry.work.id}: ${entry.work.title} [${entry.work.status}], lease epoch ${entry.work.lease.epoch}` : "no open work");
  const h = s.last_handoff; if (h) lines.push(`last handoff ${h.id}: ${h.state}, to ${h.to_runtime} at epoch ${h.reserved_epoch}`);
  const checkpoint = entry?.checkpoints.at(-1);
  if (!checkpoint) return lines.join("\n");
  const base = checkpoint.based_on ? `, based on ${checkpoint.based_on.work_id ?? ""} v${checkpoint.based_on.version}` : "";
  lines.push(`checkpoint v${checkpoint.version}, write epoch ${checkpoint.write_epoch}${base}`);
  for (const field of s.latest_checkpoint!.brief_sections) {
    const value = checkpoint.body[field];
    lines.push("", `## ${field}`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  return lines.join("\n");
}

// L2: carry the latest body forward, apply --set, and judge the whole next capsule before writing a byte.
function checkpoint(dir: string, workId: string, sets: string[]) {
  const files = loadDir(dir);
  const capsule = validate(files);
  const entry = capsule.works.get(workId) ?? fail(`no work ${workId}`);
  const busy = entry.handoffs.find((handoff) => IN_PROGRESS.includes(handoff.state));
  if (busy) fail(`handoff_in_progress works/${workId}/handoffs/${busy.id}.json: nobody holds the lease until it is committed or failed (§6)`);
  const latest = entry.checkpoints.at(-1);
  const body = Object.assign(Object.create(null), latest?.body); // null prototype: "__proto__" stays a key
  for (const set of sets) {
    const eq = set.indexOf("="); if (eq < 1) fail(`--set wants key=value, got ${JSON.stringify(set)}`);
    const [key, raw] = [set.slice(0, eq), set.slice(eq + 1)];
    try { body[key] = JSON.parse(raw); } catch { body[key] = raw; } // not JSON: a plain string
  }
  const version = (latest?.version ?? 0) + 1;
  const path = `works/${workId}/checkpoints/${version}.json`;
  const record = { work_id: workId, version, write_epoch: entry.work.lease.epoch, content_hash: sha256(jcs(body)), body,
    created_at: new Date().toISOString() };
  const bytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
  walkBody(body, path, "/body", capsule.names);
  const manifest = { ...capsule.manifest, contents: [...capsule.manifest.contents, { path, sha256: sha256(bytes) }],
    reenter: { ...capsule.manifest.reenter, credential_refs: [...capsule.names].sort() } };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  validate(new Map(files).set(path, bytes).set("manifest.json", manifestBytes));
  mkdirSync(join(dir, `works/${workId}/checkpoints`), { recursive: true });
  try { writeFileSync(join(dir, path), bytes, { flag: "wx" }); } catch { fail(`cannot create ${path}`); } // never overwrite (I-1)
  writeFileSync(join(dir, ".manifest.json.tmp"), manifestBytes); // dot files are not part of the capsule
  renameSync(join(dir, ".manifest.json.tmp"), join(dir, "manifest.json"));
  console.log(`${path} ${record.content_hash}`);
}

const [command, dir, ...rest] = process.argv.slice(2);
try {
  if (command === "read" && dir && rest.every((arg) => arg === "--json")) {
    const capsule = validate(loadDir(dir));
    console.log(rest.length > 0 ? JSON.stringify(summarize(capsule), null, 2) : brief(capsule));
  } else if (command === "checkpoint" && dir && rest.length >= 3 && rest.length % 2 === 1
    && rest.every((arg, i) => i % 2 === 0 || arg === "--set")) {
    checkpoint(dir, rest[0]!, rest.filter((_, i) => i > 0 && i % 2 === 0));
  } else fail("usage: main.ts read <capsule-dir> [--json] | main.ts checkpoint <capsule-dir> <work_id> --set key=value ...");
} catch (error) {
  if (error instanceof Fault) fail(error.message);
  throw error;
}
