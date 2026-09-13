import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseNativeSpec, type NativeFormat, type NativeSpec } from "@openroly/core";
import { openrolyHome, withFileLock, writeFileAtomic } from "./credentials.ts";

// runtime profile(PBI-0211)= **同じ binary の provider 差し替え**(`claude-zai()` のような shell 関数)を
// Your AI の 1 行にする。端末の `profiles.json` が正本で、account には置かない(値も参照も)。
//
//   rc の関数 → class 判定(catalog の `adapter: "variant"` entry の `variant.match` と `*_BASE_URL` の host)
//            → profiles.json(秘密は値を捨て、class の provider があれば `connection:<provider>` の参照だけ)
//   broker scan が親の Found に重ねて `Found{id: class, source: "profile"}` を出す(broker/src/profiles.rs)
//   wake は `openroly run <class> -- <親の argv>` が参照を解決して親 binary を起こす
//
// あわせて catalog に無い agent を user が足す `catalog.local.json`(id `local-<name>`)もここに置く。

type Env = Record<string, string | undefined>;

export const VARIANT_ADAPTER = "variant";
export const LOCAL_RUNTIME_PREFIX = "local-";

/** catalog の class entry(`adapter: "variant"`)から読む分 */
export interface VariantClass {
  id: string;
  displayName: string;
  /** 親 runtime(同じ binary) */
  of: string;
  /** `*_BASE_URL` の host がこれに当たれば、この class */
  match: string[];
  /** 秘密 var を解決する Connections の provider。無い class は鍵を持たない(localhost proxy) */
  provider?: string;
}

export interface RuntimeProfile {
  /** 取り込んだ関数名(同じ関数の再 import は上書き = 冪等。別の関数が同じ class に当たれば拒否) */
  name: string;
  env: Record<string, string>;
  /** VAR → `connection:<provider>`。**値は持たない** */
  secret_env: Record<string, string>;
}

export interface ProfilesFile {
  version: 1;
  profiles: Record<string, RuntimeProfile>;
}

export const profilesPath = (env: Env = process.env): string => join(openrolyHome(env), "profiles.json");
export const localCatalogPath = (env: Env = process.env): string => join(openrolyHome(env), "catalog.local.json");

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** bundled / 署名済み catalog の detectors から class entry を拾う(形の壊れた entry は捨てる) */
export function variantClasses(detectors: unknown[]): VariantClass[] {
  return detectors.flatMap((d) => {
    if (!isObj(d) || d.adapter !== VARIANT_ADAPTER || typeof d.id !== "string" || !isObj(d.variant)) return [];
    const v = d.variant;
    if (typeof v.of !== "string" || !Array.isArray(v.match)) return [];
    return [{
      id: d.id,
      displayName: typeof d.display_name === "string" ? d.display_name : d.id,
      of: v.of,
      match: v.match.filter((m): m is string => typeof m === "string"),
      ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
    }];
  });
}

/** 秘密として扱う var 名。値は file にも stdout にも出さない */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
/** 鍵を中に運べる var(`ANTHROPIC_CUSTOM_HEADERS` 等)。値を捨てるが、Connections の鍵を生で差す先にもしない */
const SENSITIVE_NAME = /HEADER|CREDENTIAL|COOKIE|AUTH/i;

export interface ImportResult {
  imported: { name: string; class: string }[];
  skipped: { name: string; reason: string }[];
  /** 値を採らなかった var(名前だけ) */
  dropped: { name: string; vars: string[] }[];
}

interface ShellCall {
  name: string;
  parent: string;
  /** 親を呼ぶ行の先頭に並ぶ `VAR=value`(引用符は剥がす前の生の形) */
  assigns: { name: string; raw: string }[];
}

/**
 * rc の中の関数のうち、本体で `claude "$@"`(`command` / `exec` 前置可)を呼ぶ物を拾う。
 * 見るのは **親を呼ぶ行の先頭の env 前置**だけ(`\` 継続は 1 行に畳む)—— 本体の他の行
 * (`grep -E '^ZHIPU_API_KEY=' …` のような鍵の読み出し)を var と読まない。
 */
