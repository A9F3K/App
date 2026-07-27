import { createElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";

import {
  ensureChooseCurrencyYearChart,
  getChooseCurrencyYearChartSnapshot,
  subscribeChooseCurrencyYearChart,
} from "../../swap/chooseCurrencyYearChartCache";
import { useColors } from "../../theme";
import { CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX } from "./chooseCurrencyTableConstants";
import type { ChooseCurrencyRow } from "./chooseCurrencyTableTypes";
import { SwapChartCanvas } from "./SwapChartCanvas";
import { SwapChartLineSvg } from "./SwapChartLineSvg";

/** Hardcoded stable “depeg” bumps along the DLLR last-year line (fraction of plot width). */
const DLLR_DEPEG_WIDTH_FRACTIONS = [0.11, 0.33, 0.77] as const;

function drawDllrStableLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lineColor: string,
): void {
  const y = Math.floor(height / 2);
  const depegXs = new Set(
    DLLR_DEPEG_WIDTH_FRACTIONS.map((f) => Math.min(width - 1, Math.max(0, Math.round(width * f)))),
  );
  ctx.fillStyle = lineColor;
  for (let x = 0; x < width; x++) {
    const py = depegXs.has(x) ? y - 1 : y;
    ctx.fillRect(x, py, 1, 1);
  }
}

/** 1px baseline matching sparkline stroke weight, with three 1px-up depegs. */
function FlatMiniChartLine() {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const height = CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX;

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };

  useEffect(() => {
    if (Platform.OS !== "web" || width <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const pixelW = Math.max(1, Math.round(width * dpr));
    const pixelH = Math.max(1, Math.round(height * dpr));
    canvas.width = pixelW;
    canvas.height = pixelH;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawDllrStableLine(ctx, width, height, colors.primary);
  }, [width, height, colors.primary]);

  const depegXs =
    width > 0
      ? DLLR_DEPEG_WIDTH_FRACTIONS.map((f) => Math.min(width - 1, Math.max(0, Math.round(width * f))))
      : [];
  const midY = Math.floor(height / 2);

  return (
    <View
      onLayout={onLayout}
      style={{
        width: "100%",
        height,
        justifyContent: "center",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      {width > 0 ? (
        Platform.OS === "web" ? (
          createElement("canvas", {
            ref: canvasRef,
            style: {
              width,
              height,
              display: "block",
              pointerEvents: "none",
            },
          })
        ) : (
          <View style={{ width, height, position: "relative" }}>
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: midY,
                height: 1,
                backgroundColor: colors.primary,
              }}
            />
            {depegXs.map((x) => (
              <View key={x}>
                <View
                  style={{
                    position: "absolute",
                    left: x,
                    top: midY,
                    width: 1,
                    height: 1,
                    backgroundColor: colors.background,
                  }}
                />
                <View
                  style={{
                    position: "absolute",
                    left: x,
                    top: midY - 1,
                    width: 1,
                    height: 1,
                    backgroundColor: colors.primary,
                  }}
                />
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

function SparklineMiniChart({ address }: { address: string }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [fetchEnabled, setFetchEnabled] = useState(false);

  // Defer sparkline fetches so the main swap chart / home paint win the first DYOR slots.
  useEffect(() => {
    const timer = setTimeout(() => setFetchEnabled(true), 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!fetchEnabled) return;
    ensureChooseCurrencyYearChart(address);
  }, [address, fetchEnabled]);

  const snapshot = useSyncExternalStore(
    (onStoreChange) => subscribeChooseCurrencyYearChart(address, onStoreChange),
    () => getChooseCurrencyYearChartSnapshot(address),
    () => getChooseCurrencyYearChartSnapshot(address),
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };

  const height = CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX;

  return (
    <View
      onLayout={onLayout}
      style={{
        width: "100%",
        height,
        justifyContent: "center",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      {snapshot.status === "ready" && width > 0 ? (
        <View pointerEvents="none" style={{ width, height }}>
          {Platform.OS === "web" ? (
            <SwapChartCanvas
              width={width}
              height={height}
              normalizedPoints={snapshot.normalized}
              lineColor={colors.primary}
            />
          ) : (
            <SwapChartLineSvg
              width={width}
              height={height}
              normalizedPoints={snapshot.normalized}
              lineColor={colors.primary}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Last-year cell: flat line for DLLR; trade-style sparkline (no legend) for other tokens. */
export function ChooseCurrencyLastYearMiniChart({ row }: { row: ChooseCurrencyRow }) {
  if (row.lastYearKind === "stable") {
    return <FlatMiniChartLine />;
  }
  return <SparklineMiniChart address={row.rowKey} />;
}
