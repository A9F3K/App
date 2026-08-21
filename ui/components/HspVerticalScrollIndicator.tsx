import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { createPortal } from "react-dom";

import {
  scrollIndicatorHairlineBorderWidthPx,
  snapScrollIndicatorCoordPx,
} from "../scrollIndicatorPx";
import { layout } from "../theme";
import { ScrollIndicatorDragHandle } from "./ScrollIndicatorDragHandle";

const SEAM_OVERLAY_Z = layout.authenticatedHome.scrollIndicatorOverlayZIndex;

type TrackBox = {
  /** Viewport X of the column’s right edge (thumb paints leftward from here). */
  rightPx: number;
  topPx: number;
  heightPx: number;
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
  scrollIndicatorExtendBottomPx?: number;
  onScrollTo: (y: number) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Vertical 1px scroll thumb.
 *
 * When {@link scrollbarRightInsetPx} is `0` on web, the rail is portaled above the split-pane
 * seam overlay so it can sit on the divider (music-bar style) without being covered by it.
 * Footers keep their edge stroke via the divider overlay; only the thumb escapes column stacking.
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
  scrollIndicatorExtendBottomPx = 0,
  onScrollTo,
  style,
}: Props) {
  const hairline = scrollIndicatorHairlineBorderWidthPx();
  const extendBottom = Math.max(0, scrollIndicatorExtendBottomPx);
  const overlaySeam = Platform.OS === "web" && scrollbarRightInsetPx <= 0;

  const [seamBox, setSeamBox] = useState<TrackBox | null>(null);

  const applySeamBox = useCallback((x: number, y: number, w: number, h: number) => {
    if (!(w > 0) || !(h > 0)) return;
    const next: TrackBox = {
      rightPx: snapScrollIndicatorCoordPx(x + w),
      topPx: snapScrollIndicatorCoordPx(y),
      heightPx: snapScrollIndicatorCoordPx(Math.max(trackH, h + extendBottom)),
    };
    setSeamBox((prev) =>
      prev &&
      prev.rightPx === next.rightPx &&
      prev.topPx === next.topPx &&
      prev.heightPx === next.heightPx
        ? prev
        : next,
    );
  }, [trackH, extendBottom]);

  const syncSeamBox = useCallback(() => {
    if (!overlaySeam || !show) {
      setSeamBox(null);
      return;
    }
    // Prefer getBoundingClientRect — measureInWindow can miss the first paint at mid breakpoints.
    const dom = findDomNode(shellRef.current);
    if (dom) {
      const rect = dom.getBoundingClientRect();
      applySeamBox(rect.left, rect.top, rect.width, rect.height);
      return;
    }
    shellRef.current?.measureInWindow((x, y, w, h) => {
      applySeamBox(x, y, w, h);
    });
  }, [overlaySeam, show, shellRef, applySeamBox]);

  useLayoutEffect(() => {
    if (!overlaySeam || !show) {
      setSeamBox(null);
      return;
    }
    const onWin = () => syncSeamBox();
    let ro: ResizeObserver | null = null;
    const observeShell = () => {
      const dom = findDomNode(shellRef.current);
      if (!dom || typeof ResizeObserver === "undefined") return;
      if (ro) ro.disconnect();
      ro = new ResizeObserver(onWin);
      ro.observe(dom);
    };

    syncSeamBox();
    observeShell();
    // Extra frames after column flex settles (common when loading already at 2 columns).
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      syncSeamBox();
      observeShell();
      raf2 = requestAnimationFrame(() => {
        syncSeamBox();
        observeShell();
      });
    });
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onWin);
    visualViewport?.addEventListener("scroll", onWin);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
      visualViewport?.removeEventListener("resize", onWin);
      visualViewport?.removeEventListener("scroll", onWin);
      ro?.disconnect();
    };
  }, [overlaySeam, show, syncSeamBox, shellRef]);

  useLayoutEffect(() => {
    if (overlaySeam && show) syncSeamBox();
  }, [overlaySeam, show, trackH, thumbH, thumbTop, syncSeamBox]);

  if (!show || trackH <= 0 || thumbH <= 0) return null;

  const thumb = (
    <ScrollIndicatorDragHandle
      axis="vertical"
      trackSpan={trackH}
      thumbSpan={thumbH}
      thumbOffset={thumbTop}
      scrollRange={maxScroll}
      onScrollTo={onScrollTo}
      crossAxisVisualSpan={hairline}
    >
      <View
        {...(Platform.OS === "web"
          ? ({ className: "hsp-scroll-indicator-thumb" } as Record<string, string>)
          : {})}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          height: thumbH,
          width: 0,
          borderLeftWidth: hairline,
          borderLeftColor: thumbColor,
          borderStyle: "solid",
        }}
      />
    </ScrollIndicatorDragHandle>
  );

  if (overlaySeam && typeof document !== "undefined") {
    if (!seamBox) return null;
    const portal: ReactNode = (
      <View
        pointerEvents="box-none"
        style={{
          position: "fixed" as unknown as "absolute",
          top: seamBox.topPx,
          left: seamBox.rightPx,
          width: 0,
          height: seamBox.heightPx,
          zIndex: SEAM_OVERLAY_Z,
          overflow: "visible",
        }}
      >
        {thumb}
      </View>
    );
    return createPortal(portal, document.body);
  }

  return (
    <View
      pointerEvents="box-none"
      style={[
        {
          position: "absolute",
          top: 0,
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

function findDomNode(ref: View | null): HTMLElement | null {
  if (!ref || Platform.OS !== "web") return null;
  if (typeof HTMLElement !== "undefined" && ref instanceof HTMLElement) return ref;
  const anyRef = ref as unknown as {
    getNode?: () => unknown;
    _touchableNode?: HTMLElement;
    _nativeNode?: HTMLElement;
  };
  const node = anyRef.getNode?.() ?? anyRef._touchableNode ?? anyRef._nativeNode ?? null;
  return node instanceof HTMLElement ? node : null;
}
