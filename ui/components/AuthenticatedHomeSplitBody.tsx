import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  PixelRatio,
  Platform,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { logPageDisplay } from "../pageDisplayLog";
import { hairlineBorderWidthPx } from "../scrollIndicatorPx";
import { layout, useColors } from "../theme";
import {
  AuthenticatedHomeSplitLayoutMetricsProvider,
  type AuthenticatedHomeSplitLayoutMetrics,
} from "./AuthenticatedHomeSplitLayoutMetricsContext";

const AH = layout.authenticatedHome;
const HIT = AH.splitPaneDividerHitWidthPx;

/** Center `HIT`-wide grab strip on the seam so flex columns abut. */
const SPLIT_PANE_HIT_LEFT_OF_SEAM = Math.floor(HIT / 2);

function splitPaneLineLeftInHit(strokePx: number): number {
  return Math.max(0, Math.floor((HIT - strokePx) / 2));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function maxLeftDual(rw: number): number {
  return Math.min(AH.splitPaneMaxFirstColumnPx, rw - AH.splitPaneMinSecondColumnPx);
}

/** First-column cap when three columns: reserve min middle + current third width (dividers overlay, no flex width). */
function maxLeftTriple(rw: number, thirdW: number): number {
  return Math.min(AH.splitPaneMaxFirstColumnPx, rw - AH.splitPaneMinSecondColumnPx - thirdW);
}

/** Third-column cap: remaining width for third after first column + minimum middle. */
function maxThirdPane(rw: number, leftW: number): number {
  return rw - leftW - AH.splitPaneMinSecondColumnPx;
}

function snapLeftPaneToDeviceSeam(leftPane: number, dpr: number, lo: number, hi: number): number {
  if (Platform.OS === "web") {
    const seamSnapped = Math.round(leftPane * dpr) / dpr;
    return clamp(seamSnapped, lo, hi);
  }
  return clamp(PixelRatio.roundToNearestPixel(leftPane), lo, hi);
}

/** Snap third-column width so the seam before it (x = rw - thirdPane) sits on device pixels. */
function snapThirdPaneToDeviceSeam(thirdPane: number, rw: number, dpr: number, lo: number, hi: number): number {
  if (Platform.OS === "web") {
    const seam = rw - thirdPane;
    const seamSnapped = Math.round(seam * dpr) / dpr;
    const next = rw - seamSnapped;
    return clamp(next, lo, hi);
  }
  return clamp(PixelRatio.roundToNearestPixel(thirdPane), lo, hi);
}

type Props = {
  /**
   * First column body. No horizontal padding is applied here: use full width for the top nav strip,
   * then wrap remaining blocks in `paddingHorizontal: layout.contentSideInsetPx` (see home screen).
   */
  left: ReactNode;
  /** Second column when two panes; middle (flex) column when three panes. */
  right: ReactNode;
  /** Third (rightmost) column when `rowWidth > secondBreakpoint`; optional placeholder if omitted. */
  farRight?: ReactNode;
  /**
   * Feed / main column: inactive footer pinned under `left` (all breakpoints when set).
   */
  leftColumnFooter?: ReactNode;
  /**
   * Wide two-column layout: footer pinned under `right` (swap or {@link GlobalBottomBar}).
   * Root layout omits the screen footer when this is set (see `authenticatedHomeBottomBarDock`).
   */
  middleColumnFooter?: ReactNode;
  /**
   * Wide three-column layout: footer pinned under `farRight` (typically {@link GlobalBottomBar}).
   */
  thirdColumnFooter?: ReactNode;
  /** Notifies parent when measured split layout changes (wide vs compact). */
  onSplitLayoutMetricsChange?: (metrics: AuthenticatedHomeSplitLayoutMetrics) => void;
};

/**
 * Full-bleed row under the authenticated header: one column below `firstBreakpoint`, two above it,
 * three above `secondBreakpoint`. In three-column mode the middle column flex-fills; the third has a
 * tunable width (default from theme) adjusted by the second divider (drag right = narrower third).
 */
export function AuthenticatedHomeSplitBody({
  left,
  right,
  farRight,
  leftColumnFooter,
  middleColumnFooter,
  thirdColumnFooter,
  onSplitLayoutMetricsChange,
}: Props) {
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState(0);
  const [leftPanePx, setLeftPanePx] = useState(AH.splitPaneDefaultFirstColumnPx);
  const [thirdPanePx, setThirdPanePx] = useState(AH.splitPaneDefaultThirdColumnPx);
  /** 0 = none; split-pane divider index for hover (web) / drag highlight. */
  const [splitDividerHovered, setSplitDividerHovered] = useState<0 | 1 | 2>(0);
  const [splitDividerDragging, setSplitDividerDragging] = useState<0 | 1 | 2>(0);

  const isWideRef = useRef(false);
  const isTripleRef = useRef(false);
  const rowWidthRef = useRef(0);
  const leftPaneRef = useRef(AH.splitPaneDefaultFirstColumnPx);
  const thirdPaneRef = useRef(AH.splitPaneDefaultThirdColumnPx);
  const dragStartLeftRef = useRef(AH.splitPaneDefaultFirstColumnPx);
  const dragStartThirdRef = useRef(AH.splitPaneDefaultThirdColumnPx);
  const activeDividerRef = useRef<1 | 2>(1);

  const pointerStartXRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const webDragActiveRef = useRef(false);
  const webActiveHostRef = useRef<HTMLElement | null>(null);
  const lastLoggedMoveKeyRef = useRef<string>("");
  const useWindowWidthRef = useRef(windowWidth);
  useWindowWidthRef.current = windowWidth;

  const dprRef = useRef(1);
  dprRef.current =
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.devicePixelRatio || PixelRatio.get()
      : PixelRatio.get();

  useEffect(() => {
    leftPaneRef.current = leftPanePx;
  }, [leftPanePx]);

  useEffect(() => {
    thirdPaneRef.current = thirdPanePx;
  }, [thirdPanePx]);

  useEffect(() => {
    rowWidthRef.current = rowWidth;
  }, [rowWidth]);

  const effectiveWidth = rowWidth > 0 ? rowWidth : windowWidth;
  const isWide = effectiveWidth > AH.firstBreakpoint;
  const isTriple = effectiveWidth > AH.secondBreakpoint;
  isWideRef.current = isWide;
  isTripleRef.current = isTriple;

  const splitLayoutMetrics = useMemo((): AuthenticatedHomeSplitLayoutMetrics => {
    const effectiveSplitWidthPx = effectiveWidth;
    const columnCount: 1 | 2 | 3 = !isWide ? 1 : isTriple ? 3 : 2;
    const measuredRow = rowWidth > 0 ? rowWidth : effectiveSplitWidthPx;
    const firstColumnWidthPx = isWide ? leftPanePx : effectiveSplitWidthPx;
    const middleColumnWidthPx = !isWide
      ? 0
      : isTriple
        ? Math.max(0, measuredRow - leftPanePx - thirdPanePx)
        : Math.max(0, measuredRow - leftPanePx);
    return {
      splitRowWidthPx: measuredRow,
      effectiveSplitWidthPx,
      firstColumnWidthPx,
      middleColumnWidthPx,
      columnCount,
    };
  }, [effectiveWidth, isWide, isTriple, rowWidth, leftPanePx, thirdPanePx]);

  useEffect(() => {
    onSplitLayoutMetricsChange?.(splitLayoutMetrics);
  }, [onSplitLayoutMetricsChange, splitLayoutMetrics]);

  useEffect(() => {
    if (isWide) return;
    setSplitDividerHovered(0);
    setSplitDividerDragging(0);
  }, [isWide]);

  useEffect(() => {
    if (!rowWidth || !isWide) return;
    const cap = isTriple ? maxLeftTriple(rowWidth, thirdPanePx) : maxLeftDual(rowWidth);
    if (cap < AH.splitPaneMinFirstColumnPx) return;
    setLeftPanePx((w) => {
      const c = clamp(w, AH.splitPaneMinFirstColumnPx, cap);
      const s = snapLeftPaneToDeviceSeam(c, dprRef.current, AH.splitPaneMinFirstColumnPx, cap);
      if (s !== w) {
        logPageDisplay("home_split_pane_clamp_effect", {
          prevLeftPx: w,
          nextLeftPx: s,
          cap,
          rowWidth,
          minLeftPx: AH.splitPaneMinFirstColumnPx,
          triple: isTriple,
        });
      }
      return s;
    });
  }, [rowWidth, isWide, isTriple, thirdPanePx]);

  useEffect(() => {
    if (!rowWidth || !isWide || !isTriple) return;
    const cap = maxThirdPane(rowWidth, leftPanePx);
    if (cap < AH.splitPaneMinThirdColumnPx) return;
    setThirdPanePx((w) => {
      const c = clamp(w, AH.splitPaneMinThirdColumnPx, cap);
      const s = snapThirdPaneToDeviceSeam(c, rowWidth, dprRef.current, AH.splitPaneMinThirdColumnPx, cap);
      if (s !== w) {
        logPageDisplay("home_split_pane_third_clamp_effect", {
          prevThirdPx: w,
          nextThirdPx: s,
          cap,
          rowWidth,
          leftPanePx,
        });
      }
      return s;
    });
  }, [rowWidth, isWide, isTriple, leftPanePx]);

  const grantDrag = useCallback((inputKind: "pointer" | "pan_responder") => {
    lastLoggedMoveKeyRef.current = "";
    const rw = rowWidthRef.current;
    const divider = activeDividerRef.current;
    const dpr = dprRef.current;

    if (divider === 1) {
      const cap =
        isTripleRef.current && rw > 0
          ? maxLeftTriple(rw, thirdPaneRef.current)
          : rw > 0
            ? maxLeftDual(rw)
            : 0;
      const lo = AH.splitPaneMinFirstColumnPx;
      let start = leftPaneRef.current;
      if (rw && cap >= lo) {
        const snapped = snapLeftPaneToDeviceSeam(start, dpr, lo, cap);
        if (snapped !== start) {
          start = snapped;
          leftPaneRef.current = snapped;
          dragStartLeftRef.current = snapped;
          setLeftPanePx(snapped);
        }
      }
      dragStartLeftRef.current = start;
    } else {
      const lo = AH.splitPaneMinThirdColumnPx;
      const cap = rw > 0 ? maxThirdPane(rw, leftPaneRef.current) : 0;
      let start = thirdPaneRef.current;
      if (rw && cap >= lo) {
        const snapped = snapThirdPaneToDeviceSeam(start, rw, dpr, lo, cap);
        if (snapped !== start) {
          start = snapped;
          thirdPaneRef.current = snapped;
          dragStartThirdRef.current = snapped;
          setThirdPanePx(snapped);
        }
      }
      dragStartThirdRef.current = start;
    }

    logPageDisplay("home_split_pane_drag", {
      phase: "grant",
      divider,
      dragStartLeftPx: divider === 1 ? dragStartLeftRef.current : undefined,
      dragStartThirdPx: divider === 2 ? dragStartThirdRef.current : undefined,
      rowWidthPx: rw,
      useWindowDimensionsWidthPx: useWindowWidthRef.current,
      isWide: isWideRef.current,
      triple: isTripleRef.current,
      dpr,
      input: inputKind,
    });
    setSplitDividerDragging(divider);
  }, []);

  const moveDragByDx = useCallback((dx: number, vx: number) => {
    const rw = rowWidthRef.current;
    if (!rw || !isWideRef.current) {
      logPageDisplay("home_split_pane_drag", {
        phase: "move_skip",
        reason: !rw ? "row_width_zero" : "not_wide",
        dx,
        vx,
      });
      return;
    }
    const divider = activeDividerRef.current;
    const dpr = dprRef.current;
    const triple = isTripleRef.current;

    if (divider === 1) {
      const cap = triple ? maxLeftTriple(rw, thirdPaneRef.current) : maxLeftDual(rw);
      if (cap < AH.splitPaneMinFirstColumnPx) {
        logPageDisplay("home_split_pane_drag", { phase: "move_skip", reason: "cap_below_min", cap });
        return;
      }
      const lo = AH.splitPaneMinFirstColumnPx;
      const raw = dragStartLeftRef.current + dx;
      const nextRounded = Math.round(clamp(raw, lo, cap));
      const next = snapLeftPaneToDeviceSeam(nextRounded, dpr, lo, cap);
      const key = `${divider}|${dx.toFixed(1)}|${raw.toFixed(1)}|${next}`;
      if (key !== lastLoggedMoveKeyRef.current) {
        lastLoggedMoveKeyRef.current = key;
        logPageDisplay("home_split_pane_drag", {
          phase: "move",
          divider: 1,
          dx,
          vx,
          rawLeftPx: raw,
          nextLeftPx: next,
          capLeftPx: cap,
          rowWidthPx: rw,
          dpr,
          seamCssPx: next,
          clampedToMin: next <= lo && raw < lo,
          clampedToMax: next >= cap && raw > cap,
        });
      }
      setLeftPanePx((prev) => (prev === next ? prev : next));
    } else {
      if (!triple) return;
      const lo = AH.splitPaneMinThirdColumnPx;
      const cap = maxThirdPane(rw, leftPaneRef.current);
      if (cap < lo) {
        logPageDisplay("home_split_pane_drag", { phase: "move_skip", reason: "third_cap_below_min", cap });
        return;
      }
      /* Drag divider right (positive dx) → third column narrower. */
      const raw = dragStartThirdRef.current - dx;
      const nextRounded = Math.round(clamp(raw, lo, cap));
      const next = snapThirdPaneToDeviceSeam(nextRounded, rw, dpr, lo, cap);
      const key = `${divider}|${dx.toFixed(1)}|${raw.toFixed(1)}|${next}`;
      if (key !== lastLoggedMoveKeyRef.current) {
        lastLoggedMoveKeyRef.current = key;
        const seamCssPx = rw - next;
        logPageDisplay("home_split_pane_drag", {
          phase: "move",
          divider: 2,
          dx,
          vx,
          rawThirdPx: raw,
          nextThirdPx: next,
          capThirdPx: cap,
          rowWidthPx: rw,
          leftPanePx: leftPaneRef.current,
          dpr,
          seamCssPx,
          clampedToMin: next <= lo && raw < lo,
          clampedToMax: next >= cap && raw > cap,
        });
      }
      setThirdPanePx((prev) => (prev === next ? prev : next));
    }
  }, []);

  const endDrag = useCallback(
    (
      phase: "release" | "terminate",
      totalDx: number,
      totalVx: number,
      inputKind: "pointer" | "pan_responder",
    ) => {
      try {
        const rw = rowWidthRef.current;
        const divider = activeDividerRef.current;
        const dpr = dprRef.current;
        const triple = isTripleRef.current;

        if (divider === 1) {
          const cap =
            triple && rw > 0
              ? maxLeftTriple(rw, thirdPaneRef.current)
              : rw > 0
                ? maxLeftDual(rw)
                : 0;
          const lo = AH.splitPaneMinFirstColumnPx;
          const before = leftPaneRef.current;
          const snapped =
            rw && cap >= lo ? snapLeftPaneToDeviceSeam(before, dpr, lo, cap) : before;
          if (snapped !== before) {
            leftPaneRef.current = snapped;
            setLeftPanePx(snapped);
          }
          logPageDisplay("home_split_pane_drag", {
            phase,
            divider: 1,
            finalLeftPx: snapped,
            snapDeltaPx: snapped - before,
            seamCssPx: snapped,
            totalDx,
            totalVx,
            rowWidthPx: rw,
            capLeftPx: cap,
            dpr,
            input: inputKind,
          });
        } else if (triple && rw > 0) {
          const lo = AH.splitPaneMinThirdColumnPx;
          const cap = maxThirdPane(rw, leftPaneRef.current);
          const before = thirdPaneRef.current;
          const snapped =
            cap >= lo ? snapThirdPaneToDeviceSeam(before, rw, dpr, lo, cap) : before;
          if (snapped !== before) {
            thirdPaneRef.current = snapped;
            setThirdPanePx(snapped);
          }
          logPageDisplay("home_split_pane_drag", {
            phase,
            divider: 2,
            finalThirdPx: snapped,
            snapDeltaPx: snapped - before,
            seamCssPx: rw - snapped,
            totalDx,
            totalVx,
            rowWidthPx: rw,
            capThirdPx: cap,
            leftPanePx: leftPaneRef.current,
            dpr,
            input: inputKind,
          });
        }
      } finally {
        setSplitDividerDragging(0);
      }
    },
    [],
  );

  const releasePointerCaptureIfNeeded = useCallback((host: HTMLElement | null) => {
    const pid = activePointerIdRef.current;
    if (pid == null || !host || typeof host.releasePointerCapture !== "function") {
      webDragActiveRef.current = false;
      webActiveHostRef.current = null;
      return;
    }
    try {
      if (host.hasPointerCapture?.(pid)) {
        host.releasePointerCapture(pid);
      }
    } catch {
      /* ignore */
    }
    activePointerIdRef.current = null;
    webDragActiveRef.current = false;
    webActiveHostRef.current = null;
  }, []);

  const beginWebDrag = useCallback(
    (
      divider: 1 | 2,
      e: {
        nativeEvent: { clientX: number; pointerId: number; preventDefault?: () => void };
        currentTarget?: unknown;
      },
    ) => {
      if (!isWideRef.current) return;
      if (divider === 2 && !isTripleRef.current) return;
      activeDividerRef.current = divider;
      const ne = e.nativeEvent;
      ne.preventDefault?.();
      pointerStartXRef.current = ne.clientX;
      grantDrag("pointer");
      const host = (e.currentTarget ?? null) as HTMLElement | null;
      webActiveHostRef.current = host;
      if (host && typeof host.setPointerCapture === "function" && typeof ne.pointerId === "number") {
        try {
          host.setPointerCapture(ne.pointerId);
          activePointerIdRef.current = ne.pointerId;
        } catch {
          activePointerIdRef.current = null;
        }
      }
      webDragActiveRef.current = true;
    },
    [grantDrag],
  );

  const handleWebPointerMove = useCallback(
    (e: { nativeEvent: { clientX: number } }) => {
      if (!webDragActiveRef.current) return;
      const dx = e.nativeEvent.clientX - pointerStartXRef.current;
      moveDragByDx(dx, 0);
    },
    [moveDragByDx],
  );

  const handleWebPointerUp = useCallback(
    (e: { nativeEvent: { clientX: number } }) => {
      if (!webDragActiveRef.current) return;
      const dx = e.nativeEvent.clientX - pointerStartXRef.current;
      endDrag("release", dx, 0, "pointer");
      releasePointerCaptureIfNeeded(webActiveHostRef.current);
    },
    [endDrag, releasePointerCaptureIfNeeded],
  );

  const handleWebPointerCancel = useCallback(
    (e: { nativeEvent: { clientX: number } }) => {
      if (!webDragActiveRef.current) return;
      const dx = e.nativeEvent.clientX - pointerStartXRef.current;
      endDrag("terminate", dx, 0, "pointer");
      releasePointerCaptureIfNeeded(webActiveHostRef.current);
    },
    [endDrag, releasePointerCaptureIfNeeded],
  );

  const handleWebLostPointerCapture = useCallback(() => {
    if (!webDragActiveRef.current) return;
    logPageDisplay("home_split_pane_drag", {
      phase: "lost_pointer_capture",
      rowWidthPx: rowWidthRef.current,
      isWide: isWideRef.current,
      input: "pointer",
    });
    endDrag("terminate", 0, 0, "pointer");
    activePointerIdRef.current = null;
    webDragActiveRef.current = false;
    webActiveHostRef.current = null;
  }, [endDrag]);

  const webPointerProps = (
    divider: 1 | 2,
  ):
    | {
        onPointerDown: (e: {
          nativeEvent: { clientX: number; pointerId: number; preventDefault?: () => void };
          currentTarget?: unknown;
        }) => void;
        onPointerMove: (e: { nativeEvent: { clientX: number } }) => void;
        onPointerUp: (e: { nativeEvent: { clientX: number } }) => void;
        onPointerCancel: (e: { nativeEvent: { clientX: number } }) => void;
        onLostPointerCapture: () => void;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
      }
    | null =>
    Platform.OS === "web"
      ? {
          onPointerDown: (e) => beginWebDrag(divider, e),
          onPointerMove: handleWebPointerMove,
          onPointerUp: handleWebPointerUp,
          onPointerCancel: handleWebPointerCancel,
          onLostPointerCapture: handleWebLostPointerCapture,
          onPointerEnter: () => {
            setSplitDividerHovered(divider);
          },
          onPointerLeave: () => {
            setSplitDividerHovered((h) => (h === divider ? 0 : h));
          },
        }
      : null;

  const panResponder1 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () =>
        Platform.OS !== "web" && isWideRef.current,
      onMoveShouldSetPanResponder: (_, g) =>
        Platform.OS !== "web" && isWideRef.current && Math.abs(g.dx) > 0.5,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => Platform.OS !== "web",
      onPanResponderGrant: () => {
        activeDividerRef.current = 1;
        grantDrag("pan_responder");
      },
      onPanResponderMove: (_, g) => moveDragByDx(g.dx, g.vx),
      onPanResponderRelease: (_, g) => {
        endDrag("release", g.dx, g.vx, "pan_responder");
      },
      onPanResponderTerminate: (_, g) => {
        endDrag("terminate", g.dx, g.vx, "pan_responder");
      },
    }),
  ).current;

  const panResponder2 = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () =>
        Platform.OS !== "web" && isWideRef.current && isTripleRef.current,
      onMoveShouldSetPanResponder: (_, g) =>
        Platform.OS !== "web" &&
        isWideRef.current &&
        isTripleRef.current &&
        Math.abs(g.dx) > 0.5,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => Platform.OS !== "web",
      onPanResponderGrant: () => {
        activeDividerRef.current = 2;
        grantDrag("pan_responder");
      },
      onPanResponderMove: (_, g) => moveDragByDx(g.dx, g.vx),
      onPanResponderRelease: (_, g) => {
        endDrag("release", g.dx, g.vx, "pan_responder");
      },
      onPanResponderTerminate: (_, g) => {
        endDrag("terminate", g.dx, g.vx, "pan_responder");
      },
    }),
  ).current;

  const bottomInset = AH.contentInsetBottom;
  /** Match scroll thumbs (one device pixel) so indicators overlay seams without a thicker band. */
  const stroke = hairlineBorderWidthPx();
  const lineLeft = splitPaneLineLeftInHit(stroke);

  function overlayDividerHitStyle(leftPx: number): ViewStyle[] {
    return [
      {
        position: "absolute" as const,
        left: leftPx,
        width: HIT,
        top: 0,
        bottom: 0,
        zIndex: AH.splitPaneDividerOverlayZIndex,
      },
      Platform.OS === "web" && isWide
        ? ({
            cursor: "col-resize",
            touchAction: "none",
            overflow: "visible",
            userSelect: "none",
          } as unknown as ViewStyle)
        : {},
    ];
  }

  const dividerLineStyleFor = (which: 1 | 2): ViewStyle => {
    const active = splitDividerHovered === which || splitDividerDragging === which;
    const lineColor = active ? colors.primary : colors.highlight;
    return Platform.OS === "web"
      ? {
          position: "absolute",
          left: lineLeft,
          top: 0,
          bottom: 0,
          width: 0,
          borderLeftWidth: stroke,
          borderLeftColor: lineColor,
          borderStyle: "solid",
          backgroundColor: "transparent",
        }
      : {
          position: "absolute",
          left: lineLeft,
          top: 0,
          bottom: 0,
          width: stroke,
          backgroundColor: lineColor,
        };
  };

  /** Global main content horizontal inset; split-pane columns use this for padding (divider hit width is separate). */
  const inset = layout.contentSideInsetPx;
  const third = farRight ?? <View />;
  const splitRowW = rowWidth > 0 ? rowWidth : windowWidth;
  const firstDividerLeft = leftPanePx - SPLIT_PANE_HIT_LEFT_OF_SEAM;
  const secondDividerLeft = isTriple ? splitRowW - thirdPanePx - SPLIT_PANE_HIT_LEFT_OF_SEAM : 0;

  const middleFlexBase = {
    flex: 1 as const,
    minWidth: AH.splitPaneMinSecondColumnPx,
    minHeight: 0,
  };

  const columnAiBarWrapStyle: ViewStyle =
    Platform.OS === "web"
      ? { position: "sticky", bottom: 0, zIndex: 2, alignSelf: "stretch" }
      : { alignSelf: "stretch" };

  const middleColumn = (() => {
    if (middleColumnFooter && !isTriple) {
      return (
        <View style={{ ...middleFlexBase, flexDirection: "column", minHeight: 0 }}>
          <View style={{ flex: 1, minHeight: 0, paddingHorizontal: inset, overflow: "visible" }}>{right}</View>
          <View style={columnAiBarWrapStyle}>{middleColumnFooter}</View>
        </View>
      );
    }
    if (middleColumnFooter && isTriple) {
      return (
        <View style={{ ...middleFlexBase, flexDirection: "column", minHeight: 0 }}>
          <View style={{ flex: 1, minHeight: 0, paddingHorizontal: inset, overflow: "visible" }}>{right}</View>
          <View style={columnAiBarWrapStyle}>{middleColumnFooter}</View>
        </View>
      );
    }
    return (
      <View style={{ ...middleFlexBase, flexDirection: "column", minHeight: 0 }}>
        <View style={{ flex: 1, minHeight: 0, paddingHorizontal: inset, overflow: "visible" }}>{right}</View>
      </View>
    );
  })();

  const thirdColumn = (() => {
    if (!isTriple) return null;
    if (thirdColumnFooter) {
      return (
        <View
          style={{
            width: thirdPanePx,
            flexShrink: 0,
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <View style={{ flex: 1, minHeight: 0, paddingHorizontal: inset }}>{third}</View>
          <View style={columnAiBarWrapStyle}>{thirdColumnFooter}</View>
        </View>
      );
    }
    return (
      <View
        style={{
          width: thirdPanePx,
          flexShrink: 0,
          paddingHorizontal: inset,
          paddingBottom: bottomInset,
        }}
      >
        {third}
      </View>
    );
  })();

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        alignSelf: "stretch",
      }}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        setRowWidth((cur) => {
          if (cur === w) return cur;
          logPageDisplay("home_split_pane_layout", {
            rowWidthPx: w,
            prevRowWidthPx: cur,
            effectiveWide: w > AH.firstBreakpoint,
            effectiveTriple: w > AH.secondBreakpoint,
          });
          return w;
        });
      }}
    >
      <AuthenticatedHomeSplitLayoutMetricsProvider value={splitLayoutMetrics}>
        {!isWide ? (
          leftColumnFooter ? (
            <View style={{ flex: 1, width: "100%", flexDirection: "column", minHeight: 0 }}>
              <View style={{ flex: 1, minHeight: 0 }}>{left}</View>
              <View style={columnAiBarWrapStyle}>{leftColumnFooter}</View>
            </View>
          ) : (
            <View style={{ flex: 1, minHeight: 0, width: "100%", alignSelf: "stretch" }}>{left}</View>
          )
        ) : (
          <View
            style={{
              flex: 1,
              width: "100%",
              flexDirection: "row",
              alignItems: "stretch",
              marginBottom: -bottomInset,
              position: "relative",
            }}
          >
            {leftColumnFooter ? (
              <View
                style={{
                  width: leftPanePx,
                  flexShrink: 0,
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                <View style={{ flex: 1, minHeight: 0 }}>{left}</View>
                <View style={columnAiBarWrapStyle}>{leftColumnFooter}</View>
              </View>
            ) : (
              <View
                style={{
                  width: leftPanePx,
                  flexShrink: 0,
                  paddingBottom: bottomInset,
                }}
              >
                {left}
              </View>
            )}
            {middleColumn}
            {thirdColumn}
            <View
              style={overlayDividerHitStyle(firstDividerLeft)}
              {...(webPointerProps(1) ?? {})}
              {...(Platform.OS === "web" ? {} : panResponder1.panHandlers)}
            >
              <View pointerEvents="none" style={dividerLineStyleFor(1)} />
            </View>
            {isTriple ? (
              <View
                style={overlayDividerHitStyle(secondDividerLeft)}
                {...(webPointerProps(2) ?? {})}
                {...(Platform.OS === "web" ? {} : panResponder2.panHandlers)}
              >
                <View pointerEvents="none" style={dividerLineStyleFor(2)} />
              </View>
            ) : null}
          </View>
        )}
      </AuthenticatedHomeSplitLayoutMetricsProvider>
    </View>
  );
}
