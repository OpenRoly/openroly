// openroly-mask の masking 本体(PBI-0177)。OpenRoly の MCP server 内蔵 masking(旧 packages/mcp/src/masking.ts・
// REQ-69)から移設し、単体 OSS として切り出した — OpenRoly の account 無しで今日から入れられる、
// 「Claude にも Codex にも同じに効く秘匿」を単体で体験できる導線にする(3 点の②)。
//
// 秘匿の源は 3 つ(~/.openroly/secrets.json・0600 必須):
//   SECRETS  — credential 文字列(現行のまま。配列 or object どちらでも受ける)
//   PRIVATE  — user 辞書(人名・住所など任意文字列。SECRETS と同じ扱いで静的に mask する)
//   PATTERNS — 既定 on の形パターン(email・電話・card 番号・鍵形)。値は事前に知らなくても
//              text の中から動的に見つけて mask する
// placeholder は `⟨s:n⟩` 1 種のみ(種別を出すと LLM が推測する手掛かりになる)。
//
// 後方互換: 旧形式(file 全体が生の配列 or {key: value} の object)は SECRETS 相当として読む
// (packages/mcp の既存 test・既存運用を壊さない)。

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 旧 `~/.atn` だけが在る端末ではそれを引き継ぐ(PBI-0344 AC-3)。この package は単体 OSS
// (依存 0)なので @openroly/core の legacyDir を使えず、同じ規則をここに置く。警告は 1 process 1 行
// HOME が無い環境では bun の homedir() が throw する(uv_os_homedir ENOENT・PBI-0676)ので
// import 時に評価せず secretsPath() の中で取る
const secretsCandidates = (): readonly [string, string] => {
  const home = homedir();
  return [join(home, ".openroly", "secrets.json"), join(home, ".atn", "secrets.json")];
};
let legacyDirWarned = false;

export const secretsPath = (): string => {
  const override = process.env.OPENROLY_SECRETS_PATH;
  if (override) return override;
  const [fresh, legacy] = secretsCandidates();
  if (existsSync(fresh) || !existsSync(legacy)) return fresh;
  if (!legacyDirWarned) {
    legacyDirWarned = true;
    console.error(
      `[openroly-mask] legacy state directory ${join(homedir(), ".atn")} is in use — move it to ${join(homedir(), ".openroly")} (support ends in a future release)`,
    );
  }
  return legacy;
};

