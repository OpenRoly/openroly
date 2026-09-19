import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../src/contract.ts";
import type { RuntimeCredential } from "../src/credentials.ts";
import { secretsPath } from "../src/credentials.ts";
import { createMcpConfigAdapter } from "../src/mcp-config.ts";
import { createNativeAdapter } from "../src/native.ts";
import { withSkills } from "../src/skill.ts";
import { claudeAdapter } from "../../../adapters/official/claude/src/index.ts";
import { planShare, shareExtensions, shareFingerprint } from "../src/share.ts";

// 吸い上げ → 提案(PBI-0212 / 図67)。**秘密が Account へ 1 byte も出ない**ことと、
// 同じ物を何度 share しても提案が増えないこと(fingerprint)を端末側で固定する。
//   AC-1  env 付きの MCP を share → spec に値が無く credential_ref が env:NAME、secrets.json は 0600
//   AC-4  同じ物を 2 回 → fingerprint が同じ(server の unique が 1 行に潰せる)
//   AC-5  --auto は前回送った物を送り直さない
//   AC-X2 secrets.json が書けない / server 不達 → 半端な提案を残さない

let root = "";
let env: Record<string, string | undefined> = {};
let requests: { path: string; body: any; auth: string | null }[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
let status = 201;
/** Account に既に在る desired(share は配った物を提案し返さない) */
let desired: { name: string; deleted_at: string | null }[] = [];

const ctx = (): AdapterContext => ({ env });

/** opencode 相当(jsonc・`mcp.<name>` = {type,command:[…],environment} + skills dir) */
const opencodeNative = () => ({
  home: { default: join(root, "opencode") },
  bin: "opencode",
  mcp: {
    strategy: "file",
    path: "opencode.json",
    format: "jsonc",
    key: "mcp",
    entry: { type: "local", command: ["${command}", "${args...}"], environment: "${env}", enabled: true },
  },
  skills: { dir: join(root, "opencode", "skills") },
});

/** claude 相当(json・`mcpServers.<name>` = {command,args,env}) */
const claudeLikeNative = () => ({
  home: { default: join(root, "claudeish") },
  bin: "claudeish",
  mcp: { strategy: "file", path: ".claude.json", format: "json", key: "mcpServers", entry: { command: "${command}", args: "${args}", env: "${env}" } },
  skills: { dir: join(root, "claudeish", "skills") },
});

const adapter = (id = "opencode") =>
  createNativeAdapter(id, id, id === "opencode" ? opencodeNative() : claudeLikeNative());

function credential(kind: string): RuntimeCredential {
  return {
    runtime_id: `rt_${kind}`,
    token: `tok_${kind}`,
    base_url: server!.url.toString().replace(/\/$/, ""),
    name: `Test / ${kind}`,
    paired_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openroly-share-"));
  env = { HOME: root, OPENROLY_HOME: join(root, ".openroly"), PATH: join(root, "bin") };
  requests = [];
  status = 201;
  desired = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // desired の読み(share が「もう配った物」を判定する口)は記録しない
      if (req.method === "GET" && url.pathname === "/v1/extensions") return Response.json(desired);
      requests.push({
        path: url.pathname,
        body: await req.json().catch(() => null),
        auth: req.headers.get("authorization"),
      });
      if (status >= 400) return Response.json({ error: "boom" }, { status });
      return Response.json({ id: `exp_${requests.length}`, status: "pending" }, { status });
    },
  });
  await mkdir(join(root, "opencode"), { recursive: true });
  await writeFile(
    join(root, "opencode", "opencode.json"),
    JSON.stringify(
      {
        theme: "dark",
        mcp: {
          // 人が自分で入れた物(token 付き)
          playwright: {
            type: "local",
            command: ["npx", "@playwright/mcp"],
            environment: { API_TOKEN: "sk-live-secret" },
            enabled: true,
          },
          // openroly 自身。提案し返してはいけない
          openroly: { type: "local", command: ["bun", "/repo/mcp.ts"], environment: { OPENROLY_URL: "http://x" }, enabled: true },
        },
      },
      null,
      2,
    ),
  );
});

afterEach(async () => {
  server?.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function putSkill(dir: string, name: string, body: string, managed = false): Promise<void> {
  const skill = join(dir, name);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), body);
  if (managed) await writeFile(join(skill, ".openroly-managed"), "");
}

