import { existsSync, readFileSync, statSync } from "node:fs";
import { binDir } from "./binary.ts";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseNativeSpec, RESERVED_EXTENSION_NAMES, type NativeConfigLocation, type NativeSpec } from "@openroly/core";
import catalog from "@openroly/core/registry/detectors.v1.json" with { type: "json" };
import { AdapterError, type ExportedExtension } from "./contract.ts";
import { dropRedundantLocalCredentials, openrolyHome } from "./credentials.ts";
import { MCP_SERVER_ENTRY, MCP_SERVER_NAME } from "./install.ts";
import { deleteMcpFileEntry, expandTemplate, exportMcpFromConfig, normalizeMcpEntry, resolveNativePath, upsertMcpFileEntry } from "./native.ts";
import { localCatalogPath } from "./profiles.ts";

// 端末の skill / 規則の正本(PBI-0688)。runtime ごとの native.skills には書かない。
// 配り先は well-known の skills dir の親 home が既に居る時だけ symlink。config 形式は見ない。

const MARKER = ".openroly-managed";
const MAX_SKILL_FILE_BYTES = 128 * 1024;
const MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_WALK_ENTRIES = 2000;
const SKIP_WALK_DIRS = new Set(["node_modules", ".git", "dist", "target", "__pycache__"]);
const HUB_RULE_NAME = "common-rules";
const OPENROLY_BLOCK = /<!-- openroly:begin [\s\S]*?<!-- openroly:end .+ -->[ \t]*\n?/g;
const OPENROLY_LINE = /^[ \t]*<!-- openroly:.*-->[ \t]*$/gm;

type Env = Record<string, string | undefined>;

export function stripOpenrolyBlocks(text: string): string {
  return text.replace(OPENROLY_BLOCK, "").replace(OPENROLY_LINE, "").trim();
}

export function hubSkillsDir(env: Env = process.env): string {
  return join(openrolyHome(env), "skills");
}

export function hubRulesDir(env: Env = process.env): string {
  return join(openrolyHome(env), "rules");
}

function officialClaudePaths(env: Env): { json: string; skills: string } {
  const home = env.HOME ?? homedir();
  if (env.CLAUDE_CONFIG_DIR) {
    return { json: join(env.CLAUDE_CONFIG_DIR, ".claude.json"), skills: join(env.CLAUDE_CONFIG_DIR, "skills") };
  }
  return { json: join(home, ".claude.json"), skills: join(home, ".claude", "skills") };
}

function eachNative(env: Env): { id: string; spec: NativeSpec }[] {
  const out: { id: string; spec: NativeSpec }[] = [];
  const push = (id: string, raw: unknown) => {
    try {
      out.push({ id, spec: parseNativeSpec(raw, id) });
    } catch {
      // 壊れた native は配り先にしない
    }
  };
  for (const d of catalog.detectors as { id: string; native?: unknown }[]) {
    if (d.native != null) push(d.id, d.native);
  }
  try {
    const local = JSON.parse(readFileSync(localCatalogPath(env), "utf8")) as {
      entries?: { id: string; native?: unknown }[];
    };
    for (const e of local.entries ?? []) {
      if (e.native != null) push(e.id, e.native);
    }
  } catch {
    // catalog.local.json が無い / 壊れている
  }
  push("codex", {
    home: { env: "CODEX_HOME", default: "~/.codex" },
    mcp: {
      strategy: "file",
      path: "config.toml",
      format: "toml",
      key: "mcp_servers",
      shape: "map",
      entry: { command: "${command}", args: "${args}", env: "${env}" },
    },
    skills: { dir: "skills" },
    instructions: { file: "AGENTS.md" },
  });
  return out;
}

function namelessHomes(env: Env): { id: string; home: string }[] {
  const root = env.HOME ?? homedir();
  const known = new Set(eachNative(env).map((x) => x.id));
  const out: { id: string; home: string }[] = [];
  for (const d of catalog.detectors as { id: string; kind?: string; native?: unknown }[]) {
    if (d.kind === "local_model_server") continue;
    if (d.native != null || known.has(d.id)) continue;
    out.push({ id: d.id, home: join(root, `.${d.id}`) });
  }
  return out;
}

export function wellKnownSkillRoots(env: Env = process.env): string[] {
  const roots = new Set<string>([officialClaudePaths(env).skills]);
  for (const { spec } of eachNative(env)) {
    if (spec.skills?.dir) roots.add(resolveNativePath(spec.skills.dir, spec, env));
  }
  for (const { home } of namelessHomes(env)) roots.add(join(home, "skills"));
  return [...roots];
}

