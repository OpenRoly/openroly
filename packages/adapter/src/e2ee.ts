import { fromEnvelopePlaintext, toEnvelopePlaintext, type MessageContent } from "@openroly/core";
import {
  open,
  seal,
  unwrapPrivateKeyFromDevice,
  type EncryptedEnvelope,
} from "@openroly/crypto-envelope";
import { apiCall } from "./api.ts";
import { getOrCreateDeviceKey, hasDeviceKey, rotateDeviceKey } from "./devicekeys.ts";

// Native E2EE(要件 §9-11 / PBI-0006 → **PBI-0247 で seal 先が account 鍵になった**)の
// client 側の作法を 1 箇所に集める。使うのは MCP tools(packages/mcp)と `openroly agent`(apps/cli)。
// HTTP の呼び方(認証・error 型)は呼び出し側で違うので `call` を注入する —— ここに 2 つ目の
// API client を作らないための境界(呼び出し側の error 型・retry 方針をそのまま活かす)。
//
// **agent は人の秘密(password / 復旧コード)を持たない**。過去を読めるのは、人が明示に
// 承認して account 秘密鍵を **この device の公開鍵へ包み直した** grant 1 本があるからで、
// 無ければ読めない(AC-X2: AI に人の包みは渡らない)。前は「着信時点の active な device 鍵群へ
// 封をする」形だったので、agent は自分が居なかった時期の item を永久に読めなかった —— grant は
// 鍵 1 本を包み直すだけなので、承認した瞬間に過去も未来も開く。

/**
 * 注入する HTTP 呼び出し。**非 2xx は `status: number` と応答 `body` を持つ error を投げる**
 * (MCP の `OpenRolyApiError`・`openroly agent` の `call`)。`resolveSealTargets` はその `status` が 404 の時だけを
 * 「宛先がまだ account 鍵を持たない」と読む —— status の無い失敗(通信断・壊れた応答)は平文の合図に
 * ならない(PBI-0259)。`body.error` は同じ status に複数の理由がある時に使う —— POST /v1/devices の
 * 409 は「他 account が持つ id」と「revoke された device」の 2 つで、復帰の手順が違う(PBI-0253)。
 */
export type E2eeCall = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

/**
 * credential 1 本から E2eeCall を作る(`openroly agent` と pairing の後の名乗り直しが共有する)。
 * 契約どおり非 2xx は `status` と `body` を持つ error。message の形は `openroly agent` の
 * 失敗表示(`NG account_api_error(409) /v1/devices`)がそのまま読む。
 */
export function e2eeCallFor(baseUrl: string, token: string, kind?: string): E2eeCall {
  return async (path, init) => {
    const res = await apiCall(baseUrl, path, { token, ...init });
    if (res.status >= 400) {
      // 401 = この credential はもう account に居ない。戻り道を文言そのものに書く(下の credentialRejectedHint)
      const hint = res.status === 401 ? ` — ${credentialRejectedHint(kind)}` : "";
      throw Object.assign(new Error(`account_api_error(${res.status}) ${path}${hint}`), {
        status: res.status,
        body: res.body,
      });
    }
    return res.body;
  };
}

/**
 * 401 を受けた agent が読む 1 行(PBI-0264 有界レビュー 2026-09-05)。Revoke は runtime token ごと落とすので、
 * 0253 が 409 device_revoked に書いた復帰の案内の **手前で 401 が返る** = revoke された agent はあの案内に
 * 二度と到達しない。無人で動く相手が生の `401 unauthorized` で止まらないよう、戻り道(人が承認し直す
 * pairing)をここに 1 本だけ持つ —— MCP の OpenRolyApiError / `openroly agent` / e2eeCallFor が同じ文を出す。
 * server は revoke 済みと未 pair を言い分けない(token_hash を消すので言い分けられない)が、戻り道は同じ
 */
export function credentialRejectedHint(kind?: string): string {
  const k = kind && kind !== "default" ? kind : "<kind>";
  return (
    `this agent's credential was rejected (401): it was revoked from the account, or was never paired. ` +
    `Run 'openroly pair ${k}' and approve it again to reconnect.`
  );
}

