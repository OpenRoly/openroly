import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `openroly adopt`(PBI-0023): broker が hello の応答で受け取った credential を非対話で materialize する。
// 実 CLI(codex / claude)には到達させない —— PATH の先頭に fake を置き、そこへ渡った argv を
// marker file で観測する(EP-0001 LEARN 13)。

const CLI = join(import.meta.dir, "../src/openroly.ts");
const TOKEN = "par_adopt_test_token";

let root = "";
let home = "";
let bin = "";
let marker = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-adopt-"));
  home = join(root, "home");
  bin = join(root, "bin");
  marker = join(root, "codex-argv.log");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 0\n`);
  await chmod(join(bin, "codex"), 0o755);
  // grok も同じ扱い。**開発機に grok が入っているかどうかで結果が変わらない**ようにする ——
  // shim が無いと adopt の register が `runtime_cli_not_found` で exit 2 になり、grok を入れていない
  // 機械(公開 CI の Linux runner)でだけ赤くなる。grok の mcp strategy は "cli" なので register は
  // binary を要る。config.toml へ openroly-mcp を書くのは register の後の applyOpenRolyMcp()
  await writeFile(join(bin, "grok"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.34; exit 0; fi\necho "$@" >> ${marker}\nexit 0\n`);
  await chmod(join(bin, "grok"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function adopt(
  args: string[],
  stdin: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, "adopt", ...args], {
    env: { ...process.env, OPENROLY_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

const OK_ARGS = [
  "--kind",
  "codex",
  "--runtime-id",
  "rt_adopt_1",
  "--base-url",
  "http://localhost:9999",
  "--name",
  "Status MacBook / Codex",
  "--token-stdin",
];

describe("openroly adopt (PBI-0023)", () => {
  test("credential を保存し MCP を登録する。token は argv に出ない", async () => {
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    expect(res.code).toBe(0);

    const file = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(file.runtimes.codex).toMatchObject({
      runtime_id: "rt_adopt_1",
      token: TOKEN,
      base_url: "http://localhost:9999",
      name: "Status MacBook / Codex",
    });

    // adapter.register が 1 回(remove → add の add 側が 1 行)
    const argv = await readFile(marker, "utf8");
    expect(argv.split("\n").filter((l) => l.startsWith("mcp add"))).toHaveLength(1);
    expect(argv).toContain("OPENROLY_RUNTIME_KIND=codex");
    expect(argv).toContain("OPENROLY_URL=http://localhost:9999");
    // argv は同一ホストの他プロセスから ps で見える。token を載せていないことを固定する
    expect(argv).not.toContain(TOKEN);
  });

  test("PBI-0685: adapter が無い kind は credential だけ保存し MCP を書かない", async () => {
    const home2 = await mkdtemp(join(tmpdir(), "openroly-adopt-aider-"));
    const grokToml = join(home2, ".grok", "config.toml");
    const res = await adopt(
      [
        "--kind",
        "aider",
        "--runtime-id",
        "rt_aider_1",
        "--base-url",
        "http://localhost:9999",
        "--name",
        "Mac / Aider",
        "--token-stdin",
      ],
      `${TOKEN}\n`,
      { OPENROLY_HOME: home2, HOME: home2 },
    );
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("openroly-mcp");
    const file = JSON.parse(await readFile(join(home2, "credentials.json"), "utf8"));
    expect(file.runtimes.aider).toMatchObject({ runtime_id: "rt_aider_1", token: TOKEN });
    expect(existsSync(grokToml)).toBe(false);
    await rm(home2, { recursive: true, force: true });
  });

  test("PBI-0699 AC-3: grok adopt は .grok があれば openroly-mcp を書く（--from 不要）", async () => {
    const home2 = await mkdtemp(join(tmpdir(), "openroly-adopt-grok-"));
    await mkdir(join(home2, ".grok"), { recursive: true });
    const res = await adopt(
      [
        "--kind",
        "grok",
        "--runtime-id",
        "rt_grok_1",
        "--base-url",
        "http://localhost:9999",
        "--name",
        "Mac / Grok",
        "--token-stdin",
      ],
      `${TOKEN}\n`,
      { OPENROLY_HOME: home2, HOME: home2, OPENROLY_MCP_COMPILE: "0" },
    );
    expect(res.code, res.err).toBe(0);
    const toml = await readFile(join(home2, ".grok", "config.toml"), "utf8");
    expect(toml).toContain("openroly-mcp");
    expect(toml).toContain("OPENROLY_RUNTIME_KIND");
    expect(toml).not.toContain("mcp/src/server.ts");
    await rm(home2, { recursive: true, force: true });
  });

  // AC-11: credentials.json は kind 単位の 1 entry なので、上書きすると Cloud の既定 runtime と
  // 実際に認証する runtime がずれる。human が入れた生きている credential は奪わない
  test("human が入れた別 runtime_id の credential は奪わない(exit 2 / ファイル不変)", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ handle: "aya", unread: 0 }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const humanEntry = {
      runtime_id: "rt_human",
      token: "par_human_token",
      base_url: `http://localhost:${srv.port}`,
      name: "Status MacBook / Codex",
      paired_at: new Date().toISOString(),
    };
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({ version: 1, runtimes: { codex: humanEntry } }),
    );
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    expect(res.code).toBe(2);
    // broker は stderr の 1 行目を register_ack の detail にする
    expect(res.err.split("\n")[0]).toBe("credential_owned_by_human");
    const file = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(file.runtimes.codex).toEqual(humanEntry);
    srv.stop(true);
  });

  // AC-4 の再試行は同じ runtime_id で来る。それは「奪う」ではないので通す
  test("同じ runtime_id の再 materialize は上書きできる(ack 失敗後の再試行)", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ handle: "aya" }), {
        headers: { "content-type": "application/json" },
      }),
    });
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          codex: {
            runtime_id: "rt_adopt_1",
            token: "par_old",
            base_url: `http://localhost:${srv.port}`,
            name: "Status MacBook / Codex",
            paired_at: new Date().toISOString(),
          },
        },
      }),
    );
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    expect(res.code).toBe(0);
    const file = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(file.runtimes.codex.token).toBe(TOKEN);
    srv.stop(true);
  });

  test("--token-stdin が無ければ exit 2(token を argv では受けない)", async () => {
    const res = await adopt(
      ["--kind", "codex", "--runtime-id", "rt_x", "--base-url", "http://h", "--name", "n"],
      `${TOKEN}\n`,
    );
    expect(res.code).toBe(2);
    expect(res.err).toContain("--token-stdin");
  });

  test("未対応の runtime は exit 2", async () => {
    const res = await adopt(
      [
        "--kind",
        "ollama",
        "--runtime-id",
        "rt_x",
        "--base-url",
        "http://h",
        "--name",
        "n",
        "--token-stdin",
      ],
      `${TOKEN}\n`,
    );
    expect(res.code).toBe(2);
    expect(res.err).toContain("unsupported runtime");
  });

  test("stdin が空なら exit 2(空 token を保存しない)", async () => {
    const res = await adopt(OK_ARGS, "\n");
    expect(res.code).toBe(2);
    expect(res.err).toContain("token");
  });


  // PBI-0041 F2: 「生きているか確認できない」は「奪ってよい」ではない。fail-closed に直した
  // (旧実装は who?.status !== 200 を無条件で通過扱いにしており、server 到達不能・5xx でも
  // 上書きしていた)
  test("PBI-0041 F2: ownership 確認が到達不能(server が居ない)なら奪わず exit 2", async () => {
    const humanEntry = {
      runtime_id: "rt_human",
      token: "par_human_token",
      base_url: "http://127.0.0.1:1",
      name: "Status MacBook / Codex",
      paired_at: new Date().toISOString(),
    };
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({ version: 1, runtimes: { codex: humanEntry } }),
    );
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    const file = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(file.runtimes.codex).toEqual(humanEntry);
    expect(res.code).toBe(2);
    // human_owned とは別の reason(HUMAN_OWNED と混ぜると server 側が human revoke 扱いにして
    // 再試行しなくなる。判定不能は機械的失敗として次の hello で再試行させる)
    expect(res.err.split("\n")[0]).toBe("credential_check_failed");
  });

  test("PBI-0041 F2: ownership の credential が既に 401(失効済み)なら奪ってよい", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response("unauthorized", { status: 401 }),
    });
    const humanEntry = {
      runtime_id: "rt_human",
      token: "par_human_token",
      base_url: `http://localhost:${srv.port}`,
      name: "Status MacBook / Codex",
      paired_at: new Date().toISOString(),
    };
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({ version: 1, runtimes: { codex: humanEntry } }),
    );
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    const file = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    expect(res.code).toBe(0);
    expect(file.runtimes.codex.runtime_id).toBe("rt_adopt_1");
    expect(file.runtimes.codex.token).toBe(TOKEN);
    srv.stop(true);
  });
  test("引数が欠けていれば exit 2", async () => {
    const res = await adopt(["--kind", "codex", "--token-stdin"], `${TOKEN}\n`);
    expect(res.code).toBe(2);
  });
});

