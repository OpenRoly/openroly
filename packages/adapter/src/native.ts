import type { NativeConfigLocation, NativeFormat, NativeMcpCli, NativeMcpFile, NativeSpec } from "@openroly/core";
import { parseNativeSpec, RESERVED_EXTENSION_NAMES } from "@openroly/core";
import { createScanner, findNodeAtLocation, getNodeValue, parseTree, type Node as JsoncNode, type ParseError } from "jsonc-parser";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Document, isSeq, parseDocument, type YAMLSeq } from "yaml";
import {
  AdapterError,
  run,
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type DetectResult,
  type ExportedExtension,
  type ExtensionApplyAction,
  type ExtensionListing,
  type Finding,
  type RegisterInput,
  type ExtensionAdapter,
} from "./contract.ts";
import { withFileLock, writeFileAtomic } from "./credentials.ts";
import { MCP_SERVER_NAME } from "./install.ts";
import { resolveMcpServerCommand } from "./mcp-config.ts";
import { withInstructions, type InstructionsTarget } from "./instructions.ts";
import { withSkills } from "./skill.ts";

// generic native adapter(PBI-0210 / EP-0017)。runtime = 署名付き registry の 1 entry。
// entry の `native`(config の場所・書き方・skills dir・指示 file)だけで、MCP 配線 5 op と
// skill 配布・指示ブロック(図14b)を捌く。
//
//   strategy "cli"  = runtime 自身の `mcp add` を argv template で叩く(openclaw / grok)。
//   strategy "file" = config file を直接書く(opencode / cursor / hermes / continue / vibe / zed …)。
//                     format handler: json / jsonc / json5 → jsonc-parser の AST で **範囲編集**
//                     (他 key・コメントは 1 byte も触らない)、yaml → yaml の Document(コメント保持)、
//                     toml → smol-toml(コメントは消える。catalog は `comments_preserved:false`)。
//                     `key`(dotted path)配下に **1 entry だけ**置換し、temp → rename で書く。
//
// 壊れた config(parse error)は **1 byte も書かず** throw する(AC-X2)。config が無いのは失敗ではない
// (新規作成する)。read-modify-write は `<path>.lock` で直列化する(AC-X3。credentials.json と同じ型)。
// 図: docs/diagrams.md 図66「native config への書き込み判定」。

/** template に流し込む材料。`env` は並び順を持つ(`--env K=V` の繰り返しに使う) */
interface McpMaterial {
  name: string;
  command: string;
  args: string[];
  env: [string, string][];
}

// ---------- template ----------

const FLAG_REPEAT = /\.\.\.$/;

function expandString(s: string, m: McpMaterial): unknown {
  if (s === "${args}") return [...m.args];
  if (s === "${env}") return Object.fromEntries(m.env);
  if (s === "${json}") return JSON.stringify({ command: m.command, args: m.args, env: Object.fromEntries(m.env) });
  return s.replaceAll("${name}", m.name).replaceAll("${command}", m.command);
}

/**
 * template を展開する。配列の中では
 *   "${args...}"          → args を要素展開
 *   "${env...}"           → "K=V" を要素展開
 *   "--flag...", "${args}" / "${env}" → 要素ごとに flag を繰り返す(`--env K=V --env K2=V2`)
 * それ以外の文字列は `${name}` `${command}` を置換、`"${args}"` `"${env}"` `"${json}"` 単独は値ごと差し替え。
 */
export function expandTemplate(tpl: unknown, m: McpMaterial): unknown {
  if (typeof tpl === "string") return expandString(tpl, m);
  if (Array.isArray(tpl)) {
    const out: unknown[] = [];
    for (let i = 0; i < tpl.length; i++) {
      const el = tpl[i];
      if (el === "${args...}") {
        out.push(...m.args);
        continue;
      }
      if (el === "${env...}") {
        out.push(...m.env.map(([k, v]) => `${k}=${v}`));
        continue;
      }
      const next = tpl[i + 1];
      if (typeof el === "string" && FLAG_REPEAT.test(el) && (next === "${args}" || next === "${env}")) {
        const flag = el.replace(FLAG_REPEAT, "");
        const items = next === "${args}" ? m.args : m.env.map(([k, v]) => `${k}=${v}`);
        for (const it of items) out.push(flag, it);
        i++;
        continue;
      }
      out.push(expandTemplate(el, m));
    }
    return out;
  }
  if (tpl !== null && typeof tpl === "object") {
    return Object.fromEntries(Object.entries(tpl as Record<string, unknown>).map(([k, v]) => [k, expandTemplate(v, m)]));
  }
  return tpl;
}

