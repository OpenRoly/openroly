import { describe, expect, test } from "bun:test";
import { hashCapsuleBody, type CapsuleBody } from "../src/capsule.ts";
import { buildCapsuleFiles, verifyContinuation, type CapsuleExportInput } from "../src/protocol-export.ts";
import { validateCapsule, type PaapCapsule } from "../src/protocol.ts";
import { transferHolderId } from "../src/work.ts";

// PBI-0553: export の写像(buildCapsuleFiles)と L3 の判定(verifyContinuation)を server 無しで測る。
// 1 つの capsule が正しいかは protocol.ts の validateCapsule に聞く(ここで判定を書き写さない)。

const T0 = "2026-09-14T06:00:00.000Z";
const T1 = "2026-09-14T06:05:00.000Z";
const B1: CapsuleBody = { goal: "ship export", relevant_memory: { gh: { credential_ref: "env:GITHUB_TOKEN" } } };
const B2: CapsuleBody = {
  goal: "ship export",
  current_state: "writing files",
  decisions: ["write to tmp, rename once"],
  failed_attempts: ["writing in place left a partial dir"],
  capability_requirements: { deploy: { credential_ref: "env:FLY_API_TOKEN,GITHUB_TOKEN" } },
};
const B3: CapsuleBody = { goal: "ship export", current_state: "continued by opencode" };

const manifestOf = (body: CapsuleBody) => ({ payload_hash: hashCapsuleBody(body), size: 1, mode: "0600", refs: ["X"] });
const capsule = (work_id: string, version: number, write_epoch: number, body: CapsuleBody, run_id: string | null = "R1") => ({
  row: { id: `wcp_${work_id}_${version}`, account_id: "acc_1", work_id, version, write_epoch, run_id, body: manifestOf(body), content_hash: hashCapsuleBody(body), created_at: T0 },
  payload: body as CapsuleBody | null,
});
const workRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: "acc_1",
  owner: "account:acc_1",
  title: `title ${id}`,
  status: "running",
  visibility: "full",
  lease_epoch: 1,
  lease_holder_run: "R1",
  lease_acquired_at: T0,
  lease_expires_at: null,
  context_profile: "full",
  parent_work_id: null,
  forked_from_work_id: null,
  forked_from_capsule_version: null,
  // roadmap「入れない物」—— 出てきたら写像の破れ
  external_ref: "gh#1",
  source_thread_id: "thr_1",
  priority: 3,
  summary: { a: 1 },
  owner_runtime_id: "rt_x",
  handled_runtime_id: "rt_y",
  handled_at: T0,
  preferred_runtime: "claude",
  handoff_note: "note on the work",
  last_heartbeat_at: T0,
  created_at: T0,
  updated_at: T1,
  ...over,
});
const transferRow = (over: Record<string, unknown> = {}) => ({
  id: "wtr_1",
  account_id: "acc_1",
  work_id: "wrk_a",
  from_run: "R1",
  from_epoch: 1,
  reserved_epoch: 2,
  to_runtime_kind: "opencode",
  source_state: "held",
  capsule_version: 2,
  state: "routed",
  reason: null,
  expires_at: T1,
  created_at: T0,
  updated_at: T0,
  ...over,
});

/**
 * account(公開鍵 + 包まれた秘密鍵 + private member 入りの device JWK)+ work 2(A: 2 版と routed の handoff / B: A@v2 の
 * reviewer_blind の枝)。A は freeze 済み = lease.epoch が reserved_epoch(2)で予約 holder(transfer:<id>)が握り、v2 はその名で
 * write_epoch = 2 に写された版(spec §6 の 1〜3 段)
 */
function input(): CapsuleExportInput {
  return {
    exportedAt: new Date(T1),
    exporter: { name: "openroly", version: "0.1.0" },
    secrets: [],
    account: { account_id: "acc_1", agent_id: "agt_1", display_name: "Alice", handle: "alice" },
    accountKey: {
      key_id: "ack_1",
      public_key_jwk: { kty: "EC", crv: "P-256", x: "ax", y: "ay" },
      wraps: [{ kind: "password", wrapped_private_key: "WRAPPED-SECRET-VALUE", kdf: {} }],
    } as CapsuleExportInput["accountKey"],
    devices: [{ id: "dev_1", device_name: "mac", public_key_jwk: { kty: "EC", crv: "P-256", x: "dx", y: "dy", d: "PRIVATE-D-VALUE" } }],
    works: [
      {
        work: workRow("wrk_a", { lease_epoch: 2, lease_holder_run: transferHolderId("wtr_1") }),
        capsules: [capsule("wrk_a", 1, 1, B1), capsule("wrk_a", 2, 2, B2, transferHolderId("wtr_1"))],
        transfers: [transferRow()],
      },
      {
        work: workRow("wrk_b", { context_profile: "reviewer_blind", forked_from_work_id: "wrk_a", forked_from_capsule_version: 2, lease_epoch: 0, lease_holder_run: null, lease_acquired_at: null }),
        capsules: [capsule("wrk_b", 1, 0, B2, null)],
        transfers: [],
      },
    ],
  };
}

