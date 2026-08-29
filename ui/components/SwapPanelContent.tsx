import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import {
  openSwapCurrenciesBrowse,
  useSwapCurrencyPicker,
} from "../swap/swapCurrencyPicker";
import { SWAP_CHART_BLOCK_MIN_HEIGHT_PX } from "../swap/swapChartConstants";
import { swapChartLog } from "../swap/swapChartDebug";
import { useSwapChart } from "../swap/useSwapChart";
import { useSwapQuote } from "../swap/useSwapQuote";
import { useSwapPairState } from "../swap/swapPairStore";
import {
  swapChartTokenForPair,
  swapTokenChartAddress,
  swapTokenDisplaySymbol,
} from "../swap/swapPairTypes";
import { HspScrollColumn, type HspScrollMetrics } from "./HspScrollColumn";
import { PanelGradientCtaBlock } from "./PanelGradientCtaBlock";
import { SwapChartView } from "./swap/SwapChartView";
import { SwapFormBelowChart } from "./swap/SwapFormBelowChart";
import { SwapPanelHeader } from "./swap/SwapPanelHeader";
import { SwapActionRow } from "./swap/SwapActionRow";
import { SwapRateRow } from "./SwapRateRow";
import { SwapStatsRow } from "./SwapStatsRow";
import { layout } from "../theme";

const SCROLL_OVERFLOW_EPSILON_PX = 1;

function swapPanelNeedsScroll(fixedMinContentH: number, viewportH: number): boolean {
  return fixedMinContentH > viewportH + SCROLL_OVERFLOW_EPSILON_PX;
}

