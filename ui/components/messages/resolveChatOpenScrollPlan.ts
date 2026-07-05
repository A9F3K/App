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
  /** Open at the first unread bubble (Telegram-style) instead of the latest tail. */
  scrollToFirstUnread: boolean;
};

/** Resolve where the chat should open before the first paint (no useEffect lag). */
export function resolveChatOpenScrollPlan(chat: MessageChatRowData): ChatOpenScrollPlan {
  const openingUnreadCount = Math.max(
    0,
    Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
  );

  const cachedScroll = getChatScrollPosition(chat.telegram_chat_id);

  // Reload while reading unreads: restore the saved viewport instead of jumping to first unread.
  if (openingUnreadCount > 0 && cachedScroll != null) {
    const restoreAtBottom = cachedScroll.followingBottom;
    return {
      openingUnreadCount,
      openAnchor: restoreAtBottom ? "bottom" : "top",
      pinMessagesToBottom: restoreAtBottom,
      followingBottom: restoreAtBottom,
      pendingInitialScroll: false,
      pendingScrollRestore: cachedScroll,
      scrollToFirstUnread: false,
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
      scrollToFirstUnread: true,
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
      scrollToFirstUnread: false,
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
    scrollToFirstUnread: false,
  };
}
