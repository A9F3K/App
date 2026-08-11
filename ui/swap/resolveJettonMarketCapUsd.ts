import type { SwapJetton, SwapJettonMarketStats, SwapJettonVerification } from "./swapJettonsTypes";

/**
 * ## Root cause (GAZZA “1.5B$+”, preOPENAI / OPENAI “8.9B$+”, and similar)
 *
 * Swap.Coffee’s `market_stats.mcap` / `fdmc` are usually `price × supply`. A thin
 * pool can print an absurd spot price; supply × that price becomes a fantasy
 * “market cap” that then sorts to the **top** of choose-currency.
 *
 * Live OPENAI (preOPENAI) example:
 *   price≈$886  mcap=fdmc≈$8.86B  tvl≈$5.28M  volume24h≈$89k  holders≈230
 *   implied supply ≈ mcap/price ≈ 10M
 *   mcap/tvl ≈ **1_680** (passed the old 10_000 ceiling)
 *   mcap/volume ≈ **99_000** (valuation is not tradeable)
 *
 * That is not a real $8.9B market — the pool cannot support it.
 *
 * ## Volume / market-cap coefficient
 *
 * Daily turnover = volume / mcap. Ranking uses the inverse (mcap / volume):
 *
 * | Turnover | mcap/volume | Action                                      |
 * | -------- | ----------- | ------------------------------------------- |
 * | ≥ 1%     | ≤ 100       | Full market-cap rank                        |
 * | 0.2–1%   | 100–500     | Soft demote toward `volume × 100`           |
 * | 0.05–0.2%| 500–2_000   | Heavy demote (same formula)                 |
 * | < 0.05%  | > 2_000     | Exclude / nullify displayed cap             |
 *
 * Target **100** ≈ 1% daily turnover — a balanced “full credit” floor used by
 * liquid mid-caps. Sort key = `min(trustedMcap, volume × 100)` so thin books
 * sink without vanishing until the hard exclude fires.
 *
 * Rejected caps become `null` → UI `—` and sort key `0`. Brand impersonators
 * are dropped entirely in `mapJettonToChooseCurrencyRow`.
 */

/** Below this TVL, only modest caps are accepted for non-whitelisted jettons. */
const MIN_TVL_FOR_ANY_LARGE_CAP_USD = 100;

/** Caps at or below this are allowed even with very thin liquidity. */
const SMALL_CAP_WITHOUT_LIQUIDITY_USD = 1_000_000; // $1M

/**
 * Max mcap/TVL for non-whitelisted jettons.
 * Was 1_000_000, then 10_000 (still let OPENAI’s ~1_680 through). 500 rejects it.
 */
const MAX_MCAP_TO_TVL_RATIO = 500;

/**
 * Hard exclude when mcap / 24h volume exceeds this (~0.05% daily turnover).
 * OPENAI ≈ 99_000. Was 5_000 (still too loose for mid fantasy caps).
 */
export const MAX_MCAP_TO_VOLUME_RATIO = 2_000;

/**
 * Ideal mcap/volume for **full** ranking credit (~1% daily turnover).
 * Tokens above this ratio are soft-demoted to `volume × this` for sort order.
 */
export const RANK_MCAP_TO_VOLUME_TARGET = 100;

/** Dust floor so a single $1 print cannot “legitimize” a fantasy cap. */
const MIN_VOLUME_FOR_RATIO_CHECK_USD = 10;

const LARGE_CAP_USD = 100_000_000; // $100M
const MIN_TVL_FOR_LARGE_CAP_USD = 50_000;
const HUGE_CAP_USD = 1_000_000_000; // $1B
const MIN_TVL_FOR_HUGE_CAP_USD = 500_000;
/** $1B+ claims also need meaningful daily volume, not just parked LP. */
const MIN_VOLUME_FOR_HUGE_CAP_USD = 250_000;

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

function readPositive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function readNonNegative(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
}

function claimedMarketCapUsd(
  stats: MarketCapTrustInput["market_stats"],
): { raw: number; hasMcap: boolean; hasFdmc: boolean } | null {
  const mcap = readPositive(stats?.mcap ?? null);
  const fdmc = readPositive(stats?.fdmc ?? null);
  if (mcap != null) return { raw: mcap, hasMcap: true, hasFdmc: fdmc != null };
  if (fdmc != null) return { raw: fdmc, hasMcap: false, hasFdmc: true };
  return null;
}

/**
 * True when 24h volume is far too small for the claimed market cap.
 * Used to hide (not merely demote) extreme low-turnover fantasies.
 * Missing volume is not treated as fail — those sink via soft demotion.
 */
