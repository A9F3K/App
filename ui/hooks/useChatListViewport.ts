import { useCallback, useEffect, useState } from "react";

/** Initial rendered chat rows (telegram-tt CHAT_LIST_SLICE). */
export const CHAT_LIST_SLICE = 30;
/** Rows added per near-bottom expansion. */
export const CHAT_LIST_EXPAND_BY = 25;
/** Gateway first-paint main-list cap — matches INITIAL_MAIN_CHAT_SYNC_LIMIT. */
export const CHAT_LIST_INITIAL_SYNC_LIMIT = 50;

export function useChatListViewport(totalCount: number) {
  const [viewportCount, setViewportCount] = useState(() =>
    totalCount > 0 ? Math.min(CHAT_LIST_SLICE, totalCount) : 0,
  );

  useEffect(() => {
    setViewportCount((prev) => {
      if (totalCount <= 0) return 0;
      if (prev <= 0) return Math.min(CHAT_LIST_SLICE, totalCount);
      if (prev > totalCount) return totalCount;
      return prev;
    });
  }, [totalCount]);

  const expandViewport = useCallback(() => {
    setViewportCount((prev) => Math.min(totalCount, prev + CHAT_LIST_EXPAND_BY));
  }, [totalCount]);

  return {
    viewportCount,
    expandViewport,
    canExpandViewport: viewportCount < totalCount,
  };
}
