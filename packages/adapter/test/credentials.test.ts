import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  getAccountUrl,
  getCredential,
  loadCredentials,
  openrolyHome,
  removeCredential,
  saveAccountUrl,
  saveCredential,
  type RuntimeCredential,
} from "../src/credentials.ts";

// AC-1 / AC-2: credential は runtime kind ごとに保存され、2 つ目の pairing が 1 つ目を
// 上書きしない(1 runtime = 1 credential = 1 runtime_id — 要件 §15.1)。

const cred = (id: string): RuntimeCredential => ({
  runtime_id: `rt_${id}`,
  token: `par_${id}`,
  base_url: "http://localhost:8787",
  name: `MacBook / ${id}`,
  paired_at: new Date().toISOString(),
});

async function tempEnv() {
  return { OPENROLY_HOME: await mkdtemp(join(tmpdir(), "openroly-cred-")) };
}

describe("credential store", () => {
  test("未作成なら空、保存すると kind ごとに引ける", async () => {
    const env = await tempEnv();
    expect((await loadCredentials(env)).runtimes).toEqual({});

    await saveCredential("claude", cred("claude"), env);
    await saveCredential("codex", cred("codex"), env);

    const file = await loadCredentials(env);
    expect(Object.keys(file.runtimes).sort()).toEqual(["claude", "codex"]);
    expect((await getCredential("claude", env))?.runtime_id).toBe("rt_claude");
    expect((await getCredential("codex", env))?.token).toBe("par_codex");
    expect(await getCredential("hermes", env)).toBeUndefined();
  });

  test("同じ kind の再 pair は置き換え、別 kind は残る", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("a"), env);
    await saveCredential("codex", cred("codex"), env);
    await saveCredential("claude", cred("b"), env);

    const file = await loadCredentials(env);
    expect(file.runtimes.claude?.runtime_id).toBe("rt_b");
    expect(file.runtimes.codex?.runtime_id).toBe("rt_codex");
  });

  test("file mode は 0600(他 user から token を読めない)", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsPath(env), "utf8")).version).toBe(1);
  });

  test("remove は該当 kind だけ消す", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    await saveCredential("codex", cred("codex"), env);

    expect(await removeCredential("claude", env)).toBe(true);
    expect(await removeCredential("claude", env)).toBe(false);
    expect(Object.keys((await loadCredentials(env)).runtimes)).toEqual(["codex"]);
  });

  // ---- PBI-0004: 同時 install(claude と codex)で entry を落とさない ----

  test("AC-10: 同一プロセス内の並行 save が互いの entry を消さない", async () => {
    const env = await tempEnv();
    await Promise.all([
      saveCredential("claude", cred("claude"), env),
      saveCredential("codex", cred("codex"), env),
      saveCredential("hermes", cred("hermes"), env),
    ]);
    expect(Object.keys((await loadCredentials(env)).runtimes).sort()).toEqual([
      "claude",
      "codex",
      "hermes",
    ]);
  });

  test("AC-10/AC-11: 別プロセスの並行 save でも全 entry が残り、壊れた JSON にならない", async () => {
    const env = await tempEnv();
    const module = new URL("../src/credentials.ts", import.meta.url).href;
    const kinds = ["claude", "codex", "hermes", "aider"];
    const procs = kinds.map((kind) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { saveCredential } = await import(${JSON.stringify(module)});
           await saveCredential(${JSON.stringify(kind)}, {
             runtime_id: "rt_${kind}", token: "par_${kind}",
             base_url: "http://localhost:8787", name: ${JSON.stringify(kind)},
             paired_at: new Date().toISOString(),
           }, { OPENROLY_HOME: ${JSON.stringify(env.OPENROLY_HOME)} });`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(errs.join("")).toBe("");

    const file = await loadCredentials(env);
    expect(file.version).toBe(1);
    expect(Object.keys(file.runtimes).sort()).toEqual([...kinds].sort());
    // lock file を残さない(次の install が 5 秒待たされる)
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(env.OPENROLY_HOME)).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 60_000);
});

// ---- PBI-0246 AC-X2 / AC-X3: account の URL は token と同じ file・同じ規律 ----

describe("account_url", () => {
  test("未保存なら undefined。保存すると末尾の / を落として引ける", async () => {
    const env = await tempEnv();
    expect(await getAccountUrl(env)).toBeUndefined();

    await saveAccountUrl("https://atn.shibubu.ai/", env);
    expect(await getAccountUrl(env)).toBe("https://atn.shibubu.ai");
  });

  test("runtime の credential を巻き込まない(どちらの向きでも)", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    await saveAccountUrl("https://atn.shibubu.ai", env);
    await saveCredential("codex", cred("codex"), env);

    const file = await loadCredentials(env);
    expect(file.account_url).toBe("https://atn.shibubu.ai");
    expect(Object.keys(file.runtimes).sort()).toEqual(["claude", "codex"]);
  });

  test("AC-X2: 保存先の file mode は 0600(token と同じ扱い)", async () => {
    const env = await tempEnv();
    await saveAccountUrl("https://atn.shibubu.ai", env);
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
  });

  test("手で壊された値は「無い」として扱う(1 行で全 command を落とさない)", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    const { writeFile } = await import("node:fs/promises");
    for (const broken of [123, "", null]) {
      await writeFile(
        credentialsPath(env),
        JSON.stringify({ version: 1, account_url: broken, runtimes: {} }),
      );
      expect(await getAccountUrl(env)).toBeUndefined();
    }
  });

  test("AC-X3: 別 URL の login が同時に走っても後勝ちで、壊れた中間状態を残さない", async () => {
    const env = await tempEnv();
    await saveCredential("claude", cred("claude"), env);
    const module = new URL("../src/credentials.ts", import.meta.url).href;
    const urls = ["https://a.example", "https://b.example", "https://c.example", "https://d.example"];
    const procs = urls.map((url) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { saveAccountUrl } = await import(${JSON.stringify(module)});
           await saveAccountUrl(${JSON.stringify(url)}, { OPENROLY_HOME: ${JSON.stringify(env.OPENROLY_HOME)} });`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(errs.join("")).toBe("");

    const file = await loadCredentials(env);
    // 後勝ち —— どれが最後かは決まらないが、**どれか 1 つ**が丸ごと残る(混ざらない)
    expect(typeof file.account_url).toBe("string");
    expect(urls).toContain(file.account_url as string);
    // 先に居た credential を巻き込まない / 半端な file を残さない
    expect(file.version).toBe(1);
    expect(Object.keys(file.runtimes)).toEqual(["claude"]);
    const { readdir } = await import("node:fs/promises");
    const left = await readdir(env.OPENROLY_HOME);
    expect(left.filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);
});

// review: PBI-0414 急所2(実射)。checkpoint-cas.ts 等の isolate し忘れが実行者本人の
// 本物の ~/.openroly に書き込んだ事故(2026-09-10)を受けて、openrolyHome() 自身に
// 「bun test 下で OPENROLY_HOME 未設定なら実 HOME に落ちず throw する」ガードを追加した。
describe("openrolyHome の test-mode ガード(review: PBI-0414 急所2)", () => {
  test("実射: OPENROLY_HOME 未設定 + bun test 下(process.env.NODE_ENV === \"test\")なら throw する", () => {
    // bun test は既定で NODE_ENV=test を立てる(このファイル自体がそれで動いている)。
    // env に OPENROLY_HOME を含めない(process.env をそのまま使う形)と実 HOME へ落ちるはずが、
    // 落ちずに明示的に throw する事を実射で確認する
    expect(() => openrolyHome({})).toThrow(/OPENROLY_HOME is not set while running under `bun test`/);
  });

  test("負の対照: OPENROLY_HOME を渡せば throw しない(既存の正常系を壊していない)", () => {
    expect(openrolyHome({ OPENROLY_HOME: "/tmp/some-isolated-home" })).toBe("/tmp/some-isolated-home");
  });
});
