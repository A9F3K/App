import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { useTelegram } from "../components/Telegram";
import { mixHex, withAlpha } from "./proAccessMaterials";

type Props = {
  label: string;
  onPress: () => void;
};

const LOGO_GREEN = HYPERLINKS_SPACE_LOGO_GREEN;
const LOGO_GREEN_DEEP = "#009E3F";
const LOGO_GREEN_LIFT = "#3CFF86";

/**
 * Active Pro subscribe CTA — logo-green plate (reads as enabled, not chrome metal).
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
      const key = `${w}x${h}:logo-green-cta`;
      if (grain && grainKey === key) return grain;
      grain = document.createElement("canvas");
      grain.width = Math.max(1, Math.round(w));
      grain.height = Math.max(1, Math.round(h));
      grainKey = key;
      const g = grain.getContext("2d");
      if (!g) return grain;

      const base = g.createLinearGradient(0, 0, w * 0.15, h);
      base.addColorStop(0, LOGO_GREEN_LIFT);
      base.addColorStop(0.35, LOGO_GREEN);
      base.addColorStop(0.72, mixHex(LOGO_GREEN, LOGO_GREEN_DEEP, 0.45));
      base.addColorStop(1, LOGO_GREEN_DEEP);
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);

      g.save();
      g.globalAlpha = 0.18;
      for (let y = 0; y < h; y += 1.35) {
        const cool = 180 + ((y * 13) % 40);
        g.strokeStyle = `rgba(${cool - 40},${cool + 40},${cool - 20},0.45)`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, y + Math.sin(y * 0.4) * 0.3);
        g.lineTo(w, y + Math.sin(y * 0.28) * 0.3);
        g.stroke();
      }
      g.restore();

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

      const keyX = w * (0.28 + 0.08 * Math.sin(t * 0.7));
      const keyY = h * (0.22 + 0.06 * Math.cos(t * 0.55));
      const key = ctx.createRadialGradient(keyX, keyY, 2, keyX, keyY, Math.max(w, h) * 0.75);
      key.addColorStop(0, "rgba(255,255,255,0.42)");
      key.addColorStop(0.25, "rgba(180,255,210,0.18)");
      key.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = key;
      ctx.fillRect(0, 0, w, h);

      const sweepX = ((t * 90) % (w + 240)) - 100;
      ctx.save();
      ctx.translate(sweepX, 0);
      ctx.rotate(-0.28);
      const sweep = ctx.createLinearGradient(0, 0, 48, h * 1.2);
      sweep.addColorStop(0, "rgba(255,255,255,0)");
      sweep.addColorStop(0.45, "rgba(220,255,230,0.08)");
      sweep.addColorStop(0.5, "rgba(255,255,255,0.38)");
      sweep.addColorStop(0.55, "rgba(220,255,230,0.08)");
      sweep.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sweep;
      ctx.fillRect(-60, -40, 130, h + 80);
      ctx.restore();

      const ao = ctx.createLinearGradient(0, 0, 0, h);
      ao.addColorStop(0, "rgba(255,255,255,0.22)");
      ao.addColorStop(0.18, "rgba(255,255,255,0)");
      ao.addColorStop(0.82, "rgba(0,0,0,0)");
      ao.addColorStop(1, "rgba(0,80,30,0.28)");
      ctx.fillStyle = ao;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      roundRect(ctx, 0.8, 0.8, w - 1.6, h - 1.6, 11.2);
      ctx.strokeStyle = withAlpha("#FFFFFF", 0.55);
      ctx.lineWidth = 1.4;
      ctx.stroke();

      roundRect(ctx, 2.2, 2.2, w - 4.4, h - 4.4, 10);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1.1;
      ctx.stroke();

      roundRect(ctx, 0.4, 0.4, w - 0.8, h - 0.8, 12);
      ctx.strokeStyle = withAlpha(LOGO_GREEN_LIFT, 0.65);
      ctx.lineWidth = 1.8;
      ctx.stroke();

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    };
  }, []);

  const liftAmt = pressed ? 0 : hover ? 1 : 0;
  const web3d =
    Platform.OS === "web"
      ? ({
          transform: pressed
            ? "perspective(900px) rotateX(4deg) translateY(1px) scale(0.99)"
            : hover
              ? "perspective(900px) rotateX(-2deg) translateY(-1px) scale(1.01)"
              : "perspective(900px) rotateX(0deg) translateY(0px) scale(1)",
          transformStyle: "preserve-3d",
          transition: "transform 140ms ease, box-shadow 160ms ease",
          boxShadow: pressed
            ? `inset 0 2px 4px rgba(0,60,25,0.35), 0 0 0 1px ${LOGO_GREEN_DEEP}`
            : hover
              ? lightTheme
                ? `0 4px 14px rgba(0,224,90,0.35), inset 0 1px 0 rgba(255,255,255,0.55)`
                : `0 8px 22px rgba(0,224,90,0.28), inset 0 1px 0 rgba(255,255,255,0.4)`
              : lightTheme
                ? `0 3px 10px rgba(0,224,90,0.28), inset 0 1px 0 rgba(255,255,255,0.45)`
                : `0 6px 18px rgba(0,224,90,0.22), inset 0 1px 0 rgba(255,255,255,0.35)`,
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
        paddingHorizontal: 8,
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
        style={{
          color: "#FFFFFF",
          fontSize: 15,
          fontWeight: "700",
          letterSpacing: 0.3,
          paddingVertical: 14,
          paddingHorizontal: 22,
          zIndex: 1,
          textShadowColor: liftAmt ? "rgba(255,255,255,0.35)" : "rgba(0,60,25,0.35)",
          textShadowOffset: { width: 0, height: liftAmt ? -0.5 : 0.5 },
          textShadowRadius: 2,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          ...(Platform.OS === "web"
            ? ({
                userSelect: "none",
              } as object)
            : null),
        }}
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
