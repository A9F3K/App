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
  chatListOrderKey,
  normalizeUnreadCount,
  lastReadOutboxMessageIdFromChat,
  lastReadInboxMessageIdFromChat,
  memberCountFromChat,
  isPrivateTdChat,
  peerUserIdFromChat,
  peerUsernameFromChat,
  presenceFromTdlibStatus,
  resolveLastMessagePreview,
  resolveLastMessagePreviewPayload,
  usernameFromTdUser,
  type TdChat,
  type TdChatListRef,
  voiceChatFromTdChat,
} from "./chatPreview.js";
import { getChatFolderIds } from "./chatFolderCache.js";
import { verifyGroupCallLiveState } from "./voiceParticipants.js";
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
import { filterChatsForList, chatListTier, type ChatListTier } from "./chatListFilter.js";
import {
  markBackgroundChatSyncEnd,
  markBackgroundChatSyncStart,
  markTier3ChatSyncEnd,
  markTier3ChatSyncStart,
  resetChatListSyncMeta,
  resetTier3ListCursor,
  setPositionedComplete,
  setTier3Available,
  getTier3ListCursor,
  isPositionedComplete,
  isTier3Available,
} from "./chatListSyncState.js";
import { userProfileFromTdUser } from "./tdUserProfile.js";
import {
  specialUserForceIncludedPeerUserIds,
  SUPPLEMENTARY_CONTACT_SEARCH_QUERIES,
} from "../../shared/specialTelegramUsers.js";
import { chatKindFromTdChat, lastMessageListRowMetaFromChat } from "./messageHistoryMap.js";
import { resolveUserChatPhoto } from "./chatPhoto.js";
import { listPhotoSizeCandidates } from "./photoParse.js";

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

/** First paint: positioned main-list chats after all pins. */
export const INITIAL_POSITIONED_SYNC_LIMIT = 2000;
/** @deprecated Use INITIAL_POSITIONED_SYNC_LIMIT — kept for client constant parity. */
export const INITIAL_MAIN_CHAT_SYNC_LIMIT = INITIAL_POSITIONED_SYNC_LIMIT;
/** Each deferred page after the initial snapshot. */
export const BACKGROUND_CHAT_SYNC_PAGE_SIZE = 80;
/** Unpositioned supplementary chats per on-demand batch. */
export const TIER3_CHAT_SYNC_BATCH_SIZE = 40;
/** Keep background pages snappy — 2.5s gaps made ~300 chats feel "lazy". */
const BACKGROUND_CHAT_SYNC_PAGE_DELAY_MS = 200;
const BACKGROUND_CHAT_SYNC_START_DELAY_MS = 100;

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

function isTdlibListExhaustedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = Number((err as { code?: unknown }).code);
  if (code === 404) return true;
  const message = String((err as { message?: unknown }).message ?? err);
  // TDLib loadChats completion is specifically HTTP-style 404.
  return /\b404\b/.test(message);
}

/**
 * TDLib contract: keep calling loadChats until it returns 404 (list fully known).
 * Without this, getChats pagination stops early (~150–255) on slim/no chat DB.
 */
async function loadChatsUntilExhausted(
  client: Client,
  chatList: TdChatListRef,
  options?: { maxRounds?: number; limit?: number },
): Promise<{ exhausted: boolean; rounds: number }> {
  const maxRounds = options?.maxRounds ?? 500;
  const limit = options?.limit ?? 100;
  for (let round = 0; round < maxRounds; round += 1) {
    try {
      await client.invoke({ _: "loadChats", chat_list: chatList, limit });
      // Brief yield so position updates land before the next load/getChats.
      await sleep(25);
    } catch (err) {
      if (isTdlibListExhaustedError(err)) {
        return { exhausted: true, rounds: round };
      }
      logGateway("load_chats_until_exhausted_error", {
        chatList,
        round,
        message: err instanceof Error ? err.message : String(err),
      });
      return { exhausted: false, rounds: round };
    }
  }
  return { exhausted: false, rounds: maxRounds };
}

