import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { buildPluginBundles } from "../src/install.ts";

// PBI-0597 AC-3: plugin の MCP bundle は追跡しない生成物なので、`openroly install` が
// **要る瞬間に置く**。ここで測るのは 2 つ:
//   ① bun の在る機では両 plugin dir に実際に file ができ、finding が ok:true で「作った」と言う
//   ② build に失敗しても **ok:true のまま**(bundle は launcher の 3 段目の材料で、binary が在る端末では
//      1 度も使われない。ここを ok:false にすると bun の無い端末で install が exit 1 になる)
//
// ②は①の負の対照でもある: 「作れた」と「作れなかった」を detail で分けていない実装はここで落ちる
// (両方 ok:true なので、区別しているのは detail の文言だけ)。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bundles = ["claude", "codex"].map((r) =>
  join(repoRoot, "adapters/official", r, "mcp-server.bundle.js"),
);
const packageJson = join(repoRoot, "package.json");
const original = readFileSync(packageJson, "utf8");

afterAll(() => {
  // 壊した package.json は必ず戻す(戻し忘れると他 file の test が全部 build できなくなる)。
  // bundle も作り直しておく —— 消したままだと後続 file の「在る前提」を壊す
  writeFileSync(packageJson, original);
  buildPluginBundles();
});

describe("PBI-0597 AC-3: install が bundle を置く", () => {
  test("bundle が無ければ作り、finding は ok:true で「作った」と言う", () => {
    for (const b of bundles) rmSync(b, { force: true });
    const finding = buildPluginBundles();
    expect({ ok: finding.ok, label: finding.label }).toEqual({ ok: true, label: "Plugin bundle" });
    expect(finding.detail).toContain("built into");
    for (const b of bundles) expect(existsSync(b)).toBe(true);
  }, 120_000);

  test("build に失敗しても install は落とさない(ok:true のまま・理由は detail に出す)", () => {
    const broken = original.replace(
      '"plugin:build": "bun build packages/mcp/src/server.ts',
      '"plugin:build": "bun build packages/mcp/src/does-not-exist.ts',
    );
    expect(broken).not.toBe(original); // 置換が当たらないまま「緑」にしない
    writeFileSync(packageJson, broken);
    try {
      for (const b of bundles) rmSync(b, { force: true }); // 在ると build を呼ばずに終わる
      const finding = buildPluginBundles();
      expect(finding.ok).toBe(true); // false にすると bun の無い端末の install が exit 1 になる
      expect(finding.detail).toContain("could not be built");
      expect(finding.detail).toContain("The binary path still works");
    } finally {
      writeFileSync(packageJson, original);
    }
  }, 120_000);

  // PBI-0610: 上の②は **package.json を壊す** 形で失敗を作っている = `exitCode` が返る経路しか
  // 測っていない。「bun が無い機」の実物は exitCode を返さず **throw する**ので、AC-3 の主張
  // (bun が無くても install を落とさない)はこれを足すまで一度も測られていなかった。
  // **process.env.PATH を書き換えるだけでは測れない**(最初にそう書いて緑になり、武装していない事に
  // 気付いた): bun は spawn する "bun" を起動時の環境から解決するので、実行中の書き換えは効かず
  // build が成功してしまう。実物と同じにするには **PATH を欠いた子 process を起こす**しかない。
  test("bun が PATH に無くても install を落とさない(spawnSync は throw する・PBI-0610)", () => {
    for (const b of bundles) rmSync(b, { force: true });
    const installTs = join(repoRoot, "packages/adapter/src/install.ts");
    const probe = `import { buildPluginBundles } from ${JSON.stringify(installTs)};
console.log(JSON.stringify(buildPluginBundles()));`;
    const child = Bun.spawnSync([process.execPath, "-e", probe], {
      // machine-ok: bun の居ない PATH を作るのが目的。HOME は子が module を解決する為で、製品の状態は読まない
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, // bun の居ない PATH
      stdout: "pipe",
      stderr: "pipe",
    });
    // src の try/catch を外すと子が例外で落ち、exitCode!==0 / stdout が空になって赤くなる(負の対照)
    expect(child.exitCode).toBe(0);
    const finding = JSON.parse(child.stdout.toString().trim()) as { ok: boolean; detail: string };
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("could not be built");
    expect(finding.detail).toContain("The binary path still works");
  }, 120_000);

  test("package.json は元のまま(この file 自身が repo を壊したまま終わらない)", () => {
    expect(readFileSync(packageJson, "utf8")).toBe(original);
  });
});