// ---------- path ----------

function userHome(env: Record<string, string | undefined>): string {
  return env.HOME ?? homedir();
}

function expandTilde(p: string, env: Record<string, string | undefined>): string {
  if (p === "~") return userHome(env);
  if (p.startsWith("~/")) return join(userHome(env), p.slice(2));
  return p;
}

/** `native.home` の実体(env が set されていればそれ、無ければ default) */
export function nativeHomeDir(spec: NativeSpec, env: Record<string, string | undefined>): string {
  const fromEnv = spec.home?.env ? env[spec.home.env] : undefined;
  if (fromEnv) return expandTilde(fromEnv, env);
  return expandTilde(spec.home?.default ?? "~", env);
}

/** `~/x` は HOME、絶対はそのまま、相対は `native.home` から */
export function resolveNativePath(p: string, spec: NativeSpec, env: Record<string, string | undefined>): string {
  if (p.startsWith("~")) return expandTilde(p, env);
  if (isAbsolute(p)) return p;
  return join(nativeHomeDir(spec, env), p);
}

// ---------- config document(format ごとの読み書き) ----------

const keyPath = (loc: NativeConfigLocation): string[] => loc.key.split(".").filter(Boolean);

/** 1 entry の抽象。format handler はこの 4 つを実装する */
interface ConfigDoc {
  /**
   * `key` 配下の entry を [名前, 値] で返す(map は key、list は match field の値)。
   * 名前だけが要る呼び手(doctor / listExtensions)も**同じ 1 本**を通す —— 名前用と値用で
   * 走査を 2 本持つと、片方だけが list 形 / 壊れた entry の扱いを直されてずれる
   */
  entries(): [string, unknown][];
  set(name: string, value: Record<string, unknown>): void;
  remove(name: string): boolean;
  text(): string;
}

function listMatchField(loc: NativeConfigLocation): string {
  return loc.match ?? "name";
}

function broken(format: NativeFormat, path: string, detail: string): AdapterError {
  return new AdapterError(
    `the ${format} config at ${path} could not be parsed, so nothing was written`,
    `${detail}. Fix the file (or move it aside) and run the command again`,
  );
}

/**
 * 構文としては読めたが、書きたい場所の**型が違う**(`mcpServers` が配列だった等)。
 * 「parse できなかった」と言わない —— 実際には parse できているので、その 1 行を信じた人は
 * 在りもしない構文エラーを探しに行く(message は 1 行目としてそのまま register_ack の detail になる)。
 */
function mismatch(format: NativeFormat, path: string, detail: string): AdapterError {
  return new AdapterError(
    `the ${format} config at ${path} does not have the expected shape (${detail}), so nothing was written`,
    `${detail}. Fix the file (or move it aside) and run the command again`,
  );
}

// --- json / jsonc / json5: AST の範囲編集。触るのは 1 entry の bytes だけ ---

function indentOfLine(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && text[start - 1] !== "\n") start--;
  const m = /^[ \t]*/.exec(text.slice(start, offset));
  return m ? m[0] : "";
}

function endOfLine(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && text[i] !== "\n") i++;
  return i;
}

/** value を JSON にし、2 行目以降を base indent に揃える */
function jsonAt(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : indent + l))
    .join("\n");
}

/**
 * `offset` 以降の最初の token が `,` か(jsonc の trailing comma / 次の要素の区切り)。
 * `SyntaxKind` は jsonc-parser の **ambient const enum** で `verbatimModuleSyntax` の下では読めないので、
 * 走査した token の bytes を見る(数値を焼き直すより、綴りを見る方が版に依らない)
 */
