import fs from "fs";
import type { Client } from "tdl";
import { markTelegramMessagesConnected } from "../../database/telegramMessages.js";
import { touchMtprotoSync, upsertMtprotoSession } from "../../database/telegramMtproto.js";
import { TELEGRAM_THREAD_NO_AVATAR } from "../../shared/telegramThreadConstants.js";
import { getTdlibUserDir } from "./env.js";
import {
  chatTitle,
  chatUsernameFromChat,
  isChatPinnedInMainList,
  lastMessageAtIso,
  mainListOrderKey,
  normalizeUnreadCount,
  lastReadOutboxMessageIdFromChat,
  memberCountFromChat,
  isPrivateTdChat,
  peerUserIdFromChat,
  peerUsernameFromChat,
  presenceFromTdlibStatus,
  resolveLastMessagePreview,
  resolveLastMessagePreviewPayload,
  usernameFromTdUser,
  type TdChat,
} from "./chatPreview.js";
import {
  patchLiveChatEmojiStatus,
  patchLiveChatFromTdlib,
  patchLiveChatMemberMeta,
  seedLiveChatList,
  mergeLiveChatRows,
  getLiveChatList,
  setLiveChatSelfUserId,
  type LiveChatRow,
} from "./liveChatCache.js";
import { resolveMyUserId } from "./chatHistory.js";
import { logGateway } from "./gatewayLog.js";
import { emojiStatusCustomIdFromChat } from "./emojiStatus.js";
import { lastMessageListRowMetaFromChat } from "./messageHistoryMap.js";
import { userProfileFromTdUser } from "./tdUserProfile.js";
import {
  specialUserForceIncludedPeerUserIds,
  SUPPLEMENTARY_CONTACT_SEARCH_QUERIES,
} from "../../shared/specialTelegramUsers.js";
import { filterChatsForList } from "./chatListFilter.js";

type TdFile = {
  id?: number;
  local?: {
    path?: string;
    is_downloading_completed?: boolean;
    is_downloading_active?: boolean;
  };
};

const AVATAR_DOWNLOAD_TIMEOUT_MS = 15_000;
const AVATAR_SYNC_CONCURRENCY = 3;
const PREVIEW_SYNC_CONCURRENCY = 8;
const PRESENCE_SYNC_CONCURRENCY = 8;
const MEMBER_COUNT_SYNC_CONCURRENCY = 6;

/** First paint: only the top of {@link chatListMain} via TDLib `loadChats` / `getChats`. */
export const INITIAL_MAIN_CHAT_SYNC_LIMIT = 50;
/** Each deferred page after the initial snapshot. */
export const BACKGROUND_CHAT_SYNC_PAGE_SIZE = 35;
const BACKGROUND_CHAT_SYNC_PAGE_DELAY_MS = 2_500;
const BACKGROUND_CHAT_SYNC_START_DELAY_MS = 1_500;

