import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { layout, useColors } from "../theme";
import {
  applyIndependentEdgeResize,
  clampFloatingDialogOffset,
  clampFloatingDialogSize,
  cursorForFloatingDialogHandle,
  edgesForFloatingDialogHandle,
  FLOATING_DIALOG_HANDLES,
  readFloatingDialogStoredOffset,
  readFloatingDialogStoredSize,
  writeFloatingDialogStoredOffset,
  writeFloatingDialogStoredSize,
  type FloatingDialogOffset,
  type FloatingDialogResizeHandle,
  type FloatingDialogSize,
} from "./floatingDialogGeometry";
import {
  allocateFloatingSurfaceId,
  bringFloatingSurfaceToFront,
  FLOATING_SURFACE_BASE_Z,
  registerFloatingSurface,
  unregisterFloatingSurface,
} from "./floatingSurfaceStack";

const AH = layout.authenticatedHome;
const HIT = AH.splitPaneDividerHitWidthPx;
const STROKE = AH.splitPaneDividerStrokePx;
/** Pointer must travel this far before the sheet starts moving — otherwise clicks (theme radios, etc.) never fire. */
const MOVE_DRAG_THRESHOLD_PX = 5;

const FloatingDialogSizingContext = createContext({ contentSizing: false });

/** True while the shell is measuring intrinsic content height (fit-content open). */
export function useFloatingDialogContentSizing(): boolean {
  return useContext(FloatingDialogSizingContext).contentSizing;
}

export type FloatingDialogShellProps = {
  visible: boolean;
  children: ReactNode;
  /** Portal / Modal stacking order. */
  zIndex?: number;
  /** Default size when nothing stored. */
  defaultSize?: FloatingDialogSize;
  minSize?: FloatingDialogSize;
  /** Persist size/offset under these keys (web localStorage). */
  sizeStorageKey?: string;
  offsetStorageKey?: string;
  /**
   * When true and nothing is stored, open at content height (capped by viewport)
   * instead of a fixed default tall frame — matches the old profile card.
   */
  fitContentHeight?: boolean;
  /** Web-only edge resize. Default true. */
  resizable?: boolean;
  /** Drag the sheet body to move (web). Default true. */
  movable?: boolean;
  /** Selector of elements that must not start a move-drag (e.g. buttons). */
  moveIgnoreSelector?: string;
  /** Extra styles for the sheet chrome. */
  sheetStyle?: ViewStyle;
  /** Called when Escape is pressed (web). */
  onRequestClose?: () => void;
  /** Optional data attribute for debugging. */
  testId?: string;
};

function ResizeEdgeHandle({
  handle,
  onHoverChange,
  onPointerDown,
  topChromeReservePx = 52,
  bottomChromeReservePx = 0,
  northEndReservePx = 0,
}: {
  handle: FloatingDialogResizeHandle;
  onHoverChange: (hovered: boolean) => void;
  onPointerDown: (e: {
    nativeEvent: {
      clientX: number;
      clientY: number;
      pointerId: number;
      preventDefault?: () => void;
    };
    currentTarget?: unknown;
  }) => void;
  topChromeReservePx?: number;
  bottomChromeReservePx?: number;
  northEndReservePx?: number;
}) {
  const half = HIT / 2;
  const webPointerProps =
    Platform.OS === "web"
      ? ({
          onPointerDown: (e: {
            nativeEvent: {
              clientX: number;
              clientY: number;
              pointerId: number;
              preventDefault?: () => void;
              stopPropagation?: () => void;
            };
            currentTarget?: unknown;
            stopPropagation?: () => void;
          }) => {
            e.stopPropagation?.();
            (e.nativeEvent as { stopPropagation?: () => void }).stopPropagation?.();
            onPointerDown(e);
          },
          onPointerEnter: () => onHoverChange(true),
          onPointerLeave: () => onHoverChange(false),
        } as object)
      : {};
  const base: ViewStyle = {
    position: "absolute",
    zIndex: 2,
    ...(Platform.OS === "web"
      ? ({
          cursor: cursorForFloatingDialogHandle(handle),
          touchAction: "none",
          userSelect: "none",
        } as object)
      : {}),
  };

  if (handle === "s") {
    const sideWidth = Math.max(HIT * 2, 48);
    return (
      <>
        <View
          style={[base, { bottom: -half, left: HIT, width: sideWidth, height: HIT }]}
          {...webPointerProps}
        />
        <View
          style={[base, { bottom: -half, right: HIT, width: sideWidth, height: HIT }]}
          {...webPointerProps}
        />
      </>
    );
  }

  let geometry: ViewStyle;
  switch (handle) {
    case "n":
      geometry = {
        top: -half,
        left: HIT,
        right: HIT + northEndReservePx,
        height: HIT,
      };
      break;
    case "e":
      geometry = {
        top: HIT + topChromeReservePx,
        bottom: HIT + bottomChromeReservePx,
        right: -half,
        width: HIT,
      };
      break;
    case "w":
      geometry = {
        top: HIT,
        bottom: HIT + bottomChromeReservePx,
        left: -half,
        width: HIT,
      };
      break;
    case "ne":
      geometry = {
        top: -half,
        right: -half,
        width: HIT,
        height: HIT,
        pointerEvents: "none",
        opacity: 0,
      };
      break;
    case "nw":
      geometry = { top: -half, left: -half, width: HIT, height: HIT };
      break;
    case "se":
      geometry = { bottom: -half, right: -half, width: HIT, height: HIT };
      break;
    default:
      geometry = { bottom: -half, left: -half, width: HIT, height: HIT };
      break;
  }

  return <View style={[base, geometry]} {...webPointerProps} />;
}

