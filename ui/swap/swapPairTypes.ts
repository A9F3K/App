import type { ChooseCurrencyIconSource } from "../components/swap/chooseCurrencyTableTypes";
import { swapDllrTokenImage, swapTonTokenImage } from "../components/swap/swapFormAssets";

/** Token selected in the swap form (Swap.Coffee / whatswap shape). */
export type SwapPairToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string | null;
  icon?: ChooseCurrencyIconSource | null;
  /** Native TON for RoutingApi — address is still the zero raw id for UI. */
  isNative?: boolean;
};

export type SwapQuoteDirection = "exact_in" | "exact_out";

export const SWAP_TON_ZERO_ADDRESS =
  "0:0000000000000000000000000000000000000000000000000000000000000000";

/** Pinned Dollar row in Currencies — sold to buy the selected token. */
export const SWAP_DLLR_ROW_KEY = "jetton:dllr";

export const SWAP_DLLR_TOKEN: SwapPairToken = {
  address: SWAP_DLLR_ROW_KEY,
  symbol: "DLLR",
  name: "Dollar",
  decimals: 9,
  icon: swapDllrTokenImage,
  isNative: false,
};

/** Default USDT jetton (whatswap / fetchSwapAmount). */
export const SWAP_USDT_TOKEN: SwapPairToken = {
  address: "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
  isNative: false,
};

/**
 * Native asset on Swap.Coffee (zero address). Catalog lists it as Gram / GRAM;
 * still `isNative` for routing.
 */
export const SWAP_GRAM_TOKEN: SwapPairToken = {
  address: SWAP_TON_ZERO_ADDRESS,
  symbol: "GRAM",
  name: "Gram",
  decimals: 9,
  icon: swapTonTokenImage,
  isNative: true,
};

/** @deprecated Prefer {@link SWAP_GRAM_TOKEN} — same native asset. */
export const SWAP_TON_TOKEN: SwapPairToken = SWAP_GRAM_TOKEN;

function isZeroTonAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  return (
    addr === "native" ||
    addr === SWAP_TON_ZERO_ADDRESS ||
    /^0:0+$/.test(addr) ||
    addr.includes("00000000000000000000000000000000000000000000000000000000")
  );
}

export function isNativeTonToken(token: SwapPairToken | null | undefined): boolean {
  if (!token) return false;
  if (isZeroTonAddress(token.address)) return true;
  // `isNative` alone is trusted only with an empty / placeholder address —
  // do not treat arbitrary "GRAM"/"TON" tickers as native.
  if (token.isNative && !token.address.trim()) return true;
  return false;
}

export function isDllrToken(token: SwapPairToken | null | undefined): boolean {
  if (!token) return false;
  if (token.address.trim().toLowerCase() === SWAP_DLLR_ROW_KEY) return true;
  return token.symbol.trim().toUpperCase() === "DLLR";
}

/**
 * Which form side holds the fixed 1-unit of the priced (non-DLLR) asset —
 * same basis-field rule as whatswap rotation (even: send/buy asset, odd: opposite).
 * Chart / rate stay on this asset; amounts flip when the pair rotates.
 */
export function swapUnitAmountSide(
  sellToken: SwapPairToken,
  buyToken: SwapPairToken,
): "sell" | "buy" {
  if (!isDllrToken(buyToken)) return "buy";
  if (!isDllrToken(sellToken)) return "sell";
  return "buy";
}

/** Non-DLLR asset used for chart + unit pricing (prefer buy, else sell). */
export function swapChartTokenForPair(
  sellToken: SwapPairToken,
  buyToken: SwapPairToken,
): SwapPairToken {
  if (!isDllrToken(buyToken)) return buyToken;
  if (!isDllrToken(sellToken)) return sellToken;
  return buyToken;
}

/** UI ticker — native zero-address asset is always Gram, never "TON". */
export function swapTokenDisplaySymbol(token: SwapPairToken): string {
  if (isDllrToken(token)) return "DLLR";
  if (isNativeTonToken(token)) return "GRAM";
  const symbol = token.symbol.trim().toUpperCase();
  if (symbol === "TON") return "GRAM";
  return symbol || "TOKEN";
}

/** Jetton address used for Dyor chart / Swap.Coffee market stats. */
export function swapTokenChartAddress(token: SwapPairToken): string {
  if (isDllrToken(token)) return SWAP_TON_ZERO_ADDRESS;
  if (isNativeTonToken(token)) return SWAP_TON_ZERO_ADDRESS;
  return token.address.trim();
}
