import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import { ensureCliOnPath } from "../src/binary.ts";

describe("ensureCliOnPath(PBI-0679)", () => {
  test("Release が無い時は bun+CLI の shim を ~/.openroly/bin と ~/.local/bin に置く", async () => {
    const home = await mkdtemp(join(tmpdir(), "openroly-cli-path-"));
    const openrolyHome = join(home, ".openroly");
    try {
      await mkdir(join(home, ".local", "bin"), { recursive: true });
      const bun = join(home, "fake-bun");
      const cli = join(home, "openroly.ts");
      await Bun.write(bun, "#!/bin/sh\n");
      await Bun.write(cli, "// cli\n");
      const r = await ensureCliOnPath({
        bunPath: bun,
        cliPath: cli,
        env: {
          HOME: home,
          OPENROLY_HOME: openrolyHome,
          OPENROLY_BINARY_BASE_URL: "http://127.0.0.1:1",
        },
      });
      expect(r.status).toBe("shim");
      await access(join(openrolyHome, "bin", "openroly"), fsConstants.X_OK);
      await access(join(home, ".local", "bin", "openroly"), fsConstants.X_OK);
      const shim = await Bun.file(join(openrolyHome, "bin", "openroly")).text();
      expect(shim).toContain(bun);
      expect(shim).toContain(cli);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
