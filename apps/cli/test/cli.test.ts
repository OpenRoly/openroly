import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// AC-12 / AC-14: CLI の公開面。status は metadata のみ、未対応 runtime は成功扱いしない。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/whoami") {
      return Response.json({
        agent_id: "agt_x",
        handle: "aya",
        display_name: "Aya",
        unread: 2,
        actor: { kind: "runtime", runtime_id: "rt_1" },
      });
    }
    if (path === "/v1/inbox/messages") {
      return Response.json([
        { id: "msg_1", sender_display: "Shibu", bucket: "inbox", read: false },
        { id: "msg_2", sender_display: "Shibu", bucket: "inbox", read: false },
      ]);
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => stub.stop(true));

async function openroly(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("openroly CLI", () => {
  test("未対応 runtime は対応一覧を出して失敗する(AC-14)", async () => {
    // 実在の製品名を選ぶと、いつか catalog に入って「対応済み」になり検査が腐る
    // (PBI-0298: 元は "hermes" だった。PBI-0210 の catalog 90 entry に入って赤くなった)
    const result = await openroly(["install", "not-a-real-runtime-0298"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsupported runtime: not-a-real-runtime-0298");
    // claude / codex は registry ではなく official adapter なので、catalog が変わっても消えない
    expect(result.stderr).toContain("claude, codex");
  }, 30_000);

  test("status は attach 先と未読の要約だけを出す(AC-12 / 要件 §19)", async () => {
    const env = { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-cli-")) };
    await saveCredential(
      "claude",
      {
        runtime_id: "rt_1",
        token: "par_x",
        base_url: `http://localhost:${stub.port}`,
        name: "MacBook / Claude Code",
        paired_at: new Date().toISOString(),
      },
      env,
    );
    const result = await openroly(["status"], env);
    expect(result.exitCode).toBe(0);
    // PBI-0424: **主語は identity**。1 行目が @handle で、runtime はその下の一覧に落ちる
    const head = result.stdout.split("\n").filter((l) => l.trim() !== "")[0];
    expect(head).toBe("@aya");
    expect(result.stdout).toContain("Unread: 2");
    expect(result.stdout).toContain("- Shibu ×2");
    expect(result.stdout).toContain("[Attached runtimes]");
    expect(result.stdout).toContain("Claude Code · MacBook / Claude Code");
    // runtime を見出しにしない(旧: `[Claude Code] MacBook / Claude Code` が 1 行目だった)
    expect(result.stdout).not.toMatch(/^\[Claude Code\]/m);
    expect(result.stdout).not.toContain("Attached as @");
    expect(result.stdout).not.toContain("msg_1");
  }, 30_000);

  test("未接続なら status は次の一手を示して失敗する", async () => {
    const result = await openroly(["status"], { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-cli-")) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("openroly login");
  }, 30_000);

  test("案内どおり repo 直下の 'bun run openroly' で起動できる", async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const proc = Bun.spawn(["bun", "run", "openroly", "--help"], {
      cwd: repoRoot,
      // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("bun run openroly <command>");
  }, 30_000);

  test("help を出せる", async () => {
    const result = await openroly(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bun run openroly <command>");
  }, 30_000);
});
