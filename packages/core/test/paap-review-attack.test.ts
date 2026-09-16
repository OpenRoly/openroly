// module review paap-v0.1(PBI-0552〜0556・0559・0564)の攻撃。spec と 3 つの実装(core の validator・examples/miniroly・
// examples/miniroly-py)の verdict が割れる入力、L3(--continued-from)の判定、export の秘密を撃つ。
// 1 つの入力に破れは 1 つだけ置く(複数の破れの reason の順は spec が規定しない)。第二実装は子 process で起こす(import しない)。
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCapsuleBody } from "../src/capsule.ts";
import { validateCapsuleDir } from "../src/node.ts";
import { buildCapsuleFiles, verifyContinuation, type CapsuleExportInput } from "../src/protocol-export.ts";
import { summarizeCapsule, TIMESTAMP_RE, type PaapCapsule } from "../src/protocol.ts";

const ROOT = join(import.meta.dir, "../../..");
const SPEC = join(ROOT, "specs/paap");
const VALID = join(SPEC, "v0.1/fixtures/valid");
const MINIROLY = join(ROOT, "examples/miniroly/main.ts");
const MINIROLY_PY = join(ROOT, "examples/miniroly-py/miniroly.py");
const TIMEOUT = 120_000; // 1 case に子 process 2 本

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const spawn = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
function python3(): string {
  const found = Bun.which("python3");
  if (!found) throw new Error("python3 not found: examples/miniroly-py needs Python 3 on PATH");
  return found;
}
const listFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();

/** valid/<kase> を tmp に複製して change し、manifest の contents を全 file の bytes に合わせる(manifest の他は触らない) */
function copy(kase: string, change: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), `paap-attack-${kase}-`));
  cpSync(join(VALID, kase, "capsule"), dir, { recursive: true });
  change(dir);
  const manifest = readJson(join(dir, "manifest.json"));
  manifest.contents = listFiles(dir)
    .filter((p) => p !== "manifest.json")
    .map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }));
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}
function text(dir: string, path: string, change: (s: string) => string) {
  const before = readFileSync(join(dir, path), "utf8");
  const after = change(before);
  if (after === before) throw new Error(`edit did not apply: ${path}`);
  writeFileSync(join(dir, path), after);
}
/** JSON を直して書く。body を持つ record は content_hash を取り直す(狙った破れ以外を作らない) */
function edit(dir: string, path: string, change: (doc: any) => void) {
  const doc = readJson(join(dir, path));
  change(doc);
  if (doc.body) doc.content_hash = hashCapsuleBody(doc.body);
  writeFileSync(join(dir, path), `${JSON.stringify(doc, null, 2)}\n`);
}

const BASIC = readJson(join(VALID, "basic/expect.summary.json"));
const CUR = `works/${BASIC.current_work.id}`;
const OTHER = `works/${readdirSync(join(VALID, "basic/capsule/works")).find((id) => id !== BASIC.current_work.id)}`;
const LATEST = `${CUR}/checkpoints/${BASIC.latest_checkpoint.version}.json`;
const createdAt = (at: string) => (d: string) => edit(d, `${CUR}/work.json`, (w) => (w.created_at = at));

