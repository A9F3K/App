import { emitLiveChatRevision } from "./liveChatRevisionNotify.js";
import { specialUserForceIncludedPeerUserIds } from "../../shared/specialTelegramUsers.js";
import {
  CHAT_ACTION_TTL_MS,
  chatTitle,
  isChatPinnedInMainList,
  lastMessageAtIso,
  lastReadOutboxMessageIdFromChat,
  mainListOrderKey,
  normalizeUnreadCount,
  peerUserIdFromChat,
  previewFromMessage,
  peerUsernameFromChat,
  chatUsernameFromChat,
  type ChatActionKind,
  type ChatPresenceKind,
  type TdChat,
  type TdMessage,
} from "./chatPreview.js";
import { previewSegmentsFromMessage } from "./formattedTextSegments.js";
import { emojiStatusCustomIdFromChat } from "./emojiStatus.js";
import {
  chatKindFromTdChat,
  lastMessageOutgoingPreviewFromChat,
  lastMessageOutgoingPreviewFromMessage,
  type MessageOutgoingStatus,
} from "./messageHistoryMap.js";
import { shouldIncludeChatInList } from "./chatListFilter.js";
import { isPrivateTdChat } from "./chatPreview.js";
import type { FormattedTextSegment } from "../../shared/formattedTextSegments.js";

export type LiveChatRow = {
  telegram_chat_id: number;
  title: string;
  subtitle: string;
  subtitle_segments?: FormattedTextSegment[] | null;
  avatar_url: string | null;
  last_message_at: string;
  unread_count: number;
  peer_user_id: number | null;
  peer_username: string | null;
  chat_username: string | null;
  chat_kind?: "private" | "group" | "supergroup" | "channel" | null;
  member_count?: number | null;
  peer_emoji_status_custom_emoji_id?: string | null;
  peer_accent_color_light?: string | null;
  peer_accent_color_dark?: string | null;
  presence_kind: ChatPresenceKind | null;
  presence_at: string | null;
  chat_action: ChatActionKind | null;
  chat_action_user_id: number | null;
  chat_action_user_name: string | null;
  chat_action_expires_at: string | null;
  last_read_outbox_message_id: number | null;
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
  is_pinned: boolean;
  pin_order: string;
  /** Monotonic version bumped on each update (for client diffing). */
  revision: number;
};

function comparePinOrderDesc(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    if (right > left) return 1;
    if (right < left) return -1;
    return 0;
  } catch {
    return 0;
  }
}

function sortLiveChatRows(rows: LiveChatRow[]): LiveChatRow[] {
  return [...rows].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.is_pinned && b.is_pinned) {
      const byPinOrder = comparePinOrderDesc(a.pin_order, b.pin_order);
      if (byPinOrder !== 0) return byPinOrder;
    }
    return Date.parse(b.last_message_at) - Date.parse(a.last_message_at);
  });
}

type UserCache = {
  chats: Map<number, LiveChatRow>;
  revision: number;
  /** Avoid re-sorting on every read when revision is unchanged. */
  sortedList: LiveChatRow[] | null;
  sortedListRevision: number;
};

const caches = new Map<string, UserCache>();

function emptyChatActionFields(): Pick<
  LiveChatRow,
  "chat_action" | "chat_action_user_id" | "chat_action_user_name" | "chat_action_expires_at"
> {
  return {
    chat_action: null,
    chat_action_user_id: null,
    chat_action_user_name: null,
    chat_action_expires_at: null,
  };
}

function expireChatActionIfStale(row: LiveChatRow): LiveChatRow {
  if (!row.chat_action || !row.chat_action_expires_at) return row;
  if (Date.parse(row.chat_action_expires_at) > Date.now()) return row;
  return { ...row, ...emptyChatActionFields() };
}

function userCache(telegramUsername: string): UserCache {
  let cache = caches.get(telegramUsername);
  if (!cache) {
    cache = { chats: new Map(), revision: 0, sortedList: null, sortedListRevision: -1 };
    caches.set(telegramUsername, cache);
  }
  return cache;
}

