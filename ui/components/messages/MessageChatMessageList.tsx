import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Text, View, type LayoutChangeEvent } from "react-native";
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
  getOpenChatHistoryCacheAnchorSpec,
} from "../../messageChatHistoryPrefetch";
import {
  clearChatScrollPosition,
  isChatScrollNearBottom,
  saveChatScrollPosition,
  scrollYFromCachedPosition,
  type CachedChatScrollPosition,
} from "../../messageChatScrollCache";
import { subscribeOutgoingChatMessages } from "../../messageChatOutgoing";
import { layout, type ThemeColors } from "../../theme";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import {
  fetchTelegramChatHistoryPage,
  fetchTelegramChatHistorySince,
} from "../../telegram/fetchTelegramChatHistoryPage";
import {
  fetchChatHistoryAroundCharBudget,
  fetchChatHistoryAroundUnreadCharBudget,
  fetchChatHistoryHeadCharBudget,
  fetchChatHistoryTailCharBudget,
  fetchNewerHistoryCharBudget,
  fetchOlderHistoryCharBudget,
} from "../../telegram/fetchChatHistoryCharacterRange";
import { warmupTelegramChatSession } from "../../telegram/warmupTelegramChatSession";
import { viewTelegramChatInboxMessages } from "../../telegram/viewTelegramChatInboxMessages";
import { debounceLeading } from "../../util/debounceLeading";
import { HspScrollColumn, type HspItemAnchor, type HspScrollAnchor, type HspScrollColumnHandle, type HspScrollMetrics } from "../HspScrollColumn";
import {
  MESSAGE_BUBBLE_ROW_GAP_PX,
  MESSAGE_CHAT_BODY_PADDING_PX,
  MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
  MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
  MESSAGE_CHAT_LOADED_CHAR_BUDGET_PER_SIDE,
  MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
  MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
  MESSAGE_CHAT_LOAD_NEWER_ERROR_BACKOFF_MS,
  MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX,
  MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
  MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";
import { chatEdgePrefetchPx } from "./chatHistoryWindowBudget";
import { CHAT_SCROLL_INDICATOR_THUMB_MIN_PX } from "../../scrollIndicatorPx";
import {
  resolveChatOpenSession,
  resolveOpenHistoryFetchAnchor,
  type ChatOpenScrollPlan,
} from "./chatOpenSession";
import {
  afterOlderPrepend,
  expandOlder as expandWindowOlder,
  resolveDisplayWindow,
  sliceDisplayMessages,
  trimLoadedAroundAnchor,
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  type CountSliceBounds,
} from "./chatMessageWindow";
import {
  beginOpenSettlePhase,
  beginPrependPhase,
  canEdgeLoad as canEdgeLoadInPhase,
  createChatScrollControllerState,
  endOpenSettlePhase,
  endPrependPhase,
  isReplacingHistory,
  rememberBeforeUpdate,
  restoreAfterUpdate,
  syncPinnedFromMetrics,
  type ChatScrollControllerState,
} from "./chatScrollController";
import {
  applyMergeTrimResult,
  filterMessagesOlderThan,
  historyTailSignature,
  mergeHistoryMessages,
  mergeTrimHistoryMessages,
  oldestHistoryMessageId,
} from "./chatHistoryMerge";
import { chatLiveSignature, chatMessageTailSignature } from "./chatListSignatures";
import {
  formatMessageDateDividerLabel,
  MessageDateDivider,
  messageDayKey,
  shouldShowMessageDateDivider,
  todayDayKey,
} from "./MessageDateDivider";
import { useChatScrollHooks } from "./useChatScrollHooks";
import { isNearChatTop } from "./chatEdgeLoadPolicy";
import { expandDisplaySliceNewer } from "./messageChatViewportSlice";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import { patchAuthenticatedHomeSelectedChatReadInbox, patchAuthenticatedHomeSelectedChatReadOutbox, patchAuthenticatedHomeSelectedChatGroupMeta, patchAuthenticatedHomeSelectedChatUnread, setAuthenticatedHomeOpenChatFollowingBottom } from "../../authenticatedHomeSelectedChat";
import {
  effectiveReadOutboxMessageId as mergeReadOutboxCursor,
  enrichHistoryMessageDisplay,
  isPrivateChatForReadReceipts,
  maxReadOutboxMessageIdFromItems,
  patchOutgoingStatusesWithReadOutbox,
  resolveHistoryMessageIsOutgoing,
  type HistoryMessageContext,
} from "./messageChatHistoryTypes";
import { MessageChatMessageRow } from "./MessageChatMessageRow";
import { MessageChatOlderHistoryLoadLine } from "./MessageChatOlderHistoryLoadLine";
import { MessageUnreadDivider } from "./MessageUnreadDivider";
import { MessageHistoryLoadSentinel } from "./MessageHistoryLoadSentinel";
import { MessageChatScrollToBottomButton } from "./MessageChatScrollToBottomButton";
import { prefetchOpenChatAvatars, setOpenChatAvatarPriority, isOpenChatAvatarPriority } from "./messageChatAvatarPrefetch";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  minIntersectingMessageId,
  resolveFirstUnreadMessageId,
  resolveLastReadMessageId,
  scrollYToAlignUnreadDivider,
  scrollYToPreserveViewportOffset,
  countUnreadMessagesBelowViewport,
  countUnreadMessagesNewerThanViewport,
  formatScrollToBottomUnreadCountLabel,
  isAtLoadedChatTail,
  isUnreadDividerAlignedAtTop,
  MESSAGE_CHAT_FAB_ALWAYS_SHOW_UNREAD_THRESHOLD,
  maxFullyVisibleMessageId,
  maxIntersectingUnreadMessageId,
  topViewportAnchorMessageId,
  UNREAD_DIVIDER_ROW_HEIGHT_PX,
  UNREAD_DIVIDER_TOP_PX,
  VIEW_INBOX_DEBOUNCE_MS,
  type MessageScrollLayoutEntry,
} from "./messageListLayout";
import {
  buildMessageListComputedLayouts,
  buildMessageListViewportAwareLayouts,
  estimateMessageListBlockTotalHeight,
  isMessageListVirtualizationActive,
  MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX,
  MESSAGE_LIST_VIRTUAL_OVERSCAN_PX,
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
const LOAD_OLDER_PAGE_COOLDOWN_MS = 500;
/** telegram-tt FAB_THRESHOLD — hide scroll-down when within this distance of bottom (read chats). */
const FAB_VISIBILITY_THRESHOLD_PX = 50;
/** telegram-tt NOTCH_THRESHOLD — unread chats hide FAB only at exact bottom. */
const FAB_NOTCH_THRESHOLD_PX = 0;

function chatOpenScrollPlanFromSession(
  session: ReturnType<typeof resolveChatOpenSession>,
): ChatOpenScrollPlan {
  return {
    openingUnreadCount: session.openingUnreadCount,
    openAnchor: session.scroll.openAnchor,
    pinMessagesToBottom: session.scroll.pinToBottom,
    followingBottom: session.scroll.followingBottom,
    pendingInitialScroll: session.scroll.pendingInitialScroll,
    pendingScrollRestore: session.scroll.restore,
    scrollToUnreadDivider: session.scroll.alignUnreadDivider,
  };
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
  /** Viewport height for 3-screen edge prefetch / sentinel rootMargin. */
  const [scrollViewportH, setScrollViewportH] = useState(0);
  const openSession = useMemo(
    () => resolveChatOpenSession(chat),
    // generation forces re-resolve on reopen of the same chat id
    [chat.telegram_chat_id, chat.unread_count, chat.last_message_telegram_id, chat.last_read_inbox_message_id, historyLoad.generation],
  );
  const openScrollPlan = useMemo(
    () => chatOpenScrollPlanFromSession(openSession),
    [openSession],
  );
  const [isFollowingBottom, setIsFollowingBottom] = useState(
    () => openScrollPlan.followingBottom,
  );
  const [initialScrollInProgress, setInitialScrollInProgress] = useState(false);
  const [chatScrollPaintReady, setChatScrollPaintReady] = useState(false);
  const [isNearScrollTop, setIsNearScrollTop] = useState(false);
  const [isNearScrollBottom, setIsNearScrollBottom] = useState(false);
  const [scrollAnchorRestorePending, setScrollAnchorRestorePending] = useState(false);
  /** Suppress preserveViewportOnResize while prepend/expand anchor restore runs. */
  const [prependAnchorRestorePending, setPrependAnchorRestorePending] = useState(false);
  /** Sync mirror of prependAnchorRestorePending — state alone lags one tick and races scroll triggers. */
  const prependAnchorRestorePendingRef = useRef(false);
  const setPrependAnchorRestorePendingSynced = useCallback((pending: boolean) => {
    prependAnchorRestorePendingRef.current = pending;
    setPrependAnchorRestorePending(pending);
  }, []);
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

  const releaseOlderLoadViewportLock = useCallback(() => {
    olderPrependInProgressRef.current = false;
    olderPrependKindRef.current = null;
    displayExpandAnchorIdRef.current = 0;
    olderPrependSettleUntilRef.current = 0;
    if (prependKeepRafRef.current != null) {
      cancelAnimationFrame(prependKeepRafRef.current);
      prependKeepRafRef.current = null;
    }
    olderLoadDomAnchorRef.current = null;
    olderLoadMessageAnchorRef.current = null;
    olderLoadLockedAnchorIdRef.current = 0;
    olderLoadDisplayHeadBeforeRef.current = 0;
  }, []);

  const logMessagesScrollAction = useCallback(
    (action: string, detail: Record<string, unknown> = {}) => {
      const metrics = scrollControllerRef.current?.getMetrics();
      logPageDisplay("messages_scroll_action", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        action,
        scrollY: metrics?.scrollY ?? -1,
        layoutH: metrics?.layoutH ?? -1,
        contentH: metrics?.contentH ?? -1,
        pinnedScrollY: pinnedScrollYRef.current,
        prependInProgress: olderPrependInProgressRef.current,
        prependKind: olderPrependKindRef.current,
        prependLockedAnchorId: olderLoadLockedAnchorIdRef.current,
        prependHeadBefore: olderLoadDisplayHeadBeforeRef.current,
        displayHeadId: displayMessagesRef.current[0]?.telegram_message_id ?? 0,
        displayCount: displayMessagesRef.current.length,
        scrollAnchorRestorePending,
        loadingOlder: loadingOlderRef.current,
        ...detail,
      });
    },
    [chat.peer_user_id, chat.telegram_chat_id, chat.title, scrollAnchorRestorePending],
  );

  const keepViewportPositionOnOlderPrependRef = useRef<
    ((trigger: string) => void) | null
  >(null);
  const applyOlderPaginationCursor = useCallback(
    (hasMore: boolean, nextBefore: number | null) => {
      hasMoreOlderRef.current = hasMore;
      nextBeforeMessageIdRef.current = nextBefore;
      setHasMoreOlder(hasMore);
      setNextBeforeMessageId(nextBefore);
    },
    [],
  );
  const mergeOlderPaginationCursor = useCallback(
    (
      incomingHasMore: boolean,
      incomingNextBefore: number | null,
      incomingHeadId: number,
    ) => {
      const loadedHeadId = oldestHistoryMessageId(loadedMessagesRef.current) ?? 0;
      const currentNext = nextBeforeMessageIdRef.current;
      // A shorter revalidation/prefetch must not close pagination while we still have
      // an older loaded head or a cursor at/below that head.
      // Ignore shorter tail-only revalidations that do not cover the loaded head.
      if (
        !incomingHasMore &&
        loadedHeadId > 0 &&
        incomingHeadId > 0 &&
        loadedHeadId < incomingHeadId
      ) {
        return;
      }
      if (
        !incomingHasMore &&
        loadedHeadId > 0 &&
        currentNext != null &&
        currentNext > 0 &&
        currentNext <= loadedHeadId
      ) {
        return;
      }
      let nextBefore = incomingNextBefore;
      if (
        incomingHasMore &&
        loadedHeadId > 0 &&
        (nextBefore == null || nextBefore > loadedHeadId)
      ) {
        nextBefore = loadedHeadId;
      }
      applyOlderPaginationCursor(incomingHasMore, nextBefore);
    },
    [applyOlderPaginationCursor],
  );
  const pendingScrollRestoreRef = useRef<CachedChatScrollPosition | null>(null);
  /** Cached scroll to re-apply once message layouts (and content height) are ready. */
  const displaySliceBoundsRef = useRef<CountSliceBounds>({ startIndex: 0, endIndex: -1 });
  /** Expanded start index toward older rows; merged into anchor slice until cleared at bottom. */
  const displaySliceBoundsOverrideRef = useRef<CountSliceBounds | null>(null);
  const pendingItemAnchorRef = useRef<HspItemAnchor | null>(null);
  /** After in-buffer expand reaches loaded head, fetch the next older API page. */
  const loadOlderAfterExpandSnapshotRef = useRef<number | null>(null);
  const tryTriggerOlderHistoryLoadRef = useRef<() => void>(() => {});
  const runOlderEdgeActionRef = useRef<() => void>(() => {});
  const tryTriggerNewerHistoryLoadRef = useRef<() => void>(() => {});
  const unlockHistoryEdgesOnUserScrollRef = useRef<() => void>(() => {});
  const scheduleMidHistoryEdgePrefetchRef = useRef<() => void>(() => {});
  const midHistoryEdgePrefetchArmedRef = useRef(false);
  const loadOlderMessagesRef = useRef<
    (options?: { expandArmed?: boolean; beforeMessageId?: number }) => Promise<void>
  >(async () => {});
  const openScrollAppliedRef = useRef(false);
  /** Unread-divider open is only done once DOM/layout scroll matches telegram-tt UNREAD_DIVIDER_TOP. */
  const unreadOpenAlignVerifiedRef = useRef(false);
  const pendingPreserveScrollYRef = useRef<number | null>(null);
  const pinnedScrollYRef = useRef(0);
  const chatScrollStateRef = useRef<ChatScrollControllerState>(createChatScrollControllerState());
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
  const openScrollToUnreadDividerRef = useRef(false);
  const memoFirstUnreadIdRef = useRef<number | null>(null);
  const memoUnreadDividerBeforeIdRef = useRef<number | null>(null);
  const isReplacingHistoryRef = useRef(false);
  const scrollOffsetRef = useRef(0);
  const isScrollTopJustUpdatedRef = useRef(false);
  const openUnreadAnchorMessageIdRef = useRef<number | null>(null);
  const openUnreadAnchorLockUntilRef = useRef(0);
  const openUnreadAnchorReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticScrollRef = useRef(false);
  const lastReadInboxMessageIdRef = useRef<number | null>(null);
  const appliedHistoryFromPreviewCacheRef = useRef(false);
  const historyLoadedAroundUnreadRef = useRef(false);
  const [readInboxCursorTick, setReadInboxCursorTick] = useState(0);
  const bumpReadInboxCursorTick = useCallback(() => {
    setReadInboxCursorTick((tick) => tick + 1);
  }, []);

  const applyLastReadInboxMessageId = useCallback(
    (lastReadInboxMessageId: number | null | undefined) => {
      if (lastReadInboxMessageId == null) return;
      if (lastReadInboxMessageIdRef.current === lastReadInboxMessageId) return;
      lastReadInboxMessageIdRef.current = lastReadInboxMessageId;
      patchAuthenticatedHomeSelectedChatReadInbox(lastReadInboxMessageId);
      bumpReadInboxCursorTick();
    },
    [bumpReadInboxCursorTick],
  );
  const lastViewedInboxMarkRef = useRef(0);
  const viewInboxInFlightRef = useRef(false);
  const pendingViewInboxMessageIdRef = useRef<number | null>(null);
  const prevDisplayLengthRef = useRef(0);
  const prevDisplayHeadIdRef = useRef(0);
  const prevDisplayLastIdRef = useRef(0);
  const loadedMessagesRef = useRef<MessageChatHistoryItem[]>([]);
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
  const historyNetworkKeyRef = useRef("");
  const chatScrollPaintReadyRef = useRef(false);
  const messageLayoutsRef = useRef<Map<number, MessageScrollLayoutEntry>>(new Map());
  const messageRowHeightCacheRef = useRef<Map<number, number>>(new Map());
  const lastDisplayedUnreadRemainingRef = useRef<number | null>(null);
  const virtualScrollTickRef = useRef(0);
  const [virtualScrollTick, setVirtualScrollTick] = useState(0);
  const viewportSliceTickRef = useRef(0);
  const [viewportSliceTick, setViewportSliceTick] = useState(0);
  const scrollAnchorMessageIdRef = useRef(0);
  const viewportAtLoadedTopRef = useRef(false);
  const viewportAtLoadedBottomRef = useRef(false);
  /** Bumps when the user scrolls manually — drives FAB visibility refresh. */
  const [userScrollInteractionTick, setUserScrollInteractionTick] = useState(0);
  const [fabUnreadDisplayTick, setFabUnreadDisplayTick] = useState(0);
  const [frozenUnreadDividerBeforeId, setFrozenUnreadDividerBeforeId] = useState<number | null>(null);
  const displayMessagesRef = useRef<MessageChatHistoryItem[]>([]);
  const syncScrollBelowUnreadRef = useRef<(metrics: HspScrollMetrics) => void>(() => {});
  const scheduleSyncScrollBelowUnreadRef = useRef<() => void>(() => {});
  const loadNewerMessagesRef = useRef<() => Promise<void>>(async () => {});
  const loadOlderAdvanceChainRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const userScrollingUpRef = useRef(false);
  const loadOlderStartScrollYRef = useRef<number | null>(null);
  /** scrollTop captured synchronously before a history/display merge (telegram-tt). */
  const scrollTopBeforeUpdateRef = useRef<number | null>(null);
  /** DOM + message anchor captured when an older-page fetch starts. */
  const olderLoadDomAnchorRef = useRef<HspScrollAnchor | null>(null);
  type OlderLoadMessageAnchor = {
    messageId: number;
    offsetFromViewportTop: number;
  };
  const olderLoadMessageAnchorRef = useRef<OlderLoadMessageAnchor | null>(null);
  const olderLoadInFlightBeforeIdRef = useRef<number | null>(null);
  const olderLoadLockedAnchorIdRef = useRef(0);
  /** Display-list head id before an older prepend; scroll-keep waits until head moves older. */
  const olderLoadDisplayHeadBeforeRef = useRef(0);
  /** True from older-prepend anchor capture until settle completes. */
  const olderPrependInProgressRef = useRef(false);
  /**
   * Item anchor armed into pendingItemAnchorRef only after a successful merge so
   * mid-fetch display ticks cannot consume restore early.
   */
  /** Display-slice expansion vs API older fetch — different scroll-keep rules. */
  const olderPrependKindRef = useRef<"display_expand" | "api_load" | null>(null);
  /** Viewport anchor pinned while expanding the display char slice (no API fetch). */
  const displayExpandAnchorIdRef = useRef(0);
  /** Defer prepend lock release until row heights stop changing (media measure). */
  const olderPrependSettleUntilRef = useRef(0);
  const prependKeepRafRef = useRef<number | null>(null);
  /** In-flight prepend restore — prevents layout-effect re-entry when display slice changes mid-keep. */
  const activePrependRestoreRef = useRef<{
    itemAnchor: HspItemAnchor | null;
    loadOlderBeforeId: number | null;
  } | null>(null);
  const lastOlderLoadFinishedAtRef = useRef(0);
  const virtualTopSpacerPxRef = useRef(0);
  /** Suppress bottom-stick scroll churn while row heights are still measuring. */
  const layoutSettlingUntilRef = useRef(0);
  const unreadSyncScheduledRef = useRef(false);
  const pendingEmojiPrefetchRef = useRef<MessageChatHistoryItem[] | null>(null);
  const hasMoreOlderRef = useRef(false);
  const userHasScrolledSinceOpenRef = useRef(false);
  const unreadCounterRafRef = useRef<number | null>(null);
  const pendingUnreadRemainingRef = useRef<number | null>(null);
  const prevChatTailForOpeningUnreadRef = useRef(chat.last_message_telegram_id ?? 0);
  const prevChatUnreadForOpeningRef = useRef(chat.unread_count ?? 0);
  const chatKindRef = useRef<MessageChatKind | null>(chat.chat_kind ?? null);
  /** Open-scroll defers reveal until this row is measured — avoids estimate→layout twitch. */
  const openScrollAwaitingLayoutMessageIdRef = useRef<number | null>(null);
  const openScrollRevealFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openScrollSettleRetryRafRef = useRef<number | null>(null);
  const openScrollForceRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openScrollSettleRef = useRef({
    trySettle: (): boolean => false,
    scheduleRetry: (): void => {},
    forceReveal: (_reason: string): void => {},
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
      windowOptions?: { skipTrim?: boolean },
    ): MessageChatHistoryItem[] => {
      const isOlderPrependMerge = !keepEnd;
      const skipTrim =
        windowOptions?.skipTrim === true ||
        (isOlderPrependMerge && loadingOlderRef.current) ||
        // Keep already-loaded older pages while the user is reading history.
        (userHasScrolledSinceOpenRef.current && prev.length > MESSAGE_LIST_VIEWPORT_LIMIT);
      const anchorMessageId = scrollAnchorMessageIdRef.current;
      const trimmed = mergeTrimHistoryMessages(prev, incoming, historyMessageContext, {
        maxRows: MESSAGE_LIST_VIEWPORT_LIMIT,
        anchorMessageId,
        keepEnd,
        skipTrim,
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

    const plan = chatOpenScrollPlanFromSession(resolveChatOpenSession(chat));
    openingUnreadCountRef.current = plan.openingUnreadCount;
    unreadMarkingArmPendingRef.current = plan.openingUnreadCount > 0;
    setFabUnreadDisplayTick((tick) => tick + 1);
    chatTailMessageIdRef.current = chat.last_message_telegram_id ?? null;
    openScrollAnchorRef.current = plan.openAnchor;
    openScrollToUnreadDividerRef.current = plan.scrollToUnreadDivider;
    pendingInitialScrollRef.current = plan.pendingInitialScroll;
    pendingScrollRestoreRef.current = plan.pendingScrollRestore;
    followingBottomRef.current = plan.followingBottom;
    setIsFollowingBottom(plan.followingBottom);
    setAuthenticatedHomeOpenChatFollowingBottom(plan.followingBottom);
    // History generation bumps (cache → network) must not re-arm the open-settle
    // lock after the viewport already settled. applyOpenScrollOnce early-returns
    // when openScrollAppliedRef is still true, leaving initialScrollInProgress
    // stuck and blocking older expand / API paging.
    const reopenInitialScroll =
      chatChanged ||
      (!chatScrollPaintReadyRef.current && !openScrollAppliedRef.current);
    if (reopenInitialScroll) {
      initialScrollInProgressRef.current =
        plan.pendingInitialScroll || plan.pendingScrollRestore != null;
      setInitialScrollInProgress(
        plan.pendingInitialScroll || plan.pendingScrollRestore != null,
      );
    }

    if (chatChanged) {
      if (plan.scrollToUnreadDivider) {
        // Drop stale mid-list restores so the next open stays on the unread divider
        // until the user actually scrolls (telegram-tt first-unread open).
        clearChatScrollPosition(chat.telegram_chat_id);
      }
      const openFetchAnchor = resolveOpenHistoryFetchAnchor(chat, plan);
      scrollAnchorMessageIdRef.current = plan.scrollToUnreadDivider
        ? 0
        : openFetchAnchor;
      viewportSliceTickRef.current = 0;
      setViewportSliceTick(0);
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastDisplayMessageIdRef.current = 0;
      prevDisplayLengthRef.current = 0;
      prevDisplayHeadIdRef.current = 0;
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
      historySyncKeyRef.current = "";
      historyNetworkKeyRef.current = "";
      openScrollAppliedRef.current = false;
      unreadOpenAlignVerifiedRef.current = false;
      pendingItemAnchorRef.current = null;
      scrollTopBeforeUpdateRef.current = null;
      setPrependAnchorRestorePendingSynced(false);
      displaySliceBoundsOverrideRef.current = null;
      setFrozenUnreadDividerBeforeId(null);
      memoFirstUnreadIdRef.current = null;
      memoUnreadDividerBeforeIdRef.current = null;
      isReplacingHistoryRef.current = false;
      scrollOffsetRef.current = 0;
      isScrollTopJustUpdatedRef.current = false;
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
      olderLoadDomAnchorRef.current = null;
      olderLoadLockedAnchorIdRef.current = 0;
      olderLoadDisplayHeadBeforeRef.current = 0;
      olderPrependInProgressRef.current = false;
      olderPrependKindRef.current = null;
      displayExpandAnchorIdRef.current = 0;
      olderPrependSettleUntilRef.current = 0;
      prevChatTailForOpeningUnreadRef.current = chat.last_message_telegram_id ?? 0;
      prevChatUnreadForOpeningRef.current = plan.openingUnreadCount;
      lastReadInboxMessageIdRef.current = (() => {
        const raw = Number(chat.last_read_inbox_message_id);
        return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
      })();
      if (lastReadInboxMessageIdRef.current != null) {
        bumpReadInboxCursorTick();
      }
      appliedHistoryFromPreviewCacheRef.current = false;
      historyLoadedAroundUnreadRef.current = false;
      midHistoryEdgePrefetchArmedRef.current = false;
      lastViewedInboxMarkRef.current = 0;
      pendingViewInboxMessageIdRef.current = null;
    } else if (generationChanged) {
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastAppliedCacheSignatureRef.current = "";
      lastAvatarPrefetchGenerationRef.current = 0;
      unreadMarkingArmedRef.current = false;
      unreadViewportBaselineMessageIdRef.current = 0;
      allowUnreadResetAtBottomRef.current = false;
      assignPendingScrollAnchor(null);
      pendingEmojiPrefetchRef.current = null;
      openScrollAwaitingLayoutMessageIdRef.current = null;
      // Soft history refresh while already painted: keep paint + scroll interaction
      // so near-top older loads are not gated on a second open settle.
      if (reopenInitialScroll) {
        userHasScrolledSinceOpenRef.current = false;
        setChatScrollPaintReady(false);
        chatScrollPaintReadyRef.current = false;
        openScrollAppliedRef.current = false;
        setIsNearScrollTop(false);
        setIsNearScrollBottom(false);
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
    }

    historyLoadedAroundUnreadRef.current = plan.scrollToUnreadDivider;
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
    applyLastReadInboxMessageId(chat.last_read_inbox_message_id);
  }, [applyLastReadInboxMessageId, chat.last_read_inbox_message_id, chat.telegram_chat_id]);

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
      setFabUnreadDisplayTick((tick) => tick + 1);
      if (polledUnread > 0 && !unreadMarkingArmedRef.current) {
        unreadMarkingArmPendingRef.current = true;
      }
    } else if (
      polledUnread <= 0 &&
      chatScrollPaintReadyRef.current &&
      !initialScrollInProgressRef.current
    ) {
      // Only clear after open settle — transient poll zeros must not wipe the FAB badge.
      openingUnreadCountRef.current = 0;
      setFabUnreadDisplayTick((tick) => tick + 1);
    } else if (tailId > prevTailId && polledUnread > prevChatUnreadForOpeningRef.current) {
      if (!unreadMarkingArmedRef.current) {
        unreadMarkingArmPendingRef.current = true;
      }
    } else if (
      polledUnread > 0 &&
      polledUnread < openingUnreadCountRef.current &&
      chatScrollPaintReadyRef.current
    ) {
      openingUnreadCountRef.current = polledUnread;
      setFabUnreadDisplayTick((tick) => tick + 1);
    }

    prevChatTailForOpeningUnreadRef.current = tailId;
    prevChatUnreadForOpeningRef.current = polledUnread;
  }, [chat.unread_count, chat.last_message_telegram_id]);

  useEffect(() => {
    return () => {
      const metrics = scrollControllerRef.current?.getMetrics();
      if (metrics && metrics.contentH > 0) {
        saveChatScrollPosition(chat.telegram_chat_id, {
          distanceFromBottom: Math.max(0, metrics.contentH - metrics.scrollY),
          contentH: metrics.contentH,
          followingBottom:
            followingBottomRef.current ||
            isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH),
          ...(scrollAnchorMessageIdRef.current > 0
            ? { anchorMessageId: scrollAnchorMessageIdRef.current }
            : {}),
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
        applyLastReadInboxMessageId(result.last_read_inbox_message_id);
      }
      patchAuthenticatedHomeSelectedChatUnread(result.unread_count);
      if (result.unread_count < openingUnreadCountRef.current) {
        openingUnreadCountRef.current = result.unread_count;
      }
      setFabUnreadDisplayTick((tick) => tick + 1);
      if (result.unread_count <= 0) {
        openingUnreadCountRef.current = 0;
      }
    },
    [applyLastReadInboxMessageId],
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

  const unreadCatchUpAwaitingUserScroll = useCallback((): boolean => {
    return (
      openingUnreadCountRef.current > 0 && !userHasScrolledSinceOpenRef.current
    );
  }, []);

  const markUserScrollInteraction = useCallback((direction?: "up" | "down") => {
    if (direction === "up") {
      userScrollingUpRef.current = true;
    } else if (direction === "down") {
      userScrollingUpRef.current = false;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (
      metrics &&
      metrics.contentH > 0 &&
      metrics.layoutH > 0 &&
      !isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
    ) {
      followingBottomRef.current = false;
      setIsFollowingBottom(false);
      setAuthenticatedHomeOpenChatFollowingBottom(false);
    }
    if (userHasScrolledSinceOpenRef.current) return;
    userHasScrolledSinceOpenRef.current = true;
    setUserScrollInteractionTick((tick) => tick + 1);
    unlockHistoryEdgesOnUserScrollRef.current();
    if (openingUnreadCountRef.current > 0) {
      openUnreadAnchorLockUntilRef.current = 0;
      if (openUnreadAnchorReleaseTimerRef.current != null) {
        clearTimeout(openUnreadAnchorReleaseTimerRef.current);
        openUnreadAnchorReleaseTimerRef.current = null;
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    markUserScrollInteraction();
    displaySliceBoundsOverrideRef.current = null;
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
  }, [chat.last_message_telegram_id, flushViewInboxMessages, markUserScrollInteraction]);

  const applyProgrammaticScrollY = useCallback((targetY: number) => {
    isScrollTopJustUpdatedRef.current = true;
    programmaticScrollRef.current = true;
    scrollControllerRef.current?.scrollToY(targetY);
    pinnedScrollYRef.current = targetY;
    lastScrollYRef.current = targetY;
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0) {
      scrollOffsetRef.current = Math.max(
        metrics.contentH - targetY,
        metrics.layoutH,
      );
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isScrollTopJustUpdatedRef.current = false;
        programmaticScrollRef.current = false;
      });
    });
  }, []);

  /** Pin scroll synchronously when older rows prepend above the viewport. */
  const pinScrollYForPrepend = useCallback(
    (targetY: number, reason: string) => {
      const beforeY = scrollControllerRef.current?.getMetrics()?.scrollY ?? -1;
      isScrollTopJustUpdatedRef.current = true;
      programmaticScrollRef.current = true;
      scrollControllerRef.current?.scrollToY(targetY);
      pinnedScrollYRef.current = targetY;
      lastScrollYRef.current = targetY;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isScrollTopJustUpdatedRef.current = false;
          programmaticScrollRef.current = false;
        });
      });
      if (Math.abs(targetY - beforeY) > 0.5) {
        logMessagesScrollAction(reason, {
          beforeScrollY: beforeY,
          targetScrollY: targetY,
          deltaY: targetY - beforeY,
        });
      }
    },
    [logMessagesScrollAction],
  );

  const keepViewportPositionOnOlderPrepend = useCallback(
    (trigger = "unknown"): void => {
      const domAnchor =
        pendingScrollAnchorRef.current ?? olderLoadDomAnchorRef.current;
      if (!domAnchor) return;

      const messageAnchor = olderLoadMessageAnchorRef.current;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.layoutH <= 0) return;

      const beforeY = metrics.scrollY;
      const prependKind = olderPrependKindRef.current;
      const display = displayMessagesRef.current;
      const estimatedContentH = estimateMessageListBlockTotalHeight(
        display,
        messageLayoutsRef.current,
        messageRowHeightCacheRef.current,
        MESSAGE_BUBBLE_ROW_GAP_PX,
      );
      const measuredContentH = Math.max(
        metrics.contentH > 0 ? metrics.contentH : 0,
        domAnchor.scrollHeight > 0 ? domAnchor.scrollHeight : 0,
      );
      let method: "message_anchor" | "dom_anchor" | "none" = "none";

      const estimatesInflated =
        measuredContentH > 0 && estimatedContentH > measuredContentH * 1.12;
      const useDomOnly =
        prependKind === "display_expand" ||
        messageAnchor == null ||
        estimatesInflated;

      if (!useDomOnly && messageAnchor) {
        const layoutMap = buildMessageListComputedLayouts(
          display,
          messageRowHeightCacheRef.current,
          MESSAGE_BUBBLE_ROW_GAP_PX,
        );
        const entry = layoutMap.get(messageAnchor.messageId);
        const contentH = Math.max(measuredContentH, estimatedContentH);
        if (entry && entry.height > 0 && contentH > 0) {
          method = "message_anchor";
          pinScrollYForPrepend(
            scrollYToPreserveViewportOffset(
              entry,
              messageAnchor.offsetFromViewportTop,
              metrics.layoutH,
              contentH,
            ),
            "prepend_keep_message_anchor",
          );
        }
      }

      if (method === "none" && scrollControllerRef.current?.keepScrollPositionOnPrepend(domAnchor)) {
        method = "dom_anchor";
        const nextMetrics = scrollControllerRef.current?.getMetrics();
        if (nextMetrics) {
          pinScrollYForPrepend(nextMetrics.scrollY, "prepend_keep_dom_anchor");
        }
      }

      logMessagesScrollAction("messages_scroll_prepend_keep", {
        trigger,
        prependKind,
        method,
        beforeScrollY: beforeY,
        afterScrollY: pinnedScrollYRef.current,
        anchorMessageId:
          messageAnchor?.messageId ?? olderLoadLockedAnchorIdRef.current,
        anchorOffset: messageAnchor?.offsetFromViewportTop ?? null,
        estimatedContentH,
        measuredContentH,
        estimatesInflated,
        domScrollHeight: domAnchor.scrollHeight,
        domScrollTop: domAnchor.scrollTop,
      });
    },
    [logMessagesScrollAction, pinScrollYForPrepend],
  );

  keepViewportPositionOnOlderPrependRef.current = keepViewportPositionOnOlderPrepend;

  const releaseStalePrependIfNeeded = useCallback(
    (reason: string): boolean => {
      if (!olderPrependInProgressRef.current) return false;
      if (loadingOlderRef.current) return false;

      const metrics = scrollControllerRef.current?.getMetrics();
      const domAnchor = pendingScrollAnchorRef.current;
      const contentH = metrics?.contentH ?? 0;
      const domScrollHeight = domAnchor?.scrollHeight ?? 0;

      const spuriousCachePrepend =
        olderPrependKindRef.current === "api_load" &&
        olderLoadLockedAnchorIdRef.current === 0 &&
        olderLoadDisplayHeadBeforeRef.current === 0;

      const staleDomAnchor =
        domAnchor != null &&
        contentH > 0 &&
        domScrollHeight > 0 &&
        domScrollHeight < contentH * 0.4;

      const settleExpired = Date.now() >= olderPrependSettleUntilRef.current + 350;

      if (spuriousCachePrepend || staleDomAnchor || settleExpired) {
        logMessagesScrollAction("prepend_force_release", {
          reason,
          spuriousCachePrepend,
          staleDomAnchor,
          settleExpired,
          domScrollHeight,
          contentH,
        });
        assignPendingScrollAnchor(null);
        releaseOlderLoadViewportLock();
        return true;
      }
      return false;
    },
    [assignPendingScrollAnchor, logMessagesScrollAction, releaseOlderLoadViewportLock],
  );

  const schedulePrependKeepFromLayout = useCallback(() => {
    if (!olderPrependInProgressRef.current) return;
    olderPrependSettleUntilRef.current = Math.max(
      olderPrependSettleUntilRef.current,
      Date.now() + 250,
    );
    if (prependKeepRafRef.current != null) return;
    prependKeepRafRef.current = requestAnimationFrame(() => {
      prependKeepRafRef.current = null;
      if (!olderPrependInProgressRef.current) return;
      keepViewportPositionOnOlderPrependRef.current?.("layout_height_change");
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
      if (
        openingUnreadCountRef.current <= 0 ||
        userHasScrolledSinceOpenRef.current
      ) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
      }
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

  const enableEdgeLoadingAfterOpen = useCallback(() => {
    scrollControllerRef.current?.clearNearTopLatch();
    scrollControllerRef.current?.clearNearBottomLatch();
  }, []);

  const persistChatScrollPosition = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0) return;
      // Never persist the pre-settle / unread-catch-up viewport — that overwrites the
      // unread-divider open with a random mid-list Y on the next reopen.
      if (initialScrollInProgressRef.current) return;
      if (!chatScrollPaintReadyRef.current) return;
      if (
        openingUnreadCountRef.current > 0 &&
        !userHasScrolledSinceOpenRef.current
      ) {
        return;
      }
      const anchorId = topViewportAnchorMessageId(
        displayMessagesRef.current,
        messageLayoutsRef.current,
        metrics,
      );
      const followingBottom =
        followingBottomRef.current ||
        isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH);
      saveChatScrollPosition(chat.telegram_chat_id, {
        distanceFromBottom: Math.max(0, metrics.contentH - metrics.scrollY),
        contentH: metrics.contentH,
        followingBottom,
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
      const liveMetrics = scrollControllerRef.current?.getMetrics();
      const scrollMetrics = metrics ?? {
        scrollY: pinnedScrollYRef.current,
        layoutH:
          pinnedLayoutHRef.current > 0
            ? pinnedLayoutHRef.current
            : liveMetrics?.layoutH ?? 0,
        contentH: liveMetrics?.contentH,
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

  const verifyPrependScrollKept = useCallback(
    (domAnchor: HspScrollAnchor | null, expectedScrollY?: number): boolean => {
      const live = scrollControllerRef.current?.captureScrollAnchor();
      if (!live) return false;
      if (expectedScrollY != null && Math.abs(live.scrollTop - expectedScrollY) <= 2) {
        return true;
      }
      if (!domAnchor) return live.scrollTop > 0;
      const heightDelta = live.scrollHeight - domAnchor.scrollHeight;
      // Mid-history opens often sit at scrollY≈0. A near-top soft pass would
      // accept an uncompensated prepend and jump the viewport to older rows.
      if (heightDelta > 0) {
        const minExpected = domAnchor.scrollTop + heightDelta - 80;
        return live.scrollTop >= minExpected;
      }
      return false;
    },
    [],
  );

  const restorePrependDomAnchor = useCallback((): boolean => {
    const domAnchor = olderLoadDomAnchorRef.current;
    if (!domAnchor) return false;
    const applied =
      scrollControllerRef.current?.keepScrollPositionOnPrepend(domAnchor) ?? false;
    if (!applied) return false;
    if (!verifyPrependScrollKept(domAnchor)) return false;
    const nextMetrics = scrollControllerRef.current?.getMetrics();
    if (nextMetrics) {
      pinnedScrollYRef.current = nextMetrics.scrollY;
      lastScrollYRef.current = nextMetrics.scrollY;
    }
    return true;
  }, [verifyPrependScrollKept]);

  const capturePrependItemAnchor = useCallback((): HspItemAnchor | null => {
    const display = displayMessagesRef.current;
    if (display.length === 0) return null;
    const fallbackId = display[0]!.telegram_message_id;
    if (fallbackId <= 0) return null;
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0) {
      return { messageId: fallbackId, viewportTopPx: 0, offsetFromViewportTop: 0 };
    }
    const layoutMap = resolveScrollLayoutMap(metrics);
    const anchorId =
      topViewportAnchorMessageId(display, layoutMap, metrics) ?? fallbackId;
    if (anchorId <= 0) return null;
    const entry = layoutMap.get(anchorId);
    const offsetFromViewportTop =
      entry && entry.height > 0 ? entry.y - metrics.scrollY : 0;
    const captured = scrollControllerRef.current?.captureItemAnchor(anchorId) ?? null;
    if (Platform.OS === "web" && captured) {
      return { ...captured, offsetFromViewportTop };
    }
    if (!entry || entry.height <= 0) {
      return { messageId: anchorId, viewportTopPx: 0, offsetFromViewportTop: 0 };
    }
    return {
      messageId: anchorId,
      viewportTopPx: 0,
      offsetFromViewportTop,
    };
  }, [resolveScrollLayoutMap]);

  const restorePrependItemAnchor = useCallback(
    (anchor: HspItemAnchor): boolean => {
      if (anchor.messageId <= 0) return false;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.layoutH <= 0) return false;
      const domAnchor = olderLoadDomAnchorRef.current;

      // Prefer live row geometry on web — height-delta restore under-shoots while
      // virtual spacers / estimated row heights are still settling (down-shift).
      if (Platform.OS === "web" && anchor.viewportTopPx != null) {
        const domRestored =
          scrollControllerRef.current?.restoreItemAnchor(anchor) ?? false;
        if (domRestored) {
          const nextMetrics = scrollControllerRef.current?.getMetrics();
          if (nextMetrics) {
            pinnedScrollYRef.current = nextMetrics.scrollY;
            lastScrollYRef.current = nextMetrics.scrollY;
          }
          const rowEl =
            typeof document !== "undefined"
              ? document.getElementById(`message-row-${anchor.messageId}`)
              : null;
          if (rowEl) {
            const drift = Math.abs(
              rowEl.getBoundingClientRect().top - anchor.viewportTopPx,
            );
            if (drift <= 2) return true;
          } else if (verifyPrependScrollKept(domAnchor)) {
            return true;
          }
        }
      }

      if (anchor.offsetFromViewportTop == null) return false;
      const layoutMap = resolveScrollLayoutMap(metrics);
      const entry = layoutMap.get(anchor.messageId);
      if (!entry || entry.height <= 0) return false;
      const liveAnchor = scrollControllerRef.current?.captureScrollAnchor();
      const measuredContentH = liveAnchor?.scrollHeight ?? metrics.contentH;
      const contentH = Math.max(metrics.contentH, measuredContentH);
      if (contentH <= 0) return false;
      const targetY = scrollYToPreserveViewportOffset(
        entry,
        anchor.offsetFromViewportTop,
        metrics.layoutH,
        contentH,
      );
      const scrollTopBefore = scrollTopBeforeUpdateRef.current;
      if (scrollTopBefore != null && domAnchor) {
        const heightDelta = Math.max(0, measuredContentH - domAnchor.scrollHeight);
        const maxTargetY = scrollTopBefore + heightDelta + 80;
        if (targetY > maxTargetY) return false;
      }
      scrollControllerRef.current?.scrollToY(targetY);
      const nextMetrics = scrollControllerRef.current?.getMetrics();
      if (
        !verifyPrependScrollKept(domAnchor, nextMetrics?.scrollY ?? targetY)
      ) {
        return false;
      }
      if (nextMetrics) {
        pinnedScrollYRef.current = nextMetrics.scrollY;
        lastScrollYRef.current = nextMetrics.scrollY;
      }
      return true;
    },
    [resolveScrollLayoutMap, verifyPrependScrollKept],
  );

  /** Capture anchor + scrollTop immediately before a list merge (telegram-tt rememberScrollPosition). */
  const rememberDomScrollAtOlderLoadStart = useCallback((): void => {
    const remembered = rememberBeforeUpdate(
      scrollControllerRef.current,
      capturePrependItemAnchor,
    );
    chatScrollStateRef.current.remembered = remembered;
    scrollTopBeforeUpdateRef.current = remembered.scrollTop;
    loadOlderStartScrollYRef.current = remembered.scrollTop;
    olderLoadDomAnchorRef.current = remembered.domAnchor;
    if (remembered.domAnchor) {
      assignPendingScrollAnchor(remembered.domAnchor);
    }
    const item = remembered.itemAnchor;
    if (item && item.messageId > 0 && item.offsetFromViewportTop != null) {
      olderLoadMessageAnchorRef.current = {
        messageId: item.messageId,
        offsetFromViewportTop: item.offsetFromViewportTop,
      };
    }
  }, [assignPendingScrollAnchor, capturePrependItemAnchor]);

  const rememberItemAnchorBeforeMerge = useCallback((): void => {
    const item = capturePrependItemAnchor();
    pendingItemAnchorRef.current = item;
    if (chatScrollStateRef.current.remembered) {
      chatScrollStateRef.current.remembered.itemAnchor = item;
    }
    if (item && item.messageId > 0 && item.offsetFromViewportTop != null) {
      olderLoadMessageAnchorRef.current = {
        messageId: item.messageId,
        offsetFromViewportTop: item.offsetFromViewportTop,
      };
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0 && metrics.layoutH > 0) {
      scrollOffsetRef.current = Math.max(
        metrics.contentH - metrics.scrollY,
        metrics.layoutH,
      );
    }
  }, [capturePrependItemAnchor]);

  const rememberScrollBeforeListUpdate = useCallback((): void => {
    rememberDomScrollAtOlderLoadStart();
    rememberItemAnchorBeforeMerge();
  }, [rememberDomScrollAtOlderLoadStart, rememberItemAnchorBeforeMerge]);

  /** telegram-tt scrollTop += prependedHeight — authoritative when rows mount above. */
  const applyPrependDomScrollCompensation = useCallback((): number | null => {
    const domAnchor = olderLoadDomAnchorRef.current;
    const scrollTopBefore =
      loadOlderStartScrollYRef.current ?? scrollTopBeforeUpdateRef.current;
    if (!domAnchor || scrollTopBefore == null) return null;
    const liveAnchor = scrollControllerRef.current?.captureScrollAnchor();
    const contentH =
      liveAnchor?.scrollHeight ??
      scrollControllerRef.current?.getMetrics()?.contentH ??
      0;
    const heightDelta = Math.max(0, contentH - domAnchor.scrollHeight);
    if (heightDelta <= 0) return null;
    const targetY = scrollTopBefore + heightDelta;
    scrollControllerRef.current?.scrollToY(targetY);
    const nextMetrics = scrollControllerRef.current?.getMetrics();
    if (nextMetrics) {
      pinnedScrollYRef.current = nextMetrics.scrollY;
      lastScrollYRef.current = nextMetrics.scrollY;
    }
    return targetY;
  }, []);

  const settleOpenUnreadDividerScroll = useCallback((): boolean => {
    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    const readCursor = lastReadInboxMessageIdRef.current;
    // Resolve against the full loaded buffer — display slice may not include first unread yet.
    const lastReadId = resolveLastReadMessageId(loaded, readCursor);
    const firstUnreadId = resolveFirstUnreadMessageId(loaded, readCursor);
    if (firstUnreadId == null && lastReadId == null) {
      if (openScrollAnchorRef.current === "bottom") {
        settleOpenBottomScroll();
        unreadOpenAlignVerifiedRef.current = true;
        return true;
      }
      // Keep retrying until layouts/messages expose an unread boundary (do not fake-settle at bottom).
      return false;
    }

    const scrollAnchorId = firstUnreadId ?? lastReadId ?? 0;
    if (scrollAnchorId > 0 && scrollAnchorMessageIdRef.current !== scrollAnchorId) {
      scrollAnchorMessageIdRef.current = scrollAnchorId;
    }

    // telegram-tt: center the rendered slice on the oldest unread before measuring.
    if (
      firstUnreadId != null &&
      !display.some((row) => row.telegram_message_id === firstUnreadId)
    ) {
      viewportSliceTickRef.current += 1;
      setViewportSliceTick(viewportSliceTickRef.current);
      return false;
    }

    if (firstUnreadId != null) {
      if (memoFirstUnreadIdRef.current !== firstUnreadId) {
        memoFirstUnreadIdRef.current = firstUnreadId;
        memoUnreadDividerBeforeIdRef.current = firstUnreadId;
        setFrozenUnreadDividerBeforeId(firstUnreadId);
      }
    }

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0) return false;

    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    unreadViewportBaselineMessageIdRef.current = Math.max(
      0,
      (lastReadId ?? firstUnreadId ?? 1) - 1,
    );
    unreadMarkingArmedRef.current = false;
    unreadMarkingArmPendingRef.current = true;
    allowUnreadResetAtBottomRef.current = false;
    openScrollAwaitingLayoutMessageIdRef.current = scrollAnchorId > 0 ? scrollAnchorId : null;
    openUnreadAnchorMessageIdRef.current = firstUnreadId ?? scrollAnchorId;
    scheduleOpenUnreadAnchorRelease(300);

    const layoutMap = resolveScrollLayoutMap(metrics);
    const anchorEntry =
      (firstUnreadId != null ? layoutMap.get(firstUnreadId) : null) ??
      (lastReadId != null ? layoutMap.get(lastReadId) : null);
    if (!anchorEntry || anchorEntry.height <= 0) {
      // Estimated layouts should always expose height; retry once slice/layout catches up.
      return false;
    }

    const estimatedContentH = estimateMessageListBlockTotalHeight(
      displayMessagesRef.current,
      messageLayoutsRef.current,
      messageRowHeightCacheRef.current,
      MESSAGE_BUBBLE_ROW_GAP_PX,
    );
    const liveContentH = metrics.contentH > 0 ? metrics.contentH : 0;
    const contentH = Math.max(liveContentH, estimatedContentH);
    if (contentH <= 0) return false;

    // Prefer live DOM geometry when the unread row/divider is mounted — estimated
    // heights under-report media-heavy group chats and scrollToY then clamps to 0.
    let domTargetY: number | null = null;
    if (Platform.OS === "web" && firstUnreadId != null) {
      const row =
        typeof document !== "undefined"
          ? document.getElementById(`message-row-${firstUnreadId}`)
          : null;
      const divider =
        typeof document !== "undefined"
          ? document.getElementById("message-unread-divider")
          : null;
      const targetEl = divider ?? row;
      if (targetEl) {
        let node: HTMLElement | null = targetEl.parentElement;
        while (node) {
          const style = globalThis.getComputedStyle?.(node);
          if (
            style &&
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 20
          ) {
            const nodeRect = node.getBoundingClientRect();
            const elRect = targetEl.getBoundingClientRect();
            const offsetInContent = elRect.top - nodeRect.top + node.scrollTop;
            const rawTarget =
              divider != null && node.contains(divider)
                ? offsetInContent - UNREAD_DIVIDER_TOP_PX
                : offsetInContent - UNREAD_DIVIDER_ROW_HEIGHT_PX - UNREAD_DIVIDER_TOP_PX;
            const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
            domTargetY = Math.min(maxScroll, Math.max(0, rawTarget));
            break;
          }
          node = node.parentElement;
        }
      }
    }

    const layoutTargetY = scrollYToAlignUnreadDivider(
      anchorEntry,
      metrics.layoutH,
      contentH,
    );
    const targetY = domTargetY != null ? domTargetY : layoutTargetY;

    // Content still growing (common on media-heavy unread opens) — pin best-effort
    // but keep retrying until the DOM can actually reach the divider.
    const liveMaxScroll = Math.max(0, liveContentH - metrics.layoutH);
    if (
      domTargetY == null &&
      targetY > liveMaxScroll + 48 &&
      liveContentH + 1 < estimatedContentH * 0.85
    ) {
      applyProgrammaticScrollY(Math.min(targetY, liveMaxScroll));
      return false;
    }

    applyProgrammaticScrollY(targetY);

    const after = scrollControllerRef.current?.getMetrics();
    const afterY = after?.scrollY ?? pinnedScrollYRef.current;
    if (isUnreadDividerAlignedAtTop(afterY, targetY)) {
      unreadOpenAlignVerifiedRef.current = true;
      enableEdgeLoadingAfterOpen();
      return true;
    }

    // DOM divider near the top of the viewport is ground truth even if scrollY
    // metrics lag a frame behind scrollTop writes.
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const divider = document.getElementById("message-unread-divider");
      if (divider) {
        let node: HTMLElement | null = divider.parentElement;
        while (node) {
          const style = globalThis.getComputedStyle?.(node);
          if (
            style &&
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 20
          ) {
            const top = divider.getBoundingClientRect().top - node.getBoundingClientRect().top;
            if (top >= -8 && top <= 72) {
              unreadOpenAlignVerifiedRef.current = true;
              enableEdgeLoadingAfterOpen();
              return true;
            }
            break;
          }
          node = node.parentElement;
        }
      }
    }

    return false;
  }, [
    applyProgrammaticScrollY,
    enableEdgeLoadingAfterOpen,
    resolveScrollLayoutMap,
    scheduleOpenUnreadAnchorRelease,
    settleOpenBottomScroll,
  ]);

  const tryArmUnreadMarking = useCallback((metrics: HspScrollMetrics): boolean => {
    if (!chatScrollPaintReadyRef.current) return false;
    if (!unreadMarkingArmPendingRef.current || unreadMarkingArmedRef.current) {
      return unreadMarkingArmedRef.current;
    }
    if (openingUnreadCountRef.current <= 0) {
      unreadMarkingArmPendingRef.current = false;
      return false;
    }
    if (!userHasScrolledSinceOpenRef.current) {
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
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    });
  }, []);

  const bumpViewportSliceTick = useCallback(() => {
    viewportSliceTickRef.current += 1;
    setViewportSliceTick(viewportSliceTickRef.current);
  }, []);

  const expandDisplaySliceTowardOlder = useCallback((
    _options?: { chainLoadOlderWhenAtTop?: boolean },
  ) => {
    if (pendingItemAnchorRef.current) return false;
    if (prependAnchorRestorePendingRef.current) return false;
    if (activePrependRestoreRef.current) return false;
    if (loadingOlderRef.current || olderPrependInProgressRef.current) return false;
    const loaded = loadedMessagesRef.current;
    const current = {
      bounds: displaySliceBoundsRef.current,
      override: displaySliceBoundsOverrideRef.current,
      anchorMessageId: scrollAnchorMessageIdRef.current,
      atLoadedTop: viewportAtLoadedTopRef.current,
      atLoadedBottom: viewportAtLoadedBottomRef.current,
    };
    const next = expandWindowOlder(loaded, current, MESSAGE_LIST_SLICE);
    if (!next) return false;
    // Lock before any async render so sentinel + scroll cannot double-expand.
    olderPrependInProgressRef.current = true;
    olderPrependKindRef.current = "display_expand";
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    beginPrependPhase(
      chatScrollStateRef.current,
      scrollControllerRef.current,
      capturePrependItemAnchor,
      "display_expand",
    );
    isReplacingHistoryRef.current = true;
    displayExpandAnchorIdRef.current =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    const expandAnchorId =
      topViewportAnchorMessageId(
        displayMessagesRef.current,
        resolveScrollLayoutMap(),
        scrollControllerRef.current?.getMetrics() ?? {
          scrollY: 0,
          layoutH: 0,
          contentH: 0,
        },
      ) ?? displayExpandAnchorIdRef.current;
    if (expandAnchorId > 0) {
      olderLoadLockedAnchorIdRef.current = expandAnchorId;
    }
    // telegram-tt: widen the in-buffer display window only. API older paging is
    // triggered separately by the top sentinel / near-top edge — never chained
    // from display expand (avoids double-prepend autoscroll at the loaded head).
    loadOlderAfterExpandSnapshotRef.current = null;
    rememberScrollBeforeListUpdate();
    displaySliceBoundsOverrideRef.current = next.override;
    displaySliceBoundsRef.current = next.bounds;
    programmaticScrollRef.current = true;
    setPrependAnchorRestorePendingSynced(true);
    logMessagesScrollAction("display_expand_start", {
      prevStart: current.bounds.startIndex,
      nextStart: next.bounds.startIndex,
      displayCount: next.bounds.endIndex - next.bounds.startIndex + 1,
      loadOlderAfterExpand: false,
      anchorMessageId: expandAnchorId,
    });
    bumpViewportSliceTick();
    return true;
  }, [
    bumpViewportSliceTick,
    capturePrependItemAnchor,
    logMessagesScrollAction,
    rememberScrollBeforeListUpdate,
    resolveScrollLayoutMap,
    setPrependAnchorRestorePendingSynced,
  ]);

  /** Expand the count-based display window toward already-loaded newer rows (no API fetch). */
  const expandDisplaySliceTowardNewer = useCallback(() => {
    if (pendingItemAnchorRef.current) return false;
    if (prependAnchorRestorePendingRef.current) return false;
    // Never widen toward newer while an older API prepend is in flight — that
    // rewrites the display window and consumes scroll restore early (jump).
    if (loadingOlderRef.current || olderPrependInProgressRef.current) return false;
    const loaded = loadedMessagesRef.current;
    const bounds = displaySliceBoundsRef.current;
    if (bounds.endIndex < bounds.startIndex) return false;
    if (bounds.endIndex >= loaded.length - 1) return false;
    const nextBounds = expandDisplaySliceNewer(loaded, bounds, MESSAGE_LIST_SLICE);
    if (nextBounds.endIndex <= bounds.endIndex) return false;
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    // Pin the visible row across append growth (flex spacer / media resize / virtual window).
    // Capture anchor locally — do not arm pendingItemAnchorRef or the prepend-restore
    // layout effect will treat this as an older prepend and jump the viewport.
    const itemAnchor = capturePrependItemAnchor();
    isReplacingHistoryRef.current = true;
    displaySliceBoundsOverrideRef.current = {
      startIndex: Math.min(nextBounds.startIndex, bounds.startIndex),
      endIndex: nextBounds.endIndex,
    };
    logMessagesScrollAction("display_expand_newer_start", {
      prevEnd: bounds.endIndex,
      nextEnd: nextBounds.endIndex,
      displayCount: nextBounds.endIndex - nextBounds.startIndex + 1,
    });
    bumpViewportSliceTick();
    displaySliceBoundsRef.current = {
      startIndex: Math.min(nextBounds.startIndex, bounds.startIndex),
      endIndex: nextBounds.endIndex,
    };
    if (itemAnchor) {
      requestAnimationFrame(() => {
        const restored =
          scrollControllerRef.current?.restoreItemAnchor(itemAnchor) ?? false;
        logMessagesScrollAction("display_expand_newer_keep", {
          restored,
          messageId: itemAnchor.messageId,
        });
        isReplacingHistoryRef.current = false;
        const nextMetrics = scrollControllerRef.current?.getMetrics();
        if (nextMetrics) {
          pinnedScrollYRef.current = nextMetrics.scrollY;
          lastScrollYRef.current = nextMetrics.scrollY;
        }
        scheduleVirtualScrollWindowUpdate();
      });
    } else {
      requestAnimationFrame(() => {
        isReplacingHistoryRef.current = false;
        scheduleVirtualScrollWindowUpdate();
      });
    }
    return true;
  }, [
    bumpViewportSliceTick,
    capturePrependItemAnchor,
    logMessagesScrollAction,
    scheduleVirtualScrollWindowUpdate,
  ]);

  /** Expand the count-based display window toward already-loaded older rows (no API fetch). */
  const beginDisplaySliceExpand = expandDisplaySliceTowardOlder;

  const handleScrollPositionChange = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0) {
        if (!chatScrollPaintReadyRef.current && metrics.layoutH > 0) {
          openScrollSettleRef.current.scheduleRetry();
        }
        return;
      }
      if (isScrollTopJustUpdatedRef.current) {
        lastScrollYRef.current = metrics.scrollY;
        pinnedScrollYRef.current = metrics.scrollY;
        scrollOffsetRef.current = Math.max(
          metrics.contentH - metrics.scrollY,
          metrics.layoutH,
        );
        return;
      }
      const deltaY = metrics.scrollY - lastScrollYRef.current;
      const nearBottom = isScrollNearBottom(metrics);
      if (
        olderPrependInProgressRef.current &&
        Math.abs(deltaY) > 2 &&
        !programmaticScrollRef.current &&
        !isScrollTopJustUpdatedRef.current
      ) {
        logMessagesScrollAction("prepend_unexpected_scroll", {
          deltaY,
          pendingAnchor: pendingScrollAnchorRef.current != null,
          scrollAnchorRestorePending,
        });
      }
      if (Math.abs(deltaY) > 0.5) {
        userScrollingUpRef.current = deltaY < 0;
        const awaitingUnreadCatchUp = unreadCatchUpAwaitingUserScroll();
        if (
          Math.abs(deltaY) > 2 &&
          !programmaticScrollRef.current &&
          !awaitingUnreadCatchUp
        ) {
          if (!nearBottom) {
            followingBottomRef.current = false;
            setIsFollowingBottom(false);
            setAuthenticatedHomeOpenChatFollowingBottom(false);
          }
          if (!userHasScrolledSinceOpenRef.current) {
            userHasScrolledSinceOpenRef.current = true;
            setUserScrollInteractionTick((tick) => tick + 1);
            unlockHistoryEdgesOnUserScrollRef.current();
            if (openingUnreadCountRef.current > 0) {
              openUnreadAnchorLockUntilRef.current = 0;
              if (openUnreadAnchorReleaseTimerRef.current != null) {
                clearTimeout(openUnreadAnchorReleaseTimerRef.current);
                openUnreadAnchorReleaseTimerRef.current = null;
              }
            }
          }
        }
        if (
          Math.abs(deltaY) > 2 &&
          Date.now() < openUnreadAnchorLockUntilRef.current &&
          !programmaticScrollRef.current &&
          !awaitingUnreadCatchUp
        ) {
          openUnreadAnchorLockUntilRef.current = 0;
          if (openUnreadAnchorReleaseTimerRef.current != null) {
            clearTimeout(openUnreadAnchorReleaseTimerRef.current);
            openUnreadAnchorReleaseTimerRef.current = null;
          }
          unlockHistoryEdgesOnUserScrollRef.current();
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
      } else if (
        chatScrollPaintReadyRef.current &&
        openScrollToUnreadDividerRef.current &&
        !unreadOpenAlignVerifiedRef.current &&
        openingUnreadCountRef.current > 0 &&
        !userHasScrolledSinceOpenRef.current &&
        metrics.contentH > metrics.layoutH + 0.5
      ) {
        // Content grew after a premature reveal (media/layouts) — re-pin to oldest unread.
        if (settleOpenUnreadDividerScroll()) {
          logMessagesScrollAction("unread_open_realign", {
            scrollY: pinnedScrollYRef.current,
            contentH: metrics.contentH,
          });
        }
      }
      scheduleVirtualScrollWindowUpdate();
      setFabUnreadDisplayTick((tick) => tick + 1);
      const nearTop = metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX;
      // Prefetch older pages before the hard top edge (tdesktop: 3 screens).
      const nearTopPrefetch =
        metrics.scrollY <=
        chatEdgePrefetchPx(
          metrics.layoutH,
          MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
          MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
        );
      if (!initialScrollInProgressRef.current) {
        setIsNearScrollTop((current) => (current === nearTop ? current : nearTop));
        setIsNearScrollBottom((current) => (current === nearBottom ? current : nearBottom));
      }

      if (initialScrollInProgressRef.current) {
        prevContentHForBottomStickRef.current = metrics.contentH;
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
              openScrollSettleRef.current.forceReveal("near_bottom_open_settle");
            }
          }
        }
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
        nearTopPrefetch &&
        (userScrollingUpRef.current || nearTop) &&
        !initialScrollInProgressRef.current &&
        Date.now() >= openUnreadAnchorLockUntilRef.current
      ) {
        tryTriggerOlderHistoryLoadRef.current();
      }

      if (
        nearBottom &&
        !userScrollingUpRef.current &&
        !initialScrollInProgressRef.current &&
        Date.now() >= openUnreadAnchorLockUntilRef.current
      ) {
        tryTriggerNewerHistoryLoadRef.current();
      }

      if (saveScrollDebounceRef.current) {
        clearTimeout(saveScrollDebounceRef.current);
      }
      saveScrollDebounceRef.current = setTimeout(() => {
        saveScrollDebounceRef.current = null;
        scrollOffsetRef.current = Math.max(
          metrics.contentH - metrics.scrollY,
          metrics.layoutH,
        );
        persistChatScrollPosition(metrics);
      }, 300);
    },
    [
      chat.unread_count,
      logMessagesScrollAction,
      scheduleVirtualScrollWindowUpdate,
      scrollAnchorRestorePending,
      settleOpenUnreadDividerScroll,
      tryArmUnreadMarking,
      isScrollNearBottom,
      persistChatScrollPosition,
      resolveEffectiveFollowingBottom,
      unreadCatchUpAwaitingUserScroll,
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
    const anchor = scrollControllerRef.current?.captureScrollAnchor();
    if (anchor) {
      assignPendingScrollAnchor(anchor);
      return;
    }
    requestAnimationFrame(() => {
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return;
      const maxScroll = Math.max(0, metrics.contentH - metrics.layoutH);
      const targetY = Math.min(Math.max(0, scrollY), maxScroll);
      isScrollTopJustUpdatedRef.current = true;
      programmaticScrollRef.current = true;
      scrollControllerRef.current?.scrollToY(targetY);
      pinnedScrollYRef.current = targetY;
      requestAnimationFrame(() => {
        isScrollTopJustUpdatedRef.current = false;
        programmaticScrollRef.current = false;
      });
    });
  }, [assignPendingScrollAnchor]);

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

    const targetY = scrollYFromCachedPosition(state, metrics.layoutH, metrics.contentH);
    scrollControllerRef.current?.applyInitialScroll(targetY);
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
      if (
        messagesCountRef.current > 0 &&
        (loadingOlderRef.current ||
          loadingNewerRef.current ||
          olderLoadLockedAnchorIdRef.current > 0 ||
          olderPrependInProgressRef.current)
      ) {
        return;
      }
      const replace = options?.replace !== false;
      const cachedMaxId =
        cached.messages.length > 0
          ? cached.messages[cached.messages.length - 1]!.telegram_message_id
          : 0;
      const cacheSignature = `${cached.fetchedAt}:${cached.messages.length}:${cachedMaxId}:${cached.previewOnly ? 1 : 0}:${cached.aroundUnread ? 1 : 0}:${cached.aroundMessageId ?? ""}`;
      if (!replace && cacheSignature === lastAppliedCacheSignatureRef.current) {
        return;
      }
      const loadedHead =
        loadedMessagesRef.current[0]?.telegram_message_id ?? 0;
      const cacheHead = cached.messages[0]?.telegram_message_id ?? 0;
      const extendsOlder =
        !replace &&
        cacheHead > 0 &&
        (loadedHead === 0 || cacheHead < loadedHead);
      if (extendsOlder && chatScrollPaintReadyRef.current) {
        bumpViewportSliceTick();
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
          let nextMessages = cached.messages;
          // telegram-tt: first paint only the viewport around the oldest unread.
          if (
            openScrollToUnreadDividerRef.current &&
            !chatScrollPaintReadyRef.current &&
            nextMessages.length > MESSAGE_LIST_VIEWPORT_LIMIT
          ) {
            const readCursor =
              cached.lastReadInboxMessageId ?? lastReadInboxMessageIdRef.current;
            const firstUnread = resolveFirstUnreadMessageId(nextMessages, readCursor);
            const paintAnchor =
              firstUnread ??
              resolveLastReadMessageId(nextMessages, readCursor) ??
              nextMessages[0]!.telegram_message_id;
            nextMessages = trimLoadedAroundAnchor(
              nextMessages,
              paintAnchor,
              MESSAGE_LIST_VIEWPORT_LIMIT,
            );
            if (paintAnchor > 0) {
              scrollAnchorMessageIdRef.current = paintAnchor;
            }
          } else if (
            openScrollToUnreadDividerRef.current &&
            !chatScrollPaintReadyRef.current
          ) {
            const readCursor =
              cached.lastReadInboxMessageId ?? lastReadInboxMessageIdRef.current;
            const firstUnread = resolveFirstUnreadMessageId(nextMessages, readCursor);
            if (firstUnread != null) {
              scrollAnchorMessageIdRef.current = firstUnread;
            }
          } else if (
            !openScrollToUnreadDividerRef.current &&
            !chatScrollPaintReadyRef.current
          ) {
            const paintAnchor = resolveOpenHistoryFetchAnchor(
              chat,
              chatOpenScrollPlanFromSession(resolveChatOpenSession(chat)),
            );
            if (paintAnchor > 0) {
              scrollAnchorMessageIdRef.current = paintAnchor;
            }
          }
          return mergeHistoryWithWindow([], nextMessages, true, {
            skipTrim: !cached.previewOnly && !cached.hasMoreOlder,
          });
        });
      } else {
        setMessages((prev) => {
          const prevHead = prev[0]?.telegram_message_id ?? 0;
          const cacheHeadInner = cached.messages[0]?.telegram_message_id ?? 0;
          const extendsOlderInner =
            cacheHeadInner > 0 && (prevHead === 0 || cacheHeadInner < prevHead);
          const next = mergeHistoryWithWindow(
            prev,
            cached.messages,
            !extendsOlderInner,
            { skipTrim: !cached.previewOnly && !cached.hasMoreOlder },
          );
          if (historyTailSignature(next) === historyTailSignature(prev)) return prev;
          return next;
        });
      }
      lastAppliedCacheSignatureRef.current = cacheSignature;
      appliedHistoryFromPreviewCacheRef.current = cached.previewOnly === true;
      historyLoadedAroundUnreadRef.current =
        cached.aroundUnread === true && cached.previewOnly !== true;
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
        mergeOlderPaginationCursor(
          cached.hasMoreOlder,
          cached.nextBeforeMessageId,
          cacheHead,
        );
      }
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, cached.lastReadOutboxMessageId),
      );
      if (cached.lastReadInboxMessageId != null) {
        applyLastReadInboxMessageId(cached.lastReadInboxMessageId);
      }
      setLoadingInitial(false);
      setError(null);
    },
    [bumpViewportSliceTick, chat.telegram_chat_id, applyLastReadInboxMessageId, historyMessageContext, mergeHistoryWithWindow, mergeOlderPaginationCursor],
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

  const loadedMessages = useMemo(() => {
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

  // Keep the ref current during render so scroll-up pagination does not use a
  // one-commit-stale head (useEffect lags behind the setMessages updater).
  loadedMessagesRef.current = loadedMessages;

  const displayMessages = useMemo(() => {
    if (loadedMessages.length === 0) {
      viewportAtLoadedTopRef.current = false;
      viewportAtLoadedBottomRef.current = false;
      displaySliceBoundsRef.current = { startIndex: 0, endIndex: -1 };
      displaySliceBoundsOverrideRef.current = null;
      return [];
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    const nearBottom =
      metrics != null && metrics.contentH > 0 && metrics.layoutH > 0
        ? isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
        : followingBottomRef.current;

    let anchorId = scrollAnchorMessageIdRef.current;
    const pinningOpenScroll =
      (pendingInitialScrollRef.current || initialScrollInProgressRef.current) &&
      anchorId > 0;
    if (pinningOpenScroll) {
      // Keep unread-anchor pin until open scroll completes.
    } else if (
      nearBottom &&
      followingBottomRef.current &&
      !loadingOlderRef.current &&
      displaySliceBoundsOverrideRef.current == null
    ) {
      anchorId = loadedMessages[loadedMessages.length - 1]!.telegram_message_id;
      scrollAnchorMessageIdRef.current = anchorId;
    } else if (anchorId <= 0) {
      // During unread open, prefer first-unread / head — never default the slice to the chat tail.
      if (
        (pendingInitialScrollRef.current || initialScrollInProgressRef.current) &&
        openScrollToUnreadDividerRef.current
      ) {
        const readCursor = lastReadInboxMessageIdRef.current;
        const firstUnread = resolveFirstUnreadMessageId(loadedMessages, readCursor);
        anchorId =
          firstUnread ??
          resolveLastReadMessageId(loadedMessages, readCursor) ??
          loadedMessages[0]!.telegram_message_id;
      } else {
        anchorId = loadedMessages[loadedMessages.length - 1]!.telegram_message_id;
      }
      scrollAnchorMessageIdRef.current = anchorId;
    } else if (
      (pendingInitialScrollRef.current || initialScrollInProgressRef.current) &&
      openScrollToUnreadDividerRef.current &&
      !loadedMessages.some((row) => row.telegram_message_id === anchorId)
    ) {
      // Stale anchor outside the around-unread window — retarget oldest unread.
      const readCursor = lastReadInboxMessageIdRef.current;
      const firstUnread = resolveFirstUnreadMessageId(loadedMessages, readCursor);
      anchorId =
        firstUnread ??
        resolveLastReadMessageId(loadedMessages, readCursor) ??
        loadedMessages[0]!.telegram_message_id;
      scrollAnchorMessageIdRef.current = anchorId;
    }

    // While a top-pinned display_expand override is active, anchor the window on
    // the buffer head so mergeOverride stays wide. During api_load prepends keep
    // the locked viewport row as the resolve anchor — override widens from 0 so
    // new older rows are included; scrollTop is compensated in layout before paint.
    const prependOverride = displaySliceBoundsOverrideRef.current;
    if (
      olderPrependKindRef.current === "display_expand" &&
      (prependAnchorRestorePendingRef.current || prependOverride != null) &&
      (prependOverride?.startIndex === 0 ||
        displaySliceBoundsRef.current.startIndex === 0)
    ) {
      const loadedHeadId = loadedMessages[0]?.telegram_message_id ?? 0;
      if (loadedHeadId > 0) {
        anchorId = loadedHeadId;
      }
    } else if (
      olderPrependKindRef.current === "api_load" &&
      (prependAnchorRestorePendingRef.current || prependOverride != null)
    ) {
      const lockedId = olderLoadLockedAnchorIdRef.current;
      if (lockedId > 0) {
        anchorId = lockedId;
      }
    }

    const window = resolveDisplayWindow(
      loadedMessages,
      anchorId,
      displaySliceBoundsOverrideRef.current,
      MESSAGE_LIST_SLICE,
    );
    const bounds = window.bounds;
    displaySliceBoundsRef.current = bounds;
    if (bounds.endIndex < bounds.startIndex) return [];
    viewportAtLoadedTopRef.current = window.atLoadedTop;
    viewportAtLoadedBottomRef.current = window.atLoadedBottom;
    return sliceDisplayMessages(loadedMessages, window);
  }, [
    loadedMessages,
    viewportSliceTick,
    virtualScrollTick,
    userScrollInteractionTick,
  ]);

  const allLoadedMessagesAreFromToday = useMemo(() => {
    if (loadedMessages.length === 0) return false;
    const today = todayDayKey();
    return loadedMessages.every((m) => messageDayKey(m.sent_at) === today);
  }, [loadedMessages]);

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

  useEffect(() => {
    const messages = loadedMessages;
    if (messages.length === 0) return;

    const serverUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
    const openingUnread = openingUnreadCountRef.current;
    const hasUnreads = serverUnread > 0 || openingUnread > 0;
    if (!hasUnreads) {
      if (frozenUnreadDividerBeforeId != null) {
        setFrozenUnreadDividerBeforeId(null);
        memoFirstUnreadIdRef.current = null;
        memoUnreadDividerBeforeIdRef.current = null;
      }
      return;
    }

    if (appliedHistoryFromPreviewCacheRef.current) return;

    const readCursor = lastReadInboxMessageIdRef.current;
    const firstUnread = resolveFirstUnreadMessageId(messages, readCursor);
    if (firstUnread == null) {
      if (frozenUnreadDividerBeforeId != null) {
        setFrozenUnreadDividerBeforeId(null);
        memoFirstUnreadIdRef.current = null;
        memoUnreadDividerBeforeIdRef.current = null;
      }
      return;
    }

    if (frozenUnreadDividerBeforeId === firstUnread) return;

    const unreadIndex = messages.findIndex(
      (row) => row.telegram_message_id === firstUnread,
    );
    if (unreadIndex >= 0) {
      const bounds = displaySliceBoundsRef.current;
      const inSlice =
        bounds.endIndex >= bounds.startIndex &&
        unreadIndex >= bounds.startIndex &&
        unreadIndex <= bounds.endIndex;
      if (!inSlice && openingUnread > 0) {
        scrollAnchorMessageIdRef.current = firstUnread;
        viewportSliceTickRef.current += 1;
        setViewportSliceTick(viewportSliceTickRef.current);
      }
    }
    memoFirstUnreadIdRef.current = firstUnread;
    memoUnreadDividerBeforeIdRef.current = firstUnread;
    setFrozenUnreadDividerBeforeId(firstUnread);
  }, [loadedMessages, frozenUnreadDividerBeforeId, chat.unread_count, readInboxCursorTick]);

  const syncScrollBelowUnread = useCallback(
    (metrics: HspScrollMetrics) => {
      if (!chatScrollPaintReadyRef.current) return;
      if (initialScrollInProgressRef.current) return;
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
      const firstUnreadFloor = memoFirstUnreadIdRef.current;
      if (
        maxVisibleUnreadId != null &&
        firstUnreadFloor != null &&
        maxVisibleUnreadId < firstUnreadFloor
      ) {
        return;
      }
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
    setFabUnreadDisplayTick((tick) => tick + 1);
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
    if (tryArmUnreadMarking(metrics)) {
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

  const applyOpenScrollOnce = useCallback((): boolean => {
    if (chatScrollPaintReadyRef.current || openScrollAppliedRef.current) {
      // Defensive: generation bumps used to re-arm initialScroll while leaving
      // openScrollApplied true, so settle never cleared the edge-load lock.
      if (initialScrollInProgressRef.current) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
      }
      if (!chatScrollPaintReadyRef.current) {
        revealChatScroll();
      }
      return true;
    }
    beginOpenSettlePhase(chatScrollStateRef.current);
    if (displayMessagesRef.current.length === 0) {
      if (!loadingInitial) {
        openScrollAppliedRef.current = true;
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
        endOpenSettlePhase(chatScrollStateRef.current, scrollControllerRef.current);
        revealChatScroll();
      }
      return true;
    }

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0) return false;
    const contentReady =
      metrics.contentH > metrics.layoutH + 0.5 || displayMessagesRef.current.length > 0;
    if (!contentReady) return false;

    if (pendingScrollRestoreRef.current) {
      if (!restoreChatScrollPosition(pendingScrollRestoreRef.current)) return false;
      pendingScrollRestoreRef.current = null;
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: "restore_cached",
        scrollY: pinnedScrollYRef.current,
        openingUnread: openingUnreadCountRef.current,
      });
    } else if (pendingInitialScrollRef.current) {
      if (openScrollToUnreadDividerRef.current) {
        if (!settleOpenUnreadDividerScroll()) return false;
      } else if (openScrollAnchorRef.current === "bottom") {
        settleOpenBottomScroll();
      }
      pendingInitialScrollRef.current = false;
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: openScrollToUnreadDividerRef.current ? "unread_divider" : "initial_bottom",
        scrollY: pinnedScrollYRef.current,
        openingUnread: openingUnreadCountRef.current,
        firstUnreadId:
          resolveFirstUnreadMessageId(
            displayMessagesRef.current,
            lastReadInboxMessageIdRef.current,
          ) ?? 0,
        lastReadId:
          resolveLastReadMessageId(
            displayMessagesRef.current,
            lastReadInboxMessageIdRef.current,
          ) ?? 0,
      });
    }

    initialScrollInProgressRef.current = false;
    setInitialScrollInProgress(false);
    enableEdgeLoadingAfterOpen();
    openScrollAppliedRef.current = true;
    endOpenSettlePhase(chatScrollStateRef.current, scrollControllerRef.current);
    revealChatScroll();
    virtualScrollTickRef.current += 1;
    setVirtualScrollTick(virtualScrollTickRef.current);
    requestAnimationFrame(() => {
      const settledMetrics = scrollControllerRef.current?.getMetrics();
      if (
        settledMetrics &&
        settledMetrics.contentH > 0 &&
        chatScrollPaintReadyRef.current &&
        !unreadCatchUpAwaitingUserScroll() &&
        tryArmUnreadMarking(settledMetrics)
      ) {
        syncScrollBelowUnreadRef.current(settledMetrics);
      }
    });
    return true;
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    enableEdgeLoadingAfterOpen,
    loadingInitial,
    restoreChatScrollPosition,
    revealChatScroll,
    settleOpenBottomScroll,
    settleOpenUnreadDividerScroll,
    tryArmUnreadMarking,
    unreadCatchUpAwaitingUserScroll,
  ]);

  const scheduleOpenScrollApply = useCallback(() => {
    if (chatScrollPaintReadyRef.current || openScrollAppliedRef.current) return;
    if (openScrollSettleRetryRafRef.current != null) return;
    let attempts = 0;
    const tick = () => {
      openScrollSettleRetryRafRef.current = null;
      if (chatScrollPaintReadyRef.current) return;
      const applied = applyOpenScrollOnce();
      if (!applied && ++attempts < 60) {
        openScrollSettleRetryRafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (!applied && !chatScrollPaintReadyRef.current) {
        openScrollSettleRef.current.forceReveal("open_scroll_retry_exhausted");
      }
    };
    openScrollSettleRetryRafRef.current = requestAnimationFrame(tick);
  }, [applyOpenScrollOnce]);

  const scheduleOpenScrollForceReveal = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    if (openScrollForceRevealTimerRef.current != null) return;
    // Media-heavy unread opens need longer than a blank bottom open — keep
    // retrying settle until the divider can land near UNREAD_DIVIDER_TOP.
    const delayMs = openScrollToUnreadDividerRef.current ? 1800 : 600;
    openScrollForceRevealTimerRef.current = setTimeout(() => {
      openScrollForceRevealTimerRef.current = null;
      if (!chatScrollPaintReadyRef.current) {
        // Last chance to land on the unread divider before paint (do not reveal at a random Y).
        openScrollSettleRef.current.forceReveal("open_scroll_timeout");
      }
    }, delayMs);
  }, []);

  openScrollSettleRef.current = {
    trySettle: applyOpenScrollOnce,
    scheduleRetry: scheduleOpenScrollApply,
    forceReveal: (reason?: string) => {
      // Last chance: land on the unread divider from estimated layouts before paint.
      if (openScrollToUnreadDividerRef.current && !openScrollAppliedRef.current) {
        const settled = settleOpenUnreadDividerScroll();
        if (settled) {
          pendingInitialScrollRef.current = false;
          initialScrollInProgressRef.current = false;
          setInitialScrollInProgress(false);
          openScrollAppliedRef.current = true;
          unreadOpenAlignVerifiedRef.current = true;
          revealChatScroll();
          enableEdgeLoadingAfterOpen();
          logPageDisplay("messages_open_scroll_settle", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            phase: "unread_divider_force",
            reason: reason ?? "unspecified",
            scrollY: pinnedScrollYRef.current,
            openingUnread: openingUnreadCountRef.current,
            firstUnreadId:
              resolveFirstUnreadMessageId(
                loadedMessagesRef.current,
                lastReadInboxMessageIdRef.current,
              ) ?? 0,
          });
          return;
        }
      }
      // Best-effort: if the divider is in the DOM, jump there even when verification failed.
      if (openScrollToUnreadDividerRef.current && Platform.OS === "web") {
        const divider =
          typeof document !== "undefined"
            ? document.getElementById("message-unread-divider")
            : null;
        if (divider) {
          let node: HTMLElement | null = divider.parentElement;
          while (node) {
            const style = globalThis.getComputedStyle?.(node);
            if (
              style &&
              (style.overflowY === "auto" || style.overflowY === "scroll") &&
              node.scrollHeight > node.clientHeight + 20
            ) {
              const offset =
                divider.getBoundingClientRect().top -
                node.getBoundingClientRect().top +
                node.scrollTop;
              const targetY = Math.max(0, offset - UNREAD_DIVIDER_TOP_PX);
              applyProgrammaticScrollY(targetY);
              unreadOpenAlignVerifiedRef.current = isUnreadDividerAlignedAtTop(
                scrollControllerRef.current?.getMetrics()?.scrollY ?? targetY,
                targetY,
              );
              break;
            }
            node = node.parentElement;
          }
        }
      }
      if (applyOpenScrollOnce()) return;
      logPageDisplay("messages_open_scroll_force_reveal", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        reason: reason ?? "unspecified",
        scrollY: pinnedScrollYRef.current,
        openingUnread: openingUnreadCountRef.current,
        pendingUnreadDivider: openScrollToUnreadDividerRef.current,
      });
      openScrollAppliedRef.current = true;
      initialScrollInProgressRef.current = false;
      setInitialScrollInProgress(false);
      revealChatScroll();
      enableEdgeLoadingAfterOpen();
    },
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

      if (!virtualActive) {
        messageLayoutsRef.current.set(messageId, { y, height });
      } else {
        // Virtual Y is slice-relative; keep measured block height for viewport-aware layouts.
        messageLayoutsRef.current.set(messageId, { y: 0, height });
      }

      messageRowHeightCacheRef.current.set(messageId, contentHeight);
      if (chatScrollPaintReadyRef.current) {
        bumpVirtualLayoutFromMeasure(messageId, prevContentHeight, contentHeight);
      }
    }
    if (!chatScrollPaintReadyRef.current) {
      scheduleOpenScrollApply();
    }
  }, [bumpVirtualLayoutFromMeasure, scheduleOpenScrollApply]);

  const handleOpenScrollMetrics = useCallback(
    (metrics: Omit<HspScrollMetrics, "scrollY">) => {
      if (metrics.layoutH > 0) {
        pinnedLayoutHRef.current = metrics.layoutH;
        setScrollViewportH((prev) =>
          Math.abs(prev - metrics.layoutH) < 0.5 ? prev : metrics.layoutH,
        );
      }
      if (olderPrependInProgressRef.current) {
        schedulePrependKeepFromLayout();
      }
      if (chatScrollPaintReadyRef.current) return;
      if (metrics.layoutH <= 0) return;
      if (displayMessages.length === 0 && !loadingInitial) {
        revealChatScroll();
        return;
      }
      if (displayMessages.length === 0) return;
      scheduleOpenScrollApply();
      scheduleOpenScrollForceReveal();
    },
    [
      displayMessages.length,
      loadingInitial,
      revealChatScroll,
      scheduleOpenScrollApply,
      scheduleOpenScrollForceReveal,
      schedulePrependKeepFromLayout,
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
      scheduleOpenScrollApply();
      scheduleOpenScrollForceReveal();
    }

    if (displayMessages.length === 0) return;

    if (pendingPreserveScrollYRef.current != null) {
      const scrollY = pendingPreserveScrollYRef.current;
      pendingPreserveScrollYRef.current = null;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      prevDisplayHeadIdRef.current = displayMessages[0]?.telegram_message_id ?? 0;
      preserveScrollY(scrollY);
      return;
    }

    const prevLen = prevDisplayLengthRef.current;
    const prevLastId = prevDisplayLastIdRef.current;
    const prevHeadId = prevDisplayHeadIdRef.current;
    const newHeadId = displayMessages[0]?.telegram_message_id ?? 0;
    const lengthGrew = displayMessages.length > prevLen;
    const newerTail = lastDisplayMessageId > prevLastId;
    prevDisplayLengthRef.current = displayMessages.length;
    prevDisplayLastIdRef.current = lastDisplayMessageId;
    prevDisplayHeadIdRef.current = newHeadId;

    if (
      openingUnreadCountRef.current <= 0 &&
      followingBottomRef.current &&
      !userHasScrolledSinceOpenRef.current &&
      !olderPrependInProgressRef.current &&
      !loadingOlderRef.current &&
      isAtLoadedChatTail(lastDisplayMessageId, chatTailMessageIdRef.current) &&
      (newerTail || lengthGrew) &&
      Date.now() >= layoutSettlingUntilRef.current
    ) {
      const metrics = scrollControllerRef.current?.getMetrics();
      const layoutH = metrics?.layoutH ?? pinnedLayoutHRef.current;
      const contentH = metrics?.contentH ?? 0;
      if (
        layoutH > 0 &&
        contentH > 0 &&
        isChatScrollNearBottom(pinnedScrollYRef.current, layoutH, contentH)
      ) {
        scrollControllerRef.current?.scrollToEnd();
        const nextY = Math.max(0, contentH - layoutH);
        pinnedScrollYRef.current = nextY;
        lastScrollYRef.current = nextY;
        followingBottomRef.current = true;
        setIsFollowingBottom(true);
        setAuthenticatedHomeOpenChatFollowingBottom(true);
      }
    }
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    preserveScrollY,
    scheduleOpenScrollApply,
    scheduleOpenScrollForceReveal,
  ]);

  useLayoutEffect(() => {
    if (activePrependRestoreRef.current) return;

    const itemAnchor = pendingItemAnchorRef.current;
    const loadOlderBeforeId = loadOlderAfterExpandSnapshotRef.current;
    if (!itemAnchor && loadOlderBeforeId == null) return;
    pendingItemAnchorRef.current = null;
    loadOlderAfterExpandSnapshotRef.current = null;
    activePrependRestoreRef.current = { itemAnchor, loadOlderBeforeId };

    const capturedItemAnchor = itemAnchor;
    const capturedLoadOlderBeforeId = loadOlderBeforeId;
    let attempts = 0;
    let released = false;
    let stableFrames = 0;
    let lastContentH = -1;
    const release = (restored: boolean, options?: { skipDomCompensate?: boolean }) => {
      if (released) return;
      released = true;
      activePrependRestoreRef.current = null;
      // Skip height-delta only when the restore loop already verified the keep
      // (item-anchor / DOM restore). Mid-history api_load remounts need compensate
      // when restore failed — never blanket-skip solely because kind === api_load.
      const skipDomCompensate = options?.skipDomCompensate === true;
      const domCompensatedY = skipDomCompensate
        ? null
        : applyPrependDomScrollCompensation();
      olderLoadDomAnchorRef.current = null;
      const pinnedBeforeRelease = pinnedScrollYRef.current;
      const startYBeforeRelease = loadOlderStartScrollYRef.current;
      // Pin the natural display slice to the viewport row before dropping the
      // widened override. Otherwise a top-pinned expand leaves the scroll
      // anchor on the buffer head and the ~40-row window blanks mid-list.
      const pinId =
        olderLoadLockedAnchorIdRef.current > 0
          ? olderLoadLockedAnchorIdRef.current
          : capturedItemAnchor?.messageId ?? 0;
      if (pinId > 0) {
        scrollAnchorMessageIdRef.current = pinId;
      }
      // Keep the settled window as an override floor (including shifted startIndex
      // after API prepend). Clearing it collapses to a ~40-row slice and clamps
      // scrollTop / blocks the next older edge load.
      const settled = displaySliceBoundsRef.current;
      if (settled.endIndex >= settled.startIndex) {
        displaySliceBoundsOverrideRef.current = {
          startIndex: settled.startIndex,
          endIndex: settled.endIndex,
        };
      } else {
        displaySliceBoundsOverrideRef.current = null;
      }
      programmaticScrollRef.current = false;
      loadOlderStartScrollYRef.current = null;
      scrollTopBeforeUpdateRef.current = null;
      isReplacingHistoryRef.current = false;
      setPrependAnchorRestorePendingSynced(false);
      releaseOlderLoadViewportLock();
      bumpViewportSliceTick();
      logMessagesScrollAction(
        restored || domCompensatedY != null
          ? "prepend_keep_release"
          : "prepend_keep_miss",
        {
          messageId: capturedItemAnchor?.messageId ?? 0,
          pinMessageId: pinId,
          attempts,
          loadOlderAfterExpand: capturedLoadOlderBeforeId != null,
          domCompensatedY,
          skipDomCompensate,
          prependKind: olderPrependKindRef.current,
        },
      );
      const releaseMetrics = scrollControllerRef.current?.getMetrics();
      if (releaseMetrics) {
        // Prefer the restore pin over live metrics: getMetrics used to lag DOM
        // (React state), which re-cemented a wrong scrollY (e.g. 21210 over 5115)
        // and caused a visible jump on prepend_keep_release.
        const domY =
          scrollControllerRef.current?.captureScrollAnchor()?.scrollTop ??
          releaseMetrics.scrollY;
        const liveY = domY;
        const restorePin =
          restored &&
          pinnedBeforeRelease > MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
            ? pinnedBeforeRelease
            : null;
        let nextPinned: number;
        if (restorePin != null) {
          nextPinned = restorePin;
          if (Math.abs(liveY - restorePin) > 2) {
            scrollControllerRef.current?.scrollToY(restorePin);
          }
        } else {
          const keepPinned =
            restored ||
            domCompensatedY != null ||
            liveY > MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX ||
            (startYBeforeRelease != null &&
              startYBeforeRelease <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX);
          nextPinned = keepPinned
            ? liveY
            : Math.max(liveY, pinnedBeforeRelease, startYBeforeRelease ?? 0);
          if (
            !keepPinned &&
            nextPinned > liveY + 1 &&
            scrollControllerRef.current
          ) {
            scrollControllerRef.current.scrollToY(nextPinned);
          }
        }
        pinnedScrollYRef.current = nextPinned;
        lastScrollYRef.current = nextPinned;
        syncPinnedFromMetrics(chatScrollStateRef.current, {
          ...releaseMetrics,
          scrollY: nextPinned,
        });
      }
      scheduleVirtualScrollWindowUpdate();
      endPrependPhase(chatScrollStateRef.current, scrollControllerRef.current);
      scrollControllerRef.current?.clearNearTopLatch();
      const releasedKind = olderPrependKindRef.current;
      // Only chain after API prepend — display expand is in-buffer only; chaining
      // it stacks height-delta keeps and jumps the viewport (telegram-tt uses
      // sentinel for the next page after expand settles).
      if (releasedKind === "api_load" && hasMoreOlderRef.current) {
        const chainMetrics = scrollControllerRef.current?.getMetrics();
        if (
          chainMetrics != null &&
          chainMetrics.layoutH > 0 &&
          isNearChatTop(
            chainMetrics.scrollY,
            chatEdgePrefetchPx(
              chainMetrics.layoutH,
              MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
              MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
            ),
          )
        ) {
          requestAnimationFrame(() => {
            runOlderEdgeActionRef.current();
          });
        }
      }
    };
    if (!capturedItemAnchor) {
      release(false);
      return;
    }
    isScrollTopJustUpdatedRef.current = true;
    programmaticScrollRef.current = true;
    const run = () => {
      const liveMetrics = scrollControllerRef.current?.getMetrics();
      const startY = loadOlderStartScrollYRef.current;
      const prependKind = olderPrependKindRef.current;
      const remembered = chatScrollStateRef.current.remembered ?? {
        scrollTop: loadOlderStartScrollYRef.current ?? 0,
        domAnchor: olderLoadDomAnchorRef.current,
        itemAnchor: capturedItemAnchor,
      };
      // Hard top edge: compensate prepended height from startY when content grew.
      // If content remounted/shrunk (common for api_load window shift), fall through
      // to item-anchor restore instead of releasing at scrollY=0.
      if (
        startY != null &&
        startY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
      ) {
        const domAnchor = olderLoadDomAnchorRef.current ?? remembered.domAnchor;
        const liveDomH =
          scrollControllerRef.current?.captureScrollAnchor()?.scrollHeight ?? 0;
        const heightDelta =
          domAnchor != null && liveDomH > 0
            ? liveDomH - domAnchor.scrollHeight
            : 0;
        if (heightDelta > 0) {
          scrollControllerRef.current?.scrollToY(startY + heightDelta);
          const nextMetrics = scrollControllerRef.current?.getMetrics();
          if (nextMetrics) {
            pinnedScrollYRef.current = nextMetrics.scrollY;
            lastScrollYRef.current = nextMetrics.scrollY;
          }
          olderLoadDomAnchorRef.current = null;
          release(true, { skipDomCompensate: true });
          return;
        }
        if (heightDelta <= 0 && prependKind !== "api_load" && attempts < 24) {
          attempts += 1;
          requestAnimationFrame(run);
          return;
        }
        // api_load (or stalled expand): continue to item-anchor path below.
      }
      // User scrolled down during a display expand — do not yank them back to
      // the pre-scroll item anchor. Compensate growth from the live offset.
      // Skip for api_load: a remount+height-delta race can inflate scrollY
      // without user intent (logs: 1229 → 0 → 21210); item-anchor must win.
      if (
        prependKind !== "api_load" &&
        startY != null &&
        liveMetrics &&
        liveMetrics.layoutH > 0 &&
        !userScrollingUpRef.current &&
        liveMetrics.scrollY > startY + MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
      ) {
        const domAnchor = olderLoadDomAnchorRef.current;
        const liveDomH =
          scrollControllerRef.current?.captureScrollAnchor()?.scrollHeight ??
          liveMetrics.contentH;
        const heightDelta =
          domAnchor != null
            ? Math.max(0, liveDomH - domAnchor.scrollHeight)
            : 0;
        if (heightDelta > 0) {
          scrollControllerRef.current?.scrollToY(liveMetrics.scrollY + heightDelta);
          const nextMetrics = scrollControllerRef.current?.getMetrics();
          if (nextMetrics) {
            pinnedScrollYRef.current = nextMetrics.scrollY;
            lastScrollYRef.current = nextMetrics.scrollY;
          }
        }
        olderLoadDomAnchorRef.current = null;
        release(true, { skipDomCompensate: true });
        return;
      }
      const domAnchor = olderLoadDomAnchorRef.current ?? remembered.domAnchor;
      const liveDomH =
        scrollControllerRef.current?.captureScrollAnchor()?.scrollHeight ?? 0;
      const heightDelta =
        domAnchor != null && liveDomH > 0
          ? liveDomH - domAnchor.scrollHeight
          : 0;
      // api_load remounts often shrink contentH (display window shift). Prefer
      // item-anchor restore like tdesktop — do not stall waiting for ΔH > 0.
      const preferItemAnchor = prependKind === "api_load";
      if (
        !preferItemAnchor &&
        domAnchor != null &&
        heightDelta <= 0 &&
        attempts < 24
      ) {
        attempts += 1;
        requestAnimationFrame(run);
        return;
      }
      // display_expand: prefer DOM height-delta (telegram-tt scrollTop += ΔH).
      // api_load: prefer item getBoundingClientRect keep (tdesktop scrollTopItem).
      let restored = restoreAfterUpdate(
        scrollControllerRef.current,
        {
          ...remembered,
          domAnchor,
          itemAnchor: capturedItemAnchor,
        },
        { preferDomDelta: !preferItemAnchor },
      );
      if (!restored) {
        restored = restorePrependItemAnchor(capturedItemAnchor);
      }
      if (!restored) {
        restored = restorePrependDomAnchor();
      }
      if (restored && capturedItemAnchor?.viewportTopPx != null) {
        const rowEl =
          typeof document !== "undefined"
            ? document.getElementById(
                `message-row-${capturedItemAnchor.messageId}`,
              )
            : null;
        if (rowEl) {
          const drift = Math.abs(
            rowEl.getBoundingClientRect().top - capturedItemAnchor.viewportTopPx,
          );
          if (drift > 2 && attempts < 24) {
            attempts += 1;
            requestAnimationFrame(run);
            return;
          }
        }
      }
      if (restored) {
        const nextMetrics = scrollControllerRef.current?.getMetrics();
        if (nextMetrics) {
          pinnedScrollYRef.current = nextMetrics.scrollY;
          lastScrollYRef.current = nextMetrics.scrollY;
          syncPinnedFromMetrics(chatScrollStateRef.current, nextMetrics);
        }
      }
      const contentH =
        liveDomH > 0
          ? liveDomH
          : scrollControllerRef.current?.getMetrics()?.contentH ??
            scrollControllerRef.current?.captureScrollAnchor()?.scrollHeight ??
            -1;
      if (restored) {
        // Wait for layout to settle before clearing the display override —
        // a no-op item restore (delta≈0) must not shrink the window on frame 0.
        if (contentH > 0 && Math.abs(contentH - lastContentH) <= 1) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        lastContentH = contentH;
        if (stableFrames >= 2 || ++attempts >= 32) {
          release(true, { skipDomCompensate: true });
          return;
        }
        requestAnimationFrame(run);
        return;
      }
      if (++attempts >= 32) {
        release(false);
        return;
      }
      requestAnimationFrame(run);
    };
    // Synchronous first pass — telegram-tt applies scrollTop in useLayoutEffect
    // before paint; deferring to rAF lets the browser commit a wrong viewport.
    run();
  }, [
    viewportSliceTick,
    restorePrependItemAnchor,
    restorePrependDomAnchor,
    applyPrependDomScrollCompensation,
    logMessagesScrollAction,
    releaseOlderLoadViewportLock,
    setPrependAnchorRestorePendingSynced,
    bumpViewportSliceTick,
    scheduleVirtualScrollWindowUpdate,
  ]);

  // Release the DOM scroll-anchor gate set by non-older paths (outgoing send,
  // live-poll newer merges, loadNewer, preserveScrollY). These are tail-side
  // merges: the browser already preserves scrollTop for below-viewport growth,
  // so we only need to clear the gate. Leaving it set stalls newer/live loads
  // because triggerLoadNewerFromSentinel bails while scrollAnchorRestorePending.
  useLayoutEffect(() => {
    if (!scrollAnchorRestorePending) return;
    assignPendingScrollAnchor(null);
    scrollControllerRef.current?.clearNearTopLatch();
    scrollControllerRef.current?.clearNearBottomLatch();
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0) {
      pinnedScrollYRef.current = metrics.scrollY;
      lastScrollYRef.current = metrics.scrollY;
    }
  }, [
    scrollAnchorRestorePending,
    displayMessagesLayoutSig,
    assignPendingScrollAnchor,
  ]);

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
      if (loadingOlderRef.current || loadingNewerRef.current) return;
      if (olderLoadLockedAnchorIdRef.current > 0) return;
      if (olderPrependInProgressRef.current) return;
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
      historyNetworkKeyRef.current = "";
      return;
    }

    // One network open per chat+generation — do not re-fetch when callback
    // identities change (e.g. selfUserId lands and recreates merge helpers).
    const historyKey = `${chat.telegram_chat_id}:${historyLoad.generation}`;
    if (historyNetworkKeyRef.current === historyKey) return;
    historyNetworkKeyRef.current = historyKey;

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
          const session = resolveChatOpenSession(chat);
          const plan = chatOpenScrollPlanFromSession(resolveChatOpenSession(chat));
          const fetchAnchor = session.displayAnchorMessageId ?? 0;
          let result;
          if (session.fetch.kind === "around_unread") {
            result = await fetchChatHistoryAroundUnreadCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
              { lastReadInboxHint: chat.last_read_inbox_message_id ?? null },
            );
          } else if (
            session.fetch.kind === "around_message" &&
            session.fetch.anchorMessageId != null &&
            session.fetch.anchorMessageId > 0
          ) {
            result = await fetchChatHistoryAroundCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              session.fetch.anchorMessageId,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
            );
          } else if (plan.openAnchor === "bottom") {
            // Fallback only when no anchor id exists (empty / brand-new chat).
            result = await fetchChatHistoryTailCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
            );
          } else {
            result = await fetchChatHistoryHeadCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
            );
          }
          if (cancelled) return;
          if (result.error) {
            throw new Error(result.error);
          }
          if (
            messagesCountRef.current > 0 &&
            (loadingOlderRef.current ||
              loadingNewerRef.current ||
              olderPrependInProgressRef.current ||
              userHasScrolledSinceOpenRef.current)
          ) {
            logPageDisplay("messages_history_cache_revalidate_skipped_during_paging", {
              ...chatLogFields({
                chatId: chat.telegram_chat_id,
                peerUserId: chat.peer_user_id,
                title: chat.title,
              }),
              count: result.messages.length,
              userScrolled: userHasScrolledSinceOpenRef.current,
              prependInProgress: olderPrependInProgressRef.current,
            });
            // Still merge rows into cache without shrinking / closing older pagination.
            mergeCachedChatHistoryTail(chat.telegram_chat_id, result);
            return;
          }
          const anchorId =
            "anchorMessageId" in result &&
            typeof result.anchorMessageId === "number" &&
            result.anchorMessageId > 0
              ? result.anchorMessageId
              : result.messages.length > 0
                ? plan.openAnchor === "bottom"
                  ? result.messages[result.messages.length - 1]!.telegram_message_id
                  : result.messages[0]!.telegram_message_id
                : 0;
          let scrollAnchorId = anchorId;
          if (plan.scrollToUnreadDivider) {
            const lastReadId = resolveLastReadMessageId(
              result.messages,
              result.lastReadInboxMessageId ?? chat.last_read_inbox_message_id,
            );
            const firstUnreadId = resolveFirstUnreadMessageId(
              result.messages,
              result.lastReadInboxMessageId ?? chat.last_read_inbox_message_id,
            );
            // Center the display slice on the oldest unread (divider target), not last-read.
            if (firstUnreadId != null) {
              scrollAnchorId = firstUnreadId;
            } else if (lastReadId != null) {
              scrollAnchorId = lastReadId;
            }
            if (
              scrollAnchorId > 0 &&
              result.messages.length > MESSAGE_LIST_VIEWPORT_LIMIT
            ) {
              const trimmed = trimLoadedAroundAnchor(
                result.messages,
                scrollAnchorId,
                MESSAGE_LIST_VIEWPORT_LIMIT,
              );
              result = {
                ...result,
                messages: trimmed,
                hasMoreOlder: true,
                nextBeforeMessageId:
                  trimmed[0]?.telegram_message_id ?? result.nextBeforeMessageId,
              };
            }
          }
          if (scrollAnchorId > 0) {
            scrollAnchorMessageIdRef.current = scrollAnchorId;
          } else if (fetchAnchor > 0) {
            scrollAnchorMessageIdRef.current = fetchAnchor;
          }
          setCachedChatHistory(chat.telegram_chat_id, result, {
            previewOnly: false,
            aroundUnread:
              session.fetch.aroundUnread || plan.scrollToUnreadDivider,
            aroundMessageId:
              session.fetch.anchorMessageId ??
              (fetchAnchor > 0 ? fetchAnchor : null),
          });
          setMessages((prev) => {
            if (
              userHasScrolledSinceOpenRef.current &&
              prev.length > result.messages.length &&
              !pendingInitialScrollRef.current
            ) {
              return prev;
            }
            return mergeHistoryWithWindow(prev, result.messages, true, {
              skipTrim: !result.hasMoreOlder,
            });
          });
          setChatKind(result.chatKind);
          if (result.selfUserId != null) {
            setSelfUserId(result.selfUserId);
          }
          applyHistoryMetaToSelectedChat(
            chat.telegram_chat_id,
            result.chatKind,
            result.memberCount,
          );
          const resultHeadId =
            result.messages.length > 0 ? result.messages[0]!.telegram_message_id : 0;
          mergeOlderPaginationCursor(
            result.hasMoreOlder,
            result.nextBeforeMessageId,
            resultHeadId,
          );
          setLastReadOutboxFromHistory((prev) =>
            mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
          );
          if (result.lastReadInboxMessageId != null) {
            applyLastReadInboxMessageId(result.lastReadInboxMessageId);
          } else if (chat.last_read_inbox_message_id != null) {
            applyLastReadInboxMessageId(chat.last_read_inbox_message_id);
          }
          appliedHistoryFromPreviewCacheRef.current = false;
          if (plan.scrollToUnreadDivider) {
            historyLoadedAroundUnreadRef.current = true;
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
        const openPlan = chatOpenScrollPlanFromSession(resolveChatOpenSession(chat));
        const cacheServesUnreadOpen =
          !openPlan.scrollToUnreadDivider ||
          (cached != null &&
            cached.aroundUnread === true &&
            cached.previewOnly !== true);
        if (
          cacheComplete &&
          cacheCoversChatTail &&
          cacheServesUnreadOpen &&
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
    applyLastReadInboxMessageId,
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
        const sinceMessageId = lastTailMessageIdRef.current;
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

  /** Merge older rows from the local history cache when the API page is empty. */
  const hydrateOlderHistoryFromCache = useCallback((): {
    hydrated: boolean;
    addedCount: number;
    mergedLength: number;
  } => {
    const cached = getCachedChatHistory(chat.telegram_chat_id);
    if (!cached || cached.previewOnly) {
      return { hydrated: false, addedCount: 0, mergedLength: 0 };
    }
    const loadedHead = loadedMessagesRef.current[0]?.telegram_message_id ?? 0;
    const cacheHead = cached.messages[0]?.telegram_message_id ?? 0;
    if (cacheHead <= 0 || loadedHead <= 0 || cacheHead >= loadedHead) {
      return { hydrated: false, addedCount: 0, mergedLength: 0 };
    }
    let addedCount = 0;
    let mergedLength = 0;
    setMessages((prev) => {
      const next = mergeHistoryWithWindow(prev, cached.messages, false, {
        skipTrim: !cached.hasMoreOlder,
      });
      const prevHead = prev.length > 0 ? prev[0]!.telegram_message_id : 0;
      const nextHead = next.length > 0 ? next[0]!.telegram_message_id : 0;
      mergedLength = next.length;
      addedCount =
        prevHead > 0 && nextHead > 0 && nextHead < prevHead
          ? Math.max(1, next.length - prev.length)
          : Math.max(0, next.length - prev.length);
      return next;
    });
    mergeOlderPaginationCursor(
      cached.hasMoreOlder,
      cached.nextBeforeMessageId,
      cacheHead,
    );
    logPageDisplay("messages_history_hydrate_older_from_cache", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      loadedHead,
      cacheHead,
      addedCount,
      mergedLength,
      cacheCount: cached.messages.length,
    });
    return { hydrated: true, addedCount, mergedLength };
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    mergeHistoryWithWindow,
    mergeOlderPaginationCursor,
  ]);

  const loadOlderMessages = useCallback(async (options?: { expandArmed?: boolean; beforeMessageId?: number }) => {
    const expandArmed = options?.expandArmed === true;
    // TDLib from_message_id must be the minimum id in the buffer — not messages[0],
    // which is sorted by sent_at and can sit above older ids that share a second.
    // Never use a stale nextBefore *older* than the buffer head: that skips the
    // contiguous gap and returns overlapping/empty pages (stalls the 2nd edge).
    const loadedOldestId = oldestHistoryMessageId(loadedMessagesRef.current);
    let beforeMessageId = options?.beforeMessageId ?? null;
    if (beforeMessageId == null || beforeMessageId <= 0) {
      beforeMessageId =
        loadedOldestId != null && loadedOldestId > 0
          ? loadedOldestId
          : nextBeforeMessageIdRef.current;
    } else if (
      loadedOldestId != null &&
      loadedOldestId > 0 &&
      beforeMessageId > loadedOldestId
    ) {
      beforeMessageId = loadedOldestId;
    } else if (
      loadedOldestId != null &&
      loadedOldestId > 0 &&
      beforeMessageId < loadedOldestId &&
      options?.beforeMessageId == null
    ) {
      beforeMessageId = loadedOldestId;
    }
    if (loadingInitial || loadingOlderRef.current || beforeMessageId == null) {
      if (expandArmed) {
        logPageDisplay("messages_history_load_older_skipped", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          reason: beforeMessageId == null ? "missing_before_id" : "busy_or_loading",
          expandArmed,
        });
      }
      return;
    }

    const cachedForHydrate = getCachedChatHistory(chat.telegram_chat_id);
    const cacheHeadForHydrate = oldestHistoryMessageId(cachedForHydrate?.messages ?? []) ?? 0;
    const canHydrateFromCache =
      cachedForHydrate != null &&
      !cachedForHydrate.previewOnly &&
      loadedOldestId != null &&
      loadedOldestId > 0 &&
      cacheHeadForHydrate > 0 &&
      cacheHeadForHydrate < loadedOldestId;

    if (!hasMoreOlderRef.current && !canHydrateFromCache) {
      return;
    }
    if (olderLoadInFlightBeforeIdRef.current === beforeMessageId) {
      return;
    }

    if (initialScrollInProgressRef.current) {
      return;
    }

    if (!expandArmed && olderPrependInProgressRef.current) {
      return;
    }

    isReplacingHistoryRef.current = true;
    olderLoadInFlightBeforeIdRef.current = beforeMessageId;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    followingBottomRef.current = false;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const headBeforeLoad =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    beginPrependPhase(
      chatScrollStateRef.current,
      scrollControllerRef.current,
      capturePrependItemAnchor,
      "api_load",
    );
    olderPrependKindRef.current = "api_load";
    olderPrependInProgressRef.current = true;
    programmaticScrollRef.current = true;
    setPrependAnchorRestorePendingSynced(true);
    olderLoadDisplayHeadBeforeRef.current = headBeforeLoad;
    const anchorId =
      topViewportAnchorMessageId(
        displayMessagesRef.current,
        resolveScrollLayoutMap(),
        scrollControllerRef.current?.getMetrics() ?? { scrollY: 0, layoutH: 0, contentH: 0 },
      ) ?? displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    if (anchorId > 0) {
      olderLoadLockedAnchorIdRef.current = anchorId;
    }
    const atLoadedTopForPrepend =
      viewportAtLoadedTopRef.current ||
      displaySliceBoundsRef.current.startIndex === 0;
    if (anchorId > 0 && !atLoadedTopForPrepend) {
      scrollAnchorMessageIdRef.current = anchorId;
    }
    logMessagesScrollAction("prepend_lock", {
      anchorMessageId: anchorId,
      prependKind: "api_load",
      loadingOlder: true,
    });
    rememberDomScrollAtOlderLoadStart();

    const clearOlderLoadCaptureWithoutRestore = (options?: {
      reason?: string;
      tryDisplayExpand?: boolean;
    }) => {
      const prependKind = olderPrependKindRef.current;
      pendingItemAnchorRef.current = null;
      loadOlderStartScrollYRef.current = null;
      scrollTopBeforeUpdateRef.current = null;
      setPrependAnchorRestorePendingSynced(false);
      programmaticScrollRef.current = false;
      isReplacingHistoryRef.current = false;
      releaseOlderLoadViewportLock();
      endPrependPhase(chatScrollStateRef.current, scrollControllerRef.current);
      logMessagesScrollAction("prepend_abort", {
        reason: options?.reason ?? "unknown",
        prependKind,
      });
      if (options?.tryDisplayExpand) {
        requestAnimationFrame(() => {
          if (displaySliceBoundsRef.current.startIndex > 0) {
            expandDisplaySliceTowardOlder();
          }
        });
      }
    };

    /** After buffer growth: shift the display window (same visual rows) and release. */
    const armOlderPrependScrollRestore = (
      prependedCount: number,
      mergedLength: number,
    ) => {
      // Prefer the window already armed inside setMessages (avoids double-apply).
      const override = displaySliceBoundsOverrideRef.current;
      const alreadyArmed =
        prependedCount > 0 &&
        override != null &&
        override.startIndex >= prependedCount;
      if (!alreadyArmed) {
        const nextWindow = afterOlderPrepend(
          Math.max(1, mergedLength),
          {
            bounds: displaySliceBoundsRef.current,
            override: displaySliceBoundsOverrideRef.current,
            anchorMessageId: scrollAnchorMessageIdRef.current,
            atLoadedTop: viewportAtLoadedTopRef.current,
            atLoadedBottom: viewportAtLoadedBottomRef.current,
          },
          prependedCount,
        );
        displaySliceBoundsOverrideRef.current = nextWindow.override;
        displaySliceBoundsRef.current = nextWindow.bounds;
      }
      // Keep scrollAnchor on the locked viewport row (not the buffer head) so
      // clearing the override after restore still covers what the user sees.
      const lockedId = olderLoadLockedAnchorIdRef.current;
      if (lockedId > 0) {
        scrollAnchorMessageIdRef.current = lockedId;
      }
      programmaticScrollRef.current = true;
      setPrependAnchorRestorePendingSynced(true);
      bumpViewportSliceTick();
    };

    logPageDisplay("messages_history_load_older_start", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      beforeMessageId,
    });

    try {
      if (canHydrateFromCache && !hasMoreOlderRef.current) {
        const cacheHydrate = hydrateOlderHistoryFromCache();
        if (cacheHydrate.hydrated) {
          rememberItemAnchorBeforeMerge();
          armOlderPrependScrollRestore(
            cacheHydrate.addedCount,
            Math.max(cacheHydrate.mergedLength, loadedMessagesRef.current.length),
          );
          logMessagesScrollAction("prepend_cache_hydrate", {
            addedCount: cacheHydrate.addedCount,
            mergedLength: cacheHydrate.mergedLength,
            beforeApi: true,
          });
          return;
        }
      }

      const MAX_OLDER_PAGE_ATTEMPTS = 6;
      let pageCursor = beforeMessageId;
      let result: Awaited<ReturnType<typeof fetchOlderHistoryCharBudget>> | null = null;
      let addedCount = 0;
      let nextHeadAfter = headBeforeLoad;
      let mergedLength = 0;
      let loadedOldestBefore =
        oldestHistoryMessageId(loadedMessagesRef.current) ?? headBeforeLoad;

      for (let attempt = 0; attempt < MAX_OLDER_PAGE_ATTEMPTS; attempt += 1) {
        olderLoadInFlightBeforeIdRef.current = pageCursor;
        result = await fetchOlderHistoryCharBudget(
          chat.telegram_chat_id,
          chat.peer_user_id,
          pageCursor,
          MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
        );
        if (result.error) {
          logPageDisplay("messages_history_load_older_error", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            beforeMessageId: pageCursor,
            message: result.error,
          });
          clearOlderLoadCaptureWithoutRestore({ reason: "fetch_error" });
          return;
        }

        if (result.messages.length === 0) {
          const cacheHydrate = hydrateOlderHistoryFromCache();
          if (cacheHydrate.hydrated) {
            rememberItemAnchorBeforeMerge();
            armOlderPrependScrollRestore(
              cacheHydrate.addedCount,
              Math.max(cacheHydrate.mergedLength, loadedMessagesRef.current.length),
            );
            logMessagesScrollAction("prepend_cache_hydrate", {
              addedCount: cacheHydrate.addedCount,
              mergedLength: cacheHydrate.mergedLength,
            });
            return;
          }
          applyOlderPaginationCursor(result.hasMoreOlder, result.nextBeforeMessageId);
          logPageDisplay("messages_history_load_older_empty", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            beforeMessageId: pageCursor,
            hasMoreOlder: result.hasMoreOlder,
            nextBeforeMessageId: result.nextBeforeMessageId,
          });
          clearOlderLoadCaptureWithoutRestore({
            reason: "empty_page",
            tryDisplayExpand: true,
          });
          return;
        }

        const incomingOlder = filterMessagesOlderThan(result.messages, pageCursor);
        addedCount = 0;
        nextHeadAfter = loadedOldestBefore;
        mergedLength = 0;
        rememberItemAnchorBeforeMerge();
        setMessages((prev) => {
          const oldestPrev = oldestHistoryMessageId(prev) ?? 0;
          const strictlyOlder =
            oldestPrev > 0
              ? filterMessagesOlderThan(incomingOlder, oldestPrev)
              : incomingOlder;
          const next = mergeHistoryWithWindow(prev, strictlyOlder, false);
          const prevOldest = oldestPrev;
          nextHeadAfter = oldestHistoryMessageId(next) ?? 0;
          mergedLength = next.length;
          addedCount =
            prevOldest > 0 && nextHeadAfter > 0 && nextHeadAfter < prevOldest
              ? Math.max(1, next.length - prev.length)
              : next.length - prev.length;
          // Shift the display window inside the updater so the first paint after
          // merge keeps the same visual rows (no scrollTop compensation).
          if (addedCount > 0) {
            const nextWindow = afterOlderPrepend(
              Math.max(1, mergedLength),
              {
                bounds: displaySliceBoundsRef.current,
                override: displaySliceBoundsOverrideRef.current,
                anchorMessageId: scrollAnchorMessageIdRef.current,
                atLoadedTop: viewportAtLoadedTopRef.current,
                atLoadedBottom: viewportAtLoadedBottomRef.current,
              },
              addedCount,
            );
            displaySliceBoundsOverrideRef.current = nextWindow.override;
            displaySliceBoundsRef.current = nextWindow.bounds;
            const lockedId = olderLoadLockedAnchorIdRef.current;
            if (lockedId > 0) {
              scrollAnchorMessageIdRef.current = lockedId;
            }
          }
          return next;
        });

        if (addedCount > 0) {
          beforeMessageId = pageCursor;
          break;
        }

        const nextCursor =
          result.nextBeforeMessageId ??
          oldestHistoryMessageId(result.messages);
        const canAdvance =
          nextCursor != null &&
          Number.isFinite(nextCursor) &&
          nextCursor > 0 &&
          nextCursor < pageCursor;
        if (!canAdvance) {
          applyOlderPaginationCursor(false, null);
          logPageDisplay("messages_history_load_older_duplicate_page", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            beforeMessageId: pageCursor,
            fetchedCount: result.messages.length,
            attempt,
          });
          clearOlderLoadCaptureWithoutRestore({
            reason: "duplicate_page",
            tryDisplayExpand: true,
          });
          return;
        }

        const keepGoing =
          result.hasMoreOlder ||
          nextCursor <
            (oldestHistoryMessageId(loadedMessagesRef.current) ?? pageCursor);
        applyOlderPaginationCursor(keepGoing, nextCursor);
        mergeCachedChatHistoryTail(chat.telegram_chat_id, result);
        logPageDisplay("messages_history_load_older_advance_cursor", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          beforeMessageId: pageCursor,
          nextBeforeMessageId: nextCursor,
          fetchedCount: result.messages.length,
          grewViaCache: false,
          grewViaMerge: false,
          keepGoing,
          attempt,
          retrying: keepGoing && attempt < MAX_OLDER_PAGE_ATTEMPTS - 1,
        });
        if (!keepGoing) {
          clearOlderLoadCaptureWithoutRestore({
            reason: "cursor_exhausted",
            tryDisplayExpand: true,
          });
          return;
        }
        // Duplicate / overlapping page — keep going with the advanced cursor in
        // the same user gesture instead of waiting for another scroll-up.
        pageCursor = nextCursor;
      }

      if (!result || addedCount === 0) {
        clearOlderLoadCaptureWithoutRestore({
          reason: "no_rows_added",
          tryDisplayExpand: true,
        });
        return;
      }

      if (result.selfUserId != null) {
        setSelfUserId(result.selfUserId);
      }
      armOlderPrependScrollRestore(addedCount, mergedLength);
      logMessagesScrollAction("prepend_merge_applied", {
        addedCount,
        nextHeadAfter,
        headBeforeLoad,
        loadedOldestBefore,
      });
      const loadedHeadAfter =
        nextHeadAfter > 0 ? nextHeadAfter : result.nextBeforeMessageId;
      const hasMore =
        result.hasMoreOlder ||
        (loadedHeadAfter != null &&
          result.nextBeforeMessageId != null &&
          result.nextBeforeMessageId <= loadedHeadAfter);
      applyOlderPaginationCursor(
        hasMore,
        result.nextBeforeMessageId ??
          (loadedHeadAfter != null && loadedHeadAfter > 0 ? loadedHeadAfter : null),
      );
      mergeCachedChatHistoryTail(chat.telegram_chat_id, result);
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
      );
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
      // Keep loadOlderStartScrollYRef until prepend restore release() — clearing
      // here races the layout-effect height-delta fallback and breaks keep.
      lastOlderLoadFinishedAtRef.current = Date.now();
      olderLoadInFlightBeforeIdRef.current = null;
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    applyOlderPaginationCursor,
    historyMessageContext,
    logMessagesScrollAction,
    capturePrependItemAnchor,
    mergeHistoryWithWindow,
    loadingInitial,
    releaseOlderLoadViewportLock,
    bumpViewportSliceTick,
    setPrependAnchorRestorePendingSynced,
    rememberDomScrollAtOlderLoadStart,
    rememberItemAnchorBeforeMerge,
    rememberScrollBeforeListUpdate,
    resolveScrollLayoutMap,
    hydrateOlderHistoryFromCache,
    expandDisplaySliceTowardOlder,
  ]);

  const loadNewerMessages = useCallback(async () => {
    const sinceMessageId = lastTailMessageIdRef.current;
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

    logPageDisplay("messages_history_load_newer_start", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      sinceMessageId,
    });

    try {
      let result = await fetchNewerHistoryCharBudget(
        chat.telegram_chat_id,
        chat.peer_user_id,
        sinceMessageId,
        MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
      );

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

      if (!followingBottomRef.current) {
        rememberScrollBeforeListUpdate();
      }

      let addedCount = 0;
      isReplacingHistoryRef.current = true;
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
        const metrics = scrollControllerRef.current?.getMetrics();
        if (
          metrics &&
          metrics.contentH > 0 &&
          metrics.layoutH > 0 &&
          isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
        ) {
          scrollControllerRef.current?.scrollToEnd();
        }
      } else {
        const itemAnchor = pendingItemAnchorRef.current;
        const scrollAnchorBeforeMerge = olderLoadDomAnchorRef.current;
        if (itemAnchor) {
          requestAnimationFrame(() => {
            scrollControllerRef.current?.restoreItemAnchor(itemAnchor);
          });
        }
        if (scrollAnchorBeforeMerge) {
          assignPendingScrollAnchor(scrollAnchorBeforeMerge);
        }
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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isReplacingHistoryRef.current = false;
        });
      });

      if (openingUnreadCountRef.current > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            refreshScrollUnreadFabRef.current();
          });
        });
      }
      requestAnimationFrame(() => {
        bumpViewportSliceTick();
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
    bumpViewportSliceTick,
    rememberScrollBeforeListUpdate,
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
    !initialScrollInProgress;

  /** Expand display toward older rows, or API-load when already at loaded head. */
  const runOlderEdgeAction = useCallback(() => {
    if (pendingItemAnchorRef.current) return;
    if (!chatScrollPaintReadyRef.current || loadingInitial) return;
    if (
      isReplacingHistory(chatScrollStateRef.current.phase) &&
      !canEdgeLoadInPhase(chatScrollStateRef.current.phase)
    ) {
      return;
    }

    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    if (display.length === 0) return;

    const displayHeadId = display[0]!.telegram_message_id;
    const loadedOldestId = oldestHistoryMessageId(loaded) ?? 0;
    const metrics = scrollControllerRef.current?.getMetrics();
    const scrollNearTop =
      metrics != null &&
      metrics.layoutH > 0 &&
      isNearChatTop(
        metrics.scrollY,
        chatEdgePrefetchPx(
          metrics.layoutH,
          MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
          MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
        ),
      );

    const canExpandInBuffer =
      displaySliceBoundsRef.current.startIndex > 0 ||
      (displayHeadId > 0 &&
        loadedOldestId > 0 &&
        displayHeadId > loadedOldestId);

    // telegram-tt: widen the in-buffer window before any API page fetch — only
    // while the user is at the older edge (never mid-list after a prior keep).
    if (
      canExpandInBuffer &&
      (scrollNearTop ||
        viewportAtLoadedTopRef.current ||
        userScrollingUpRef.current)
    ) {
      if (expandDisplaySliceTowardOlder()) return;
      // Already at the display head of the loaded buffer — fall through to API.
    }
    if (
      !scrollNearTop &&
      !viewportAtLoadedTopRef.current &&
      displaySliceBoundsRef.current.startIndex > 0
    ) {
      return;
    }

    if (!hasMoreOlderRef.current) {
      const cached = getCachedChatHistory(chat.telegram_chat_id);
      const cacheHead = oldestHistoryMessageId(cached?.messages ?? []) ?? 0;
      if (
        cached &&
        !cached.previewOnly &&
        cacheHead > 0 &&
        loadedOldestId > 0 &&
        cacheHead < loadedOldestId
      ) {
        void loadOlderMessages();
      }
      return;
    }

    void loadOlderMessages();
  }, [
    expandDisplaySliceTowardOlder,
    loadOlderMessages,
    loadingInitial,
    chat.telegram_chat_id,
  ]);

  /** Expand display toward newer rows, or API-load when display already at loaded tail. */
  const runNewerEdgeAction = useCallback(() => {
    if (pendingItemAnchorRef.current) return;
    if (!chatScrollPaintReadyRef.current || loadingInitial) return;

    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    if (display.length === 0) return;

    const displayTailId = display[display.length - 1]!.telegram_message_id;
    const loadedTailId =
      loaded.length > 0 ? loaded[loaded.length - 1]!.telegram_message_id : 0;
    if (displayTailId > 0 && loadedTailId > 0 && displayTailId < loadedTailId) {
      expandDisplaySliceTowardNewer();
      return;
    }
    if (
      isAtLoadedChatTail(
        displayTailId,
        chatTailMessageIdRef.current ?? chat.last_message_telegram_id,
      )
    ) {
      return;
    }
    void loadNewerMessages();
  }, [
    chat.last_message_telegram_id,
    expandDisplaySliceTowardNewer,
    loadNewerMessages,
    loadingInitial,
  ]);

  const { tryLoadOlder: tryTriggerOlderHistoryLoad, tryLoadNewer: tryTriggerNewerHistoryLoad } =
    useChatScrollHooks({
      historyIoEnabled: historyLoadIoEnabled,
      getPhase: () => chatScrollStateRef.current.phase,
      getMetrics: () => scrollControllerRef.current?.getMetrics(),
      getGate: () => {
        const loaded = loadedMessagesRef.current;
        const display = displayMessagesRef.current;
        const bounds = displaySliceBoundsRef.current;
        const loadedOldest = oldestHistoryMessageId(loaded) ?? 0;
        const canExpandOlder =
          bounds.startIndex > 0 ||
          (display.length > 0 &&
            loadedOldest > 0 &&
            display[0]!.telegram_message_id > loadedOldest);
        const cached = getCachedChatHistory(chat.telegram_chat_id);
        const cacheHead = oldestHistoryMessageId(cached?.messages ?? []) ?? 0;
        const canHydrateOlder =
          cached != null &&
          !cached.previewOnly &&
          cacheHead > 0 &&
          loadedOldest > 0 &&
          cacheHead < loadedOldest;
        return {
          phase: chatScrollStateRef.current.phase,
          userHasScrolledSinceOpen: userHasScrolledSinceOpenRef.current,
          initialScrollInProgress: initialScrollInProgressRef.current,
          prependAnchorRestorePending:
            prependAnchorRestorePendingRef.current ||
            prependAnchorRestorePending ||
            scrollAnchorRestorePending,
          loadingOlder: loadingOlderRef.current,
          loadingNewer: loadingNewerRef.current,
          userScrollingUp: userScrollingUpRef.current,
          hasMoreOlder: hasMoreOlderRef.current,
          hasMoreNewer: true,
          canExpandOlderInBuffer: canExpandOlder,
          canHydrateOlderFromCache: canHydrateOlder,
          olderCooldownUntilMs:
            lastOlderLoadFinishedAtRef.current + LOAD_OLDER_PAGE_COOLDOWN_MS,
          newerRetryAfterMs: loadNewerRetryAfterRef.current,
        };
      },
      actions: {
        onLoadOlder: runOlderEdgeAction,
        onLoadNewer: runNewerEdgeAction,
      },
    });

  const triggerLoadNewerFromSentinel = useCallback(() => {
    tryTriggerNewerHistoryLoad();
  }, [tryTriggerNewerHistoryLoad]);

  useEffect(() => {
    tryTriggerOlderHistoryLoadRef.current = tryTriggerOlderHistoryLoad;
  }, [tryTriggerOlderHistoryLoad]);

  useEffect(() => {
    runOlderEdgeActionRef.current = runOlderEdgeAction;
  }, [runOlderEdgeAction]);

  useEffect(() => {
    tryTriggerNewerHistoryLoadRef.current = tryTriggerNewerHistoryLoad;
  }, [tryTriggerNewerHistoryLoad]);

  /**
   * After mid-history open settles, widen the display window toward already-loaded
   * newer rows only. Older expansion is scroll/sentinel-driven so open settle does
   * not prepend tall rows above the unread viewport (DOM height lag → jump).
   */
  const scheduleMidHistoryEdgePrefetch = useCallback(() => {
    if (midHistoryEdgePrefetchArmedRef.current) return;
    if (!chatScrollPaintReadyRef.current || initialScrollInProgressRef.current) return;
    if (loadingInitial || loadingOlderRef.current || loadingNewerRef.current) return;
    const loaded = loadedMessagesRef.current;
    if (loaded.length === 0) return;
    const loadedTailId = loaded[loaded.length - 1]!.telegram_message_id;
    const atChatTail = isAtLoadedChatTail(
      loadedTailId,
      chatTailMessageIdRef.current ?? chat.last_message_telegram_id,
    );
    const midHistory =
      historyLoadedAroundUnreadRef.current ||
      (hasMoreOlderRef.current && !atChatTail);
    if (!midHistory) return;
    midHistoryEdgePrefetchArmedRef.current = true;
    const bounds = displaySliceBoundsRef.current;
    logPageDisplay("messages_mid_history_edge_prefetch", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      hasMoreOlder: hasMoreOlderRef.current,
      atChatTail,
      loadedCount: loaded.length,
      aroundUnread: historyLoadedAroundUnreadRef.current,
      displayStart: bounds.startIndex,
      displayEnd: bounds.endIndex,
      mode: "widen_display_newer_only",
    });
    requestAnimationFrame(() => {
      if (
        loadingOlderRef.current ||
        olderPrependInProgressRef.current ||
        prependAnchorRestorePendingRef.current
      ) {
        return;
      }
      // Only widen toward newer on open settle. Auto older expand prepends tall
      // rows above a mid-history viewport; DOM scrollHeight lags estimated
      // contentH so height-delta keep clamps and the unread anchor jumps.
      // Older rows stay user/sentinel-driven via expandDisplaySliceTowardOlder.
      const loadedNow = loadedMessagesRef.current;
      const displayNow = displayMessagesRef.current;
      if (loadedNow.length === 0 || displayNow.length === 0) return;
      const displayTail =
        displayNow[displayNow.length - 1]!.telegram_message_id;
      const loadedTail =
        loadedNow[loadedNow.length - 1]!.telegram_message_id;
      if (displayTail > 0 && loadedTail > 0 && displayTail < loadedTail) {
        expandDisplaySliceTowardNewer();
      }
    });
  }, [
    chat.last_message_telegram_id,
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    expandDisplaySliceTowardNewer,
    loadingInitial,
  ]);

  useEffect(() => {
    scheduleMidHistoryEdgePrefetchRef.current = scheduleMidHistoryEdgePrefetch;
  }, [scheduleMidHistoryEdgePrefetch]);

  const unlockHistoryEdgesOnUserScroll = useCallback(() => {
    const wasBlocked =
      initialScrollInProgressRef.current || !chatScrollPaintReadyRef.current;
    if (initialScrollInProgressRef.current) {
      initialScrollInProgressRef.current = false;
      setInitialScrollInProgress(false);
    }
    if (!chatScrollPaintReadyRef.current) {
      openScrollAppliedRef.current = true;
      revealChatScroll();
      logPageDisplay("messages_open_scroll_force_reveal", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        reason: "user_scroll_unlock_edges",
        scrollY: pinnedScrollYRef.current,
        openingUnread: openingUnreadCountRef.current,
      });
    }
    enableEdgeLoadingAfterOpen();
    if (wasBlocked) {
      scheduleMidHistoryEdgePrefetch();
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    enableEdgeLoadingAfterOpen,
    revealChatScroll,
    scheduleMidHistoryEdgePrefetch,
  ]);

  useEffect(() => {
    unlockHistoryEdgesOnUserScrollRef.current = unlockHistoryEdgesOnUserScroll;
  }, [unlockHistoryEdgesOnUserScroll]);

  useEffect(() => {
    if (!chatScrollPaintReady || initialScrollInProgress || loadingInitial) return;
    scheduleMidHistoryEdgePrefetch();
  }, [
    chatScrollPaintReady,
    initialScrollInProgress,
    loadingInitial,
    scheduleMidHistoryEdgePrefetch,
  ]);

  const canExpandOlderInBuffer = useMemo(() => {
    if (loadedMessages.length === 0 || displayMessages.length === 0) return false;
    const bounds = displaySliceBoundsRef.current;
    return (
      bounds.startIndex > 0 ||
      displayMessages[0]!.telegram_message_id > loadedMessages[0]!.telegram_message_id
    );
  }, [loadedMessages, displayMessages, viewportSliceTick]);

  const canHydrateOlderFromCache = useMemo(() => {
    const cached = getCachedChatHistory(chat.telegram_chat_id);
    if (!cached || cached.previewOnly || loadedMessages.length === 0) return false;
    const cacheHead = cached.messages[0]?.telegram_message_id ?? 0;
    const loadedHead = loadedMessages[0]!.telegram_message_id;
    return cacheHead > 0 && loadedHead > 0 && cacheHead < loadedHead;
  }, [chat.telegram_chat_id, loadedMessages, viewportSliceTick]);

  const showTopHistoryLoadSentinel =
    hasMoreOlder || canExpandOlderInBuffer || canHydrateOlderFromCache;

  const triggerLoadOlderFromSentinel = useCallback(() => {
    tryTriggerOlderHistoryLoad();
  }, [tryTriggerOlderHistoryLoad]);

  const effectiveChatTailMessageId = chat.last_message_telegram_id ?? null;
  const hasMoreNewerBelow = !isAtLoadedChatTail(
    lastDisplayMessageId,
    effectiveChatTailMessageId,
  );

  const canExpandNewerInBuffer = useMemo(() => {
    if (loadedMessages.length === 0 || displayMessages.length === 0) return false;
    return (
      displayMessages[displayMessages.length - 1]!.telegram_message_id <
      loadedMessages[loadedMessages.length - 1]!.telegram_message_id
    );
  }, [loadedMessages, displayMessages]);

  const showBottomHistoryLoadSentinel =
    hasMoreNewerBelow || canExpandNewerInBuffer;

  const fabUnreadCount = useMemo(() => {
    const serverUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
    const openingUnread = Math.max(0, openingUnreadCountRef.current);
    // telegram-tt ScrollDownButton: badge is the chat unread count, not local viewport leftovers.
    const remaining = Math.max(serverUnread, openingUnread);

    if (
      initialScrollInProgressRef.current ||
      !chatScrollPaintReadyRef.current
    ) {
      return remaining > 0 ? remaining : Math.max(0, openScrollPlan.openingUnreadCount);
    }

    const chatTail = chat.last_message_telegram_id ?? null;
    const loadedTail =
      loadedMessages.length > 0
        ? loadedMessages[loadedMessages.length - 1]!.telegram_message_id
        : 0;
    const atChatTail = isAtLoadedChatTail(loadedTail, chatTail);

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) {
      return remaining;
    }

    const nearBottom = isChatScrollNearBottom(
      metrics.scrollY,
      metrics.layoutH,
      metrics.contentH,
    );

    if (followingBottomRef.current && atChatTail && nearBottom) {
      return 0;
    }

    if (remaining > 0) return remaining;

    const layoutMap = resolveScrollLayoutMap(metrics);
    const readCursor = lastReadInboxMessageIdRef.current;
    return nearBottom
      ? countUnreadMessagesBelowViewport(
          displayMessages,
          layoutMap,
          metrics,
          readCursor,
        )
      : countUnreadMessagesNewerThanViewport(
          loadedMessages,
          layoutMap,
          metrics,
          readCursor,
        );
  }, [
    chat.last_message_telegram_id,
    chat.unread_count,
    fabUnreadDisplayTick,
    displayMessages,
    loadedMessages,
    openScrollPlan.openingUnreadCount,
    resolveScrollLayoutMap,
    userScrollInteractionTick,
    virtualScrollTick,
  ]);
  const scrollToBottomUnreadLabel = formatScrollToBottomUnreadCountLabel(
    fabUnreadCount,
    chat.telegram_chat_id,
  );
  const bottomHistoryLoadLineActive = loadingNewer;
  const topHistoryLoadLineActive = loadingOlder || prependAnchorRestorePending;
  const showScrollToBottomButton = useMemo(() => {
    // Keep the unread badge visible while the open settle runs (telegram-tt).
    if (initialScrollInProgress) {
      return (
        fabUnreadCount > 0 ||
        openScrollPlan.openingUnreadCount > 0 ||
        openingUnreadCountRef.current > 0
      );
    }
    if (hasMoreNewerBelow) return true;
    const manyUnreads =
      fabUnreadCount > MESSAGE_CHAT_FAB_ALWAYS_SHOW_UNREAD_THRESHOLD;
    if (manyUnreads && !(isFollowingBottom && !hasMoreNewerBelow)) {
      return true;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) {
      return fabUnreadCount > 0;
    }
    const scrollBottom = metrics.contentH - metrics.scrollY - metrics.layoutH;
    const isAtBottom = scrollBottom <= FAB_NOTCH_THRESHOLD_PX;
    const isNearBottom = scrollBottom <= FAB_VISIBILITY_THRESHOLD_PX;
    const isUnread =
      fabUnreadCount > 0 || frozenUnreadDividerBeforeId != null;
    if (isUnread) return !isAtBottom;
    return !isNearBottom;
  }, [
    fabUnreadCount,
    frozenUnreadDividerBeforeId,
    hasMoreNewerBelow,
    initialScrollInProgress,
    isFollowingBottom,
    openScrollPlan.openingUnreadCount,
    userScrollInteractionTick,
    virtualScrollTick,
  ]);

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
    // During older prepend/restore the virtual window must include the anchor row.
    // Slicing with stale scrollY (often ≈0 at the top edge) drops the anchor from
    // the DOM and scroll-keep misses — the viewport jumps to newly prepended rows.
    if (
      prependAnchorRestorePending ||
      olderPrependInProgressRef.current ||
      pendingItemAnchorRef.current != null
    ) {
      return disabledWindow;
    }
    if (displayMessages.length < MESSAGE_LIST_VIRTUALIZE_MIN_ROWS) {
      return disabledWindow;
    }
    // telegram-tt: while scrolled up in history, render the full mounted display
    // slice — windowing with 120px fallbacks leaves blank gaps between rows.
    if (!isFollowingBottom && !initialScrollInProgress) {
      return disabledWindow;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    const layoutH =
      pinnedLayoutHRef.current > 0
        ? pinnedLayoutHRef.current
        : metrics && metrics.layoutH > 0
          ? metrics.layoutH
          : 1;
    const scrollY = metrics?.scrollY ?? pinnedScrollYRef.current;
    const liveContentH = metrics?.contentH ?? 0;
    // At the loaded head, render the full display slice — virtual spacers fight
    // the flex column and leave blank gaps above the oldest rows (telegram-tt).
    if (
      viewportAtLoadedTopRef.current &&
      scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX + MESSAGE_LIST_VIRTUAL_OVERSCAN_PX
    ) {
      return disabledWindow;
    }
    const window = resolveMessageListVirtualWindow(
      displayMessages,
      messageRowHeightCacheRef.current,
      { scrollY, layoutH, contentH: liveContentH },
      MESSAGE_BUBBLE_ROW_GAP_PX,
      messageLayoutsRef.current,
    );
    if (!window.enabled || displayMessages.length === 0) {
      return window;
    }
    let totalHeight = 0;
    let measuredRows = 0;
    for (let index = 0; index < displayMessages.length; index += 1) {
      const messageId = displayMessages[index]!.telegram_message_id;
      const cached = messageRowHeightCacheRef.current.get(messageId);
      const contentHeight =
        cached != null && cached > 0 ? cached : MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
      totalHeight += contentHeight + (index > 0 ? MESSAGE_BUBBLE_ROW_GAP_PX : 0);
      if (cached != null && cached > 0) measuredRows += 1;
    }
    const measuredRatio =
      displayMessages.length > 0 ? measuredRows / displayMessages.length : 1;
    if (
      liveContentH > 0 &&
      totalHeight > 0 &&
      liveContentH > totalHeight * 1.1 &&
      measuredRatio < 0.6
    ) {
      return disabledWindow;
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
  }, [
    chat.last_message_telegram_id,
    chatScrollPaintReady,
    displayMessages,
    displayMessagesLayoutSig,
    initialScrollInProgress,
    isFollowingBottom,
    prependAnchorRestorePending,
    virtualScrollTick,
    viewportSliceTick,
  ]);

  const renderedMessages = listVirtualWindow.enabled
    ? displayMessages.slice(listVirtualWindow.startIndex, listVirtualWindow.endIndex + 1)
    : displayMessages;
  const renderedMessageStartIndex = listVirtualWindow.enabled ? listVirtualWindow.startIndex : 0;

  const olderEdgePrefetchPx = chatEdgePrefetchPx(
    scrollViewportH,
    MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
    MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
  );
  const newerEdgePrefetchPx = chatEdgePrefetchPx(
    scrollViewportH,
    MESSAGE_CHAT_EDGE_PREFETCH_SCREENS,
    MESSAGE_LIST_SENSITIVE_AREA_PX,
  );

  // Thumb size vs loaded buffer (+ N padding when more history exists), not only
  // the mounted display slice — keeps mid-history thumbs from collapsing.
  const chatScrollIndicatorContentSpanPx = useMemo(() => {
    const loadedCount = loadedMessages.length;
    if (loadedCount <= 0) return null;
    const displayCount = Math.max(1, displayMessages.length);
    const avgRowPx = MESSAGE_LIST_VIRTUAL_ESTIMATED_ROW_PX;
    let estimated = loadedCount * avgRowPx;
    if (hasMoreOlder) estimated += MESSAGE_LIST_SLICE * avgRowPx;
    if (hasMoreNewerBelow) estimated += MESSAGE_LIST_SLICE * avgRowPx;
    const displayFloor = displayCount * avgRowPx;
    return Math.max(estimated, displayFloor);
  }, [
    loadedMessages.length,
    displayMessages.length,
    hasMoreOlder,
    hasMoreNewerBelow,
  ]);

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

  const pinMessagesToBottom =
    openScrollPlan.pinMessagesToBottom &&
    (isFollowingBottom || initialScrollInProgress);
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
        key={String(chat.telegram_chat_id)}
        style={{ flex: 1, minHeight: 0 }}
        indicatorColor={colors.accent}
        scrollbarRightInsetPx={layout.scrollIndicatorRightInsetPx}
        indicatorThumbMinPx={CHAT_SCROLL_INDICATOR_THUMB_MIN_PX}
        indicatorContentSpanPx={chatScrollIndicatorContentSpanPx}
        initialScrollPosition={openScrollPlan.openAnchor}
        skipInitialTopReset
        onScrollPositionChange={handleScrollPositionChange}
        onUserScrollIntent={markUserScrollInteraction}
        onMetricsChange={handleOpenScrollMetrics}
        scrollControllerRef={scrollControllerRef}
        preserveViewportOnResize={chatScrollPaintReady && !prependAnchorRestorePending && !loadingOlder}
        stickToBottomOnResize={isFollowingBottom}
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

        {displayMessages.length > 0 && showTopHistoryLoadSentinel ? (
          <MessageHistoryLoadSentinel
            edge="top"
            enabled={historyLoadIoEnabled}
            rootMarginPx={olderEdgePrefetchPx}
            onTrigger={triggerLoadOlderFromSentinel}
          />
        ) : null}

        {listVirtualWindow.enabled && listVirtualWindow.topSpacerPx > 0 ? (
          <View style={{ height: listVirtualWindow.topSpacerPx }} />
        ) : null}

        {renderedMessages.map((item, sliceIndex) => {
          const index = renderedMessageStartIndex + sliceIndex;
          const previous = index > 0 ? displayMessages[index - 1] : null;
          const showDateDivider = shouldShowMessageDateDivider(
            item,
            previous,
            loadedMessages,
            allLoadedMessagesAreFromToday,
          );
          const dateDividerLabel = showDateDivider
            ? formatMessageDateDividerLabel(item.sent_at, new Date())
            : "";
          return (
          <View
            key={item.telegram_message_id}
            nativeID={`message-row-${item.telegram_message_id}`}
            onLayout={(event) => handleMessageLayout(item.telegram_message_id, event)}
          >
            {index > 0 ? <View style={{ height: MESSAGE_BUBBLE_ROW_GAP_PX }} /> : null}
            {showDateDivider ? (
              <>
                <MessageDateDivider label={dateDividerLabel} colors={colors} />
                <View style={{ height: MESSAGE_BUBBLE_ROW_GAP_PX }} />
              </>
            ) : null}
            {frozenUnreadDividerBeforeId === item.telegram_message_id ? (
              <>
                <MessageUnreadDivider
                  unreadCount={Math.max(0, chat.unread_count ?? 0)}
                  colors={colors}
                />
                <View style={{ height: MESSAGE_BUBBLE_ROW_GAP_PX }} />
              </>
            ) : null}
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
        {displayMessages.length > 0 && showBottomHistoryLoadSentinel ? (
          <MessageHistoryLoadSentinel
            edge="bottom"
            enabled={historyLoadIoEnabled}
            rootMarginPx={newerEdgePrefetchPx}
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
