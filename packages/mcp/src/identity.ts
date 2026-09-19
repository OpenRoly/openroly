import { loadCredentials, type RuntimeCredential } from "@openroly/adapter";

// MCP 起動時の「誰として話すか」(PBI-0685)。runtime の config 形式は見ない。
// kind は env、無ければ親 process の comm。credential は kind と local-<kind> を同じ機械の別名として探す。

export function kindFromParentComm(comm: string): string | undefined {
  const base = comm.trim().split(/[/\\]/).pop()?.replace(/^-/, "").replace(/\.exe$/i, "") ?? "";
  if (!base) return undefined;
  const id = base.toLowerCase();
  if (id === "bun" || id === "node" || id === "npm" || id === "sh" || id === "zsh" || id === "bash") return undefined;
  return id;
}

export function parentComm(env: Record<string, string | undefined> = process.env): string {
  if (env.OPENROLY_PARENT_COMM) return env.OPENROLY_PARENT_COMM;
  try {
    const r = Bun.spawnSync(["ps", "-p", String(process.ppid), "-o", "comm="], { stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString();
  } catch {
    return "";
  }
}

export async function resolveMcpIdentity(
  env: Record<string, string | undefined> = process.env,
): Promise<{ kind: string; credential: RuntimeCredential } | undefined> {
  const hinted = env.OPENROLY_RUNTIME_KIND?.trim();
  const inferred = hinted || kindFromParentComm(parentComm(env));
  if (!inferred) return undefined;
  const candidates = inferred.startsWith("local-")
    ? [inferred, inferred.slice("local-".length)]
    : [inferred, `local-${inferred}`];
  const stored = (await loadCredentials(env)).runtimes;
  for (const kind of candidates) {
    if (!kind) continue;
    // 保存されている key をそのまま名乗る（PBI-0685 AC-3）。getCredential の別名は一覧用。
    const credential = stored[kind];
    if (credential) return { kind, credential };
  }
  return undefined;
}
