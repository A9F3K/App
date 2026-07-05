import { Platform } from "react-native";
import type { MessageScrollLayoutEntry } from "./messageListLayout";

/** Minimum loaded rows before web windowing kicks in. */
export const MESSAGE_LIST_VIRTUALIZE_MIN_ROWS =
  Platform.OS === "web" ? 24 : 40;
/** Extra pixels rendered above/below the viewport. */
export const MESSAGE_LIST_VIRTUAL_OVERSCAN_PX = 1200;
/** Fallback row height before first layout pass (emoji-heavy rows are often taller). */
export const MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX = 120;

export function isMessageListVirtualizationActive(
  messageCount: number,
): boolean {
  return messageCount >= MESSAGE_LIST_VIRTUALIZE_MIN_ROWS;
}

export type MessageListVirtualWindow = {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
};

/** Bubble body height only — row gap is a sibling inside the row wrapper. */
function resolveContentHeightPx(
  messageId: number,
  index: number,
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  heightCache: ReadonlyMap<number, number>,
  rowGapPx: number,
): number {
  const layout = layouts.get(messageId);
  if (layout && layout.height > 0) {
    return Math.max(0, layout.height - (index > 0 ? rowGapPx : 0));
  }
  const cached = heightCache.get(messageId);
  if (cached != null && cached > 0) return cached;
  return MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
}

function rowBlockHeightPx(
  messageId: number,
  index: number,
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  heightCache: ReadonlyMap<number, number>,
  rowGapPx: number,
): number {
  return (
    resolveContentHeightPx(messageId, index, layouts, heightCache, rowGapPx) +
    (index > 0 ? rowGapPx : 0)
  );
}

export function estimateMessageListBlockTotalHeight(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  heightCache: ReadonlyMap<number, number>,
  rowGapPx: number,
): number {
  let total = 0;
  for (let index = 0; index < messages.length; index += 1) {
    total += rowBlockHeightPx(
      messages[index]!.telegram_message_id,
      index,
      layouts,
      heightCache,
      rowGapPx,
    );
  }
  return total;
}

/** Web-only message list windowing — renders a viewport slice plus spacers. */
export function resolveMessageListVirtualWindow(
  messages: readonly { telegram_message_id: number }[],
  heightCache: ReadonlyMap<number, number>,
  metrics: { scrollY: number; layoutH: number },
  rowGapPx: number,
): MessageListVirtualWindow {
  const count = messages.length;
  const disabledWindow: MessageListVirtualWindow = {
    enabled: false,
    startIndex: 0,
    endIndex: Math.max(0, count - 1),
    topSpacerPx: 0,
    bottomSpacerPx: 0,
  };
  if (count < MESSAGE_LIST_VIRTUALIZE_MIN_ROWS || metrics.layoutH <= 0) {
    return disabledWindow;
  }

  const virtualRowBlockHeightPx = (messageId: number, index: number): number => {
    const cached = heightCache.get(messageId);
    const contentHeight =
      cached != null && cached > 0 ? cached : MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
    return contentHeight + (index > 0 ? rowGapPx : 0);
  };

  let totalHeight = 0;
  for (let index = 0; index < count; index += 1) {
    totalHeight += virtualRowBlockHeightPx(messages[index]!.telegram_message_id, index);
  }
  const maxScrollY = Math.max(0, totalHeight - metrics.layoutH);
  const scrollY = Math.min(Math.max(0, metrics.scrollY), maxScrollY);

  const viewportTop = Math.max(0, scrollY - MESSAGE_LIST_VIRTUAL_OVERSCAN_PX);
  const viewportBottom = scrollY + metrics.layoutH + MESSAGE_LIST_VIRTUAL_OVERSCAN_PX;

  let cursorY = 0;
  let startIndex = 0;
  let endIndex = count - 1;
  let foundStart = false;

  for (let index = 0; index < count; index += 1) {
    const messageId = messages[index]!.telegram_message_id;
    const blockHeight = virtualRowBlockHeightPx(messageId, index);
    const rowTop = cursorY;
    const rowBottom = rowTop + blockHeight;
    cursorY = rowBottom;

    if (!foundStart && rowBottom >= viewportTop) {
      startIndex = index;
      foundStart = true;
    }
    if (foundStart && rowTop > viewportBottom) {
      endIndex = Math.max(startIndex, index - 1);
      break;
    }
  }

  let topSpacerPx = 0;
  for (let index = 0; index < startIndex; index += 1) {
    topSpacerPx += virtualRowBlockHeightPx(messages[index]!.telegram_message_id, index);
  }

  let bottomSpacerPx = 0;
  for (let index = endIndex + 1; index < count; index += 1) {
    bottomSpacerPx += virtualRowBlockHeightPx(messages[index]!.telegram_message_id, index);
  }

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerPx,
    bottomSpacerPx,
  };
}

/** Cumulative Y/height from the height cache — stable for virtualized unread sync. */
export function buildMessageListComputedLayouts(
  messages: readonly { telegram_message_id: number }[],
  heightCache: ReadonlyMap<number, number>,
  rowGapPx: number,
): Map<number, MessageScrollLayoutEntry> {
  const layouts = new Map<number, MessageScrollLayoutEntry>();
  let y = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const messageId = messages[index]!.telegram_message_id;
    const blockHeight = rowBlockHeightPx(
      messageId,
      index,
      new Map(),
      heightCache,
      rowGapPx,
    );
    layouts.set(messageId, { y, height: blockHeight });
    y += blockHeight;
  }
  return layouts;
}

/**
 * Merge on-layout positions for the rendered virtual slice over computed layouts.
 * Measured rows report absolute Y in scroll content; computed rows fill the rest.
 */
export function buildMessageListViewportAwareLayouts(
  messages: readonly { telegram_message_id: number }[],
  measuredLayouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  heightCache: ReadonlyMap<number, number>,
  metrics: { scrollY: number; layoutH: number },
  rowGapPx: number,
): Map<number, MessageScrollLayoutEntry> {
  const layouts = buildMessageListComputedLayouts(messages, heightCache, rowGapPx);
  const window = resolveMessageListVirtualWindow(
    messages,
    heightCache,
    metrics,
    rowGapPx,
  );
  if (!window.enabled) return layouts;

  for (let index = window.startIndex; index <= window.endIndex; index += 1) {
    const messageId = messages[index]!.telegram_message_id;
    const measured = measuredLayouts.get(messageId);
    const computed = layouts.get(messageId);
    if (measured != null && measured.height > 0 && computed != null) {
      // Keep computed cumulative Y; only adopt measured block height. Measured Y
      // is relative to the current virtual slice and goes stale when the window slides.
      layouts.set(messageId, { y: computed.y, height: measured.height });
    }
  }
  return layouts;
}
