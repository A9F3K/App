import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import {
  liquidGlassContentInsetPx,
  liquidGlassDebugLogging,
  liquidGlassRayMarginPx,
  startLiquidGlassGl,
  type LiquidGlassGlOptions,
  type LiquidGlassShape,
} from "../glass/liquidGlassThreeSession";
import { logPageDisplay } from "../pageDisplayLog";
import { appLog } from "../../shared/appLog";

type Props = {
  /** Square chip side (px). Default when `width` / `height` omitted. */
  size?: number;
  width?: number;
  height?: number;
  /** `auto` picks pill when width ≠ height. */
  shape?: LiquidGlassShape | "auto";
  phaseOffset?: number;
  isLightTheme: boolean;
  /** `center` = single icon (settings). `top` = icon + label column like original FloatingShield circle. */
  contentAlign?: "center" | "top";
  /** Override automatic inner inset (px); use `0` for pill layouts with explicit padding. */
  contentInsetPx?: number;
  /**
   * When false, the glass underlay never captures pointer events so nested inputs/buttons work
   * (e.g. chat-list search pill). Default true for icon chips inside a Pressable.
   */
  capturePointerEvents?: boolean;
  children: ReactNode;
};

function resolveShape(
  shape: LiquidGlassShape | "auto",
  chipWidth: number,
  chipHeight: number,
): LiquidGlassShape {
  if (shape !== "auto") return shape;
  return chipWidth === chipHeight ? "circle" : "pill";
}

function buildGlOptions(
  resolvedShape: LiquidGlassShape,
  chipWidth: number,
  chipHeight: number,
  viewWidth: number,
  viewHeight: number,
  borderRadius: number,
  phaseOffset: number,
  isLightTheme: boolean,
): LiquidGlassGlOptions {
  return {
    shape: resolvedShape,
    chipWidthPx: chipWidth,
    chipHeightPx: chipHeight,
    viewWidthPx: viewWidth,
    viewHeightPx: viewHeight,
    cornerRadiusPx: borderRadius,
    phaseOffset,
    isLightTheme,
  };
}

/**
 * Liquid-glass chip: Three.js GLSL inside `expo-gl` (same path for web, iOS, Android, Electron webview).
 * Pill chips reuse the 40px circle glass/lightning pattern, clipped to a rounded rectangle.
 */
export function LiquidGlassShaderUndercover({
  size = 40,
  width,
  height,
  shape = "auto",
  phaseOffset = 0,
  isLightTheme,
  contentAlign = "center",
  contentInsetPx,
  capturePointerEvents = true,
  children,
}: Props) {
  const chipWidth = width ?? size;
  const chipHeight = height ?? size;
  const resolvedShape = resolveShape(shape, chipWidth, chipHeight);
  const isCircle = resolvedShape === "circle";
  const borderRadius = isCircle ? chipWidth / 2 : chipHeight / 2;
  const rayRefPx = chipHeight;
  const rayPad = liquidGlassRayMarginPx(rayRefPx);
  const viewWidth = chipWidth + 2 * rayPad;
  const viewHeight = chipHeight + 2 * rayPad;

  const glOptions = useMemo(
    () =>
      buildGlOptions(
        resolvedShape,
        chipWidth,
        chipHeight,
        viewWidth,
        viewHeight,
        borderRadius,
        phaseOffset,
        isLightTheme,
      ),
    [resolvedShape, chipWidth, chipHeight, viewWidth, viewHeight, borderRadius, phaseOffset, isLightTheme],
  );

  const optsRef = useRef(glOptions);
  optsRef.current = glOptions;

  const disposeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    logPageDisplay("liquid_glass_chip_mount", {
      platform: Platform.OS,
      shape: resolvedShape,
      chipWidth,
      chipHeight,
      viewWidth,
      viewHeight,
      phaseOffset,
      isLightTheme,
    });
  }, [resolvedShape, chipWidth, chipHeight, viewWidth, viewHeight, phaseOffset, isLightTheme]);

  useEffect(
    () => () => {
      disposeRef.current?.();
      disposeRef.current = null;
    },
    [],
  );

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    disposeRef.current?.();
    if (liquidGlassDebugLogging()) {
      appLog("[LiquidGlassGL]", "onContextCreate", {
        ...optsRef.current,
        note: "If missing, GLView did not create a context (web/TMA block or zero-size view).",
      });
    }
    disposeRef.current = startLiquidGlassGl(gl, () => optsRef.current);
    logPageDisplay("liquid_glass_context_created", {
      phaseOffset: optsRef.current.phaseOffset,
      shape: optsRef.current.shape,
      chipPx: optsRef.current.chipHeightPx,
      drawingBuffer: { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight },
      note: "If w/h are 0 on web, the next onLayout should resize the canvas; see liquid_glass_draw_ready.",
    });
  }, []);

  const outerLift = isLightTheme
    ? {
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
      }
    : {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.22,
        shadowRadius: Math.max(4, rayRefPx * 0.1),
        elevation: 4,
      };

  const outerWrap = {
    width: chipWidth,
    height: chipHeight,
    overflow: "hidden" as const,
    borderRadius,
    ...outerLift,
  };
  const clip = {
    width: chipWidth,
    height: chipHeight,
    borderRadius,
    overflow: "hidden" as const,
  };
  const inset = contentInsetPx ?? liquidGlassContentInsetPx(rayRefPx);
  const safePad =
    contentAlign === "top"
      ? { paddingHorizontal: inset, paddingBottom: inset }
      : { paddingHorizontal: inset, paddingVertical: inset };

  const glLayerStyle =
    Platform.OS === "web" ? [StyleSheet.absoluteFill, styles.glLayerWeb] : StyleSheet.absoluteFill;

  const glExpand = {
    position: "absolute" as const,
    left: -rayPad,
    top: -rayPad,
    width: viewWidth,
    height: viewHeight,
    zIndex: 0,
  };

  const hitR = chipHeight / 2;

  return (
    <View style={outerWrap} pointerEvents="box-none" collapsable={false}>
      <View style={[glExpand, styles.glUnderlay]} pointerEvents="none" collapsable={false}>
        <GLView pointerEvents="none" style={glLayerStyle} onContextCreate={onContextCreate} />
      </View>
      <View style={clip} pointerEvents="box-none" collapsable={false}>
        {capturePointerEvents ? (
          <Svg
            width={chipWidth}
            height={chipHeight}
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
          >
            {isCircle ? (
              <Circle
                cx={chipWidth / 2}
                cy={chipHeight / 2}
                r={hitR}
                fill="transparent"
                pointerEvents="auto"
              />
            ) : (
              <Rect
                x={0}
                y={0}
                width={chipWidth}
                height={chipHeight}
                rx={borderRadius}
                ry={borderRadius}
                fill="transparent"
                pointerEvents="auto"
              />
            )}
          </Svg>
        ) : null}
        <View
          style={[
            styles.foreground,
            contentAlign === "top" ? styles.foregroundTop : styles.foregroundCenter,
            clip,
            safePad,
          ]}
          pointerEvents="box-none"
        >
          {children}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  glUnderlay: {
    zIndex: 0,
    backgroundColor: "transparent",
  },
  glLayerWeb: {
    zIndex: 0,
    opacity: 1,
  },
  foreground: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "column",
    zIndex: 2,
    backgroundColor: "transparent",
  },
  foregroundCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  foregroundTop: {
    alignItems: "center",
    justifyContent: "flex-start",
  },
});
