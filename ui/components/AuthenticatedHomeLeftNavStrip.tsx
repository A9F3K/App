import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { logPageDisplay } from "../pageDisplayLog";
import { layout, type ThemeColors } from "../theme";
import { scrollIndicatorThumbSpanAndOffset } from "../scrollIndicatorPx";
import { ScrollIndicatorDragHandle } from "./ScrollIndicatorDragHandle";
import { useAuthenticatedHomeSplitLayoutMetrics } from "./AuthenticatedHomeSplitLayoutMetricsContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import type { AppStringKey } from "../../locales/appStrings";
import { getAppString } from "../../locales/appStrings";

const NAV_IDS = ["feed", "messages", "tasks", "items", "coins"] as const;

const AH = layout.authenticatedHome;

/** Total strip height including vertical inner padding. */
const STRIP_HEIGHT_PX = 55;
/** Vertical padding inside strip; horizontal inset is visual-only via edge fades (no horizontal padding on scroll). */
const STRIP_PADDING_PX = layout.contentSideInsetPx;
const INNER_SCROLL_HEIGHT_PX = STRIP_HEIGHT_PX - STRIP_PADDING_PX * 2;
const ITEM_GAP_PX = layout.contentSideInsetPx;
const LABEL_FONT_SIZE = 20;
const LABEL_LINE_HEIGHT = 15;
const SCROLL_EPS = 2;
/**
 * When `fits` flips due to web layout jitter, `justifyContent` / `scrollEnabled` toggle and the strip
 * snaps back. Sticky overflow stays in scroll mode until the row clearly fits with margin.
 */
const NAV_STRIP_OVERFLOW_LOCK_PX = SCROLL_EPS;
const NAV_STRIP_OVERFLOW_CLEAR_MARGIN_PX = 8;
/** Both horizontal content insets on the strip (`contentSideInsetPx` × 2); matches “width minus 30px” in layout copy. */
const NAV_STRIP_HORIZONTAL_INSET_TOTAL_PX = STRIP_PADDING_PX * 2;
/**
 * Fallback width before the label row’s first `onLayout` (and for scroll-range padding). Slightly
 * conservative vs average glyph width so we don’t prefer scroll mode when the real row is narrower.
 * Once the label row reports `onLayout`, use that width instead (see `stripContentWidthPx`).
 */
const ESTIMATED_NAV_STRIP_CONTENT_W_PX = (() => {
  const charPx = LABEL_FONT_SIZE * 0.82;
  let w = STRIP_PADDING_PX * 2;
  for (let i = 0; i < NAV_IDS.length; i++) {
    const key = `home.nav.${NAV_IDS[i]}` as AppStringKey;
    const labelLen = Math.max(getAppString("en", key).length, getAppString("ru", key).length);
    w += labelLen * charPx;
    if (i < NAV_IDS.length - 1) w += ITEM_GAP_PX;
  }
  return Math.ceil(w);
})();

/**
 * Rule thickness in layout units: one **device** pixel (hairline).
 * A `1` css px / 1 dp bar maps to several physical pixels on phones, so it reads as a thick band
 * (often worse in single-column / full-width mobile layouts). This matches ~StyleSheet.hairlineWidth
 * intent but stays consistent with {@link snapToPixelGrid} math on web.
 */
function menuStripRuleThickness(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

/**
 * Snap layout coordinates/sizes to the device pixel grid so 1px borders render crisp (no blur between pixels).
 */
function snapToPixelGrid(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      const dpr = window.devicePixelRatio;
      return Math.round(n * dpr) / dpr;
    }
    return Math.round(n);
  }
  return PixelRatio.roundToNearestPixel(n);
}

function windowInferredSplitColumnCount(windowWidthPx: number): 1 | 2 | 3 {
  if (windowWidthPx <= AH.firstBreakpoint) return 1;
  if (windowWidthPx <= AH.secondBreakpoint) return 2;
  return 3;
}

/** RN-web horizontal ScrollView often reports total scroll span in `contentSize.height` instead of `.width`. */
/**
 * RN-web: choose the horizontal scroller under the strip root. Prefer nodes whose `clientWidth`
 * matches the measured strip viewport (avoids grabbing an outer page column); among those, prefer the
 * **smallest `scrollWidth`** (tightest inner content track vs a wide outer wrapper).
 */
