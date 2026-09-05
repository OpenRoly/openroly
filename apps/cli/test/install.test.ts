import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_ENTRY, run, type AdapterContext, type RuntimeAdapter } from "@paa/adapter";
import { claudeAdapter } from "@paa/adapter-claude";
import { codexAdapter } from "@paa/adapter-codex";

// AC-8 / AC-9: install / uninstall が runtime 側の設定を実際に書き換えること。
// 検査は必ず隔離環境(temp HOME / CODEX_HOME)で行う —— ユーザーの実 runtime 設定を
// test が書き換えてはいけない。実 CLI が無い環境では skip する。
//
// **この file は 2 段構え**(PBI-0162):
//   ① 下の 2 本 = 実 CLI を起こす live test。**その CLI が本当にこの argv を受け付け、
//      読み戻せる config を書く**ことは、実物を動かさないと分からない。dev 機でだけ走る
//   ② 最後の describe = fake CLI で **自分たちの側の契約**(組む argv / config の場所・形式・key)
//      を固定する。CLI が入っていない CI でも回るので、① が skip される所に穴が空かない

/**
 * 実 CLI が起動できるか。**待ちに上限を置く** —— claude / codex の `--version` は runtime 本体を
 * 起こすので、機械が混んでいると数十秒返らないことがある。上限が無いと「入っているのに skip」と
 * 「入っていないのに 60s 使って落ちる」が run ごとに入れ替わり、この file の結果が非決定になる
 * (2026-09-01 PBI-0162 起票時の症状)。上限に当たった時は **skip でなく throw** して、
 * 「測れなかった」を緑で覆わない
 */
async function cliExists(cmd: string): Promise<boolean> {
  const ctx: AdapterContext = { env: process.env };
  const probe = run(ctx, [cmd, "--version"]).then(
    (r) => r.ok,
    () => false, // PATH に無い = 未 install(正当な skip 理由)
  );
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${cmd} --version が 20s で返らなかった(機械が混んでいる)`)), 20_000),
  );
  return await Promise.race([probe, timeout]);
}

async function isolated(extra: Record<string, string> = {}): Promise<AdapterContext> {
  const home = await mkdtemp(join(tmpdir(), "paa-home-"));
  // PAA_HOME も隔離する: binary が在れば register はそれを使う(PBI-0132)ので、
  // dev 機の ~/.atn/bin/atn-mcp の有無で結果が変わらないようにする
  return { env: { ...process.env, HOME: home, PAA_HOME: join(home, ".atn"), ...extra } };
}

/** ユーザー本物の設定が触られていないことを確かめる */
async function untouched(path: string, fn: () => Promise<void>): Promise<void> {
  const before = await stat(path).catch(() => null);
  await fn();
  const after = await stat(path).catch(() => null);
  expect(after?.mtimeMs).toBe(before?.mtimeMs);
}

const registerInput = (adapter: RuntimeAdapter) => ({
  serverEntry: MCP_SERVER_ENTRY,
  runtimeKind: adapter.id,
  baseUrl: "http://localhost:8787",
  serverName: "atn",
});

describe.skipIf(!(await cliExists("claude")))("claude adapter", () => {
  test("install で MCP server を登録し、uninstall で消す(実 config は触らない)", async () => {
    const ctx = await isolated();
    const configPath = join(ctx.env.HOME!, ".claude.json");
    const readServers = async () =>
      JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")).mcpServers ?? {};

    await untouched(join(homedir(), ".claude.json"), async () => {
      expect((await claudeAdapter.detect(ctx)).installed).toBe(true);

      await claudeAdapter.register(ctx, registerInput(claudeAdapter));
      const server = (await readServers()).atn;
      expect(server.command).toBe("bun"); // binary の無い環境では従来経路(PBI-0132 AC-3)
      expect(server.args).toEqual([MCP_SERVER_ENTRY]);
      expect(server.env.PAA_RUNTIME_KIND).toBe("claude");
      expect((await claudeAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(true);

      // 再 install(upgrade)でも重複しない
      await claudeAdapter.register(ctx, registerInput(claudeAdapter));
      expect(Object.keys(await readServers())).toEqual(["atn"]);

      await claudeAdapter.unregister(ctx, "atn");
      expect((await readServers()).atn).toBeUndefined();
      expect((await claudeAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(false);
    });
  }, 60_000);
});

describe.skipIf(!(await cliExists("codex")))("codex adapter", () => {
  test("install で [mcp_servers.atn] を書き、uninstall で消す(実 config は触らない)", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paa-codex-"));
    await writeFile(join(codexHome, "config.toml"), "");
    const ctx = await isolated({ CODEX_HOME: codexHome });
    const configPath = join(codexHome, "config.toml");

    await untouched(join(homedir(), ".codex", "config.toml"), async () => {
      expect((await codexAdapter.detect(ctx)).installed).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      const toml = await readFile(configPath, "utf8");
      expect(toml).toContain("[mcp_servers.atn]");
      expect(toml).toContain(MCP_SERVER_ENTRY);
      expect(toml).toContain('PAA_RUNTIME_KIND = "codex"');
      expect((await codexAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      expect((await readFile(configPath, "utf8")).match(/\[mcp_servers\.atn\]/g)?.length).toBe(1);

      await codexAdapter.unregister(ctx, "atn");
      expect(await readFile(configPath, "utf8")).not.toContain("[mcp_servers.atn]");
      expect((await codexAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(false);
    });
  }, 60_000);
});

// ---- PBI-0162: runtime CLI が入っていない環境(CI)でも回る決定的な面 ----
// 上の 2 本は実 CLI が無ければ丸ごと skip される。**skip した分を「何も測っていない」にしない**ため、
// claude / codex adapter が持つ runtime 固有の 3 点のうち、こちら側で決まっている 2 点
//   ① `mcp add` / `mcp remove` に渡す argv(env の綴り・`--` の位置・name と command の順)
//   ② config をどこから、どの形式の、どの key で読むか
// を PATH 先頭の fake CLI で固定する。実 CLI 側の契約(その argv を受けて何を書くか)は live test の担当。
// generic 機構(createMcpConfigAdapter)自体は packages/adapter/test/mcp-config.test.ts が持つ ——
// ここで測るのは **claude / codex という具体の spec** が正しく組まれていること。

/** fake CLI を PATH 先頭に置いた隔離 ctx。受け取った argv を 1 行ずつ marker に落とす */
async function fakeRuntimeCtx(bin: string): Promise<{
  ctx: AdapterContext;
  argv: () => Promise<string[]>;
  home: string;
}> {
  const home = await mkdtemp(join(tmpdir(), `paa-fake-${bin}-`));
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  const marker = join(home, "argv.log");
  await writeFile(join(binDir, bin), `#!/bin/sh\necho "$@" >> ${marker}\nexit 0\n`);
  await chmod(join(binDir, bin), 0o755);
  return {
    // PATH は fake だけ。PAA_HOME も隔離する(実機の ~/.atn/bin/atn-mcp を拾うと
    // resolveMcpServerCommand が binary 経路に倒れて期待が機械ごとに揺れる — PBI-0132)
    ctx: {
      env: {
        PATH: binDir,
        HOME: home,
        PAA_HOME: join(home, ".atn"),
        CODEX_HOME: join(home, ".codex"),
      },
    },
    argv: async () =>
      (await readFile(marker, "utf8").catch(() => ""))
        .split("\n")
        .filter((l) => l.length > 0),
    home,
  };
}

