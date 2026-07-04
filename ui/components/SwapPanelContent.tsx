import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { SWAP_CHART_BLOCK_MIN_HEIGHT_PX } from "../swap/swapChartConstants";
import { swapChartLog } from "../swap/swapChartDebug";
import { useSwapChart } from "../swap/useSwapChart";
import { HspScrollColumn, type HspScrollMetrics } from "./HspScrollColumn";
import { SwapChartView } from "./swap/SwapChartView";
import { SwapFormBelowChart } from "./swap/SwapFormBelowChart";
import { SwapRateRow } from "./SwapRateRow";
import { SwapStatsRow } from "./SwapStatsRow";
import { layout } from "../theme";

const SCROLL_OVERFLOW_EPSILON_PX = 1;

function swapPanelNeedsScroll(fixedMinContentH: number, viewportH: number): boolean {
  return fixedMinContentH > viewportH + SCROLL_OVERFLOW_EPSILON_PX;
}

/** Swap panel body: rate row, stats, chart (min 55px line area), and buy/sell form. Scrolls when content exceeds viewport (footer bar excluded). */
export function SwapPanelContent() {
  const {
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
  } = useSwapChart("d", { deferInitialLoad: true });

  const { width: windowWidth } = useWindowDimensions();
  const showSwapActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  const [viewportH, setViewportH] = useState(0);
  /** Scroll column viewport — used for flex-fill `minHeight` (matches layout, not outer wrapper). */
  const [scrollViewportH, setScrollViewportH] = useState(0);
  /** `null` = one-time intrinsic measure; `false` = flex-fill chart; `true` = panel scroll. */
  const [needsScroll, setNeedsScroll] = useState<boolean | null>(null);
  const fixedMinContentHRef = useRef(0);
  const measureMetricsRef = useRef<HspScrollMetrics>({ layoutH: 0, contentH: 0 });
  const flexFillMode = needsScroll === false;

  useEffect(() => {
    swapChartLog("panel_mount", {
      swapFirstRowTopInsetPx: layout.authenticatedHome.swapFirstRowTopInsetPx,
      swapStatsRowTopGapPx: layout.authenticatedHome.swapStatsRowTopGapPx,
      swapChartTopGapPx: layout.authenticatedHome.swapChartTopGapPx,
    });
  }, []);

  useEffect(() => {
    fixedMinContentHRef.current = 0;
    measureMetricsRef.current = { layoutH: 0, contentH: 0 };
    setScrollViewportH(0);
    setNeedsScroll(null);
  }, [showSwapActionBlock]);

  const effectiveViewportH = scrollViewportH > 0 ? scrollViewportH : viewportH;

  useEffect(() => {
    if (effectiveViewportH <= 0 || fixedMinContentHRef.current <= 0 || needsScroll === null) return;
    const next = swapPanelNeedsScroll(fixedMinContentHRef.current, effectiveViewportH);
    setNeedsScroll(next);
    swapChartLog("panel_scroll_state", {
      viewportH: effectiveViewportH,
      layoutH: effectiveViewportH,
      contentH: fixedMinContentHRef.current,
      needsScroll: next,
      reason: "viewport_resize",
    });
  }, [effectiveViewportH, needsScroll]);

  const onViewportLayout = useCallback((e: LayoutChangeEvent) => {
    setViewportH(e.nativeEvent.layout.height);
  }, []);

  const commitScrollMode = useCallback(
    (next: boolean, reason: string) => {
      setNeedsScroll(next);
      swapChartLog("panel_scroll_state", {
        viewportH,
        layoutH: measureMetricsRef.current.layoutH || viewportH,
        contentH: fixedMinContentHRef.current,
        needsScroll: next,
        reason,
      });
    },
    [viewportH],
  );

  const onScrollMetrics = useCallback((metrics: HspScrollMetrics) => {
    measureMetricsRef.current = metrics;
    if (metrics.layoutH > 0) {
      setScrollViewportH((h) => (h === metrics.layoutH ? h : metrics.layoutH));
    }
    if (needsScroll !== null) return;
    if (metrics.layoutH <= 0 || metrics.contentH <= 0) return;

    fixedMinContentHRef.current =
      fixedMinContentHRef.current <= 0
        ? metrics.contentH
        : Math.min(fixedMinContentHRef.current, metrics.contentH);
  }, [needsScroll]);

  useLayoutEffect(() => {
    if (needsScroll !== null || effectiveViewportH <= 0) return;

    let cancelled = false;
    let frame = 0;
    let lastContentH = 0;
    let stableStreak = 0;

    const finish = () => {
      if (cancelled || fixedMinContentHRef.current <= 0) return;
      commitScrollMode(
        swapPanelNeedsScroll(fixedMinContentHRef.current, effectiveViewportH),
        "intrinsic_measure",
      );
    };

    const tick = () => {
      if (cancelled || needsScroll !== null) return;
      frame += 1;
      const contentH = fixedMinContentHRef.current;
      if (contentH <= 0) {
        if (frame < 12) requestAnimationFrame(tick);
        return;
      }

      if (contentH <= effectiveViewportH + SCROLL_OVERFLOW_EPSILON_PX) {
        finish();
        return;
      }

      if (contentH < lastContentH - SCROLL_OVERFLOW_EPSILON_PX) {
        lastContentH = contentH;
        stableStreak = 0;
        if (frame < 12) requestAnimationFrame(tick);
        return;
      }

      if (lastContentH > 0 && Math.abs(contentH - lastContentH) <= SCROLL_OVERFLOW_EPSILON_PX) {
        stableStreak += 1;
      } else {
        lastContentH = contentH;
        stableStreak = 0;
      }

      if (stableStreak >= 1 || frame >= 12) {
        finish();
        return;
      }

      requestAnimationFrame(tick);
    };

    lastContentH = fixedMinContentHRef.current;
    const id = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [needsScroll, effectiveViewportH, commitScrollMode]);

  const ah = layout.authenticatedHome;
  const contentInset = layout.contentSideInsetPx;
  /** Bleed scroll shell to column/screen edge so the thumb uses {@link layout.scrollIndicatorRightInsetPx} like welcome `/`. */
  const scrollShellBleed = { marginHorizontal: -contentInset };
  const scrollContentPadding = {
    paddingTop: ah.swapFirstRowTopInsetPx,
    paddingHorizontal: contentInset,
  };
  const flexFillMinHeight = scrollViewportH > 0 ? scrollViewportH : effectiveViewportH;

  const displayTonPriceUsd =
    selectedPointIndex != null &&
    series &&
    selectedPointIndex >= 0 &&
    selectedPointIndex < series.points.length
      ? series.points[selectedPointIndex]!.price
      : effectiveTonPriceUsd;

  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        alignSelf: "stretch",
        minHeight: 0,
      }}
      onLayout={onViewportLayout}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        scrollEnabled={needsScroll === true}
        onMetricsChange={onScrollMetrics}
        contentContainerStyle={
          flexFillMode
            ? {
                ...scrollContentPadding,
                flexGrow: 1,
                ...(flexFillMinHeight > 0 ? { minHeight: flexFillMinHeight } : {}),
              }
            : scrollContentPadding
        }
      >
        <SwapRateRow
          intervalKey={intervalKey}
          onIntervalKeyChange={setIntervalKey}
          tonPriceUsd={displayTonPriceUsd}
        />
        <View style={{ marginTop: layout.authenticatedHome.swapStatsRowTopGapPx }}>
          <SwapStatsRow marketStats={marketStats} />
        </View>
        <View
          style={{
            marginTop: layout.authenticatedHome.swapChartTopGapPx,
            minHeight: SWAP_CHART_BLOCK_MIN_HEIGHT_PX,
            ...(flexFillMode ? { flex: 1 } : null),
          }}
        >
          <SwapChartView
            resolution={resolution}
            intervalKey={intervalKey}
            onIntervalKeyChange={setIntervalKey}
            series={series}
            isLoading={isLoadingChart}
            error={chartError}
            selectedPointIndex={selectedPointIndex}
            onSelectedPointIndexChange={setSelectedPointIndex}
            expandToFill={flexFillMode}
          />
        </View>
        <SwapFormBelowChart effectiveTonPriceUsd={displayTonPriceUsd} />
      </HspScrollColumn>
    </View>
  );
}
