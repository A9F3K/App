import type { ChooseCurrencyIconSource } from "../components/swap/chooseCurrencyTableTypes";

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

/** Default USDT jetton (whatswap / fetchSwapAmount). */
export const SWAP_USDT_TOKEN: SwapPairToken = {
  address: "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
  isNative: false,
};

export const SWAP_TON_TOKEN: SwapPairToken = {
  address: SWAP_TON_ZERO_ADDRESS,
  symbol: "TON",
  name: "Toncoin",
  decimals: 9,
  isNative: true,
};

export function isNativeTonToken(token: SwapPairToken | null | undefined): boolean {
  if (!token) return false;
  if (token.isNative) return true;
  const symbol = token.symbol.trim().toUpperCase();
  if (symbol === "TON") return true;
  const addr = token.address.trim().toLowerCase();
  return (
    addr === "native" ||
    addr === SWAP_TON_ZERO_ADDRESS ||
    addr.includes("00000000000000000000000000000000000000000000000000000000")
  );
}
