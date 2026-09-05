// 持ち込みの住所(PBI-0191 / 図61)。「値の妥当性」と「宛先が identity に当たるか」の
// 判定をここ 1 箇所に置く —— server(登録 API・inbound 解決)と test が同じ規則を見る。
// DNS も DB も触らない(core は I/O を持たない)。

/**
 * 持ち込みの 2 種。**MX を自分で向けられるか**で割れる:
 *  - `domain`  = 自分の DNS を持つ(shibubu.ai)。MX を PAA に向ければ任意 local-part が直接届く
 *  - `address` = MX は他人が持つ(gmail.com)。転送でしか届かないので所有証明は code
 */
export type MailIdentityKind = "address" | "domain";

/** DNS TXT の値の頭。これが付いた TXT だけを所有証明として読む */
export const MAIL_IDENTITY_TXT_PREFIX = "atn-verify=";

/** 所有証明の TXT を貼る場所。`shibubu.ai` → `_atn-verify.shibubu.ai` */
export function verificationTxtName(domain: string): string {
  return `_atn-verify.${domain}`;
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
    const d = s.replace(/^@+/, "");
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
