import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAccountTools, type OpenRolyClientConfig } from "./tools.ts";

const DEFAULT_TOOLS_SRC = fileURLToPath(new URL("./tools.ts", import.meta.url));

export type AccountTools = ReturnType<typeof createAccountTools>;

async function loadFromSource(sourcePath: string, config: OpenRolyClientConfig): Promise<AccountTools> {
  const trans = await Bun.build({
    entrypoints: [sourcePath],
    target: "bun",
    format: "esm",
  });
  if (!trans.success || trans.outputs[0] == null) {
    throw new Error("tools source build failed");
  }
  const js = await trans.outputs[0].text();
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  try {
    const mod = (await import(url)) as { createAccountTools: typeof createAccountTools };
    return mod.createAccountTools(config);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** tools.ts の mtime が変わったら作り直す。Bun は import query を cache-bust しないので Blob URL で読む。 */
export function createLiveAccountTools(
  config: OpenRolyClientConfig,
  sourcePath: string = DEFAULT_TOOLS_SRC,
): { current: () => AccountTools; refresh: () => Promise<AccountTools> } {
  let impl = createAccountTools(config);
  let seen = 0;
  const eager = sourcePath !== DEFAULT_TOOLS_SRC;
  return {
    current: () => impl,
    refresh: async () => {
      try {
        const m = statSync(sourcePath).mtimeMs;
        if (seen === 0 && !eager) {
          seen = m;
          return impl;
        }
        if (m !== seen) {
          impl = await loadFromSource(sourcePath, config);
          seen = m;
        }
      } catch {
        // compiled / 読めない source = 起動時の impl
      }
      return impl;
    },
  };
}
