export type CachedChatScrollPosition = {
  scrollY: number;
  contentH: number;
  followingBottom: boolean;
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

function hydrateFromSession(chatId: number): CachedChatScrollPosition | null {
  const entry = readSessionCache()[String(chatId)];
  if (!entry || !Number.isFinite(entry.scrollY) || !Number.isFinite(entry.contentH)) return null;
  if (Date.now() - entry.savedAt > MAX_AGE_MS) return null;
  memory.set(chatId, entry);
  return entry;
}

export function saveChatScrollPosition(
  chatId: number,
  state: Omit<CachedChatScrollPosition, "savedAt">,
): void {
  if (!Number.isFinite(chatId)) return;
  const entry: CachedChatScrollPosition = { ...state, savedAt: Date.now() };
  memory.set(chatId, entry);
  writeSessionCache(chatId, entry);
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