/**
 * Click-through floating dialog: underlay stays interactive; only the sheet
 * captures pointer events. Web supports independent-edge resize + move.
 */
export function FloatingDialogShell({
  visible,
  children,
  zIndex = FLOATING_SURFACE_BASE_Z,
  defaultSize = { width: 380, height: 420 },
  minSize = { width: 280, height: 220 },
  sizeStorageKey,
  offsetStorageKey,
  fitContentHeight = false,
  resizable = true,
  movable = true,
  moveIgnoreSelector = "button, a, input, textarea, [role='button'], [role='radio'], [role='checkbox'], [data-floating-no-drag]",
  sheetStyle,
  onRequestClose,
  testId = "floating-dialog",
}: FloatingDialogShellProps) {
  const colors = useColors();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const surfaceIdRef = useRef(allocateFloatingSurfaceId(testId));
  const [stackZ, setStackZ] = useState(() =>
    registerFloatingSurface(surfaceIdRef.current, zIndex),
  );

  const raiseToFront = useCallback(() => {
    setStackZ(bringFloatingSurfaceToFront(surfaceIdRef.current, zIndex));
  }, [zIndex]);

  useEffect(() => {
    const id = surfaceIdRef.current;
    return () => unregisterFloatingSurface(id);
  }, []);

  useEffect(() => {
    if (visible) raiseToFront();
  }, [raiseToFront, visible]);

  const maxSize = useMemo(
    (): FloatingDialogSize => ({
      width: Math.max(minSize.width, windowWidth - 2 * layout.contentSideInsetPx),
      height: Math.max(minSize.height, windowHeight - 2 * layout.contentSideInsetPx),
    }),
    [minSize.height, minSize.width, windowHeight, windowWidth],
  );

  const clampSize = useCallback(
    (size: FloatingDialogSize) => clampFloatingDialogSize(size, minSize, maxSize),
    [maxSize, minSize],
  );

  const [sheetSize, setSheetSize] = useState<FloatingDialogSize>(() => {
    const stored = sizeStorageKey && visible ? readFloatingDialogStoredSize(sizeStorageKey) : null;
    return clampSize(stored ?? defaultSize);
  });
  const [sheetOffset, setSheetOffset] = useState<FloatingDialogOffset>(() => {
    const storedOffset =
      offsetStorageKey && visible ? readFloatingDialogStoredOffset(offsetStorageKey) : null;
    const storedSize =
      sizeStorageKey && visible ? readFloatingDialogStoredSize(sizeStorageKey) : null;
    const size = clampSize(storedSize ?? defaultSize);
    return clampFloatingDialogOffset(storedOffset ?? { x: 0, y: 0 }, size, windowWidth, windowHeight);
  });
  const [contentSizing, setContentSizing] = useState(() => {
    if (!visible) return false;
    if (sizeStorageKey) {
      const stored = readFloatingDialogStoredSize(sizeStorageKey);
      // If we have stored geometry, don't try to measure intrinsic height.
      return !stored && fitContentHeight;
    }
    return fitContentHeight;
  });
  const [hoveredHandle, setHoveredHandle] = useState<FloatingDialogResizeHandle | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<FloatingDialogResizeHandle | null>(null);
  const [movingSheet, setMovingSheet] = useState(false);

  const dragRef = useRef<{
    handle: FloatingDialogResizeHandle;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startOffsetX: number;
    startOffsetY: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const moveDragRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const pendingMoveRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
    pointerId: number;
    host: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void } | null;
  } | null>(null);
  const sheetSizeRef = useRef(sheetSize);
  sheetSizeRef.current = sheetSize;
  const sheetOffsetRef = useRef(sheetOffset);
  sheetOffsetRef.current = sheetOffset;

  useEffect(() => {
    if (!visible) {
      setContentSizing(false);
      return;
    }
    if (sizeStorageKey) {
      const stored = readFloatingDialogStoredSize(sizeStorageKey);
      if (stored) {
        setSheetSize(clampSize(stored));
        setContentSizing(false);
      } else {
        setSheetSize(clampSize(defaultSize));
        setContentSizing(fitContentHeight);
      }
    } else {
      setSheetSize(clampSize(defaultSize));
      setContentSizing(fitContentHeight);
    }
    if (offsetStorageKey) {
      const storedOffset = readFloatingDialogStoredOffset(offsetStorageKey);
      setSheetOffset(
        clampFloatingDialogOffset(
          storedOffset ?? { x: 0, y: 0 },
          sheetSizeRef.current,
          windowWidth,
          windowHeight,
        ),
      );
    } else {
      setSheetOffset({ x: 0, y: 0 });
    }
  }, [
    clampSize,
    defaultSize,
    fitContentHeight,
    offsetStorageKey,
    sizeStorageKey,
    visible,
    windowHeight,
    windowWidth,
  ]);

  useEffect(() => {
    setSheetSize((prev) => clampSize(prev));
    setSheetOffset((prev) =>
      clampFloatingDialogOffset(prev, sheetSizeRef.current, windowWidth, windowHeight),
    );
  }, [clampSize, windowHeight, windowWidth]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.host && typeof drag.host.releasePointerCapture === "function") {
      try {
        drag.host.releasePointerCapture(drag.pointerId);
      } catch {
        // ignore
      }
    }
    dragRef.current = null;
    setDraggingHandle(null);
    if (sizeStorageKey) writeFloatingDialogStoredSize(sizeStorageKey, sheetSizeRef.current);
    if (offsetStorageKey) {
      writeFloatingDialogStoredOffset(offsetStorageKey, sheetOffsetRef.current);
    }
  }, [offsetStorageKey, sizeStorageKey]);

  const endMoveDrag = useCallback(() => {
    pendingMoveRef.current = null;
    const move = moveDragRef.current;
    if (move?.host && typeof move.host.releasePointerCapture === "function") {
      try {
        move.host.releasePointerCapture(move.pointerId);
      } catch {
        // ignore
      }
    }
    const didMove = move != null;
    moveDragRef.current = null;
    setMovingSheet(false);
    if (didMove && offsetStorageKey) {
      writeFloatingDialogStoredOffset(offsetStorageKey, sheetOffsetRef.current);
    }
  }, [offsetStorageKey]);

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
      const pending = pendingMoveRef.current;
      if (pending && !moveDragRef.current) {
        const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
        if (dist < MOVE_DRAG_THRESHOLD_PX) return;
        pendingMoveRef.current = null;
        if (pending.host && typeof pending.host.setPointerCapture === "function") {
          try {
            pending.host.setPointerCapture(pending.pointerId);
          } catch {
            // ignore
          }
        }
        moveDragRef.current = pending;
        setMovingSheet(true);
      }
      const move = moveDragRef.current;
      if (move) {
        const next = clampFloatingDialogOffset(
          {
            x: move.startOffsetX + (e.clientX - move.startX),
            y: move.startOffsetY + (e.clientY - move.startY),
          },
          sheetSizeRef.current,
          windowWidth,
          windowHeight,
        );
        setSheetOffset(next);
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const applied = applyIndependentEdgeResize({
        handle: drag.handle,
        startSize: { width: drag.startWidth, height: drag.startHeight },
        startOffset: { x: drag.startOffsetX, y: drag.startOffsetY },
        dx: e.clientX - drag.startX,
        dy: e.clientY - drag.startY,
        clampSize,
      });
      const offset = clampFloatingDialogOffset(
        applied.offset,
        applied.size,
        windowWidth,
        windowHeight,
      );
      setSheetSize(applied.size);
      setSheetOffset(offset);
    };
    const onUp = () => {
      pendingMoveRef.current = null;
      if (moveDragRef.current) endMoveDrag();
      if (dragRef.current) endDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clampSize, endDrag, endMoveDrag, visible, windowHeight, windowWidth]);

  useEffect(() => {
    if (!visible || !onRequestClose || Platform.OS !== "web" || typeof window === "undefined") {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        e.stopPropagation();
        onRequestClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onRequestClose, visible]);

  const beginDrag = useCallback(
    (
      handle: FloatingDialogResizeHandle,
      e: {
        nativeEvent: {
          clientX: number;
          clientY: number;
          pointerId: number;
          preventDefault?: () => void;
        };
        currentTarget?: unknown;
      },
    ) => {
      e.nativeEvent.preventDefault?.();
      moveDragRef.current = null;
      setMovingSheet(false);
      const host = e.currentTarget as {
        setPointerCapture?: (id: number) => void;
        releasePointerCapture?: (id: number) => void;
      } | null;
      if (host && typeof host.setPointerCapture === "function") {
        try {
          host.setPointerCapture(e.nativeEvent.pointerId);
        } catch {
          // ignore
        }
      }
      dragRef.current = {
        handle,
        startX: e.nativeEvent.clientX,
        startY: e.nativeEvent.clientY,
        startWidth: sheetSizeRef.current.width,
        startHeight: sheetSizeRef.current.height,
        startOffsetX: sheetOffsetRef.current.x,
        startOffsetY: sheetOffsetRef.current.y,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
      setDraggingHandle(handle);
      raiseToFront();
    },
    [raiseToFront],
  );

  const beginMoveDrag = useCallback(
    (e: {
      nativeEvent: {
        clientX: number;
        clientY: number;
        pointerId: number;
        button?: number;
        target?: EventTarget | null;
        preventDefault?: () => void;
        stopPropagation?: () => void;
      };
      currentTarget?: unknown;
    }) => {
      raiseToFront();
      if (!movable || Platform.OS !== "web") return;
      if (e.nativeEvent.button != null && e.nativeEvent.button !== 0) return;
      const target = e.nativeEvent.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(moveIgnoreSelector)
      ) {
        return;
      }
      dragRef.current = null;
      setDraggingHandle(null);
      const host = e.currentTarget as {
        setPointerCapture?: (id: number) => void;
        releasePointerCapture?: (id: number) => void;
      } | null;
      pendingMoveRef.current = {
        startX: e.nativeEvent.clientX,
        startY: e.nativeEvent.clientY,
        startOffsetX: sheetOffsetRef.current.x,
        startOffsetY: sheetOffsetRef.current.y,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
    },
    [movable, moveIgnoreSelector, raiseToFront],
  );

  const activeEdges = useMemo(() => {
    const edges = new Set<"n" | "s" | "e" | "w">();
    if (hoveredHandle) {
      for (const edge of edgesForFloatingDialogHandle(hoveredHandle)) edges.add(edge);
    }
    if (draggingHandle) {
      for (const edge of edgesForFloatingDialogHandle(draggingHandle)) edges.add(edge);
    }
    return edges;
  }, [draggingHandle, hoveredHandle]);

  const borderColors = {
    borderTopColor: activeEdges.has("n") ? colors.primary : colors.highlight,
    borderRightColor: activeEdges.has("e") ? colors.primary : colors.highlight,
    borderBottomColor: activeEdges.has("s") ? colors.primary : colors.highlight,
    borderLeftColor: activeEdges.has("w") ? colors.primary : colors.highlight,
  };

  if (!visible) return null;

  const sheet = (
    <View
      pointerEvents="auto"
      onLayout={(e) => {
        if (!contentSizing) return;
        const measuredH = Math.round(e.nativeEvent.layout.height);
        if (!Number.isFinite(measuredH) || measuredH < minSize.height) return;
        const next = clampSize({ width: sheetSize.width, height: measuredH });
        setSheetSize(next);
        setContentSizing(false);
      }}
      style={[
        {
          width: sheetSize.width,
          maxWidth: sheetSize.width,
          ...(contentSizing
            ? {
                height: undefined,
                maxHeight: maxSize.height,
              }
            : {
                height: sheetSize.height,
                maxHeight: sheetSize.height,
              }),
          backgroundColor: colors.background,
          overflow: "visible",
          zIndex: 5,
          ...(Platform.OS === "web"
            ? ({
                position: "relative",
                isolation: "isolate",
                display: "flex",
                flexDirection: "column",
                transform: `translate(${sheetOffset.x}px, ${sheetOffset.y}px)`,
                cursor: movingSheet ? "grabbing" : movable ? "grab" : undefined,
                // Keep scroll inside the dialog when the pointer is over it.
                overscrollBehavior: "contain",
                boxSizing: "border-box",
                // Outline survives child backgrounds covering the border box.
                outlineStyle: "solid",
                outlineWidth: Math.max(1, STROKE),
                outlineColor: activeEdges.size > 0 ? colors.primary : colors.highlight,
                outlineOffset: 0,
              } as object)
            : {
                flexDirection: "column",
                transform: [{ translateX: sheetOffset.x }, { translateY: sheetOffset.y }],
              }),
        },
        sheetStyle,
        // Always paint dialog chrome last so callers cannot strip the border.
        {
          borderWidth: Math.max(1, STROKE),
          borderStyle: "solid" as const,
          borderColor: colors.highlight,
          ...borderColors,
        },
      ]}
      {...(Platform.OS === "web"
        ? ({
            [`data-${testId}`]: "1",
            onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            // Bubble phase so resize handles can own the gesture first.
            onPointerDown: beginMoveDrag,
          } as object)
        : { onStartShouldSetResponder: () => true })}
    >
      {Platform.OS === "web" && resizable
        ? FLOATING_DIALOG_HANDLES.map((handle) => (
            <ResizeEdgeHandle
              key={handle}
              handle={handle}
              onHoverChange={(hovered) =>
                setHoveredHandle((prev) => {
                  if (hovered) return handle;
                  return prev === handle ? null : prev;
                })
              }
              onPointerDown={(e) => beginDrag(handle, e)}
            />
          ))
        : null}
      <View
        style={{
          flex: contentSizing ? undefined : 1,
          flexGrow: contentSizing ? 0 : 1,
          flexShrink: 1,
          minHeight: contentSizing ? undefined : 0,
          minWidth: 0,
          // Visible so the scroll thumb can paint onto the 1px chrome border (inset -1).
          overflow: "visible",
          ...(Platform.OS === "web"
            ? ({ overscrollBehavior: "contain" } as object)
            : {}),
        }}
        pointerEvents="box-none"
      >
        <FloatingDialogSizingContext.Provider value={{ contentSizing }}>
          {children}
        </FloatingDialogSizingContext.Provider>
      </View>
    </View>
  );

  if (Platform.OS === "web" && typeof document !== "undefined") {
    return createPortal(
      <View
        pointerEvents="box-none"
        style={{
          position: "fixed" as unknown as "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: windowHeight,
          zIndex: stackZ,
          elevation: stackZ,
          justifyContent: "center",
          alignItems: "center",
          ...(Platform.OS === "web"
            ? ({
                width: "100vw",
                height: "100vh",
                pointerEvents: "none",
              } as object)
            : {}),
        }}
        {...({ [`data-${testId}-root`]: "1" } as object)}
      >
        {sheet}
      </View>,
      document.body,
    );
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onRequestClose}>
      <View
        pointerEvents="box-none"
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          minHeight: windowHeight,
        }}
      >
        {sheet}
      </View>
    </Modal>
  );
}
