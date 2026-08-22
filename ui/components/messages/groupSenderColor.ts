import type { ThemeName } from "../../theme";
import { colorForAvatarLetter } from "./chatAvatarInitials";
import { resolveTelegramUserAccentColorForDisplay } from "./resolveTelegramUserAccentColor";

function senderSeed(senderUserId: number | null, senderChatId: number | null, senderName: string): string {
  if (senderUserId != null) return `u:${senderUserId}`;
  if (senderChatId != null) return `c:${senderChatId}`;
  return `n:${senderName.trim().toLowerCase()}`;
}

/** Distinct username color per sender — Telegram profile accent when set, else hash palette. */
export function groupSenderDisplayColor(
  senderUserId: number | null,
  senderChatId: number | null,
  senderName: string,
  scheme: ThemeName,
  accentLight: string | null | undefined,
  accentDark: string | null | undefined,
  backgroundColor: string,
): string {
  const profileColor = resolveTelegramUserAccentColorForDisplay(
    accentLight,
    accentDark,
    scheme,
    backgroundColor,
  );
  if (profileColor) return profileColor;
  const seed = senderSeed(senderUserId, senderChatId, senderName);
  const letter = Array.from(seed).find((ch) => /[a-z0-9]/i.test(ch)) ?? "A";
  return colorForAvatarLetter(letter, scheme);
}
