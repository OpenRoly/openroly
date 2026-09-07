import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryTarget, ensureBinary } from "@openroly/adapter";

// PBI-0154 AC-3/X1/X2: bun も cargo も無い配布先で `openroly login` が broker binary を
// 公開 Release から取ってくる。取得の形自体(checksum 必須・tmp→rename)は PBI-0137 の
// ensureBinary と共通なので、ここでは name="openroly-broker" の 3 経路(取得成功・checksum 不一致・
// 未対応 OS/arch)だけを見る(binary-fetch.test.ts の openroly-mcp 版と対称)。
//
// `openroly login` からの呼び出し配線(ensureBrokerBinary → resolveBrokerBin の download 先追加)は
// 実 repo checkout に broker/target/{release,debug}/openroly-broker が既に存在しうる dev tree の上で
// black-box に spawn すると、その実 binary を先に拾ってしまい検証にならない
// (REPO_ROOT は openroly.ts 自身の実ファイル位置から固定で計算される)。build artifact を
// 一時退避して検証する手も検討したが、並行 session が同じ tree で cargo build を走らせている
// 可能性がある(前例あり)ため避け、配線自体は diagrams-check.sh の grep 規則(PBI-0154)で
// 静的に固定する

const VERSION = "9.9.9";
const TARGET = binaryTarget()!; // host の target(darwin-arm64 等)
const ASSET = `openroly-broker-${TARGET}`;
const BODY = "#!/bin/sh\necho fake-broker\n";
const SHA = new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(BODY)).digest("hex");

let requests: string[] = [];
/** checksum を壊すか / SHA256SUMS を無くすか を test ごとに切り替える */
let mode: "ok" | "bad-checksum" | "no-sums" = "ok";

const release = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    if (path === `/v${VERSION}/SHA256SUMS`) {
      if (mode === "no-sums") return new Response("not found", { status: 404 });
      const sum = mode === "bad-checksum" ? "0".repeat(64) : SHA;
      return new Response(`${sum}  ${ASSET}\n`);
    }
    if (path === `/v${VERSION}/${ASSET}`) return new Response(BODY);
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
const binPath = () => join(home, "bin", "openroly-broker");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openroly-broker-binfetch-"));
  requests = [];
  mode = "ok";
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function leftovers(): Promise<string[]> {
  return (await readdir(join(home, "bin")).catch(() => [])).filter((f) => f.includes(".tmp"));
}

