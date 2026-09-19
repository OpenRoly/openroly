import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryTarget,
  ensureBinary,
  installRuntime,
  resolveMcpServerCommand,
  saveCredential,
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type RegisterInput,
  type ExtensionAdapter,
} from "@openroly/adapter";

// PBI-0137 AC-2〜7 / X1〜X3: 公開 Release から binary を取ってきて `~/.openroly/bin` に置く。
// stub の Release server から偽 binary を配り、**実際に置かれた file** を見る。
//
// 失敗は全部 bun 経路への fallback に倒す(network が無いだけで install を失敗させない)。
// ただし checksum 不一致だけは置かない —— 壊れた / すり替えられた binary を黙って流さない。

const VERSION = "9.9.9";
const TARGET = binaryTarget()!; // host の target(darwin-arm64 等)
const ASSET = `openroly-mcp-${TARGET}`;
const BODY = "#!/bin/sh\necho fake-binary\n";
const SHA = new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(BODY)).digest("hex");

let requests: string[] = [];
let authHeaders: string[] = [];
/** checksum を壊すか / 途中で切るか を test ごとに切り替える */
let mode: "ok" | "bad-checksum" | "no-sums" | "truncate" = "ok";

const release = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    const auth = req.headers.get("authorization");
    if (auth) authHeaders.push(auth);

    if (path === `/v${VERSION}/SHA256SUMS`) {
      if (mode === "no-sums") return new Response("not found", { status: 404 });
      const sum = mode === "bad-checksum" ? "0".repeat(64) : SHA;
      // 似た名前の行を先に置く: 部分一致で拾う実装なら別 asset の hash を使ってしまう
      return new Response(`${"1".repeat(64)}  ${ASSET}-old\n${sum}  ${ASSET}\n`);
    }
    if (path === `/v${VERSION}/${ASSET}`) {
      // 途中で切れた応答(download 中断)= 全部は届かなかった bytes
      if (mode === "truncate") return new Response(BODY.slice(0, 9));
      return new Response(BODY);
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://localhost:${release.port}`;
afterAll(() => release.stop(true));

let home = "";
const envFor = (extra: Record<string, string> = {}) => ({
  OPENROLY_HOME: home,
  OPENROLY_BINARY_BASE_URL: BASE,
  OPENROLY_BINARY_VERSION: VERSION,
  ...extra,
});
const binPath = () => join(home, "bin", "openroly-mcp");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-binfetch-"));
  requests = [];
  authHeaders = [];
  mode = "ok";
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** dir に中途半端な file(tmp)が残っていないこと */
async function leftovers(): Promise<string[]> {
  return (await readdir(join(home, "bin")).catch(() => [])).filter((f) => f.includes(".tmp"));
}

describe("ensureBinary — 取得と検証 (PBI-0137)", () => {
  test("AC-2: bin が空・network 有りなら download して実行可能な状態で置く", async () => {
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome).toMatchObject({ status: "downloaded", path: binPath(), target: TARGET });

    expect(await readFile(binPath(), "utf8")).toBe(BODY);
    expect((await stat(binPath())).mode & 0o111).toBeGreaterThan(0);
    expect((await readFile(`${binPath()}.version`, "utf8")).trim()).toBe(VERSION);
    expect(await leftovers()).toEqual([]);
  });

  test("AC-3: 置いた後は MCP 設定の command が binary になる(bun を含まない)", async () => {
    await ensureBinary("openroly-mcp", { env: envFor() });
    const resolved = resolveMcpServerCommand("/repo/packages/mcp/src/server.ts", envFor());
    expect(resolved).toEqual({ command: binPath(), args: [] });
    expect(JSON.stringify(resolved)).not.toContain("bun");
  });

  test("AC-4: checksum 不一致なら置かない(中途半端な file も残さない)", async () => {
    mode = "bad-checksum";
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome.status).toBe("checksum_mismatch");
    expect(await Bun.file(binPath()).exists()).toBe(false);
    expect(await leftovers()).toEqual([]);
    // 壊れた物を「置いた」ことにしない = 版の印も書かない
    expect(await Bun.file(`${binPath()}.version`).exists()).toBe(false);
  });

  test("AC-5: 取れない(server 断)なら unavailable に倒れ、置かない", async () => {
    const outcome = await ensureBinary("openroly-mcp", {
      env: envFor({ OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1" }),
    });
    expect(outcome.status).toBe("unavailable");
    expect(await Bun.file(binPath()).exists()).toBe(false);
  });

  test("AC-6: 未対応 OS/arch なら取りに行かない(request 0)", async () => {
    const outcome = await ensureBinary("openroly-mcp", {
      env: envFor(),
      platform: "win32",
      arch: "arm64",
    });
    expect(outcome).toMatchObject({ status: "unsupported" });
    expect(outcome.status === "unsupported" && outcome.detail).toContain("win32/arm64");
    expect(requests).toEqual([]);
  });

  test("AC-7: 同じ version が置いてあれば再 download しない", async () => {
    await ensureBinary("openroly-mcp", { env: envFor() });
    const after = requests.length;
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome).toMatchObject({ status: "present", path: binPath() });
    expect(requests.length).toBe(after);
  });

  test("AC-X1: 公開 Release だけを叩く(Authorization を送らない)・permission は 0755", async () => {
    await ensureBinary("openroly-mcp", { env: envFor() });
    expect(authHeaders).toEqual([]);
    expect((await stat(join(home, "bin"))).mode & 0o777).toBe(0o755);
    expect((await stat(binPath())).mode & 0o777).toBe(0o755);
  });

  test("AC-X2: download が中断したら中途半端な file を残さない", async () => {
    // 中断は「全部は届かなかった bytes」として現れる。checksum がそれを掴み、
    // tmp → rename なので `~/.openroly/bin/openroly-mcp` は最後まで存在しない
    mode = "truncate";
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome.status).toBe("checksum_mismatch");
    expect(await Bun.file(binPath()).exists()).toBe(false);
    expect(await leftovers()).toEqual([]);

    // 次の試行は普通に成功する(壊れた印が残って詰まらない)
    mode = "ok";
    expect((await ensureBinary("openroly-mcp", { env: envFor() })).status).toBe("downloaded");
  });

  test("AC-X3: SHA256SUMS が無ければ binary を引かない(照合を必ず通す)", async () => {
    mode = "no-sums";
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome.status).toBe("unavailable");
    expect(requests).toEqual([`/v${VERSION}/SHA256SUMS`]); // asset 本体は引いていない
    expect(await Bun.file(binPath()).exists()).toBe(false);
  });

  // ---- 攻撃 ----
  test("攻撃: 似た名前の行(<asset>-old)の hash を掴まない", async () => {
    // SHA256SUMS の 1 行目は `<asset>-old`。部分一致で拾う実装ならここで checksum_mismatch になる
    expect((await ensureBinary("openroly-mcp", { env: envFor() })).status).toBe("downloaded");
  });

  test("攻撃: 版の印だけ在って binary が消えていれば取り直す", async () => {
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(`${binPath()}.version`, `${VERSION}\n`);
    const outcome = await ensureBinary("openroly-mcp", { env: envFor() });
    expect(outcome.status).toBe("downloaded");
    expect(await Bun.file(binPath()).exists()).toBe(true);
  });

  test("攻撃: 古い version が置いてあれば取り直す(印が新しくなる)", async () => {
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(binPath(), "old");
    await chmod(binPath(), 0o755);
    await writeFile(`${binPath()}.version`, "0.0.1\n");
    expect((await ensureBinary("openroly-mcp", { env: envFor() })).status).toBe("downloaded");
    expect(await readFile(binPath(), "utf8")).toBe(BODY);
    expect((await readFile(`${binPath()}.version`, "utf8")).trim()).toBe(VERSION);
  });
});

