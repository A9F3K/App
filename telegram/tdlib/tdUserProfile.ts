import type { Client } from "tdl";
import { parseUserAccentColors } from "../../shared/telegramUserAccentColor.js";
import { resolveTelegramDisplayName } from "../../shared/telegramDisplayName.js";
import { emojiStatusCustomIdFromUser } from "./emojiStatus.js";

export type TdUserProfileCache = {
  name: string;
  emoji_status_custom_emoji_id: string | null;
  accent_color_light: string | null;
  accent_color_dark: string | null;
  is_bot: boolean;
};

const FALLBACK_PROFILE: TdUserProfileCache = {
  name: "User",
  emoji_status_custom_emoji_id: null,
  accent_color_light: null,
  accent_color_dark: null,
  is_bot: false,
};

export function userDisplayNameFromTdUser(user: Record<string, unknown>): string {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const joined = parts.join(" ").trim();
  const username =
    typeof user.username === "string" && user.username.trim()
      ? user.username.trim()
      : null;
  const usernames = user.usernames as { active_usernames?: string[] } | undefined;
  const active = usernames?.active_usernames?.find((u) => typeof u === "string" && u.trim());
  const resolvedUsername = active?.trim() ?? username;
  const userId = typeof user.id === "number" ? user.id : null;
  return resolveTelegramDisplayName({
    name: joined,
    username: resolvedUsername,
    userId,
  });
}

export function isBotFromTdUser(user: unknown): boolean {
  if (!user || typeof user !== "object") return false;
  const row = user as Record<string, unknown>;
  const type = row.type;
  if (type && typeof type === "object") {
    const typeId = (type as { _?: string })._;
    if (typeId === "userTypeBot") return true;
  }
  return row.type === "bot" || row.is_bot === true;
}

export function userProfileFromTdUser(user: unknown): TdUserProfileCache {
  if (!user || typeof user !== "object") return FALLBACK_PROFILE;
  const row = user as Record<string, unknown>;
  const accents = parseUserAccentColors(row);
  return {
    name: userDisplayNameFromTdUser(row),
    emoji_status_custom_emoji_id: emojiStatusCustomIdFromUser(row),
    accent_color_light: accents.light,
    accent_color_dark: accents.dark,
    is_bot: isBotFromTdUser(row),
  };
}

export async function resolveTdUserProfile(
  client: Client,
  userId: number,
  cache: Map<number, TdUserProfileCache>,
): Promise<TdUserProfileCache> {
  const cached = cache.get(userId);
  if (cached) return cached;
  try {
    const user = await client.invoke({ _: "getUser", user_id: userId });
    const profile = userProfileFromTdUser(user);
    cache.set(userId, profile);
    return profile;
  } catch {
    const fallback = { ...FALLBACK_PROFILE };
    cache.set(userId, fallback);
    return fallback;
  }
}
