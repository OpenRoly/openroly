import { describe, expect, test } from "bun:test";
import {
  planReconciliation,
  validateExtensionSpec,
  type DesiredExtension,
  type MaterializationState,
} from "../src/extension.ts";

// AC-5,6,7,8,9,10: planReconciliation の判定順序(図8)。
// AC-3/AC-4 の secret 拒否ロジックそのもの(validateExtensionSpec)も純関数として直接検査する。

const github: DesiredExtension = {
  id: "ext_github",
  kind: "mcp",
  name: "github",
  spec: { command: "npx", args: ["-y", "gh-mcp"] },
  credentialRef: null,
  enabled: true,
  revision: 1,
  deletedAt: null,
};

describe("planReconciliation(図8 の判定順序)", () => {
  test("AC-5: 未対応 kind ではない・native に無い desired は install", () => {
    const plan = planReconciliation({
      desired: [github],
      materialized: [],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(plan).toMatchObject([{ action: "install", name: "github" }]);
  });

  test("AC-6: kind が supportedKinds に無ければ unsupported。native は触らない前提の action しか出ない", () => {
    const plugin: DesiredExtension = { ...github, id: "ext_plugin", kind: "plugin", name: "figma" };
    const plan = planReconciliation({
      desired: [plugin],
      materialized: [],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(plan).toMatchObject([
      { action: "unsupported", name: "figma", kind: "plugin" },
    ]);
  });

  test("AC-16: unsupported を既に報告済みなら再送しない(noop) — 送ると updated_at が無意味に更新される", () => {
    const plugin: DesiredExtension = { ...github, id: "ext_plugin", kind: "plugin", name: "figma" };
    const secondSync = planReconciliation({
      desired: [plugin],
      materialized: [{ extensionId: "ext_plugin", status: "unsupported", appliedRevision: null }],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(secondSync).toMatchObject([{ action: "noop", name: "figma" }]);
  });

  test("AC-10: 未対応 kind でも soft delete されたら uninstall(purge 経路)に乗る。無ければ noop", () => {
    const deletedPlugin: DesiredExtension = {
      ...github,
      id: "ext_plugin",
      kind: "plugin",
      name: "figma",
      deletedAt: new Date().toISOString(),
    };
    const withMat = planReconciliation({
      desired: [deletedPlugin],
      materialized: [{ extensionId: "ext_plugin", status: "unsupported", appliedRevision: null }],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(withMat).toMatchObject([{ action: "uninstall", name: "figma" }]);

    const withoutMat = planReconciliation({
      desired: [deletedPlugin],
      materialized: [],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(withoutMat).toMatchObject([{ action: "noop", name: "figma" }]);
  });

  test("AC-7: applied_revision < revision は update", () => {
    const materialized: MaterializationState[] = [
      { extensionId: "ext_github", status: "applied", appliedRevision: 1 },
    ];
    const plan = planReconciliation({
      desired: [{ ...github, revision: 2 }],
      materialized,
      actual: ["github"],
      supportedKinds: ["mcp"],
    });
    expect(plan).toMatchObject([{ action: "update", name: "github", revision: 2 }]);
  });

  test("AC-8: native に有るが desired にも materialization にも無い extension は noop(uninstall しない)", () => {
    const plan = planReconciliation({
      desired: [],
      materialized: [],
      actual: ["openroly", "other"],
      supportedKinds: ["mcp"],
    });
    expect(plan).toHaveLength(2);
    expect(plan.every((a) => a.action === "noop")).toBe(true);
    expect(plan.map((a) => a.name).sort()).toEqual(["openroly", "other"]);
  });

  test("AC-9: enabled=false は disable。既に disabled 記録済みなら noop(冪等性)", () => {
    const disabled: DesiredExtension = { ...github, enabled: false };
    const firstSync = planReconciliation({
      desired: [disabled],
      materialized: [{ extensionId: "ext_github", status: "applied", appliedRevision: 1 }],
      actual: ["github"],
      supportedKinds: ["mcp"],
    });
    expect(firstSync).toMatchObject([{ action: "disable", name: "github" }]);

    const secondSync = planReconciliation({
      desired: [disabled],
      materialized: [{ extensionId: "ext_github", status: "disabled", appliedRevision: null }],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(secondSync).toMatchObject([{ action: "noop", name: "github" }]);
  });

  test("AC-10: deleted かつ materialization 有りは uninstall。materialization 無しは noop", () => {
    const deleted: DesiredExtension = { ...github, deletedAt: new Date().toISOString() };
    const withMat = planReconciliation({
      desired: [deleted],
      materialized: [{ extensionId: "ext_github", status: "applied", appliedRevision: 1 }],
      actual: ["github"],
      supportedKinds: ["mcp"],
    });
    expect(withMat).toMatchObject([{ action: "uninstall", name: "github" }]);

    const withoutMat = planReconciliation({
      desired: [deleted],
      materialized: [],
      actual: [],
      supportedKinds: ["mcp"],
    });
    expect(withoutMat).toMatchObject([{ action: "noop", name: "github" }]);
  });

  test("revision が追いつき済みなら noop(再インストールしない)", () => {
    const plan = planReconciliation({
      desired: [github],
      materialized: [{ extensionId: "ext_github", status: "applied", appliedRevision: 1 }],
      actual: ["github"],
      supportedKinds: ["mcp"],
    });
    expect(plan).toMatchObject([{ action: "noop", name: "github" }]);
  });
});

describe("validateExtensionSpec(AC-3 の判定そのもの)", () => {
  test("生 credential が無ければ ok", () => {
    expect(validateExtensionSpec({ command: "npx", args: ["-y", "gh-mcp"] })).toEqual({ ok: true });
  });

  test("ネストした env.GITHUB_TOKEN も拒否する(AC-3)", () => {
    const result = validateExtensionSpec({
      command: "npx",
      env: { GITHUB_TOKEN: "ghp_realvalue" },
    });
    expect(result).toMatchObject({ ok: false, key: "env.GITHUB_TOKEN" });
  });

  test("api_key / apiKey どちらの表記も拒否する", () => {
    expect(validateExtensionSpec({ env: { api_key: "sk-x" } }).ok).toBe(false);
    expect(validateExtensionSpec({ env: { apiKey: "sk-x" } }).ok).toBe(false);
  });

  test("空文字列は許容する(credential_ref 未解決の placeholder を弾かない)", () => {
    expect(validateExtensionSpec({ env: { GITHUB_TOKEN: "" } })).toEqual({ ok: true });
  });
});