export function parseShellCalls(rc: string, parents: string[]): ShellCall[] {
  const out: ShellCall[] = [];
  const lines = rc.split("\n");
  const call = new RegExp(`(?:^|\\s)(?:command\\s+|exec\\s+)?(${parents.map((p) => p.replace(/[^\w-]/g, "")).join("|")})\\s+"\\$@"`);
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{\s*$/.exec(lines[i]!);
    if (!head) continue;
    let end = i + 1;
    while (end < lines.length && !/^\}\s*$/.test(lines[end]!)) end++;
    const body = lines.slice(i + 1, end).join("\n").replace(/\\\n/g, " ");
    i = end;
    for (const line of body.split("\n")) {
      const m = call.exec(line);
      if (!m) continue;
      const assigns: { name: string; raw: string }[] = [];
      let rest = line.slice(0, m.index);
      for (;;) {
        const a = /^\s*([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']*)/.exec(rest);
        if (!a) break;
        assigns.push({ name: a[1]!, raw: a[2]! });
        rest = rest.slice(a[0].length);
      }
      out.push({ name: head[1]!, parent: m[1]!, assigns });
      break;
    }
  }
  return out;
}

/** 非秘密値を literal にする。`${NAME:-default}` は default。他の `$` 展開は採らない(undefined) */
function literal(raw: string): string | undefined {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  const v = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  const dflt = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}$`]*)\}$/.exec(v);
  if (dflt) return dflt[1];
  return /[$`]/.test(v) ? undefined : v;
}

/** URL の host。userinfo(`user:key@`)を持つ URL は採らない(鍵を file に落とさない) */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.username || u.password ? undefined : u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 1 関数 → profile(class が決まらなければ skip 理由) */
export function profileFromCall(
  c: ShellCall,
  classes: VariantClass[],
): { class: string; profile: RuntimeProfile; dropped: string[] } | { skip: string } {
  const baseUrl = c.assigns.find((a) => a.name.endsWith("_BASE_URL") && !SECRET_NAME.test(a.name));
  const url = baseUrl ? literal(baseUrl.raw) : undefined;
  const host = url ? hostOf(url) : undefined;
  if (!host) return { skip: "no literal *_BASE_URL" };
  const cls = classes.find((k) => k.of === c.parent && k.match.includes(host));
  if (!cls) return { skip: `no runtime class for ${c.parent} at ${host}` };
  const env: Record<string, string> = {};
  const secret_env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const a of c.assigns) {
    if (SECRET_NAME.test(a.name)) {
      if (cls.provider) secret_env[a.name] = `connection:${cls.provider}`;
      else dropped.push(a.name);
      continue;
    }
    const v = literal(a.raw);
    if (v === undefined || SENSITIVE_NAME.test(a.name) || (a.name.endsWith("_BASE_URL") && !hostOf(v))) dropped.push(a.name);
    else env[a.name] = v;
  }
  return { class: cls.id, profile: { name: c.name, env, secret_env }, dropped };
}

/**
 * `openroly run` が鍵を解決する前の門(PBI-0211 review)。broker の egress allowlist は profile の base URL の host に
 * 追随する(profiles::wake_hosts)ので、書き換えた profile で鍵 —— provider の無い class では claude 自身の認証 ——
 * を class の外の host へ運ばせないのはここだけ。文言に URL の値は出さない(userinfo に鍵が在りうる)
 */
export function profileProblem(profile: RuntimeProfile, cls: VariantClass): string | undefined {
  const urls = Object.entries(profile.env).filter(([k]) => k.endsWith("_BASE_URL"));
  if (urls.length === 0) return `profile_host_mismatch: ${cls.id} has no *_BASE_URL`;
  for (const [k, v] of urls) {
    const host = hostOf(v);
    if (!host || !cls.match.includes(host)) return `profile_host_mismatch: ${k} is not ${cls.match.join(" / ")}`;
  }
  if (cls.provider && Object.keys(profile.secret_env).length === 0) {
    return `profile_incomplete: ${cls.id} needs a key from connection:${cls.provider}`;
  }
  return undefined;
}

/**
 * profiles.json を読む。無ければ空。**壊れていれば throw**(空として扱うと import が既存を上書きで消す)
 */
