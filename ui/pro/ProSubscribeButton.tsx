import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import { FONT_UI_SANS_SEMIBOLD, WEB_UI_SANS_STACK } from "../fonts";
import { useTelegram } from "../components/Telegram";
import { withAlpha } from "./proAccessMaterials";

type Props = {
  label: string;
  onPress: () => void;
};

const GREEN = HYPERLINKS_SPACE_LOGO_GREEN;
const GREEN_HI = "#2CFF7A";
const GREEN_MID = "#00C84F";
const GREEN_LO = "#007A32";
const BUTTON_H = 52;
const RADIUS = 14;

/**
 * AAA extruded logo-green subscribe CTA — sharp rims, dense metal, living specular.
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
    canvas.style.borderRadius = `${RADIUS}px`;
    host.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    let plate: HTMLCanvasElement | null = null;
    let plateKey = "";

    const ensurePlate = (w: number, h: number) => {
      const key = `${w}x${h}:aaa-green`;
      if (plate && plateKey === key) return plate;
      plate = document.createElement("canvas");
      plate.width = Math.max(1, Math.round(w));
      plate.height = Math.max(1, Math.round(h));
      plateKey = key;
      const g = plate.getContext("2d");
      if (!g) return plate;

      // Dense extruded green body (rich, not washed).
      const body = g.createLinearGradient(0, 0, 0, h);
      body.addColorStop(0, GREEN_HI);
      body.addColorStop(0.18, GREEN);
      body.addColorStop(0.55, GREEN_MID);
      body.addColorStop(1, GREEN_LO);
      g.fillStyle = body;
      g.fillRect(0, 0, w, h);

      // Fine anisotropic brush — green-only (no grey mud).
      g.save();
      g.globalAlpha = 0.16;
      for (let y = 0; y < h; y += 1.15) {
        const v = 40 + ((y * 19) % 50);
        g.strokeStyle = `rgba(${v},${180 + (v % 40)},${70 + (v % 30)},0.7)`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, y + Math.sin(y * 0.55) * 0.25);
        g.lineTo(w, y + Math.sin(y * 0.33) * 0.25);
        g.stroke();
      }
      g.restore();

      // Micro flecks
      const img = g.createImageData(plate.width, plate.height);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4) {
        const n = (Math.random() * 36) | 0;
        data[i] = 30 + n;
        data[i + 1] = 200 + n;
        data[i + 2] = 80 + n;
        data[i + 3] = 18;
      }
      g.putImageData(img, 0, 0);

      // Inner bevel (sharp)
      g.strokeStyle = "rgba(255,255,255,0.55)";
      g.lineWidth = 1;
      g.strokeRect(1.5, 1.5, w - 3, h - 3);
      g.strokeStyle = "rgba(0,60,20,0.45)";
      g.strokeRect(2.5, 2.5, w - 5, h - 5);

      return plate;
    };

    const resize = () => {
      const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      plate = null;
      plateKey = "";
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
      roundRect(ctx, 0, 0, w, h, RADIUS);
      ctx.save();
      ctx.clip();
      ctx.drawImage(ensurePlate(w, h), 0, 0, w, h);

      // Living key light
      const kx = w * (0.3 + 0.08 * Math.sin(t * 0.85));
      const ky = h * (0.2 + 0.05 * Math.cos(t * 0.7));
      const key = ctx.createRadialGradient(kx, ky, 1, kx, ky, Math.max(w, h) * 0.7);
      key.addColorStop(0, "rgba(255,255,255,0.34)");
      key.addColorStop(0.35, "rgba(180,255,200,0.1)");
      key.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = key;
      ctx.fillRect(0, 0, w, h);

      // Specular sweep
      const sweepX = ((t * 95) % (w + 260)) - 110;
      ctx.save();
      ctx.translate(sweepX, 0);
      ctx.rotate(-0.32);
      const sweep = ctx.createLinearGradient(0, 0, 44, h * 1.3);
      sweep.addColorStop(0, "rgba(255,255,255,0)");
      sweep.addColorStop(0.45, "rgba(220,255,230,0.05)");
      sweep.addColorStop(0.5, "rgba(255,255,255,0.48)");
      sweep.addColorStop(0.55, "rgba(220,255,230,0.05)");
      sweep.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sweep;
      ctx.fillRect(-50, -30, 110, h + 60);
      ctx.restore();

      // Bottom AO
      const ao = ctx.createLinearGradient(0, h * 0.45, 0, h);
      ao.addColorStop(0, "rgba(0,0,0,0)");
      ao.addColorStop(1, "rgba(0,50,18,0.38)");
      ctx.fillStyle = ao;
      ctx.fillRect(0, 0, w, h);

      // Press darken
      if (pressed) {
        ctx.fillStyle = "rgba(0,40,15,0.22)";
        ctx.fillRect(0, 0, w, h);
      } else if (hover) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();

      // Crisp outer rim (1px, no blur)
      roundRect(ctx, 0.5, 0.5, w - 1, h - 1, RADIUS - 0.5);
      ctx.strokeStyle = withAlpha("#FFFFFF", 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();

      roundRect(ctx, 1.5, 1.5, w - 3, h - 3, RADIUS - 1.5);
      ctx.strokeStyle = "rgba(0,70,25,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    };
  }, [hover, pressed]);

  const webChrome =
    Platform.OS === "web"
      ? ({
          transform: pressed
            ? "translateY(2px)"
            : hover
              ? "translateY(-2px)"
              : "translateY(0)",
          transition: "transform 120ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 160ms ease",
          // Sharp layered rims — avoid large soft blurs that smear edges.
          boxShadow: pressed
            ? `inset 0 3px 6px rgba(0,50,18,0.45), 0 0 0 1px ${GREEN_LO}`
            : hover
              ? lightTheme
                ? `0 1px 0 rgba(255,255,255,0.85), 0 6px 0 ${GREEN_LO}, 0 10px 18px rgba(0,120,40,0.28)`
                : `0 1px 0 rgba(255,255,255,0.7), 0 6px 0 ${GREEN_LO}, 0 12px 22px rgba(0,224,90,0.28)`
              : lightTheme
                ? `0 1px 0 rgba(255,255,255,0.9), 0 4px 0 ${GREEN_LO}, 0 8px 14px rgba(0,100,35,0.22)`
                : `0 1px 0 rgba(255,255,255,0.75), 0 4px 0 ${GREEN_LO}, 0 8px 16px rgba(0,224,90,0.22)`,
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
        borderRadius: RADIUS,
        overflow: "hidden",
        height: BUTTON_H,
        minWidth: 220,
        paddingHorizontal: 28,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: GREEN,
        borderWidth: 1,
        borderColor: GREEN_LO,
        ...webChrome,
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
        style={{
          color: "#FFFFFF",
          fontSize: 15,
          fontWeight: "700",
          letterSpacing: 0.35,
          // Exact vertical centering: line box == button height, no padding/shadow.
          lineHeight: BUTTON_H,
          height: BUTTON_H,
          includeFontPadding: false,
          textAlignVertical: "center",
          textAlign: "center",
          zIndex: 1,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_SEMIBOLD,
          ...(Platform.OS === "web"
            ? ({
                userSelect: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: 0,
                padding: 0,
                // Cancel global Text translateY so flex centering wins.
                transform: "none",
                textShadow: "0 1px 0 rgba(0,60,20,0.35)",
              } as object)
            : {
                transform: [{ translateY: 0 }],
              }),
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
