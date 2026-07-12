import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";
import {
  expandDisplaySliceNewer,
  expandDisplaySliceOlder,
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  sliceMessagesByCountAroundId,
  trimMessagesAroundAnchorCount,
  type CountSliceBounds,
} from "./messageChatViewportSlice";

export type ChatMessageWindowState = {
  bounds: CountSliceBounds;
  /** When set, widens the computed slice (prepend / expand). */
  override: CountSliceBounds | null;
  anchorMessageId: number;
  atLoadedTop: boolean;
  atLoadedBottom: boolean;
};

export function emptyChatMessageWindow(): ChatMessageWindowState {
  return {
    bounds: { startIndex: 0, endIndex: -1 },
    override: null,
    anchorMessageId: 0,
    atLoadedTop: false,
    atLoadedBottom: false,
  };
}

function clampBounds(
  loadedLength: number,
  bounds: CountSliceBounds,
): CountSliceBounds {
  if (loadedLength <= 0) return { startIndex: 0, endIndex: -1 };
  const startIndex = Math.max(0, Math.min(bounds.startIndex, loadedLength - 1));
  const endIndex = Math.max(
    startIndex,
    Math.min(bounds.endIndex, loadedLength - 1),
  );
  return { startIndex, endIndex };
}

function mergeOverride(
  base: CountSliceBounds,
  override: CountSliceBounds | null,
  loadedLength: number,
): CountSliceBounds {
  if (!override || override.endIndex < override.startIndex) {
    return clampBounds(loadedLength, base);
  }
  return clampBounds(loadedLength, {
    startIndex: Math.min(base.startIndex, override.startIndex),
    endIndex: Math.max(base.endIndex, override.endIndex),
  });
}

/** Center display slice on anchor (open / follow-bottom / unread). */
export function openAround(
  loaded: readonly MessageChatHistoryItem[],
  anchorMessageId: number,
  sliceSize = MESSAGE_LIST_SLICE,
): ChatMessageWindowState {
  if (loaded.length === 0) return emptyChatMessageWindow();
  const bounds = sliceMessagesByCountAroundId(loaded, anchorMessageId, sliceSize);
  return {
    bounds,
    override: null,
    anchorMessageId:
      anchorMessageId > 0
        ? anchorMessageId
        : loaded[loaded.length - 1]!.telegram_message_id,
    atLoadedTop: bounds.startIndex === 0,
    atLoadedBottom: bounds.endIndex >= loaded.length - 1,
  };
}

/** Follow the chat tail — display slice anchored on the newest loaded row. */
export function followBottom(
  loaded: readonly MessageChatHistoryItem[],
  sliceSize = MESSAGE_LIST_SLICE,
): ChatMessageWindowState {
  if (loaded.length === 0) return emptyChatMessageWindow();
  const tailId = loaded[loaded.length - 1]!.telegram_message_id;
  return openAround(loaded, tailId, sliceSize);
}

/** Expand display toward older rows already in the loaded buffer. */
export function expandOlder(
  loaded: readonly MessageChatHistoryItem[],
  current: ChatMessageWindowState,
  expandBy = MESSAGE_LIST_SLICE,
): ChatMessageWindowState | null {
  if (loaded.length === 0) return null;
  const visibleBounds = mergeOverride(
    current.bounds,
    current.override,
    loaded.length,
  );
  if (visibleBounds.startIndex <= 0) return null;
  const nextBounds = expandDisplaySliceOlder(loaded, visibleBounds, expandBy);
  if (nextBounds.startIndex >= visibleBounds.startIndex) return null;
  const override: CountSliceBounds = {
    startIndex: nextBounds.startIndex,
    endIndex: Math.max(nextBounds.endIndex, visibleBounds.endIndex),
  };
  const bounds = mergeOverride(nextBounds, override, loaded.length);
  return {
    bounds,
    override,
    anchorMessageId: current.anchorMessageId,
    atLoadedTop: bounds.startIndex === 0,
    atLoadedBottom: bounds.endIndex >= loaded.length - 1,
  };
}

