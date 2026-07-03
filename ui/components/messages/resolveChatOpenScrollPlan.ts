import {
  getChatScrollPosition,
  type CachedChatScrollPosition,
} from "../../messageChatScrollCache";
import { MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD } from "./messageListLayout";
import type { MessageChatRowData } from "./MessageChatRow";

export type ChatOpenScrollPlan = {
  openingUnreadCount: number;
  openAnchor: "top" | "bottom";
  pinMessagesToBottom: boolean;
  followingBottom: boolean;
  pendingInitialScroll: boolean;
  pendingScrollRestore: CachedChatScrollPosition | null;
};

/** Resolve where the chat should open before the first paint (no useEffect lag). */
export function resolveChatOpenScrollPlan(chat: MessageChatRowData): ChatOpenScrollPlan {
  const openingUnreadCount = Math.max(
    0,
    Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
  );
  const unreadOpensAtTop =
    openingUnreadCount > MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD;
  const openAnchor: "top" | "bottom" = unreadOpensAtTop ? "top" : "bottom";

  const cachedScroll = getChatScrollPosition(chat.telegram_chat_id);
  if (cachedScroll) {
    const followingBottom = cachedScroll.followingBottom;
    return {
      openingUnreadCount,
      openAnchor: followingBottom ? "bottom" : "top",
      pinMessagesToBottom: followingBottom,
      followingBottom,
      pendingInitialScroll: false,
      pendingScrollRestore: cachedScroll,
    };
  }

  const followingBottom = openAnchor === "bottom";
  return {
    openingUnreadCount,
    openAnchor,
    pinMessagesToBottom: followingBottom,
    followingBottom,
    pendingInitialScroll: true,
    pendingScrollRestore: null,
  };
}
