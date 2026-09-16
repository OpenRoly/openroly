#!/usr/bin/env bun
// 型の門。**走らせる project の一覧と、覆えているかを測る一覧が同じ配列**である事がこの file の要。
//
// なぜ在るか（PBI-0628・2026-09-16）:
//   `scripts/` は tsc の対象外だった。PBI-0614 が `headCommit` 引数を足した時、scripts/ 側の
//   呼び出し元 5 か所が落ち、`bench-memory --report` が**必ず失敗する状態で main に乗った**。
//   bun test は型を見ないので誰も気付けない。同型を PBI-0605 / PBI-0608 で既に踏んでいる（3 度目）。
//   個別に直すのをやめて、**門を抜けている .ts が 1 file でも在れば赤**にした。
//
// 一覧を 2 つに分けない理由（armed-tests の型「3 つ目の口」）:
//   package.json に tsc の for ループを置き、此処に別の配列で覆いを測ると、
//   **tsconfig を足して覆いだけ増えて tsc が走らない**状態が緑になる。だから PROJECTS は 1 つ。
//
// **公開 clone でも走る**（PBI-0628 追随 fix・2026-09-16）: `public-ci.yml` は毎 push で
//   `bun run typecheck` を打つ。あちらには `apps/server` / `apps/web` が無いので、
//   在る物だけを門にかける（下の `present`）。此の file 自身は `INCLUDE_ANYWAY` で運ばれる ——
//   package.json が名指しする実体が運ばれないと、公開 clone の typecheck は 1 行目で死ぬ。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

// ---- 単一の正本: 門が走らせる project（此処に無い tsconfig の file は uncovered = 赤）----
export const PROJECTS = [
  "packages/core",
  "packages/crypto-envelope",
  "packages/adapter",
  "packages/mcp-mask",
  "packages/mcp",
  "adapters/official/api",
  "adapters/official/claude",
  "adapters/official/codex",
  "apps/server",
  "apps/cli",
  "apps/web",
  "tsconfig.tools.json",
];

/** その project の設定 file。`.json` で終わる物は file 指定、それ以外は dir 指定（= dir/tsconfig.json）*/
export const configOf = (project: string) =>
  project.endsWith(".json") ? project : `${project}/tsconfig.json`;

