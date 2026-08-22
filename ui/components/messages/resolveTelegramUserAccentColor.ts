import type { ThemeName } from "../../theme";
import {
  ensureAccentReadableOnBackground,
  resolveTelegramUserAccentColor as resolveShared,
  resolveTelegramUserAccentColorForDisplay as resolveSharedForDisplay,
} from "../../../shared/telegramUserAccentColor";

export function resolveTelegramUserAccentColor(
  accentLight: string | null | undefined,
  accentDark: string | null | undefined,
  scheme: ThemeName,
): string | null {
  return resolveShared(
    {
      light: accentLight ?? null,
      dark: accentDark ?? null,
    },
    scheme === "dark" ? "dark" : "light",
  );
}

/** Telegram profile accent with contrast pass for sender names on `backgroundHex`. */
export function resolveTelegramUserAccentColorForDisplay(
  accentLight: string | null | undefined,
  accentDark: string | null | undefined,
  scheme: ThemeName,
  backgroundHex: string,
): string | null {
  return resolveSharedForDisplay(
    {
      light: accentLight ?? null,
      dark: accentDark ?? null,
    },
    scheme === "dark" ? "dark" : "light",
    backgroundHex,
  );
}

export { ensureAccentReadableOnBackground };
