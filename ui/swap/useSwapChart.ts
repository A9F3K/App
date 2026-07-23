import { useCallback, useEffect, useRef, useState } from "react";
import {
  SWAP_INTERVAL_TO_RESOLUTION,
  type SwapChartResolution,
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

export function useSwapChart(
  initialInterval: SwapIntervalKey = "m",
  options?: { deferInitialLoad?: boolean },
) {
  const [intervalKey, setIntervalKey] = useState<SwapIntervalKey>(initialInterval);
  const resolution = SWAP_INTERVAL_TO_RESOLUTION[intervalKey];

  const cachedOnInit = peekSwapChartSeriesCache(resolution);
  const [series, setSeries] = useState<NormalizedChartSeries | null>(cachedOnInit);
  const [isLoadingChart, setIsLoadingChart] = useState(!cachedOnInit);
  const [chartError, setChartError] = useState<string | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [marketStats, setMarketStats] = useState<SwapMarketStats | null>(null);

  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadChart = useCallback(
    async (isRetry: boolean) => {
      swapChartLog("hook_load_chart", {
        resolution,
        intervalKey,
        isRetry,
        attempt: retryCountRef.current + 1,
      });

      const hadCachedSeries = peekSwapChartSeriesCache(resolution) != null;
      if (!isRetry) {
        if (!hadCachedSeries) {
          setIsLoadingChart(true);
        }
        setChartError(null);
        retryCountRef.current = 0;
      }

      const result = await loadSwapChartSeriesCached(resolution);
      if (hadCachedSeries && result.ok) {
        swapChartLog("hook_load_cache_hit", {
          resolution,
          pointCount: result.series.points.length,
        });
      }
      if (!mountedRef.current) {
        swapChartLog("hook_unmounted_after_fetch", { resolution, ok: result.ok });
        return;
      }

      if (result.ok) {
        swapChartLog("hook_load_success", {
          resolution,
          pointCount: result.series.points.length,
        });
        setSeries(result.series);
        setSelectedPointIndex(null);
        setIsLoadingChart(false);
        setChartError(null);
        retryCountRef.current = 0;
        return;
      }

      swapChartWarn("hook_load_failed", {
        resolution,
        error: result.error,
        retryable: result.retryable,
        retryCount: retryCountRef.current,
      });

      if (result.retryable && retryCountRef.current < chartMaxRetries()) {
        retryCountRef.current += 1;
        const delay = chartRetryDelayMs(retryCountRef.current);
        setChartError(`${result.error} Retrying in ${Math.round(delay / 1000)}s…`);
        swapChartLog("hook_scheduled_retry", { delayMs: delay, attempt: retryCountRef.current });
        setTimeout(() => {
          if (mountedRef.current) void loadChart(true);
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
    if (options?.deferInitialLoad) {
      let retryId: ReturnType<typeof setTimeout> | null = null;
      const runLoad = () => {
        // Chart parse of 300+ points mid voice-dialog open freezes Close
        // (logs: swap_chart_parse_done overlapping voice_dialog_longtask).
        if (isVoiceDialogUiOpen()) {
          retryId = setTimeout(runLoad, 2_500);
          return;
        }
        void loadChart(false);
      };
      if (typeof requestIdleCallback === "function") {
        const idleId = requestIdleCallback(runLoad, { timeout: 2500 });
        return () => {
          cancelIdleCallback(idleId);
          if (retryId != null) clearTimeout(retryId);
        };
      }
      const timeoutId = setTimeout(runLoad, 1500);
      return () => {
        clearTimeout(timeoutId);
        if (retryId != null) clearTimeout(retryId);
      };
    }
    void loadChart(false);
  }, [loadChart, options?.deferInitialLoad]);

  useEffect(() => {
    void fetchSwapMarketStats().then((stats) => {
      if (mountedRef.current) setMarketStats(stats);
    });
  }, []);

  const effectiveTonPriceUsd =
    series?.points.length && series.points[series.points.length - 1]
      ? series.points[series.points.length - 1]!.price
      : marketStats?.priceUsd ?? null;

  useEffect(() => {
    swapChartLog("hook_state", {
      intervalKey,
      resolution,
      isLoadingChart,
      chartError,
      pointCount: series?.points.length ?? 0,
      effectiveTonPriceUsd,
      hasMarketStats: marketStats != null,
    });
  }, [
    intervalKey,
    resolution,
    isLoadingChart,
    chartError,
    series,
    effectiveTonPriceUsd,
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
    effectiveTonPriceUsd,
    reloadChart: () => loadChart(false),
  };
}
