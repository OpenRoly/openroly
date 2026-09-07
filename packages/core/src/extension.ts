// Account-scoped Extension Sync(PBI-0005)の pure domain。
// 判定順序は docs/diagrams.md 図8 と一致させる(diagrams-check.sh が検査):
// 1. kind が runtime の supportedKinds に無い → unsupported(ただし deleted_at 有りなら
//    2 と同じ扱いで uninstall/noop、既に unsupported 記録済みなら再送せず noop — 冪等性)
// 2. deleted_at あり → materialization 行が有る時だけ uninstall(無ければ noop)
// 3. enabled=false → disable(既に disabled 記録済みなら noop — 冪等性)
// 4. native(actual)に無い → install
// 5. applied_revision < revision → update
// 6. それ以外 → noop
// 7. native に有るが desired にも materialization にも無い → noop。絶対に uninstall しない

export type ExtensionKind = "mcp" | "skill" | "plugin" | "instructions";
export type MaterializationStatus = "applied" | "disabled" | "unsupported" | "failed";

/** OpenRoly 自身の MCP server 名。desired extension として登録させると自分の登録を張り替えてしまう */
export const RESERVED_EXTENSION_NAMES = ["openroly"] as const;

export interface DesiredExtension {
  id: string;
  kind: ExtensionKind;
  name: string;
  spec: Record<string, unknown>;
  credentialRef: string | null;
  enabled: boolean;
  revision: number;
  /** null でなければ soft delete 済み(値そのものは判定に使わない) */
  deletedAt: string | null;
}

export interface MaterializationState {
  extensionId: string;
  status: MaterializationStatus;
  appliedRevision: number | null;
}

export type PlanAction =
  | { action: "unsupported"; extensionId: string; name: string; kind: ExtensionKind; detail: string }
  | { action: "uninstall"; extensionId: string; name: string }
  | { action: "disable"; extensionId: string; name: string }
  | {
      action: "install" | "update";
      extensionId: string;
      name: string;
      kind: ExtensionKind;
      spec: Record<string, unknown>;
      credentialRef: string | null;
      revision: number;
    }
  | { action: "noop"; extensionId?: string; name: string };

export interface PlanReconciliationInput {
  desired: DesiredExtension[];
  /** 呼び出し側 runtime 1 台分の materialization のみ */
  materialized: MaterializationState[];
  /** native に実在する extension 名(呼び出し側 runtime の listExtensions 結果) */
  actual: string[];
  supportedKinds: ExtensionKind[];
}

/** soft delete 済み desired extension の扱い(unsupported/対応 kind 共通): 行が有れば uninstall、無ければ noop */
function planDeletion(ext: DesiredExtension, mat: MaterializationState | undefined): PlanAction {
  return mat
    ? { action: "uninstall", extensionId: ext.id, name: ext.name }
    : { action: "noop", extensionId: ext.id, name: ext.name };
}

export function planReconciliation(input: PlanReconciliationInput): PlanAction[] {
  const materializedByExt = new Map(input.materialized.map((m) => [m.extensionId, m]));
  const actualNames = new Set(input.actual);
  const desiredNames = new Set(input.desired.map((d) => d.name));
  const actions: PlanAction[] = [];

  for (const ext of input.desired) {
    const mat = materializedByExt.get(ext.id);

    if (!input.supportedKinds.includes(ext.kind)) {
      // 未対応 kind でも soft delete されたら desired 行を消す経路(uninstall)に乗せる —
      // ここで noop 固定にすると、native には何も無いのに materialization 行と desired 行が
      // 永遠に残り続ける(purge に一度も到達しない)
      if (ext.deletedAt != null) {
        actions.push(planDeletion(ext, mat));
        continue;
      }
      // 既に unsupported として記録済みなら再送しない — 3 段目(disable)と同じ冪等性ガード。
      // 無いと desired に plugin/skill が 1 件でもある限り毎 sync で status を送り直し、
      // extension_materializations.updated_at が無意味に更新され続ける
      if (mat?.status === "unsupported") {
        actions.push({ action: "noop", extensionId: ext.id, name: ext.name });
        continue;
      }
      actions.push({
        action: "unsupported",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        detail: `kind "${ext.kind}" はこの runtime では未対応です`,
      });
      continue;
    }
    if (ext.deletedAt != null) {
      actions.push(planDeletion(ext, mat));
      continue;
    }
    if (!ext.enabled) {
      // 既に disabled で記録済みなら再送しない — noop で status を送らないのが冪等性の実体
      // (送ると updated_at が無意味に更新され「差分が無い」が DB 上で観測できなくなる)
      actions.push(
        mat?.status === "disabled"
          ? { action: "noop", extensionId: ext.id, name: ext.name }
          : { action: "disable", extensionId: ext.id, name: ext.name },
      );
      continue;
    }
    if (!actualNames.has(ext.name)) {
      actions.push({
        action: "install",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        spec: ext.spec,
        credentialRef: ext.credentialRef,
        revision: ext.revision,
      });
      continue;
    }
    if ((mat?.appliedRevision ?? 0) < ext.revision) {
      actions.push({
        action: "update",
        extensionId: ext.id,
        name: ext.name,
        kind: ext.kind,
        spec: ext.spec,
        credentialRef: ext.credentialRef,
        revision: ext.revision,
      });
      continue;
    }
    actions.push({ action: "noop", extensionId: ext.id, name: ext.name });
  }

  // 7: native に有るが desired に無い extension(人が手で入れた物・openroly MCP server 自身)は
  // 絶対に uninstall しない。noop として明示する(黙って除外すると不変条件が検査できない)
  for (const name of actualNames) {
    if (desiredNames.has(name)) continue;
    actions.push({ action: "noop", name });
  }

  return actions;
}