function commaFollows(text: string, offset: number): { has: boolean; end: number } {
  const sc = createScanner(text, true);
  sc.setPosition(offset);
  sc.scan();
  const start = sc.getTokenOffset();
  const end = start + sc.getTokenLength();
  return { has: text.slice(start, end) === ",", end };
}

class JsoncDoc implements ConfigDoc {
  private src: string;
  constructor(
    text: string,
    private readonly loc: NativeConfigLocation,
    private readonly path: string,
  ) {
    this.src = text.trim() === "" ? "{}\n" : text;
    const errors: ParseError[] = [];
    const root = parseTree(this.src, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0 || !root || root.type !== "object") {
      throw errors.length > 0
        ? broken(this.loc.format, this.path, `parse error at offset ${errors[0]!.offset}`)
        : mismatch(this.loc.format, this.path, "the top level is not an object");
    }
  }

  private root(): JsoncNode {
    return parseTree(this.src, [], { allowTrailingComma: true })!;
  }

  private container(): JsoncNode | undefined {
    return findNodeAtLocation(this.root(), keyPath(this.loc));
  }

  entries(): [string, unknown][] {
    const c = this.container();
    if (!c) return [];
    if (this.loc.shape === "list") {
      if (c.type !== "array") return [];
      const field = listMatchField(this.loc);
      return (c.children ?? [])
        .map((el): [string, unknown] => [
          el.children?.find((p) => p.children?.[0]?.value === field)?.children?.[1]?.value,
          getNodeValue(el),
        ])
        .filter((e): e is [string, unknown] => typeof e[0] === "string");
    }
    if (c.type !== "object") return [];
    return (c.children ?? [])
      .map((p): [string, unknown] => [p.children?.[0]?.value, p.children?.[1] ? getNodeValue(p.children[1]) : undefined])
      .filter((e): e is [string, unknown] => typeof e[0] === "string");
  }

  /** 既存 entry の value node(map は property の value、list は要素) */
  private entryNode(name: string): JsoncNode | undefined {
    const c = this.container();
    if (!c) return undefined;
    if (this.loc.shape === "list") {
      if (c.type !== "array") return undefined;
      const field = listMatchField(this.loc);
      return (c.children ?? []).find((el) => el.children?.find((p) => p.children?.[0]?.value === field)?.children?.[1]?.value === name);
    }
    if (c.type !== "object") return undefined;
    return c.children?.find((p) => p.children?.[0]?.value === name)?.children?.[1];
  }

  private replace(start: number, end: number, content: string): void {
    this.src = this.src.slice(0, start) + content + this.src.slice(end);
  }

  /** 既存の container(object / array)に要素を 1 つ足す。他の bytes は動かさない */
  private appendTo(c: JsoncNode, render: (indent: string) => string): void {
    const children = c.children ?? [];
    const closeOffset = c.offset + c.length - 1; // `}` / `]`
    if (children.length === 0) {
      const outer = indentOfLine(this.src, c.offset);
      const inner = `${outer}  `;
      this.replace(c.offset + 1, closeOffset, `\n${inner}${render(inner)}\n${outer}`);
      return;
    }
    const last = children[children.length - 1]!;
    const lastEnd = last.offset + last.length;
    const indent = indentOfLine(this.src, last.offset);
    const comma = commaFollows(this.src, lastEnd);
    // 直後の行末(trailing comment の後ろ)に新しい行を足す。comma は value の直後に置く
    const lineEnd = endOfLine(this.src, comma.has ? comma.end : lastEnd);
    const insertAt = Math.min(lineEnd, closeOffset);
    this.replace(insertAt, insertAt, `\n${indent}${render(indent)}`);
    if (!comma.has) this.replace(lastEnd, lastEnd, ",");
  }

