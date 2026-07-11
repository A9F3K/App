import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  scrollIndicatorHairlineBorderWidthPx,
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../scrollIndicatorPx";
import { isBrowserZoomWheelEvent } from "../browserZoom";
import { layout, useColors } from "../theme";
import { SCROLL_INDICATOR_SCROLL_EPS } from "../scrollIndicatorPx";
import { ScrollIndicatorDragHandle } from "./ScrollIndicatorDragHandle";

const DEFAULT_SCROLLBAR_RIGHT_INSET = layout.scrollIndicatorRightInsetPx;

export type HspScrollMetrics = {
  layoutH: number;
  contentH: number;
  scrollY: number;
};

/** Snapshot before prepending content above the viewport (infinite scroll up). */
export type HspScrollAnchor = {
  scrollTop: number;
  scrollHeight: number;
};

/** Per-message anchor for prepend stability (telegram-tt getBoundingClientRect delta). */
export type HspItemAnchor = {
  messageId: number;
  /** Row top relative to viewport at capture (web). */
  viewportTopPx: number;
  /** Row offset from viewport top at capture (native layout map). */
  offsetFromViewportTop?: number;
};

export type HspScrollColumnHandle = {
  scrollToEnd: () => void;
  scrollToY: (y: number) => void;
  getMetrics: () => HspScrollMetrics;
  /** Apply open-scroll position once before reveal. */
  applyInitialScroll: (targetY: number) => void;
  captureScrollAnchor: () => HspScrollAnchor | null;
  /** One synchronous scrollTop += scrollHeight delta — keeps the viewport fixed on prepend. */
  keepScrollPositionOnPrepend: (anchor: HspScrollAnchor) => boolean;
  restoreScrollAnchor: (anchor: HspScrollAnchor) => void;
  captureItemAnchor: (messageId: number) => HspItemAnchor | null;
  restoreItemAnchor: (anchor: HspItemAnchor) => boolean;
  /** Allow {@link onNearTop} to fire again after prepending content near the top. */
  clearNearTopLatch: () => void;
  /** Allow {@link onNearBottom} to fire again after appending content near the bottom. */
  clearNearBottomLatch: () => void;
};

type Props = {
  children: ReactNode;
  /** Scroll thumb color; defaults to theme `accent`. */
  indicatorColor?: string;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Fired when viewport/content heights change (e.g. to toggle scroll vs flex-fill layouts). */
  onMetricsChange?: (metrics: Omit<HspScrollMetrics, "scrollY">) => void;
  /** Fired on scroll and when content/viewport metrics settle. */
  onScrollPositionChange?: (metrics: HspScrollMetrics) => void;
  /** Inset (px) of the thumb from the right edge of the scroll shell; default {@link layout.scrollIndicatorRightInsetPx}. */
  scrollbarRightInsetPx?: number;
  /**
   * When true (default), wheel/touch scroll does not chain to parent scrollers once this column hits an edge.
   * Root layout passes false so zoomed document scroll still works when the main shell is exhausted.
   */
  containOverscroll?: boolean;
  /** When false, content is flex-filled without scrolling (root layout on panel routes). */
  scrollEnabled?: boolean;
  /** Where to place the viewport on first mount; chat panes use `bottom`. */
  initialScrollPosition?: "top" | "bottom";
  /** When true, skip the mount-time scrollTop=0 reset (controller applies initial scroll). */
  skipInitialTopReset?: boolean;
  /** Fired when the user scrolls within {@link nearTopThresholdPx} of the top. */
  onNearTop?: () => void;
  nearTopThresholdPx?: number;
  /** Fired when the user scrolls within {@link nearBottomThresholdPx} of the bottom. */
  onNearBottom?: () => void;
  nearBottomThresholdPx?: number;
  /** Wheel, touch-drag, or scrollbar drag — not layout/programmatic scroll. */
  onUserScrollIntent?: (direction?: "up" | "down") => void;
  /** Optional imperative scroll API (scroll-to-end, preserve position on prepend). */
  scrollControllerRef?: React.MutableRefObject<HspScrollColumnHandle | null>;
  /**
   * When true, content-size changes (e.g. media resolving heights) keep the viewport stable:
   * stick to bottom if the user was at the bottom, otherwise pin the top-visible message row.
   * Enable only after the open-scroll has settled so it doesn't fight the initial positioning.
   */
  preserveViewportOnResize?: boolean;
  /**
   * When true with {@link preserveViewportOnResize}, content growth while the viewport was at
   * the scroll bottom sticks to the new bottom. Mid-history chat reading must pass false:
   * the display-window bottom is not the chat tail, and sticking jumps the viewport down when
   * newer rows are expanded/loaded below.
   */
  stickToBottomOnResize?: boolean;
};

