import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";
import {
  CHAT_HISTORY_WINDOW_N,
  windowBoundsAroundAnchor,
} from "./chatHistoryWindowBudget";

/** Rows preferred above/below the scroll anchor (tdesktop-style N). */
export const MESSAGE_LIST_SLICE = CHAT_HISTORY_WINDOW_N;

/** Max rows kept in the in-memory buffer around the anchor (2N). */
export const MESSAGE_LIST_VIEWPORT_LIMIT = MESSAGE_LIST_SLICE * 2;

/**
 * Max rows in the mounted display window (2N sides + anchor).
 * Matches {@link windowBoundsAroundAnchor} / openAround.
 */
export const MESSAGE_LIST_DISPLAY_MAX = MESSAGE_LIST_VIEWPORT_LIMIT + 1;

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

/**
 * Contiguous slice of up to 2N rows around `anchorIndex`.
 * Shortfalls at history edges are redistributed to the other side.
 */
export function sliceMessagesByCount(
  messages: readonly MessageChatHistoryItem[],
  anchorIndex: number,
  sliceSize = MESSAGE_LIST_SLICE,
): CountSliceBounds {
  if (messages.length === 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  return windowBoundsAroundAnchor(messages.length, anchorIndex, sliceSize);
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

/** Trim loaded buffer to at most `maxRows` centered on `anchorMessageId` with edge redistribution. */
export function trimMessagesAroundAnchorCount(
  messages: MessageChatHistoryItem[],
  anchorMessageId: number,
  maxRows = MESSAGE_LIST_VIEWPORT_LIMIT,
): MessageChatHistoryItem[] {
  if (messages.length <= maxRows) return messages;
  const anchorIndex = findMessageIndexById(messages, anchorMessageId);
  if (anchorIndex < 0) return messages;
  const nPerSide = Math.floor(maxRows / 2);
  const { startIndex, endIndex } = windowBoundsAroundAnchor(
    messages.length,
    anchorIndex,
    nPerSide,
  );
  return messages.slice(startIndex, endIndex + 1);
}

/** Expand display slice toward older rows already in the buffer (no API fetch). */
export function canExpandDisplaySliceOlder(
  loadedMessages: readonly MessageChatHistoryItem[],
  displayStartIndex: number,
): boolean {
  return displayStartIndex > 0;
}

/**
 * Slide the display window toward older rows (tdesktop / telegram-tt).
 * Never grow past `maxRows` — drop newer rows as older ones are revealed.
 */
export function expandDisplaySliceOlder(
  loadedMessages: readonly MessageChatHistoryItem[],
  currentBounds: CountSliceBounds,
  expandBy = MESSAGE_LIST_SLICE,
  maxRows = MESSAGE_LIST_DISPLAY_MAX,
): CountSliceBounds {
  if (currentBounds.endIndex < currentBounds.startIndex) return currentBounds;
  const startIndex = Math.max(0, currentBounds.startIndex - expandBy);
  let endIndex = currentBounds.endIndex;
  if (maxRows > 0 && endIndex - startIndex + 1 > maxRows) {
    endIndex = startIndex + maxRows - 1;
  }
  return { startIndex, endIndex };
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

/**
 * Slide the display window toward newer rows.
 * Never grow past `maxRows` — drop older rows as newer ones are revealed.
 */
export function expandDisplaySliceNewer(
  loadedMessages: readonly MessageChatHistoryItem[],
  currentBounds: CountSliceBounds,
  expandBy = MESSAGE_LIST_SLICE,
  maxRows = MESSAGE_LIST_DISPLAY_MAX,
): CountSliceBounds {
  if (currentBounds.endIndex < currentBounds.startIndex) return currentBounds;
  if (loadedMessages.length === 0) return currentBounds;
  const endIndex = Math.min(
    loadedMessages.length - 1,
    currentBounds.endIndex + expandBy,
  );
  let startIndex = currentBounds.startIndex;
  if (maxRows > 0 && endIndex - startIndex + 1 > maxRows) {
    startIndex = Math.max(0, endIndex - maxRows + 1);
  }
  return { startIndex, endIndex };
}