export type SyncChatThreadsOptions = {
  /** Cap main-list chats (skips archive and full pagination when set). */
  maxMainChats?: number | null;
  includeArchive?: boolean;
  /** Contact/chat search supplements — expensive; off on the fast path. */
  includeSupplementarySearch?: boolean;
  /** Skip group member-count TDLib calls on the fast path. */
  skipMemberCounts?: boolean;
  /** Replace live cache (`seed`) vs merge pages (`mergeLiveChatRows`). */
  replaceCache?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadChatsFromList(
  client: Client,
  chatList: { _: "chatListMain" } | { _: "chatListArchive" },
  options?: { maxChats?: number },
): Promise<TdChat[]> {
  const maxChats = options?.maxChats;
  const collected = new Map<number, TdChat>();
  let offsetOrder = "9223372036854775807";
  let offsetChatId = 0;
  let warmedUp = false;
  const pageSize = maxChats != null ? Math.min(100, Math.max(maxChats, 20)) : 100;

  for (let round = 0; round < 80; round++) {
    if (maxChats != null && collected.size >= maxChats) break;

    let list: { chat_ids?: number[] };
    try {
      list = (await client.invoke({
        _: "getChats",
        chat_list: chatList,
        offset_order: offsetOrder,
        offset_chat_id: offsetChatId,
        limit: maxChats != null ? Math.min(pageSize, maxChats - collected.size) : pageSize,
      })) as { chat_ids?: number[] };
    } catch {
      break;
    }

    const ids = list.chat_ids ?? [];
    if (ids.length === 0) {
      if (warmedUp) break;
      warmedUp = true;
      try {
        const loadLimit =
          maxChats != null ? Math.min(pageSize, maxChats) : 100;
        await client.invoke({ _: "loadChats", chat_list: chatList, limit: loadLimit });
      } catch {
        break;
      }
      await sleep(400);
      continue;
    }

    for (const chatId of ids) {
      if (maxChats != null && collected.size >= maxChats) break;
      if (collected.has(chatId)) continue;
      try {
        const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
        collected.set(chatId, chat);
      } catch {
        /* skip unreadable chat */
      }
    }

    if (maxChats != null && collected.size >= maxChats) break;
    if (ids.length < pageSize) break;
    const lastChat = [...ids]
      .reverse()
      .map((chatId) => collected.get(chatId))
      .find((chat): chat is TdChat => Boolean(chat));
    if (!lastChat) break;
    const nextOffsetOrder = mainListOrderKey(lastChat);
    if (!nextOffsetOrder || nextOffsetOrder === "0") break;
    if (nextOffsetOrder === offsetOrder && lastChat.id === offsetChatId) break;
    offsetOrder = nextOffsetOrder;
    offsetChatId = lastChat.id;
  }

  return [...collected.values()];
}

async function openPrivateChatsForUserIds(client: Client, userIds: number[]): Promise<TdChat[]> {
  const chats: TdChat[] = [];
  for (const userId of userIds) {
    if (!Number.isFinite(userId) || userId <= 0) continue;
    try {
      const chat = (await client.invoke({
        _: "createPrivateChat",
        user_id: userId,
        force: true,
      })) as TdChat;
      chats.push(chat);
    } catch {
      /* chat may be unavailable */
    }
  }
  return chats;
}

async function discoverPrivateChatsByContactSearch(
  client: Client,
  queries: readonly string[],
): Promise<TdChat[]> {
  const userIds = new Set<number>();
  for (const query of queries) {
    const trimmed = query.trim();
    if (!trimmed) continue;
    try {
      const result = (await client.invoke({
        _: "searchContacts",
        query: trimmed,
        limit: 30,
      })) as { user_ids?: number[] };
      for (const userId of result.user_ids ?? []) {
        if (Number.isFinite(userId) && userId > 0) userIds.add(userId);
      }
    } catch {
      /* skip failed query */
    }
  }
  return openPrivateChatsForUserIds(client, [...userIds]);
}

async function discoverPrivateChatsByChatSearch(
  client: Client,
  queries: readonly string[],
): Promise<TdChat[]> {
  const collected = new Map<number, TdChat>();
  for (const query of queries) {
    const trimmed = query.trim();
    if (!trimmed) continue;
    for (const chatList of [{ _: "chatListMain" as const }, { _: "chatListArchive" as const }]) {
      try {
        const result = (await client.invoke({
          _: "searchChats",
          chat_list: chatList,
          query: trimmed,
          limit: 20,
        })) as { chat_ids?: number[] };
        for (const chatId of result.chat_ids ?? []) {
          if (collected.has(chatId)) continue;
          try {
            const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
            collected.set(chatId, chat);
          } catch {
            /* skip unreadable chat */
          }
        }
      } catch {
        /* skip failed search */
      }
    }
  }
  return [...collected.values()];
}

async function loadForcedPrivateChats(client: Client): Promise<TdChat[]> {
  return openPrivateChatsForUserIds(client, specialUserForceIncludedPeerUserIds());
}

async function loadSupplementaryPrivateChats(client: Client): Promise<TdChat[]> {
  const merged = new Map<number, TdChat>();

  for (const chat of await loadForcedPrivateChats(client)) {
    merged.set(chat.id, chat);
  }

  for (const chat of await discoverPrivateChatsByContactSearch(client, SUPPLEMENTARY_CONTACT_SEARCH_QUERIES)) {
    merged.set(chat.id, chat);
  }

  return [...merged.values()];
}

type LoadAllChatsOptions = {
  maxMainChats?: number | null;
  includeArchive?: boolean;
  includeSupplementarySearch?: boolean;
};

async function loadAllChats(client: Client, options?: LoadAllChatsOptions): Promise<TdChat[]> {
  const collected = new Map<number, TdChat>();
  const merge = (chats: TdChat[]) => {
    for (const chat of chats) collected.set(chat.id, chat);
  };

  merge(
    await loadChatsFromList(
      client,
      { _: "chatListMain" },
      options?.maxMainChats != null ? { maxChats: options.maxMainChats } : undefined,
    ),
  );

  if (options?.includeArchive !== false && options?.maxMainChats == null) {
    merge(await loadChatsFromList(client, { _: "chatListArchive" }));
  }

  if (options?.includeSupplementarySearch === false) {
    merge(await loadForcedPrivateChats(client));
  } else {
    merge(await loadSupplementaryPrivateChats(client));
  }

  const allowSupplementaryPrivate = options?.includeSupplementarySearch !== false;
  return filterChatsForList([...collected.values()], { allowSupplementaryPrivate });
}

function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function waitForLocalFile(client: Client, fileId: number): Promise<TdFile | null> {
  const deadline = Date.now() + AVATAR_DOWNLOAD_TIMEOUT_MS;
  let syncAttempted = false;

  while (Date.now() < deadline) {
    try {
      const file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
      if (file.local?.is_downloading_completed && file.local.path) return file;

      if (!file.local?.is_downloading_active && !file.local?.is_downloading_completed) {
        await client.invoke({
          _: "downloadFile",
          file_id: fileId,
          priority: 16,
          offset: 0,
          limit: 0,
          synchronous: syncAttempted,
        });
        syncAttempted = true;
        const refreshed = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
        if (refreshed.local?.is_downloading_completed && refreshed.local.path) return refreshed;
      }
    } catch {
      /* keep polling */
    }
    await sleep(150);
  }
  return null;
}

async function downloadChatAvatarBytes(
  client: Client,
  chat: TdChat,
): Promise<{ data: Buffer; mime: string } | typeof TELEGRAM_THREAD_NO_AVATAR | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let current = chat;
    if (attempt > 0) {
      try {
        current = (await client.invoke({ _: "getChat", chat_id: chat.id })) as TdChat;
        await sleep(250 * attempt);
      } catch {
        continue;
      }
    }

    const fileIds = [current.photo?.small?.id, current.photo?.big?.id].filter(
      (id): id is number => typeof id === "number",
    );
    if (fileIds.length === 0) return TELEGRAM_THREAD_NO_AVATAR;

    for (const fileId of fileIds) {
      try {
        let file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
        const useSync = attempt >= 1;
        if (!file?.local?.is_downloading_completed || !file.local.path) {
          await client.invoke({
            _: "downloadFile",
            file_id: fileId,
            priority: 16,
            offset: 0,
            limit: 0,
            synchronous: useSync,
          });
          if (!useSync) {
            file = (await waitForLocalFile(client, fileId)) ?? undefined;
          } else {
            file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
          }
        }
        const filePath = file?.local?.path;
        if (!filePath) continue;
        const buf = await fs.promises.readFile(filePath);
        if (buf.length === 0) continue;
        return { data: buf, mime: mimeFromPath(filePath) };
      } catch {
        /* try next size / attempt */
      }
    }
  }
  return null;
}

