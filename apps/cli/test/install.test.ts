import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_ENTRY, run, type AdapterContext, type ExtensionAdapter } from "@openroly/adapter";
import { claudeAdapter } from "@openroly/adapter-claude";
import { codexAdapter } from "@openroly/adapter-codex";

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
  const home = await mkdtemp(join(tmpdir(), "openroly-home-"));
  // OPENROLY_HOME も隔離する: binary が在れば register はそれを使う(PBI-0132)ので、
  // dev 機の ~/.openroly/bin/openroly-mcp の有無で結果が変わらないようにする
  return { env: { ...process.env, HOME: home, OPENROLY_HOME: join(home, ".openroly"), ...extra } };
}

/**
 * ユーザー本物の設定の **openroly の登録が動いていない**ことを確かめる。
 *
 * **mtime を比べてはいけない**(PBI-0307) —— `~/.claude.json` も `~/.codex/config.toml` も
 * **隣で走っている別 session の CLI が自分の都合で書き換える file** で、この repo の持ち物ではない。
 * 窓の間に誰か 1 枚が書けば赤くなり、そうなると **本物の破れ(実 config に openroly を書く)が
 * その noise に紛れて見えなくなる**。だから見るのは **私たちが書き込む唯一の場所**だけにして、
 * 無関係な書き込みには素通しにする。
 * (2026-09-05 実測: 公開 clone の verify 470 秒のうち 432 秒目に第三者が `~/.claude.json` を
 *  書き、同期は正しいのに公開の門が閉じた)
 */
async function openrolyEntry(path: string): Promise<string | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  if (path.endsWith(".json")) {
    try {
      return JSON.stringify(JSON.parse(raw).mcpServers?.openroly ?? null);
    } catch {
      return null; // 第三者が書いている途中の半端な JSON。触っていない事の証拠にはならないが赤にもしない
    }
  }
  // TOML: `[mcp_servers.openroly]` と、その下位 table(`[mcp_servers.openroly.env]` 等)の行だけを集める
  let section = "";
  return (
    raw
      .split("\n")
      .filter((line) => {
        const header = line.trim().match(/^\[(.+)\]$/);
        if (header) section = header[1]!;
        return section === "mcp_servers.openroly" || section.startsWith("mcp_servers.openroly.");
      })
      .join("\n") || null
  );
}

async function untouched(path: string, fn: () => Promise<void>): Promise<void> {
  const before = await openrolyEntry(path);
  await fn();
  expect(await openrolyEntry(path)).toBe(before);
}

const registerInput = (adapter: ExtensionAdapter) => ({
  serverEntry: MCP_SERVER_ENTRY,
  runtimeKind: adapter.id,
  baseUrl: "http://localhost:8787",
  serverName: "openroly",
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
      const server = (await readServers()).openroly;
      expect(server.command).toBe("bun"); // binary の無い環境では従来経路(PBI-0132 AC-3)
      expect(server.args).toEqual([MCP_SERVER_ENTRY]);
      expect(server.env.OPENROLY_RUNTIME_KIND).toBe("claude");
      expect((await claudeAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(true);

      // 再 install(upgrade)でも重複しない
      await claudeAdapter.register(ctx, registerInput(claudeAdapter));
      expect(Object.keys(await readServers())).toEqual(["openroly"]);

      await claudeAdapter.unregister(ctx, "openroly");
      expect((await readServers()).openroly).toBeUndefined();
      expect((await claudeAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(false);
    });
  }, 60_000);
});

