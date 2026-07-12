import { MESSAGE_CHAT_CACHE_MESSAGES_MAX } from "./components/messages/messageChatLayout";
import {
  enrichHistoryMessageDisplay,
  mergeHistoryMessageRow,
} from "./components/messages/messageChatHistoryTypes";
import type { ChatHistoryPageResult } from "./telegram/fetchTelegramChatHistoryPage";

export type CachedChatHistoryPage = ChatHistoryPageResult & {
  fetchedAt: number;
  /** True when only a short preview page was prefetched for the list. */
  previewOnly?: boolean;
  /** True when loaded around the inbox read cursor instead of the latest tail. */
  aroundUnread?: boolean;
  /** Message id the first page was centered on (saved scroll anchor). */
  aroundMessageId?: number | null;
};

export type ChatHistoryCacheAnchorSpec = {
  aroundUnread?: boolean;
  aroundMessageId?: number | null;
};

const cache = new Map<number, CachedChatHistoryPage>();
const MAX_ENTRIES = 32;
const FRESH_MS = 45_000;
/** Background list preview stays valid longer — avoids competing with the open chat. */
export const PREVIEW_FRESH_MS = 2 * 60_000;
const MAX_AGE_MS = 10 * 60_000;
/** Bump when cached page shape changes (e.g. lastReadInboxMessageId required for unread divider). */
const SESSION_STORAGE_KEY = "hyperlinks_chat_history_cache_v2";

const cacheListeners = new Set<(chatId: number) => void>();

function emitCacheUpdate(chatId: number): void {
  for (const listener of cacheListeners) {
    listener(chatId);
  }
}

function readSessionCache(): Record<string, CachedChatHistoryPage> {
  try {
    if (typeof globalThis === "undefined" || !("sessionStorage" in globalThis)) {
      return {};
    }
    const raw = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.getItem(
      SESSION_STORAGE_KEY,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, CachedChatHistoryPage>;
  } catch {
    return {};
  }
}

function writeSessionCache(chatId: number, entry: CachedChatHistoryPage): void {
  try {
    if (typeof globalThis === "undefined" || !("sessionStorage" in globalThis)) return;
    const store = readSessionCache();
    store[String(chatId)] = entry;
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      const sorted = keys.sort(
        (a, b) => (store[a]!.fetchedAt ?? 0) - (store[b]!.fetchedAt ?? 0),
      );
      for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
        delete store[sorted[i]!];
      }
    }
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(store),
    );
  } catch {
    /* quota / private mode */
  }
}

function hydrateFromSession(chatId: number): CachedChatHistoryPage | null {
  const entry = readSessionCache()[String(chatId)];
  if (!entry || !Array.isArray(entry.messages) || entry.messages.length === 0) return null;
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return null;
  cache.set(chatId, entry);
  return entry;
}

export function subscribeChatHistoryCache(listener: (chatId: number) => void): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}

/** Restore the last cached first page for a chat (e.g. on reload with an open thread). */
export function warmChatHistoryCacheFromSession(chatId: number): boolean {
  if (!Number.isFinite(chatId)) return false;
  if (cache.has(chatId)) return true;
  return hydrateFromSession(chatId) != null;
}

function trimCache(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const entries = [...cache.entries()].sort((a, b) => {
    const aPreview = a[1].previewOnly ? 0 : 1;
    const bPreview = b[1].previewOnly ? 0 : 1;
    if (aPreview !== bPreview) return aPreview - bPreview;
    return a[1].fetchedAt - b[1].fetchedAt;
  });
  const removeCount = cache.size - MAX_ENTRIES;
  for (let i = 0; i < removeCount; i++) {
    cache.delete(entries[i]![0]);
  }
}

function cachePageSignature(
  page: ChatHistoryPageResult & {
    previewOnly?: boolean;
    aroundUnread?: boolean;
    aroundMessageId?: number | null;
  },
): string {
  const maxId =
    page.messages.length > 0
      ? page.messages[page.messages.length - 1]!.telegram_message_id
      : 0;
  const minId =
    page.messages.length > 0 ? page.messages[0]!.telegram_message_id : 0;
  return [
    page.messages.length,
    minId,
    maxId,
    page.previewOnly ? 1 : 0,
    page.aroundUnread ? 1 : 0,
    page.aroundMessageId ?? "",
    page.hasMoreOlder ? 1 : 0,
    page.nextBeforeMessageId ?? "",
    page.lastReadOutboxMessageId ?? "",
    page.lastReadInboxMessageId ?? "",
    page.chatKind ?? "",
    page.selfUserId ?? "",
  ].join("|");
}