// ---- 門の外に居てよい物。増やす時は理由を必ず横に書く ----
// tsconfig.tools.json の `exclude` と同じ形を持つ（2 つが食い違うと、除いた物が uncovered として
// 赤くなるか、門を抜けた物が exempt として黙って消えるかのどちらかになる）。
const EXEMPT: Array<[pattern: RegExp, why: string]> = [
  [
    /^scripts\/bench-fixtures\/.+\/src\//,
    "benchmark の入力の木（bench-fixtures の下で src/ を持つ木）。base/ dirty/ stages/ overlay/ reference/ は " +
      "『わざと欠けた木』で、./money.ts が在らない事そのものが fixture の中身（TS2307 18 件が全部これ）。" +
      "型を通すと fixture でなくなる。**judge.ts 等 bench-fixtures 直下の .ts は実装なので門の中**",
  ],
  [/^third_party\//, "借り物。上流の型は見ない（provenance-check.sh が別の持ち場で由来を見る）"],
];

function main() {
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (topLevel.status !== 0) {
    console.error("NG: git repo の中で走っていない（覆いは tracked な file の上で定義されるので測れない）");
    process.exit(2);
  }
  const repoRoot = topLevel.stdout.trim();

  function run(cmd: string, args: string[]): { code: number; out: string; err: string } {
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  // ---- 1. 測る対象を先に取る ----
  // **道具（tsc）の有無より先に見る。** tracked が 0 件なら、道具が揃っていても覆いは測れない。
  // 素直に書くと「uncovered が 0 件なので OK」になり、git が答えなかった / cwd が違う / 全部落ちた時に
  // 門が一度も測られていないのに緑になる（AC-X3・armed-tests の型「入口未到達」）。
  const tracked = run("git", ["ls-files", "*.ts", "*.tsx"]).out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tracked.length === 0) {
    console.error("NG: tracked な .ts が 0 件だった。git ls-files が答えていない（覆いを測れていないので緑にしない）");
    process.exit(2);
  }

  const tsc = join(repoRoot, "node_modules/.bin/tsc");
  if (!existsSync(tsc)) {
    // 無いまま spawn すると ENOENT が「project X で落ちた」に化けて、原因が読めなくなる
    console.error(`NG: ${tsc} が無い（bun install が済んでいない）`);
    process.exit(2);
  }

  // ---- 2. 在る project だけを門にかける ----
  // 公開 clone（OpenRoly/openroly）に `apps/server` / `apps/web` は無い。あちらの public-ci.yml も
  // 同じ `bun run typecheck` を打つので、無い project で落ちてはならない（PBI-0303 が
  // `[ -d "$p" ] || continue` で守っていた性質。PBI-0628 が門を此の file へ移した時に落とした）。
  //
  // **飛ばして穴が開かないのは、下の覆いが飛ばした結果を測るから。** tsconfig が消えたのに .ts が
  // tracked のまま残れば uncovered として名指しで赤くなる（走らせる一覧と測る一覧が同じ `present`）。
  // 飛ばした事自体も毎回印字する（黙って減らない）。
  const present = PROJECTS.filter((p) => existsSync(join(repoRoot, configOf(p))));
  const skipped = PROJECTS.filter((p) => !present.includes(p));
  if (present.length === 0) {
    console.error(`NG: 走る project が 1 つも無い（${PROJECTS.length} 件の tsconfig が 1 つも見つからない）`);
    process.exit(2);
  }

  /** その project が実際に見る file（glob を自前で解釈しない —— include の書き方が変わった時に黙って外れる） */
  function resolvedFiles(project: string): string[] {
    const r = run(tsc, ["--showConfig", "-p", project]);
    if (r.code !== 0) {
      console.error(`NG: tsc --showConfig -p ${project} が失敗した\n${r.err || r.out}`);
      process.exit(2);
    }
    let cfg: { files?: string[] };
    try {
      cfg = JSON.parse(r.out);
    } catch {
      console.error(`NG: ${project} の --showConfig が JSON ではなかった`);
      process.exit(2);
    }
    // `files` は project の dir からの相対。tsconfig.tools.json のような file 指定なら repo root 基準。
    const base = project.endsWith(".json") ? "." : project;
    return (cfg.files ?? []).map((f) => normalize(join(base, f)));
  }

  // ---- 3. 門を走らせる（--coverage-only の時は飛ばす。検査から覆いだけを測りたい時に使う）----
  if (!process.argv.includes("--coverage-only")) {
    for (const p of present) {
      const r = run(tsc, ["--noEmit", "-p", p]);
      if (r.code !== 0) {
        process.stdout.write(r.out);
        process.stderr.write(r.err);
        console.error(`NG: typecheck が落ちた（project: ${p}）`);
        process.exit(1);
      }
    }
  }

  // ---- 4. 覆いを測る ----
  const covered = new Set<string>();
  for (const p of present) for (const f of resolvedFiles(p)) covered.add(f);

  const exemptOf = (f: string) => EXEMPT.find(([pattern]) => pattern.test(f));

  const uncovered: string[] = [];
  let exemptN = 0;
  let coveredN = 0;
  for (const f of tracked) {
    if (covered.has(f)) coveredN++;
    else if (exemptOf(f)) exemptN++;
    else uncovered.push(f);
  }

  // 緑でも数を run log に残す（「緑だった」ではなく「門の外は 0 だった」が残る）
  console.log(
    `typecheck coverage: tracked=${tracked.length} covered=${coveredN} exempt=${exemptN} uncovered=${uncovered.length}` +
      (skipped.length > 0 ? ` skipped=${skipped.join(",")}（この tree に tsconfig が無い）` : ""),
  );

  if (uncovered.length > 0) {
    console.error(`NG: typecheck の門を抜けている .ts が ${uncovered.length} file 在る:`);
    for (const f of uncovered) console.error(`  ${f}`);
    console.error(
      "  → どれかの tsconfig の include に入れる（product でないなら tsconfig.tools.json）。" +
        "門の外に置くなら scripts/typecheck-coverage.ts の EXEMPT に理由付きで足す。",
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
