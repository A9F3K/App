import type { MessageScrollLayoutEntry } from "./messageListLayout";

/** Minimum loaded rows before web windowing kicks in. */
export const MESSAGE_LIST_VIRTUALIZE_MIN_ROWS = 40;
/** Extra pixels rendered above/below the viewport. */
export const MESSAGE_LIST_VIRTUAL_OVERSCAN_PX = 600;
/** Fallback row height before first layout pass. */
export const MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX = 64;

export type MessageListVirtualWindow = {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
};

function resolveRowHeightPx(
  messageId: number,
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
  heightCache: ReadonlyMap<number, number>,
): number {
  const layout = layouts.get(messageId);
  if (layout && layout.height > 0) return layout.height;
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
  return resolveRowHeightPx(messageId, layouts, heightCache) + (index > 0 ? rowGapPx : 0);
}

/** Web-only message list windowing — renders a viewport slice plus spacers. */
export function resolveMessageListVirtualWindow(
  messages: readonly { telegram_message_id: number }[],
  layouts: ReadonlyMap<number, MessageScrollLayoutEntry>,
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

  const viewportTop = Math.max(0, metrics.scrollY - MESSAGE_LIST_VIRTUAL_OVERSCAN_PX);
  const viewportBottom = metrics.scrollY + metrics.layoutH + MESSAGE_LIST_VIRTUAL_OVERSCAN_PX;

  let cursorY = 0;
  let startIndex = 0;
  let endIndex = count - 1;
  let foundStart = false;

  for (let index = 0; index < count; index += 1) {
    const messageId = messages[index]!.telegram_message_id;
    const gapBefore = index > 0 ? rowGapPx : 0;
    const rowTop = cursorY + gapBefore;
    const rowHeight = resolveRowHeightPx(messageId, layouts, heightCache);
    const rowBottom = rowTop + rowHeight;
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
    topSpacerPx += rowBlockHeightPx(
      messages[index]!.telegram_message_id,
      index,
      layouts,
      heightCache,
      rowGapPx,
    );
  }

  let bottomSpacerPx = 0;
  for (let index = endIndex + 1; index < count; index += 1) {
    bottomSpacerPx += rowBlockHeightPx(
      messages[index]!.telegram_message_id,
      index,
      layouts,
      heightCache,
      rowGapPx,
    );
  }

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerPx,
    bottomSpacerPx,
  };
}