/**
 * POST /v1/devices の結末。`revoked` = 人が Revoke を押した id(409 device_revoked)。
 * `skipped` = triage scope の session で名乗りが許可集合の外(403 scope_denied・PBI-0268)—— 封の宛先は
 * account 鍵 2 本で名乗りは封に要らないので、ここで投げると scope 付き MCP の owner thread 報告 reply /
 * label summary / 外部 send が **全部**止まる(PBI-0261 の有界レビューが実測)。登録は次の非 scope session が
 * 同じ鍵で通す(冪等)。他の失敗(他の 403 / 5xx / 通信断)は投げる
 */
async function registerOwnDevice(
  call: E2eeCall,
  deviceKind: string,
  record: { keyId: string; publicJwk: JsonWebKey },
): Promise<"ok" | "revoked" | "taken" | "skipped"> {
  try {
    await call("/v1/devices", {
      body: {
        device_name: deviceKind,
        device_key_id: record.keyId,
        public_key_jwk: record.publicJwk,
      },
    });
    return "ok";
  } catch (e) {
    const err = e as { status?: unknown; body?: { error?: unknown } } | null;
    if (err?.status === 409 && err?.body?.error === "device_revoked") return "revoked";
    // 別の生きた runtime(同 account)か別 account が持つ id(PBI-0264 有界レビュー: 1 鍵 ↔ 1 runtime)
    if (err?.status === 409 && err?.body?.error === "device_key_id_taken") return "taken";
    if (err?.status === 403 && err?.body?.error === "scope_denied") return "skipped";
    throw e;
  }
}

/**
 * 自分の device key を用意し、server 側へ upsert 登録する(冪等 — 呼ぶたびに送ってよい)。
 *
 * **人が Revoke を押した device は 409 `device_revoked` で戻れない**(PBI-0253)。秘密鍵は
 * 手元に残るので id は変わらず、黙って再登録できてしまうと押した Revoke が効かない。
 * ここで理由を名乗らないと agent は生の `account_api_error(409)` で止まる —— 無人で動く
 * 相手なので、**復帰の手順を error 文字列そのものに書く**(AC-X1)。手順は **pairing の
 * やり直し**(`openroly pair <kind>`)—— `openroly login` は broker を pair するだけで device 鍵に触らないので、
 * 案内しても同じ id で 409 のまま永久に詰む(有界レビュー 2026-09-05 で実測)。
 */
export async function ensureOwnDevice(
  call: E2eeCall,
  deviceKind: string,
  env: Record<string, string | undefined> = process.env,
) {
  const record = await getOrCreateDeviceKey(deviceKind, env);
  const registered = await registerOwnDevice(call, deviceKind, record);
  if (registered === "revoked") {
    throw new Error(
      `This device (${deviceKind}) was revoked from the account, so it can no longer read or send messages. ` +
        `Run 'openroly pair ${deviceKind}' and approve it again to connect with a new device key.`,
    );
  }
  if (registered === "taken") {
    // 同じ鍵 file を別の生きた runtime(同じ machine で pair し直した / 別 account に pair した)が先に
    // 名乗っている。理由は revoke と別物だが、戻り道は同じ pairing のやり直し(承認直後に鍵を作り直す)
    throw new Error(
      `This device key (${deviceKind}) is held by another connection of this machine — a different agent or ` +
        `account paired here — so it cannot be used by this one. ` +
        `Run 'openroly pair ${deviceKind}' and approve it again to connect with a new device key.`,
    );
  }
  return record;
}

/**
 * **人が pairing を承認し直した直後**に 1 回だけ通る(`pairRuntime` の中)。手元の鍵で名乗り、
 * 409 device_revoked なら **鍵を作り直して**新しい id で名乗る —— これが revoke された device の
 * 唯一の戻り道(Apple の trusted device と同じく、戻るには人の認証を通る)。
 * agent が自分の判断で作り直す道は作らない(押した Revoke が新しい id で黙って取り消される)。
 *
 * 手元に鍵の無い kind(broker の `openroly login`)では **何もしない** —— ここで作ると、封もしない
 * broker が Settings › Devices に 1 行増える。失敗(通信断・5xx)は投げる。呼び出し元は pairing を
 * 成功のまま返してよい(credential は書けている。鍵の登録は次の送信でもう一度通る)。
 */
