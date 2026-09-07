import type { AdapterContext } from "@openroly/adapter";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { codexAdapter } from "../src/index.ts";

// code review で見つかったバグの回帰検査(claude adapter と同種): applyExtension の
// disable/uninstall が `codex mcp remove` の結果を見ずに握り潰していた。
// config ロック等の本当の失敗まで成功扱いになると、uninstall では server 側の
// materialization purge が誤って走ってしまう(desired 行が消える)。

async function makeCtx(opts: {
  configServers: string; // mcp_servers テーブルの TOML 断片(空文字なら未登録)
  removeExitCode: number;
}): Promise<AdapterContext> {
  const home = await mkdtemp(join(tmpdir(), "openroly-codex-adapter-"));
  const codexDir = join(home, ".codex");
  const binDir = join(home, "bin");
  await mkdir(codexDir, { recursive: true });
  await mkdir(binDir);
  await writeFile(join(codexDir, "config.toml"), opts.configServers);
  const script = `#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then exit ${opts.removeExitCode}; fi\nexit 0\n`;
  const bin = join(binDir, "codex");
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { env: { HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` } };
}

describe("codexAdapter.applyExtension — disable/uninstall(result を握り潰さない)", () => {
  test("native に有って remove が本当に失敗したら throw する", async () => {
    const ctx = await makeCtx({
      configServers: '[mcp_servers.github]\ncommand = "npx"\n',
      removeExitCode: 1,
    });
    await expect(
      codexAdapter.applyExtension(ctx, { action: "uninstall", name: "github" }),
    ).rejects.toThrow(/codex mcp remove failed/);
  });

  test("native に有って remove が成功したら throw しない", async () => {
    const ctx = await makeCtx({
      configServers: '[mcp_servers.github]\ncommand = "npx"\n',
      removeExitCode: 0,
    });
    await expect(
      codexAdapter.applyExtension(ctx, { action: "uninstall", name: "github" }),
    ).resolves.toBeUndefined();
  });

  test("native に既に無い名前は remove を呼ばずに成功扱い(冪等)", async () => {
    const ctx = await makeCtx({ configServers: "", removeExitCode: 1 });
    await expect(
      codexAdapter.applyExtension(ctx, { action: "uninstall", name: "not-there" }),
    ).resolves.toBeUndefined();
  });

  test("disable も同じ規約(native に有って失敗すれば throw)", async () => {
    const ctx = await makeCtx({
      configServers: '[mcp_servers.github]\ncommand = "npx"\n',
      removeExitCode: 1,
    });
    await expect(
      codexAdapter.applyExtension(ctx, { action: "disable", name: "github" }),
    ).rejects.toThrow(/codex mcp remove failed/);
  });
});
