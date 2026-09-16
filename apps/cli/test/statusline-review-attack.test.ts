import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredential } from "@openroly/adapter";

// PBI-0313 レビュー攻撃: statusline.sh の stat probe を **GNU coreutils に偽装**して測る。
//
// ③ の赤は手元(macOS / BSD)では再現できない —— BSD stat に `-c` は無いので probe が false に
// なり BSD 分岐へ落ち、`-f %m` は正しく mtime を返す。だから **GNU の挙動を持つ fake `stat` を
// PATH の先頭に置き**、「Linux でも TTL が効く(cache が新鮮なら bun を起こさない)」を手元で測る:
//
//   fake stat(実物 GNU coreutils と同じ挙動の縮約):
//     stat -f %m <file> → `%m` をそのまま stdout へ印字して **exit 0**(`%m` は fs 書式に無い)
//     stat -c %Y <file> → file の mtime(epoch)
//
// 旧形(`stat -f %m "$STAMP" || stat -c %Y …` = -f を先に試す)だと last='%m' が返り
// `$((now - last))` が構文 error で script が死ぬ = この test が赤くなる(変異で実測)。

const SH = fileURLToPath(new URL("../../../adapters/official/claude/statusline.sh", import.meta.url));

let hits = 0;
const stub = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    hits += 1;
    if (path === "/v1/whoami") {
      return Response.json({
        agent_id: "agt_x",
        handle: "aya",
        display_name: "Aya",
        unread: 3,
        actor: { kind: "runtime", runtime_id: "rt_1" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => stub.stop(true));

/** 実物の stat(host が BSD でも GNU でも良い)。mock の値をここから取る */
const REAL_STAT = Bun.which("stat") ?? "/usr/bin/stat";

/** GNU stat の縮約模倣を置く bin dir */
async function fakeGnuBin(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "openroly-gnustat-"));
  // **引数の位置を間違えない**(レビューで実測) —— 呼ばれ方は `stat -c %Y <file>` なので
  // file は `$3`。前の版は `$2`(= 書式文字列 `%Y`)を file として実物に渡していたので
  // **常に失敗し、probe が「GNU ではない」と答えて BSD 枝へ落ちていた** ——
  // つまり GNU 偽装になっていなかった(それでも test は緑だった。観測点も間違っていたため)。
  //   -f %m <file> → GNU は `--file-system` で `%m` を書式として持たないので **素通し印字 + exit 0**
  //   -c %Y <file> → mtime(epoch)。値は実物から取る(host の綴りは GNU→BSD の順で試す)
  await writeFile(
    join(bin, "stat"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  -f) printf '%s\\n' '%m'; exit 0 ;;",
      `  -c) ${REAL_STAT} -c %Y "$3" 2>/dev/null || ${REAL_STAT} -f %m "$3" 2>/dev/null || echo 0; exit 0 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "stat"), 0o755);
  return bin;
}

/** GNU 偽装が本当に GNU として振る舞うか(入口の検査。ここが腐ると下の 3 本が全部無意味になる) */
async function probeIsGnu(bin: string): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", 'stat -c %Y . >/dev/null 2>&1 && echo GNU || echo BSD'], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function run(
  script: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["/bin/bash", script], {
    // machine-ok: 子の bun / CLI 自身が HOME（bun の cache）を要る。製品の状態は OPENROLY_HOME / OPENROLY_BROKER_HOME で隔離済み
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

/** credential 済みの OPENROLY_HOME(cache と STAMP を作る位置) */
async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "openroly-statusline-gnustat-"));
  await saveCredential(
    "claude",
    {
      runtime_id: "rt_1",
      token: "par_x",
      base_url: `http://localhost:${stub.port}`,
      name: "test",
      paired_at: new Date().toISOString(),
    },
    { OPENROLY_HOME: home } as any,
  );
  return home;
}