export function getCachedChatHistory(chatId: number): CachedChatHistoryPage | null {
  let entry = cache.get(chatId) ?? null;
  if (!entry) {
    entry = hydrateFromSession(chatId);
  }
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) {
    cache.delete(chatId);
    return null;
  }
  return entry;
}

export function isChatHistoryCacheFresh(chatId: number, maxAgeMs = FRESH_MS): boolean {
  const entry = cache.get(chatId);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < maxAgeMs;
}

/** Whether a cached page matches the current load strategy. */
export function isChatHistoryCacheAnchorMatch(
  chatId: number,
  spec: ChatHistoryCacheAnchorSpec = {},
): boolean {
  const entry = getCachedChatHistory(chatId);
  if (!entry || entry.messages.length === 0) return false;

  const aroundMessageId = spec.aroundMessageId;
  if (aroundMessageId != null && aroundMessageId > 0) {
    if (entry.aroundMessageId === aroundMessageId) return true;
    return entry.messages.some((row) => row.telegram_message_id === aroundMessageId);
  }

  if (spec.aroundUnread === true) {
    return entry.aroundUnread === true && !entry.previewOnly;
  }

  if (entry.aroundMessageId != null && entry.aroundMessageId > 0) {
    return false;
  }

  return true;
}

/** Full first page ready to show without another network round-trip. */
export function isChatHistoryCacheComplete(chatId: number): boolean {
  const entry = getCachedChatHistory(chatId);
  if (!entry || entry.messages.length === 0) return false;
  return !entry.previewOnly;
}

function resolveMergedOlderCursor(
  existing: CachedChatHistoryPage | null | undefined,
  incoming: Pick<ChatHistoryPageResult, "messages" | "hasMoreOlder" | "nextBeforeMessageId">,
): { hasMoreOlder: boolean; nextBeforeMessageId: number | null } {
  const existingHead = existing?.messages[0]?.telegram_message_id ?? 0;
  const incomingHead = incoming.messages[0]?.telegram_message_id ?? 0;
  const mergedHead =
    existingHead > 0 && incomingHead > 0
      ? Math.min(existingHead, incomingHead)
      : existingHead || incomingHead;
  const existingNext = existing?.nextBeforeMessageId ?? null;
  const incomingNext = incoming.nextBeforeMessageId;
  let nextBeforeMessageId: number | null = null;
  for (const candidate of [existingNext, incomingNext, mergedHead > 0 ? mergedHead : null]) {
    if (candidate == null || candidate <= 0) continue;
    if (nextBeforeMessageId == null || candidate < nextBeforeMessageId) {
      nextBeforeMessageId = candidate;
    }
  }
  const hasMoreOlder =
    Boolean(existing?.hasMoreOlder) ||
    Boolean(incoming.hasMoreOlder) ||
    (mergedHead > 0 &&
      nextBeforeMessageId != null &&
      nextBeforeMessageId <= mergedHead);
  return { hasMoreOlder, nextBeforeMessageId };
}

function commitCachedChatHistoryEntry(chatId: number, entry: CachedChatHistoryPage): void {
  const prev = cache.get(chatId);
  const contentChanged = !prev || cachePageSignature(prev) !== cachePageSignature(entry);
  cache.set(chatId, entry);
  if (!contentChanged) return;
  writeSessionCache(chatId, entry);
  trimCache();
  emitCacheUpdate(chatId);
}

