import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PBI-0236 有界レビュー(2026-09-04)の攻撃 test。
// 急所は AC-X1(`runtime_cli_not_found` が `openroly_cli_not_found` と混ざらないか)と、
// (b) 案の代償 —— login shell を 1 回起こす副作用(遅い / 汚れる / 二重起動)。
// 実 CLI には到達させない(EP-0001 LEARN 13): PATH の先頭に fake を置いて marker で観測する。

const CLI = join(import.meta.dir, "../src/openroly.ts");
const TOKEN = "par_0236_attack_token";
/** freshLoginPath() が自分で名乗っている閉じ込め(LOGIN_SHELL_TIMEOUT_MS = 5s)+ bun の起動余裕 */
const PROBE_BUDGET_MS = 15_000;

let base = "";
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "openroly-0236-atk-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  home: string;
  stale: string;
  fresh: string;
  marker: string;
  spy: string;
  shell: string;
}

/**
 * fake の runtime CLI を stale / fresh の 2 か所に置き、fresh を PATH に入れる fake login shell を作る。
 * login shell は argv が `-l -i -c <script>` である事を自分で固定し(違えば exit 9)、`-c` の中身は
 * 本物のまま実行する。`/bin/sh -c` で実行するのは、`-l` を付け直すと macOS の path_helper が
 * /etc/paths を足して実機の CLI が fake に勝つため(PBI-0236 実装 session が踏んだ罠)。
 */
async function fixture(
  tag: string,
  opts: { bin?: string; staleBody?: string; freshBody?: string; shellPreamble?: string } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(base, `${tag}-`));
  const home = join(root, "home");
  const stale = join(root, "stale-bin");
  const fresh = join(root, "fresh-bin");
  const marker = join(root, "ran.log");
  const spy = join(root, "shell-calls.log");
  for (const d of [home, stale, fresh]) await mkdir(d, { recursive: true });

  const bin = opts.bin ?? "codex";
  const body = (t: string) => `#!/bin/sh\necho "${t} $@" >> ${marker}\nexit 0\n`;
  if (opts.staleBody !== null) await writeFile(join(stale, bin), opts.staleBody ?? body("STALE"));
  await writeFile(join(fresh, bin), opts.freshBody ?? body("FRESH"));
  await chmod(join(stale, bin), 0o755).catch(() => null);
  await chmod(join(fresh, bin), 0o755);

  const shell = join(root, "login-shell");
  await writeFile(
    shell,
    `#!/bin/sh\necho call >> ${spy}\n` +
      `[ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 9\n` +
      (opts.shellPreamble ?? "") +
      `PATH="${fresh}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh -c "$4"\n`,
  );
  await chmod(shell, 0o755);
  return { root, home, stale, fresh, marker, spy, shell };
}

