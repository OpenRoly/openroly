// Account API への最小 client。engine が使うのは pairing / whoami / inbox metadata だけで、
// runtime 向けの §16 contract は packages/mcp が持つ(依存の向きは mcp → adapter)。

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function apiCall<T = any>(
  baseUrl: string,
  path: string,
  init: { token?: string; method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    // 呼び手が待つ上限を持てるようにする(PBI-0234: 接続報告の whoami)。
    // 渡さなければ従来どおり無制限
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => null)) as T;
  return { status: res.status, body };
}