// PBI-0050 AC-1 / AC-X2: launchd が broker を最小 PATH(/usr/bin:/bin:/usr/sbin:/sbin)で起こすと、
// broker → `openroly adopt` → adapter.register の `claude mcp add` が bare な "claude" を解決できず
// ENOENT で自動登録が全滅する。run() の PATH 補強(broker の default_bin_dirs 相当)で
// `~/.local/bin` 等から absolute path 解決できることを、launchd 相当 env の subprocess で固定する。
describe("openroly adopt — launchd 最小 PATH (PBI-0050)", () => {
  let lroot = "";
  let lhome = "";
  let lmarker = "";

  beforeAll(async () => {
    lroot = await mkdtemp(join(tmpdir(), "openroly-adopt-launchd-"));
    lhome = join(lroot, "home");
    const localBin = join(lhome, ".local", "bin");
    lmarker = join(lroot, "claude-argv.log");
    await mkdir(localBin, { recursive: true });
    await writeFile(join(localBin, "claude"), `#!/bin/sh\necho "$@" >> ${lmarker}\nexit 0\n`);
    await chmod(join(localBin, "claude"), 0o755);
  });

  afterAll(async () => {
    await rm(lroot, { recursive: true, force: true });
  });

  /** launchd 相当の最小 PATH(OPENROLY_HOME は credential 保存先の隔離用に別途渡す)。
   * OPENROLY_EXTRA_PATH_DIRS で補強 dir を差し替える(review 2026-08-28) — 実機の /usr/local/bin に
   * 実 claude が居ても(この Mac は 2026-08-28 から居る)fake が shadow されない。AC-1 は
   * 補強 dir を temp の ~/.local/bin に向け、X2 は補強を無効化する(空文字 = 補強なし)。
   * X2 は fake claude を置かない home で起こす(AC-1 と同じ lhome を使うと fake が居て成功してしまう) */
  async function adoptLaunchd(
    kind: string,
    home = lhome,
    extraDirs?: string,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, CLI, "adopt", "--kind", kind, "--runtime-id", "rt_launchd_1",
      "--base-url", "http://localhost:9999", "--name", "MacBook / Claude Code", "--token-stdin"], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, OPENROLY_HOME: home,
        OPENROLY_EXTRA_PATH_DIRS: extraDirs ?? "" },
      stdin: new TextEncoder().encode(`${TOKEN}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out, err };
  }

  test("AC-1: PATH=/usr/bin:/bin でも $HOME/.local/bin の claude を解決して登録できる", async () => {
    const res = await adoptLaunchd("claude", lhome, join(lhome, ".local", "bin"));
    expect(res.code).toBe(0);
    const argv = await readFile(lmarker, "utf8");
    expect(argv.split("\n").filter((l) => l.startsWith("mcp add"))).toHaveLength(1);
    const cred = JSON.parse(await readFile(join(lhome, "credentials.json"), "utf8"));
    expect(cred.runtimes.claude.runtime_id).toBe("rt_launchd_1");
  });

  test("AC-X2: どこにも claude が無ければ exit 2 と「見つかりません」1 行(ENOENT の生 stack ではなく)", async () => {
    // 補強を空文字で無効化(review 2026-08-28) — 実行環境の /usr/local/bin に本物の claude が
    // 居ても「無いはず」が決定的に成り立つ(旧 SYSTEM_CLAUDE ガードは skip ではなく決定化で解消)
    const emptyHome = join(lroot, "empty-home");
    await mkdir(emptyHome, { recursive: true });
    const res = await adoptLaunchd("claude", emptyHome, "");
    expect(res.code).toBe(2);
    const first = res.err.split("\n")[0]!;
    expect(first).toContain("claude was not found");
    // 生 stack trace を stderr 1 行目に晒さない(broker が register_ack の detail に載せる)
    expect(first).not.toContain("at ");
  });
});

// ---------------------------------------------------------------------------
// PBI-0236: plist に焼いた PATH は login の瞬間の snapshot。`openroly adopt` は
// `OPENROLY_LOGIN_PATH`(= 焼いた印)が在る時だけ login shell を起こして今の PATH を取り直す。
// 実 CLI には到達させない —— stale / fresh の 2 つの dir に別々の fake `codex` を置き、
// **どちらが走ったか**を marker file で観測する(EP-0001 LEARN 13)。
// fake は `#!/bin/sh` なので PATH には /usr/bin:/bin を残す(残さないと script 内の command が
// 解決できず、意図した経路ではなく exit 127 で終わる)。
// ---------------------------------------------------------------------------
describe("openroly adopt: PATH は adopt の時に解決する (PBI-0236)", () => {
  const ADOPT_ARGS = [
    "--kind", "codex",
    "--runtime-id", "rt_0236",
    "--base-url", "http://localhost:9999",
    "--name", "MacBook / Codex",
    "--token-stdin",
  ];

  interface Fixture {
    root: string;
    home: string;
    stale: string;
    fresh: string;
    marker: string;
    shellSpy: string;
  }

  /** fake の codex を 2 つ(stale / fresh)と、fresh を PATH に入れて `-c` を実行する fake login shell */
  async function fixture(opts: { staleCodex?: string; loginShell?: string } = {}): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "openroly-0236-"));
    const home = join(root, "home");
    const stale = join(root, "stale-bin");
    const fresh = join(root, "fresh-bin");
    const marker = join(root, "which-codex.log");
    const shellSpy = join(root, "login-shell-called");
    for (const d of [home, stale, fresh]) await mkdir(d, { recursive: true });

    const codex = (tag: string) => `#!/bin/sh\necho "${tag} $@" >> ${marker}\nexit 0\n`;
    await writeFile(join(stale, "codex"), opts.staleCodex ?? codex("STALE"));
    await writeFile(join(fresh, "codex"), codex("FRESH"));
    await chmod(join(stale, "codex"), 0o755);
    await chmod(join(fresh, "codex"), 0o755);

    // 既定の fake login shell: 「rc file が PATH を書き換えてから -c を実行する」を再現する。
    // ① 渡された argv が `-l -i -c <script>` である事をここで固定し(違えば exit 9)、
    // ② `-c` の中身は **本物のまま** 実行する(marker の組み立てと切り出しを迂回しない)。
    // 実行は `/bin/sh -c` にする —— `-l` を付け直すと macOS の path_helper が /etc/paths を
    // 足して実機の /opt/homebrew/bin が混ざり、fake が本物の codex に負けて検査が嘘になる
    const login = join(root, "login-shell");
    await writeFile(
      login,
      opts.loginShell ??
        `#!/bin/sh\ntouch ${shellSpy}\n` +
          `[ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 9\n` +
          `PATH="${fresh}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh -c "$4"\n`,
    );
    await chmod(login, 0o755);
    return { root, home, stale, fresh, marker, shellSpy: shellSpy };
  }

  async function runAdopt(
    f: Fixture,
    env: Record<string, string>,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, CLI, "adopt", ...ADOPT_ARGS], {
      env: {
        // launchd が broker を起こす時の env を再現する(最小 PATH + plist が焼いた分)
        HOME: f.home,
        OPENROLY_HOME: f.home,
        OPENROLY_EXTRA_PATH_DIRS: "", // 実機の /opt/homebrew/bin に本物が居ても決定的にする
        ...env,
      },
      stdin: new TextEncoder().encode(`${TOKEN}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out, err };
  }

  /** 走った fake CLI の tag(STALE / FRESH)。1 回も走っていなければ空 */
  async function whoRan(f: Fixture): Promise<string> {
    const log = await readFile(f.marker, "utf8").catch(() => "");
    return log
      .split("\n")
      .filter((l) => l.includes("mcp add"))
      .map((l) => l.split(" ")[0]!)
      .join(",");
  }

  test("AC-1: 版を切り替えた後は login shell の今の PATH が使われる(焼いた古い dir ではなく)", async () => {
    const f = await fixture();
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: join(f.root, "login-shell"),
    });
    expect(res.code).toBe(0);
    // 旧 dir の codex は**まだ実在する**(nvm で古い版を消していない人)。それでも新が勝つ
    expect(await whoRan(f)).toBe("FRESH");
    expect(res.out).toContain("refreshed from the login shell");
    await rm(f.root, { recursive: true, force: true });
  });

  test("AC-2: 解決できても shebang の node が無ければ、その 1 行がそのまま理由になる", async () => {
    // PBI-0190 で本番実測した壊れ方。`codex` は解決できているので resolveCommand は助けにならない
    const f = await fixture({
      staleCodex: `#!/bin/sh\necho "env: node: No such file or directory" >&2\nexit 127\n`,
      loginShell: `#!/bin/sh\nexit 1\n`, // probe は失敗 = 焼いた PATH のまま(「作り直していない端末」)
    });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: join(f.root, "login-shell"),
    });
    expect(res.code).toBe(2);
    // broker は stderr の **1 行目**だけを register_ack.detail と log に載せる
    const first = res.err.split("\n")[0]!;
    expect(first).toContain("env: node: No such file or directory");
    expect(first).not.toContain("at "); // 生 stack を晒さない
    await rm(f.root, { recursive: true, force: true });
  });

  test("AC-3: OPENROLY_LOGIN_PATH が無ければ login shell を 1 回も起こさない(人が手で打つ経路)", async () => {
    const f = await fixture();
    const res = await runAdopt(f, {
      PATH: `${f.stale}:/usr/bin:/bin`,
      OPENROLY_LOGIN_SHELL: join(f.root, "login-shell"), // 起こせる状態にしておく
    });
    expect(res.code).toBe(0);
    expect(await whoRan(f)).toBe("STALE"); // 今の PATH がそのまま使われる
    expect(existsSync(f.shellSpy)).toBe(false); // shell は起きていない
    expect(res.out).not.toContain("PATH ");
    await rm(f.root, { recursive: true, force: true });
  });

  test("AC-X1: どこにも codex が無ければ runtime_cli_not_found(openroly_cli_not_found とは別の名前)", async () => {
    const f = await fixture();
    // stale / fresh の両方から codex を消す = 「PATH がどうやっても解決できない」
    await rm(join(f.stale, "codex"), { force: true });
    await rm(join(f.fresh, "codex"), { force: true });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: join(f.root, "login-shell"),
    });
    expect(res.code).toBe(2);
    const first = res.err.split("\n")[0]!;
    expect(first.startsWith("runtime_cli_not_found")).toBe(true);
    expect(first).not.toContain("openroly_cli_not_found"); // broker 側の「openroly 自身が無い」と混ぜない
    await rm(f.root, { recursive: true, force: true });
  });

  test("AC-X2: login shell が答えない 3 通り(落ちる / PATH でない / 黙る)は焼いた PATH に落ちる", async () => {
    const shells = [
      { name: "exit 1", body: `#!/bin/sh\nexit 1\n` },
      { name: "PATH でない出力", body: `#!/bin/sh\necho hello world\n` },
      { name: "黙る(timeout)", body: `#!/bin/sh\nexec sleep 30\n` },
    ];
    for (const s of shells) {
      const f = await fixture({ loginShell: s.body });
      const snapshot = `${f.stale}:/usr/bin:/bin`;
      const res = await runAdopt(f, {
        PATH: snapshot,
        OPENROLY_LOGIN_PATH: snapshot,
        OPENROLY_LOGIN_SHELL: join(f.root, "login-shell"),
      });
      expect(`${s.name}: exit ${res.code}`).toBe(`${s.name}: exit 0`);
      expect(`${s.name}: ${await whoRan(f)}`).toBe(`${s.name}: STALE`);
      expect(res.out).toContain("kept from the plist snapshot");
      await rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("AC-X2 攻撃: allowlist の外の login shell(fish 等)は起こさない", async () => {
    const f = await fixture();
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    // OPENROLY_LOGIN_SHELL を渡さない = 本番と同じ `SHELL` 経由の判定になる
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      SHELL: "/opt/homebrew/bin/fish",
    });
    expect(res.code).toBe(0);
    expect(await whoRan(f)).toBe("STALE");
    expect(res.out).toContain("kept from the plist snapshot");
    await rm(f.root, { recursive: true, force: true });
  });
});