describe("adapter spec の argv と config の読み(fake CLI・PBI-0162)", () => {
  test("claude: register は remove → add、unregister は remove(綴りまで固定)", async () => {
    const { ctx, argv, home } = await fakeRuntimeCtx("claude");
    await claudeAdapter.register(ctx, registerInput(claudeAdapter));
    expect(await argv()).toEqual([
      "mcp remove -s user atn",
      `mcp add -s user atn -e PAA_RUNTIME_KIND=claude -e PAA_URL=http://localhost:8787 -- bun ${MCP_SERVER_ENTRY}`,
    ]);
    await claudeAdapter.unregister(ctx, "atn");
    expect((await argv()).at(-1)).toBe("mcp remove -s user atn");
    await rm(home, { recursive: true, force: true });
  });

  test("claude: doctor / listExtensions は $HOME/.claude.json の mcpServers を読む", async () => {
    const { ctx, home } = await fakeRuntimeCtx("claude");
    // 無い状態: throw せず「未登録」(atn doctor は install の案内に繋ぐのが仕事)
    expect((await claudeAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(false);
    expect(await claudeAdapter.listExtensions(ctx)).toEqual([]);

    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { atn: {} } }));
    expect((await claudeAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(true);
    expect(await claudeAdapter.listExtensions(ctx)).toEqual([{ name: "atn" }]);
    // 別 key(codex の綴り)に置いても拾わない = key の取り違えを測る
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcp_servers: { atn: {} } }));
    expect((await claudeAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("codex: register の argv は --env / name → -- → command の順", async () => {
    const { ctx, argv, home } = await fakeRuntimeCtx("codex");
    await codexAdapter.register(ctx, registerInput(codexAdapter));
    expect(await argv()).toEqual([
      "mcp remove atn",
      `mcp add atn --env PAA_RUNTIME_KIND=codex --env PAA_URL=http://localhost:8787 -- bun ${MCP_SERVER_ENTRY}`,
    ]);
    await rm(home, { recursive: true, force: true });
  });

  test("codex: doctor / listExtensions は $CODEX_HOME/config.toml の mcp_servers を読む", async () => {
    const { ctx, home } = await fakeRuntimeCtx("codex");
    expect((await codexAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(false);
    await writeFile(join(home, ".codex", "config.toml"), "[mcp_servers.atn]\ncommand = \"bun\"\n");
    expect((await codexAdapter.doctor(ctx, "atn"))[0]?.ok).toBe(true);
    expect(await codexAdapter.listExtensions(ctx)).toEqual([{ name: "atn" }]);
    // 壊れた TOML でも throw せず 0 件(doctor が生の stack trace で落ちない)。
    // **本当に parse が失敗する入力を使う** —— `[mcp_servers.atn` は Bun.TOML が
    // 閉じ括弧無しでも受けるので(2026-09-04 実測)、それでは catch を 1 度も踏まない
    await writeFile(join(home, ".codex", "config.toml"), "= 1\n");
    expect(await codexAdapter.listExtensions(ctx)).toEqual([]);
    await rm(home, { recursive: true, force: true });
  });

  test("detect は CLI の有無をそのまま返す(無ければ installHint)", async () => {
    const { ctx, home } = await fakeRuntimeCtx("claude");
    expect((await claudeAdapter.detect(ctx)).installed).toBe(true);
    // codex は同じ PATH に居ない = 未 install
    expect(await codexAdapter.detect(ctx)).toMatchObject({
      installed: false,
      detail: "codex CLI was not found (npm i -g @openai/codex)",
    });
    await rm(home, { recursive: true, force: true });
  });
});
