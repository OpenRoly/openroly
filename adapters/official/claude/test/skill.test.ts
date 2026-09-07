import type { AdapterContext } from "@openroly/adapter";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { claudeAdapter } from "../src/index.ts";

// PBI-0008: kind = "skill" の Extension を Claude adapter が materialize できることの検査。
// 実 `claude` CLI は不要(純粋な fs 操作)。

async function makeCtx(): Promise<{ ctx: AdapterContext; home: string }> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(join(tmpdir(), "openroly-claude-skill-"));
  return { ctx: { env: { HOME: home } }, home };
}

/** mcp 経路(claude mcp remove)も同時に検査する test 用。fake `claude` を PATH に置く
 * (extension.test.ts の makeCtx と同じ手)。 */
async function makeCtxWithFakeClaude(): Promise<{ ctx: AdapterContext; home: string }> {
  const { ctx, home } = await makeCtx();
  const binDir = join(home, "bin");
  await mkdir(binDir);
  const bin = join(binDir, "claude");
  await writeFile(bin, `#!/bin/sh\nexit 0\n`);
  await chmod(bin, 0o755);
  return { ctx: { env: { ...ctx.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } }, home };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function untouched<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = await stat(path).catch(() => null);
  const result = await fn();
  const after = await stat(path).catch(() => null);
  expect(after?.mtimeMs).toBe(before?.mtimeMs);
  return result;
}

