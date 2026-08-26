import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, useWindowDimensions, type LayoutChangeEvent } from "react-native";

import { logPageDisplay } from "../pageDisplayLog";
import { resolveWebLayoutElement, resolveWebRefElement } from "./resolveWebLayoutElement";

type WidthSource = "onLayout" | "resizeObserver" | "windowDimensions";

/** Tracks an element width via onLayout and, on web, ResizeObserver (split-pane / shell resizes). */
export function useObservedWidth(scope: string) {
  const { width: windowWidth } = useWindowDimensions();
  const [widthPx, setWidthPx] = useState(0);
  const [probeNode, setProbeNode] = useState<HTMLElement | null>(null);
  const lastLoggedWidthRef = useRef<number | null>(null);

  const reportWidth = useCallback(
    (width: number, source: WidthSource) => {
      const rounded = Math.round(width);
      setWidthPx((current) => {
        // Split-pane remounts briefly report 0×0; keep the last real width so
        // column layouts / scroll indicators do not collapse mid-resize.
        if (rounded <= 0 && current > 0) {
          return current;
        }
        if (current === rounded) {
          return current;
        }
        logPageDisplay("smart_observed_width", {
          scope,
          source,
          widthPx: rounded,
          prevWidthPx: current > 0 ? current : null,
          windowWidth: Math.round(windowWidth),
          probeAttached: Boolean(probeNode),
        });
        return rounded;
      });
    },
    [probeNode, scope, windowWidth],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      reportWidth(event.nativeEvent.layout.width, "onLayout");
      const layoutElement = resolveWebLayoutElement(event);
      if (layoutElement) {
        setProbeNode((current) => (current === layoutElement ? current : layoutElement));
      }
    },
    [reportWidth],
  );

  const onRef = useCallback((node: unknown) => {
    const element = resolveWebRefElement(node);
    if (element) {
      setProbeNode((current) => (current === element ? current : element));
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || !probeNode || typeof ResizeObserver === "undefined") {
      return;
    }

    const measure = () => reportWidth(probeNode.getBoundingClientRect().width, "resizeObserver");

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probeNode);
    logPageDisplay("smart_observed_width_probe", {
      scope,
      action: "attach",
      initialWidthPx: Math.round(probeNode.getBoundingClientRect().width),
    });
    return () => {
      observer.disconnect();
      logPageDisplay("smart_observed_width_probe", {
        scope,
        action: "detach",
      });
    };
  }, [probeNode, reportWidth, scope]);

  useEffect(() => {
    if (Platform.OS !== "web" || !probeNode) {
      return;
    }
    reportWidth(probeNode.getBoundingClientRect().width, "windowDimensions");
  }, [windowWidth, probeNode, reportWidth]);

  useEffect(() => {
    if (widthPx <= 0 || lastLoggedWidthRef.current === widthPx) {
      return;
    }
    lastLoggedWidthRef.current = widthPx;
  }, [widthPx]);

  return {
    widthPx,
    onLayout,
    onRef: Platform.OS === "web" ? onRef : undefined,
  };
}
