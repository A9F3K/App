/**
 * History buffer merge/trim — telegram-tt viewport buffer around an anchor.
 * Kept pure so MessageList / prefetch / cache listeners share one path.
 */
import type { MutableRefObject } from "react";
import {
  enrichHistoryMessageDisplay,
  mergeHistoryMessageRow,
  type HistoryMessageContext,
  type MessageChatHistoryItem,
} from "./messageChatHistoryTypes";
import { trimMessagesAroundAnchorCount } from "./messageChatViewportSlice";
import { estimateMessageListBlockTotalHeight } from "./messageListVirtualWindow";
import type { MessageScrollLayoutEntry } from "./messageListLayout";

export type MergeTrimHistoryResult = {
  messages: MessageChatHistoryItem[];
  removedFromTop: number;
  adjustScrollYByPx: number;
  hasMoreOlder: boolean;
  nextBeforeMessageId: number | null;
};

function collapseOutgoingEchoDuplicates(
  items: MessageChatHistoryItem[],
  ctx?: HistoryMessageContext,
): MessageChatHistoryItem[] {
  const result: MessageChatHistoryItem[] = [];
  for (const item of items) {
    if (!item.is_outgoing) {
      result.push(item);
      continue;
    }
    const textKey = item.text.trim();
    const sentAt = Date.parse(item.sent_at);
    const dupIdx = result.findIndex((row) => {
      if (!row.is_outgoing || row.telegram_message_id === item.telegram_message_id) {
        return false;
      }
      if (row.text.trim() !== textKey) return false;
      const rowSent = Date.parse(row.sent_at);
      if (!Number.isFinite(sentAt) || !Number.isFinite(rowSent)) return true;
      return Math.abs(sentAt - rowSent) < 60_000;
    });
    if (dupIdx >= 0) {
      const prev = result[dupIdx]!;
      result[dupIdx] =
        item.telegram_message_id >= prev.telegram_message_id
          ? mergeHistoryMessageRow(prev, item, ctx)
          : mergeHistoryMessageRow(item, prev, ctx);
      continue;
    }
    result.push(item);
  }
  return result;
}

/** Merge by id, sort chronologically, collapse outgoing echo duplicates. */
export function mergeHistoryMessages(
  existing: MessageChatHistoryItem[],
  incoming: MessageChatHistoryItem[],
  ctx?: HistoryMessageContext,
): MessageChatHistoryItem[] {
  const byId = new Map<number, MessageChatHistoryItem>();
  for (const row of existing) {
    byId.set(row.telegram_message_id, enrichHistoryMessageDisplay(row));
  }
  for (const row of incoming) {
    const prev = byId.get(row.telegram_message_id);
    byId.set(row.telegram_message_id, mergeHistoryMessageRow(prev, row, ctx));
  }
  const sorted = [...byId.values()].sort((a, b) => {
    const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
    if (byTime !== 0) return byTime;
    return a.telegram_message_id - b.telegram_message_id;
  });
  return collapseOutgoingEchoDuplicates(sorted, ctx);
}

/**
 * Merge then trim to a count window around the scroll anchor (telegram-tt
 * MESSAGE_LIST_VIEWPORT_LIMIT). Reports top removals for scroll compensation.
 */
