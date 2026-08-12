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

export type SwapDealLeftMode = "deal" | "gramOffer" | "lowAmount";

export type SwapDealActionState = {
  /** DLLR needed to buy 1 unit of the offer / deal asset. */
  dllrAmount: number | null;
  /** Ticker for deal / Gram-offer copy. */
  buySymbol: string;
  leftMode: SwapDealLeftMode;
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

/** Shared deal summary / Swap button state for inline (2-col) and column footer (3-col). */
export function useSwapDealActionState(): SwapDealActionState {
  const pickerMode = useSwapCurrencyPicker();
  const onCurrencyScreen = pickerMode != null;
  const { sellToken, buyToken } = useSwapPairState();

  const offerToken = onCurrencyScreen
    ? SWAP_GRAM_TOKEN
    : chartTokenForPair(sellToken, buyToken);
  const chartJettonAddress = swapTokenChartAddress(offerToken);
  const buySymbol = swapTokenDisplaySymbol(offerToken);

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

  if (onCurrencyScreen) {
    return {
      dllrAmount,
      buySymbol: "GRAM",
      leftMode: "gramOffer",
      buttonActive: false,
      onCurrencyScreen: true,
    };
  }

  if (!hasEnoughDllr) {
    return {
      dllrAmount,
      buySymbol,
      leftMode: "lowAmount",
      buttonActive: false,
      onCurrencyScreen: false,
    };
  }

  return {
    dllrAmount,
    buySymbol,
    leftMode: "deal",
    buttonActive: true,
    onCurrencyScreen: false,
  };
}
