/** TonAPI v2 — https://docs.tonconsole.com/tonapi/ */

export const TONAPI_BASE_URL = "https://tonapi.io/v2";

/** Optional Bearer token from TonConsole (raises rate limits above anonymous 0.25 rps). */
export function getTonapiAuthHeaders(): HeadersInit {
  const token =
    process.env.EXPO_PUBLIC_TONAPI_KEY?.trim() ||
    process.env.TONAPI_KEY?.trim() ||
    "";
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function tonapiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith("http")
    ? path
    : `${TONAPI_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init?.headers);
  const auth = getTonapiAuthHeaders() as Record<string, string>;
  for (const [key, value] of Object.entries(auth)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers });
}
