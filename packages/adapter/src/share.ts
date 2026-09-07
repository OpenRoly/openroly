import { canonicalExtensionKey, validateExtensionSpec, type ExtensionKind } from "@openroly/core";
import { apiCall } from "./api.ts";
import type { AdapterContext, ExportedExtension, RuntimeAdapter } from "./contract.ts";
import { loadShareState, mergeSecrets, saveShareState, type RuntimeCredential } from "./credentials.ts";

// 吸い上げ → 提案(PBI-0212 / 図67)。`openroly share` の本体。
//
//   各 runtime の exportExtensions → 名前で dedupe → env を剥がして `env:NAME` の参照にする →
//   **先に端末の secrets.json へ値を書き**(AC-X2: 書けないなら 1 件も提案しない) →
//   POST /v1/extensions/proposals。
//
// **sync の逆向きだが、desired は書かない** —— runtime が書けるのは提案までで、desired に
// するのは human の承認(または account 設定 auto_share で server が代行する承認)だけ。
// この一方通行が REQ-20「agent が自分の権限を広げない」の実体。

type Env = Record<string, string | undefined>;

export interface SharePlanItem {
  kind: ExtensionKind;
  name: string;
  /** 名前が他 runtime と衝突して `<name>-<runtime>` に改名した時の元の名前 */
  originalName: string;
  spec: Record<string, unknown>;
  credentialRef: string | null;
  fingerprint: string;
  /** どの runtime から拾ったか(credential store の kind) */
  runtimeKind: string;
}

export interface ShareSkip {
  name: string;
  runtimeKind: string;
  reason: string;
}

export interface ShareResult {
  /** 今回送る(送った)提案 */
  plan: SharePlanItem[];
  /** server が受け取った結果。`status` は pending(承認待ち)か approved(auto_share) */
  sent: { name: string; status: string; created: boolean }[];
  failed: { name: string; detail: string }[];
  /** 提案に上げなかった物と理由(人に見せる) */
  skipped: ShareSkip[];
}

export interface ShareOptions {
  /** 対象 adapter(`--runtime` で 1 つに絞れる) */
  adapters: RuntimeAdapter[];
  ctx: AdapterContext;
  /** credential store の中身(kind → credential)。**接続済みの runtime だけが提案を出せる** */
  credentials: Record<string, RuntimeCredential>;
  /**
   * secrets.json / share-state.json の置き場を決める。**既定は `ctx.env`**(PBI-0212 有界レビュー)
   * —— 既定を process.env にしていたので、偽の HOME を持つ ctx を渡した呼び手が
   * **本物の `~/.openroly/secrets.json` に書いた**(実測: レビューの攻撃 test が 1 回踏んだ)。
   * CLI の ctx は `{ env: process.env }` なので、本番の振る舞いは変わらない
   */
  env?: Env;
  /** 何も書かない・送らない(plan だけ) */
  dryRun?: boolean;
  /** 前回 share した物との差分だけ送る(順114 の fs watch から呼ばれる形) */
  auto?: boolean;
}

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * 提案の同一性。canonical 化は `@openroly/core`(server と共有)、hash はここ —— server は node:crypto
 * で同じ bytes を hash する。2 台の端末が同じ物を出したら同じ値になる(device を混ぜない)。
 */
export function shareFingerprint(item: {
  kind: ExtensionKind;
  name: string;
  spec: Record<string, unknown>;
  credentialRef: string | null;
}): string {
  return sha256(canonicalExtensionKey(item.kind, item.name, item.spec, item.credentialRef));
}

/** secretEnv の名前から credential_ref を組む。**並びは常に sort**(端末ごとに fingerprint がずれない) */
function credentialRefOf(secretEnv: Record<string, string>): string | null {
  const names = Object.keys(secretEnv).sort();
  return names.length === 0 ? null : `env:${names.join(",")}`;
}

/** env 名として使えるか。使えない名前は `env:` の綴りに載せられない(server 側も同じ形で弾く) */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 全 runtime から集めて 1 本の提案列にする。同名は
 *   ① 中身も同じ → 1 件に潰す(2 つの runtime に同じ MCP が在るのが普通)
 *   ② 中身が違う → 後から来た方を `<name>-<runtime>` にする(**先に来た方は改名しない** ——
 *      承認済みの desired と同じ名前を持つ物が改名されると、次の sync が同じ物を 2 つ入れる)
 */
