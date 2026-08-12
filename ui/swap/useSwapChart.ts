import { useCallback, useEffect, useRef, useState } from "react";
import {
  SWAP_INTERVAL_TO_RESOLUTION,
  TON_JETTON_ADDRESS,
  type SwapIntervalKey,
} from "./swapChartConstants";
import {
  chartMaxRetries,
  chartRetryDelayMs,
  fetchSwapMarketStats,
  type NormalizedChartSeries,
  type SwapMarketStats,
} from "./fetchSwapChart";
import { loadSwapChartSeriesCached, peekSwapChartSeriesCache } from "./swapChartSeriesCache";
import { swapChartLog, swapChartWarn } from "./swapChartDebug";
import { isVoiceDialogUiOpen } from "../components/messages/voiceDialogUiGate";

function normalizeChartJettonAddress(jettonAddress: string | null | undefined): string {
  const trimmed = jettonAddress?.trim() ?? "";
  return trimmed || TON_JETTON_ADDRESS;
}

export function useSwapChart(
  initialInterval: SwapIntervalKey = "m",
  options?: {
    /** Defer only the first enabled load (voice-dialog / idle). Later asset switches load immediately. */
    deferInitialLoad?: boolean;
    /** Chart / rate asset (defaults to native Gram). */
    jettonAddress?: string | null;
    /** When false, skip network loads (e.g. Currencies overlay covering the swap form). */
    enabled?: boolean;
  },
) {
  const jettonAddress = normalizeChartJettonAddress(options?.jettonAddress);
  const enabled = options?.enabled !== false;
  const deferInitialLoad = Boolean(options?.deferInitialLoad);

  const [intervalKey, setIntervalKey] = useState<SwapIntervalKey>(initialInterval);
  const resolution = SWAP_INTERVAL_TO_RESOLUTION[intervalKey];

  const cachedOnInit = peekSwapChartSeriesCache(jettonAddress, resolution);
  const [series, setSeries] = useState<NormalizedChartSeries | null>(cachedOnInit);
  const [isLoadingChart, setIsLoadingChart] = useState(enabled && !cachedOnInit);
  const [chartError, setChartError] = useState<string | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [marketStats, setMarketStats] = useState<SwapMarketStats | null>(null);

  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);
  const jettonAddressRef = useRef(jettonAddress);
  jettonAddressRef.current = jettonAddress;
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset visible series immediately when the selected asset or interval changes.
  useEffect(() => {
    const cached = peekSwapChartSeriesCache(jettonAddress, resolution);
    setSeries(cached);
    setSelectedPointIndex(null);
    setChartError(null);
    setIsLoadingChart(enabled && !cached);
    retryCountRef.current = 0;
  }, [jettonAddress, resolution, enabled]);

  useEffect(() => {
    setMarketStats(null);
  }, [jettonAddress]);

  const loadChart = useCallback(
    async (isRetry: boolean) => {
      const address = jettonAddressRef.current;
      swapChartLog("hook_load_chart", {
        jettonAddress: address,
        resolution,
        intervalKey,
        isRetry,
        attempt: retryCountRef.current + 1,
      });

      const hadCachedSeries = peekSwapChartSeriesCache(address, resolution) != null;
      if (!isRetry) {
        if (!hadCachedSeries) {
          setIsLoadingChart(true);
        }
        setChartError(null);
        retryCountRef.current = 0;
      }

      const result = await loadSwapChartSeriesCached(address, resolution);
      if (jettonAddressRef.current !== address) {
        swapChartLog("hook_stale_after_fetch", { jettonAddress: address });
        return;
      }
      if (hadCachedSeries && result.ok) {
        swapChartLog("hook_load_cache_hit", {
          jettonAddress: address,
          resolution,
          pointCount: result.series.points.length,
        });
      }
      if (!mountedRef.current) {
        swapChartLog("hook_unmounted_after_fetch", {
          jettonAddress: address,
          resolution,
          ok: result.ok,
        });
        return;
      }

      if (result.ok) {
        swapChartLog("hook_load_success", {
          jettonAddress: address,
          resolution,
          pointCount: result.series.points.length,
        });
        setSeries(result.series);
        setSelectedPointIndex(null);
        setIsLoadingChart(false);
        setChartError(null);
        retryCountRef.current = 0;
        hasLoadedOnceRef.current = true;
        return;
      }

      swapChartWarn("hook_load_failed", {
        jettonAddress: address,
        resolution,
        error: result.error,
        retryable: result.retryable,
        retryCount: retryCountRef.current,
      });

      if (result.retryable && retryCountRef.current < chartMaxRetries()) {
        retryCountRef.current += 1;
        const delay = chartRetryDelayMs(retryCountRef.current);
        setChartError(`${result.error} Retrying in ${Math.round(delay / 1000)}s…`);
        swapChartLog("hook_scheduled_retry", {
          delayMs: delay,
          attempt: retryCountRef.current,
          jettonAddress: address,
        });
        setTimeout(() => {
          if (mountedRef.current && jettonAddressRef.current === address) {
            void loadChart(true);
          }
        }, delay);
        return;
      }

      setSeries(null);
      setIsLoadingChart(false);
      setChartError(
        retryCountRef.current >= chartMaxRetries()
          ? `Failed to load chart after ${chartMaxRetries()} attempts. Please try again later.`
          : result.error,
      );
    },
    [intervalKey, resolution],
  );

  useEffect(() => {
    if (!enabled) return;

    const shouldDefer = deferInitialLoad && !hasLoadedOnceRef.current;
    if (shouldDefer) {
      let retryId: ReturnType<typeof setTimeout> | null = null;
      const runLoad = () => {
        if (isVoiceDialogUiOpen()) {
          retryId = setTimeout(runLoad, 2_500);
          return;
        }
        void loadChart(false);
      };
      if (typeof requestIdleCallback === "function") {
        const idleId = requestIdleCallback(runLoad, { timeout: 1200 });
        return () => {
          cancelIdleCallback(idleId);
          if (retryId != null) clearTimeout(retryId);
        };
      }
      const timeoutId = setTimeout(runLoad, 200);
      return () => {
        clearTimeout(timeoutId);
        if (retryId != null) clearTimeout(retryId);
      };
    }

    void loadChart(false);
  }, [loadChart, deferInitialLoad, jettonAddress, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const address = jettonAddress;
    let cancelled = false;
    void fetchSwapMarketStats(address).then((stats) => {
      if (!cancelled && mountedRef.current && jettonAddressRef.current === address) {
        setMarketStats(stats);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jettonAddress, enabled]);

  const effectivePriceUsd =
    series?.points.length && series.points[series.points.length - 1]
      ? series.points[series.points.length - 1]!.price
      : marketStats?.priceUsd ?? null;

  useEffect(() => {
    swapChartLog("hook_state", {
      jettonAddress,
      enabled,
      intervalKey,
      resolution,
      isLoadingChart,
      chartError,
      pointCount: series?.points.length ?? 0,
      effectivePriceUsd,
      hasMarketStats: marketStats != null,
    });
  }, [
    jettonAddress,
    enabled,
    intervalKey,
    resolution,
    isLoadingChart,
    chartError,
    series,
    effectivePriceUsd,
    marketStats,
  ]);

  return {
    intervalKey,
    setIntervalKey,
    resolution,
    series,
    isLoadingChart,
    chartError,
    selectedPointIndex,
    setSelectedPointIndex,
    marketStats,
    effectivePriceUsd,
    /** @deprecated Use {@link effectivePriceUsd}. */
    effectiveTonPriceUsd: effectivePriceUsd,
    reloadChart: () => loadChart(false),
  };
}
