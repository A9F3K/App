import { emitLiveChatRevision } from "./liveChatRevisionNotify.js";
import {
  clearLiveChatMessageDeletes,
  peekLiveChatMessageDeletes,
} from "./liveChatDeletedMessages.js";
import {
  CHAT_ACTION_TTL_MS,
  chatTitle,
  isChatPinnedInMainList,
  isPrivateTdChat,
  lastMessageAtIso,
  lastReadInboxMessageIdFromChat,
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
  voiceChatFromTdChat,
  readTdVideoChat,
} from "./chatPreview.js";
import { previewSegmentsFromMessage } from "./formattedTextSegments.js";
import { emojiStatusCustomIdFromChat } from "./emojiStatus.js";
import {
  chatKindFromTdChat,
  lastMessageListRowMetaFromChat,
  lastMessageListRowMetaFromMessage,
  type MessageOutgoingStatus,
} from "./messageHistoryMap.js";
import { chatListTier, shouldIncludeChatInList, type ChatListTier } from "./chatListFilter.js";
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
  /** Private peer is a Telegram bot. */
  peer_is_bot?: boolean | null;
  presence_kind: ChatPresenceKind | null;
  presence_at: string | null;
  chat_action: ChatActionKind | null;
  chat_action_user_id: number | null;
  chat_action_user_name: string | null;
  chat_action_expires_at: string | null;
  last_read_outbox_message_id: number | null;
  last_read_inbox_message_id: number | null;
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
  last_message_telegram_id: number | null;
  last_message_sender_user_id: number | null;
  is_pinned: boolean;
  pin_order: string;
  list_tier: ChatListTier;
  /** True when TDLib reports an active voice/video chat on this chat. */
  has_active_voice_chat: boolean;
  /** TDLib `video_chat.group_call_id` when active; otherwise null. */
  voice_chat_group_call_id: number | null;
  /** True when this account is joined to the active voice chat. */
  voice_chat_is_joined?: boolean;
  /** Recent deleted message ids for open-chat UI removal (ephemeral). */
  pending_deleted_message_ids?: number[];
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

function tierRank(tier: ChatListTier): number {
  switch (tier) {
    case "pinned":
      return 0;
    case "positioned":
      return 1;
    case "unpositioned":
      return 2;
    default:
      return 3;
  }
}