export function setCachedChatHistory(
  chatId: number,
  page: ChatHistoryPageResult,
  options?: { previewOnly?: boolean; aroundUnread?: boolean; aroundMessageId?: number | null },
): void {
  if (page.error) return;
  const previewOnly = options?.previewOnly === true;
  const aroundUnread = options?.aroundUnread === true;
  const aroundMessageId =
    typeof options?.aroundMessageId === "number" &&
    Number.isFinite(options.aroundMessageId) &&
    options.aroundMessageId > 0
      ? Math.trunc(options.aroundMessageId)
      : null;
  const existing = getCachedChatHistory(chatId);
  // Never let a short preview lane wipe a longer full thread (open/full prefetch).
  if (
    previewOnly &&
    existing &&
    !existing.previewOnly &&
    existing.messages.length > 0
  ) {
    if (page.messages.length > 0) {
      mergeCachedChatHistoryTail(chatId, page);
    }
    return;
  }
  if (
    previewOnly &&
    existing &&
    existing.previewOnly &&
    existing.messages.length > page.messages.length
  ) {
    mergeCachedChatHistoryTail(chatId, page);
    return;
  }
  // Never let a shorter overlapping page wipe a longer thread (prefetch 30 vs open 197).
  if (
    existing &&
    !previewOnly &&
    !existing.previewOnly &&
    existing.messages.length > 0 &&
    page.messages.length > 0
  ) {
    const existingMax =
      existing.messages[existing.messages.length - 1]!.telegram_message_id;
    const pageMax = page.messages[page.messages.length - 1]!.telegram_message_id;
    const existingMin = existing.messages[0]!.telegram_message_id;
    const pageMin = page.messages[0]!.telegram_message_id;
    const pageIsSubsetOrOverlap =
      page.messages.length <= existing.messages.length &&
      pageMax <= existingMax &&
      pageMin >= existingMin;
    if (pageMax < existingMax || pageIsSubsetOrOverlap || page.messages.length < existing.messages.length) {
      mergeCachedChatHistoryTail(chatId, page);
      return;
    }
  }
  const olderCursor = resolveMergedOlderCursor(existing, page);
  commitCachedChatHistoryEntry(chatId, {
    ...page,
    hasMoreOlder: olderCursor.hasMoreOlder,
    nextBeforeMessageId: olderCursor.nextBeforeMessageId,
    fetchedAt: Date.now(),
    previewOnly,
    aroundUnread,
    ...(aroundMessageId != null ? { aroundMessageId } : {}),
  });
}

/** Merge a live tail poll into the cached first page without shrinking history. */
export function mergeCachedChatHistoryTail(
  chatId: number,
  tail: ChatHistoryPageResult,
): void {
  if (tail.error || tail.messages.length === 0) return;
  const existing = getCachedChatHistory(chatId);
  if (!existing) {
    setCachedChatHistory(chatId, tail);
    return;
  }
  const byId = new Map(existing.messages.map((row) => [row.telegram_message_id, row]));
  for (const row of tail.messages) {
    const prev = byId.get(row.telegram_message_id);
    byId.set(
      row.telegram_message_id,
      prev
        ? mergeHistoryMessageRow(prev, row)
        : enrichHistoryMessageDisplay(row),
    );
  }
  let messages = [...byId.values()].sort((a, b) => {
    const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
    if (byTime !== 0) return byTime;
    return a.telegram_message_id - b.telegram_message_id;
  });
  const trimmedFromOlder =
    messages.length > MESSAGE_CHAT_CACHE_MESSAGES_MAX
      ? messages.length - MESSAGE_CHAT_CACHE_MESSAGES_MAX
      : 0;
  if (trimmedFromOlder > 0) {
    messages = messages.slice(trimmedFromOlder);
  }
  const olderCursor = resolveMergedOlderCursor(existing, tail);
  const nextBeforeFromHead =
    messages.length > 0 ? messages[0]!.telegram_message_id : null;
  commitCachedChatHistoryEntry(chatId, {
    ...existing,
    ...tail,
    messages,
    hasMoreOlder:
      olderCursor.hasMoreOlder ||
      trimmedFromOlder > 0 ||
      (existing.messages.length > 0 &&
        messages.length > 0 &&
        messages[0]!.telegram_message_id < existing.messages[0]!.telegram_message_id),
    nextBeforeMessageId: olderCursor.nextBeforeMessageId ?? nextBeforeFromHead,
    lastReadOutboxMessageId:
      tail.lastReadOutboxMessageId ?? existing.lastReadOutboxMessageId,
    lastReadInboxMessageId:
      tail.lastReadInboxMessageId ?? existing.lastReadInboxMessageId,
    fetchedAt: Date.now(),
    previewOnly: existing.previewOnly,
    aroundUnread: existing.aroundUnread,
    ...(existing.aroundMessageId != null ? { aroundMessageId: existing.aroundMessageId } : {}),
  });
}

/** Append or update rows after send/edit without wiping a longer cached thread. */
export function mergeCachedChatHistoryMessages(
  chatId: number,
  rows: ChatHistoryPageResult["messages"],
  meta?: Pick<ChatHistoryPageResult, "lastReadOutboxMessageId">,
): void {
  if (rows.length === 0) return;
  mergeCachedChatHistoryTail(chatId, {
    messages: rows,
    chatKind: null,
    error: null,
    hasMoreOlder: false,
    nextBeforeMessageId: null,
    lastReadOutboxMessageId: meta?.lastReadOutboxMessageId ?? null,
    memberCount: null,
    selfUserId: null,
  });
}

export function invalidateChatHistoryCache(chatId: number): void {
  cache.delete(chatId);
}