async function resolveChatAvatarUrl(client: Client, chat: TdChat): Promise<string | null> {
  const result = await downloadChatAvatarBytes(client, chat);
  if (result === TELEGRAM_THREAD_NO_AVATAR) return TELEGRAM_THREAD_NO_AVATAR;
  if (!result) return null;
  return `data:${result.mime};base64,${result.data.toString("base64")}`;
}

export async function readChatAvatarBytes(
  client: Client,
  chatId: number,
): Promise<{ data: Buffer; mime: string } | typeof TELEGRAM_THREAD_NO_AVATAR | null> {
  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    return downloadChatAvatarBytes(client, chat);
  } catch {
    return null;
  }
}

type TdUserProfile = {
  profile_photo?: { small?: { id?: number }; big?: { id?: number } };
};

function profilePhotoFileIds(user: TdUserProfile): number[] {
  return [user.profile_photo?.small?.id, user.profile_photo?.big?.id].filter(
    (id): id is number => typeof id === "number" && id > 0,
  );
}

export async function readUserAvatarBytes(
  client: Client,
  userId: number,
): Promise<{ data: Buffer; mime: string } | typeof TELEGRAM_THREAD_NO_AVATAR | null> {
  try {
    const user = (await client.invoke({ _: "getUser", user_id: userId })) as TdUserProfile;
    const fileIds = profilePhotoFileIds(user);
    if (fileIds.length === 0) return TELEGRAM_THREAD_NO_AVATAR;

    for (const fileId of fileIds) {
      try {
        let file = (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
        if (!file?.local?.is_downloading_completed || !file.local.path) {
          await client.invoke({
            _: "downloadFile",
            file_id: fileId,
            priority: 16,
            offset: 0,
            limit: 0,
            synchronous: true,
          });
          file = (await waitForLocalFile(client, fileId)) ?? (await client.invoke({ _: "getFile", file_id: fileId })) as TdFile;
        }
        const filePath = file?.local?.path;
        if (!filePath) continue;
        const buf = await fs.promises.readFile(filePath);
        if (buf.length === 0) continue;
        return { data: buf, mime: mimeFromPath(filePath) };
      } catch {
        /* try next size */
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function persistMtprotoConnection(
  client: Client,
  telegramUsername: string,
): Promise<void> {
  let telegramUserId: number | null = null;
  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    if (typeof me.id === "number") telegramUserId = me.id;
  } catch {
    /* ignore */
  }

  const dbPath = getTdlibUserDir(telegramUsername);
  await upsertMtprotoSession({
    telegramUsername,
    telegramUserId,
    tdlibDbPath: dbPath,
    status: "active",
  });
  await markTelegramMessagesConnected(telegramUsername);
}

export async function refreshLiveChatFromTdlib(
  client: Client,
  telegramUsername: string,
  chatId: number,
): Promise<void> {
  const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  const { subtitle, subtitleSegments } = await resolveLastMessagePreviewPayload(client, chat);
  const avatarUrl = await resolveChatAvatarUrl(client, chat);
  patchLiveChatFromTdlib(telegramUsername, chat, {
    subtitle,
    subtitle_segments: subtitleSegments,
    avatar_url: avatarUrl,
    last_message: chat.last_message ?? null,
  });
}

export async function refreshLiveChats(
  client: Client,
  telegramUsername: string,
  chatIds: number[],
): Promise<number> {
  let refreshed = 0;
  for (const chatId of chatIds) {
    try {
      await refreshLiveChatFromTdlib(client, telegramUsername, chatId);
      refreshed += 1;
    } catch {
      /* skip unreadable chat */
    }
  }
  if (refreshed > 0) await touchMtprotoSync(telegramUsername);
  return refreshed;
}

async function enrichChatRow(
  client: Client,
  chat: TdChat,
  subtitle: string | null,
  avatarUrl: string | null,
): Promise<{ subtitle: string | null; avatarUrl: string | null }> {
  let nextSubtitle = subtitle;
  let nextAvatar = avatarUrl;
  if (!nextSubtitle) {
    nextSubtitle = await resolveLastMessagePreview(client, chat);
  }
  if (!nextAvatar) {
    nextAvatar = await resolveChatAvatarUrl(client, chat);
  }
  return { subtitle: nextSubtitle, avatarUrl: nextAvatar };
}

function resolveChatEmojiStatusCustomId(
  chat: TdChat,
  peerEmojiStatusId: string | null,
): string | null {
  if (isPrivateTdChat(chat)) return peerEmojiStatusId;
  return emojiStatusCustomIdFromChat(chat) ?? peerEmojiStatusId;
}

async function resolvePeerProfile(
  client: Client,
  chat: TdChat,
): Promise<{
  presence: { kind: LiveChatRow["presence_kind"]; at: string | null } | null;
  emojiStatusCustomEmojiId: string | null;
  username: string | null;
  accentColorLight: string | null;
  accentColorDark: string | null;
}> {
  const peerUserId = peerUserIdFromChat(chat);
  if (peerUserId == null) {
    return {
      presence: null,
      emojiStatusCustomEmojiId: null,
      username: null,
      accentColorLight: null,
      accentColorDark: null,
    };
  }
  try {
    const user = (await client.invoke({ _: "getUser", user_id: peerUserId })) as {
      status?: unknown;
      emoji_status?: unknown;
      username?: string;
      usernames?: { active_usernames?: string[]; editable_username?: string };
    };
    const profile = userProfileFromTdUser(user);
    return {
      presence: presenceFromTdlibStatus(user.status),
      emojiStatusCustomEmojiId: profile.emoji_status_custom_emoji_id,
      username: usernameFromTdUser(user),
      accentColorLight: profile.accent_color_light,
      accentColorDark: profile.accent_color_dark,
    };
  } catch {
    return {
      presence: null,
      emojiStatusCustomEmojiId: null,
      username: null,
      accentColorLight: null,
      accentColorDark: null,
    };
  }
}

/** Backfill peer emoji statuses for private chats missing them in the live cache. */
export async function refreshPeerEmojiStatus(
  client: Client,
  telegramUsername: string,
  peerUserId: number,
): Promise<boolean> {
  try {
    const user = (await client.invoke({ _: "getUser", user_id: peerUserId })) as unknown;
    const profile = userProfileFromTdUser(user);
    patchLiveChatEmojiStatus(
      telegramUsername,
      peerUserId,
      profile.emoji_status_custom_emoji_id,
      profile.accent_color_light,
      profile.accent_color_dark,
    );
    return true;
  } catch {
    return false;
  }
}

/** Backfill peer emoji statuses for private chats missing them in the live cache. */
export async function refreshMissingPeerEmojiStatuses(
  client: Client,
  telegramUsername: string,
  maxPeers = 24,
): Promise<number> {
  const rows = getLiveChatList(telegramUsername);
  if (!rows?.length) return 0;

  let refreshed = 0;
  for (const row of rows) {
    if (refreshed >= maxPeers) break;
    const peerUserId = row.peer_user_id;
    if (peerUserId == null) continue;
    try {
      const user = (await client.invoke({ _: "getUser", user_id: peerUserId })) as unknown;
      const profile = userProfileFromTdUser(user);
      patchLiveChatEmojiStatus(
        telegramUsername,
        peerUserId,
        profile.emoji_status_custom_emoji_id,
        profile.accent_color_light,
        profile.accent_color_dark,
      );
      refreshed += 1;
    } catch {
      /* per-peer fetch may fail for deleted users */
    }
  }
  return refreshed;
}

/** Backfill member counts for group / channel rows missing them in the live cache. */
export async function refreshMissingMemberCounts(
  client: Client,
  telegramUsername: string,
  maxChats = 32,
): Promise<number> {
  const rows = getLiveChatList(telegramUsername);
  if (!rows?.length) return 0;

  let refreshed = 0;
  for (const row of rows) {
    if (refreshed >= maxChats) break;
    const kind = row.chat_kind;
    const isPrivate =
      kind === "private" || (kind == null && row.peer_user_id != null);
    if (isPrivate) continue;
    if (row.member_count != null && row.member_count > 0 && kind != null) continue;
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: row.telegram_chat_id })) as TdChat;
      const chatKind = chatKindFromTdChat(chat);
      const count = await memberCountFromChat(client, chat);
      patchLiveChatMemberMeta(telegramUsername, row.telegram_chat_id, {
        member_count: count,
        chat_kind: chatKind,
      });
      refreshed += 1;
    } catch {
      /* per-chat fetch may fail for deleted chats */
    }
  }
  return refreshed;
}

