import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADAPTER_OPS } from "../src/contract.ts";

// PBI-0451: 公開 spec の interface block が contract.ts の op を欠いていた(exportExtensions / watchPaths)。
// 見るのは識別子の実在だけ —— 型の綴りは pin しない
test("specs/extension-adapter-contract.md の ExtensionAdapter block は ADAPTER_OPS を全部名乗る", () => {
  const spec = readFileSync(new URL("../../../specs/extension-adapter-contract.md", import.meta.url), "utf8");
  const block = spec.match(/interface ExtensionAdapter \{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(block).not.toBe("");
  expect(ADAPTER_OPS.filter((op) => !new RegExp(`^\\s*${op}\\b`, "m").test(block))).toEqual([]);
});