  set(name: string, value: Record<string, unknown>): void {
    const isList = this.loc.shape === "list";
    const payload = isList ? { [listMatchField(this.loc)]: name, ...value } : value;
    const existing = this.entryNode(name);
    if (existing) {
      this.replace(existing.offset, existing.offset + existing.length, jsonAt(payload, indentOfLine(this.src, existing.offset)));
      return;
    }
    const path = keyPath(this.loc);
    // 既に在る最も深い祖先を探し、足りない container は object literal として一緒に作る
    let depth = path.length;
    let parent: JsoncNode | undefined;
    for (; depth >= 0; depth--) {
      parent = findNodeAtLocation(this.root(), path.slice(0, depth));
      if (parent) break;
    }
    if (!parent) throw mismatch(this.loc.format, this.path, "no top-level object");
    const missing = path.slice(depth);
    if (missing.length === 0) {
      if (isList ? parent.type !== "array" : parent.type !== "object") {
        throw mismatch(this.loc.format, this.path, `"${this.loc.key}" is not ${isList ? "an array" : "an object"}`);
      }
      this.appendTo(parent, (indent) => (isList ? jsonAt(payload, indent) : `${JSON.stringify(name)}: ${jsonAt(payload, indent)}`));
      return;
    }
    if (parent.type !== "object") throw mismatch(this.loc.format, this.path, `"${path.slice(0, depth).join(".")}" is not an object`);
    // 欠けている鎖を内側から組む: {"name": payload} または [payload] を missing の key で包む
    let nested: unknown = isList ? [payload] : { [name]: payload };
    for (let i = missing.length - 1; i > 0; i--) nested = { [missing[i]!]: nested };
    const head = missing[0]!;
    this.appendTo(parent, (indent) => `${JSON.stringify(head)}: ${jsonAt(nested, indent)}`);
  }

  remove(name: string): boolean {
    const node = this.entryNode(name);
    if (!node) return false;
    const target = this.loc.shape === "list" ? node : node.parent!; // list は要素、map は property
    let start = target.offset;
    let end = target.offset + target.length;
    const after = commaFollows(this.src, end);
    if (after.has) {
      // 後ろに要素が続く: `, ` ごと消し、次の要素の頭まで詰める
      end = after.end;
      while (end < this.src.length && /[ \t]/.test(this.src[end]!)) end++;
      if (this.src[end] === "\n") end++;
      while (start > 0 && /[ \t]/.test(this.src[start - 1]!)) start--;
    } else {
      // 最後の要素: 前の `,` と、自分の行の改行ごと消す
      while (start > 0 && /\s/.test(this.src[start - 1]!)) start--;
      if (this.src[start - 1] === ",") start--;
    }
    this.replace(start, end, "");
    return true;
  }

  text(): string {
    return this.src;
  }
}

// --- yaml: Document API(コメント保持。空白は正規化されうる) ---

class YamlDoc implements ConfigDoc {
  private readonly doc: Document;
  constructor(
    text: string,
    private readonly loc: NativeConfigLocation,
    path: string,
  ) {
    this.doc = parseDocument(text);
    if (this.doc.errors.length > 0) throw broken("yaml", path, this.doc.errors[0]!.message.split("\n")[0]!);
    if (this.doc.contents == null) this.doc.contents = this.doc.createNode({}) as never;
  }

  private seq(): YAMLSeq | undefined {
    const s = this.doc.getIn(keyPath(this.loc));
    return isSeq(s) ? s : undefined;
  }

  entries(): [string, unknown][] {
    if (this.loc.shape === "list") {
      const field = listMatchField(this.loc);
      return ((this.seq()?.toJSON() as unknown[] | undefined) ?? [])
        .map((el): [unknown, unknown] => [
          el && typeof el === "object" ? (el as Record<string, unknown>)[field] : undefined,
          el,
        ])
        .filter((e): e is [string, unknown] => typeof e[0] === "string");
    }
    const m = this.doc.getIn(keyPath(this.loc));
    const obj = m && typeof m === "object" && "toJSON" in m ? (m as { toJSON(): unknown }).toJSON() : undefined;
    return obj && typeof obj === "object" ? Object.entries(obj as Record<string, unknown>) : [];
  }

