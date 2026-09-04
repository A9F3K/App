import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { useTelegram } from "../components/Telegram";
import { typographyRect15, uiTextVerticalCompensationY } from "../theme";
import { mixHex, withAlpha } from "./proAccessMaterials";

type Props = {
  label: string;
  onPress: () => void;
};

const LOGO_GREEN = HYPERLINKS_SPACE_LOGO_GREEN;
const LOGO_GREEN_DEEP = "#00B348";
const LOGO_GREEN_LIFT = "#1AE86A";

/**
 * Active Pro subscribe CTA — clean logo-green plate (reads as enabled).
 */
export function ProSubscribeButton({ label, onPress }: Props) {
  const { colorScheme } = useTelegram();
  const lightTheme = colorScheme === "light";
  const hostRef = useRef<View>(null);
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!host) return;

    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    canvas.style.borderRadius = "12px";
    host.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    let grain: HTMLCanvasElement | null = null;
    let grainKey = "";

    const ensureGrain = (w: number, h: number) => {
      const key = `${w}x${h}:logo-green-cta-v2:${lightTheme ? 1 : 0}`;
      if (grain && grainKey === key) return grain;
      grain = document.createElement("canvas");
      grain.width = Math.max(1, Math.round(w));
      grain.height = Math.max(1, Math.round(h));
      grainKey = key;
      const g = grain.getContext("2d");
      if (!g) return grain;

      // Clean vertical brand-green fill — no blue-grey brush dirt.
      const base = g.createLinearGradient(0, 0, 0, h);
      if (lightTheme) {
        base.addColorStop(0, LOGO_GREEN_LIFT);
        base.addColorStop(0.45, LOGO_GREEN);
        base.addColorStop(1, LOGO_GREEN_DEEP);
      } else {
        base.addColorStop(0, mixHex(LOGO_GREEN_LIFT, LOGO_GREEN, 0.25));
        base.addColorStop(0.4, LOGO_GREEN);
        base.addColorStop(1, LOGO_GREEN_DEEP);
      }
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);

      return grain;
    };

    const resize = () => {
      const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grain = null;
      grainKey = "";
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w < 2 || h < 2) {
        raf = requestAnimationFrame(tick);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      roundRect(ctx, 0, 0, w, h, 12);
      ctx.save();
      ctx.clip();
      ctx.drawImage(ensureGrain(w, h), 0, 0, w, h);

      // Soft top sheen only — keep green saturated and clean.
      const sheen = ctx.createLinearGradient(0, 0, 0, h * 0.55);
      sheen.addColorStop(0, lightTheme ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.2)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, w, h);

      const sweepX = ((t * 70) % (w + 200)) - 80;
      ctx.save();
      ctx.translate(sweepX, 0);
      ctx.rotate(-0.22);
      const sweep = ctx.createLinearGradient(0, 0, 36, h);
      sweep.addColorStop(0, "rgba(255,255,255,0)");
      sweep.addColorStop(0.5, lightTheme ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.28)");
      sweep.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sweep;
      ctx.fillRect(-40, -20, 90, h + 40);
      ctx.restore();

      const ao = ctx.createLinearGradient(0, h * 0.55, 0, h);
      ao.addColorStop(0, "rgba(0,0,0,0)");
      ao.addColorStop(1, lightTheme ? "rgba(0,90,40,0.14)" : "rgba(0,70,30,0.22)");
      ctx.fillStyle = ao;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      roundRect(ctx, 0.75, 0.75, w - 1.5, h - 1.5, 11.2);
      ctx.strokeStyle = withAlpha("#FFFFFF", lightTheme ? 0.45 : 0.4);
      ctx.lineWidth = 1.25;
      ctx.stroke();

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    };
  }, [lightTheme]);

  const web3d =
    Platform.OS === "web"
      ? ({
          transform: pressed
            ? "translateY(1px) scale(0.99)"
            : hover
              ? "translateY(-1px) scale(1.01)"
              : "translateY(0) scale(1)",
          transition: "transform 140ms ease, box-shadow 160ms ease",
          boxShadow: pressed
            ? `inset 0 2px 4px rgba(0,70,30,0.28)`
            : hover
              ? `0 4px 14px rgba(0,224,90,${lightTheme ? 0.32 : 0.28})`
              : `0 3px 10px rgba(0,224,90,${lightTheme ? 0.24 : 0.2})`,
        } as object)
      : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      style={{
        alignSelf: "center",
        borderRadius: 12,
        overflow: "hidden",
        minHeight: 48,
        height: 48,
        paddingHorizontal: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: LOGO_GREEN,
        ...web3d,
      }}
    >
      <View
        ref={hostRef}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        }}
      />
      <Text
        numberOfLines={1}
        style={[
          typographyRect15,
          {
            color: "#FFFFFF",
            fontWeight: "700",
            letterSpacing: 0.3,
            zIndex: 1,
            textAlign: "center",
            // Optical center in the 48px plate (global Text nudge alone is not enough here).
            transform: [{ translateY: uiTextVerticalCompensationY - 1 }],
            fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
            ...(Platform.OS === "web"
              ? ({
                  userSelect: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 18,
                  marginTop: 0,
                  marginBottom: 0,
                  paddingTop: 0,
                  paddingBottom: 0,
                } as object)
              : null),
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
