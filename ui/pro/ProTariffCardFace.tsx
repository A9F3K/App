import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";

import {
  paintPlatinumGrain,
  paintPlatinumLiveOverlay,
  withAlpha,
} from "./proAccessMaterials";

type Props = {
  selected: boolean;
  undercover: string;
  background: string;
  highlight: string;
  primary: string;
  lightTheme?: boolean;
};

/** Brushed-platinum card plate with chrome rim (unified light/dark). */
export function ProTariffCardFace({
  selected,
  undercover,
  background,
  highlight,
  primary,
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
    canvas.style.borderRadius = "12px";
    host.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    let grain: HTMLCanvasElement | null = null;
    let grainKey = "";

    const ensureGrain = (w: number, h: number) => {
      const key = `${w}x${h}:${undercover}:${background}:${selected ? 1 : 0}:pt`;
      if (grain && grainKey === key) return grain;
      grain = document.createElement("canvas");
      grain.width = Math.max(1, Math.round(w));
      grain.height = Math.max(1, Math.round(h));
      grainKey = key;
      const g = grain.getContext("2d");
      if (!g) return grain;
      paintPlatinumGrain(g, w, h, undercover, background, "plate", selected);
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
      const r = 12;
      roundRect(ctx, 0, 0, w, h, r);
      ctx.save();
      ctx.clip();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(ensureGrain(w, h), 0, 0, w, h);
      paintPlatinumLiveOverlay(ctx, w, h, t, highlight, {
        kind: "plate",
        selected,
        lightTheme,
      });
      ctx.restore();

      roundRect(ctx, 0.75, 0.75, w - 1.5, h - 1.5, r - 0.2);
      ctx.strokeStyle = selected
        ? "rgba(255,255,255,0.88)"
        : withAlpha(highlight, 0.55);
      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.stroke();

      roundRect(ctx, 2.2, 2.2, w - 4.4, h - 4.4, r - 1.8);
      ctx.strokeStyle = selected ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.35)";
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
  }, [selected, undercover, background, highlight, primary, lightTheme]);

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
        borderRadius: 12,
        overflow: "hidden",
      }}
    />
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