export async function loadProfiles(env: Env = process.env): Promise<ProfilesFile> {
  let text: string;
  try {
    text = await readFile(profilesPath(env), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`profiles file is not valid JSON: ${profilesPath(env)}`);
  }
  if (!isObj(parsed) || parsed.version !== 1 || !isObj(parsed.profiles)) {
    throw new Error(`unsupported profiles file: ${profilesPath(env)}`);
  }
  return parsed as unknown as ProfilesFile;
}

async function updateJsonFile<T>(path: string, load: () => Promise<T>, fn: (cur: T) => T | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withFileLock(path, async () => {
    const next = fn(await load());
    if (next !== undefined) await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  });
}

/** rc の本文から取り込む。同じ関数の再 import は上書き、別の関数が同じ class に当たれば skip */
export async function importShellProfiles(rc: string, classes: VariantClass[], env: Env = process.env): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], dropped: [] };
  const parents = [...new Set(classes.map((k) => k.of))];
  if (parents.length === 0) return result;
  const calls = parseShellCalls(rc, parents);
  await updateJsonFile(profilesPath(env), () => loadProfiles(env), (file) => {
    let changed = false;
    for (const c of calls) {
      const p = profileFromCall(c, classes);
      if ("skip" in p) {
        result.skipped.push({ name: c.name, reason: p.skip });
        continue;
      }
      const cur = file.profiles[p.class];
      if (cur && cur.name !== c.name) {
        result.skipped.push({ name: c.name, reason: `${p.class} is already taken by ${cur.name} (one profile per class on this machine)` });
        continue;
      }
      file.profiles[p.class] = p.profile;
      changed = true;
      result.imported.push({ name: c.name, class: p.class });
      if (p.dropped.length > 0) result.dropped.push({ name: c.name, vars: p.dropped });
    }
    return changed ? file : undefined;
  });
  return result;
}

export async function removeProfile(cls: string, env: Env = process.env): Promise<boolean> {
  let removed = false;
  await updateJsonFile(profilesPath(env), () => loadProfiles(env), (file) => {
    if (!(cls in file.profiles)) return undefined;
    delete file.profiles[cls];
    removed = true;
    return file;
  });
  return removed;
}

// ---------- local catalog(`openroly runtimes add`) ----------

export interface LocalRuntimeEntry {
  id: string;
  display_name: string;
  detect: { binaries: string[] };
  native: NativeSpec;
}

interface LocalCatalogFile {
  version: 1;
  entries: LocalRuntimeEntry[];
}

async function loadLocalCatalog(env: Env): Promise<LocalCatalogFile> {
  let text: string;
  try {
    text = await readFile(localCatalogPath(env), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw e;
  }
  const parsed = JSON.parse(text) as LocalCatalogFile;
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`unsupported local catalog: ${localCatalogPath(env)}`);
  }
  return parsed;
}

export interface LocalRuntimeInput {
  name: string;
  binary: string;
  mcpFile: string;
  format: string;
  key: string;
}

/** `local-<name>` を足す(同じ name は置き換え)。native は generic adapter と同じ検証を通す */
export async function addLocalRuntime(input: LocalRuntimeInput, env: Env = process.env): Promise<LocalRuntimeEntry> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(input.name)) {
    throw new Error(`runtime name must be lowercase letters, digits and '-': ${input.name}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input.binary)) throw new Error(`--binary must be a command name: ${input.binary}`);
  const id = `${LOCAL_RUNTIME_PREFIX}${input.name}`;
  const native = parseNativeSpec({
    bin: input.binary,
    mcp: {
      strategy: "file",
      path: input.mcpFile,
      format: input.format as NativeFormat,
      key: input.key,
      shape: "map",
      entry: { command: "${command}", args: "${args}", env: "${env}" },
    },
  }, id);
  const entry: LocalRuntimeEntry = { id, display_name: input.name, detect: { binaries: [input.binary] }, native };
  await updateJsonFile(localCatalogPath(env), () => loadLocalCatalog(env), (file) => ({
    version: 1 as const,
    entries: [...file.entries.filter((e) => e.id !== id), entry],
  }));
  return entry;
}