function wellKnownAgentHomes(env: Env): string[] {
  return [...new Set(wellKnownSkillRoots(env).map((r) => dirname(r)))];
}

function splitSkillMd(text: string): { description: string; instructions: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  try {
    const front = parseYaml(m[1]!);
    const description = (front as Record<string, unknown> | null)?.description;
    if (typeof description !== "string") return null;
    return { description, instructions: text.slice(m[0].length) };
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function readSkillFiles(skillDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let total = 0;
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SKIP_WALK_DIRS.has(entry.name)) continue;
      if (++visited > MAX_SKILL_WALK_ENTRIES) return;
      const full = join(dir, entry.name);
      const rel = relative(skillDir, full);
      if (rel === "SKILL.md") continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!st.isFile() || st.size > MAX_SKILL_FILE_BYTES) continue;
      if (total + st.size > MAX_SKILL_TOTAL_BYTES) return;
      const buf = Buffer.from(await readFile(full));
      const text = buf.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(buf)) continue;
      total += st.size;
      files[rel.split(sep).join("/")] = text;
    }
  };
  await walk(skillDir);
  return files;
}

export type HubSkill = {
  name: string;
  description: string;
  instructions: string;
  files?: Record<string, string>;
};

export async function writeHubSkill(name: string, spec: Omit<HubSkill, "name"> & { name?: string }, env: Env = process.env): Promise<void> {
  if (/[/\\]/.test(name) || name === "" || name.startsWith(".")) {
    throw new AdapterError(`hub skill "${name}": invalid name`);
  }
  const dir = join(hubSkillsDir(env), name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MARKER), "");
  const frontmatter = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(spec.description)}\n---\n`;
  await writeFile(join(dir, "SKILL.md"), frontmatter + spec.instructions);
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const path = resolve(dir, rel);
    if (!path.startsWith(dir + sep)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export async function listHubSkills(env: Env = process.env): Promise<{ name: string; description: string }[]> {
  const hub = hubSkillsDir(env);
  const names = await readdir(hub).catch(() => [] as string[]);
  const out: { name: string; description: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const md = await readFile(join(hub, name, "SKILL.md"), "utf8").catch(() => null);
    if (md == null) continue;
    const parsed = splitSkillMd(md) ?? { description: name, instructions: md };
    out.push({ name, description: parsed.description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function exportHubSkills(env: Env = process.env): Promise<ExportedExtension[]> {
  const out: ExportedExtension[] = [];
  for (const s of await listHubSkills(env)) {
    const full = await readHubSkill(s.name, env);
    if (!full) continue;
    out.push({
      kind: "skill",
      name: s.name,
      spec: {
        description: full.description,
        instructions: full.instructions,
        ...(full.files ? { files: full.files } : {}),
      },
      secretEnv: {},
    });
  }
  const rule = await readHubRule(HUB_RULE_NAME, env);
  if (rule) out.push({ kind: "instructions", name: HUB_RULE_NAME, spec: { content: rule }, secretEnv: {} });
  return out;
}

export async function readHubSkill(name: string, env: Env = process.env): Promise<HubSkill | null> {
  if (/[/\\]/.test(name)) return null;
  const dir = join(hubSkillsDir(env), name);
  const md = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (md == null) return null;
  const parsed = splitSkillMd(md) ?? { description: name, instructions: md };
  const files = await readSkillFiles(dir);
  return {
    name,
    description: parsed.description,
    instructions: parsed.instructions,
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
}

export async function writeHubRule(name: string, content: string, env: Env = process.env): Promise<void> {
  if (/[/\\]/.test(name) || name === "") throw new AdapterError(`hub rule "${name}": invalid name`);
  const dir = hubRulesDir(env);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  const prev = await readFile(path, "utf8").catch(() => null);
  if (prev === content) return;
  await writeFile(path, content);
}

export async function readHubRule(name: string, env: Env = process.env): Promise<string | null> {
  if (/[/\\]/.test(name)) return null;
  return readFile(join(hubRulesDir(env), `${name}.md`), "utf8").catch(() => null);
}

async function ingestRoot(root: string, env: Env): Promise<number> {
  let n = 0;
  const listing = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of listing) {
    const skillDir = join(root, entry.name);
    const st = await stat(skillDir).catch(() => null);
    if (!st?.isDirectory()) continue;
    if (await exists(join(skillDir, MARKER))) continue;
    const md = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => null);
    if (md == null) continue;
    const parsed = splitSkillMd(md) ?? { description: entry.name, instructions: md };
    const files = await readSkillFiles(skillDir);
    await writeHubSkill(entry.name, { description: parsed.description, instructions: parsed.instructions, files }, env);
    n++;
  }
  return n;
}

export type HubMcp = {
  url?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

function hubMcpPath(env: Env): string {
  return join(openrolyHome(env), "mcp-servers.json");
}

function isReservedMcp(name: string): boolean {
  return name === MCP_SERVER_NAME || (RESERVED_EXTENSION_NAMES as readonly string[]).includes(name);
}

function isShadowOpenroly(spec: { command?: string; args?: string[] }): boolean {
  if (spec.command === "openroly-mcp" || spec.command?.endsWith("/openroly-mcp")) return true;
  return (spec.args ?? []).some((a) => /mcp\/src\/server\.ts$/.test(a) || /openroly-mcp$/.test(a));
}

type McpSink = {
  loc: NativeConfigLocation;
  path: string;
  createIfParent: boolean;
  runtimeKind: string;
  stdioEntry?: Record<string, unknown>;
};

export function wellKnownMcpSinks(env: Env = process.env): McpSink[] {
  const claude = officialClaudePaths(env).json;
  const sinks: McpSink[] = [
    {
      loc: { path: claude, format: "json", key: "mcpServers", shape: "map" },
      path: claude,
      createIfParent: false,
      runtimeKind: "claude",
    },
  ];
  for (const { id, spec } of eachNative(env)) {
    const mcp = spec.mcp;
    if (!mcp) continue;
    const loc = mcp.strategy === "file" ? mcp : mcp.read;
    if (!loc) continue;
    const path = resolveNativePath(loc.path, spec, env);
    sinks.push({
      loc,
      path,
      createIfParent: loc.format === "toml" || loc.format === "yaml",
      runtimeKind: id,
      stdioEntry: mcp.strategy === "file" ? mcp.entry : undefined,
    });
  }
  for (const { id, home } of namelessHomes(env)) {
    const json = join(home, "mcp.json");
    if (existsSync(json)) {
      sinks.push({
        loc: { path: json, format: "json", key: "mcpServers", shape: "map" },
        path: json,
        createIfParent: false,
        runtimeKind: id,
      });
    }
    const toml = join(home, "config.toml");
    if (existsSync(toml)) {
      sinks.push({
        loc: { path: toml, format: "toml", key: "mcp_servers", shape: "map" },
        path: toml,
        createIfParent: true,
        runtimeKind: id,
      });
    }
  }
  const seen = new Set<string>();
  return sinks.filter((s) => {
    if (seen.has(s.path)) return false;
    seen.add(s.path);
    return true;
  });
}

async function loadHubMcps(env: Env): Promise<Record<string, HubMcp>> {
  const raw = await readFile(hubMcpPath(env), "utf8").catch(() => "");
  if (!raw) return {};
  try {
    const doc = JSON.parse(raw) as { servers?: Record<string, HubMcp> };
    return doc.servers && typeof doc.servers === "object" ? doc.servers : {};
  } catch {
    return {};
  }
}

export async function writeHubMcp(name: string, spec: HubMcp, env: Env = process.env): Promise<void> {
  if (isReservedMcp(name) || /[/\\]/.test(name) || name === "") {
    throw new AdapterError(`hub mcp "${name}": invalid or reserved name`);
  }
  const servers = await loadHubMcps(env);
  servers[name] = spec;
  const path = hubMcpPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, servers }, null, 2) + "\n");
  await chmod(path, 0o600);
}

export async function listHubMcps(
  env: Env = process.env,
): Promise<{ name: string; url?: string; transport?: string; command?: string; args?: string[] }[]> {
  const servers = await loadHubMcps(env);
  return Object.entries(servers)
    .map(([name, spec]) => ({
      name,
      ...(spec.url ? { url: spec.url, transport: spec.transport } : { command: spec.command, args: spec.args }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function destWire(spec: HubMcp, sink: McpSink, name: string): Record<string, unknown> {
  const jsonLike = sink.loc.format === "json" || sink.loc.format === "jsonc" || sink.loc.format === "json5";
  if (spec.url) {
    return jsonLike ? { type: spec.transport ?? "http", url: spec.url } : { url: spec.url, enabled: true };
  }
  if (sink.stdioEntry) {
    return expandTemplate(sink.stdioEntry, {
      name,
      command: spec.command ?? "",
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}),
      url: spec.url,
    }) as Record<string, unknown>;
  }
  const wire: Record<string, unknown> = { command: spec.command, args: spec.args ?? [] };
  if (spec.env && Object.keys(spec.env).length > 0) wire.env = spec.env;
  if (sink.loc.format === "toml" || sink.loc.format === "yaml") wire.enabled = true;
  return wire;
}

async function mergeMcpSink(sink: McpSink, name: string, spec: HubMcp, allowReserved = false): Promise<"ok" | "skip" | "fail"> {
  if (isReservedMcp(name) && !allowReserved) return "skip";
  const parent = dirname(sink.path);
  const fileExists = await exists(sink.path);
  if (!fileExists) {
    if (!sink.createIfParent || !(await exists(parent))) return "skip";
  }
  try {
    await upsertMcpFileEntry(sink.loc, sink.path, name, destWire(spec, sink, name));
    return "ok";
  } catch {
    return "fail";
  }
}

async function ingestMcpSinks(env: Env): Promise<number> {
  let n = 0;
  for (const sink of wellKnownMcpSinks(env)) {
    if (!(await exists(sink.path))) continue;
    const items = await exportMcpFromConfig(sink.loc, sink.path);
    for (const item of items) {
      const entry = normalizeMcpEntry({
        ...item.spec,
        env: item.secretEnv,
      });
      if (!entry) continue;
      if (isReservedMcp(item.name) || isShadowOpenroly(entry)) continue;
      await writeHubMcp(item.name, {
        ...(entry.url ? { url: entry.url, transport: entry.transport } : { command: entry.command, args: entry.args }),
        env: Object.keys(entry.env).length > 0 ? entry.env : undefined,
      }, env);
      n++;
    }
  }
  return n;
}

async function applyHubMcps(env: Env): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const servers = await loadHubMcps(env);
  for (const [name, spec] of Object.entries(servers)) {
    if (isShadowOpenroly(spec)) continue;
    for (const sink of wellKnownMcpSinks(env)) {
      const r = await mergeMcpSink(sink, name, spec);
      if (r === "ok") applied.push(`${sink.path}:${name}`);
      else if (r === "fail") skipped.push(`${sink.path}:${name}`);
    }
  }
  return { applied, skipped };
}

const COMPILED_MCP_MIN_BYTES = 10_000;

function isCompiledMcp(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > COMPILED_MCP_MIN_BYTES;
  } catch {
    return false;
  }
}

function shouldCompileMcp(env: Env): boolean {
  return env.OPENROLY_MCP_COMPILE === "1";
}

async function tryCompileMcp(dest: string): Promise<void> {
  if (!existsSync(MCP_SERVER_ENTRY)) return;
  await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
  const tmp = `${dest}.tmp`;
  await rm(tmp, { force: true }).catch(() => null);
  const proc = Bun.spawn([process.execPath, "build", MCP_SERVER_ENTRY, "--compile", "--outfile", tmp], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await proc.exited;
  if (!isCompiledMcp(tmp)) {
    await rm(tmp, { force: true }).catch(() => null);
    return;
  }
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
}

async function ensureMcpLaunch(env: Env): Promise<{ command: string; args: string[] }> {
  const compiled = join(binDir(env), "openroly-mcp");
  if (shouldCompileMcp(env)) {
    await tryCompileMcp(compiled);
    if (isCompiledMcp(compiled)) return { command: compiled, args: [] };
  }
  if (existsSync(MCP_SERVER_ENTRY)) {
    const compiledStale =
      !isCompiledMcp(compiled) || statSync(MCP_SERVER_ENTRY).mtimeMs > statSync(compiled).mtimeMs;
    if (compiledStale) return { command: process.execPath, args: [MCP_SERVER_ENTRY] };
  }
  if (isCompiledMcp(compiled)) return { command: compiled, args: [] };
  const bun = process.execPath;
  const dest = join(env.HOME ?? homedir(), ".local", "bin", "openroly-mcp");
  await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
  const shim = `#!/bin/sh\nexec ${JSON.stringify(bun)} ${JSON.stringify(MCP_SERVER_ENTRY)}\n`;
  await writeFile(dest, shim, { mode: 0o755 });
  await chmod(dest, 0o755);
  return { command: dest, args: [] };
}