async function resolveChatFolderIdsForSync(
  client: Client,
  telegramUsername?: string,
): Promise<number[]> {
  if (telegramUsername) {
    const cached = getChatFolderIds(telegramUsername);
    if (cached.length > 0) return cached;
  }
  // Fallback when updateChatFolders was missed: probe common folder ids.
  const found: number[] = [];
  for (let id = 1; id <= 40; id += 1) {
    try {
      await client.invoke({ _: "getChatFolder", chat_folder_id: id });
      found.push(id);
    } catch {
      /* invalid / inaccessible folder */
    }
  }
  return found;
}

/** Re-fetch chat until TDLib populates `positions` (or retries exhaust). */
export async function hydrateChatPositions(
  client: Client,
  chatId: number,
  retries = 4,
): Promise<TdChat | null> {
  let last: TdChat | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      last = chat;
      const positions = chat.positions;
      if (Array.isArray(positions) && positions.length > 0) {
        const hasUsableOrder = positions.some(
          (row) => typeof row.order === "string" && row.order !== "0",
        );
        if (hasUsableOrder) return chat;
      }
      if (attempt < retries) await sleep(150 + attempt * 100);
    } catch {
      return last;
    }
  }
  return last;
}

/**
 * Pick a getChats pagination anchor from the end of a page.
 * Never use order "0" — that used to stop sync at ~150 chats.
 */
async function findChatListPageAnchor(
  client: Client,
  chatIds: number[],
  chatList: TdChatListRef,
  known?: Map<number, TdChat> | TdChat[],
): Promise<{ order: string; chatId: number } | null> {
  const byId = new Map<number, TdChat>();
  if (Array.isArray(known)) {
    for (const chat of known) byId.set(chat.id, chat);
  } else if (known) {
    for (const [id, chat] of known) byId.set(id, chat);
  }

  for (let i = chatIds.length - 1; i >= 0; i -= 1) {
    const chatId = chatIds[i];
    if (chatId == null) continue;
    let chat = byId.get(chatId) ?? null;
    if (!chat) {
      chat = await hydrateChatPositions(client, chatId);
    }
    if (!chat) continue;
    const order = chatListOrderKey(chat, chatList);
    if (order && order !== "0") {
      return { order, chatId: chat.id };
    }
  }
  return null;
}

const GET_CHATS_FULL_LIMIT = 20_000;

async function getChatsSnapshot(
  client: Client,
  chatList: TdChatListRef,
  limit: number,
): Promise<{ chatIds: number[]; totalCount: number }> {
  try {
    // TDLib 1.7.7+: getChats only accepts chat_list + limit (no offset pagination).
    const list = (await client.invoke({
      _: "getChats",
      chat_list: chatList,
      limit: Math.max(1, Math.min(limit, GET_CHATS_FULL_LIMIT)),
    })) as { chat_ids?: number[]; total_count?: number };
    const chatIds = list.chat_ids ?? [];
    const totalCount =
      typeof list.total_count === "number" && Number.isFinite(list.total_count)
        ? list.total_count
        : chatIds.length;
    return { chatIds, totalCount };
  } catch {
    return { chatIds: [], totalCount: 0 };
  }
}

async function hydrateChatsByIds(
  client: Client,
  chatIds: number[],
  options?: { maxChats?: number },
): Promise<TdChat[]> {
  const maxChats = options?.maxChats;
  const ids =
    maxChats != null ? chatIds.slice(0, Math.max(maxChats * 2, maxChats)) : chatIds;
  const hydrated = await mapWithConcurrency(ids, PREVIEW_SYNC_CONCURRENCY, async (chatId) => {
    try {
      return await hydrateChatPositions(client, chatId);
    } catch {
      return null;
    }
  });
  const result: TdChat[] = [];
  const seen = new Set<number>();
  for (const chat of hydrated) {
    if (!chat || seen.has(chat.id)) continue;
    seen.add(chat.id);
    result.push(chat);
    if (maxChats != null && result.length >= maxChats) break;
  }
  return result;
}

