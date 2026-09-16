// Peek log(PBI-0224)。dedicated session で model が実際に受け取った面(tool 往復)を、model が見たのと
// **同じ masked 形**で端末の local file に 1 行ずつ残す。`openroly peek` がこれを表示する。
//
// - 書く場所は broker の session_dir(`$OPENROLY_BROKER_HOME/sessions/<request_id>/`・instruction.txt /
//   stdout.log と同じ dir)。id は broker が dedicated session の子 env `OPENROLY_SESSION_ID` に載せる。
//   manual session には無いので何もしない(人が画面で見ている面を二重に記録しない)。
// - **値は一度も復元しない**。この file は restore 系の関数を import しない(旧 diagrams-check 規則 (c))。
//   server.ts が model に返す masked 済み文字列をそのまま受け取って書くだけ。
// - **fail-open**: open / write の失敗は stderr 1 行で握りつぶし、tool 実行を止めない(peek は観測
//   であって機能ではない。log が書けない事で agent の仕事を止めない)。
// - id は broker 側 `is_safe_request_id` と同じ境界(英数と _ - のみ)を MCP 側でも持つ —— env は
//   信頼境界の外(runtime の設定 file 経由でも書ける)なので `../x` を dir に混ぜない。

import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { createConnection } from "node:net";
import { join } from "node:path";
import { legacyDir, LEGACY_STATE_DIR, STATE_DIR } from "@openroly/core";

type Env = Record<string, string | undefined>;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** broker の常駐先(`openroly` CLI の brokerHome と同じ既定)。sessions/<request_id>/ の親。
 * 旧 `~/.atn/broker` だけが在る端末ではそれを引き継ぐ(PBI-0344 AC-3) */
export const brokerHome = (env: Env = process.env): string =>
  env.OPENROLY_BROKER_HOME ??
  legacyDir(
    join(homedir(), STATE_DIR, "broker"),
    join(homedir(), LEGACY_STATE_DIR, "broker"),
    existsSync,
  );

export interface PeekRecord {
  tool: string;
  /** model が渡した引数(server.ts が maskValue 済みで渡す。生の値が来ても log には出さない) */
  input: unknown;
  /** model に返した text そのもの(masked 済み) */
  output: string;
}

export interface Peek {
  path: string;
  record: (r: PeekRecord) => void;
}

const warn = (e: unknown) => console.error(`peek: ${e instanceof Error ? e.message : String(e)}`);

/**
 * `OPENROLY_SESSION_DIR`(PBI-0230・hub wake で broker が載せる turn dir)の門。絶対 path で
 * `<home>/sessions/` 配下・leaf を持つ物だけを通す。env は信頼境界の外(runtime の設定 file 経由
 * でも書ける)なので SESSION_ID と同じ二重防壁 —— 通らない物は peek を書かない(fail-open。
 * 観測で agent の仕事を止めない)。broker は `sessions/hub/<account>/<runtime>/` を載せるので、
 * 正常系はこの門を素通りする。
 */
export function checkedSessionDir(dir: string, home: string): string | null {
  const norm = dir.replace(/\/+$/, "");
  const prefix = join(home, "sessions") + "/";
  if (
    !isAbsolute(norm) ||
    !norm.startsWith(prefix) ||
    norm.length <= prefix.length ||
    norm.split("/").includes("..")
  ) {
    console.error("peek: invalid session dir");
    return null;
  }
  return norm;
}

/**
 * `OPENROLY_SESSION_ID` が無ければ null(manual session = 何もしない)。有れば
 * `<home>/sessions/<id>/peek.jsonl` を append で開き 0600 にして header 1 行を書く。
 * hub wake(PBI-0230)では `OPENROLY_SESSION_DIR` が turn dir を指し、そちらを優先する
 * (cwd 固定の会話 dir に peek をまとめる。folder payload は使わない)。失敗は stderr 1 行で
 * null(= 以後 record しない)。
 */
export function openPeek(env: Env = process.env, home: string = brokerHome(env)): Peek | null {
  const id = env.OPENROLY_SESSION_ID;
  if (!id) return null;
  if (!SESSION_ID_RE.test(id)) {
    console.error("peek: invalid session id");
    return null;
  }
  const dirOverride = env.OPENROLY_SESSION_DIR;
  let dir: string;
  if (dirOverride !== undefined) {
    // 門で落ちた時は標準位置へフォールバックしない(怪しい env は黙って別の場所に書かない)
    const checked = checkedSessionDir(dirOverride, home);
    if (!checked) return null;
    dir = checked;
  } else {
    dir = join(home, "sessions", id);
  }
  const path = join(dir, "peek.jsonl");
  const line = (v: unknown) => JSON.stringify(v) + "\n";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path, line({ session: id, runtime: env.OPENROLY_RUNTIME_KIND ?? null, started: new Date().toISOString() }), {
      mode: 0o600,
    });
    // mode は umask と既存 file に負けるので、開けた後に必ず 0600 へ寄せる
    chmodSync(path, 0o600);
  } catch (e) {
    warn(e);
    return null;
  }
  return {
    path,
    // 1 呼び出し 1 行の同期 append。1 process 内で逐次なので行が混ざらない(AC-X3)
    record: (r) => {
      try {
        appendFileSync(path, line(r), { mode: 0o600 });
      } catch (e) {
        warn(e);
      }
    },
  };
}

/**
 * PBI-0558: この session の masking の状態を session_dir/masking.txt に 1 行(`openroly peek` が header の下に出す)。
 * broker は外の server を起こした時に `masking: outside sandbox` を書き、relay が繋がらなかった時はここで
 * `masking: unavailable — <理由>` に上書きする。manual session(id 無し)では何もしない・失敗は stderr 1 行(peek と同じ fail-open)
 */
export function noteMasking(env: Env, line: string, home: string = brokerHome(env)): void {
  const id = env.OPENROLY_SESSION_ID;
  if (!id || !SESSION_ID_RE.test(id)) return;
  try {
    const dir = join(home, "sessions", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "masking.txt"), `${line}\n`);
  } catch (e) {
    warn(e);
  }
}

// broker の hook socket 名(broker/src/triggers.rs の HOOK_SOCKET_NAME と同じ名前)。
const HOOK_SOCKET_NAME = "broker.sock";

/**
 * hook socket への tool 報告(PBI-0229)。broker が session の last_tool / tool_count を持つ為の
 * 上流。`OPENROLY_SESSION_ID` が無ければ null(manual session = 何もしない)。**fail-open**:
 * socket が無い / 繋がらない端末(broker 未起動)では 1 行も送らず、tool 実行は止めない(AC-X2)。
 * 1 呼び出し 1 接続 1 行(`{"type":"tool","session":id,"tool":name}`)で、broker は答えを
 * 返さない(tool は投げっぱなし。status / cancel だけが 1 行の答えを受け取る)。
 */
export function openSessionUpdate(
  env: Env = process.env,
  home: string = brokerHome(env),
): ((tool: string) => void) | null {
  const id = env.OPENROLY_SESSION_ID;
  if (!id) return null;
  if (!SESSION_ID_RE.test(id)) return null;
  const sockPath = join(home, HOOK_SOCKET_NAME);
  return (tool) => {
    try {
      const client = createConnection(sockPath);
      // broker 未起動 / socket 消滅は握りつぶす(観測で agent の仕事を止めない = peek と同じ)
      client.on("error", () => {});
      client.on("connect", () => {
        client.write(JSON.stringify({ type: "tool", session: id, tool }) + "\n", () => client.end());
      });
    } catch (e) {
      warn(e);
    }
  };
}
