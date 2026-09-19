// registry entry の `native`(PBI-0210 / EP-0017)。runtime を「署名付き registry の 1 entry」にするための、
// **その runtime の config をどこに・どう書くか**の宣言。generic adapter(`packages/adapter/src/native.ts`
// の `createNativeAdapter`)がこれ 1 つで MCP 配線と skill 配布を捌く。
//
// 形の検証はここ 1 箇所(server の `parseRegistry`、CLI の `openroly adopt --spec-stdin`、catalog-build が
// 同じ関数を通す)。**推測で埋めない** —— 分からない項目は null(= unsupported)で、adapter は
// その面を「無い」として扱う(fail-closed)。

export type NativeFormat = "json" | "jsonc" | "json5" | "yaml" | "toml";
export const NATIVE_FORMATS: readonly NativeFormat[] = ["json", "jsonc", "json5", "yaml", "toml"];

/** config の根。`env` が set されていればその値、無ければ `default`(`~/` は HOME) */
export interface NativeHome {
  env?: string;
  default: string;
}

/** config file の 1 箇所を指す(file strategy の書き先・cli strategy の読み先) */
export interface NativeConfigLocation {
  /** `~/x`・絶対 path・または `home` からの相対 */
  path: string;
  format: NativeFormat;
  /** dotted path(`mcp` / `mcp_servers` / `amp.mcpServers`) */
  key: string;
  /** map = `key.<name>` に 1 entry。list = `key` 配列の中で `match` field が name の 1 要素 */
  shape?: "map" | "list";
  /** list の時に name を持つ field(既定 "name") */
  match?: string;
}

export interface NativeMcpFile extends NativeConfigLocation {
  strategy: "file";
  /** 書く entry の template。`${command}` `${args}` `${env}` `${name}` を展開する(`${args...}` は要素展開) */
  entry: Record<string, unknown>;
}

export interface NativeMcpCli {
  strategy: "cli";
  /** 叩く CLI(既定 = entry の `bin` / id) */
  bin?: string;
  /** `bin` の後ろに付く argv template。`${name}` `${command}` `${args...}` `${env...}` `${json}`、
   * `["--env...", "${env}"]` の対で flag を要素ごとに繰り返す */
  add: string[];
  remove: string[];
  /** HTTP/SSE MCP を足す argv。`${name}` `${url}`。無い runtime は url 形を書けない */
  add_url?: string[];
  /** CLI が書いた config を doctor / listExtensions が読む場所(無ければ読めない = doctor は unknown) */
  read?: NativeConfigLocation | null;
}

export type NativeMcp = NativeMcpFile | NativeMcpCli;

