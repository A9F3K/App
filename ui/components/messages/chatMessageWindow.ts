import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";
import {
  expandDisplaySliceNewer,
  expandDisplaySliceOlder,
  MESSAGE_LIST_DISPLAY_MAX,
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
  maxRows = MESSAGE_LIST_DISPLAY_MAX,
): ChatMessageWindowState | null {
  if (loaded.length === 0) return null;
  const visibleBounds = mergeOverride(
    current.bounds,
    current.override,
    loaded.length,
  );
  if (visibleBounds.startIndex <= 0) return null;
  const nextBounds = expandDisplaySliceOlder(
    loaded,
    visibleBounds,
    expandBy,
    maxRows,
  );
  if (nextBounds.startIndex >= visibleBounds.startIndex) return null;
  // Authoritative slid window — do not merge-widen with the previous endIndex.
  const bounds = clampBounds(loaded.length, nextBounds);
  return {
    bounds,
    override: bounds,
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
  maxRows = MESSAGE_LIST_DISPLAY_MAX,
): ChatMessageWindowState | null {
  if (loaded.length === 0) return null;
  const visibleBounds = mergeOverride(
    current.bounds,
    current.override,
    loaded.length,
  );
  if (visibleBounds.endIndex >= loaded.length - 1) return null;
  const nextBounds = expandDisplaySliceNewer(
    loaded,
    visibleBounds,
    expandBy,
    maxRows,
  );
  if (nextBounds.endIndex <= visibleBounds.endIndex) return null;
  // Authoritative slid window — do not merge-widen with the previous startIndex.
  const bounds = clampBounds(loaded.length, nextBounds);
  return {
    bounds,
    override: bounds,
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
  const settled =
    current.override != null &&
    current.override.endIndex >= current.override.startIndex
      ? current.override
      : current.bounds;
  // Empty / unset display bounds ({0,-1}) must not invent a 1-row override —
  // prevEnd=-1 + prependedCount ≈ buffer growth collapses to the last index
  // (logs: count=3, displayCount=1 on HyperlinkSpace Channel Chat).
  if (settled.endIndex < settled.startIndex) {
    return {
      bounds: { startIndex: 0, endIndex: loadedLength - 1 },
      override: null,
      anchorMessageId: current.anchorMessageId,
      atLoadedTop: true,
      atLoadedBottom: true,
    };
  }
  const prevStart = settled.startIndex;
  const prevEnd = Math.max(prevStart, settled.endIndex);
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
  let nextEnd = Math.min(
    loadedLength - 1,
    Math.max(prevEnd + prependedCount, nextStart),
  );
  // Keep the shifted window within 2N+1 (drop from the newer end).
  if (nextEnd - nextStart + 1 > MESSAGE_LIST_DISPLAY_MAX) {
    nextEnd = nextStart + MESSAGE_LIST_DISPLAY_MAX - 1;
  }
  // Never pin a collapsed 1-row window while the buffer still has more rows.
  if (nextStart === nextEnd && loadedLength > 1) {
    return {
      bounds: { startIndex: 0, endIndex: loadedLength - 1 },
      override: null,
      anchorMessageId: current.anchorMessageId,
      atLoadedTop: true,
      atLoadedBottom: true,
    };
  }
  const override: CountSliceBounds = {
    startIndex: nextStart,
    endIndex: nextEnd,
  };
  const bounds = clampBounds(loadedLength, override);
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
  const resolvedAnchorId =
    anchorMessageId > 0
      ? anchorMessageId
      : loaded[loaded.length - 1]!.telegram_message_id;

  // When the natural window already covers the full loaded buffer (short
  // channel/bot threads, early history), never apply a narrowing override.
  // Stale 1-row overrides after keepEnd trim / chat-switch races otherwise
  // hide already-loaded stickers (logs: count=3, displayCount=1).
  if (base.startIndex === 0 && base.endIndex >= loaded.length - 1) {
    return {
      bounds: base,
      override: null,
      anchorMessageId: resolvedAnchorId,
      atLoadedTop: true,
      atLoadedBottom: true,
    };
  }

  // Override is authoritative (afterOlderPrepend shift, expandOlder/Newer).
  // Merging with a re-centered base (min start / max end) widens the window on
  // API prepend and mounts new older rows above the viewport — that grows
  // contentH and causes the visible jump (e.g. displayCount 81→119).
  let bounds = base;
  let nextOverride = override;
  if (override != null && override.endIndex >= override.startIndex) {
    const clamped = clampBounds(loaded.length, override);
    const overrideSpan = override.endIndex - override.startIndex;
    const clampedSpan = clamped.endIndex - clamped.startIndex;
    const baseSpan = base.endIndex - base.startIndex;
    // After a keepEnd trim, stale high indices clamp to a single last row and
    // trap scroll (contentH≈layoutH). Also heal any override that collapsed
    // narrower than the anchor-centered base while still inside the buffer.
    if (
      (overrideSpan > 0 && clampedSpan === 0 && override.startIndex >= loaded.length) ||
      (clampedSpan < baseSpan && clampedSpan === 0)
    ) {
      nextOverride = null;
      bounds = base;
    } else {
      bounds = clamped;
    }
  }
  return {
    bounds,
    override: nextOverride,
    anchorMessageId: resolvedAnchorId,
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

/**
 * Keep a settled display window as an override floor (tdesktop item-anchor).
 * Only shrink when over maxRows — never re-center via openAround (that jumps).
 */
export function keepSettledDisplayWindow(
  loadedLength: number,
  settled: CountSliceBounds,
  maxRows = MESSAGE_LIST_DISPLAY_MAX,
): CountSliceBounds {
  if (loadedLength <= 0 || settled.endIndex < settled.startIndex) {
    return { startIndex: 0, endIndex: -1 };
  }
  let startIndex = Math.max(0, Math.min(settled.startIndex, loadedLength - 1));
  let endIndex = Math.max(
    startIndex,
    Math.min(settled.endIndex, loadedLength - 1),
  );
  if (maxRows > 0 && endIndex - startIndex + 1 > maxRows) {
    // Drop from the newer end so the older edge the user just revealed stays.
    endIndex = startIndex + maxRows - 1;
  }
  return { startIndex, endIndex };
}

export {
  MESSAGE_LIST_DISPLAY_MAX,
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  type CountSliceBounds,
};
