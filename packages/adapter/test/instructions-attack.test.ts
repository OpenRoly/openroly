// PBI-0214 有界レビュー(c4) — AC-X1〜X3 を破りに行く。
// 攻撃の的は 1 つだけ: **人が書いた file を、こちらの都合で 1 byte でも変えていないか**
// (図8 7段目)。AC の本文は「ブロック外を触らない」だが、既存の検査は
// 「末尾がちょうど 1 個の \n で終わる file」しか渡していないので、
//   - marker として読み直せない name を書いてしまう(= 抜けなくなる / 毎 sync で増える)
//   - 末尾の空行を勝手に畳む
//   - symlink を実体で潰す / mode を 0644 に戻す
//   - dir 形で listExtensions と uninstall が別の規約を使う(3 つ目の口)
// が全部素通りする。ここはその 4 面を実 file の byte / lstat / mode で測る。
import { claudeAdapter } from "../../../adapters/official/claude/src/index.ts";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type { AdapterContext, RuntimeAdapter } from "../src/contract.ts";
import { createNativeAdapter } from "../src/native.ts";

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-instr-attack-"));
});
const ctx = (): AdapterContext => ({ env: { HOME: home } });

const install = (adapter: RuntimeAdapter, name: string, content: string) =>
  adapter.applyExtension(ctx(), { action: "install", kind: "instructions", name, spec: { content }, env: {} });
const uninstall = (adapter: RuntimeAdapter, name: string) =>
  adapter.applyExtension(ctx(), { action: "uninstall", name });
const read = (path: string) => readFile(join(home, path), "utf8");
const seed = async (path: string, text: string) => {
  await mkdir(join(home, path, ".."), { recursive: true });
  await writeFile(join(home, path), text);
};

const CLAUDE_MD = ".claude/CLAUDE.md";
const block = (name: string, body: string) => `<!-- openroly:begin ${name} -->\n${body}\n<!-- openroly:end ${name} -->`;
const kiro = (): RuntimeAdapter =>
  createNativeAdapter("kiro", "Kiro", {
    home: { default: "~/.kiro" },
    bin: null,
    mcp: null,
    instructions: { dir: "~/.kiro/steering", filename: "openroly-${name}.md" },
  });

describe("攻撃1: marker として読み直せない name(書けるのに抜けない)", () => {
  // U+2028/U+2029 は JS 正規表現でも改行(LineTerminator)なので `.` に入らず `^`/`$` の境界になる。
  // server の検査は `name.length === 0` だけ、adapter の検査は /[\n\r<>]/ だけなので、
  // U+2028 入りの name は両方を通り抜けて **marker として読み直せないブロック**を人の file に書く。
  // そうなると listExtensions は永久に見つけられず、reconcile は毎回 install を出し、
  // append 枝が毎回走って人の CLAUDE.md がブロックで膨らみ続ける(しかも uninstall で消せない)。
  for (const bad of ["foo\u2028bar", "foo\u2029bar", ""]) {
    test(`name=${JSON.stringify(bad)} は書き込み前に弾く(人の file は不変)`, async () => {
      const HUMAN = "# my notes\nAlways answer in Japanese.\n";
      await seed(CLAUDE_MD, HUMAN);
      await expect(install(claudeAdapter, bad, "X")).rejects.toThrow();
      expect(await read(CLAUDE_MD)).toBe(HUMAN);
    });
  }

  test("書けた name は必ず listExtensions に出て uninstall で消える(往復できない name を書かない)", async () => {
    // 「弾く」の裏側 —— 通した name は 100% 管理下に入ること。1 本でも書けてしまうと上の膨張が起きる
    for (const name of ["foo", "a b", "日本語", "a-->b", "a\tb", "  "]) {
      home = await mkdtemp(join(tmpdir(), "openroly-instr-attack-"));
      const written = await install(claudeAdapter, name, "X").then(
        () => true,
        () => false,
      );
      if (!written) continue;
      expect((await claudeAdapter.listExtensions(ctx())).map((e) => e.name)).toContain(name);
      await uninstall(claudeAdapter, name);
      expect(await read(CLAUDE_MD)).toBe("");
    }
  });

  test("content 側の marker 注入は \\n 以外の改行でも弾く(\\r / U+2028)", async () => {
    const HUMAN = "# h\n";
    for (const evil of ["x\r\n<!-- openroly:end foo -->\r\nmine", "x\u2028<!-- openroly:end foo -->\u2028mine"]) {
      home = await mkdtemp(join(tmpdir(), "openroly-instr-attack-"));
      await seed(CLAUDE_MD, HUMAN);
      await expect(install(claudeAdapter, "foo", evil)).rejects.toThrow(/marker/);
      expect(await read(CLAUDE_MD)).toBe(HUMAN);
    }
  });
});

