import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";

/** Rows rendered around the scroll anchor (telegram-tt MESSAGE_LIST_SLICE). */
export const MESSAGE_LIST_SLICE = 40;

/** Max rows kept in the in-memory buffer around the anchor. */
export const MESSAGE_LIST_VIEWPORT_LIMIT = MESSAGE_LIST_SLICE * 2;

export type CountSliceBounds = {
  startIndex: number;
  endIndex: number;
};

function findMessageIndexById(
  messages: readonly MessageChatHistoryItem[],
  messageId: number,
): number {
  if (messageId <= 0) return -1;
  return messages.findIndex((row) => row.telegram_message_id === messageId);
}

/** Contiguous slice of `sliceSize` rows above and below `anchorIndex`. */
export function sliceMessagesByCount(
  messages: readonly MessageChatHistoryItem[],
  anchorIndex: number,
  sliceSize = MESSAGE_LIST_SLICE,
): CountSliceBounds {
  if (messages.length === 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  const anchor = Math.max(0, Math.min(anchorIndex, messages.length - 1));
  const startIndex = Math.max(0, anchor - sliceSize);
  const endIndex = Math.min(messages.length - 1, anchor + sliceSize);
  return { startIndex, endIndex };
}

export function sliceMessagesByCountAroundId(
  messages: readonly MessageChatHistoryItem[],
  anchorMessageId: number,
  sliceSize = MESSAGE_LIST_SLICE,
): CountSliceBounds {
  const anchorIndex = findMessageIndexById(messages, anchorMessageId);
  if (anchorIndex < 0) {
    if (messages.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }
    return sliceMessagesByCount(messages, messages.length - 1, sliceSize);
  }
  return sliceMessagesByCount(messages, anchorIndex, sliceSize);
}

/** Trim loaded buffer to at most `maxRows` centered on `anchorMessageId`. */
export function trimMessagesAroundAnchorCount(
  messages: MessageChatHistoryItem[],
  anchorMessageId: number,
  maxRows = MESSAGE_LIST_VIEWPORT_LIMIT,
): MessageChatHistoryItem[] {
  if (messages.length <= maxRows) return messages;
  const anchorIndex = findMessageIndexById(messages, anchorMessageId);
  if (anchorIndex < 0) return messages;
  const half = Math.floor(maxRows / 2);
  let startIndex = Math.max(0, anchorIndex - half);
  let endIndex = Math.min(messages.length - 1, startIndex + maxRows - 1);
  if (endIndex - startIndex + 1 < maxRows) {
    startIndex = Math.max(0, endIndex - maxRows + 1);
  }
  return messages.slice(startIndex, endIndex + 1);
}

/** Expand display slice toward older rows already in the buffer (no API fetch). */
export function canExpandDisplaySliceOlder(
  loadedMessages: readonly MessageChatHistoryItem[],
  displayStartIndex: number,
): boolean {
  return displayStartIndex > 0;
}

export function expandDisplaySliceOlder(
  loadedMessages: readonly MessageChatHistoryItem[],
  currentBounds: CountSliceBounds,
  expandBy = MESSAGE_LIST_SLICE,
): CountSliceBounds {
  if (currentBounds.endIndex < currentBounds.startIndex) return currentBounds;
  const startIndex = Math.max(0, currentBounds.startIndex - expandBy);
  return { startIndex, endIndex: currentBounds.endIndex };
}

/** Expand display slice toward newer rows already in the buffer (no API fetch). */
export function canExpandDisplaySliceNewer(
  loadedMessages: readonly MessageChatHistoryItem[],
  displayEndIndex: number,
): boolean {
  return (
    loadedMessages.length > 0 &&
    displayEndIndex >= 0 &&
    displayEndIndex < loadedMessages.length - 1
  );
}

export function expandDisplaySliceNewer(
  loadedMessages: readonly MessageChatHistoryItem[],
  currentBounds: CountSliceBounds,
  expandBy = MESSAGE_LIST_SLICE,
): CountSliceBounds {
  if (currentBounds.endIndex < currentBounds.startIndex) return currentBounds;
  if (loadedMessages.length === 0) return currentBounds;
  const endIndex = Math.min(
    loadedMessages.length - 1,
    currentBounds.endIndex + expandBy,
  );
  return { startIndex: currentBounds.startIndex, endIndex };
}
