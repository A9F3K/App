import {
  getChatScrollPosition,
  type CachedChatScrollPosition,
} from "../../messageChatScrollCache";
import type { MessageChatRowData } from "./MessageChatRow";

export type ChatOpenScrollPlan = {
  openingUnreadCount: number;
  openAnchor: "top" | "bottom";
  pinMessagesToBottom: boolean;
  followingBottom: boolean;
  pendingInitialScroll: boolean;
  pendingScrollRestore: CachedChatScrollPosition | null;
  /** Open scrolled to the unread divider (telegram-tt MessageList). */
  scrollToUnreadDivider: boolean;
};

/** Ignore stale cache at scroll top — that is not a deliberate mid-read position. */
const RESTORE_CACHED_UNREAD_MIN_SCROLL_Y_PX = 48;

function cachedScrollY(cached: CachedChatScrollPosition): number {
  if (Number.isFinite(cached.scrollY)) return cached.scrollY!;
  if (Number.isFinite(cached.distanceFromBottom) && Number.isFinite(cached.contentH)) {
    return Math.max(0, cached.contentH - cached.distanceFromBottom);
  }
  return 0;
}

function isMeaningfulCachedUnreadScroll(cached: CachedChatScrollPosition): boolean {
  if (cached.followingBottom) return true;
  const scrollY = cachedScrollY(cached);
  if (scrollY > RESTORE_CACHED_UNREAD_MIN_SCROLL_Y_PX) return true;
  if (cached.anchorMessageId != null && cached.anchorMessageId > 0) {
    return scrollY > RESTORE_CACHED_UNREAD_MIN_SCROLL_Y_PX;
  }
  return false;
}

/** Resolve where the chat should open before the first paint (no useEffect lag). */
export function resolveChatOpenScrollPlan(chat: MessageChatRowData): ChatOpenScrollPlan {
  const openingUnreadCount = Math.max(
    0,
    Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
  );

  const cachedScroll = getChatScrollPosition(chat.telegram_chat_id);

  // Reload while reading unreads: restore the saved viewport instead of jumping to first unread.
  if (
    openingUnreadCount > 0 &&
    cachedScroll != null &&
    isMeaningfulCachedUnreadScroll(cachedScroll)
  ) {
    const restoreAtBottom = cachedScroll.followingBottom;
    return {
      openingUnreadCount,
      openAnchor: restoreAtBottom ? "bottom" : "top",
      pinMessagesToBottom: restoreAtBottom,
      followingBottom: restoreAtBottom,
      pendingInitialScroll: false,
      pendingScrollRestore: cachedScroll,
      scrollToUnreadDivider: false,
    };
  }

  if (openingUnreadCount > 0) {
    return {
      openingUnreadCount,
      openAnchor: "top",
      pinMessagesToBottom: false,
      followingBottom: false,
      pendingInitialScroll: true,
      pendingScrollRestore: null,
      scrollToUnreadDivider: true,
    };
  }

  if (cachedScroll) {
    const restoreAtBottom = cachedScroll.followingBottom;
    // Cached "at bottom" is a scroll position only — keep FAB visible while unreads remain.
    const followingBottom = restoreAtBottom && openingUnreadCount <= 0;
    return {
      openingUnreadCount,
      openAnchor: restoreAtBottom ? "bottom" : "top",
      pinMessagesToBottom: restoreAtBottom,
      followingBottom,
      pendingInitialScroll: false,
      pendingScrollRestore: cachedScroll,
      scrollToUnreadDivider: false,
    };
  }

  const openAnchor: "top" | "bottom" = "bottom";
  const followingBottom = openAnchor === "bottom";
  return {
    openingUnreadCount,
    openAnchor,
    pinMessagesToBottom: followingBottom,
    followingBottom,
    pendingInitialScroll: true,
    pendingScrollRestore: null,
    scrollToUnreadDivider: false,
  };
}
