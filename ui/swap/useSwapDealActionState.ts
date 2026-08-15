import { useMemo } from "react";

import { SWAP_BUY_AMOUNT_TON } from "./fetchSwapAmount";
import { useSwapCurrencyPicker } from "./swapCurrencyPicker";
import { useSwapPairState } from "./swapPairStore";
import {
  isDllrToken,
  SWAP_GRAM_TOKEN,
  swapChartTokenForPair,
  swapTokenChartAddress,
  swapTokenDisplaySymbol,
  swapUnitAmountSide,
} from "./swapPairTypes";
import { useSwapChart } from "./useSwapChart";

/**
 * Wallet DLLR available for the sample strip (“1$”) until real balances are wired.
 * Deal is inactive (Low amount) when the quoted sell cost exceeds this.
 */
export const SWAP_AVAILABLE_DLLR_PLACEHOLDER = 1;

/** Notice shown immediately left of the Swap button. */
export type SwapDealButtonNotice = "none" | "noAmount" | "lowAmount" | "noPool" | "dllrFrozen";

export type SwapDealActionState = {
  /** DLLR needed to buy/sell 1 unit of the offer / deal asset. */
  dllrAmount: number | null;
  /** Ticker for the left-edge offer copy. */
  buySymbol: string;
  /** `buy` = Buy 1 asset for dllr; `sell` = Sell 1 asset for dllr (after rotate). */
  dealSide: "buy" | "sell";
  /** Status text immediately left of Swap (`DLLR Frozen` / `No pool` / `No amount` / `Low amount`). */
  buttonNotice: SwapDealButtonNotice;
  /** When false, Swap uses inactive undercover + is not pressable. */
  buttonActive: boolean;
  /** Currencies / choose-currency picker is covering the form. */
  onCurrencyScreen: boolean;
};

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

  // Currencies-home selection: always the Gram ↔ DLLR offer.
  const offerToken = onCurrencyScreen
    ? SWAP_GRAM_TOKEN
    : swapChartTokenForPair(sellToken, buyToken);
  const chartJettonAddress = swapTokenChartAddress(offerToken);
  const buySymbol = onCurrencyScreen ? "GRAM" : swapTokenDisplaySymbol(offerToken);
  const dealSide: "buy" | "sell" = onCurrencyScreen
    ? "buy"
    : swapUnitAmountSide(sellToken, buyToken) === "buy"
      ? "buy"
      : "sell";

  const { effectivePriceUsd } = useSwapChart("d", {
    deferInitialLoad: true,
    jettonAddress: chartJettonAddress,
  });

  const dllrAmount = useMemo(() => {
    if (effectivePriceUsd == null || !Number.isFinite(effectivePriceUsd)) return null;
    return effectivePriceUsd * SWAP_BUY_AMOUNT_TON;
  }, [effectivePriceUsd]);

  const hasQuotedAmount = dllrAmount != null && Number.isFinite(dllrAmount);
  const hasEnoughDllr =
    hasQuotedAmount && dllrAmount <= SWAP_AVAILABLE_DLLR_PLACEHOLDER + 1e-9;

  // DLLR swaps are frozen until routing is live — every DLLR pair (and the
  // Currencies Gram offer) shows “DLLR Frozen” left of Swap.
  const dllrInPair =
    onCurrencyScreen || isDllrToken(sellToken) || isDllrToken(buyToken);
  const noPool = !dllrInPair && quoteMeansNoPool(quoteError);

  const buttonNotice: SwapDealButtonNotice = dllrInPair
    ? "dllrFrozen"
    : noPool
      ? "noPool"
      : !hasQuotedAmount
        ? "noAmount"
        : !hasEnoughDllr
          ? "lowAmount"
          : "none";

  return {
    dllrAmount,
    buySymbol,
    dealSide,
    buttonNotice,
    buttonActive: !onCurrencyScreen && !dllrInPair && !noPool && hasEnoughDllr,
    onCurrencyScreen,
  };
}
