import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ActivityIndicator, Text, View, type LayoutChangeEvent } from "react-native";
import { useAuth } from "../../../auth/AuthContext";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { useAuthenticatedHomeHistoryLoadTarget } from "../../authenticatedHomeSelectedChat";
import { chatLogFields, logPageDisplay } from "../../pageDisplayLog";
import {
  getCachedChatHistory,
  isChatHistoryCacheAnchorMatch,
  isChatHistoryCacheComplete,
  isChatHistoryCacheFresh,
  PREVIEW_FRESH_MS,
  mergeCachedChatHistoryTail,
  setCachedChatHistory,
  subscribeChatHistoryCache,
} from "../../messageChatHistoryCache";
import {
  loadOpenChatHistoryFirstPage,
  getOpenChatHistoryCacheAnchorSpec,
} from "../../messageChatHistoryPrefetch";
import {
  isChatScrollNearBottom,
  saveChatScrollPosition,
  type CachedChatScrollPosition,
} from "../../messageChatScrollCache";
import { subscribeOutgoingChatMessages } from "../../messageChatOutgoing";
import { layout, type ThemeColors } from "../../theme";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import {
  fetchTelegramChatHistoryPage,
  fetchTelegramChatHistorySince,
} from "../../telegram/fetchTelegramChatHistoryPage";
import { warmupTelegramChatSession } from "../../telegram/warmupTelegramChatSession";
import { viewTelegramChatInboxMessages } from "../../telegram/viewTelegramChatInboxMessages";
import { debounceLeading } from "../../util/debounceLeading";
import { HspScrollColumn, type HspScrollAnchor, type HspScrollColumnHandle, type HspScrollMetrics } from "../HspScrollColumn";
import {
  MESSAGE_BUBBLE_ROW_GAP_PX,
  MESSAGE_CHAT_BODY_PADDING_PX,
  MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
  MESSAGE_CHAT_HISTORY_NEWER_CATCHUP_PAGE_SIZE,
  MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
  MESSAGE_CHAT_LOADED_WINDOW_MAX,
  MESSAGE_CHAT_LOAD_NEWER_ERROR_BACKOFF_MS,
  MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX,
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import { patchAuthenticatedHomeSelectedChatReadOutbox, patchAuthenticatedHomeSelectedChatGroupMeta, patchAuthenticatedHomeSelectedChatUnread, setAuthenticatedHomeOpenChatFollowingBottom } from "../../authenticatedHomeSelectedChat";
import {
  effectiveReadOutboxMessageId as mergeReadOutboxCursor,
  enrichHistoryMessageDisplay,
  isPrivateChatForReadReceipts,
  isGroupLikeChatKind,
  maxReadOutboxMessageIdFromItems,
  mergeHistoryMessageRow,
  patchOutgoingStatusesWithReadOutbox,
  resolveHistoryMessageIsOutgoing,
  type HistoryMessageContext,
} from "./messageChatHistoryTypes";
import { MessageChatMessageRow } from "./MessageChatMessageRow";
import { MessageChatOlderHistoryLoadLine } from "./MessageChatOlderHistoryLoadLine";
import { MessageHistoryLoadSentinel } from "./MessageHistoryLoadSentinel";
import { MessageChatScrollToBottomButton } from "./MessageChatScrollToBottomButton";
import { resolveChatOpenScrollPlan } from "./resolveChatOpenScrollPlan";
import { prefetchOpenChatAvatars, setOpenChatAvatarPriority, isOpenChatAvatarPriority } from "./messageChatAvatarPrefetch";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  minIntersectingMessageId,
  resolveFirstUnreadMessageId,
  resolveLastReadMessageId,
  scrollYToAlignMessageBottomEdge,
  formatScrollToBottomUnreadCountLabel,
  isAtLoadedChatTail,
  maxFullyVisibleMessageId,
  maxIntersectingUnreadMessageId,
  topViewportAnchorMessageId,
  VIEW_INBOX_DEBOUNCE_MS,
  type MessageScrollLayoutEntry,
} from "./messageListLayout";
import {
  buildMessageListComputedLayouts,
  buildMessageListViewportAwareLayouts,
  estimateMessageListBlockTotalHeight,
  isMessageListVirtualizationActive,
  MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX,
  MESSAGE_LIST_VIRTUALIZE_MIN_ROWS,
  resolveMessageListVirtualWindow,
} from "./messageListVirtualWindow";
import { prefetchTelegramEmojiAssetsFromMessages } from "./fetchTelegramEmojiBytes";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
};

/** Rows kept below the viewport before tail eviction while scrolled up. */
const MESSAGE_TAIL_EVICT_BUFFER_ROWS = 15;
const MESSAGE_CHAT_LIVE_POLL_MS = 3_000;
const MESSAGE_CHAT_LIVE_POLL_STREAM_FALLBACK_MS = 30_000;
const CHAT_HISTORY_STREAM_ENABLED = typeof EventSource !== "undefined";
/** User must scroll up this far before older history loads after reopen. */
const LOAD_OLDER_SCROLL_UP_THRESHOLD_PX = 40;
/** User must scroll down this far before newer history loads after reopen. */
const LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX = 40;
/** Minimum gap between consecutive older-page fetches (avoids scroll thrash at top). */
const LOAD_OLDER_PAGE_COOLDOWN_MS = 500;
/** Only restore a prepend anchor if the viewport stayed near where the fetch started. */
const LOAD_OLDER_ANCHOR_MAX_DRIFT_PX = 80;

function chatLiveSignature(chat: MessageChatRowData): string {
  return [
    chat.last_message_at ?? "",
    chat.subtitle,
    chat.unread_count,
    chat.last_read_outbox_message_id ?? "",
    chat.chat_action ?? "",
    chat.chat_action_expires_at ?? "",
    chat.presence_kind ?? "",
  ].join("|");
}

function chatMessageTailSignature(chat: MessageChatRowData): string {
  return `${chat.last_message_at ?? ""}|${chat.subtitle}`;
}

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
      if (!row.is_outgoing || row.telegram_message_id === item.telegram_message_id) return false;
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

function mergeHistoryMessages(
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

type MergeTrimHistoryResult = {
  messages: MessageChatHistoryItem[];
  removedFromTop: number;
  adjustScrollYByPx: number;
  hasMoreOlder: boolean;
  nextBeforeMessageId: number | null;
};

function mergeTrimHistoryMessages(
  existing: MessageChatHistoryItem[],
  incoming: MessageChatHistoryItem[],
  ctx: HistoryMessageContext | undefined,
  options: {
    maxRows: number;
    keepEnd: boolean;
    layouts: ReadonlyMap<number, MessageScrollLayoutEntry>;
    heightCache: ReadonlyMap<number, number>;
    rowGapPx: number;
    hasMoreOlder: boolean;
    nextBeforeMessageId: number | null;
  },
): MergeTrimHistoryResult {
  const merged = mergeHistoryMessages(existing, incoming, ctx);
  if (merged.length <= options.maxRows) {
    return {
      messages: merged,
      removedFromTop: 0,
      adjustScrollYByPx: 0,
      hasMoreOlder: options.hasMoreOlder,
      nextBeforeMessageId: options.nextBeforeMessageId,
    };
  }

  const excess = merged.length - options.maxRows;
  if (options.keepEnd) {
    const adjustScrollYByPx = estimateMessageListBlockTotalHeight(
      merged.slice(0, excess),
      new Map(),
      options.heightCache,
      options.rowGapPx,
    );
    const messages = merged.slice(excess);
    return {
      messages,
      removedFromTop: excess,
      adjustScrollYByPx,
      hasMoreOlder: true,
      nextBeforeMessageId: messages[0]!.telegram_message_id,
    };
  }

  return {
    messages: merged.slice(0, options.maxRows),
    removedFromTop: 0,
    adjustScrollYByPx: 0,
    hasMoreOlder: options.hasMoreOlder,
    nextBeforeMessageId: options.nextBeforeMessageId,
  };
}

function applyMergeTrimResult(
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
    refs.nextBeforeMessageIdRef.current = result.nextBeforeMessageId;
    refs.setNextBeforeMessageId(result.nextBeforeMessageId);
  }
  return result.messages;
}

function applyHistoryMetaToSelectedChat(
  chatId: number,
  chatKind: MessageChatKind | null,
  memberCount: number | null,
): void {
  if (chatKind == null && memberCount == null) return;
  patchAuthenticatedHomeSelectedChatGroupMeta(chatId, {
    ...(chatKind != null ? { chat_kind: chatKind } : {}),
    ...(memberCount != null ? { member_count: memberCount } : {}),
  });
}

function historyTailSignature(messages: readonly MessageChatHistoryItem[]): string {
  if (messages.length === 0) return "0:0";
  return `${messages.length}:${messages[messages.length - 1]!.telegram_message_id}`;
}

