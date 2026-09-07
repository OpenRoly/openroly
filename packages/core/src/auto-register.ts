// runtime 自動登録(PBI-0023 / REQ-19)の materialize 面 —— `openroly adopt`(apps/cli)が stderr 1 行目に
// 出す reason 文字列と、それを受けた server(apps/server/src/auto-register.ts)が register_ack.detail
// と比較する文字列は、broker(Rust)が 2 プロセスの間をそのまま素通しする契約でしか成立しない
// (broker は stderr の 1 行目を切り出して運ぶだけで、意味は解釈しない)。
//
// 別々の workspace（apps/cli / apps/server）にリテラルを重複させると、片方だけ書き換えても
// 何も落ちず、判定が silently `retry` に落ちて無限ループになる(47f2807 が踏んだ欠陥 — PBI-0023
// F3)。@openroly/core は両方から届く共通の依存(apps/server → @openroly/core 直接、apps/cli → @openroly/adapter →
// @openroly/core)なので、正本をここ 1 箇所に置く。

/** 端末に human が入れた同 kind の credential が既に生きている(奪わずに諦める。再試行しない) */
export const CREDENTIAL_OWNED_BY_HUMAN = "credential_owned_by_human";

/** 所有権の生死が確認できなかった(server 到達不能・5xx 等)。fail-closed で拒否するが、
 * human の意思表示ではないので機械的失敗として次の hello で再試行する */
export const CREDENTIAL_CHECK_FAILED = "credential_check_failed";
