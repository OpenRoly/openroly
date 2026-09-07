import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  AdapterError,
  type AdapterContext,
  type ExtensionApplyAction,
  type RuntimeAdapter,
} from "./contract.ts";
import { withFileLock, writeFileAtomic } from "./credentials.ts";

// kind = "instructions" の materialize(PBI-0214 / EP-0017)。web で 1 本書いた指示が、各 agent の
// **global** 指示ファイルに入る。図14b が正本。
//
// 形は 2 つあるが **管理単位はどちらも同じ「ブロック」** 1 種類だけ:
//   file 形 (~/.claude/CLAUDE.md ・ ~/.codex/AGENTS.md ・ ~/.gemini/GEMINI.md ・
//            ~/.config/opencode/AGENTS.md): 人が書いた本文と同居するので、ブロックだけを
//            足す / 差し替える / 抜く。ブロックの外は 1 byte も触らない。
//   dir 形  (kiro steering …): `<dir>/<filename>` が丸ごと 1 extension。中身は file 形と
//            同じブロックなので、「openroly のブロックを持つ file だけが管理下」= marker と
//            ブロックが同じ 1 つの規約で済む(2 種類の marker を持たない)。
//
// 図8 7段目「未管理を絶対に触らない」の instructions 版:
//   - ブロックが無い file / dir 形の同名 file は install で **触らずに throw**(= failed)
//   - 壊れたブロック(begin だけ・end だけ・入れ子・同名 2 つ)も同じく触らずに throw
//   - uninstall は「ブロックが読めた時」だけ抜く。読めなければ no-op(半端に直さない)
//
// 書き込みは editConfig(native.ts / 図66)と同じ 3 不変条件を通す:
//   lock → 読む → parse 失敗なら **書かない** → temp → rename。

const BEGIN = (name: string): string => `<!-- openroly:begin ${name} -->`;
const END = (name: string): string => `<!-- openroly:end ${name} -->`;
/** 行頭から行末までがちょうど marker であること。本文中の説明文には当たらない */
const MARKER = /^<!-- openroly:(begin|end) (.+) -->[ \t]*$/gm;

interface Block {
  name: string;
  /** [start, end) = begin 行頭から end 行末まで(改行は含まない) */
  start: number;
  end: number;
}

/**
 * text の中の openroly ブロックを全部返す。**壊れていれば throw**(呼び手は 1 byte も書かずに止まる)。
 * 入れ子・begin だけ・end だけ・同名 2 つは全て「壊れている」—— どれも「どこからどこまでが
 * OpenRoly の持ち物か」を一意に決められないので、推測で書き換えるより失敗として残す方が安全。
 */
function parseBlocks(text: string, path: string): Block[] {
  const blocks: Block[] = [];
  let open: { name: string; start: number } | null = null;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
    const [whole, kind, name] = m as unknown as [string, "begin" | "end", string];
    if (kind === "begin") {
      if (open) {
        throw new AdapterError(
          `${path} has a broken OpenRoly block`,
          `"${BEGIN(open.name)}" is never closed before "${whole}"`,
        );
      }
      open = { name, start: m.index };
      continue;
    }
    if (!open || open.name !== name) {
      throw new AdapterError(
        `${path} has a broken OpenRoly block`,
        open ? `"${whole}" does not match "${BEGIN(open.name)}"` : `"${whole}" has no matching begin marker`,
      );
    }
    blocks.push({ name, start: open.start, end: m.index + whole.length });
    open = null;
  }
  if (open) {
    throw new AdapterError(
      `${path} has a broken OpenRoly block`,
      `"${BEGIN(open.name)}" is never closed`,
    );
  }
  const names = new Set<string>();
  for (const b of blocks) {
    if (names.has(b.name)) {
      throw new AdapterError(`${path} has a broken OpenRoly block`, `"${b.name}" appears twice`);
    }
    names.add(b.name);
  }
  return blocks;
}

/** name / content が marker 構文を壊さないこと。壊せると「人の本文を OpenRoly の持ち物に見せる」
 * (= 次の uninstall で人の行が消える)ので、書き込み前に必ず弾く。 */
function validate(name: string, content: string): void {
  if (/[\n\r<>]/.test(name)) {
    throw new AdapterError(
      `instructions extension "${name}": the name cannot contain a newline or angle brackets`,
      "the name is written into the block markers",
    );
  }
  if (/^<!-- openroly:/m.test(content)) {
    throw new AdapterError(
      `instructions extension "${name}": the content cannot contain an OpenRoly marker line`,
      "a marker inside the content would end the block early and put human-written text inside it",
    );
  }
  // **書こうとしている byte を、そのまま読み直せること**。文字種の blacklist だけでは足りない ——
  // U+2028 / U+2029 は JS 正規表現でも改行なので `.` に入らず(= marker に読み直せない)、
  // 空 name も `(.+)` に掛からない。どちらも上の 2 つと server の `name.length === 0` を
  // すり抜けるので、「読み直せないブロック」を人の file に書いてしまう —— そうなると
  // listExtensions が永久に見つけられず、reconcile が毎 sync で install を出し、append 枝が
  // 走って人の file がブロックで膨らみ続ける(しかも uninstall でも消せない)。
  const probe = blockText(name, content);
  const parsed = ((): Block[] => {
    try {
      return parseBlocks(probe, name);
    } catch {
      return [];
    }
  })();
  if (parsed.length !== 1 || parsed[0]!.name !== name || parsed[0]!.start !== 0 || parsed[0]!.end !== probe.length) {
    throw new AdapterError(
      `instructions extension "${name}": the name cannot be written as a block marker`,
      "the block would not be readable back, so it could never be updated or removed",
    );
  }
}