describe("exportExtensions(端末に在る物を提案の形にする)", () => {
  test("AC-1: MCP の env は 1 つも spec に残らず、credential_ref だけが名前を運ぶ", async () => {
    const items = await adapter().exportExtensions(ctx());
    expect(items.map((i) => i.name)).toEqual(["playwright"]); // openroly 自身は除く
    const [pw] = items;
    expect(pw!.spec).toEqual({ command: "npx", args: ["@playwright/mcp"] });
    expect(pw!.secretEnv).toEqual({ API_TOKEN: "sk-live-secret" });
    expect(JSON.stringify(pw!.spec)).not.toContain("sk-live-secret");
  });

  test("人が置いた skill は上げ、OpenRoly が配った物(.openroly-managed)は上げない", async () => {
    const dir = join(root, "opencode", "skills");
    await putSkill(dir, "foo", '---\nname: "foo"\ndescription: "my own skill"\n---\ndo the thing\n');
    await putSkill(dir, "handed-down", '---\nname: "handed-down"\ndescription: "from account"\n---\nx\n', true);
    await writeFile(join(dir, "foo", "reference.md"), "detail\n");
    const items = await adapter().exportExtensions(ctx());
    const foo = items.find((i) => i.name === "foo");
    expect(items.find((i) => i.name === "handed-down")).toBeUndefined();
    expect(foo?.kind).toBe("skill");
    expect(foo?.spec).toEqual({
      description: "my own skill",
      instructions: "do the thing\n",
      files: { "reference.md": "detail\n" },
    });
  });

  test("SKILL.md が無い dir は上げず、frontmatter が無い SKILL.md は name を description にして上げる", async () => {
    const dir = join(root, "opencode", "skills");
    await mkdir(join(dir, "notaskill"), { recursive: true });
    await writeFile(join(dir, "notaskill", "readme.md"), "hi");
    await putSkill(dir, "nofront", "just text, no frontmatter\n");
    const skills = (await adapter().exportExtensions(ctx())).filter((i) => i.kind === "skill");
    expect(skills.map((s) => s.name)).toEqual(["nofront"]);
    expect(skills[0]?.spec).toEqual({ description: "nofront", instructions: "just text, no frontmatter\n" });
  });

  test("大きすぎる参照 file は飛ばし、SKILL.md は残す", async () => {
    const dir = join(root, "opencode", "skills");
    await putSkill(dir, "huge", '---\nname: "huge"\ndescription: "big"\n---\nx\n');
    await writeFile(join(dir, "huge", "blob.txt"), "a".repeat(70 * 1024));
    await writeFile(join(dir, "huge", "ok.md"), "keep\n");
    const huge = (await adapter().exportExtensions(ctx())).find((i) => i.name === "huge");
    expect(huge?.kind).toBe("skill");
    expect(huge?.spec).toEqual({
      description: "big",
      instructions: "x\n",
      files: { "ok.md": "keep\n" },
    });
  });

  test("skills/ 直下の symlink 先 dir も skill として上げる", async () => {
    const dir = join(root, "opencode", "skills");
    const archive = join(root, "archive", "linked");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "SKILL.md"), '---\nname: "linked"\ndescription: "from archive"\n---\ngo\n');
    await mkdir(dir, { recursive: true });
    await symlink(archive, join(dir, "linked"));
    const linked = (await adapter().exportExtensions(ctx())).find((i) => i.name === "linked");
    expect(linked?.kind).toBe("skill");
    expect(linked?.spec).toEqual({ description: "from archive", instructions: "go\n" });
  });
});

