#!/usr/bin/env bun
// openroly-mask CLI(PBI-0177)。
//   openroly-mask -- <MCP server の command と args>   … proxy として起動
//   openroly-mask --dry-run < text                     … 何が伏せられるか確認(stdin → stdout)
//
// **stdout には JSON-RPC 行(または --dry-run の結果)以外を絶対に書かない** — proxy 経路は
// MCP の stdio 面そのもので、1 行でも混ぜると親の handshake が壊れる。案内・エラーは全部 stderr。

import { dryRunMask, loadConfig, secretsPath } from "./masking.ts";
import { runProxy } from "./proxy.ts";

function usage(): string {
  return [
    "openroly-mask -- <command> [args...]   run as a proxy in front of any MCP server",
    "openroly-mask --dry-run                show on stdout what would be masked in the text from stdin",
    "",
    `secrets file: ${secretsPath()} (must be 0600; runs without masking if absent)`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--dry-run")) {
    const text = await Bun.stdin.text();
    let config;
    try {
      config = loadConfig();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    console.log(dryRunMask(text, config));
    return 0;
  }

  // bun は `openroly-mask -- foo bar` の `--` 自体を process.argv から取り除く(bun 自身の CLI 引数と
  // script 引数を区切る記法として消費される — 実測済み)。よって argv には既に子 command だけが
  // 残っている前提で良い(`--` を探して分割する必要が無い。子 command が独自に `--` を含む場合も
  // そのまま args へ渡る)
  const [command, ...childArgs] = argv;
  if (!command) {
    console.error("Usage:\n" + usage());
    return 2;
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  try {
    const handle = runProxy(
      {
        parentIn: Bun.stdin.stream(),
        parentOut: { write: (s) => process.stdout.write(s) },
        spawnChild: () => {
          const proc = Bun.spawn({
            cmd: [command, ...childArgs],
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
          });
          return { stdin: proc.stdin, stdout: proc.stdout, exited: proc.exited };
        },
      },
      config,
    );
    return await handle.exited;
  } catch (e) {
    console.error(`Could not start the child command: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
