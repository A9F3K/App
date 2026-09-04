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

/** Full-bleed brushed-platinum field (unified light/dark). */
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
      const key = `${w}x${h}:${undercover}:${background}:pt`;
      if (grain && grainKey === key) return grain;
      grain = document.createElement("canvas");
      grain.width = Math.max(1, Math.round(w));
      grain.height = Math.max(1, Math.round(h));
      grainKey = key;
      const g = grain.getContext("2d");
      if (!g) return grain;
      paintPlatinumGrain(g, w, h, undercover, background, "field");
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
      paintPlatinumLiveOverlay(ctx, w, h, t, highlight, {
        kind: "field",
        lightTheme,
      });

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