function bumpRevision(cache: UserCache, telegramUsername: string): number {
  cache.revision += 1;
  cache.sortedList = null;
  emitLiveChatRevision(telegramUsername, cache.revision);
  return cache.revision;
}

/** Metadata-only row update — does not bump list revision or emit SSE. */
function replaceLiveChatRowQuietly(
  telegramUsername: string,
  row: Omit<LiveChatRow, "revision">,
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(row.telegram_chat_id);
  if (!existing) return null;
  const next: LiveChatRow = { ...row, revision: existing.revision };
  cache.chats.set(row.telegram_chat_id, next);
  cache.sortedList = null;
  return next;
}

export function clearLiveChatCache(telegramUsername: string): void {
  caches.delete(telegramUsername);
}

export function getLiveChatListRevision(telegramUsername: string): number {
  return caches.get(telegramUsername)?.revision ?? 0;
}

export function getLiveChatList(telegramUsername: string): LiveChatRow[] | null {
  const cache = caches.get(telegramUsername);
  if (!cache || cache.chats.size === 0) return null;
  if (cache.sortedList && cache.sortedListRevision === cache.revision) {
    return cache.sortedList.map(expireChatActionIfStale);
  }
  const sorted = sortLiveChatRows([...cache.chats.values()].map(expireChatActionIfStale));
  cache.sortedList = sorted;
  cache.sortedListRevision = cache.revision;
  return sorted;
}

export function seedLiveChatList(
  telegramUsername: string,
  rows: Omit<LiveChatRow, "revision">[],
): void {
  const cache = userCache(telegramUsername);
  cache.chats.clear();
  const rev = bumpRevision(cache, telegramUsername);
  for (const row of rows) {
    cache.chats.set(row.telegram_chat_id, { ...row, revision: rev });
  }
}

/** Merge rows into the live cache with a single revision bump (background paging). */
export function mergeLiveChatRows(
  telegramUsername: string,
  rows: Omit<LiveChatRow, "revision">[],
): number {
  const cache = userCache(telegramUsername);
  const forcedPeerIds = new Set(specialUserForceIncludedPeerUserIds());
  const filtered = rows.filter((row) => {
    if (cache.chats.has(row.telegram_chat_id)) return true;
    if (row.pin_order !== "0") return true;
    const peerUserId = row.peer_user_id;
    return peerUserId != null && forcedPeerIds.has(peerUserId);
  });
  if (filtered.length === 0) return cache.revision;
  const rev = bumpRevision(cache, telegramUsername);
  for (const row of filtered) {
    cache.chats.set(row.telegram_chat_id, { ...row, revision: rev });
  }
  return rev;
}

export function upsertLiveChatRow(
  telegramUsername: string,
  row: Omit<LiveChatRow, "revision">,
): LiveChatRow {
  const cache = userCache(telegramUsername);
  const rev = bumpRevision(cache, telegramUsername);
  const next: LiveChatRow = { ...row, revision: rev };
  cache.chats.set(row.telegram_chat_id, next);
  return next;
}

