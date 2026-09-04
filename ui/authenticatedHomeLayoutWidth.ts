import { Platform, useWindowDimensions } from "react-native";

import { useAuthenticatedHomeSplitLayoutMetrics } from "./components/AuthenticatedHomeSplitLayoutMetricsContext";
import { layout } from "./theme";

/** Layout width for authenticated-home breakpoints (prefer visual viewport on web). */
export function readAuthenticatedHomeLayoutWidthPx(windowWidth: number): number {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const clientWidth = document.documentElement?.clientWidth ?? 0;
    if (clientWidth > 0) {
      return clientWidth;
    }
    if (typeof window !== "undefined" && window.innerWidth > 0) {
      return window.innerWidth;
    }
  }
  return windowWidth;
}

export function isAuthenticatedHomeWideLayoutWidthPx(widthPx: number): boolean {
  return widthPx > layout.authenticatedHome.firstBreakpoint;
}

export function isAuthenticatedHomeTripleColumnLayoutWidthPx(widthPx: number): boolean {
  return widthPx > layout.authenticatedHome.secondBreakpoint;
}

/** Wide vs compact for routes and chrome outside the split metrics provider. */
export function useAuthenticatedHomeRouteWideLayout(): boolean {
  const { width: windowWidth } = useWindowDimensions();
  return isAuthenticatedHomeWideLayoutWidthPx(readAuthenticatedHomeLayoutWidthPx(windowWidth));
}

/** Prefer live split metrics when mounted under {@link AuthenticatedHomeSplitLayoutMetricsProvider}. */
export function useAuthenticatedHomeLayoutMode(): {
  layoutWidthPx: number;
  isWide: boolean;
  isTripleColumn: boolean;
  columnCount: 1 | 2 | 3;
} {
  const { width: windowWidth } = useWindowDimensions();
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  const fallbackWidthPx = readAuthenticatedHomeLayoutWidthPx(windowWidth);

  if (splitMetrics) {
    const layoutWidthPx = Math.min(splitMetrics.effectiveSplitWidthPx, fallbackWidthPx);
    const isWide = isAuthenticatedHomeWideLayoutWidthPx(layoutWidthPx);
    return {
      layoutWidthPx,
      isWide,
      isTripleColumn: isAuthenticatedHomeTripleColumnLayoutWidthPx(layoutWidthPx),
      columnCount: isWide
        ? isAuthenticatedHomeTripleColumnLayoutWidthPx(layoutWidthPx)
          ? 3
          : 2
        : 1,
    };
  }

  const layoutWidthPx = fallbackWidthPx;
  const isWide = isAuthenticatedHomeWideLayoutWidthPx(layoutWidthPx);
  return {
    layoutWidthPx,
    isWide,
    isTripleColumn: isAuthenticatedHomeTripleColumnLayoutWidthPx(layoutWidthPx),
    columnCount: isWide
      ? isAuthenticatedHomeTripleColumnLayoutWidthPx(layoutWidthPx)
        ? 3
        : 2
      : 1,
  };
}