describe("攻撃2: 末尾の空行 —— install が人の byte を削らないこと(AC-1) / 往復で戻ること(AC-3)", () => {
  for (const human of ["A\n\n\n", "A\n   \n", "# h\nb\n", "A\r\n\r\n", "\ufeff# h\n"]) {
    test(`human=${JSON.stringify(human)}: install は先頭一致、uninstall で byte 一致に戻る`, async () => {
      await seed(CLAUDE_MD, human);
      await install(claudeAdapter, "foo", "X");
      const after = await read(CLAUDE_MD);
      // AC-1「元の行は不変」= 人の byte 列が丸ごと先頭に残っていること(末尾の空行も人の物)
      expect(after.startsWith(human)).toBe(true);
      expect(after).toContain(block("foo", "X"));
      await uninstall(claudeAdapter, "foo");
      // AC-3「元の 2 行だけ残る」= byte 一致
      expect(await read(CLAUDE_MD)).toBe(human);
    });
  }

  test("2 本入れて 1 本ずつ抜いても、途中の状態が『その 1 本だけ入れた形』と一致する", async () => {
    const HUMAN = "# h\n";
    await seed(CLAUDE_MD, HUMAN);
    await install(claudeAdapter, "a", "A");
    const onlyA = await read(CLAUDE_MD);
    await install(claudeAdapter, "b", "B");
    await uninstall(claudeAdapter, "b");
    expect(await read(CLAUDE_MD)).toBe(onlyA);
    await uninstall(claudeAdapter, "a");
    expect(await read(CLAUDE_MD)).toBe(HUMAN);
  });
});

describe("攻撃3: 人が置いた file の『形』を壊さない(symlink / mode)", () => {
  test("symlink の CLAUDE.md は symlink のまま、実体に書く(dotfiles の配線を切らない)", async () => {
    const HUMAN = "# dotfiles\n";
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, "real-CLAUDE.md"), HUMAN);
    await symlink(join(home, "real-CLAUDE.md"), join(home, CLAUDE_MD));
    await install(claudeAdapter, "foo", "X");
    expect((await lstat(join(home, CLAUDE_MD))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(home, "real-CLAUDE.md"), "utf8")).toBe(`${HUMAN}\n${block("foo", "X")}\n`);
  });

  test("0600 の CLAUDE.md は 0600 のまま(人の private な指示を 0644 に開けない)", async () => {
    await seed(CLAUDE_MD, "# secret\n");
    await chmod(join(home, CLAUDE_MD), 0o600);
    await install(claudeAdapter, "foo", "X");
    expect((await stat(join(home, CLAUDE_MD))).mode & 0o777).toBe(0o600);
  });

  test("書けない時の uninstall は黙って成功しない(壊れたブロックの no-op に紛れさせない)", async () => {
    await seed(CLAUDE_MD, "# h\n");
    await install(claudeAdapter, "foo", "X");
    await chmod(join(home, ".claude"), 0o500); // dir に temp を作れない = 書き込み不能
    try {
      await expect(uninstall(claudeAdapter, "foo")).rejects.toThrow();
    } finally {
      await chmod(join(home, ".claude"), 0o700);
    }
    expect(await read(CLAUDE_MD)).toContain(block("foo", "X"));
  });
});

describe("攻撃4: dir 形 —— listExtensions と uninstall が同じ規約であること(3 つ目の口)", () => {
  test("自分の file 名に入っていないブロックは『管理下』と名乗らない", async () => {
    // 人が openroly-foo.md を notes.md に copy した(= backup)だけで listExtensions が "bar" を返すと、
    // reconcile は「もう入っている」と読んで **本物の openroly-bar.md を永久に作らない**(silent no-apply)。
    await seed(".kiro/steering/notes.md", `${block("bar", "B")}\n`);
    expect((await kiro().listExtensions(ctx())).map((e) => e.name)).toEqual([]);
    // 人の file は 1 byte も変わらない
    expect(await read(".kiro/steering/notes.md")).toBe(`${block("bar", "B")}\n`);
  });

  test("人が管理 file に足した行は update でも uninstall でも残る(dir 形も『ブロックだけ』)", async () => {
    // dir 形を「file 丸ごと 1 extension」にしていると、人が openroly-foo.md に 1 行足しただけで
    // 次の update に黙って消される —— file 形と同じ「ブロックの外は触らない」に揃える
    await install(kiro(), "foo", "v1");
    const mine = "# 手で足したメモ\n";
    await writeFile(join(home, ".kiro/steering/openroly-foo.md"), mine + (await read(".kiro/steering/openroly-foo.md")));
    await install(kiro(), "foo", "v2");
    const after = await read(".kiro/steering/openroly-foo.md");
    expect(after.startsWith(mine)).toBe(true);
    expect(after).toContain(block("foo", "v2"));
    expect(after).not.toContain("v1");
    await uninstall(kiro(), "foo");
    // ブロックだけ抜けて、人の行を持つ file は残る
    expect(await read(".kiro/steering/openroly-foo.md")).toBe(mine);
  });

  test("無関係な kind の uninstall で人の home に dir を作らない", async () => {
    // uninstall / disable は kind を持たないので instructions 層を必ず通る。
    // 何も入っていない runtime でも通るため、ここで dir を掘ると「触っていない」が嘘になる
    await uninstall(kiro(), "some-mcp-server");
    expect(await readdir(join(home, ".kiro/steering")).catch(() => null)).toBe(null);
  });

  test("list に出た名前は必ず uninstall で消える(list と remove が同じ path を指す)", async () => {
    await install(kiro(), "foo", "X");
    await seed(".kiro/steering/notes.md", `${block("bar", "B")}\n`);
    const listed = (await kiro().listExtensions(ctx())).map((e) => e.name);
    for (const name of listed) await uninstall(kiro(), name);
    expect((await kiro().listExtensions(ctx())).map((e) => e.name)).toEqual([]);
    // 管理外の notes.md は残る
    expect(await readdir(join(home, ".kiro/steering"))).toEqual(["notes.md"]);
  });
});