describe.skipIf(!(await cliExists("codex")))("codex adapter", () => {
  test("install で [mcp_servers.openroly] を書き、uninstall で消す(実 config は触らない)", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "openroly-codex-"));
    await writeFile(join(codexHome, "config.toml"), "");
    const ctx = await isolated({ CODEX_HOME: codexHome });
    const configPath = join(codexHome, "config.toml");

    await untouched(join(homedir(), ".codex", "config.toml"), async () => {
      expect((await codexAdapter.detect(ctx)).installed).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      const toml = await readFile(configPath, "utf8");
      expect(toml).toContain("[mcp_servers.openroly]");
      expect(toml).toContain(MCP_SERVER_ENTRY);
      expect(toml).toContain('OPENROLY_RUNTIME_KIND = "codex"');
      expect((await codexAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(true);

      await codexAdapter.register(ctx, registerInput(codexAdapter));
      expect((await readFile(configPath, "utf8")).match(/\[mcp_servers\.openroly\]/g)?.length).toBe(1);

      await codexAdapter.unregister(ctx, "openroly");
      expect(await readFile(configPath, "utf8")).not.toContain("[mcp_servers.openroly]");
      expect((await codexAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(false);
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
  const home = await mkdtemp(join(tmpdir(), `openroly-fake-${bin}-`));
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  const marker = join(home, "argv.log");
  await writeFile(join(binDir, bin), `#!/bin/sh\necho "$@" >> ${marker}\nexit 0\n`);
  await chmod(join(binDir, bin), 0o755);
  return {
    // PATH は fake だけ。OPENROLY_HOME も隔離する(実機の ~/.openroly/bin/openroly-mcp を拾うと
    // resolveMcpServerCommand が binary 経路に倒れて期待が機械ごとに揺れる — PBI-0132)
    ctx: {
      env: {
        PATH: binDir,
        HOME: home,
        OPENROLY_HOME: join(home, ".openroly"),
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
      "mcp remove -s user openroly",
      `mcp add -s user openroly -e OPENROLY_RUNTIME_KIND=claude -e OPENROLY_URL=http://localhost:8787 -- bun ${MCP_SERVER_ENTRY}`,
    ]);
    await claudeAdapter.unregister(ctx, "openroly");
    expect((await argv()).at(-1)).toBe("mcp remove -s user openroly");
    await rm(home, { recursive: true, force: true });
  });

  test("claude: doctor / listExtensions は $HOME/.claude.json の mcpServers を読む", async () => {
    const { ctx, home } = await fakeRuntimeCtx("claude");
    // 無い状態: throw せず「未登録」(openroly doctor は install の案内に繋ぐのが仕事)
    expect((await claudeAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(false);
    expect(await claudeAdapter.listExtensions(ctx)).toEqual([]);

    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { openroly: {} } }));
    expect((await claudeAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(true);
    expect(await claudeAdapter.listExtensions(ctx)).toEqual([{ name: "openroly" }]);
    // 別 key(codex の綴り)に置いても拾わない = key の取り違えを測る
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcp_servers: { openroly: {} } }));
    expect((await claudeAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("codex: register の argv は --env / name → -- → command の順", async () => {
    const { ctx, argv, home } = await fakeRuntimeCtx("codex");
    await codexAdapter.register(ctx, registerInput(codexAdapter));
    expect(await argv()).toEqual([
      "mcp remove openroly",
      `mcp add openroly --env OPENROLY_RUNTIME_KIND=codex --env OPENROLY_URL=http://localhost:8787 -- bun ${MCP_SERVER_ENTRY}`,
    ]);
    await rm(home, { recursive: true, force: true });
  });

  test("codex: doctor / listExtensions は $CODEX_HOME/config.toml の mcp_servers を読む", async () => {
    const { ctx, home } = await fakeRuntimeCtx("codex");
    expect((await codexAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(false);
    await writeFile(join(home, ".codex", "config.toml"), "[mcp_servers.openroly]\ncommand = \"bun\"\n");
    expect((await codexAdapter.doctor(ctx, "openroly"))[0]?.ok).toBe(true);
    expect(await codexAdapter.listExtensions(ctx)).toEqual([{ name: "openroly" }]);
    // 壊れた TOML でも throw せず 0 件(doctor が生の stack trace で落ちない)。
    // **本当に parse が失敗する入力を使う** —— `[mcp_servers.openroly` は Bun.TOML が
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

// ---- PBI-0307: `untouched()` 自身を測る ----
// 上の 2 本は実 CLI が無いと skip されるので、**門になっている helper が本当に効くか**は
// ここで独立に固定する。守りたいのは 2 つ同時 ——
//   ① 実 config の openroly が動いたら赤（＝守りが生きている）
//   ② 実 config の **openroly 以外**が動いても緑（＝隣の session に落とされない）
describe("PBI-0307: 実 config の見張りは openroly の欄だけを見る", () => {
  const withTemp = async (name: string, body: string, fn: (p: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "openroly-cfg-"));
    const path = join(dir, name);
    await writeFile(path, body);
    await fn(path);
    await rm(dir, { recursive: true, force: true });
  };

  const claudeCfg = JSON.stringify({
    mcpServers: { openroly: { command: "bun", args: ["x"] }, other: { command: "y" } },
    projects: { "/a": { history: [] } },
  });
  const codexCfg = '[mcp_servers.openroly]\ncommand = "bun"\n\n[mcp_servers.openroly.env]\nK = "1"\n\n[mcp_servers.other]\ncommand = "y"\n';

  test("AC-3/AC-X2: 第三者が openroly 以外を書き換えても緑(mtime も動く)", async () => {
    await withTemp("cfg.json", claudeCfg, async (path) => {
      await untouched(path, async () => {
        const d = JSON.parse(await readFile(path, "utf8"));
        d.projects["/a"].history.push("隣の session が書いた");
        d.mcpServers.other.command = "z";
        await writeFile(path, JSON.stringify(d));
      });
    });
    await withTemp("config.toml", codexCfg, async (path) => {
      await untouched(path, async () => {
        await writeFile(path, `${await readFile(path, "utf8")}\n[mcp_servers.zzz]\ncommand = "z"\n`);
      });
    });
  });

  test("AC-X1: openroly の欄が動いたら赤(json / toml とも・下位 table も見る)", async () => {
    const red = async (name: string, body: string, mutate: (raw: string) => string) => {
      let threw = false;
      await withTemp(name, body, async (path) => {
        try {
          await untouched(path, async () => writeFile(path, mutate(await readFile(path, "utf8"))));
        } catch {
          threw = true;
        }
      });
      expect({ name, red: threw }).toEqual({ name, red: true });
    };
    await red("cfg.json", claudeCfg, (raw) => raw.replace('"command":"bun"', '"command":"node"'));
    await red("config.toml", codexCfg, (raw) => raw.replace('command = "bun"', 'command = "node"'));
    // 下位 table(`[mcp_servers.openroly.env]`)だけを動かしても捕まる
    await red("config.toml", codexCfg, (raw) => raw.replace('K = "1"', 'K = "2"'));
    // openroly を丸ごと消す = 「触っていない」ではない
    await red("cfg.json", claudeCfg, (raw) => raw.replace(/"openroly":\{[^}]*\},?/, ""));
  });

  test("AC-4: 実 config が無い機械でも落ちない(前後とも null)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openroly-cfg-"));
    await untouched(join(dir, "no-such.json"), async () => {});
    await untouched(join(dir, "no-such.toml"), async () => {});
    await rm(dir, { recursive: true, force: true });
  });
});
