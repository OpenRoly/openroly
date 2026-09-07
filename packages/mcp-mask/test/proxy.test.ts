import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// PBI-0177 AC-4/AC-5/AC-X2: openroly-mask の CLI を fixture MCP server(echo)越しに実行し、
// JSON-RPC の initialize → tools/list → tools/call が protocol を壊さず通る事、
// result が mask され、次の call の params で復元される事、--dry-run、
// 子の exit code 伝播、config 異常時の fail-closed を確認する(実 subprocess で end-to-end)。

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));

function jsonRpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
}

/** openroly-mask を fixture 越しに起動し、送った行への応答(id 一致)を返す */
async function withProxy<T>(
  env: Record<string, string>,
  fn: (send: (line: string) => Promise<any>, proc: Bun.Subprocess<"pipe", "pipe", "pipe">) => Promise<T>,
): Promise<T> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, "--", "bun", FIXTURE],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readLine = async (): Promise<any> => {
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        return JSON.parse(line);
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before a full line arrived");
      buf += decoder.decode(value, { stream: true });
    }
  };
  const send = async (line: string): Promise<any> => {
    proc.stdin.write(line + "\n");
    await proc.stdin.flush();
    return readLine();
  };
  try {
    return await fn(send, proc);
  } finally {
    reader.releaseLock();
    proc.kill();
  }
}

describe("openroly-mask proxy (PBI-0177)", () => {
  test("AC-4: initialize → tools/list → tools/call が protocol を壊さず通る", async () => {
    await withProxy({ OPENROLY_SECRETS_PATH: "/nonexistent/secrets.json" }, async (send) => {
      const init = await send(
        jsonRpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      );
      expect(init.result).toBeTruthy();
      const list = await send(jsonRpc(2, "tools/list"));
      expect(list.result.tools.some((t: any) => t.name === "echo")).toBe(true);
      const call = await send(jsonRpc(3, "tools/call", { name: "echo", arguments: { text: "hello" } }));
      expect(call.result.content[0].text).toBe("hello");
    });
  });

  test("AC-4: 子の exit code 3 → proxy の exit code 3", async () => {
    await withProxy({ OPENROLY_SECRETS_PATH: "/nonexistent/secrets.json" }, async (send, proc) => {
      await send(jsonRpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
      proc.stdin.write(jsonRpc(2, "tools/call", { name: "echo", arguments: { text: "exit:3" } }) + "\n");
      await proc.stdin.flush();
      const code = await proc.exited;
      expect(code).toBe(3);
    });
  }, 10000);

  test("AC-5: tools/call の result が mask され、次の call の params で復元されて子に届く", async () => {
    const dir = `${import.meta.dir}/.tmp-ac5`;
    await Bun.write(`${dir}/secrets.json`, JSON.stringify({ PRIVATE: ["Taro Yamada"] }));
    await Bun.$`chmod 600 ${dir}/secrets.json`.quiet();
    try {
      await withProxy({ OPENROLY_SECRETS_PATH: `${dir}/secrets.json` }, async (send) => {
        await send(jsonRpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
        const call1 = await send(jsonRpc(2, "tools/call", { name: "echo", arguments: { text: "Taro Yamada said hi" } }));
        const masked = call1.result.content[0].text as string;
        expect(masked).not.toContain("Taro Yamada");
        expect(masked).toContain("⟨s:0⟩");
        // その ⟨s:0⟩ を次の call の params に含めて送る → 子(echo)には復元された値が届き、
        // echo がそのまま返した値を再び mask するので、また ⟨s:0⟩ に戻る(往復)
        const call2 = await send(jsonRpc(3, "tools/call", { name: "echo", arguments: { text: masked } }));
        expect(call2.result.content[0].text).toBe(masked);
      });
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("--dry-run: stdin の文字列に対し伏せた結果を stdout に出す(表は出さない)", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", CLI, "--dry-run"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENROLY_SECRETS_PATH: "/nonexistent/secrets.json" },
    });
    proc.stdin.write("mail a@b.example");
    proc.stdin.end();
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("⟨s:0⟩");
    expect(stdout).not.toContain("a@b.example");
  });

  test("AC-X2: config が 0644 → exit 2・1 行の理由(stderr)・stdout に JSON を書かない", async () => {
    const dir = `${import.meta.dir}/.tmp-x2`;
    await Bun.write(`${dir}/secrets.json`, JSON.stringify(["x".repeat(20)]));
    await Bun.$`chmod 644 ${dir}/secrets.json`.quiet();
    try {
      const proc = Bun.spawn({
        cmd: ["bun", CLI, "--", "bun", FIXTURE],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENROLY_SECRETS_PATH: `${dir}/secrets.json` },
      });
      proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stdout.trim()).toBe("");
      expect(stderr.trim().split("\n").length).toBe(1);
      expect(stderr).toMatch(/0600/);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("AC-X2: 子 command が存在しない → exit 2・1 行の理由(stderr)", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", CLI, "--", "this-command-does-not-exist-xyz"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENROLY_SECRETS_PATH: "/nonexistent/secrets.json" },
    });
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout.trim()).toBe("");
    expect(stderr.trim().length).toBeGreaterThan(0);
  });
});
