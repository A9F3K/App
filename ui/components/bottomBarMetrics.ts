import { scrollIndicatorThumbSpanAndOffset } from "../scrollIndicatorPx";

export type ScrollbarMetrics = {
  indicatorHeight: number;
  topPosition: number;
};

export type BottomBarMetrics = {
  rawLines: number;
  barHeight: number;
  viewportHeight: number;
  contentHeightWithGaps: number;
  showScrollbar: boolean;
  scrollbar: ScrollbarMetrics;
};

type BottomBarMetricParams = {
  baseHeight: number;
  scrollY: number;
  lineHeight: number;
  innerPadding: number;
  maxLinesBeforeScroll: number;
  maxBarHeight: number;
  minBarHeight?: number;
  scrollRangeOverride?: number;
};

function getScrollbarMetrics(
  showScrollbar: boolean,
  viewportHeight: number,
  contentHeightWithGaps: number,
  barHeight: number,
  scrollY: number,
  scrollRange: number,
): ScrollbarMetrics {
  if (!showScrollbar || scrollRange <= 0 || contentHeightWithGaps <= 0) {
    return { indicatorHeight: 0, topPosition: 0 };
  }

  const { thumbSpan, thumbOffset } = scrollIndicatorThumbSpanAndOffset(
    barHeight,
    viewportHeight,
    contentHeightWithGaps,
    scrollY,
    scrollRange,
  );
  return { indicatorHeight: thumbSpan, topPosition: thumbOffset };
}

export function getBottomBarMetrics({
  baseHeight,
  scrollY,
  lineHeight,
  innerPadding,
  maxLinesBeforeScroll,
  maxBarHeight,
  minBarHeight = 59,
  scrollRangeOverride,
}: BottomBarMetricParams): BottomBarMetrics {
  const effectiveTextHeight = Math.max(0, baseHeight - innerPadding * 2);
  const rawLines = Math.max(1, Math.floor((effectiveTextHeight + lineHeight * 0.2) / lineHeight));
  const visibleLines = Math.min(rawLines, maxLinesBeforeScroll);
  const expandedHeight = innerPadding * 2 + visibleLines * lineHeight;
  /** One-line bar matches {@link layout.bottomBar.barMinHeight} and column inactive footers (59px). */
  const barHeight =
    visibleLines <= 1
      ? minBarHeight
      : Math.max(minBarHeight, Math.min(maxBarHeight, expandedHeight));
  const viewportHeight = barHeight;
  const contentHeightWithGaps = baseHeight;
  const scrollRange = Math.max(contentHeightWithGaps - viewportHeight, 0);
  /** Prefer the larger of mirror-based and live DOM ranges so a transient 0 DOM range cannot hide the thumb. */
  const effectiveScrollRange = Math.max(
    scrollRange,
    scrollRangeOverride != null && scrollRangeOverride > 0 ? scrollRangeOverride : 0,
  );
  /**
   * One-line bar is `minBarHeight` (59) while padded content is often ~60px — that 1px gap must not
   * show a thumb. Only scroll when text exceeds the expandable line cap.
   */
  const showScrollbar =
    rawLines > maxLinesBeforeScroll && effectiveScrollRange > 0.5;

  return {
    rawLines,
    barHeight,
    viewportHeight,
    contentHeightWithGaps,
    showScrollbar,
    scrollbar: getScrollbarMetrics(
      showScrollbar,
      viewportHeight,
      contentHeightWithGaps,
      barHeight,
      scrollY,
      effectiveScrollRange,
    ),
  };
}
