import {
  getChatScrollPosition,
  type CachedChatScrollPosition,
} from "../../messageChatScrollCache";
import type { ChatHistoryCacheAnchorSpec } from "../../messageChatHistoryCache";
import {
  MESSAGE_CHAT_HISTORY_AROUND_UNREAD_OLDER,
  MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER,
  MESSAGE_CHAT_HISTORY_OPEN_OLDER_BUFFER,
  MESSAGE_CHAT_HISTORY_OPEN_UNREAD_LIMIT_MAX,
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
} from "./messageChatLayout";
import { CHAT_HISTORY_WINDOW_N } from "./chatHistoryWindowBudget";
import type { MessageChatRowData } from "./MessageChatRow";

/** Full bidirectional open window (2N) when one side of history is exhausted. */
const OPEN_WINDOW_2N = CHAT_HISTORY_WINDOW_N * 2;

/** Ignore stale cache at scroll top — that is not a deliberate mid-read position. */
const RESTORE_CACHED_UNREAD_MIN_SCROLL_Y_PX = 48;

/**
 * Fully-read chats must open at the latest messages (Telegram). Only restore a
 * mid-thread viewport when the saved Y is clearly not a stuck/open-at-top paint.
 */
const RESTORE_READ_CHAT_MIN_SCROLL_Y_PX = 48;

export type ChatOpenSessionMode =
  | "bottom"
  | "unread_divider"
  | "restore"
  | "around_anchor";

export type ChatOpenFetchKind = "around_message" | "around_unread" | "tail";

export type ChatOpenFetchSpec = {
  kind: ChatOpenFetchKind;
  anchorMessageId: number | null;
  olderBudgetRows: number;
  newerBudgetRows: number;
  /** Prefetch / TDLib first-page limit. */
  limit: number;
  aroundUnread: boolean;
  olderAbove: number | null;
  newerBelow: number | null;
};

export type ChatOpenScrollSpec = {
  followingBottom: boolean;
  pinToBottom: boolean;
  restore: CachedChatScrollPosition | null;
  alignUnreadDivider: boolean;
  openAnchor: "top" | "bottom";
  pendingInitialScroll: boolean;
};

export type ChatOpenSession = {
  mode: ChatOpenSessionMode;
  openingUnreadCount: number;
  fetch: ChatOpenFetchSpec;
  scroll: ChatOpenScrollSpec;
  displayAnchorMessageId: number | null;
};

/** @deprecated Prefer ChatOpenSession.scroll fields via resolveChatOpenSession. */
export type ChatOpenScrollPlan = {
  openingUnreadCount: number;
  openAnchor: "top" | "bottom";
  pinMessagesToBottom: boolean;
  followingBottom: boolean;
  pendingInitialScroll: boolean;
  pendingScrollRestore: CachedChatScrollPosition | null;
  scrollToUnreadDivider: boolean;
};

function cachedScrollY(cached: CachedChatScrollPosition): number {
  if (Number.isFinite(cached.scrollY)) return cached.scrollY!;
  if (Number.isFinite(cached.distanceFromBottom) && Number.isFinite(cached.contentH)) {
    return Math.max(0, cached.contentH - cached.distanceFromBottom);
  }
  return 0;
}

/** True when saved scroll is a real mid-thread position (not a stale top/empty entry). */
export function isMeaningfulCachedUnreadScroll(cached: CachedChatScrollPosition): boolean {
  if (cached.followingBottom) return true;
  const hasAnchor =
    cached.anchorMessageId != null &&
    Number.isFinite(cached.anchorMessageId) &&
    cached.anchorMessageId > 0;
  // After reload, contentH from the previous paint cannot be trusted — a saved
  // viewport message id is enough to reopen mid-thread instead of the unread divider.
  if (hasAnchor) return true;
  const scrollY = cachedScrollY(cached);
  // Bare scrollY from a failed/partial open settle must not skip the unread divider.
  return scrollY > RESTORE_CACHED_UNREAD_MIN_SCROLL_Y_PX;
}

/**
 * For chats with no unreads: restore only a deliberate mid-list read.
 * Stale top paints (scrollY≈0 after a bad open / short-history head) must not
 * reopen the oldest rows — Telegram shows the bottom when everything is read.
 * `followingBottom: true` with scrollY≈0 is still a bottom open (not mid-list).
 */
