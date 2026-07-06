/** Matches {@link AuthenticatedHomeLeftNavStrip} total strip height. */
export const MESSAGE_CHAT_HEADER_STRIP_HEIGHT_PX = 55;

/** Shared list row metrics — aligned with {@link AuthenticatedHomeFeedPanel} feed rows. */
export const MESSAGE_ROW_HEIGHT_PX = 40;
export const MESSAGE_AVATAR_PX = 30;
export const MESSAGE_ICON_TEXT_GAP_PX = 15;
export const MESSAGE_NAME_TIME_GAP_PX = 15;
export const MESSAGE_FONT_SIZE_PX = 15;
export const MESSAGE_LINE_HEIGHT_PX = 20;
/** Inline emoji sticker height in chat-list previews — Telegram ~18px for 15px preview text. */
export const MESSAGE_LIST_INLINE_EMOJI_SIZE_PX = Math.round(MESSAGE_FONT_SIZE_PX * 1.2);
/** Unread-count pill horizontal inset inside the 20px-tall badge. */
export const MESSAGE_UNREAD_BADGE_PADDING_X_PX = 5;

/** Scroll-to-bottom control in the open chat message column. */
export const MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX = 60;
export const MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX = 30;
export const MESSAGE_CHAT_SCROLL_TO_BOTTOM_ICON_BOTTOM_INSET_PX = 7.5;
export const MESSAGE_CHAT_SCROLL_TO_BOTTOM_BADGE_TOP_PX = 5;
export const MESSAGE_CHAT_LIST_UNREAD_MAX_DISPLAY = 99;
export const MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_MAX_DISPLAY = 999;
/** Show the scroll-to-bottom FAB without waiting for scroll when unreads exceed this count. */
export const MESSAGE_CHAT_FAB_ALWAYS_SHOW_UNREAD_THRESHOLD = 7;
/** Debounce before TDLib viewMessages while scrolling through unreads. */
export const VIEW_INBOX_DEBOUNCE_MS = 100;

export function formatMessageUnreadCountLabel(
  count: number,
  chatId: number,
  maxDisplay = MESSAGE_CHAT_LIST_UNREAD_MAX_DISPLAY,
): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count === chatId || count > 50_000) return "";
  if (count > maxDisplay) return `${maxDisplay}+`;
  return String(count);
}

/** Open-chat scroll-to-bottom FAB — higher cap than the chat list preview badge. */
export function formatScrollToBottomUnreadCountLabel(count: number, chatId: number): string {
  return formatMessageUnreadCountLabel(
    count,
    chatId,
    MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_MAX_DISPLAY,
  );
}

export type MessageScrollLayoutEntry = { y: number; height: number };

export function isMessageFullyVisibleInViewport(
  entry: MessageScrollLayoutEntry,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  return (
    entry.y >= viewportTop - 0.5 &&
    entry.y + entry.height <= viewportBottom + 0.5
  );
}

/** Topmost message intersecting the viewport — saved as the reopen scroll anchor. */
export function topViewportAnchorMessageId(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
): number | null {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let anchorId: number | null = null;
  let anchorY = Number.POSITIVE_INFINITY;

  for (const msg of messages) {
    const id = msg.telegram_message_id;
    const entry = layouts.get(id);
    if (!entry) continue;
    const bottom = entry.y + entry.height;
    if (bottom <= viewportTop + 0.5) continue;
    if (entry.y >= viewportBottom - 0.5) continue;
    if (entry.y < anchorY) {
      anchorY = entry.y;
      anchorId = id;
    }
  }

  return anchorId;
}

/** Highest message id that is fully visible in the viewport (open-chat unread baseline). */
export function maxFullyVisibleMessageId(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
): number {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let maxId = 0;
  for (const msg of messages) {
    const id = msg.telegram_message_id;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (isMessageFullyVisibleInViewport(entry, viewportTop, viewportBottom)) {
      maxId = Math.max(maxId, id);
    }
  }
  return maxId;
}

/** Lowest message id that is fully visible in the viewport. */
export function minFullyVisibleMessageId(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
): number {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let minId = 0;
  for (const msg of messages) {
    const id = msg.telegram_message_id;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (isMessageFullyVisibleInViewport(entry, viewportTop, viewportBottom)) {
      if (minId <= 0 || id < minId) minId = id;
    }
  }
  return minId;
}

