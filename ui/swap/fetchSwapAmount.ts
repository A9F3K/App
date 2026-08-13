import { swapCoffeeFetch } from "./swapCoffeeFetch";

export const SWAP_COFFEE_API_BASE = "https://backend.swap.coffee";

/** Default USDT jetton on TON (prev-main `swap_page.dart`). */
export const SWAP_USDT_DEFAULT_ADDRESS =
  "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

export const SWAP_BUY_AMOUNT_TON = 1;

type SwapRouteSmartResponse = {
  input_amount?: number | string;
};

export type FetchSwapAmountResult =
  | { ok: true; sellAmount: number }
  | { ok: false; error: string };

async function resolveUsdtAddress(): Promise<string> {
  try {
    const res = await swapCoffeeFetch(`${SWAP_COFFEE_API_BASE}/v1/tokens/ton`);
    if (!res.ok) return SWAP_USDT_DEFAULT_ADDRESS;
    const data: unknown = await res.json();
    if (Array.isArray(data)) {
      for (const token of data) {
        if (
          token &&
          typeof token === "object" &&
          (token as { symbol?: string }).symbol?.toUpperCase() === "USDT"
        ) {
          const address = (token as { address?: string }).address;
          if (address) return address;
        }
      }
    } else if (data && typeof data === "object") {
      const obj = data as { symbol?: string; address?: string };
      if (obj.symbol?.toUpperCase() === "USDT" && obj.address) return obj.address;
    }
  } catch {
    /* use default */
  }
  return SWAP_USDT_DEFAULT_ADDRESS;
}

/** How much USDT (sell side) is needed to receive `outputAmountTon` TON. */
export async function fetchSwapAmount(
  outputAmountTon = SWAP_BUY_AMOUNT_TON,
): Promise<FetchSwapAmountResult> {
  const usdtAddress = await resolveUsdtAddress();
  try {
    const res = await swapCoffeeFetch(`${SWAP_COFFEE_API_BASE}/v1/route/smart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_token: { blockchain: "ton", address: usdtAddress },
        output_token: { blockchain: "ton", address: "native" },
        output_amount: outputAmountTon,
        max_splits: 4,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Failed to fetch: ${res.status}` };
    }
    const data = (await res.json()) as SwapRouteSmartResponse;
    const raw = data.input_amount;
    const sellAmount = typeof raw === "number" ? raw : raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(sellAmount)) {
      return { ok: false, error: "Invalid response format" };
    }
    return { ok: true, sellAmount };
  } catch {
    return { ok: false, error: "Network error" };
  }
}