  private listIndex(name: string): number {
    const field = listMatchField(this.loc);
    const items = (this.seq()?.toJSON() as unknown[] | undefined) ?? [];
    return items.findIndex((el) => el && typeof el === "object" && (el as Record<string, unknown>)[field] === name);
  }

  set(name: string, value: Record<string, unknown>): void {
    const path = keyPath(this.loc);
    if (this.loc.shape === "list") {
      const payload = { [listMatchField(this.loc)]: name, ...value };
      const idx = this.listIndex(name);
      if (idx >= 0) {
        this.doc.setIn([...path, idx], payload);
        return;
      }
      if (!this.seq()) this.doc.setIn(path, []);
      this.seq()!.add(this.doc.createNode(payload));
      return;
    }
    this.doc.setIn([...path, name], value);
  }

  remove(name: string): boolean {
    const path = keyPath(this.loc);
    if (this.loc.shape === "list") {
      const idx = this.listIndex(name);
      if (idx < 0) return false;
      return this.doc.deleteIn([...path, idx]);
    }
    return this.doc.deleteIn([...path, name]);
  }

  text(): string {
    return this.doc.toString();
  }
}

// --- toml: parse → mutate → stringify(コメントは消える) ---

class TomlDoc implements ConfigDoc {
  private readonly obj: Record<string, unknown>;
  constructor(
    text: string,
    private readonly loc: NativeConfigLocation,
    path: string,
  ) {
    try {
      this.obj = parseToml(text) as Record<string, unknown>;
    } catch (e) {
      throw broken("toml", path, (e as Error).message.split("\n")[0]!);
    }
  }

  private container(create: boolean): unknown {
    let cur: Record<string, unknown> = this.obj;
    const path = keyPath(this.loc);
    for (let i = 0; i < path.length; i++) {
      const k = path[i]!;
      const last = i === path.length - 1;
      if (cur[k] === undefined) {
        if (!create) return undefined;
        cur[k] = last && this.loc.shape === "list" ? [] : {};
      }
      if (last) return cur[k];
      if (cur[k] === null || typeof cur[k] !== "object" || Array.isArray(cur[k])) return undefined;
      cur = cur[k] as Record<string, unknown>;
    }
    return cur;
  }

  entries(): [string, unknown][] {
    const c = this.container(false);
    if (this.loc.shape === "list") {
      const field = listMatchField(this.loc);
      return Array.isArray(c)
        ? c
            .map((el): [unknown, unknown] => [el && typeof el === "object" ? (el as Record<string, unknown>)[field] : undefined, el])
            .filter((e): e is [string, unknown] => typeof e[0] === "string")
        : [];
    }
    return c && typeof c === "object" && !Array.isArray(c) ? Object.entries(c as Record<string, unknown>) : [];
  }