export function mergeTrimHistoryMessages(
  existing: MessageChatHistoryItem[],
  incoming: MessageChatHistoryItem[],
  ctx: HistoryMessageContext | undefined,
  options: {
    maxRows: number;
    anchorMessageId: number;
    keepEnd: boolean;
    skipTrim?: boolean;
    layouts: ReadonlyMap<number, MessageScrollLayoutEntry>;
    heightCache: ReadonlyMap<number, number>;
    rowGapPx: number;
    hasMoreOlder: boolean;
    nextBeforeMessageId: number | null;
  },
): MergeTrimHistoryResult {
  const merged = mergeHistoryMessages(existing, incoming, ctx);
  if (options.skipTrim) {
    return {
      messages: merged,
      removedFromTop: 0,
      adjustScrollYByPx: 0,
      hasMoreOlder: options.hasMoreOlder,
      nextBeforeMessageId: options.nextBeforeMessageId,
    };
  }
  const trimmed = trimMessagesAroundAnchorCount(
    merged,
    options.anchorMessageId,
    options.maxRows,
  );
  const removedFromTop =
    trimmed.length < merged.length && trimmed[0] != null
      ? merged.findIndex(
          (row) => row.telegram_message_id === trimmed[0]!.telegram_message_id,
        )
      : 0;
  const adjustScrollYByPx =
    removedFromTop > 0
      ? estimateMessageListBlockTotalHeight(
          merged.slice(0, removedFromTop),
          new Map(),
          options.heightCache,
          options.rowGapPx,
        )
      : 0;
  // Do not infer server pagination from viewport trim alone — callers pass
  // hasMoreOlder from cache/API. Trim only evicts rows still available locally
  // (complete cache hydrate) or via the next API page.
  const hasMoreOlder = options.hasMoreOlder;
  const nextBeforeMessageId =
    trimmed.length > 0 && hasMoreOlder
      ? trimmed[0]!.telegram_message_id
      : options.nextBeforeMessageId;

  return {
    messages: trimmed,
    removedFromTop,
    adjustScrollYByPx,
    hasMoreOlder,
    nextBeforeMessageId,
  };
}

/** Apply trim side-effects (scroll compensate + older cursor) after a merge. */
export function applyMergeTrimResult(
  result: MergeTrimHistoryResult,
  refs: {
    hasMoreOlderRef: MutableRefObject<boolean>;
    nextBeforeMessageIdRef: MutableRefObject<number | null>;
    pendingPreserveScrollYRef: MutableRefObject<number | null>;
    pinnedScrollYRef: MutableRefObject<number>;
    setHasMoreOlder: (value: boolean) => void;
    setNextBeforeMessageId: (value: number | null) => void;
  },
): MessageChatHistoryItem[] {
  if (result.removedFromTop > 0 && result.adjustScrollYByPx > 0) {
    const nextScrollY = Math.max(
      0,
      refs.pinnedScrollYRef.current - result.adjustScrollYByPx,
    );
    refs.pendingPreserveScrollYRef.current = nextScrollY;
  }
  if (result.hasMoreOlder !== refs.hasMoreOlderRef.current) {
    refs.hasMoreOlderRef.current = result.hasMoreOlder;
    refs.setHasMoreOlder(result.hasMoreOlder);
  }
  if (result.nextBeforeMessageId !== refs.nextBeforeMessageIdRef.current) {
    const current = refs.nextBeforeMessageIdRef.current;
    const incoming = result.nextBeforeMessageId;
    // Smaller message ids are older — never regress the API pagination cursor.
    const shouldApply =
      incoming == null || current == null || incoming <= current;
    if (shouldApply) {
      refs.nextBeforeMessageIdRef.current = incoming;
      refs.setNextBeforeMessageId(incoming);
    }
  }
  return result.messages;
}

export function historyTailSignature(
  messages: readonly MessageChatHistoryItem[],
): string {
  if (messages.length === 0) return "0:0";
  return `${messages.length}:${messages[messages.length - 1]!.telegram_message_id}`;
}

/**
 * Oldest telegram message id in the buffer. Prefer this over messages[0] for
 * getChatHistory from_message_id — display sort is by sent_at, so the chronological
 * head can sit after a higher id when several rows share the same second.
 */
export function oldestHistoryMessageId(
  messages: readonly MessageChatHistoryItem[],
): number | null {
  let oldest: number | null = null;
  for (const row of messages) {
    const id = row.telegram_message_id;
    if (!Number.isFinite(id) || id <= 0) continue;
    if (oldest == null || id < oldest) oldest = id;
  }
  return oldest;
}

/** Keep only rows strictly older than the pagination cursor (TDLib exclusive). */
export function filterMessagesOlderThan(
  messages: readonly MessageChatHistoryItem[],
  beforeMessageId: number,
): MessageChatHistoryItem[] {
  if (!(beforeMessageId > 0)) return [...messages];
  return messages.filter((row) => row.telegram_message_id < beforeMessageId);
}