export interface NativeSpec {
  home?: NativeHome | null;
  /** detect に使う binary 名(既定 = entry id)。app だけの entry は null */
  bin?: string | null;
  version_args?: string[];
  /** detect が失敗した時に人へ出す 1 行 */
  install?: string | null;
  mcp: NativeMcp | null;
  skills?: { dir: string } | null;
  /** 指示ファイル(PBI-0214 で使う。ここでは形だけ通す) */
  instructions?: { file: string } | { dir: string; filename: string } | null;
  /** toml のように書き戻しでコメントが消える format は false(doctor が 1 行出す) */
  comments_preserved?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function parseLocation(raw: Record<string, unknown>, where: string): NativeConfigLocation {
  if (typeof raw.path !== "string" || raw.path === "") throw new Error(`${where}.path が無い`);
  if (!NATIVE_FORMATS.includes(raw.format as NativeFormat)) throw new Error(`${where}.format は ${NATIVE_FORMATS.join("|")}`);
  if (typeof raw.key !== "string" || raw.key === "") throw new Error(`${where}.key が無い`);
  const shape = raw.shape ?? "map";
  if (shape !== "map" && shape !== "list") throw new Error(`${where}.shape は map|list`);
  if (raw.match !== undefined && typeof raw.match !== "string") throw new Error(`${where}.match は string`);
  return {
    path: raw.path,
    format: raw.format as NativeFormat,
    key: raw.key,
    shape,
    ...(typeof raw.match === "string" ? { match: raw.match } : {}),
  };
}

/**
 * `native` の形を検証して返す。壊れていれば throw(message は `native(<id>): …`)。
 * 未知の field は落とす(registry 側が先に増えても古い CLI が壊れない。broker と同じ姿勢)。
 */
export function parseNativeSpec(raw: unknown, id: string): NativeSpec {
  // 型注釈を **変数側** に置く —— `const fail = (…): never => …` だけでは TS が「この行の後は
  // 到達しない」と読まず、後続の絞り込みが全部 unknown のままになる(TS 3.7 の規則)
  const fail: (msg: string) => never = (msg) => {
    throw new Error(`native(${id}): ${msg}`);
  };
  if (!isObj(raw)) return fail("object ではない");
  const out: NativeSpec = { mcp: null };
  if (raw.home != null) {
    if (!isObj(raw.home) || typeof raw.home.default !== "string") fail("home.default が無い");
    const home = raw.home as Record<string, unknown>;
    if (home.env !== undefined && typeof home.env !== "string") fail("home.env は string");
    out.home = { default: home.default as string, ...(typeof home.env === "string" ? { env: home.env } : {}) };
  }
  if (raw.bin !== undefined) {
    if (raw.bin !== null && typeof raw.bin !== "string") fail("bin は string | null");
    out.bin = raw.bin as string | null;
  }
  if (raw.version_args !== undefined) {
    if (!isStrArr(raw.version_args)) fail("version_args は string[]");
    out.version_args = raw.version_args;
  }
  if (raw.install !== undefined) {
    if (raw.install !== null && typeof raw.install !== "string") fail("install は string | null");
    out.install = raw.install as string | null;
  }
  if (raw.mcp != null) {
    if (!isObj(raw.mcp)) fail("mcp は object | null");
    const mcp = raw.mcp as Record<string, unknown>;
    if (mcp.strategy === "file") {
      if (!isObj(mcp.entry)) fail("mcp.entry(template)が無い");
      try {
        out.mcp = { strategy: "file", ...parseLocation(mcp, "mcp"), entry: mcp.entry };
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (mcp.strategy === "cli") {
      if (!isStrArr(mcp.add) || mcp.add.length === 0) fail("mcp.add(argv template)が無い");
      if (!isStrArr(mcp.remove) || mcp.remove.length === 0) fail("mcp.remove(argv template)が無い");
      if (mcp.add_url !== undefined && (!isStrArr(mcp.add_url) || mcp.add_url.length === 0)) {
        fail("mcp.add_url は string[]");
      }
      if (mcp.bin !== undefined && typeof mcp.bin !== "string") fail("mcp.bin は string");
      let read: NativeConfigLocation | null = null;
      if (mcp.read != null) {
        if (!isObj(mcp.read)) fail("mcp.read は object | null");
        try {
          read = parseLocation(mcp.read as Record<string, unknown>, "mcp.read");
        } catch (e) {
          fail((e as Error).message);
        }
      }
      out.mcp = {
        strategy: "cli",
        add: mcp.add,
        remove: mcp.remove,
        read,
        ...(typeof mcp.bin === "string" ? { bin: mcp.bin } : {}),
        ...(isStrArr(mcp.add_url) ? { add_url: mcp.add_url } : {}),
      };
    } else {
      fail("mcp.strategy は file|cli");
    }
  }
  if (raw.skills != null) {
    if (!isObj(raw.skills) || typeof raw.skills.dir !== "string" || raw.skills.dir === "") fail("skills.dir が無い");
    out.skills = { dir: raw.skills.dir as string };
  } else {
    out.skills = null;
  }
  if (raw.instructions != null) {
    if (!isObj(raw.instructions)) fail("instructions は object | null");
    const ins = raw.instructions as Record<string, unknown>;
    if (typeof ins.file === "string") out.instructions = { file: ins.file };
    else if (typeof ins.dir === "string" && typeof ins.filename === "string") {
      out.instructions = { dir: ins.dir, filename: ins.filename };
    } else fail("instructions は {file} | {dir, filename}");
  } else {
    out.instructions = null;
  }
  if (raw.comments_preserved !== undefined) {
    if (typeof raw.comments_preserved !== "boolean") fail("comments_preserved は boolean");
    out.comments_preserved = raw.comments_preserved;
  }
  return out;
}
