// PBI-0658 / CAP-4 A8: Connection の判定(第 32 通 §1〜§5・§10・§15〜§19・改-1 / 改-7 ③)。
//
// 接続は今 5 つの表に割れている(`connections` / `extensions` / `sources` /
// `runtime_registrations` / `device_keys` + `push_subscriptions`)。**表は 1 つも捨てない** ——
// 捨てると token_hash も materialization も一緒に落ちる。代わりに `connections` の行が
// 1 本ずつ束ね、「何ができるか」を capabilities で名乗る。
//
// **A3 の 4 Registry(RuntimeRegistry / ModelProviderRegistry / ExtensionRegistry /
// CommandRegistry)は上位 ontology にしない**(覆り #36)。4 つの区別は `transport` の**値**に
// 降りる —— 面と Control API は Connection 1 語のまま、内部の分離だけ残る。
//
// capabilities は **自由な string**(`<domain>.<verb>` の既存語彙)。enum にしない理由は §5 の
// 「新しい種類のサービス(Obsidian・Linear・S3)を足す時に表も kind も増えない」で、
// 値を固定した瞬間にその性質が消えるから。**判定に使うのは transport / locality / scope だけ**。

/** 接続の届き方 7 値。migration 065 の connections_transport_check と同じ並び(value-sets-check.ts が同値を測る)。
 *  cli = 端末の CLI(RuntimeRegistry) / acp = ACP を喋る harness / mcp = MCP server(ExtensionRegistry) /
 *  http = こちらが HTTP で叩く service(ModelProviderRegistry・GitHub・持ち込みの endpoint) /
 *  device = 鍵を持つ端末 / surface = 通知の出口(push・collector) / session-driver = Herdr(CAP-14 Y4・行だけ予約) */
export const CONNECTION_TRANSPORTS = [
  "cli",
  "acp",
  "mcp",
  "http",
  "device",
  "surface",
  "session-driver",
] as const;
export type ConnectionTransport = (typeof CONNECTION_TRANSPORTS)[number];

/** どこに在るか 3 値(第 26 通の `locality`)。横断ルール 1 の cloud_visibility と組で読む */
export const CONNECTION_LOCALITIES = ["device", "private-network", "cloud"] as const;
export type ConnectionLocality = (typeof CONNECTION_LOCALITIES)[number];

export const isConnectionTransport = (v: unknown): v is ConnectionTransport =>
  typeof v === "string" && (CONNECTION_TRANSPORTS as readonly string[]).includes(v);

export const isConnectionLocality = (v: unknown): v is ConnectionLocality =>
  typeof v === "string" && (CONNECTION_LOCALITIES as readonly string[]).includes(v);

/** catalog entry を持つ Connection(= runtime)が常に名乗る 4 本。entry 側の `capabilities`
 *  (coding / shell / files / chat / local_model)はこれに**足される**(置き換えない) */
export const RUNTIME_CONNECTION_CAPABILITIES = ["run_work", "resume_work", "wake", "stop"] as const;

/**
 * catalog の `kind` → transport。**RuntimeRegistry と ModelProviderRegistry の分離がここに降りる**
 * (C13 #10「v0 で要るのはこの分離だけ」)。api / local_model_server = こちらが HTTP で叩く口、
 * それ以外(cli / app・catalog に無い broker / local-*)は端末の CLI として届く。
 */
export function transportForCatalogKind(kind: string | null | undefined): ConnectionTransport {
  return kind === "api" || kind === "local_model_server" ? "http" : "cli";
}

export interface ConnectionLike {
  transport: string;
  /** その行自身が名乗る capability(自由な string) */
  capabilities?: readonly string[] | null;
  /** catalog entry。runtime の Connection だけが持つ(無い = 名乗るのは自分の列だけ) */
  catalog?: { kind?: string | null; capabilities?: readonly string[] | null } | null;
  /** null = account 全体。非 null = その project の scope key だけ(D1・`projects` 表は立てない) */
  scopeKey?: string | null;
  revokedAt?: string | null;
}