export function MessageChatMessageList({ chat, colors }: Props) {
  const { t } = useAppStrings();
  const { isAuthenticated } = useAuth();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const historyLoad = useAuthenticatedHomeHistoryLoadTarget();
  const shouldLoadHistory =
    historyLoad.chatId === chat.telegram_chat_id && historyLoad.generation > 0;

  const [messages, setMessages] = useState<MessageChatHistoryItem[]>([]);
  const [chatKind, setChatKind] = useState<MessageChatKind | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [nextBeforeMessageId, setNextBeforeMessageId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReadOutboxFromHistory, setLastReadOutboxFromHistory] = useState<number | null>(null);
  const [selfUserId, setSelfUserId] = useState<number | null>(null);
  const [columnWidthPx, setColumnWidthPx] = useState(0);
  const openScrollPlan = useMemo(
    () => resolveChatOpenScrollPlan(chat),
    [chat.telegram_chat_id, chat.unread_count, historyLoad.generation],
  );
  const [isFollowingBottom, setIsFollowingBottom] = useState(
    () => openScrollPlan.followingBottom,
  );
  const [initialScrollInProgress, setInitialScrollInProgress] = useState(false);
  const [chatScrollPaintReady, setChatScrollPaintReady] = useState(false);
  const [isNearScrollTop, setIsNearScrollTop] = useState(false);
  const [isNearScrollBottom, setIsNearScrollBottom] = useState(false);
  const [scrollAnchorRestorePending, setScrollAnchorRestorePending] = useState(false);
  const scrollControllerRef = useRef<HspScrollColumnHandle | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadNewerRetryAfterRef = useRef(0);
  const nextBeforeMessageIdRef = useRef<number | null>(null);
  const pendingScrollAnchorRef = useRef<HspScrollAnchor | null>(null);
  const assignPendingScrollAnchor = useCallback((anchor: HspScrollAnchor | null) => {
    pendingScrollAnchorRef.current = anchor;
    setScrollAnchorRestorePending(anchor != null);
  }, []);
  const applyOlderPaginationCursor = useCallback(
    (hasMore: boolean, nextBefore: number | null) => {
      hasMoreOlderRef.current = hasMore;
      nextBeforeMessageIdRef.current = nextBefore;
      setHasMoreOlder(hasMore);
      setNextBeforeMessageId(nextBefore);
    },
    [],
  );
  const pendingScrollRestoreRef = useRef<CachedChatScrollPosition | null>(null);
  const pendingPreserveScrollYRef = useRef<number | null>(null);
  const pinnedScrollYRef = useRef(0);
  const pinnedLayoutHRef = useRef(0);
  const virtualScrollRafRef = useRef<number | null>(null);
  const pendingInitialScrollRef = useRef(false);
  const followingBottomRef = useRef(openScrollPlan.followingBottom);
  const allowUnreadResetAtBottomRef = useRef(false);
  const initialScrollInProgressRef = useRef(false);
  const openingUnreadCountRef = useRef(0);
  const unreadMarkingArmedRef = useRef(false);
  const unreadMarkingArmPendingRef = useRef(false);
  const unreadViewportBaselineMessageIdRef = useRef(0);
  const chatTailMessageIdRef = useRef<number | null>(null);
  const openScrollAnchorRef = useRef<"top" | "bottom">("bottom");
  const openScrollToLastReadBottomRef = useRef(false);
  const openUnreadAnchorMessageIdRef = useRef<number | null>(null);
  const openUnreadAnchorLockUntilRef = useRef(0);
  const openUnreadAnchorReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticScrollRef = useRef(false);
  const lastReadInboxMessageIdRef = useRef<number | null>(null);
  const lastViewedInboxMarkRef = useRef(0);
  const viewInboxInFlightRef = useRef(false);
  const pendingViewInboxMessageIdRef = useRef<number | null>(null);
  const prevDisplayLengthRef = useRef(0);
  const prevDisplayLastIdRef = useRef(0);
  const lastLiveSignatureRef = useRef("");
  const lastMessageTailSigRef = useRef("");
  const lastDisplayMessageIdRef = useRef(0);
  const historyPollInFlightRef = useRef(false);
  const historyPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesCountRef = useRef(0);
  const lastTailMessageIdRef = useRef(0);
  const lastAppliedCacheSignatureRef = useRef("");
  const lastAvatarPrefetchGenerationRef = useRef(0);
  const saveScrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevContentHForBottomStickRef = useRef(0);
  const historySyncKeyRef = useRef("");
  const chatScrollPaintReadyRef = useRef(false);
  const messageLayoutsRef = useRef<Map<number, MessageScrollLayoutEntry>>(new Map());
  const messageRowHeightCacheRef = useRef<Map<number, number>>(new Map());
  const lastDisplayedUnreadRemainingRef = useRef<number | null>(null);
  const virtualScrollTickRef = useRef(0);
  const [virtualScrollTick, setVirtualScrollTick] = useState(0);
  const displayMessagesRef = useRef<MessageChatHistoryItem[]>([]);
  const syncScrollBelowUnreadRef = useRef<(metrics: HspScrollMetrics) => void>(() => {});
  const scheduleSyncScrollBelowUnreadRef = useRef<() => void>(() => {});
  const loadNewerMessagesRef = useRef<() => Promise<void>>(async () => {});
  const loadOlderMessagesRef = useRef<() => Promise<void>>(async () => {});
  const loadOlderAdvanceChainRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const userScrollingUpRef = useRef(false);
  const loadOlderStartScrollYRef = useRef<number | null>(null);
  const lastOlderLoadFinishedAtRef = useRef(0);
  const virtualTopSpacerPxRef = useRef(0);
  /** Suppress bottom-stick scroll churn while row heights are still measuring. */
  const layoutSettlingUntilRef = useRef(0);
  const unreadSyncScheduledRef = useRef(false);
  const pendingEmojiPrefetchRef = useRef<MessageChatHistoryItem[] | null>(null);
  const loadOlderEnabledRef = useRef(false);
  const loadNewerEnabledRef = useRef(false);
  const userHasScrolledSinceOpenRef = useRef(false);
  const hasMoreOlderRef = useRef(false);
  const unreadCounterRafRef = useRef<number | null>(null);
  const pendingUnreadRemainingRef = useRef<number | null>(null);
  const openScrollOlderGateYRef = useRef(0);
  const openScrollNewerGateYRef = useRef(0);
  const lastPagedLoadEnableGenerationRef = useRef(0);
  const prevChatTailForOpeningUnreadRef = useRef(chat.last_message_telegram_id ?? 0);
  const prevChatUnreadForOpeningRef = useRef(chat.unread_count ?? 0);
  const chatKindRef = useRef<MessageChatKind | null>(chat.chat_kind ?? null);
  const pendingTvScrollMessageIdRef = useRef<number | null>(null);
  /** Open-scroll defers reveal until this row is measured — avoids estimate→layout twitch. */
  const openScrollAwaitingLayoutMessageIdRef = useRef<number | null>(null);
  const openScrollRevealFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openScrollSettleRetryRafRef = useRef<number | null>(null);
  const openScrollForceRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openScrollSettleRef = useRef({
    trySettle: (): boolean => false,
    scheduleRetry: (): void => {},
    forceReveal: (): void => {},
  });
  const chatLiveSignatureValue = chatLiveSignature(chat);
  const historyMessageContext = useMemo(
    (): HistoryMessageContext => ({
      peerUserId: chat.peer_user_id,
      selfUserId,
    }),
    [chat.peer_user_id, selfUserId],
  );

  const mergeHistoryWithWindow = useCallback(
    (
      prev: MessageChatHistoryItem[],
      incoming: MessageChatHistoryItem[],
      keepEnd: boolean,
    ): MessageChatHistoryItem[] => {
      const trimmed = mergeTrimHistoryMessages(prev, incoming, historyMessageContext, {
        maxRows: MESSAGE_CHAT_LOADED_WINDOW_MAX,
        keepEnd,
        layouts: messageLayoutsRef.current,
        heightCache: messageRowHeightCacheRef.current,
        rowGapPx: MESSAGE_BUBBLE_ROW_GAP_PX,
        hasMoreOlder: hasMoreOlderRef.current,
        nextBeforeMessageId: nextBeforeMessageIdRef.current,
      });
      const next = applyMergeTrimResult(trimmed, {
        hasMoreOlderRef,
        nextBeforeMessageIdRef,
        pendingPreserveScrollYRef,
        pinnedScrollYRef,
        setHasMoreOlder,
        setNextBeforeMessageId,
      });
      if (trimmed.removedFromTop > 0) {
        messageLayoutsRef.current.clear();
        virtualScrollTickRef.current += 1;
        setVirtualScrollTick(virtualScrollTickRef.current);
      }
      return next;
    },
    [historyMessageContext],
  );

  useEffect(() => {
    chatKindRef.current = chatKind ?? chat.chat_kind ?? null;
  }, [chatKind, chat.chat_kind]);

  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder;
  }, [hasMoreOlder]);

  useEffect(() => {
    messagesCountRef.current = messages.length;
    lastTailMessageIdRef.current =
      messages.length > 0 ? messages[messages.length - 1]!.telegram_message_id : 0;
  }, [messages]);

  const openSessionKeyRef = useRef<{
    chatId: number;
    generation: number;
  } | null>(null);

  useLayoutEffect(() => {
    const prev = openSessionKeyRef.current;
    const chatChanged = prev == null || prev.chatId !== chat.telegram_chat_id;
    const generationChanged = prev != null && prev.generation !== historyLoad.generation;
    if (!chatChanged && !generationChanged) return;

    openSessionKeyRef.current = {
      chatId: chat.telegram_chat_id,
      generation: historyLoad.generation,
    };

    const plan = resolveChatOpenScrollPlan(chat);
    openingUnreadCountRef.current = plan.openingUnreadCount;
    unreadMarkingArmPendingRef.current = plan.openingUnreadCount > 0;
    chatTailMessageIdRef.current = chat.last_message_telegram_id ?? null;
    openScrollAnchorRef.current = plan.openAnchor;
    openScrollToLastReadBottomRef.current = plan.scrollToLastReadBottom;
    pendingInitialScrollRef.current = plan.pendingInitialScroll;
    pendingScrollRestoreRef.current = plan.pendingScrollRestore;
    followingBottomRef.current = plan.followingBottom;
    setIsFollowingBottom(plan.followingBottom);
    setAuthenticatedHomeOpenChatFollowingBottom(plan.followingBottom);
    initialScrollInProgressRef.current =
      plan.pendingInitialScroll || plan.pendingScrollRestore != null;
    setInitialScrollInProgress(
      plan.pendingInitialScroll || plan.pendingScrollRestore != null,
    );

    if (chatChanged) {
      lastPagedLoadEnableGenerationRef.current = 0;
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastDisplayMessageIdRef.current = 0;
      prevDisplayLengthRef.current = 0;
      prevDisplayLastIdRef.current = 0;
      lastAppliedCacheSignatureRef.current = "";
      lastAvatarPrefetchGenerationRef.current = 0;
      messageLayoutsRef.current.clear();
      messageRowHeightCacheRef.current.clear();
      lastDisplayedUnreadRemainingRef.current = null;
      unreadMarkingArmedRef.current = false;
      unreadViewportBaselineMessageIdRef.current = 0;
      allowUnreadResetAtBottomRef.current = false;
      setChatScrollPaintReady(false);
      chatScrollPaintReadyRef.current = false;
      setIsNearScrollTop(false);
      setIsNearScrollBottom(false);
      assignPendingScrollAnchor(null);
      pendingEmojiPrefetchRef.current = null;
      prevContentHForBottomStickRef.current = 0;
      loadOlderEnabledRef.current = false;
      loadNewerEnabledRef.current = false;
      userHasScrolledSinceOpenRef.current = false;
      loadNewerRetryAfterRef.current = 0;
      if (unreadCounterRafRef.current != null) {
        cancelAnimationFrame(unreadCounterRafRef.current);
        unreadCounterRafRef.current = null;
      }
      pendingUnreadRemainingRef.current = null;
      openScrollOlderGateYRef.current = 0;
      openScrollNewerGateYRef.current = 0;
      openUnreadAnchorMessageIdRef.current = null;
      openUnreadAnchorLockUntilRef.current = 0;
      if (openUnreadAnchorReleaseTimerRef.current != null) {
        clearTimeout(openUnreadAnchorReleaseTimerRef.current);
        openUnreadAnchorReleaseTimerRef.current = null;
      }
      programmaticScrollRef.current = false;
      lastScrollYRef.current = 0;
      pinnedScrollYRef.current = 0;
      pinnedLayoutHRef.current = 0;
      userScrollingUpRef.current = false;
      virtualTopSpacerPxRef.current = 0;
      layoutSettlingUntilRef.current = 0;
      openScrollAwaitingLayoutMessageIdRef.current = null;
      if (openScrollRevealFallbackTimerRef.current != null) {
        clearTimeout(openScrollRevealFallbackTimerRef.current);
        openScrollRevealFallbackTimerRef.current = null;
      }
      if (openScrollSettleRetryRafRef.current != null) {
        cancelAnimationFrame(openScrollSettleRetryRafRef.current);
        openScrollSettleRetryRafRef.current = null;
      }
      if (openScrollForceRevealTimerRef.current != null) {
        clearTimeout(openScrollForceRevealTimerRef.current);
        openScrollForceRevealTimerRef.current = null;
      }
      lastOlderLoadFinishedAtRef.current = 0;
      prevChatTailForOpeningUnreadRef.current = chat.last_message_telegram_id ?? 0;
      prevChatUnreadForOpeningRef.current = plan.openingUnreadCount;
      lastReadInboxMessageIdRef.current = null;
      lastViewedInboxMarkRef.current = 0;
      pendingViewInboxMessageIdRef.current = null;
    } else if (generationChanged) {
      lastPagedLoadEnableGenerationRef.current = 0;
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastAppliedCacheSignatureRef.current = "";
      lastAvatarPrefetchGenerationRef.current = 0;
      unreadMarkingArmedRef.current = false;
      unreadViewportBaselineMessageIdRef.current = 0;
      allowUnreadResetAtBottomRef.current = false;
      loadOlderEnabledRef.current = false;
      loadNewerEnabledRef.current = false;
      userHasScrolledSinceOpenRef.current = false;
      setChatScrollPaintReady(false);
      chatScrollPaintReadyRef.current = false;
      setIsNearScrollTop(false);
      setIsNearScrollBottom(false);
      assignPendingScrollAnchor(null);
      pendingEmojiPrefetchRef.current = null;
      openScrollAwaitingLayoutMessageIdRef.current = null;
      if (openScrollRevealFallbackTimerRef.current != null) {
        clearTimeout(openScrollRevealFallbackTimerRef.current);
        openScrollRevealFallbackTimerRef.current = null;
      }
      if (openScrollSettleRetryRafRef.current != null) {
        cancelAnimationFrame(openScrollSettleRetryRafRef.current);
        openScrollSettleRetryRafRef.current = null;
      }
      if (openScrollForceRevealTimerRef.current != null) {
        clearTimeout(openScrollForceRevealTimerRef.current);
        openScrollForceRevealTimerRef.current = null;
      }
    }
  }, [assignPendingScrollAnchor, chat.telegram_chat_id, historyLoad.generation]);

  useEffect(() => {
    return () => {
      if (openScrollRevealFallbackTimerRef.current != null) {
        clearTimeout(openScrollRevealFallbackTimerRef.current);
      }
      if (virtualScrollRafRef.current != null) {
        cancelAnimationFrame(virtualScrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const tailId = chat.last_message_telegram_id;
    if (tailId != null && Number.isFinite(tailId) && tailId > 0) {
      chatTailMessageIdRef.current = tailId;
    }
  }, [chat.last_message_telegram_id]);

  useEffect(() => {
    const tailId = chat.last_message_telegram_id ?? 0;
    const polledUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
    const prevTailId = prevChatTailForOpeningUnreadRef.current;

    if (polledUnread > openingUnreadCountRef.current) {
      openingUnreadCountRef.current = polledUnread;
      if (polledUnread > 0 && !unreadMarkingArmedRef.current) {
        unreadMarkingArmPendingRef.current = true;
      }
    } else if (polledUnread <= 0) {
      openingUnreadCountRef.current = 0;
    } else if (tailId > prevTailId && polledUnread > prevChatUnreadForOpeningRef.current) {
      if (!unreadMarkingArmedRef.current) {
        unreadMarkingArmPendingRef.current = true;
      }
    }

    prevChatTailForOpeningUnreadRef.current = tailId;
    prevChatUnreadForOpeningRef.current = polledUnread;
  }, [chat.unread_count, chat.last_message_telegram_id]);

  useEffect(() => {
    return () => {
      const metrics = scrollControllerRef.current?.getMetrics();
      if (metrics && metrics.contentH > 0) {
        saveChatScrollPosition(chat.telegram_chat_id, {
          scrollY: metrics.scrollY,
          contentH: metrics.contentH,
          followingBottom:
            followingBottomRef.current ||
            isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH),
        });
      }
    };
  }, [chat.telegram_chat_id, historyLoad.generation]);

  const onColumnLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setColumnWidthPx((current) => (current === next ? current : next));
  }, []);

  const applyTdlibInboxReadResult = useCallback(
    (result: { unread_count: number; last_read_inbox_message_id: number | null }, viewedUpTo: number) => {
      lastViewedInboxMarkRef.current = Math.max(lastViewedInboxMarkRef.current, viewedUpTo);
      if (result.last_read_inbox_message_id != null) {
        lastReadInboxMessageIdRef.current = result.last_read_inbox_message_id;
      }
      patchAuthenticatedHomeSelectedChatUnread(result.unread_count);
      if (result.unread_count <= 0) {
        openingUnreadCountRef.current = 0;
      }
    },
    [],
  );

  const flushViewInboxMessages = useCallback(async () => {
    const messageId = pendingViewInboxMessageIdRef.current;
    if (messageId == null) return;
    if (viewInboxInFlightRef.current) return;
    viewInboxInFlightRef.current = true;
    try {
      const result = await viewTelegramChatInboxMessages(chat.telegram_chat_id, messageId);
      if (!result.error) {
        applyTdlibInboxReadResult(result, messageId);
      }
    } finally {
      viewInboxInFlightRef.current = false;
      const pending = pendingViewInboxMessageIdRef.current;
      if (pending != null && pending > lastViewedInboxMarkRef.current) {
        void flushViewInboxMessages();
      } else {
        pendingViewInboxMessageIdRef.current = null;
      }
    }
  }, [applyTdlibInboxReadResult, chat.telegram_chat_id]);

  const scheduleViewInboxMessages = useMemo(
    () =>
      debounceLeading((messageId: number) => {
        const prev = pendingViewInboxMessageIdRef.current;
        pendingViewInboxMessageIdRef.current =
          prev != null ? Math.max(prev, messageId) : messageId;
        void flushViewInboxMessages();
      }, VIEW_INBOX_DEBOUNCE_MS),
    [flushViewInboxMessages],
  );

  const scrollToBottom = useCallback(() => {
    loadNewerEnabledRef.current = true;
    scrollControllerRef.current?.scrollToEnd();
    followingBottomRef.current = true;
    setIsFollowingBottom(true);
    allowUnreadResetAtBottomRef.current = true;
    setAuthenticatedHomeOpenChatFollowingBottom(true);
    openingUnreadCountRef.current = 0;
    unreadMarkingArmedRef.current = false;
    unreadMarkingArmPendingRef.current = false;
    unreadViewportBaselineMessageIdRef.current = 0;
    const tailId = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
    if (tailId != null && Number.isFinite(tailId) && tailId > 0) {
      pendingViewInboxMessageIdRef.current = tailId;
      void flushViewInboxMessages();
    } else {
      patchAuthenticatedHomeSelectedChatUnread(0);
    }
    requestAnimationFrame(() => {
      const loadedTail = lastDisplayMessageIdRef.current;
      const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
      if (!isAtLoadedChatTail(loadedTail, chatTail)) {
        void loadNewerMessagesRef.current();
      }
    });
  }, [chat.last_message_telegram_id, flushViewInboxMessages]);

  /** Group/channel: anchor tall new tails at their top; private chats use {@link scrollToBottom}. */
  const tryScrollToFollowLiveTail = useCallback(
    (messageId: number): boolean => {
      const metrics = scrollControllerRef.current?.getMetrics();
      const entry = messageLayoutsRef.current.get(messageId);
      if (!metrics || metrics.layoutH <= 0 || !entry || entry.height <= 0) {
        return false;
      }
      followingBottomRef.current = true;
      setIsFollowingBottom(true);
      setAuthenticatedHomeOpenChatFollowingBottom(true);
      if (entry.height > metrics.layoutH + 0.5) {
        const targetY = Math.max(0, entry.y);
        scrollControllerRef.current?.scrollToY(targetY);
        pinnedScrollYRef.current = targetY;
      } else {
        scrollControllerRef.current?.scrollToEnd();
        allowUnreadResetAtBottomRef.current = true;
      }
      return true;
    },
    [],
  );

  const scrollToFollowNewContent = useCallback(() => {
    const effectiveKind = chatKindRef.current ?? chat.chat_kind;
    if (!isGroupLikeChatKind(effectiveKind)) {
      scrollToBottom();
      return;
    }
    const rows = displayMessagesRef.current;
    const tailId =
      rows.length > 0 ? rows[rows.length - 1]!.telegram_message_id : 0;
    if (tailId <= 0) {
      scrollToBottom();
      return;
    }
    pendingTvScrollMessageIdRef.current = tailId;
    if (!tryScrollToFollowLiveTail(tailId)) {
      requestAnimationFrame(() => {
        tryScrollToFollowLiveTail(tailId);
      });
    }
  }, [chat.chat_kind, scrollToBottom, tryScrollToFollowLiveTail]);

  const applyProgrammaticScrollY = useCallback((targetY: number) => {
    programmaticScrollRef.current = true;
    scrollControllerRef.current?.scrollToY(targetY);
    pinnedScrollYRef.current = targetY;
    lastScrollYRef.current = targetY;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }, []);

  const scheduleOpenUnreadAnchorRelease = useCallback((lockMs: number) => {
    openUnreadAnchorLockUntilRef.current = Date.now() + lockMs;
    if (openUnreadAnchorReleaseTimerRef.current != null) {
      clearTimeout(openUnreadAnchorReleaseTimerRef.current);
    }
    openUnreadAnchorReleaseTimerRef.current = setTimeout(() => {
      openUnreadAnchorReleaseTimerRef.current = null;
      openUnreadAnchorLockUntilRef.current = 0;
      initialScrollInProgressRef.current = false;
      setInitialScrollInProgress(false);
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    }, lockMs);
  }, []);

  const settleOpenBottomScroll = useCallback(() => {
    if (openScrollAnchorRef.current !== "bottom") return;
    const metrics = scrollControllerRef.current?.getMetrics();
    const contentFits =
      metrics != null &&
      metrics.layoutH > 0 &&
      metrics.contentH > 0 &&
      metrics.contentH <= metrics.layoutH + 0.5;
    if (!contentFits) {
      scrollControllerRef.current?.scrollToEnd();
    }
    initialScrollInProgressRef.current = false;
    setInitialScrollInProgress(false);
    allowUnreadResetAtBottomRef.current = true;
  }, []);

  const enablePagedLoadAfterOpenSettle = useCallback(
    (metrics: HspScrollMetrics, enableImmediately: boolean) => {
      scrollControllerRef.current?.clearNearTopLatch();
      scrollControllerRef.current?.clearNearBottomLatch();
      openScrollOlderGateYRef.current = metrics.scrollY;
      openScrollNewerGateYRef.current = metrics.scrollY;
      const loadedTailId =
        displayMessagesRef.current[displayMessagesRef.current.length - 1]
          ?.telegram_message_id ?? 0;
      const chatTail = chatTailMessageIdRef.current ?? 0;
      const hasMoreNewer =
        loadedTailId > 0 && chatTail > 0 && loadedTailId < chatTail;
      // Unread chats open at last-read bottom — never arm older loads until the user
      // scrolls up past the open gate (see tryUnlockPagedLoad).
      loadOlderEnabledRef.current =
        enableImmediately && openingUnreadCountRef.current <= 0;
      // Never arm newer catch-up automatically on open. If the cached window ends before
      // the live chat tail, user scroll intent must enable newer loading.
      loadNewerEnabledRef.current = enableImmediately && !hasMoreNewer;
    },
    [],
  );

  const persistChatScrollPosition = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0) return;
      const anchorId = topViewportAnchorMessageId(
        displayMessagesRef.current,
        messageLayoutsRef.current,
        metrics,
      );
      saveChatScrollPosition(chat.telegram_chat_id, {
        scrollY: metrics.scrollY,
        contentH: metrics.contentH,
        followingBottom:
          followingBottomRef.current ||
          isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH),
        ...(anchorId != null ? { anchorMessageId: anchorId } : {}),
      });
    },
    [chat.telegram_chat_id],
  );

  const resolveScrollLayoutMap = useCallback((
    metrics?: Pick<HspScrollMetrics, "scrollY" | "layoutH">,
  ): ReadonlyMap<number, { y: number; height: number }> => {
    const messages = displayMessagesRef.current;
    if (isMessageListVirtualizationActive(messages.length)) {
      const scrollMetrics = metrics ?? {
        scrollY: pinnedScrollYRef.current,
        layoutH:
          pinnedLayoutHRef.current > 0
            ? pinnedLayoutHRef.current
            : scrollControllerRef.current?.getMetrics().layoutH ?? 0,
      };
      if (scrollMetrics.layoutH > 0) {
        return buildMessageListViewportAwareLayouts(
          messages,
          messageLayoutsRef.current,
          messageRowHeightCacheRef.current,
          scrollMetrics,
          MESSAGE_BUBBLE_ROW_GAP_PX,
        );
      }
      return buildMessageListComputedLayouts(
        messages,
        messageRowHeightCacheRef.current,
        MESSAGE_BUBBLE_ROW_GAP_PX,
      );
    }
    return messageLayoutsRef.current;
  }, []);

  const reconcileOpenUnreadAnchorScroll = useCallback((): boolean => {
    if (Date.now() >= openUnreadAnchorLockUntilRef.current) return false;
    const anchorId = openUnreadAnchorMessageIdRef.current;
    if (anchorId == null || anchorId <= 0) return false;

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;

    const layoutMap = resolveScrollLayoutMap(metrics);
    const entry = layoutMap.get(anchorId);
    if (!entry || entry.height <= 0) return false;

    const targetY = scrollYToAlignMessageBottomEdge(
      entry,
      metrics.layoutH,
      metrics.contentH,
    );
    if (Math.abs(targetY - pinnedScrollYRef.current) <= 1) return true;

    applyProgrammaticScrollY(targetY);
    return true;
  }, [applyProgrammaticScrollY, resolveScrollLayoutMap]);

  const settleOpenLastReadBottomScroll = useCallback((): boolean => {
    const messages = displayMessagesRef.current;
    const lastReadId = resolveLastReadMessageId(
      messages,
      lastReadInboxMessageIdRef.current,
    );
    if (lastReadId == null) {
      const firstUnreadId = resolveFirstUnreadMessageId(
        messages,
        lastReadInboxMessageIdRef.current,
      );
      if (firstUnreadId == null) {
        settleOpenBottomScroll();
        return true;
      }
      // No read cursor in loaded window — open at top so unreads sit below.
      followingBottomRef.current = false;
      setIsFollowingBottom(false);
      setAuthenticatedHomeOpenChatFollowingBottom(false);
      unreadViewportBaselineMessageIdRef.current = Math.max(0, firstUnreadId - 1);
      unreadMarkingArmedRef.current = true;
      unreadMarkingArmPendingRef.current = false;
      allowUnreadResetAtBottomRef.current = false;
      openScrollAwaitingLayoutMessageIdRef.current = firstUnreadId;
      openUnreadAnchorMessageIdRef.current = null;
      scheduleOpenUnreadAnchorRelease(1500);
      applyProgrammaticScrollY(0);
      return true;
    }

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;

    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    unreadViewportBaselineMessageIdRef.current = lastReadId;
    unreadMarkingArmedRef.current = true;
    unreadMarkingArmPendingRef.current = false;
    allowUnreadResetAtBottomRef.current = false;
    openScrollAwaitingLayoutMessageIdRef.current = lastReadId;
    openUnreadAnchorMessageIdRef.current = lastReadId;
    scheduleOpenUnreadAnchorRelease(1500);

    const layoutMap = resolveScrollLayoutMap(metrics);
    const entry = layoutMap.get(lastReadId);
    if (!entry || entry.height <= 0) return false;

    const targetY = scrollYToAlignMessageBottomEdge(
      entry,
      metrics.layoutH,
      metrics.contentH,
    );
    applyProgrammaticScrollY(targetY);
    return true;
  }, [applyProgrammaticScrollY, resolveScrollLayoutMap, scheduleOpenUnreadAnchorRelease, settleOpenBottomScroll]);

  const tryArmUnreadMarking = useCallback((metrics: HspScrollMetrics): boolean => {
    if (!chatScrollPaintReadyRef.current) return false;
    if (!unreadMarkingArmPendingRef.current || unreadMarkingArmedRef.current) {
      return unreadMarkingArmedRef.current;
    }
    if (openingUnreadCountRef.current <= 0) {
      unreadMarkingArmPendingRef.current = false;
      return false;
    }
    if (metrics.contentH <= 0 || metrics.layoutH <= 0) return false;

    const layoutMap = resolveScrollLayoutMap(metrics);
    const anchorId = topViewportAnchorMessageId(
      displayMessagesRef.current,
      layoutMap,
      metrics,
    );
    let baselineExclusive = 0;
    if (anchorId != null && anchorId > 0) {
      baselineExclusive = anchorId - 1;
    } else {
      const maxVisibleId = maxFullyVisibleMessageId(
        displayMessagesRef.current,
        layoutMap,
        metrics,
      );
      if (maxVisibleId <= 0) return false;
      baselineExclusive = maxVisibleId - 1;
    }

    unreadViewportBaselineMessageIdRef.current = Math.max(0, baselineExclusive);
    unreadMarkingArmedRef.current = true;
    unreadMarkingArmPendingRef.current = false;
    return true;
  }, [resolveScrollLayoutMap]);

  const loadedDisplayTailId = useCallback((): number => {
    const rows = displayMessagesRef.current;
    return rows.length > 0 ? rows[rows.length - 1]!.telegram_message_id : 0;
  }, []);

  const shouldContinueNewerPageLoad = useCallback(
    (metrics: HspScrollMetrics): boolean => {
      const loadedTail = loadedDisplayTailId();
      const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
      if (isAtLoadedChatTail(loadedTail, chatTail)) return false;

      const nearBottom = isChatScrollNearBottom(
        metrics.scrollY,
        metrics.layoutH,
        metrics.contentH,
      );
      if (nearBottom || followingBottomRef.current) return true;

      const scrolledDownPastNewerGate =
        openingUnreadCountRef.current > 0 &&
        openScrollNewerGateYRef.current > 0 &&
        metrics.scrollY >
          openScrollNewerGateYRef.current + LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX;
      return scrolledDownPastNewerGate;
    },
    [chat.last_message_telegram_id, loadedDisplayTailId],
  );

  const isScrollNearBottom = useCallback((metrics: HspScrollMetrics): boolean => {
    const contentOverflows = metrics.contentH > metrics.layoutH + 0.5;
    return contentOverflows
      ? isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
      : openScrollAnchorRef.current === "bottom";
  }, []);

  const resolveEffectiveFollowingBottom = useCallback(
    (metrics: HspScrollMetrics): boolean => {
      if (openingUnreadCountRef.current > 0) return false;
      if (!isScrollNearBottom(metrics)) return false;
      return isAtLoadedChatTail(loadedDisplayTailId(), chatTailMessageIdRef.current);
    },
    [isScrollNearBottom, loadedDisplayTailId],
  );

  const tryUnlockPagedLoad = useCallback((metrics: HspScrollMetrics) => {
    if (!loadOlderEnabledRef.current) {
      const olderGateY = openScrollOlderGateYRef.current;
      if (olderGateY > 0) {
        const scrolledUpPastGate =
          metrics.scrollY < olderGateY - LOAD_OLDER_SCROLL_UP_THRESHOLD_PX;
        if (openingUnreadCountRef.current > 0) {
          // Unread catch-up opens near the top of the loaded window — only arm
          // older loads after the user scrolls up (not merely because scrollY is low).
          if (
            scrolledUpPastGate ||
            (userScrollingUpRef.current &&
              metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX)
          ) {
            loadOlderEnabledRef.current = true;
          }
        } else if (
          scrolledUpPastGate ||
          metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
        ) {
          loadOlderEnabledRef.current = true;
        }
      }
    }
    if (!loadNewerEnabledRef.current) {
      const newerGateY = openScrollNewerGateYRef.current;
      if (
        newerGateY > 0 &&
        metrics.scrollY > newerGateY + LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX
      ) {
        loadNewerEnabledRef.current = true;
      }
    }
  }, []);

  const scheduleVirtualLayoutRefresh = useCallback(() => {
    if (virtualScrollRafRef.current != null) return;
    virtualScrollRafRef.current = requestAnimationFrame(() => {
      virtualScrollRafRef.current = null;
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    });
  }, []);

  const scheduleVirtualScrollWindowUpdate = useCallback(() => {
    if (virtualScrollRafRef.current != null) return;
    virtualScrollRafRef.current = requestAnimationFrame(() => {
      virtualScrollRafRef.current = null;
      const msgs = displayMessagesRef.current;
      if (
        chatScrollPaintReadyRef.current &&
        isMessageListVirtualizationActive(msgs.length)
      ) {
        const layoutH = pinnedLayoutHRef.current;
        const metrics = scrollControllerRef.current?.getMetrics();
        if (layoutH > 0) {
          const nearBottomActual =
            metrics != null &&
            metrics.contentH > 0 &&
            isChatScrollNearBottom(
              pinnedScrollYRef.current,
              layoutH,
              metrics.contentH,
            );
          // Clamp using live DOM height only — estimate-based clamp fights row measure passes.
          if (
            metrics != null &&
            metrics.contentH > 0 &&
            !nearBottomActual
          ) {
            if (reconcileOpenUnreadAnchorScroll()) {
              // Anchor lock maintains last-read bottom edge during row measure passes.
            } else {
              const domMaxScrollY = Math.max(0, metrics.contentH - layoutH);
              if (pinnedScrollYRef.current > domMaxScrollY + 2) {
                pinnedScrollYRef.current = domMaxScrollY;
                scrollControllerRef.current?.scrollToY(domMaxScrollY);
              }
            }
          }
        }
      }
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    });
  }, [reconcileOpenUnreadAnchorScroll]);

  const tryLoadNewerNearVirtualTail = useCallback(
    (metrics: HspScrollMetrics) => {
      if (!chatScrollPaintReadyRef.current) return;
      if (initialScrollInProgressRef.current) return;
      if (Date.now() < openUnreadAnchorLockUntilRef.current) return;
      if (loadingNewerRef.current) return;
      if (loadingOlderRef.current) return;
      if (Date.now() < loadNewerRetryAfterRef.current) return;
      const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
      const loadedTail = loadedDisplayTailId();
      if (isAtLoadedChatTail(loadedTail, chatTail)) return;

      if (!loadNewerEnabledRef.current) {
        tryUnlockPagedLoad(metrics);
      }
      if (!loadNewerEnabledRef.current) return;
      if (!shouldContinueNewerPageLoad(metrics)) return;

      const msgs = displayMessagesRef.current;
      const layoutH =
        pinnedLayoutHRef.current > 0 ? pinnedLayoutHRef.current : metrics.layoutH;
      const nearBottom = isChatScrollNearBottom(
        pinnedScrollYRef.current,
        layoutH,
        metrics.contentH,
      );
      if (!nearBottom) return;

      if (isMessageListVirtualizationActive(msgs.length)) {
        const window = resolveMessageListVirtualWindow(
          msgs,
          messageRowHeightCacheRef.current,
          { scrollY: pinnedScrollYRef.current, layoutH },
          MESSAGE_BUBBLE_ROW_GAP_PX,
        );
        if (window.enabled && window.endIndex >= msgs.length - 2) {
          void loadNewerMessagesRef.current();
        }
        return;
      }

      void loadNewerMessagesRef.current();
    },
    [
      chat.last_message_telegram_id,
      loadedDisplayTailId,
      shouldContinueNewerPageLoad,
      tryUnlockPagedLoad,
    ],
  );

  const tryEvictMessageTail = useCallback(
    (metrics: HspScrollMetrics) => {
      if (!chatScrollPaintReadyRef.current) return;
      if (initialScrollInProgressRef.current) return;
      const msgs = displayMessagesRef.current;
      if (msgs.length <= MESSAGE_CHAT_LOADED_WINDOW_MAX) return;
      if (isScrollNearBottom(metrics)) return;

      const layoutMap = resolveScrollLayoutMap(metrics);
      const maxVisibleId = maxFullyVisibleMessageId(msgs, layoutMap, metrics);
      if (maxVisibleId <= 0) return;

      let lastKeepIndex = -1;
      for (let index = 0; index < msgs.length; index += 1) {
        if (msgs[index]!.telegram_message_id <= maxVisibleId) {
          lastKeepIndex = index;
        } else {
          break;
        }
      }
      if (lastKeepIndex < 0) return;

      const keepEnd = Math.min(
        msgs.length,
        lastKeepIndex + MESSAGE_TAIL_EVICT_BUFFER_ROWS + 1,
      );
      if (msgs.length - keepEnd < 10) return;

      let trimmed = msgs.slice(0, keepEnd);
      if (trimmed.length > MESSAGE_CHAT_LOADED_WINDOW_MAX) {
        trimmed = trimmed.slice(trimmed.length - MESSAGE_CHAT_LOADED_WINDOW_MAX);
      }
      if (trimmed.length === msgs.length) return;

      setMessages(trimmed);
      loadNewerEnabledRef.current = true;
      messageLayoutsRef.current.clear();
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    },
    [isScrollNearBottom, resolveScrollLayoutMap],
  );

  const handleScrollPositionChange = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0) {
        if (!chatScrollPaintReadyRef.current && metrics.layoutH > 0) {
          openScrollSettleRef.current.scheduleRetry();
        }
        return;
      }
      const deltaY = metrics.scrollY - lastScrollYRef.current;
      if (Math.abs(deltaY) > 0.5) {
        userScrollingUpRef.current = deltaY < 0;
        if (Math.abs(deltaY) > 2 && !programmaticScrollRef.current) {
          userHasScrolledSinceOpenRef.current = true;
        }
        if (
          Math.abs(deltaY) > 2 &&
          Date.now() < openUnreadAnchorLockUntilRef.current &&
          !programmaticScrollRef.current
        ) {
          openUnreadAnchorLockUntilRef.current = 0;
          if (openUnreadAnchorReleaseTimerRef.current != null) {
            clearTimeout(openUnreadAnchorReleaseTimerRef.current);
            openUnreadAnchorReleaseTimerRef.current = null;
          }
          initialScrollInProgressRef.current = false;
          setInitialScrollInProgress(false);
        }
      }
      lastScrollYRef.current = metrics.scrollY;
      pinnedScrollYRef.current = metrics.scrollY;
      if (metrics.layoutH > 0) {
        pinnedLayoutHRef.current = metrics.layoutH;
      }
      if (
        !chatScrollPaintReadyRef.current &&
        metrics.layoutH > 0 &&
        metrics.contentH > 0
      ) {
        if (!openScrollSettleRef.current.trySettle()) {
          openScrollSettleRef.current.scheduleRetry();
        }
      }
      scheduleVirtualScrollWindowUpdate();
      const nearBottom = isScrollNearBottom(metrics);
      const nearTop = metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX;
      setIsNearScrollTop((current) => (current === nearTop ? current : nearTop));
      setIsNearScrollBottom((current) => (current === nearBottom ? current : nearBottom));

      if (!nearBottom && !initialScrollInProgressRef.current) {
        tryEvictMessageTail(metrics);
      }

      if (initialScrollInProgressRef.current) {
        if (
          followingBottomRef.current &&
          openingUnreadCountRef.current <= 0 &&
          metrics.contentH > prevContentHForBottomStickRef.current + 2
        ) {
          prevContentHForBottomStickRef.current = metrics.contentH;
          if (Date.now() >= layoutSettlingUntilRef.current) {
            scrollToFollowNewContent();
          }
        } else {
          prevContentHForBottomStickRef.current = metrics.contentH;
        }
        const markingReady = tryArmUnreadMarking(metrics);
        if (nearBottom && openingUnreadCountRef.current <= 0 && (chat.unread_count ?? 0) <= 0) {
          initialScrollInProgressRef.current = false;
          setInitialScrollInProgress(false);
          followingBottomRef.current = true;
          setIsFollowingBottom(true);
          setAuthenticatedHomeOpenChatFollowingBottom(true);
          allowUnreadResetAtBottomRef.current = true;
          if (!chatScrollPaintReadyRef.current) {
            if (!openScrollSettleRef.current.trySettle()) {
              openScrollSettleRef.current.forceReveal();
            }
          }
        } else if (
          openingUnreadCountRef.current > 0 &&
          markingReady &&
          chatScrollPaintReadyRef.current
        ) {
          scheduleSyncScrollBelowUnreadRef.current();
        }
        return;
      }

      tryUnlockPagedLoad(metrics);
      tryLoadNewerNearVirtualTail(metrics);

      if (
        followingBottomRef.current &&
        openingUnreadCountRef.current <= 0 &&
        metrics.contentH > prevContentHForBottomStickRef.current + 2
      ) {
        prevContentHForBottomStickRef.current = metrics.contentH;
        if (Date.now() >= layoutSettlingUntilRef.current) {
          scrollToFollowNewContent();
        }
        if (saveScrollDebounceRef.current) {
          clearTimeout(saveScrollDebounceRef.current);
        }
        saveScrollDebounceRef.current = setTimeout(() => {
          saveScrollDebounceRef.current = null;
          persistChatScrollPosition(metrics);
        }, 200);
        return;
      }
      prevContentHForBottomStickRef.current = metrics.contentH;

      const markingReady = tryArmUnreadMarking(metrics);

      const followingBottom = resolveEffectiveFollowingBottom(metrics);
      followingBottomRef.current = followingBottom;
      setIsFollowingBottom((current) => (current === followingBottom ? current : followingBottom));
      setAuthenticatedHomeOpenChatFollowingBottom(followingBottom);

      if (nearBottom) {
        if (followingBottom) {
          allowUnreadResetAtBottomRef.current = true;
          if (openingUnreadCountRef.current <= 0 && (chat.unread_count ?? 0) <= 0) {
            /* TDLib unread already cleared */
          } else if (markingReady) {
            scheduleSyncScrollBelowUnreadRef.current();
          }
        } else if (markingReady) {
          scheduleSyncScrollBelowUnreadRef.current();
        }
      } else if (openingUnreadCountRef.current > 0 && markingReady) {
        scheduleSyncScrollBelowUnreadRef.current();
      }

      if (
        nearBottom &&
        loadNewerEnabledRef.current &&
        !loadingNewerRef.current &&
        !isAtLoadedChatTail(
          loadedDisplayTailId(),
          chatTailMessageIdRef.current ?? chat.last_message_telegram_id,
        )
      ) {
        void loadNewerMessagesRef.current();
      }

      if (
        nearTop &&
        !initialScrollInProgressRef.current &&
        Date.now() >= openUnreadAnchorLockUntilRef.current
      ) {
        const canArmOlder =
          openingUnreadCountRef.current > 0
            ? userScrollingUpRef.current
            : userScrollingUpRef.current || metrics.scrollY <= 48;
        if (canArmOlder) {
          tryUnlockPagedLoad(metrics);
          if (
            openingUnreadCountRef.current <= 0 &&
            !loadOlderEnabledRef.current &&
            metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
          ) {
            loadOlderEnabledRef.current = true;
          }
        }
        if (
          loadOlderEnabledRef.current &&
          hasMoreOlderRef.current &&
          !loadingOlderRef.current
        ) {
          void loadOlderMessagesRef.current();
        }
      }

      tryLoadNewerNearVirtualTail(metrics);

      if (saveScrollDebounceRef.current) {
        clearTimeout(saveScrollDebounceRef.current);
      }
      saveScrollDebounceRef.current = setTimeout(() => {
        saveScrollDebounceRef.current = null;
        persistChatScrollPosition(metrics);
      }, 300);
    },
    [
      chat.last_message_telegram_id,
      chat.unread_count,
      loadedDisplayTailId,
      scheduleVirtualScrollWindowUpdate,
      tryArmUnreadMarking,
      tryEvictMessageTail,
      tryUnlockPagedLoad,
      tryLoadNewerNearVirtualTail,
      isScrollNearBottom,
      persistChatScrollPosition,
      resolveEffectiveFollowingBottom,
      scrollToBottom,
      scrollToFollowNewContent,
    ],
  );

  useEffect(() => {
    const flushScrollPosition = () => {
      const metrics = scrollControllerRef.current?.getMetrics();
      if (metrics && metrics.contentH > 0) {
        persistChatScrollPosition(metrics);
      }
    };
    if (typeof globalThis !== "undefined" && "addEventListener" in globalThis) {
      globalThis.addEventListener("pagehide", flushScrollPosition);
      return () => {
        globalThis.removeEventListener("pagehide", flushScrollPosition);
        if (saveScrollDebounceRef.current) {
          clearTimeout(saveScrollDebounceRef.current);
          saveScrollDebounceRef.current = null;
        }
      };
    }
    return () => {
      if (saveScrollDebounceRef.current) {
        clearTimeout(saveScrollDebounceRef.current);
        saveScrollDebounceRef.current = null;
      }
    };
  }, [persistChatScrollPosition]);

  const preserveScrollY = useCallback((scrollY: number) => {
    let attempts = 0;
    const maxAttempts = 12;

    const tryPreserve = (): boolean => {
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return false;
      const maxScroll = Math.max(0, metrics.contentH - metrics.layoutH);
      const targetY = Math.min(Math.max(0, scrollY), maxScroll);
      scrollControllerRef.current?.scrollToY(targetY);
      pinnedScrollYRef.current = targetY;
      const atBottom = isChatScrollNearBottom(
        targetY,
        metrics.layoutH,
        metrics.contentH,
      );
      const follow =
        atBottom &&
        openingUnreadCountRef.current <= 0 &&
        isAtLoadedChatTail(loadedDisplayTailId(), chatTailMessageIdRef.current);
      followingBottomRef.current = follow;
      setIsFollowingBottom(follow);
      return true;
    };

    const run = () => {
      if (tryPreserve() || ++attempts >= maxAttempts) return;
      requestAnimationFrame(run);
    };

    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }, []);

  const captureScrollYIfScrolledUp = useCallback((): number | null => {
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return null;
    if (isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)) return null;
    return metrics.scrollY;
  }, []);

  const restoreChatScrollPosition = useCallback((state: CachedChatScrollPosition): boolean => {
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return false;

    if (state.followingBottom && openingUnreadCountRef.current <= 0) {
      const contentFits = metrics.contentH <= metrics.layoutH + 0.5;
      if (!contentFits) {
        scrollControllerRef.current?.scrollToEnd();
      }
      const atTrueTail = isAtLoadedChatTail(
        loadedDisplayTailId(),
        chatTailMessageIdRef.current,
      );
      const follow = atTrueTail && openingUnreadCountRef.current <= 0;
      followingBottomRef.current = follow;
      setIsFollowingBottom(follow);
      setAuthenticatedHomeOpenChatFollowingBottom(follow);
      allowUnreadResetAtBottomRef.current = follow;
      return true;
    }

    const maxScroll = Math.max(0, metrics.contentH - metrics.layoutH);
    const targetY = Math.min(Math.max(0, state.scrollY), maxScroll);
    scrollControllerRef.current?.scrollToY(targetY);
    pinnedScrollYRef.current = targetY;
    const atBottom = isChatScrollNearBottom(
      targetY,
      metrics.layoutH,
      metrics.contentH,
    );
    const follow =
      atBottom &&
      isAtLoadedChatTail(loadedDisplayTailId(), chatTailMessageIdRef.current) &&
      openingUnreadCountRef.current <= 0;
    followingBottomRef.current = follow;
    setIsFollowingBottom(follow);
    setAuthenticatedHomeOpenChatFollowingBottom(follow);
    allowUnreadResetAtBottomRef.current = follow;
    return true;
  }, [loadedDisplayTailId]);

  const applyCachedHistoryPage = useCallback(
    (cached: NonNullable<ReturnType<typeof getCachedChatHistory>>, options?: { replace?: boolean }) => {
      const replace = options?.replace !== false;
      const cachedMaxId =
        cached.messages.length > 0
          ? cached.messages[cached.messages.length - 1]!.telegram_message_id
          : 0;
      const cacheSignature = `${cached.fetchedAt}:${cached.messages.length}:${cachedMaxId}:${cached.previewOnly ? 1 : 0}:${cached.aroundUnread ? 1 : 0}:${cached.aroundMessageId ?? ""}`;
      if (!replace && cacheSignature === lastAppliedCacheSignatureRef.current) {
        return;
      }
      if (replace) {
        setMessages((prev) => {
          if (
            prev.length > 0 &&
            historyTailSignature(prev) === historyTailSignature(cached.messages)
          ) {
            return prev;
          }
          if (
            prev.length > 0 &&
            cached.messages.length < prev.length &&
            !chatScrollPaintReadyRef.current
          ) {
            return prev;
          }
          return mergeHistoryWithWindow([], cached.messages, true);
        });
      } else {
        setMessages((prev) => {
          const prevHead = prev[0]?.telegram_message_id ?? 0;
          const cacheHead = cached.messages[0]?.telegram_message_id ?? 0;
          const extendsOlder =
            cacheHead > 0 && (prevHead === 0 || cacheHead < prevHead);
          const next = mergeHistoryWithWindow(prev, cached.messages, !extendsOlder);
          if (historyTailSignature(next) === historyTailSignature(prev)) return prev;
          return next;
        });
      }
      lastAppliedCacheSignatureRef.current = cacheSignature;
      setChatKind(cached.chatKind);
      if (cached.selfUserId != null) {
        setSelfUserId(cached.selfUserId);
      }
      applyHistoryMetaToSelectedChat(
        chat.telegram_chat_id,
        cached.chatKind,
        cached.memberCount,
      );
      if (!cached.previewOnly) {
        setHasMoreOlder(cached.hasMoreOlder);
        setNextBeforeMessageId(cached.nextBeforeMessageId);
      }
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, cached.lastReadOutboxMessageId),
      );
      if (cached.lastReadInboxMessageId != null) {
        lastReadInboxMessageIdRef.current = cached.lastReadInboxMessageId;
      }
      setLoadingInitial(false);
      setError(null);
    },
    [chat.telegram_chat_id, historyMessageContext, mergeHistoryWithWindow],
  );

  const readOutboxCursor = useMemo(
    () =>
      mergeReadOutboxCursor(
        chat.last_read_outbox_message_id,
        lastReadOutboxFromHistory,
        maxReadOutboxMessageIdFromItems(messages),
      ),
    [chat.last_read_outbox_message_id, lastReadOutboxFromHistory, messages],
  );

  useEffect(() => {
    patchAuthenticatedHomeSelectedChatReadOutbox(readOutboxCursor);
  }, [readOutboxCursor]);

  useEffect(() => {
    if (selfUserId == null) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        const isOutgoing = resolveHistoryMessageIsOutgoing({
          rawIsOutgoing: row.is_outgoing,
          senderUserId: row.sender_user_id,
          peerUserId: chat.peer_user_id,
          selfUserId,
        });
        if (isOutgoing === row.is_outgoing) return row;
        changed = true;
        return { ...row, is_outgoing: isOutgoing };
      });
      return changed ? next : prev;
    });
  }, [selfUserId, chat.peer_user_id]);

  const displayMessages = useMemo(() => {
    const enriched = messages.map(enrichHistoryMessageDisplay);
    const effectiveChatKind = chatKind ?? chat.chat_kind ?? null;
    if (!isPrivateChatForReadReceipts(effectiveChatKind, chat)) return enriched;
    return patchOutgoingStatusesWithReadOutbox(enriched, readOutboxCursor);
  }, [
    chat.chat_kind,
    chat.peer_user_id,
    chatKind,
    messages,
    readOutboxCursor,
  ]);

  const displayMessagesSigRef = useRef("");
  const [displayMessagesLayoutSig, setDisplayMessagesLayoutSig] = useState("");

  useEffect(() => {
    displayMessagesRef.current = displayMessages;
    const sig = displayMessages.map((m) => m.telegram_message_id).join(",");
    if (sig !== displayMessagesSigRef.current) {
      displayMessagesSigRef.current = sig;
      setDisplayMessagesLayoutSig(sig);
      const liveIds = new Set(displayMessages.map((m) => m.telegram_message_id));
      for (const id of messageLayoutsRef.current.keys()) {
        if (!liveIds.has(id)) messageLayoutsRef.current.delete(id);
      }
      for (const id of messageRowHeightCacheRef.current.keys()) {
        if (!liveIds.has(id)) messageRowHeightCacheRef.current.delete(id);
      }
    }
  }, [displayMessages]);

  const syncScrollBelowUnread = useCallback(
    (metrics: HspScrollMetrics) => {
      if (!chatScrollPaintReadyRef.current) return;
      if (metrics.contentH <= 0 || metrics.layoutH <= 0) return;
      const serverUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
      if (serverUnread <= 0 && openingUnreadCountRef.current <= 0) return;
      if (!unreadMarkingArmedRef.current) return;

      const layoutMap = resolveScrollLayoutMap(metrics);
      const baseline =
        lastReadInboxMessageIdRef.current ?? unreadViewportBaselineMessageIdRef.current;
      const minVisibleId = minIntersectingMessageId(
        displayMessagesRef.current,
        layoutMap,
        metrics,
      );
      if (minVisibleId != null && minVisibleId > 0) {
        unreadViewportBaselineMessageIdRef.current = Math.min(
          unreadViewportBaselineMessageIdRef.current,
          minVisibleId - 1,
        );
      }

      const maxVisibleUnreadId = maxIntersectingUnreadMessageId(
        displayMessagesRef.current,
        layoutMap,
        metrics,
        baseline,
      );
      if (
        maxVisibleUnreadId != null &&
        maxVisibleUnreadId > lastViewedInboxMarkRef.current
      ) {
        scheduleViewInboxMessages(maxVisibleUnreadId);
        logPageDisplay("messages_scroll_unread_sync", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          viewedUpTo: maxVisibleUnreadId,
          serverUnread,
          baseline,
        });
      }

      const nearBottom = isScrollNearBottom(metrics);
      const chatTailId = chatTailMessageIdRef.current;
      const loadedTailId =
        displayMessagesRef.current[displayMessagesRef.current.length - 1]
          ?.telegram_message_id ?? 0;
      if (
        loadedTailId > 0 &&
        chatTailId != null &&
        chatTailId > 0 &&
        loadedTailId < chatTailId &&
        nearBottom &&
        !loadingNewerRef.current &&
        Date.now() >= loadNewerRetryAfterRef.current
      ) {
        loadNewerEnabledRef.current = true;
        void loadNewerMessagesRef.current();
      }
    },
    [
      chat.telegram_chat_id,
      chat.peer_user_id,
      chat.title,
      chat.unread_count,
      isScrollNearBottom,
      resolveScrollLayoutMap,
      scheduleViewInboxMessages,
    ],
  );

  const scheduleSyncScrollBelowUnread = useCallback(() => {
    if (unreadSyncScheduledRef.current) return;
    unreadSyncScheduledRef.current = true;
    requestAnimationFrame(() => {
      unreadSyncScheduledRef.current = false;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (metrics && metrics.contentH > 0 && metrics.layoutH > 0) {
        syncScrollBelowUnreadRef.current(metrics);
      }
    });
  }, []);

  const refreshScrollUnreadFab = useCallback(() => {
    scheduleSyncScrollBelowUnread();
  }, [scheduleSyncScrollBelowUnread]);

  const refreshScrollUnreadFabRef = useRef<() => void>(() => {});

  useEffect(() => {
    syncScrollBelowUnreadRef.current = syncScrollBelowUnread;
  }, [syncScrollBelowUnread]);

  useEffect(() => {
    scheduleSyncScrollBelowUnreadRef.current = scheduleSyncScrollBelowUnread;
  }, [scheduleSyncScrollBelowUnread]);

  useEffect(() => {
    refreshScrollUnreadFabRef.current = refreshScrollUnreadFab;
  }, [refreshScrollUnreadFab]);

  useEffect(() => {
    if (!chatScrollPaintReady) return;
    if (openingUnreadCountRef.current <= 0) return;
    if (!unreadMarkingArmPendingRef.current && !unreadMarkingArmedRef.current) {
      return;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return;
    if (tryArmUnreadMarking(metrics) || unreadMarkingArmedRef.current) {
      scheduleSyncScrollBelowUnread();
    }
  }, [
    chatScrollPaintReady,
    displayMessagesLayoutSig,
    scheduleSyncScrollBelowUnread,
    tryArmUnreadMarking,
  ]);

  const lastDisplayMessageId =
    displayMessages.length > 0
      ? displayMessages[displayMessages.length - 1]!.telegram_message_id
      : 0;

  useEffect(() => {
    chatScrollPaintReadyRef.current = chatScrollPaintReady;
    if (!chatScrollPaintReady) return;
    const pending = pendingEmojiPrefetchRef.current;
    if (pending == null || pending.length === 0) return;
    pendingEmojiPrefetchRef.current = null;
    prefetchTelegramEmojiAssetsFromMessages(pending);
  }, [chatScrollPaintReady]);

  const revealChatScroll = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    chatScrollPaintReadyRef.current = true;
    layoutSettlingUntilRef.current = Date.now() + 800;
    setChatScrollPaintReady(true);
  }, []);

  const clearOpenScrollRevealFallback = useCallback(() => {
    if (openScrollRevealFallbackTimerRef.current != null) {
      clearTimeout(openScrollRevealFallbackTimerRef.current);
      openScrollRevealFallbackTimerRef.current = null;
    }
  }, []);

  const runOpenScrollPostSettleWork = useCallback(
    (enableImmediately: boolean) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const settledMetrics = scrollControllerRef.current?.getMetrics();
          if (settledMetrics && settledMetrics.contentH > 0) {
            enablePagedLoadAfterOpenSettle(settledMetrics, enableImmediately);
            if (chatScrollPaintReadyRef.current) {
              if (tryArmUnreadMarking(settledMetrics)) {
                syncScrollBelowUnreadRef.current(settledMetrics);
              } else if (unreadMarkingArmedRef.current) {
                syncScrollBelowUnreadRef.current(settledMetrics);
              }
            }
          }
        });
      });
    },
    [enablePagedLoadAfterOpenSettle, tryArmUnreadMarking],
  );

  const finishOpenScrollReveal = useCallback(
    (enableImmediately: boolean) => {
      clearOpenScrollRevealFallback();
      openScrollAwaitingLayoutMessageIdRef.current = null;
      if (!openScrollToLastReadBottomRef.current) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
      } else if (openUnreadAnchorLockUntilRef.current <= Date.now()) {
        scheduleOpenUnreadAnchorRelease(1500);
      }
      revealChatScroll();
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
      runOpenScrollPostSettleWork(enableImmediately);
    },
    [clearOpenScrollRevealFallback, revealChatScroll, runOpenScrollPostSettleWork, scheduleOpenUnreadAnchorRelease],
  );

  const beginOpenScrollRevealWait = useCallback(
    (enableImmediately: boolean) => {
      clearOpenScrollRevealFallback();
      const waitMs = openScrollAwaitingLayoutMessageIdRef.current != null ? 400 : 150;
      openScrollRevealFallbackTimerRef.current = setTimeout(() => {
        openScrollRevealFallbackTimerRef.current = null;
        finishOpenScrollReveal(enableImmediately);
      }, waitMs);
    },
    [clearOpenScrollRevealFallback, finishOpenScrollReveal],
  );

  const tryCompleteOpenScrollAfterLayout = useCallback(
    (messageId: number, entry: { y: number; height: number }): boolean => {
      if (chatScrollPaintReadyRef.current) return false;
      if (openScrollAwaitingLayoutMessageIdRef.current !== messageId) return false;

      const anchorMessageId = messageId;
      openScrollAwaitingLayoutMessageIdRef.current = null;
      clearOpenScrollRevealFallback();

      if (openScrollToLastReadBottomRef.current) {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (metrics && metrics.layoutH > 0 && metrics.contentH > 0) {
          const layoutMap = resolveScrollLayoutMap(metrics);
          const layoutEntry = layoutMap.get(anchorMessageId);
          if (layoutEntry && layoutEntry.height > 0) {
            const targetY = scrollYToAlignMessageBottomEdge(
              layoutEntry,
              metrics.layoutH,
              metrics.contentH,
            );
            openUnreadAnchorMessageIdRef.current = anchorMessageId;
            applyProgrammaticScrollY(targetY);
            scheduleOpenUnreadAnchorRelease(1500);
          }
        }
      } else if (
        openScrollAnchorRef.current === "bottom" &&
        openingUnreadCountRef.current <= 0
      ) {
        scrollControllerRef.current?.scrollToEnd();
      }

      const enableImmediately =
        (openScrollAnchorRef.current === "bottom" &&
          openingUnreadCountRef.current <= 0 &&
          followingBottomRef.current);
      if (!openScrollToLastReadBottomRef.current) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
      }
      revealChatScroll();
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
      runOpenScrollPostSettleWork(enableImmediately);
      return true;
    },
    [applyProgrammaticScrollY, clearOpenScrollRevealFallback, revealChatScroll, resolveScrollLayoutMap, runOpenScrollPostSettleWork, scheduleOpenUnreadAnchorRelease],
  );

  const trySettleOpenChatScroll = useCallback((): boolean => {
    if (displayMessages.length === 0) {
      if (!loadingInitial) revealChatScroll();
      return true;
    }

    if (pendingScrollRestoreRef.current) {
      const state = pendingScrollRestoreRef.current;
      if (!restoreChatScrollPosition(state)) return false;
      pendingScrollRestoreRef.current = null;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      let anchorId =
        state.anchorMessageId != null && Number.isFinite(state.anchorMessageId)
          ? Math.trunc(state.anchorMessageId)
          : 0;
      if (anchorId <= 0) {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (metrics && metrics.contentH > 0 && metrics.layoutH > 0) {
          const layoutMap = resolveScrollLayoutMap(metrics);
          const resolved = topViewportAnchorMessageId(
            displayMessagesRef.current,
            layoutMap,
            metrics,
          );
          if (resolved != null && resolved > 0) anchorId = resolved;
        }
      }
      openScrollAwaitingLayoutMessageIdRef.current = anchorId > 0 ? anchorId : null;
      beginOpenScrollRevealWait(false);
      return true;
    }

    if (pendingInitialScrollRef.current) {
      const scrollToLastReadBottom = openScrollToLastReadBottomRef.current;
      if (!scrollToLastReadBottom) {
        pendingInitialScrollRef.current = false;
      }
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;
      if (scrollToLastReadBottom) {
        if (!settleOpenLastReadBottomScroll()) {
          return false;
        }
        pendingInitialScrollRef.current = false;
      } else {
        settleOpenBottomScroll();
        const rows = displayMessagesRef.current;
        const tailId =
          rows.length > 0 ? rows[rows.length - 1]!.telegram_message_id : 0;
        openScrollAwaitingLayoutMessageIdRef.current = tailId > 0 ? tailId : null;
      }
      beginOpenScrollRevealWait(
        openScrollAnchorRef.current === "bottom" &&
          openingUnreadCountRef.current <= 0 &&
          followingBottomRef.current,
      );
      return true;
    }

    if (!chatScrollPaintReadyRef.current) {
      beginOpenScrollRevealWait(false);
    }
    return true;
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    loadingInitial,
    restoreChatScrollPosition,
    revealChatScroll,
    resolveScrollLayoutMap,
    settleOpenBottomScroll,
    settleOpenLastReadBottomScroll,
    beginOpenScrollRevealWait,
  ]);

  const clearOpenScrollSettleRetry = useCallback(() => {
    if (openScrollSettleRetryRafRef.current != null) {
      cancelAnimationFrame(openScrollSettleRetryRafRef.current);
      openScrollSettleRetryRafRef.current = null;
    }
  }, []);

  const forceRevealOpenChatScroll = useCallback(() => {
    clearOpenScrollRevealFallback();
    clearOpenScrollSettleRetry();
    if (openScrollForceRevealTimerRef.current != null) {
      clearTimeout(openScrollForceRevealTimerRef.current);
      openScrollForceRevealTimerRef.current = null;
    }
    openScrollAwaitingLayoutMessageIdRef.current = null;
    pendingInitialScrollRef.current = false;
    initialScrollInProgressRef.current = false;
    setInitialScrollInProgress(false);
    revealChatScroll();
  }, [clearOpenScrollRevealFallback, clearOpenScrollSettleRetry, revealChatScroll]);

  const scheduleOpenScrollSettleRetry = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    if (openScrollSettleRetryRafRef.current != null) return;
    let attempts = 0;
    const tick = () => {
      openScrollSettleRetryRafRef.current = null;
      if (chatScrollPaintReadyRef.current) return;
      const settled = trySettleOpenChatScroll();
      if (!settled && ++attempts < 60) {
        openScrollSettleRetryRafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (!settled) {
        forceRevealOpenChatScroll();
      }
    };
    openScrollSettleRetryRafRef.current = requestAnimationFrame(tick);
  }, [forceRevealOpenChatScroll, trySettleOpenChatScroll]);

  const scheduleOpenScrollForceReveal = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    if (openScrollForceRevealTimerRef.current != null) return;
    openScrollForceRevealTimerRef.current = setTimeout(() => {
      openScrollForceRevealTimerRef.current = null;
      if (!chatScrollPaintReadyRef.current) {
        forceRevealOpenChatScroll();
      }
    }, 900);
  }, [forceRevealOpenChatScroll]);

  openScrollSettleRef.current = {
    trySettle: trySettleOpenChatScroll,
    scheduleRetry: scheduleOpenScrollSettleRetry,
    forceReveal: forceRevealOpenChatScroll,
  };

  const bumpVirtualLayoutFromMeasure = useCallback(
    (messageId: number, prevHeight: number, nextHeight: number) => {
      if (!isMessageListVirtualizationActive(displayMessagesRef.current.length)) return;
      if (Math.abs(prevHeight - nextHeight) <= 1) return;
      scheduleVirtualLayoutRefresh();
    },
    [scheduleVirtualLayoutRefresh],
  );

  const handleMessageLayout = useCallback((messageId: number, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const virtualActive = isMessageListVirtualizationActive(displayMessagesRef.current.length);
    if (height > 0) {
      const rowIndex = displayMessagesRef.current.findIndex(
        (row) => row.telegram_message_id === messageId,
      );
      const rowGap =
        rowIndex > 0 ? MESSAGE_BUBBLE_ROW_GAP_PX : 0;
      const contentHeight = Math.max(0, height - rowGap);

      const prevContentHeight =
        messageRowHeightCacheRef.current.get(messageId) ??
        MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
      const prevBlockHeight = prevContentHeight + rowGap;

      if (!virtualActive) {
        messageLayoutsRef.current.set(messageId, { y, height });
      }

      if (tryCompleteOpenScrollAfterLayout(messageId, { y, height })) {
        messageRowHeightCacheRef.current.set(messageId, contentHeight);
        return;
      }

      if (
        chatScrollPaintReadyRef.current &&
        height > prevBlockHeight + 1 &&
        !loadingNewerRef.current &&
        !loadingOlderRef.current &&
        pendingScrollAnchorRef.current == null &&
        Date.now() >= openUnreadAnchorLockUntilRef.current
      ) {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (
          metrics &&
          metrics.contentH > 0 &&
          metrics.layoutH > 0 &&
          !isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
        ) {
          let rowBottom = y + prevBlockHeight;
          if (virtualActive && rowIndex >= 0) {
            let rowTop = 0;
            for (let i = 0; i < rowIndex; i += 1) {
              const id = displayMessagesRef.current[i]!.telegram_message_id;
              const cached =
                messageRowHeightCacheRef.current.get(id) ??
                MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
              rowTop += cached + (i > 0 ? MESSAGE_BUBBLE_ROW_GAP_PX : 0);
            }
            rowBottom = rowTop + prevBlockHeight;
          }
          if (rowBottom <= metrics.scrollY + 0.5) {
            const delta = height - prevBlockHeight;
            const nextY = metrics.scrollY + delta;
            scrollControllerRef.current?.scrollToY(nextY);
            pinnedScrollYRef.current = nextY;
            lastScrollYRef.current = nextY;
          }
        }
      }
      messageRowHeightCacheRef.current.set(messageId, contentHeight);
      if (chatScrollPaintReadyRef.current) {
        bumpVirtualLayoutFromMeasure(messageId, prevContentHeight, contentHeight);
        if (messageId === openUnreadAnchorMessageIdRef.current) {
          reconcileOpenUnreadAnchorScroll();
        }
      }
    }
    if (pendingTvScrollMessageIdRef.current === messageId) {
      if (tryScrollToFollowLiveTail(messageId)) {
        pendingTvScrollMessageIdRef.current = null;
      }
      return;
    }
    if (pendingInitialScrollRef.current && openScrollToLastReadBottomRef.current) {
      trySettleOpenChatScroll();
    }
  }, [bumpVirtualLayoutFromMeasure, reconcileOpenUnreadAnchorScroll, tryCompleteOpenScrollAfterLayout, tryScrollToFollowLiveTail, trySettleOpenChatScroll]);

  useEffect(() => {
    if (!shouldLoadHistory || loadingInitial || displayMessages.length === 0) return;
    if (lastPagedLoadEnableGenerationRef.current === historyLoad.generation) return;

    let attempts = 0;
    const settlePagedLoadGates = () => {
      if (lastPagedLoadEnableGenerationRef.current === historyLoad.generation) return;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (
        !metrics ||
        metrics.layoutH <= 0 ||
        metrics.contentH <= 0
      ) {
        if (++attempts < 24) requestAnimationFrame(settlePagedLoadGates);
        return;
      }
      lastPagedLoadEnableGenerationRef.current = historyLoad.generation;
      const enableImmediately =
        (openScrollAnchorRef.current === "bottom" &&
          openingUnreadCountRef.current <= 0 &&
          followingBottomRef.current);
      enablePagedLoadAfterOpenSettle(metrics, enableImmediately);
      scrollControllerRef.current?.clearNearTopLatch();
      scrollControllerRef.current?.clearNearBottomLatch();
    };

    requestAnimationFrame(settlePagedLoadGates);
  }, [
    displayMessages.length,
    enablePagedLoadAfterOpenSettle,
    historyLoad.generation,
    loadingInitial,
    shouldLoadHistory,
  ]);

  const handleOpenScrollMetrics = useCallback(
    (metrics: Omit<HspScrollMetrics, "scrollY">) => {
      if (metrics.layoutH > 0) {
        pinnedLayoutHRef.current = metrics.layoutH;
      }
      if (chatScrollPaintReadyRef.current) return;
      if (metrics.layoutH <= 0) return;
      if (displayMessages.length === 0 && !loadingInitial) {
        revealChatScroll();
        return;
      }
      if (displayMessages.length === 0) return;
      if (!trySettleOpenChatScroll()) {
        scheduleOpenScrollSettleRetry();
      }
    },
    [
      displayMessages.length,
      loadingInitial,
      revealChatScroll,
      scheduleOpenScrollSettleRetry,
      trySettleOpenChatScroll,
    ],
  );

  useEffect(() => {
    if (!shouldLoadHistory || displayMessages.length === 0) return;
    if (!chatScrollPaintReady) return;
    if (lastAvatarPrefetchGenerationRef.current === historyLoad.generation) return;
    lastAvatarPrefetchGenerationRef.current = historyLoad.generation;
    const effectiveChatKind = chatKind ?? chat.chat_kind ?? null;
    prefetchOpenChatAvatars(chat, displayMessages, effectiveChatKind);
    return () => {
      if (isOpenChatAvatarPriority(chat.telegram_chat_id)) {
        setOpenChatAvatarPriority(null);
      }
    };
  }, [
    chat.telegram_chat_id,
    chat.chat_kind,
    chatKind,
    displayMessages.length,
    historyLoad.generation,
    shouldLoadHistory,
    chatScrollPaintReady,
  ]);

  useEffect(() => {
    nextBeforeMessageIdRef.current = nextBeforeMessageId;
  }, [nextBeforeMessageId]);

  useEffect(() => {
    lastDisplayMessageIdRef.current = lastDisplayMessageId;
  }, [lastDisplayMessageId]);

  useLayoutEffect(() => {
    if (!chatScrollPaintReadyRef.current) {
      if (!trySettleOpenChatScroll()) {
        scheduleOpenScrollSettleRetry();
      }
      scheduleOpenScrollForceReveal();
    }

    if (displayMessages.length === 0) return;

    if (pendingScrollAnchorRef.current) {
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      return;
    }

    if (pendingPreserveScrollYRef.current != null) {
      const scrollY = pendingPreserveScrollYRef.current;
      pendingPreserveScrollYRef.current = null;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      preserveScrollY(scrollY);
      return;
    }

    const prevLen = prevDisplayLengthRef.current;
    const prevLastId = prevDisplayLastIdRef.current;
    const lengthGrew = displayMessages.length > prevLen;
    const newerTail = lastDisplayMessageId > prevLastId;
    prevDisplayLengthRef.current = displayMessages.length;
    prevDisplayLastIdRef.current = lastDisplayMessageId;

    if (
      followingBottomRef.current &&
      openingUnreadCountRef.current <= 0 &&
      isAtLoadedChatTail(lastDisplayMessageId, chatTailMessageIdRef.current) &&
      !loadingOlderRef.current &&
      (newerTail || lengthGrew) &&
      Date.now() >= layoutSettlingUntilRef.current
    ) {
      scrollToFollowNewContent();
      return;
    }

    if (lengthGrew && !newerTail) {
      if (!pendingScrollAnchorRef.current) {
        const prependAnchor = scrollControllerRef.current?.captureScrollAnchor();
        if (prependAnchor) {
          assignPendingScrollAnchor(prependAnchor);
        } else {
          preserveScrollY(pinnedScrollYRef.current);
        }
      }
      return;
    }

    if (
      (newerTail || lengthGrew) &&
      !loadingOlderRef.current &&
      !loadingNewerRef.current &&
      !followingBottomRef.current
    ) {
      const anchor = scrollControllerRef.current?.captureScrollAnchor();
      if (anchor) {
        assignPendingScrollAnchor(anchor);
      } else {
        preserveScrollY(pinnedScrollYRef.current);
      }
    }
  }, [
    assignPendingScrollAnchor,
    displayMessages.length,
    lastDisplayMessageId,
    preserveScrollY,
    scheduleOpenScrollForceReveal,
    scheduleOpenScrollSettleRetry,
    scrollToFollowNewContent,
    trySettleOpenChatScroll,
  ]);

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    assignPendingScrollAnchor(null);
    scrollControllerRef.current?.restoreScrollAnchor(anchor);
    scrollControllerRef.current?.clearNearTopLatch();
    scrollControllerRef.current?.clearNearBottomLatch();
    // restoreScrollAnchor retries across frames — sync scroll refs after it settles.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.contentH <= 0) return;
        lastScrollYRef.current = metrics.scrollY;
        pinnedScrollYRef.current = metrics.scrollY;
        if (metrics.layoutH > 0) {
          const nearBottom = isChatScrollNearBottom(
            metrics.scrollY,
            metrics.layoutH,
            metrics.contentH,
          );
          setIsNearScrollBottom((current) => (current === nearBottom ? current : nearBottom));
        }
        if (openingUnreadCountRef.current > 0) {
          refreshScrollUnreadFabRef.current();
        }
      });
    });
  }, [assignPendingScrollAnchor, messages]);

  useEffect(() => {
    return subscribeOutgoingChatMessages(({ chatId, message }) => {
      if (chatId !== chat.telegram_chat_id) return;
      if (!followingBottomRef.current) {
        const anchor = scrollControllerRef.current?.captureScrollAnchor();
        if (anchor) assignPendingScrollAnchor(anchor);
      }
      setMessages((prev) => mergeHistoryWithWindow(prev, [message], true));
    });
  }, [chat.telegram_chat_id, assignPendingScrollAnchor, mergeHistoryWithWindow]);

  useEffect(() => {
    if (!shouldLoadHistory) return;
    return subscribeChatHistoryCache((chatId) => {
      if (chatId !== chat.telegram_chat_id) return;
      if (
        openingUnreadCountRef.current > 0 &&
        messagesCountRef.current > 0 &&
        (chat.unread_count ?? 0) > 0
      ) {
        return;
      }
      const cached = getCachedChatHistory(chatId);
      if (cached == null || cached.messages.length === 0) return;
      if (
        !isChatHistoryCacheAnchorMatch(
          chatId,
          getOpenChatHistoryCacheAnchorSpec(chat),
        )
      ) {
        return;
      }
      const cachedMaxId =
        cached.messages[cached.messages.length - 1]?.telegram_message_id ?? 0;
      const effectiveKind = chatKind ?? chat.chat_kind;
      const isPrivateLike = isPrivateChatForReadReceipts(effectiveKind, chat);
      const loadedTail = lastTailMessageIdRef.current;
      const atTrueTail = isAtLoadedChatTail(
        loadedTail,
        chat.last_message_telegram_id ?? chatTailMessageIdRef.current,
      );
      if (isPrivateLike && !atTrueTail && cachedMaxId > loadedTail) {
        return;
      }
      const cacheSignature = `${cached.fetchedAt}:${cached.messages.length}:${cachedMaxId}:${cached.previewOnly ? 1 : 0}:${cached.aroundUnread ? 1 : 0}:${cached.aroundMessageId ?? ""}`;
      if (cacheSignature === lastAppliedCacheSignatureRef.current) return;
      if (cached.previewOnly && lastTailMessageIdRef.current > cachedMaxId) return;
      if (!cached.previewOnly && lastTailMessageIdRef.current > cachedMaxId) return;
      applyCachedHistoryPage(cached, { replace: false });
      logPageDisplay("messages_history_cache_hit", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        count: cached.messages.length,
        fresh: isChatHistoryCacheFresh(chat.telegram_chat_id),
        source: "cache_listener",
      });
    });
  }, [
    applyCachedHistoryPage,
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    chat.chat_kind,
    chatKind,
    shouldLoadHistory,
  ]);

  // Apply cached history (or clear stale rows) before paint when switching chats.
  useLayoutEffect(() => {
    if (!shouldLoadHistory || !isAuthenticated || !isTelegramMessagesConnected) {
      historySyncKeyRef.current = "";
      return;
    }
    const historyKey = `${chat.telegram_chat_id}:${historyLoad.generation}`;
    if (historySyncKeyRef.current === historyKey) return;
    historySyncKeyRef.current = historyKey;

    const historyAnchorSpec = getOpenChatHistoryCacheAnchorSpec(chat);
    const cached = getCachedChatHistory(chat.telegram_chat_id);
    const cacheHit =
      cached != null &&
      cached.messages.length > 0 &&
      isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec);

    if (cacheHit) {
      applyCachedHistoryPage(cached, { replace: true });
      return;
    }

    const staleCached = getCachedChatHistory(chat.telegram_chat_id);
    if (
      staleCached != null &&
      staleCached.messages.length > 0 &&
      isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec)
    ) {
      applyCachedHistoryPage(staleCached, { replace: true });
      return;
    }

    setMessages([]);
    setChatKind(null);
    setHasMoreOlder(false);
    setNextBeforeMessageId(null);
    setLastReadOutboxFromHistory(null);
    setSelfUserId(null);
  }, [
    applyCachedHistoryPage,
    chat,
    historyLoad.generation,
    isAuthenticated,
    isTelegramMessagesConnected,
    shouldLoadHistory,
  ]);

  useEffect(() => {
    if (!shouldLoadHistory || !isAuthenticated || !isTelegramMessagesConnected) {
      setMessages([]);
      setChatKind(null);
      setError(null);
      setLoadingInitial(false);
      setHasMoreOlder(false);
      setNextBeforeMessageId(null);
      setLastReadOutboxFromHistory(null);
      setSelfUserId(null);
      return;
    }

    let cancelled = false;
    setError(null);

    const historyAnchorSpec = getOpenChatHistoryCacheAnchorSpec(chat);
    const cached = getCachedChatHistory(chat.telegram_chat_id);
    const cacheHit =
      cached != null &&
      cached.messages.length > 0 &&
      isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec);

    if (cacheHit) {
      applyCachedHistoryPage(cached, { replace: true });
      lastLiveSignatureRef.current = chatLiveSignature(chat);
      lastMessageTailSigRef.current = chatMessageTailSignature(chat);
      logPageDisplay("messages_history_cache_hit", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        count: cached.messages.length,
        fresh: isChatHistoryCacheFresh(chat.telegram_chat_id),
      });
    } else {
      const staleCached = getCachedChatHistory(chat.telegram_chat_id);
      if (
        staleCached != null &&
        staleCached.messages.length > 0 &&
        isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec)
      ) {
        applyCachedHistoryPage(staleCached, { replace: true });
      } else {
        setLoadingInitial(true);
        setMessages([]);
        setChatKind(null);
        setHasMoreOlder(false);
        setNextBeforeMessageId(null);
        setLastReadOutboxFromHistory(null);
        setSelfUserId(null);
      }
      logPageDisplay("messages_history_load_start", chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }));
    }

    void (async () => {
      const runNetworkLoad = async () => {
        try {
          const result = await loadOpenChatHistoryFirstPage(
            chat.telegram_chat_id,
            chat.peer_user_id,
            chat,
          );
          if (cancelled) return;
          if (result.error) {
            throw new Error(result.error);
          }
          setCachedChatHistory(chat.telegram_chat_id, result, {
            previewOnly: false,
            aroundUnread: historyAnchorSpec.aroundUnread,
            aroundMessageId: historyAnchorSpec.aroundMessageId ?? null,
          });
          setMessages((prev) => mergeHistoryWithWindow(prev, result.messages, true));
          setChatKind(result.chatKind);
          if (result.selfUserId != null) {
            setSelfUserId(result.selfUserId);
          }
          applyHistoryMetaToSelectedChat(
            chat.telegram_chat_id,
            result.chatKind,
            result.memberCount,
          );
          setHasMoreOlder(result.hasMoreOlder);
          setNextBeforeMessageId(result.nextBeforeMessageId);
          setLastReadOutboxFromHistory((prev) =>
            mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
          );
          if (result.lastReadInboxMessageId != null) {
            lastReadInboxMessageIdRef.current = result.lastReadInboxMessageId;
          }
          logPageDisplay(cacheHit ? "messages_history_cache_revalidated" : "messages_history_load_ok", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            count: result.messages.length,
            chatKind: result.chatKind,
            hasMoreOlder: result.hasMoreOlder,
          });
          telegramEmojiDebug.historySummary(
            result.messages,
            chat.peer_emoji_status_custom_emoji_id ?? null,
          );
          pendingEmojiPrefetchRef.current = result.messages;
          lastLiveSignatureRef.current = chatLiveSignature(chat);
          lastMessageTailSigRef.current = chatMessageTailSignature(chat);
        } catch (e) {
          if (cancelled) return;
          const message = e instanceof Error ? e.message : String(e);
          if (cacheHit) {
            logPageDisplay("messages_history_cache_revalidate_error", {
              ...chatLogFields({
                chatId: chat.telegram_chat_id,
                peerUserId: chat.peer_user_id,
                title: chat.title,
              }),
              message,
            });
            return;
          }
          logPageDisplay("messages_history_load_error", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            message,
          });
          setError(message);
          setMessages([]);
          setHasMoreOlder(false);
          setNextBeforeMessageId(null);
        } finally {
          if (!cancelled && !cacheHit) setLoadingInitial(false);
        }
      };

      try {
        const cacheComplete =
          cacheHit && isChatHistoryCacheComplete(chat.telegram_chat_id);
        const cachedTailId =
          cacheHit && cached!.messages.length > 0
            ? cached!.messages[cached!.messages.length - 1]!.telegram_message_id
            : 0;
        const cacheCoversChatTail = isAtLoadedChatTail(
          cachedTailId,
          chat.last_message_telegram_id,
        );
        if (
          cacheComplete &&
          cacheCoversChatTail &&
          isChatHistoryCacheFresh(chat.telegram_chat_id) &&
          isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec)
        ) {
          return;
        }

        const previewFresh =
          cacheHit &&
          cached!.previewOnly &&
          isChatHistoryCacheFresh(chat.telegram_chat_id, PREVIEW_FRESH_MS) &&
          isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, historyAnchorSpec);

        if (previewFresh) {
          const scheduleDeferred = (fn: () => void) => {
            if (typeof requestIdleCallback === "function") {
              requestIdleCallback(() => {
                if (!cancelled) fn();
              }, { timeout: 1_500 });
              return;
            }
            setTimeout(() => {
              if (!cancelled) fn();
            }, 80);
          };
          scheduleDeferred(() => {
            void runNetworkLoad();
          });
          return;
        }

        if (cacheHit) {
          setLoadingInitial(true);
        }

        await runNetworkLoad();
      } catch {
        /* runNetworkLoad handles errors */
      } finally {
        if (!cancelled && cacheHit) setLoadingInitial(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    chat.telegram_chat_id,
    chat.peer_user_id,
    chat.title,
    historyLoad.generation,
    isAuthenticated,
    isTelegramMessagesConnected,
    shouldLoadHistory,
    applyCachedHistoryPage,
  ]);

  useEffect(() => {
    if (!shouldLoadHistory || !isAuthenticated || !isTelegramMessagesConnected || loadingInitial) {
      return;
    }

    let cancelled = false;

    const pollLatest = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (historyPollInFlightRef.current) return;
      const signature = chatLiveSignatureValue;
      if (signature === lastLiveSignatureRef.current) return;

      const messageTailSig = chatMessageTailSignature(chat);
      const listTailChanged = messageTailSig !== lastMessageTailSigRef.current;

      if (!listTailChanged && lastMessageTailSigRef.current !== "") {
        lastLiveSignatureRef.current = signature;
        return;
      }

      const loadedTailId = lastDisplayMessageIdRef.current;
      const chatTailId = chat.last_message_telegram_id ?? chatTailMessageIdRef.current;
      const atTrueTailBeforeFetch = isAtLoadedChatTail(loadedTailId, chatTailId);
      const effectiveKind = chatKindRef.current ?? chat.chat_kind;
      const isPrivateLike = isPrivateChatForReadReceipts(effectiveKind, chat);

      if (isPrivateLike && !atTrueTailBeforeFetch && listTailChanged) {
        chatTailMessageIdRef.current = chat.last_message_telegram_id ?? chatTailMessageIdRef.current;
        lastLiveSignatureRef.current = signature;
        lastMessageTailSigRef.current = messageTailSig;
        const polledUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
        if (polledUnread > 0) {
          patchAuthenticatedHomeSelectedChatUnread(polledUnread);
        }
        logPageDisplay("messages_live_tail_deferred_private", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          loadedTailId,
          chatTailId: chatTailId ?? null,
          polledUnread,
        });
        return;
      }

      historyPollInFlightRef.current = true;
      try {
        const sinceMessageId = lastDisplayMessageIdRef.current;
        let result =
          sinceMessageId > 0
            ? await fetchTelegramChatHistorySince(
                chat.telegram_chat_id,
                sinceMessageId,
                MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
                chat.peer_user_id,
              )
            : await fetchTelegramChatHistoryPage(
                chat.telegram_chat_id,
                MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
                chat.peer_user_id,
              );
        if (cancelled) return;

        if (result.error) {
          if (sinceMessageId > 0 && listTailChanged) {
            result = await fetchTelegramChatHistoryPage(
              chat.telegram_chat_id,
              MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
              chat.peer_user_id,
            );
            if (cancelled || result.error) return;
          } else {
            return;
          }
        }

        if (
          result.messages.length === 0 &&
          listTailChanged &&
          sinceMessageId > 0
        ) {
          result = await fetchTelegramChatHistoryPage(
            chat.telegram_chat_id,
            MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
            chat.peer_user_id,
          );
          if (cancelled || result.error) return;
        }

        lastLiveSignatureRef.current = signature;
        lastMessageTailSigRef.current = messageTailSig;

        if (result.messages.length === 0) {
          if (result.lastReadOutboxMessageId != null) {
            setLastReadOutboxFromHistory((prev) =>
              mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
            );
          }
          return;
        }

        const atTrueTail = isAtLoadedChatTail(
          sinceMessageId,
          chat.last_message_telegram_id ?? chatTailMessageIdRef.current,
        );
        if (
          isPrivateLike &&
          !atTrueTail
        ) {
          lastLiveSignatureRef.current = signature;
          lastMessageTailSigRef.current = messageTailSig;
          return;
        }
        if (!atTrueTail && !followingBottomRef.current) {
          const metrics = scrollControllerRef.current?.getMetrics();
          if (
            metrics &&
            metrics.contentH > 0 &&
            !isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
          ) {
            lastLiveSignatureRef.current = signature;
            lastMessageTailSigRef.current = messageTailSig;
            return;
          }
        }

        const preserveScrollYBeforeMerge = captureScrollYIfScrolledUp();
        const scrollAnchorBeforeMerge =
          !followingBottomRef.current
            ? scrollControllerRef.current?.captureScrollAnchor()
            : null;
        let tailGrew = false;
        setMessages((prev) => {
          const next = mergeHistoryWithWindow(prev, result.messages, true);
          const prevMaxId = prev.length > 0 ? prev[prev.length - 1]!.telegram_message_id : 0;
          const mergedMaxId =
            next.length > 0 ? next[next.length - 1]!.telegram_message_id : 0;
          tailGrew = mergedMaxId > prevMaxId;
          return next;
        });
        if (tailGrew && !followingBottomRef.current) {
          if (scrollAnchorBeforeMerge) {
            assignPendingScrollAnchor(scrollAnchorBeforeMerge);
          } else if (preserveScrollYBeforeMerge != null) {
            pendingPreserveScrollYRef.current = preserveScrollYBeforeMerge;
          }
        }
        if (result.selfUserId != null) {
          setSelfUserId(result.selfUserId);
        }
        setLastReadOutboxFromHistory((prev) =>
          mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
        );
        applyHistoryMetaToSelectedChat(
          chat.telegram_chat_id,
          result.chatKind,
          result.memberCount,
        );
        if (tailGrew) {
          mergeCachedChatHistoryTail(chat.telegram_chat_id, result);
        }
        if (tailGrew) {
          void import("../../telegram/warmupTelegramChatSession").then(({ warmupTelegramChatSession }) => {
            void warmupTelegramChatSession(chat.telegram_chat_id);
          });
        }
      } finally {
        historyPollInFlightRef.current = false;
      }
    };

    const schedulePollLatest = () => {
      if (historyPollTimerRef.current != null) {
        clearTimeout(historyPollTimerRef.current);
      }
      historyPollTimerRef.current = setTimeout(() => {
        historyPollTimerRef.current = null;
        void pollLatest();
      }, 300);
    };

    schedulePollLatest();

    const pollMs = CHAT_HISTORY_STREAM_ENABLED
      ? MESSAGE_CHAT_LIVE_POLL_STREAM_FALLBACK_MS
      : MESSAGE_CHAT_LIVE_POLL_MS;
    const timer = setInterval(() => {
      schedulePollLatest();
    }, pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (historyPollTimerRef.current != null) {
        clearTimeout(historyPollTimerRef.current);
        historyPollTimerRef.current = null;
      }
    };
  }, [
    chat,
    chat.telegram_chat_id,
    chatLiveSignatureValue,
    captureScrollYIfScrolledUp,
    assignPendingScrollAnchor,
    historyMessageContext,
    mergeHistoryWithWindow,
    isAuthenticated,
    isTelegramMessagesConnected,
    shouldLoadHistory,
    loadingInitial,
  ]);

  const loadOlderMessages = useCallback(async () => {
    const beforeMessageId = nextBeforeMessageIdRef.current;
    if (
      loadingInitial ||
      loadingOlderRef.current ||
      !hasMoreOlder ||
      beforeMessageId == null
    ) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }

    if (initialScrollInProgressRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }

    if (Date.now() < openUnreadAnchorLockUntilRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }

    if (openingUnreadCountRef.current > 0 && !loadOlderEnabledRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }

    const startMetrics = scrollControllerRef.current?.getMetrics();
    const startScrollY = startMetrics?.scrollY ?? 0;
    if (startScrollY > MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    if (
      !loadOlderAdvanceChainRef.current &&
      Date.now() - lastOlderLoadFinishedAtRef.current < LOAD_OLDER_PAGE_COOLDOWN_MS
    ) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    loadOlderAdvanceChainRef.current = false;

    loadOlderStartScrollYRef.current = startScrollY;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    followingBottomRef.current = false;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const scrollAnchor = scrollControllerRef.current?.captureScrollAnchor();
    const headBeforeLoad =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    const lengthBeforeLoad = displayMessagesRef.current.length;
    let shouldChainOlderLoad = false;

    logPageDisplay("messages_history_load_older_start", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      beforeMessageId,
    });

    try {
      let cursor = beforeMessageId;
      let result = await fetchTelegramChatHistoryPage(
        chat.telegram_chat_id,
        MESSAGE_CHAT_HISTORY_PAGE_SIZE,
        chat.peer_user_id,
        cursor,
      );
      if (
        result.error === "session_not_ready" ||
        result.error === "history_unavailable"
      ) {
        await warmupTelegramChatSession(chat.telegram_chat_id);
        result = await fetchTelegramChatHistoryPage(
          chat.telegram_chat_id,
          MESSAGE_CHAT_HISTORY_PAGE_SIZE,
          chat.peer_user_id,
          cursor,
        );
      }

      for (let skipAttempt = 0; skipAttempt < 4; skipAttempt += 1) {
        if (result.error) break;
        if (result.messages.length > 0) break;
        if (
          !result.hasMoreOlder ||
          result.nextBeforeMessageId == null ||
          result.nextBeforeMessageId >= cursor
        ) {
          break;
        }
        cursor = result.nextBeforeMessageId;
        result = await fetchTelegramChatHistoryPage(
          chat.telegram_chat_id,
          MESSAGE_CHAT_HISTORY_PAGE_SIZE,
          chat.peer_user_id,
          cursor,
        );
      }

      if (result.error) {
        logPageDisplay("messages_history_load_older_error", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          beforeMessageId,
          message: result.error,
        });
        return;
      }

      if (result.messages.length === 0) {
        applyOlderPaginationCursor(result.hasMoreOlder, result.nextBeforeMessageId);
        logPageDisplay("messages_history_load_older_empty", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          beforeMessageId,
          hasMoreOlder: result.hasMoreOlder,
          nextBeforeMessageId: result.nextBeforeMessageId,
        });
        return;
      }

      let addedCount = 0;
      let nextHeadAfter = headBeforeLoad;
      setMessages((prev) => {
        const next = mergeHistoryWithWindow(prev, result.messages, false);
        const prevHead = prev.length > 0 ? prev[0]!.telegram_message_id : 0;
        nextHeadAfter = next.length > 0 ? next[0]!.telegram_message_id : 0;
        addedCount =
          prevHead > 0 && nextHeadAfter > 0 && nextHeadAfter < prevHead
            ? Math.max(1, next.length - prev.length)
            : next.length - prev.length;
        return next;
      });
      if (addedCount === 0) {
        const currentHead =
          displayMessagesRef.current[0]?.telegram_message_id ?? 0;
        const grewViaCache =
          displayMessagesRef.current.length > lengthBeforeLoad ||
          (currentHead > 0 &&
            headBeforeLoad > 0 &&
            currentHead < headBeforeLoad);
        const grewViaMerge =
          nextHeadAfter > 0 &&
          headBeforeLoad > 0 &&
          nextHeadAfter < headBeforeLoad;
        if ((grewViaCache || grewViaMerge) && scrollAnchor) {
          assignPendingScrollAnchor(scrollAnchor);
        }
        const nextCursor =
          result.nextBeforeMessageId ??
          Math.min(...result.messages.map((row) => row.telegram_message_id));
        if (nextCursor != null && nextCursor < beforeMessageId) {
          applyOlderPaginationCursor(result.hasMoreOlder, nextCursor);
          shouldChainOlderLoad = result.hasMoreOlder;
          logPageDisplay("messages_history_load_older_advance_cursor", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            beforeMessageId,
            nextBeforeMessageId: nextCursor,
            fetchedCount: result.messages.length,
            grewViaCache,
            grewViaMerge,
          });
          return;
        }
        applyOlderPaginationCursor(false, null);
        logPageDisplay("messages_history_load_older_duplicate_page", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          beforeMessageId,
          fetchedCount: result.messages.length,
        });
        return;
      }
      if (result.selfUserId != null) {
        setSelfUserId(result.selfUserId);
      }
      const endScrollY = scrollControllerRef.current?.getMetrics()?.scrollY ?? startScrollY;
      const anchorDrift = Math.abs(endScrollY - startScrollY);
      const userMovedAway =
        anchorDrift > LOAD_OLDER_ANCHOR_MAX_DRIFT_PX ||
        endScrollY > MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX;
      const endAnchor = scrollControllerRef.current?.captureScrollAnchor();
      if (endAnchor) {
        assignPendingScrollAnchor(endAnchor);
      } else if (scrollAnchor && !userMovedAway) {
        assignPendingScrollAnchor(scrollAnchor);
      }
      applyOlderPaginationCursor(result.hasMoreOlder, result.nextBeforeMessageId);
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
      );
      if (result.hasMoreOlder && startScrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX) {
        shouldChainOlderLoad = true;
      }
      logPageDisplay("messages_history_load_older_ok", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        beforeMessageId,
        fetchedCount: result.messages.length,
        addedCount,
        hasMoreOlder: result.hasMoreOlder,
        nextBeforeMessageId: result.nextBeforeMessageId,
      });
      const loadedTailId =
        displayMessagesRef.current[displayMessagesRef.current.length - 1]
          ?.telegram_message_id ?? 0;
      const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
      if (
        loadedTailId > 0 &&
        !isAtLoadedChatTail(loadedTailId, chatTail)
      ) {
        void fetchTelegramChatHistorySince(
          chat.telegram_chat_id,
          loadedTailId,
          MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
          chat.peer_user_id,
        ).then((budget) => {
          if (!budget.error && budget.messages.length > 0) {
            mergeCachedChatHistoryTail(chat.telegram_chat_id, budget);
          }
        });
      }
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      loadOlderStartScrollYRef.current = null;
      lastOlderLoadFinishedAtRef.current = Date.now();
      scrollControllerRef.current?.clearNearTopLatch();
      scrollControllerRef.current?.clearNearBottomLatch();

      requestAnimationFrame(() => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return;
        tryUnlockPagedLoad(metrics);
        const loadedTail = lastDisplayMessageIdRef.current;
        const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
        if (
          !isAtLoadedChatTail(loadedTail, chatTail) &&
          isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH) &&
          !loadingNewerRef.current
        ) {
          loadNewerEnabledRef.current = true;
          void loadNewerMessagesRef.current();
        }
        if (
          shouldChainOlderLoad &&
          !loadingOlderRef.current &&
          hasMoreOlderRef.current &&
          metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX &&
          Date.now() >= openUnreadAnchorLockUntilRef.current
        ) {
          loadOlderAdvanceChainRef.current = true;
          void loadOlderMessagesRef.current();
        }
      });
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    hasMoreOlder,
    assignPendingScrollAnchor,
    applyOlderPaginationCursor,
    historyMessageContext,
    mergeHistoryWithWindow,
    loadingInitial,
    shouldContinueNewerPageLoad,
    tryUnlockPagedLoad,
  ]);

  const loadNewerMessages = useCallback(async () => {
    const sinceMessageId = lastDisplayMessageIdRef.current;
    const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
    if (
      loadingInitial ||
      loadingNewerRef.current ||
      loadingOlderRef.current ||
      sinceMessageId <= 0 ||
      Date.now() < loadNewerRetryAfterRef.current ||
      isAtLoadedChatTail(sinceMessageId, chatTail)
    ) {
      return;
    }

    loadingNewerRef.current = true;
    setLoadingNewer(true);
    let shouldChainNewerLoad = false;

    const serverUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
    const newerPageSize =
      serverUnread > MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE
        ? MESSAGE_CHAT_HISTORY_NEWER_CATCHUP_PAGE_SIZE
        : MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE;

    logPageDisplay("messages_history_load_newer_start", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      sinceMessageId,
    });

    try {
      let result = await fetchTelegramChatHistorySince(
        chat.telegram_chat_id,
        sinceMessageId,
        newerPageSize,
        chat.peer_user_id,
      );
      if (
        result.error === "session_not_ready" ||
        result.error === "history_unavailable"
      ) {
        await warmupTelegramChatSession(chat.telegram_chat_id);
        result = await fetchTelegramChatHistorySince(
          chat.telegram_chat_id,
          sinceMessageId,
          newerPageSize,
          chat.peer_user_id,
        );
      }

      if (result.error) {
        loadNewerRetryAfterRef.current =
          Date.now() + MESSAGE_CHAT_LOAD_NEWER_ERROR_BACKOFF_MS;
        logPageDisplay("messages_history_load_newer_error", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          sinceMessageId,
          message: result.error,
        });
        return;
      }

      if (result.messages.length === 0) {
        loadNewerRetryAfterRef.current =
          Date.now() + MESSAGE_CHAT_LOAD_NEWER_ERROR_BACKOFF_MS;
        logPageDisplay("messages_history_load_newer_empty", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          sinceMessageId,
        });
        return;
      }

      const scrollAnchorBeforeMerge =
        !followingBottomRef.current
          ? scrollControllerRef.current?.captureScrollAnchor()
          : null;

      let addedCount = 0;
      setMessages((prev) => {
        const next = mergeHistoryWithWindow(prev, result.messages, true);
        const prevTail =
          prev.length > 0 ? prev[prev.length - 1]!.telegram_message_id : 0;
        const nextTail =
          next.length > 0 ? next[next.length - 1]!.telegram_message_id : 0;
        addedCount =
          nextTail > prevTail
            ? Math.max(1, next.length - prev.length)
            : next.length - prev.length;
        return next;
      });

      if (addedCount === 0) {
        if (result.messages.length > 0) {
          const maxFetchedId = Math.max(
            ...result.messages.map((row) => row.telegram_message_id),
          );
          if (maxFetchedId > sinceMessageId) {
            lastDisplayMessageIdRef.current = maxFetchedId;
            shouldChainNewerLoad = true;
            logPageDisplay("messages_history_load_newer_advance_cursor", {
              ...chatLogFields({
                chatId: chat.telegram_chat_id,
                peerUserId: chat.peer_user_id,
                title: chat.title,
              }),
              sinceMessageId,
              maxFetchedId,
              fetchedCount: result.messages.length,
            });
          }
        }
        return;
      }

      shouldChainNewerLoad = true;
      loadNewerRetryAfterRef.current = 0;

      if (unreadMarkingArmedRef.current) {
        scheduleSyncScrollBelowUnreadRef.current();
      }

      if (result.selfUserId != null) {
        setSelfUserId(result.selfUserId);
      }
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
      );
      mergeCachedChatHistoryTail(chat.telegram_chat_id, result);

      if (followingBottomRef.current && openingUnreadCountRef.current <= 0) {
        scrollToBottom();
      } else if (scrollAnchorBeforeMerge) {
        assignPendingScrollAnchor(scrollAnchorBeforeMerge);
      }

      logPageDisplay("messages_history_load_newer_ok", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        sinceMessageId,
        fetchedCount: result.messages.length,
        addedCount,
      });
      const budgetBeforeId =
        nextBeforeMessageIdRef.current ??
        displayMessagesRef.current[0]?.telegram_message_id ??
        null;
      if (budgetBeforeId != null && budgetBeforeId > 0) {
        void fetchTelegramChatHistoryPage(
          chat.telegram_chat_id,
          MESSAGE_CHAT_HISTORY_PAGE_SIZE,
          chat.peer_user_id,
          budgetBeforeId,
        ).then((budget) => {
          if (!budget.error && budget.messages.length > 0) {
            const merged = mergeHistoryMessages([], budget.messages, historyMessageContext);
            mergeCachedChatHistoryTail(chat.telegram_chat_id, {
              ...budget,
              messages: merged,
            });
          }
        });
      }
    } finally {
      loadingNewerRef.current = false;
      setLoadingNewer(false);
      scrollControllerRef.current?.clearNearBottomLatch();

      if (openingUnreadCountRef.current > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            refreshScrollUnreadFabRef.current();
          });
        });
      }

      if (!shouldChainNewerLoad) return;

      requestAnimationFrame(() => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return;
        const loadedTail = lastDisplayMessageIdRef.current;
        const chatTail = chatTailMessageIdRef.current ?? chat.last_message_telegram_id;
        if (isAtLoadedChatTail(loadedTail, chatTail)) return;
        if (
          !loadNewerEnabledRef.current ||
          loadingNewerRef.current
        ) {
          return;
        }
        if (shouldContinueNewerPageLoad(metrics)) {
          void loadNewerMessagesRef.current();
        }
      });
    }
  }, [
    chat.last_message_telegram_id,
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    historyMessageContext,
    mergeHistoryWithWindow,
    loadingInitial,
    assignPendingScrollAnchor,
    scrollToBottom,
    shouldContinueNewerPageLoad,
  ]);

  useEffect(() => {
    loadNewerMessagesRef.current = loadNewerMessages;
  }, [loadNewerMessages]);

  useEffect(() => {
    loadOlderMessagesRef.current = loadOlderMessages;
  }, [loadOlderMessages]);

  const historyLoadIoEnabled =
    chatScrollPaintReady &&
    !loadingInitial &&
    !loadingOlder &&
    !loadingNewer &&
    !scrollAnchorRestorePending &&
    !initialScrollInProgress &&
    Date.now() >= openUnreadAnchorLockUntilRef.current;

  const triggerLoadNewerFromSentinel = useCallback(() => {
    if (!userHasScrolledSinceOpenRef.current) return;
    if (initialScrollInProgressRef.current || scrollAnchorRestorePending) return;
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0) {
      tryUnlockPagedLoad(metrics);
      loadNewerEnabledRef.current = true;
    }
    if (
      isAtLoadedChatTail(
        lastDisplayMessageIdRef.current,
        chatTailMessageIdRef.current ?? chat.last_message_telegram_id,
      )
    ) {
      return;
    }
    void loadNewerMessages();
  }, [chat.last_message_telegram_id, loadNewerMessages, scrollAnchorRestorePending, tryUnlockPagedLoad]);

  const handleNearTop = useCallback(() => {
    if (initialScrollInProgressRef.current || scrollAnchorRestorePending) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    if (Date.now() < openUnreadAnchorLockUntilRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    if (metrics.scrollY > MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    const atRestTop = metrics.scrollY <= 48;
    const scrollingUp = userScrollingUpRef.current;
    if (openingUnreadCountRef.current > 0 && !scrollingUp) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    if (!atRestTop && !scrollingUp) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    tryUnlockPagedLoad(metrics);
    if (
      openingUnreadCountRef.current <= 0 &&
      !loadOlderEnabledRef.current &&
      metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
    ) {
      loadOlderEnabledRef.current = true;
    }
    if (!loadOlderEnabledRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    if (!hasMoreOlder || loadingOlderRef.current) {
      scrollControllerRef.current?.clearNearTopLatch();
      return;
    }
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    void loadOlderMessages();
  }, [hasMoreOlder, loadOlderMessages, tryUnlockPagedLoad]);

  const triggerLoadOlderFromSentinel = useCallback(() => {
    if (!userHasScrolledSinceOpenRef.current) return;
    if (initialScrollInProgressRef.current || scrollAnchorRestorePending) return;
    handleNearTop();
  }, [handleNearTop, scrollAnchorRestorePending]);

  const handleNearBottom = useCallback(() => {
    if (!userHasScrolledSinceOpenRef.current) return;
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0) {
      tryUnlockPagedLoad(metrics);
      if (
        !loadNewerEnabledRef.current &&
        isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
      ) {
        loadNewerEnabledRef.current = true;
      }
    }
    if (!loadNewerEnabledRef.current) return;
    if (
      isAtLoadedChatTail(
        lastDisplayMessageIdRef.current,
        chatTailMessageIdRef.current ?? chat.last_message_telegram_id,
      )
    ) {
      return;
    }
    void loadNewerMessages();
  }, [chat.last_message_telegram_id, loadNewerMessages, tryUnlockPagedLoad]);

  const effectiveChatTailMessageId = chat.last_message_telegram_id ?? null;
  const hasMoreNewerBelow = !isAtLoadedChatTail(
    lastDisplayMessageId,
    effectiveChatTailMessageId,
  );

  useEffect(() => {
    if (initialScrollInProgress || loadingInitial || displayMessages.length === 0) return;
    if (!userHasScrolledSinceOpenRef.current) return;
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return;
    // High-unread chats open at last-read bottom — do not auto-chain newer pages here.
    if (openingUnreadCountRef.current > 0) return;
    if (displayMessages.length >= MESSAGE_CHAT_HISTORY_PAGE_SIZE / 2) return;
    if (metrics.contentH > metrics.layoutH + 2) return;
    if (hasMoreOlder && !loadingOlderRef.current) {
      void loadOlderMessages();
      return;
    }
    if (hasMoreNewerBelow && !loadingNewerRef.current) {
      loadNewerEnabledRef.current = true;
      void loadNewerMessages();
    }
  }, [
    displayMessages.length,
    hasMoreNewerBelow,
    hasMoreOlder,
    initialScrollInProgress,
    loadNewerMessages,
    loadOlderMessages,
    loadingInitial,
  ]);

  const fabUnreadCount = Math.max(0, Math.trunc(chat.unread_count ?? 0));
  const scrollToBottomUnreadLabel = formatScrollToBottomUnreadCountLabel(
    fabUnreadCount,
    chat.telegram_chat_id,
  );
  const bottomHistoryLoadLineActive =
    loadingNewer ||
    (scrollAnchorRestorePending && hasMoreNewerBelow) ||
    (hasMoreNewerBelow &&
      chatScrollPaintReady &&
      !loadingInitial &&
      !initialScrollInProgress &&
      isNearScrollBottom);
  const topHistoryLoadLineActive =
    loadingOlder ||
    (scrollAnchorRestorePending && hasMoreOlder && isNearScrollTop) ||
    (hasMoreOlder &&
      chatScrollPaintReady &&
      !loadingInitial &&
      !initialScrollInProgress &&
      isNearScrollTop);
  const showScrollToBottomButton =
    !initialScrollInProgress &&
    fabUnreadCount > 0 &&
    !(isFollowingBottom && !hasMoreNewerBelow);

  useEffect(() => {
    if (!shouldLoadHistory) return;
    logPageDisplay("messages_scroll_fab_state", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      show: showScrollToBottomButton,
      followingBottom: isFollowingBottom,
      initialScrollInProgress,
      unreadCount: fabUnreadCount,
      label: scrollToBottomUnreadLabel || null,
    });
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    isFollowingBottom,
    initialScrollInProgress,
    fabUnreadCount,
    hasMoreNewerBelow,
    openScrollPlan.openingUnreadCount,
    scrollToBottomUnreadLabel,
    shouldLoadHistory,
    showScrollToBottomButton,
  ]);

  const innerWidthPx = Math.max(
    0,
    columnWidthPx - MESSAGE_CHAT_BODY_PADDING_PX * 2,
  );

  const listVirtualWindow = useMemo(() => {
    const disabledWindow = {
      enabled: false as const,
      startIndex: 0,
      endIndex: Math.max(0, displayMessages.length - 1),
      topSpacerPx: 0,
      bottomSpacerPx: 0,
    };
    if (displayMessages.length < MESSAGE_LIST_VIRTUALIZE_MIN_ROWS) {
      return disabledWindow;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    const layoutH =
      pinnedLayoutHRef.current > 0
        ? pinnedLayoutHRef.current
        : metrics && metrics.layoutH > 0
          ? metrics.layoutH
          : 1;
    const scrollY = pinnedScrollYRef.current;
    const window = resolveMessageListVirtualWindow(
      displayMessages,
      messageRowHeightCacheRef.current,
      { scrollY, layoutH },
      MESSAGE_BUBBLE_ROW_GAP_PX,
    );
    if (!window.enabled || displayMessages.length === 0) {
      return window;
    }
    let totalHeight = 0;
    for (let index = 0; index < displayMessages.length; index += 1) {
      const messageId = displayMessages[index]!.telegram_message_id;
      const cached = messageRowHeightCacheRef.current.get(messageId);
      const contentHeight =
        cached != null && cached > 0 ? cached : MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
      totalHeight += contentHeight + (index > 0 ? MESSAGE_BUBBLE_ROW_GAP_PX : 0);
    }
    const maxScrollY = Math.max(0, totalHeight - layoutH);
    const nearBottomFromEstimate =
      maxScrollY <= 0 ||
      scrollY >= maxScrollY - MESSAGE_LIST_SENSITIVE_AREA_PX;
    const liveMetrics = scrollControllerRef.current?.getMetrics();
    const nearBottom =
      liveMetrics != null && liveMetrics.contentH > layoutH
        ? isChatScrollNearBottom(scrollY, layoutH, liveMetrics.contentH)
        : nearBottomFromEstimate;
    const waitingForNewer = !isAtLoadedChatTail(
      displayMessages.length > 0
        ? displayMessages[displayMessages.length - 1]!.telegram_message_id
        : 0,
      chat.last_message_telegram_id ?? null,
    );
    if (
      !(waitingForNewer && nearBottom) &&
      (!nearBottom || window.endIndex >= displayMessages.length - 1)
    ) {
      return window;
    }
    // While newer pages are pending at the loaded tail, render through the last
    // row so the user does not scroll into an empty virtual bottom spacer.
    return {
      ...window,
      endIndex: displayMessages.length - 1,
      bottomSpacerPx: 0,
    };
  }, [chat.last_message_telegram_id, chatScrollPaintReady, displayMessages, displayMessagesLayoutSig, virtualScrollTick]);

  const renderedMessages = listVirtualWindow.enabled
    ? displayMessages.slice(listVirtualWindow.startIndex, listVirtualWindow.endIndex + 1)
    : displayMessages;
  const renderedMessageStartIndex = listVirtualWindow.enabled ? listVirtualWindow.startIndex : 0;

  // Track virtual top spacer for diagnostics; do not adjust scrollY here — when the
  // window slides during user scroll, topSpacer delta already matches scrollY delta,
  // and compensating again double-counts. Prepend stability uses restoreScrollAnchor.
  useLayoutEffect(() => {
    virtualTopSpacerPxRef.current = listVirtualWindow.topSpacerPx;
  }, [listVirtualWindow.topSpacerPx]);

  if (!shouldLoadHistory) {
    return (
      <View
        style={{
          flex: 1,
          minHeight: 0,
          alignSelf: "stretch",
        }}
        onLayout={onColumnLayout}
      />
    );
  }

  const pinMessagesToBottom = openScrollPlan.pinMessagesToBottom;
  const hideScrollUntilSettled =
    displayMessages.length > 0 && !chatScrollPaintReady;

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        alignSelf: "stretch",
        position: "relative",
      }}
      onLayout={onColumnLayout}
    >
      <MessageChatOlderHistoryLoadLine active={topHistoryLoadLineActive} color={colors.accent} />
      <View style={{ flex: 1, minHeight: 0, position: "relative", opacity: hideScrollUntilSettled ? 0 : 1 }}>
      <HspScrollColumn
        key={`${chat.telegram_chat_id}-${historyLoad.generation}`}
        style={{ flex: 1, minHeight: 0 }}
        indicatorColor={colors.accent}
        scrollbarRightInsetPx={layout.scrollIndicatorRightInsetPx}
        initialScrollPosition={openScrollPlan.openAnchor}
        nearTopThresholdPx={MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX}
        nearBottomThresholdPx={MESSAGE_LIST_SENSITIVE_AREA_PX}
        onNearTop={hasMoreOlder ? handleNearTop : undefined}
        onNearBottom={hasMoreNewerBelow ? handleNearBottom : undefined}
        onScrollPositionChange={handleScrollPositionChange}
        onMetricsChange={handleOpenScrollMetrics}
        scrollControllerRef={scrollControllerRef}
        contentContainerStyle={{
          padding: MESSAGE_CHAT_BODY_PADDING_PX,
          ...(pinMessagesToBottom ? { flexGrow: 1 } : null),
        }}
      >
        {pinMessagesToBottom ? (
          <View style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} />
        ) : null}
        {loadingInitial && messages.length === 0 ? (
          <View style={{ paddingVertical: 24, alignItems: "center" }}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : null}

        {!loadingInitial && error && messages.length === 0 ? (
          <Text
            style={{
              color: colors.secondary,
              fontSize: 15,
              lineHeight: 20,
              textAlign: "left",
            }}
          >
            {t("messages.historyLoadError")}
          </Text>
        ) : null}

        {!loadingInitial && !error && messages.length === 0 ? (
          <Text
            style={{
              color: colors.secondary,
              fontSize: 15,
              lineHeight: 20,
              textAlign: "left",
            }}
          >
            {t("messages.chatEmpty")}
          </Text>
        ) : null}

        {displayMessages.length > 0 && hasMoreOlder ? (
          <MessageHistoryLoadSentinel
            edge="top"
            enabled={historyLoadIoEnabled}
            onTrigger={triggerLoadOlderFromSentinel}
          />
        ) : null}

        {listVirtualWindow.enabled && listVirtualWindow.topSpacerPx > 0 ? (
          <View style={{ height: listVirtualWindow.topSpacerPx }} />
        ) : null}

        {renderedMessages.map((item, sliceIndex) => {
          const index = renderedMessageStartIndex + sliceIndex;
          return (
          <View
            key={item.telegram_message_id}
            onLayout={(event) => handleMessageLayout(item.telegram_message_id, event)}
          >
            {index > 0 ? <View style={{ height: MESSAGE_BUBBLE_ROW_GAP_PX }} /> : null}
            <MessageChatMessageRow
              chat={chat}
              chatKind={chatKind}
              item={item}
              colors={colors}
              columnWidthPx={innerWidthPx}
              selfUserId={selfUserId}
              contentActive={chatScrollPaintReady}
            />
          </View>
          );
        })}

        {listVirtualWindow.enabled && listVirtualWindow.bottomSpacerPx > 0 ? (
          <View style={{ height: listVirtualWindow.bottomSpacerPx }} />
        ) : null}
        {displayMessages.length > 0 && hasMoreNewerBelow ? (
          <MessageHistoryLoadSentinel
            edge="bottom"
            enabled={historyLoadIoEnabled}
            onTrigger={triggerLoadNewerFromSentinel}
          />
        ) : null}
      </HspScrollColumn>
      </View>
      <MessageChatOlderHistoryLoadLine
        active={bottomHistoryLoadLineActive}
        color={colors.accent}
        edge="bottom"
      />
      {showScrollToBottomButton ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            right: MESSAGE_CHAT_BODY_PADDING_PX,
            bottom: MESSAGE_CHAT_BODY_PADDING_PX,
            zIndex: layout.authenticatedHome.scrollIndicatorOverlayZIndex + 1,
          }}
        >
          <MessageChatScrollToBottomButton
            unreadLabel={scrollToBottomUnreadLabel}
            colors={colors}
            onPress={scrollToBottom}
          />
        </View>
      ) : null}
    </View>
  );
}
