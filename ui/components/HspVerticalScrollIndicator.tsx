import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { createPortal } from "react-dom";

import { resolveWebRefElement } from "../smart/resolveWebLayoutElement";
import {
  isScrollIndicatorAtViewportRightEdge,
  isSplitColumnFlushRight,
  scrollIndicatorHairlineBorderWidthPx,
  scrollIndicatorPortalLeftPx,
  SCROLL_INDICATOR_VIEWPORT_EDGE_THUMB_PX,
  snapScrollIndicatorCoordPx,
} from "../scrollIndicatorPx";
import { layout } from "../theme";
import { peekTopFloatingSurfaceZ } from "./floatingSurfaceStack";
import { ScrollIndicatorDragHandle } from "./ScrollIndicatorDragHandle";
import { useTelegram } from "./Telegram";
import { useAuthenticatedHomeSplitLayoutMetrics } from "./AuthenticatedHomeSplitLayoutMetricsContext";

const SEAM_OVERLAY_Z = layout.authenticatedHome.scrollIndicatorOverlayZIndex;
/** Keep above FloatingDialogShell stack (Pro Access uses minZ 12050; raise-to-front climbs). */
const DIALOG_BODY_PORTAL_Z_FLOOR = 200_000;
/** Match FloatingDialogShell east chrome (1 CSS px frame stroke). */
const DIALOG_THUMB_CROSS_AXIS_PX = 1;
/** Split-pane remounts often leave shell height/width at 0 for several frames. */
const SEAM_SYNC_RETRY_FRAMES = 24;

type TrackBox = {
  /** Viewport X of the column’s right edge (thumb paints leftward from here). */
  rightPx: number;
  topPx: number;
  heightPx: number;
};

type DialogChromeBox = {
  /** Viewport Y of the dialog body top (fixed portal). */
  topPx: number;
  heightPx: number;
  /** Viewport X of the sheet’s right chrome edge (thumb paints leftward). */
  rightPx: number;
};

type Props = {
  show: boolean;
  /** Shell to align against (column scroll viewport). */
  shellRef: RefObject<View | null>;
  trackH: number;
  thumbH: number;
  thumbTop: number;
  maxScroll: number;
  thumbColor: string;
  scrollbarRightInsetPx: number;
  /**
   * Override seam portal. Default: portal when inset is 0 on web (split-pane columns).
   * Floating dialogs pass false so the thumb stays on the dialog’s right edge.
   */
  overlaySeam?: boolean;
  scrollIndicatorExtendBottomPx?: number;
  scrollIndicatorExtendTopPx?: number;
  onScrollTo: (y: number) => void;
  style?: StyleProp<ViewStyle>;
};

