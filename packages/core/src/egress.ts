// broker の sandbox backend が名乗る「egress をどこまで絞れているか」(PBI-0441)。
// 値の正本は broker(`broker/src/sandbox.rs` の `egress_enforcement`)。server は hello から写し、
// `openroly doctor` / Your AI / session 開始の activity はここの語で名乗る —— 面ごとに言い方が
// ずれると、どれが本当かを人に迷わせる。

export const EGRESS_ENFORCEMENTS = ["host_scoped", "port_scoped", "none"] as const;
export type EgressEnforcement = (typeof EGRESS_ENFORCEMENTS)[number];

/** 知らない値・欠落(旧 broker)は null。**`host_scoped` と推測しない**(AC-X2) */
export function parseEgressEnforcement(v: unknown): EgressEnforcement | null {
  return (EGRESS_ENFORCEMENTS as readonly unknown[]).includes(v) ? (v as EgressEnforcement) : null;
}

/** floor より上げた runtime だけの表(hello / status file の `egress_enforcement_by_runtime`)。
 *
 * C1(PBI-0441 ③)は **claude だけ**を `host_scoped` に上げられる —— 専用 uid は本人の Keychain を
 * 読めないので、資格情報を渡せる runtime しか閉じられない。だから絞り方は端末単位ではなく
 * **runtime 単位**で決まる。ここに載らない runtime は floor(端末の値)のまま。 */
export type EgressByRuntime = Record<string, EgressEnforcement>;

/** 表の key として通す runtime id の形(broker の registry id と同じ範囲だけ) */
const RUNTIME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 壊れた / 悪意ある broker からの payload 膨張を防ぐ(既存の hello の上限と同じ思想) */
const BY_RUNTIME_MAX = 64;

/** hello / status file の per-runtime 表を写す。知らない値・形の壊れた key は **落とす**
 * (`host_scoped` と推測しない = AC-X2 の per-runtime 版)。 */
export function parseEgressByRuntime(v: unknown): EgressByRuntime {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: EgressByRuntime = {};
  for (const [kind, raw] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= BY_RUNTIME_MAX) break;
    if (!RUNTIME_ID.test(kind)) continue;
    const parsed = parseEgressEnforcement(raw);
    if (parsed !== null) out[kind] = parsed;
  }
  return out;
}

/** **この runtime の session に実際に効く値**。表に在ればそれ、無ければ floor(端末の値)。
 * 合流はここ 1 箇所 —— 面ごとに `?? floor` を書くと、直した面だけ正しくなる(lessons 13)。 */
export function effectiveEgressEnforcement(
  kind: string | null | undefined,
  floor: EgressEnforcement | null,
  by: EgressByRuntime | null | undefined,
): EgressEnforcement | null {
  if (kind && by && Object.hasOwn(by, kind)) return by[kind]!;
  return floor;
}

/** 値の短い呼び名(1 行に並べる時に使う。文は `egressEnforcementText`) */
export function egressEnforcementShort(v: EgressEnforcement | null): string {
  return v === null ? "unknown" : v === "host_scoped" ? "host-scoped" : v === "port_scoped" ? "port-scoped" : "none";
}

/** 端末の 1 行。floor の文に、**floor と違う runtime を名指しで添える** ——
 * 「claude だけ閉じている」端末で port-scoped とだけ言うと、閉じている事を黙る事になり、
 * host-scoped とだけ言うと codex について嘘になる(この PBI が殺そうとしている嘘そのもの)。 */
export function egressScopeText(floor: EgressEnforcement | null, by: EgressByRuntime | null | undefined): string {
  const base = egressEnforcementText(floor);
  const raised = Object.entries(by ?? {}).filter(([, v]) => v !== floor);
  if (raised.length === 0) return base;
  // 値ごとに束ねる(runtime が増えても 1 行に収まる)。並びは決定的に —— 表示が tab ごとに揺れない
  const byValue = new Map<EgressEnforcement, string[]>();
  for (const [kind, v] of raised.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byValue.set(v, [...(byValue.get(v) ?? []), kind]);
  }
  const notes = [...byValue.entries()].map(([v, kinds]) => `${egressEnforcementShort(v)} for: ${kinds.join(", ")}`);
  return `${base} — ${notes.join("; ")}`;
}

/** `egress: <この文>` の文。null = 名乗っていない broker */
export function egressEnforcementText(v: EgressEnforcement | null): string {
  switch (v) {
    case "host_scoped":
      return "host-scoped (a process inside can reach only the proxy)";
    case "port_scoped":
      return "port-scoped (a process inside can reach any host on the proxy's port)";
    case "none":
      return "none (no sandbox, so dedicated sessions are refused)";
    case null:
      return "unknown (the broker does not report it; update the broker)";
  }
}
