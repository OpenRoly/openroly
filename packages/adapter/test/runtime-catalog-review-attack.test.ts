import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMcpServerCommand } from "../src/mcp-config.ts";

// runtime-catalog module review の攻撃（PBI-0694 / 0709 の adapter 側）。
// 急所は **「どれで起こすか」を決める 1 つの判定**（PBI-0709 の mtime 比較）—— ここが黙って
// 落ちると、人は古い binary を掴んだまま「直したのに直らない」に嵌まる（dogfood F56 の元の形）。

let home = "";
let bin = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-rcrev-adapter-"));
  bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const put = async (path: string, mode: number, body = "#!/bin/sh\n") => {
  await writeFile(path, body);
  await chmod(path, mode);
  return path;
};
const age = async (path: string, msAgo: number) => {
  const t = new Date(Date.now() - msAgo);
  await utimes(path, t, t);
};

describe("runtime-catalog review — 攻撃(adapter)", () => {
  test("B1(PBI-0709): entry が消えていても、compiled binary を掴んだまま落ちない", () => {
    // 「checkout の方が新しい」を測る側の file が無い場合。statSync が投げるので、
    // catch していなければここで例外になり、MCP が 1 つも起動しなくなる
    const entry = join(home, "does-not-exist.ts");
    const compiled = join(bin, "openroly-mcp");
    return put(compiled, 0o755).then(() => {
      expect(resolveMcpServerCommand(entry, { OPENROLY_HOME: home })).toEqual({ command: compiled, args: [] });
    });
  });

  test("B2(PBI-0709): compiled が実行権限を持たない時は bun へ落ちる（古い物を掴まない）", async () => {
    const compiled = await put(join(bin, "openroly-mcp"), 0o644);
    const entry = join(home, "server.ts");
    await writeFile(entry, "export {}\n");
    await age(compiled, 60_000);
    expect(resolveMcpServerCommand(entry, { OPENROLY_HOME: home })).toEqual({ command: "bun", args: [entry] });
  });

  test("B3(PBI-0709): 人が明示した OPENROLY_MCP_BINARY は、古くても mtime 判定に上書きされない", async () => {
    // 明示は「この 1 本で起こせ」という意思表示。ここが mtime で覆ると、
    // 固定したい環境（実機の再現・二分探索）で別の物が起きて原因が分からなくなる
    const explicit = await put(join(home, "pinned-mcp"), 0o755);
    await age(explicit, 10 * 60_000);
    const entry = join(home, "server.ts");
    await writeFile(entry, "export {}\n");
    expect(resolveMcpServerCommand(entry, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: explicit }))
      .toEqual({ command: explicit, args: [] });
  });

  test("B4(PBI-0709): 明示した path が実行できない物なら、黙って使わず落ちる先を持つ", async () => {
    const explicit = join(home, "not-executable");
    await put(explicit, 0o644);
    const compiled = await put(join(bin, "openroly-mcp"), 0o755);
    const entry = join(home, "server.ts");
    await writeFile(entry, "export {}\n");
    await age(entry, 60_000); // compiled の方が新しい = bun へ行く理由が無い
    expect(resolveMcpServerCommand(entry, { OPENROLY_HOME: home, OPENROLY_MCP_BINARY: explicit }))
      .toEqual({ command: compiled, args: [] });
  });

  test("B5(PBI-0709): 同じ mtime は「新しい」ではない（境界で bun へ振れない）", async () => {
    const compiled = await put(join(bin, "openroly-mcp"), 0o755);
    const entry = join(home, "server.ts");
    await writeFile(entry, "export {}\n");
    const t = new Date(Date.now() - 30_000);
    await utimes(compiled, t, t);
    await utimes(entry, t, t);
    expect(resolveMcpServerCommand(entry, { OPENROLY_HOME: home })).toEqual({ command: compiled, args: [] });
  });
});
