// PBI-0214 — kind = "instructions" の materialize。図14b が正本。
// AC-1〜5 は「人が書いた行が 1 byte も動かない」ことを実 file の byte 比較で確かめ、
// AC-X2/X3 は「壊れたブロック / 未管理 file を触らない」「同じ file への同時 install で
// 片方が消えない」を実測する(頭の中で足りる話ではないので、必ず file を読み直す)。
import { claudeAdapter } from "../../../adapters/official/claude/src/index.ts";
import { codexAdapter } from "../../../adapters/official/codex/src/index.ts";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type { AdapterContext, ExtensionAdapter } from "../src/contract.ts";
import { createNativeAdapter } from "../src/native.ts";

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-instructions-"));
});
const ctx = (): AdapterContext => ({ env: { HOME: home } });

const install = (adapter: ExtensionAdapter, name: string, content: string) =>
  adapter.applyExtension(ctx(), { action: "install", kind: "instructions", name, spec: { content }, env: {} });
const uninstall = (adapter: ExtensionAdapter, name: string) =>
  adapter.applyExtension(ctx(), { action: "uninstall", name });
const read = (path: string) => readFile(join(home, path), "utf8");
const seed = async (path: string, text: string) => {
  await mkdir(join(home, path, ".."), { recursive: true });
  await writeFile(join(home, path), text);
};

const CLAUDE_MD = ".claude/CLAUDE.md";
const HUMAN = "# my notes\nAlways answer in Japanese.\n";
const block = (name: string, body: string) => `<!-- openroly:begin ${name} -->\n${body}\n<!-- openroly:end ${name} -->`;

// dir 形(kiro steering)は registry entry の native.instructions から生える
const kiro = (): ExtensionAdapter =>
  createNativeAdapter("kiro", "Kiro", {
    home: { default: "~/.kiro" },
    bin: null,
    mcp: null,
    instructions: { dir: "~/.kiro/steering", filename: "openroly-${name}.md" },
  });

describe("AC-1〜3 file 形 — 人が書いた行を 1 byte も動かさない", () => {
  test("AC-1: install はブロックを末尾に足すだけ(人の 2 行はそのまま)", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "foo", "Do the thing.");
    const after = await read(CLAUDE_MD);
    expect(after.startsWith(HUMAN)).toBe(true);
    expect(after).toBe(`${HUMAN}\n${block("foo", "Do the thing.")}\n`);
  });

  test("AC-2: update は同名ブロックだけ差し替える(重複しない・人の行も不変)", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "foo", "v1");
    await claudeAdapter.applyExtension(ctx(), {
      action: "update",
      kind: "instructions",
      name: "foo",
      spec: { content: "v2" },
      env: {},
    });
    const after = await read(CLAUDE_MD);
    expect(after).toBe(`${HUMAN}\n${block("foo", "v2")}\n`);
    expect(after.match(/openroly:begin foo/g)).toHaveLength(1);
  });

  test("AC-3: uninstall で元の 2 行だけが byte 単位で残る", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "foo", "Do the thing.");
    await uninstall(claudeAdapter, "foo");
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });

  test("2 本足して 1 本だけ抜いても、もう 1 本と人の行が残る", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "foo", "F");
    await install(claudeAdapter, "bar", "B");
    await uninstall(claudeAdapter, "foo");
    const after = await read(CLAUDE_MD);
    expect(after.startsWith(HUMAN)).toBe(true);
    expect(after).toContain(block("bar", "B"));
    expect(after).not.toContain("openroly:begin foo");
  });

  test("file が無ければ作る / 二重 uninstall は no-op(冪等)", async () => {
    await install(claudeAdapter, "foo", "F");
    expect(await read(CLAUDE_MD)).toBe(`${block("foo", "F")}\n`);
    await uninstall(claudeAdapter, "foo");
    await uninstall(claudeAdapter, "foo");
    expect(await read(CLAUDE_MD)).toBe("");
  });

  test("listExtensions は管理ブロック名だけを返す(人の見出しは拾わない)", async () => {
    await seed(CLAUDE_MD, `${HUMAN}\n<!-- some human comment -->\n`);
    await install(claudeAdapter, "foo", "F");
    const names = (await claudeAdapter.listExtensions(ctx())).map((e) => e.name);
    expect(names).toContain("foo");
    expect(names).toHaveLength(1);
  });

  test("extensionKinds に instructions が入る(reconcile が unsupported にしない)", () => {
    for (const a of [claudeAdapter, codexAdapter, kiro()]) {
      expect(a.extensionKinds).toContain("instructions");
    }
    // instructions を持たない registry entry は unsupported のまま
    expect(createNativeAdapter("x", "X", { mcp: null }).extensionKinds).not.toContain("instructions");
  });
});