async function loadPinnedAndPositionedChats(
  client: Client,
  maxPositioned: number,
): Promise<{ chats: TdChat[]; positionedComplete: boolean }> {
  const chatList = { _: "chatListMain" } as const;
  // Load enough into TDLib memory, then snapshot from the start (no offsets).
  for (let round = 0; round < 80; round += 1) {
    const snap = await getChatsSnapshot(client, chatList, maxPositioned + 100);
    let positionedCount = 0;
    for (const chatId of snap.chatIds) {
      try {
        const chat = await hydrateChatPositions(client, chatId);
        if (chat && !isChatPinnedInMainList(chat)) positionedCount += 1;
      } catch {
        /* ignore */
      }
    }
    if (positionedCount >= maxPositioned) break;
    try {
      await client.invoke({ _: "loadChats", chat_list: chatList, limit: 100 });
      await sleep(40);
    } catch (err) {
      if (isTdlibListExhaustedError(err)) {
        const chats = await hydrateChatsByIds(client, snap.chatIds, {
          maxChats: maxPositioned + 50,
        });
        return { chats, positionedComplete: true };
      }
      break;
    }
  }

  const finalSnap = await getChatsSnapshot(client, chatList, maxPositioned + 100);
  const chats = await hydrateChatsByIds(client, finalSnap.chatIds);
  const positioned = chats.filter((c) => !isChatPinnedInMainList(c));
  const positionedComplete = positioned.length >= maxPositioned;
  // Keep pins + first N positioned.
  const pins = chats.filter((c) => isChatPinnedInMainList(c));
  const rest = positioned.slice(0, maxPositioned);
  const byId = new Map<number, TdChat>();
  for (const chat of [...pins, ...rest]) byId.set(chat.id, chat);
  return { chats: [...byId.values()], positionedComplete };
}

/**
 * TDLib 1.7.7+: loadChats until 404, then getChats(limit) from the start.
 * offset_order / offset_chat_id were removed — old pagination always re-fetched page 1.
 */
