import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PBI-0640: 届かない account server は **NG 1 行**で落ちる。stack trace(絶対 path 付き)を人に見せない。
// 同じ破れを PBI-0046 レビューが `login` で踏み、pairing.ts の中だけで塞いだので、`apiCall` を
// 直に叩く残り(openroly.ts に 58 か所)が裸のまま残っていた。塞いだのは **共有の口**(apiCall)。

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));
/** 誰も listen していない port。`127.0.0.1:9`(discard)は環境により落ちないので高い番号を選ぶ */
const DEAD_URL = "http://127.0.0.1:59919";

/** pair 済みに見える HOME を作る —— ここを通らないと「未 pair」で先に落ちて何も測れない */
async function pairedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "openroly-0640-"));
  await mkdir(join(home, ".openroly"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, ".openroly", "credentials.json"),
    JSON.stringify({
      version: 1,
      runtimes: {
        claude: {
          runtime_id: "rt_0640",
          kind: "claude",
          name: "probe",
          token: "not-a-real-token",
          base_url: DEAD_URL,
        },
      },
    }),
  );
  return home;
}

async function openroly(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
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

describe("届かない account server は NG 1 行 (PBI-0640)", () => {
  for (const args of [["continue"], ["work", "list"]]) {
    test(`AC-1/AC-2: openroly ${args.join(" ")}`, async () => {
      const home = await pairedHome();
      const r = await openroly(args, { HOME: home, OPENROLY_HOME: join(home, ".openroly") });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`NG cannot connect to ${DEAD_URL}`);
      // 生の bun の dump が出ていない事を、3 つの印で測る(1 つだけだと文言が変わった時に素通りする)
      expect(r.stderr).not.toContain("Unable to connect");
      expect(r.stderr).not.toContain("at async apiCall");
      expect(r.stderr).not.toContain("/packages/adapter/src/api.ts");
      // 1 行である(改行を挟んだ stack が後ろに付いていない)
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
    }, 30_000);
  }

  test("AC-3: 届かない以外の例外は従来どおり stack trace が出る(実装の bug を NG 1 行で隠さない)", async () => {
    // handler が畳むのは ApiUnreachableError だけ。他は console.error(e) で bun の既定と同じ形が出る。
    // 本物の CLI で測る —— 壊れた credentials.json は loadCredentials が throw する(version !== 1)。
    // 「届かない」ではない例外が同じ handler を通る、唯一の credit 0 の経路
    const home = await mkdtemp(join(tmpdir(), "openroly-0640-bug-"));
    await mkdir(join(home, ".openroly"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".openroly", "credentials.json"), JSON.stringify({ version: 2, runtimes: {} }));
    const r = await openroly(["continue"], { HOME: home, OPENROLY_HOME: join(home, ".openroly") });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unsupported credentials file");
    expect(r.stderr).toContain("credentials.ts"); // 元の frame が残っている(handler の frame に潰れていない)
    expect(r.stderr).not.toContain("NG cannot connect");
  }, 30_000);
});
