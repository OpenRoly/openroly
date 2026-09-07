import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMcpServerCommand } from "../src/mcp-config.ts";

// PBI-0132 AC-1〜4: MCP server の起動口を「binary が在れば binary、無ければ bun」に解決する。
// **実行できる物だけ**を採るのが芯 —— 存在しない command を runtime の config に書くと
// 「登録は成功したのに起動だけ静かに失敗する」形になり、user からは tool が消えたようにしか見えない。

let home = "";
let bin = "";
const ENTRY = "/repo/packages/mcp/src/server.ts";

/** `mode` で file を置く。0o755 = 実行可能、0o644 = 実行不可 */
async function put(path: string, mode: number): Promise<string> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, mode);
  return path;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-mcpcmd-"));
  bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("resolveMcpServerCommand (PBI-0132)", () => {
  test("AC-1: OPENROLY_MCP_BINARY が実行可能ならそれを args 無しで使う", async () => {
    const explicit = await put(join(home, "custom-mcp"), 0o755);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: explicit })).toEqual({
      command: explicit,
      args: [],
    });
  });

  test("AC-2: OPENROLY_MCP_BINARY 無しなら <OPENROLY_HOME>/bin/openroly-mcp", async () => {
    const installed = await put(join(bin, "openroly-mcp"), 0o755);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home })).toEqual({
      command: installed,
      args: [],
    });
  });

  test("AC-1 > AC-2: 両方在れば OPENROLY_MCP_BINARY が勝つ", async () => {
    const explicit = await put(join(home, "custom-mcp"), 0o755);
    await put(join(bin, "openroly-mcp"), 0o755);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: explicit }).command).toBe(
      explicit,
    );
  });

  test("AC-3: binary が 1 つも無ければ従来どおり bun <entry>", () => {
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home })).toEqual({
      command: "bun",
      args: [ENTRY],
    });
  });

  test("AC-4: 実行不可(無い / 権限無し / dir)は黙って次の候補へ落ちる", async () => {
    // 存在しない path
    expect(
      resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: join(home, "nope") }),
    ).toEqual({ command: "bun", args: [ENTRY] });

    // 在るが実行権が無い(chmod 忘れ / download 直後)
    const notExec = await put(join(home, "not-exec"), 0o644);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: notExec })).toEqual({
      command: "bun",
      args: [ENTRY],
    });

    // dir は X_OK が立つ(= access だけ見ると通ってしまう)ので isFile まで見る
    const asDir = join(home, "dir-mcp");
    await mkdir(asDir);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: asDir })).toEqual({
      command: "bun",
      args: [ENTRY],
    });

    // 空文字の env は「未設定」と同じ扱い(存在しない path を command にしない)
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: "" })).toEqual({
      command: "bun",
      args: [ENTRY],
    });
  });

  test("AC-4 攻撃: <OPENROLY_HOME>/bin/openroly-mcp が実行不可でも explicit へ戻らず bun に落ちる", async () => {
    await put(join(bin, "openroly-mcp"), 0o644);
    expect(resolveMcpServerCommand(ENTRY, { OPENROLY_HOME: home })).toEqual({
      command: "bun",
      args: [ENTRY],
    });
  });
});
