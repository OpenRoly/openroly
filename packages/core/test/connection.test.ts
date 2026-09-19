// PBI-0658 / CAP-4 A8 AC-2: Connection の判定(値集合 / advertised / matches)。
// **判定の分岐はこの 1 枚**(route は結果を code に写すだけ)なので、境界はここで撃つ。
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONNECTION_LOCALITIES,
  CONNECTION_ORIGINS,
  CONNECTION_TRANSPORTS,
  RUNTIME_CONNECTION_CAPABILITIES,
  advertised,
  connectionShapeFor,
  isConnectionTransport,
  matches,
  providerConnectionShape,
  transportForCatalogKind,
} from "../src/connection.ts";

test("AC-2 値集合: transport 7 値 / locality 3 値。知らない値は述語が false", () => {
  expect([...CONNECTION_TRANSPORTS]).toEqual(["cli", "acp", "mcp", "http", "device", "surface", "session-driver"]);
  expect([...CONNECTION_LOCALITIES]).toEqual(["device", "private-network", "cloud"]);
  expect(isConnectionTransport("session-driver")).toBe(true);
  for (const bad of ["Cli", "CLI", "", "http ", "websocket", null, undefined, 3]) {
    expect(isConnectionTransport(bad)).toBe(false);
  }
});

test("AC-2 advertised: catalog を持つ行は 4 動詞 + entry の capabilities。空の entry でも 4 動詞は名乗る", () => {
  expect(advertised({ transport: "cli", catalog: { kind: "cli", capabilities: ["coding", "shell"] } })).toEqual([
    ...RUNTIME_CONNECTION_CAPABILITIES,
    "coding",
    "shell",
  ]);
  // catalog 91 entry のうち 30 本は capabilities が空。そこで「何もできない」と読むと wake 先が消える
  expect(advertised({ transport: "cli", catalog: { kind: "cli", capabilities: [] } })).toEqual([
    ...RUNTIME_CONNECTION_CAPABILITIES,
  ]);
  // catalog を持たない行は自分の列だけ
  expect(advertised({ transport: "http", capabilities: ["repo.read", "repo.write"] })).toEqual([
    "repo.read",
    "repo.write",
  ]);
  // 重複は落ち、並びは runtime 動詞 → catalog → 自分の列で固定
  expect(advertised({ transport: "cli", capabilities: ["wake", "x.y"], catalog: { kind: "cli", capabilities: ["wake"] } })).toEqual([
    ...RUNTIME_CONNECTION_CAPABILITIES,
    "x.y",
  ]);
  expect(advertised({ transport: "http" })).toEqual([]);
});

test("AC-2 matches: requirements が全部無いと false・空の requirements は true", () => {
  const conn = { transport: "cli", catalog: { kind: "cli", capabilities: ["coding"] } };
  expect(matches(conn, [])).toBe(true);
  expect(matches(conn, ["wake", "coding"])).toBe(true);
  expect(matches(conn, ["wake", "shell"])).toBe(false);
  // 名乗りは完全一致。前方一致や大小文字違いで通さない
  expect(matches(conn, ["cod"])).toBe(false);
  expect(matches(conn, ["Coding"])).toBe(false);
});

test("攻撃 AC-X: 知らない transport / 失効した行は fail-closed(requirements が空でも false)", () => {
  expect(matches({ transport: "websocket" }, [])).toBe(false);
  expect(matches({ transport: "" }, [])).toBe(false);
  expect(matches({ transport: "cli", revokedAt: "2026-09-16T00:00:00Z" }, [])).toBe(false);
  // catalog から entry が消えた runtime は「4 動詞を名乗る」を失う(古い名乗りを残さない)
  expect(matches({ transport: "cli", catalog: null }, ["wake"])).toBe(false);
});