async function loadChatsFromList(
  client: Client,
  chatList: TdChatListRef,
  options?: { maxChats?: number; skipExhaust?: boolean },
): Promise<TdChat[]> {
  const maxChats = options?.maxChats;
  const wantLimit = maxChats != null ? Math.max(maxChats, 20) : GET_CHATS_FULL_LIMIT;

  if (options?.skipExhaust !== true) {
    const loadResult = await loadChatsUntilExhausted(client, chatList);
    logGateway("load_chats_from_list_exhausted", {
      chatList,
      exhausted: loadResult.exhausted,
      loadRounds: loadResult.rounds,
    });
    await sleep(100);
  }

  let snap = await getChatsSnapshot(client, chatList, wantLimit);
  // If TDLib reports more chats than returned, keep loading then re-snapshot.
  for (let retry = 0; retry < 30 && snap.totalCount > snap.chatIds.length; retry += 1) {
    const again = await loadChatsUntilExhausted(client, chatList, { maxRounds: 40 });
    await sleep(80);
    snap = await getChatsSnapshot(client, chatList, wantLimit);
    logGateway("load_chats_from_list_resnapshot", {
      chatList,
      retry,
      returned: snap.chatIds.length,
      totalCount: snap.totalCount,
      exhausted: again.exhausted,
    });
    if (again.exhausted && snap.chatIds.length >= snap.totalCount) break;
    if (again.exhausted && retry >= 2) break;
  }

  const chats = await hydrateChatsByIds(client, snap.chatIds, { maxChats });
  logGateway("load_chats_from_list_done", {
    chatList,
    returnedIds: snap.chatIds.length,
    totalCount: snap.totalCount,
    hydrated: chats.length,
    maxChats: maxChats ?? null,
  });
  return chats;
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
    try {
      // TDLib `searchChats` is offline query+limit only (no chat_list).
      const result = (await client.invoke({
        _: "searchChats",
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
  includeFolders?: boolean;
  telegramUsername?: string;
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

  // Always pull archive + folders when requested — a main-list cap must not drop them
  // (tdesktop account unread includes archived / folder-only dialogs).
  if (options?.includeArchive !== false) {
    merge(await loadChatsFromList(client, { _: "chatListArchive" }));
  }

  if (options?.includeFolders !== false) {
    const folderIds = await resolveChatFolderIdsForSync(client, options?.telegramUsername);
    logGateway("load_all_chats_folders", {
      telegramUsername: options?.telegramUsername ?? null,
      folderCount: folderIds.length,
      folderIds,
    });
    for (const folderId of folderIds) {
      merge(
        await loadChatsFromList(client, {
          _: "chatListFolder",
          chat_folder_id: folderId,
        }),
      );
    }
  }

  if (options?.includeSupplementarySearch === false) {
    merge(await loadForcedPrivateChats(client));
  } else {
    merge(await loadSupplementaryPrivateChats(client));
  }

  const allowSupplementaryPrivate = options?.includeSupplementarySearch !== false;
  return filterChatsForList([...collected.values()], {
    allowSupplementaryPrivate,
    includeUnpositioned: allowSupplementaryPrivate,
  });
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

/** File ids from getUserFullInfo / getUserProfilePhotos ChatPhoto (sizes or small/big). */
function fileIdsFromResolvedChatPhoto(photo: Record<string, unknown>): number[] {
  const fromSizes = listPhotoSizeCandidates({ photo }).map((row) => row.fileId);
  if (fromSizes.length > 0) return fromSizes;
  const ids: number[] = [];
  for (const key of ["small", "big"] as const) {
    const node = photo[key];
    if (!node || typeof node !== "object") continue;
    const rec = node as { id?: unknown; file?: { id?: unknown } };
    const raw = rec.id ?? rec.file?.id;
    const id = typeof raw === "bigint" ? Number(raw) : Number(raw);
    if (Number.isFinite(id) && id > 0) ids.push(Math.trunc(id));
  }
  return ids;
}

async function downloadUserProfilePhotoBytes(
  client: Client,
  fileIds: number[],
): Promise<{ data: Buffer; mime: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(250 * attempt);
    for (const fileId of fileIds) {
      try {
        let file: TdFile | undefined = (await client.invoke({
          _: "getFile",
          file_id: fileId,
        })) as TdFile;
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
            file =
              (await waitForLocalFile(client, fileId)) ??
              ((await client.invoke({ _: "getFile", file_id: fileId })) as TdFile);
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

export async function readUserAvatarBytes(
  client: Client,
  userId: number,
): Promise<{ data: Buffer; mime: string } | typeof TELEGRAM_THREAD_NO_AVATAR | null> {
  try {
    let user = (await client.invoke({ _: "getUser", user_id: userId })) as TdUserProfile;
    let fileIds = profilePhotoFileIds(user);

    // Voice-roster peers are often cold in TDLib: getUser returns without
    // profile_photo until the private chat is opened (same as Desktop).
    if (fileIds.length === 0) {
      try {
        await client.invoke({
          _: "createPrivateChat",
          user_id: userId,
          force: false,
        });
      } catch {
        /* deleted / inaccessible — fall through */
      }
      try {
        user = (await client.invoke({ _: "getUser", user_id: userId })) as TdUserProfile;
        fileIds = profilePhotoFileIds(user);
      } catch {
        /* keep empty fileIds */
      }
    }

    // Full-info / profile-photos path: cold voice peers often have ChatPhoto on
    // getUserFullInfo while user.profile_photo is still empty → sticky 404s and
    // letter tiles on the voice preview strip.
    if (fileIds.length === 0) {
      try {
        const fullPhoto = await resolveUserChatPhoto(client, userId);
        if (fullPhoto) fileIds = fileIdsFromResolvedChatPhoto(fullPhoto);
      } catch {
        /* keep empty fileIds */
      }
    }

    if (fileIds.length > 0) {
      const downloaded = await downloadUserProfilePhotoBytes(client, fileIds);
      if (downloaded) return downloaded;
      // Photo ids exist but download failed — retryable, not a hard no-avatar.
      return null;
    }

    // Private chat id equals user id; chat.photo is sometimes populated first.
    const chatBytes = await readChatAvatarBytes(client, userId);
    if (chatBytes && chatBytes !== TELEGRAM_THREAD_NO_AVATAR) return chatBytes;
    if (chatBytes === TELEGRAM_THREAD_NO_AVATAR) return TELEGRAM_THREAD_NO_AVATAR;
    // Undetermined (TDLib miss / race) — 503 so the client retries, not sticky 404.
    return null;
  } catch {
    // Transient TDLib / session errors should 503, not sticky 404.
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
  isBot: boolean;
}> {
  const peerUserId = peerUserIdFromChat(chat);
  if (peerUserId == null) {
    return {
      presence: null,
      emojiStatusCustomEmojiId: null,
      username: null,
      accentColorLight: null,
      accentColorDark: null,
      isBot: false,
    };
  }
  try {
    const user = (await client.invoke({ _: "getUser", user_id: peerUserId })) as {
      status?: unknown;
      emoji_status?: unknown;
      username?: string;
      usernames?: { active_usernames?: string[]; editable_username?: string };
      type?: unknown;
    };
    const profile = userProfileFromTdUser(user);
    return {
      presence: presenceFromTdlibStatus(user.status),
      emojiStatusCustomEmojiId: profile.emoji_status_custom_emoji_id,
      username: usernameFromTdUser(user),
      accentColorLight: profile.accent_color_light,
      accentColorDark: profile.accent_color_dark,
      isBot: profile.is_bot,
    };
  } catch {
    return {
      presence: null,
      emojiStatusCustomEmojiId: null,
      username: null,
      accentColorLight: null,
      accentColorDark: null,
      isBot: false,
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

  const maxPositioned = options?.maxMainChats ?? null;
  let chats: TdChat[];
  let positionedComplete = false;

  if (maxPositioned != null) {
    const loaded = await loadPinnedAndPositionedChats(client, maxPositioned);
    chats = loaded.chats;
    positionedComplete = loaded.positionedComplete;
    if (options?.includeArchive !== false) {
      const archiveChats = await loadChatsFromList(client, { _: "chatListArchive" });
      const seen = new Set(chats.map((c) => c.id));
      for (const chat of archiveChats) {
        if (!seen.has(chat.id)) {
          seen.add(chat.id);
          chats.push(chat);
        }
      }
    }
    // Folder-only dialogs are absent from chatListMain — merge them so the flat
    // list / unread total match tdesktop (folders + archive + main).
    {
      const folderIds = await resolveChatFolderIdsForSync(client, telegramUsername);
      const seen = new Set(chats.map((c) => c.id));
      for (const folderId of folderIds) {
        const folderChats = await loadChatsFromList(client, {
          _: "chatListFolder",
          chat_folder_id: folderId,
        });
        for (const chat of folderChats) {
          if (!seen.has(chat.id)) {
            seen.add(chat.id);
            chats.push(chat);
          }
        }
      }
    }
    resetChatListSyncMeta(telegramUsername, {
      positionedComplete,
      tier3Available: true,
    });
  } else {
    chats = await loadAllChats(client, {
      maxMainChats: options?.maxMainChats ?? null,
      includeArchive: options?.includeArchive,
      includeSupplementarySearch: options?.includeSupplementarySearch,
      telegramUsername,
    });
    positionedComplete = true;
    resetChatListSyncMeta(telegramUsername, {
      positionedComplete: true,
      tier3Available: true,
    });
  }

  const liveRows = await buildLiveRowsForChats(client, chats, {
    skipMemberCounts: options?.skipMemberCounts === true,
  });

  if (options?.replaceCache === false) {
    mergeLiveChatRows(telegramUsername, liveRows);
  } else {
    const existingCount = getLiveChatList(telegramUsername)?.length ?? 0;
    if (existingCount === 0 || liveRows.length >= existingCount) {
      seedLiveChatList(telegramUsername, liveRows);
    } else {
      logGateway("sync_chat_threads_merge_instead_of_shrink", {
        telegramUsername,
        existingCount,
        newCount: liveRows.length,
      });
      mergeLiveChatRows(telegramUsername, liveRows);
    }
  }
  setPositionedComplete(telegramUsername, positionedComplete);
  // Full main/archive/folder sync: allow one supplementary (tier-3) pass, then
  // syncUnpositionedChatBatch clears the flag when exhausted.
  if (positionedComplete) {
    resetTier3ListCursor(telegramUsername);
  }
  setTier3Available(telegramUsername, true);
  await touchMtprotoSync(telegramUsername);

  logGateway("sync_chat_threads_done", {
    telegramUsername,
    chatCount: chats.length,
    rowCount: liveRows.length,
    maxMainChats: options?.maxMainChats ?? null,
    positionedComplete,
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
      peer_is_bot: profile?.isBot ?? false,
      presence_kind: profile?.presence?.kind ?? null,
      presence_at: profile?.presence?.at ?? null,
      chat_action: null,
      chat_action_user_id: null,
      chat_action_user_name: null,
      chat_action_expires_at: null,
      last_read_outbox_message_id: lastReadOutboxMessageIdFromChat(chat),
      last_read_inbox_message_id: lastReadInboxMessageIdFromChat(chat),
      ...lastMessageListRowMetaFromChat(chat, myUserId),
      is_pinned: isChatPinnedInMainList(chat),
      pin_order: mainListOrderKey(chat),
      // Bound id only from metadata; live paint via verify pass below.
      ...voiceChatFromTdChat(chat),
      list_tier: chatListTier(chat),
    });
  }

  // Verify bound group calls before painting list rings. Metadata alone must not
  // set has_active_voice_chat (stale empty leftovers keep a group_call_id).
  return mapWithConcurrency(liveRows, PREVIEW_SYNC_CONCURRENCY, async (row) => {
    const callId = row.voice_chat_group_call_id;
    if (typeof callId !== "number" || !Number.isFinite(callId) || callId <= 0) {
      return row;
    }
    const state = await verifyGroupCallLiveState(client, callId, {
      chatId: row.telegram_chat_id,
    });
    if (!state.live) {
      return {
        ...row,
        has_active_voice_chat: false,
        voice_chat_is_joined: false,
      };
    }
    return {
      ...row,
      has_active_voice_chat: true,
      // Green joined ring is client-session / self-on-roster — not list sync.
      voice_chat_is_joined: false,
    };
  });
}

/** Load remaining positioned main-list chats in small TDLib pages (non-blocking). */
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

  const syncChatList = async (chatList: TdChatListRef): Promise<void> => {
    const chats = await loadChatsFromList(client, chatList);
    const pageChats = chats.filter((chat) => !cachedIds.has(chat.id));
    for (const chat of pageChats) cachedIds.add(chat.id);

    logGateway("sync_chat_background_list_snapshot", {
      telegramUsername,
      chatList,
      totalHydrated: chats.length,
      newChats: pageChats.length,
    });

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
  };

  await syncChatList({ _: "chatListMain" });
  await syncChatList({ _: "chatListArchive" });
  const folderIds = await resolveChatFolderIdsForSync(client, telegramUsername);
  for (const folderId of folderIds) {
    await syncChatList({ _: "chatListFolder", chat_folder_id: folderId });
  }

  setPositionedComplete(telegramUsername, true);
  // Do not re-arm tier-3 after it already exhausted — that caused an endless
  // client load-more storm (Vercel: POST /chats-load-more every ~2s at count=375).
  if (!getTier3ListCursor(telegramUsername).exhausted) {
    setTier3Available(telegramUsername, true);
  }
  await touchMtprotoSync(telegramUsername);
  logGateway("sync_chat_background_done", {
    telegramUsername,
    mergedCount: merged,
    totalCached: getLiveChatList(telegramUsername)?.length ?? 0,
    tier3Available: isTier3Available(telegramUsername),
  });
  return merged;
}

/** On-demand batch of supplementary / unpositioned chats (tier 3 tail). */
export async function syncUnpositionedChatBatch(
  client: Client,
  telegramUsername: string,
  options?: { limit?: number },
): Promise<number> {
  const limit = options?.limit ?? TIER3_CHAT_SYNC_BATCH_SIZE;
  const cachedIds = new Set(
    (getLiveChatList(telegramUsername) ?? []).map((row) => row.telegram_chat_id),
  );

  const candidates: TdChat[] = [];
  const seen = new Set<number>();

  const tryAddChat = (chat: TdChat) => {
    if (seen.has(chat.id) || cachedIds.has(chat.id)) return;
    const tier = chatListTier(chat, { allowSupplementaryPrivate: true });
    if (tier !== "unpositioned") return;
    candidates.push(chat);
    seen.add(chat.id);
  };

  for (const chat of await loadForcedPrivateChats(client)) {
    if (candidates.length >= limit) break;
    const hydrated = await hydrateChatPositions(client, chat.id);
    if (hydrated) tryAddChat(hydrated);
  }

  for (const chat of await discoverPrivateChatsByContactSearch(
    client,
    SUPPLEMENTARY_CONTACT_SEARCH_QUERIES,
  )) {
    if (candidates.length >= limit) break;
    const hydrated = await hydrateChatPositions(client, chat.id);
    if (hydrated) tryAddChat(hydrated);
  }

  const cursor = getTier3ListCursor(telegramUsername);
  if (candidates.length < limit && !cursor.exhausted) {
    // Snapshot the full main list (TDLib 1.7+ getChats has no offsets), then pick unpositioned.
    const mainChats = await loadChatsFromList(client, { _: "chatListMain" });
    for (const chat of mainChats) {
      if (candidates.length >= limit) break;
      tryAddChat(chat);
    }
    cursor.exhausted = true;
  }

  const batch = candidates.slice(0, limit);
  if (batch.length === 0) {
    if (cursor.exhausted) {
      setTier3Available(telegramUsername, false);
    }
    return 0;
  }

  const rows = await buildLiveRowsForChats(client, batch);
  const tieredRows = rows.map((row) => ({ ...row, list_tier: "unpositioned" as ChatListTier }));
  mergeLiveChatRows(telegramUsername, tieredRows);
  await touchMtprotoSync(telegramUsername);

  logGateway("sync_chat_tier3_batch_done", {
    telegramUsername,
    mergedCount: tieredRows.length,
    totalCached: getLiveChatList(telegramUsername)?.length ?? 0,
    listExhausted: cursor.exhausted,
  });
  return tieredRows.length;
}

export {
  isBackgroundChatSyncInProgress,
  isTier3ChatSyncInProgress,
} from "./chatListSyncState.js";

export function scheduleBackgroundChatSync(client: Client, telegramUsername: string): void {
  if (!markBackgroundChatSyncStart(telegramUsername)) return;
  // Only flip incomplete while the first pass is unfinished. Re-running after
  // complete must not briefly report positionedComplete=false (client storm).
  if (!isPositionedComplete(telegramUsername)) {
    setPositionedComplete(telegramUsername, false);
  }
  void (async () => {
    try {
      await syncRemainingChatsInBackground(client, telegramUsername);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logGateway("sync_chat_background_error", { telegramUsername, message });
    } finally {
      markBackgroundChatSyncEnd(telegramUsername);
    }
  })();
}

export function scheduleTier3ChatSync(client: Client, telegramUsername: string): void {
  if (!markTier3ChatSyncStart(telegramUsername)) return;
  void (async () => {
    try {
      await syncUnpositionedChatBatch(client, telegramUsername);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logGateway("sync_chat_tier3_error", { telegramUsername, message });
    } finally {
      markTier3ChatSyncEnd(telegramUsername);
    }
  })();
}

export async function syncChatsFromTdlib(
  client: Client,
  telegramUsername: string,
): Promise<number> {
  await persistMtprotoConnection(client, telegramUsername);
  const count = await syncChatThreads(client, telegramUsername, {
    maxMainChats: null,
    includeArchive: true,
    includeSupplementarySearch: false,
    skipMemberCounts: true,
    replaceCache: true,
  });
  return count;
}