  set(name: string, value: Record<string, unknown>): void {
    const c = this.container(true);
    if (this.loc.shape === "list") {
      if (!Array.isArray(c)) throw new AdapterError(`"${this.loc.key}" is not an array`);
      const field = listMatchField(this.loc);
      const payload = { [field]: name, ...value };
      const idx = c.findIndex((el) => el && typeof el === "object" && (el as Record<string, unknown>)[field] === name);
      if (idx >= 0) c[idx] = payload;
      else c.push(payload);
      return;
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new AdapterError(`"${this.loc.key}" is not a table`);
    (c as Record<string, unknown>)[name] = value;
  }

  remove(name: string): boolean {
    const c = this.container(false);
    if (this.loc.shape === "list") {
      if (!Array.isArray(c)) return false;
      const field = listMatchField(this.loc);
      const idx = c.findIndex((el) => el && typeof el === "object" && (el as Record<string, unknown>)[field] === name);
      if (idx < 0) return false;
      c.splice(idx, 1);
      return true;
    }
    if (!c || typeof c !== "object" || !(name in (c as object))) return false;
    delete (c as Record<string, unknown>)[name];
    return true;
  }

  text(): string {
    return `${stringifyToml(this.obj)}\n`;
  }
}

function openDoc(text: string, loc: NativeConfigLocation, path: string): ConfigDoc {
  switch (loc.format) {
    case "yaml":
      return new YamlDoc(text, loc, path);
    case "toml":
      return new TomlDoc(text, loc, path);
    default:
      // json / jsonc / json5。json5 の単引用符・裸 key は jsonc-parser が parse error にする =
      // 書かずに止まる(推測で書き換えない)。catalog は json5 の書き先を持たない(openclaw は cli)
      return new JsoncDoc(text, loc, path);
  }
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
 * config 内の server 名一覧。**読めない / 壊れている / 無い時は空**(= 「登録されていない」。
 * doctor は「無い」と言って install の案内に繋ぐ)。official adapter(mcp-config.ts)も同じ reader を
 * 使う —— format ごとの読み方はここ 1 箇所(json / jsonc / json5 / yaml / toml)。
 */
export async function readConfigNames(loc: NativeConfigLocation, path: string): Promise<string[]> {
  return (await readConfigEntries(loc, path)).map(([name]) => name);
}

/** `readConfigNames` の値つき版(PBI-0212 の吸い上げが使う)。読めない時の扱いは同じ = 空 */
export async function readConfigEntries(
  loc: NativeConfigLocation,
  path: string,
): Promise<[string, unknown][]> {
  try {
    const text = await readText(path);
    if (text === null) return [];
    return openDoc(text, loc, path).entries();
  } catch {
    return [];
  }
}

/**
 * native config の 1 entry を `{command, args, env}` に戻す(PBI-0212 / 図67)。
 * MCP config の書き方は 2 通りしか実在しない(2026-09-05 実測: catalog の全 5 entry + official 3):
 *   ① `{command: "npx", args: [...], env: {...}}`  ② `{command: ["npx", ...], environment: {...}}`
 * どちらでもない entry(remote server の `{url}` 等)は **null** = 提案に上げない —— 推測で
 * `{command: undefined}` を送ると、承認した瞬間に全 agent の sync が失敗し続ける。
 */
export function normalizeMcpEntry(
  value: unknown,
): { command: string; args: string[]; env: Record<string, string> } | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const argv = Array.isArray(v.command) ? v.command.map(String) : null;
  const command = argv ? argv[0] : typeof v.command === "string" ? v.command : undefined;
  if (!command) return null;
  const args = argv ? argv.slice(1) : Array.isArray(v.args) ? v.args.map(String) : [];
  const rawEnv = v.env ?? v.environment;
  const env: Record<string, string> = {};
  if (rawEnv != null && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
    for (const [k, val] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof val === "string") env[k] = val;
    }
  }
  return { command, args, env };
}

/**
 * config に在る MCP server を提案の形にする(generic / official 共通の 1 本)。
 * `openroly` 自身と予約名は外す —— 自分が配った物を自分で提案し返すと循環する。
 * env は spec に残さず `secretEnv` へ移す(値は端末から出ない。`ExportedExtension` の注記)。
 */
export async function exportMcpFromConfig(
  loc: NativeConfigLocation,
  path: string,
): Promise<ExportedExtension[]> {
  const out: ExportedExtension[] = [];
  for (const [name, value] of await readConfigEntries(loc, path)) {
    if (name === MCP_SERVER_NAME || (RESERVED_EXTENSION_NAMES as readonly string[]).includes(name)) continue;
    const entry = normalizeMcpEntry(value);
    if (!entry) continue;
    out.push({
      kind: "mcp",
      name,
      spec: { command: entry.command, args: entry.args },
      secretEnv: entry.env,
    });
  }
  return out;
}

/**
 * **唯一の書き込み口**(図66)。lock → 読む → parse(失敗なら throw = 何も書かない)→ 1 entry を
 * 置換 / 削除 → temp → rename。`mutate` が false を返したら書かない(削除対象が無い時)。
 */