const blockText = (name: string, content: string): string =>
  `${BEGIN(name)}\n${content.replace(/\n+$/, "")}\n${END(name)}`;

/**
 * 同名ブロックが有れば **そこだけ** 差し替え、無ければ末尾に足す。**file 形も dir 形も同じ**。
 * 足すのは「区切りの `\n` 1 個 + ブロック + `\n` 1 個」だけで、**人の byte は 1 つも削らない**
 * (末尾の空行も人の物。`\n*$` で畳むと install しただけで人の file が変わり、uninstall しても
 * 戻らない)。最後の行が終端されていない時だけ `\n` を 1 個補う。
 */
function upsertBlock(text: string, blocks: Block[], name: string, body: string): string {
  const mine = blocks.find((b) => b.name === name);
  if (mine) return text.slice(0, mine.start) + body + text.slice(mine.end);
  if (text === "") return `${body}\n`;
  return `${text.endsWith("\n") ? text : `${text}\n`}\n${body}\n`;
}

/**
 * `upsertBlock` の逆。**install が書いた分だけ**抜く(`\n+` で畳むと人が書いた末尾の空行まで
 * 持っていき、install 前の byte に戻らない)。install が前に書いた `\n` は「その 1 個で空行が
 * できた」時だけ在るので、head が `\n\n` で終わる時だけ 1 個返す —— 人が自分でブロックの
 * すぐ上の行に書いた場合(head が `\n` 1 個で終わる)は、その `\n` は人の物なので触らない。
 */
function removeBlock(text: string, mine: Block): string {
  const head = text.slice(0, mine.start);
  const tail = text.slice(mine.end);
  return (head.endsWith("\n\n") ? head.slice(0, -1) : head) + tail.replace(/^\n/, "");
}

/** base の真の子孫でない resolved は拒否する(skill.ts の safeJoin と同じ理由・同じ境界)。
 * base 自身も resolve してから比べる —— 生の base(末尾 `/` 付き・相対)と resolve 済みの
 * 子を突き合わせると、正当な path まで全部弾く */