export async function reconnectOwnDevice(
  call: E2eeCall,
  deviceKind: string,
  env: Record<string, string | undefined> = process.env,
): Promise<"none" | "kept" | "rotated"> {
  if (!(await hasDeviceKey(deviceKind, env))) return "none";
  const current = await getOrCreateDeviceKey(deviceKind, env);
  // "revoked"(人が Revoke を押した)も "taken"(別の生きた runtime / 別 account が先に名乗っている・
  // PBI-0264 有界レビュー)も、人が承認し直したこの瞬間だけは作り直してよい。
  // pairing に scope は付かないので "skipped"(PBI-0268)は来ない。来ても鍵を作り直す理由にはならない
  const named = await registerOwnDevice(call, deviceKind, current);
  if (named === "ok" || named === "skipped") return "kept";
  const fresh = await rotateDeviceKey(deviceKind, env);
  const again = await registerOwnDevice(call, deviceKind, fresh);
  if (again !== "ok") {
    // 作ったばかりの id が revoke 済み / 他人の物である事は無い。来たら server 側の別の問題なので隠さない
    throw new Error(`the new device key for ${deviceKind} was rejected as ${again}`);
  }
  return "rotated";
}

/**
 * この device に降りている account 鍵(人が承認した grant)。無ければ null。
 * **「無い」は 30 秒だけ覚える**(PBI-0259) —— MCP server / `openroly agent` は長生きする process で、
 * 人が web で grant を押すのはたいてい agent を起こした後。無期限に覚えると、その process は
 * 再起動するまで account 鍵で封をした item を 1 つも開けない(全部 `undecryptable`)。
 *
 * **「有る」も 5 分で捨てる**(PBI-0253 AC-4)。前は process の間ずっと持っていたので、人が
 * Revoke を押しても既に起きている agent は平文の秘密鍵を握ったまま読み書きを続け、
 * 再起動するまで revoke が一度も効かなかった。この TTL が「revoke が効くまでの上限」になる
 * (revoke は grant の包みを消すので、引き直しは 404 → null に落ちる)。
 */