export async function syncChatThreads(
  client: Client,
  telegramUsername: string,
  options?: SyncChatThreadsOptions,
): Promise<number> {
  setLiveChatSelfUserId(telegramUsername, await resolveMyUserId(client));
  const chats = await loadAllChats(client, {
    maxMainChats: options?.maxMainChats ?? null,
    includeArchive: options?.includeArchive,
    includeSupplementarySearch: options?.includeSupplementarySearch,
  });

  const liveRows = await buildLiveRowsForChats(client, chats, {
    skipMemberCounts: options?.skipMemberCounts === true,
  });

  if (options?.replaceCache === false) {
    mergeLiveChatRows(telegramUsername, liveRows);
  } else {
    seedLiveChatList(telegramUsername, liveRows);
  }
  await touchMtprotoSync(telegramUsername);

  logGateway("sync_chat_threads_done", {
    telegramUsername,
    chatCount: chats.length,
    rowCount: liveRows.length,
    maxMainChats: options?.maxMainChats ?? null,
    includeArchive: options?.includeArchive !== false,
    replaceCache: options?.replaceCache !== false,
  });

  return chats.length;
}

async function buildLiveRowsForChats(
  client: Client,
  chats: TdChat[],
  options?: { skipMemberCounts?: boolean },
): Promise<Omit<LiveChatRow, "revision">[]> {
  if (chats.length === 0) return [];

  const myUserId = await resolveMyUserId(client);

  let previewPayloads = await mapWithConcurrency(chats, PREVIEW_SYNC_CONCURRENCY, (chat) =>
    resolveLastMessagePreviewPayload(client, chat),
  );
  let avatarUrls = await mapWithConcurrency(chats, AVATAR_SYNC_CONCURRENCY, (chat) =>
    resolveChatAvatarUrl(client, chat),
  );
  let presences = await mapWithConcurrency(chats, PRESENCE_SYNC_CONCURRENCY, (chat) =>
    resolvePeerProfile(client, chat),
  );
  let memberCounts = options?.skipMemberCounts
    ? chats.map(() => null as number | null)
    : await mapWithConcurrency(chats, MEMBER_COUNT_SYNC_CONCURRENCY, (chat) =>
        memberCountFromChat(client, chat),
      );

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < chats.length; i++) {
      if (previewPayloads[i]?.subtitle && avatarUrls[i]) continue;
      if (!previewPayloads[i]?.subtitle) {
        previewPayloads[i] = await resolveLastMessagePreviewPayload(client, chats[i]);
      }
      if (!avatarUrls[i]) {
        avatarUrls[i] = await resolveChatAvatarUrl(client, chats[i]);
      }
    }
  }

  const liveRows: Omit<LiveChatRow, "revision">[] = [];
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    const profile = presences[i];
    const preview = previewPayloads[i];
    const subtitleSegments = preview?.subtitleSegments ?? null;
    liveRows.push({
      telegram_chat_id: chat.id,
      title: chatTitle(chat),
      subtitle: preview?.subtitle ?? "",
      ...(subtitleSegments ? { subtitle_segments: subtitleSegments } : {}),
      avatar_url: avatarUrls[i] ?? null,
      last_message_at: lastMessageAtIso(chat),
      unread_count: normalizeUnreadCount(chat),
      peer_user_id: peerUserIdFromChat(chat),
      peer_username: profile?.username ?? peerUsernameFromChat(chat),
      chat_username: chatUsernameFromChat(chat),
      chat_kind: chatKindFromTdChat(chat),
      member_count: memberCounts[i] ?? null,
      peer_emoji_status_custom_emoji_id: resolveChatEmojiStatusCustomId(
        chat,
        profile?.emojiStatusCustomEmojiId ?? null,
      ),
      peer_accent_color_light: profile?.accentColorLight ?? null,
      peer_accent_color_dark: profile?.accentColorDark ?? null,
      presence_kind: profile?.presence?.kind ?? null,
      presence_at: profile?.presence?.at ?? null,
      chat_action: null,
      chat_action_user_id: null,
      chat_action_user_name: null,
      chat_action_expires_at: null,
      last_read_outbox_message_id: lastReadOutboxMessageIdFromChat(chat),
      ...lastMessageListRowMetaFromChat(chat, myUserId),
      is_pinned: isChatPinnedInMainList(chat),
      pin_order: mainListOrderKey(chat),
    });
  }
  return liveRows;
}