export function jettonFailsVolumeToMcapFilter(input: MarketCapTrustInput): boolean {
  if (input.verification === "WHITELISTED") return false;
  const claimed = claimedMarketCapUsd(input.market_stats);
  if (!claimed) return false;
  const volumeRaw = input.market_stats?.volume_usd_24h;
  if (typeof volumeRaw !== "number" || !Number.isFinite(volumeRaw)) return false;
  const volume = Math.max(0, volumeRaw);

  // Known positive volume that implies < ~0.05% daily turnover.
  if (volume >= MIN_VOLUME_FOR_RATIO_CHECK_USD) {
    return claimed.raw / volume > MAX_MCAP_TO_VOLUME_RATIO;
  }

  // Explicit near-zero print + eight-figure claim — hide (soft demote is not enough).
  return volume < DEAD_MARKET_MIN_VOLUME_USD && claimed.raw >= DEAD_MARKET_HUGE_CAP_USD;
}

/**
 * Single trust gate for USD market-cap display / ranking.
 * Returns `null` when the API figure must not be shown in any list position.
 */
export function trustJettonMarketCapUsd(input: MarketCapTrustInput): number | null {
  const claimed = claimedMarketCapUsd(input.market_stats);
  if (!claimed) return null;
  const { raw, hasMcap, hasFdmc } = claimed;

  if (input.verification === "WHITELISTED") return raw;

  const stats = input.market_stats;
  const tvl = readNonNegative(stats?.tvl_usd);
  const volume = readNonNegative(stats?.volume_usd_24h);

  if (tvl < MIN_TVL_FOR_ANY_LARGE_CAP_USD) {
    return raw <= SMALL_CAP_WITHOUT_LIQUIDITY_USD ? raw : null;
  }

  if (raw / tvl > MAX_MCAP_TO_TVL_RATIO) return null;

  if (raw >= HUGE_CAP_USD && tvl < MIN_TVL_FOR_HUGE_CAP_USD) return null;
  if (raw >= HUGE_CAP_USD && volume < MIN_VOLUME_FOR_HUGE_CAP_USD) return null;
  if (raw >= LARGE_CAP_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) return null;

  // FDMC-only + thin pool → classic max-supply fantasy.
  if (!hasMcap && hasFdmc && raw > SMALL_CAP_WITHOUT_LIQUIDITY_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) {
    return null;
  }

  // No 24h volume but claiming eight-figure+ size on a tiny pool.
  if (volume < DEAD_MARKET_MIN_VOLUME_USD && raw >= DEAD_MARKET_HUGE_CAP_USD && tvl < MIN_TVL_FOR_LARGE_CAP_USD) {
    return null;
  }

  // Spot price × supply dwarfs what actually traded — not a real valuation.
  if (jettonFailsVolumeToMcapFilter(input)) return null;

  return raw;
}

/**
 * Sort key for choose-currency: full trusted mcap when turnover is healthy,
 * otherwise `volume × RANK_MCAP_TO_VOLUME_TARGET` so low-volume tokens sink
 * to a balanced place without jumping the list on fantasy supply×price.
 */
export function rankJettonMarketCapUsd(
  trustedCapUsd: number | null,
  volumeUsd24h: number | null | undefined,
): number {
  if (trustedCapUsd == null || !(trustedCapUsd > 0)) return 0;
  const volume = readNonNegative(volumeUsd24h);
  if (volume <= 0) {
    // Trusted but dead book — keep below any token with real flow.
    return Math.min(trustedCapUsd, SMALL_CAP_WITHOUT_LIQUIDITY_USD * 0.01);
  }
  const ratio = trustedCapUsd / volume;
  if (ratio <= RANK_MCAP_TO_VOLUME_TARGET) return trustedCapUsd;
  return Math.min(trustedCapUsd, volume * RANK_MCAP_TO_VOLUME_TARGET);
}

/** Resolve a displayable USD market cap for the choose-currency list. */
export function resolveJettonMarketCapUsd(jetton: SwapJetton): number | null {
  return trustJettonMarketCapUsd({
    verification: jetton.verification,
    market_stats: jetton.market_stats,
  });
}

/** Volume-adjusted sort score for the choose-currency list. */
export function resolveJettonMarketCapRankUsd(jetton: SwapJetton): number {
  const trusted = resolveJettonMarketCapUsd(jetton);
  return rankJettonMarketCapUsd(trusted, jetton.market_stats?.volume_usd_24h);
}