export function planShare(
  collected: { runtimeKind: string; items: ExportedExtension[] }[],
): { plan: SharePlanItem[]; secrets: Record<string, string>; skipped: ShareSkip[] } {
  const plan: SharePlanItem[] = [];
  const skipped: ShareSkip[] = [];
  const secrets: Record<string, string> = {};
  const byName = new Map<string, string>(); // name → fingerprint

  for (const { runtimeKind, items } of collected) {
    for (const item of items) {
      const badEnv = Object.keys(item.secretEnv).filter((n) => !ENV_NAME.test(n));
      if (badEnv.length > 0) {
        skipped.push({ name: item.name, runtimeKind, reason: `env name cannot be referenced: ${badEnv.join(", ")}` });
        continue;
      }
      // env を剥がしても生の credential が残る spec(`args` に `--token sk-…` 等)は**送らない**。
      // 判定は server が proposals / extensions に掛けるのと同じ 1 本(@openroly/core)
      const check = validateExtensionSpec(item.spec);
      if (!check.ok) {
        skipped.push({
          name: item.name,
          runtimeKind,
          // key だけでなく「どう直すか」を言う —— `args.3` だけ見せられても人は動けない
          reason: `the spec still carries a raw credential (${check.key}) — move it into an env var and share again`,
        });
        continue;
      }
      const credentialRef = credentialRefOf(item.secretEnv);
      const fingerprint = shareFingerprint({ ...item, credentialRef });
      let name = item.name;
      const seen = byName.get(name);
      if (seen === fingerprint) continue; // 同じ物が 2 runtime に在るだけ
      if (seen !== undefined) {
        name = `${item.name}-${runtimeKind}`;
        if (byName.has(name)) {
          skipped.push({ name: item.name, runtimeKind, reason: `the name "${name}" is already used by another proposal` });
          continue;
        }
      }
      // 名前が変わると fingerprint も変わる(名前は同一性の一部)
      const finalFingerprint =
        name === item.name ? fingerprint : shareFingerprint({ ...item, name, credentialRef });
      byName.set(name, finalFingerprint);
      Object.assign(secrets, item.secretEnv);
      plan.push({
        kind: item.kind,
        name,
        originalName: item.name,
        spec: item.spec,
        credentialRef,
        fingerprint: finalFingerprint,
        runtimeKind,
      });
    }
  }
  return { plan, secrets, skipped };
}

/**
 * Account に既に在る desired の名前。**skill の `.openroly-managed` に当たる mcp 側の防御** ——
 * config に書き込んだ MCP には marker を置けない(他人の config を汚さない)ので、
 * 「配った物かどうか」は Account 側の desired 一覧で判定するしかない。無いと
 * `sync` で配った物が次の `share` で提案に戻り、人が web で足した物も「Found」として出る。
 * **読めなければ share しない**(fail-closed) —— 判定できないまま送ると循環に気付けない。
 */
async function desiredNames(credential: RuntimeCredential): Promise<Set<string>> {
  const res = await apiCall<{ name: string; deleted_at: string | null }[]>(
    credential.base_url,
    "/v1/extensions",
    { token: credential.token },
  );
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(`GET /v1/extensions failed: ${res.status}`);
  }
  return new Set(res.body.filter((e) => e.deleted_at == null).map((e) => e.name));
}

export async function shareExtensions(options: ShareOptions): Promise<ShareResult> {
  const env = options.env ?? options.ctx.env;
  const collected: { runtimeKind: string; items: ExportedExtension[] }[] = [];
  for (const adapter of options.adapters) {
    if (!options.credentials[adapter.id]) continue;
    collected.push({ runtimeKind: adapter.id, items: await adapter.exportExtensions(options.ctx) });
  }
  const { plan: collectedPlan, secrets, skipped } = planShare(collected);

  const anyCredential = Object.values(options.credentials)[0];
  if (!anyCredential) return { plan: [], sent: [], failed: [], skipped };
  const alreadyDesired = await desiredNames(anyCredential);
  const found = collectedPlan.filter((p) => {
    if (!alreadyDesired.has(p.name)) return true;
    // 「every AI に配った」とは言わない —— desired は targets を選べるので、この判定
    // (Account に同じ名前が在る)は配布先の広さを何も知らない
    skipped.push({ name: p.name, runtimeKind: p.runtimeKind, reason: "already in your account's extensions" });
    return false;
  });

  // --auto: 前回送った集合との差分だけ。**消えた物は提案しない**(削除は配らない)
  const known = options.auto ? await loadShareState(env) : new Set<string>();
  const plan = found.filter((p) => !known.has(p.fingerprint));

  const result: ShareResult = { plan, sent: [], failed: [], skipped };
  if (options.dryRun || plan.length === 0) return result;

  // **値を先に置く**(AC-X2)。ここで落ちたら 1 件も提案しない —— 提案だけが Account に在って
  // 値が端末に無い状態は、承認した瞬間に全 agent の sync が失敗し続ける形になる
  await mergeSecrets(secrets, env);

  for (const item of plan) {
    const credential = options.credentials[item.runtimeKind]!;
    const res = await apiCall<{ id?: string; status?: string }>(
      credential.base_url,
      "/v1/extensions/proposals",
      {
        token: credential.token,
        method: "POST",
        body: {
          kind: item.kind,
          name: item.name,
          spec: item.spec,
          ...(item.credentialRef ? { credential_ref: item.credentialRef } : {}),
        },
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      result.failed.push({
        name: item.name,
        detail: `POST /v1/extensions/proposals returned ${res.status}`,
      });
      continue;
    }
    result.sent.push({ name: item.name, status: res.body?.status ?? "pending", created: res.status === 201 });
  }

  // 1 件でも送れなかったら状態を進めない(次の --auto が取りこぼしを再送する)
  if (result.failed.length === 0) await saveShareState(found.map((p) => p.fingerprint), env);
  return result;
}