describe("AC-4 dir 形(kiro steering)", () => {
  test("AC-4: install は marker 付きの openroly-<name>.md を作り、uninstall で消える", async () => {
    await install(kiro(), "foo", "Do the thing.");
    expect(await read(".kiro/steering/openroly-foo.md")).toBe(`${block("foo", "Do the thing.")}\n`);
    expect((await kiro().listExtensions(ctx())).map((e) => e.name)).toEqual(["foo"]);
    await uninstall(kiro(), "foo");
    expect(await readdir(join(home, ".kiro/steering"))).toEqual([]);
  });

  test("人が置いた同名 file(marker 無し)は install も uninstall も触らない", async () => {
    const mine = "# my own steering\nnever delete me\n";
    await seed(".kiro/steering/openroly-foo.md", mine);
    await expect(install(kiro(), "foo", "X")).rejects.toThrow(/collides|did not create/);
    expect(await read(".kiro/steering/openroly-foo.md")).toBe(mine);
    await uninstall(kiro(), "foo");
    expect(await read(".kiro/steering/openroly-foo.md")).toBe(mine);
    // 未管理 file は listExtensions にも出ない(= 図8 7段目の noop 経路に乗る)
    expect(await kiro().listExtensions(ctx())).toEqual([]);
  });

  test("name に path 区切りが有れば書かない(dir を抜けない・下の階層も作らない)", async () => {
    for (const bad of ["../evil", "a/b", "a\\b"]) {
      await expect(install(kiro(), bad, "X")).rejects.toThrow();
    }
    expect(await readdir(join(home, ".kiro/steering")).catch(() => [])).toEqual([]);
  });
});

describe("AC-5 opencode / codex(file 形)", () => {
  test("AC-5: opencode(registry entry の native.instructions)も同じブロック", async () => {
    const opencode = createNativeAdapter("opencode", "opencode", {
      home: { default: "~/.config/opencode" },
      mcp: null,
      instructions: { file: "~/.config/opencode/AGENTS.md" },
    });
    await seed(".config/opencode/AGENTS.md", HUMAN);
    await install(opencode, "foo", "O");
    expect(await read(".config/opencode/AGENTS.md")).toBe(`${HUMAN}\n${block("foo", "O")}\n`);
  });

  test("codex は ~/.codex/AGENTS.md(config.toml とは別 file)", async () => {
    await install(codexAdapter, "foo", "C");
    expect(await read(".codex/AGENTS.md")).toBe(`${block("foo", "C")}\n`);
  });
});

