import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PBI-0555: PAAP v0.1 の 2 つ目の L1 Reader（examples/miniroly-py・Python stdlib だけ）。
// 期待は spec 側（fixtures の expect.summary.json と README §7）から読む。実装も core も写さない。

const ROOT = join(import.meta.dir, "../../..");
const DIR = join(ROOT, "examples/miniroly-py");
const PY = join(DIR, "miniroly.py");
const SPEC = join(ROOT, "specs/paap");
const VALID = join(SPEC, "v0.1/fixtures/valid");

// AC-X3: python3 が無い環境で skip して緑にしない。
// machine-ok: この機の python3 を探すのが目的（実機の PATH が測る対象）
function python3(PATH = process.env.PATH): string {
  const found = Bun.which("python3", { PATH });
  if (!found) throw new Error("python3 not found: examples/miniroly-py needs Python 3 on PATH");
  return found;
}

function read(dir: string, ...args: string[]) {
  const r = spawnSync(python3(), [PY, "read", dir, ...args], { encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr }; // signal で死ねば code = null で赤
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const cases = existsSync(VALID) ? readdirSync(VALID).filter((n) => !n.startsWith(".")).sort() : [];

function withBasic(edit: (capsule: string, summary: any) => void) {
  const capsule = mkdtempSync(join(tmpdir(), "miniroly-py-"));
  try {
    cpSync(join(VALID, "basic", "capsule"), capsule, { recursive: true });
    edit(capsule, json(join(VALID, "basic", "expect.summary.json")));
  } finally {
    rmSync(capsule, { recursive: true, force: true });
  }
}

// file を書き換え、manifest の sha256 も合わせる（壊すのは狙った 1 点だけにする）
function rewrite(capsule: string, path: string, edit: (doc: any) => void) {
  const doc = json(join(capsule, path));
  edit(doc);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(join(capsule, path), text);
  const manifest = json(join(capsule, "manifest.json"));
  for (const c of manifest.contents) if (c.path === path) c.sha256 = sha256(text);
  writeFileSync(join(capsule, "manifest.json"), JSON.stringify(manifest, null, 2));
}

describe("miniroly-py L1 は fixtures の要約と一致", () => {
  test("valid fixtures が在る（空の readdir で緑にしない）", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases).toContain("basic");
  });

  for (const name of cases) {
    test(`AC-1 ${name}: read --json が expect.summary.json と一致`, () => {
      const r = read(join(VALID, name, "capsule"), "--json");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual(json(join(VALID, name, "expect.summary.json")));
    });
  }

  test("AC-2 basic: brief の見出し順が spec §7 の節順と一致", () => {
    const readme = readFileSync(join(SPEC, "README.md"), "utf8");
    const section = readme.split(/^## \d+\. Brief$/m)[1]?.split(/^## /m)[0] ?? "";
    const order = [...section.matchAll(/^\d+\. `(\w+)`$/gm)].map((m) => m[1]!);
    expect(order.length).toBeGreaterThan(0);

    const capsule = join(VALID, "basic", "capsule");
    const summary = json(join(VALID, "basic", "expect.summary.json"));
    const { body } = json(
      join(capsule, "works", summary.current_work.id, "checkpoints", `${summary.latest_checkpoint.version}.json`),
    );
    const r = read(capsule);
    expect(r.code).toBe(0);
    const headings = [...r.out.matchAll(/^## (\w+)$/gm)].map((m) => m[1]!).filter((h) => order.includes(h));
    expect(headings.length).toBeGreaterThan(1);
    expect(headings).toEqual(order.filter((field) => field in body));
  });

  test("AC-3 / AC-X2: sha256 が byte と合わない file は exit 1 と理由", () => {
    withBasic((capsule) => {
      writeFileSync(join(capsule, "identity.json"), `${readFileSync(join(capsule, "identity.json"), "utf8")} `);
      const r = read(capsule, "--json");
      expect(r.code).toBe(1);
      expect(r.err).toContain("manifest_hash_mismatch identity.json");
      expect(r.out).toBe("");
    });
  });

  test("AC-X2: top-level の未知 key は exit 1 と理由", () => {
    withBasic((capsule, summary) => {
      const path = `works/${summary.current_work.id}/work.json`;
      rewrite(capsule, path, (work) => {
        work.surprise = true;
      });
      const r = read(capsule, "--json");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`unknown_key ${path}`);
    });
  });

  test("AC-X2: ext の未知 key は無視して同じ要約", () => {
    // 未知でも形は §10 の <vendor>.<key>（形の違反は invalid_field = 別の話。形の正本は spec から読む）
    const key = "acme.unknown";
    const pattern = readFileSync(join(SPEC, "README.md"), "utf8").match(/pattern `(\^[^`]+\$)`/)?.[1];
    expect(pattern).toBeDefined();
    expect(key).toMatch(new RegExp(pattern!));
    withBasic((capsule, summary) => {
      const path = `works/${summary.current_work.id}/work.json`;
      rewrite(capsule, path, (work) => {
        work.ext = { ...work.ext, [key]: { nested: [1, 2] } };
      });
      const r = read(capsule, "--json");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual(summary);
    });
  });
});

describe("miniroly-py は stdlib だけ・200 行以下", () => {
  const source = readFileSync(PY, "utf8");

  test("AC-4: wc -l ≤ 200・README に使い方と Python の最低版", () => {
    expect((source.match(/\n/g) ?? []).length).toBeLessThanOrEqual(200);
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(readme).toContain("python3 miniroly.py read");
    expect(readme).toMatch(/Python 3\.\d+ or newer/);
  });

  test("AC-X1: import は python3 の sys.stdlib_module_names に在る物だけ・requirements 無し", () => {
    const imported = [...source.matchAll(/^\s*(?:import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|from\s+([\w.]+)\s+import\b)/gm)]
      .flatMap((m) => (m[1] ?? m[2]!).split(","))
      .map((name) => name.trim().split(".")[0]);
    expect(imported.length).toBeGreaterThan(0);
    const r = spawnSync(python3(), ["-c", "import sys, json; print(json.dumps(sorted(sys.stdlib_module_names)))"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const stdlib = new Set(JSON.parse(r.stdout));
    expect(imported.filter((name) => !stdlib.has(name))).toEqual([]);
    for (const file of ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile"]) {
      expect(existsSync(join(DIR, file))).toBe(false);
    }
  });

  test("AC-X3: python3 が PATH に無ければ skip せず fail する", () => {
    expect(() => python3(join(tmpdir(), "no-python-here"))).toThrow("python3 not found");
  });
});
