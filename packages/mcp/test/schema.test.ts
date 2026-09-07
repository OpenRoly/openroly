import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { replyInputShape, rulesPutInputShape, sendInputShape } from "../src/schemas.ts";

// server.ts が実際に server.tool("send", ..., sendInputShape, ...) へ渡すのと同じ shape を
// ここで直接 import して検査する。contract.test.ts は tools.ts(HTTP 経由)しか通らないため、
// server.ts の zod schema が SendInput/pickContent から乖離しても検出できなかった(files 欠落の回帰)。

describe("MCP send tool の zod schema(packages/mcp/src/server.ts と同一の shape)", () => {
  test("files 添付を保持する(regression: files が schema に無いと silently drop される)", () => {
    const parsed = z.object(sendInputShape).parse({
      to: "@shibu",
      files: [{ name: "doc.pdf", ref: "blob://abc", size: 123, mime: "application/pdf" }],
    });
    expect(parsed.files).toEqual([
      { name: "doc.pdf", ref: "blob://abc", size: 123, mime: "application/pdf" },
    ]);
  });

  test("text だけの最小 payload も通る", () => {
    const parsed = z.object(sendInputShape).parse({ to: "@shibu", text: "hi" });
    expect(parsed.text).toBe("hi");
    expect(parsed.files).toBeUndefined();
  });
});

describe("MCP reply tool の zod schema(PBI-0094)", () => {
  test("thread_id + text の最小 payload が通り、files も保持される", () => {
    const parsed = z.object(replyInputShape).parse({
      thread_id: "thr_abc",
      text: "完了",
      files: [{ name: "a.txt", ref: "openroly-file:x" }],
    });
    expect(parsed.thread_id).toBe("thr_abc");
    expect(parsed.files).toEqual([{ name: "a.txt", ref: "openroly-file:x" }]);
  });
  test("thread_id は必須", () => {
    expect(z.object(replyInputShape).safeParse({ text: "完了" }).success).toBe(false);
  });
});

describe("MCP rules_put tool の zod schema(EP-0013 W4 / REQ-54)", () => {
  test("metadata rule の最小 payload が通る", () => {
    const parsed = z.object(rulesPutInputShape).parse({
      nl: "newsletter は毎朝 9 時にまとめて",
      scope: { app_id: "github" },
      action: { type: "digest", schedule: "09:00", tz: "Asia/Tokyo" },
    });
    expect(parsed.nl).toBe("newsletter は毎朝 9 時にまとめて");
    expect(parsed.action).toEqual({ type: "digest", schedule: "09:00", tz: "Asia/Tokyo" });
  });

  test("sender / keywords を含めると content rule の形になり、action type の外れは弾かれる", () => {
    const content = z.object(rulesPutInputShape).parse({
      nl: "invoice は捨てて",
      scope: { sender: "billing@vendor.example", keywords: ["invoice"] },
      action: { type: "discard" },
    });
    expect(content.scope).toEqual({ sender: "billing@vendor.example", keywords: ["invoice"] });
    expect(z.object(rulesPutInputShape).safeParse({ nl: "x", action: { type: "archive" } }).success).toBe(false);
    expect(
      z.object(rulesPutInputShape).safeParse({ nl: "x", action: { type: "cloud_visibility", visibility: "public" } })
        .success,
    ).toBe(false);
  });
});