export interface GrantedAccountKey {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

const GRANT_MISS_TTL_MS = 30_000;
const GRANT_HIT_TTL_MS = 5 * 60_000;
const granted = new Map<string, { key: GrantedAccountKey | null; until: number }>();

export async function loadGrantedAccountKey(
  call: E2eeCall,
  deviceKind: string,
): Promise<GrantedAccountKey | null> {
  const cached = granted.get(deviceKind);
  if (cached && cached.until > Date.now()) return cached.key;
  const device = await getOrCreateDeviceKey(deviceKind);
  let key: GrantedAccountKey | null = null;
  try {
    const grant = (await call(
      `/v1/me/account-key/grant?device_key_id=${encodeURIComponent(device.keyId)}`,
    )) as { key_id: string; public_key_jwk: JsonWebKey; wrapped_private_key: string };
    key = {
      keyId: grant.key_id,
      publicJwk: grant.public_key_jwk,
      privateJwk: await unwrapPrivateKeyFromDevice(grant.wrapped_private_key, device),
    };
  } catch {
    // 承認されていない / 通信できない。**本文を作らない**(平文へは落ちない)。30 秒後に引き直す
    key = null;
  }
  granted.set(deviceKind, {
    key,
    until: Date.now() + (key ? GRANT_HIT_TTL_MS : GRANT_MISS_TTL_MS),
  });
  return key;
}

/** test 用: 承認の前後を同じ process で見る(cache が結果を固定してしまわない様に) */
export function resetGrantedAccountKeyCache(): void {
  granted.clear();
}

/**
 * handle 1 つの account 公開鍵。**shape も見る** —— 200 で `{}` を返す server 相手に
 * 壊れた鍵(`device_key_id: undefined`)へ封をすると、それも「誰も開けない 1 通」になる。
 * 404 はそのまま投げ直す —— 呼び出し側が「宛先が居ない = 平文」と「自分が居ない = 送信中止」を
 * 別々に読む為(この関数はどちらかを決めない)。
 */
async function accountPublicKeyOf(
  call: E2eeCall,
  handle: string,
): Promise<{ keyId: string; publicJwk: JsonWebKey }> {
  const bare = handle.replace(/^@/, "");
  const key = (await call(`/v1/handles/${encodeURIComponent(bare)}/account-key`)) as {
    id?: unknown;
    public_key_jwk?: unknown;
  };
  if (typeof key?.id !== "string" || key.public_key_jwk == null) {
    throw new Error(`account-key for @${bare}: response has no id / public_key_jwk`);
  }
  return { keyId: key.id, publicJwk: key.public_key_jwk as JsonWebKey };
}

/**
 * 送信者自身の account 公開鍵。**grant を待たない**(PBI-0254)。
 *
 * grant は「過去を読む」為に降りてくる **秘密**鍵で、自分の写しを入れるのに要るのは公開鍵だけ。
 * agent は **grant される前が既定状態**(人が Settings で承認して初めて包みが降りる)なので、
 * ここを grant に掛けると `openroly send` / MCP の send・reply の初期の送信が全部
 * 「送った本人だけが永久に読めない 1 通」になる。
 *
 * `/v1/me/account-key` は human only(PBI-0247 AC-X2 —— AI に人の包みは渡さない)なので、
 * **公開鍵しか出ない handle 経由**で引く。process に覚えない —— 1 process が複数 account の
 * tools を持つ形(MCP)では他人の鍵を自分の写しとして入れてしまうし、鍵を作り直した後も
 * 古い key_id へ封をし続ける(AC-X3)。
 *
 * 取れなければ **投げる**(AC-X1)。平文へは落とさない —— downgrade 経路は
 * 「宛先が account 鍵を持たない」1 本だけ(PBI-0023 F4)。
 */
async function ownAccountPublicKey(call: E2eeCall): Promise<{ keyId: string; publicJwk: JsonWebKey }> {
  const me = (await call("/v1/whoami")) as { handle?: unknown };
  if (typeof me?.handle !== "string" || me.handle === "") {
    throw new Error("whoami returned no handle — cannot include the sender's own copy");
  }
  try {
    return await accountPublicKeyOf(call, me.handle);
  } catch (e) {
    if ((e as { status?: unknown } | null)?.status === 404) {
      throw new Error(
        `your account (@${me.handle}) has no account key yet — sending now would create a message you can never read`,
      );
    }
    throw e;
  }
}

/**
 * seal 先 = 宛先 account 鍵 ∪ 自分の account 鍵(どちらも 1 本)。
 * 宛先がまだ account 鍵を持っていなければ null(= 平文 fallback の合図)。
 *
 * null になるのは **404 の 1 経路だけ**(PBI-0023 F4 / PBI-0259)。500・通信断・壊れた応答を null に
 * 潰すと、宛先 account の鍵取得を 1 回失敗させるだけで、その account 宛の送信が server に **平文で残る**
 * downgrade になる(web の `sealForSend` と同じ読み方に揃える)。
 *
 * **自分の写しは必ず入る**(PBI-0254) —— grant の有無で分岐しない。宛先を先に引くのは順番に
 * 意味がある為で、「宛先に鍵が無い」は自分の鍵を見る前に平文へ抜ける。
 */
export async function resolveSealTargets(
  call: E2eeCall,
  deviceKind: string,
  toHandle: string,
): Promise<{ keyId: string; publicJwk: JsonWebKey }[] | null> {
  let theirs: { keyId: string; publicJwk: JsonWebKey };
  try {
    theirs = await accountPublicKeyOf(call, toHandle);
  } catch (e) {
    if ((e as { status?: unknown } | null)?.status === 404) return null;
    throw e;
  }
  // device の名乗り(POST /v1/devices)。triage scope の session では 403 scope_denied を registerOwnDevice が
  // `skipped` と読んで飛ばす(PBI-0268 — 封の宛先は account 鍵で、名乗りは封に要らない)
  await ensureOwnDevice(call, deviceKind);
  const mine = await ownAccountPublicKey(call);
  const targets = [theirs];
  // 自分宛(自分の handle への reply)は宛先と同じ鍵なので足さない —— 同じ recipient が 2 本並ぶ
  if (mine.keyId !== theirs.keyId) targets.push(mine);
  return targets;
}

/**
 * 平文 fallback は **「宛先が account 鍵を持っていない」の 1 経路だけ**(PBI-0006 AC-7)。
 * seal や鍵解決の失敗を捕まえて平文へ落とすのは設計に無い downgrade で、
 * 誰でも壊れた JWK を 1 件登録するだけで、その account 宛の全送信を平文に
 * (= 運営が読める状態に)落とせてしまう(PBI-0023 F4)。失敗はそのまま呼び出し元へ投げる。
 */
export async function sealForHandle(
  call: E2eeCall,
  deviceKind: string,
  toHandle: string,
  content: { text?: string; urls?: string[]; files?: MessageContent["files"] },
): Promise<MessageContent> {
  const targets = await resolveSealTargets(call, deviceKind, toHandle);
  if (!targets) return content;
  const plaintext = new TextEncoder().encode(JSON.stringify(toEnvelopePlaintext(content)));
  return { envelope: await seal(plaintext, targets) };
}

/**
 * この agent が開ける鍵を順に返す。**account 鍵の grant が先、device 鍵が後**(L1 collector が
 * 自分宛に封をした物はまだ device 鍵で来る)。開ける面はここ 1 箇所に集める —— 2 箇所に書くと
 * 片方だけが grant を見ない形に腐る
 */
export async function readerKeys(
  deviceKind: string,
  call?: E2eeCall,
): Promise<{ keyId: string; privateJwk: JsonWebKey }[]> {
  const keys: { keyId: string; privateJwk: JsonWebKey }[] = [];
  if (call) {
    const account = await loadGrantedAccountKey(call, deviceKind);
    if (account) keys.push(account);
  }
  keys.push(await getOrCreateDeviceKey(deviceKind));
  return keys;
}

/**
 * envelope なら開く。開ける鍵は 2 本 —— 人が承認した account 鍵の grant と、
 * 自分の device 鍵(L1 collector が自分宛に封をした物)。どちらでも開けなければ
 * `{undecryptable:true}` に落とす(本文は作らない)
 */
export async function openIfEnvelope<T extends { content: MessageContent }>(
  deviceKind: string,
  message: T,
  call?: E2eeCall,
): Promise<T | (Omit<T, "content"> & { content: MessageContent & { undecryptable?: true } })> {
  const envelope = message.content.envelope as EncryptedEnvelope | undefined;
  if (envelope == null) return message;
  // 過去に 202 で入った壊れた行(`[null]` / `[{}]`・PBI-0265 より前の send は recipients の中身を
  // 見なかった)で **ここが投げると履歴読み(CLI agent / inbox_read)ごと落ちる**。壊れた entry は
  // 宛先に無かった物として扱い、**残った entry だけを `open` に渡す**(web の `recipientsOf` と同じ守り。
  // 有界レビュー 2026-09-05: 原本をそのまま渡すと `open` の `find` が null で投げ、隣に自分の鍵が
  // 居ても catch に落ちて undecryptable になっていた = web では読める行が adapter では読めない)
  const recipients = (Array.isArray(envelope.recipients) ? envelope.recipients : []).filter(
    (r): r is EncryptedEnvelope["recipients"][number] =>
      typeof (r as { device_key_id?: unknown } | null)?.device_key_id === "string",
  );
  const ids = recipients.map((r) => r.device_key_id);
  for (const key of await readerKeys(deviceKind, call)) {
    if (!ids.includes(key.keyId)) continue;
    try {
      const plaintextBytes = await open({ ...envelope, recipients }, key);
      return { ...message, content: fromEnvelopePlaintext(JSON.parse(new TextDecoder().decode(plaintextBytes))) };
    } catch {
      /* 次の鍵で試す */
    }
  }
  return { ...message, content: { undecryptable: true } };
}
