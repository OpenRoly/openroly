// openroly-mask の stdio proxy 本体(PBI-0177)。JSON-RPC(MCP)を newline framing で親↔子の間に
// 挟み、`tools/call` / `resources/read` / `prompts/get` の **result** の文字列値を mask し、
// `tools/call` の **params** に含まれる placeholder を子へ渡す前に復元する。request id・
// notification はそのまま(id を書き換えると応答の対応が取れなくなる)。
// MCP stdio の framing(Content-Length 無しの改行区切り JSON)は @modelcontextprotocol/sdk@1.30.0
// の shared/stdio.js(ReadBuffer.readMessage / serializeMessage)を実測して確認済み。

import { Masker, type MaskConfig } from "./masking.ts";

const MASKED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

/** ReadableStream<Uint8Array> を改行区切りの行へ分解する(SDK の ReadBuffer と同じ切り方 —
 * \r を末尾から落とす。バッファは chunk をまたいで保持する) */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  // getReader()を使う(DOM lib の ReadableStream は for-await の型を持たない環境がある —
  // getReader は型が安定しているのでそちらに統一する)
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
  // 末尾に改行の無い残りは捨てる(SDK の ReadBuffer と同じ — 子が書き切る前に死んだ場合の
  // 半端な JSON 断片を親へ流さない。AC-X2)
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function parseLine(line: string): JsonRpcMessage | null {
  if (line.trim().length === 0) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === "object" ? (v as JsonRpcMessage) : null;
  } catch {
    return null;
  }
}

export interface ProxyHandle {
  /** 子 process の終了コード(await で待てる)。proxy 自身もこれで exit する(cli.ts の役目) */
  exited: Promise<number>;
}

export interface ProxyDeps {
  parentIn: ReadableStream<Uint8Array>;
  parentOut: { write: (s: string) => void };
  spawnChild: () => {
    stdin: {
      write: (s: string) => number | Promise<number>;
      flush: () => number | Promise<number>;
      end: () => number | Promise<number>;
    };
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
}

/**
 * 親(Claude Code 等) ⇄ openroly-mask ⇄ 子(任意の MCP server) を繋ぐ。id → method の対応表を持ち、
 * 応答が来た時に**その id が指す method**で mask するかを決める(応答の順不同に対応・AC-X3)。
 * 非 JSON 行(壊れた行・子の debug print 等)は解釈できないので**無変更で素通し**する
 * (子の log を壊さない・パース不能で proxy が落ちない)。
 */
export function runProxy(deps: ProxyDeps, config: MaskConfig): ProxyHandle {
  const masker = new Masker(config.secrets);
  const pendingById = new Map<string | number, string>();
  const child = deps.spawnChild();

  const parentToChild = (async () => {
    for await (const line of readLines(deps.parentIn)) {
      const msg = parseLine(line);
      if (!msg) {
        await child.stdin.write(line + "\n");
        await child.stdin.flush();
        continue;
      }
      if (msg.method !== undefined && msg.id !== undefined) pendingById.set(msg.id, msg.method);
      const forwarded: JsonRpcMessage =
        msg.method === "tools/call" && msg.params !== undefined
          ? { ...msg, params: masker.restoreValue(msg.params) }
          : msg;
      await child.stdin.write(`${JSON.stringify(forwarded)}\n`);
      await child.stdin.flush();
    }
    await child.stdin.end();
  })();

  const childToParent = (async () => {
    for await (const line of readLines(child.stdout)) {
      const msg = parseLine(line);
      if (!msg) {
        deps.parentOut.write(`${line}\n`);
        continue;
      }
      let out: JsonRpcMessage = msg;
      if (msg.id !== undefined) {
        const method = pendingById.get(msg.id);
        if (method) {
          pendingById.delete(msg.id);
          if (MASKED_METHODS.has(method) && msg.result !== undefined) {
            out = { ...msg, result: masker.maskValue(msg.result, config.patterns) };
          }
        }
      }
      deps.parentOut.write(`${JSON.stringify(out)}\n`);
    }
  })();

  // child.exited だけを待つ(親の stdin は Claude Code 側が握っており、いつ閉じるか proxy は
  // 制御できない — parentToChild の完了待ちを混ぜると子が死んだ後も exit できなくなる)。
  // childToParent は child.stdout の EOF で自然に終わる(child.exited と同時期)
  void parentToChild;
  void childToParent;
  return { exited: child.exited };
}