/** Expand display toward newer rows already in the loaded buffer. */
export function expandNewer(
  loaded: readonly MessageChatHistoryItem[],
  current: ChatMessageWindowState,
  expandBy = MESSAGE_LIST_SLICE,
): ChatMessageWindowState | null {
  if (loaded.length === 0) return null;
  if (current.bounds.endIndex >= loaded.length - 1) return null;
  const nextBounds = expandDisplaySliceNewer(loaded, current.bounds, expandBy);
  if (nextBounds.endIndex <= current.bounds.endIndex) return null;
  const override: CountSliceBounds = {
    startIndex: Math.min(nextBounds.startIndex, current.bounds.startIndex),
    endIndex: nextBounds.endIndex,
  };
  const bounds = mergeOverride(nextBounds, override, loaded.length);
  return {
    bounds,
    override,
    anchorMessageId: current.anchorMessageId,
    atLoadedTop: bounds.startIndex === 0,
    atLoadedBottom: bounds.endIndex >= loaded.length - 1,
  };
}

/**
 * After older messages land in the loaded buffer: **always shift** the display
 * window by `prependedCount` so the same visual rows stay mounted.
 *
 * New older rows sit above `startIndex` and are revealed later via
 * {@link expandOlder} / scroll-up — never by growing content at scrollY≈0
 * (which requires fragile scroll compensation and still jumps).
 *
 * `pinToLoadedTop` is ignored (kept for call-site compatibility).
 */
export function afterOlderPrepend(
  loadedLength: number,
  current: ChatMessageWindowState,
  prependedCount: number,
  _options?: { pinToLoadedTop?: boolean },
): ChatMessageWindowState {
  if (loadedLength <= 0) return emptyChatMessageWindow();
  const prevStart = current.override?.startIndex ?? current.bounds.startIndex;
  const prevEnd = Math.max(
    current.bounds.endIndex,
    current.override?.endIndex ?? current.bounds.endIndex,
  );
  if (prependedCount <= 0) {
    const bounds = clampBounds(loadedLength, current.bounds);
    return {
      bounds,
      override: current.override,
      anchorMessageId: current.anchorMessageId,
      atLoadedTop: bounds.startIndex === 0,
      atLoadedBottom: bounds.endIndex >= loadedLength - 1,
    };
  }
  const nextStart = Math.min(loadedLength - 1, prevStart + prependedCount);
  const override: CountSliceBounds = {
    startIndex: nextStart,
    endIndex: Math.min(
      loadedLength - 1,
      Math.max(prevEnd + prependedCount, nextStart),
    ),
  };
  const base = clampBounds(loadedLength, {
    startIndex: prevStart + prependedCount,
    endIndex: prevEnd + prependedCount,
  });
  const bounds = mergeOverride(base, override, loadedLength);
  return {
    bounds,
    override,
    anchorMessageId: current.anchorMessageId,
    atLoadedTop: bounds.startIndex === 0,
    atLoadedBottom: bounds.endIndex >= loadedLength - 1,
  };
}

/** Recompute slice from anchor + optional override (render path). */
export function resolveDisplayWindow(
  loaded: readonly MessageChatHistoryItem[],
  anchorMessageId: number,
  override: CountSliceBounds | null,
  sliceSize = MESSAGE_LIST_SLICE,
): ChatMessageWindowState {
  if (loaded.length === 0) return emptyChatMessageWindow();
  const base = sliceMessagesByCountAroundId(loaded, anchorMessageId, sliceSize);
  // Override is authoritative (afterOlderPrepend shift, expandOlder/Newer).
  // Merging with a re-centered base (min start / max end) widens the window on
  // API prepend and mounts new older rows above the viewport — that grows
  // contentH and causes the visible jump (e.g. displayCount 81→119).
  const bounds =
    override != null && override.endIndex >= override.startIndex
      ? clampBounds(loaded.length, override)
      : base;
  return {
    bounds,
    override,
    anchorMessageId:
      anchorMessageId > 0
        ? anchorMessageId
        : loaded[loaded.length - 1]!.telegram_message_id,
    atLoadedTop: bounds.startIndex === 0,
    atLoadedBottom: bounds.endIndex >= loaded.length - 1,
  };
}

export function sliceDisplayMessages(
  loaded: readonly MessageChatHistoryItem[],
  window: ChatMessageWindowState,
): MessageChatHistoryItem[] {
  if (window.bounds.endIndex < window.bounds.startIndex) return [];
  return loaded.slice(window.bounds.startIndex, window.bounds.endIndex + 1);
}

export function trimLoadedAroundAnchor(
  messages: MessageChatHistoryItem[],
  anchorMessageId: number,
  maxRows = MESSAGE_LIST_VIEWPORT_LIMIT,
): MessageChatHistoryItem[] {
  return trimMessagesAroundAnchorCount(messages, anchorMessageId, maxRows);
}

export {
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  type CountSliceBounds,
};