/**
 * Vertical scroll column with the app’s 1px accent hairline indicator (same as {@link MainWebScrollColumn} in root layout).
 */
export function HspScrollColumn({
  children,
  indicatorColor,
  style,
  contentContainerStyle,
  onMetricsChange,
  onScrollPositionChange,
  scrollbarRightInsetPx = DEFAULT_SCROLLBAR_RIGHT_INSET,
  containOverscroll = true,
  scrollEnabled = true,
  initialScrollPosition = "top",
  skipInitialTopReset = false,
  onNearTop,
  nearTopThresholdPx = 120,
  onNearBottom,
  nearBottomThresholdPx = 120,
  onUserScrollIntent,
  scrollControllerRef,
  preserveViewportOnResize = false,
  stickToBottomOnResize = true,
}: Props) {
  const colors = useColors();
  const thumbColor = indicatorColor ?? colors.accent;
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const didInitialTopResetRef = useRef(false);
  const didInitialBottomScrollRef = useRef(false);
  const nearTopFiredRef = useRef(false);
  const nearBottomFiredRef = useRef(false);
  const scrollMetricsRef = useRef({ layoutH: 0, contentH: 0, scrollY: 0 });
  const [scroll, setScroll] = useState({ layoutH: 0, contentH: 0, scrollY: 0 });
  scrollMetricsRef.current = scroll;
  const stickToBottomOnResizeRef = useRef(stickToBottomOnResize);
  stickToBottomOnResizeRef.current = stickToBottomOnResize;

  const getScrollElement = useCallback((): HTMLElement | null => {
    if (Platform.OS !== "web") return null;
    const instance = scrollRef.current as unknown as {
      getScrollableNode?: () => HTMLElement | null | undefined;
    } | null;
    return instance?.getScrollableNode?.() ?? null;
  }, []);

  const emitScrollPosition = useCallback(
    (metrics: HspScrollMetrics) => {
      onScrollPositionChange?.(metrics);
    },
    [onScrollPositionChange],
  );

  const syncNearTopLatch = useCallback(
    (scrollY: number) => {
      if (!onNearTop) {
        nearTopFiredRef.current = false;
        return;
      }
      if (scrollY > nearTopThresholdPx) {
        nearTopFiredRef.current = false;
      }
    },
    [nearTopThresholdPx, onNearTop],
  );

  const syncNearBottomLatch = useCallback(
    (scrollY: number, layoutH: number, contentH: number) => {
      if (!onNearBottom) {
        nearBottomFiredRef.current = false;
        return;
      }
      const maxScroll = Math.max(0, contentH - layoutH);
      if (scrollY < maxScroll - nearBottomThresholdPx) {
        nearBottomFiredRef.current = false;
      }
    },
    [nearBottomThresholdPx, onNearBottom],
  );

  const syncScrollMetricsFromDom = useCallback(() => {
    if (Platform.OS !== "web") return;
    const el = getScrollElement();
    if (!el) return;
    const layoutH = el.clientHeight;
    const contentH = el.scrollHeight;
    const scrollYRaw = el.scrollTop;
    const scrollY = scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : scrollYRaw;
    if (layoutH <= 0) return;
    syncNearTopLatch(scrollY);
    syncNearBottomLatch(scrollY, layoutH, contentH);
    setScroll((prev) => {
      const next = {
        ...prev,
        layoutH,
        scrollY,
        ...(contentH > 0 ? { contentH } : {}),
      };
      emitScrollPosition(next);
      return next;
    });
  }, [emitScrollPosition, getScrollElement, syncNearBottomLatch, syncNearTopLatch]);

  // --- Viewport preservation across content-size changes (opt-in) ---
  const preserveViewportOnResizeRef = useRef(preserveViewportOnResize);
  preserveViewportOnResizeRef.current = preserveViewportOnResize;
  const stableAnchorRef = useRef<HspItemAnchor | null>(null);
  const stableAnchorScrollTopRef = useRef<number | null>(null);
  const wasAtBottomRef = useRef(true);
  const resizeHandlerRef = useRef<() => void>(() => {});

  /** First message row whose bottom is still within the viewport (web only). */
  const captureTopVisibleAnchor = useCallback((): HspItemAnchor | null => {
    if (Platform.OS !== "web") return null;
    const scrollEl = getScrollElement();
    if (!scrollEl) return null;
    const rows = scrollEl.querySelectorAll<HTMLElement>('[id^="message-row-"]');
    if (rows.length === 0) return null;
    const viewportTop = scrollEl.getBoundingClientRect().top;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > viewportTop + 1) {
        const messageId = Number(row.id.replace("message-row-", ""));
        if (!Number.isFinite(messageId) || messageId <= 0) return null;
        return { messageId, viewportTopPx: rect.top };
      }
    }
    return null;
  }, [getScrollElement]);

  /** Record whether we're at the bottom and, if not, which row anchors the viewport. */
  const recordStableAnchor = useCallback(() => {
    if (Platform.OS !== "web") return;
    if (!preserveViewportOnResizeRef.current) return;
    const el = getScrollElement();
    if (!el) return;
    const atBottom =
      stickToBottomOnResizeRef.current &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_INDICATOR_SCROLL_EPS;
    wasAtBottomRef.current = atBottom;
    stableAnchorScrollTopRef.current = el.scrollTop;
    // Always keep a row pin when not sticking to bottom — mid-history display growth
    // must re-pin the visible message instead of jumping to the new scroll end.
    stableAnchorRef.current = atBottom ? null : captureTopVisibleAnchor();
  }, [captureTopVisibleAnchor, getScrollElement]);

  /** Reset scroll only on first mount — not when `children` change (e.g. split-pane resize reflow). */
  const didMountScrollResetRef = useRef(false);
  useLayoutEffect(() => {
    if (didMountScrollResetRef.current) return;
    didMountScrollResetRef.current = true;
    if (initialScrollPosition === "bottom") return;
    if (Platform.OS === "web") {
      const instance = scrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (el) el.scrollTop = 0;
    } else {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
    setScroll((prev) => ({ ...prev, scrollY: 0 }));
    syncNearTopLatch(0);
    if (Platform.OS !== "web") return;
    syncScrollMetricsFromDom();
    const id = requestAnimationFrame(() => {
      syncScrollMetricsFromDom();
      requestAnimationFrame(syncScrollMetricsFromDom);
    });
    return () => cancelAnimationFrame(id);
  }, [initialScrollPosition, syncNearTopLatch, syncScrollMetricsFromDom]);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      const instance = scrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (!el?.style) return;
      el.classList.add("hsp-main-scroll-hide-native-scrollbar");
      if (containOverscroll) {
        el.classList.add("hsp-scroll-column-overscroll-contain");
      } else {
        el.classList.remove("hsp-scroll-column-overscroll-contain");
      }
      el.style.setProperty("scrollbar-width", "none");
      el.style.setProperty("-ms-overflow-style", "none");
      el.style.setProperty("overscroll-behavior", containOverscroll ? "contain" : "auto");
      el.style.setProperty("overflow", scrollEnabled ? "auto" : "hidden");
      if (!scrollEnabled) el.scrollTop = 0;
    };
    const id = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    return () => cancelAnimationFrame(id);
  }, [children, containOverscroll, scrollEnabled]);

  /** Fallback when CSS overscroll-behavior is ignored (some RN-web / browser combos). */
  useEffect(() => {
    if (Platform.OS !== "web" || !containOverscroll || !scrollEnabled) return;

    let scrollEl: HTMLElement | null = null;
    let onWheel: ((e: WheelEvent) => void) | null = null;

    const bind = () => {
      const instance = scrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (!el || el === scrollEl) return;

      if (scrollEl && onWheel) {
        scrollEl.removeEventListener("wheel", onWheel);
      }

      scrollEl = el;
      onWheel = (e: WheelEvent) => {
        if (isBrowserZoomWheelEvent(e)) return;
        const { scrollTop, scrollHeight, clientHeight } = el;
        if (Math.abs(e.deltaY) <= 0.5) return;

        onUserScrollIntent?.(e.deltaY < 0 ? "up" : "down");

        const contentFits = scrollHeight <= clientHeight + 0.5;
        const atTop = scrollTop <= SCROLL_INDICATOR_SCROLL_EPS;
        const atBottom =
          contentFits ||
          scrollTop + clientHeight >= scrollHeight - SCROLL_INDICATOR_SCROLL_EPS;

        // Mid-history opens often sit at scrollY=0 (top of the display window).
        // Wheel-up then cannot move scrollTop, so onScroll/onNearTop never re-fire.
        // Treat edge overscroll (and short content) as an explicit older/newer intent.
        if (e.deltaY < 0 && (atTop || contentFits)) {
          e.preventDefault();
          nearTopFiredRef.current = false;
          onNearTop?.();
          return;
        }
        // Only fire newer intent when already parked at the absolute bottom —
        // never while mid-list scroll-down (contentFits alone was too aggressive).
        if (e.deltaY > 0 && atBottom && !contentFits) {
          e.preventDefault();
          nearBottomFiredRef.current = false;
          onNearBottom?.();
          return;
        }
        if (e.deltaY > 0 && contentFits) {
          e.preventDefault();
          nearBottomFiredRef.current = false;
          onNearBottom?.();
          return;
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
    };

    bind();
    const id = requestAnimationFrame(() => {
      bind();
      requestAnimationFrame(bind);
    });

    return () => {
      cancelAnimationFrame(id);
      if (scrollEl && onWheel) {
        scrollEl.removeEventListener("wheel", onWheel);
      }
    };
  }, [
    children,
    containOverscroll,
    onNearBottom,
    onNearTop,
    onUserScrollIntent,
    scrollEnabled,
  ]);

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    const t = requestAnimationFrame(() => {
      resizeObserverRef.current?.disconnect();
      const instance = scrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const scrollEl = instance?.getScrollableNode?.();
      if (!scrollEl) return;
      const ro = new ResizeObserver(() => resizeHandlerRef.current());
      resizeObserverRef.current = ro;
      ro.observe(scrollEl);
      const inner = scrollEl.firstElementChild;
      if (inner) ro.observe(inner);
    });
    return () => {
      cancelAnimationFrame(t);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [syncScrollMetricsFromDom, children]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const ne = e.nativeEvent;
    const ch = ne.contentSize?.height ?? 0;
    const yRaw = ne.contentOffset.y;
    const y = yRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : yRaw;
    setScroll((prev) => {
      const next = {
        ...prev,
        scrollY: y,
        ...(ch > 0 ? { contentH: ch } : {}),
      };
      emitScrollPosition({
        layoutH: next.layoutH,
        contentH: next.contentH,
        scrollY: next.scrollY,
      });
      return next;
    });
    if (onNearTop) {
      if (y <= nearTopThresholdPx) {
        if (!nearTopFiredRef.current) {
          nearTopFiredRef.current = true;
          onNearTop();
        }
      } else {
        nearTopFiredRef.current = false;
      }
    }
    const layoutH = scrollMetricsRef.current.layoutH;
    const contentH = ch > 0 ? ch : scrollMetricsRef.current.contentH;
    if (onNearBottom && layoutH > 0 && contentH > layoutH + 0.5) {
      const maxScroll = contentH - layoutH;
      if (y >= maxScroll - nearBottomThresholdPx) {
        if (!nearBottomFiredRef.current) {
          nearBottomFiredRef.current = true;
          onNearBottom();
        }
      } else {
        nearBottomFiredRef.current = false;
      }
    }
    syncNearBottomLatch(y, layoutH, contentH);
    if (Platform.OS === "web") {
      syncScrollMetricsFromDom();
      recordStableAnchor();
    }
  };

  const onLayout = (e: LayoutChangeEvent) => {
    const lh = e.nativeEvent.layout.height;
    setScroll((prev) => ({ ...prev, layoutH: lh }));
    if (initialScrollPosition === "top" && !skipInitialTopReset && !didInitialTopResetRef.current) {
      didInitialTopResetRef.current = true;
      requestAnimationFrame(() => {
        if (Platform.OS === "web") {
          const instance = scrollRef.current as unknown as {
            getScrollableNode?: () => HTMLElement | null | undefined;
          } | null;
          const el = instance?.getScrollableNode?.();
          if (el) el.scrollTop = 0;
        } else {
          scrollRef.current?.scrollTo({ y: 0, animated: false });
        }
        setScroll((prev) => ({ ...prev, scrollY: 0 }));
        syncNearTopLatch(0);
      });
    }
    if (Platform.OS === "web") {
      requestAnimationFrame(syncScrollMetricsFromDom);
    }
  };

  const onContentSizeChange = (_w: number, h: number) => {
    setScroll((prev) => ({ ...prev, contentH: h }));
    if (Platform.OS === "web") {
      requestAnimationFrame(() => resizeHandlerRef.current());
    }
  };

  useEffect(() => {
    onMetricsChange?.({ layoutH: scroll.layoutH, contentH: scroll.contentH });
  }, [scroll.layoutH, scroll.contentH, onMetricsChange]);

  const scrollToY = useCallback(
    (y: number) => {
      let clamped = Math.max(0, y);
      if (Platform.OS === "web") {
        const instance = scrollRef.current as unknown as {
          getScrollableNode?: () => HTMLElement | null | undefined;
        } | null;
        const el = instance?.getScrollableNode?.();
        if (el) {
          const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
          clamped = Math.min(maxScroll, clamped);
          el.scrollTop = clamped;
          setScroll((prev) => ({
            ...prev,
            layoutH: el.clientHeight > 0 ? el.clientHeight : prev.layoutH,
            contentH: el.scrollHeight > 0 ? el.scrollHeight : prev.contentH,
            scrollY: clamped,
          }));
          syncNearTopLatch(clamped);
          syncNearBottomLatch(clamped, el.clientHeight, el.scrollHeight);
          recordStableAnchor();
          return;
        }
      }
      scrollRef.current?.scrollTo({ y: clamped, animated: false });
      syncNearTopLatch(clamped);
      syncNearBottomLatch(clamped, scrollMetricsRef.current.layoutH, scrollMetricsRef.current.contentH);
      setScroll((prev) => ({ ...prev, scrollY: clamped }));
      recordStableAnchor();
    },
    [recordStableAnchor, syncNearBottomLatch, syncNearTopLatch],
  );

  const scrollToEnd = useCallback(() => {
    if (Platform.OS === "web") {
      const el = getScrollElement();
      if (el) {
        const layoutH = el.clientHeight;
        const contentH = el.scrollHeight;
        const y = Math.max(0, contentH - layoutH);
        el.scrollTop = y;
        setScroll((prev) => ({
          ...prev,
          layoutH: layoutH > 0 ? layoutH : prev.layoutH,
          contentH: contentH > 0 ? contentH : prev.contentH,
          scrollY: y,
        }));
        syncNearTopLatch(y);
        syncNearBottomLatch(y, layoutH, contentH);
        recordStableAnchor();
        return;
      }
    }
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [getScrollElement, recordStableAnchor, syncNearBottomLatch, syncNearTopLatch]);

  const messageRowNativeId = (messageId: number) => `message-row-${messageId}`;

  const findMessageRowElement = useCallback(
    (messageId: number): HTMLElement | null => {
      if (Platform.OS !== "web") return null;
      const scrollEl = getScrollElement();
      if (!scrollEl) return null;
      const id = messageRowNativeId(messageId);
      return (
        scrollEl.querySelector(`#${CSS.escape(id)}`) ??
        scrollEl.querySelector(`[nativeid="${id}"]`) ??
        scrollEl.querySelector(`[data-message-id="${messageId}"]`)
      );
    },
    [getScrollElement],
  );

  const captureItemAnchor = useCallback(
    (messageId: number): HspItemAnchor | null => {
      if (messageId <= 0) return null;
      if (Platform.OS === "web") {
        const rowEl = findMessageRowElement(messageId);
        if (!rowEl) return null;
        return {
          messageId,
          viewportTopPx: rowEl.getBoundingClientRect().top,
        };
      }
      return { messageId, viewportTopPx: 0 };
    },
    [findMessageRowElement],
  );

  const restoreItemAnchor = useCallback(
    (anchor: HspItemAnchor): boolean => {
      if (anchor.messageId <= 0) return false;
      if (Platform.OS === "web") {
        const rowEl = findMessageRowElement(anchor.messageId);
        const scrollEl = getScrollElement();
        if (!rowEl || !scrollEl) return false;
        const delta = rowEl.getBoundingClientRect().top - anchor.viewportTopPx;
        if (Math.abs(delta) < 0.5) return true;
        const nextTop = scrollEl.scrollTop + delta;
        scrollEl.scrollTop = nextTop;
        setScroll((prev) => ({
          ...prev,
          layoutH: scrollEl.clientHeight > 0 ? scrollEl.clientHeight : prev.layoutH,
          contentH: scrollEl.scrollHeight > 0 ? scrollEl.scrollHeight : prev.contentH,
          scrollY: nextTop,
        }));
        syncNearTopLatch(nextTop);
        syncNearBottomLatch(nextTop, scrollEl.clientHeight, scrollEl.scrollHeight);
        return true;
      }
      return false;
    },
    [findMessageRowElement, getScrollElement, syncNearBottomLatch, syncNearTopLatch],
  );

  const applyInitialScroll = useCallback(
    (targetY: number) => {
      scrollToY(targetY);
      recordStableAnchor();
    },
    [recordStableAnchor, scrollToY],
  );

  /**
   * Keep the viewport visually stable when content resizes (media resolving heights,
   * async layout). Sticks to the bottom if the user was at the bottom pre-resize;
   * otherwise re-pins the recorded top-visible row. Falls back to a plain metrics sync.
   */
  const handleContentResize = useCallback(() => {
    if (Platform.OS !== "web") {
      syncScrollMetricsFromDom();
      return;
    }
    if (preserveViewportOnResizeRef.current) {
      const el = getScrollElement();
      if (el) {
        const anchorScrollTop = stableAnchorScrollTopRef.current;
        if (
          anchorScrollTop != null &&
          stableAnchorRef.current &&
          Math.abs(el.scrollTop - anchorScrollTop) > 8
        ) {
          recordStableAnchor();
          syncScrollMetricsFromDom();
          return;
        }
        if (wasAtBottomRef.current) {
          const targetY = Math.max(0, el.scrollHeight - el.clientHeight);
          if (Math.abs(el.scrollTop - targetY) > 0.5) {
            el.scrollTop = targetY;
          }
        } else if (stableAnchorRef.current) {
          restoreItemAnchor(stableAnchorRef.current);
        }
      }
    }
    syncScrollMetricsFromDom();
  }, [getScrollElement, restoreItemAnchor, syncScrollMetricsFromDom]);

  resizeHandlerRef.current = handleContentResize;

  // Seed the stable anchor as soon as preservation is enabled, before the first
  // scroll event, so an early media resize has something to pin to.
  useEffect(() => {
    if (!preserveViewportOnResize) return;
    const id = requestAnimationFrame(() => recordStableAnchor());
    return () => cancelAnimationFrame(id);
  }, [preserveViewportOnResize, recordStableAnchor]);

  const captureScrollAnchor = useCallback((): HspScrollAnchor | null => {
    if (Platform.OS === "web") {
      const el = getScrollElement();
      if (!el) return null;
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    }
    const metrics = scrollMetricsRef.current;
    if (metrics.contentH <= 0) return null;
    return { scrollTop: metrics.scrollY, scrollHeight: metrics.contentH };
  }, [getScrollElement]);

  const applyScrollAnchorRestore = useCallback(
    (anchor: HspScrollAnchor) => {
      if (Platform.OS === "web") {
        const el = getScrollElement();
        if (!el) return false;
        const delta = el.scrollHeight - anchor.scrollHeight;
        if (delta <= 0) return false;
        const nextTop = anchor.scrollTop + delta;
        el.scrollTop = nextTop;
        setScroll((prev) => ({
          ...prev,
          layoutH: el.clientHeight > 0 ? el.clientHeight : prev.layoutH,
          contentH: el.scrollHeight > 0 ? el.scrollHeight : prev.contentH,
          scrollY: nextTop,
        }));
        syncNearTopLatch(nextTop);
        syncNearBottomLatch(nextTop, el.clientHeight, el.scrollHeight);
        return true;
      }
      const metrics = scrollMetricsRef.current;
      const delta = metrics.contentH - anchor.scrollHeight;
      if (delta <= 0) return false;
      const nextTop = anchor.scrollTop + delta;
      scrollRef.current?.scrollTo({ y: nextTop, animated: false });
      setScroll((prev) => ({ ...prev, scrollY: nextTop, contentH: metrics.contentH }));
      syncNearTopLatch(nextTop);
      syncNearBottomLatch(nextTop, metrics.layoutH, metrics.contentH);
      return true;
    },
    [getScrollElement, syncNearBottomLatch, syncNearTopLatch],
  );

  const keepScrollPositionOnPrepend = useCallback(
    (anchor: HspScrollAnchor) => applyScrollAnchorRestore(anchor),
    [applyScrollAnchorRestore],
  );

  const restoreScrollAnchor = useCallback(
    (anchor: HspScrollAnchor) => {
      let attempts = 0;
      const maxAttempts = 12;

      const run = () => {
        const restored = applyScrollAnchorRestore(anchor);
        if (restored || ++attempts >= maxAttempts) return;
        requestAnimationFrame(run);
      };

      requestAnimationFrame(() => {
        run();
        requestAnimationFrame(run);
      });
    },
    [applyScrollAnchorRestore],
  );

  useEffect(() => {
    if (!scrollControllerRef) return;
    const controller: HspScrollColumnHandle = {
      scrollToEnd,
      scrollToY,
      applyInitialScroll,
      getMetrics: () => ({
        layoutH: scrollMetricsRef.current.layoutH,
        contentH: scrollMetricsRef.current.contentH,
        scrollY: scrollMetricsRef.current.scrollY,
      }),
      captureScrollAnchor,
      keepScrollPositionOnPrepend,
      restoreScrollAnchor,
      captureItemAnchor,
      restoreItemAnchor,
      clearNearTopLatch: () => {
        nearTopFiredRef.current = false;
      },
      clearNearBottomLatch: () => {
        nearBottomFiredRef.current = false;
      },
    };
    (scrollControllerRef as MutableRefObject<HspScrollColumnHandle | null>).current = controller;
    return () => {
      if (scrollControllerRef.current === controller) {
        scrollControllerRef.current = null;
      }
    };
  }, [scrollControllerRef, scrollToEnd, scrollToY, applyInitialScroll, captureScrollAnchor, keepScrollPositionOnPrepend, restoreScrollAnchor, captureItemAnchor, restoreItemAnchor]);

  useLayoutEffect(() => {
    if (initialScrollPosition !== "bottom" || didInitialBottomScrollRef.current) return;
    if (scroll.layoutH <= 0 || scroll.contentH <= scroll.layoutH + 0.5) return;
    didInitialBottomScrollRef.current = true;
    scrollToEnd();
  }, [initialScrollPosition, scroll.contentH, scroll.layoutH, scrollToEnd]);

  const indicator = useMemo(() => {
    const viewH = scroll.layoutH;
    const contentH = scroll.contentH;
    const y = scroll.scrollY;
    if (viewH <= 0 || contentH <= 0 || contentH <= viewH + 0.5) {
      return { show: false as const, thumbH: 0, thumbTop: 0 };
    }
    const maxScroll = Math.max(1e-6, contentH - viewH);
    const { thumbSpan, thumbOffset } = scrollIndicatorThumbSpanAndOffset(
      viewH,
      viewH,
      contentH,
      y,
      maxScroll,
    );
    const hairline = scrollIndicatorHairlineBorderWidthPx();
    const thumbH = Math.max(hairline, thumbSpan);
    const thumbTop =
      scroll.scrollY <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : thumbOffset;
    return { show: true as const, thumbH, thumbTop, maxScroll };
  }, [scroll]);

  return (
    <View style={[styles.shell, style]}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
        scrollEnabled={scrollEnabled}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        onScrollBeginDrag={() => onUserScrollIntent?.()}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {indicator.show ? (
        <View
          style={[
            styles.scrollIndicatorWrap,
            { right: snapScrollIndicatorCoordPx(scrollbarRightInsetPx) },
          ]}
        >
          <ScrollIndicatorDragHandle
            axis="vertical"
            trackSpan={scroll.layoutH}
            thumbSpan={indicator.thumbH}
            thumbOffset={indicator.thumbTop}
            scrollRange={indicator.maxScroll}
            onScrollTo={(y) => {
              onUserScrollIntent?.();
              scrollToY(y);
            }}
            crossAxisVisualSpan={scrollIndicatorHairlineBorderWidthPx()}
          >
            <View
              {...(Platform.OS === "web"
                ? ({ className: "hsp-scroll-indicator-thumb" } as Record<string, string>)
                : {})}
              style={[
                styles.scrollIndicatorThumb,
                {
                  top: 0,
                  height: indicator.thumbH,
                  width: 0,
                  borderLeftWidth: scrollIndicatorHairlineBorderWidthPx(),
                  borderLeftColor: thumbColor,
                  borderStyle: "solid",
                },
              ]}
            />
          </ScrollIndicatorDragHandle>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    alignSelf: "stretch",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 0,
  },
  scrollIndicatorWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0,
    overflow: "visible",
    zIndex: layout.authenticatedHome.scrollIndicatorOverlayZIndex,
    pointerEvents: "box-none",
  },
  scrollIndicatorThumb: {
    position: "absolute",
    right: 0,
    top: 0,
  },
});