describe("PBI-0313 レビュー: GNU stat 環境でも TTL が効く", () => {
  test("入口: fake stat が本当に GNU として判定される(偽装が効いていない緑を防ぐ)", async () => {
    const bin = await fakeGnuBin();
    expect(await probeIsGnu(bin)).toBe("GNU");
    // 素の PATH は BSD(macOS) —— 偽装が「元から GNU だっただけ」ではない事も見る
    await rm(bin, { recursive: true, force: true });
  }, 30_000);

  test("cache が新鮮なら中身を出して bun を起こさない(GNU 偽装)", async () => {
    const home = await setupHome();
    await writeFile(join(home, "statusline"), "FRESH");
    const stamp = join(home, "statusline.at");
    await writeFile(stamp, "");
    const bin = await fakeGnuBin();
    // **観測点は STAMP の mtime**(レビューの負の対照で判明)。stub の hits を見ると、
    // 実装を旧形に戻しても **この test は緑のままだった** —— 更新は `nohup … &` の背景 spawn で、
    // 同期に読む hits には間に合わないから。`touch "$STAMP"` は spawn の **前**に同期で起きるので、
    // 「起こさなかった」を本当に測れるのはこちら(armed-tests「一度も測っていないから緑」の型)
    const before = statSync(stamp).mtimeMs;
    const httpBefore = hits;
    const res = await run(SH, {
      OPENROLY_HOME: home,
      OPENROLY_STATUSLINE_TTL: "600",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("FRESH");
    expect(statSync(stamp).mtimeMs).toBe(before); // 印が付いていない = 起動口へ進んでいない
    expect(hits).toBe(httpBefore);
    await Promise.all([rm(home, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]);
  }, 30_000);

  test("STAMP が古ければ再試行の印を付ける(GNU 偽装・方向の逆)", async () => {
    const home = await setupHome();
    await writeFile(join(home, "statusline"), "STALE");
    const stamp = join(home, "statusline.at");
    await writeFile(stamp, "");
    // STAMP を 2000-01-01 まで巻き戻す → TTL 超過 → touch で印が付くはず
    Bun.spawnSync(["touch", "-t", "200001010000", stamp]);
    const bin = await fakeGnuBin();
    const before = statSync(stamp).mtimeMs;
    const res = await run(SH, {
      OPENROLY_HOME: home,
      OPENROLY_STATUSLINE_TTL: "600",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(res.exitCode).toBe(0);
    expect(statSync(stamp).mtimeMs).toBeGreaterThan(before);
    await Promise.all([rm(home, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]);
  }, 30_000);

  test("負の対照: 旧形(-f を先に試す)は GNU で TTL 判定が壊れる(AC-X ③)", async () => {
    // 実物の statusline.sh を **PBI-0313 修正前の形に書き戻した copy** を走らせる。
    // last='%m' が返り `$((now - last))` の算術展開が死ぬ → TTL 行が無効になり、
    // **新鮮な cache でも touch が走る**(= Linux で毎回 bun を起こしていた実物の bug)。
    // 実物が probe 形ではなくなったら置換が失敗してこの expect が赤くなる(形の変化も検知する)。
    const src = await readFile(SH, "utf8");
    const mutated = src.replace(
      [
        "  if stat -c %Y . >/dev/null 2>&1; then",
        '    last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)   # GNU coreutils',
        "  else",
        '    last=$(stat -f %m "$STAMP" 2>/dev/null || echo 0)   # BSD (macOS)',
        "  fi",
      ].join("\n"),
      '  last=$(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP" 2>/dev/null || echo 0)',
    );
    expect(mutated).not.toBe(src);
    const home = await setupHome();
    // copy は repo の外に在るので bun 経路の REPO 解決が失敗する。binary 優先の分岐で
    // 起動口を確定させる(何もしない fake binary → nohup しても無害)
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin/openroly"), "#!/bin/sh\nexit 0\n");
    await chmod(join(home, "bin/openroly"), 0o755);
    const legacy = join(home, "statusline.legacy.sh");
    await writeFile(legacy, mutated);
    await chmod(legacy, 0o755);
    await writeFile(join(home, "statusline"), "FRESH");
    const stamp = join(home, "statusline.at");
    await writeFile(stamp, ""); // 作り立て = 新鮮 → 本来は touch されない
    const bin = await fakeGnuBin();
    const before = statSync(stamp).mtimeMs;
    const res = await run(legacy, {
      OPENROLY_HOME: home,
      OPENROLY_STATUSLINE_TTL: "600",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("FRESH");
    // 新鮮なのに印が付いた = TTL 判定が壊れている(旧形の bug の再現)
    expect(statSync(stamp).mtimeMs).toBeGreaterThan(before);
    await Promise.all([rm(home, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]);
  }, 30_000);
});