export async function applyOpenRolyMcp(env: Env = process.env): Promise<string[]> {
  const attached: string[] = [];
  const launch = await ensureMcpLaunch(env);
  for (const sink of wellKnownMcpSinks(env)) {
    const r = await mergeMcpSink(
      sink,
      MCP_SERVER_NAME,
      { command: launch.command, args: launch.args, env: { OPENROLY_RUNTIME_KIND: sink.runtimeKind } },
      true,
    );
    if (r === "ok") attached.push(`${sink.path}:${sink.runtimeKind}`);
    const items = await exportMcpFromConfig(sink.loc, sink.path).catch(() => []);
    for (const item of items) {
      if (item.name === MCP_SERVER_NAME) continue;
      const entry = normalizeMcpEntry({ ...item.spec, env: item.secretEnv });
      if (entry && isShadowOpenroly(entry)) {
        await deleteMcpFileEntry(sink.loc, sink.path, item.name).catch(() => null);
      }
    }
  }
  return attached;
}

export type LinkResult = {
  ingested: number;
  linked: string[];
  skipped: string[];
  removed?: string[];
  mcpApplied?: string[];
  openrolyAttached?: string[];
};

async function sweepDanglingSkillLinks(root: string): Promise<string[]> {
  const removed: string[] = [];
  const listing = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of listing) {
    const dest = join(root, entry.name);
    const st = await lstat(dest).catch(() => null);
    if (!st?.isSymbolicLink()) continue;
    if (await exists(dest)) continue;
    await rm(dest);
    removed.push(dest);
  }
  return removed;
}