describe('ensureBinary("openroly-broker") — 取得と検証 (PBI-0154)', () => {
  test("AC-3: bin が空・network 有りなら公開 Release から download して実行可能な状態で置く", async () => {
    const outcome = await ensureBinary("openroly-broker", { env: envFor() });
    expect(outcome).toMatchObject({ status: "downloaded", path: binPath(), target: TARGET });

    expect(await readFile(binPath(), "utf8")).toBe(BODY);
    expect((await stat(binPath())).mode & 0o111).toBeGreaterThan(0); // 実行可能
    expect((await readFile(`${binPath()}.version`, "utf8")).trim()).toBe(VERSION);
    expect(await leftovers()).toEqual([]);
    // checksum を先に取ってから本体を引く(66MB 級を引いてから「表が無い」と分かるのは無駄)
    expect(requests).toEqual([`/v${VERSION}/SHA256SUMS`, `/v${VERSION}/${ASSET}`]);
  });

  test("AC-3: 同じ version が既に置いてあれば再 download しない", async () => {
    await ensureBinary("openroly-broker", { env: envFor() });
    const after = requests.length;
    const outcome = await ensureBinary("openroly-broker", { env: envFor() });
    expect(outcome).toMatchObject({ status: "present", path: binPath() });
    expect(requests.length).toBe(after);
  });

  // review: 取得先に置いた broker を「在るから何もしない」で固定すると、openroly を新しくしても
  // broker だけ旧版が residual に残る。stamp が古ければ引き直すことを name="openroly-broker" でも見る
  test("版が上がったら取り直す(初回に取った broker が古いまま固定されない)", async () => {
    await Bun.write(binPath(), "old-broker\n");
    await Bun.write(`${binPath()}.version`, "0.0.1\n");
    requests = [];

    const outcome = await ensureBinary("openroly-broker", { env: envFor() });
    expect(outcome).toMatchObject({ status: "downloaded", path: binPath() });
    expect(await readFile(binPath(), "utf8")).toBe(BODY);
    expect((await readFile(`${binPath()}.version`, "utf8")).trim()).toBe(VERSION);
    expect(requests).toEqual([`/v${VERSION}/SHA256SUMS`, `/v${VERSION}/${ASSET}`]);
  });

  test("AC-X1: checksum 不一致なら置かない(中途半端な file も版の印も残さない)", async () => {
    mode = "bad-checksum";
    const outcome = await ensureBinary("openroly-broker", { env: envFor() });
    expect(outcome.status).toBe("checksum_mismatch");
    expect(await Bun.file(binPath()).exists()).toBe(false);
    expect(await Bun.file(`${binPath()}.version`).exists()).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  test("AC-X1: SHA256SUMS 自体が無ければ本体を引かず unavailable に倒れる(壊れた物を流さない前段)", async () => {
    mode = "no-sums";
    const outcome = await ensureBinary("openroly-broker", { env: envFor() });
    expect(outcome.status).toBe("unavailable");
    expect(requests).toEqual([`/v${VERSION}/SHA256SUMS`]); // asset 本体は引いていない
    expect(await Bun.file(binPath()).exists()).toBe(false);
  });

  test("AC-X2: 未対応 OS/arch なら取りに行かず unsupported(request 0・回帰なしで cargo 案内に倒せる)", async () => {
    const outcome = await ensureBinary("openroly-broker", {
      env: envFor(),
      platform: "win32",
      arch: "arm64",
    });
    expect(outcome).toMatchObject({ status: "unsupported" });
    expect(outcome.status === "unsupported" && outcome.detail).toContain("win32/arm64");
    expect(requests).toEqual([]);
  });

  test("取得できない(server 断)なら unavailable に倒れ、置かない(呼び出し側は cargo 案内へ fallback できる)", async () => {
    const outcome = await ensureBinary("openroly-broker", {
      env: envFor({ OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1" }),
    });
    expect(outcome.status).toBe("unavailable");
    expect(await Bun.file(binPath()).exists()).toBe(false);
  });
});

// ---- Release workflow の形(broker 3 target。AC-2 は tag を打つまで実測できないので機械で固定) ----

describe("release workflow の broker 面 (PBI-0154 AC-2)", () => {
  test("darwin-arm64 / darwin-x64 / linux-x64 の openroly-broker asset を組み立てて SHA256SUMS に含める", async () => {
    const yml = await readFile(
      fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)),
      "utf8",
    );
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      expect(yml).toContain(`dist/openroly-broker-${target}`);
    }
    expect(yml).toContain("openroly-broker-*"); // SHA256SUMS の対象に含まれる
    expect(yml).toContain("OPENROLY_REGISTRY_PUBLIC_KEY");
    expect(yml).toContain("cargo build --release");
    // darwin の 2 target を 1 job(macOS runner)で作る設計 — cross target 追加は ubuntu からは無理
    expect(yml).toContain("rustup target add x86_64-apple-darwin");
  });
});

// ---- 取得側 2 実装の版が揃っている(PBI-0154 で TS 側だけ上げると plugin 経路が旧 tag を引く) ----

describe("launcher(sh)と ensureBinary(TS)の既定 version (PBI-0154 review)", () => {
  test("同じ version を既定にする — 片方だけ上げると plugin 経路が存在しない tag を引きに行く", async () => {
    const root = new URL("../../../", import.meta.url);
    const ts = await readFile(fileURLToPath(new URL("packages/adapter/src/binary.ts", root)), "utf8");
    const sh = await readFile(fileURLToPath(new URL("packages/mcp/openroly-mcp", root)), "utf8");
    const claude = await readFile(
      fileURLToPath(new URL("adapters/official/claude/openroly-mcp", root)),
      "utf8",
    );

    const tsVersion = ts.match(/OPENROLY_BINARY_VERSION = "([0-9][0-9.]*)"/)?.[1];
    const shVersion = sh.match(/OPENROLY_BINARY_VERSION:-([0-9][0-9.]*)\}/)?.[1];
    expect(tsVersion).toBeTruthy();
    expect(shVersion).toBe(tsVersion!);
    const codex = await readFile(
      fileURLToPath(new URL("adapters/official/codex/openroly-mcp", root)),
      "utf8",
    );
    expect(claude).toBe(sh); // plugin 側 copy も同一
    expect(codex).toBe(sh);
  });
});
