export type CachedChatScrollPosition = {
  /** Distance from viewport bottom — survives media resize (telegram-tt). */
  distanceFromBottom: number;
  /** Legacy field — kept for session cache migration. */
  scrollY?: number;
  contentH: number;
  followingBottom: boolean;
  /** Top-of-viewport message when scroll was saved — used to load a tight window on reopen. */
  anchorMessageId?: number;
  /**
   * Distance from the viewport top to the top of `anchorMessageId` when saved.
   * Prefer this over distanceFromBottom after reload — contentH usually differs.
   */
  anchorOffsetFromViewportTop?: number;
  savedAt: number;
};

const memory = new Map<number, CachedChatScrollPosition>();
const SESSION_STORAGE_KEY = "hyperlinks_chat_scroll_cache_v1";
const MAX_ENTRIES = 32;
const MAX_AGE_MS = 30 * 60_000;

function readSessionCache(): Record<string, CachedChatScrollPosition> {
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
    return parsed as Record<string, CachedChatScrollPosition>;
  } catch {
    return {};
  }
}

function writeSessionCache(chatId: number, entry: CachedChatScrollPosition): void {
  try {
    if (typeof globalThis === "undefined" || !("sessionStorage" in globalThis)) return;
    const store = readSessionCache();
    store[String(chatId)] = entry;
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      const sorted = keys.sort(
        (a, b) => (store[a]!.savedAt ?? 0) - (store[b]!.savedAt ?? 0),
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

function normalizeAnchorMessageId(raw: unknown): number | undefined {
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  return Math.trunc(id);
}

function normalizeDistanceFromBottom(entry: CachedChatScrollPosition): number {
  if (Number.isFinite(entry.distanceFromBottom)) {
    return Math.max(0, entry.distanceFromBottom);
  }
  const scrollY = Number(entry.scrollY);
  const contentH = Number(entry.contentH);
  if (Number.isFinite(scrollY) && Number.isFinite(contentH) && contentH > 0) {
    return Math.max(0, contentH - scrollY);
  }
  return 0;
}

function normalizeAnchorOffset(raw: unknown): number | undefined {
  const offset = Number(raw);
  if (!Number.isFinite(offset)) return undefined;
  return offset;
}

function hydrateFromSession(chatId: number): CachedChatScrollPosition | null {
  const entry = readSessionCache()[String(chatId)];
  if (!entry || !Number.isFinite(entry.contentH)) return null;
  if (Date.now() - entry.savedAt > MAX_AGE_MS) return null;
  const anchorMessageId = normalizeAnchorMessageId(entry.anchorMessageId);
  const anchorOffsetFromViewportTop = normalizeAnchorOffset(
    entry.anchorOffsetFromViewportTop,
  );
  const normalized: CachedChatScrollPosition = {
    ...entry,
    distanceFromBottom: normalizeDistanceFromBottom(entry),
    ...(anchorMessageId != null ? { anchorMessageId } : {}),
    ...(anchorOffsetFromViewportTop != null
      ? { anchorOffsetFromViewportTop }
      : {}),
  };
  memory.set(chatId, normalized);
  return normalized;
}

export function saveChatScrollPosition(
  chatId: number,
  state: Omit<CachedChatScrollPosition, "savedAt">,
): void {
  if (!Number.isFinite(chatId)) return;
  const distanceFromBottom = Number.isFinite(state.distanceFromBottom)
    ? Math.max(0, state.distanceFromBottom)
    : Math.max(0, state.contentH - (state.scrollY ?? 0));
  const entry: CachedChatScrollPosition = {
    ...state,
    distanceFromBottom,
    savedAt: Date.now(),
  };
  memory.set(chatId, entry);
  writeSessionCache(chatId, entry);
}

/** Compute scrollY from persisted distance-from-bottom for the current content height. */
export function scrollYFromCachedPosition(
  state: CachedChatScrollPosition,
  layoutH: number,
  contentH: number,
): number {
  if (contentH <= 0 || layoutH <= 0) return 0;
  if (state.followingBottom && contentH <= layoutH + 0.5) return 0;
  const maxScroll = Math.max(0, contentH - layoutH);
  if (state.followingBottom) return maxScroll;
  const distance = normalizeDistanceFromBottom(state);
  return Math.min(Math.max(0, contentH - distance), maxScroll);
}

export function getChatScrollPosition(chatId: number): CachedChatScrollPosition | null {
  if (!Number.isFinite(chatId)) return null;
  let entry = memory.get(chatId) ?? hydrateFromSession(chatId);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > MAX_AGE_MS) {
    memory.delete(chatId);
    return null;
  }
  return entry;
}

/** Drop one chat's saved scroll (memory + session). Used when forcing a fresh unread open. */
export function clearChatScrollPosition(chatId: number): void {
  if (!Number.isFinite(chatId)) return;
  memory.delete(chatId);
  try {
    if (typeof globalThis === "undefined" || !("sessionStorage" in globalThis)) return;
    const store = readSessionCache();
    delete store[String(chatId)];
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(store),
    );
  } catch {
    /* quota / private mode */
  }
}

/** Drop all saved scroll positions (memory + session). */
export function clearAllChatScrollPositions(): void {
  memory.clear();
  try {
    if (typeof globalThis === "undefined" || !("sessionStorage" in globalThis)) return;
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.removeItem(
      SESSION_STORAGE_KEY,
    );
  } catch {
    /* quota / private mode */
  }
}

/** Distance from viewport bottom (px) treated as "pinned to latest messages". */
export const CHAT_SCROLL_FOLLOW_BOTTOM_THRESHOLD_PX = 80;

export function isChatScrollNearBottom(
  scrollY: number,
  layoutH: number,
  contentH: number,
  thresholdPx = CHAT_SCROLL_FOLLOW_BOTTOM_THRESHOLD_PX,
): boolean {
  if (contentH <= layoutH + 0.5) return true;
  const maxScroll = Math.max(0, contentH - layoutH);
  return maxScroll - scrollY <= thresholdPx;
}