// PBI-0210: broker は `--spec-stdin` で JSON 1 行 `{token, native?}` を渡す。`native` が有れば bundled catalog に
// 無い runtime でも generic adapter を組んで config を書く(rebuild 無しの新 runtime)。実 opencode には到達させない
// (PATH 先頭の fake)。HOME も隔離する —— `~/.config/opencode/opencode.json` を **user の実 file に書かない**
describe("openroly adopt --spec-stdin(PBI-0210)", () => {
  const OPENCODE_NATIVE = {
    home: { default: "~/.config/opencode" },
    bin: "opencode",
    mcp: {
      strategy: "file",
      path: "opencode.json",
      format: "jsonc",
      key: "mcp",
      entry: { type: "local", command: ["${command}", "${args...}"], environment: "${env}", enabled: true },
    },
  };
  const BEFORE = `{
  // keep me
  "theme": "dark",
  "mcp": {
    "playwright": { "type": "local", "command": ["npx", "@playwright/mcp"], "enabled": true } // trailing
  }
}
`;
  const ARGS = ["--kind", "opencode", "--runtime-id", "rt_oc_1", "--base-url", "http://localhost:9999", "--name", "MacBook / OpenCode", "--spec-stdin"];

  async function isolatedHome(): Promise<{ ohome: string; cfg: string }> {
    const ohome = await mkdtemp(join(tmpdir(), "openroly-adopt-oc-"));
    await mkdir(join(ohome, ".config", "opencode"), { recursive: true });
    const cfg = join(ohome, ".config", "opencode", "opencode.json");
    await writeFile(cfg, BEFORE);
    await writeFile(join(bin, "opencode"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; fi\nexit 0\n`);
    await chmod(join(bin, "opencode"), 0o755);
    return { ohome, cfg };
  }

  test("AC-1: {token, native} で opencode.json の mcp.openroly を書き、他 key とコメントは変わらない。credential も保存", async () => {
    const { ohome, cfg } = await isolatedHome();
    const res = await adopt(ARGS, `${JSON.stringify({ token: TOKEN, native: OPENCODE_NATIVE })}\n`, { HOME: ohome, OPENROLY_HOME: join(ohome, ".openroly") });
    expect(res.code, res.err).toBe(0);
    const after = await readFile(cfg, "utf8");
    expect(after).toContain("// keep me");
    expect(after).toContain("// trailing");
    const { parse } = await import("jsonc-parser");
    const doc = parse(after);
    expect(doc.theme).toBe("dark");
    expect(doc.mcp.playwright).toEqual({ type: "local", command: ["npx", "@playwright/mcp"], enabled: true });
    expect(doc.mcp.openroly).toMatchObject({
      type: "local",
      environment: { OPENROLY_RUNTIME_KIND: "opencode", OPENROLY_URL: "http://localhost:9999" },
      enabled: true,
    });
    expect(Array.isArray(doc.mcp.openroly.command) && doc.mcp.openroly.command.length >= 1).toBe(true);
    const creds = JSON.parse(await readFile(join(ohome, ".openroly", "credentials.json"), "utf8"));
    expect(creds.runtimes.opencode).toMatchObject({ runtime_id: "rt_oc_1", token: TOKEN, base_url: "http://localhost:9999" });
    // token は argv に出ない(stdin の JSON の中だけ)
    expect(res.out + res.err).not.toContain(TOKEN);
    await rm(ohome, { recursive: true, force: true });
  });

  test("AC-X2: 壊れた opencode.json には 1 byte も書かず exit 2(1 行目が register_ack の detail)。credential も残さない", async () => {
    const { ohome, cfg } = await isolatedHome();
    const broken = '{ "mcp": { "x": }\n';
    await writeFile(cfg, broken);
    const res = await adopt(ARGS, `${JSON.stringify({ token: TOKEN, native: OPENCODE_NATIVE })}\n`, { HOME: ohome, OPENROLY_HOME: join(ohome, ".openroly") });
    expect(res.code).toBe(2);
    expect(res.err.split("\n")[0]).toContain("could not be parsed");
    expect(await readFile(cfg, "utf8")).toBe(broken);
    // 端末にも死んだ credential を残さない(Cloud は register_ack ok:false で行を revoke するので、
    // ここに残ると「繋がっているのに 401」の runtime が次の hello まで居座る)
    const credsPath = join(ohome, ".openroly", "credentials.json");
    if (existsSync(credsPath)) expect(JSON.parse(await readFile(credsPath, "utf8")).runtimes.opencode).toBeUndefined();
    await rm(ohome, { recursive: true, force: true });
  });

  test("壊れた native / JSON でない stdin は exit 2 で何も書かない", async () => {
    const { ohome, cfg } = await isolatedHome();
    const env = { HOME: ohome, OPENROLY_HOME: join(ohome, ".openroly") };
    const bad = await adopt(ARGS, `${JSON.stringify({ token: TOKEN, native: { mcp: { strategy: "ftp" } } })}\n`, env);
    expect(bad.code).toBe(2);
    expect(bad.err.split("\n")[0]).toContain("native(opencode)");
    const notJson = await adopt(ARGS, `${TOKEN}\n`, env);
    expect(notJson.code).toBe(2);
    expect(notJson.err.split("\n")[0]).toContain("expects one JSON line");
    // native 無し + catalog にも無い kind = unsupported(opencode は catalog に載ったので別 id で測る)
    const none = await adopt(
      ["--kind", "no-such-runtime", "--runtime-id", "rt_x", "--base-url", "http://localhost:9999", "--name", "x", "--spec-stdin"],
      `${JSON.stringify({ token: TOKEN })}\n`,
      env,
    );
    expect(none.code).toBe(2);
    expect(none.err.split("\n")[0]).toContain("unsupported runtime: no-such-runtime");
    expect(await readFile(cfg, "utf8")).toBe(BEFORE);
    expect(existsSync(join(ohome, ".openroly", "credentials.json"))).toBe(false);
    await rm(ohome, { recursive: true, force: true });
  });

  test("旧 broker 互換: --token-stdin(生の token 1 行)は従来どおり通る", async () => {
    const res = await adopt(OK_ARGS, `${TOKEN}\n`);
    expect(res.code).toBe(0);
    const spec = await adopt(OK_ARGS.filter((a) => a !== "--token-stdin").concat("--spec-stdin"), `${JSON.stringify({ token: TOKEN })}\n`);
    expect(spec.code).toBe(0);
  });

  // AC-4: **bundled catalog に無い id** でも、署名検証済み registry から渡された `native` だけで配線できる
  // (= catalog に entry を足せば CLI を再 build せずに新しい runtime が繋がる)。catalog に居る opencode で
  // 通っても、それは「たまたま bundled に有った」経路かもしれないので、居ない id で必ず 1 回測る
  test("AC-4: bundled catalog に無い id でも native だけで config を書く(rebuild 無しの新 runtime)", async () => {
    const { ADAPTERS } = await import("../src/registry.ts");
    expect(ADAPTERS.some((a) => a.id === "superagent")).toBe(false); // 前提: catalog にも official にも居ない
    const ohome = await mkdtemp(join(tmpdir(), "openroly-adopt-super-"));
    await mkdir(join(ohome, ".superagent"), { recursive: true });
    const cfg = join(ohome, ".superagent", "mcp.json");
    await writeFile(cfg, `{\n  "keepMe": 1,\n  "mcpServers": { "other": { "command": "x" } }\n}\n`);
    await writeFile(join(bin, "superagent"), `#!/bin/sh\nexit 0\n`);
    await chmod(join(bin, "superagent"), 0o755);
    const native = {
      home: { default: "~/.superagent" },
      bin: "superagent",
      mcp: {
        strategy: "file",
        path: "mcp.json",
        format: "json",
        key: "mcpServers",
        entry: { command: "${command}", args: "${args}", env: "${env}" },
      },
    };
    const res = await adopt(
      ["--kind", "superagent", "--runtime-id", "rt_sa_1", "--base-url", "http://localhost:9999", "--name", "Mac / SuperAgent", "--spec-stdin"],
      `${JSON.stringify({ token: TOKEN, native })}\n`,
      { HOME: ohome, OPENROLY_HOME: join(ohome, ".openroly") },
    );
    expect(res.code, res.err).toBe(0);
    const doc = JSON.parse(await readFile(cfg, "utf8"));
    expect(doc.keepMe).toBe(1); // 他 key は消えない
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.mcpServers.openroly.env).toMatchObject({ OPENROLY_RUNTIME_KIND: "superagent", OPENROLY_URL: "http://localhost:9999" });
    expect(typeof doc.mcpServers.openroly.command).toBe("string");
    await rm(ohome, { recursive: true, force: true });
  });
});
