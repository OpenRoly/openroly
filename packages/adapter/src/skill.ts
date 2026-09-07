import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AdapterError,
  type AdapterContext,
  type ExportedExtension,
  type ExtensionApplyAction,
  type RuntimeAdapter,
} from "./contract.ts";

// kind = "skill" の materialize(W20 / PBI-0091 に claude から共通化。図 14 の正本はここ)。
// Agent Skills 仕様(Claude / Codex CLI 共通)の skill は「SKILL.md(frontmatter 必須)を含む
// directory」を skills/ の直下に置くだけで良いため、claude と codex の差は
// skillsDir(ctx) の決め方だけ(CLAUDE_CONFIG_DIR / CODEX_HOME)。
//   - claude: $CLAUDE_CONFIG_DIR/skills 〜 ~/.claude/skills
//   - codex : $CODEX_HOME/skills 〜 ~/.codex/skills
// (出典: https://community.openai.com/t/skills-for-codex-experimental-support-starting-today/1369367
//   https://learn.chatgpt.com/docs/build-skills)

/** base の真の子孙でない resolved は全て拒否する — resolved === base を許すと rel="."/""/"./"/
 * "foo/.." のいずれでも通ってしまい(path.resolve の標準挙動)、name 側の呼び出しでは
 * skillsDir 自体が「消してから作り直す」対象になって他の全 skill が消える
 * (PBI-0008 実装前レビューで発見。図 14)。 */
function safeJoin(base: string, rel: string): string {
  const resolved = resolve(base, rel);
  if (!resolved.startsWith(base + sep)) {
    throw new AdapterError(`skill extension: invalid path "${rel}"`, "it points outside the skill directory");
  }
  return resolved;
}

/** OpenRoly が作った skill ディレクトリだけに立つ sentinel。実測(2026-08-25, 実 claude CLI 2.1.243):
 * `~/.claude/skills/` には SKILL.md だけの人間の私物 skill が(このマシンで 48 件)実在し、
 * 名前は完全に自由(予約無し)。marker が無ければ「OpenRoly が作ったのではない」と確実に判定できる
 * ので、install の上書きと disable/uninstall の削除の両方をこれで gate する
 * (図8 7段目「未管理を絶対に触らない」を skill kind でも守るための追加防御)。 */
const OPENROLY_MANAGED_MARKER = ".openroly-managed";

/** SKILL.md と marker は adapter が組み立てる物なので、spec.files から上書きさせない(PBI-0036)。
 * 判定は safeJoin 後の resolved path で行う — 生キーの文字列比較だと "./SKILL.md" や
 * "references/../SKILL.md" が素通りし、frontmatter を失った SKILL.md(= CLI に認識されない)を
 * 成功扱いで書いてしまう(AC-13 が description で守った不変条件の files 経路での抜け穴) */
const RESERVED_SKILL_FILES = ["SKILL.md", OPENROLY_MANAGED_MARKER];

export type SkillsDirFn = (ctx: AdapterContext) => string;

