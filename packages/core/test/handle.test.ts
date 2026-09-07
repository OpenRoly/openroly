import { describe, expect, test } from "bun:test";
import { normalizeHandle, parseRecipient, validateHandle } from "../src/handle.ts";

describe("normalizeHandle", () => {
  test("trim + 先頭@除去 + 小文字化", () => {
    expect(normalizeHandle(" @Aya ")).toBe("aya");
    expect(normalizeHandle("@@AYA")).toBe("aya");
  });
  test("冪等", () => {
    for (const input of [" @Aya ", "aya_01", "@X_9"]) {
      const once = normalizeHandle(input);
      expect(normalizeHandle(once)).toBe(once);
    }
  });
});

describe("validateHandle", () => {
  test("正常系", () => {
    expect(validateHandle("aya_01")).toEqual({ ok: true, handle: "aya_01" });
    expect(validateHandle(" @AYA ")).toEqual({ ok: true, handle: "aya" });
  });
  test("境界: 3 字と 30 字は ok、2 字と 31 字は ng", () => {
    expect(validateHandle("abc").ok).toBe(true);
    expect(validateHandle("a".repeat(30)).ok).toBe(true);
    expect(validateHandle("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateHandle("")).toEqual({ ok: false, reason: "too_short" });
    expect(validateHandle("a".repeat(31))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
  test("charset: 先頭は a-z、本体は a-z0-9_", () => {
    expect(validateHandle("1aya")).toEqual({ ok: false, reason: "invalid_start" });
    expect(validateHandle("_aya")).toEqual({ ok: false, reason: "invalid_start" });
    expect(validateHandle("aya-x")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validateHandle("aya.x")).toEqual({ ok: false, reason: "invalid_chars" });
    expect(validateHandle("あやか")).toEqual({ ok: false, reason: "invalid_start" });
  });
  test("予約語(RFC 2142 系含む)", () => {
    for (const h of ["postmaster", "admin", "abuse", "OpenRoly"]) {
      expect(validateHandle(h)).toEqual({ ok: false, reason: "reserved" });
    }
  });
});

describe("parseRecipient(PBI-0093 の provider 住所判定を含む)", () => {
  const domains = new Map([
    ["openai.mail.example.com", "openai"],
    ["gemini.mail.example.com", "gemini"],
  ]);

  test("providerDomains 無しは従来どおり handle / address の 2 値", () => {
    expect(parseRecipient("taro@openai.mail.example.com")).toEqual({
      kind: "address",
      address: "taro@openai.mail.example.com",
    });
    expect(parseRecipient("@aya")).toEqual({ kind: "handle", handle: "aya" });
  });

  test("domain が一致すれば provider 住所として切り分ける(大文字・先頭 @ も正規化)", () => {
    expect(parseRecipient("taro@openai.mail.example.com", domains)).toEqual({
      kind: "provider",
      provider: "openai",
      handle: "taro",
    });
    expect(parseRecipient("@TARO@gemini.mail.example.com", domains)).toEqual({
      kind: "provider",
      provider: "gemini",
      handle: "taro",
    });
  });

  test("domain 不一致・空 Map は address のまま(外部 peer)", () => {
    expect(parseRecipient("taro@openai.example.com", domains)).toEqual({
      kind: "address",
      address: "taro@openai.example.com",
    });
    expect(parseRecipient("taro@openai.mail.example.com", new Map())).toEqual({
      kind: "address",
      address: "taro@openai.mail.example.com",
    });
  });

  test("FQDN trailing dot の住所も同じ provider とみなす(レビュー(有界)の攻撃3/4 — 落とすと管理空間の住所が外部 address 扱いで漏れる)", () => {
    expect(parseRecipient("taro@openai.mail.example.com.", domains)).toEqual({
      kind: "provider",
      provider: "openai",
      handle: "taro",
    });
    // providerDomains に無い domain の trailing dot は従来どおり address(挙動不変)
    expect(parseRecipient("foo@example.com.", domains)).toEqual({
      kind: "address",
      address: "foo@example.com.",
    });
  });

  test("local-part が handle 規則を満たさない provider 住所は null(予約語・数字開始)", () => {
    expect(parseRecipient("admin@openai.mail.example.com", domains)).toBeNull();
    expect(parseRecipient("1taro@openai.mail.example.com", domains)).toBeNull();
    // handle 規則を満たさない local-part は provider 空間外の address にもしない —
    // local-part = 自分の handle に固定の設計(図37)なので解釈不能として弾く
  });
});
