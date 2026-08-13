import { isDesktopAppShell } from "../appShell";
import { logPageDisplay } from "../pageDisplayLog";
import { SWAP_COFFEE_TOKENS_API_BASE } from "./swapChartConstants";
import type {
  SwapAccountJettonsResponse,
  SwapJetton,
  SwapJettonVerification,
} from "./swapJettonsTypes";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
/** Desktop previously hung forever on the Vercel proxy (504 / DDoS-Guard). Cap waits. */
const FETCH_TIMEOUT_MS = 20_000;

const DEFAULT_VERIFICATION: SwapJettonVerification[] = ["WHITELISTED", "COMMUNITY", "UNKNOWN"];

function tokensBaseUrl(): string {
  return SWAP_COFFEE_TOKENS_API_BASE.replace(/\/$/, "");
}

function swapCoffeeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.EXPO_PUBLIC_COFFEE?.trim();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...swapCoffeeHeaders(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Swap.Coffee tokens request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Swap.Coffee tokens API ${res.status}: ${text.slice(0, 160)}`);
  }
  return JSON.parse(text) as T;
}

function jettonsPageUrl(
  page: number,
  verification: readonly SwapJettonVerification[],
): string {
  // Always hit tokens.swap.coffee directly. Desktop used to proxy via
  // `/api/swap-coffee-tokens`, but Vercel egress is blocked/slowed by DDoS-Guard
  // (prod: FUNCTION_INVOCATION_TIMEOUT) while the origin returns ACAO: * for app://.
  const url = new URL(`${tokensBaseUrl()}/api/v3/jettons`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(PAGE_SIZE));
  for (const v of verification) {
    url.searchParams.append("verification", v);
  }
  return url.toString();
}

export async function fetchSwapJettonsPage(
  page: number,
  verification: readonly SwapJettonVerification[] = DEFAULT_VERIFICATION,
): Promise<SwapJetton[]> {
  const url = jettonsPageUrl(page, verification);
  const started = Date.now();
  logPageDisplay("swap_jettons_page_fetch", {
    page,
    desktopShell: isDesktopAppShell(),
    via: "direct",
  });
  try {
    const res = await fetchWithTimeout(url);
    const data = await parseJsonResponse<unknown>(res);
    if (!Array.isArray(data)) {
      throw new Error("Swap.Coffee jettons: unexpected payload");
    }
    logPageDisplay("swap_jettons_page_ok", {
      page,
      count: data.length,
      elapsedMs: Date.now() - started,
    });
    return data as SwapJetton[];
  } catch (err) {
    logPageDisplay("swap_jettons_page_error", {
      page,
      elapsedMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function fetchAllSwapJettons(
  onPage?: (jettons: SwapJetton[], page: number) => void,
): Promise<SwapJetton[]> {
  const seen = new Set<string>();
  const all: SwapJetton[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_PAGES) {
    const batch = await fetchSwapJettonsPage(page);
    if (batch.length === 0) break;

    for (const jetton of batch) {
      const key = jetton.address?.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(jetton);
    }

    onPage?.(all.slice(), page);
    hasMore = batch.length >= PAGE_SIZE;
    page += 1;
  }

  return all;
}

export async function fetchAccountSwapJettons(walletAddress: string): Promise<SwapAccountJettonsResponse> {
  const url = `${tokensBaseUrl()}/api/v3/accounts/${encodeURIComponent(walletAddress)}/jettons`;
  const started = Date.now();
  logPageDisplay("swap_account_jettons_fetch", {
    desktopShell: isDesktopAppShell(),
    via: "direct",
  });
  try {
    const res = await fetchWithTimeout(url);
    const data = await parseJsonResponse<SwapAccountJettonsResponse>(res);
    logPageDisplay("swap_account_jettons_ok", {
      count: Array.isArray(data.items) ? data.items.length : 0,
      elapsedMs: Date.now() - started,
    });
    return data;
  } catch (err) {
    logPageDisplay("swap_account_jettons_error", {
      elapsedMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
