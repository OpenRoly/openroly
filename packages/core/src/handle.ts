// public handle の規則。判定順序は docs/diagrams.md 図2 と一致させる:
// normalize → 長さ → charset(先頭/本体) → 予約語。
// ASCII 限定で開始(未決: Unicode handle。狭→広は互換なので後から広げられる)。
// handle は email-compatible address の local-part にもなるため(アーキ§8)、
// 予約語には RFC 2142 の標準 mailbox 名を含める。

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "abuse",
  "admin",
  "administrator",
  "agent",
  "api",
  "contact",
  "hostmaster",
  "help",
  "info",
  "mail",
  "marketing",
  "mod",
  "moderator",
  "noc",
  "noreply",
  "no_reply",
  "official",
  "openroly",
  "postmaster",
  "root",
  "sales",
  "security",
  "staff",
  "support",
  "system",
  "team",
  "webmaster",
  "www",
]);

export type HandleErrorReason =
  | "too_short"
  | "too_long"
  | "invalid_start"
  | "invalid_chars"
  | "reserved";

export type HandleResult =
  | { ok: true; handle: string }
  | { ok: false; reason: HandleErrorReason };

/**
 * handle 記法の先頭 `@` —— **1 個だけ**、直後が `@` でも空白でもない時に限る(PBI-0347)。
 * `@@alice` / `@ alice` は剥がさずに残し、後段の charset 判定で弾かせる(typo を黙って直さない)。
 * 剥がした後に `@` や空白が先頭へ来ないので、normalizeHandle が冪等であり続ける。
 * `@` を剥がす所(宛先判定・持ち込み domain・CLI)は全部これを使う。
 */
export const LEADING_AT = /^@(?=[^@\s])/;

/** trim → 先頭の @ を 1 個だけ除去 → 小文字化。冪等。 */
export function normalizeHandle(input: string): string {
  return input.trim().replace(LEADING_AT, "").toLowerCase();
}

export function validateHandle(input: string): HandleResult {
  const handle = normalizeHandle(input);
  if (handle.length < HANDLE_MIN) return { ok: false, reason: "too_short" };
  if (handle.length > HANDLE_MAX) return { ok: false, reason: "too_long" };
  if (!/^[a-z]/.test(handle)) return { ok: false, reason: "invalid_start" };
  if (!/^[a-z][a-z0-9_]*$/.test(handle))
    return { ok: false, reason: "invalid_chars" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  return { ok: true, handle };
}

/**
 * 宛先文字列の判定(W14a / PBI-0087)。`@` を含まない(または先頭にだけ含む)= OpenRoly の
 * @handle、途中に含む = 外部 address(email)。正本はこの 1 関数で、送信(POST /v1/send)と
 * 今後の mail inbound(順 31)が同じ判定を使う。null は「宛先として解釈できない」。
 *
 * address は実用最小の RFC 5322 縮小形(`local@domain`・domain に dot 必須・空白不可・
 * 320 文字上限 = RFC 5321 path 上限)。quoted local-part 等は対象外で弾く —
 * OpenRoly から外部へ出すのは plain address に限る。
 *
 * provider 住所(PBI-0093 / 図37): 第 2 引数 `providerDomains`(domain → provider の Map)を
 * 渡すと、domain が一致する address を `{ kind: "provider" }` として切り分ける。Map は
 * 呼び出し側(server)が OPENROLY_MAIL_DOMAIN から組み立てる — core は env を持たない。
 * 引数を渡さない呼び出しは従来どおり(handle / address の 2 値。既存 test 無変更)。
 * local-part は自分の handle に固定される設計なので、handle 規則を満たさない
 * local-part の provider 住所は解釈不能(null)として弾く。
 */
export type Recipient =
  | { kind: "handle"; handle: string }
  | { kind: "address"; address: string }
  | { kind: "provider"; provider: string; handle: string };

export function parseRecipient(
  input: string,
  providerDomains?: ReadonlyMap<string, string>,
): Recipient | null {
  const s = input.trim();
  if (s === "") return null;
  // 先頭の @ は handle 記法(`@aya`)。除去後に @ が残るなら address
  const withoutAt = s.replace(LEADING_AT, "");
  if (withoutAt.includes("@")) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(withoutAt) && withoutAt.length <= 320) {
      const [local, rawDomain] = withoutAt.split("@") as [string, string];
      // 小文字化は domain だけ(PBI-0347)。local-part は受信 host しか解釈しない(RFC 5321 では
      // case-sensitive)ので原形で運ぶ。「同じ相手か」の比較は store 側が lower() で当てる(migration 061)
      const domain = rawDomain.toLowerCase();
      // FQDN の trailing dot(`openai.mail.example.com.`)も同じ provider とみなす —
      // 落とさないと OpenRoly 管理空間の住所が表記ゆれだけで**外部 address 扱い**になり、
      // 未登録住所を外の mail に出す(図37 の不変条件が core の判定だけで破れる)。
      // providerDomains に無い通常 address は strip 後も無いので挙動不変
      const provider =
        providerDomains?.get(domain) ?? providerDomains?.get(domain.replace(/\.+$/, ""));
      if (provider !== undefined) {
        const h = validateHandle(local);
        return h.ok ? { kind: "provider", provider, handle: h.handle } : null;
      }
      return { kind: "address", address: `${local}@${domain}` };
    }
    return null;
  }
  const h = validateHandle(withoutAt);
  return h.ok ? { kind: "handle", handle: h.handle } : null;
}

// ---- phone number(PBI-0152) ----
//
// **正規化はここ 1 箇所**。登録側(PUT /v1/me/phone)と解決側(POST /v1/sessions/password)が
// 別々に整形すると、「登録できたのにサインインできない番号」が生まれる。
// 国番号の推測はしない(`090…` を勝手に `+8190…` にしない) —— 間違えると他人の番号になる。

/** 入力が phone number の**つもり**か。`@` を含む物・handle は除く(識別子の三択に使う) */
export function looksLikePhoneNumber(input: string): boolean {
  // 判定は normalizePhoneNumber に寄せる(2 つ目の規則を作らない)
  return normalizePhoneNumber(input) !== null;
}

/**
 * E.164 に寄せる(`+` + 数字 7〜15 桁)。整形できなければ null。
 * `+81 90-1234-5678` → `+819012345678` / `09012345678` → `09012345678`(国番号は補わない)
 */
export function normalizePhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  // **文字が混ざっていたら捨てる**: 数字以外を落とすだけだと `+81-90-abcd-5678` が
  // `+81905678` という別人の番号になる。許すのは先頭の + と 数字 / 空白 / ( ) - だけ
  if (!/^\+?[\d\s()-]+$/.test(trimmed)) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

/** log / activity 用。**全桁を残さない**(下 4 桁だけ) */
export function maskPhoneNumber(normalized: string): string {
  return `…${normalized.slice(-4)}`;
}