/**
 * その Connection が名乗る capability の全部。catalog entry を持つ行は 4 本の runtime 動詞を
 * **足して**名乗る —— catalog 側に `capabilities` が空の entry(91 中 30 本)が在り、
 * そこだけ「何もできない」と読まれると wake 先が消える。
 * 重複は落とし、並びは runtime 動詞 → catalog → 自分の列で固定する(表示が揺れない)。
 */
export function advertised(conn: ConnectionLike): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (v !== "" && !out.includes(v)) out.push(v);
  };
  if (conn.catalog) {
    for (const v of RUNTIME_CONNECTION_CAPABILITIES) push(v);
    for (const v of conn.catalog.capabilities ?? []) push(v);
  }
  for (const v of conn.capabilities ?? []) push(v);
  return out;
}

/**
 * この Connection を `requirements` の仕事に、`scope`(project の scope key・null = account)で
 * 使ってよいか。**fail-closed** —— 知らない transport / locality は false を返す。
 * 「知らない値は通さない」を判定側にも置くのは、DB の check をすり抜けた行(旧 dump の復元・
 * 手で入れた行)が Router の候補に混ざるのを止める為(check は新しい行しか見ない)。
 */
export function matches(
  conn: ConnectionLike,
  requirements: readonly string[],
  scope: string | null = null,
): boolean {
  if (conn.revokedAt != null) return false;
  if (!isConnectionTransport(conn.transport)) return false;
  // scope が付いた行は、その project の仕事にしか出てこない(account の仕事にも出さない)
  const key = conn.scopeKey ?? null;
  if (key !== null && key !== scope) return false;
  const have = advertised(conn);
  return requirements.every((r) => have.includes(r));
}

// ---------- 束ねる元(5 表)→ Connection の形 ----------
// migration 065 の backfill と**同じ規則**を書く側にも効かせる為の 1 枚。ここを 2 箇所に散らすと
// 「昔の行と今日の行で transport が違う」が静かに起きる(一覧の並びだけが崩れるので気付けない)。

/** 束ねた元の表の名前。`connections` 自身(provider の鍵)は origin を持たない(= null) */
export const CONNECTION_ORIGINS = [
  "runtime_registrations",
  "extensions",
  "sources",
  "device_keys",
  "push_subscriptions",
] as const;
export type ConnectionOrigin = (typeof CONNECTION_ORIGINS)[number];

export interface ConnectionShape {
  transport: ConnectionTransport;
  locality: ConnectionLocality;
  capabilities: string[];
}

/**
 * 元の表と、その行の `kind` から Connection の形を決める。**null = Connection にしない**
 * (`extensions` の skill / plugin は改-1 の Skill primitive で、届き方を持たない)。
 *
 * runtime の cli / http の分かれ目は catalog の `kind` だが、backfill は catalog JSON を読めない。
 * catalog で kind = api の entry は必ず `<provider>-api` の形で作られる(catalog-build が
 * API_PROVIDERS から組む)ので、**両側ともこの形で分ける** —— 形が崩れていない事は
 * packages/core/test/connection.test.ts が catalog 全 entry に対して機械で測る。
 */
export function connectionShapeFor(origin: ConnectionOrigin, kind: string | null): ConnectionShape | null {
  switch (origin) {
    case "runtime_registrations":
      return kind !== null && kind.endsWith("-api")
        ? { transport: "http", locality: "cloud", capabilities: [] }
        : { transport: "cli", locality: "device", capabilities: [] };
    case "extensions":
      return kind === "mcp" ? { transport: "mcp", locality: "device", capabilities: ["mcp.tools"] } : null;
    case "sources":
      return kind === "webhook"
        ? { transport: "http", locality: "cloud", capabilities: ["inbox.capture"] }
        : { transport: "surface", locality: "device", capabilities: ["inbox.capture"] };
    case "device_keys":
      return { transport: "device", locality: "device", capabilities: ["content.decrypt"] };
    case "push_subscriptions":
      return { transport: "surface", locality: "cloud", capabilities: ["notify.push"] };
  }
}

/** provider の鍵(`connections` 自身の行)の形。github = 認可の範囲・それ以外 = model を叩く口 */
export function providerConnectionShape(provider: string): ConnectionShape {
  return {
    transport: "http",
    locality: "cloud",
    capabilities: provider === "github" ? ["repo.read", "repo.write"] : ["chat.completion"],
  };
}
