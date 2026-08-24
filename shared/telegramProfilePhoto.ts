/** Custom-emoji / generated-background profile photos from TDLib `chatPhoto.sticker`. */

export type TelegramProfilePhotoFill =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; top_color: string; bottom_color: string }
  | { kind: "freeform"; colors: string[] };

export type TelegramProfilePhotoMarkup = {
  custom_emoji_id: string | null;
  fill: TelegramProfilePhotoFill | null;
  has_animation: boolean;
  /** ISO timestamp from TDLib `chatPhoto.added_date`, when known. */
  added_at: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** TDLib int32 RGB (sometimes signed) → `#rrggbb`. */
export function tdlibColorToCssHex(value: unknown): string | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(n)) return null;
  const rgb = (n >>> 0) & 0xffffff;
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

export function parseTdlibBackgroundFill(value: unknown): TelegramProfilePhotoFill | null {
  const row = asRecord(value);
  if (!row) return null;
  const type = typeof row._ === "string" ? row._ : "";
  if (type === "backgroundFillSolid") {
    const color = tdlibColorToCssHex(row.color);
    return color ? { kind: "solid", color } : null;
  }
  if (type === "backgroundFillGradient") {
    const top = tdlibColorToCssHex(row.top_color ?? row.topColor);
    const bottom = tdlibColorToCssHex(row.bottom_color ?? row.bottomColor);
    if (!top || !bottom) return null;
    return { kind: "gradient", top_color: top, bottom_color: bottom };
  }
  if (type === "backgroundFillFreeformGradient") {
    const raw = row.colors;
    if (!Array.isArray(raw)) return null;
    const colors = raw
      .map((entry) => tdlibColorToCssHex(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (colors.length === 0) return null;
    return { kind: "freeform", colors };
  }
  const color = tdlibColorToCssHex(row.color);
  if (color) return { kind: "solid", color };
  return null;
}

export function profilePhotoFillCss(fill: TelegramProfilePhotoFill): string {
  if (fill.kind === "solid") return fill.color;
  if (fill.kind === "gradient") {
    return `linear-gradient(180deg, ${fill.top_color}, ${fill.bottom_color})`;
  }
  const colors = fill.colors;
  if (colors.length === 1) return colors[0]!;
  if (colors.length === 2) {
    return `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
  }
  const a = colors[0]!;
  const b = colors[1] ?? a;
  const c = colors[2] ?? b;
  const d = colors[3] ?? c;
  return [
    `radial-gradient(at 18% 18%, ${a} 0%, transparent 58%)`,
    `radial-gradient(at 82% 22%, ${b} 0%, transparent 52%)`,
    `radial-gradient(at 22% 86%, ${c} 0%, transparent 55%)`,
    `radial-gradient(at 78% 78%, ${d} 0%, transparent 50%)`,
    d,
  ].join(", ");
}

export function profilePhotoFillFallbackColor(fill: TelegramProfilePhotoFill): string {
  if (fill.kind === "solid") return fill.color;
  if (fill.kind === "gradient") return fill.top_color;
  return fill.colors[0] ?? "#888888";
}

export function normalizeTelegramProfilePhotoMarkup(
  value: unknown,
): TelegramProfilePhotoMarkup | null {
  const row = asRecord(value);
  if (!row) return null;
  const custom =
    typeof row.custom_emoji_id === "string" && row.custom_emoji_id.trim()
      ? row.custom_emoji_id.trim()
      : typeof row.customEmojiId === "string" && row.customEmojiId.trim()
        ? row.customEmojiId.trim()
        : null;
  const fillRaw = row.fill ?? row.background_fill ?? row.backgroundFill;
  let fill: TelegramProfilePhotoFill | null = null;
  const fillRow = asRecord(fillRaw);
  if (fillRow && typeof fillRow.kind === "string") {
    if (fillRow.kind === "solid" && typeof fillRow.color === "string") {
      fill = { kind: "solid", color: fillRow.color };
    } else if (
      fillRow.kind === "gradient" &&
      typeof fillRow.top_color === "string" &&
      typeof fillRow.bottom_color === "string"
    ) {
      fill = {
        kind: "gradient",
        top_color: fillRow.top_color,
        bottom_color: fillRow.bottom_color,
      };
    } else if (fillRow.kind === "freeform" && Array.isArray(fillRow.colors)) {
      const colors = fillRow.colors.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      if (colors.length > 0) fill = { kind: "freeform", colors };
    }
  }
  if (!fill) fill = parseTdlibBackgroundFill(fillRaw);
  const hasAnimation = row.has_animation === true || row.hasAnimation === true;
  const addedAt =
    typeof row.added_at === "string" && row.added_at.trim()
      ? row.added_at.trim()
      : typeof row.addedAt === "string" && row.addedAt.trim()
        ? row.addedAt.trim()
        : null;
  if (!custom && !fill && !hasAnimation && !addedAt) return null;
  return {
    custom_emoji_id: custom,
    fill,
    has_animation: hasAnimation,
    added_at: addedAt,
  };
}
