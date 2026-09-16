import { createNativeAdapter, variantClasses, type ExtensionAdapter, type VariantClass } from "@openroly/adapter";
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
  adapter: string | null;
  native?: unknown;
  launch?: { headless?: unknown };
  detect?: { binaries?: string[] };
};

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
 * `native` を渡された時はそれで組む(署名検証済み registry が bundled catalog より新しい = rebuild 無しで
 * 新 runtime。壊れていれば throw → adopt は exit 2)。無ければ official → bundled catalog の順。
 */
export function findAdapter(id: string, native?: unknown): ExtensionAdapter | undefined {
  const kind = id.toLowerCase();
  const official = OFFICIAL.find((a) => a.id === kind);
  if (official) return official;
  if (native != null) {
    const fromCatalog = CATALOG.find((a) => a.id === kind);
    return createNativeAdapter(kind, fromCatalog?.displayName ?? kind, native);
  }
  return CATALOG.find((a) => a.id === kind);
}

export const SUPPORTED_IDS = ADAPTERS.map((a) => a.id);

/** runtime profile の class(PBI-0211。`adapter: "variant"`)。adapter は持たない —— MCP / skills は親の登録を共有する */
export const VARIANT_CLASSES: VariantClass[] = variantClasses(catalog.detectors as unknown[]);