export function patchLiveChatFromTdlib(
  telegramUsername: string,
  chat: TdChat,
  input: {
    subtitle?: string | null;
    subtitle_segments?: FormattedTextSegment[] | null;
    avatar_url?: string | null;
    last_message?: TdMessage | null;
    peer_emoji_status_custom_emoji_id?: string | null;
    peer_username?: string | null;
    chat_username?: string | null;
  },
): LiveChatRow | null {
  const cache = userCache(telegramUsername);
  const existing = cache.chats.get(chat.id);
  if (!existing && !shouldIncludeChatInList(chat)) {
    return null;
  }
  const lastMessage = input.last_message ?? chat.last_message ?? null;
  const subtitleSegments =
    input.subtitle_segments !== undefined
      ? input.subtitle_segments
      : previewSegmentsFromMessage(lastMessage);
  const subtitle =
    input.subtitle?.trim() ||
    previewFromMessage(lastMessage) ||
    existing?.subtitle ||
    "";
  const chatEmojiStatusId = isPrivateTdChat(chat)
    ? null
    : emojiStatusCustomIdFromChat(chat);
  const row: Omit<LiveChatRow, "revision"> = {
    telegram_chat_id: chat.id,
    title: chatTitle(chat),
    subtitle,
    ...(subtitleSegments ? { subtitle_segments: subtitleSegments } : { subtitle_segments: null }),
    avatar_url: input.avatar_url !== undefined ? input.avatar_url : (existing?.avatar_url ?? null),
    last_message_at: lastMessageAtIso(chat, lastMessage),
    unread_count: normalizeUnreadCount(chat),
    peer_user_id: existing?.peer_user_id ?? peerUserIdFromChat(chat),
    peer_username:
      input.peer_username !== undefined
        ? input.peer_username
        : (existing?.peer_username ?? peerUsernameFromChat(chat)),
    chat_username:
      input.chat_username !== undefined
        ? input.chat_username
        : (existing?.chat_username ?? chatUsernameFromChat(chat)),
    chat_kind: chatKindFromTdChat(chat),
    member_count: existing?.member_count ?? null,
    peer_emoji_status_custom_emoji_id:
      input.peer_emoji_status_custom_emoji_id !== undefined
        ? input.peer_emoji_status_custom_emoji_id
        : chatEmojiStatusId ?? existing?.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: existing?.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing?.peer_accent_color_dark ?? null,
    presence_kind: existing?.presence_kind ?? null,
    presence_at: existing?.presence_at ?? null,
    chat_action: existing?.chat_action ?? null,
    chat_action_user_id: existing?.chat_action_user_id ?? null,
    chat_action_user_name: existing?.chat_action_user_name ?? null,
    chat_action_expires_at: existing?.chat_action_expires_at ?? null,
    last_read_outbox_message_id:
      lastReadOutboxMessageIdFromChat(chat) ?? existing?.last_read_outbox_message_id ?? null,
    ...lastMessageOutgoingPreviewFromChat(chat),
    is_pinned: isChatPinnedInMainList(chat),
    pin_order: mainListOrderKey(chat),
  };
  return upsertLiveChatRow(telegramUsername, row);
}

export function patchLiveChatAction(
  telegramUsername: string,
  chatId: number,
  input: {
    action: ChatActionKind | null;
    userId: number | null;
    userName: string | null;
  },
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(chatId);
  if (!existing) return null;

  const expiresAt =
    input.action != null ? new Date(Date.now() + CHAT_ACTION_TTL_MS).toISOString() : null;

  return upsertLiveChatRow(telegramUsername, {
    telegram_chat_id: existing.telegram_chat_id,
    title: existing.title,
    subtitle: existing.subtitle,
    ...(existing.subtitle_segments ? { subtitle_segments: existing.subtitle_segments } : {}),
    avatar_url: existing.avatar_url,
    last_message_at: existing.last_message_at,
    unread_count: existing.unread_count,
    peer_user_id: existing.peer_user_id,
    peer_username: existing.peer_username ?? null,
    chat_username: existing.chat_username ?? null,
    chat_kind: existing.chat_kind ?? null,
    member_count: existing.member_count ?? null,
    peer_emoji_status_custom_emoji_id: existing.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: existing.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing.peer_accent_color_dark ?? null,
    presence_kind: existing.presence_kind,
    presence_at: existing.presence_at,
    chat_action: input.action,
    chat_action_user_id: input.userId,
    chat_action_user_name: input.userName,
    chat_action_expires_at: expiresAt,
    last_read_outbox_message_id: existing.last_read_outbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
  });
}

