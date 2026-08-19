import { buildApiUrl } from "../../api/_base";

export type TelegramProfileAudioTrack = {
  user_id: number;
  file_id: number;
  artist: string;
  title: string;
  duration_sec: number;
  size_bytes: number;
  cover_data_url: string | null;
  cover_file_id: number | null;
  chat_id?: number | null;
  message_id?: number | null;
};

export type TelegramUserProfile = {
  user_id: number | null;
  chat_id: number;
  title: string;
  username: string | null;
  bio: string | null;
  phone_number: string | null;
  status_text: string | null;
  is_bot: boolean;
  is_blocked: boolean;
  emoji_status_custom_emoji_id: string | null;
  music: { artist: string; title: string } | null;
  playlist: TelegramProfileAudioTrack[];
  channel: {
    chat_id: number;
    title: string;
    subtitle: string | null;
  } | null;
  media: {
    marked: number;
    images: number;
    photos: number;
    links: number;
    gifs: number;
  };
};

export type FetchTelegramUserProfileResult =
  | { ok: true; profile: TelegramUserProfile }
  | { ok: false; error: string };

export type ProfileMediaKind = "marked" | "images" | "photos" | "links" | "gifs";

export type TelegramChatMediaItem = {
  telegram_message_id: number;
  date: string | null;
  text: string;
  url: string;
  kind: ProfileMediaKind;
  sender_name: string;
};

export type TelegramChatLinkItem = TelegramChatMediaItem;

export async function fetchTelegramUserProfile(
  chatId: number,
  peerUserId?: number | null,
  signal?: AbortSignal,
): Promise<FetchTelegramUserProfileResult> {
  const hasChat = Number.isFinite(chatId) && chatId !== 0;
  const hasUser =
    peerUserId != null && Number.isFinite(peerUserId) && peerUserId !== 0;
  if (!hasChat && !hasUser) {
    return { ok: false, error: "chat_id_or_user_id_required" };
  }
  const params = new URLSearchParams();
  if (hasChat) params.set("chat_id", String(Math.trunc(chatId)));
  if (hasUser) params.set("user_id", String(Math.trunc(peerUserId!)));
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-profile?${params.toString()}`),
      { method: "GET", credentials: "include", signal },
    );
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; profile?: TelegramUserProfile; error?: string }
      | null;
    if (!response.ok || !json?.ok || !json.profile) {
      return { ok: false, error: json?.error ?? "profile_unavailable" };
    }
    return {
      ok: true,
      profile: {
        ...json.profile,
        is_blocked: Boolean(json.profile.is_blocked),
        playlist: Array.isArray(json.profile.playlist) ? json.profile.playlist : [],
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function blockTelegramUser(userId: number): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-block"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: Math.trunc(userId) }),
    });
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    return {
      ok: response.ok && json?.ok !== false,
      error: typeof json?.error === "string" ? json.error : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function unblockTelegramUser(
  userId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-unblock"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: Math.trunc(userId) }),
    });
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    return {
      ok: response.ok && json?.ok !== false,
      error: typeof json?.error === "string" ? json.error : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function fetchTelegramChatLinks(
  chatId: number,
  options?: { fromMessageId?: number | null; limit?: number; signal?: AbortSignal },
): Promise<
  | { ok: true; links: TelegramChatLinkItem[]; has_more: boolean }
  | { ok: false; error: string }
> {
  const result = await fetchTelegramChatMedia(chatId, "links", options);
  if (!result.ok) return result;
  return { ok: true, links: result.items, has_more: result.has_more };
}

export async function fetchTelegramChatMedia(
  chatId: number,
  kind: ProfileMediaKind,
  options?: { fromMessageId?: number | null; limit?: number; signal?: AbortSignal },
): Promise<
  | { ok: true; items: TelegramChatMediaItem[]; has_more: boolean }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const params = new URLSearchParams({
    chat_id: String(Math.trunc(chatId)),
    kind,
  });
  if (
    options?.fromMessageId != null &&
    Number.isFinite(options.fromMessageId) &&
    options.fromMessageId! > 0
  ) {
    params.set("from_message_id", String(Math.trunc(options.fromMessageId!)));
  }
  if (options?.limit != null && Number.isFinite(options.limit)) {
    params.set("limit", String(Math.trunc(options.limit)));
  }
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-profile-media?${params.toString()}`),
      { method: "GET", credentials: "include", signal: options?.signal },
    );
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; items?: TelegramChatMediaItem[]; has_more?: boolean; error?: string }
      | null;
    if (!response.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? "media_unavailable" };
    }
    return {
      ok: true,
      items: Array.isArray(json.items) ? json.items : [],
      has_more: Boolean(json.has_more),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export function telegramProfileAudioUrl(userId: number, fileId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-profile-audio?user_id=${encodeURIComponent(String(Math.trunc(userId)))}&file_id=${encodeURIComponent(String(Math.trunc(fileId)))}`,
  );
}

export function telegramProfileAudioCoverUrl(userId: number, fileId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-profile-audio-cover?user_id=${encodeURIComponent(String(Math.trunc(userId)))}&file_id=${encodeURIComponent(String(Math.trunc(fileId)))}`,
  );
}

export function telegramChatMessageAudioUrl(chatId: number, messageId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-media?chat_id=${encodeURIComponent(String(Math.trunc(chatId)))}&message_id=${encodeURIComponent(String(Math.trunc(messageId)))}`,
  );
}

export function musicTrackPlaybackKey(track: TelegramProfileAudioTrack): string {
  if (
    track.chat_id != null &&
    Number.isFinite(track.chat_id) &&
    track.chat_id !== 0 &&
    track.message_id != null &&
    Number.isFinite(track.message_id) &&
    track.message_id !== 0
  ) {
    return `msg:${Math.trunc(track.chat_id)}:${Math.trunc(track.message_id)}`;
  }
  return `file:${Math.trunc(track.user_id)}:${Math.trunc(track.file_id)}`;
}

export function musicTrackPlaybackUrl(track: TelegramProfileAudioTrack): string {
  if (
    track.chat_id != null &&
    Number.isFinite(track.chat_id) &&
    track.chat_id !== 0 &&
    track.message_id != null &&
    Number.isFinite(track.message_id) &&
    track.message_id !== 0
  ) {
    return telegramChatMessageAudioUrl(track.chat_id, track.message_id);
  }
  return telegramProfileAudioUrl(track.user_id, track.file_id);
}
