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
import {
  isChatListSyncInProgress,
  subscribeChatListSyncStatus,
} from "./components/messages/chatListSyncStatus";
import {
  isVoiceDialogUiOpen,
  subscribeVoiceDialogUiOpen,
} from "./components/messages/voiceDialogUiGate";

/** Max visible chats we warm in the background (viewport-driven). */
const PREFETCH_VISIBLE_MAX = 7;
/** Preview rows warmed immediately when the viewport changes (visual top first). */
const VISIBLE_PREVIEW_BATCH = 5;
const MAX_BACKGROUND_CONCURRENT = 2;
/** Stagger between background list prefetches (telegram-tt). */
const TOP_CHAT_PREFETCH_INTERVAL_MS = 100;
/**
 * After opening a chat, keep neighbor history paused so voice strip / full
 * history / soft getGroupCall win the TDLib gateway (prod: open → 34s until
 * voice SSE while preview prefetches ran 7–32s each).
 */
const OPEN_CHAT_FOCUS_HOLD_MS = 12_000;

type LoadSpec = {
  warmup: boolean;
  limit: number;
  previewOnly: boolean;
  aroundUnread: boolean;
  aroundMessageId?: number | null;
  olderAbove?: number | null;
  newerBelow?: number | null;
  /** Neighbor/list warming — discarded if the voice dialog opens mid-flight. */
  background?: boolean;
};

const sharedLoads = new Map<number, Promise<ChatHistoryPageResult>>();
const inFlightBackground = new Map<number, Promise<void>>();
const queued: Array<{
  chatId: number;
  peerUserId: number | null;
  spec: LoadSpec;
}> = [];
let backgroundActive = 0;
/** Bumped when the voice sheet opens so in-flight neighbor loads drop their paint. */
let historyPrefetchEpoch = 0;
/** While set, background list prefetch is paused so the open chat wins gateway time. */
let openChatLoadingId: number | null = null;
/** Selected chat — background drain stays paused for {@link OPEN_CHAT_FOCUS_HOLD_MS}. */
let openChatFocusId: number | null = null;
let openChatFocusUntilMs = 0;
let openChatFocusTimer: ReturnType<typeof setTimeout> | null = null;

function prefetchQueueSnapshot(): {
  queued: number;
  inFlight: number;
  backgroundActive: number;
  openChatLoadingId: number | null;
  openChatFocusId: number | null;
  focusHoldMsLeft: number;
} {
  return {
    queued: queued.length,
    inFlight: inFlightBackground.size,
    backgroundActive,
    openChatLoadingId,
    openChatFocusId,
    focusHoldMsLeft: Math.max(0, openChatFocusUntilMs - Date.now()),
  };
}

