import { z } from "zod";

// server.ts の各 tool 登録で使う zod shape。副作用(credential 解決・process.exit・stdio connect)を
// 一切持たない純粋な定義だけをここに置き、server.ts とテストの双方から import する。
// こうしておくことで「schema と実装(SendInput/pickContent)のドリフト」をテストで機械検査できる。

export const fileRefShape = z.object({
  name: z.string(),
  ref: z.string(),
  size: z.number().optional(),
  mime: z.string().optional(),
});

export const sendInputShape = {
  to: z.string().describe("@handle"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("force-send to a thread that is already_handled"),
};

export const replyInputShape = {
  thread_id: z.string().describe("thread id to reply to (including the thread shared with the owner)"),
  text: z.string().optional(),
  urls: z.array(z.string()).optional(),
  files: z.array(fileRefShape).optional(),
  force: z.boolean().optional().describe("force-send to a thread that is already_handled"),
  refs: z
    .array(z.string())
    .optional()
    .describe("ids of the notification items that were handled (marks them done when reporting to the owner instruction thread)"),
};

// triage(EP-0013 W3)の label 付け。MCP からは "none" を見せない(label 無し状態への復帰は
// human の web UI / API が担う — triage agent が未処理に戻す経路は作らない)。
export const labelInputShape = {
  message_id: z.string().describe("message id of the notification item"),
  label: z.enum(["action", "fyi", "discard"]).describe("action = needs handling / fyi = for information / discard = not needed"),
  summary: z
    .string()
    .optional()
    .describe("short summary (140 chars or less recommended). The MCP server seals it with the device key before sending"),
};

// 自然言語 rule(EP-0013 W4 / REQ-54)。runtime が owner の言葉を JSON に compile して渡す。
// server が layer(metadata / content)を導出し、正規化済み rule を応答として返す ——
// それを owner に 1 文で echo する(REQ-54「解釈を同一 thread で返す」)のが runtime の仕事。
// 同じ nl の再 put は更新になる(rule は増えない)
export const rulesPutInputShape = {
  nl: z.string().describe("the owner's words verbatim (e.g. 'batch newsletters at 9 every morning')"),
  scope: z
    .object({
      source_kind: z.enum(["mail", "openroly", "webhook", "android", "windows", "macos", "ios", "digest"]).optional(),
      app_id: z.string().optional().describe("source app (e.g. com.example.app). Values given here are stored in the clear as metadata"),
      time_window: z.string().optional(),
      sender: z.string().optional().describe("a sender term. Setting it makes this a content rule, stored encrypted on the server"),
      keywords: z.array(z.string()).optional().describe("body terms. Setting them makes this a content rule"),
    })
    .optional(),
  action: z.object({
    type: z.enum(["immediate", "digest", "discard", "cloud_visibility"]),
    schedule: z.string().optional().describe("\"HH:MM\" for digests (e.g. 09:00)"),
    tz: z.string().optional().describe("IANA timezone for digests (e.g. America/Los_Angeles; default UTC)"),
    visibility: z.enum(["full", "masked", "local_only", "none"]).optional().describe("for cloud_visibility"),
  }),
};
