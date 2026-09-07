import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// PBI-0213(図18): broker が「見張る場所」を訊く口。**接続していない runtime の path は出さない**
// —— 出すと、繋がってもいない agent の config を触った時に share が空回りする。
//
// broker 側(Rust)はこの stdout を 1 行 1 path として読むだけで、path の作り方を一切知らない。
// ここが壊れると「Found on <device> が出ない」だけが起き、log にも何も出ない。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

async function openroly(args: string[], home: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OPENROLY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

async function seed(home: string, kind: string): Promise<void> {
  await saveCredential(
    kind,
    {
      runtime_id: `rt_${kind}`,
      token: `par_${kind}`,
      base_url: "http://127.0.0.1:1",
      name: `M / ${kind}`,
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home },
  );
}

describe("openroly watch-dirs", () => {
  test("接続済みの runtime の config file と skills dir だけを 1 行 1 path で出す", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-watch-"));
    await seed(home, "claude");
    const res = await openroly(["watch-dirs"], home);
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toEqual([join(home, ".claude.json"), join(home, ".claude", "skills")]);
    // **繋いでいない runtime は出さない**
    expect(res.stdout).not.toContain(".codex");
    expect(res.stdout).not.toContain(".gemini");
  });

  test("2 つ繋がれば両方出て、全部が絶対 path(broker は相対を捨てる)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-watch2-"));
    await seed(home, "claude");
    await seed(home, "codex");
    const lines = (await openroly(["watch-dirs"], home)).stdout.trim().split("\n").filter(Boolean);
    expect(lines.some((l) => l.includes(".claude"))).toBe(true);
    expect(lines.some((l) => l.includes(".codex"))).toBe(true);
    expect(lines.every((l) => l.startsWith("/"))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length); // 重複無し
  });

  test("1 つも繋いでいなければ何も出さない(broker は見張る場所が 0 でも起動する)", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-watch0-"));
    const res = await openroly(["watch-dirs"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });
});
