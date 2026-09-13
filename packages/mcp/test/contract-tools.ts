/**
 * 要件 §16 Runtime Access Contract で **公開してよい tool の全部**。手で書く一覧である事に意味が
 * ある —— server.ts から数えて作ると「増やしたら増える」だけの検査になり、生やしてはいけない物
 * (memory.* / task.* / browser.*)を捕まえられない。
 *
 * PBI-0031 で approval_get・PBI-0094 で reply・EP-0013 W3 で notification_label・W4 で
 * rules_put / rules_list・PBI-0129 で agents_list・PBI-0400 で work_* 6 本・PBI-0406 で
 * work_capsule / work_capsules の 2 本(19 → 21・CAP-3 V2「1 回打つ口」。checkpoint(V3)
 * とは別名 —— 定期 checkpoint が来た時に意味が割れない)・PBI-0413 で work_freeze の 1 本
 * (21 → 22・CAP-3 V10・v0 Authority。intent 無しでは必ず拒否される。claim は held な work を
 * 上書きできないので権限段が無く、MCP 口も無いまま)・PBI-0433 で work_assigned / work_context_put /
 * work_context_search の 3 本(22 → 25・手描き 1 枚目の Work Project。handoff が書き、次の agent が要る key だけ取る)・
 * PBI-0434 で work_task_create / work_team / work_message の 3 本(25 → 28・手描き 2 枚目の task と住所)・
 * PBI-0439 で work_transfer / work_accept の 2 本(28 → 30・CAP-3 V7 runtime transfer の source 側と target 側)・
 * PBI-0440 で work_fork の 1 本(30 → 31・CAP-3 V8 fork / review。枝を拾うのは同じ work_accept)・
 * PBI-0443 で work_context_publish の 1 本(31 → 32・task → Work Project へ出す唯一の口)・
 * PBI-0447 で work_task_merge の 1 本(32 → 33・task の folder を Work Project の作業ツリーへ合流)。
 *
 * **この一覧は 1 箇所しか無い**（有界レビュー 2026-09-09）: plugin-launcher.test.ts と
 * launcher-live.test.ts が同じ物を 2 回書いていて、PBI-0400 は前者だけを 19 本に直した ——
 * 後者は 13 本のまま **CI が赤いまま commit された**。写しを作らず、両方がここを import する。
 */
export const CONTRACT_TOOLS = [
  "agents_list",
  "approval_get",
  "contacts_get",
  "contacts_list",
  "inbox_list",
  "inbox_read",
  "mark_read",
  "notification_label",
  "reply",
  "rules_list",
  "rules_put",
  "send",
  "whoami",
  // Work Core の口(PBI-0400 / CAP-3 V9・図79)。claim は held な work を上書きできず権限段自体が要らないので
  // 口を足していない(握りを移すのは work_transfer / work_accept = PBI-0439・枝を立てるのは work_fork = PBI-0440)
  "work_accept",
  "work_assigned",
  "work_capsule",
  "work_capsules",
  "work_context_publish",
  "work_context_put",
  "work_context_search",
  "work_current",
  "work_events",
  "work_fork",
  "work_freeze",
  "work_get",
  "work_handoff",
  "work_message",
  "work_promote",
  "work_proof",
  "work_task_create",
  "work_task_merge",
  "work_team",
  "work_transfer",
];