// ---- install 経路(AC-2/3/5 を engine 越しに) ----

const registered: RegisterInput[] = [];
const fakeAdapter: ExtensionAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: STAGE0_CAPABILITIES,
  detect: async () => ({ installed: true, detail: "fake 1.0.0" }),
  register: async (_ctx, input) => {
    registered.push(input);
  },
  unregister: async () => {},
  doctor: async () => [{ ok: true, label: "MCP 登録", detail: "あり" }],
  extensionKinds: ["mcp"],
  listExtensions: async () => [],
  applyExtension: async () => {},
  exportExtensions: async () => [],
  watchPaths: () => [],
};
const ctx: AdapterContext = { env: {} };

const account = Bun.serve({
  port: 0,
  fetch: () => Response.json({ agent_id: "agt_x", handle: "aya", unread: 0 }),
});
afterAll(() => account.stop(true));

async function installWith(env: Record<string, string>) {
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_1",
      token: "par_x",
      base_url: `http://localhost:${account.port}`,
      name: "MacBook / Claude Code",
      paired_at: new Date().toISOString(),
    },
    env,
  );
  return installRuntime({
    adapter: fakeAdapter,
    ctx,
    env,
    onPrompt: () => {},
    sleep: async () => {},
    now: () => 0,
  });
}

