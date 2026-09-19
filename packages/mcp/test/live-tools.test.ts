import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveAccountTools } from "../src/live-tools.ts";

const config = { baseUrl: "http://127.0.0.1:9", token: "par_test" };

describe("createLiveAccountTools", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("PBI-0699 AC-2: source の mtime が変わったら新しい createAccountTools を読む", async () => {
    dir = await mkdtemp(join(tmpdir(), "live-tools-"));
    const src = join(dir, "tools.ts");
    await writeFile(src, `export function createAccountTools() { return { mark: "v1" }; }\n`);
    const live = createLiveAccountTools(config, src);
    expect((await live.refresh() as unknown as { mark: string }).mark).toBe("v1");
    const later = new Date(Date.now() + 5_000);
    await writeFile(src, `export function createAccountTools() { return { mark: "v2" }; }\n`);
    await (await import("node:fs/promises")).utimes(src, later, later);
    expect((await live.refresh() as unknown as { mark: string }).mark).toBe("v2");
  });
});
