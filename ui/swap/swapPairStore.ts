import { useSyncExternalStore } from "react";

import type { SwapCurrencySide } from "./swapCurrencyPicker";
import {
  SWAP_DLLR_TOKEN,
  SWAP_GRAM_TOKEN,
  swapUnitAmountSide,
  type SwapPairToken,
  type SwapQuoteDirection,
} from "./swapPairTypes";

export type SwapPairState = {
  sellToken: SwapPairToken;
  buyToken: SwapPairToken;
  sellAmount: string;
  buyAmount: string;
  /** Which field the user last edited. */
  quoteDirection: SwapQuoteDirection;
  /** Last successful route meta for the action row. */
  lastQuotedSellAmount: number | null;
  lastQuotedBuyAmount: number | null;
  quoteError: string | null;
  isQuoting: boolean;
};

const listeners = new Set<() => void>();

let state: SwapPairState = {
  sellToken: SWAP_DLLR_TOKEN,
  buyToken: SWAP_GRAM_TOKEN,
  sellAmount: "",
  buyAmount: "1",
  quoteDirection: "exact_out",
  lastQuotedSellAmount: null,
  lastQuotedBuyAmount: null,
  quoteError: null,
  isQuoting: false,
};

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<SwapPairState>) {
  state = { ...state, ...patch };
  emit();
}

export function getSwapPairState(): SwapPairState {
  return state;
}

export function subscribeSwapPair(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSwapPairState(): SwapPairState {
  return useSyncExternalStore(subscribeSwapPair, getSwapPairState, getSwapPairState);
}

export function setSwapSellAmount(amount: string) {
  setState({
    sellAmount: amount,
    quoteDirection: "exact_in",
  });
}

export function setSwapBuyAmount(amount: string) {
  setState({
    buyAmount: amount,
    quoteDirection: "exact_out",
  });
}

export function setSwapQuoteResult(opts: {
  sellAmount: string;
  buyAmount: string;
  sellNumeric: number | null;
  buyNumeric: number | null;
  error: string | null;
  isQuoting: boolean;
}) {
  setState({
    sellAmount: opts.sellAmount,
    buyAmount: opts.buyAmount,
    lastQuotedSellAmount: opts.sellNumeric,
    lastQuotedBuyAmount: opts.buyNumeric,
    quoteError: opts.error,
    isQuoting: opts.isQuoting,
  });
}

export function setSwapQuoting(isQuoting: boolean) {
  if (state.isQuoting === isQuoting) return;
  setState({ isQuoting });
}

export function setSwapTokenForSide(side: SwapCurrencySide, token: SwapPairToken) {
  if (side === "sell") {
    const sameAsBuy =
      token.address.toLowerCase() === state.buyToken.address.toLowerCase() &&
      Boolean(token.isNative) === Boolean(state.buyToken.isNative);
    if (sameAsBuy) {
      setState({
        sellToken: token,
        buyToken: state.sellToken,
        buyAmount: "",
        quoteDirection: "exact_in",
      });
      return;
    }
    setState({
      sellToken: token,
      buyAmount: "",
      quoteDirection: "exact_in",
    });
    return;
  }
  const sameAsSell =
    token.address.toLowerCase() === state.sellToken.address.toLowerCase() &&
    Boolean(token.isNative) === Boolean(state.sellToken.isNative);
  if (sameAsSell) {
    setState({
      buyToken: token,
      sellToken: state.buyToken,
      buyAmount: "",
      quoteDirection: "exact_in",
    });
    return;
  }
  setState({
    buyToken: token,
    buyAmount: "",
    quoteDirection: "exact_in",
  });
}

/**
 * Currencies-home selection: buy `token` for Dollar (DLLR). Picking DLLR itself
 * opens the default DLLR → Gram pair.
 */
export function selectSwapBuyTokenForDllr(token: SwapPairToken) {
  const isDllr =
    token.address.toLowerCase() === SWAP_DLLR_TOKEN.address.toLowerCase() ||
    token.symbol.trim().toUpperCase() === "DLLR";
  setState({
    sellToken: SWAP_DLLR_TOKEN,
    buyToken: isDllr ? SWAP_GRAM_TOKEN : token,
    sellAmount: "",
    buyAmount: "1",
    quoteDirection: "exact_out",
    lastQuotedBuyAmount: null,
    lastQuotedSellAmount: null,
    quoteError: null,
  });
}

export function rotateSwapPair() {
  // whatswap rotation: swap tokens and move the fixed unit ("1") to the opposite side.
  const nextSell = state.buyToken;
  const nextBuy = state.sellToken;
  const unitSide = swapUnitAmountSide(nextSell, nextBuy);
  if (unitSide === "buy") {
    // Buying 1 chart asset for DLLR — quote exact-out of 1.
    setState({
      sellToken: nextSell,
      buyToken: nextBuy,
      sellAmount: "",
      buyAmount: "1",
      quoteDirection: "exact_out",
      lastQuotedBuyAmount: null,
      lastQuotedSellAmount: null,
    });
    return;
  }
  // Selling 1 chart asset for DLLR — quote exact-in of 1.
  setState({
    sellToken: nextSell,
    buyToken: nextBuy,
    sellAmount: "1",
    buyAmount: "",
    quoteDirection: "exact_in",
    lastQuotedBuyAmount: null,
    lastQuotedSellAmount: null,
  });
}
