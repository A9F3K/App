import type { ThemeColors } from "../theme";

/**
 * Surface materials for Pro Access metal UI.
 * Cards / CTA: shared black metal on light and dark.
 * Tray + dialog copy stay theme-aware.
 */
export type ProAccessMaterials = {
  /** Full-bleed tariff tray. */
  field: string;
  /** Card / CTA plate base. */
  plate: string;
  /** Lifted selected plate (also CTA deep — slightly lighter than cards). */
  porcelain: string;
  /** Rim / chrome stroke. */
  chrome: string;
  /** Ink on metal surfaces (cards, CTA). */
  metalInk: string;
  /** Muted copy on metal surfaces. */
  metalMuted: string;
  /** Dialog / page copy (theme-aware). */
  ink: string;
  /** Dialog muted copy (theme-aware). */
  muted: string;
  /** Brand accent. */
  accent: string;
};

/** Shared black metal for tariff cards (both themes). Cards stay obscure/matte. */
const BLACK_METAL = {
  plate: "#0E0E0E",
  porcelain: "#161616",
  chrome: "#2E2E2E",
  metalInk: "#FFFFFF",
  metalMuted: "#9A9A9A",
} as const;

/** Light-theme tray: darker than dialog `#F1F1F1` so black cards and selection ring read clearly. */
const LIGHT_FIELD = "#9A9A9A";
const LIGHT_FIELD_MID = "#868686";

export function resolveProAccessMaterials(
  colors: ThemeColors,
  lightTheme: boolean,
): ProAccessMaterials {
  return {
    field: lightTheme ? LIGHT_FIELD : colors.undercover,
    ...BLACK_METAL,
    // Dark rim on light so unselected cards separate from the grey tray.
    chrome: lightTheme ? "#0A0A0A" : BLACK_METAL.chrome,
    ink: colors.primary,
    muted: colors.secondary,
    accent: colors.scrollIndicator,
  };
}