function isMessageIntersectingViewport(
  entry: MessageScrollLayoutEntry,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  const bottom = entry.y + entry.height;
  return bottom > viewportTop + 0.5 && entry.y < viewportBottom - 0.5;
}

/** Lowest message id that intersects the viewport (fully or partially). */
export function minIntersectingMessageId(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
): number | null {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let minId: number | null = null;

  for (const msg of messages) {
    const id = msg.telegram_message_id;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (!isMessageIntersectingViewport(entry, viewportTop, viewportBottom)) continue;
    if (minId == null || id < minId) minId = id;
  }

  return minId;
}

/** Newer-than-baseline messages visible in the viewport (fully or partially). */
export function collectFullyVisibleUnreadMessageIds(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
  minUnreadMessageIdExclusive: number,
  alreadyReadIds?: ReadonlySet<number>,
): number[] {
  if (messages.length === 0) return [];

  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  const readIds = alreadyReadIds ?? new Set<number>();
  const newlyRead: number[] = [];

  for (const msg of messages) {
    const id = msg.telegram_message_id;
    if (id <= minUnreadMessageIdExclusive) continue;
    if (readIds.has(id)) continue;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (isMessageIntersectingViewport(entry, viewportTop, viewportBottom)) {
      newlyRead.push(id);
    }
  }

  return newlyRead;
}

/** Highest newer-than-baseline message intersecting the viewport — TDLib read cursor advances to max. */
export function maxIntersectingUnreadMessageId(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
  minUnreadMessageIdExclusive: number,
): number | null {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let maxId: number | null = null;

  for (const msg of messages) {
    const id = msg.telegram_message_id;
    if (id <= minUnreadMessageIdExclusive) continue;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (!isMessageIntersectingViewport(entry, viewportTop, viewportBottom)) continue;
    if (maxId == null || id > maxId) maxId = id;
  }

  return maxId;
}

/** Lowest newer-than-baseline message intersecting the viewport — one mark per scroll tick. */
export function collectNextUnreadMessageIdToMark(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
  minUnreadMessageIdExclusive: number,
  alreadyReadIds?: ReadonlySet<number>,
): number | null {
  const viewportTop = metrics.scrollY;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  const readIds = alreadyReadIds ?? new Set<number>();
  let nextId: number | null = null;

  for (const msg of messages) {
    const id = msg.telegram_message_id;
    if (id <= minUnreadMessageIdExclusive) continue;
    if (readIds.has(id)) continue;
    const entry = layouts.get(id);
    if (!entry) continue;
    if (!isMessageIntersectingViewport(entry, viewportTop, viewportBottom)) continue;
    if (nextId == null || id < nextId) nextId = id;
  }

  return nextId;
}

/** Remaining unreads = opening count minus messages fully seen while scrolling. */
export function computeRemainingUnreadCount(
  openingUnreadCount: number,
  fullyReadMessageIds: ReadonlySet<number>,
): number {
  const openingUnread = Math.max(0, Math.trunc(openingUnreadCount));
  if (openingUnread <= 0) return 0;
  const readCount = Math.min(openingUnread, fullyReadMessageIds.size);
  return Math.max(0, openingUnread - readCount);
}

/** First unread message in a loaded history page (id strictly after inbox read cursor). */
export function resolveFirstUnreadMessageId(
  messages: readonly { telegram_message_id: number }[],
  lastReadInboxMessageId: number | null | undefined,
): number | null {
  if (messages.length === 0) return null;
  const floor =
    typeof lastReadInboxMessageId === "number" &&
    Number.isFinite(lastReadInboxMessageId) &&
    lastReadInboxMessageId > 0
      ? Math.trunc(lastReadInboxMessageId)
      : 0;
  for (const msg of messages) {
    if (msg.telegram_message_id > floor) {
      return msg.telegram_message_id;
    }
  }
  return null;
}

/** Last read message present in a loaded history page (at or below inbox read cursor). */
export function resolveLastReadMessageId(
  messages: readonly { telegram_message_id: number }[],
  lastReadInboxMessageId: number | null | undefined,
): number | null {
  if (messages.length === 0) return null;
  const readCursor =
    typeof lastReadInboxMessageId === "number" &&
    Number.isFinite(lastReadInboxMessageId) &&
    lastReadInboxMessageId > 0
      ? Math.trunc(lastReadInboxMessageId)
      : 0;

  if (readCursor > 0) {
    let lastAtOrBelow: number | null = null;
    for (const msg of messages) {
      if (msg.telegram_message_id <= readCursor) {
        lastAtOrBelow = msg.telegram_message_id;
      }
    }
    if (lastAtOrBelow != null) return lastAtOrBelow;
  }

  const firstUnread = resolveFirstUnreadMessageId(messages, lastReadInboxMessageId);
  if (firstUnread == null) return null;
  let prior: number | null = null;
  for (const msg of messages) {
    if (msg.telegram_message_id >= firstUnread) break;
    prior = msg.telegram_message_id;
  }
  return prior;
}