async function applySkillExtension(
  ctx: AdapterContext,
  skillsDir: SkillsDirFn,
  name: string,
  spec: Record<string, unknown>,
): Promise<void> {
  // 1. 全パス(name 由来の skillDir 自体・files の全キー)を検証してから書き込みを始める
  //    (1 つでも不正なら 1 byte も書かない)
  // skill は skills/ の直下 1 階層にしか作らない(PBI-0036)。"foo/bar" は safeJoin を通って
  // しまうが、listExtensions は readdir の直下しか見ないので native listing と永久に
  // 噛み合わず(毎 sync で install が再実行される)、さらに marker を持たない中間ディレクトリ
  // skills/foo が残ることで、後から正当な skill "foo" を install する経路を AC-15 の
  // 衝突判定が永久に塞ぐ(API からの復旧手段が無い自傷ロックアウト)。
  // mcp の name は path join を経ないため、この制限は skill kind の中だけに閉じる
  const skillDir = safeJoin(skillsDir(ctx), name);
  if (/[/\\]/.test(name)) {
    throw new AdapterError(
      `skill extension "${name}": the name cannot contain a path separator`,
      "skills are created only one level below skills/",
    );
  }
  const reservedPaths = new Set(RESERVED_SKILL_FILES.map((f) => join(skillDir, f)));
  const rawFiles = spec.files;
  if (rawFiles != null && (typeof rawFiles !== "object" || Array.isArray(rawFiles))) {
    throw new AdapterError(`skill extension "${name}": spec.files is not an object`);
  }
  const resolvedFiles: [string, string][] = [];
  for (const [rel, content] of Object.entries((rawFiles ?? {}) as Record<string, unknown>)) {
    const path = safeJoin(skillDir, rel);
    if (reservedPaths.has(path)) {
      throw new AdapterError(
        `skill extension "${name}": spec.files tries to overwrite the reserved file "${rel}"`,
        "SKILL.md is assembled from description/instructions, and .openroly-managed is managed by OpenRoly",
      );
    }
    if (typeof content !== "string") {
      throw new AdapterError(`skill extension "${name}": spec.files["${rel}"] is not a string`);
    }
    resolvedFiles.push([path, content]);
  }
  // 2. spec.description / spec.instructions が string でなければ throw(何も書かない)
  if (typeof spec.description !== "string") {
    throw new AdapterError(`skill extension "${name}": spec.description is not a string`);
  }
  if (typeof spec.instructions !== "string") {
    throw new AdapterError(`skill extension "${name}": spec.instructions is not a string`);
  }
  // 既存の skillDir が有るのに OpenRoly marker が無ければ、人間が別途作った private skill(名前が
  // たまたま衝突しただけ)である可能性が高い — 絶対に上書きしない(何も書かない)
  const existingMarker = await stat(join(skillDir, OPENROLY_MANAGED_MARKER)).then(
    () => true,
    () => false,
  );
  const dirExists = await stat(skillDir).then(
    () => true,
    () => false,
  );
  if (dirExists && !existingMarker) {
    throw new AdapterError(
      `skill extension "${name}" collides with an existing directory that OpenRoly did not create`,
      `${skillDir} has no marker (${OPENROLY_MANAGED_MARKER}), so it will not be overwritten`,
    );
  }

  // 3. 既存の skillDir が有れば丸ごと削除してから再作成する(mcp の「消してから足す」冪等
  //    パターンと同じ理由 — 前 revision の files に有って今の revision に無いファイルの残留防止)
  await rm(skillDir, { recursive: true, force: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, OPENROLY_MANAGED_MARKER), "");
  // 4. frontmatter は JSON.stringify で二重引用符 scalar 化する(YAML 1.2 は JSON 文字列を
  //    正当な flow scalar として受理するため、コロン・引用符・改行を含む値でも壊れない)
  const frontmatter = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(spec.description)}\n---\n`;
  await writeFile(join(skillDir, "SKILL.md"), frontmatter + spec.instructions);
  // 5. spec.files の各エントリを(親ディレクトリを mkdir -p して)書く
  for (const [path, content] of resolvedFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** skillDir が有り、かつ OpenRoly marker を持つ時だけ削除(無ければ何もしない = 冪等)。marker が
 * 無いディレクトリは人間の私物 skill の可能性が高いので絶対に触らない(図8 7段目と同じ不変条件)。
 * 不正な name は skill として存在し得ない(install 時に同じ safeJoin で必ず弾かれているため、
 * ここでは黙って「無い」扱いにする)。 */
async function removeSkillIfPresent(ctx: AdapterContext, skillsDir: SkillsDirFn, name: string): Promise<void> {
  let skillDir: string;
  try {
    skillDir = safeJoin(skillsDir(ctx), name);
  } catch {
    return;
  }
  const isManaged = await stat(join(skillDir, OPENROLY_MANAGED_MARKER)).then(
    () => true,
    () => false,
  );
  if (!isManaged) return;
  await rm(skillDir, { recursive: true, force: true });
}

/**
 * 吸い上げ(PBI-0212)の上限。1 file 64KiB / 1 skill 256KiB を超えたら **その skill を丸ごと落とす**
 * —— 参照 file を黙って落として SKILL.md だけ配ると、配布先では「本文が自分の references を
 * 指しているのに無い」skill になる(壊れた物を成功として配る)。落とすなら丸ごと。
 */
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILL_TOTAL_BYTES = 256 * 1024;

/** SKILL.md の frontmatter と本文を分ける。frontmatter が無い dir は Agent Skill ではない */
function splitSkillMd(text: string): { description: string; instructions: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  let front: unknown;
  try {
    front = parseYaml(m[1]!);
  } catch {
    return null;
  }
  const description = (front as Record<string, unknown> | null)?.description;
  if (typeof description !== "string") return null;
  return { description, instructions: text.slice(m[0].length) };
}

/**
 * skill dir の SKILL.md 以外の file(再帰)。上限超え・非 UTF-8 は null = skill ごと落とす。
 * **`.` で始まる名前は丸ごと飛ばす**(PBI-0212 有界レビュー) —— 実測で 2 つ壊れていた:
 *   ① `.env` / `.netrc` が spec.files に入って Account へ行った(「秘密は端末に留まる」の反例)
 *   ② `git clone` で入れた skill は `.git` の binary object で **skill ごと黙って落ちて**いた
 * `.openroly-managed` の除外もこの 1 行に含まれる(marker は dot file)。
 */
async function readSkillFiles(skillDir: string): Promise<Record<string, string> | null> {
  const files: Record<string, string> = {};
  let total = 0;
  const walk = async (dir: string): Promise<boolean> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = relative(skillDir, full);
      if (rel === "SKILL.md") continue;
      if (entry.isDirectory()) {
        if (!(await walk(full))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await stat(full)).size;
      total += size;
      if (size > MAX_SKILL_FILE_BYTES || total > MAX_SKILL_TOTAL_BYTES) return false;
      const buf = Buffer.from(await readFile(full));
      const text = buf.toString("utf8");
      // 非 UTF-8(画像等)は round-trip が壊れる。spec.files は string しか運べない
      if (!Buffer.from(text, "utf8").equals(buf)) return false;
      files[rel.split(sep).join("/")] = text;
    }
    return true;
  };
  return (await walk(skillDir)) ? files : null;
}

/**
 * 人が自分で置いた skill を提案の形にする(PBI-0212 / 図67)。**`.openroly-managed` を持つ dir は
 * 除く** —— OpenRoly が配った物を提案し返すと、承認のたびに増える循環になる(図8 7 段目と同じ不変条件
 * の吸い上げ側)。SKILL.md を持たない dir は Agent Skill ではないので触らない。
 */
async function exportSkills(ctx: AdapterContext, skillsDir: SkillsDirFn): Promise<ExportedExtension[]> {
  let dir: string;
  try {
    dir = skillsDir(ctx);
  } catch {
    return [];
  }
  let listing: Dirent[];
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExportedExtension[] = [];
  for (const entry of listing) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const managed = await stat(join(skillDir, OPENROLY_MANAGED_MARKER)).then(() => true, () => false);
    if (managed) continue;
    const md = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => null);
    if (md === null) continue;
    const parsed = splitSkillMd(md);
    if (!parsed) continue;
    const files = await readSkillFiles(skillDir);
    if (files === null) continue;
    out.push({
      kind: "skill",
      name: entry.name,
      spec: {
        description: parsed.description,
        instructions: parsed.instructions,
        ...(Object.keys(files).length > 0 ? { files } : {}),
      },
      secretEnv: {},
    });
  }
  return out;
}

/** MCP-config adapter(PBI-0060)の上に skill kind を足す。claude(PBI-0008 では直書き)と
 * codex(W20)の差は skillsDir だけ — この関数が図 14 の skill 分岐の実体。
 * extensionKinds は base に "skill" を追記し、listExtensions は mcp server 名に
 * skills/ 直下 directory を合算、applyExtension は skill を分岐して disable/uninstall は
 * 両経路(skill → mcp)を見る(kind を持たない action の既存規約)。 */
export function withSkills(base: RuntimeAdapter, skillsDir: SkillsDirFn): RuntimeAdapter {
  return {
    ...base,
    extensionKinds: [...base.extensionKinds.filter((k) => k !== "skill"), "skill"],
    /** PBI-0213: base の config file に skills dir を足す(dir 自体の変化 = skill の増減) */
    watchPaths(ctx) {
      return [...base.watchPaths(ctx), skillsDir(ctx)];
    },
    async listExtensions(ctx) {
      // mcp server 名に加えて skills/ の直下ディレクトリも native の実在として数える
      const names = new Set((await base.listExtensions(ctx)).map((e) => e.name));
      try {
        for (const entry of await readdir(skillsDir(ctx), { withFileTypes: true })) {
          if (entry.isDirectory()) names.add(entry.name);
        }
      } catch {
        // skills/ が無ければ skill は 0 件(mcp のみ返す)
      }
      return [...names].map((name) => ({ name }));
    },
    async exportExtensions(ctx) {
      return [...(await base.exportExtensions(ctx)), ...(await exportSkills(ctx, skillsDir))];
    },
    async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
      if (action.action === "disable" || action.action === "uninstall") {
        // skill/mcp どちらか一方にしか存在し得ない(name は account 内で kind をまたいで一意)が、
        // disable/uninstall action は kind を持たないため両方を見て、有る方だけ消す
        await removeSkillIfPresent(ctx, skillsDir, action.name);
        return base.applyExtension(ctx, action);
      }
      if (action.kind === "skill") {
        await applySkillExtension(ctx, skillsDir, action.name, action.spec);
        return;
      }
      return base.applyExtension(ctx, action);
    },
  };
}
