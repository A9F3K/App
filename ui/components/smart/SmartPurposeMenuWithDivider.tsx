import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  PixelRatio,
  Platform,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";

import {
  SCROLL_INDICATOR_SCROLL_EPS,
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../../scrollIndicatorPx";
import { layout, useColors } from "../../theme";
import { ScrollIndicatorDragHandle } from "../ScrollIndicatorDragHandle";
import { SmartGradientDivider } from "./SmartGradientDivider";

const SCROLL_EPS = 2;
const OVERFLOW_LOCK_PX = SCROLL_EPS;
const SCROLL_NATIVE_ID = "smart-purpose-menu-hscroll";
/** Side spacers in scroll content: labels start/end inset at scroll 0 / max; while sliding, labels pass through these zones. */
const MENU_SCROLL_PADDING_PX = layout.contentSideInsetPx;

function ruleThicknessPx(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

function scrollSpanFromContentSize(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (Platform.OS === "web") {
    return Math.max(w, h);
  }
  return w;
}

function pickWebScrollEl(root: Element | null, viewportWidthPx: number): HTMLElement | null {
  if (!root || typeof window === "undefined") return null;
  const candidates: HTMLElement[] = [];
  const collect = (el: Element) => {
    const host = el as HTMLElement;
    if (host.scrollWidth - host.clientWidth > 2 && host.clientWidth > 0) {
      candidates.push(host);
    }
    for (let i = 0; i < el.children.length; i++) {
      collect(el.children[i]);
    }
  };
  collect(root);
  if (candidates.length === 0) return null;
  const vw = viewportWidthPx;
  const pool =
    vw > 0 ? candidates.filter((host) => Math.abs(host.clientWidth - vw) <= 20) : candidates;
  const pickFrom = pool.length > 0 ? pool : candidates;
  return pickFrom.reduce((a, b) => (a.scrollWidth <= b.scrollWidth ? a : b));
}

type Props = {
  menuLineHeightPx: number;
  gapAboveDividerPx: number;
  renderMenuItems: () => ReactNode;
};

/**
 * Single-row Smart purpose menu. Never wraps — when labels exceed the column width,
 * horizontal scroll + thumb (3px above divider) turn on; divider position stays fixed.
 */
export function SmartPurposeMenuWithDivider({
  menuLineHeightPx,
  gapAboveDividerPx,
  renderMenuItems,
}: Props) {
  const colors = useColors();
  const lineT = ruleThicknessPx();
  const contentInset = layout.contentSideInsetPx;
  const menuPaddingPx = MENU_SCROLL_PADDING_PX;
  const menuPaddingTotalPx = menuPaddingPx * 2;
  const overflowLinePaddingPx = contentInset;

  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const prevFitsRef = useRef<boolean | null>(null);

  const [scrollX, setScrollX] = useState(0);
  const [layoutW, setLayoutW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [intrinsicRowW, setIntrinsicRowW] = useState(0);
  const [domHScrollSpanPx, setDomHScrollSpanPx] = useState(0);
  const [domScrollRangePx, setDomScrollRangePx] = useState(0);
  const [trackW, setTrackW] = useState(0);
  const maxScrollXSeenRef = useRef(0);
  const overflowStickyRef = useRef(false);

  /** Measured horizontal `ScrollView` client width (not the bleed shell — that is wider and breaks fits). */
  const scrollViewportW = layoutW;
  /** Labels + side spacers (scroll content span). */
  const stripContentWidthPx =
    intrinsicRowW > 0 ? menuPaddingTotalPx + intrinsicRowW : contentW;

  if (scrollViewportW > 0 && stripContentWidthPx > 0) {
    const overBy = stripContentWidthPx - scrollViewportW;
    if (overBy > OVERFLOW_LOCK_PX) {
      overflowStickyRef.current = true;
    } else if (stripContentWidthPx <= scrollViewportW + SCROLL_EPS) {
      overflowStickyRef.current = false;
    }
  }

  const fits =
    scrollViewportW > 0 &&
    stripContentWidthPx > 0 &&
    stripContentWidthPx <= scrollViewportW + SCROLL_EPS &&
    !overflowStickyRef.current;

  const rawMeasuredScrollSpanPx = Math.max(
    contentW > 0 ? contentW : 0,
    stripContentWidthPx,
    domHScrollSpanPx > 0 ? domHScrollSpanPx : 0,
  );
  const scrollContentSpanPx =
    !fits && scrollViewportW > 0
      ? rawMeasuredScrollSpanPx
      : 0;

  const computedScrollRange =
    !fits && scrollContentSpanPx > 0
      ? Math.max(0, scrollContentSpanPx - scrollViewportW)
      : 0;
  const scrollRange =
    !fits && domScrollRangePx > 0 ? domScrollRangePx : computedScrollRange;

  const scrollTrackWidth = trackW > 0 ? trackW : Math.max(0, scrollViewportW - menuPaddingTotalPx);
  const showScrollbar = !fits && scrollRange > 0 && scrollTrackWidth > 0;
  const scrollEnabled = !fits && scrollRange > 0;

  const scrollOffsetForThumb = Math.max(0, Math.min(scrollX, scrollRange));
  const { thumbSpan: thumbW, thumbOffset: thumbLeft } = scrollIndicatorThumbSpanAndOffset(
    scrollTrackWidth,
    scrollTrackWidth,
    scrollContentSpanPx > 0 ? scrollContentSpanPx : scrollTrackWidth + scrollRange,
    scrollOffsetForThumb,
    scrollRange,
  );
  const thumbSnapLeft = snapScrollIndicatorCoordPx(thumbLeft);
  const thumbSnapW = Math.max(1, snapScrollIndicatorCoordPx(thumbW));
  /** Overlay the divider track (music progress style), not a gap above it. */
  const thumbBottomPx = 0;

  const scrollContentContainerStyle = useMemo(
    (): ViewStyle => ({
      flexDirection: "row",
      alignItems: "flex-start",
      flexGrow: 0,
    }),
    [],
  );

  const bleedShellProps =
    Platform.OS === "web"
      ? ({
          dataSet: { smartPurposeMenuBleed: "true" },
          className: "smart-purpose-menu-scroll-bleed",
        } as Record<string, string>)
      : {};

  const syncScrollFromDomWeb = useCallback(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root =
          document.getElementById(SCROLL_NATIVE_ID) ??
          document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
          document.querySelector(".smart-purpose-menu-hscroll");
        const scrollEl = pickWebScrollEl(root, layoutW);
        if (!scrollEl || typeof scrollEl.scrollLeft !== "number") return;
        const span = Math.round(scrollEl.scrollWidth);
        const range = Math.max(0, Math.round(scrollEl.scrollWidth - scrollEl.clientWidth));
        if (span > 0) {
          setDomHScrollSpanPx((prev) => (span > prev ? span : prev));
        }
        setDomScrollRangePx(range);
        let x = Math.round(scrollEl.scrollLeft);
        if (range > 0 && x >= range - SCROLL_INDICATOR_SCROLL_EPS) {
          x = range;
        }
        if (x > maxScrollXSeenRef.current) {
          maxScrollXSeenRef.current = x;
        }
        setScrollX(x);
      });
    });
  }, [layoutW]);

  const syncScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nativeEvent = event.nativeEvent;
      let x = nativeEvent.contentOffset.x;
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const root =
          document.getElementById(SCROLL_NATIVE_ID) ??
          document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
          document.querySelector(".smart-purpose-menu-hscroll");
        const scrollEl = pickWebScrollEl(root, layoutW);
        if (scrollEl && typeof scrollEl.scrollLeft === "number") {
          x = Math.round(scrollEl.scrollLeft);
          const span = Math.round(scrollEl.scrollWidth);
          if (span > 0) {
            setDomHScrollSpanPx((prev) => (span > prev ? span : prev));
          }
          const range = Math.max(0, Math.round(scrollEl.scrollWidth - scrollEl.clientWidth));
          if (range > 0) {
            setDomScrollRangePx(range);
          }
        }
      }
      const range = scrollRange > 0 ? scrollRange : computedScrollRange;
      if (range > 0 && x >= range - SCROLL_INDICATOR_SCROLL_EPS) {
        x = range;
      }
      if (x > maxScrollXSeenRef.current) {
        maxScrollXSeenRef.current = x;
      }
      const spanPx = scrollSpanFromContentSize(
        nativeEvent.contentSize?.width ?? 0,
        nativeEvent.contentSize?.height ?? 0,
      );
      if (spanPx > 0) {
        setContentW((prev) => Math.max(prev, Math.round(spanPx)));
      }
      setScrollX(x);
    },
    [computedScrollRange, layoutW, scrollRange],
  );

  const onScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      syncScrollFromEvent(event);
      syncScrollFromDomWeb();
    },
    [syncScrollFromEvent, syncScrollFromDomWeb],
  );

  const onScrollViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const w = Math.round(event.nativeEvent.layout.width);
      setLayoutW(w);
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollFromDomWeb);
      }
    },
    [syncScrollFromDomWeb],
  );

  const onContentSizeChange = useCallback(
    (width: number, height: number) => {
      const spanPx = scrollSpanFromContentSize(width, height);
      if (spanPx > 0) {
        setContentW((prev) => Math.max(prev, Math.round(spanPx)));
      }
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollFromDomWeb);
      }
    },
    [syncScrollFromDomWeb],
  );

  const onIntrinsicRowLayout = useCallback((event: LayoutChangeEvent) => {
    const w = Math.round(event.nativeEvent.layout.width);
    if (w > 0) {
      setIntrinsicRowW((prev) => (prev === w ? prev : w));
    }
  }, []);

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackW(Math.round(event.nativeEvent.layout.width));
  }, []);

  const scrollToX = useCallback(
    (x: number) => {
      const clamped = Math.max(0, Math.min(x, scrollRange > 0 ? scrollRange : x));
      scrollRef.current?.scrollTo({ x: clamped, animated: false });
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const root =
          document.getElementById(SCROLL_NATIVE_ID) ??
          document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
          document.querySelector(".smart-purpose-menu-hscroll");
        const scrollEl = pickWebScrollEl(root, layoutW);
        if (scrollEl) {
          scrollEl.scrollLeft = clamped;
        }
      }
      setScrollX(clamped);
    },
    [layoutW, scrollRange],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    const root =
      document.getElementById(SCROLL_NATIVE_ID) ??
      document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
      document.querySelector(".smart-purpose-menu-hscroll");
    if (!root) {
      syncScrollFromDomWeb();
      return;
    }
    const ro = new ResizeObserver(() => syncScrollFromDomWeb());
    ro.observe(root);
    const scrollEl = pickWebScrollEl(root, layoutW);
    if (scrollEl) {
      ro.observe(scrollEl);
      const inner = scrollEl.firstElementChild;
      if (inner) ro.observe(inner);
    }
    syncScrollFromDomWeb();
    return () => ro.disconnect();
  }, [layoutW, intrinsicRowW, syncScrollFromDomWeb]);

  useEffect(() => {
    const wasOverflow = prevFitsRef.current === false;
    prevFitsRef.current = fits;

    if (!fits) return;

    maxScrollXSeenRef.current = 0;
    setScrollX(0);
    setDomScrollRangePx(0);
    setDomHScrollSpanPx(0);

    if (wasOverflow) {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [fits]);

  return (
    <>
      <View
        {...bleedShellProps}
        style={{
          alignSelf: "stretch",
          marginHorizontal: -contentInset,
          overflow: "visible",
        }}
      >
        <ScrollView
          ref={scrollRef}
          horizontal
          nativeID={SCROLL_NATIVE_ID}
          testID={SCROLL_NATIVE_ID}
          {...(Platform.OS === "web"
            ? ({ className: "smart-purpose-menu-hscroll" } as unknown as Record<string, string>)
            : {})}
          showsHorizontalScrollIndicator={false}
          scrollEnabled={scrollEnabled}
          style={{ width: "100%", height: menuLineHeightPx, zIndex: 0 }}
          contentContainerStyle={scrollContentContainerStyle}
          onScroll={syncScrollFromEvent}
          onMomentumScrollEnd={onScrollEnd}
          onScrollEndDrag={onScrollEnd}
          scrollEventThrottle={16}
          onLayout={onScrollViewLayout}
          onContentSizeChange={onContentSizeChange}
        >
          <View style={{ width: menuPaddingPx, flexShrink: 0 }} />
          <View
            collapsable={false}
            onLayout={onIntrinsicRowLayout}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              flexGrow: 0,
              flexShrink: 0,
            }}
          >
            {renderMenuItems()}
          </View>
          <View style={{ width: menuPaddingPx, flexShrink: 0 }} />
        </ScrollView>
      </View>

      <View style={{ position: "relative", width: "100%", alignSelf: "stretch" }}>
        <View style={{ height: gapAboveDividerPx }} />

        <View style={{ position: "relative", width: "100%", alignSelf: "stretch" }}>
          <SmartGradientDivider
            variant={fits ? "gradient" : "solid"}
            horizontalPaddingPx={fits ? 0 : overflowLinePaddingPx}
          />

          {showScrollbar ? (
            <View
              style={{
                position: "absolute",
                left: -contentInset,
                right: -contentInset,
                bottom: thumbBottomPx,
                paddingHorizontal: overflowLinePaddingPx,
                zIndex: 1,
                pointerEvents: "box-none",
              }}
            >
              <View
                onLayout={onTrackLayout}
                style={{
                  height: lineT,
                  overflow: "visible",
                }}
              >
                <ScrollIndicatorDragHandle
                  axis="horizontal"
                  trackSpan={scrollTrackWidth}
                  thumbSpan={thumbSnapW}
                  thumbOffset={thumbSnapLeft}
                  scrollRange={scrollRange}
                  onScrollTo={scrollToX}
                  crossAxisVisualSpan={lineT}
                >
                  <View
                    style={{
                      width: thumbSnapW,
                      height: lineT,
                      backgroundColor: colors.accent,
                      ...(Platform.OS === "web" ? ({ willChange: "transform" } as ViewStyle) : null),
                    }}
                  />
                </ScrollIndicatorDragHandle>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </>
  );
}
