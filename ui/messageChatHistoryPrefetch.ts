import type { MessageChatRowData } from "./components/messages/MessageChatRow";
import {
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
  MESSAGE_CHAT_HISTORY_PREVIEW_SIZE,
} from "./components/messages/messageChatLayout";
import type { ChatHistoryPageResult } from "./telegram/fetchTelegramChatHistoryPage";
import { loadTelegramChatHistoryFirstPage } from "./telegram/fetchTelegramChatHistoryPage";
import {
  type CachedChatHistoryPage,
  type ChatHistoryCacheAnchorSpec,
  getCachedChatHistory,
  isChatHistoryCacheAnchorMatch,
  isChatHistoryCacheComplete,
  isChatHistoryCacheFresh,
  PREVIEW_FRESH_MS,
  setCachedChatHistory,
} from "./messageChatHistoryCache";
import {
  getOpenChatHistoryCacheAnchorSpec,
  resolveChatOpenSession,
  shouldPrefetchHistoryAroundUnread,
} from "./components/messages/chatOpenSession";
import { logPageDisplay } from "./pageDisplayLog";
import { isChatListSyncInProgress } from "./components/messages/chatListSyncStatus";

/** Max visible chats we warm in the background (viewport-driven). */
const PREFETCH_VISIBLE_MAX = 7;
const MAX_BACKGROUND_CONCURRENT = 2;
/** Stagger between background list prefetches (telegram-tt). */
const TOP_CHAT_PREFETCH_INTERVAL_MS = 100;

type LoadSpec = {
  warmup: boolean;
  limit: number;
  previewOnly: boolean;
  aroundUnread: boolean;
  aroundMessageId?: number | null;
  olderAbove?: number | null;
  newerBelow?: number | null;
};

const sharedLoads = new Map<number, Promise<ChatHistoryPageResult>>();
const inFlightBackground = new Map<number, Promise<void>>();
const queued: Array<{
  chatId: number;
  peerUserId: number | null;
  spec: LoadSpec;
}> = [];
let backgroundActive = 0;
/** While set, background list prefetch is paused so the open chat wins gateway time. */
let openChatLoadingId: number | null = null;

function toPageResult(cached: CachedChatHistoryPage): ChatHistoryPageResult {
  const {
    fetchedAt: _fetchedAt,
    previewOnly: _previewOnly,
    aroundUnread: _aroundUnread,
    aroundMessageId: _aroundMessageId,
    ...page
  } = cached;
  return page;
}

function isFullPageSpec(spec: LoadSpec): boolean {
  return !spec.previewOnly && spec.limit >= MESSAGE_CHAT_HISTORY_PAGE_SIZE;
}

function toCacheAnchorSpec(spec: LoadSpec): ChatHistoryCacheAnchorSpec {
  return {
    aroundUnread: spec.aroundUnread,
    aroundMessageId: spec.aroundMessageId ?? null,
  };
}

export { shouldPrefetchHistoryAroundUnread, getOpenChatHistoryCacheAnchorSpec };

function resolveOpenLoadSpec(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "unread_count"> &
    Partial<Pick<MessageChatRowData, "last_message_telegram_id" | "last_read_inbox_message_id">>,
): LoadSpec {
  const session = resolveChatOpenSession(chat as MessageChatRowData);
  return {
    warmup: true,
    limit: session.fetch.limit,
    previewOnly: false,
    aroundUnread: session.fetch.aroundUnread,
    aroundMessageId: session.fetch.anchorMessageId,
    olderAbove: session.fetch.olderAbove,
    newerBelow: session.fetch.newerBelow,
  };
}

function resolveLoadSpec(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "unread_count">,
  options: { previewOnly: boolean; warmup?: boolean; limit?: number },
): LoadSpec {
  const aroundUnread = shouldPrefetchHistoryAroundUnread(chat);
  return {
    warmup: options.warmup === true,
    limit:
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : options.previewOnly
          ? MESSAGE_CHAT_HISTORY_PREVIEW_SIZE
          : MESSAGE_CHAT_HISTORY_PAGE_SIZE,
    previewOnly: options.previewOnly,
    aroundUnread,
  };
}

