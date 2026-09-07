import { describe, expect, test } from "bun:test";
import { fromEnvelopePlaintext, isRenderableUrl } from "../src/content.ts";

// PBI-0153: capture 通知(webhook L2 seal・collector L1 seal)は envelope 平文に
// {title, body, url} を持つ。fromEnvelopePlaintext がそれを MessageContent の
// text/urls に畳む — 畳まないと web / MCP inbox_read が「(no text)」になる。

describe("fromEnvelopePlaintext(PBI-0153)", () => {
  test("AC-1: title + body → text は title\\nbody に畳まれる", () => {
    expect(fromEnvelopePlaintext({ title: "CI failed", body: "2 tests" })).toEqual({
      text: "CI failed\n2 tests",
    });
  });

  test("AC-3: title だけ(body 無し)でも text が出る(「(no text)」にならない)", () => {
    expect(fromEnvelopePlaintext({ title: "L1 sealed" })).toEqual({ text: "L1 sealed" });
  });

  test("url は urls[] に入る", () => {
    expect(fromEnvelopePlaintext({ title: "t", body: "b", url: "https://example.com/x" })).toEqual({
      text: "t\nb",
      urls: ["https://example.com/x"],
    });
  });

  test("AC-4: 従来形(text/files/urls)は回帰なし", () => {
    expect(fromEnvelopePlaintext({ text: "hello there" })).toEqual({ text: "hello there" });
    expect(
      fromEnvelopePlaintext({ files: [{ name: "a.pdf", ref: "openroly-file:x" }], urls: ["https://example.com"] }),
    ).toEqual({ files: [{ name: "a.pdf", ref: "openroly-file:x" }], urls: ["https://example.com"] });
  });

  test("AC-X1: body 8,000 字でも切らずにそのまま畳む(切り詰めは表示側の役目)", () => {
    const long = "あ".repeat(8000);
    const out = fromEnvelopePlaintext({ title: "t", body: long });
    expect(out.text).toBe(`t\n${long}`);
    expect(out.text?.length).toBe(8002);
  });

  test("AC-X2: 未知 key(foo)が混ざっても無視して落ちない", () => {
    expect(
      fromEnvelopePlaintext({ title: "t", body: "b", foo: "bar" } as never),
    ).toEqual({ text: "t\nb" });
  });

  test("title/text どちらも無ければ空の MessageContent", () => {
    expect(fromEnvelopePlaintext({})).toEqual({});
  });

  // ---- 順70 review の攻撃(envelope 平文は L1 collector = client が任意に組める) ----

  test("破れ 1: title 空・body だけの L1 平文(Full text mode)でも本文が出る", () => {
    expect(fromEnvelopePlaintext({ body: "only body" })).toEqual({ text: "only body" });
    expect(fromEnvelopePlaintext({ title: "   ", body: "only body" })).toEqual({ text: "only body" });
  });

  test("破れ 2: javascript: / data: の url は link にしない(http/https/mailto だけ通す)", () => {
    expect(fromEnvelopePlaintext({ title: "t", url: "javascript:alert(1)" })).toEqual({ text: "t" });
    expect(fromEnvelopePlaintext({ title: "t", urls: ["data:text/html,x", "https://ok.example"] })).toEqual({
      text: "t",
      urls: ["https://ok.example"],
    });
    expect(fromEnvelopePlaintext({ title: "t", url: "mailto:a@example.com" }).urls).toEqual([
      "mailto:a@example.com",
    ]);
  });

  test("破れ 3: urls が配列でない平文を 1 文字ずつの link に展開しない", () => {
    expect(fromEnvelopePlaintext({ title: "t", urls: "https://a.example" } as never)).toEqual({ text: "t" });
  });

  test("破れ 2: isRenderableUrl は描画側(平文 content 経路)でも同じ判定を出す", () => {
    expect(isRenderableUrl("https://a.example")).toBe(true);
    expect(isRenderableUrl("HTTP://a.example")).toBe(true);
    expect(isRenderableUrl("mailto:a@example.com")).toBe(true);
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "openroly-file:x", "", 5, null]) {
      expect(isRenderableUrl(bad)).toBe(false);
    }
  });

  test("破れ 3: title/body/files が文字列・配列でなければ無視する", () => {
    expect(fromEnvelopePlaintext({ title: 123, body: { a: 1 } } as never)).toEqual({});
    expect(fromEnvelopePlaintext({ files: [{ ref: 5 }] } as never)).toEqual({});
    expect(fromEnvelopePlaintext({ files: { name: "x" } } as never)).toEqual({});
  });
});