async function runAdopt(
  f: Fixture,
  env: Record<string, string>,
  kind = "codex",
): Promise<{ code: number; out: string; err: string; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn(
    [
      process.execPath, CLI, "adopt",
      "--kind", kind,
      "--runtime-id", "rt_0236_atk",
      "--base-url", "http://localhost:9999",
      "--name", "MacBook / Attack",
      "--token-stdin",
    ],
    {
      env: {
        HOME: f.home,
        OPENROLY_HOME: f.home,
        CLAUDE_CONFIG_DIR: f.home,
        OPENROLY_EXTRA_PATH_DIRS: "", // 実機の /usr/local/bin の本物に負けないよう決定化する
        ...env,
      },
      stdin: new TextEncoder().encode(`${TOKEN}\n`),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err, ms: Date.now() - started };
}

async function whoRan(f: Fixture): Promise<string> {
  const log = await readFile(f.marker, "utf8").catch(() => "");
  return log
    .split("\n")
    .filter((l) => l.includes("mcp add"))
    .map((l) => l.split(" ")[0]!)
    .join(",");
}

async function shellCalls(f: Fixture): Promise<number> {
  const log = await readFile(f.spy, "utf8").catch(() => "");
  return log.split("\n").filter(Boolean).length;
}

describe("PBI-0236 攻撃: probe の閉じ込め / 名前の分離", () => {
  test("攻撃1: rc file が背景に子を残しても、probe は自分の名乗る 5 秒で諦める", async () => {
    // 実物の .zshrc は背景 daemon を起こす(powerlevel10k の gitstatusd・zsh-async・mise 等)。
    // 子は shell の stdout を継承するので、**shell を kill(9) しても pipe は閉じない**。
    // 「5 秒で kill → snapshot に落ちる」を shell の生死だけで測っていると、ここが素通りする。
    const f = await fixture("bgchild", { shellPreamble: "sleep 25 &\n" });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(0);
    expect(res.ms).toBeLessThan(PROBE_BUDGET_MS);
  }, 60_000);

  test("攻撃2: 黙る login shell(AC-X2)は 5 秒で諦める —— 時間まで測る", async () => {
    // AC-X2 は exit 0 と STALE だけを見ており、**timer を消しても緑のまま**通る。
    const f = await fixture("mute", { shellPreamble: "" });
    await writeFile(f.shell, `#!/bin/sh\necho call >> ${f.spy}\nexec sleep 45\n`);
    await chmod(f.shell, 0o755);
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(0);
    expect(await whoRan(f)).toBe("STALE");
    expect(res.ms).toBeLessThan(PROBE_BUDGET_MS);
  }, 90_000);

  test("攻撃3: probe は adopt 1 回につき 1 回だけ(run() は remove/add の 2 回叩く)", async () => {
    const f = await fixture("once");
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(0);
    expect(await shellCalls(f)).toBe(1);
  }, 60_000);

  test("攻撃4: login shell の env は PATH 以外 1 つも runtime CLI に漏れない", async () => {
    // interactive shell は rc file で大量に export する(NVM_BIN・VIRTUAL_ENV・PROMPT 等)。
    // それが `codex mcp add` の env に混ざると、登録される MCP server の環境が端末ごとに割れる。
    const leak = join(base, "leak.log");
    const f = await fixture("leak", { shellPreamble: `OpenRoly_LEAKED=yes\nexport OpenRoly_LEAKED\n` });
    await writeFile(
      join(f.fresh, "codex"),
      `#!/bin/sh\necho "FRESH $@" >> ${f.marker}\necho "leaked=[\${OpenRoly_LEAKED}]" >> ${leak}\nexit 0\n`,
    );
    await chmod(join(f.fresh, "codex"), 0o755);
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(0);
    expect(await whoRan(f)).toBe("FRESH"); // fresh 側が走った = probe は効いている
    expect(await readFile(leak, "utf8")).not.toContain("yes");
  }, 60_000);

  test("攻撃5: fresh に無く snapshot にだけ在る dir(direnv 等)を捨てない", async () => {
    // 「fresh を先頭に」だけを守って snapshot を落とすと、login を打った shell にしか無かった
    // dir が消え、今日まで動いていた端末が壊れる。fresh 側から CLI を消して観測する。
    const f = await fixture("keepsnap");
    await rm(join(f.fresh, "codex"), { force: true });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(0);
    expect(await whoRan(f)).toBe("STALE");
  }, 60_000);

  test("攻撃6: AC-X1 は codex 固有ではない —— claude でも同じ名前が付く", async () => {
    const f = await fixture("claude", { bin: "claude" });
    await rm(join(f.stale, "claude"), { force: true });
    await rm(join(f.fresh, "claude"), { force: true });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(
      f,
      { PATH: snapshot, OPENROLY_LOGIN_PATH: snapshot, OPENROLY_LOGIN_SHELL: f.shell },
      "claude",
    );
    expect(res.code).toBe(2);
    const first = res.err.split("\n")[0]!;
    expect(first.startsWith("runtime_cli_not_found")).toBe(true);
    expect(first).not.toContain("openroly_cli_not_found");
    // broker は detail を 200 字で切る。名前が頭に在っても、切られて意味が消えては困らない事を固定
    expect(first.length).toBeLessThanOrEqual(200);
  }, 60_000);

  test("攻撃7: 在る CLI が `runtime_cli_not_found:` と喋っても、その名前を名乗らせない", async () => {
    // 名前で分岐する以上、下流が同じ語を stderr に出した時に **偽の陽性**が立たない事が要る
    // (立つと「CLI が無い」と「CLI が在って別の理由で落ちた」がまた同じ顔になる)。
    // 実機の負荷で probe が 5 秒に負けても結論が変わらないよう、**両方の dir**に同じ物を置く
    const spoof = `#!/bin/sh\necho "runtime_cli_not_found: totally not me" >&2\nexit 3\n`;
    const f = await fixture("spoof", { freshBody: spoof, staleBody: spoof });
    const snapshot = `${f.stale}:/usr/bin:/bin`;
    const res = await runAdopt(f, {
      PATH: snapshot,
      OPENROLY_LOGIN_PATH: snapshot,
      OPENROLY_LOGIN_SHELL: f.shell,
    });
    expect(res.code).toBe(2);
    const first = res.err.split("\n")[0]!;
    expect(first.startsWith("runtime_cli_not_found")).toBe(false);
    expect(first).toContain("registering the MCP server failed");
  }, 60_000);
});