async function runHistoryLoad(
  chatId: number,
  peerUserId: number | null,
  spec: LoadSpec,
): Promise<ChatHistoryPageResult> {
  const started = Date.now();
  const result = await loadTelegramChatHistoryFirstPage(chatId, peerUserId, {
    warmup: spec.warmup,
    limit: spec.limit,
    aroundUnread: spec.aroundUnread,
    aroundMessageId: spec.aroundMessageId ?? null,
    olderAbove: spec.olderAbove ?? null,
    newerBelow: spec.newerBelow ?? null,
  });
  if (!result.error && result.messages.length > 0) {
    setCachedChatHistory(chatId, result, {
      previewOnly: spec.previewOnly,
      aroundUnread: spec.aroundUnread,
      aroundMessageId: spec.aroundMessageId ?? null,
    });
    logPageDisplay("messages_history_prefetch_ok", {
      chatId,
      count: result.messages.length,
      elapsedMs: Date.now() - started,
      previewOnly: spec.previewOnly,
      aroundUnread: spec.aroundUnread,
      aroundMessageId: spec.aroundMessageId ?? null,
      limit: spec.limit,
      lane: spec.previewOnly ? "preview" : "full",
    });
  } else if (result.error) {
    const shouldFallbackFromAroundUnread =
      spec.aroundUnread &&
      !spec.previewOnly &&
      (result.error.includes("offset must be non-positive") ||
        result.error.includes("history_failed"));
    if (shouldFallbackFromAroundUnread) {
      const fallback: LoadSpec = {
        ...spec,
        aroundUnread: false,
        aroundMessageId: null,
        olderAbove: null,
        newerBelow: null,
        limit: Math.min(spec.limit, MESSAGE_CHAT_HISTORY_PAGE_SIZE),
      };
      return runHistoryLoad(chatId, peerUserId, fallback);
    }
    logPageDisplay("messages_history_prefetch_skip", {
      chatId,
      error: result.error,
      elapsedMs: Date.now() - started,
      previewOnly: spec.previewOnly,
      aroundUnread: spec.aroundUnread,
      aroundMessageId: spec.aroundMessageId ?? null,
      limit: spec.limit,
      lane: spec.previewOnly ? "preview" : "full",
    });
  }
  return result;
}

function startSharedLoad(
  chatId: number,
  peerUserId: number | null,
  spec: LoadSpec,
): Promise<ChatHistoryPageResult> {
  const anchorSpec = toCacheAnchorSpec(spec);
  const existing = sharedLoads.get(chatId);
  if (existing) {
    if (isFullPageSpec(spec)) {
      return existing.then(async (prior) => {
        if (prior.error) {
          return prior;
        }
        if (
          isChatHistoryCacheComplete(chatId) &&
          isChatHistoryCacheFresh(chatId) &&
          isChatHistoryCacheAnchorMatch(chatId, anchorSpec)
        ) {
          const cached = getCachedChatHistory(chatId);
          return cached ? toPageResult(cached) : prior;
        }
        if (sharedLoads.has(chatId)) {
          return sharedLoads.get(chatId)!;
        }
        return startSharedLoad(chatId, peerUserId, spec);
      });
    }
    return existing;
  }

  const promise = runHistoryLoad(chatId, peerUserId, spec).finally(() => {
    if (sharedLoads.get(chatId) === promise) {
      sharedLoads.delete(chatId);
    }
  });
  sharedLoads.set(chatId, promise);
  return promise;
}

function scheduleBackgroundDrain(): void {
  if (openChatLoadingId != null || isChatListSyncInProgress()) return;
  if (backgroundActive >= MAX_BACKGROUND_CONCURRENT || queued.length === 0) return;

  const next = queued.shift();
  if (!next) return;

  const freshMs = next.spec.previewOnly ? PREVIEW_FRESH_MS : undefined;
  if (
    isChatHistoryCacheFresh(next.chatId, freshMs) &&
    isChatHistoryCacheAnchorMatch(next.chatId, toCacheAnchorSpec(next.spec))
  ) {
    scheduleBackgroundDrain();
    return;
  }
  if (sharedLoads.has(next.chatId)) {
    scheduleBackgroundDrain();
    return;
  }

  backgroundActive += 1;
  const promise = startSharedLoad(next.chatId, next.peerUserId, next.spec)
    .finally(() => {
      backgroundActive -= 1;
      inFlightBackground.delete(next.chatId);
      setTimeout(() => scheduleBackgroundDrain(), TOP_CHAT_PREFETCH_INTERVAL_MS);
    });
  inFlightBackground.set(next.chatId, promise.then(() => undefined));
}

