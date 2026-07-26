import type { SwapJetton } from "./swapJettonsTypes";

/**
 * Minimum pool TVL (USD) before we trust a large reported mcap/fdmc on
 * non-whitelisted jettons. Below this, only modest caps are accepted.
 */
const MIN_TVL_FOR_LARGE_CAP_USD = 100;

/** Caps at or below this are allowed even with very thin liquidity. */
const SMALL_CAP_WITHOUT_LIQUIDITY_USD = 1_000_000; // $1M

/**
 * Max mcap/TVL ratio for non-whitelisted jettons.
 * Real majors on TON (e.g. BTC jetton ~5e5) stay under this; USDT-logo clones
 * with $2 TVL and ~$100B FDMC are far above it.
 */
const MAX_MCAP_TO_TVL_RATIO = 1_000_000;

/**
 * Resolve a displayable USD market cap for the choose-currency list.
 * Returns `null` when the API figure is an unreliable fully-diluted fantasy number.
 */
export function resolveJettonMarketCapUsd(jetton: SwapJetton): number | null {
  const stats = jetton.market_stats;
  const raw = stats?.mcap ?? stats?.fdmc;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;

  if (jetton.verification === "WHITELISTED") return raw;

  const tvl =
    typeof stats?.tvl_usd === "number" && Number.isFinite(stats.tvl_usd) ? Math.max(0, stats.tvl_usd) : 0;

  if (tvl < MIN_TVL_FOR_LARGE_CAP_USD) {
    return raw <= SMALL_CAP_WITHOUT_LIQUIDITY_USD ? raw : null;
  }

  if (raw / tvl > MAX_MCAP_TO_TVL_RATIO) return null;

  return raw;
}
