// 持ち込みの住所(PBI-0191 / 図61)。「値の妥当性」と「宛先が identity に当たるか」の
// 判定をここ 1 箇所に置く —— server(登録 API・inbound 解決)と test が同じ規則を見る。
// DNS も DB も触らない(core は I/O を持たない)。

import { LEADING_AT } from "./handle.ts";

/**
 * 持ち込みの 2 種。**MX を自分で向けられるか**で割れる:
 *  - `domain`  = 自分の DNS を持つ(shibubu.ai)。MX を OpenRoly に向ければ任意 local-part が直接届く
 *  - `address` = MX は他人が持つ(gmail.com)。転送でしか届かないので所有証明は code
 */
export type MailIdentityKind = "address" | "domain";

/** DNS TXT の値の頭。これが付いた TXT だけを所有証明として読む */
export const MAIL_IDENTITY_TXT_PREFIX = "openroly-verify=";

/** 旧 token の頭(PBI-0344 AC-5)。**少なくとも 1 release は受け続ける**(貼り直しを強制しない) */
export const LEGACY_MAIL_IDENTITY_TXT_PREFIX = "atn-verify=";

/** 所有証明の TXT を貼る場所。`shibubu.ai` → `_openroly-verify.shibubu.ai` */
export function verificationTxtName(domain: string): string {
  return `_openroly-verify.${domain}`;
}

/** 旧所有証明の TXT を貼る場所(改名前に案内した物。受け側はこちらも引く) */
export function legacyVerificationTxtName(domain: string): string {
  return `_atn-verify.${domain}`;
}

/**
 * TXT 1 件の値と challenge が**同じ payload**を指すか。新旧どちらの頭でも通す
 * (PBI-0344 AC-5) —— 改名後に challenge を作り直した account の DNS には、まだ旧頭の
 * 値が貼られたままかもしれない。頭がどちらでも無い値は所有証明として読まない。
 */
export function mailIdentityChallengeMatches(txtValue: string, challenge: string): boolean {
  const payload = (v: string): string | null => {
    for (const p of [MAIL_IDENTITY_TXT_PREFIX, LEGACY_MAIL_IDENTITY_TXT_PREFIX]) {
      if (v.startsWith(p)) return v.slice(p.length);
    }
    return null;
  };
  const want = payload(challenge.trim());
  const got = payload(txtValue.trim());
  return want !== null && got !== null && want === got;
}

/** RFC 5321 の path 上限。address の受け口の上限に使う */
const ADDRESS_MAX = 320;
/** RFC 1035 の FQDN 上限 */
const DOMAIN_MAX = 253;

/**
 * domain 1 本の妥当性。label は英数と `-`(先頭末尾は英数)、2 label 以上、TLD は英字 2 文字以上。
 * IDN は punycode(`xn--`)で入っていれば通る — Unicode のままは受けない(正規化の正本を
 * 増やさない。handle が ASCII 限定なのと同じ理由)。
 */
function isDomainLike(d: string): boolean {
  if (d.length === 0 || d.length > DOMAIN_MAX) return false;
  const labels = d.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && l.length <= 63);
}

/**
 * 入力を正規化して返す(小文字・trim・先頭 `@` と末尾 `.` を落とす)。妥当でなければ null。
 * **登録 API と inbound 解決の両方がこれを通す** — 片方だけが緩いと「登録できたのに届かない」
 * / 「登録していない値に当たる」が生まれる(handle の normalize と同じ規律)。
 */
export function normalizeMailIdentityValue(
  kind: MailIdentityKind,
  input: string,
): string | null {
  const s = input.trim().toLowerCase().replace(/\.+$/, "");
  if (s === "") return null;
  if (kind === "domain") {
    const d = s.replace(LEADING_AT, "");
    return isDomainLike(d) ? d : null;
  }
  if (s.length > ADDRESS_MAX) return null;
  const at = s.lastIndexOf("@");
  if (at < 1) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  // local-part は実用最小(空白・`@` 不可)。quoted local-part は対象外 —— parseRecipient と同じ縮小形
  if (!/^[^\s@]+$/.test(local) || !isDomainLike(domain)) return null;
  return s;
}

