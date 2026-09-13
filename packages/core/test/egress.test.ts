// PBI-0441 ③: 「床」と「床より上げた runtime の表」の合流を 1 箇所で固める。
// 面(doctor / Your AI / activity)は全部この 3 関数を通るので、ここが嘘をつくと 3 面が同時に嘘になる。
import { describe, expect, test } from "bun:test";
import {
  effectiveEgressEnforcement,
  egressEnforcementShort,
  egressScopeText,
  parseEgressByRuntime,
} from "../src/egress.ts";

describe("per-runtime の egress(PBI-0441 ③)", () => {
  test("表は形の正しい key と知っている値だけを通す(host_scoped と推測しない)", () => {
    expect(parseEgressByRuntime({ claude: "host_scoped" })).toEqual({ claude: "host_scoped" });
    // 知らない値は落とす —— 残すと「閉じている」と読める値が表に載る
    expect(parseEgressByRuntime({ claude: "wide_open" })).toEqual({});
    expect(parseEgressByRuntime({ claude: null })).toEqual({});
    // 形の壊れた key は落とす(broker が送ってきた任意の文字列を表示面に通さない)
    expect(parseEgressByRuntime({ "../etc": "host_scoped" })).toEqual({});
    expect(parseEgressByRuntime({ "Claude Code": "host_scoped" })).toEqual({});
    expect(parseEgressByRuntime({ "": "host_scoped" })).toEqual({});
    // object でない物・配列・欠落は空
    for (const v of [null, undefined, 1, "x", ["claude"], true]) expect(parseEgressByRuntime(v)).toEqual({});
    // 膨張を止める(上限 64)
    const many = Object.fromEntries([...Array(200)].map((_, i) => [`r${i}`, "host_scoped"]));
    expect(Object.keys(parseEgressByRuntime(many)).length).toBe(64);
  });

  test("効く値は「表に在ればそれ・無ければ床」", () => {
    const by = { claude: "host_scoped" } as const;
    expect(effectiveEgressEnforcement("claude", "port_scoped", by)).toBe("host_scoped");
    // 表に無い runtime は床のまま(codex を claude の値で名乗らない)
    expect(effectiveEgressEnforcement("codex", "port_scoped", by)).toBe("port_scoped");
    // runtime 不明 / 表なしは床
    expect(effectiveEgressEnforcement(null, "port_scoped", by)).toBe("port_scoped");
    expect(effectiveEgressEnforcement("claude", "port_scoped", {})).toBe("port_scoped");
    expect(effectiveEgressEnforcement("claude", null, undefined)).toBeNull();
    // prototype の key を拾わない(`toString` を runtime 名として渡されても表の値にしない)
    expect(effectiveEgressEnforcement("toString", "port_scoped", by)).toBe("port_scoped");
  });

  test("端末の 1 行は床の文に、床と違う runtime を名指しで添える", () => {
    // 表が空 = 今までどおり床の文だけ
    expect(egressScopeText("port_scoped", {})).toBe(
      "port-scoped (a process inside can reach any host on the proxy's port)",
    );
    // claude だけ閉じた端末: 床を偽らず、閉じている事も黙らない
    expect(egressScopeText("port_scoped", { claude: "host_scoped" })).toBe(
      "port-scoped (a process inside can reach any host on the proxy's port) — host-scoped for: claude",
    );
    // 床と同じ値は添えない(同じ事を 2 回言わない)
    expect(egressScopeText("port_scoped", { claude: "port_scoped" })).not.toContain("for:");
    // 並びは決定的(tab ごとに揺れない)
    expect(egressScopeText("port_scoped", { zed: "host_scoped", claude: "host_scoped" })).toContain(
      "host-scoped for: claude, zed",
    );
    // 名乗らない broker は unknown のまま(表だけ在っても床を推測しない)
    expect(egressScopeText(null, {})).toMatch(/^unknown/);
  });

  test("短い呼び名", () => {
    expect(egressEnforcementShort("host_scoped")).toBe("host-scoped");
    expect(egressEnforcementShort("port_scoped")).toBe("port-scoped");
    expect(egressEnforcementShort("none")).toBe("none");
    expect(egressEnforcementShort(null)).toBe("unknown");
  });
});