function enqueueBackgroundPrefetch(
  chatId: number,
  peerUserId: number | null | undefined,
  spec: LoadSpec,
): void {
  if (!Number.isFinite(chatId)) return;
  if (openChatLoadingId != null || isChatListSyncInProgress()) return;

  const freshMs = spec.previewOnly ? PREVIEW_FRESH_MS : undefined;
  if (
    isChatHistoryCacheFresh(chatId, freshMs) &&
    isChatHistoryCacheAnchorMatch(chatId, toCacheAnchorSpec(spec))
  ) {
    return;
  }
  if (sharedLoads.has(chatId)) return;

  const existingIdx = queued.findIndex((row) => row.chatId === chatId);
  if (existingIdx >= 0) {
    queued.splice(existingIdx, 1);
  }

  if (queued.length + inFlightBackground.size >= PREFETCH_VISIBLE_MAX) return;

  queued.push({
    chatId,
    peerUserId: Number.isFinite(Number(peerUserId)) ? Number(peerUserId) : null,
    spec,
  });
  scheduleBackgroundDrain();
}

/** Open chat history — highest priority, deduped, pauses background prefetch. */
export async function loadOpenChatHistoryFirstPage(
  chatId: number,
  peerUserId: number | null | undefined,
  chat?: Pick<MessageChatRowData, "telegram_chat_id" | "unread_count"> | null,
): Promise<ChatHistoryPageResult> {
  if (!Number.isFinite(chatId)) {
    return {
      messages: [],
      chatKind: null,
      error: "invalid_chat_id",
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      lastReadOutboxMessageId: null,
      lastReadInboxMessageId: null,
      memberCount: null,
      selfUserId: null,
    };
  }

  const spec = resolveOpenLoadSpec(chat ?? { telegram_chat_id: chatId, unread_count: 0 });
  const anchorSpec = toCacheAnchorSpec(spec);

  openChatLoadingId = chatId;
  try {
    const cached = getCachedChatHistory(chatId);
    if (
      cached &&
      !cached.previewOnly &&
      isChatHistoryCacheFresh(chatId) &&
      isChatHistoryCacheAnchorMatch(chatId, anchorSpec)
    ) {
      return toPageResult(cached);
    }
    return await startSharedLoad(chatId, peerUserId ?? null, spec);
  } finally {
    if (openChatLoadingId === chatId) {
      openChatLoadingId = null;
    }
    scheduleBackgroundDrain();
  }
}

/** True while the open chat is loading history (background prefetch is paused). */
export function isOpenChatHistoryLoading(): boolean {
  return openChatLoadingId != null;
}

/** Prefetch a short preview page when a list row scrolls into view. */
export function prefetchChatHistory(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "peer_user_id" | "unread_count">,
): void {
  if (openChatLoadingId != null || isChatListSyncInProgress()) return;
  enqueueBackgroundPrefetch(
    chat.telegram_chat_id,
    chat.peer_user_id ?? null,
    resolveLoadSpec(chat, { previewOnly: true }),
  );
}

/** Warm the open chat — shares the same in-flight load as {@link loadOpenChatHistoryFirstPage}. */
export function prefetchChatHistoryPriority(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "peer_user_id" | "unread_count">,
): void {
  const chatId = chat.telegram_chat_id;
  if (!Number.isFinite(chatId)) return;
  const spec = resolveOpenLoadSpec(chat);
  const anchorSpec = toCacheAnchorSpec(spec);
  const cached = getCachedChatHistory(chatId);
  if (
    cached &&
    !cached.previewOnly &&
    isChatHistoryCacheFresh(chatId) &&
    isChatHistoryCacheAnchorMatch(chatId, anchorSpec)
  ) {
    return;
  }
  if (sharedLoads.has(chatId)) return;
  if (
    cached?.previewOnly &&
    isChatHistoryCacheFresh(chatId, PREVIEW_FRESH_MS) &&
    isChatHistoryCacheAnchorMatch(chatId, anchorSpec)
  ) {
    return;
  }
  void loadOpenChatHistoryFirstPage(chatId, chat.peer_user_id ?? null, chat);
}

/** @deprecated Use viewport-driven {@link prefetchChatHistory} from visible rows. */
export function prefetchChatHistoryForList(
  chats: readonly MessageChatRowData[],
  options?: { skipChatId?: number | null },
): void {
  if (chats.length === 0) return;
  const skipId = options?.skipChatId ?? null;
  for (const chat of chats) {
    if (skipId != null && chat.telegram_chat_id === skipId) continue;
    if (queued.length + inFlightBackground.size >= PREFETCH_VISIBLE_MAX) break;
    prefetchChatHistory(chat);
  }
}

/** True when a usable first page is already in memory. */
export function hasPrefetchedChatHistory(chatId: number): boolean {
  const cached = getCachedChatHistory(chatId);
  return cached != null && cached.messages.length > 0 && !cached.error;
}