function findDomNode(ref: View | null): HTMLElement | null {
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

function findFloatingDialogBody(shell: HTMLElement | null): HTMLElement | null {
  if (!shell) return null;
  const body =
    shell.closest("[data-hsp-floating-dialog-body]") ??
    shell.closest(".hsp-floating-dialog-body");
  return body instanceof HTMLElement ? body : null;
}

function findFloatingDialogSheet(from: HTMLElement | null): HTMLElement | null {
  if (!from) return null;
  const sheet = from.closest("[data-hsp-floating-dialog-sheet]");
  return sheet instanceof HTMLElement ? sheet : null;
}

/**
 * Vertical 1px scroll thumb.
 *
 * When {@link scrollbarRightInsetPx} is `0` on web, the rail is portaled above the split-pane
 * seam overlay so it can sit on the divider (music-bar style) without being covered by it.
 * Footers keep their edge stroke via the divider overlay; only the thumb escapes column stacking.
 *
 * Inside floating dialogs, the rail is portaled to `document.body` with `position:fixed`
 * above the dialog stack so edge borders / sticky chrome cannot cover it, spanning the
 * full right chrome (header + scroll + footer).
 */
export function HspVerticalScrollIndicator({
  show,
  shellRef,
  trackH,
  thumbH,
  thumbTop,
  maxScroll,
  thumbColor,
  scrollbarRightInsetPx,
  overlaySeam: overlaySeamProp,
  scrollIndicatorExtendBottomPx = 0,
  scrollIndicatorExtendTopPx = 0,
  onScrollTo,
  style,
}: Props) {
  const { colorScheme } = useTelegram();
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  const hairline = scrollIndicatorHairlineBorderWidthPx();
  const extendBottom = Math.max(0, scrollIndicatorExtendBottomPx);
  const extendTop = Math.max(0, scrollIndicatorExtendTopPx);
  const overlaySeam =
    overlaySeamProp ?? (Platform.OS === "web" && scrollbarRightInsetPx <= 0);

  const [seamBox, setSeamBox] = useState<TrackBox | null>(null);
  const [dialogChrome, setDialogChrome] = useState<{
    box: DialogChromeBox;
  } | null>(null);

  const applySeamBox = useCallback(
    (x: number, y: number, w: number, h: number): boolean => {
      if (!(w > 0) || !(h > 0)) return false;
      const next: TrackBox = {
        rightPx: snapScrollIndicatorCoordPx(x + w),
        // Extend the track upward through sticky dialog / column chrome.
        topPx: snapScrollIndicatorCoordPx(y - extendTop),
        heightPx: snapScrollIndicatorCoordPx(Math.max(trackH, h + extendTop + extendBottom)),
      };
      setSeamBox((prev) =>
        prev &&
        prev.rightPx === next.rightPx &&
        prev.topPx === next.topPx &&
        prev.heightPx === next.heightPx
          ? prev
          : next,
      );
      return true;
    },
    [trackH, extendBottom, extendTop],
  );

  const syncDialogChrome = useCallback((): boolean => {
    if (Platform.OS !== "web" || overlaySeam || !show) {
      setDialogChrome(null);
      return true;
    }
    const shellDom = findDomNode(shellRef.current);
    const body = findFloatingDialogBody(shellDom);
    const sheet =
      findFloatingDialogSheet(shellDom) ?? findFloatingDialogSheet(body);
    if (!body || !sheet) {
      setDialogChrome(null);
      return false;
    }
    const bodyRect = body.getBoundingClientRect();
    const sheetRect = sheet.getBoundingClientRect();
    if (!(bodyRect.height > 0) || !(sheetRect.width > 0)) {
      setDialogChrome(null);
      return false;
    }
    // Viewport coords: sit on the sheet’s east chrome border for the full body height.
    const nextBox: DialogChromeBox = {
      topPx: snapScrollIndicatorCoordPx(bodyRect.top),
      heightPx: snapScrollIndicatorCoordPx(Math.max(trackH, bodyRect.height)),
      rightPx: snapScrollIndicatorCoordPx(sheetRect.right),
    };
    setDialogChrome((prev) =>
      prev &&
      prev.box.topPx === nextBox.topPx &&
      prev.box.heightPx === nextBox.heightPx &&
      prev.box.rightPx === nextBox.rightPx
        ? prev
        : { box: nextBox },
    );
    return true;
  }, [overlaySeam, show, shellRef, trackH]);

  const syncSeamBox = useCallback((): boolean => {
    if (!overlaySeam || !show) {
      setSeamBox(null);
      return true;
    }
    // Prefer getBoundingClientRect — measureInWindow can miss the first paint at mid breakpoints.
    const dom = findDomNode(shellRef.current);
    if (dom) {
      const rect = dom.getBoundingClientRect();
      return applySeamBox(rect.left, rect.top, rect.width, rect.height);
    }
    let measured = false;
    shellRef.current?.measureInWindow((x, y, w, h) => {
      measured = applySeamBox(x, y, w, h);
    });
    return measured;
  }, [overlaySeam, show, shellRef, applySeamBox]);

  useLayoutEffect(() => {
    if (!overlaySeam || !show) {
      setSeamBox(null);
      return;
    }
    const onWin = () => {
      syncSeamBox();
    };
    let ro: ResizeObserver | null = null;
    const observeShell = () => {
      const dom = findDomNode(shellRef.current);
      if (!dom || typeof ResizeObserver === "undefined") return false;
      if (ro) ro.disconnect();
      ro = new ResizeObserver(onWin);
      ro.observe(dom);
      const host = dom.closest("[data-hsp-split-column-scroll-host]");
      if (host && host instanceof HTMLElement) {
        ro.observe(host);
      }
      return true;
    };

    syncSeamBox();
    observeShell();

    let cancelled = false;
    let frame = 0;
    let rafId = 0;
    let measuredOk = syncSeamBox();
    const pump = () => {
      if (cancelled) return;
      measuredOk = syncSeamBox() || measuredOk;
      observeShell();
      frame += 1;
      if (frame < SEAM_SYNC_RETRY_FRAMES && !measuredOk) {
        rafId = requestAnimationFrame(pump);
      } else if (frame < SEAM_SYNC_RETRY_FRAMES) {
        rafId = requestAnimationFrame(pump);
      }
    };
    rafId = requestAnimationFrame(pump);

    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onWin);
    visualViewport?.addEventListener("scroll", onWin);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      visualViewport?.removeEventListener("resize", onWin);
      visualViewport?.removeEventListener("scroll", onWin);
      ro?.disconnect();
    };
  }, [overlaySeam, show, syncSeamBox, shellRef]);

  useLayoutEffect(() => {
    if (overlaySeam || !show) {
      setDialogChrome(null);
      return;
    }
    const onWin = () => {
      syncDialogChrome();
    };
    let ro: ResizeObserver | null = null;
    const observe = () => {
      const shellDom = findDomNode(shellRef.current);
      const body = findFloatingDialogBody(shellDom);
      const sheet =
        findFloatingDialogSheet(shellDom) ?? findFloatingDialogSheet(body);
      if (!body || !sheet || typeof ResizeObserver === "undefined") return false;
      if (ro) ro.disconnect();
      ro = new ResizeObserver(onWin);
      ro.observe(body);
      ro.observe(sheet);
      if (shellDom) ro.observe(shellDom);
      return true;
    };

    syncDialogChrome();
    observe();

    let cancelled = false;
    let frame = 0;
    let rafId = 0;
    const pump = () => {
      if (cancelled) return;
      syncDialogChrome();
      observe();
      frame += 1;
      if (frame < SEAM_SYNC_RETRY_FRAMES) rafId = requestAnimationFrame(pump);
    };
    rafId = requestAnimationFrame(pump);

    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onWin);
    visualViewport?.addEventListener("scroll", onWin);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      visualViewport?.removeEventListener("resize", onWin);
      visualViewport?.removeEventListener("scroll", onWin);
      ro?.disconnect();
    };
  }, [overlaySeam, show, syncDialogChrome, shellRef]);

  useLayoutEffect(() => {
    if (overlaySeam && show) syncSeamBox();
    if (!overlaySeam && show) syncDialogChrome();
  }, [
    overlaySeam,
    show,
    trackH,
    thumbH,
    thumbTop,
    syncSeamBox,
    syncDialogChrome,
    splitMetrics?.columnCount,
    splitMetrics?.effectiveSplitWidthPx,
    splitMetrics?.thirdColumnWidthPx,
    splitMetrics?.splitRowWidthPx,
  ]);

  if (!show || trackH <= 0 || thumbH <= 0) return null;

  const viewportRightPx =
    typeof window !== "undefined"
      ? snapScrollIndicatorCoordPx(window.visualViewport?.width ?? window.innerWidth)
      : null;

  const shellDom = findDomNode(shellRef.current);
  const shellRect = shellDom?.getBoundingClientRect();
  const shellRightPx =
    shellRect != null ? snapScrollIndicatorCoordPx(shellRect.right) : null;
  const fallbackBox: TrackBox | null =
    shellRect && shellRect.height > 0
      ? {
          rightPx: shellRightPx ?? snapScrollIndicatorCoordPx(shellRect.left + shellRect.width),
          topPx: snapScrollIndicatorCoordPx(shellRect.top - extendTop),
          heightPx: snapScrollIndicatorCoordPx(
            Math.max(trackH, shellRect.height + extendTop + extendBottom),
          ),
        }
      : null;
  const activeBox = seamBox ?? fallbackBox;
  const columnRightPx = activeBox?.rightPx ?? shellRightPx ?? viewportRightPx ?? 0;
  const flushRight = isSplitColumnFlushRight(shellDom);
  const atViewportRightEdge =
    overlaySeam &&
    (flushRight || activeBox != null || shellRightPx != null) &&
    (flushRight ||
      isScrollIndicatorAtViewportRightEdge(columnRightPx) ||
      (viewportRightPx != null && columnRightPx >= viewportRightPx - 2.5));
  const useViewportEdgeWideThumb =
    overlaySeam && atViewportRightEdge && colorScheme === "light";
  const inFloatingDialog =
    !overlaySeam && Platform.OS === "web";
  const crossAxisVisualSpan = useViewportEdgeWideThumb
    ? SCROLL_INDICATOR_VIEWPORT_EDGE_THUMB_PX
    : inFloatingDialog
      ? DIALOG_THUMB_CROSS_AXIS_PX
      : Math.max(1, hairline);
  const dialogTrackH =
    inFloatingDialog && dialogChrome ? Math.max(trackH, dialogChrome.box.heightPx) : trackH;

  const thumb = (
    <ScrollIndicatorDragHandle
      axis="vertical"
      trackSpan={dialogTrackH}
      thumbSpan={thumbH}
      thumbOffset={thumbTop}
      scrollRange={maxScroll}
      onScrollTo={onScrollTo}
      crossAxisVisualSpan={crossAxisVisualSpan}
    >
      <View
        {...(Platform.OS === "web"
          ? ({
              className: useViewportEdgeWideThumb
                ? "hsp-scroll-indicator-thumb-viewport-edge"
                : "hsp-scroll-indicator-thumb",
            } as Record<string, string>)
          : {})}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          height: thumbH,
          width: useViewportEdgeWideThumb
            ? SCROLL_INDICATOR_VIEWPORT_EDGE_THUMB_PX
            : inFloatingDialog
              ? DIALOG_THUMB_CROSS_AXIS_PX
              : 0,
          backgroundColor:
            useViewportEdgeWideThumb || inFloatingDialog ? thumbColor : "transparent",
          borderLeftWidth: useViewportEdgeWideThumb || inFloatingDialog ? 0 : Math.max(1, hairline),
          borderLeftColor:
            useViewportEdgeWideThumb || inFloatingDialog ? "transparent" : thumbColor,
          borderStyle: "solid",
        }}
      />
    </ScrollIndicatorDragHandle>
  );

  if (overlaySeam && typeof document !== "undefined" && activeBox) {
    const portalLeft = scrollIndicatorPortalLeftPx(activeBox.rightPx, shellDom);
    const portal: ReactNode = (
      <View
        pointerEvents="none"
        style={{
          position: "fixed" as unknown as "absolute",
          top: activeBox.topPx,
          left: portalLeft,
          width: 0,
          height: activeBox.heightPx,
          zIndex: SEAM_OVERLAY_Z,
          overflow: "visible",
        }}
      >
        {thumb}
      </View>
    );
    return createPortal(portal, document.body);
  }

  // Floating dialog: always portal onto document.body (never in-shell — shell overflow:hidden clips).
  if (!overlaySeam && typeof document !== "undefined" && Platform.OS === "web") {
    const shellDomNow = findDomNode(shellRef.current);
    const body = findFloatingDialogBody(shellDomNow);
    const sheet =
      findFloatingDialogSheet(shellDomNow) ?? findFloatingDialogSheet(body);
    const bodyRect = body?.getBoundingClientRect();
    const sheetRect = sheet?.getBoundingClientRect();
    const shellRectNow = shellDomNow?.getBoundingClientRect();
    const box: DialogChromeBox | null = dialogChrome?.box
      ?? (bodyRect && sheetRect && bodyRect.height > 0 && sheetRect.width > 0
        ? {
            topPx: snapScrollIndicatorCoordPx(bodyRect.top),
            heightPx: snapScrollIndicatorCoordPx(Math.max(trackH, bodyRect.height)),
            rightPx: snapScrollIndicatorCoordPx(sheetRect.right),
          }
        : shellRectNow && shellRectNow.height > 0
          ? {
              topPx: snapScrollIndicatorCoordPx(shellRectNow.top - extendTop),
              heightPx: snapScrollIndicatorCoordPx(
                Math.max(trackH, shellRectNow.height + extendTop + extendBottom),
              ),
              rightPx: snapScrollIndicatorCoordPx(shellRectNow.right),
            }
          : null);
    if (box) {
      const portalZ = Math.max(DIALOG_BODY_PORTAL_Z_FLOOR, peekTopFloatingSurfaceZ() + 1);
      const portalLeft = snapScrollIndicatorCoordPx(box.rightPx - DIALOG_THUMB_CROSS_AXIS_PX);
      const portal: ReactNode = (
        <View
          pointerEvents="none"
          {...({
            dataSet: { hspDialogScrollIndicator: "1" },
          } as object)}
          style={{
            position: "fixed" as unknown as "absolute",
            top: box.topPx,
            left: portalLeft,
            width: DIALOG_THUMB_CROSS_AXIS_PX,
            height: box.heightPx,
            zIndex: portalZ,
            overflow: "visible",
          }}
        >
          {thumb}
        </View>
      );
      return createPortal(portal, document.body);
    }
  }

  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: -extendTop,
          bottom: -extendBottom,
          right: snapScrollIndicatorCoordPx(scrollbarRightInsetPx),
          width: 0,
          overflow: "visible",
          zIndex: SEAM_OVERLAY_Z,
        },
        style,
      ]}
    >
      {thumb}
    </View>
  );
}
