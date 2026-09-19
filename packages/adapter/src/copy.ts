import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionKind } from "@openroly/core";
import type { AdapterContext, ExportedExtension, ExtensionAdapter } from "./contract.ts";
import { ingestAndLink, stripOpenrolyBlocks, writeHubMcp, writeHubRule, writeHubSkill } from "./hub.ts";

// 端末の中で runtime A の extension を runtime B へ写す(PBI-0678)。
// Account の提案 / web Approve / auto_share を通さない —— 同じ機械の 2 adapter の
// exportExtensions → applyExtension だけ。秘密は secretEnv のまま dest に渡す。

export interface CopyItem {
  action: "install";
  kind: ExtensionKind;
  name: string;
}

export interface CopyResult {
  plan: CopyItem[];
  applied: CopyItem[];
  failed: { name: string; detail: string }[];
}

export { stripOpenrolyBlocks } from "./hub.ts";

async function extraFromSource(from: ExtensionAdapter, ctx: AdapterContext): Promise<ExportedExtension[]> {
  if (from.id !== "claude") return [];
  const dir = ctx.env.CLAUDE_CONFIG_DIR ?? join(ctx.env.HOME ?? homedir(), ".claude");
  const text = await readFile(join(dir, "CLAUDE.md"), "utf8").catch(() => null);
  if (text == null) return [];
  const content = stripOpenrolyBlocks(text);
  if (content === "") return [];
  return [{ kind: "instructions", name: "common-rules", spec: { content }, secretEnv: {} }];
}

export async function copyExtensions(options: {
  from: ExtensionAdapter;
  to: ExtensionAdapter | null;
  ctx: AdapterContext;
  dryRun?: boolean;
}): Promise<CopyResult> {
  const items = [
    ...(await options.from.exportExtensions(options.ctx)),
    ...(await extraFromSource(options.from, options.ctx)),
  ];
  const supported = new Set(options.to?.extensionKinds ?? []);
  const plan: CopyItem[] = [];
  const byKey = new Map<string, ExportedExtension>();
  for (const item of items) {
    const viaHub = item.kind === "skill" || item.kind === "instructions" || item.kind === "mcp";
    if (!viaHub && !supported.has(item.kind)) continue;
    const key = `${item.kind}:${item.name}`;
    if (byKey.has(key)) continue;
    byKey.set(key, item);
    plan.push({ action: "install", kind: item.kind, name: item.name });
  }
  if (options.dryRun) return { plan, applied: [], failed: [] };

  const applied: CopyItem[] = [];
  const failed: { name: string; detail: string }[] = [];
  for (const p of plan) {
    const item = byKey.get(`${p.kind}:${p.name}`);
    if (!item) continue;
    try {
      if (item.kind === "skill") {
        const description = typeof item.spec.description === "string" ? item.spec.description : item.name;
        const instructions = typeof item.spec.instructions === "string" ? item.spec.instructions : "";
        const files =
          item.spec.files != null && typeof item.spec.files === "object" && !Array.isArray(item.spec.files)
            ? (item.spec.files as Record<string, string>)
            : undefined;
        await writeHubSkill(item.name, { description, instructions, files }, options.ctx.env);
      } else if (item.kind === "instructions") {
        const content = typeof item.spec.content === "string" ? item.spec.content : "";
        await writeHubRule(item.name, content, options.ctx.env);
      } else if (item.kind === "mcp") {
        const url = typeof item.spec.url === "string" ? item.spec.url : undefined;
        await writeHubMcp(
          item.name,
          url
            ? { url, transport: typeof item.spec.transport === "string" ? item.spec.transport : "http", env: item.secretEnv }
            : {
                command: typeof item.spec.command === "string" ? item.spec.command : "",
                args: Array.isArray(item.spec.args) ? item.spec.args.map(String) : [],
                env: item.secretEnv,
              },
          options.ctx.env,
        );
      } else if (!options.to) {
        throw new Error(`no adapter to install ${item.kind} "${item.name}"`);
      } else {
        await options.to.applyExtension(options.ctx, {
          action: "install",
          name: item.name,
          kind: item.kind,
          spec: item.spec,
          env: item.secretEnv,
        });
      }
      applied.push(p);
    } catch (e) {
      failed.push({ name: item.name, detail: (e as Error).message });
    }
  }
  await ingestAndLink(options.ctx.env).catch(() => null);
  return { plan, applied, failed };
}
