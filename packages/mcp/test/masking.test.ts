import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, maskText, maskValue, restoreText, secretsPath } from "openroly-mask";

// REQ-69(PBI-0117): secrets.json(0600)の読み込み、`⟨s:n⟩` の長い順安定割当、値だけの deep mask、
// そして restore との対。mask は「tool 応答 → agent の context」面、restore は「agent → send/reply」面。

describe("loadSecrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "openroly-mask-"));
  const path = join(dir, "secrets.json");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("file が無ければ空(mask 対象なし = 従来どおり)", () => {
    expect(loadSecrets(join(dir, "missing.json"))).toEqual([]);
  });

  test("配列形式・空文字除去・重複除去・長い順", () => {
    writeFileSync(path, JSON.stringify(["ghp_short", "sk-very-long-secret-value-aaa", "ghp_short", ""]));
    chmodSync(path, 0o600);
    const secrets = loadSecrets(path);
    expect(secrets).toEqual(["sk-very-long-secret-value-aaa", "ghp_short"]);
  });

  test("object 形式は値だけを採用する(key は mask しない)", () => {
    writeFileSync(path, JSON.stringify({ OPENAI: "sk-openai-123", NOTE: 42, EMPTY: "" }));
    chmodSync(path, 0o600);
    expect(loadSecrets(path)).toEqual(["sk-openai-123"]);
  });

  test("0600 以外は投げる(fail-closed。起動拒否の元)", () => {
    writeFileSync(path, JSON.stringify(["x".repeat(20)]));
    chmodSync(path, 0o644);
    expect(() => loadSecrets(path)).toThrow(/0600/);
  });

  test("壊れた JSON は投げる(半分だけ mask より起動を止める)", () => {
    writeFileSync(path, "{not json");
    chmodSync(path, 0o600);
    expect(() => loadSecrets(path)).toThrow();
  });

  test("secretsPath は OPENROLY_SECRETS_PATH を優先する", () => {
    const prev = process.env.OPENROLY_SECRETS_PATH;
    try {
      process.env.OPENROLY_SECRETS_PATH = "/tmp/custom-secrets.json";
      expect(secretsPath()).toBe("/tmp/custom-secrets.json");
    } finally {
      if (prev === undefined) delete process.env.OPENROLY_SECRETS_PATH;
      else process.env.OPENROLY_SECRETS_PATH = prev;
    }
  });
});

describe("maskText / restoreText", () => {
  const secrets = ["sk-very-long-secret-value-aaa", "ghp_short"];

  test("長い secret から先に置換される(prefix 漏れ防止)", () => {
    const out = maskText("a sk-very-long-secret-value-aaa b ghp_short c", secrets);
    expect(out).toBe("a ⟨s:0⟩ b ⟨s:1⟩ c");
  });

  test("同じ secret は常に同じ n(セッション中の安定割当)", () => {
    expect(maskText("ghp_short", secrets)).toBe("⟨s:1⟩");
    expect(maskText("x ghp_short y", secrets)).toBe("x ⟨s:1⟩ y");
    expect(maskText("ghp_short ghp_short", secrets)).toBe("⟨s:1⟩ ⟨s:1⟩");
  });

  test("restoreText が対で戻す。未知の n は壊さず残す", () => {
    const masked = maskText("key=sk-very-long-secret-value-aaa end", secrets);
    expect(restoreText(masked, secrets)).toBe("key=sk-very-long-secret-value-aaa end");
    expect(restoreText("⟨s:99⟩ is unknown", secrets)).toBe("⟨s:99⟩ is unknown");
  });

  test("secrets が空なら mask も restore も何もしない", () => {
    expect(maskText("plain", [])).toBe("plain");
    expect(restoreText("⟨s:0⟩", [])).toBe("⟨s:0⟩");
  });
});

describe("maskValue", () => {
  const secrets = ["sk-secret-value-9999"];

  test("文字列「値」だけを mask する(key・数値・null は触らない)", () => {
    const input = {
      id: "msg_1",
      nested: { text: "token is sk-secret-value-9999", count: 2, flag: null },
      list: ["sk-secret-value-9999", "clean"],
      "sk-secret-value-9999-key": "value",
    };
    expect(maskValue(input, secrets)).toEqual({
      id: "msg_1",
      nested: { text: "token is ⟨s:0⟩", count: 2, flag: null },
      list: ["⟨s:0⟩", "clean"],
      "sk-secret-value-9999-key": "value", // key はそのまま(shape を壊さない)
    });
  });

  test("secrets が空なら元の値をそのまま返す(mask 無し運用 = 従来挙動)", () => {
    const input = { a: "b" };
    expect(maskValue(input, [])).toBe(input);
  });
});