function checkPermissions(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${path} has permission ${mode.toString(8)}. A file holding plaintext secrets must be readable by its owner only, 0600 (chmod 600 ${path})`,
    );
  }
}

/** 配列 or {key: value} の object から文字列の「値」だけを集める。長さ 0 は捨てる */
function extractStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (raw !== null && typeof raw === "object") {
    return Object.values(raw).filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}

/** 長い順・重複除去に固定する。長い secret を先に置換しないと短い共通部分だけ置換されて
 * prefix が漏れる(例: ghp_… の ghp だけ残る) */
function longestFirst(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** secrets.json を読む(旧形式互換)。無ければ空(mask 対象なし = 挙動は従来どおり)。
 * 壊れた JSON も空にせず投げる — 「半分だけ mask」より「mask 無しで起動させるか、直させてから起動」が安全側 */
export function loadSecrets(path: string = secretsPath()): string[] {
  if (!existsSync(path)) return [];
  checkPermissions(path);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return longestFirst(extractStrings(raw));
}

export interface PatternConfig {
  email: boolean;
  phone: boolean;
  card: boolean;
  keys: boolean;
}

export const DEFAULT_PATTERNS: PatternConfig = { email: true, phone: true, card: true, keys: true };

export interface MaskConfig {
  /** SECRETS ∪ PRIVATE。同じ ⟨s:n⟩ scheme で静的に mask する(長い順) */
  secrets: string[];
  patterns: PatternConfig;
}

const isNestedFormat = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null &&
  typeof raw === "object" &&
  !Array.isArray(raw) &&
  ("SECRETS" in raw || "PRIVATE" in raw || "PATTERNS" in raw);

/** 新形式(`{SECRETS, PRIVATE, PATTERNS}`)と旧形式(生の配列/object = SECRETS 相当)の両方を読む */
export function loadConfig(path: string = secretsPath()): MaskConfig {
  if (!existsSync(path)) return { secrets: [], patterns: DEFAULT_PATTERNS };
  checkPermissions(path);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isNestedFormat(raw)) return { secrets: longestFirst(extractStrings(raw)), patterns: DEFAULT_PATTERNS };
  const secrets = longestFirst([...extractStrings(raw.SECRETS), ...extractStrings(raw.PRIVATE)]);
  const rawPatterns = raw.PATTERNS;
  const patterns: PatternConfig =
    rawPatterns !== null && typeof rawPatterns === "object"
      ? { ...DEFAULT_PATTERNS, ...(rawPatterns as Partial<PatternConfig>) }
      : DEFAULT_PATTERNS;
  return { secrets, patterns };
}

/** `⟨s:n⟩`。n は secrets 配列(長い順)での index。restoreText と対で使う */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  secrets.forEach((secret, n) => {
    out = out.split(secret).join(`⟨s:${n}⟩`);
  });
  return out;
}

/** mask の逆変換。send / reply の text だけに適用する(応答面で復元すると mask が無意味になる) */
export function restoreText(text: string, secrets: string[]): string {
  return text.replace(/⟨s:(\d+)⟩/g, (whole, n: string) => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 0 && i < secrets.length ? secrets[i]! : whole;
  });
}

/** tool 応答全体を deep walk して **文字列の「値」だけ**を mask する(object の key は変えない —
 * key を変えると応答の shape が壊れて agent が parse できなくなる)。循環参照は JSON 応答に
 * なり得ない(API 応答 = JSON.parse 済み)ので考慮しない */
export function maskValue(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return maskText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskValue(v, secrets);
    return out;
  }
  return value;
}

// ---------- PATTERNS(既定 on。値を事前に知らなくても text から動的に見つける) ----------

/** Luhn チェック(桁だけの文字列)。card 番号の誤検知(電話・注文番号)を減らす */
function passesLuhn(digitsOnly: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let d = digitsOnly.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const EMAIL_RE = /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164(+81 90 1234 5678 等)/ JP 国内(090-1234-5678)/ US(555-123-4567・(555) 123-4567)。
// \b を必須にする(境界なしだと token の末尾の数字列を誤って phone と読む — 例: "sk-xxx1234567890")
const PHONE_RE = /\B\+\d{1,3}(?:[ -]?\d{2,4}){2,5}\b|\b0\d{1,4}-\d{1,4}-\d{3,4}\b|\b\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g;
// 13〜19 桁(空白/ハイフン区切り許容)。Luhn を通らなければ後段で除外する。
// レビュー修正: 区切り文字を「各桁の後ろ」に置く旧形(`(?:\d[ -]?){13,19}`)は、最終反復の
// 区切り文字を貪欲に飲み込んだ上でその直後(空白→文字)でも \b が成立してしまい、末尾の空白
// ごと mask してしまっていた(隣接語と連結する不具合)。区切り文字を「先頭の桁の後ろ」限定に
// 変える(`\d(?:[ -]?\d){12,18}`)と、必ず桁で終わるので末尾の区切り文字を飲み込めない
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
// 特定の形(sk-… / ghp_… / xoxb-… / JWT)。他 pattern より先に走らせる — 電話/card の緩い数字
// pattern が token の一部(末尾の数字列)を先食いすると、鍵の残りが平文で漏れる為
// 特定形(sk-proj / sk-ant / github_pat / AKIA / AIza / password=)を generic sk- より先に置く。
// dogfood F15: 13 形中 6 形が素通りしていた。
const KEY_RE =
  /\bsk-proj-[A-Za-z0-9_-]+\b|\bsk-ant-[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9]{10,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxoxb-[A-Za-z0-9-]{10,}\b|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bpassword=["']?[^\s"'\\]{8,}["']?/g;

/** pattern 一致箇所を `replace(matched)` の返り値に置き換える。既に mask 済み(⟨s:n⟩)の箇所は
 * 対象にしない(static secrets 置換の後に呼ぶ前提 — masking.ts の呼び出し順が不変条件)。
 * 判定順は「構造が特定できる形(keys)→ 緩い数字形(phone/card)→ email」— 緩い pattern が
 * 特定形の一部を先食いして残りを平文で漏らすのを防ぐ */
export function applyPatterns(text: string, patterns: PatternConfig, replace: (matched: string) => string): string {
  let out = text;
  if (patterns.keys) out = out.replace(KEY_RE, (m) => replace(m));
  if (patterns.card) {
    out = out.replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return passesLuhn(digits) ? replace(m) : m;
    });
  }
  if (patterns.phone) out = out.replace(PHONE_RE, (m) => replace(m));
  if (patterns.email) out = out.replace(EMAIL_RE, (m) => replace(m));
  return out;
}

/**
 * 1 process(1 子 MCP server の寿命)の間だけ生きる mask/restore の表。static secrets(SECRETS ∪
 * PRIVATE)は固定 index、pattern の一致は見つかった順に table へ追記して index を振る
 * (要件: 復元表は process の寿命だけ・PBI-0177)
 */
export class Masker {
  private table: string[];
  private readonly staticCount: number;

  constructor(initialSecrets: string[]) {
    this.table = [...initialSecrets];
    this.staticCount = initialSecrets.length;
  }

  private allocate(value: string): number {
    const i = this.table.indexOf(value);
    if (i !== -1) return i;
    this.table.push(value);
    return this.table.length - 1;
  }

  /** `onPattern` は、この呼び出しで pattern に一致した値の index を 1 つずつ知らせる(表に既に在った値も)。
   * 辞書の値と、元の text に書かれていた `⟨s:n⟩` の字面は知らせない —— 呼び手が「どの応答から来た値か」を持つ為の口 */
  maskText(text: string, patterns: PatternConfig, onPattern?: (index: number) => void): string {
    let out = text;
    for (let i = 0; i < this.staticCount; i++) out = out.split(this.table[i]!).join(`⟨s:${i}⟩`);
    out = applyPatterns(out, patterns, (matched) => {
      const i = this.allocate(matched);
      onPattern?.(i);
      return `⟨s:${i}⟩`;
    });
    return out;
  }

  maskValue(value: unknown, patterns: PatternConfig, onPattern?: (index: number) => void): unknown {
    if (typeof value === "string") return this.maskText(value, patterns, onPattern);
    if (Array.isArray(value)) return value.map((v) => this.maskValue(v, patterns, onPattern));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.maskValue(v, patterns, onPattern);
      return out;
    }
    return value;
  }

  restoreText(text: string): string {
    return text.replace(/⟨s:(\d+)⟩/g, (whole, n: string) => {
      const i = Number(n);
      return Number.isInteger(i) && i >= 0 && i < this.table.length ? this.table[i]! : whole;
    });
  }

  restoreValue(value: unknown): unknown {
    if (typeof value === "string") return this.restoreText(value);
    if (Array.isArray(value)) return value.map((v) => this.restoreValue(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.restoreValue(v);
      return out;
    }
    return value;
  }
}

/** cli.ts の --dry-run 用。table を持たず、その場限りの mask だけ見せる(何が伏せられるか) */
export function dryRunMask(text: string, config: MaskConfig): string {
  const masker = new Masker(config.secrets);
  return masker.maskText(text, config.patterns);
}
