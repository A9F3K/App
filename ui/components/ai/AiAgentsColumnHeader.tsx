import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Rect, Stop } from "react-native-svg";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import {
  SCROLL_INDICATOR_SCROLL_EPS,
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../../scrollIndicatorPx";
import { layout, useColors } from "../../theme";
import { ScrollIndicatorDragHandle } from "../ScrollIndicatorDragHandle";
import { CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX } from "../swap/ChooseCurrencySubheader";

const SCROLL_NATIVE_ID = "ai-agents-tabs-hscroll";
const SCROLL_EPS = 2;
const OVERFLOW_LOCK_PX = SCROLL_EPS;
const STRIP_PADDING_PX = layout.contentSideInsetPx;
const INNER_ROW_HEIGHT_PX = CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX - STRIP_PADDING_PX * 2;
/** Match inner row so undercover / close controls do not bleed over the bottom hairline. */
const TAB_HEIGHT_PX = INNER_ROW_HEIGHT_PX;
const TAB_PAD_X_PX = 10;
const TAB_GAP_PX = 8;
const ICON_SIZE_PX = 14;
const CLOSE_HIT_PX = 16;
const ADD_HIT_PX = 30;
/** 10px background fade immediately left of the solid mask. */
const ADD_GRADIENT_W_PX = 10;
/** Solid mask begins this many px left of the + icon. */
const ADD_GAP_BEFORE_ICON_PX = 5;
const ADD_SOLID_W_PX = ADD_GAP_BEFORE_ICON_PX + ADD_HIT_PX;
const RIGHT_OVERLAY_W_PX = ADD_GRADIENT_W_PX + ADD_SOLID_W_PX;
/** Last tab stops this many px before the gradient’s left edge at max scroll. */
const LAST_TAB_GRADIENT_INDENT_PX = 15;
const SCROLL_TRAILING_SPACER_PX = RIGHT_OVERLAY_W_PX + LAST_TAB_GRADIENT_INDENT_PX;

export type AiAgentTab = {
  id: string;
};

type Props = {
  tabs: AiAgentTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
  /**
   * When false, tabs omit the close control (single idle agent tab).
   * When true, every tab shows close (multiple tabs, or the sole tab has started).
   */
  showCloseButtons?: boolean;
};

function menuStripRuleThickness(): number {
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

function AgentBubbleIcon({ color, size = ICON_SIZE_PX }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4.5 14v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function AgentPlusIcon({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path d="M7 1.5v11M1.5 7h11" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

function AgentCloseIcon({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <Path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * Third-column agent tab strip — overflow scroll + thumb like Feed nav; hairlines between
 * inactive tabs; active undercover left/right edges carry dividers; + icon on background mask.
 */
export function AiAgentsColumnHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  showCloseButtons = true,
}: Props) {
  const { t } = useAppStrings();
  const colors = useColors();
  const lineT = menuStripRuleThickness();
  const addGradientId = useId().replace(/:/g, "");
  const fadeGradientIdLeft = `${addGradientId}-fade-l`;

  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const prevFitsRef = useRef<boolean | null>(null);
  const overflowStickyRef = useRef(false);
  const maxScrollXSeenRef = useRef(0);

  const [scrollX, setScrollX] = useState(0);
  const [layoutW, setLayoutW] = useState(0);
  const [stripW, setStripW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [intrinsicRowW, setIntrinsicRowW] = useState(0);
  const [domHScrollSpanPx, setDomHScrollSpanPx] = useState(0);
  const [domScrollRangePx, setDomScrollRangePx] = useState(0);

  const scrollViewportW = layoutW;
  const stripContentWidthPx =
    intrinsicRowW > 0
      ? STRIP_PADDING_PX + intrinsicRowW + SCROLL_TRAILING_SPACER_PX
      : contentW;

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
    !fits && scrollViewportW > 0 ? rawMeasuredScrollSpanPx : 0;

  const computedScrollRange =
    !fits && scrollContentSpanPx > 0
      ? Math.max(0, scrollContentSpanPx - scrollViewportW)
      : 0;
  const scrollRange =
    !fits && domScrollRangePx > 0 ? domScrollRangePx : computedScrollRange;

  const scrollTrackWidth = stripW > 0 ? stripW : Math.max(0, scrollViewportW);
  const showScrollbar = !fits && scrollRange > 0 && scrollTrackWidth > 0;
  const scrollEnabled = !fits && scrollRange > 0;

  const scrollOffsetForThumb = Math.max(0, Math.min(scrollX, scrollRange));
  const { thumbSpan: thumbW, thumbOffset: thumbLeft } = scrollIndicatorThumbSpanAndOffset(
    scrollTrackWidth,
    scrollViewportW,
    scrollContentSpanPx > 0 ? scrollContentSpanPx : scrollTrackWidth + scrollRange,
    scrollOffsetForThumb,
    scrollRange,
  );
  const thumbSnapLeft = snapScrollIndicatorCoordPx(thumbLeft);
  const thumbSnapW = Math.max(1, snapScrollIndicatorCoordPx(thumbW));
  const fadeW = STRIP_PADDING_PX;

  const syncScrollFromDomWeb = useCallback(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root =
          document.getElementById(SCROLL_NATIVE_ID) ??
          document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
          document.querySelector(".ai-agents-tabs-hscroll");
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
          document.querySelector(".ai-agents-tabs-hscroll");
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

  const onStripLayout = useCallback((event: LayoutChangeEvent) => {
    setStripW(Math.round(event.nativeEvent.layout.width));
  }, []);

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
      setIntrinsicRowW((prev) => {
        if (prev === w) return prev;
        if (prev > 0 && w < prev) {
          setContentW(0);
          setDomHScrollSpanPx(0);
          maxScrollXSeenRef.current = 0;
          overflowStickyRef.current = false;
        }
        return w;
      });
    }
  }, []);

  const scrollToX = useCallback(
    (x: number) => {
      const clamped = Math.max(0, Math.min(x, scrollRange > 0 ? scrollRange : x));
      scrollRef.current?.scrollTo({ x: clamped, animated: false });
      if (Platform.OS === "web" && typeof document !== "undefined") {
        const root =
          document.getElementById(SCROLL_NATIVE_ID) ??
          document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
          document.querySelector(".ai-agents-tabs-hscroll");
        const scrollEl = pickWebScrollEl(root, layoutW);
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

  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    const root =
      document.getElementById(SCROLL_NATIVE_ID) ??
      document.querySelector(`[data-testid="${SCROLL_NATIVE_ID}"]`) ??
      document.querySelector(".ai-agents-tabs-hscroll");
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
  }, [layoutW, intrinsicRowW, tabs.length, syncScrollFromDomWeb]);

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

  const scrollContentContainerStyle = useMemo(
    (): ViewStyle => ({
      flexDirection: "row",
      alignItems: "center",
      flexGrow: 0,
      justifyContent: "flex-start",
    }),
    [],
  );

  const borderLineStyle = useMemo((): ViewStyle => {
    return {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: lineT,
      backgroundColor: colors.highlight,
      zIndex: 4,
      overflow: "visible",
    };
  }, [colors.highlight, lineT]);

  const thumbFillStyle = useMemo((): ViewStyle | null => {
    if (!showScrollbar || thumbW <= 0) return null;
    return {
      width: thumbSnapW,
      height: lineT,
      backgroundColor: colors.scrollIndicator,
      ...(Platform.OS === "web" ? ({ willChange: "transform" } as ViewStyle) : null),
    };
  }, [showScrollbar, thumbW, thumbSnapW, colors.scrollIndicator, lineT]);

  const lineAxisLock = {
    flexGrow: 0,
    flexShrink: 0,
  } satisfies ViewStyle;

  return (
    <View style={styles.strip} onLayout={onStripLayout}>
      <View style={styles.rowHost}>
        <ScrollView
          ref={scrollRef}
          horizontal
          nativeID={SCROLL_NATIVE_ID}
          testID={SCROLL_NATIVE_ID}
          {...(Platform.OS === "web"
            ? ({ className: "ai-agents-tabs-hscroll" } as unknown as Record<string, string>)
            : {})}
          showsHorizontalScrollIndicator={false}
          scrollEnabled={scrollEnabled}
          style={styles.tabsScroll}
          contentContainerStyle={scrollContentContainerStyle}
          onScroll={syncScrollFromEvent}
          onMomentumScrollEnd={onScrollEnd}
          onScrollEndDrag={onScrollEnd}
          scrollEventThrottle={16}
          onLayout={onScrollViewLayout}
          onContentSizeChange={onContentSizeChange}
        >
          <View style={{ width: STRIP_PADDING_PX, flexShrink: 0 }} />
          <View
            collapsable={false}
            onLayout={onIntrinsicRowLayout}
            style={styles.intrinsicRow}
          >
            {tabs.map((tab, index) => {
              const active = tab.id === activeTabId;
              const nextActive =
                index < tabs.length - 1 && tabs[index + 1]!.id === activeTabId;
              const showInactiveDivider =
                index < tabs.length - 1 && !active && !nextActive;
              return (
                <View key={tab.id} style={styles.tabCluster}>
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={t("ai.agents.newAgent")}
                    onPress={() => onSelectTab(tab.id)}
                    style={[
                      styles.tab,
                      {
                        backgroundColor: active ? colors.undercover : "transparent",
                        borderLeftWidth: active ? lineT : 0,
                        borderRightWidth: active ? lineT : 0,
                        borderLeftColor: colors.highlight,
                        borderRightColor: colors.highlight,
                        paddingRight: showCloseButtons ? 6 : TAB_PAD_X_PX,
                      },
                    ]}
                  >
                    <AgentBubbleIcon color={colors.primary} />
                    <Text style={[styles.tabLabel, { color: colors.primary }]} numberOfLines={1}>
                      {t("ai.agents.newAgent")}
                    </Text>
                    {showCloseButtons ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("ai.agents.closeTab")}
                        hitSlop={6}
                        onPress={(event) => {
                          event?.stopPropagation?.();
                          onCloseTab(tab.id);
                        }}
                        style={styles.closeHit}
                      >
                        <AgentCloseIcon color={colors.secondary} />
                      </Pressable>
                    ) : null}
                  </Pressable>
                  {showInactiveDivider ? (
                    <View
                      style={[
                        styles.tabRule,
                        { width: lineT, backgroundColor: colors.highlight },
                      ]}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
          <View style={{ width: SCROLL_TRAILING_SPACER_PX, flexShrink: 0 }} />
        </ScrollView>
      </View>

      {fadeW > 0 ? (
        <View
          pointerEvents="none"
          style={[styles.edgeFade, { left: 0, width: fadeW, height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX }]}
        >
          <Svg
            width={fadeW}
            height={CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}
            viewBox={`0 0 ${fadeW} ${CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}`}
          >
            <Defs>
              <SvgLinearGradient id={fadeGradientIdLeft} x1="0%" y1="0" x2="100%" y2="0">
                <Stop offset="0%" stopColor={colors.background} stopOpacity={1} />
                <Stop offset="100%" stopColor={colors.background} stopOpacity={0} />
              </SvgLinearGradient>
            </Defs>
            <Rect
              x={0}
              y={0}
              width={fadeW}
              height={CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}
              fill={`url(#${fadeGradientIdLeft})`}
            />
          </Svg>
        </View>
      ) : null}

      <View pointerEvents="box-none" style={styles.addOverlay}>
        <View pointerEvents="none" style={styles.addGradient}>
          <Svg
            width={ADD_GRADIENT_W_PX}
            height={CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}
            viewBox={`0 0 ${ADD_GRADIENT_W_PX} ${CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}`}
          >
            <Defs>
              <SvgLinearGradient id={addGradientId} x1="0%" y1="0" x2="100%" y2="0">
                <Stop offset="0%" stopColor={colors.background} stopOpacity={0} />
                <Stop offset="100%" stopColor={colors.background} stopOpacity={1} />
              </SvgLinearGradient>
            </Defs>
            <Rect
              x={0}
              y={0}
              width={ADD_GRADIENT_W_PX}
              height={CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX}
              fill={`url(#${addGradientId})`}
            />
          </Svg>
        </View>
        <View
          pointerEvents="none"
          style={[styles.addSolidMask, { backgroundColor: colors.background }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("ai.agents.addTab")}
          onPress={onAddTab}
          style={styles.addHit}
        >
          <AgentPlusIcon color={colors.primary} />
        </Pressable>
      </View>

      <View pointerEvents="box-none" collapsable={false} style={[borderLineStyle, lineAxisLock]}>
        {thumbFillStyle ? (
          <ScrollIndicatorDragHandle
            axis="horizontal"
            trackSpan={scrollTrackWidth}
            thumbSpan={thumbSnapW}
            thumbOffset={thumbSnapLeft}
            scrollRange={scrollRange}
            onScrollTo={scrollToX}
            crossAxisVisualSpan={lineT}
          >
            <View pointerEvents="none" collapsable={false} style={[thumbFillStyle, lineAxisLock]} />
          </ScrollIndicatorDragHandle>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: "100%",
    alignSelf: "stretch",
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
    paddingTop: STRIP_PADDING_PX,
    paddingBottom: STRIP_PADDING_PX,
    position: "relative",
    overflow: "visible",
  },
  rowHost: {
    height: INNER_ROW_HEIGHT_PX,
    width: "100%",
    position: "relative",
    overflow: "hidden",
  },
  tabsScroll: {
    width: "100%",
    height: INNER_ROW_HEIGHT_PX,
    zIndex: 0,
  },
  intrinsicRow: {
    flexDirection: "row",
    alignItems: "center",
    flexGrow: 0,
    flexShrink: 0,
    height: TAB_HEIGHT_PX,
  },
  tabCluster: {
    flexDirection: "row",
    alignItems: "center",
    height: TAB_HEIGHT_PX,
  },
  tab: {
    height: TAB_HEIGHT_PX,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: TAB_PAD_X_PX,
    paddingRight: 6,
    gap: TAB_GAP_PX,
    maxWidth: 200,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: "400",
    includeFontPadding: false,
  },
  closeHit: {
    width: CLOSE_HIT_PX,
    height: CLOSE_HIT_PX,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  tabRule: {
    width: StyleSheet.hairlineWidth,
    height: TAB_HEIGHT_PX,
    marginHorizontal: 2,
    flexShrink: 0,
  },
  edgeFade: {
    position: "absolute",
    top: 0,
    zIndex: 2,
  },
  addOverlay: {
    position: "absolute",
    right: 0,
    top: 0,
    width: RIGHT_OVERLAY_W_PX,
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
    zIndex: 3,
  },
  addSolidMask: {
    position: "absolute",
    left: ADD_GRADIENT_W_PX,
    top: 0,
    width: ADD_SOLID_W_PX,
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
  },
  addGradient: {
    position: "absolute",
    left: 0,
    top: 0,
    width: ADD_GRADIENT_W_PX,
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
  },
  addHit: {
    position: "absolute",
    right: 0,
    top: 0,
    width: ADD_HIT_PX,
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
    alignItems: "center",
    justifyContent: "center",
  },
});
