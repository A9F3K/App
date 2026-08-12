import { useMemo } from "react";

import { SWAP_BUY_AMOUNT_TON } from "./fetchSwapAmount";
import { useSwapCurrencyPicker } from "./swapCurrencyPicker";
import { useSwapPairState } from "./swapPairStore";
import {
  isDllrToken,
  SWAP_GRAM_TOKEN,
  swapTokenChartAddress,
  swapTokenDisplaySymbol,
  type SwapPairToken,
} from "./swapPairTypes";
import { useSwapChart } from "./useSwapChart";

/**
 * Wallet DLLR available for the sample strip (“1$”) until real balances are wired.
 * Deal is inactive (Low amount) when the quoted sell cost exceeds this.
 */
export const SWAP_AVAILABLE_DLLR_PLACEHOLDER = 1;

/** Notice shown immediately left of the Swap button. */
export type SwapDealButtonNotice = "none" | "lowAmount" | "noPool";

export type SwapDealActionState = {
  /** DLLR needed to buy 1 unit of the offer / deal asset. */
  dllrAmount: number | null;
  /** Ticker for the left-edge offer copy. */
  buySymbol: string;
  /** Status text immediately left of Swap (`No pool` / `Low amount`). */
  buttonNotice: SwapDealButtonNotice;
  /** When false, Swap uses inactive undercover + is not pressable. */
  buttonActive: boolean;
  /** Currencies / choose-currency picker is covering the form. */
  onCurrencyScreen: boolean;
};

function chartTokenForPair(sellToken: SwapPairToken, buyToken: SwapPairToken): SwapPairToken {
  if (!isDllrToken(buyToken)) return buyToken;
  if (!isDllrToken(sellToken)) return sellToken;
  return buyToken;
}

function quoteMeansNoPool(quoteError: string | null): boolean {
  if (!quoteError) return false;
  const key = quoteError.trim().toLowerCase();
  return (
    key === "no_route" ||
    key === "no pool" ||
    key.includes("no_route") ||
    key.includes("no route") ||
    key.includes("no pool")
  );
}

/** Shared deal summary / Swap button state for inline (2-col) and column footer (3-col). */
export function useSwapDealActionState(): SwapDealActionState {
  const pickerMode = useSwapCurrencyPicker();
  const onCurrencyScreen = pickerMode != null;
  const { sellToken, buyToken, quoteError } = useSwapPairState();

  // Currencies / choose-currency: always the Gram ↔ DLLR offer.
  const offerToken = onCurrencyScreen
    ? SWAP_GRAM_TOKEN
    : chartTokenForPair(sellToken, buyToken);
  const chartJettonAddress = swapTokenChartAddress(offerToken);
  const buySymbol = onCurrencyScreen ? "GRAM" : swapTokenDisplaySymbol(offerToken);

  const { effectivePriceUsd } = useSwapChart("d", {
    deferInitialLoad: true,
    jettonAddress: chartJettonAddress,
  });

  const dllrAmount = useMemo(() => {
    if (effectivePriceUsd == null || !Number.isFinite(effectivePriceUsd)) return null;
    return effectivePriceUsd * SWAP_BUY_AMOUNT_TON;
  }, [effectivePriceUsd]);

  const hasEnoughDllr =
    dllrAmount != null && dllrAmount <= SWAP_AVAILABLE_DLLR_PLACEHOLDER + 1e-9;

  // DLLR is off-catalog / not routable on Swap.Coffee yet — treat any DLLR pair
  // (including Currencies Gram offer) as no pool until a real route exists.
  const dllrInPair =
    onCurrencyScreen || isDllrToken(sellToken) || isDllrToken(buyToken);
  const noPool = dllrInPair || quoteMeansNoPool(quoteError);

  const buttonNotice: SwapDealButtonNotice = noPool
    ? "noPool"
    : !hasEnoughDllr
      ? "lowAmount"
      : "none";

  return {
    dllrAmount,
    buySymbol,
    buttonNotice,
    buttonActive: !onCurrencyScreen && !noPool && hasEnoughDllr,
    onCurrencyScreen,
  };
}