// [名前, core と miniroly が言うべき verdict, basic への 1 つの変更]
const CASES: [string, string, (dir: string) => void][] = [
  // I-JSON: JSON.parse は後勝ち。先勝ちの parser は会話 key を持つ本文を読む(hash は後勝ちの本文で合っている)
  ["同じ member 名で body の会話 key を隠す", "invalid_json", (d) =>
    text(d, LATEST, (s) => s.replace(`"body": {`, `"body": {\n    "goal": { "messages": ["the whole chat"] },`))],
  ["top-level の member 名を 2 度", "invalid_json", (d) => text(d, `${CUR}/work.json`, (s) => s.replace(`"title":`, `"title": "shadowed",\n  "title":`))],
  ["byte order mark で始まる", "invalid_json", (d) =>
    writeFileSync(join(d, "identity.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(join(d, "identity.json"))]))],
  ["body の外(work.title)に lone surrogate", "not_i_json", (d) => edit(d, `${CUR}/work.json`, (w) => (w.title = "invoice \ud800 export"))],
  ["body の入れ子の member 名に lone surrogate", "not_i_json", (d) => edit(d, LATEST, (c) => (c.body.decisions = { "\udc00": 1 }))],
  ["credential_ref の末尾に空の NAME", "invalid_credential_ref", (d) =>
    edit(d, LATEST, (c) => (c.body.capability_requirements[0].credential_ref = "env:GITHUB_TOKEN,"))],
  ["credential_ref の先頭に空の NAME", "invalid_credential_ref", (d) =>
    edit(d, LATEST, (c) => (c.body.capability_requirements[0].credential_ref = "env:,GITHUB_TOKEN"))],
  ["based_on が自分の work を名指しして後の版", "based_on_missing", (d) =>
    edit(d, `${CUR}/checkpoints/2.json`, (c) => (c.based_on = { work_id: BASIC.current_work.id, version: BASIC.latest_checkpoint.version }))],
  ["based_on が自分の work を名指しして自分自身", "based_on_missing", (d) =>
    edit(d, LATEST, (c) => (c.based_on = { work_id: BASIC.current_work.id, version: BASIC.latest_checkpoint.version }))],
  ["2026-02-29(閏年ではない)", "invalid_field", createdAt("2026-02-29T09:00:00Z")],
  ["2100-02-29(100 で割れて 400 で割れない)", "invalid_field", createdAt("2100-02-29T09:00:00Z")],
  ["2026-13-01", "invalid_field", createdAt("2026-13-01T09:00:00Z")],
  ["24:00:00", "invalid_field", createdAt("2026-09-14T24:00:00Z")],
  ["閏秒 23:59:60", "invalid_field", createdAt("2026-12-31T23:59:60Z")],
  ["2028-02-29", "ok", createdAt("2028-02-29T09:00:00Z")],
  ["2000-02-29", "ok", createdAt("2000-02-29T09:00:00Z")],
  ["9 桁の小数秒", "ok", createdAt("2026-09-14T09:00:00.123456789Z")],
  // §8.1: 瞬間で比べる。ミリ秒に丸めると同時刻になり、id の昇順で先の work(done を開いた方)を選んでしまう
  ["ミリ秒より細かい差で後の work が current", "ok", (d) => {
    edit(d, `${OTHER}/work.json`, (w) => ((w.status = "running"), (w.updated_at = "2026-09-14T11:40:00.0001Z")));
    edit(d, `${CUR}/work.json`, (w) => (w.updated_at = "2026-09-14T11:40:00.0002Z"));
  }],
  ["整数を 3.0 / 1.0 と書く", "ok", (d) =>
    text(d, LATEST, (s) => s.replace(/"version": (\d+),/, `"version": $1.0,`).replace(/"write_epoch": (\d+),/, `"write_epoch": $1.0,`))],
];

describe("攻撃 A: 1 つの破れに 3 実装が同じ verdict(core の reason = miniroly の reason・ok なら 3 つの要約が同じ)", () => {
  test.each(CASES)("%s → %s", (_name, expected, change) => {
    const dir = copy("basic", change);
    try {
      const v = validateCapsuleDir(dir);
      const ts = spawn([process.execPath, MINIROLY, "read", dir, "--json"]);
      const miniroly = ts.code === 0 ? "ok" : (ts.err.split(" ")[1] ?? ts.err);
      expect({ core: v.ok ? "ok" : `${v.reason}`, miniroly }).toEqual({ core: expected, miniroly: expected });
      if (!v.ok) return;
      const py = spawn([python3(), MINIROLY_PY, "read", dir, "--json"]);
      expect({ code: py.code, err: py.err }).toEqual({ code: 0, err: "" });
      const core = summarizeCapsule(v.capsule);
      expect({ miniroly: JSON.parse(ts.out), py: JSON.parse(py.out) }).toEqual({ miniroly: core, py: core });
      expect(core.current_work?.id).toBe(BASIC.current_work.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("miniroly L2 は lone surrogate を含む本文を 1 byte も書かない", () => {
    const dir = copy("basic", () => {});
    try {
      const before = listFiles(dir).map((p) => [p, sha256(readFileSync(join(dir, p)))]);
      const run = spawn([process.execPath, MINIROLY, "checkpoint", dir, BASIC.current_work.id, "--set", 'current_state="\\ud800"']);
      expect({ code: run.code, reason: run.err.split(" ")[1] }).toEqual({ code: 1, reason: "not_i_json" });
      expect(listFiles(dir).map((p) => [p, sha256(readFileSync(join(dir, p)))])).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test("2 MiB の patch(escape が 24 万個)でも I-JSON の走査は終わり、core と miniroly が ok", () => {
    const patch = `diff --git a/x b/x\n${'+ "quoted" \\ back\\slash {brace} :\n'.repeat(60_000)}`;
    const dir = copy("basic", (d) => edit(d, LATEST, (c) => (c.body.git_state = { baseCommit: "abc", dirty: 1, trackedPatch: patch })));
    try {
      expect(validateCapsuleDir(dir)).toMatchObject({ ok: true });
      expect(spawn([process.execPath, MINIROLY, "read", dir, "--json"]).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("攻撃 B: 時刻の式は暦と一致し、spec 本文・5 schema・core が同じ式", () => {
  test("400 年周期の閏年規則と 0000 年: 暦に在る日だけが通る", () => {
    const wrong: string[] = [];
    for (const y of [0, 1, 4, 100, 104, 400, 1900, 1996, 2000, 2023, 2024, 2100, 2400, 9999]) {
      const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      for (let m = 0; m <= 13; m++) {
        for (let d = 0; d <= 32; d++) {
          const t = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00Z`;
          const real = m >= 1 && m <= 12 && d >= 1 && d <= (days[m - 1] ?? 0);
          if (TIMESTAMP_RE.test(t) !== real) wrong.push(t);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("時刻の部分: 00〜23 時・閏秒なし・小数秒 1〜9 桁・大文字の Z だけ", () => {
    const cases: Record<string, boolean> = {
      "T00:00:00Z": true,
      "T23:59:59.999999999Z": true,
      "T24:00:00Z": false,
      "T23:60:00Z": false,
      "T23:59:60Z": false,
      "T23:59:59.1234567890Z": false,
      "T23:59:59.Z": false,
      "T23:59:59z": false,
      "T23:59:59+00:00": false,
    };
    expect(Object.fromEntries(Object.keys(cases).map((k) => [k, TIMESTAMP_RE.test(`2024-02-29${k}`)]))).toEqual(cases);
  });

  test("spec 本文と 5 schema の式 = core の式(書き写しがずれていない)", () => {
    expect(readFileSync(join(SPEC, "README.md"), "utf8")).toContain(`\`${TIMESTAMP_RE.source}\``);
    for (const o of ["identity", "work", "checkpoint", "handoff", "manifest"]) {
      const pattern = readJson(join(SPEC, `v0.1/${o}.schema.json`)).$defs.timestamp.pattern;
      expect({ o, pattern }).toEqual({ o, pattern: TIMESTAMP_RE.source });
    }
  });
});

describe("攻撃 C: --continued-from(L3)は commit の時に書き換えた handoff を通さない", () => {
  const ROUTED = readJson(join(VALID, "handoff-routed/expect.summary.json"));
  const W = `works/${ROUTED.current_work.id}`;
  const H = `${W}/handoffs/${ROUTED.last_handoff.id}.json`;
  const R = ROUTED.last_handoff.reserved_epoch as number;
  const N = ROUTED.latest_checkpoint.version as number;
  const BODY = { goal: "continue the routed work", current_state: "picked up by the next runtime" };
  const load = (dir: string): PaapCapsule => {
    const v = validateCapsuleDir(dir);
    if (!v.ok) throw new Error(`${v.reason} ${v.path}${v.at}`);
    return v.capsule;
  };
  /** 正直な L3(committed・lease = reserved + 1・版 N+1 を write_epoch = 元の reserved + 1 で)に、handoff の書き換えを 1 つ */
  const continued = (change: (h: any) => void) =>
    copy("handoff-routed", (d) => {
      let reserved = R;
      edit(d, H, (h) => {
        h.state = "committed";
        h.updated_at = "2026-09-14T12:30:00Z";
        change(h);
        reserved = h.reserved_epoch;
      });
      edit(d, `${W}/work.json`, (w) => (w.lease = { epoch: reserved + 1, holder_run: "run-next" }));
      const cp = { work_id: ROUTED.current_work.id, version: N + 1, write_epoch: R + 1, run_id: "run-next", content_hash: hashCapsuleBody(BODY), body: BODY, created_at: "2026-09-14T12:30:00Z" };
      writeFileSync(join(d, `${W}/checkpoints/${N + 1}.json`), `${JSON.stringify(cp, null, 2)}\n`);
    });

  test.each([
    ["書き換えない(対照)", (_h: any) => {}, { ok: true }],
    ["from_epoch / reserved_epoch を先へずらす(lease もそれに合わせる)", (h: any) => ((h.from_epoch += 2), (h.reserved_epoch += 2)), { ok: false, reason: "handoff_rewritten" }],
    ["行き先の runtime を替える", (h: any) => (h.to_runtime = `${h.to_runtime}-other`), { ok: false, reason: "handoff_rewritten" }],
    ["起点の版(checkpoint_version)を消す", (h: any) => {
      if (h.checkpoint_version === undefined) throw new Error("fixture の routed handoff に checkpoint_version が無い");
      delete h.checkpoint_version;
    }, { ok: false, reason: "handoff_rewritten" }],
  ])("%s", (_name, change, expected) => {
    const dir = continued(change);
    try {
      expect(verifyContinuation(load(join(VALID, "handoff-routed/capsule")), load(dir))).toMatchObject(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("攻撃 D: export はこの端末の秘密の値が紛れた本文を書き出さない(本文は agent が書く自由な JSON)", () => {
  const TOKEN = "orly_rt_0123456789abcdefSECRETvalue";
  const T = "2026-09-14T06:00:00.000Z";
  const input = (body: Record<string, unknown>, title = "export drill", secrets: string[] = [TOKEN]): CapsuleExportInput => ({
    exportedAt: new Date(T),
    exporter: { name: "openroly", version: "0.1.0" },
    account: { account_id: "acc_1", agent_id: "agt_1", display_name: "Alice", handle: "alice" },
    accountKey: null,
    devices: [],
    secrets,
    works: [
      {
        work: { id: "wrk_a", owner: "account:acc_1", title, status: "running", visibility: "full", lease_epoch: 1, lease_holder_run: "R1", context_profile: "full", created_at: T, updated_at: T },
        capsules: [{ row: { version: 1, write_epoch: 1, run_id: "R1", body: { payload_hash: hashCapsuleBody(body) }, created_at: T }, payload: body }],
        transfers: [],
      },
    ],
  });

  test("秘密の無い本文は書き出せる(対照)", () => {
    expect(buildCapsuleFiles(input({ goal: "ship", current_state: "clean" }))).toMatchObject({ ok: true });
  });
  test("本文の文字列に token → secret_value(work と版)", () => {
    expect(buildCapsuleFiles(input({ goal: "ship", current_state: `debugging with OPENROLY_TOKEN=${TOKEN}` }))).toEqual({
      ok: false,
      problems: [{ reason: "secret_value", work_id: "wrk_a", version: 1 }],
    });
  });
  test("git_state の patch の奥に token → secret_value", () => {
    const body = { goal: "ship", git_state: { baseCommit: "abc", dirty: 1, trackedPatch: `+token = "${TOKEN}"\n` } };
    expect(buildCapsuleFiles(input(body))).toEqual({ ok: false, problems: [{ reason: "secret_value", work_id: "wrk_a", version: 1 }] });
  });
  test("work の title に token → secret_value(work だけ)", () => {
    expect(buildCapsuleFiles(input({ goal: "ship" }, `rotate ${TOKEN}`))).toEqual({ ok: false, problems: [{ reason: "secret_value", work_id: "wrk_a" }] });
  });
});