describe("openroly install からの取得 (PBI-0137)", () => {
  test("AC-2/3: install が binary を置き、finding にそれを出す", async () => {
    const outcome = await installWith(envFor());
    expect(outcome.status).toBe("installed");
    expect(await Bun.file(binPath()).exists()).toBe(true);

    const finding = outcome.status === "installed" && outcome.findings[0];
    expect(finding).toMatchObject({ ok: true, label: "MCP binary" });
    expect(finding && finding.detail).toContain(TARGET);
    // register は binary が置かれた**後**に走る(順序が逆だと今回の install だけ bun のまま)
    expect(resolveMcpServerCommand(registered.at(-1)!.serverEntry, envFor()).command).toBe(binPath());
  });

  test("AC-5: 取れなくても install は成功し、bun 経路である事を出す", async () => {
    const outcome = await installWith(envFor({ OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1" }));
    expect(outcome.status).toBe("installed");
    const finding = outcome.status === "installed" && outcome.findings[0];
    // ここを ok:false にすると network が無いだけで `openroly install` が exit 1 になる
    expect(finding).toMatchObject({ ok: true, label: "MCP binary" });
    expect(finding && finding.detail).toContain("bun path");
  });
});

// ---- launcher の最後の手段(sh 側の取得) ----

const LAUNCHER = fileURLToPath(
  new URL("../../../adapters/official/claude/openroly-mcp", import.meta.url),
);

describe("launcher の最後の手段 (PBI-0137)", () => {
  test("binary も bun も無ければ Release から取ってきて exec する", async () => {
    // これが「end user の bun 依存 0」の芯: plugin だけ入れた人は `openroly install` を走らせない
    const empty = join(home, "empty-path");
    const marker = join(home, "exec.log");
    await mkdir(empty, { recursive: true });
    const res = Bun.spawn([LAUNCHER, "/nonexistent/bundle.js"], {
      env: {
        PATH: `${empty}:/usr/bin:/bin`, // bun は PATH に居ない
        HOME: home,
        OPENROLY_HOME: home,
        OPENROLY_BINARY_BASE_URL: BASE,
        OPENROLY_BINARY_VERSION: VERSION,
        OPENROLY_EXEC_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(res.stdout).text(), res.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("fake-binary\n"); // 取ってきた binary が実際に exec された
    expect(await Bun.file(binPath()).exists()).toBe(true);
    expect((await stat(binPath())).mode & 0o111).toBeGreaterThan(0);
    expect(await leftovers()).toEqual([]);
  }, 60_000);

  test("攻撃: checksum が合わなければ取ってきた物を置かず exec もしない", async () => {
    mode = "bad-checksum";
    const empty = join(home, "empty-path");
    await mkdir(empty, { recursive: true });
    const res = Bun.spawn([LAUNCHER, "/nonexistent/bundle.js"], {
      env: {
        PATH: `${empty}:/usr/bin:/bin`,
        HOME: home,
        OPENROLY_HOME: home,
        OPENROLY_BINARY_BASE_URL: BASE,
        OPENROLY_BINARY_VERSION: VERSION,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(res.stdout).text(),
      new Response(res.stderr).text(),
      res.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe(""); // MCP は stdio。失敗経路でも 1 byte も出さない
    expect(stderr).toContain("fetching it from the public Release was also tried");
    expect(await Bun.file(binPath()).exists()).toBe(false);
    expect(await leftovers()).toEqual([]);
  }, 60_000);
});

// ---- Release workflow(AC-1 は tag を打つまで実測できないので、形を機械で固定する) ----

describe("release workflow の形 (PBI-0137 AC-1)", () => {
  test("3 target × 2 binary + SHA256SUMS を tag push で添付する", async () => {
    const yml = await readFile(
      fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)),
      "utf8",
    );
    expect(yml).toContain('tags: ["v*"]');
    expect(yml).toContain("contents: write");
    expect(yml).toContain("./scripts/build-binaries.sh --out dist");
    expect(yml).toContain("SHA256SUMS");

    // asset 名は取得側(ensureBinary / launcher)が組み立てる名前と一致していなければ 404 になる
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      for (const name of ["openroly-mcp", "openroly"]) {
        expect(yml).toContain(`dist/${name}-${target}`);
      }
    }
  });

  test("workflow と build script が同じ target を配る", async () => {
    const script = await readFile(
      fileURLToPath(new URL("../../../scripts/build-binaries.sh", import.meta.url)),
      "utf8",
    );
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      expect(script).toContain(`bun-${target}`);
    }
    // 取得側が知っている target 集合と同じ(片方だけ増えたら 404 / 取り漏らしになる)
    expect(binaryTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(binaryTarget("darwin", "x64")).toBe("darwin-x64");
    expect(binaryTarget("linux", "x64")).toBe("linux-x64");
    expect(binaryTarget("win32", "x64")).toBeUndefined();
  });
});

// ---- 公開する前に検査を通す(PBI-0647) ----
//
// public-ci は tag を無視する(`tags-ignore: ["**"]`)ので、**tag が指す commit には検査が 1 つも
// 走らない**。そこを塞ぐ配線がこの 2 つで、外れると typecheck も `bun test` も PAAP conformance も
// 通っていない binary に Sigstore の provenance が付き、`openroly install` が全利用者に配る。
//
// **上の block の `toContain` と違い、ここは YAML として読む** —— 綴りを本文から grep すると
// 「そう書いてあるコメント」にも当たり、配線が消えていても緑になる。
//
// これが測るのは **配線が在る事だけ**。門が実際に公開を止めるかは、赤い commit に tag を打って
// Release が出ない事を見るまで分からない(AC-3・owner 実施)。

describe("release は検査が緑の時だけ公開する (PBI-0647)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML は外形だけ見る
  const workflow = (name: string): any =>
    Bun.YAML.parse(
      readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), "utf8"),
    );

  test("AC-1: 公開する job は verify を待ち、verify は public-ci を呼ぶ(job を書き写さない)", () => {
    const release = workflow("release.yml");
    expect(release.jobs.release.needs).toContain("verify");
    expect(release.jobs.verify.uses).toBe("./.github/workflows/public-ci.yml");
    // 呼ぶ側に job の中身が生えていたら、2 箇所に置いた時点でずれ始める
    expect(release.jobs.verify.steps).toBeUndefined();
  });

  test("AC-2: public-ci は呼び出せて、tag では今までどおり自分では走らない(二重に走らせない)", () => {
    const publicCi = workflow("public-ci.yml");
    expect(publicCi.on).toHaveProperty("workflow_call");
    expect(publicCi.on.push["tags-ignore"]).toEqual(["**"]);
  });
});
