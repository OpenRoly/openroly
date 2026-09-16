import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

// PBI-0557: 検知の口 = Claude Code の StopFailure hook(matcher "rate_limit"。cutoff 後の事実 —
// 公式 docs code.claude.com/docs/en/hooks の StopFailure 節: error 12 値の matcher を持つ。
// resets_at を運ぶ field は無いので --resets-at は付けていない)。ここで機械で刺すのは
// 「定義が在る事」だけ —— 実際の 429 は owner 機でしか起こせず、書き込みの中身(work stalled の
// diagnostic 1 行)は apps/cli/test/work-stalled.test.ts が合成 signal で測る。

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

describe("StopFailure hook(検知の口・PBI-0557)", () => {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));

  test("StopFailure に matcher rate_limit の hook が 1 本在る(docs の error 12 値のうち usage limit に当たる値)", () => {
    const entries = hooks.hooks?.StopFailure;
    expect(Array.isArray(entries)).toBe(true);
    const hit = entries.filter((e: any) => e.matcher === "rate_limit");
    expect(hit).toHaveLength(1);
    expect(hit[0].hooks).toHaveLength(1);
    expect(hit[0].hooks[0].type).toBe("command");
  });

  test("hook の command は plugin 同梱の stalled.sh を叩く(外の script を参照しない)", () => {
    const cmd = hooks.hooks.StopFailure.find((e: any) => e.matcher === "rate_limit").hooks[0].command as string;
    expect(cmd).toContain("$CLAUDE_PLUGIN_ROOT/hooks/stalled.sh");
    expect(cmd).not.toMatch(/curl|http/i); // 外へ出る検知にしない
  });

  test("stalled.sh は work stalled --reason usage_limit を叩き、起動口は binary → bun(実 file の中身)", () => {
    const sh = readFileSync(join(pluginRoot, "hooks", "stalled.sh"), "utf8");
    expect(sh).toContain("work stalled --reason usage_limit");
    expect(sh).toContain("$OPENROLY_DIR/bin/openroly"); // binary を先に(statusline.sh と同じ)
    expect(sh).toContain("apps/cli/src/openroly.ts"); // 無い時の bun + repo checkout
    expect(statSync(join(pluginRoot, "hooks", "stalled.sh")).mode & 0o111).toBeGreaterThan(0); // 実行可能
  });

  test("stalled.sh は失敗しても黙って exit 0(StopFailure の規律: 入力を止めない)", () => {
    const sh = readFileSync(join(pluginRoot, "hooks", "stalled.sh"), "utf8");
    // 最後の exit は 0・出力は /dev/null へ(前景でエラーを吐かない)
    const tail = sh.trimEnd().split("\n").slice(-3).join("\n");
    expect(tail).toContain("exit 0");
    expect(sh).toContain(">/dev/null 2>&1");
  });
});

// PBI-0565: 上の 4 本は file の文字列しか見ないので、repo checkout の口が `adapters/` を指して黙って
// 何もしない破れを通していた。ここは stalled.sh を実際に走らせ、PATH の偽 bun に届いた引数を読む。
describe("stalled.sh を実行する(binary が無い機の bun + repo checkout の口・PBI-0565)", () => {
  const repoRoot = resolve(pluginRoot, "..", "..", "..");
  const STOP_FAILURE = JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" });

  function run(withCredentials: boolean): { code: number; record: string } {
    const dir = mkdtempSync(join(tmpdir(), "stalled-hook-"));
    const home = join(dir, "home");
    const fakeBin = join(dir, "fake-bin");
    const record = join(dir, "bun-args");
    Bun.spawnSync(["mkdir", "-p", home, fakeBin]);
    if (withCredentials) writeFileSync(join(home, "credentials.json"), "{}");
    writeFileSync(join(fakeBin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 });
    const r = Bun.spawnSync(["bash", join(pluginRoot, "hooks", "stalled.sh")], {
      stdin: new TextEncoder().encode(STOP_FAILURE),
      env: { HOME: home, OPENROLY_HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
    });
    // 本体は `&` で後ろに回るので、記録が書かれるまで少し待つ(偽 bun は printf 1 回 = 数十 ms)
    const until = Date.now() + 2_000;
    while (!existsSync(record) && Date.now() < until) Bun.sleepSync(50);
    return { code: r.exitCode ?? -1, record: existsSync(record) ? readFileSync(record, "utf8") : "" };
  }

  test("AC-1: bin/openroly が無い時は この checkout の apps/cli/src/openroly.ts を bun で叩く", () => {
    const { code, record } = run(true);
    expect(code).toBe(0);
    expect(record.split("\n").filter(Boolean)).toEqual([
      join(repoRoot, "apps", "cli", "src", "openroly.ts"),
      "work",
      "stalled",
      "--reason",
      "usage_limit",
    ]);
  }, 10_000);

  test("AC-X1: credentials.json が無ければ bun を呼ばず exit 0", () => {
    const { code, record } = run(false);
    expect(code).toBe(0);
    expect(record).toBe("");
  }, 10_000);
});