export function isRestorableCachedScrollForReadChat(
  cached: CachedChatScrollPosition,
): boolean {
  if (cached.followingBottom) {
    // Poisoned saves claimed followingBottom while parked at the oldest rows —
    // still restore as a bottom open (caller uses followingBottom path), not mid-list.
    return true;
  }
  const scrollY = cachedScrollY(cached);
  if (scrollY > RESTORE_READ_CHAT_MIN_SCROLL_Y_PX) {
    // Near-bottom saves should reopen as bottom, not a fragile mid restore.
    if (
      Number.isFinite(cached.distanceFromBottom) &&
      cached.distanceFromBottom <= 80
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function positiveId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return 0;
  return Math.trunc(id);
}

function aroundMessageFetch(anchorMessageId: number): ChatOpenFetchSpec {
  return {
    kind: "around_message",
    anchorMessageId,
    olderBudgetRows: MESSAGE_CHAT_HISTORY_OPEN_OLDER_BUFFER,
    newerBudgetRows: MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER,
    limit:
      MESSAGE_CHAT_HISTORY_OPEN_OLDER_BUFFER +
      MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER +
      2,
    aroundUnread: false,
    olderAbove: MESSAGE_CHAT_HISTORY_OPEN_OLDER_BUFFER,
    newerBelow: MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER,
  };
}

function aroundUnreadFetch(unreadCount: number): ChatOpenFetchSpec {
  return {
    kind: "around_unread",
    anchorMessageId: null,
    olderBudgetRows: MESSAGE_CHAT_HISTORY_AROUND_UNREAD_OLDER,
    newerBudgetRows: MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER,
    limit: Math.min(
      MESSAGE_CHAT_HISTORY_OPEN_UNREAD_LIMIT_MAX,
      Math.max(
        OPEN_WINDOW_2N,
        MESSAGE_CHAT_HISTORY_PAGE_SIZE,
        unreadCount + MESSAGE_CHAT_HISTORY_AROUND_UNREAD_OLDER + 8,
      ),
    ),
    aroundUnread: true,
    olderAbove: MESSAGE_CHAT_HISTORY_AROUND_UNREAD_OLDER,
    newerBelow: MESSAGE_CHAT_HISTORY_OPEN_NEWER_BUFFER,
  };
}

function tailFetchFallback(): ChatOpenFetchSpec {
  return {
    kind: "tail",
    anchorMessageId: null,
    // At chat end: redistribute unused newer budget → up to 2N older.
    olderBudgetRows: OPEN_WINDOW_2N,
    newerBudgetRows: 0,
    limit: Math.max(MESSAGE_CHAT_HISTORY_PAGE_SIZE, OPEN_WINDOW_2N),
    aroundUnread: false,
    olderAbove: OPEN_WINDOW_2N,
    newerBelow: 0,
  };
}

/**
 * Universal open session: one fetch + scroll + display-anchor decision for
 * prefetch, cache match, and MessageList network load.
 */
export function resolveChatOpenSession(chat: MessageChatRowData): ChatOpenSession {
  const openingUnreadCount = Math.max(
    0,
    Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
  );
  const cachedScroll = getChatScrollPosition(chat.telegram_chat_id);
  const tailId = positiveId(chat.last_message_telegram_id);
  const readId = positiveId(chat.last_read_inbox_message_id);

  const canRestoreCached =
    cachedScroll != null &&
    (openingUnreadCount <= 0
      ? isRestorableCachedScrollForReadChat(cachedScroll)
      : isMeaningfulCachedUnreadScroll(cachedScroll));

  // Restore mid-read (including while unreads remain). Fully-read chats only
  // restore a real mid-list Y — never a stuck top open (scrollY≈0).
  if (canRestoreCached && cachedScroll != null) {
    const restoreAtBottom = cachedScroll.followingBottom;
    const cachedAnchor = positiveId(cachedScroll.anchorMessageId);
    const followingBottom = restoreAtBottom && openingUnreadCount <= 0;
    const anchorForFetch =
      !restoreAtBottom && cachedAnchor > 0
        ? cachedAnchor
        : restoreAtBottom && tailId > 0
          ? tailId
          : cachedAnchor > 0
            ? cachedAnchor
            : tailId > 0
              ? tailId
              : readId;

    const mode: ChatOpenSessionMode =
      !restoreAtBottom && cachedAnchor > 0
        ? "around_anchor"
        : restoreAtBottom
          ? "bottom"
          : "restore";

    return {
      mode,
      openingUnreadCount,
      fetch:
        anchorForFetch > 0 ? aroundMessageFetch(anchorForFetch) : tailFetchFallback(),
      scroll: {
        followingBottom,
        pinToBottom: restoreAtBottom,
        // Bottom opens must pin to the live tail — never replay a saved scrollY≈0
        // (poisoned followingBottom caches used to restore the oldest rows).
        restore: restoreAtBottom ? null : cachedScroll,
        alignUnreadDivider: false,
        openAnchor: restoreAtBottom ? "bottom" : "top",
        // Wait for history + layouts before revealing — same settle path as unread/bottom.
        pendingInitialScroll: true,
      },
      displayAnchorMessageId: anchorForFetch > 0 ? anchorForFetch : null,
    };
  }

  // First open with unreads → unread divider + around-unread fetch.
  if (openingUnreadCount > 0) {
    return {
      mode: "unread_divider",
      openingUnreadCount,
      fetch: aroundUnreadFetch(openingUnreadCount),
      scroll: {
        followingBottom: false,
        pinToBottom: false,
        restore: null,
        alignUnreadDivider: true,
        openAnchor: "top",
        pendingInitialScroll: true,
      },
      displayAnchorMessageId: null,
    };
  }

  // Default: open at bottom with older context around the tail message.
  return {
    mode: "bottom",
    openingUnreadCount,
    fetch: tailId > 0 ? aroundMessageFetch(tailId) : tailFetchFallback(),
    scroll: {
      followingBottom: true,
      pinToBottom: true,
      restore: null,
      alignUnreadDivider: false,
      openAnchor: "bottom",
      pendingInitialScroll: true,
    },
    displayAnchorMessageId: tailId > 0 ? tailId : null,
  };
}

/** Legacy shape used by MessageList open-settle wiring. */
export function resolveChatOpenScrollPlan(chat: MessageChatRowData): ChatOpenScrollPlan {
  const session = resolveChatOpenSession(chat);
  return {
    openingUnreadCount: session.openingUnreadCount,
    openAnchor: session.scroll.openAnchor,
    pinMessagesToBottom: session.scroll.pinToBottom,
    followingBottom: session.scroll.followingBottom,
    pendingInitialScroll: session.scroll.pendingInitialScroll,
    pendingScrollRestore: session.scroll.restore,
    scrollToUnreadDivider: session.scroll.alignUnreadDivider,
  };
}

/** Message id to seed around-fetch / display slice (0 for unread-divider until messages land). */
export function resolveOpenHistoryFetchAnchor(
  chat: Pick<MessageChatRowData, "last_message_telegram_id" | "last_read_inbox_message_id">,
  plan: ChatOpenScrollPlan,
): number {
  if (plan.scrollToUnreadDivider) return 0;
  const cachedAnchor = plan.pendingScrollRestore?.anchorMessageId;
  if (cachedAnchor != null && cachedAnchor > 0) return Math.trunc(cachedAnchor);
  if (plan.openAnchor === "bottom" || plan.followingBottom) {
    return positiveId(chat.last_message_telegram_id);
  }
  return (
    positiveId(chat.last_read_inbox_message_id) ||
    positiveId(chat.last_message_telegram_id)
  );
}

export function chatOpenSessionToCacheAnchorSpec(
  session: ChatOpenSession,
): ChatHistoryCacheAnchorSpec {
  return {
    aroundUnread: session.fetch.aroundUnread,
    aroundMessageId: session.fetch.anchorMessageId,
  };
}

export function getOpenChatHistoryCacheAnchorSpec(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "unread_count"> &
    Partial<Pick<MessageChatRowData, "last_message_telegram_id" | "last_read_inbox_message_id">>,
): ChatHistoryCacheAnchorSpec {
  return chatOpenSessionToCacheAnchorSpec(
    resolveChatOpenSession(chat as MessageChatRowData),
  );
}

/** Load around the inbox read cursor when the chat has unreads on first open. */
export function shouldPrefetchHistoryAroundUnread(
  chat: Pick<MessageChatRowData, "telegram_chat_id" | "unread_count">,
): boolean {
  return resolveChatOpenSession(chat as MessageChatRowData).mode === "unread_divider";
}