/** 正規化済み address の domain 部分。`ryo@shibubu.ai` → `shibubu.ai` */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : null;
}

/**
 * inbound の宛先 1 つを identity 照合用の 2 つの key に割る(図61 パス2)。
 * `ryo+t_ab12@shibubu.ai` → `{ address: "ryo@shibubu.ai", domain: "shibubu.ai", plus: ["t_ab12"] }`
 *
 * **`+` 以降を落とした address を返す**のは、持ち込み domain の Reply-To
 * (`handle+t_<token>@<domain>`・PBI-0192)が同じ thread に戻る為。address の側は routing には
 * 使わず(転送 mail は envelope の system address で解決される)、「届いた住所」の label の照合
 * (PBI-0200)にだけ plus を落とした形で使う。
 */
export function inboundMailKeys(
  rawAddress: string,
): { address: string; domain: string; plus: string[] } | null {
  const s = rawAddress.trim().toLowerCase().replace(/\.+$/, "");
  const at = s.lastIndexOf("@");
  if (at < 1) return null;
  const domain = s.slice(at + 1);
  if (!isDomainLike(domain)) return null;
  const [base, ...plus] = s.slice(0, at).split("+");
  if (!base) return null;
  return { address: `${base}@${domain}`, domain, plus };
}

/** gmail(と旧称 googlemail)は local-part の `.` を無視して同じ受信箱に届ける。両ドメインは
 * Google 自身が同じ受信箱の別名として運用している(旧 UK/DE ユーザー向けの旧称)。 */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * 宛先ごとの mail-bomb 防止 bucket(PBI-0221)の key。**`inboundMailKeys` とは別の畳み方が要る** ——
 * あちらは inbound routing 用で `.` を畳まない(PBI-0221 が意図的に外した判断: 他 provider では
 * `.` が別人の住所になるので、畳むと巻き添えが起きる)。だが gmail は畳まないと、`.` の位置を
 * 変えるだけで同じ実在の受信箱への「宛先」を無限に作れ、宛先ごとの上限(PBI-0221 AC-2)が
 * 意味を失う(PBI-0386 有界レビューで実証)。**gmail/googlemail だけ**畳んで 1 ドメインへ正規化し、
 * それ以外は `inboundMailKeys` の畳み方をそのまま使う(他 provider を巻き添えにしない)。
 */
export function mailBombTargetKey(rawAddress: string): string | null {
  const keys = inboundMailKeys(rawAddress);
  if (!keys) return null;
  if (!GMAIL_DOMAINS.has(keys.domain)) return keys.address;
  const local = keys.address.slice(0, keys.address.lastIndexOf("@"));
  return `${local.replace(/\./g, "")}@gmail.com`;
}

/**
 * 画面に出す「届いた住所」の上限(PBI-0222)。持ち込み domain は catch-all なので local-part を
 * 送信者が自由に決められる —— `<10,000 文字>@<victim domain>` 宛の 1 通で inbox の全行と
 * chat の sender 行に 10,000 文字の chip が出る。**切らずに落とす**のは、切った文字列が
 * 「そこへ届いた」という嘘になる為(`aaa…a@x.test` の前 64 文字は別の住所を指し得る)。
 * 上限は RFC 5321: local-part 64 + `@` + domain 253 = 318。
 */
export const DELIVERED_TO_LOCAL_MAX = 64;
export const DELIVERED_TO_MAX = 318;

/** 上限内ならその住所、超えたら null(呼び出し側が catch-all 表記 / system address に落とす) */
export function boundedDeliveredTo(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  return at <= DELIVERED_TO_LOCAL_MAX && address.length <= DELIVERED_TO_MAX ? address : null;
}
