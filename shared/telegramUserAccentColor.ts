/**
 * Telegram accent colors for sender names — TDLib user fields + tdesktop historyPeer*NameFg
 * for built-in ids (not userpic background hues, which are too light on light themes).
 */

/** tdesktop `historyPeer*NameFg` on light fills — ids 0–6: red, orange, purple, green, sea, blue, pink. */
const BUILTIN_ACCENT_NAME_LIGHT = [
  "#C03D33",
  "#CE671B",
  "#8544D6",
  "#4FAD2D",
  "#2996AD",
  "#168ACD",
  "#CD4073",
] as const;

/** Bright name hues for dark undercover fills (unchanged — validated in app). */
const BUILTIN_ACCENT_NAME_DARK = [
  "#FF8585",
  "#FFAC72",
  "#B18FFF",
  "#85D685",
  "#7ADCE6",
  "#8BB3FF",
  "#FF9ACC",
] as const;

/** WCAG contrast for ~13px medium sender labels (between tdesktop bubble min 1.14 and AA 4.5). */
const MIN_SENDER_NAME_CONTRAST = 3.5;

export type TelegramUserAccentColors = {
  light: string | null;
  dark: string | null;
};

type Rgb = readonly [number, number, number];

function unpackTdlibRgbColor(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rgb = Math.trunc(n);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `#${[r, g, b].map((ch) => ch.toString(16).padStart(2, "0")).join("")}`;
}

function tryParseRgb888(hex: string): Rgb | null {
  const s = hex.trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m3) {
    const t = m3[1];
    return [
      parseInt(t[0] + t[0], 16),
      parseInt(t[1] + t[1], 16),
      parseInt(t[2] + t[2], 16),
    ];
  }
  return null;
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((ch) => ch.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const map = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return map(r) * 0.2126 + map(g) * 0.7152 + map(b) * 0.0722;
}

/** WCAG 2.x contrast ratio — same model as Telegram Desktop `CountContrast`. */
export function countContrastRatio(foregroundHex: string, backgroundHex: string): number {
  const fg = tryParseRgb888(foregroundHex);
  const bg = tryParseRgb888(backgroundHex);
  if (!fg || !bg) return 1;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Telegram Desktop `ThemeAdjustedColor`: keep accent lightness, borrow background hue/sat
 * (used when harmonizing with wallpaper — optional pre-pass for custom profile accents).
 */
export function themeAdjustedAccentColor(accentHex: string, backgroundHex: string): string {
  const accent = tryParseRgb888(accentHex);
  const background = tryParseRgb888(backgroundHex);
  if (!accent || !background) return accentHex;
  const accentHsl = rgbToHsl(accent);
  const backgroundHsl = rgbToHsl(background);
  return rgbToHex(
    hslToRgb(backgroundHsl.h, backgroundHsl.s, accentHsl.l),
  );
}

/** Darken/lighten accent lightness until contrast vs solid fill meets {@link MIN_SENDER_NAME_CONTRAST}. */
export function ensureAccentReadableOnBackground(
  accentHex: string,
  backgroundHex: string,
  minContrast = MIN_SENDER_NAME_CONTRAST,
): string {
  const bg = tryParseRgb888(backgroundHex);
  const raw = tryParseRgb888(accentHex);
  if (!bg || !raw) return accentHex;
  if (countContrastRatio(accentHex, backgroundHex) >= minContrast) return accentHex;

  const harmonized = themeAdjustedAccentColor(accentHex, backgroundHex);
  if (countContrastRatio(harmonized, backgroundHex) >= minContrast) return harmonized;

  const bgLum = relativeLuminance(bg);
  const towardDark = bgLum > 0.45;
  let { h, s, l } = rgbToHsl(tryParseRgb888(harmonized) ?? raw);
  s = Math.min(1, Math.max(0.35, s));

  for (let step = 0; step < 28; step += 1) {
    l = towardDark ? l * 0.9 : l + (1 - l) * 0.12;
    l = Math.min(1, Math.max(0, l));
    const candidate = rgbToHex(hslToRgb(h, s, l));
    if (countContrastRatio(candidate, backgroundHex) >= minContrast) {
      return candidate;
    }
  }

  return towardDark ? "#000000" : "#FFFFFF";
}

function builtinAccentColors(id: number): TelegramUserAccentColors | null {
  if (!Number.isFinite(id) || id < 0 || id > 6) return null;
  return {
    light: BUILTIN_ACCENT_NAME_LIGHT[id] ?? null,
    dark: BUILTIN_ACCENT_NAME_DARK[id] ?? null,
  };
}

/** Parse TDLib `user` accent fields into light/dark display colors. */
export function parseUserAccentColors(user: Record<string, unknown>): TelegramUserAccentColors {
  const accentColor = user.accent_color ?? user.accentColor;
  if (accentColor && typeof accentColor === "object") {
    const row = accentColor as Record<string, unknown>;
    const light = unpackTdlibRgbColor(row.light_theme_accent_color ?? row.lightThemeAccentColor);
    const dark = unpackTdlibRgbColor(row.dark_theme_accent_color ?? row.darkThemeAccentColor);
    if (light || dark) {
      return { light, dark };
    }
    const builtIn = Number(row.built_in_accent_color_id ?? row.builtInAccentColorId ?? row.id);
    const builtin = builtinAccentColors(builtIn);
    if (builtin) return builtin;
  }

  const accentColorId = Number(user.accent_color_id ?? user.accentColorId);
  const builtin = builtinAccentColors(accentColorId);
  if (builtin) return builtin;

  return { light: null, dark: null };
}

export function resolveTelegramUserAccentColor(
  colors: TelegramUserAccentColors | null | undefined,
  scheme: "light" | "dark",
): string | null {
  if (!colors) return null;
  if (scheme === "dark") return colors.dark ?? colors.light ?? null;
  return colors.light ?? colors.dark ?? null;
}

/** Profile accent from Telegram, tuned for readable sender names on a solid surface. */
export function resolveTelegramUserAccentColorForDisplay(
  colors: TelegramUserAccentColors | null | undefined,
  scheme: "light" | "dark",
  backgroundHex: string,
): string | null {
  const raw = resolveTelegramUserAccentColor(colors, scheme);
  if (!raw) return null;
  return ensureAccentReadableOnBackground(raw, backgroundHex);
}