function pickWebNavStripScrollEl(root: Element | null, viewportWidthPx: number): HTMLElement | null {
  if (!root || typeof window === "undefined") return null;
  const candidates: HTMLElement[] = [];
  const collect = (el: Element) => {
    const h = el as HTMLElement;
    if (h.scrollWidth - h.clientWidth > 2 && h.clientWidth > 0) {
      candidates.push(h);
    }
    for (let i = 0; i < el.children.length; i++) {
      collect(el.children[i]);
    }
  };
  collect(root);
  if (candidates.length === 0) return null;
  const vw = viewportWidthPx;
  const matchesViewport = (h: HTMLElement) => vw > 0 && Math.abs(h.clientWidth - vw) <= 20;
  const pool = vw > 0 ? candidates.filter(matchesViewport) : [];
  const pickFrom = pool.length > 0 ? pool : candidates;
  return pickFrom.reduce((a, b) => (a.scrollWidth <= b.scrollWidth ? a : b));
}

function scrollSpanFromContentSizeEvent(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (Platform.OS === "web") {
    return Math.max(w, h);
  }
  return w;
}

export function AuthenticatedHomeLeftNavStrip({
  colors,
  selectedIndex: selectedIndexProp,
  onSelectIndex,
}: {
  colors: ThemeColors;
  /** Controlled mode: parent owns which tab is highlighted. */
  selectedIndex?: number;
  onSelectIndex?: (index: number) => void;
}) {
  const { t, locale } = useAppStrings();
  const { width: windowWidth } = useWindowDimensions();
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  /**
   * When mounted under {@link AuthenticatedHomeSplitBody}, chrome follows **split column count** (2+ =
   * wide menu with bottom hairline, no extra top margin). Otherwise fall back to window width vs
   * `firstBreakpoint` (e.g. strip reused outside split).
   */
  const chromeFromSplit = splitMetrics !== null;
  /** Same predicate as split body `isWide`: never treat narrow split rows as wide when `rowWidth` lags `windowWidth`. */
  const layoutIsWide = chromeFromSplit
    ? splitMetrics.effectiveSplitWidthPx > AH.firstBreakpoint
    : windowWidth > AH.firstBreakpoint;
  /**
   * Width budget for “labels + horizontal padding + gaps” (see {@link ESTIMATED_NAV_STRIP_CONTENT_W_PX}):
   * full window in single-column, first column width when `columnCount >= 2`. Matches screen vs column
   * minus the two side inset rects ({@link NAV_STRIP_HORIZONTAL_INSET_TOTAL_PX} inside the strip).
   */
  const navStripBudgetWidthPx = chromeFromSplit
    ? Math.round(
        splitMetrics.columnCount >= 2 && splitMetrics.firstColumnWidthPx > 0
          ? splitMetrics.firstColumnWidthPx
          : splitMetrics.effectiveSplitWidthPx,
      )
    : Math.round(windowWidth);
  const stripMarginTop =
    chromeFromSplit && splitMetrics.columnCount >= 2
      ? 0
      : chromeFromSplit
        ? AH.leftNavStripMarginTopPx
        : layoutIsWide
          ? 0
          : AH.leftNavStripMarginTopPx;
  /** Bottom hairline under Feed/Messages/… — full strip width in every layout (music-bar track). */
  const showBottomMenuRule = true;

  const fadeGradientIdRight = useId().replace(/[^a-zA-Z0-9_-]/g, "_");
  const fadeGradientIdLeft = useId().replace(/[^a-zA-Z0-9_-]/g, "_");
  const [internalIndex, setInternalIndex] = useState(0);
  const isControlled = selectedIndexProp !== undefined;
  const activeIndex = isControlled ? (selectedIndexProp as number) : internalIndex;
  const [scrollX, setScrollX] = useState(0);
  const [layoutW, setLayoutW] = useState(0);
  const [contentW, setContentW] = useState(0);
  /** RN-web often reports `contentSize.width` ≈ row layout while the DOM scrollWidth is larger; infer min span from max offset seen. */
  const maxScrollXSeenRef = useRef(0);
  /** Once strip overflows viewport, keep scroll layout until it clearly fits (see {@link NAV_STRIP_OVERFLOW_CLEAR_MARGIN_PX}). */
  const navStripOverflowStickyRef = useRef(false);
  /** Labels + gaps only (excludes `paddingHorizontal` on the scroll content container). */
  const [intrinsicRowW, setIntrinsicRowW] = useState(0);
  const [outerW, setOuterW] = useState(0);
  /** RN-web: real horizontal scroll width from DOM when `contentSize` understates `scrollWidth`. */
  const [domHScrollSpanPx, setDomHScrollSpanPx] = useState(0);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);

  const lineT = menuStripRuleThickness();
  /** Edge fades; matches `contentSideInsetPx` (15px) in theme. */
  const fadeW = AH.leftNavStripRightFadeWidthPx;
  /** Thumb sits on the divider (music seek bar), not above it. */
  const thumbBottomSnapped = 0;

  const onOuterLayout = useCallback((e: LayoutChangeEvent) => {
    setOuterW(Math.round(e.nativeEvent.layout.width));
  }, []);

  const syncHorizontalScrollFromNativeEvent = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const ne = e.nativeEvent;
      let x = ne.contentOffset.x;
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const root =
          document.getElementById("ah-nav-strip-hscroll") ??
          document.querySelector('[data-testid="ah-nav-strip-hscroll"]') ??
          document.querySelector(".ah-nav-strip-hscroll");
        const scrollEl = pickWebNavStripScrollEl(root, layoutW);
        if (scrollEl && typeof scrollEl.scrollLeft === "number") {
          /** Synthetic `contentOffset.x` often decays after lift; DOM `scrollLeft` matches visible items. */
          x = Math.round(scrollEl.scrollLeft);
          const sw = Math.round(scrollEl.scrollWidth);
          if (sw > 0) {
            setDomHScrollSpanPx((prev) => (prev === sw ? prev : sw));
          }
        }
      }
      if (x > maxScrollXSeenRef.current) {
        maxScrollXSeenRef.current = x;
      }
      const cs = ne.contentSize;
      const spanPx = scrollSpanFromContentSizeEvent(cs?.width ?? 0, cs?.height ?? 0);
      if (spanPx > 0) {
        const rounded = Math.round(spanPx);
        setContentW((prev) => (prev === rounded ? prev : rounded));
      }
      setScrollX(x);
    },
    [layoutW],
  );

  /** RN-web: after gestures, synthetic `onScroll` contentOffset can drift below real `scrollLeft`; re-read DOM. */
  const syncHorizontalScrollFromDomWeb = useCallback(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root =
          document.getElementById("ah-nav-strip-hscroll") ??
          document.querySelector('[data-testid="ah-nav-strip-hscroll"]') ??
          document.querySelector(".ah-nav-strip-hscroll");
        const node = pickWebNavStripScrollEl(root, layoutW);
        if (!node || typeof node.scrollLeft !== "number") return;
        const sw = Math.round(node.scrollWidth);
        if (sw > 0) {
          setDomHScrollSpanPx((prev) => (prev === sw ? prev : sw));
        }
        const x = Math.round(node.scrollLeft);
        if (x > maxScrollXSeenRef.current) {
          maxScrollXSeenRef.current = x;
        }
        setScrollX(x);
      });
    });
  }, [layoutW]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      syncHorizontalScrollFromNativeEvent(e);
    },
    [syncHorizontalScrollFromNativeEvent],
  );

  const onHorizontalScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      syncHorizontalScrollFromNativeEvent(e);
      syncHorizontalScrollFromDomWeb();
    },
    [syncHorizontalScrollFromNativeEvent, syncHorizontalScrollFromDomWeb],
  );

  const onScrollViewLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setLayoutW((prev) => {
      if (prev !== w) {
        setContentW(0);
        setDomHScrollSpanPx(0);
        maxScrollXSeenRef.current = 0;
      }
      return w;
    });
  }, []);

  const onContentSizeChange = useCallback((w: number, h: number) => {
    const spanPx = scrollSpanFromContentSizeEvent(w, h);
    if (spanPx <= 0) return;
    const rounded = Math.round(spanPx);
    // Allow shrink when locale/label width drops (monotonic max kept a stale English scrollWidth).
    setContentW((prev) => (prev === rounded ? prev : rounded));
  }, []);

  const onIntrinsicRowLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setIntrinsicRowW((prev) => {
      if (prev === w) return prev;
      // Labels got narrower (locale change) — drop inflated scroll spans so fits/center can recover.
      if (prev > 0 && w < prev) {
        setContentW(0);
        setDomHScrollSpanPx(0);
        maxScrollXSeenRef.current = 0;
        navStripOverflowStickyRef.current = false;
      }
      return w;
    });
  }, []);

  /** Locale change remounts label strings; reset sticky overflow from the previous language. */
  useEffect(() => {
    setContentW(0);
    setDomHScrollSpanPx(0);
    maxScrollXSeenRef.current = 0;
    navStripOverflowStickyRef.current = false;
    setScrollX(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [locale]);

  /**
   * Scroll viewport width: measured `ScrollView` width when available, else budget from split/window
   * so fits/scroll state match the column (wide) or screen (compact) before first layout.
   */
  const scrollViewportW =
    layoutW > 0 ? layoutW : navStripBudgetWidthPx > 0 ? navStripBudgetWidthPx : 0;
  /** Total scroll content width: padding + measured label row (preferred) or `ESTIMATED_NAV_STRIP_CONTENT_W_PX`. */
  const stripContentWidthPx =
    intrinsicRowW > 0
      ? NAV_STRIP_HORIZONTAL_INSET_TOTAL_PX + intrinsicRowW
      : ESTIMATED_NAV_STRIP_CONTENT_W_PX;
  if (scrollViewportW > 0) {
    const overBy = stripContentWidthPx - scrollViewportW;
    // Prefer intrinsic fit: clear sticky when labels clearly fit. Do not keep sticky solely because
    // the user once scrolled longer English/Russian labels (maxScrollXSeen never cleared).
    if (stripContentWidthPx < scrollViewportW - NAV_STRIP_OVERFLOW_CLEAR_MARGIN_PX) {
      navStripOverflowStickyRef.current = false;
      if (maxScrollXSeenRef.current > 0) {
        maxScrollXSeenRef.current = 0;
      }
    } else if (overBy > NAV_STRIP_OVERFLOW_LOCK_PX) {
      navStripOverflowStickyRef.current = true;
    }
  }
  const fits =
    scrollViewportW > 0 &&
    stripContentWidthPx <= scrollViewportW + SCROLL_EPS &&
    !navStripOverflowStickyRef.current;
  /**
   * Scroll span for thumb/range: prefer **measured** widths only. Including `ESTIMATED_NAV_STRIP_CONTENT_W_PX`
   * or uncapped `maxScrollXSeen` inflates `scrollRange` (e.g. 158 vs real 9px), so the thumb tracks
   * rubber-band `scrollX` then snaps back when the real range is tiny.
   * Cap inflated DOM/contentSize against the intrinsic label row once measured.
   */
  const intrinsicScrollCapPx =
    intrinsicRowW > 0 ? NAV_STRIP_HORIZONTAL_INSET_TOTAL_PX + intrinsicRowW : 0;
  const cappedContentW =
    contentW > 0 && intrinsicScrollCapPx > 0
      ? Math.min(contentW, Math.max(intrinsicScrollCapPx, stripContentWidthPx))
      : contentW;
  const cappedDomHScrollSpanPx =
    domHScrollSpanPx > 0 && intrinsicScrollCapPx > 0
      ? Math.min(domHScrollSpanPx, Math.max(intrinsicScrollCapPx, stripContentWidthPx))
      : domHScrollSpanPx;
  const rawMeasuredScrollSpanPx = Math.max(
    cappedContentW > 0 ? cappedContentW : 0,
    stripContentWidthPx,
    cappedDomHScrollSpanPx > 0 ? cappedDomHScrollSpanPx : 0,
    intrinsicRowW <= 0 && contentW <= 0 && domHScrollSpanPx <= 0 ? ESTIMATED_NAV_STRIP_CONTENT_W_PX : 0,
  );
  const theoryMaxScrollOffsetPx = Math.max(0, rawMeasuredScrollSpanPx - scrollViewportW);
  const clampedMaxSeenScrollX = Math.min(maxScrollXSeenRef.current, theoryMaxScrollOffsetPx);
  const scrollSpanInferredFromObservedOffsetPx =
    scrollViewportW > 0 ? scrollViewportW + clampedMaxSeenScrollX : 0;
  const scrollContentSpanPx =
    !fits && scrollViewportW > 0
      ? Math.max(rawMeasuredScrollSpanPx, scrollSpanInferredFromObservedOffsetPx)
      : 0;

  const scrollRange = Math.max(0, scrollContentSpanPx - scrollViewportW);
  /**
   * Stable identity avoids RN-web resetting scroll when unrelated parent state updates pass new object
   * literals every render.
   */
  const navScrollContentContainerStyle = useMemo(
    (): ViewStyle => ({
      paddingHorizontal: STRIP_PADDING_PX,
      flexGrow: fits ? 1 : 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: fits ? "center" : "flex-start",
      minWidth: fits && scrollViewportW > 0 ? scrollViewportW : undefined,
    }),
    [fits, scrollViewportW],
  );
  /**
   * Thumb track must match the same client width as `scrollViewportW` so the thumb crosses the full strip.
   * When `outer`/`ScrollView` layouts disagree by a pixel, use the larger width for the track math.
   */
  const scrollTrackWidth = Math.max(
    0,
    outerW > 0 && layoutW > 0
      ? Math.max(outerW, layoutW)
      : outerW > 0
        ? outerW
        : scrollViewportW,
  );
  const showScrollbar =
    !fits && scrollRange > 0 && scrollViewportW > 0 && scrollTrackWidth > 0;
  const { thumbSpan: thumbW, thumbOffset: thumbLeft } = scrollIndicatorThumbSpanAndOffset(
    scrollTrackWidth,
    scrollViewportW,
    scrollContentSpanPx,
    Math.max(0, Math.min(scrollX, scrollRange)),
    scrollRange,
  );
  const thumbSnapLeft = snapToPixelGrid(thumbLeft);
  const thumbSnapW = Math.max(1, snapToPixelGrid(thumbW));

  const scrollToX = useCallback(
    (x: number) => {
      const clamped = Math.max(0, Math.min(x, scrollRange));
      scrollRef.current?.scrollTo({ x: clamped, animated: false });
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const root =
          document.getElementById("ah-nav-strip-hscroll") ??
          document.querySelector('[data-testid="ah-nav-strip-hscroll"]') ??
          document.querySelector(".ah-nav-strip-hscroll");
        const scrollEl = pickWebNavStripScrollEl(root, layoutW);
        if (scrollEl) {
          scrollEl.scrollLeft = clamped;
        }
      }
      if (clamped > maxScrollXSeenRef.current) {
        maxScrollXSeenRef.current = clamped;
      }
      setScrollX(clamped);
    },
    [layoutW, scrollRange],
  );

  /** Nested primary thumb on highlight track (music seek bar) — same thickness as the divider it overlays. */
  const thumbVisualH = lineT;

  const borderLineStyle = useMemo((): ViewStyle => {
    return {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: thumbVisualH,
      backgroundColor: colors.highlight,
      zIndex: 1,
      overflow: "visible",
    };
  }, [colors.highlight, thumbVisualH]);

  const thumbFillStyle = useMemo((): ViewStyle | null => {
    if (!showScrollbar || thumbW <= 0) return null;
    return {
      width: thumbSnapW,
      height: thumbVisualH,
      backgroundColor: colors.primary,
      ...(Platform.OS === "web" ? ({ willChange: "transform" } as ViewStyle) : null),
    };
  }, [showScrollbar, thumbW, thumbSnapW, colors.primary, thumbVisualH]);

  const labelStyle = (active: boolean) => ({
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: LABEL_FONT_SIZE,
    lineHeight: LABEL_LINE_HEIGHT,
    fontWeight: "400" as const,
    color: active ? colors.primary : colors.secondary,
    includeFontPadding: false,
    paddingVertical: 0,
  });

  /** Avoid flex/layout growing the hairline-high track on web. */
  const lineAxisLock = {
    flexGrow: 0,
    flexShrink: 0,
  } satisfies ViewStyle;

  const navStripLogPrevRef = useRef<{
    windowWidth: number;
    layoutIsWide: boolean;
    navStripBudgetWidthPx: number;
    showBottomMenuRule: boolean;
    stripMarginTop: number;
    fits: boolean;
    layoutW: number;
    scrollViewportW: number;
    contentW: number;
    intrinsicRowW: number;
    stripContentWidthPx: number;
    scrollContentSpanPx: number;
    outerW: number;
    scrollTrackWidth: number;
    showScrollbar: boolean;
    lineT: number;
    thumbBottomSnapped: number;
    splitColumnCount: number | null;
    splitFirstColumnWidthPx: number | null;
    splitRowWidthPx: number | null;
    splitEffectiveWidthPx: number | null;
  } | null>(null);

  useEffect(() => {
    const prev = navStripLogPrevRef.current;
    const splitColumnCount = splitMetrics?.columnCount ?? null;
    const splitFirstColumnWidthPx = splitMetrics?.firstColumnWidthPx ?? null;
    const splitRowWidthPx = splitMetrics?.splitRowWidthPx ?? null;
    const splitEffectiveWidthPx = splitMetrics?.effectiveSplitWidthPx ?? null;
    const next = {
      windowWidth,
      layoutIsWide,
      navStripBudgetWidthPx,
      showBottomMenuRule,
      stripMarginTop,
      fits,
      layoutW,
      scrollViewportW,
      contentW,
      intrinsicRowW,
      stripContentWidthPx,
      scrollContentSpanPx,
      outerW,
      scrollTrackWidth,
      showScrollbar,
      lineT,
      thumbBottomSnapped,
      splitColumnCount,
      splitFirstColumnWidthPx,
      splitRowWidthPx,
      splitEffectiveWidthPx,
    };

    const unchanged =
      prev !== null &&
      prev.windowWidth === next.windowWidth &&
      prev.layoutIsWide === next.layoutIsWide &&
      prev.navStripBudgetWidthPx === next.navStripBudgetWidthPx &&
      prev.showBottomMenuRule === next.showBottomMenuRule &&
      prev.stripMarginTop === next.stripMarginTop &&
      prev.fits === next.fits &&
      prev.layoutW === next.layoutW &&
      prev.scrollViewportW === next.scrollViewportW &&
      prev.contentW === next.contentW &&
      prev.intrinsicRowW === next.intrinsicRowW &&
      prev.stripContentWidthPx === next.stripContentWidthPx &&
      prev.scrollContentSpanPx === next.scrollContentSpanPx &&
      prev.outerW === next.outerW &&
      prev.scrollTrackWidth === next.scrollTrackWidth &&
      prev.showScrollbar === next.showScrollbar &&
      prev.lineT === next.lineT &&
      prev.thumbBottomSnapped === next.thumbBottomSnapped &&
      prev.splitColumnCount === next.splitColumnCount &&
      prev.splitFirstColumnWidthPx === next.splitFirstColumnWidthPx &&
      prev.splitRowWidthPx === next.splitRowWidthPx &&
      prev.splitEffectiveWidthPx === next.splitEffectiveWidthPx;

    if (unchanged) return;
    navStripLogPrevRef.current = next;

    const dpr =
      Platform.OS === "web" && typeof window !== "undefined" && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : PixelRatio.get();

    let bottomRuleEvent: string;
    if (prev === null) {
      bottomRuleEvent = showBottomMenuRule ? "initial_render_visible" : "initial_render_hidden";
    } else if (prev.showBottomMenuRule === showBottomMenuRule) {
      bottomRuleEvent = "unchanged";
    } else {
      bottomRuleEvent = showBottomMenuRule ? "bottom_border_shown" : "bottom_border_hidden";
    }

    let alignmentEvent: string;
    if (prev === null) {
      alignmentEvent = fits ? "initial_align_center" : "initial_align_scroll_start";
    } else if (prev.fits === fits && prev.stripMarginTop === stripMarginTop) {
      alignmentEvent = "strip_alignment_unchanged";
    } else {
      const parts: string[] = [];
      if (prev.fits !== fits) {
        parts.push(fits ? "row_now_centered_fits_viewport" : "row_now_left_when_overflow");
      }
      if (prev.stripMarginTop !== stripMarginTop) {
        parts.push(
          stripMarginTop > 0 ? "strip_margin_top_compact" : "strip_margin_top_wide_zero",
        );
      }
      alignmentEvent = parts.join("|");
    }

    const windowInferredColumns = windowInferredSplitColumnCount(windowWidth);
    const splitWindowColumnCountMismatch =
      chromeFromSplit && splitColumnCount != null && windowInferredColumns !== splitColumnCount;

    logPageDisplay("home_feed_messages_nav_strip", {
      menuId: "feed_messages_tasks_items_coins",
      phase: prev === null ? "mount" : "layout_update",
      chromeRuleSource: chromeFromSplit ? "split_layout_metrics" : "window_width_fallback",
      bottomBorderRule: chromeFromSplit
        ? `effectiveSplitWidthPx>firstBreakpoint && columnCount>=2 (wide=${layoutIsWide}, cols=${splitColumnCount})`
        : `windowWidth>firstBreakpoint (wide=${layoutIsWide})`,
      viewportWidthPx: windowWidth,
      firstBreakpointPx: AH.firstBreakpoint,
      secondBreakpointPx: AH.secondBreakpoint,
      layoutIsWideByEffectiveSplitOrWindow: layoutIsWide,
      navStripBudgetWidthPx,
      stripHorizontalInsetTotalPx: NAV_STRIP_HORIZONTAL_INSET_TOTAL_PX,
      viewportRelationToBreakpoint:
        windowWidth > AH.firstBreakpoint ? "above_wide_threshold" : "at_or_below_compact_threshold",
      windowInferredSplitColumnCount: windowInferredColumns,
      splitLayoutMetricsPresent: chromeFromSplit,
      splitPaneRowWidthPx: splitRowWidthPx,
      splitPaneEffectiveWidthPx: splitEffectiveWidthPx,
      splitPaneFirstColumnWidthPx: splitFirstColumnWidthPx,
      splitColumnCount,
      splitWindowColumnCountMismatch,
      stripMarginTopPx: stripMarginTop,
      leftNavStripMarginTopThemePx: AH.leftNavStripMarginTopPx,
      scrollViewportWidthMeasuredPx: layoutW,
      scrollViewportWidthUsedPx: scrollViewportW,
      scrollViewportWidthPx: scrollViewportW,
      scrollbarTrackWidthPx: scrollTrackWidth,
      estimatedNavStripContentWidthPx: ESTIMATED_NAV_STRIP_CONTENT_W_PX,
      intrinsicLabelRowWidthPx: intrinsicRowW,
      stripContentWidthPx,
      fitsUsesIntrinsicRowMeasure: intrinsicRowW > 0,
      scrollContentWidthRawPx: contentW,
      scrollContentWidthForThumbPx: scrollContentSpanPx,
      scrollOverflowPx: Math.max(0, scrollContentSpanPx - scrollViewportW),
      labelsFitWithoutScroll: fits,
      contentContainerJustifyContent: fits ? "center" : "flex-start",
      contentContainerFlexGrow: fits ? 1 : 0,
      contentContainerMinWidthPx: fits && scrollViewportW > 0 ? scrollViewportW : null,
      outerStripWidthPx: outerW,
      measuredNavOuterMinusSplitFirstColumnPx:
        splitFirstColumnWidthPx != null && outerW > 0 ? outerW - splitFirstColumnWidthPx : null,
      bottomMenuHairlineVisible: showBottomMenuRule,
      bottomRuleThicknessPx: lineT,
      bottomRuleColorRole: "colors.highlight",
      scrollbarTrackVisible: showScrollbar,
      scrollbarThumbBottomOffsetPx: thumbBottomSnapped,
      scrollbarGapAboveBorderThemePx: AH.leftNavStripScrollbarAboveBorderPx,
      platform: Platform.OS,
      devicePixelRatio: dpr,
      alignmentChange: alignmentEvent,
      bottomBorderLifecycle: bottomRuleEvent,
    });
  }, [
    windowWidth,
    layoutIsWide,
    navStripBudgetWidthPx,
    showBottomMenuRule,
    stripMarginTop,
    fits,
    layoutW,
    scrollViewportW,
    contentW,
    intrinsicRowW,
    stripContentWidthPx,
    scrollContentSpanPx,
    outerW,
    scrollTrackWidth,
    showScrollbar,
    lineT,
    thumbBottomSnapped,
    chromeFromSplit,
    splitMetrics,
  ]);

  return (
    <View
      onLayout={onOuterLayout}
      style={{
        width: "100%",
        alignSelf: "stretch",
        marginTop: stripMarginTop,
        height: STRIP_HEIGHT_PX,
        paddingTop: STRIP_PADDING_PX,
        paddingBottom: STRIP_PADDING_PX,
        /** List panels own top inset; keep flush with the nav bottom rule. */
        marginBottom: 0,
        position: "relative",
        overflow: "visible",
      }}
    >
      {/* Full-width scroll + 15px content insets: at scroll 0 / thumb left, row starts 15px in; at max scroll / thumb right, row ends 15px before edge. Edge fades sit on top for motion blur to the real edge. */}
      <ScrollView
        ref={scrollRef}
        horizontal
        nativeID="ah-nav-strip-hscroll"
        testID="ah-nav-strip-hscroll"
        {...(Platform.OS === "web"
          ? ({ className: "ah-nav-strip-hscroll" } as unknown as Record<string, string>)
          : {})}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!fits}
        style={{ width: "100%", height: INNER_SCROLL_HEIGHT_PX, zIndex: 0 }}
        contentContainerStyle={navScrollContentContainerStyle}
        onScroll={onScroll}
        onMomentumScrollEnd={onHorizontalScrollEnd}
        onScrollEndDrag={onHorizontalScrollEnd}
        scrollEventThrottle={16}
        onLayout={onScrollViewLayout}
        onContentSizeChange={onContentSizeChange}
      >
        <View
          collapsable={false}
          onLayout={onIntrinsicRowLayout}
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexGrow: 0,
            flexShrink: 0,
          }}
        >
          {NAV_IDS.map((navId, index) => {
            const label = t(`home.nav.${navId}` as AppStringKey);
            const isActive = activeIndex >= 0 && index === activeIndex;
            return (
            <Pressable
              key={navId}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={label}
              onPress={() => {
                if (isControlled) {
                  onSelectIndex?.(index);
                } else {
                  setInternalIndex(index);
                }
              }}
              style={{
                marginRight: index < NAV_IDS.length - 1 ? ITEM_GAP_PX : 0,
              }}
            >
              <Text style={labelStyle(isActive)}>{label}</Text>
            </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {fadeW > 0 ? (
        <>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 0,
              top: STRIP_PADDING_PX,
              width: fadeW,
              height: INNER_SCROLL_HEIGHT_PX,
              zIndex: 2,
            }}
          >
            <Svg width={fadeW} height={INNER_SCROLL_HEIGHT_PX} viewBox={`0 0 ${fadeW} ${INNER_SCROLL_HEIGHT_PX}`}>
              <Defs>
                <SvgLinearGradient id={fadeGradientIdLeft} x1="0%" y1="0" x2="100%" y2="0">
                  <Stop offset="0%" stopColor={colors.background} stopOpacity={1} />
                  <Stop offset="100%" stopColor={colors.background} stopOpacity={0} />
                </SvgLinearGradient>
              </Defs>
              <Rect x={0} y={0} width={fadeW} height={INNER_SCROLL_HEIGHT_PX} fill={`url(#${fadeGradientIdLeft})`} />
            </Svg>
          </View>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              right: 0,
              top: STRIP_PADDING_PX,
              width: fadeW,
              height: INNER_SCROLL_HEIGHT_PX,
              zIndex: 2,
            }}
          >
            <Svg width={fadeW} height={INNER_SCROLL_HEIGHT_PX} viewBox={`0 0 ${fadeW} ${INNER_SCROLL_HEIGHT_PX}`}>
              <Defs>
                <SvgLinearGradient id={fadeGradientIdRight} x1="0%" y1="0" x2="100%" y2="0">
                  <Stop offset="0%" stopColor={colors.background} stopOpacity={0} />
                  <Stop offset="100%" stopColor={colors.background} stopOpacity={1} />
                </SvgLinearGradient>
              </Defs>
              <Rect x={0} y={0} width={fadeW} height={INNER_SCROLL_HEIGHT_PX} fill={`url(#${fadeGradientIdRight})`} />
            </Svg>
          </View>
        </>
      ) : null}

      {showBottomMenuRule ? (
        <View pointerEvents="box-none" collapsable={false} style={[borderLineStyle, lineAxisLock]}>
          {thumbFillStyle ? (
            <ScrollIndicatorDragHandle
              axis="horizontal"
              trackSpan={scrollTrackWidth}
              thumbSpan={thumbSnapW}
              thumbOffset={thumbSnapLeft}
              scrollRange={scrollRange}
              onScrollTo={scrollToX}
              crossAxisVisualSpan={thumbVisualH}
            >
              <View pointerEvents="none" collapsable={false} style={[thumbFillStyle, lineAxisLock]} />
            </ScrollIndicatorDragHandle>
          ) : null}
        </View>
      ) : thumbFillStyle ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: thumbVisualH,
            zIndex: 3,
          }}
        >
          <ScrollIndicatorDragHandle
            axis="horizontal"
            trackSpan={scrollTrackWidth}
            thumbSpan={thumbSnapW}
            thumbOffset={thumbSnapLeft}
            scrollRange={scrollRange}
            onScrollTo={scrollToX}
            crossAxisVisualSpan={thumbVisualH}
          >
            <View pointerEvents="none" collapsable={false} style={[thumbFillStyle, lineAxisLock]} />
          </ScrollIndicatorDragHandle>
        </View>
      ) : null}
    </View>
  );
}