const CREDENTIAL_LIKE_KEYS = ["token", "apikey", "password", "secret", "authorization"];

/** key を正規化(小文字化 + `_`/`-` 除去)してから比較する。api_key も apiKey も同じ扱いにするため */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/**
 * `scheme://user:password@host` の userinfo(PBI-0212 有界レビュー)。**key を持たない生 credential**
 * の唯一の一般形で、`postgresql://app:pw@db/app` のような 1 語の DSN が MCP の argv に載る形が実在する。
 * 見るのは **argv だけ** —— skill の本文に例として書かれた DSN まで弾くと、秘密でない物を
 * 「credential が残っている」と言って丸ごと落とす(fail-closed の costs が利得を超える)。
 */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;

/** `--token` / `--api-key` など、**次の語(または `=` の右)が値になる** flag */
const ARG_FLAG = /^--?([A-Za-z0-9][A-Za-z0-9_-]*)(?:=([\s\S]*))?$/;

/**
 * argv に載った生 credential(PBI-0212 有界レビュー)。key/value の対が object ではなく
 * **配列の隣り合う 2 要素**で表れるので、key を舐めるだけの走査には最初から見えない
 * (`args: ["--token", "ghp_…"]` が素通りしていた)。判定語は object 側と同じ辞書 1 本。
 */
function findCredentialLikeArg(args: unknown[], path: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (URL_USERINFO.test(arg)) return `${path}.${i}`;
    const m = ARG_FLAG.exec(arg);
    if (!m || !CREDENTIAL_LIKE_KEYS.some((bad) => normalizeKey(m[1]!).includes(bad))) continue;
    // `--token=VALUE`(右が空でない)か、`--token VALUE`(次が flag ではない)の時だけ値が在る
    const next = args[i + 1];
    if (m[2] !== undefined ? m[2].length > 0 : typeof next === "string" && next.length > 0 && !next.startsWith("-")) {
      return `${path}.${i}`;
    }
  }
  return null;
}

function findCredentialLikeKey(value: unknown, path = ""): string | null {
  if (value == null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    const inArg = findCredentialLikeArg(value, path);
    if (inArg) return inArg;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (
      typeof v === "string" &&
      v.length > 0 &&
      CREDENTIAL_LIKE_KEYS.some((bad) => normalizeKey(key).includes(bad))
    ) {
      return here;
    }
    if (v != null && typeof v === "object") {
      const nested = findCredentialLikeKey(v, here);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * spec の中に生 credential が有れば拒否する。アーキ §14「Credentials are referenced, not copied」の強制点。
 * 見るのは 2 面:
 *  - **key**: token / api_key / password / secret / authorization を key に持つ非空文字列
 *  - **argv**: `--token VALUE` / `--api-key=VALUE` / `scheme://user:pw@host`(PBI-0212 有界レビュー
 *    の実測 —— key しか見ていなかったので、MCP の `args` に載った生 token が Account へ素通りした)
 */
export function validateExtensionSpec(
  spec: Record<string, unknown>,
): { ok: true } | { ok: false; key: string } {
  const found = findCredentialLikeKey(spec);
  return found ? { ok: false, key: found } : { ok: true };
}

/**
 * 提案(extension_proposals)の同一性を決める正規形(PBI-0212)。**hash はここでは取らない** ——
 * server は node:crypto、CLI は Bun.CryptoHasher でこの文字列を sha256 する。`@openroly/core` は
 * web(browser bundle)からも import されるので、runtime 依存の crypto をこの層に持ち込まない。
 * 正規化(key の並び)だけを 1 箇所に置き、両側が同じ bytes を hash する。
 *
 * 同じ物を 2 台の端末が同時に share しても 1 行に潰れる(AC-X3)ので、**device は入れない**。
 */
export function canonicalExtensionKey(
  kind: ExtensionKind,
  name: string,
  spec: Record<string, unknown>,
  credentialRef: string | null,
): string {
  return JSON.stringify(canonicalize({ kind, name, spec, credential_ref: credentialRef ?? null }));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(src)
        .sort()
        .map((k) => [k, canonicalize(src[k])]),
    );
  }
  return value;
}

/**
 * `credential_ref` として受け付ける綴り(PBI-0212)。
 * - `env:NAME` / `env:NAME,NAME2` —— 端末側でだけ解決する(値は Account を通らない。§40)。
 *   1 つの MCP が token と別の env を両方要ることは普通にあるので **複数名を許す**(`,` は
 *   POSIX の env 名に出現し得ないので曖昧にならない)。落とすと「共有はできたが起動だけ静かに
 *   失敗する」形になる
 * - `connection:<provider>` —— Account 側で解決する。provider の綴りは呼び出し側が別途検査する
 */
export const ENV_CREDENTIAL_REF = /^env:[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$/;