/** Count inbox-unread messages whose bottom edge is below the viewport (FAB badge). */
export function countUnreadMessagesBelowViewport(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  metrics: { scrollY: number; layoutH: number },
  lastReadInboxMessageId: number | null | undefined,
): number {
  const floor =
    typeof lastReadInboxMessageId === "number" &&
    Number.isFinite(lastReadInboxMessageId) &&
    lastReadInboxMessageId > 0
      ? Math.trunc(lastReadInboxMessageId)
      : 0;
  const viewportBottom = metrics.scrollY + metrics.layoutH;
  let count = 0;
  for (const msg of messages) {
    const id = msg.telegram_message_id;
    if (id <= floor) continue;
    const entry = layouts.get(id);
    if (!entry) {
      count += 1;
      continue;
    }
    if (entry.y + entry.height > viewportBottom + 0.5) {
      count += 1;
    }
  }
  return count;
}

/** Scroll offset that places a message block's bottom edge on the viewport bottom. */
export function scrollYToAlignMessageBottomEdge(
  entry: { y: number; height: number },
  viewportHeight: number,
  contentHeight: number,
): number {
  const messageBottom = entry.y + entry.height;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  return Math.min(maxScroll, Math.max(0, messageBottom - viewportHeight));
}

/** telegram-tt UNREAD_DIVIDER_TOP — gap above the unread divider when opening a chat. */
export const UNREAD_DIVIDER_TOP_PX = 10;
/** Approximate rendered height of the unread divider row. */
export const UNREAD_DIVIDER_ROW_HEIGHT_PX = 28;

/** Scroll offset that places the unread divider near the top of the viewport (telegram-tt open). */
export function scrollYToAlignUnreadDivider(
  firstUnreadEntry: { y: number; height: number },
  viewportHeight: number,
  contentHeight: number,
): number {
  const dividerTop = firstUnreadEntry.y - UNREAD_DIVIDER_ROW_HEIGHT_PX;
  const targetY = dividerTop - UNREAD_DIVIDER_TOP_PX;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  return Math.min(maxScroll, Math.max(0, targetY));
}

/** Loaded history includes the chat's latest message (not a stale preview tail). */
export function isAtLoadedChatTail(
  loadedTailMessageId: number,
  chatTailMessageId?: number | null,
): boolean {
  if (
    chatTailMessageId == null ||
    !Number.isFinite(chatTailMessageId) ||
    chatTailMessageId <= 0
  ) {
    return true;
  }
  return loadedTailMessageId >= Math.trunc(chatTailMessageId);
}

/** Vertical rhythm for authenticated home Feed / Messages lists. */
export const LIST_TOP_INSET_PX = 15;
export const LIST_ROW_GAP_PX = 15;
export const LIST_BOTTOM_INSET_PX = 15;
/** Wide-layout row press highlight: padding above/below the 40px row content. */
export const LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX = 7.5;

export function chatListShellTopInsetPx(widePressHighlight: boolean): number {
  return widePressHighlight ? LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX : LIST_TOP_INSET_PX;
}

/** Per-row scroll stride in the home chat list (row content + inter-row rhythm). */
export function chatListRowStridePx(widePressHighlight: boolean): number {
  return widePressHighlight
    ? MESSAGE_ROW_HEIGHT_PX + 2 * LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX
    : MESSAGE_ROW_HEIGHT_PX + LIST_ROW_GAP_PX;
}

export function homeListShellStyle(widePressHighlight: boolean) {
  return {
    paddingTop: chatListShellTopInsetPx(widePressHighlight),
    paddingBottom: widePressHighlight
      ? LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX
      : LIST_BOTTOM_INSET_PX,
    width: "100%" as const,
    alignSelf: "stretch" as const,
  };
}

/** @deprecated Use {@link LIST_ROW_GAP_PX}. */
export const MESSAGE_ROW_MARGIN_BOTTOM_PX = LIST_ROW_GAP_PX;
