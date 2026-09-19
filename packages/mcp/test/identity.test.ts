import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindFromParentComm, resolveMcpIdentity } from "../src/identity.ts";

describe("kindFromParentComm", () => {
  test("basename を kind にし、bun/node/shell は捨てる", () => {
    expect(kindFromParentComm("grok")).toBe("grok");
    expect(kindFromParentComm("/Users/you/.grok/bin/grok")).toBe("grok");
    expect(kindFromParentComm("bun")).toBeUndefined();
    expect(kindFromParentComm("node")).toBeUndefined();
    expect(kindFromParentComm("")).toBeUndefined();
  });
});

describe("resolveMcpIdentity", () => {
  let home = "";
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  test("KIND が grok で credential は local-grok だけでも拾う", async () => {
    home = await mkdtemp(join(tmpdir(), "openroly-mcp-id-"));
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          "local-grok": {
            runtime_id: "rt_local",
            token: "par_local",
            base_url: "https://example.invalid",
            name: "grok",
            paired_at: "2026-09-17T00:00:00Z",
          },
        },
      }),
    );
    const id = await resolveMcpIdentity({ OPENROLY_HOME: home, OPENROLY_RUNTIME_KIND: "grok" });
    expect(id?.kind).toBe("local-grok");
    expect(id?.credential.token).toBe("par_local");
  });

  test("KIND 無しでも親 comm が grok なら同じ credential を拾う", async () => {
    home = await mkdtemp(join(tmpdir(), "openroly-mcp-id-"));
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({
        version: 1,
        runtimes: {
          grok: {
            runtime_id: "rt_g",
            token: "par_g",
            base_url: "https://example.invalid",
            name: "grok",
            paired_at: "2026-09-17T00:00:00Z",
          },
        },
      }),
    );
    const id = await resolveMcpIdentity({ OPENROLY_HOME: home, OPENROLY_PARENT_COMM: "grok" });
    expect(id?.kind).toBe("grok");
    expect(id?.credential.token).toBe("par_g");
  });
});