describe("planShare(名前の衝突と fingerprint)", () => {
  const item = (name: string, command: string, secretEnv: Record<string, string> = {}) => ({
    kind: "mcp" as const,
    name,
    spec: { command, args: [] },
    secretEnv,
  });

  test("同名で中身も同じなら 1 件に潰す", () => {
    const { plan } = planShare([
      { runtimeKind: "claude", items: [item("gh", "npx")] },
      { runtimeKind: "opencode", items: [item("gh", "npx")] },
    ]);
    expect(plan.map((p) => p.name)).toEqual(["gh"]);
  });

  test("同名で中身が違えば後から来た方だけ <name>-<runtime> になる", () => {
    const { plan } = planShare([
      { runtimeKind: "claude", items: [item("gh", "npx")] },
      { runtimeKind: "opencode", items: [item("gh", "bunx")] },
    ]);
    expect(plan.map((p) => p.name)).toEqual(["gh", "gh-opencode"]);
    expect(plan[1]!.originalName).toBe("gh");
    // 改名した方は名前が違う = fingerprint も違う(server の unique で潰れない)
    expect(plan[0]!.fingerprint).not.toBe(plan[1]!.fingerprint);
  });

  test("AC-4: 同じ入力からは常に同じ fingerprint(key の並びに依らない)", () => {
    const a = shareFingerprint({ kind: "mcp", name: "gh", spec: { command: "npx", args: ["x"] }, credentialRef: "env:A" });
    const b = shareFingerprint({ kind: "mcp", name: "gh", spec: { args: ["x"], command: "npx" }, credentialRef: "env:A" });
    expect(a).toBe(b);
  });

  test("credential_ref の env 名は常に sort する(端末ごとに fingerprint がずれない)", () => {
    const { plan } = planShare([{ runtimeKind: "x", items: [item("gh", "npx", { B: "2", A: "1" })] }]);
    expect(plan[0]!.credentialRef).toBe("env:A,B");
  });

  test("env を剥がしても生の credential が残る spec は送らない(理由付きで落とす)", () => {
    const { plan, skipped } = planShare([
      {
        runtimeKind: "x",
        items: [{ kind: "mcp", name: "leaky", spec: { command: "npx", headers: { authorization: "Bearer sk-x" } }, secretEnv: {} }],
      },
    ]);
    expect(plan).toEqual([]);
    expect(skipped[0]!.reason).toContain("raw credential");
  });

  test("env 名として使えない綴りは参照に載せられないので落とす", () => {
    const { plan, skipped } = planShare([{ runtimeKind: "x", items: [item("gh", "npx", { "A-B": "1" })] }]);
    expect(plan).toEqual([]);
    expect(skipped[0]!.reason).toContain("env name");
  });
});