export function patchLiveChatPresence(
  telegramUsername: string,
  peerUserId: number,
  presence: { kind: ChatPresenceKind; at: string | null },
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  for (const row of cache.chats.values()) {
    if (row.peer_user_id !== peerUserId) continue;
    return replaceLiveChatRowQuietly(telegramUsername, {
      telegram_chat_id: row.telegram_chat_id,
      title: row.title,
      subtitle: row.subtitle,
      ...(row.subtitle_segments ? { subtitle_segments: row.subtitle_segments } : {}),
      avatar_url: row.avatar_url,
      last_message_at: row.last_message_at,
      unread_count: row.unread_count,
      peer_user_id: row.peer_user_id,
      peer_username: row.peer_username ?? null,
      chat_username: row.chat_username ?? null,
      chat_kind: row.chat_kind ?? null,
      member_count: row.member_count ?? null,
      peer_emoji_status_custom_emoji_id: row.peer_emoji_status_custom_emoji_id ?? null,
      peer_accent_color_light: row.peer_accent_color_light ?? null,
      peer_accent_color_dark: row.peer_accent_color_dark ?? null,
      presence_kind: presence.kind,
      presence_at: presence.at,
      chat_action: row.chat_action,
      chat_action_user_id: row.chat_action_user_id,
      chat_action_user_name: row.chat_action_user_name,
      chat_action_expires_at: row.chat_action_expires_at,
      last_read_outbox_message_id: row.last_read_outbox_message_id,
      last_message_is_outgoing: row.last_message_is_outgoing,
      last_message_outgoing_status: row.last_message_outgoing_status,
      is_pinned: row.is_pinned,
      pin_order: row.pin_order,
    });
  }
  return null;
}

export function patchLiveChatEmojiStatus(
  telegramUsername: string,
  peerUserId: number,
  customEmojiId: string | null,
  accentColorLight: string | null = null,
  accentColorDark: string | null = null,
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  for (const row of cache.chats.values()) {
    if (row.peer_user_id !== peerUserId) continue;
    return replaceLiveChatRowQuietly(telegramUsername, {
      telegram_chat_id: row.telegram_chat_id,
      title: row.title,
      subtitle: row.subtitle,
      ...(row.subtitle_segments ? { subtitle_segments: row.subtitle_segments } : {}),
      avatar_url: row.avatar_url,
      last_message_at: row.last_message_at,
      unread_count: row.unread_count,
      peer_user_id: row.peer_user_id,
      peer_username: row.peer_username ?? null,
      chat_username: row.chat_username ?? null,
      chat_kind: row.chat_kind ?? null,
      member_count: row.member_count ?? null,
      peer_emoji_status_custom_emoji_id: customEmojiId,
      peer_accent_color_light: accentColorLight ?? row.peer_accent_color_light ?? null,
      peer_accent_color_dark: accentColorDark ?? row.peer_accent_color_dark ?? null,
      presence_kind: row.presence_kind,
      presence_at: row.presence_at,
      chat_action: row.chat_action,
      chat_action_user_id: row.chat_action_user_id,
      chat_action_user_name: row.chat_action_user_name,
      chat_action_expires_at: row.chat_action_expires_at,
      last_read_outbox_message_id: row.last_read_outbox_message_id,
      last_message_is_outgoing: row.last_message_is_outgoing,
      last_message_outgoing_status: row.last_message_outgoing_status,
      is_pinned: row.is_pinned,
      pin_order: row.pin_order,
    });
  }
  return null;
}

export function patchLiveChatChatEmojiStatus(
  telegramUsername: string,
  chatId: number,
  customEmojiId: string | null,
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(chatId);
  if (!existing) return null;
  return replaceLiveChatRowQuietly(telegramUsername, {
    telegram_chat_id: existing.telegram_chat_id,
    title: existing.title,
    subtitle: existing.subtitle,
    ...(existing.subtitle_segments ? { subtitle_segments: existing.subtitle_segments } : {}),
    avatar_url: existing.avatar_url,
    last_message_at: existing.last_message_at,
    unread_count: existing.unread_count,
    peer_user_id: existing.peer_user_id,
    peer_username: existing.peer_username ?? null,
    chat_username: existing.chat_username ?? null,
    chat_kind: existing.chat_kind ?? null,
    member_count: existing.member_count ?? null,
    peer_emoji_status_custom_emoji_id: customEmojiId,
    peer_accent_color_light: existing.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing.peer_accent_color_dark ?? null,
    presence_kind: existing.presence_kind,
    presence_at: existing.presence_at,
    chat_action: existing.chat_action,
    chat_action_user_id: existing.chat_action_user_id,
    chat_action_user_name: existing.chat_action_user_name,
    chat_action_expires_at: existing.chat_action_expires_at,
    last_read_outbox_message_id: existing.last_read_outbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
  });
}

