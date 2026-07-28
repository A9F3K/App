import { stripInvisibleDisplayNameChars } from "../../../shared/telegramDisplayName";
import type { ThemeColors, ThemeName } from "../../theme";

/** Soft luminous hues — readable on dark undercover fills (#323232 range). */
const LETTER_COLORS_DARK = [
  "#FF8A80",
  "#FF80AB",
  "#EA80FC",
  "#B388FF",
  "#8C9EFF",
  "#82B1FF",
  "#80D8FF",
  "#84FFFF",
  "#A7FFEB",
  "#B9F6CA",
  "#CCFF90",
  "#F4FF81",
  "#FFFF8D",
  "#FFE57F",
  "#FFD180",
  "#FFAB91",
  "#BCAAA4",
  "#B0BEC5",
  "#EF9A9A",
  "#F48FB1",
  "#CE93D8",
  "#B39DDB",
  "#9FA8DA",
  "#90CAF9",
  "#80DEEA",
  "#80CBC4",
  "#A5D6A7",
] as const;

/** Rich mid-tones — readable on light undercover fills (#dadada range). */
const LETTER_COLORS_LIGHT = [
  "#C62828",
  "#AD1457",
  "#6A1B9A",
  "#4527A0",
  "#283593",
  "#1565C0",
  "#0277BD",
  "#00838F",
  "#00695C",
  "#2E7D32",
  "#558B2F",
  "#9E9D24",
  "#F9A825",
  "#FF8F00",
  "#EF6C00",
  "#D84315",
  "#4E342E",
  "#37474F",
  "#E53935",
  "#D81B60",
  "#8E24AA",
  "#5E35B1",
  "#3949AB",
  "#1E88E5",
  "#00ACC1",
  "#00897B",
  "#43A047",
] as const;

function tryParseRgb888(hex: string): [number, number, number] | null {
  const s = hex.trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

export function mixRgbHex(from: string, to: string, t: number): string {
  const A = tryParseRgb888(from);
  const B = tryParseRgb888(to);
  if (!A || !B) return from;
  const u = Math.min(1, Math.max(0, t));
  const r = Math.round(A[0] + (B[0] - A[0]) * u);
  const g = Math.round(A[1] + (B[1] - A[1]) * u);
  const b = Math.round(A[2] + (B[2] - A[2]) * u);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** CSS custom-property palette for animated 3D null-avatar chips. */
export function avatarFallback3dCssVars(
  letterColor: string | null,
  backgroundColor: string,
  scheme: ThemeName,
): Record<string, string> {
  const accent = letterColor ?? (scheme === "light" ? "#3949AB" : "#8C9EFF");
  const towardBlack = scheme === "light" ? "#1A1A1A" : "#000000";
  const towardWhite = scheme === "light" ? "#FFFFFF" : "#E8E8E8";
  return {
    ["--hsp-af-letter"]: accent,
    ["--hsp-af-depth1"]: mixRgbHex(accent, towardBlack, 0.28),
    ["--hsp-af-depth2"]: mixRgbHex(accent, towardBlack, 0.48),
    ["--hsp-af-depth3"]: mixRgbHex(accent, towardBlack, 0.68),
    ["--hsp-af-hi"]: mixRgbHex(accent, towardWhite, 0.35),
    ["--hsp-af-bg0"]: backgroundColor,
    ["--hsp-af-bg1"]: mixRgbHex(backgroundColor, accent, scheme === "light" ? 0.2 : 0.28),
    ["--hsp-af-bg2"]: mixRgbHex(backgroundColor, accent, scheme === "light" ? 0.38 : 0.48),
    ["--hsp-af-glow"]: mixRgbHex(accent, towardWhite, 0.2),
  };
}

function isInvisibleInitialGrapheme(grapheme: string): boolean {
  if (!grapheme) return true;
  return stripInvisibleDisplayNameChars(grapheme).length === 0;
}

function firstGrapheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  for (const grapheme of Array.from(trimmed)) {
    if (!isInvisibleInitialGrapheme(grapheme)) return grapheme;
  }
  return "";
}

function letterPalette(scheme: ThemeName): readonly string[] {
  return scheme === "light" ? LETTER_COLORS_LIGHT : LETTER_COLORS_DARK;
}

function letterPaletteIndex(letter: string, paletteLength: number): number {
  const upper = letter.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 48 && code <= 57) return (code - 48) % paletteLength;
  return code % paletteLength;
}

export function colorForAvatarLetter(letter: string, scheme: ThemeName): string {
  const palette = letterPalette(scheme);
  return palette[letterPaletteIndex(letter, palette.length)];
}

/** One color per initial; multi-letter avatars reuse the first letter's hue. */
export function colorsForAvatarInitials(initials: string[], scheme: ThemeName): string[] {
  if (initials.length === 0) return [];
  const firstColor = colorForAvatarLetter(initials[0], scheme);
  return initials.map(() => firstColor);
}

/** Filled circle behind initials — blends theme undercover toward primary for subtle depth. */
export function chatAvatarFallbackBackground(colors: ThemeColors, scheme: ThemeName): string {
  const t = scheme === "light" ? 0.05 : 0.1;
  return mixRgbHex(colors.undercover, colors.primary, t);
}

/**
 * Derives display initials from the chat title (built from first/last name, @username, or group title).
 * Returns an empty array when no displayable symbols exist (e.g. placeholder "Chat 123").
 */
export function extractChatAvatarInitials(title: string): string[] {
  const trimmed = stripInvisibleDisplayNameChars(title).trim();
  if (!trimmed || /^Chat \d+$/.test(trimmed)) return [];

  if (trimmed.startsWith("@")) {
    const letter = firstGrapheme(trimmed.slice(1));
    return letter ? [letter.toUpperCase()] : [];
  }

  const words = trimmed.split(/\s+/).filter((word) => stripInvisibleDisplayNameChars(word).trim().length > 0);
  if (words.length >= 2) {
    const first = firstGrapheme(words[0]);
    const second = firstGrapheme(words[1]);
    const letters = [first, second].filter(Boolean).map((c) => c.toUpperCase());
    return letters;
  }

  const letter = firstGrapheme(words[0] ?? trimmed);
  return letter ? [letter.toUpperCase()] : [];
}
