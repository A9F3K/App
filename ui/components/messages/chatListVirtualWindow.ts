import type { MessageChatRowData } from "./MessageChatRow";
import { MESSAGE_ROW_HEIGHT_PX } from "./messageListLayout";

/** Extra pixels rendered above/below the chat-list viewport. */
export const CHAT_LIST_VIRTUAL_OVERSCAN_PX = 600;
/** Max tier-3 rows kept in client memory. */
export const CHAT_LIST_TIER3_CLIENT_CAP = 80;
/** Minimum chats before windowing kicks in. */
export const CHAT_LIST_VIRTUALIZE_MIN_ROWS = 20;

export type ChatListVirtualWindow = {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
};

export type ChatListTier = "pinned" | "positioned" | "unpositioned";

function comparePinOrderDesc(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length !== b.length) return b.length - a.length;
  return b.localeCompare(a);
}

function tierRank(tier: ChatListTier | null | undefined): number {
  if (tier === "pinned") return 0;
  if (tier === "positioned") return 1;
  if (tier === "unpositioned") return 2;
  return 1;
}

export function resolveChatListTier(row: MessageChatRowData): ChatListTier {
  if (row.list_tier === "pinned" || row.list_tier === "positioned" || row.list_tier === "unpositioned") {
    return row.list_tier;
  }
  return row.is_pinned ? "pinned" : "positioned";
}

export function sortChatRowsTierAware(rows: MessageChatRowData[]): MessageChatRowData[] {
  return [...rows].sort((a, b) => {
    const aTier = resolveChatListTier(a);
    const bTier = resolveChatListTier(b);
    const tierDiff = tierRank(aTier) - tierRank(bTier);
    if (tierDiff !== 0) return tierDiff;
    if (aTier === "pinned" || aTier === "positioned") {
      const byOrder = comparePinOrderDesc(a.pin_order ?? "0", b.pin_order ?? "0");
      if (byOrder !== 0) return byOrder;
    }
    const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return tb - ta;
  });
}

export function isChatListVirtualizationActive(count: number): boolean {
  return count >= CHAT_LIST_VIRTUALIZE_MIN_ROWS;
}

export type ChatListVirtualWindowOptions = {
  rowStridePx?: number;
  overscanPx?: number;
  contentTopInsetPx?: number;
  /** Keep window indices stable until scroll crosses the next row boundary. */
  stickyWindow?: Pick<ChatListVirtualWindow, "startIndex" | "endIndex">;
};

export function resolveChatListVirtualWindow(
  totalCount: number,
  metrics: { scrollY: number; layoutH: number },
  options: ChatListVirtualWindowOptions = {},
): ChatListVirtualWindow {
  const rowStridePx = options.rowStridePx ?? MESSAGE_ROW_HEIGHT_PX;
  const overscanPx = options.overscanPx ?? CHAT_LIST_VIRTUAL_OVERSCAN_PX;
  const contentTopInsetPx = options.contentTopInsetPx ?? 0;
  const disabledWindow: ChatListVirtualWindow = {
    enabled: false,
    startIndex: 0,
    endIndex: Math.max(0, totalCount - 1),
    topSpacerPx: 0,
    bottomSpacerPx: 0,
  };
  if (totalCount < CHAT_LIST_VIRTUALIZE_MIN_ROWS || metrics.layoutH <= 0) {
    return disabledWindow;
  }

  const totalHeight = contentTopInsetPx + totalCount * rowStridePx;
  const maxScrollY = Math.max(0, totalHeight - metrics.layoutH);
  const scrollY = Math.min(Math.max(0, metrics.scrollY), maxScrollY);
  const rowScrollY = Math.max(0, scrollY - contentTopInsetPx);

  const viewportTop = Math.max(0, rowScrollY - overscanPx);
  const viewportBottom = rowScrollY + metrics.layoutH + overscanPx;

  let startIndex = Math.max(0, Math.floor(viewportTop / rowStridePx));
  let endIndex = Math.min(totalCount - 1, Math.ceil(viewportBottom / rowStridePx) - 1);

  const sticky = options.stickyWindow;
  if (sticky) {
    const hysteresisPx = rowStridePx * 0.35;
    if (startIndex > sticky.startIndex) {
      const advanceAt = (sticky.startIndex + 1) * rowStridePx - hysteresisPx;
      if (rowScrollY < advanceAt) {
        startIndex = sticky.startIndex;
      }
    } else if (startIndex < sticky.startIndex) {
      startIndex = Math.min(sticky.startIndex, startIndex);
    }
    if (endIndex < sticky.endIndex) {
      const shrinkAt = sticky.endIndex * rowStridePx - metrics.layoutH + hysteresisPx;
      if (rowScrollY > shrinkAt) {
        endIndex = sticky.endIndex;
      }
    } else if (endIndex > sticky.endIndex) {
      endIndex = Math.max(sticky.endIndex, endIndex);
    }
    if (endIndex < startIndex) {
      endIndex = startIndex;
    }
  }

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerPx: startIndex * rowStridePx,
    bottomSpacerPx: Math.max(0, (totalCount - endIndex - 1) * rowStridePx),
  };
}

/** Drop tier-3 rows outside 2× overscan of the virtual window; cap total tier-3 rows. */
export function pruneTier3ChatRows(
  rows: MessageChatRowData[],
  window: ChatListVirtualWindow,
  rowStridePx: number = MESSAGE_ROW_HEIGHT_PX,
  overscanPx: number = CHAT_LIST_VIRTUAL_OVERSCAN_PX,
  tier3Cap: number = CHAT_LIST_TIER3_CLIENT_CAP,
): MessageChatRowData[] {
  const tier3Rows = rows.filter((row) => resolveChatListTier(row) === "unpositioned");
  if (tier3Rows.length === 0) return rows;

  const overscanRows = Math.ceil((overscanPx * 2) / rowStridePx);
  const keepStart = Math.max(0, window.startIndex - overscanRows);
  const keepEnd = Math.min(rows.length, window.endIndex + overscanRows + 1);
  const keepIds = new Set<number>();
  for (let index = keepStart; index < keepEnd; index += 1) {
    const row = rows[index];
    if (row && resolveChatListTier(row) === "unpositioned") {
      keepIds.add(row.telegram_chat_id);
    }
  }

  let tier3Kept = 0;
  const next: MessageChatRowData[] = [];
  for (const row of rows) {
    if (resolveChatListTier(row) !== "unpositioned") {
      next.push(row);
      continue;
    }
    if (!keepIds.has(row.telegram_chat_id)) continue;
    if (tier3Kept >= tier3Cap) continue;
    next.push(row);
    tier3Kept += 1;
  }
  return next.length === rows.length ? rows : next;
}
