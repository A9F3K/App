import { useEffect, useRef } from "react";

import { buildSwapRouteQuote } from "./swapCoffeeRouting";
import {
  getSwapPairState,
  setSwapQuoteResult,
  setSwapQuoting,
  subscribeSwapPair,
  useSwapPairState,
} from "./swapPairStore";

const QUOTE_DEBOUNCE_MS = 350;

function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Live Swap.Coffee quotes (whatswap `use-swap-calculation` port).
 * Debounces edits and fills the opposite amount field.
 */
export function useSwapQuote(): void {
  const pair = useSwapPairState();
  const requestIdRef = useRef(0);

  useEffect(() => {
    const run = () => {
      const snap = getSwapPairState();
      const raw =
        snap.quoteDirection === "exact_out" ? snap.buyAmount : snap.sellAmount;
      const amount = Number(String(raw).replace(",", ".").trim());
      if (!(amount > 0) || !Number.isFinite(amount)) {
        setSwapQuoteResult({
          sellAmount: snap.sellAmount,
          buyAmount: snap.quoteDirection === "exact_in" ? "" : snap.buyAmount,
          sellNumeric: null,
          buyNumeric: null,
          error: null,
          isQuoting: false,
        });
        return;
      }

      const id = ++requestIdRef.current;
      setSwapQuoting(true);

      void buildSwapRouteQuote({
        sellToken: snap.sellToken,
        buyToken: snap.buyToken,
        amount,
        direction: snap.quoteDirection,
      })
        .then((quote) => {
          if (id !== requestIdRef.current) return;
          const nextSell =
            snap.quoteDirection === "exact_out"
              ? formatAmount(quote.inputAmount)
              : snap.sellAmount;
          const nextBuy =
            snap.quoteDirection === "exact_in"
              ? formatAmount(quote.outputAmount)
              : snap.buyAmount;
          setSwapQuoteResult({
            sellAmount: nextSell,
            buyAmount: nextBuy,
            sellNumeric: quote.inputAmount,
            buyNumeric: quote.outputAmount,
            error: null,
            isQuoting: false,
          });
        })
        .catch((err) => {
          if (id !== requestIdRef.current) return;
          const message =
            err instanceof Error ? err.message : "quote_failed";
          setSwapQuoteResult({
            sellAmount: snap.sellAmount,
            buyAmount: snap.quoteDirection === "exact_in" ? "" : snap.buyAmount,
            sellNumeric: null,
            buyNumeric: null,
            error: message,
            isQuoting: false,
          });
        });
    };

    const timer = setTimeout(run, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    pair.sellToken.address,
    pair.buyToken.address,
    pair.sellToken.isNative,
    pair.buyToken.isNative,
    pair.sellAmount,
    pair.buyAmount,
    pair.quoteDirection,
  ]);

  // Keep hook subscribed for external setSell/setBuy from other components.
  useEffect(() => subscribeSwapPair(() => {}), []);
}
