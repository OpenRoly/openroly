import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

// PBI-0777: Claude Code の中だけで「始める → 渡す → 続きを見る」が閉じる slash command 3 本。
// **file は prompt なので、実行結果は測れない**。測るのは形と契約の 2 つ:
//   ① plugin の dir 構成に載っていて、名前が絵のとおり(start / give / follow)
//   ③ 本文が **実在する CLI の動詞だけ**を指す(綴りは openroly.ts から引く。ここに書き写さない)
//   ④ start / give が MCP tool を指していない(MCP 経由は runtime credential = 403 human_only)
// ② (install した dir に入る)は packages/adapter 側 —— 配る経路を持つのがあちらなので。

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const commandsDir = join(repoRoot, "adapters/official/claude/commands");
const NAMES = ["start", "give", "follow"] as const;
const body = (n: string) => readFileSync(join(commandsDir, `${n}.md`), "utf8");

/** `openroly` CLI が実際に持つ動詞。**USAGE と WORK_SUBS から引く** —— test に綴りを書くと、
 *  CLI 側で消えた動詞を command が指したままでも緑になる(式 pin ではなく値集合の同値) */
function cliVerbs(): { top: Set<string>; work: Set<string> } {
  const src = readFileSync(join(repoRoot, "apps/cli/src/openroly.ts"), "utf8");
  const usage = /const USAGE = `([\s\S]*?)\n`;/.exec(src)?.[1];
  if (usage == null) throw new Error("USAGE block not found in openroly.ts");
  const top = new Set([...usage.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!));
  // work の sub は Set literal + 後から足す `.add("x")` の 2 形(片方だけ読むと取りこぼす)
  const literal = /const WORK_SUBS = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";
  const work = new Set([
    ...[...literal.matchAll(/"([a-z][a-z-]*)"/g)].map((m) => m[1]!),
    ...[...src.matchAll(/WORK_SUBS\.add\("([a-z][a-z-]*)"\)/g)].map((m) => m[1]!),
  ]);
  return { top, work };
}

/** Work Context の well-known key。**packages/core から引く** —— 並べ直されても増えても、
 *  give の数える key がずれた事をここが言う(綴りを test に書き写さない) */
function wellKnownContextKeys(): string[] {
  const src = readFileSync(join(repoRoot, "packages/core/src/work-context.ts"), "utf8");
  const block = /WORK_CONTEXT_WELL_KNOWN_KEYS = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
  if (block == null) throw new Error("WORK_CONTEXT_WELL_KNOWN_KEYS not found in work-context.ts");
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** MCP server が公開している tool 名(server.ts の `tool("<name>"` から引く) */
function mcpToolNames(): string[] {
  const src = readFileSync(join(repoRoot, "packages/mcp/src/server.ts"), "utf8");
  return [...new Set([...src.matchAll(/\btool\(\s*"([a-z][a-z_0-9]*)"/g)].map((m) => m[1]!))];
}

/** 本文が打つと言っている `openroly <verb> [<sub>]` の全部 */
function calls(text: string): { verb: string; sub: string | null }[] {
  return [...text.matchAll(/\bopenroly ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)].map((m) => ({
    verb: m[1]!,
    sub: m[2] ?? null,
  }));
}

describe("PBI-0777 AC-1/2/4/5: plugin に載る 3 つの slash command", () => {
  test("AC-5: commands/ に 3 file が在り、frontmatter の name が絵のとおり", () => {
    for (const n of NAMES) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(body(n))?.[1];
      expect(front).toBeString();
      expect(/^name:\s*(\S+)/m.exec(front!)?.[1]).toBe(n);
      // 人が一覧で読む 1 行。無い command は `/openroly:` の一覧で無名になる
      expect(/^description:\s*\S/m.test(front!)).toBe(true);
    }
  });

  test("AC-6: 3 本とも同じ前置き —— PATH に無い / login していない時に何をすれば良いかを 1 行で言う", () => {
    const block = (n: string) => /<!-- openroly:preflight -->([\s\S]*?)<!-- \/openroly:preflight -->/.exec(body(n))?.[1];
    const first = block("start");
    expect(first).toBeString();
    expect(first).toContain("openroly login");
    // 3 本で 1 字でもずれたら、同じ詰まりに 3 通りの案内が出る(面ごとに書くのをここで止める)
    for (const n of NAMES) expect(block(n)).toBe(first!);
  });

  test("③ 本文が指す動詞は全部 CLI に実在する(綴りは openroly.ts から引く)", () => {
    const { top, work } = cliVerbs();
    expect(top.size).toBeGreaterThan(10); // 引けていないまま「全部在った」と言わない
    expect(work.size).toBeGreaterThan(10);
    for (const n of NAMES) {
      const found = calls(body(n));
      expect(found.length).toBeGreaterThan(1); // 動詞を 1 つも指さない prompt を緑にしない
      for (const c of found) {
        expect({ file: n, ...c, known: top.has(c.verb) }).toMatchObject({ known: true });
        if (c.verb === "work" && c.sub != null) {
          expect({ file: n, sub: c.sub, known: work.has(c.sub) }).toMatchObject({ known: true });
        }
      }
    }
  });

  test("④ start / give は MCP tool を指さない(MCP 経由は runtime credential = 403 human_only)", () => {
    const names = mcpToolNames();
    expect(names.length).toBeGreaterThan(10);
    for (const n of NAMES) {
      for (const tool of names) expect({ file: n, tool, used: body(n).includes(tool) }).toMatchObject({ used: false });
    }
  });

  test("AC-3: give が数える brief の key は Work Context の well-known key と同じ集合", () => {
    const give = body("give");
    const quoted = new Set([...give.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    const keys = wellKnownContextKeys();
    expect(keys.length).toBeGreaterThan(3);
    for (const k of keys) {
      expect({ key: k, named: quoted.has(k) }).toMatchObject({ named: true });
    }
  });
});
