import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0641 ②③: **公開した binary を手に入れた人が最初に読む面**を測る。
//
// PBI-0638 が空の HOME で実射した 1 行がここの対象:
//   `NG  credential: not paired. Run 'openroly install claude' (it will connect to http://localhost:8787)`
// 開発機の port(② )と、README に無い command(③ )が同じ 1 行に同居していた。
//
// **network は踏まない** —— 未 pair の runtime は credential finding を返した時点で doctor が
// 打ち切るので、行き先の URL は名乗るだけで叩かれない(だからこの test は offline でも通る)。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

/** 何も設定されていない端末 —— login も pair もしていない、公開直後の 1 人目 */
async function freshHome(): Promise<Record<string, string>> {
  const home = await mkdtemp(join(tmpdir(), "openroly-0641-"));
  return { HOME: home, OPENROLY_HOME: join(home, ".openroly") };
}

async function openroly(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    // PATH だけ渡す。`$OPENROLY_URL` を継ぐと既定を一度も通らない(測る物が消える)
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

// 本番 host は `packages/adapter/src/install.ts` の DEFAULT_BASE_URL が正本。2026-09-17 の owner 決定
// (hp+app を 1 host に統一・PBI-0675)で atn.shibubu.ai → openroly.shibubu.ai に移した。ここは
// **公開面が名乗る綴り**を測るので literal のまま持つ —— import で揃えると localhost でも緑になる
describe("公開面の既定 (PBI-0641 ②)", () => {
  test("AC-3: 未 pair の doctor が名乗る行き先は本番 —— 開発機の localhost ではない", async () => {
    const r = await openroly(["doctor", "claude"], await freshHome());

    // 未 pair なので NG 自体は正しい。見るのは **どこへ繋ぐと言ったか**
    expect(r.stdout).toContain("not paired");
    expect(r.stdout).toContain("it will connect to https://openroly.shibubu.ai");
    expect(r.stdout).not.toContain("localhost");
  }, 30_000);

  test("AC-4: `--url` の help が名乗る既定も本番(doctor だけ見て緑と言わない)", async () => {
    // 既定は 1 箇所から来るが、面は 2 つある —— 片方だけ直した時に赤くなる側を持つ
    const r = await openroly(["--help"], await freshHome());

    expect(r.stdout).toContain("then https://openroly.shibubu.ai");
    expect(r.stdout).not.toContain("localhost");
  }, 30_000);

  test("AC-X4: `$OPENROLY_URL` を持つ端末の行き先は今までどおりその server(既定が上書きしない)", async () => {
    // ②は「何も無い時の既定」だけを動かす。PBI-0246 の優先順位(明示 > login > credential > 既定)は不変
    const env = { ...(await freshHome()), OPENROLY_URL: "http://127.0.0.1:59641" };

    const r = await openroly(["doctor", "claude"], env);

    expect(r.stdout).toContain("it will connect to http://127.0.0.1:59641");
    expect(r.stdout).not.toContain("openroly.shibubu.ai");
  }, 30_000);
});

describe("公開面の語 (PBI-0641 ③)", () => {
  test("AC-3: doctor が案内する openroly の command は全部 README に在る", async () => {
    // **README が正** —— 公開後に最初の 1 人が読むのはこちら。同じ行為を doctor が別の名前で
    // 呼ぶと、README だけ読んだ人には存在しない command に見える(PBI-0638 実測:
    // doctor = `Run 'openroly install claude'` / README §Get started = `./openroly pair claude`)。
    // 語を 1 つずつ固定するのではなく **doctor が実際に出した物を README に突き合わせる** ——
    // 片方を動かした時にだけ赤くなる(どちらを動かしても片側に気づける)
    const readme = await Bun.file(fileURLToPath(new URL("../../../README.md", import.meta.url))).text();

    const r = await openroly(["doctor", "claude"], await freshHome());
    const quoted = [...r.stdout.matchAll(/'(openroly [^']+)'/g)].map((m) => m[1]!);

    // 出ていない = 何も測っていない(doctor が 1 つも案内しなくなった型)
    expect(quoted).toContain("openroly pair claude");
    expect(quoted.filter((c) => !readme.includes(c))).toEqual([]);
  }, 30_000);
});
