// 外部 API provider の表(PBI-0210 / EP-0017 層 D)。**provider の一覧はここ 1 箇所**で、
// cli(`openroly agent <id>`)・api adapter(`<id>-api` runtime)・server(`API_KEY_PROVIDERS` =
// Connections の API key 型)・web(表示ラベル)・registry(catalog-build の `<id>-api` entry)は
// 全部ここから導出する(4 箇所に散っていた重複を消す = 大きな部品 1 つ)。
//
// `baseUrl` の綴りは **この file 以外に現れない**(diagrams-check が数える)。baseUrl / defaultModel は
// **cutoff(2026-05)の外**なので推測で書かない —— 1 つずつ公式 doc を引いて実測した(出典 URL の一覧は
// backlog/PBI-0210-generic-runtime-adapter.md「provider 表の出典」節)。default model 名はこの先も
// 変わるので `--model` / `OPENROLY_AGENT_MODEL` で上書きできる(既存の型)。
//
// `auth: "none"` は鍵を持たない OpenAI 互換の local 口(Ollama / LM Studio / Jan)。
// `openroly agent` は鍵解決(Connections の ASK)を飛ばして直接叩く。Connections(API key 型)には
// 載せない = server の `API_KEY_PROVIDERS` は `auth: "key"` だけ。

export interface ApiProvider {
  /** `openroly agent <id>` の id。credential kind は `<id>-api`(claude / codex と同じ 1 kind = 1 runtime_id) */
  id: string;
  /** Connections / Your AI に出す表示名 */
  label: string;
  /** OpenAI 互換 `/chat/completions` の base */
  baseUrl: string;
  defaultModel: string;
  auth: "key" | "none";
}

export const API_PROVIDERS: readonly ApiProvider[] = [
  // baseUrl は 2026-09-05 に全件 probe した(`/models` か `/chat/completions` が 401/403/400 を返す =
  // その host+path が実在する。404 は 1 つも無い)。defaultModel は下の出典で 1 つずつ引いた
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.6", auth: "key" },
  {
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.8-flash",
    auth: "key",
  },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5", auth: "key" },
  // OpenRouter の `~<vendor>/<name>-latest` は「最新に解決される alias」= cutoff を越えても腐らない
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "~openai/gpt-latest", auth: "key" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", auth: "key" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-flash", auth: "key" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-medium-latest", auth: "key" },
  { id: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.6", auth: "key" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", auth: "key" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/gpt-oss-120b", auth: "key" },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", defaultModel: "gpt-oss-120b", auth: "key" },
  { id: "moonshot", label: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-latest", auth: "key" },
  // owner が使っているのは Z.AI(国際)。`open.bigmodel.cn` は中国本土の別 endpoint で、owner の鍵は通らない
  { id: "zhipu", label: "Z.AI (GLM)", baseUrl: "https://api.z.ai/api/openrolys/v4", defaultModel: "glm-5.3", auth: "key" },
  { id: "dashscope", label: "DashScope (Qwen)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.7-plus", auth: "key" },
  { id: "perplexity", label: "Perplexity", baseUrl: "https://api.perplexity.ai", defaultModel: "sonar", auth: "key" },
  // local の既定 model は端末が持つ物次第(検知した runtime の `models` が実物を出す)。ここは最後の fallback
  { id: "ollama-local", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.2", auth: "none" },
  { id: "lmstudio-local", label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", defaultModel: "local-model", auth: "none" },
  { id: "jan-local", label: "Jan (local)", baseUrl: "http://127.0.0.1:1337/v1", defaultModel: "local-model", auth: "none" },
];

export const API_PROVIDER_IDS: readonly string[] = API_PROVIDERS.map((p) => p.id);

/** Connections(API key 型)に載せる provider = 鍵を持つ物だけ。server の `API_KEY_PROVIDERS` の正本 */
export const API_KEY_PROVIDER_IDS: readonly string[] = API_PROVIDERS.filter((p) => p.auth === "key").map((p) => p.id);

export function apiProvider(id: string): ApiProvider | undefined {
  return API_PROVIDERS.find((p) => p.id === id);
}

export const isApiProviderId = (id: string): boolean => API_PROVIDER_IDS.includes(id);

/** credential store / device key store / registry entry の id。`openai` → `openai-api` */
export const apiProviderKind = (id: string): string => `${id}-api`;

// ---------- 持ち込みの endpoint(PBI-0276) ----------
//
// こちらが名前を知らない OpenAI 互換の口(omnirouter・自社 proxy・社内 gateway・まだ無い provider)を
// owner が自分で繋ぐ枠。`API_PROVIDERS` は**こちらが調べた表**なので載らない —— 代わりに
// **provider id そのものが名前**になる: `custom-<slug>`。slug は owner が付けた名前を正規化した物で、
// 画面の表示名・CLI の引数(`openroly agent custom-<slug>`)・credential kind(`custom-<slug>-api`)・
// broker の runtime 名が**全部同じ 1 つの文字列**になる(見た目と id がずれる面を作らない)。
//
// 形は狭く固定する —— この文字列は server の provider 列 / CLI の argv / broker の spawn 引数を
// 通るので、**通す形が唯一の門**になる(broker は署名済み registry に custom を載せられない)。

export const CUSTOM_PROVIDER_PREFIX = "custom-";
/** slug = 先頭が英数・以降は英数と `-`・末尾は英数・2〜32 文字 */
const CUSTOM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export const isCustomProviderId = (id: string): boolean =>
  id.startsWith(CUSTOM_PROVIDER_PREFIX) && CUSTOM_SLUG_RE.test(id.slice(CUSTOM_PROVIDER_PREFIX.length));

/** owner が打った名前 → provider id。作れない名前(全部記号・空)は undefined */
export function toCustomProviderId(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return CUSTOM_SLUG_RE.test(slug) ? `${CUSTOM_PROVIDER_PREFIX}${slug}` : undefined;
}

/** 画面と Your AI の表示名。`custom-omnirouter` → `omnirouter (custom)` */
export const customProviderLabel = (id: string): string =>
  `${id.slice(CUSTOM_PROVIDER_PREFIX.length)} (custom)`;

/** `/v1/connections/:provider/resolve` が鍵を載せる env の名前。持ち込みの id(`custom-x`)を
 * env 名として妥当な形に落とす —— 名前付き provider の綴りは変わらない(`openai` → `OPENAI_TOKEN`) */
export const connectionTokenEnvName = (provider: string): string =>
  `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