/** Swap panel body: rate row, stats, chart (min 55px line area), and buy/sell form. Scrolls when content exceeds viewport (footer bar excluded). */
export function SwapPanelContent() {
  const pickerMode = useSwapCurrencyPicker();
  const swapFormVisible = pickerMode == null;
  const { sellToken, buyToken } = useSwapPairState();
  useSwapQuote();
  const chartToken = useMemo(
    () => swapChartTokenForPair(sellToken, buyToken),
    [buyToken, sellToken],
  );
  const chartJettonAddress = swapTokenChartAddress(chartToken);

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
    effectivePriceUsd,
  } = useSwapChart("d", {
    jettonAddress: chartJettonAddress,
    enabled: swapFormVisible,
    deferInitialLoad: true,
  });

  useEffect(() => {
    swapChartLog("panel_pair", {
      sell: sellToken.symbol,
      buy: buyToken.symbol,
      chartSymbol: chartToken.symbol,
      chartJettonAddress,
      swapFormVisible,
    });
  }, [
    sellToken.symbol,
    buyToken.symbol,
    chartToken.symbol,
    chartJettonAddress,
    swapFormVisible,
  ]);

  const { width: windowWidth } = useWindowDimensions();
  const showSwapActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  const [viewportH, setViewportH] = useState(0);
  /** Scroll column viewport — used for flex-fill `minHeight` (matches layout, not outer wrapper). */
  const [scrollViewportH, setScrollViewportH] = useState(0);
  /** `null` = one-time intrinsic measure; `false` = flex-fill chart; `true` = panel scroll. */
  const [needsScroll, setNeedsScroll] = useState<boolean | null>(null);
  const [ctaHeightPx, setCtaHeightPx] = useState(0);
  /** Peak intrinsic content height (never shrink on flex-fill equalization). */
  const intrinsicContentHRef = useRef(0);
  const measureMetricsRef = useRef<Omit<HspScrollMetrics, "scrollY">>({ layoutH: 0, contentH: 0 });
  const flexFillMode = needsScroll === false;

  useEffect(() => {
    swapChartLog("panel_mount", {
      swapFirstRowTopInsetPx: layout.authenticatedHome.swapFirstRowTopInsetPx,
      swapStatsRowTopGapPx: layout.authenticatedHome.swapStatsRowTopGapPx,
      swapChartTopGapPx: layout.authenticatedHome.swapChartTopGapPx,
    });
  }, []);

  useEffect(() => {
    intrinsicContentHRef.current = 0;
    measureMetricsRef.current = { layoutH: 0, contentH: 0 };
    setScrollViewportH(0);
    setNeedsScroll(null);
  }, [showSwapActionBlock, chartJettonAddress, swapFormVisible]);

  const effectiveViewportH = scrollViewportH > 0 ? scrollViewportH : viewportH;

  useEffect(() => {
    if (effectiveViewportH <= 0 || needsScroll === null) return;
    const contentH = intrinsicContentHRef.current;
    if (contentH <= 0) return;
    const next = swapPanelNeedsScroll(contentH, effectiveViewportH);
    if (next === needsScroll) return;
    setNeedsScroll(next);
    swapChartLog("panel_scroll_state", {
      viewportH: effectiveViewportH,
      layoutH: effectiveViewportH,
      contentH,
      needsScroll: next,
      reason: "viewport_resize",
    });
  }, [effectiveViewportH, needsScroll]);

  const onViewportLayout = useCallback((e: LayoutChangeEvent) => {
    setViewportH(e.nativeEvent.layout.height);
  }, []);

  const onCtaHeightChange = useCallback((heightPx: number) => {
    setCtaHeightPx((current) => (current === heightPx ? current : heightPx));
  }, []);

  const commitScrollMode = useCallback(
    (next: boolean, reason: string) => {
      setNeedsScroll(next);
      swapChartLog("panel_scroll_state", {
        viewportH,
        layoutH: measureMetricsRef.current.layoutH || viewportH,
        contentH: intrinsicContentHRef.current,
        needsScroll: next,
        reason,
      });
    },
    [viewportH],
  );

  const onScrollMetrics = useCallback(
    (metrics: Omit<HspScrollMetrics, "scrollY">) => {
      measureMetricsRef.current = metrics;
      if (metrics.layoutH > 0) {
        setScrollViewportH((h) => (h === metrics.layoutH ? h : metrics.layoutH));
      }
      if (metrics.layoutH > 0 && metrics.contentH > 0) {
        const liveOverflow =
          metrics.contentH > metrics.layoutH + SCROLL_OVERFLOW_EPSILON_PX;
        if (liveOverflow) {
          intrinsicContentHRef.current = Math.max(
            intrinsicContentHRef.current,
            metrics.contentH,
          );
          if (needsScroll !== true) {
            commitScrollMode(true, "live_overflow");
            return;
          }
        } else if (intrinsicContentHRef.current <= 0) {
          intrinsicContentHRef.current = metrics.contentH;
        }
      }
      if (needsScroll !== null) return;
      if (metrics.layoutH <= 0 || metrics.contentH <= 0) return;

      intrinsicContentHRef.current = Math.max(
        intrinsicContentHRef.current,
        metrics.contentH,
      );
    },
    [commitScrollMode, needsScroll],
  );

  useLayoutEffect(() => {
    if (needsScroll !== null || effectiveViewportH <= 0) return;

    let cancelled = false;
    let frame = 0;
    let lastContentH = 0;
    let stableStreak = 0;

    const finish = () => {
      if (cancelled || intrinsicContentHRef.current <= 0) return;
      commitScrollMode(
        swapPanelNeedsScroll(intrinsicContentHRef.current, effectiveViewportH),
        "intrinsic_measure",
      );
    };

    const tick = () => {
      if (cancelled || needsScroll !== null) return;
      frame += 1;
      const contentH = intrinsicContentHRef.current;
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

    lastContentH = intrinsicContentHRef.current;
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

  const displayPriceUsd =
    selectedPointIndex != null &&
    series &&
    selectedPointIndex >= 0 &&
    selectedPointIndex < series.points.length
      ? series.points[selectedPointIndex]!.price
      : effectivePriceUsd;

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
      <View style={scrollShellBleed}>
        <SwapPanelHeader onCurrenciesPress={openSwapCurrenciesBrowse} />
      </View>
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        scrollEnabled={needsScroll !== false}
        onMetricsChange={onScrollMetrics}
        scrollIndicatorExtendBottomPx={showSwapActionBlock ? ctaHeightPx : 0}
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
          priceUsd={displayPriceUsd}
          assetSymbol={swapTokenDisplaySymbol(chartToken)}
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
          {/* Remount when the selected asset changes or the form leaves display:none
              so layout is not stuck at width=0 from the Currencies overlay. */}
          {swapFormVisible ? (
            <SwapChartView
              key={chartJettonAddress}
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
          ) : null}
        </View>
        <SwapFormBelowChart
          effectivePriceUsd={displayPriceUsd}
          showActionBlock={false}
        />
      </HspScrollColumn>
      {showSwapActionBlock ? (
        <PanelGradientCtaBlock onHeightChange={onCtaHeightChange}>
          <SwapActionRow />
        </PanelGradientCtaBlock>
      ) : null}
    </View>
  );
}