const enc = new TextEncoder();
function exported(i: CapsuleExportInput): Record<string, string> {
  const r = buildCapsuleFiles(i);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.files;
}
function read(files: Record<string, string>): PaapCapsule {
  const v = validateCapsule(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, enc.encode(t)])));
  if (!v.ok) throw new Error(`${v.reason} ${v.path}${v.at}`);
  return v.capsule;
}
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}
function hasNull(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === "object") return Object.values(v as object).some(hasNull);
  return false;
}

describe("buildCapsuleFiles(PBI-0553)", () => {
  test("AC-1: spec の layout で validateCapsule が ok・reenter は checkpoint の NAME の和集合", () => {
    const files = exported(input());
    expect(Object.keys(files)).toEqual([
      "identity.json",
      "manifest.json",
      "works/wrk_a/checkpoints/1.json",
      "works/wrk_a/checkpoints/2.json",
      "works/wrk_a/handoffs/wtr_1.json",
      "works/wrk_a/work.json",
      "works/wrk_b/checkpoints/1.json",
      "works/wrk_b/work.json",
    ]);
    const c = read(files);
    expect(c.manifest.reenter).toEqual({ credential_refs: ["FLY_API_TOKEN", "GITHUB_TOKEN"], devices: 1 });
    expect(c.works[0]!.checkpoints[1]!.body.failed_attempts).toEqual(["writing in place left a partial dir"]);
    for (const text of Object.values(files)) expect(hasNull(JSON.parse(text))).toBe(false); // spec §2: optional は省く
  });

  test("AC-3: 入れない物の key が 0・中立名(profile / forked_from / to_runtime / checkpoint_version)で出る", () => {
    const files = exported(input());
    const keys = new Set([...Object.values(files)].flatMap((t) => [...keysDeep(JSON.parse(t))]));
    for (const k of [
      "owner_runtime_id", "handled_runtime_id", "handled_at", "preferred_runtime", "handoff_note", "source_thread_id",
      "external_ref", "priority", "summary", "last_heartbeat_at", "payload_hash", "size", "mode", "refs",
      "context_profile", "forked_from_work_id", "to_runtime_kind", "capsule_version", "account_id_of_row",
    ]) {
      expect([k, keys.has(k)]).toEqual([k, false]);
    }
    const b = JSON.parse(files["works/wrk_b/work.json"]!);
    expect(b.profile).toBe("reviewer_blind");
    expect(b.forked_from).toEqual({ work_id: "wrk_a", checkpoint_version: 2 });
    // I-12: 枝の v1 は fork 元の版を指す。元の work の版には based_on を付けない
    expect(JSON.parse(files["works/wrk_b/checkpoints/1.json"]!).based_on).toEqual({ work_id: "wrk_a", version: 2 });
    expect(JSON.parse(files["works/wrk_a/checkpoints/1.json"]!).based_on).toBeUndefined();
    expect(JSON.parse(files["works/wrk_a/handoffs/wtr_1.json"]!)).toMatchObject({ to_runtime: "opencode", checkpoint_version: 2 });
    // spec §6 freeze「no run holds it」: 予約 holder(transfer:<id>)は run ではないので lease.holder_run / run_id に出さない
    expect(JSON.parse(files["works/wrk_a/work.json"]!).lease).toEqual({ epoch: 2, acquired_at: T0 });
    expect(JSON.parse(files["works/wrk_a/checkpoints/2.json"]!).run_id).toBeUndefined();
    expect(JSON.parse(files["works/wrk_a/checkpoints/1.json"]!).run_id).toBe("R1");
  });

  test("I-8: reviewer_blind の枝は allowlist の field だけで hash を取り直す(CAS には全 field が在る)", () => {
    const cp = read(exported(input())).works[1]!.checkpoints[0]!;
    expect(Object.keys(cp.body).sort()).toEqual(["capability_requirements", "goal"]);
    expect(cp.content_hash).not.toBe(hashCapsuleBody(B2));
  });

  test("AC-X1: 包まれた秘密鍵・JWK の private member は key も値も 0", () => {
    const files = exported(input());
    const all = Object.values(files).join("\n");
    expect(all).not.toContain("WRAPPED-SECRET-VALUE");
    expect(all).not.toContain("PRIVATE-D-VALUE");
    const keys = new Set([...Object.values(files)].flatMap((t) => [...keysDeep(JSON.parse(t))]));
    for (const k of ["d", "wraps", "wrapped_private_key", "token", "refresh_token", "password", "api_key", "secret"]) {
      expect([k, keys.has(k)]).toEqual([k, false]);
    }
  });

  test("AC-X2: 本文がこの端末に無い版は全件を列挙して files を返さない", () => {
    const i = input();
    i.works[0]!.capsules[1]!.payload = null;
    i.works[1]!.capsules[0]!.payload = null;
    expect(buildCapsuleFiles(i)).toEqual({
      ok: false,
      problems: [
        { reason: "payload_missing", work_id: "wrk_a", version: 2 },
        { reason: "payload_missing", work_id: "wrk_b", version: 1 },
      ],
    });
  });

  test("AC-X2: CAS の本文が manifest の hash と違う版は payload_mismatch(書き換わった本文をその版として出さない)", () => {
    const i = input();
    i.works[0]!.capsules[0]!.payload = { goal: "tampered" };
    expect(buildCapsuleFiles(i)).toEqual({ ok: false, problems: [{ reason: "payload_mismatch", work_id: "wrk_a", version: 1 }] });
  });

  test("file 名になる id に / や .. を含む行は invalid_id(capsule の外へ書かせない)", () => {
    const i = input();
    i.works[1]!.work.id = "../escape";
    i.works[0]!.transfers[0]!.id = "wtr/../../x";
    const r = buildCapsuleFiles(i);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((p) => p.reason)).toEqual(["invalid_id", "invalid_id"]);
  });
});

