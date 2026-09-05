import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";

import {
  paintPlatinumGrain,
  paintPlatinumLiveOverlay,
} from "./proAccessMaterials";

type Props = {
  undercover: string;
  background: string;
  highlight: string;
  primary: string;
  lightTheme?: boolean;
};

/** Full-bleed tariff tray. Light: clean silver band; dark: brushed platinum. */
export function ProTariffUndercoverCanvas({
  undercover,
  background,
  highlight,
  primary: _primary,
  lightTheme = false,
}: Props) {
  const hostRef = useRef<View>(null);

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
    host.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    let grain: HTMLCanvasElement | null = null;
    let grainKey = "";

    const ensureGrain = (w: number, h: number) => {
      const key = `${w}x${h}:${undercover}:${background}:${lightTheme ? "L" : "D"}`;
      if (grain && grainKey === key) return grain;
      grain = document.createElement("canvas");
      grain.width = Math.max(1, Math.round(w));
      grain.height = Math.max(1, Math.round(h));
      grainKey = key;
      const g = grain.getContext("2d");
      if (!g) return grain;

      if (lightTheme) {
        // Clean light silver — no muddy brush dirt.
        const base = g.createLinearGradient(0, 0, 0, h);
        base.addColorStop(0, "#F3F3F3");
        base.addColorStop(0.35, undercover);
        base.addColorStop(0.7, background);
        base.addColorStop(1, "#D0D0D0");
        g.fillStyle = base;
        g.fillRect(0, 0, w, h);

        g.save();
        g.globalAlpha = 0.06;
        for (let y = 0; y < h; y += 2) {
          g.strokeStyle = "rgba(255,255,255,0.9)";
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(w, y);
          g.stroke();
        }
        g.restore();
      } else {
        paintPlatinumGrain(g, w, h, undercover, background, "field");
      }
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
      ctx.drawImage(ensureGrain(w, h), 0, 0, w, h);

      if (lightTheme) {
        // Crisp top/bottom seams — no soft washed lip.
        ctx.fillStyle = "rgba(0,0,0,0.14)";
        ctx.fillRect(0, 0, w, 1);
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.fillRect(0, 1, w, 1);
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.fillRect(0, h - 1, w, 1);

        const soft = ctx.createLinearGradient(0, 0, 0, 10);
        soft.addColorStop(0, "rgba(0,0,0,0.04)");
        soft.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = soft;
        ctx.fillRect(0, 2, w, 10);
      } else {
        paintPlatinumLiveOverlay(ctx, w, h, t, highlight, {
          kind: "field",
          lightTheme,
        });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    };
  }, [undercover, background, highlight, lightTheme]);

  if (Platform.OS !== "web") return null;
  return (
    <View
      pointerEvents="none"
      ref={hostRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: 0,
      }}
    />
  );
}
