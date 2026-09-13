# third_party/ — 上流の写し

**ここは編集しない。** 各 file の先頭 3 行が取得元 URL / 取得日 / commit sha を持ち、
それを除いた本文は上流と **1 byte も違わない**。

「編集しない」は README に書くだけでは守れないので、`scripts/provenance-check.sh` が
**header 3 行を除いた本文の git blob sha を上流の blob sha と突き合わせる**（PBI-0401 の攻撃①）。
手で 1 文字直すと NG になる。

## 更新する（取り直す）

`third_party/<upstream>/` の下は **上流の path をそのまま写している**ので、取り直しは 1:1 に対応する:

```sh
# 例: openclaw の bootstrap-budget.ts
gh api repos/openclaw/openclaw/contents/src/agents/bootstrap-budget.ts --jq .content | base64 -d
```

取り直したら header 3 行を付け直し、`scripts/provenance-check.sh` の中の期待 blob sha も同じ commit で更新する
（sha を直さずに本文だけ差し替えると NG のまま = 「上流が動いた」が可視化される）。

## 借りている物

| 上流 | 写した path | 使う所 |
|---|---|---|
| `openclaw` `packages/workboard-contract/src/index.ts` | `openclaw/packages/workboard-contract/src/index.ts` | `packages/core/src/work.ts` が値集合 4 本を **derive**（手で写さない） |
| `openclaw` `src/agents/bootstrap-budget.ts` | `openclaw/src/agents/bootstrap-budget.ts` | `packages/core/test/context.test.ts` が `analyzeBootstrapBudget` を**実際に呼んで** `analyzeContextBudget` と比べる |
| `openclaw` `src/agents/bootstrap-budget.types.ts` | `openclaw/src/agents/bootstrap-budget.types.ts` | 上の返り値の型 |

license は MIT。本文と copyright は `THIRD_PARTY_NOTICES.md` の OpenClaw 節。

## stub（**写しではない**）

`bootstrap-budget.ts` を**改変せずに**動かす為だけの最小 file。冒頭に「上流の写しではない」と書いてあり、
blob sha の検査対象でもない。写していない関数は **呼ばれたら throw する**
（no-op にすると、いつか誰かが呼んだ時に上流と違う答えが静かに返る）。

- `openclaw/src/agents/bootstrap-budget-warning.ts`
- `openclaw/src/agents/embedded-agent-helpers.ts` / `openclaw/src/agents/embedded-agent-helpers/bootstrap.ts`
  （`USER_BOOTSTRAP_MAX_CHARS = 4_000` だけは上流の実値。`effectiveBootstrapFileLimit` が実際に読む）
- `openclaw/src/agents/workspace.ts` / `openclaw/src/config/types.openclaw.ts`

`@openclaw/workboard-contract` と `@openclaw/normalization-core` は
**root の workspace member**（`package.json` の `workspaces`）。bare import
（`@openclaw/normalization-core/string-coerce`）が上流 file の中に在り、
tsconfig の `paths` を 2 箇所に書くより workspace 1 本の方が resolver が 1 つで済む。