describe("claudeAdapter.applyExtension — kind=skill(PBI-0008)", () => {
  test("AC-1,2: install が SKILL.md と補助 file を書く", async () => {
    await untouched(join(homedir(), ".claude", "skills"), async () => {
      const { ctx, home } = await makeCtx();
      await claudeAdapter.applyExtension(ctx, {
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
      const skillMd = await readFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "utf8");
      expect(skillMd).toBe(`---\nname: "foo"\ndescription: "D"\n---\n# Foo\n本文`);
      const ref = await readFile(
        join(home, ".claude", "skills", "foo", "references", "api.md"),
        "utf8",
      );
      expect(ref).toBe("REF");
    });
  });

  test("AC-3: update が前 revision の残留物を消して作り直す", async () => {
    const { ctx, home } = await makeCtx();
    await claudeAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "D", instructions: "v1" },
      env: {},
    });
    const staleDir = join(home, ".claude", "skills", "foo");
    await writeFile(join(staleDir, "stale.txt"), "old");
    expect(await listDir(staleDir)).toEqual([".openroly-managed", "SKILL.md", "stale.txt"]);

    await claudeAdapter.applyExtension(ctx, {
      action: "update",
      kind: "skill",
      name: "foo",
      spec: { description: "D2", instructions: "v2", files: { "notes.md": "v2" } },
      env: {},
    });
    expect(await listDir(staleDir)).toEqual([".openroly-managed", "SKILL.md", "notes.md"]);
    const skillMd = await readFile(join(staleDir, "SKILL.md"), "utf8");
    expect(skillMd).toContain("v2");
  });

  test("AC-4: disable でディレクトリごと削除される", async () => {
    const { ctx, home } = await makeCtx();
    await claudeAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "D", instructions: "v1" },
      env: {},
    });
    await claudeAdapter.applyExtension(ctx, { action: "disable", name: "foo" });
    await expect(stat(join(home, ".claude", "skills", "foo"))).rejects.toThrow();
  });

  test("AC-5: skills/ 自体が無い状態での uninstall は冪等(throw しない)", async () => {
    const { ctx } = await makeCtx();
    await expect(
      claudeAdapter.applyExtension(ctx, { action: "uninstall", name: "foo" }),
    ).resolves.toBeUndefined();
  });

  test("AC-6: listExtensions が skill と mcp server を合算して返す", async () => {
    const { ctx, home } = await makeCtx();
    await mkdir(join(home, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "x");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { bar: { command: "npx" } } }),
    );
    const result = await claudeAdapter.listExtensions(ctx);
    expect(result.map((r) => r.name).sort()).toEqual(["bar", "foo"]);
  });

  test("AC-7: spec.description が未指定なら throw し、何も書かれない", async () => {
    const { ctx, home } = await makeCtx();
    await expect(
      claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "foo",
        spec: { instructions: "x" },
        env: {},
      }),
    ).rejects.toThrow(/description/);
    expect(await listDir(join(home, ".claude", "skills"))).toEqual([]);
  });

  test("AC-8: name の path traversal は拒否され、skills/ の外に何も書かれない", async () => {
    const { ctx, home } = await makeCtx();
    const parent = join(home, ".claude");
    const before = await listDir(parent);
    await expect(
      claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "../../evil",
        spec: { description: "D", instructions: "x" },
        env: {},
      }),
    ).rejects.toThrow(/invalid path/);
    expect(await listDir(parent)).toEqual(before);
  });

  test("AC-9: files のキーに 1 つでも traversal が有れば全体を書かない(部分書き込み防止)", async () => {
    const { ctx, home } = await makeCtx();
    await expect(
      claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "foo",
        spec: {
          description: "D",
          instructions: "x",
          files: { "../outside.txt": "x", "ok.md": "y" },
        },
        env: {},
      }),
    ).rejects.toThrow(/invalid path/);
    expect(await stat(join(home, ".claude", "skills", "foo")).catch(() => null)).toBeNull();
    // "../outside.txt" は skillDir(skills/foo)基準の相対パスなので、書けてしまうとすれば
    // skills/outside.txt(= skills/foo/ の外、skills/ 自体の中)に着地する
    expect(await stat(join(home, ".claude", "skills", "outside.txt")).catch(() => null)).toBeNull();
  });

  test("AC-10: CLAUDE_CONFIG_DIR 設定時は分離される(HOME 側は触らない)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(join(tmpdir(), "openroly-claude-skill-home-"));
    const configDir = await mkdtemp(join(tmpdir(), "openroly-claude-skill-config-"));
    const ctx: AdapterContext = { env: { HOME: home, CLAUDE_CONFIG_DIR: configDir } };
    await claudeAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description: "D", instructions: "x" },
      env: {},
    });
    expect(
      await stat(join(configDir, "skills", "foo", "SKILL.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(await stat(join(home, ".claude", "skills")).catch(() => null)).toBeNull();
  });

  test("AC-11: 実 HOME を汚さない(全 test を untouched で包んでいることの自己検証)", async () => {
    await untouched(join(homedir(), ".claude", "skills"), async () => {
      const { ctx } = await makeCtx();
      await claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "foo",
        spec: { description: "D", instructions: "x" },
        env: {},
      });
    });
  });

  test("AC-12: safeJoin の resolved===base 抜け穴(skills 全体削除の回帰)", async () => {
    const { ctx, home } = await makeCtx();
    const otherDir = join(home, ".claude", "skills", "other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, "OTHER.md"), "keep-me");

    for (const badName of [".", "", "./", "foo/.."]) {
      await expect(
        claudeAdapter.applyExtension(ctx, {
          action: "install",
          kind: "skill",
          name: badName,
          spec: { description: "D", instructions: "x" },
          env: {},
        }),
      ).rejects.toThrow(/invalid path/);
      expect(await readFile(join(otherDir, "OTHER.md"), "utf8")).toBe("keep-me");
    }
  });

  test("AC-13: frontmatter は JSON.stringify でエスケープされ YAML 構文を壊さない", async () => {
    const { ctx, home } = await makeCtx();
    const description = 'a: "b"\nname: evil';
    await claudeAdapter.applyExtension(ctx, {
      action: "install",
      kind: "skill",
      name: "foo",
      spec: { description, instructions: "本文" },
      env: {},
    });
    const skillMd = await readFile(join(home, ".claude", "skills", "foo", "SKILL.md"), "utf8");
    const lines = skillMd.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe(`name: ${JSON.stringify("foo")}`);
    expect(lines[2]).toBe(`description: ${JSON.stringify(description)}`);
    expect(lines[3]).toBe("---");
    // description の中身が独立した name: 行として解釈されていない(name は "foo" のまま)
    expect(JSON.parse((lines[1] ?? "").slice("name: ".length))).toBe("foo");
    expect(JSON.parse((lines[2] ?? "").slice("description: ".length))).toBe(description);
  });

  // 実 claude CLI(2.1.243)実測: ~/.claude/skills/ には SKILL.md だけの人間の私物 skill が
  // このマシンだけで 48 件実在し、名前に予約は無い。OpenRoly が管理していないディレクトリと名前が
  // 衝突した場合に絶対に触らないことを、OPENROLY_MANAGED_MARKER(`.openroly-managed`)で検査する。

  test("AC-14: disable/uninstall は OpenRoly 未管理の同名 skill ディレクトリを消さない", async () => {
    const { ctx, home } = await makeCtxWithFakeClaude();
    // 人間が別途作った私物 skill(OpenRoly が install したことは一度も無い = marker 無し)
    const humanDir = join(home, ".claude", "skills", "github");
    await mkdir(humanDir, { recursive: true });
    await writeFile(join(humanDir, "SKILL.md"), "human's own skill");
    // 同じ名前の mcp extension "github" を account 側が管理していて、それを uninstall する
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    );

    await expect(
      claudeAdapter.applyExtension(ctx, { action: "uninstall", name: "github" }),
    ).resolves.toBeUndefined();

    // 人間の私物 skill は無傷(mcp 側の削除経路は fake claude CLI に委譲されるため、
    // ここで検査するのは「skill 側を巻き込んで消していないか」のみ)
    expect(await readFile(join(humanDir, "SKILL.md"), "utf8")).toBe("human's own skill");
  });

  test("AC-15: install/update は OpenRoly 未管理の同名 skill ディレクトリを上書きしない", async () => {
    const { ctx, home } = await makeCtx();
    const humanDir = join(home, ".claude", "skills", "review");
    await mkdir(humanDir, { recursive: true });
    await writeFile(join(humanDir, "SKILL.md"), "human's own skill");

    await expect(
      claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "skill",
        name: "review",
        spec: { description: "D", instructions: "x" },
        env: {},
      }),
    ).rejects.toThrow(/did not create/);
    expect(await readFile(join(humanDir, "SKILL.md"), "utf8")).toBe("human's own skill");
    expect(await listDir(humanDir)).toEqual(["SKILL.md"]);
  });

  // ---- PBI-0036(review fixes)。上の AC-1〜15 が守れていなかった 2 つの経路 ----

  test("PBI-0036 AC-1: spec.files の予約ファイル名は resolved path で拒否される(SKILL.md 乗っ取り防止)", async () => {
    const { ctx, home } = await makeCtx();
    // 生キー文字列の比較では "./SKILL.md" / "references/../SKILL.md" が素通りするため、
    // safeJoin 後の resolved path で判定していることをこの 4 変種で検査する
    for (const key of ["SKILL.md", "./SKILL.md", "references/../SKILL.md", ".openroly-managed"]) {
      await expect(
        claudeAdapter.applyExtension(ctx, {
          action: "install",
          kind: "skill",
          name: "foo",
          spec: {
            description: "D",
            instructions: "# Foo\n本文",
            files: { [key]: "HIJACKED, no frontmatter" },
          },
          env: {},
        }),
      ).rejects.toThrow(/SKILL\.md|openroly-managed/);
      // 検証は書き込み前に閉じている(1 byte も書かない)
      expect(await stat(join(home, ".claude", "skills", "foo")).catch(() => null)).toBeNull();
    }
  });

  test("PBI-0036 AC-2: skill の name にパス区切りは使えない(marker 無しの中間ディレクトリによる自傷ロックアウト防止)", async () => {
    const { ctx, home } = await makeCtx();
    const skills = join(home, ".claude", "skills");
    for (const name of ["foo/bar", "a/b/c", "foo/"]) {
      const before = await listDir(skills);
      await expect(
        claudeAdapter.applyExtension(ctx, {
          action: "install",
          kind: "skill",
          name,
          spec: { description: "D", instructions: "本文" },
          env: {},
        }),
      ).rejects.toThrow(/path separator/);
      // 中間ディレクトリ(skills/foo)も作られない — 作られると marker を持たないため
      // 後から正当な skill "foo" が AC-15 の分岐で永久に install 不能になる
      expect(await listDir(skills)).toEqual(before);
    }
  });

  test("PBI-0036 AC-2b: mcp kind の scoped name(@scope/pkg)は従来どおり install できる(制限は skill 側だけ)", async () => {
    const { ctx } = await makeCtxWithFakeClaude();
    await expect(
      claudeAdapter.applyExtension(ctx, {
        action: "install",
        kind: "mcp",
        name: "@scope/pkg",
        spec: { command: "npx", args: ["-y", "pkg"] },
        env: {},
      }),
    ).resolves.toBeUndefined();
  });
});
