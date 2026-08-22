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
  lastIndex: number;
}): number {
  const { startIndex, dx, velocityX, width, lastIndex } = args;
  if (width <= 0) return startIndex;
  if (velocityX > VELOCITY_PX_PER_MS) return clamp(startIndex - 1, 0, lastIndex);
  if (velocityX < -VELOCITY_PX_PER_MS) return clamp(startIndex + 1, 0, lastIndex);
  if (dx <= -width * SNAP_RATIO) return clamp(startIndex + 1, 0, lastIndex);
  if (dx >= width * SNAP_RATIO) return clamp(startIndex - 1, 0, lastIndex);
  return startIndex;
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

/**
 * Horizontal collection slides: mouse-drag on web, swipe on native / touch.
 * Vertical parent scroll still wins until the gesture is clearly horizontal.
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

  const lastIndex = Math.max(0, slides.length - 1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const widthRef = useRef(0);
  const activeIndexRef = useRef(activeIndex);
  const lastIndexRef = useRef(lastIndex);
  const draggingRef = useRef(false);
  const trackingRef = useRef(false);
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
  lastIndexRef.current = lastIndex;
  onActiveIndexChangeRef.current = onActiveIndexChange;
  onUserInteractRef.current = onUserInteract;

  const animateToIndex = useCallback(
    (index: number, width: number) => {
      Animated.timing(translateX, {
        toValue: -index * width,
        duration: SNAP_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [translateX],
  );

  useEffect(() => {
    const width = widthRef.current;
    if (width <= 0 || draggingRef.current) return;
    animateToIndex(activeIndex, width);
  }, [activeIndex, animateToIndex, lastIndex]);

  useEffect(
    () => () => {
      setDocumentDragSelectLock(false);
    },
    [],
  );

  const finishDrag = useCallback(
    (dx: number) => {
      if (!draggingRef.current) {
        trackingRef.current = false;
        return;
      }
      const width = widthRef.current;
      const nextIndex = snapIndexFromDrag({
        startIndex: startIndexRef.current,
        dx,
        velocityX: velocityXRef.current,
        width,
        lastIndex: lastIndexRef.current,
      });
      draggingRef.current = false;
      trackingRef.current = false;
      setDocumentDragSelectLock(false);
      if (width > 0) animateToIndex(nextIndex, width);
      if (nextIndex !== activeIndexRef.current) {
        onActiveIndexChangeRef.current(nextIndex);
      }
    },
    [animateToIndex],
  );

  const applyDragDx = useCallback(
    (dx: number) => {
      const width = widthRef.current;
      if (width <= 0) return;
      const min = -lastIndexRef.current * width;
      translateX.setValue(rubberTranslate(startTranslateRef.current + dx, min, 0));
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
      setViewportWidth((prev) => (prev === width ? prev : width));
      onWidthChange(width);
      if (prev !== width && !draggingRef.current) {
        translateX.setValue(-activeIndexRef.current * width);
      }
    },
    [onWidthChange, translateX],
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
          startIndexRef.current = activeIndexRef.current;
          startTranslateRef.current = -activeIndexRef.current * widthRef.current;
          velocityXRef.current = 0;
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
    [applyDragDx, finishDrag],
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

  const onWebPointerDown = useCallback((e: WebPointerEvt) => {
    const ne = e.nativeEvent;
    if (typeof ne.button === "number" && ne.button !== 0) return;
    trackingRef.current = true;
    draggingRef.current = false;
    startXRef.current = ne.clientX;
    startYRef.current = ne.clientY;
    startIndexRef.current = activeIndexRef.current;
    startTranslateRef.current = -activeIndexRef.current * widthRef.current;
    lastMoveXRef.current = ne.clientX;
    lastMoveAtRef.current = Date.now();
    velocityXRef.current = 0;
    hostRef.current = (e.currentTarget ?? null) as HTMLElement | null;
  }, []);

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

  return (
    <View
      {...nativeHandlers}
      {...webHandlers}
      collapsable={false}
      onLayout={onViewportLayout}
      style={{
        width: "100%",
        overflow: "hidden",
        ...(Platform.OS === "web"
          ? ({
              touchAction: "pan-y",
              userSelect: "none",
              cursor: "grab",
            } as const)
          : null),
      }}
    >
      <Animated.View
        style={{
          flexDirection: "row",
          width: viewportWidth > 0 ? viewportWidth * slides.length : `${slides.length * 100}%`,
          transform: [{ translateX }],
        }}
      >
        {slides.map((slide, slideIndex) => (
          <View
            key={slideIndex}
            style={{
              width: viewportWidth > 0 ? viewportWidth : `${100 / slides.length}%`,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-start", width: "100%" }}>
              {slide.map((collection, index) => (
                <Fragment key={`${collection.title}-${slideIndex}-${index}`}>
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
        ))}
      </Animated.View>
    </View>
  );
}