function sortLiveChatRows(rows: LiveChatRow[]): LiveChatRow[] {
  return [...rows].sort((a, b) => {
    const tierDiff = tierRank(a.list_tier) - tierRank(b.list_tier);
    if (tierDiff !== 0) return tierDiff;
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.is_pinned && b.is_pinned) {
      const byPinOrder = comparePinOrderDesc(a.pin_order, b.pin_order);
      if (byPinOrder !== 0) return byPinOrder;
    }
    if (a.list_tier === "positioned" && b.list_tier === "positioned") {
      const byMainOrder = comparePinOrderDesc(a.pin_order, b.pin_order);
      if (byMainOrder !== 0) return byMainOrder;
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
const selfUserIds = new Map<string, number>();

export function setLiveChatSelfUserId(telegramUsername: string, userId: number | null): void {
  if (typeof userId === "number" && Number.isFinite(userId) && userId > 0) {
    selfUserIds.set(telegramUsername, userId);
    return;
  }
  selfUserIds.delete(telegramUsername);
}

export function getLiveChatSelfUserId(telegramUsername: string): number | null {
  const id = selfUserIds.get(telegramUsername);
  return typeof id === "number" && Number.isFinite(id) && id > 0 ? id : null;
}

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

/** Bump list revision so SSE clients refetch (e.g. after message deletes). */
export function bumpLiveChatRevision(telegramUsername: string): number {
  return bumpRevision(userCache(telegramUsername), telegramUsername);
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
  selfUserIds.delete(telegramUsername);
  clearLiveChatMessageDeletes(telegramUsername);
}

export function getLiveChatListRevision(telegramUsername: string): number {
  return caches.get(telegramUsername)?.revision ?? 0;
}

function attachPendingDeletes(telegramUsername: string, rows: LiveChatRow[]): LiveChatRow[] {
  return rows.map((row) => {
    const pending = peekLiveChatMessageDeletes(telegramUsername, row.telegram_chat_id);
    if (pending.length === 0) {
      if (!row.pending_deleted_message_ids?.length) return row;
      return { ...row, pending_deleted_message_ids: undefined };
    }
    return { ...row, pending_deleted_message_ids: pending };
  });
}

export function getLiveChatList(telegramUsername: string): LiveChatRow[] | null {
  const cache = caches.get(telegramUsername);
  if (!cache || cache.chats.size === 0) return null;
  if (cache.sortedList && cache.sortedListRevision === cache.revision) {
    return attachPendingDeletes(
      telegramUsername,
      cache.sortedList.map(expireChatActionIfStale),
    );
  }
  const sorted = sortLiveChatRows([...cache.chats.values()].map(expireChatActionIfStale));
  cache.sortedList = sorted;
  cache.sortedListRevision = cache.revision;
  return attachPendingDeletes(telegramUsername, sorted);
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

/** Drop tier-3 rows not in keepIds (viewport eviction). Pinned/positioned rows are always kept. */
export function pruneLiveChatRows(
  telegramUsername: string,
  keepUnpositionedIds: ReadonlySet<number>,
): number {
  const cache = caches.get(telegramUsername);
  if (!cache || cache.chats.size === 0) return cache?.revision ?? 0;
  let pruned = 0;
  for (const [chatId, row] of cache.chats) {
    if (row.list_tier !== "unpositioned") continue;
    if (keepUnpositionedIds.has(chatId)) continue;
    cache.chats.delete(chatId);
    pruned += 1;
  }
  if (pruned === 0) return cache.revision;
  return bumpRevision(cache, telegramUsername);
}

/** Merge rows into the live cache with a single revision bump (background paging). */
export function mergeLiveChatRows(
  telegramUsername: string,
  rows: Omit<LiveChatRow, "revision">[],
): number {
  const cache = userCache(telegramUsername);
  const filtered = rows.filter((row) => Number.isFinite(row.telegram_chat_id));
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
    peer_is_bot: existing?.peer_is_bot ?? null,
    presence_kind: existing?.presence_kind ?? null,
    presence_at: existing?.presence_at ?? null,
    chat_action: existing?.chat_action ?? null,
    chat_action_user_id: existing?.chat_action_user_id ?? null,
    chat_action_user_name: existing?.chat_action_user_name ?? null,
    chat_action_expires_at: existing?.chat_action_expires_at ?? null,
    last_read_outbox_message_id:
      lastReadOutboxMessageIdFromChat(chat) ?? existing?.last_read_outbox_message_id ?? null,
    last_read_inbox_message_id:
      lastReadInboxMessageIdFromChat(chat) ?? existing?.last_read_inbox_message_id ?? null,
    ...lastMessageListRowMetaFromChat(chat, getLiveChatSelfUserId(telegramUsername)),
      is_pinned: isChatPinnedInMainList(chat),
      pin_order: mainListOrderKey(chat),
      ...(() => {
        // Metadata never paints live (see voiceChatFromTdChat). Preserve a
        // previously verified live/joined flag for the same bound call across
        // getChat upserts (new messages, read inbox, …). Busy chats like Blox
        // Fruits otherwise cleared spectator rings on every updateNewMessage
        // because stillJoined-only kept live only when *we* were in the call.
        // Clearing inactive leftovers is updateChatVideoChat / updateGroupCall /
        // verifyAndPatchVideoChat — not every chat-row refresh.
        // Exception: explicit has_participants=false must clear live immediately
        // (stale getGroupCall counts otherwise keep rings after the call ended).
        const video = readTdVideoChat(chat);
        const voice = voiceChatFromTdChat(chat);
        const nextCallId = voice.voice_chat_group_call_id;
        if (nextCallId == null) {
          return {
            voice_chat_group_call_id: null,
            has_active_voice_chat: false,
            voice_chat_is_joined: false,
          };
        }
        if (video.has_participants === false) {
          // Do not immediately drop a verified live call. has_participants
          // lags false after we leave while others are still in the call
          // (in-chat Join preview vanished). Leftovers clear via
          // updateGroupCall / verifyAndPatchVideoChat.
          return {
            voice_chat_group_call_id: nextCallId,
            has_active_voice_chat: Boolean(existing?.has_active_voice_chat),
            voice_chat_is_joined: false,
          };
        }
        const sameBound =
          existing?.voice_chat_group_call_id != null &&
          nextCallId === existing.voice_chat_group_call_id;
        if (sameBound) {
          return {
            voice_chat_group_call_id: nextCallId,
            has_active_voice_chat: Boolean(existing?.has_active_voice_chat),
            voice_chat_is_joined: Boolean(existing?.voice_chat_is_joined),
          };
        }
        // New/changed call id — wait for verify before painting the ring.
        return {
          voice_chat_group_call_id: nextCallId,
          has_active_voice_chat: false,
          voice_chat_is_joined: false,
        };
      })(),
      list_tier: existing?.list_tier ?? chatListTier(chat),
    };
  return upsertLiveChatRow(telegramUsername, row);
}

/** Apply TDLib updateChatReadInbox without a full getChat round-trip. */
export function patchLiveChatReadInbox(
  telegramUsername: string,
  chatId: number,
  unreadCount: number,
  lastReadInboxMessageId?: number | null,
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(chatId);
  if (!existing) return null;
  const nextUnread = Math.max(0, Math.trunc(unreadCount));
  const nextLastReadInbox = (() => {
    const raw = Number(lastReadInboxMessageId);
    if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
    return existing.last_read_inbox_message_id ?? null;
  })();
  if (
    existing.unread_count === nextUnread &&
    existing.last_read_inbox_message_id === nextLastReadInbox
  ) {
    return existing;
  }
  return upsertLiveChatRow(telegramUsername, {
    telegram_chat_id: existing.telegram_chat_id,
    title: existing.title,
    subtitle: existing.subtitle,
    ...(existing.subtitle_segments ? { subtitle_segments: existing.subtitle_segments } : {}),
    avatar_url: existing.avatar_url,
    last_message_at: existing.last_message_at,
    unread_count: nextUnread,
    peer_user_id: existing.peer_user_id,
    peer_username: existing.peer_username ?? null,
    chat_username: existing.chat_username ?? null,
    chat_kind: existing.chat_kind ?? null,
    member_count: existing.member_count ?? null,
    peer_emoji_status_custom_emoji_id: existing.peer_emoji_status_custom_emoji_id ?? null,
    peer_accent_color_light: existing.peer_accent_color_light ?? null,
    peer_accent_color_dark: existing.peer_accent_color_dark ?? null,
    presence_kind: existing.presence_kind ?? null,
    presence_at: existing.presence_at ?? null,
    chat_action: existing.chat_action ?? null,
    chat_action_user_id: existing.chat_action_user_id ?? null,
    chat_action_user_name: existing.chat_action_user_name ?? null,
    chat_action_expires_at: existing.chat_action_expires_at ?? null,
    last_read_outbox_message_id: existing.last_read_outbox_message_id ?? null,
    last_read_inbox_message_id: nextLastReadInbox,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    last_message_telegram_id: existing.last_message_telegram_id,
    last_message_sender_user_id: existing.last_message_sender_user_id,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
    has_active_voice_chat: existing.has_active_voice_chat ?? false,
    voice_chat_group_call_id: existing.voice_chat_group_call_id ?? null,
    voice_chat_is_joined: existing.voice_chat_is_joined ?? false,
    list_tier: existing.list_tier,
  });
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
    last_read_inbox_message_id: existing.last_read_inbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    last_message_telegram_id: existing.last_message_telegram_id,
    last_message_sender_user_id: existing.last_message_sender_user_id,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
    has_active_voice_chat: existing.has_active_voice_chat ?? false,
    voice_chat_group_call_id: existing.voice_chat_group_call_id ?? null,
    voice_chat_is_joined: existing.voice_chat_is_joined ?? false,
    list_tier: existing.list_tier,
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
      last_read_inbox_message_id: row.last_read_inbox_message_id,
      last_message_is_outgoing: row.last_message_is_outgoing,
      last_message_outgoing_status: row.last_message_outgoing_status,
      last_message_telegram_id: row.last_message_telegram_id,
      last_message_sender_user_id: row.last_message_sender_user_id,
      is_pinned: row.is_pinned,
      pin_order: row.pin_order,
      has_active_voice_chat: row.has_active_voice_chat ?? false,
      voice_chat_group_call_id: row.voice_chat_group_call_id ?? null,
      voice_chat_is_joined: row.voice_chat_is_joined ?? false,
      list_tier: row.list_tier,
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
      last_read_inbox_message_id: row.last_read_inbox_message_id,
      last_message_is_outgoing: row.last_message_is_outgoing,
      last_message_outgoing_status: row.last_message_outgoing_status,
      last_message_telegram_id: row.last_message_telegram_id,
      last_message_sender_user_id: row.last_message_sender_user_id,
      is_pinned: row.is_pinned,
      pin_order: row.pin_order,
      has_active_voice_chat: row.has_active_voice_chat ?? false,
      voice_chat_group_call_id: row.voice_chat_group_call_id ?? null,
      voice_chat_is_joined: row.voice_chat_is_joined ?? false,
      list_tier: row.list_tier,
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
    last_read_inbox_message_id: existing.last_read_inbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    last_message_telegram_id: existing.last_message_telegram_id,
    last_message_sender_user_id: existing.last_message_sender_user_id,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
    has_active_voice_chat: existing.has_active_voice_chat ?? false,
    voice_chat_group_call_id: existing.voice_chat_group_call_id ?? null,
    voice_chat_is_joined: existing.voice_chat_is_joined ?? false,
    list_tier: existing.list_tier,
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
    last_read_inbox_message_id: existing?.last_read_inbox_message_id ?? null,
    ...lastMessageListRowMetaFromMessage(
      message,
      existing?.last_read_outbox_message_id ?? null,
      getLiveChatSelfUserId(telegramUsername),
    ),
    is_pinned: existing?.is_pinned ?? false,
    pin_order: existing?.pin_order ?? "0",
    has_active_voice_chat: existing?.has_active_voice_chat ?? false,
    voice_chat_group_call_id: existing?.voice_chat_group_call_id ?? null,
    voice_chat_is_joined: existing?.voice_chat_is_joined ?? false,
    list_tier: existing?.list_tier ?? "positioned",
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
    last_read_inbox_message_id: existing.last_read_inbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    last_message_telegram_id: existing.last_message_telegram_id,
    last_message_sender_user_id: existing.last_message_sender_user_id,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
    has_active_voice_chat: existing.has_active_voice_chat ?? false,
    voice_chat_group_call_id: existing.voice_chat_group_call_id ?? null,
    voice_chat_is_joined: existing.voice_chat_is_joined ?? false,
    list_tier: existing.list_tier,
  });
}

/** Apply TDLib `updateChatVideoChat` / refreshed `video_chat` without a full chat rebuild. */
export function patchLiveChatVideoChat(
  telegramUsername: string,
  chatId: number,
  input: {
    has_active_voice_chat: boolean;
    voice_chat_group_call_id: number | null;
    voice_chat_is_joined?: boolean;
  },
): LiveChatRow | null {
  const cache = caches.get(telegramUsername);
  if (!cache) return null;
  const existing = cache.chats.get(chatId);
  if (!existing) return null;
  const nextJoined = input.has_active_voice_chat
    ? Boolean(input.voice_chat_is_joined ?? existing.voice_chat_is_joined)
    : false;
  if (
    existing.has_active_voice_chat === input.has_active_voice_chat &&
    existing.voice_chat_group_call_id === input.voice_chat_group_call_id &&
    Boolean(existing.voice_chat_is_joined) === nextJoined
  ) {
    return existing;
  }
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
    chat_action: existing.chat_action,
    chat_action_user_id: existing.chat_action_user_id,
    chat_action_user_name: existing.chat_action_user_name,
    chat_action_expires_at: existing.chat_action_expires_at,
    last_read_outbox_message_id: existing.last_read_outbox_message_id,
    last_read_inbox_message_id: existing.last_read_inbox_message_id,
    last_message_is_outgoing: existing.last_message_is_outgoing,
    last_message_outgoing_status: existing.last_message_outgoing_status,
    last_message_telegram_id: existing.last_message_telegram_id,
    last_message_sender_user_id: existing.last_message_sender_user_id,
    is_pinned: existing.is_pinned,
    pin_order: existing.pin_order,
    has_active_voice_chat: input.has_active_voice_chat,
    voice_chat_group_call_id: input.voice_chat_group_call_id,
    voice_chat_is_joined: nextJoined,
    list_tier: existing.list_tier,
  });
}