describe("shareExtensions(送る側の順序と失敗)", () => {
  test("AC-1: proposals の body に値が無く、値は 0600 の secrets.json にだけ在る", async () => {
    const result = await shareExtensions({
      adapters: [adapter()],
      ctx: ctx(),
      credentials: { opencode: credential("opencode") },
      env,
    });
    expect(result.failed).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/v1/extensions/proposals");
    expect(requests[0]!.auth).toBe("Bearer tok_opencode");
    expect(requests[0]!.body.credential_ref).toBe("env:API_TOKEN");
    expect(JSON.stringify(requests[0]!.body)).not.toContain("sk-live-secret");

    const stored = JSON.parse(await readFile(secretsPath(env), "utf8"));
    expect(stored.env.API_TOKEN).toBe("sk-live-secret");
    expect(statSync(secretsPath(env)).mode & 0o777).toBe(0o600);
  });

  test("--dry-run は 1 件も送らず secret も書かない", async () => {
    const result = await shareExtensions({
      adapters: [adapter()],
      ctx: ctx(),
      credentials: { opencode: credential("opencode") },
      env,
      dryRun: true,
    });
    expect(result.plan).toHaveLength(1);
    expect(requests).toEqual([]);
    expect(await readFile(secretsPath(env), "utf8").catch(() => null)).toBeNull();
  });

  test("AC-5: --auto は 2 回目に何も送らない(消えた物も提案しない)", async () => {
    const opts = { adapters: [adapter()], ctx: ctx(), credentials: { opencode: credential("opencode") }, env, auto: true };
    await shareExtensions(opts);
    expect(requests).toHaveLength(1);
    const second = await shareExtensions(opts);
    expect(second.plan).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("接続していない runtime からは吸い上げない", async () => {
    const result = await shareExtensions({
      adapters: [adapter()],
      ctx: ctx(),
      credentials: {},
      env,
    });
    expect(result.plan).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("AC-X2: server が落ちたら share-state を進めない(次回また送る)", async () => {
    status = 500;
    const opts = { adapters: [adapter()], ctx: ctx(), credentials: { opencode: credential("opencode") }, env, auto: true };
    const first = await shareExtensions(opts);
    expect(first.failed).toHaveLength(1);
    status = 201;
    const second = await shareExtensions(opts);
    expect(second.sent).toHaveLength(1);
  });

  test("AC-X2: secrets.json が書けなければ提案を 1 件も送らない", async () => {
    // ~/.openroly を読み取り専用にする = secrets.json の作成が EACCES
    await mkdir(join(root, ".openroly"), { recursive: true });
    await chmod(join(root, ".openroly"), 0o500);
    try {
      await expect(
        shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: { opencode: credential("opencode") }, env }),
      ).rejects.toThrow();
      expect(requests).toEqual([]);
    } finally {
      await chmod(join(root, ".openroly"), 0o700);
    }
  });

  test("配った物を提案し返さない(既に desired に在る名前は上げない)", async () => {
    desired = [{ name: "playwright", deleted_at: null }];
    const result = await shareExtensions({
      adapters: [adapter()],
      ctx: ctx(),
      credentials: { opencode: credential("opencode") },
      env,
    });
    expect(result.plan).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["already in your account's extensions"]);
    expect(requests).toEqual([]);
  });

  test("削除待ち(deleted_at 有り)の名前は「配った物」に数えない", async () => {
    desired = [{ name: "playwright", deleted_at: new Date().toISOString() }];
    const result = await shareExtensions({
      adapters: [adapter()],
      ctx: ctx(),
      credentials: { opencode: credential("opencode") },
      env,
    });
    expect(result.plan.map((p) => p.name)).toEqual(["playwright"]);
  });

  test("desired が読めなければ 1 件も送らない(判定できないまま循環させない)", async () => {
    server!.stop(true);
    await expect(
      shareExtensions({ adapters: [adapter()], ctx: ctx(), credentials: { opencode: credential("opencode") }, env }),
    ).rejects.toThrow();
  });

  test("2 つの runtime の同名 MCP は 1 件に潰れ、送り先はそれを見つけた側の token", async () => {
    await mkdir(join(root, "claudeish"), { recursive: true });
    await writeFile(
      join(root, "claudeish", ".claude.json"),
      JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"], env: { API_TOKEN: "sk-live-secret" } } } }),
    );
    const result = await shareExtensions({
      adapters: [adapter("opencode"), adapter("claudeish")],
      ctx: ctx(),
      credentials: { opencode: credential("opencode"), claudeish: credential("claudeish") },
      env,
    });
    expect(result.plan.map((p) => p.name)).toEqual(["playwright"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.auth).toBe("Bearer tok_opencode");
  });
});

// ---------------------------------------------------------------- PBI-0213(図18)
// **見張る場所の正本は adapter 1 箇所**。broker は `openroly watch-dirs` に訊くだけで、
// 76 agent 分の config path を Rust に写さない。ここが嘘をつくと「Found が出ない」が
// 端末側では一切診断できない(何も起きないので log にも出ない)。
describe("watchPaths — native が変わったと分かる場所(PBI-0213)", () => {
  const env = { HOME: "/home/me" };

  test("mcp-config adapter は config file を返す(親 dir ではない)", () => {
    const adapter = createMcpConfigAdapter({
      id: "demo",
      displayName: "Demo",
      bin: "demo",
      installHint: "",
      configPath: (ctx) => `${ctx.env.HOME}/.demo.json`,
      format: "json",
      serversKey: "mcpServers",
      addArgs: () => [],
      removeArgs: () => [],
    });
    // **file 自身**であることが要点: `~/.claude.json` の親は `$HOME` で、そこを見張ると
    // `.zsh_history` の書き込みで毎秒発火する
    expect(adapter.watchPaths({ env })).toEqual(["/home/me/.demo.json"]);
  });

  test("withSkills は skills dir を足す(config file と 2 本)", () => {
    const base = createMcpConfigAdapter({
      id: "demo",
      displayName: "Demo",
      bin: "demo",
      installHint: "",
      configPath: (ctx) => `${ctx.env.HOME}/.demo.json`,
      format: "json",
      serversKey: "mcpServers",
      addArgs: () => [],
      removeArgs: () => [],
    });
    const withS = withSkills(base, (ctx) => `${ctx.env.HOME}/.demo/skills`);
    expect(withS.watchPaths({ env })).toEqual(["/home/me/.demo.json", "/home/me/.demo/skills"]);
  });

  test("catalog の generic adapter は native.mcp.path を返し、skills が有れば 2 本", () => {
    const adapter = createNativeAdapter("kiro", "Kiro", {
      mcp: {
        strategy: "file",
        path: "~/.kiro/settings/mcp.json",
        format: "json",
        key: "mcpServers",
        entry: {},
      },
      skills: { dir: "~/.kiro/skills" },
    });
    expect(adapter.watchPaths({ env })).toEqual([
      "/home/me/.kiro/settings/mcp.json",
      "/home/me/.kiro/skills",
    ]);
  });

  test("MCP config を持たない entry は空(見張る場所が無い = 何も起こさない)", () => {
    const adapter = createNativeAdapter("bare", "Bare", { skills: { dir: "~/.bare/skills" } });
    expect(adapter.watchPaths({ env })).toEqual(["/home/me/.bare/skills"]);
    const nothing = createNativeAdapter("nada", "Nada", {});
    expect(nothing.watchPaths({ env })).toEqual([]);
  });

  test("official claude は `~/.claude.json` と `~/.claude/skills`(実機の 2 本)", () => {
    expect(claudeAdapter.watchPaths({ env })).toEqual([
      "/home/me/.claude.json",
      "/home/me/.claude/skills",
    ]);
  });
});