export function applyLiveMessageUpdate(
  telegramUsername: string,
  chatId: number,
  message: TdMessage,
  unreadCount?: number,
): LiveChatRow | null {
  const cache = userCache(telegramUsername);
  const existing = cache.chats.get(chatId);
  const preview = previewFromMessage(message);
  if (!preview && !existing) return null;
  const subtitleSegments =
    previewSegmentsFromMessage(message) ?? existing?.subtitle_segments ?? null;

  const row: Omit<LiveChatRow, "revision"> = {
    telegram_chat_id: chatId,
    title: existing?.title ?? `Chat ${chatId}`,
    subtitle: preview || existing?.subtitle || "",
    ...(subtitleSegments ? { subtitle_segments: subtitleSegments } : {}),
    avatar_url: existing?.avatar_url ?? null,
    last_message_at: lastMessageAtIso({ id: chatId, last_message: message }, message),
    unread_count:
      typeof unreadCount === "number" && unreadCount >= 0
        ? unreadCount
        : (existing?.unread_count ?? 0),
    peer_user_id: existing?.peer_user_id ?? null,
    peer_username: existing?.peer_username ?? null,
    chat_username: existing?.chat_username ?? null,
    chat_kind: existing?.chat_kind ?? null,
    member_count: existing?.member_count ?? null,
    peer_emoji_status_custom_emoji_id: existing?.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: existing?.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing?.peer_accent_color_dark ?? null,
    presence_kind: existing?.presence_kind ?? null,
    presence_at: existing?.presence_at ?? null,
    chat_action: existing?.chat_action ?? null,
    chat_action_user_id: existing?.chat_action_user_id ?? null,
    chat_action_user_name: existing?.chat_action_user_name ?? null,
    chat_action_expires_at: existing?.chat_action_expires_at ?? null,
    last_read_outbox_message_id: existing?.last_read_outbox_message_id ?? null,
    ...lastMessageOutgoingPreviewFromMessage(
      message,
      existing?.last_read_outbox_message_id ?? null,
    ),
    is_pinned: existing?.is_pinned ?? false,
    pin_order: existing?.pin_order ?? "0",
  };
  return upsertLiveChatRow(telegramUsername, row);
}

export function patchLiveChatMemberMeta(
  telegramUsername: string,
  chatId: number,
  input: {
    member_count?: number | null;
    chat_kind?: LiveChatRow["chat_kind"];
  },
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(chatId);
  if (!existing) return null;
  return replaceLiveChatRowQuietly(telegramUsername, {
    telegram_chat_id: existing.telegram_chat_id,
    title: existing.title,
    subtitle: existing.subtitle,
    ...(existing.subtitle_segments ? { subtitle_segments: existing.subtitle_segments } : {}),
    avatar_url: existing.avatar_url,
    last_message_at: existing.last_message_at,
    unread_count: existing.unread_count,
    peer_user_id: existing.peer_user_id,
    peer_username: existing.peer_username ?? null,
    chat_username: existing.chat_username ?? null,
    chat_kind: input.chat_kind !== undefined ? input.chat_kind : (existing.chat_kind ?? null),
    member_count:
      input.member_count !== undefined ? input.member_count : (existing.member_count ?? null),
    peer_emoji_status_custom_emoji_id: existing.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: existing.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing.peer_accent_color_dark ?? null,
    presence_kind: existing.presence_kind,
    presence_at: existing.presence_at,
    chat_action: existing.chat_action,
    chat_action_user_id: existing.chat_action_user_id,
    chat_action_user_name: existing.chat_action_user_name,
    chat_action_expires_at: existing.chat_action_expires_at,
    last_read_outbox_message_id: existing.last_read_outbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
  });
}
