import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNativeAdapter,
  LOCAL_RUNTIME_PREFIX,
  localCatalogPath,
  variantClasses,
  type ExtensionAdapter,
  type VariantClass,
} from "@openroly/adapter";
import { localRuntimeName } from "@openroly/core";
import { apiAdapters } from "@openroly/adapter-api";
import { claudeAdapter } from "@openroly/adapter-claude";
import { codexAdapter } from "@openroly/adapter-codex";
import catalog from "@openroly/core/registry/detectors.v1.json" with { type: "json" };

// runtime adapter の解決(配布戦略 §8 / PBI-0210)。
//   1. hand-written official(claude / codex / `<provider>-api`)
//   2. 呼び手が渡した `native`(broker が署名検証済み registry から `openroly adopt --spec-stdin` で渡す)
//   3. bundled catalog(`@openroly/core/registry/detectors.v1.json`)—— `openroly install <id>` の human 経路が
//      使う。正本は 1 つ(catalog-build の生成物)で、ここに載るのは `adapter: "generic/native"` の
//      entry だけ。server も CLI も**この同じ 1 file** を読む。`packages/core` に在るのは、公開 repo に
//      `apps/server` が無いから —— `../../server/…` を import していた頃は公開 clone が起動できなかった
//      (PBI-0303)。
// community adapter = catalog に 1 entry(`native` + `sources`)を足すこと。TS を書かない。

const OFFICIAL: ExtensionAdapter[] = [claudeAdapter, codexAdapter, ...apiAdapters];

export const GENERIC_ADAPTER = "generic/native";

type CatalogEntry = {
  id: string;
  display_name?: string;
  kind?: string;
  adapter: string | null;
  native?: unknown;
  launch?: { headless?: unknown };
  detect?: { binaries?: string[] };
};

/** adopt してよいか。server `registrableRuntime` と同じ集合（PBI-0685）。adapter は要らない。 */
export function isAdoptibleKind(id: string): boolean {
  const entry = (catalog.detectors as CatalogEntry[]).find((d) => d.id === id);
  if (entry) return entry.kind !== "local_model_server";
  return localRuntimeName(id) !== null;
}

/**
 * 実行ファイル名 → runtime kind(PBI-0631)。`openroly status` が `ps` の `comm` を突き合わせて
 * 「この機械で今 走っている AI」を数えるのに使う。**正本は catalog 1 file** ——
 * `openroly runtimes` が検出に使うのと同じ `detect.binaries` を読むので、CLI 側に別名表も
 * 除外表も作らない(`code` や `ollama` が session ではなく常駐でも、catalog がそれを runtime と
 * 呼んでいる限りここに出る。2 枚目の正本を作らない方を採る)。
 * 突き合わせは **basename の完全一致**。`claude-flow` / `myclaude` を数えない為で、
 * 部分一致に緩めると「名前が似ているだけの process」が製品の答えに混ざる
 */
export const RUNTIME_BINARIES: Map<string, string> = new Map(
  (catalog.detectors as CatalogEntry[]).flatMap((d) =>
    (d.detect?.binaries ?? []).map((b) => [b, d.id] as [string, string]),
  ),
);

/**
 * dedicated wake で instruction 付きで起こせる runtime kind(PBI-0547 `openroly continue` の候補)。
 * 規則は broker の `is_headless_capable`(broker/src/launch.rs)と同じ —— **catalog の
 * `launch.headless` を持つ entry**。PBI-0618 で official 2 種の argv も catalog に降りたので、
 * 両側とも data 1 本で決まる(hard-code の列挙を片側だけ直して値集合がずれる事が無くなった)
 */
export const HEADLESS_KINDS: string[] = (catalog.detectors as CatalogEntry[])
  .filter((d) => d.launch?.headless != null)
  .map((d) => d.id);

/** bundled catalog の generic entry から組んだ adapter(壊れた entry は落として続ける = 1 つの誤りで CLI が起動不能にならない) */
const CATALOG: ExtensionAdapter[] = (catalog.detectors as CatalogEntry[])
  .filter((d) => d.adapter === GENERIC_ADAPTER && d.native != null)
  .flatMap((d) => {
    try {
      return [createNativeAdapter(d.id, d.display_name ?? d.id, d.native)];
    } catch (e) {
      console.error(`catalog: ${d.id} is skipped (${(e as Error).message})`);
      return [];
    }
  });

export const ADAPTERS: ExtensionAdapter[] = [...OFFICIAL, ...CATALOG];

/**
 * `openroly runtimes add` が書いた `catalog.local.json` の 1 entry。
 * broker が auto-register → adopt した `local-*` を sync / share が解決する口(PBI-0678)。
 * 壊れていれば無かったことにする —— 1 つの誤りで CLI 全体を落とさない。
 */
function findLocalAdapter(kind: string): ExtensionAdapter | undefined {
  if (!kind.startsWith(LOCAL_RUNTIME_PREFIX)) return undefined;
  try {
    const path = localCatalogPath();
    if (!existsSync(path)) return undefined;
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: { id: string; display_name?: string; native?: unknown }[];
    };
    const entry = file.entries?.find((e) => e.id === kind);
    if (!entry?.native) return undefined;
    return createNativeAdapter(entry.id, entry.display_name ?? entry.id, entry.native);
  } catch (e) {
    console.error(`local catalog: ${kind} is skipped (${(e as Error).message})`);
    return undefined;
  }
}

/**
 * `native` を渡された時はそれで組む(署名検証済み registry が bundled catalog より新しい = rebuild 無しで
 * 新 runtime。壊れていれば throw → adopt は exit 2)。無ければ official → bundled catalog →
 * 端末の `catalog.local.json`(`local-*`)の順。
 */
export function findAdapter(id: string, native?: unknown): ExtensionAdapter | undefined {
  const kind = id.toLowerCase();
  const official = OFFICIAL.find((a) => a.id === kind);
  if (official) return official;
  if (native != null) {
    const fromCatalog = CATALOG.find((a) => a.id === kind);
    return createNativeAdapter(kind, fromCatalog?.displayName ?? kind, native);
  }
  return CATALOG.find((a) => a.id === kind) ?? findLocalAdapter(kind);
}

export const SUPPORTED_IDS = ADAPTERS.map((a) => a.id);

/** catalog 全 detector 数（dogfood F12 の「91」。local_model_server も含む） */
export const CATALOG_DETECTOR_COUNT = (catalog.detectors as CatalogEntry[]).length;

export type CatalogAgentRuntime = {
  id: string;
  displayName: string;
  kind: string;
  adapter: string | null;
  binaries: string[];
};

/** 自動登録の対象と同じ集合（PBI-0685）。adapter は要らない。 */
export function catalogAgentRuntimes(): CatalogAgentRuntime[] {
  return (catalog.detectors as CatalogEntry[])
    .filter((d) => d.kind !== "local_model_server")
    .map((d) => ({
      id: d.id,
      displayName: d.display_name ?? d.id,
      kind: d.kind ?? "cli",
      adapter: d.adapter,
      binaries: d.detect?.binaries ?? [],
    }));
}

/** adapter.detect が無い kind は catalog の binaries が PATH にあれば検出（PBI-0690） */
export function catalogBinaryDetected(binaries: readonly string[], pathDirs: readonly string[]): boolean {
  return binaries.some((b) => pathDirs.some((dir) => dir !== "" && existsSync(join(dir, b))));
}

/** runtime profile の class(PBI-0211。`adapter: "variant"`)。adapter は持たない —— MCP / skills は親の登録を共有する */
export const VARIANT_CLASSES: VariantClass[] = variantClasses(catalog.detectors as unknown[]);
