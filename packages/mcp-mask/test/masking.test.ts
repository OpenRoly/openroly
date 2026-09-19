import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PATTERNS,
  Masker,
  loadConfig,
  loadSecrets,
  maskText,
  maskValue,
  restoreText,
} from "../src/masking.ts";

// PBI-0177: secrets.json(0600・旧形式互換)の読み込み、SECRETS/PRIVATE/PATTERNS の 3 源、
// stateful な Masker(process 寿命の table)の mask/restore 往復と AC-X1/X3。

describe("loadSecrets(旧形式互換)", () => {
  const dir = mkdtempSync(join(tmpdir(), "openroly-mask-"));
  const path = join(dir, "secrets.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("生の配列(旧形式)を長い順・重複除去で読む", () => {
    writeFileSync(path, JSON.stringify(["ghp_short", "sk-very-long-secret-value-aaa", "ghp_short"]));
    chmodSync(path, 0o600);
    expect(loadSecrets(path)).toEqual(["sk-very-long-secret-value-aaa", "ghp_short"]);
  });

  test("0600 以外は投げる(fail-closed)", () => {
    writeFileSync(path, JSON.stringify(["x".repeat(20)]));
    chmodSync(path, 0o644);
    expect(() => loadSecrets(path)).toThrow(/0600/);
  });
});

describe("loadConfig (AC-1相当: SECRETS/PRIVATE/PATTERNS の 3 源)", () => {
  const dir = mkdtempSync(join(tmpdir(), "openroly-mask-config-"));
  const path = join(dir, "secrets.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("新形式(SECRETS+PRIVATE)は 1 つの secrets 配列に合流する(長い順)", () => {
    writeFileSync(path, JSON.stringify({ SECRETS: ["sk-abc"], PRIVATE: ["Taro Yamada"] }));
    chmodSync(path, 0o600);
    const cfg = loadConfig(path);
    expect(cfg.secrets).toEqual(["Taro Yamada", "sk-abc"]);
    expect(cfg.patterns).toEqual(DEFAULT_PATTERNS);
  });

  test("PATTERNS は個別に off にできる(既定は全部 on)", () => {
    writeFileSync(path, JSON.stringify({ PATTERNS: { email: false } }));
    chmodSync(path, 0o600);
    const cfg = loadConfig(path);
    expect(cfg.patterns).toEqual({ email: false, phone: true, card: true, keys: true });
  });

  test("file が無ければ空(mask 対象なし)", () => {
    expect(loadConfig(join(dir, "missing.json"))).toEqual({ secrets: [], patterns: DEFAULT_PATTERNS });
  });
});

describe("maskText / restoreText(既存互換の stateless API)", () => {
  const secrets = ["sk-very-long-secret-value-aaa", "ghp_short"];
  test("長い secret から先に置換され、restore で戻る", () => {
    const masked = maskText("a sk-very-long-secret-value-aaa b ghp_short c", secrets);
    expect(masked).toBe("a ⟨s:0⟩ b ⟨s:1⟩ c");
    expect(restoreText(masked, secrets)).toBe("a sk-very-long-secret-value-aaa b ghp_short c");
  });
});

describe("maskValue", () => {
  test("文字列「値」だけを mask する(key は変えない)", () => {
    const input = { id: "msg_1", text: "token is sk-x", "sk-x-key": "value" };
    expect(maskValue(input, ["sk-x"])).toEqual({ id: "msg_1", text: "token is ⟨s:0⟩", "sk-x-key": "value" });
  });
});

