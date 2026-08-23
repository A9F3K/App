import {
  useCallback,
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

const AH = layout.authenticatedHome;
const HIT = AH.splitPaneDividerHitWidthPx;
const STROKE = AH.splitPaneDividerStrokePx;

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
  zIndex = 10050,
  defaultSize = { width: 380, height: 420 },
  minSize = { width: 280, height: 220 },
  sizeStorageKey,
  offsetStorageKey,
  resizable = true,
  movable = true,
  moveIgnoreSelector = "button, a, input, textarea, [data-floating-no-drag]",
  sheetStyle,
  onRequestClose,
  testId = "floating-dialog",
}: FloatingDialogShellProps) {
  const colors = useColors();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

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

  const [sheetSize, setSheetSize] = useState<FloatingDialogSize>(() =>
    clampSize(defaultSize),
  );
  const [sheetOffset, setSheetOffset] = useState<FloatingDialogOffset>({ x: 0, y: 0 });
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
  const sheetSizeRef = useRef(sheetSize);
  sheetSizeRef.current = sheetSize;
  const sheetOffsetRef = useRef(sheetOffset);
  sheetOffsetRef.current = sheetOffset;

  useEffect(() => {
    if (!visible) return;
    if (sizeStorageKey) {
      const stored = readFloatingDialogStoredSize(sizeStorageKey);
      if (stored) setSheetSize(clampSize(stored));
      else setSheetSize(clampSize(defaultSize));
    } else {
      setSheetSize(clampSize(defaultSize));
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
    const move = moveDragRef.current;
    if (move?.host && typeof move.host.releasePointerCapture === "function") {
      try {
        move.host.releasePointerCapture(move.pointerId);
      } catch {
        // ignore
      }
    }
    moveDragRef.current = null;
    setMovingSheet(false);
    if (offsetStorageKey) {
      writeFloatingDialogStoredOffset(offsetStorageKey, sheetOffsetRef.current);
    }
  }, [offsetStorageKey]);

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
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
    },
    [],
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
      e.nativeEvent.preventDefault?.();
      e.nativeEvent.stopPropagation?.();
      dragRef.current = null;
      setDraggingHandle(null);
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
      moveDragRef.current = {
        startX: e.nativeEvent.clientX,
        startY: e.nativeEvent.clientY,
        startOffsetX: sheetOffsetRef.current.x,
        startOffsetY: sheetOffsetRef.current.y,
        pointerId: e.nativeEvent.pointerId,
        host,
      };
      setMovingSheet(true);
    },
    [movable, moveIgnoreSelector],
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
      style={[
        {
          width: sheetSize.width,
          maxWidth: sheetSize.width,
          height: sheetSize.height,
          maxHeight: sheetSize.height,
          backgroundColor: colors.background,
          borderColor: colors.highlight,
          borderWidth: STROKE,
          ...borderColors,
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
              } as object)
            : {
                flexDirection: "column",
                transform: [{ translateX: sheetOffset.x }, { translateY: sheetOffset.y }],
              }),
        },
        sheetStyle,
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
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          ...(Platform.OS === "web"
            ? ({ overscrollBehavior: "contain" } as object)
            : {}),
        }}
        pointerEvents="box-none"
      >
        {children}
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
          zIndex,
          elevation: zIndex,
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