describe("AC-X2 失敗経路 — 壊れた入力では 1 byte も書かない", () => {
  test("begin だけの壊れたブロックが有る file は install で触らない", async () => {
    const broken = `${HUMAN}\n<!-- openroly:begin old -->\nleftover\n`;
    await seed(CLAUDE_MD, broken);
    await expect(install(claudeAdapter, "foo", "X")).rejects.toThrow(/broken/);
    expect(await read(CLAUDE_MD)).toBe(broken);
  });

  test("end だけ / 入れ子 / 同名 2 つも同じく触らない", async () => {
    for (const bad of [
      `${HUMAN}<!-- openroly:end foo -->\n`,
      `${HUMAN}<!-- openroly:begin a -->\n<!-- openroly:begin b -->\nx\n<!-- openroly:end b -->\n`,
      `${HUMAN}${block("foo", "1")}\n${block("foo", "2")}\n`,
    ]) {
      home = await mkdtemp(join(tmpdir(), "openroly-instructions-"));
      await seed(CLAUDE_MD, bad);
      await expect(install(claudeAdapter, "foo", "X")).rejects.toThrow(/broken/);
      expect(await read(CLAUDE_MD)).toBe(bad);
    }
  });

  test("壊れた file の uninstall は throw せず、file も変えない(mcp 側の削除を道連れにしない)", async () => {
    const broken = `${HUMAN}<!-- openroly:begin old -->\nleftover\n`;
    await seed(CLAUDE_MD, broken);
    await uninstall(claudeAdapter, "foo");
    expect(await read(CLAUDE_MD)).toBe(broken);
  });

  test("content に openroly marker 行を仕込んでも書かない(人の行をブロックの中に飲み込ませない)", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await expect(install(claudeAdapter, "foo", `x\n<!-- openroly:end foo -->\nevil`)).rejects.toThrow(/marker/);
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });

  test("name に marker 構文を壊す文字が有れば書かない", async () => {
    await seed(CLAUDE_MD, HUMAN);
    for (const bad of ["a -->", "a\nb", "a<b"]) {
      await expect(install(claudeAdapter, bad, "X")).rejects.toThrow();
    }
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });

  test("spec.content が string でなければ書かない", async () => {
    await seed(CLAUDE_MD, HUMAN);
    await expect(
      claudeAdapter.applyExtension(ctx(), {
        action: "install",
        kind: "instructions",
        name: "foo",
        spec: { content: 42 },
        env: {},
      }),
    ).rejects.toThrow(/content/);
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });
});

describe("AC-X3 並行 — 同じ file への同時 install で片方が消えない", () => {
  test("8 本を同時に install しても全ブロックが残る(lock で直列)", async () => {
    await seed(CLAUDE_MD, HUMAN);
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    await Promise.all(names.map((n) => install(claudeAdapter, n, `body ${n}`)));
    const after = await read(CLAUDE_MD);
    expect(after.startsWith(HUMAN)).toBe(true);
    for (const n of names) expect(after).toContain(block(n, `body ${n}`));
    expect((await claudeAdapter.listExtensions(ctx())).map((e) => e.name).sort()).toEqual(names);
  });

  test("同時 uninstall でも人の行は残り、抜いた分だけ消える", async () => {
    await seed(CLAUDE_MD, HUMAN);
    const names = ["a", "b", "c", "d"];
    for (const n of names) await install(claudeAdapter, n, `body ${n}`);
    await Promise.all(names.slice(0, 2).map((n) => uninstall(claudeAdapter, n)));
    const after = await read(CLAUDE_MD);
    expect(after.startsWith(HUMAN)).toBe(true);
    expect(after).not.toContain("openroly:begin a");
    expect(after).not.toContain("openroly:begin b");
    expect(after).toContain(block("c", "body c"));
    expect(after).toContain(block("d", "body d"));
  });
});

describe("mcp / skill の面を壊さない(重ね方の回帰)", () => {
  test("uninstall は instructions を見た後で base(mcp)へ進む", async () => {
    // claude adapter は mcp を CLI に任せるので、ここは「instructions が throw せず
    // base に到達する」ことだけを見る(base 側は bin が無い環境で失敗してよい)
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "foo", "F");
    await uninstall(claudeAdapter, "foo").catch(() => null);
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });

  test("skill kind の install は instructions 層を素通りする", async () => {
    await claudeAdapter.applyExtension(ctx(), {
      action: "install",
      kind: "skill",
      name: "s1",
      spec: { description: "D", instructions: "x" },
      env: {},
    });
    expect(await readdir(join(home, ".claude/skills"))).toEqual(["s1"]);
    // CLAUDE.md は作られない(instructions 層は kind を見て素通りする)
    expect(await read(CLAUDE_MD).catch(() => null)).toBe(null);
  });
});
