import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";

import { drawProMetallicRocket } from "./proMetallicRocketDraw";

type Props = {
  sizePx?: number;
  inverted?: boolean;
};

/**
 * Cartoon metallic rocket (Telegram-emoji shading), readable at ~18px.
 * Points upper-right; slight idle bob only (keeps glyph large in the chip).
 */
export function ProMetallicRocket({ sizePx = 18, inverted = false }: Props) {
  const hostRef = useRef<View>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!host) return;

    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sizePx * dpr);
    canvas.height = Math.round(sizePx * dpr);
    canvas.style.width = `${sizePx}px`;
    canvas.style.height = `${sizePx}px`;
    canvas.style.display = "block";
    canvas.style.overflow = "hidden";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      drawProMetallicRocket(ctx, sizePx, (now - start) / 1000, inverted);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      canvas.remove();
    };
  }, [sizePx, inverted]);

  if (Platform.OS !== "web") {
    return (
      <View
        style={{
          width: sizePx,
          height: sizePx,
          borderRadius: sizePx / 2,
          backgroundColor: inverted ? "rgba(255,255,255,0.4)" : "rgba(190,200,220,0.7)",
        }}
      />
    );
  }

  return (
    <View
      ref={hostRef}
      style={{
        width: sizePx,
        height: sizePx,
        overflow: "hidden",
      }}
    />
  );
}
