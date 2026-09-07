// EFAULT 機序 probe(PBI-0263): 同じ dir を 2 プロセスが同時に rm(recursive, force) すると Bun が何を投げるか。
// 実測 2026-09-05 Bun 1.3.14: plain → EFAULT 2 / 200(c1 実測 14 / 120)・grab(rename で掴んでから rm) → 0 / 200
// usage: bun apps/cli/test/probes/efault-probe.ts parent <n> [grab]   /  worker <slot> <root> <n> [grab]
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [mode = "", ...a] = process.argv.slice(2);
if (mode === "parent") {
  const n = Number(a[0] ?? 200);
  const grab = a[1] === "grab";
  const root = join(tmpdir(), `openroly-efault-probe-${Date.now()}`);
  await mkdir(root);
  for (let i = 0; i < n; i++) {
    await mkdir(join(root, `d${i}`));
    await writeFile(join(root, `d${i}`, "x"), "x");
  }
  const ws = [0, 1].map((s) =>
    Bun.spawn(["bun", import.meta.path, "worker", String(s), root, String(n), grab ? "grab" : "plain"], {
      stdout: "pipe", stderr: "pipe",
    }),
  );
  const outs = await Promise.all(ws.map((w) => new Response(w.stdout).text()));
  const codes = await Promise.all(ws.map((w) => w.exited));
  const errs: Record<string, number> = {};
  for (const o of outs) for (const l of o.split("\n")) if (l) errs[l] = (errs[l] ?? 0) + 1;
  console.log(JSON.stringify({ n, grab, codes, errs }));
  await rm(root, { recursive: true, force: true });
} else {
  const [slot = "0", root = "", nS = "0", kind = "plain"] = a;
  const n = Number(nS);
  // 2 本が同じ round に居るよう、開始を合わせる(親の spawn 差だけ)
  for (let i = 0; i < n; i++) {
    const d = join(root, `d${i}`);
    try {
      if (kind === "grab") {
        const g = `${d}.grab.${slot}`;
        try { await rename(d, g); } catch { continue; }
        await rm(g, { recursive: true, force: true });
      } else {
        await rm(d, { recursive: true, force: true });
      }
    } catch (e) {
      console.log(`${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }
}
