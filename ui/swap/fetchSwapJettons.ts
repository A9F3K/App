import { buildApiUrl } from "../../api/_base";
import { isDesktopAppShell } from "../appShell";
import { SWAP_COFFEE_TOKENS_API_BASE } from "./swapChartConstants";
import type {
  SwapAccountJettonsResponse,
  SwapJetton,
  SwapJettonVerification,
} from "./swapJettonsTypes";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const DEFAULT_VERIFICATION: SwapJettonVerification[] = ["WHITELISTED", "COMMUNITY", "UNKNOWN"];

function useSwapCoffeeTokensProxy(): boolean {
  return isDesktopAppShell();
}

function tokensBaseUrl(): string {
  return SWAP_COFFEE_TOKENS_API_BASE.replace(/\/$/, "");
}

function swapCoffeeHeaders(viaProxy = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!viaProxy) {
    const apiKey = process.env.EXPO_PUBLIC_COFFEE?.trim();
    if (apiKey) headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

function swapCoffeeFetchInit(viaProxy: boolean): RequestInit {
  return {
    headers: swapCoffeeHeaders(viaProxy),
    ...(viaProxy ? { credentials: "include" as const } : null),
  };
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Swap.Coffee tokens API ${res.status}: ${text.slice(0, 160)}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchSwapJettonsPage(
  page: number,
  verification: readonly SwapJettonVerification[] = DEFAULT_VERIFICATION,
): Promise<SwapJetton[]> {
  const viaProxy = useSwapCoffeeTokensProxy();
  const url = viaProxy
    ? new URL(buildApiUrl("/api/swap-coffee-tokens"))
    : new URL(`${tokensBaseUrl()}/api/v3/jettons`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(PAGE_SIZE));
  for (const v of verification) {
    url.searchParams.append("verification", v);
  }

  const res = await fetch(url.toString(), swapCoffeeFetchInit(viaProxy));
  const data = await parseJsonResponse<unknown>(res);
  if (!Array.isArray(data)) {
    throw new Error("Swap.Coffee jettons: unexpected payload");
  }
  return data as SwapJetton[];
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
  const viaProxy = useSwapCoffeeTokensProxy();
  const url = viaProxy
    ? (() => {
        const proxy = new URL(buildApiUrl("/api/swap-coffee-tokens"));
        proxy.searchParams.set("wallet", walletAddress);
        return proxy.toString();
      })()
    : `${tokensBaseUrl()}/api/v3/accounts/${encodeURIComponent(walletAddress)}/jettons`;
  const res = await fetch(url, swapCoffeeFetchInit(viaProxy));
  return parseJsonResponse<SwapAccountJettonsResponse>(res);
}
