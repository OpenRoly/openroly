import type { AdapterContext } from "@openroly/adapter";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { codexAdapter } from "../src/index.ts";

// W20(PBI-0091): codex adapter が skill kind を materialize できることの検査。
// 実 `codex` CLI は不要(skill は純粋な fs 操作)。防御群(traversal / 予約ファイル /
// marker)の本体は packages/adapter/src/skill.ts で claude 側 20 検査が担保しているため、
// ここは codex 固有の配線(skillsDir 解決・合算・両経路)に絞る + 回帰 1 本。

async function makeCtx(opts?: {
  configServers?: string; // config.toml の内容(無ければ空 file)
  fakeCli?: boolean; // fake `codex` を PATH に置く(mcp 経路の検査用)
}): Promise<{ ctx: AdapterContext; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "openroly-codex-skill-"));
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "config.toml"), opts?.configServers ?? "");
  let ctx: AdapterContext = { env: { HOME: home } };
  if (opts?.fakeCli) {
    const binDir = join(home, "bin");
    await mkdir(binDir);
    const bin = join(binDir, "codex");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    ctx = { env: { HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` } };
  }
  return { ctx, home };
}

describe("codexAdapter — kind=skill(W20 / PBI-0091)", () => {
  test("AC-1: install が ~/.codex/skills に SKILL.md・marker・files を書く", async () => {
    const { ctx, home } = await makeCtx();
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: {
        description: "D",
        instructions: "# Foo\n本文",
        files: { "references/api.md": "REF" },
      },
      env: {},
    });
    const dir = join(home, ".codex", "skills", "foo");
    expect((await readdir(dir)).sort()).toEqual([".openroly-managed", "SKILL.md", "references"]);
    const skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
    expect(skillMd).toBe(`---\nname: "foo"\ndescription: "D"\n---\n# Foo\n本文`);
    expect(await readFile(join(dir, "references", "api.md"), "utf8")).toBe("REF");
  });

  test("AC-2: listExtensions が mcp_servers と skills/ を合算して返す", async () => {
    const { ctx, home } = await makeCtx({
      configServers: '[mcp_servers.bar]\ncommand = "npx"\n',
    });
    await mkdir(join(home, ".codex", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".codex", "skills", "foo", "SKILL.md"), "x");
    const result = await codexAdapter.listExtensions(ctx);
    expect(result.map((r) => r.name).sort()).toEqual(["bar", "foo"]);
  });

  test("AC-3: disable は skill と mcp の両経路を見る(marker 無しの私物 skill は消さない)", async () => {
    const { ctx, home } = await makeCtx({ fakeCli: true });
    // OpenRoly 管理の skill(marker 有り)と人間の私物 skill(marker 無し)を同居させる
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "managed",
      spec: { description: "D", instructions: "x" },
      env: {},
    });
    const humanDir = join(home, ".codex", "skills", "human-own");
    await mkdir(humanDir, { recursive: true });
    await writeFile(join(humanDir, "SKILL.md"), "human's own");

    await expect(
      codexAdapter.applyExtension(ctx, { action: "disable", name: "managed" }),
    ).resolves.toBeUndefined();
    await expect(stat(join(home, ".codex", "skills", "managed"))).rejects.toThrow();
    expect(await readFile(join(humanDir, "SKILL.md"), "utf8")).toBe("human's own");
  });

  test("AC-4(回帰): name の path traversal は拒否され ~/.codex の外に何も書かない", async () => {
    const { ctx, home } = await makeCtx();
    const before = (await readdir(join(home, ".codex"))).sort();
    await expect(
      codexAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "../../evil",
        spec: { description: "D", instructions: "x" },
        env: {},
      }),
    ).rejects.toThrow(/invalid path/);
    expect((await readdir(join(home, ".codex"))).sort()).toEqual(before);
  });

  test("AC-6: extensionKinds が mcp と skill を持つ(PBI-0214 で instructions も)", () => {
    expect(codexAdapter.extensionKinds).toEqual(["mcp", "skill", "instructions"]);
  });

  test("AC-X2: CODEX_HOME 設定時はその配下の skills に分離される(HOME 側は触らない)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-codex-skill-home-"));
    const codexHome = await mkdtemp(join(tmpdir(), "openroly-codex-skill-codex-"));
    await writeFile(join(codexHome, "config.toml"), "");
    const ctx: AdapterContext = { env: { HOME: home, CODEX_HOME: codexHome } };
    await codexAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "D", instructions: "x" },
      env: {},
    });
    expect(
      await stat(join(codexHome, "skills", "foo", "SKILL.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(await stat(join(home, ".codex")).catch(() => null)).toBeNull();
  });
});