describe("Masker(stateful table。AC-1/2/3)", () => {
  test("AC-1: PRIVATE の辞書語が result から 0 回になり、⟨s:0⟩ が出る", () => {
    const masker = new Masker(["Taro Yamada"]);
    const out = masker.maskText("Taro Yamada said hi", DEFAULT_PATTERNS);
    expect(out).not.toContain("Taro Yamada");
    expect(out).toBe("⟨s:0⟩ said hi");
  });

  test("AC-2: params の ⟨s:0⟩ を restore すると元の辞書語に戻る", () => {
    const masker = new Masker(["Taro Yamada"]);
    const masked = masker.maskText("Taro Yamada", DEFAULT_PATTERNS);
    expect(masker.restoreText(masked)).toBe("Taro Yamada");
  });

  test("AC-3: 辞書なし・PATTERNS 既定で email/電話/card(Luhn 有効)が mask され、Luhn 無効の16桁は伏せない", () => {
    const masker = new Masker([]);
    const out = masker.maskText(
      "mail a@b.example tel +81 90 1234 5678 card 4242 4242 4242 4242 bad 1234 5678 9012 3456",
      DEFAULT_PATTERNS,
    );
    expect(out).toContain("⟨s:0⟩");
    expect(out).toContain("⟨s:1⟩");
    expect(out).toContain("⟨s:2⟩");
    expect(out).not.toContain("a@b.example");
    expect(out).not.toContain("4242 4242 4242 4242");
    expect(out).toContain("1234 5678 9012 3456"); // Luhn を通らない → 伏せない
  });

  test("鍵形(sk-/ghp_)は電話 pattern に先食いされず丸ごと mask される(prefix 漏れ防止)", () => {
    const masker = new Masker([]);
    const out = masker.maskText("token sk-abcdefghij1234567890 end", DEFAULT_PATTERNS);
    expect(out).not.toContain("sk-abcdefghij");
    expect(out).not.toContain("1234567890");
    expect(masker.restoreText(out)).toBe("token sk-abcdefghij1234567890 end");
  });

  test("PBI-0687 / F15: 辞書無しでも sk-proj / sk-ant / github_pat / AKIA / AIza / password= を伏せる", () => {
    const masker = new Masker([]);
    const src =
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345 sk-ant-api03-abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz0123456789 AKIAIOSFODNN7EXAMPLE AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe password=hunter2secret";
    const out = masker.maskText(src, DEFAULT_PATTERNS);
    expect(out).not.toContain("sk-proj-");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("github_pat_");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe");
    expect(out).not.toContain("hunter2secret");
    expect(masker.restoreText(out)).toBe(src);
    const off = new Masker([]);
    const raw = off.maskText(src, { ...DEFAULT_PATTERNS, keys: false });
    expect(raw).toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    expect(raw).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("AC-X1: 未知/負/空の index は例外を投げずそのまま通す(別 index の値を出さない)", () => {
    const masker = new Masker(["secret-a"]);
    expect(() => masker.restoreText("⟨s:999⟩ ⟨s:-1⟩ ⟨s:⟩ ⟨s:abc⟩")).not.toThrow();
    expect(masker.restoreText("⟨s:999⟩ ⟨s:-1⟩ ⟨s:⟩ ⟨s:abc⟩")).toBe("⟨s:999⟩ ⟨s:-1⟩ ⟨s:⟩ ⟨s:abc⟩");
  });

  test("AC-X3: 同じ値は常に同じ n(2 回目の mask で新規 index を作らない)", () => {
    const masker = new Masker([]);
    const first = masker.maskText("call +81 90 1234 5678", DEFAULT_PATTERNS);
    const second = masker.maskText("again +81 90 1234 5678", DEFAULT_PATTERNS);
    expect(first).toContain("⟨s:0⟩");
    expect(second).toContain("⟨s:0⟩"); // 新しい table 追記(⟨s:1⟩ 等)を作らない
  });

  test("restoreValue は object を deep walk する(params の復元と同型)", () => {
    const masker = new Masker(["secret-a"]);
    const masked = masker.maskText("secret-a", DEFAULT_PATTERNS);
    const restored = masker.restoreValue({ nested: { text: masked }, list: [masked] });
    expect(restored).toEqual({ nested: { text: "secret-a" }, list: ["secret-a"] });
  });

  // ---------- レビュー攻撃 test(newway §12.2 (b)。AC-3 の「値だけを mask する」を破りに行く) ----------
  test("攻撃: card 番号(CARD_RE)の直後の空白を飲み込み、隣接語と連結させてしまわないか", () => {
    const masker = new Masker([]);
    const out = masker.maskText("card 4242 4242 4242 4242 and more text", DEFAULT_PATTERNS);
    // 他 pattern(phone/key/email)は既に空白を保っている — card だけ崩れていないか固定する
    expect(out).toMatch(/⟨s:\d+⟩ and more text/);
    expect(masker.restoreText(out)).toBe("card 4242 4242 4242 4242 and more text");
  });
});
