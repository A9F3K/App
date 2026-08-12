import {
  fetchJettonChartSeries,
  type NormalizedChartSeries,
} from "./fetchSwapChart";
import type { SwapChartResolution } from "./swapChartConstants";
import { TON_JETTON_ADDRESS } from "./swapChartConstants";

type ChartResult =
  | { ok: true; series: NormalizedChartSeries }
  | { ok: false; error: string; retryable: boolean };

function cacheKey(jettonAddress: string, resolution: SwapChartResolution): string {
  return `${jettonAddress.trim().toLowerCase()}|${resolution}`;
}

const seriesCache = new Map<string, NormalizedChartSeries>();
const inFlight = new Map<string, Promise<ChartResult>>();

function normalizeChartAddress(jettonAddress: string): string {
  const trimmed = jettonAddress.trim();
  if (!trimmed) return TON_JETTON_ADDRESS;
  return trimmed;
}

/** Dedupes Dyor fetches across SwapPanel remounts and caches by address+resolution. */
export async function loadSwapChartSeriesCached(
  jettonAddress: string,
  resolution: SwapChartResolution,
): Promise<ChartResult> {
  const address = normalizeChartAddress(jettonAddress);
  const key = cacheKey(address, resolution);
  const cached = seriesCache.get(key);
  if (cached) {
    return { ok: true, series: cached };
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchJettonChartSeries(address, resolution).then((result) => {
    inFlight.delete(key);
    if (result.ok) {
      seriesCache.set(key, result.series);
    }
    return result;
  });
  inFlight.set(key, promise);
  return promise;
}

export function peekSwapChartSeriesCache(
  jettonAddress: string,
  resolution: SwapChartResolution,
): NormalizedChartSeries | null {
  const address = normalizeChartAddress(jettonAddress);
  return seriesCache.get(cacheKey(address, resolution)) ?? null;
}

/** @deprecated Prefer address-aware {@link loadSwapChartSeriesCached}. */
export async function loadTonSwapChartSeriesCached(
  resolution: SwapChartResolution,
): Promise<ChartResult> {
  return loadSwapChartSeriesCached(TON_JETTON_ADDRESS, resolution);
}
