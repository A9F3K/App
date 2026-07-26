import type { SwapJetton } from "./swapJettonsTypes";

const LEGIT_STABLE_SYMBOLS = new Set([
  "USDT",
  "JUSDT",
  "OUSDT",
  "USD₮",
  "USDE",
  "USD",
]);

/**
 * Scam jettons often copy the official Tether image while using a different
 * name/symbol (e.g. "Black VORS12" / VORS212). Detect that so we can drop the
 * stolen logo and avoid ranking them as if they were USDT.
 */
export function jettonUsesStolenUsdtBranding(jetton: SwapJetton): boolean {
  const symbol = (jetton.symbol ?? "").trim().toUpperCase();
  if (!symbol || LEGIT_STABLE_SYMBOLS.has(symbol)) return false;
  if (symbol.includes("USDT") && jetton.verification === "WHITELISTED") return false;

  const image = jetton.image_url ?? "";
  if (!image) return false;

  return (
    /tether\.to/i.test(image) ||
    /Tether-USDT/i.test(image) ||
    /USDTJettonMasterTon/i.test(image) ||
    /logoCircle/i.test(image) ||
    /\/USDT\.jpe?g/i.test(image)
  );
}
