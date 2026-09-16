// PBI-0558: sandbox の中の relay。broker が起こした「辞書を読める外の MCP server」へ、session の egress proxy を
// 通って繋ぐ(sandbox が開けている loopback の port は proxy の 1 本だけ = 新しい穴を足さない)。
// 繋がった後は MCP の byte を素通しするだけで JSON-RPC を読まない(mask は外の server の出口 json() が掛ける)。

import { connect } from "node:net";

/** broker/src/egress.rs の `MASK_HOST` と同じ綴り(`.invalid` は DNS で引けない予約名) */
export const MASK_HOST = "openroly-mask.invalid";

/**
 * `target`(`127.0.0.1:<proxy port>`)へ token 付きで CONNECT し、200 が返れば stdin ⇄ socket を繋いで null を返す
 * (以後 socket が閉じたら process を終える)。繋がらない / 200 でない / 何も返さずに切られた / 時間内に答えない は理由の文字列 ——
 * **stdin にはまだ触っていない**ので、呼び手はそのまま中の server として続けられる。
 */
export function openRelay(target: string, token: string, timeoutMs = 10_000): Promise<string | null> {
  const sep = target.lastIndexOf(":");
  const port = Number(target.slice(sep + 1));
  if (sep <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(`bad relay target ${JSON.stringify(target)}`);
  }
  return new Promise((resolve) => {
    const socket = connect({ host: target.slice(0, sep), port });
    let head = Buffer.alloc(0);
    const settle = (why: string | null) => {
      clearTimeout(timer);
      resolve(why);
      if (why !== null) socket.destroy();
    };
    const timer = setTimeout(() => settle("the masking server did not answer in time"), timeoutMs);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 4096) settle("unreadable answer from the proxy");
        return;
      }
      socket.off("data", onData);
      const status = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      if (!/^HTTP\/1\.[01] 200 /.test(status)) return settle(`the proxy answered ${JSON.stringify(status)}`);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.on("error", () => process.exit(1));
      socket.on("close", () => process.exit(0));
      // MCP は client が先に話すので head の後ろは通常空。在れば落とさない
      const rest = head.subarray(end + 4);
      if (rest.length > 0) process.stdout.write(rest);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      settle(null);
    };
    socket.on("connect", () =>
      socket.write(`CONNECT ${MASK_HOST}:1 HTTP/1.1\r\nHost: ${MASK_HOST}:1\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`),
    );
    socket.on("data", onData);
    socket.on("error", (e) => settle(e.message));
    socket.on("close", () => settle("closed by the proxy before it answered"));
  });
}
