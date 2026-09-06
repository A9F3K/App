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
  SCROLL_INDICATOR_THUMB_MIN_PX,
  SCROLL_INDICATOR_SCROLL_EPS,
  readScrollportOverflowPx,
  readShellFlexAvailableHeightPx,
  readSplitColumnScrollHostHeightPx,
  scrollContentOverflowsViewport,
} from "../scrollIndicatorPx";
import { isBrowserZoomWheelEvent } from "../browserZoom";
import { layout, useColors } from "../theme";
import { resolveWebRefElement } from "../smart/resolveWebLayoutElement";
import { useAuthenticatedHomeSplitLayoutMetrics } from "./AuthenticatedHomeSplitLayoutMetricsContext";
import { useFloatingDialogScrollChrome } from "./floatingDialogScrollChrome";
import { HspVerticalScrollIndicator } from "./HspVerticalScrollIndicator";

const DEFAULT_SCROLLBAR_RIGHT_INSET = layout.scrollIndicatorRightInsetPx;

function findShellDomNode(ref: View | null): HTMLElement | null {
  if (!ref || Platform.OS !== "web") return null;
  const fromResolver = resolveWebRefElement(ref);
  if (fromResolver) return fromResolver;
  if (typeof HTMLElement !== "undefined" && ref instanceof HTMLElement) return ref;
  const anyRef = ref as unknown as {
    getNode?: () => unknown;
    _touchableNode?: HTMLElement;
    _nativeNode?: HTMLElement;
  };
  const node = anyRef.getNode?.() ?? anyRef._touchableNode ?? anyRef._nativeNode ?? null;
  return node instanceof HTMLElement ? node : null;
}

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
  /** Live scroll DOM node on web (null on native). */
  getScrollElement: () => HTMLElement | null;
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
  /** Re-read DOM scrollport metrics (resize / split-pane reflow). Web only. */
  syncScrollMetricsFromDom: () => void;
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
   * When false, keep the thumb in the scroll shell (for floating dialogs).
   * Default: portal to the viewport seam when {@link scrollbarRightInsetPx} is 0 (chat columns).
   */
  scrollIndicatorOverlaySeam?: boolean;
  /**
   * Extend the scroll-thumb track below the scroll viewport (px) so the indicator can travel
   * through a pinned gradient CTA row that sits under the scroller.
   * When omitted, floating dialogs use {@link FloatingDialogScrollChromeProvider} `footerExtendPx`.
   */
  scrollIndicatorExtendBottomPx?: number;
  /**
   * Extend the scroll-thumb track above the scroll viewport (px) through a sticky dialog header
   * so the indicator spans the full right chrome height.
   */
  scrollIndicatorExtendTopPx?: number;
  /** Min thumb height (px). Chat panes pass ~20 to match tdesktop. */
  indicatorThumbMinPx?: number;
  /**
   * Optional content height used only for thumb *size* (not scroll range).
   * Pass estimated loaded-buffer / history span so mid-history remounts do not
   * collapse the thumb to the mounted display slice alone.
   */
  indicatorContentSpanPx?: number | null;
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
  scrollIndicatorOverlaySeam,
  scrollIndicatorExtendBottomPx,
  scrollIndicatorExtendTopPx,
  indicatorThumbMinPx = SCROLL_INDICATOR_THUMB_MIN_PX,
  indicatorContentSpanPx = null,
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
  const dialogScrollChrome = useFloatingDialogScrollChrome();
  const resolvedExtendTopPx = Math.max(
    0,
    scrollIndicatorExtendTopPx ?? dialogScrollChrome.headerExtendPx ?? 0,
  );
  const resolvedExtendBottomPx = Math.max(
    0,
    scrollIndicatorExtendBottomPx ?? dialogScrollChrome.footerExtendPx ?? 0,
  );
  const thumbColor = indicatorColor ?? colors.scrollIndicator;
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const shellRef = useRef<View>(null);
  const didInitialTopResetRef = useRef(false);
  const didInitialBottomScrollRef = useRef(false);
  const prevInitialScrollPositionRef = useRef(initialScrollPosition);
  if (prevInitialScrollPositionRef.current !== initialScrollPosition) {
    prevInitialScrollPositionRef.current = initialScrollPosition;
    didInitialTopResetRef.current = false;
    didInitialBottomScrollRef.current = false;
  }
  const nearTopFiredRef = useRef(false);
  const nearBottomFiredRef = useRef(false);
  const scrollMetricsRef = useRef({ layoutH: 0, contentH: 0, scrollY: 0 });
  const [scroll, setScroll] = useState({ layoutH: 0, contentH: 0, scrollY: 0 });
  // Do NOT assign scrollMetricsRef from React state here — programmatic
  // scrollToY/restore must update the ref synchronously so getMetrics() is
  // correct before the next render. Parent re-renders with stale state would
  // otherwise wipe a just-restored scrollY and re-pin the wrong offset.

  /** Keep getMetrics() in sync with DOM mutations before the next React render. */
  const commitScrollMetrics = useCallback(
    (next: { layoutH?: number; contentH?: number; scrollY: number }) => {
      const merged = {
        layoutH:
          next.layoutH != null && next.layoutH > 0
            ? next.layoutH
            : scrollMetricsRef.current.layoutH,
        contentH:
          next.contentH != null && next.contentH > 0
            ? next.contentH
            : scrollMetricsRef.current.contentH,
        scrollY: next.scrollY,
      };
      scrollMetricsRef.current = merged;
      setScroll((prev) => ({
        layoutH: merged.layoutH > 0 ? merged.layoutH : prev.layoutH,
        contentH: merged.contentH > 0 ? merged.contentH : prev.contentH,
        scrollY: merged.scrollY,
      }));
    },
    [],
  );
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
    const shellDom = findShellDomNode(shellRef.current);
    const live = readScrollportOverflowPx(el, shellDom);
    if (!live) return;
    const scrollYRaw = el.scrollTop;
    const scrollY = scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : scrollYRaw;
    syncNearTopLatch(scrollY);
    syncNearBottomLatch(scrollY, live.layoutH, live.contentH);
    setScroll((prev) => {
      const next = {
        ...prev,
        layoutH: live.layoutH,
        scrollY,
        // Always take live contentH (including when it shrinks after zoom-out).
        contentH: live.contentH > 0 ? live.contentH : prev.contentH,
      };
      scrollMetricsRef.current = next;
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
    // Unread opens skip the top reset — the controller applies UNREAD_DIVIDER_TOP itself.
    if (skipInitialTopReset) return;
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
  }, [initialScrollPosition, skipInitialTopReset, syncNearTopLatch, syncScrollMetricsFromDom]);

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
    let cancelled = false;
    let attempts = 0;
    let rafId = 0;
    let scrollEl: HTMLElement | null = null;

    const bindShellBox = (shellDom: HTMLElement) => {
      // Cap the shell to its flex parent’s remaining height. With overflow:visible,
      // RN-web often sizes the shell to content (AI third column) so neither the
      // scrollport nor the custom thumb ever sees overflow.
      shellDom.style.setProperty("min-height", "0");
      shellDom.style.setProperty("flex", "1 1 0px");
      shellDom.style.setProperty("align-self", "stretch");
      const avail = Math.max(
        readShellFlexAvailableHeightPx(shellDom),
        readSplitColumnScrollHostHeightPx(shellDom),
      );
      if (avail > 0) {
        shellDom.style.setProperty("height", `${avail}px`);
        shellDom.style.setProperty("max-height", `${avail}px`);
        // Always clip the shell to the flex box so overflow is real (needed for dialogs).
        // Portaled thumbs don't need overhang; in-shell thumbs use inset ≥ 0.
        shellDom.style.setProperty("overflow", "hidden");
      } else {
        shellDom.style.removeProperty("height");
        shellDom.style.setProperty("max-height", "100%");
      }
    };

    const bindScrollportBox = (el: HTMLElement) => {
      // Keep the scrollport bounded to the shell even when RN-web flex min-height
      // would otherwise size the node to its content (no overflow → no indicator).
      // Prefer an explicit max-height from the shell’s clientHeight — under zoom,
      // max-height:100% can resolve to content height and hide the thumb.
      el.style.setProperty("min-height", "0");
      el.style.setProperty("flex", "1 1 0px");
      el.style.setProperty("align-self", "stretch");
      el.style.setProperty("height", "0px");
      const shellDom = findShellDomNode(shellRef.current);
      if (shellDom) bindShellBox(shellDom);
      const shellH = shellDom?.clientHeight ?? 0;
      if (shellH > 0) {
        el.style.setProperty("max-height", `${shellH}px`);
      } else {
        el.style.setProperty("max-height", "100%");
      }
    };

    const onResize = () => {
      const shellDom = findShellDomNode(shellRef.current);
      if (shellDom) bindShellBox(shellDom);
      if (scrollEl) bindScrollportBox(scrollEl);
      resizeHandlerRef.current();
      syncScrollMetricsFromDom();
    };

    /** Ctrl/Cmd+wheel zoom does not always fire window.resize in the same frame. */
    const onZoomWheel = (e: WheelEvent) => {
      if (!isBrowserZoomWheelEvent(e)) return;
      requestAnimationFrame(() => {
        onResize();
        requestAnimationFrame(onResize);
      });
    };

    const attach = (): boolean => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      const instance = scrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const next = instance?.getScrollableNode?.() ?? null;
      if (!next) return false;
      scrollEl = next;
      bindScrollportBox(next);

      const ro = new ResizeObserver(onResize);
      resizeObserverRef.current = ro;
      ro.observe(next);
      const inner = next.firstElementChild;
      if (inner) ro.observe(inner);
      const shellDom = findShellDomNode(shellRef.current);
      if (shellDom && shellDom !== next) {
        ro.observe(shellDom);
        const host = shellDom.closest("[data-hsp-split-column-scroll-host]");
        if (host && host instanceof HTMLElement && host !== next && host !== shellDom) {
          ro.observe(host);
        }
        const shellParent = shellDom.parentElement;
        if (shellParent && shellParent !== next && shellParent !== shellDom) {
          ro.observe(shellParent);
        }
      }
      onResize();
      return true;
    };

    const pump = () => {
      if (cancelled) return;
      if (attach()) return;
      attempts += 1;
      if (attempts < 24) rafId = requestAnimationFrame(pump);
    };
    rafId = requestAnimationFrame(pump);

    window.addEventListener("resize", onResize);
    window.addEventListener("wheel", onZoomWheel, { passive: true });
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onResize);
    visualViewport?.addEventListener("scroll", onResize);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", onZoomWheel);
      visualViewport?.removeEventListener("resize", onResize);
      visualViewport?.removeEventListener("scroll", onResize);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [
    children,
    scrollbarRightInsetPx,
    scrollIndicatorOverlaySeam,
    syncScrollMetricsFromDom,
  ]);

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
      scrollMetricsRef.current = {
        layoutH: next.layoutH,
        contentH: next.contentH,
        scrollY: next.scrollY,
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
    setScroll((prev) => {
      const next = { ...prev, layoutH: lh };
      scrollMetricsRef.current = next;
      return next;
    });
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
        commitScrollMetrics({ scrollY: 0 });
        syncNearTopLatch(0);
      });
    }
    if (Platform.OS === "web") {
      requestAnimationFrame(syncScrollMetricsFromDom);
    }
  };

  const onContentSizeChange = (_w: number, h: number) => {
    setScroll((prev) => {
      const next = { ...prev, contentH: h };
      scrollMetricsRef.current = next;
      return next;
    });
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
          commitScrollMetrics({
            layoutH: el.clientHeight,
            contentH: el.scrollHeight,
            scrollY: clamped,
          });
          syncNearTopLatch(clamped);
          syncNearBottomLatch(clamped, el.clientHeight, el.scrollHeight);
          recordStableAnchor();
          return;
        }
      }
      scrollRef.current?.scrollTo({ y: clamped, animated: false });
      syncNearTopLatch(clamped);
      syncNearBottomLatch(clamped, scrollMetricsRef.current.layoutH, scrollMetricsRef.current.contentH);
      commitScrollMetrics({ scrollY: clamped });
      recordStableAnchor();
    },
    [commitScrollMetrics, recordStableAnchor, syncNearBottomLatch, syncNearTopLatch],
  );

  const scrollToEnd = useCallback(() => {
    if (Platform.OS === "web") {
      const el = getScrollElement();
      if (el) {
        const layoutH = el.clientHeight;
        const contentH = el.scrollHeight;
        const y = Math.max(0, contentH - layoutH);
        el.scrollTop = y;
        commitScrollMetrics({ layoutH, contentH, scrollY: y });
        // Parents (MessageList pinnedScrollYRef) only learn the pin via this emit —
        // without it, open-at-bottom left scrollY=0 and falsely triggered load-older.
        emitScrollPosition({ layoutH, contentH, scrollY: y });
        syncNearTopLatch(y);
        syncNearBottomLatch(y, layoutH, contentH);
        recordStableAnchor();
        return;
      }
    }
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [
    commitScrollMetrics,
    emitScrollPosition,
    getScrollElement,
    recordStableAnchor,
    syncNearBottomLatch,
    syncNearTopLatch,
  ]);

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
        if (Math.abs(delta) < 0.5) {
          // Still sync metrics from live DOM so callers do not read a stale scrollY.
          commitScrollMetrics({
            layoutH: scrollEl.clientHeight,
            contentH: scrollEl.scrollHeight,
            scrollY: scrollEl.scrollTop,
          });
          return true;
        }
        const nextTop = scrollEl.scrollTop + delta;
        scrollEl.scrollTop = nextTop;
        commitScrollMetrics({
          layoutH: scrollEl.clientHeight,
          contentH: scrollEl.scrollHeight,
          scrollY: nextTop,
        });
        syncNearTopLatch(nextTop);
        syncNearBottomLatch(nextTop, scrollEl.clientHeight, scrollEl.scrollHeight);
        return true;
      }
      return false;
    },
    [
      commitScrollMetrics,
      findMessageRowElement,
      getScrollElement,
      syncNearBottomLatch,
      syncNearTopLatch,
    ],
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

  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      resizeHandlerRef.current();
      syncScrollMetricsFromDom();
    };
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }, [
    splitMetrics?.columnCount,
    splitMetrics?.effectiveSplitWidthPx,
    splitMetrics?.middleColumnWidthPx,
    splitMetrics?.splitRowWidthPx,
    splitMetrics?.thirdColumnWidthPx,
    syncScrollMetricsFromDom,
  ]);

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
        // Growing content: classic prepend keep (scrollTop += ΔH).
        // Shrinking / remounted windows: pin absolute scrollTop from the capture
        // so a display-slice remount does not reset the viewport to 0.
        const nextTop =
          delta > 0
            ? anchor.scrollTop + delta
            : Math.max(
                0,
                Math.min(anchor.scrollTop, Math.max(0, el.scrollHeight - el.clientHeight)),
              );
        if (delta <= 0 && Math.abs(el.scrollTop - nextTop) < 0.5) {
          // Already at the captured offset — treat as kept when heights match.
          if (Math.abs(delta) < 0.5) {
            commitScrollMetrics({
              layoutH: el.clientHeight,
              contentH: el.scrollHeight,
              scrollY: el.scrollTop,
            });
            return true;
          }
          return false;
        }
        el.scrollTop = nextTop;
        commitScrollMetrics({
          layoutH: el.clientHeight,
          contentH: el.scrollHeight,
          scrollY: nextTop,
        });
        syncNearTopLatch(nextTop);
        syncNearBottomLatch(nextTop, el.clientHeight, el.scrollHeight);
        return true;
      }
      const metrics = scrollMetricsRef.current;
      const delta = metrics.contentH - anchor.scrollHeight;
      const maxY = Math.max(0, metrics.contentH - metrics.layoutH);
      const nextTop =
        delta > 0
          ? anchor.scrollTop + delta
          : Math.max(0, Math.min(anchor.scrollTop, maxY));
      if (delta <= 0 && Math.abs(metrics.scrollY - nextTop) < 0.5) {
        if (Math.abs(delta) < 0.5) return true;
        return false;
      }
      scrollRef.current?.scrollTo({ y: nextTop, animated: false });
      commitScrollMetrics({
        layoutH: metrics.layoutH,
        contentH: metrics.contentH,
        scrollY: nextTop,
      });
      syncNearTopLatch(nextTop);
      syncNearBottomLatch(nextTop, metrics.layoutH, metrics.contentH);
      return true;
    },
    [commitScrollMetrics, getScrollElement, syncNearBottomLatch, syncNearTopLatch],
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
      getScrollElement,
      getMetrics: () => {
        if (Platform.OS === "web") {
          const el = getScrollElement();
          if (el && el.clientHeight > 0) {
            const scrollYRaw = el.scrollTop;
            const scrollY =
              scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : scrollYRaw;
            const live = {
              layoutH: el.clientHeight,
              contentH:
                el.scrollHeight > 0
                  ? el.scrollHeight
                  : scrollMetricsRef.current.contentH,
              scrollY,
            };
            scrollMetricsRef.current = live;
            return live;
          }
        }
        return {
          layoutH: scrollMetricsRef.current.layoutH,
          contentH: scrollMetricsRef.current.contentH,
          scrollY: scrollMetricsRef.current.scrollY,
        };
      },
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
      syncScrollMetricsFromDom,
    };
    (scrollControllerRef as MutableRefObject<HspScrollColumnHandle | null>).current = controller;
    return () => {
      if (scrollControllerRef.current === controller) {
        scrollControllerRef.current = null;
      }
    };
  }, [scrollControllerRef, scrollToEnd, scrollToY, applyInitialScroll, captureScrollAnchor, keepScrollPositionOnPrepend, restoreScrollAnchor, captureItemAnchor, restoreItemAnchor, getScrollElement, syncScrollMetricsFromDom]);

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
    const extendBottom = resolvedExtendBottomPx;
    const extendTop = resolvedExtendTopPx;
    const trackH = viewH + extendTop + extendBottom;
    // Subpixel / flexGrow fill often reports 1px phantom overflow; hide until real scroll range.
    if (viewH <= 0 || contentH <= 0 || !scrollContentOverflowsViewport(contentH, viewH)) {
      return { show: false as const, thumbH: 0, thumbTop: 0, trackH: 0 };
    }
    const maxScroll = Math.max(1e-6, contentH - viewH);
    const thumbContentSpan =
      indicatorContentSpanPx != null && indicatorContentSpanPx > contentH
        ? indicatorContentSpanPx
        : contentH;
    const { thumbSpan, thumbOffset } = scrollIndicatorThumbSpanAndOffset(
      trackH,
      viewH,
      thumbContentSpan,
      y,
      maxScroll,
      indicatorThumbMinPx,
    );
    const hairline = scrollIndicatorHairlineBorderWidthPx();
    const thumbH = Math.max(hairline, thumbSpan);
    const maxTravel = Math.max(0, trackH - thumbH);
    const scrollClamped = Math.max(0, Math.min(y, maxScroll));
    let thumbTop =
      scroll.scrollY <= SCROLL_INDICATOR_SCROLL_EPS
        ? 0
        : Math.min(maxTravel, thumbOffset);
    if (scrollClamped >= maxScroll - SCROLL_INDICATOR_SCROLL_EPS) thumbTop = maxTravel;
    return { show: true as const, thumbH, thumbTop, maxScroll, trackH, extendTop };
  }, [
    scroll,
    indicatorContentSpanPx,
    indicatorThumbMinPx,
    resolvedExtendBottomPx,
    resolvedExtendTopPx,
  ]);

  return (
    <View
      ref={shellRef}
      style={[styles.shell, style]}
      collapsable={false}
      onLayout={(e) => {
        // Shell resize often fires when ScrollView onLayout is quiet (window / column drag).
        // On web, prefer live scrollport clientHeight — using shell height here can inflate
        // layoutH to the content size (overflow:visible) and hide the indicator.
        if (Platform.OS === "web") {
          requestAnimationFrame(() => resizeHandlerRef.current());
          return;
        }
        const lh = e.nativeEvent.layout.height;
        if (!(lh > 0)) return;
        setScroll((prev) => {
          if (Math.abs(prev.layoutH - lh) < 0.5) return prev;
          const next = { ...prev, layoutH: lh };
          scrollMetricsRef.current = next;
          return next;
        });
      }}
    >
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
      <HspVerticalScrollIndicator
        show={indicator.show}
        shellRef={shellRef}
        trackH={indicator.trackH}
        thumbH={indicator.thumbH}
        thumbTop={indicator.thumbTop}
        maxScroll={indicator.show ? indicator.maxScroll : 0}
        thumbColor={thumbColor}
        scrollbarRightInsetPx={scrollbarRightInsetPx}
        overlaySeam={scrollIndicatorOverlaySeam}
        scrollIndicatorExtendBottomPx={resolvedExtendBottomPx}
        scrollIndicatorExtendTopPx={resolvedExtendTopPx}
        onScrollTo={(y) => {
          onUserScrollIntent?.();
          scrollToY(y);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    alignSelf: "stretch",
    // Visible so the 1px thumb can overhang onto a chrome border; scrolling
    // clips inside the ScrollView node (overflow:auto via web style hooks).
    overflow: "visible",
  },
  scroll: {
    flex: 1,
    // Flex-basis 0: bound the scrollport to the shell on height resize. Without
    // this, RN-web sizes the node to content (clientHeight === scrollHeight),
    // ancestors clip the overflow, and the custom indicator never shows.
    height: 0,
    minHeight: 0,
    alignSelf: "stretch",
  },
  scrollContent: {
    flexGrow: 0,
  },
});
