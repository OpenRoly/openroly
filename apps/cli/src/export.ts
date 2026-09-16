// PBI-0553 / CAP-15 Z1・CAP-10 T1: `openroly export` と `openroly capsule verify` の I/O。
// 写像は core の buildCapsuleFiles、1 つの capsule の判定は core の validateCapsule、2 つの間(L3)は verifyContinuation ——
// ここは API を読む・CAS を読む・directory を書く/読む だけ。server に route は足さない(既存の GET だけ)。

import { apiCall, loadCredentials, readCasPayload } from "@openroly/adapter";
import { buildCapsuleFiles, isValidCasHash, protocol, verifyContinuation, type CapsuleBody, type CapsuleExportInput } from "@openroly/core";
import { validateCapsuleDir } from "@openroly/core/node";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

type Row = Record<string, unknown>;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : undefined;
}

function ng(message: string, code = 1): number {
  console.error(message);
  return code;
}

export async function runExport(args: readonly string[], baseUrl: string | undefined): Promise<number> {
  const creds = await loadCredentials();
  const cred = creds.runtimes.claude ?? Object.values(creds.runtimes)[0];
  if (!cred) return ng("NG not paired yet. Run 'openroly login' first");
  const url = (baseUrl ?? cred.base_url).replace(/\/$/, "");
  const get = (path: string) => apiCall(url, path, { token: cred.token });
  const httpNg = (what: string, status: number, body: unknown) =>
    ng(`NG ${what}: ${(body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP ${status}`}`);

  const me = await get("/v1/whoami");
  if (me.status !== 200) return httpNg("whoami", me.status, me.body);
  const account = me.body as CapsuleExportInput["account"];
  const out = resolve(flag(args, "--out") ?? `${account.handle}.capsule`);
  if (existsSync(out)) return ng(`NG ${out} already exists — export never overwrites; pass another --out`);

  // runtime credential は 403 human_only、鍵が未作成なら 404 —— どちらも account の公開鍵を省いて続ける(spec で optional)
  const key = await get("/v1/me/account-key");
  if (![200, 403, 404].includes(key.status)) return httpNg("account-key", key.status, key.body);
  const devices = await get("/v1/devices");
  if (devices.status !== 200) return httpNg("devices", devices.status, devices.body);
  const list = await get("/v1/works");
  if (list.status !== 200) return httpNg("works", list.status, list.body);

  const works: CapsuleExportInput["works"] = [];
  for (const listed of list.body as Row[]) {
    const path = `/v1/works/${encodeURIComponent(String(listed.id))}`;
    // 読む順 = transfers → capsules → work 行。途中で handoff が進んでも、handoff が指す版は capsules に在り(I-7)、
    // lease.epoch は committed の reserved_epoch 以上になる(I-5)—— epoch と版は減らないので、後に読んだ方が必ず追いついている
    const transfers = await get(`${path}/transfers`);
    if (transfers.status !== 200) return httpNg(`${listed.id} transfers`, transfers.status, transfers.body);
    const capsules = await get(`${path}/capsules`);
    if (capsules.status !== 200) return httpNg(`${listed.id} capsules`, capsules.status, capsules.body);
    const work = await get(path);
    if (work.status !== 200) return httpNg(String(listed.id), work.status, work.body);
    works.push({
      work: work.body as Row,
      transfers: transfers.body as Row[],
      capsules: await Promise.all(
        (capsules.body as Row[]).map(async (row) => {
          const hash = (row.body as { payload_hash?: unknown } | null)?.payload_hash;
          // 壊れた CAS file(JSON で無い・読めない)も「この端末に本文が無い」と同じ扱い
          const payload =
            typeof hash === "string" && isValidCasHash(hash) ? await readCasPayload(hash).catch(() => null) : null;
          return { row, payload: payload as CapsuleBody | null };
        }),
      ),
    });
  }

  const result = buildCapsuleFiles({
    exportedAt: new Date(),
    exporter: { name: "openroly", version: pkg.version },
    account,
    accountKey: key.status === 200 ? (key.body as CapsuleExportInput["accountKey"]) : null,
    devices: devices.body as CapsuleExportInput["devices"],
    works,
    secrets: Object.values(creds.runtimes).map((r) => r.token),
  });
  if (!result.ok) {
    for (const p of result.problems) {
      const where = `${p.work_id}${p.version !== undefined ? `@v${p.version}` : ""}`;
      console.error(`NG ${p.reason}: ${p.field ? `${p.field} on ${where}` : where}`);
    }
    // PBI-0626: **同じ欄が全部の work で欠けていたら、それは 1 件ずつのデータ異常ではなく server の版**。
    // 「送られてこなかった欄」から読むのは、version を名乗る口を持たないほど古い server にも効くから
    // (問い合わせたい相手が、その口を持たない当人である)
    const missing = result.problems.filter((p) => p.reason === "missing_field");
    for (const field of new Set(missing.map((p) => p.field))) {
      if (new Set(missing.filter((p) => p.field === field).map((p) => p.work_id)).size === works.length) {
        console.error(
          `NG the server at ${url} never sent "${field}" — for any of the ${works.length} work${works.length === 1 ? "" : "s"}.` +
            ` It is older than this CLI, so it cannot produce a ${protocol.PAAP_VERSION} capsule. Update the server and export again.`,
        );
      }
    }
    return 1;
  }

  // 部分的な dir を残さない: 隣の tmp に全部書いて core の判定を通してから rename 1 回
  const tmp = join(dirname(out), `.${basename(out)}.partial-${process.pid}`);
  try {
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    for (const [path, text] of Object.entries(result.files)) {
      const file = join(tmp, ...path.split("/"));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, text, { mode: 0o600, flag: "wx" });
    }
    const verdict = validateCapsuleDir(tmp);
    if (!verdict.ok) return ng(`NG the export does not verify (${verdict.reason}: ${verdict.path}${verdict.at}) — nothing was written`);
    await rename(tmp, out);
    const s = protocol.summarizeCapsule(verdict.capsule);
    const count = (dir: string) => Object.keys(result.files).filter((p) => p.split("/")[2] === dir).length;
    console.log(`OK exported ${s.handle} → ${out}`);
    console.log(
      `  ${verdict.capsule.works.length} works · ${count("checkpoints")} checkpoints · ${count("handoffs")} handoffs` +
        ` · re-enter: ${s.reenter.credential_refs.length} credential refs${s.reenter.credential_refs.length ? ` (${s.reenter.credential_refs.join(", ")})` : ""}, ${s.reenter.devices} devices`,
    );
    return 0;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function runCapsule(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const dir = args[1];
  if (args[0] !== "verify" || !dir || dir.startsWith("--")) {
    return ng("Usage: openroly capsule verify <dir> [--continued-from <dir>] [--json]", 2);
  }
  const from = flag(args, "--continued-from");
  if (args.includes("--continued-from") && !from) return ng("--continued-from takes a capsule directory", 2);

  const fail = (at: string, reason: string, path: string, where = ""): number => {
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, dir: at, reason, path })}\n`);
    else console.error(`NG ${reason}: ${join(at, path)}${where}`);
    return 1;
  };
  const load = (d: string) => {
    try {
      return validateCapsuleDir(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw e;
    }
  };

  const next = load(dir);
  if (next === null) return ng(`NG not a directory: ${dir}`, 2);
  if (!next.ok) return fail(dir, next.reason, next.path, next.at);
  let continued: { work_id: string; handoff_id: string; version: number }[] | undefined;
  if (from) {
    const prev = load(from);
    if (prev === null) return ng(`NG not a directory: ${from}`, 2);
    if (!prev.ok) return fail(from, prev.reason, prev.path, prev.at);
    const v = verifyContinuation(prev.capsule, next.capsule);
    if (!v.ok) return fail(dir, v.reason, v.path);
    continued = v.continued;
  }
  const summary = protocol.summarizeCapsule(next.capsule);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, dir, summary, ...(continued ? { continued } : {}) })}\n`);
    return 0;
  }
  console.log(`OK ${dir}: ${summary.protocol} capsule of ${summary.handle ?? summary.display_name} (${next.capsule.works.length} works)`);
  for (const c of continued ?? []) {
    console.log(`  continues ${from}: ${c.work_id} v${c.version} after handoff ${c.handoff_id}`);
  }
  return 0;
}