describe("verifyContinuation(PBI-0553 AC-4 / AC-X3)", () => {
  /** A = routed の時点 / B = opencode(R2)が commit して lease.epoch = reserved_epoch + 1 = 3 を取り、v3 をその epoch で積んだ後 */
  function after(over: { transfer?: Record<string, unknown>; v3?: number | null; dropB?: boolean } = {}) {
    const i = input();
    i.exportedAt = new Date("2026-09-14T06:10:00.000Z");
    const a = i.works[0]!;
    a.work = workRow("wrk_a", { lease_epoch: 3, lease_holder_run: "R2" });
    a.transfers = [transferRow({ state: "committed", ...over.transfer })];
    if (over.v3 !== null) a.capsules.push(capsule("wrk_a", 3, over.v3 ?? 3, B3, "R2"));
    if (over.dropB) i.works.pop();
    return read(exported(i));
  }
  const prev = () => read(exported(input()));

  test("AC-4: committed・v3 の write_epoch = reserved_epoch + 1・元の版が全部残る → ok", () => {
    expect(verifyContinuation(prev(), after())).toEqual({ ok: true, continued: [{ work_id: "wrk_a", handoff_id: "wtr_1", version: 3 }] });
  });

  test("AC-X3①: 続きの版の write_epoch ≠ reserved_epoch + 1(予約の epoch のまま書いた)→ continuation_epoch_mismatch", () => {
    expect(verifyContinuation(prev(), after({ v3: 2 }))).toEqual({ ok: false, reason: "continuation_epoch_mismatch", path: "works/wrk_a/checkpoints/3.json" });
  });

  test("AC-X3②: A の checkpoint が B で消えた → checkpoint_lost", () => {
    expect(verifyContinuation(prev(), after({ dropB: true }))).toEqual({ ok: false, reason: "checkpoint_lost", path: "works/wrk_b/checkpoints/1.json" });
  });

  test("AC-X3③: handoff が committed でない(failed のまま)→ handoff_not_committed", () => {
    // failed なら lease は予約のまま(epoch 2・holder 無し)で、続きの版も無い
    const i = input();
    i.works[0]!.transfers = [transferRow({ state: "failed", reason: "commit_timeout" })];
    i.works[0]!.work = workRow("wrk_a", { lease_epoch: 2, lease_holder_run: null, lease_acquired_at: null });
    expect(verifyContinuation(prev(), read(exported(i)))).toEqual({
      ok: false,
      reason: "handoff_not_committed",
      path: "works/wrk_a/handoffs/wtr_1.json",
    });
  });

  test("続きの版が無い → no_continuation_checkpoint / 続ける handoff が無い → no_routed_handoff / 別 account → identity_mismatch", () => {
    expect(verifyContinuation(prev(), after({ v3: null }))).toEqual({
      ok: false,
      reason: "no_continuation_checkpoint",
      path: "works/wrk_a/checkpoints/3.json",
    });
    const b = after();
    expect(verifyContinuation(b, b)).toEqual({ ok: false, reason: "no_routed_handoff", path: "manifest.json" });
    const other = after();
    other.identity = { ...other.identity, account_id: "acc_2" };
    expect(verifyContinuation(prev(), other)).toEqual({ ok: false, reason: "identity_mismatch", path: "identity.json" });
  });
});

