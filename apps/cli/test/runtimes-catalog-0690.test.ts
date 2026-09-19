import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/openroly.ts", import.meta.url));

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { PATH: env.PATH, HOME: env.HOME, OPENROLY_HOME: env.OPENROLY_HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe("openroly runtimes catalog (PBI-0690)", () => {
  test("AC-2 / AC-X1: catalog 数を名乗り、local-grok だけでも grok が connected。既定は居る物だけ", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-runtimes-0690-"));
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await mkdir(join(home, ".openroly"), { recursive: true });
    await writeFile(join(bin, "grok"), "#!/bin/sh\necho 1.0.34\n", { mode: 0o755 });
    await chmod(join(bin, "grok"), 0o755);
    await writeFile(
      join(home, ".openroly", "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          "local-grok": {
            runtime_id: "rt_local",
            token: "par_x",
            base_url: "http://127.0.0.1:9",
            name: "g",
            paired_at: new Date().toISOString(),
          },
        },
      }),
    );
    const r = await run(["runtimes", "--json"], {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      OPENROLY_HOME: join(home, ".openroly"),
    });
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as {
      data: { catalog: number; detected: number; connected: number; runtimes: { id: string; connected: boolean; detected: boolean }[] };
    };
    expect(body.data.catalog).toBe(91);
    expect(body.data.connected).toBeGreaterThanOrEqual(1);
    const grok = body.data.runtimes.find((x) => x.id === "grok");
    expect(grok?.connected).toBe(true);
    expect(grok?.detected).toBe(true);
    expect(body.data.runtimes.every((x) => x.detected || x.connected)).toBe(true);
    expect(body.data.runtimes.length).toBeLessThan(91);
  }, 20_000);
});

afterAll(() => {});
