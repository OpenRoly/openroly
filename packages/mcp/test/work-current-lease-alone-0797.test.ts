import { afterAll, describe, expect, test } from "bun:test";
import { createAccountTools } from "../src/tools.ts";

// PBI-0797 / dogfood F107: work_current が係(handled_runtime_id)で選んでいた。
// 説明書は "Picked by the lease alone … never read it as 'running now'" と書いている。
// 実測では、1.5 時間書き込んでいる work(係は空欄)を差し置いて 3 日前の task(係は自分)を返していた。

const ME = "rt_me";
const hour = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const work = (id: string, o: Partial<Record<string, unknown>> = {}) => ({
  id,
  title: id,
  status: "todo",
  lease_epoch: 1,
  lease_holder_run: "mcp-claude",
  lease_acquired_at: iso(hour),
  lease_expires_at: null,
  last_heartbeat_at: null,
  handled_runtime_id: null,
  ...o,
});

/** 与えた work 一覧を返す stub。events は空(continue_candidate を立てない) */
const stubFor = (works: unknown[]) =>
  Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/agents") return Response.json({ me: { runtime_id: ME }, runtimes: [{ id: ME, kind: "claude" }] });
      if (path === "/v1/works") return Response.json(works);
      if (/^\/v1\/works\/[^/]+\/events$/.test(path)) return Response.json([]);
      return new Response("not found", { status: 404 });
    },
  });

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

const currentOf = async (works: unknown[]) => {
  const s = stubFor(works);
  servers.push(s);
  return (await createAccountTools({ baseUrl: `http://localhost:${s.port}`, token: "t" }).work_current()) as {
    work_id: string;
    ambiguous: boolean;
  } | null;
};

describe("work_current は lease だけで選ぶ(PBI-0797)", () => {
  test("AC-1: 新しい方の係が空欄・古い方の係が自分でも、名乗るのは新しい方", async () => {
    const r = await currentOf([
      work("old_mine", { lease_acquired_at: iso(3 * hour), handled_runtime_id: ME }),
      work("new_unowned", { lease_acquired_at: iso(1 * hour) }),
    ]);
    expect(r?.work_id).toBe("new_unowned");
  });

  test("AC-2: 係が自分の work が唯一 held なら今までどおりそれ", async () => {
    const r = await currentOf([work("only_mine", { handled_runtime_id: ME })]);
    expect(r?.work_id).toBe("only_mine");
  });

  test("AC-3: ambiguous の意味は変えない — 係が自分の held が在れば false、無ければ held>1 で true", async () => {
    const withMine = await currentOf([
      work("old_mine", { lease_acquired_at: iso(3 * hour), handled_runtime_id: ME }),
      work("new_unowned", { lease_acquired_at: iso(1 * hour) }),
    ]);
    expect(withMine?.ambiguous).toBe(false);
    const noneMine = await currentOf([
      work("a", { lease_acquired_at: iso(3 * hour) }),
      work("b", { lease_acquired_at: iso(1 * hour) }),
    ]);
    expect(noneMine?.ambiguous).toBe(true);
    expect(noneMine?.work_id).toBe("b");
  });

  test("AC-4: done と期限切れ lease は候補に入らない", async () => {
    const r = await currentOf([
      work("newest_done", { lease_acquired_at: iso(1000), status: "done" }),
      work("newest_expired", { lease_acquired_at: iso(2000), lease_expires_at: iso(1000) }),
      work("alive", { lease_acquired_at: iso(2 * hour) }),
    ]);
    expect(r?.work_id).toBe("alive");
  });
});
