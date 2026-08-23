import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Platform,
  View,
  type LayoutChangeEvent,
  type PanResponderGestureState,
} from "react-native";
import type { ThemeColors } from "../../theme";
import type { TradeCollectionItem } from "../../trade/tradeSampleData";
import { TradeCollectionColumn } from "./TradeCollectionColumn";

const SNAP_RATIO = 0.22;
const VELOCITY_PX_PER_MS = 0.45;
const SNAP_MS = 240;
const ACTIVATE_DX_PX = 10;
const RUBBER = 0.28;

type Props = {
  collections: readonly TradeCollectionItem[];
  itemsPerSlide: number;
  columnCount: number;
  gapPx: number;
  activeIndex: number;
  colors: ThemeColors;
  onActiveIndexChange: (index: number) => void;
  onUserInteract: () => void;
  onWidthChange: (widthPx: number) => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

function rubberTranslate(next: number, min: number, max: number): number {
  if (next > max) return max + (next - max) * RUBBER;
  if (next < min) return min + (next - min) * RUBBER;
  return next;
}

function snapIndexFromDrag(args: {
  startIndex: number;
  dx: number;
  velocityX: number;
  width: number;
  count: number;
  loop: boolean;
}): number {
  const { startIndex, dx, velocityX, width, count, loop } = args;
  if (width <= 0 || count <= 0) return startIndex;
  let next = startIndex;
  if (velocityX > VELOCITY_PX_PER_MS) next = startIndex - 1;
  else if (velocityX < -VELOCITY_PX_PER_MS) next = startIndex + 1;
  else if (dx <= -width * SNAP_RATIO) next = startIndex + 1;
  else if (dx >= width * SNAP_RATIO) next = startIndex - 1;
  if (loop) return wrapIndex(next, count);
  return clamp(next, 0, count - 1);
}

function gestureDirection(dx: number, velocityX: number): 1 | -1 {
  if (Math.abs(velocityX) > VELOCITY_PX_PER_MS) return velocityX < 0 ? 1 : -1;
  return dx <= 0 ? 1 : -1;
}

function clearBrowserTextSelection() {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  window.getSelection?.()?.removeAllRanges?.();
}

function setDocumentDragSelectLock(locked: boolean) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const root = document.documentElement;
  if (locked) {
    root.style.setProperty("user-select", "none");
    root.style.setProperty("-webkit-user-select", "none");
    clearBrowserTextSelection();
  } else {
    root.style.removeProperty("user-select");
    root.style.removeProperty("-webkit-user-select");
  }
}

type WebPointerEvt = {
  nativeEvent: {
    clientX: number;
    clientY: number;
    pointerId?: number;
    pointerType?: string;
    button?: number;
    preventDefault?: () => void;
  };
  currentTarget?: unknown;
};

