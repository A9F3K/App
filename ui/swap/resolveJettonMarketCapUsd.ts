import type { SwapJetton } from "./swapJettonsTypes";

/** Caps at or below this are shown as reported (covers normal TON jettons). */
const TRUSTED_WITHOUT_CHECKS_USD = 100_000_000_000; // $100B

/**
 * Minimum pool TVL required before we trust a *mega* FDMC/mcap from the API.
 * Junk meme jettons often report quadrillion “market caps” from huge `total_supply`
 * while having only a few thousand dollars of liquidity.
 */
const MIN_TVL_FOR_MEGA_CAP_USD = 1_000_000; // $1M

/**
 * Resolve a displayable USD market cap for the choose-currency list.
 * Returns `null` when the API figure is an unreliable fully-diluted fantasy number.
 */
export function resolveJettonMarketCapUsd(jetton: SwapJetton): number | null {
  const stats = jetton.market_stats;
  const raw = stats?.mcap ?? stats?.fdmc;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;

  if (raw <= TRUSTED_WITHOUT_CHECKS_USD) return raw;

  if (jetton.verification === "WHITELISTED") return raw;

  const tvl = stats?.tvl_usd;
  if (typeof tvl === "number" && Number.isFinite(tvl) && tvl >= MIN_TVL_FOR_MEGA_CAP_USD) {
    return raw;
  }

  return null;
}