function safeJoin(baseRaw: string, rel: string): string {
  const base = resolve(baseRaw);
  const resolved = resolve(base, rel);
  if (!resolved.startsWith(base + sep)) {
    throw new AdapterError(
      `instructions extension: invalid path "${rel}"`,
      "it points outside the instructions directory",
    );
  }
  return resolved;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * **唯一の書き込み口**。editConfig(図66)と同じ形: lock → 読む → parse 失敗なら throw(何も書かない)
 * → mutate → temp → rename。`mutate` が null を返したら書かない(抜く対象が無い時)。
 */
async function editFile(
  logicalPath: string,
  mutate: (text: string, blocks: Block[]) => string | null,
): Promise<void> {
  await mkdir(dirname(logicalPath), { recursive: true });
  // symlink は **実体に書く**。temp → rename は path そのものを差し替えるので、解決しないと
  // 人の dotfiles 配線(`~/.claude/CLAUDE.md` → repo の実体)を普通の file で潰してしまう。
  // 実体を指すことで、同じ file を指す 2 つの path が同じ lock を取る効果もある
  const path = await realpath(logicalPath).catch(() => logicalPath);
  await withFileLock(path, async () => {
    const before = await readText(path);
    const after = mutate(before ?? "", parseBlocks(before ?? "", path));
    if (after === null || after === before) return;
    await writeFileAtomic(path, after);
  });
}

/** ctx から解決した書き先。file 形は 1 file を共有、dir 形は name ごとに 1 file */
export type InstructionsTarget = { file: string } | { dir: string; filename: string };
export type InstructionsTargetFn = (ctx: AdapterContext) => InstructionsTarget;

/** dir 形の書き先。`filename` の `${name}` を差し替える(catalog の kiro = `openroly-${name}.md`) */
function dirFormPath(target: { dir: string; filename: string }, name: string): string {
  if (/[/\\]/.test(name)) {
    throw new AdapterError(
      `instructions extension "${name}": the name cannot contain a path separator`,
      "instructions files are created only one level below the steering directory",
    );
  }
  return safeJoin(target.dir, target.filename.replaceAll("${name}", name));
}

async function applyInstructions(
  target: InstructionsTarget,
  name: string,
  spec: Record<string, unknown>,
): Promise<void> {
  if (typeof spec.content !== "string") {
    throw new AdapterError(`instructions extension "${name}": spec.content is not a string`);
  }
  validate(name, spec.content);
  const body = blockText(name, spec.content);

  if ("file" in target) {
    await editFile(target.file, (text, blocks) => upsertBlock(text, blocks, name, body));
    return;
  }

  const path = dirFormPath(target, name);
  await editFile(path, (text, blocks) => {
    // 既存 file に openroly ブロックが 1 つも無ければ、人が置いた同名 file —— 絶対に上書きしない
    if (text !== "" && !blocks.some((b) => b.name === name)) {
      throw new AdapterError(
        `instructions extension "${name}" collides with a file OpenRoly did not create`,
        `${path} has no "${BEGIN(name)}" marker, so it will not be overwritten`,
      );
    }
    // **file 形と同じ書き方**。dir 形も「file 丸ごと上書き」ではない —— 人がその file に
    // 足した行(kiro の steering を手で足した等)を、次の update で黙って消さないため
    return upsertBlock(text, blocks, name, body);
  });
}

/**
 * ブロックが読めた時だけ抜く(冪等)。**読めなければ何もしない** —— 壊れた file を推測で直すと
 * 人の行を巻き込むし、name は kind をまたいで一意なので、ここで throw すると同じ action の
 * mcp 側の削除まで道連れになる(disable/uninstall action は kind を持たない)。
 */
async function removeInstructionsIfPresent(target: InstructionsTarget, name: string): Promise<void> {
  let path: string;
  if ("file" in target) path = target.file;
  else {
    try {
      path = dirFormPath(target, name);
    } catch {
      return; // install で必ず弾かれる name = その file は存在し得ない
    }
  }
  // 書き先が無いなら **何もしない**。この関数は kind を持たない action(mcp / skill の uninstall)
  // からも必ず通るので、ここで editFile に入ると無関係な削除のたびに人の home に空の dir を作る
  if ((await readText(path).catch(() => null)) === null) return;

  let emptied = false;
  await editFile(path, (text, blocks) => {
    const mine = blocks.find((b) => b.name === name);
    if (!mine) return null; // 自分のブロックが無い = 人が置いた file。触らない
    const after = removeBlock(text, mine);
    emptied = after.trim() === "";
    return after;
  }).catch((e) => {
    if (e instanceof AdapterError) return; // 壊れている = 持ち主が判らない。触らない
    throw e;
  });
  // dir 形は 1 name = 1 file。中身が自分のブロックだけだったら file ごと片付ける
  // (人が同じ file に足した行が有れば、それは残すので file も残る)
  if (!("file" in target) && emptied) await rm(path, { force: true });
}

/** 管理下のブロック名。読めない / 壊れている / 無い時は空(= 「登録されていない」。
 * reconcile は install を出し、applyInstructions が触らずに failed を返す) */
async function listInstructions(target: InstructionsTarget): Promise<string[]> {
  if ("file" in target) {
    try {
      const text = await readText(target.file);
      return text === null ? [] : parseBlocks(text, target.file).map((b) => b.name);
    } catch {
      return [];
    }
  }
  let entries: string[];
  try {
    entries = (await readdir(target.dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    const path = resolve(target.dir, entry);
    try {
      const text = await readText(path);
      if (text === null) continue;
      for (const b of parseBlocks(text, path)) {
        // **list と uninstall が同じ規約を使う**: name N の書き先は dirFormPath(N) の 1 つだけ。
        // 別名の file に入っているブロック(人が openroly-foo.md を backup した等)を「管理下」と
        // 名乗ると、reconcile が「もう入っている」と読んで本物を永久に作らず(silent no-apply)、
        // uninstall もその file を指さないので永久に消えない
        if (dirFormPath(target, b.name) === path) names.push(b.name);
      }
    } catch {
      // 人が置いた file / 壊れたブロック / 書き先にならない name → 管理下ではない
    }
  }
  return names;
}

/**
 * 既存 adapter に kind = "instructions" を重ねる(withSkills と同じ重ね方)。
 * runtime 固有なのは `target(ctx)` の解決だけ —— official は adapter が直に、registry entry を
 * 持つ runtime は `native.instructions` が決める。
 */
export function withInstructions(base: RuntimeAdapter, target: InstructionsTargetFn): RuntimeAdapter {
  return {
    ...base,
    extensionKinds: [...base.extensionKinds.filter((k) => k !== "instructions"), "instructions"],
    async listExtensions(ctx) {
      const names = new Set((await base.listExtensions(ctx)).map((e) => e.name));
      for (const name of await listInstructions(target(ctx))) names.add(name);
      return [...names].map((name) => ({ name }));
    },
    async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
      if (action.action === "disable" || action.action === "uninstall") {
        // kind を持たない action なので両方見て、有る方だけ消す(withSkills と同じ規約)
        await removeInstructionsIfPresent(target(ctx), action.name);
        return base.applyExtension(ctx, action);
      }
      if (action.kind === "instructions") {
        await applyInstructions(target(ctx), action.name, action.spec);
        return;
      }
      return base.applyExtension(ctx, action);
    },
  };
}
