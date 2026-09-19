// PBI-0554 / CAP-15 Z1: MiniRoly(examples/miniroly/main.ts)は OpenRoly の code を読まずに
// PAAP v0.1 の L1 Reader + L2 Writer を名乗れるか。期待は spec の fixtures と README から読み、
// L2 の出力は core の validateCapsule が判定する。main.ts は子 process で起こす(import しない = 独立)。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPSULE_FIELDS } from "../src/capsule";
import { validateCapsule } from "../src/protocol";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MAIN = join(ROOT, "examples", "miniroly", "main.ts");
const FIXTURES = join(ROOT, "specs", "paap", "v0.1", "fixtures");
const TIMEOUT = 60_000; // 子 process を十数本起こす

const miniroly = (...args: string[]) => {
  const run = Bun.spawnSync([process.execPath, MAIN, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
};
const cases = (kind: string) => readdirSync(join(FIXTURES, kind)).filter((name) => !name.startsWith(".")).sort();
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const summaryOf = (kase: string) => readJson(join(FIXTURES, "valid", kase, "expect.summary.json"));

function copyValid(kase: string): string {
  const dir = mkdtempSync(join(tmpdir(), `miniroly-${kase}-`));
  cpSync(join(FIXTURES, "valid", kase, "capsule"), dir, { recursive: true });
  return dir;
}
/** core の validateCapsule が受け取る形: capsule 内の相対 path("/" 区切り)→ bytes */
function filesOf(dir: string, prefix = "", files: Record<string, Uint8Array> = {}) {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(dir, path, files);
    else files[path] = readFileSync(join(dir, path));
  }
  return files;
}
/** record を書き換え、manifest の sha256 をその file だけ合わせる(1 fault に保つ) */
function rewrite(dir: string, path: string, edit: (value: any) => void) {
  const value = readJson(join(dir, path));
  edit(value);
  const bytes = JSON.stringify(value);
  writeFileSync(join(dir, path), bytes);
  const manifest = readJson(join(dir, "manifest.json"));
  manifest.contents.find((item: { path: string }) => item.path === path).sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("miniroly L1 Reader(AC-1・AC-X3)", () => {
  test("valid fixtures の要約は expect.summary.json と一致する", () => {
    const valid = cases("valid");
    expect(valid.length).toBeGreaterThanOrEqual(3);
    for (const kase of valid) {
      const run = miniroly("read", join(FIXTURES, "valid", kase, "capsule"), "--json");
      expect({ kase, code: run.code, err: run.err }).toEqual({ kase, code: 0, err: "" });
      expect({ kase, summary: JSON.parse(run.out) }).toEqual({ kase, summary: summaryOf(kase) });
    }
  }, TIMEOUT);

  test("ext の未知 key は無視し、top-level の未知 key は exit 1", () => {
    const summary = summaryOf("basic");
    const workJson = `works/${summary.current_work.id}/work.json`;
    const withExt = copyValid("basic");
    rewrite(withExt, workJson, (work) => { work.ext = { "acme.x": { nested: [1, 2] } }; });
    const ignored = miniroly("read", withExt, "--json");
    expect(ignored.code).toBe(0);
    expect(JSON.parse(ignored.out)).toEqual(summary);

    const withUnknown = copyValid("basic");
    rewrite(withUnknown, workJson, (work) => { work.acme_x = 1; });
    const rejected = miniroly("read", withUnknown, "--json");
    expect(rejected.code).toBe(1);
    expect(rejected.err).toStartWith("miniroly: unknown_key");
  }, TIMEOUT);
});

describe("miniroly の brief(AC-2)", () => {
  test("見出しは spec §7 の節順 = core の CAPSULE_FIELDS 順で、在る field だけ", () => {
    const readme = readFileSync(join(ROOT, "specs", "paap", "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## 7. Brief"), readme.indexOf("## 8."));
    const specOrder = [...section.matchAll(/^\d+\. `([a-z_]+)`$/gm)].map((m) => m[1]);
    const schemaOrder = Object.keys(readJson(join(ROOT, "specs", "paap", "v0.1", "checkpoint.schema.json")).properties.body.properties);
    expect(specOrder).toEqual([...CAPSULE_FIELDS]);
    expect(schemaOrder).toEqual([...CAPSULE_FIELDS]);

    const summary = summaryOf("basic");
    const run = miniroly("read", join(FIXTURES, "valid", "basic", "capsule"));
    expect(run.code).toBe(0);
    expect(run.out).toContain(summary.handle);
    expect(run.out).toContain(summary.current_work.id);
    if (summary.last_handoff) expect(run.out).toContain(summary.last_handoff.id);
    const headings = [...run.out.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings).toEqual(summary.latest_checkpoint.brief_sections);
    expect(headings).toEqual(CAPSULE_FIELDS.filter((field) => headings.includes(field)));
  }, TIMEOUT);

  // PBI-0667: based_on.work_id は optional(同じ work の前の版)。無い時に「based on  v1」(空白 2 つ)を出さない
  test("checkpoint 行の based_on は work_id が在れば「based on <work_id> v<n>」、無ければ「based on v<n>」", () => {
    const named = miniroly("read", join(FIXTURES, "valid", "reviewer-blind", "capsule"));
    expect(named.code).toBe(0);
    expect(named.out).toContain("\ncheckpoint v1, write epoch 1, based on wrk_01936b2a7c4e7a1b9f3d2e8c6a5b4d21 v1\n");
    const unnamed = miniroly("read", join(FIXTURES, "valid", "basic", "capsule"));
    expect(unnamed.code).toBe(0);
    expect(unnamed.out).toContain("\ncheckpoint v3, write epoch 1, based on v1\n");
  }, TIMEOUT);
});

describe("miniroly L2 Writer(AC-3・AC-X1・spec §8 L2)", () => {
  test("積んだ checkpoint を core が pass と判定する(version+1・JCS hash・manifest)", () => {
    const summary = summaryOf("basic");
    const dir = copyValid("basic");
    const run = miniroly(
      "checkpoint", dir, summary.current_work.id,
      "--set", "current_state=reviewing the second draft",
      "--set", 'failed_attempts=[{"tried":"retry on 429","why":"quota, not rate"}]',
      // JCS の急所: 整数に見える key が 2 つ("9" と "10" は JS の列挙順と UTF-16 順が逆)・数字より前の "!"・
      // BMP 外(サロゲート対)と U+FFFF の UTF-16 順・数値表記。"10" と英字だけでは素朴な実装も通る(2026-09-14 実測)
      "--set", 'decisions={"b":1,"10":2,"9":3,"!":4,"a":5,"😀":6,"\uffff":7,"n":[1e21,0.1,-0]}',
    );
    expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
    const version = summary.latest_checkpoint.version + 1;
    const path = `works/${summary.current_work.id}/checkpoints/${version}.json`;
    expect(existsSync(join(dir, path))).toBe(true);
    const verdict = validateCapsule(filesOf(dir));
    expect(verdict).toMatchObject({ ok: true });
    const after = JSON.parse(miniroly("read", dir, "--json").out);
    expect(after.latest_checkpoint.version).toBe(version);
  }, TIMEOUT);

  test("書けない物は exit 1 で 1 byte も書かない(I-2・I-4・I-8・I-10・§6 handoff 進行中)", () => {
    const summary = summaryOf("basic");
    // reviewer_blind の work を fixtures から探す(case 名に頼らない)
    const blind = cases("valid").flatMap((kase) => {
      const works = join(FIXTURES, "valid", kase, "capsule", "works");
      if (!existsSync(works)) return [];
      return readdirSync(works).filter((id) => readJson(join(works, id, "work.json")).profile === "reviewer_blind").map((id) => ({ kase, id }));
    })[0];
    const attempts: [string, string, string][] = [
      ["basic", summary.current_work.id, "messages=[]"],
      ["basic", summary.current_work.id, 'notes={"transcript":1}'],
      ["basic", summary.current_work.id, "credential_ref=vault:x"],
      ["basic", summary.current_work.id, 'decisions={"log":{"transcript":[]}}'],
      ["basic", summary.current_work.id, 'capability_requirements={"credential_ref":"vault:x"}'],
      ["basic", summary.current_work.id, '__proto__={"goal":"x"}'],
    ];
    expect(blind).toBeDefined();
    attempts.push([blind!.kase, blind!.id, "current_state=opinion"]);
    // §6 / L2: handoff が進行中(frozen / capsule_ready / routed)の work には積めない(summary から探す。case 名に頼らない)
    const busy = cases("valid").map((kase) => ({ kase, summary: summaryOf(kase) }))
      .find(({ summary }) => ["frozen", "capsule_ready", "routed"].includes(summary.last_handoff?.state));
    expect(busy).toBeDefined();
    attempts.push([busy!.kase, busy!.summary.current_work.id, "current_state=continuing anyway"]);
    for (const [kase, work, set] of attempts) {
      const dir = copyValid(kase);
      const before = filesOf(dir);
      const run = miniroly("checkpoint", dir, work, "--set", set);
      expect({ set, code: run.code }).toEqual({ set, code: 1 });
      expect({ set, files: filesOf(dir) }).toEqual({ set, files: before });
    }
  }, TIMEOUT);

  test("invalid fixtures は expect.json の reason で拒否する", () => {
    const invalid = cases("invalid");
    expect(invalid.length).toBeGreaterThan(0);
    for (const kase of invalid) {
      const { reason } = readJson(join(FIXTURES, "invalid", kase, "expect.json"));
      const run = miniroly("read", join(FIXTURES, "invalid", kase, "capsule"), "--json");
      expect({ kase, code: run.code, reason: run.err.split(" ")[1] }).toEqual({ kase, code: 1, reason });
    }
  }, TIMEOUT);
});

describe("miniroly は薄く独立している(AC-4・AC-X2)", () => {
  test("main.ts は 300 行以下・node: / bun: 以外を import しない・依存 0・README は内部を指さない", () => {
    const source = readFileSync(MAIN, "utf8");
    expect(source.split("\n").length).toBeLessThanOrEqual(300);
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !/^(node|bun):/.test(s))).toEqual([]);
    const pkg = join(ROOT, "examples", "miniroly", "package.json");
    if (existsSync(pkg)) {
      const { dependencies = {}, devDependencies = {} } = readJson(pkg);
      expect({ ...dependencies, ...devDependencies }).toEqual({});
    }
    const readme = readFileSync(join(ROOT, "examples", "miniroly", "README.md"), "utf8");
    expect(readme.match(/\bdocs\/|\bbacklog\/|\/Users\//g)).toBeNull();
  });
});
