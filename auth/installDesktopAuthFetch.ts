import { getDesktopSessionToken } from "./desktopSessionToken";
import { getApiBaseUrl } from "../api/_base";
import { isDesktopAppShell } from "../ui/appShell";

const PATCHED = "__HSP_AUTH_FETCH_PATCHED__";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Only our backend (`getApiBaseUrl()/api/...`) should get Bearer + credentials.
 * Matching any URL that contains `/api/` also hits tokens.swap.coffee/api/v3 and
 * forces credentials:include, which Chromium rejects when ACAO is `*`
 * (prod: desktop "Failed to fetch" / Loading tokens).
 */
function isOurBackendApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes("/api")) return false;
    const base = getApiBaseUrl();
    if (!base) return false;
    return parsed.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** Attach `Authorization: Bearer` for our `/api/*` when running in the Electron desktop shell. */
export function installDesktopAuthFetch(): void {
  if (!isDesktopAppShell() || typeof globalThis.fetch !== "function") return;
  const g = globalThis as typeof globalThis & { [PATCHED]?: boolean };
  if (g[PATCHED]) return;
  g[PATCHED] = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!isOurBackendApiUrl(url)) {
      return nativeFetch(input, init);
    }

    const token = getDesktopSessionToken();
    if (!token) return nativeFetch(input, init);

    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return nativeFetch(input, {
      ...init,
      credentials: init?.credentials ?? "include",
      headers,
    });
  };
}