test("攻撃 AC-X: scope 付きの行は、その project の仕事にしか出てこない(account の仕事にも出さない)", () => {
  const scoped = { transport: "mcp", capabilities: ["mcp.tools"], scopeKey: "prj_a" };
  expect(matches(scoped, ["mcp.tools"], "prj_a")).toBe(true);
  expect(matches(scoped, ["mcp.tools"], "prj_b")).toBe(false);
  expect(matches(scoped, ["mcp.tools"], null)).toBe(false);
  expect(matches(scoped, ["mcp.tools"])).toBe(false);
  // scope の無い行(account 全体)はどの project にも出る
  const open = { transport: "mcp", capabilities: ["mcp.tools"] };
  expect(matches(open, ["mcp.tools"], "prj_a")).toBe(true);
  expect(matches(open, ["mcp.tools"], null)).toBe(true);
});

test("AC-1 の写像: origin ごとの形。extensions は mcp だけが Connection になる", () => {
  expect([...CONNECTION_ORIGINS]).toEqual([
    "runtime_registrations",
    "extensions",
    "sources",
    "device_keys",
    "push_subscriptions",
  ]);
  expect(connectionShapeFor("extensions", "mcp")).toEqual({ transport: "mcp", locality: "device", capabilities: ["mcp.tools"] });
  expect(connectionShapeFor("extensions", "skill")).toBeNull();
  expect(connectionShapeFor("extensions", "plugin")).toBeNull();
  expect(connectionShapeFor("sources", "webhook")!.transport).toBe("http");
  expect(connectionShapeFor("sources", "android")!.transport).toBe("surface");
  expect(connectionShapeFor("device_keys", null)!.transport).toBe("device");
  expect(connectionShapeFor("push_subscriptions", null)!.transport).toBe("surface");
  expect(providerConnectionShape("github").capabilities).toEqual(["repo.read", "repo.write"]);
  expect(providerConnectionShape("custom-omni").capabilities).toEqual(["chat.completion"]);
  // 形は全部 CONNECTION_TRANSPORTS / CONNECTION_LOCALITIES の中にある(知らない値を作らない)
  for (const origin of CONNECTION_ORIGINS) {
    for (const kind of ["mcp", "webhook", "claude", "openai-api", null]) {
      const shape = connectionShapeFor(origin, kind);
      if (!shape) continue;
      expect(CONNECTION_TRANSPORTS).toContain(shape.transport);
      expect(CONNECTION_LOCALITIES).toContain(shape.locality);
    }
  }
});

// migration 065 の backfill は catalog JSON を読めないので `<id>-api` の形で cli / http を分ける。
// **その形が catalog 全 entry で崩れていない事をここで測る** —— 崩れた日に backfill だけが
// 静かに間違う(一覧の並びしか変わらないので誰も気付けない)。
test("AC-1 負の対照の土台: catalog 91 entry で `kind = api` ⇔ id が `-api` で終わる", () => {
  const raw = readFileSync(fileURLToPath(new URL("../registry/detectors.v1.json", import.meta.url)), "utf8");
  const detectors = (JSON.parse(raw) as { detectors: { id: string; kind: string }[] }).detectors;
  expect(detectors.length).toBeGreaterThan(80);
  for (const d of detectors) {
    expect(`${d.id}:${d.id.endsWith("-api")}`).toBe(`${d.id}:${d.kind === "api"}`);
    // backfill の分け方(id の形)と core の分け方(catalog の kind)が同じ答えを出す
    const byShape = connectionShapeFor("runtime_registrations", d.id)!.transport;
    const byKind = transportForCatalogKind(d.kind);
    if (d.kind !== "local_model_server") expect(`${d.id}:${byShape}`).toBe(`${d.id}:${byKind}`);
  }
  // 唯一ずれる local_model_server(ollama / lmstudio / jan)は **adapter が null = 自動登録の対象外**
  // なので runtime_registrations の行にならない = backfill が触らない。その前提をここで固定する
  for (const d of detectors as { id: string; kind: string; adapter: string | null }[]) {
    if (d.kind === "local_model_server") expect(`${d.id}:${d.adapter}`).toBe(`${d.id}:null`);
  }
});