function SlideRow({
  slide,
  slideKey,
  width,
  gapPx,
  colors,
}: {
  slide: TradeCollectionItem[];
  slideKey: string;
  width: number | `${number}%`;
  gapPx: number;
  colors: ThemeColors;
}) {
  return (
    <View key={slideKey} style={{ width }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", width: "100%" }}>
        {slide.map((collection, index) => (
          <Fragment key={`${slideKey}-${collection.title}-${index}`}>
            {index > 0 ? <View style={{ width: gapPx }} /> : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <TradeCollectionColumn
                image={collection.image}
                title={collection.title}
                subtitle={collection.subtitle}
                colors={colors}
              />
            </View>
          </Fragment>
        ))}
      </View>
    </View>
  );
}

/**
 * Horizontal collection slides: mouse-drag on web, swipe on native / touch.
 * Vertical parent scroll still wins until the gesture is clearly horizontal.
 * Looping clones let the last batch continue into the first.
 */
export function TradeCollectionCarousel({
  collections,
  itemsPerSlide,
  columnCount,
  gapPx,
  activeIndex,
  colors,
  onActiveIndexChange,
  onUserInteract,
  onWidthChange,
}: Props) {
  const slides = useMemo(() => {
    const out: TradeCollectionItem[][] = [];
    for (let i = 0; i < collections.length; i += itemsPerSlide) {
      out.push(collections.slice(i, i + itemsPerSlide).slice(0, Math.max(1, columnCount)));
    }
    return out.length > 0 ? out : [[]];
  }, [collections, columnCount, itemsPerSlide]);

  const count = slides.length;
  const looping = count > 1;
  const lastIndex = Math.max(0, count - 1);
  const trackSlides = useMemo(() => {
    if (!looping) return slides.map((slide, i) => ({ slide, key: `slide-${i}` }));
    return [
      { slide: slides[lastIndex]!, key: "clone-last" },
      ...slides.map((slide, i) => ({ slide, key: `slide-${i}` })),
      { slide: slides[0]!, key: "clone-first" },
    ];
  }, [looping, lastIndex, slides]);

  const [viewportWidth, setViewportWidth] = useState(0);
  const [grabbing, setGrabbing] = useState(false);
  const widthRef = useRef(0);
  const activeIndexRef = useRef(activeIndex);
  const prevIndexRef = useRef(activeIndex);
  const countRef = useRef(count);
  const loopingRef = useRef(looping);
  const draggingRef = useRef(false);
  const trackingRef = useRef(false);
  const skipIndexEffectRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startTranslateRef = useRef(0);
  const startIndexRef = useRef(0);
  const lastMoveXRef = useRef(0);
  const lastMoveAtRef = useRef(0);
  const velocityXRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  const onUserInteractRef = useRef(onUserInteract);
  const translateX = useRef(new Animated.Value(0)).current;

  activeIndexRef.current = activeIndex;
  countRef.current = count;
  loopingRef.current = looping;
  onActiveIndexChangeRef.current = onActiveIndexChange;
  onUserInteractRef.current = onUserInteract;

  const logicalToTranslate = useCallback(
    (logicalIndex: number, width: number) => -(logicalIndex + (loopingRef.current ? 1 : 0)) * width,
    [],
  );

  const jumpToLogical = useCallback(
    (logicalIndex: number, width: number) => {
      translateX.setValue(logicalToTranslate(logicalIndex, width));
    },
    [logicalToTranslate, translateX],
  );

  const animateToLogical = useCallback(
    (fromLogical: number, toLogical: number, width: number, direction: 1 | -1) => {
      if (width <= 0) return;
      const slideCount = countRef.current;
      const loop = loopingRef.current;
      const offset = loop ? 1 : 0;
      let trackTarget = toLogical + offset;
      if (loop && slideCount > 1) {
        if (direction === 1 && fromLogical === slideCount - 1 && toLogical === 0) {
          trackTarget = slideCount + 1;
        } else if (direction === -1 && fromLogical === 0 && toLogical === slideCount - 1) {
          trackTarget = 0;
        }
      }
      Animated.timing(translateX, {
        toValue: -trackTarget * width,
        duration: SNAP_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        if (trackTarget !== toLogical + offset) {
          jumpToLogical(toLogical, width);
        }
      });
    },
    [jumpToLogical, translateX],
  );

  useEffect(() => {
    const width = widthRef.current;
    const from = prevIndexRef.current;
    prevIndexRef.current = activeIndex;
    if (width <= 0 || draggingRef.current) return;
    if (skipIndexEffectRef.current) {
      skipIndexEffectRef.current = false;
      return;
    }
    if (from === activeIndex) {
      jumpToLogical(activeIndex, width);
      return;
    }
    const direction: 1 | -1 =
      wrapIndex(from + 1, countRef.current) === activeIndex ? 1 : -1;
    animateToLogical(from, activeIndex, width, direction);
  }, [activeIndex, animateToLogical, jumpToLogical, lastIndex]);

  useEffect(
    () => () => {
      setDocumentDragSelectLock(false);
    },
    [],
  );

  const beginDragFromCurrent = useCallback(() => {
    const width = widthRef.current;
    const offset = loopingRef.current ? 1 : 0;
    startIndexRef.current = activeIndexRef.current;
    startTranslateRef.current = -(activeIndexRef.current + offset) * width;
    translateX.stopAnimation((value) => {
      if (typeof value === "number") startTranslateRef.current = value;
    });
    velocityXRef.current = 0;
  }, [translateX]);

  const finishDrag = useCallback(
    (dx: number) => {
      if (!draggingRef.current) {
        trackingRef.current = false;
        setGrabbing(false);
        return;
      }
      const width = widthRef.current;
      const slideCount = countRef.current;
      const from = startIndexRef.current;
      const nextIndex = snapIndexFromDrag({
        startIndex: from,
        dx,
        velocityX: velocityXRef.current,
        width,
        count: slideCount,
        loop: loopingRef.current,
      });
      draggingRef.current = false;
      trackingRef.current = false;
      setGrabbing(false);
      setDocumentDragSelectLock(false);
      if (width > 0) {
        animateToLogical(from, nextIndex, width, gestureDirection(dx, velocityXRef.current));
      }
      if (nextIndex !== activeIndexRef.current) {
        skipIndexEffectRef.current = true;
        prevIndexRef.current = nextIndex;
        onActiveIndexChangeRef.current(nextIndex);
      }
    },
    [animateToLogical],
  );

  const applyDragDx = useCallback(
    (dx: number) => {
      const width = widthRef.current;
      if (width <= 0) return;
      const loop = loopingRef.current;
      const min = loop ? -(countRef.current + 1) * width : -Math.max(0, countRef.current - 1) * width;
      const max = 0;
      const next = startTranslateRef.current + dx;
      translateX.setValue(loop ? clamp(next, min, max) : rubberTranslate(next, min, max));
    },
    [translateX],
  );

  const noteVelocity = useCallback((clientX: number) => {
    const now = Date.now();
    const dt = now - lastMoveAtRef.current;
    if (dt > 0 && dt < 80) {
      velocityXRef.current = (clientX - lastMoveXRef.current) / dt;
    }
    lastMoveXRef.current = clientX;
    lastMoveAtRef.current = now;
  }, []);

  const releasePointerCapture = useCallback(() => {
    const host = hostRef.current;
    const pid = pointerIdRef.current;
    if (host && pid != null && typeof host.releasePointerCapture === "function") {
      try {
        if (host.hasPointerCapture?.(pid)) host.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
    }
    pointerIdRef.current = null;
    hostRef.current = null;
  }, []);

  const onViewportLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const width = Math.round(e.nativeEvent.layout.width);
      if (!(width > 0)) return;
      const prev = widthRef.current;
      widthRef.current = width;
      setViewportWidth((current) => (current === width ? current : width));
      onWidthChange(width);
      if (prev !== width && !draggingRef.current) {
        jumpToLogical(activeIndexRef.current, width);
      }
    },
    [jumpToLogical, onWidthChange],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g: PanResponderGestureState) =>
          Platform.OS !== "web" &&
          Math.abs(g.dx) >= ACTIVATE_DX_PX &&
          Math.abs(g.dx) > Math.abs(g.dy) * 1.1,
        onMoveShouldSetPanResponderCapture: (_, g: PanResponderGestureState) =>
          Platform.OS !== "web" &&
          Math.abs(g.dx) >= ACTIVATE_DX_PX &&
          Math.abs(g.dx) > Math.abs(g.dy) * 1.1,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => Platform.OS !== "web",
        onPanResponderGrant: () => {
          draggingRef.current = true;
          setGrabbing(true);
          beginDragFromCurrent();
          onUserInteractRef.current();
        },
        onPanResponderMove: (_, g: PanResponderGestureState) => {
          velocityXRef.current = g.vx;
          applyDragDx(g.dx);
        },
        onPanResponderRelease: (_, g: PanResponderGestureState) => {
          velocityXRef.current = g.vx;
          finishDrag(g.dx);
        },
        onPanResponderTerminate: (_, g: PanResponderGestureState) => {
          velocityXRef.current = g.vx;
          finishDrag(g.dx);
        },
      }),
    [applyDragDx, beginDragFromCurrent, finishDrag],
  );

  const capturePointer = useCallback((e: WebPointerEvt) => {
    const host = (e.currentTarget ?? null) as HTMLElement | null;
    const pointerId = e.nativeEvent.pointerId;
    hostRef.current = host;
    if (host && typeof host.setPointerCapture === "function" && typeof pointerId === "number") {
      try {
        host.setPointerCapture(pointerId);
        pointerIdRef.current = pointerId;
      } catch {
        pointerIdRef.current = null;
      }
    }
  }, []);

  const onWebPointerDown = useCallback(
    (e: WebPointerEvt) => {
      const ne = e.nativeEvent;
      if (typeof ne.button === "number" && ne.button !== 0) return;
      trackingRef.current = true;
      draggingRef.current = false;
      startXRef.current = ne.clientX;
      startYRef.current = ne.clientY;
      lastMoveXRef.current = ne.clientX;
      lastMoveAtRef.current = Date.now();
      beginDragFromCurrent();
      hostRef.current = (e.currentTarget ?? null) as HTMLElement | null;
    },
    [beginDragFromCurrent],
  );

  const onWebPointerMove = useCallback(
    (e: WebPointerEvt) => {
      if (!trackingRef.current) return;
      const { clientX, clientY, preventDefault } = e.nativeEvent;
      const dx = clientX - startXRef.current;
      const dy = clientY - startYRef.current;
      if (!draggingRef.current) {
        if (Math.abs(dx) < ACTIVATE_DX_PX && Math.abs(dy) < ACTIVATE_DX_PX) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          trackingRef.current = false;
          return;
        }
        draggingRef.current = true;
        setGrabbing(true);
        setDocumentDragSelectLock(true);
        capturePointer(e);
        onUserInteractRef.current();
      }
      preventDefault?.();
      noteVelocity(clientX);
      applyDragDx(dx);
    },
    [applyDragDx, capturePointer, noteVelocity],
  );

  const onWebPointerUp = useCallback(
    (e: WebPointerEvt) => {
      if (!trackingRef.current && !draggingRef.current) return;
      finishDrag(e.nativeEvent.clientX - startXRef.current);
      releasePointerCapture();
    },
    [finishDrag, releasePointerCapture],
  );

  const nativeHandlers = Platform.OS === "web" ? null : panResponder.panHandlers;
  const webHandlers =
    Platform.OS === "web"
      ? {
          onPointerDown: onWebPointerDown,
          onPointerMove: onWebPointerMove,
          onPointerUp: onWebPointerUp,
          onPointerCancel: onWebPointerUp,
          onLostPointerCapture: () => {
            if (!draggingRef.current && !trackingRef.current) return;
            finishDrag(lastMoveXRef.current - startXRef.current);
            pointerIdRef.current = null;
            hostRef.current = null;
          },
        }
      : null;

  const slideWidth: number | `${number}%` =
    viewportWidth > 0 ? viewportWidth : `${100 / Math.max(1, trackSlides.length)}%`;

  return (
    <View
      {...nativeHandlers}
      {...webHandlers}
      collapsable={false}
      onLayout={onViewportLayout}
      style={{
        width: "100%",
        overflow: "hidden",
        opacity: viewportWidth > 0 ? 1 : 0,
        ...(Platform.OS === "web"
          ? ({
              touchAction: "pan-y",
              userSelect: "none",
              cursor: grabbing ? "grabbing" : "pointer",
            } as const)
          : null),
      }}
    >
      <Animated.View
        style={{
          flexDirection: "row",
          width:
            viewportWidth > 0
              ? viewportWidth * trackSlides.length
              : `${trackSlides.length * 100}%`,
          transform: [{ translateX }],
        }}
      >
        {trackSlides.map(({ slide, key }) => (
          <SlideRow
            key={key}
            slide={slide}
            slideKey={key}
            width={slideWidth}
            gapPx={gapPx}
            colors={colors}
          />
        ))}
      </Animated.View>
    </View>
  );
}
