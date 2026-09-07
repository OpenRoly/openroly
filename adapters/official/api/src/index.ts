import {
  getCredential,
  STAGE0_CAPABILITIES,
  type AdapterContext,
  type DetectResult,
  type ExportedExtension,
  type ExtensionApplyAction,
  type ExtensionListing,
  type Finding,
  type RuntimeAdapter,
} from "@openroly/adapter";
import { API_PROVIDERS, apiProviderKind } from "@openroly/core";

// 外部 API provider 用の official adapter(PBI-0070 / EP-0009 C)。
//
// 他の adapter と違い **native の設定ファイルを 1 つも持たない** —— この runtime の実体は
// 端末側の `openroly agent <provider>`(PBI-0057)で、MCP server を登録する相手の CLI が存在しない。
// それでも adapter を置くのは、自動登録(図18)が kind ごとに `openroly adopt` → `adapter.register` を
// 通す 1 本道だからで、ここに no-op の実装を置くことで「API runtime だけ登録経路が別」という
// 2 本目の道を作らずに済む。
//
// provider は同じ手順で、違うのは id と表示名だけ —— factory 1 つで全部作る(部品を N 枚書かない)。
// **一覧は `@openroly/core` の `API_PROVIDERS` から導出する**(PBI-0210。cli / server / web / registry と同じ正本)。

export function apiProviderAdapter(provider: string, displayName: string): RuntimeAdapter {
  const id = apiProviderKind(provider);
  return {
    id,
    displayName,
    // wake は broker(launch_api)が担う。adapter 自身は pair / status だけ(他の official と同じ宣言)
    capabilities: STAGE0_CAPABILITIES,

    // 端末に binary は無い。registry 側の `detect.always` と同じ理由で常に present
    async detect(): Promise<DetectResult> {
      return { installed: true, detail: `${displayName} is always available as a local runtime (openroly agent)` };
    },

    // 書くものが無い。credential は engine(install/adopt)が credentials.json へ保存済み
    async register(): Promise<void> {},
    async unregister(): Promise<void> {},

    async doctor(ctx: AdapterContext): Promise<Finding[]> {
      const credential = await getCredential(id, ctx.env);
      return [
        {
          ok: credential != null,
          label: `${displayName} connection`,
          detail: credential
            ? `credential present (${credential.base_url}). The API key is resolved from Connections`
            : "not connected. Run 'openroly login' to connect this machine",
        },
      ];
    },

    // MCP server を持たないので extension の materialize 対象にならない
    extensionKinds: [],
    async listExtensions(): Promise<ExtensionListing[]> {
      return [];
    },
    // native config を持たないので吸い上げる物も無い(PBI-0212)
    async exportExtensions(): Promise<ExportedExtension[]> {
      return [];
    },
    // 端末に config file が無い = 見張る場所も無い(PBI-0213)
    watchPaths(): string[] {
      return [];
    },
    async applyExtension(_ctx: AdapterContext, _action: ExtensionApplyAction): Promise<void> {},
  };
}

export const apiAdapters: RuntimeAdapter[] = API_PROVIDERS.map((p) =>
  apiProviderAdapter(p.id, `${p.label} (API)`),
);