const backgroundSyncInflight = new Set<string>();

/** Load archive + remaining main-list chats in small TDLib pages (non-blocking). */
export async function syncRemainingChatsInBackground(
  client: Client,
  telegramUsername: string,
): Promise<number> {
  await sleep(BACKGROUND_CHAT_SYNC_START_DELAY_MS);

  const cachedIds = new Set(
    (getLiveChatList(telegramUsername) ?? []).map((row) => row.telegram_chat_id),
  );

  logGateway("sync_chat_background_start", {
    telegramUsername,
    cachedCount: cachedIds.size,
    pageSize: BACKGROUND_CHAT_SYNC_PAGE_SIZE,
  });

  let merged = 0;

  const syncChatList = async (
    chatList: { _: "chatListMain" } | { _: "chatListArchive" },
  ): Promise<void> => {
    let offsetOrder = "9223372036854775807";
    let offsetChatId = 0;
    let warmedUp = false;

    for (let round = 0; round < 80; round++) {
      let list: { chat_ids?: number[] };
      try {
        list = (await client.invoke({
          _: "getChats",
          chat_list: chatList,
          offset_order: offsetOrder,
          offset_chat_id: offsetChatId,
          limit: 100,
        })) as { chat_ids?: number[] };
      } catch {
        break;
      }

      const rawIds = list.chat_ids ?? [];
      const ids = rawIds.filter((id) => !cachedIds.has(id));
      if (rawIds.length === 0) {
        if (warmedUp) break;
        warmedUp = true;
        try {
          await client.invoke({ _: "loadChats", chat_list: chatList, limit: 100 });
        } catch {
          break;
        }
        await sleep(400);
        continue;
      }

      const pageChats: TdChat[] = [];
      for (const chatId of ids) {
        try {
          const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
          if (!filterChatsForList([chat]).length) continue;
          pageChats.push(chat);
          cachedIds.add(chatId);
        } catch {
          /* skip */
        }
      }

      for (let offset = 0; offset < pageChats.length; offset += BACKGROUND_CHAT_SYNC_PAGE_SIZE) {
        const slice = pageChats.slice(offset, offset + BACKGROUND_CHAT_SYNC_PAGE_SIZE);
        if (slice.length === 0) continue;
        const rows = await buildLiveRowsForChats(client, slice);
        mergeLiveChatRows(telegramUsername, rows);
        merged += rows.length;
        if (offset + BACKGROUND_CHAT_SYNC_PAGE_SIZE < pageChats.length) {
          await sleep(BACKGROUND_CHAT_SYNC_PAGE_DELAY_MS);
        }
      }

      if (rawIds.length < 100) break;
      const lastId = rawIds[rawIds.length - 1];
      let anchor: TdChat | null = pageChats.find((c) => c.id === lastId) ?? null;
      if (!anchor && lastId != null) {
        try {
          anchor = (await client.invoke({ _: "getChat", chat_id: lastId })) as TdChat;
        } catch {
          anchor = null;
        }
      }
      if (!anchor) break;
      const nextOffsetOrder = mainListOrderKey(anchor);
      if (!nextOffsetOrder || nextOffsetOrder === "0") break;
      if (nextOffsetOrder === offsetOrder && anchor.id === offsetChatId) break;
      offsetOrder = nextOffsetOrder;
      offsetChatId = anchor.id;

      if (pageChats.length > 0) {
        await sleep(BACKGROUND_CHAT_SYNC_PAGE_DELAY_MS);
      }
    }
  };

  await syncChatList({ _: "chatListMain" });

  await touchMtprotoSync(telegramUsername);
  logGateway("sync_chat_background_done", {
    telegramUsername,
    mergedCount: merged,
    totalCached: getLiveChatList(telegramUsername)?.length ?? 0,
  });
  return merged;
}

export function isBackgroundChatSyncInProgress(telegramUsername: string): boolean {
  return backgroundSyncInflight.has(telegramUsername);
}

export function scheduleBackgroundChatSync(client: Client, telegramUsername: string): void {
  if (backgroundSyncInflight.has(telegramUsername)) return;
  backgroundSyncInflight.add(telegramUsername);
  void (async () => {
    try {
      await syncRemainingChatsInBackground(client, telegramUsername);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logGateway("sync_chat_background_error", { telegramUsername, message });
    } finally {
      backgroundSyncInflight.delete(telegramUsername);
    }
  })();
}

export async function syncChatsFromTdlib(
  client: Client,
  telegramUsername: string,
): Promise<number> {
  await persistMtprotoConnection(client, telegramUsername);
  const count = await syncChatThreads(client, telegramUsername, {
    maxMainChats: INITIAL_MAIN_CHAT_SYNC_LIMIT,
    includeArchive: false,
    includeSupplementarySearch: false,
    skipMemberCounts: true,
    replaceCache: true,
  });
  return count;
}
