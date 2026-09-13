import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catalog from "@openroly/core/registry/detectors.v1.json" with { type: "json" };
import {
  addLocalRuntime,
  importShellProfiles,
  loadProfiles,
  localCatalogPath,
  profilesPath,
  variantClasses,
} from "../src/profiles.ts";

// PBI-0211: shell の provider 差し替え wrapper → runtime profile。鍵は fake 値だけ(本物は置かない)。

const FAKE_KEY = "fake-zai-key-not-a-real-secret-5d1e";
const FAKE_PROXY_KEY = "fake-proxy-key-not-a-real-secret-9a0b";
const CLASSES = variantClasses(catalog.detectors as unknown[]);

/** ~/.zshrc の claude-zai() と同じ形(鍵は file から読む) */
const ZAI_FROM_FILE = `
claude-zai() {
  local zai_key
  zai_key="$(command grep -E '^ZHIPU_API_KEY=' ~/secrets/keys.env | cut -d= -f2-)"
  if [ -z "$zai_key" ]; then
    echo "claude-zai: ZHIPU_API_KEY missing" >&2
    return 1
  fi
  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \\
  ANTHROPIC_AUTH_TOKEN="$zai_key" \\
  ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.3" \\
  ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.3-flash" \\
  ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air" \\
  API_TIMEOUT_MS="3000000" \\
  command claude "$@"
  local rc=$?
  return $rc
}
`;

/** 鍵を literal で書いた形(値が file に落ちないかを測る) */
const ZAI_LITERAL = `
claude-zai() {
  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" ANTHROPIC_AUTH_TOKEN="${FAKE_KEY}" command claude "$@"
}
`;

/** ~/.zshrc の claude-free() と同じ形 */
const FREE = `
claude-free() {
  if ! curl -s -o /dev/null -m 2 http://localhost:20128/health; then
    return 1
  fi
  ANTHROPIC_BASE_URL="http://localhost:20128/api" \\
  ANTHROPIC_MODEL="\${CLAUDE_FREE_MODEL:-free-auto}" \\
  ANTHROPIC_API_KEY="${FAKE_PROXY_KEY}" \\
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1" \\
  command claude "$@"
}
`;

const roots: string[] = [];
async function freshEnv(): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "openroly-profiles-"));
  roots.push(root);
  return { OPENROLY_HOME: join(root, ".openroly") };
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("runtime profile import(PBI-0211)", () => {
  test("catalog に class が 2 つ(claude-zai は provider zhipu・claude-proxy は provider 無し)", () => {
    expect(CLASSES.find((k) => k.id === "claude-zai")).toMatchObject({ of: "claude", match: ["api.z.ai"], provider: "zhipu", displayName: "Claude Code · Z.AI (GLM)" });
    expect(CLASSES.find((k) => k.id === "claude-proxy")?.provider).toBeUndefined();
  });

  test("AC-1: claude-zai() → class claude-zai・env に base URL と model 3 つ・鍵は connection:zhipu の参照だけ", async () => {
    const env = await freshEnv();
    const result = await importShellProfiles(ZAI_FROM_FILE, CLASSES, env);
    expect(result.imported).toEqual([{ name: "claude-zai", class: "claude-zai" }]);
    const file = await loadProfiles(env);
    expect(file.profiles["claude-zai"]).toEqual({
      name: "claude-zai",
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3-flash",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
        API_TIMEOUT_MS: "3000000",
      },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "connection:zhipu" },
    });
    expect((await stat(profilesPath(env))).mode & 0o777).toBe(0o600);
  });

  test("AC-1: 鍵が literal でも値は profiles.json にも結果にも出ない", async () => {
    const env = await freshEnv();
    const result = await importShellProfiles(ZAI_LITERAL, CLASSES, env);
    const text = await readFile(profilesPath(env), "utf8");
    expect(text).toContain("connection:zhipu");
    expect(text.split(FAKE_KEY).length - 1).toBe(0);
    expect(JSON.stringify(result).split(FAKE_KEY).length - 1).toBe(0);
  });

  test("AC-4: claude-free() → claude-proxy・秘密 var は保存しない(名前だけ dropped)・${X:-default} は default", async () => {
    const env = await freshEnv();
    const result = await importShellProfiles(FREE, CLASSES, env);
    expect(result.imported).toEqual([{ name: "claude-free", class: "claude-proxy" }]);
    expect(result.dropped).toEqual([{ name: "claude-free", vars: ["ANTHROPIC_API_KEY"] }]);
    const p = (await loadProfiles(env)).profiles["claude-proxy"]!;
    expect(p.secret_env).toEqual({});
    expect(p.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:20128/api",
      ANTHROPIC_MODEL: "free-auto",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
    expect((await readFile(profilesPath(env), "utf8")).includes(FAKE_PROXY_KEY)).toBe(false);
  });

  test("class が決まらない関数は skip し、file を作らない", async () => {
    const env = await freshEnv();
    const rc = `claude-other() {\n  ANTHROPIC_BASE_URL="https://gw.example.com/v1" command claude "$@"\n}\n`;
    const result = await importShellProfiles(rc, CLASSES, env);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("gw.example.com");
    expect(await stat(profilesPath(env)).catch(() => null)).toBeNull();
  });

  test("AC-X2: 壊れた profiles.json には書かない(throw・中身はそのまま)", async () => {
    const env = await freshEnv();
    await mkdir(env.OPENROLY_HOME!, { recursive: true });
    await writeFile(profilesPath(env), "{ broken");
    await expect(importShellProfiles(ZAI_FROM_FILE, CLASSES, env)).rejects.toThrow("profiles.json");
    expect(await readFile(profilesPath(env), "utf8")).toBe("{ broken");
  });

  test("AC-X3: 同じ関数の 2 度目は 1 件のまま・同じ class に当たる別の関数は skip", async () => {
    const env = await freshEnv();
    await importShellProfiles(ZAI_FROM_FILE, CLASSES, env);
    const first = await readFile(profilesPath(env), "utf8");
    await importShellProfiles(ZAI_FROM_FILE, CLASSES, env);
    expect(await readFile(profilesPath(env), "utf8")).toBe(first);
    const second = ZAI_LITERAL.replace("claude-zai()", "glm()");
    const result = await importShellProfiles(second, CLASSES, env);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ name: "glm" });
    expect(result.skipped[0]!.reason).toContain("already taken by claude-zai");
    expect(Object.keys((await loadProfiles(env)).profiles)).toEqual(["claude-zai"]);
  });
});

describe("local catalog(PBI-0211 AC-5)", () => {
  test("runtimes add foo → local-foo の native(file strategy)を 0600 で置く。name の文字種は絞る", async () => {
    const env = await freshEnv();
    const entry = await addLocalRuntime({ name: "foo", binary: "foo", mcpFile: "~/.foo/mcp.json", format: "json", key: "mcpServers" }, env);
    const file = JSON.parse(await readFile(localCatalogPath(env), "utf8"));
    expect(file.entries).toEqual([entry]);
    expect(entry).toMatchObject({ id: "local-foo", detect: { binaries: ["foo"] }, native: { bin: "foo", mcp: { strategy: "file", path: "~/.foo/mcp.json", key: "mcpServers" } } });
    expect((await stat(localCatalogPath(env))).mode & 0o777).toBe(0o600);
    await expect(addLocalRuntime({ name: "Foo;rm", binary: "foo", mcpFile: "x", format: "json", key: "k" }, env)).rejects.toThrow();
    await expect(addLocalRuntime({ name: "bar", binary: "../bin/sh", mcpFile: "x", format: "json", key: "k" }, env)).rejects.toThrow();
  });
});
