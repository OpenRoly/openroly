// PBI-0091 レビュー(有界)の攻撃 test。withSkills の path safety / marker 規約を codex 経由で
// 破りに行く。防御群の本体は packages/adapter/src/skill.ts(claude 側 20 検査が担保)なので、
// ここは「codex adapter からも同じ防御が効く」事の回帰として固定する。
import type { AdapterContext } from "@openroly/adapter";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { codexAdapter } from "../src/index.ts";

async function makeCtx(): Promise<{ ctx: AdapterContext; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "openroly-codex-attack-"));
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "config.toml"), "");
  return { ctx: { env: { HOME: home } }, home };
}

const install = (name: string, files?: Record<string, string>) =>
  codexAdapter.applyExtension({ env: {} } as AdapterContext, {
    action: "install",
    kind: "skill",
    name,
    spec: { description: "D", instructions: "x", ...(files ? { files } : {}) },
    env: {},
  });

describe("PBI-0091 攻撃 — skill materialize の path safety(codex 経由)", () => {
  test("攻撃1: name に Windows 区切り(バックスラッシュ)を混ぜても拒否・何も書かない", async () => {
    const { ctx, home } = await makeCtx();
    await expect(install("foo\\bar")).rejects.toThrow();
    // skills/ 以下に何も作られていない
    const skillsDir = join(home, ".codex", "skills");
    expect(await readdir(skillsDir).catch(() => [])).toEqual([]);
  });

  test("攻撃2: files キーの ./SKILL.md 変種は予約ファイル判定に落ちる(SKILL.md は書き換わらない)", async () => {
    const { ctx, home } = await makeCtx();
    // 先に正規 install しておく
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "Orig", instructions: "# Orig" },
      env: {},
    });
    const skillMd = join(home, ".codex", "skills", "foo", "SKILL.md");
    const before = await readFile(skillMd, "utf8");
    await expect(
      codexAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "foo",
        spec: {
          description: "Evil",
          instructions: "x",
          files: { "./SKILL.md": "frontmatter 消し" },
        },
        env: {},
      }),
    ).rejects.toThrow(/reserved file/);
    expect(await readFile(skillMd, "utf8")).toBe(before);
  });

  test("攻撃3: files キーの references/../SKILL.md も safeJoin 後の判定に落ちる", async () => {
    const { home } = await makeCtx();
    await expect(install("foo", { "references/../SKILL.md": "x" })).rejects.toThrow(/reserved file/);
    expect(await readdir(join(home, ".codex", "skills")).catch(() => [])).toEqual([]);
  });

  test("攻撃4: 再 install で旧 files が残留しない(消してから作り直す)", async () => {
    const { ctx, home } = await makeCtx();
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "v1", instructions: "x", files: { "old/keep.txt": "OLD" } },
      env: {},
    });
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "v2", instructions: "y" },
      env: {},
    });
    const dir = join(home, ".codex", "skills", "foo");
    expect((await readdir(dir)).sort()).toEqual([".openroly-managed", "SKILL.md"]);
    expect(await stat(join(dir, "old", "keep.txt")).catch(() => null)).toBeNull();
  });

  test("攻撃5: disable に不正 name(traversal)を渡しても throw せず何も消さない(mcp 経路だけが走る)", async () => {
    const { ctx, home } = await makeCtx();
    // marker 付き skill を 1 つ作る
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "keep",
      spec: { description: "D", instructions: "x" },
      env: {},
    });
    await expect(
      codexAdapter.applyExtension(ctx, { action: "disable", name: "../../evil" }),
    ).resolves.toBeUndefined();
    // marker 付き skill は無傷・~/.codex の外に影響が無い(こけたら例外ではなく消滅が帰る)
    expect(
      await stat(join(home, ".codex", "skills", "keep")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  });

  test("攻撃6: skills 直下の file(非 directory)は listExtensions に skill として現れない", async () => {
    const { ctx, home } = await makeCtx();
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await writeFile(join(home, ".codex", "skills", "README.md"), "not a skill");
    const names = (await codexAdapter.listExtensions(ctx)).map((e) => e.name);
    expect(names).not.toContain("README.md");
  });
});