// ---------- PBI-0626: server が送ってこなかった必須欄を名指す ----------
// 素の `String(v)` は欠落で例外を投げず文字列 "undefined" を作るので、「server が送らなかった」が
// 「壊れた値を書いた」に化けて、判定が capsule を書き終えた後の schema 検査まで遅れていた。
// **実データに依存しない** —— 本番 server(PBI-0467 より前 = owner を持たない)の応答の形を fixture で作る。

describe("PBI-0626 必須欄の欠落を problems で名指す", () => {
  /** 1 work だけの最小の入力(欄を 1 つ落とせる) */
  const oneWork = (over: Record<string, unknown>): CapsuleExportInput => ({
    ...input(),
    works: [{ work: workRow("wrk_a", over), capsules: [capsule("wrk_a", 1, 1, B1)], transfers: [] }],
  });
  const problemsOf = (i: CapsuleExportInput) => {
    const r = buildCapsuleFiles(i);
    return r.ok ? [] : r.problems;
  };

  test("AC-1: owner を送ってこない server(本番の形)は missing_field + 欄名で落ちる", () => {
    const problems = problemsOf(oneWork({ owner: undefined }));
    expect(problems).toEqual([{ reason: "missing_field", work_id: "wrk_a", field: "owner" }]);
  });

  test('AC-1b: 落ちるので "undefined" を書いた file は 1 つも作られない', () => {
    const r = buildCapsuleFiles(oneWork({ owner: undefined }));
    expect(r.ok).toBe(false);
    // 直す前はここが ok:true で、work.json に "owner": "undefined" が入っていた
    expect(JSON.stringify(r)).not.toContain('"undefined"');
  });

  test("AC-X1 境界: null / 空文字も欠落として扱う(present と同じ定義)", () => {
    for (const bad of [null, "", undefined]) {
      expect(problemsOf(oneWork({ owner: bad }))).toEqual([
        { reason: "missing_field", work_id: "wrk_a", field: "owner" },
      ]);
    }
  });

  test("AC-X2 別 actor: 在るが型が違う値(123)は missing_field にしない —— 在る値の正しさは schema の持ち場", () => {
    expect(problemsOf(oneWork({ owner: 123 }))).toEqual([]);
    // 越権しない代わりに、schema が確実に捕まえる事まで見る(見逃しにしない)
    const r = buildCapsuleFiles(oneWork({ owner: 123 }));
    if (!r.ok) throw new Error("should map");
    const v = validateCapsule(Object.fromEntries(Object.entries(r.files).map(([p, t]) => [p, enc.encode(t)])));
    expect(v.ok).toBe(false);
  });

  test("AC-X3 失敗経路: owner 以外の必須欄も同じ門を通る(owner だけ直して終わりにしない)", () => {
    for (const [key, field] of [
      ["title", "title"],
      ["status", "status"],
      ["visibility", "visibility"],
      ["lease_epoch", "lease.epoch"],
      ["created_at", "created_at"],
      ["updated_at", "updated_at"],
    ] as const) {
      expect(problemsOf(oneWork({ [key]: undefined }))).toEqual([
        { reason: "missing_field", work_id: "wrk_a", field },
      ]);
    }
  });

  test("AC-X4 並行: 1 つの work で 2 欄が同時に欠けたら problem は 2 件(最初の 1 件で打ち切らない)", () => {
    expect(problemsOf(oneWork({ owner: undefined, title: undefined }))).toEqual([
      { reason: "missing_field", work_id: "wrk_a", field: "owner" },
      { reason: "missing_field", work_id: "wrk_a", field: "title" },
    ]);
  });

  test("AC-5: 揃っている行(今の server の形)は今までどおり通る", () => {
    expect(problemsOf(oneWork({}))).toEqual([]);
    expect(read(exported(input())).works.length).toBe(2);
  });
});
