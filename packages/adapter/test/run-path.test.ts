import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/contract.ts";

// run() の PATH 補強(PBI-0050 AC-1): launchd が `openroly broker` を最小 PATH で起こした時も、
// adopt → adapter.register → run() がユーザーの install 先(~/.local/bin 等)の runtime CLI を
// 解決できることを固定する。broker の discovery default_bin_dirs と同じ dir を見る。

let root = "";
let home = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-runpath-"));
  home = join(root, "home");
  const localBin = join(home, ".local", "bin");
  await mkdir(localBin, { recursive: true });
  await writeFile(join(localBin, "claude"), "#!/bin/sh\necho resolved \"$0\"\n");
  await chmod(join(localBin, "claude"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// launchd 相当の最小 PATH(本物の launchd は /usr/bin:/bin:/usr/sbin:/sbin しか持たない)。
// home は beforeAll で決まるので、env は呼び出しのたびに組む
const launchdEnv = () => ({ PATH: "/usr/bin:/bin", HOME: home });

describe("run() の PATH 補強 (PBI-0050)", () => {
  test("PATH に無い openroly を $HOME/.openroly/bin から absolute path で解決できる", async () => {
    const bin = join(home, ".openroly", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "openroly"), "#!/bin/sh\necho resolved \"$0\"\n");
    await chmod(join(bin, "openroly"), 0o755);
    const r = await run({ env: launchdEnv() }, ["openroly", "--version"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe(`resolved ${join(bin, "openroly")}`);
  });

  test("PATH に無い grok を $HOME/.grok/bin から absolute path で解決できる", async () => {
    const grokBin = join(home, ".grok", "bin");
    await mkdir(grokBin, { recursive: true });
    await writeFile(join(grokBin, "grok"), "#!/bin/sh\necho resolved \"$0\"\n");
    await chmod(join(grokBin, "grok"), 0o755);
    const r = await run({ env: launchdEnv() }, ["grok", "--version"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe(`resolved ${join(grokBin, "grok")}`);
  });

  test("PATH に無い bare command を $HOME/.local/bin から absolute path で解決できる", async () => {
    // OPENROLY_EXTRA_PATH_DIRS で補強 dir を temp 側へ差し替える(review 2026-08-28) — 実機の
    // /usr/local/bin に claude が居ても(この Mac は 2026-08-28 から居る)fake が shadow されない
    const env = { ...launchdEnv(), OPENROLY_EXTRA_PATH_DIRS: join(home, ".local", "bin") };
    const r = await run({ env }, ["claude", "--version"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain(join(home, ".local", "bin", "claude"));
    // marker file 方式ではなく argv[0] が absolute path になっていることを $0 で観測
    expect(r.stdout.trim()).toBe(`resolved ${join(home, ".local", "bin", "claude")}`);
  });

  test("OPENROLY_EXTRA_PATH_DIRS=空文字 で補強を無効化できる(test 隔離の口・review 2026-08-28)", async () => {
    // 補強が効いたままだと実 /usr/local/bin の claude を拾う環境でも、空文字なら補強 dir は
    // 1 つも見ずに「見つかりません」で落ちる — 「CLI 無し」の test が実機に依存しないことの固定
    const env = { ...launchdEnv(), OPENROLY_EXTRA_PATH_DIRS: "" };
    expect(() => run({ env }, ["claude", "--version"])).toThrow(/claude was not found/);
  });

  test("PATH に有る command は従来どおり PATH から解決される(/bin の内蔵 command)", async () => {
    const r = await run({ env: launchdEnv() }, ["echo", "ok"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("ok");
  });

  test("PATH に '/' を含む command は補強せずそのまま渡す(絶対 path 指定は明示指定)", async () => {
    const r = await run({ env: launchdEnv() }, ["/bin/echo", "explicit"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("explicit");
  });

  // AC-X2: ENOENT の生 stack trace ではなく「見つからない」を含む 1 行
  test("どこにも無い command は名前の付いた Error(ENOENT の生を晒さない)", async () => {
    expect(() => run({ env: launchdEnv() }, ["no-such-openroly-runtime-cli"]))
      .toThrow(/no-such-openroly-runtime-cli was not found/);
  });

  test("HOME が無い env では固定 dir(/usr/local/bin 等)だけ補強する", async () => {
    // HOME 無しでも throw しない(補強 dir 一覧が空にはならない)
    await expect(run({ env: { PATH: "/usr/bin:/bin" } }, ["echo", "x"])).resolves.toMatchObject({ ok: true });
    expect(() => run({ env: { PATH: "/usr/bin:/bin" } }, ["no-such-openroly-runtime-cli"])).toThrow(
      /was not found/,
    );
  });
});