function isOpenChatFocusHoldActive(): boolean {
  return openChatFocusId != null && Date.now() < openChatFocusUntilMs;
}

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
  const epochAtStart = historyPrefetchEpoch;
  // Skip starting neighbor loads once the voice sheet is open — an in-flight
  // 80-row normalize mid-Join freezes createOffer / Close.
  if (
    spec.background &&
    (historyPrefetchEpoch !== epochAtStart ||
      isVoiceDialogUiOpen() ||
      isOpenChatFocusHoldActive())
  ) {
    logPageDisplay("messages_history_prefetch_dropped_voice_dialog", {
      chatId,
      count: 0,
      elapsedMs: Date.now() - started,
      previewOnly: spec.previewOnly,
      note: "skipped_before_fetch",
      reason: isVoiceDialogUiOpen()
        ? "voice_dialog"
        : isOpenChatFocusHoldActive()
          ? "open_chat_focus"
          : "epoch",
      ...prefetchQueueSnapshot(),
    });
    return {
      messages: [],
      chatKind: null,
      error: "voice_dialog_open",
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      lastReadOutboxMessageId: null,
      lastReadInboxMessageId: null,
      memberCount: null,
      selfUserId: null,
    };
  }
  const result = await loadTelegramChatHistoryFirstPage(chatId, peerUserId, {
    warmup: spec.warmup,
    limit: spec.limit,
    aroundUnread: spec.aroundUnread,
    aroundMessageId: spec.aroundMessageId ?? null,
    olderAbove: spec.olderAbove ?? null,
    newerBelow: spec.newerBelow ?? null,
    background: spec.background === true,
  });
  // Neighbor prefetches that finish during Join used to parse + cache-notify on
  // the main thread beside createOffer (logs: history_prefetch_ok mid-dialog).
  // Same for open-chat focus hold — drop paint so voice soft-poll can recover.
  if (
    spec.background &&
    (historyPrefetchEpoch !== epochAtStart ||
      isVoiceDialogUiOpen() ||
      isOpenChatFocusHoldActive())
  ) {
    logPageDisplay("messages_history_prefetch_dropped_voice_dialog", {
      chatId,
      count: result.messages.length,
      elapsedMs: Date.now() - started,
      previewOnly: spec.previewOnly,
      reason: isVoiceDialogUiOpen()
        ? "voice_dialog"
        : isOpenChatFocusHoldActive()
          ? "open_chat_focus"
          : "epoch",
      ...prefetchQueueSnapshot(),
    });
    return {
      messages: [],
      chatKind: null,
      error: "voice_dialog_open",
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      lastReadOutboxMessageId: null,
      lastReadInboxMessageId: null,
      memberCount: null,
      selfUserId: null,
    };
  }
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
      background: spec.background === true,
      ...prefetchQueueSnapshot(),
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
  // Voice UI owns gateway + main thread — pause neighbor history warming.
  if (isVoiceDialogUiOpen()) return;
  if (isOpenChatFocusHoldActive()) return;
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
  logPageDisplay("messages_history_prefetch_drain_start", {
    chatId: next.chatId,
    previewOnly: next.spec.previewOnly,
    ...prefetchQueueSnapshot(),
    level: "info",
  });
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
  options?: { front?: boolean },
): void {
  if (!Number.isFinite(chatId)) return;
  // Always queue while the open chat loads — drain resumes when it finishes.
  // Skipping enqueue here previously burned MessageChatRow's one-shot prefetch.
  // List sync: still enqueue (esp. front/open neighbors); drain waits until sync clears.
  if (isVoiceDialogUiOpen()) return;
  // During open-chat focus hold, don't refill neighbor work that will compete
  // the moment the hold ends (rows keep remounting / viewport firing).
  if (isOpenChatFocusHoldActive() && !options?.front) return;

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

  if (queued.length + inFlightBackground.size >= PREFETCH_VISIBLE_MAX) {
    if (!options?.front) return;
    // Neighbors of the open chat: bump the oldest queued preview out.
    if (queued.length > 0) queued.pop();
  }

  const entry = {
    chatId,
    peerUserId: Number.isFinite(Number(peerUserId)) ? Number(peerUserId) : null,
    spec: { ...spec, background: true },
  };
  if (options?.front) {
    queued.unshift(entry);
  } else {
    queued.push(entry);
  }
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
      const needsMemberCount =
        cached.memberCount == null &&
        cached.chatKind != null &&
        cached.chatKind !== "private";
      if (!needsMemberCount) {
        return toPageResult(cached);
      }
      // Group/channel cache without member_count — refetch so the header can show
      // participants (TDLib FullInfo). Keep falling through to the shared load.
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

/**
 * Pause neighbor history drain after selecting a chat so voice strip / open
 * history / soft getGroupCall are not starved by list warming.
 */
export function setOpenChatFocusHold(
  chatId: number | null,
  options?: { holdMs?: number; clearQueued?: boolean },
): void {
  if (openChatFocusTimer != null) {
    clearTimeout(openChatFocusTimer);
    openChatFocusTimer = null;
  }
  if (chatId == null || !Number.isFinite(chatId)) {
    openChatFocusId = null;
    openChatFocusUntilMs = 0;
    logPageDisplay("messages_history_prefetch_focus_cleared", {
      ...prefetchQueueSnapshot(),
    });
    scheduleBackgroundDrain();
    return;
  }
  const holdMs =
    typeof options?.holdMs === "number" && options.holdMs > 0
      ? Math.trunc(options.holdMs)
      : OPEN_CHAT_FOCUS_HOLD_MS;
  const clearQueued = options?.clearQueued !== false;
  openChatFocusId = Math.trunc(chatId);
  openChatFocusUntilMs = Date.now() + holdMs;
  // Invalidate in-flight neighbor loads so they don't cache/normalize on focus.
  historyPrefetchEpoch += 1;
  let dropped = 0;
  if (clearQueued && queued.length > 0) {
    dropped = queued.length;
    queued.length = 0;
  }
  logPageDisplay("messages_history_prefetch_focus_hold", {
    chatId: openChatFocusId,
    holdMs,
    dropped,
    ...prefetchQueueSnapshot(),
    level: "info",
  });
  openChatFocusTimer = setTimeout(() => {
    openChatFocusTimer = null;
    if (openChatFocusId !== Math.trunc(chatId)) return;
    openChatFocusId = null;
    openChatFocusUntilMs = 0;
    logPageDisplay("messages_history_prefetch_focus_release", {
      chatId: Math.trunc(chatId),
      ...prefetchQueueSnapshot(),
      level: "info",
    });
    scheduleBackgroundDrain();
  }, holdMs);
}

/** Prefetch a short preview page when a list row scrolls into view. */
export function prefetchChatHistory(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "peer_user_id" | "unread_count">,
): void {
  enqueueBackgroundPrefetch(
    chat.telegram_chat_id,
    chat.peer_user_id ?? null,
    resolveLoadSpec(chat, { previewOnly: true }),
  );
}

/**
 * Warm neighbors of the open chat (tdesktop-style fast switch).
 * Full open-spec for ±radius list neighbors; preview for the rest of `visible`.
 */
export function prefetchVisibleChatNeighbors(
  chats: readonly MessageChatRowData[],
  selectedChatId: number | null | undefined,
  options?: { radius?: number; /** Search/recents column-reverse: visual top is at the end. */ visualTopAtEnd?: boolean },
): void {
  if (chats.length === 0) return;
  if (isOpenChatFocusHoldActive()) {
    logPageDisplay("messages_history_prefetch_neighbors_deferred_focus", {
      selectedChatId: selectedChatId ?? null,
      visible: chats.length,
      ...prefetchQueueSnapshot(),
      level: "info",
    });
    return;
  }
  const radius =
    typeof options?.radius === "number" && options.radius > 0
      ? Math.trunc(options.radius)
      : 2;
  const selectedIdx =
    selectedChatId != null && Number.isFinite(selectedChatId)
      ? chats.findIndex((row) => row.telegram_chat_id === selectedChatId)
      : -1;

  // Neighbors of the open chat — full page, front of queue.
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]!;
    if (selectedChatId != null && chat.telegram_chat_id === selectedChatId) {
      continue;
    }
    const nearSelected =
      selectedIdx >= 0 && Math.abs(i - selectedIdx) <= radius;
    if (nearSelected) {
      enqueueBackgroundPrefetch(
        chat.telegram_chat_id,
        chat.peer_user_id ?? null,
        resolveOpenLoadSpec(chat),
        { front: true },
      );
    }
  }

  // Visible-first preview batch: walk visual top → bottom.
  const visualTopAtEnd = options?.visualTopAtEnd === true;
  let previewBudget = VISIBLE_PREVIEW_BATCH;
  if (visualTopAtEnd) {
    for (let i = chats.length - 1; i >= 0 && previewBudget > 0; i--) {
      const chat = chats[i]!;
      if (selectedChatId != null && chat.telegram_chat_id === selectedChatId) {
        continue;
      }
      if (selectedIdx >= 0 && Math.abs(i - selectedIdx) <= radius) {
        continue;
      }
      enqueueBackgroundPrefetch(
        chat.telegram_chat_id,
        chat.peer_user_id ?? null,
        resolveLoadSpec(chat, { previewOnly: true }),
      );
      previewBudget -= 1;
    }
  } else {
    for (let i = 0; i < chats.length && previewBudget > 0; i++) {
      const chat = chats[i]!;
      if (selectedChatId != null && chat.telegram_chat_id === selectedChatId) {
        continue;
      }
      if (selectedIdx >= 0 && Math.abs(i - selectedIdx) <= radius) {
        continue;
      }
      enqueueBackgroundPrefetch(
        chat.telegram_chat_id,
        chat.peer_user_id ?? null,
        resolveLoadSpec(chat, { previewOnly: true }),
      );
      previewBudget -= 1;
    }
  }
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
  // Full fresh page only — never skip upgrading a preview-only cache.
  if (
    cached &&
    !cached.previewOnly &&
    isChatHistoryCacheFresh(chatId) &&
    isChatHistoryCacheAnchorMatch(chatId, anchorSpec)
  ) {
    return;
  }
  if (sharedLoads.has(chatId)) return;
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

/** Drop queued neighbor history work when the voice sheet opens. */
export function clearQueuedHistoryPrefetchForVoiceDialog(): void {
  historyPrefetchEpoch += 1;
  if (queued.length > 0) {
    logPageDisplay("messages_history_prefetch_queue_cleared_voice_dialog", {
      dropped: queued.length,
      inFlight: inFlightBackground.size,
    });
    queued.length = 0;
  }
}

if (typeof window !== "undefined") {
  subscribeVoiceDialogUiOpen((open) => {
    if (open) clearQueuedHistoryPrefetchForVoiceDialog();
  });
  subscribeChatListSyncStatus(() => {
    if (!isChatListSyncInProgress()) scheduleBackgroundDrain();
  });
}
