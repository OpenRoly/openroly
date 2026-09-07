import type { AdapterContext } from "@openroly/adapter";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { claudeAdapter } from "../src/index.ts";

// code review で見つかったバグの回帰検査: applyExtension の disable/uninstall は
// `claude mcp remove` の結果を見ずに握り潰していた(既に無い場合も real failure も
// 同じ非ゼロ終了を返すため — 実測: `claude mcp remove` で未登録名を指定すると exit 1)。
// これだと config ロック等の本当の失敗まで成功扱いになり、uninstall では
// server 側の materialization purge が誤って走ってしまう(desired 行が消える)。

async function makeCtx(opts: {
  configServers: Record<string, unknown>;
  removeExitCode: number;
}): Promise<AdapterContext> {
  const home = await mkdtemp(join(tmpdir(), "openroly-claude-adapter-"));
  const binDir = join(home, "bin");
  await mkdir(binDir);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: opts.configServers }),
  );
  const script = `#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then exit ${opts.removeExitCode}; fi\nexit 0\n`;
  const bin = join(binDir, "claude");
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { env: { HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` } };
}

describe("claudeAdapter.applyExtension — disable/uninstall(result を握り潰さない)", () => {
  test("native に有って remove が本当に失敗したら throw する", async () => {
    const ctx = await makeCtx({ configServers: { github: { command: "npx" } }, removeExitCode: 1 });
    await expect(
      claudeAdapter.applyExtension(ctx, { action: "uninstall", name: "github" }),
    ).rejects.toThrow(/claude mcp remove failed/);
  });

  test("native に有って remove が成功したら throw しない", async () => {
    const ctx = await makeCtx({ configServers: { github: { command: "npx" } }, removeExitCode: 0 });
    await expect(
      claudeAdapter.applyExtension(ctx, { action: "uninstall", name: "github" }),
    ).resolves.toBeUndefined();
  });

  test("native に既に無い名前は remove を呼ばずに成功扱い(冪等)", async () => {
    // removeExitCode:1 でも呼ばれなければ throw しないことを確認する
    const ctx = await makeCtx({ configServers: {}, removeExitCode: 1 });
    await expect(
      claudeAdapter.applyExtension(ctx, { action: "uninstall", name: "not-there" }),
    ).resolves.toBeUndefined();
  });

  test("disable も同じ規約(native に有って失敗すれば throw)", async () => {
    const ctx = await makeCtx({ configServers: { github: { command: "npx" } }, removeExitCode: 1 });
    await expect(
      claudeAdapter.applyExtension(ctx, { action: "disable", name: "github" }),
    ).rejects.toThrow(/claude mcp remove failed/);
  });
});