export async function ingestAndLink(env: Env = process.env): Promise<LinkResult> {
  let ingested = 0;
  for (const root of wellKnownSkillRoots(env)) {
    ingested += await ingestRoot(root, env);
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
  const claudeMd = await readFile(join(claudeDir, "CLAUDE.md"), "utf8").catch(() => null);
  if (claudeMd != null) {
    const content = stripOpenrolyBlocks(claudeMd);
    if (content !== "") await writeHubRule(HUB_RULE_NAME, content, env);
  }
  await ingestMcpSinks(env);
  const mcp = await applyHubMcps(env);
  const linked: string[] = [];
  const skipped: string[] = [...mcp.skipped];
  const removed: string[] = [];
  const hub = hubSkillsDir(env);
  const names = (await readdir(hub).catch(() => [])).filter((n) => !n.startsWith("."));
  for (const home of wellKnownAgentHomes(env)) {
    if (!(await exists(home))) continue;
    const root = join(home, "skills");
    await mkdir(root, { recursive: true });
    for (const name of names) {
      const target = join(hub, name);
      const dest = join(root, name);
      const st = await lstat(dest).catch(() => null);
      if (st?.isSymbolicLink()) {
        await rm(dest);
      } else if (st) {
        if (!(await exists(join(dest, MARKER)))) {
          skipped.push(`${root}/${name}`);
          continue;
        }
        await rm(dest, { recursive: true, force: true });
      }
      await symlink(target, dest);
      linked.push(`${root}/${name}`);
    }
    removed.push(...(await sweepDanglingSkillLinks(root)));
  }
  const rule = await readHubRule(HUB_RULE_NAME, env);
  if (rule != null) {
    for (const { spec } of eachNative(env)) {
      const ins = spec.instructions;
      if (!ins || !("dir" in ins)) continue;
      const dir = resolveNativePath(ins.dir, spec, env);
      if (!(await exists(dirname(dir))) && !(await exists(dir))) continue;
      await mkdir(dir, { recursive: true });
      const dest = join(dir, ins.filename.replaceAll("${name}", HUB_RULE_NAME));
      const st = await lstat(dest).catch(() => null);
      if (st?.isSymbolicLink()) await rm(dest);
      else if (st) {
        const existing = await readFile(dest, "utf8").catch(() => null);
        if (existing !== rule && stripOpenrolyBlocks(existing ?? "") !== stripOpenrolyBlocks(rule)) {
          skipped.push(dest);
        } else {
          await rm(dest);
          await symlink(join(hubRulesDir(env), `${HUB_RULE_NAME}.md`), dest);
          linked.push(dest);
        }
      } else {
        await symlink(join(hubRulesDir(env), `${HUB_RULE_NAME}.md`), dest);
        linked.push(dest);
      }
      const stale = join(dir, ins.filename.replaceAll("${name}", "claude-rules"));
      if (stale !== dest) {
        const prev = await readFile(stale, "utf8").catch(() => null);
        if (prev != null && stripOpenrolyBlocks(prev) === stripOpenrolyBlocks(rule)) await rm(stale);
      }
    }
  }
  const openrolyAttached = await applyOpenRolyMcp(env);
  await dropRedundantLocalCredentials(env).catch(() => []);
  return { ingested, linked, skipped, removed, mcpApplied: mcp.applied, openrolyAttached };
}
