/**
 * Unified chat message list — telegram-tt alignment map.
 *
 * telegram-tt source of truth (Ajaxy/telegram-tt):
 * - MessageList.tsx          → MessageChatMessageList.tsx (compose + render)
 * - useScrollHooks.ts        → useChatScrollHooks.ts + MessageHistoryLoadSentinel
 * - loadViewportMessages     → chatOpenSession + fetchChatHistoryCharacterRange
 * - MESSAGE_LIST_SLICE       → messageChatViewportSlice / chatMessageWindow
 * - rememberScrollPosition   → chatScrollController.rememberBeforeUpdate
 * - UNREAD_DIVIDER_TOP       → messageListLayout.scrollYToAlignUnreadDivider
 * - ScrollDownButton         → MessageChatScrollToBottomButton + FAB thresholds
 *
 * Module ownership (one concern each):
 * - chatOpenSession.ts       open mode → fetch + scroll + display anchor
 * - chatMessageWindow.ts     count window over loaded buffer
 * - chatScrollController.ts  single mutation phase + remember/restore
 * - chatEdgeLoadPolicy.ts    older/newer load gate
 * - chatHistoryMerge.ts      merge/trim loaded buffer
 * - useChatScrollHooks.ts    sentinel-driven edge loads + FAB readiness
 * - messageChatHistoryPrefetch.ts  background + open first page
 *
 * Rules of the road:
 * 1. Always open with Around (older+newer context); tail-only is last-resort fallback.
 * 2. Sentinels are the primary edge trigger; near-top/bottom metrics are backup.
 * 3. chatScrollController.phase is the only mutation gate — do not add parallel booleans.
 * 4. On prepend release, re-pin display around the viewport message before clearing override.
 * 5. Display expand widens the in-buffer window only; API older loads use sentinels / near-top edge.
 */
export {
  resolveChatOpenSession,
  type ChatOpenSession,
  type ChatOpenSessionMode,
} from "./chatOpenSession";
export {
  openAround,
  followBottom,
  expandOlder,
  expandNewer,
  afterOlderPrepend,
  resolveDisplayWindow,
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
} from "./chatMessageWindow";
export {
  createChatScrollControllerState,
  beginPrependPhase,
  endPrependPhase,
  beginOpenSettlePhase,
  endOpenSettlePhase,
  rememberBeforeUpdate,
  restoreAfterUpdate,
  isChatScrollMutating,
  canEdgeLoad,
  type ChatScrollPhase,
} from "./chatScrollController";
export { decideChatEdgeLoad } from "./chatEdgeLoadPolicy";
export { mergeHistoryMessages, mergeTrimHistoryMessages } from "./chatHistoryMerge";