async function editConfig(
  loc: NativeConfigLocation,
  path: string,
  mutate: (doc: ConfigDoc) => boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(path, async () => {
    const before = await readText(path);
    const doc = openDoc(before ?? "", loc, path);
    if (!mutate(doc)) return;
    const after = doc.text();
    if (after === before) return;
    await writeFileAtomic(path, after);
  });
}

// ---------- adapter ----------

/**
 * `native` から ExtensionAdapter を組む。`nativeRaw` は registry / broker(`--spec-stdin`)/ bundled catalog
 * から来た生の JSON —— ここで `parseNativeSpec` を通す(壊れていれば throw。adopt は exit 2)。
 */
export function createNativeAdapter(id: string, displayName: string, nativeRaw: unknown): ExtensionAdapter {
  const spec = parseNativeSpec(nativeRaw, id);
  const bin = spec.bin === null ? null : (spec.bin ?? id);
  const installHint = spec.install ?? `${displayName} was not found on this machine. Install it and run 'openroly install ${id}' again`;

  const mcpPath = (ctx: AdapterContext): string | null => {
    const loc = readLocation(spec.mcp);
    return loc ? resolveNativePath(loc.path, spec, ctx.env) : null;
  };

  const material = (name: string, command: string, args: string[], env: [string, string][]): McpMaterial => ({
    name,
    command,
    args,
    env,
  });

  /** 1 entry を書く(strategy で分岐)。cli は消してから足す(mcp-config と同じ冪等の手) */
  const put = async (ctx: AdapterContext, m: McpMaterial): Promise<void> => {
    const mcp = spec.mcp;
    if (!mcp) throw new AdapterError(`${displayName} has no MCP configuration in the catalog (native.mcp is null)`);
    if (mcp.strategy === "cli") {
      const cli = mcp.bin ?? bin ?? id;
      await run(ctx, [cli, ...(expandTemplate(mcp.remove, m) as string[])]).catch(() => null);
      const result = await run(ctx, [cli, ...(expandTemplate(mcp.add, m) as string[])]);
      if (!result.ok) throw new Error(`${cli} mcp add failed: ${result.stderr || result.stdout}`);
      return;
    }
    const path = resolveNativePath(mcp.path, spec, ctx.env);
    const entry = expandTemplate(mcp.entry, m) as Record<string, unknown>;
    await editConfig(mcp, path, (doc) => {
      doc.set(m.name, entry);
      return true;
    });
  };

  const drop = async (ctx: AdapterContext, name: string, mustExist: boolean): Promise<void> => {
    const mcp = spec.mcp;
    if (!mcp) return;
    if (mcp.strategy === "cli") {
      const cli = mcp.bin ?? bin ?? id;
      const m = material(name, "", [], []);
      const result = await run(ctx, [cli, ...(expandTemplate(mcp.remove, m) as string[])]);
      if (!result.ok && mustExist) throw new Error(`${cli} mcp remove failed: ${result.stderr || result.stdout}`);
      return;
    }
    const path = resolveNativePath(mcp.path, spec, ctx.env);
    await editConfig(mcp, path, (doc) => doc.remove(name));
  };

  const base: ExtensionAdapter = {
    id,
    displayName,
    capabilities: STAGE0_CAPABILITIES,

    async detect(ctx): Promise<DetectResult> {
      const configPath = mcpPath(ctx) ?? undefined;
      if (bin) {
        const version = await run(ctx, [bin, ...(spec.version_args ?? ["--version"])]).catch(() => null);
        if (version?.ok) return { installed: true, detail: version.stdout.trim().split("\n")[0] ?? "", configPath };
      }
      const home = nativeHomeDir(spec, ctx.env);
      if (spec.home && existsSync(home)) return { installed: true, detail: `${home} present`, configPath };
      return { installed: false, detail: installHint };
    },

    async register(ctx, input: RegisterInput): Promise<void> {
      const cmd = resolveMcpServerCommand(input.serverEntry, ctx.env);
      await put(
        ctx,
        material(input.serverName, cmd.command, cmd.args, [
          ["OPENROLY_RUNTIME_KIND", input.runtimeKind],
          ["OPENROLY_URL", input.baseUrl],
        ]),
      );
    },

    async unregister(ctx, serverName): Promise<void> {
      await drop(ctx, serverName, true);
    },

    async doctor(ctx, serverName): Promise<Finding[]> {
      const loc = readLocation(spec.mcp);
      const path = mcpPath(ctx);
      if (!spec.mcp) {
        return [{ ok: false, label: `${displayName} MCP registration`, detail: "the catalog has no MCP configuration for this runtime" }];
      }
      if (!loc || !path) {
        return [{ ok: true, label: `${displayName} MCP registration`, detail: `registered through '${spec.mcp.strategy === "cli" ? (spec.mcp.bin ?? bin ?? id) : id} mcp add' (the config file is not declared, so it is not re-read)` }];
      }
      const registered = (await readConfigNames(loc, path)).includes(serverName);
      const findings: Finding[] = [
        {
          ok: registered,
          label: `${displayName} MCP registration`,
          detail: registered ? `"${serverName}" in ${path}` : `"${serverName}" is missing from ${path}. Run 'openroly install ${id}'`,
        },
      ];
      if (spec.comments_preserved === false) {
        findings.push({ ok: true, label: `${displayName} config format`, detail: `${loc.format} is rewritten as a whole; comments in ${path} are not preserved` });
      }
      return findings;
    },

    extensionKinds: ["mcp"],

    /** PBI-0213: config file(file strategy)だけ。cli strategy でも読む場所は native.mcp.path */
    watchPaths(ctx): string[] {
      const path = mcpPath(ctx);
      return path ? [path] : [];
    },

    async listExtensions(ctx): Promise<ExtensionListing[]> {
      const loc = readLocation(spec.mcp);
      const path = mcpPath(ctx);
      if (!loc || !path) return [];
      return (await readConfigNames(loc, path)).map((name) => ({ name }));
    },

    async exportExtensions(ctx): Promise<ExportedExtension[]> {
      const loc = readLocation(spec.mcp);
      const path = mcpPath(ctx);
      if (!loc || !path) return [];
      return exportMcpFromConfig(loc, path);
    },

    async applyExtension(ctx, action: ExtensionApplyAction): Promise<void> {
      if (action.action === "disable" || action.action === "uninstall") {
        const loc = readLocation(spec.mcp);
        const path = mcpPath(ctx);
        // 既に無ければ成功扱い(冪等)。読める config が在る時だけ先に読んで判定する(mcp-config と同じ)
        if (loc && path && !(await readConfigNames(loc, path)).includes(action.name)) return;
        await drop(ctx, action.name, true);
        return;
      }
      const s = action.spec as { command?: unknown; args?: unknown };
      if (typeof s.command !== "string") throw new Error(`extension "${action.name}": spec.command is not a string`);
      await put(ctx, material(action.name, s.command, Array.isArray(s.args) ? s.args.map(String) : [], Object.entries(action.env)));
    },
  };

  const withSkill = spec.skills
    ? withSkills(base, (ctx) => resolveNativePath(spec.skills!.dir, spec, ctx.env))
    : base;
  // `native.instructions` が null の entry は kind = "instructions" を持たない(unsupported)。
  // path は skills と同じ resolveNativePath(`~/x` / 絶対 / `native.home` からの相対)
  const ins = spec.instructions;
  if (!ins) return withSkill;
  return withInstructions(withSkill, (ctx): InstructionsTarget =>
    "file" in ins
      ? { file: resolveNativePath(ins.file, spec, ctx.env) }
      : { dir: resolveNativePath(ins.dir, spec, ctx.env), filename: ins.filename },
  );
}

/** strategy 共通の読み先(file は自身、cli は `read`。無ければ null) */
function readLocation(mcp: NativeMcpFile | NativeMcpCli | null): NativeConfigLocation | null {
  if (!mcp) return null;
  if (mcp.strategy === "file") return mcp;
  return mcp.read ?? null;
}
