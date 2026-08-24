import type { TelegramProfilePhotoMarkup } from "../../shared/telegramProfilePhoto";

export type CachedSelfTelegramProfile = {
  userId: number;
  title: string;
  username: string | null;
  emojiStatusCustomEmojiId: string | null;
  profilePhoto: TelegramProfilePhotoMarkup | null;
};

let cached: CachedSelfTelegramProfile | null = null;

export function getCachedSelfTelegramProfile(
  userId: number | null | undefined,
): CachedSelfTelegramProfile | null {
  if (userId == null || !Number.isFinite(userId) || userId <= 0) return null;
  const id = Math.trunc(userId);
  if (!cached || cached.userId !== id) return null;
  return cached;
}

export function rememberSelfTelegramProfile(
  userId: number,
  profile: Omit<CachedSelfTelegramProfile, "userId">,
): void {
  const title = profile.title.trim();
  if (!title) return;
  cached = {
    userId: Math.trunc(userId),
    title,
    username: profile.username?.trim() || null,
    emojiStatusCustomEmojiId: profile.emojiStatusCustomEmojiId?.trim() || null,
    profilePhoto: profile.profilePhoto ?? null,
  };
}

export function clearSelfTelegramProfileCache(): void {
  cached = null;
}
