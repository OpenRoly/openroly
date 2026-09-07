import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openrolyHome } from "./credentials.ts";

// 単体実行ファイルの取得(PBI-0137)。PBI-0132 が「置いてあれば bun を使わない」を作ったので、
// ここが「置いてある状態を配布で作る」を担う —— ここまでで end user の bun 依存が 0 になる。
//
// 置き場は credential と同じ OPENROLY_HOME(`~/.openroly/bin`)。**公開 Release からの取得だけ**を扱い、
// token を要求しない(要求する配布物なら、それは私的な binary なので手で置く方が正しい)。
//
// 同じ取得は launcher(`packages/mcp/openroly-mcp`)にも sh で在る —— bun も binary も無い環境では
// TypeScript を動かす手段自体が無いため。URL の形・checksum の必須・tmp → rename は
// 両方で同じ(diagrams-check の PBI-0137 規則が version と URL の形を両側で固定する)。

/** Release の tag。`v${OPENROLY_BINARY_VERSION}` が tag 名になる(plugin.json の version と一致させる) */
export const OPENROLY_BINARY_VERSION = "0.2.3";

/** 公開 Release の置き場。private な mirror へ向けたい時は `OPENROLY_BINARY_BASE_URL` で差し替える */
export const DEFAULT_BINARY_BASE_URL =
  "https://github.com/openroly/openroly/releases/download";

type Env = Record<string, string | undefined>;

/** 配る 3 target。increase は `scripts/build-binaries.sh` と workflow に 1 行足すだけ */
export function binaryTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return undefined;
}

export function binDir(env: Env = process.env): string {
  return join(openrolyHome(env), "bin");
}

export type EnsureBinaryOutcome =
  /** 既に同じ version が置いてある(download しない) */
  | { status: "present"; path: string }
  | { status: "downloaded"; path: string; target: string }
  /** 未対応 OS/arch。bun 経路のまま使う */
  | { status: "unsupported"; detail: string }
  /** 取れなかった(offline / Release 未公開 / 500)。bun 経路のまま使う */
  | { status: "unavailable"; detail: string }
  /** 取れたが SHA256 が合わない。**置かない** */
  | { status: "checksum_mismatch"; detail: string };

export interface EnsureBinaryOptions {
  env?: Env;
  version?: string;
  baseUrl?: string;
  /** test から stub HTTP server を刺すため */
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
}

/** `<hash>  <asset>` の並びから 1 つ引く。asset 名の完全一致だけを見る(部分一致で取り違えない) */
function sha256From(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (rest.at(-1) === asset && hash && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return undefined;
}

/**
 * `~/.openroly/bin/<name>` を「公開 Release から取ってきて置く」まで面倒を見る。
 *
 * 失敗は**全部 fallback**(bun 経路)に倒す —— ここで throw すると、network が無いだけで
 * `openroly install` そのものが失敗し、従来どおり動くはずの人まで止めてしまう。
 * ただし checksum 不一致だけは黙って落とさない(壊れた / すり替えられた binary を使わせない)。
 */
export async function ensureBinary(
  name: "openroly-mcp" | "openroly" | "openroly-broker",
  options: EnsureBinaryOptions = {},
): Promise<EnsureBinaryOutcome> {
  const env = options.env ?? process.env;
  const version = options.version ?? env.OPENROLY_BINARY_VERSION ?? OPENROLY_BINARY_VERSION;
  const base = (options.baseUrl ?? env.OPENROLY_BINARY_BASE_URL ?? DEFAULT_BINARY_BASE_URL).replace(
    /\/$/,
    "",
  );
  const doFetch = options.fetchImpl ?? fetch;
  const dir = binDir(env);
  const path = join(dir, name);
  const stamp = `${path}.version`;

  // 同じ version が既に置いてある = 何もしない(毎 install で 66MB を引き直さない)
  const installed = await readFile(stamp, "utf8").catch(() => "");
  if (installed.trim() === version && (await Bun.file(path).exists())) {
    return { status: "present", path };
  }

  const target = binaryTarget(options.platform, options.arch);
  if (!target) {
    return {
      status: "unsupported",
      detail: `no prebuilt binary is published for ${options.platform ?? process.platform}/${options.arch ?? process.arch}`,
    };
  }

  const asset = `${name}-${target}`;
  const dirUrl = `${base}/v${version}`;
  let bytes: Uint8Array;
  let want: string | undefined;
  try {
    // checksum を**先に**取る: 66MB を引いてから「照合表が無い」と分かるのは無駄
    const sums = await doFetch(`${dirUrl}/SHA256SUMS`);
    if (!sums.ok) return { status: "unavailable", detail: `SHA256SUMS returned ${sums.status}` };
    want = sha256From(await sums.text(), asset);
    if (!want) return { status: "unavailable", detail: `${asset} is not listed in SHA256SUMS` };

    const res = await doFetch(`${dirUrl}/${asset}`);
    if (!res.ok) return { status: "unavailable", detail: `${asset} returned ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { status: "unavailable", detail: (e as Error).message };
  }

  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== want) {
    return {
      status: "checksum_mismatch",
      detail: `SHA256 mismatch for ${asset} (expected ${want.slice(0, 12)}… / got ${got.slice(0, 12)}…)`,
    };
  }

  // tmp → rename: 中断しても中途半端な file を「置いてある」と数えさせない。
  // tmp 名は process 固有(並行 install が互いの tmp を rename しない)
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, bytes, { mode: 0o755 });
    await chmod(tmp, 0o755); // umask で落ちた実行権を戻す
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    return { status: "unavailable", detail: (e as Error).message };
  }
  // 版の印は binary を置いた**後**(先に書くと、置けなかった版を「在る」と数える)
  await writeFile(stamp, `${version}\n`);
  return { status: "downloaded", path, target };
}