export const PRO_ACCESS_LIGHT_FIELD_MID = LIGHT_FIELD_MID;

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(128,128,128,${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return a;
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[m(A.r, B.r), m(A.g, B.g), m(A.b, B.b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function liftHex(hex: string, amount: number): string {
  const A = parseHex(hex);
  if (!A) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const f = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return `#${[clamp(A.r + (f - A.r) * t), clamp(A.g + (f - A.g) * t), clamp(A.b + (f - A.b) * t)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

export type PlatinumGrainKind = "field" | "plate" | "cta";

/**
 * Realistic anisotropic brushed platinum — cool steel-silver, shared by tray / cards / CTA.
 */
export function paintPlatinumGrain(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  deep: string,
  mid: string,
  kind: PlatinumGrainKind,
  selected = false,
): void {
  const base = g.createLinearGradient(0, 0, w * 0.18, h);
  if (kind === "field") {
    base.addColorStop(0, liftHex(deep, 0.14));
    base.addColorStop(0.28, mixHex(deep, mid, 0.22));
    base.addColorStop(0.62, deep);
    base.addColorStop(1, mixHex(deep, "#5A616A", 0.35));
  } else if (kind === "cta") {
    base.addColorStop(0, liftHex(mid, 0.28));
    base.addColorStop(0.32, mixHex(mid, deep, 0.2));
    base.addColorStop(0.68, mixHex(deep, mid, 0.45));
    base.addColorStop(1, mixHex(deep, "#6A727C", 0.4));
  } else if (selected) {
    // Obscure plate: almost flat charcoal, tiny lift only when selected.
    base.addColorStop(0, liftHex(mid, 0.06));
    base.addColorStop(0.5, mid);
    base.addColorStop(1, mixHex(mid, deep, 0.35));
  } else {
    base.addColorStop(0, mid);
    base.addColorStop(0.55, mid);
    base.addColorStop(1, mixHex(mid, deep, 0.25));
  }
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // Cool platinum brush lines; plates stay nearly matte / obscure.
  const brushAlpha =
    kind === "field" ? 0.22 : kind === "cta" ? 0.26 : selected ? 0.05 : 0.035;
  g.save();
  g.globalAlpha = brushAlpha;
  const step = kind === "field" ? 1.05 : 1.2;
  for (let y = 0; y < h; y += step) {
    const cool = 120 + ((y * 17) % 70);
    g.strokeStyle = `rgba(${cool - 4},${cool + 2},${cool + 12},0.55)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y + Math.sin(y * 0.48) * 0.35);
    g.lineTo(w, y + Math.sin(y * 0.31) * 0.35);
    g.stroke();
  }
  g.restore();

  // Micro specular flecks in the metal lattice
  const img = g.createImageData(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const data = img.data;
  const gw = img.width;
  const grainA =
    kind === "field" ? 28 : kind === "cta" ? 34 : selected ? 8 : 5;
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    const y = (p / gw) | 0;
    const x = p % gw;
    const n = (Math.random() * 40) | 0;
    const brush = Math.sin(y * 0.52) * 11 + ((x * 17) % 8);
    const v = 130 + n + brush;
    data[i] = Math.min(255, v - 2);
    data[i + 1] = Math.min(255, v + 2);
    data[i + 2] = Math.min(255, v + 10);
    data[i + 3] = grainA;
  }
  g.putImageData(img, 0, 0);
}

/** Living specular / AO overlays for platinum plates. */
export function paintPlatinumLiveOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  highlight: string,
  opts: {
    kind: PlatinumGrainKind;
    selected?: boolean;
    lightTheme: boolean;
  },
): void {
  const { kind, selected = false, lightTheme } = opts;
  const isPlate = kind === "plate";
  const isCta = kind === "cta";
  // Field tray stays theme-aware; CTA keeps mild shine; plates are obscure/matte.
  const aoStrength = isPlate ? 0.28 : lightTheme || isCta ? 0.1 : 0.22;

  const keyX = w * (0.24 + 0.1 * Math.sin(t * (isCta ? 0.7 : 0.55)));
  const keyY = h * (0.26 + 0.08 * Math.cos(t * 0.6));
  const key = ctx.createRadialGradient(keyX, keyY, 2, keyX, keyY, Math.max(w, h) * 0.72);
  if (isPlate) {
    key.addColorStop(0, "rgba(255,255,255,0.04)");
    key.addColorStop(0.35, "rgba(255,255,255,0.012)");
    key.addColorStop(1, "rgba(0,0,0,0)");
  } else {
    key.addColorStop(0, "rgba(255,255,255,0.52)");
    key.addColorStop(0.18, "rgba(230,238,248,0.16)");
    key.addColorStop(0.5, withAlpha(highlight, 0.1));
    key.addColorStop(1, "rgba(0,0,0,0)");
  }
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  if (selected && !isPlate) {
    const sel = ctx.createLinearGradient(0, 0, w, h);
    sel.addColorStop(0, "rgba(255,255,255,0.1)");
    sel.addColorStop(0.55, "rgba(0,0,0,0)");
    sel.addColorStop(1, withAlpha(highlight, 0.08));
    ctx.fillStyle = sel;
    ctx.fillRect(0, 0, w, h);
  } else if (selected && isPlate) {
    const sel = ctx.createLinearGradient(0, 0, 0, h);
    sel.addColorStop(0, "rgba(255,255,255,0.03)");
    sel.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sel;
    ctx.fillRect(0, 0, w, h);
  }

  // Diagonal sweep: strong on CTA/field, nearly gone on obscure plates.
  if (!isPlate) {
    const speed = isCta ? 85 : selected ? 70 : 52;
    const sweepX = ((t * speed) % (w + 220)) - 90;
    ctx.save();
    ctx.translate(sweepX, 0);
    ctx.rotate(kind === "field" ? -0.25 : -0.3);
    const sweep = ctx.createLinearGradient(0, 0, kind === "field" ? 70 : 42, h * 1.25);
    sweep.addColorStop(0, "rgba(255,255,255,0)");
    sweep.addColorStop(0.45, "rgba(220,230,240,0.06)");
    sweep.addColorStop(0.5, selected || isCta ? "rgba(255,255,255,0.42)" : "rgba(255,255,255,0.26)");
    sweep.addColorStop(0.55, "rgba(220,230,240,0.06)");
    sweep.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sweep;
    ctx.fillRect(-55, -40, 120, h + 80);
    ctx.restore();
  }

  const ao = ctx.createLinearGradient(0, 0, 0, h);
  const topHighlight =
    isPlate ? 0.03 : kind === "field" && lightTheme ? 0.06 : lightTheme || isCta ? 0.28 : 0.14;
  ao.addColorStop(0, `rgba(255,255,255,${topHighlight})`);
  ao.addColorStop(0.14, "rgba(255,255,255,0)");
  ao.addColorStop(0.86, "rgba(0,0,0,0)");
  ao.addColorStop(1, `rgba(0,0,0,${aoStrength})`);
  ctx.fillStyle = ao;
  ctx.fillRect(0, 0, w, h);

  if (kind === "field") {
    if (lightTheme) {
      // Crisp seam vs dialog background — no washed white lip.
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(0, 0, w, 1);
      const topShade = ctx.createLinearGradient(0, 1, 0, 14);
      topShade.addColorStop(0, "rgba(0,0,0,0.14)");
      topShade.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = topShade;
      ctx.fillRect(0, 1, w, 14);

      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(0, h - 1, w, 1);
      const floor = ctx.createLinearGradient(0, h - 14, 0, h - 1);
      floor.addColorStop(0, "rgba(0,0,0,0)");
      floor.addColorStop(1, "rgba(0,0,0,0.12)");
      ctx.fillStyle = floor;
      ctx.fillRect(0, h - 14, w, 13);
    } else {
      const lip = ctx.createLinearGradient(0, 0, 0, 12);
      lip.addColorStop(0, "rgba(255,255,255,0.35)");
      lip.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = lip;
      ctx.fillRect(0, 0, w, 12);

      const floor = ctx.createLinearGradient(0, h - 16, 0, h);
      floor.addColorStop(0, "rgba(0,0,0,0)");
      floor.addColorStop(1, "rgba(0,0,0,0.38)");
      ctx.fillStyle = floor;
      ctx.fillRect(0, h - 16, w, 16);
    }
  }
}
