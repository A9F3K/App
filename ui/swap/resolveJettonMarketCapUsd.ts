import type { SwapJetton, SwapJettonMarketStats, SwapJettonVerification } from "./swapJettonsTypes";

/**
 * ## Root cause (GAZZA “1.5B$+” and similar list rows)
 *
 * Swap.Coffee’s `market_stats.mcap` / `fdmc` are often `price × total_supply` with
 * an absurd total supply. Example (live API):
 *   GAZZA  price≈$0.000014  mcap=fdmc≈$1.48B  tvl≈$4k  volume24h=$0  verification=UNKNOWN
 * That is not a real $1.5B market — the pool cannot support it.
 *
 * The choose-currency list used to trust any non-whitelisted cap whose
 * mcap/TVL ratio was ≤ **1_000_000**. GAZZA’s ratio is ~**372_000**, so it
 * passed, became `marketCapUsd`, sorted near the **top** of the list
 * (`useChooseCurrencyRows` sorts by mcap desc), and rendered as `1.5B$+`.
 *
 * Fix: every list row goes through `resolveJettonMarketCapUsd` with a much
 * tighter ratio + absolute TVL floors for large/huge caps. Rejected caps
 * become `null` → UI `—` and sort key `0` (bottom of the list).
 */

/** Below this TVL, only modest caps are accepted for non-whitelisted jettons. */
const MIN_TVL_FOR_ANY_LARGE_CAP_USD = 100;

/** Caps at or below this are allowed even with very thin liquidity. */
const SMALL_CAP_WITHOUT_LIQUIDITY_USD = 1_000_000; // $1M

/**
 * Max mcap/TVL for non-whitelisted jettons.
 * Was 1_000_000 (let GAZZA through). 10_000 rejects ~$1.5B on ~$4k TVL.
 */
const MAX_MCAP_TO_TVL_RATIO = 10_000;

const LARGE_CAP_USD = 100_000_000; // $100M
const MIN_TVL_FOR_LARGE_CAP_USD = 50_000;
const HUGE_CAP_USD = 1_000_000_000; // $1B
const MIN_TVL_FOR_HUGE_CAP_USD = 500_000;

/** Dead markets claiming huge size are almost always supply×price fantasies. */
const DEAD_MARKET_HUGE_CAP_USD = 10_000_000; // $10M
const DEAD_MARKET_MIN_VOLUME_USD = 1;

export type MarketCapTrustInput = {
  verification?: SwapJettonVerification | null;
  market_stats?: Pick<
    SwapJettonMarketStats,
    "mcap" | "fdmc" | "tvl_usd" | "volume_usd_24h"
  > | null;
};

/**
 * Single trust gate for USD market-cap display / ranking.
 * Returns `null` when the API figure must not be shown in any list position.
 */
export function trustJettonMarketCapUsd(input: MarketCapTrustInput): number | null {
  const stats = input.market_stats;
  const mcap = stats?.mcap;
  const fdmc = stats?.fdmc;
  const hasMcap = typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0;
  const hasFdmc = typeof fdmc === "number" && Number.isFinite(fdmc) && fdmc > 0;
  // Prefer circulating mcap; fdmc only when mcap is missing.
  const raw = hasMcap ? mcap! : hasFdmc ? fdmc! : null;
  if (raw == null) return null;

  if (input.verification === "WHITELISTED") return raw;

  const tvl =
    typeof stats?.tvl_usd === "number" && Number.isFinite(stats.tvl_usd) ? Math.max(0, stats.tvl_usd) : 0;
  const volume =
    typeof stats?.volume_usd_24h === "number" && Number.isFinite(stats.volume_usd_24h)
      ? Math.max(0, stats.volume_usd_24h)
      : 0;

  if (tvl < MIN_TVL_FOR_ANY_LARGE_CAP_USD) {
    return raw <= SMALL_CAP_WITHOUT_LIQUIDITY_USD ? raw : null;
  }

  if (raw / tvl > MAX_MCAP_TO_TVL_RATIO) return null;

  if (raw >= HUGE_CAP_USD && tvl < MIN_TVL_FOR_HUGE_CAP_USD) return null;
  if (raw >= LARGE_CAP_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) return null;

  // FDMC-only + thin pool → classic max-supply fantasy.
  if (!hasMcap && hasFdmc && raw > SMALL_CAP_WITHOUT_LIQUIDITY_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) {
    return null;
  }

  // No 24h volume but claiming eight-figure+ size on a tiny pool.
  if (volume < DEAD_MARKET_MIN_VOLUME_USD && raw >= DEAD_MARKET_HUGE_CAP_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) {
    return null;
  }

  return raw;
}

/** Resolve a displayable USD market cap for the choose-currency list. */
export function resolveJettonMarketCapUsd(jetton: SwapJetton): number | null {
  return trustJettonMarketCapUsd({
    verification: jetton.verification,
    market_stats: jetton.market_stats,
  });
}
