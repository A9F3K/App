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
import { HspScrollColumn, type HspScrollAnchor, type HspScrollColumnHandle, type HspScrollMetrics } from "../HspScrollColumn";
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
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";
import {
  sliceMessagesByCharacterBudgetAroundId,
  trimMessagesAroundAnchorCharBudget,
} from "./messageChatCharacterRange";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import { patchAuthenticatedHomeSelectedChatReadOutbox, patchAuthenticatedHomeSelectedChatGroupMeta, patchAuthenticatedHomeSelectedChatUnread, setAuthenticatedHomeOpenChatFollowingBottom } from "../../authenticatedHomeSelectedChat";
import {
  effectiveReadOutboxMessageId as mergeReadOutboxCursor,
  enrichHistoryMessageDisplay,
  isPrivateChatForReadReceipts,
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
import { MessageDateDivider } from "./MessageDateDivider";
import { resolveChatOpenScrollPlan } from "./resolveChatOpenScrollPlan";
import { prefetchOpenChatAvatars, setOpenChatAvatarPriority, isOpenChatAvatarPriority } from "./messageChatAvatarPrefetch";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  minIntersectingMessageId,
  resolveFirstUnreadMessageId,
  resolveLastReadMessageId,
  scrollYToAlignMessageBottomEdge,
  scrollYToAlignUnreadDivider,
  countUnreadMessagesBelowViewport,
  formatScrollToBottomUnreadCountLabel,
  isAtLoadedChatTail,
  MESSAGE_CHAT_FAB_ALWAYS_SHOW_UNREAD_THRESHOLD,
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
/** telegram-tt FAB_THRESHOLD — hide scroll-down when within this distance of bottom (read chats). */
const FAB_VISIBILITY_THRESHOLD_PX = 50;
/** telegram-tt NOTCH_THRESHOLD — unread chats hide FAB only at exact bottom. */
const FAB_NOTCH_THRESHOLD_PX = 0;
const DATE_DIVIDER_CURRENT_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
});
const DATE_DIVIDER_OTHER_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatMessageDateDividerLabel(sentAt: string, now: Date): string {
  const sentDate = new Date(sentAt);
  if (!Number.isFinite(sentDate.getTime())) return "";
  const dayDiff = Math.floor(
    (startOfLocalDayMs(now) - startOfLocalDayMs(sentDate)) / 86_400_000,
  );
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff === 2) return "The Day Before Yesterday";
  if (sentDate.getFullYear() === now.getFullYear()) {
    return DATE_DIVIDER_CURRENT_YEAR_FORMATTER.format(sentDate);
  }
  return DATE_DIVIDER_OTHER_YEAR_FORMATTER.format(sentDate);
}

function messageDayKey(sentAt: string): string {
  const sentDate = new Date(sentAt);
  if (!Number.isFinite(sentDate.getTime())) return sentAt;
  return `${sentDate.getFullYear()}-${sentDate.getMonth()}-${sentDate.getDate()}`;
}

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
    charBudgetUp: number;
    charBudgetDown: number;
    anchorMessageId: number;
    keepEnd: boolean;
    layouts: ReadonlyMap<number, MessageScrollLayoutEntry>;
    heightCache: ReadonlyMap<number, number>;
    rowGapPx: number;
    hasMoreOlder: boolean;
    nextBeforeMessageId: number | null;
  },
): MergeTrimHistoryResult {
  const merged = mergeHistoryMessages(existing, incoming, ctx);
  const trimmed = trimMessagesAroundAnchorCharBudget(
    merged,
    options.anchorMessageId,
    options.charBudgetUp,
    options.charBudgetDown,
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
  const hasMoreOlder =
    removedFromTop > 0 ? true : options.hasMoreOlder;
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
    ): MessageChatHistoryItem[] => {
      const trimmed = mergeTrimHistoryMessages(prev, incoming, historyMessageContext, {
        charBudgetUp: MESSAGE_CHAT_LOADED_CHAR_BUDGET_PER_SIDE,
        charBudgetDown: MESSAGE_CHAT_LOADED_CHAR_BUDGET_PER_SIDE,
        anchorMessageId: scrollAnchorMessageIdRef.current,
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
    openScrollToUnreadDividerRef.current = plan.scrollToUnreadDivider;
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
      scrollAnchorMessageIdRef.current = 0;
      viewportSliceTickRef.current = 0;
      setViewportSliceTick(0);
      lastPagedLoadEnableGenerationRef.current = 0;
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
      setFabUnreadDisplayTick((tick) => tick + 1);
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

  const unreadCatchUpAwaitingUserScroll = useCallback((): boolean => {
    return (
      openingUnreadCountRef.current > 0 && !userHasScrolledSinceOpenRef.current
    );
  }, []);

  const markUserScrollInteraction = useCallback(() => {
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
    if (openingUnreadCountRef.current > 0) {
      initialScrollInProgressRef.current = false;
      setInitialScrollInProgress(false);
      openUnreadAnchorLockUntilRef.current = 0;
      if (openUnreadAnchorReleaseTimerRef.current != null) {
        clearTimeout(openUnreadAnchorReleaseTimerRef.current);
        openUnreadAnchorReleaseTimerRef.current = null;
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    markUserScrollInteraction();
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

  const enablePagedLoadAfterOpenSettle = useCallback(
    (_metrics: HspScrollMetrics, _enableImmediately: boolean) => {
      scrollControllerRef.current?.clearNearTopLatch();
      scrollControllerRef.current?.clearNearBottomLatch();
      loadOlderEnabledRef.current = true;
      loadNewerEnabledRef.current = true;
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

  const settleOpenUnreadDividerScroll = useCallback((): boolean => {
    const messages = displayMessagesRef.current;
    const lastReadId = resolveLastReadMessageId(
      messages,
      lastReadInboxMessageIdRef.current,
    );
    const firstUnreadId = resolveFirstUnreadMessageId(
      messages,
      lastReadInboxMessageIdRef.current,
    );
    if (firstUnreadId == null && lastReadId == null) {
      settleOpenBottomScroll();
      return true;
    }

    if (firstUnreadId != null) {
      if (memoFirstUnreadIdRef.current == null) {
        memoFirstUnreadIdRef.current = firstUnreadId;
        memoUnreadDividerBeforeIdRef.current = firstUnreadId;
      }
    }

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;

    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const scrollAnchorId = lastReadId ?? firstUnreadId ?? 0;
    if (scrollAnchorId > 0) {
      scrollAnchorMessageIdRef.current = scrollAnchorId;
    }
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
      (scrollAnchorId > 0 ? layoutMap.get(scrollAnchorId) : null) ??
      (firstUnreadId != null ? layoutMap.get(firstUnreadId) : null);
    if (!anchorEntry || anchorEntry.height <= 0) return false;

    const targetY =
      lastReadId != null
        ? scrollYToAlignMessageBottomEdge(
            anchorEntry,
            metrics.layoutH,
            metrics.contentH,
          )
        : scrollYToAlignUnreadDivider(
            anchorEntry,
            metrics.layoutH,
            metrics.contentH,
          );
    applyProgrammaticScrollY(targetY);
    enablePagedLoadAfterOpenSettle(metrics, true);
    return true;
  }, [
    applyProgrammaticScrollY,
    enablePagedLoadAfterOpenSettle,
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
        metrics.scrollY > newerGateY + LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX &&
        !(
          openingUnreadCountRef.current > 0 &&
          !userHasScrolledSinceOpenRef.current
        )
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
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
    });
  }, []);

  const bumpViewportSliceTick = useCallback(() => {
    viewportSliceTickRef.current += 1;
    setViewportSliceTick(viewportSliceTickRef.current);
  }, []);

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
            if (openingUnreadCountRef.current > 0) {
              initialScrollInProgressRef.current = false;
              setInitialScrollInProgress(false);
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
      setFabUnreadDisplayTick((tick) => tick + 1);
      const nearTop = metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX;
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

      tryUnlockPagedLoad(metrics);
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
      scheduleVirtualScrollWindowUpdate,
      tryArmUnreadMarking,
      tryUnlockPagedLoad,
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

  useEffect(() => {
    loadedMessagesRef.current = loadedMessages;
  }, [loadedMessages]);

  const displayMessages = useMemo(() => {
    if (loadedMessages.length === 0) {
      viewportAtLoadedTopRef.current = false;
      viewportAtLoadedBottomRef.current = false;
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
    } else if (nearBottom && followingBottomRef.current) {
      anchorId = loadedMessages[loadedMessages.length - 1]!.telegram_message_id;
      scrollAnchorMessageIdRef.current = anchorId;
    } else if (anchorId <= 0) {
      anchorId = loadedMessages[loadedMessages.length - 1]!.telegram_message_id;
      scrollAnchorMessageIdRef.current = anchorId;
    }

    const bounds = sliceMessagesByCharacterBudgetAroundId(
      loadedMessages,
      anchorId,
      MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
      MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
    );
    if (bounds.endIndex < bounds.startIndex) return [];
    viewportAtLoadedTopRef.current = bounds.startIndex === 0;
    viewportAtLoadedBottomRef.current =
      bounds.endIndex >= loadedMessages.length - 1;
    return loadedMessages.slice(bounds.startIndex, bounds.endIndex + 1);
  }, [
    loadedMessages,
    viewportSliceTick,
    virtualScrollTick,
    userScrollInteractionTick,
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

  useEffect(() => {
    if (displayMessages.length === 0) return;
    if (frozenUnreadDividerBeforeId != null) return;
    const firstUnread = resolveFirstUnreadMessageId(
      displayMessages,
      lastReadInboxMessageIdRef.current,
    );
    if (firstUnread == null) return;
    memoFirstUnreadIdRef.current = firstUnread;
    memoUnreadDividerBeforeIdRef.current = firstUnread;
    setFrozenUnreadDividerBeforeId(firstUnread);
  }, [displayMessages, frozenUnreadDividerBeforeId]);

  const syncScrollBelowUnread = useCallback(
    (metrics: HspScrollMetrics) => {
      if (!chatScrollPaintReadyRef.current) return;
      if (initialScrollInProgressRef.current) return;
      if (metrics.contentH <= 0 || metrics.layoutH <= 0) return;
      if (
        openingUnreadCountRef.current > 0 &&
        !userHasScrolledSinceOpenRef.current
      ) {
        return;
      }
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
            if (
              chatScrollPaintReadyRef.current &&
              !unreadCatchUpAwaitingUserScroll()
            ) {
              if (tryArmUnreadMarking(settledMetrics)) {
                syncScrollBelowUnreadRef.current(settledMetrics);
              }
            }
          }
        });
      });
    },
    [enablePagedLoadAfterOpenSettle, tryArmUnreadMarking, unreadCatchUpAwaitingUserScroll],
  );

  const finishOpenScrollReveal = useCallback(
    (enableImmediately: boolean, reason: string) => {
      clearOpenScrollRevealFallback();
      openScrollAwaitingLayoutMessageIdRef.current = null;
      if (!openScrollToUnreadDividerRef.current) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
      } else if (openUnreadAnchorLockUntilRef.current <= Date.now()) {
        scheduleOpenUnreadAnchorRelease(1500);
      }
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: "reveal",
        reason,
        scrollY: pinnedScrollYRef.current,
        enableImmediately,
        scrollToUnreadDivider: openScrollToUnreadDividerRef.current,
        openingUnread: openingUnreadCountRef.current,
      });
      revealChatScroll();
      virtualScrollTickRef.current += 1;
      setVirtualScrollTick(virtualScrollTickRef.current);
      runOpenScrollPostSettleWork(enableImmediately);
    },
    [chat.peer_user_id, chat.telegram_chat_id, chat.title, clearOpenScrollRevealFallback, revealChatScroll, runOpenScrollPostSettleWork, scheduleOpenUnreadAnchorRelease],
  );

  const beginOpenScrollRevealWait = useCallback(
    (enableImmediately: boolean, reason: string) => {
      clearOpenScrollRevealFallback();
      const waitMs = openScrollAwaitingLayoutMessageIdRef.current != null ? 400 : 150;
      openScrollRevealFallbackTimerRef.current = setTimeout(() => {
        openScrollRevealFallbackTimerRef.current = null;
        finishOpenScrollReveal(enableImmediately, reason);
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

      if (openScrollToUnreadDividerRef.current) {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (metrics && metrics.layoutH > 0 && metrics.contentH > 0) {
          const layoutMap = resolveScrollLayoutMap(metrics);
          const layoutEntry = layoutMap.get(anchorMessageId);
          if (layoutEntry && layoutEntry.height > 0) {
            const targetY = scrollYToAlignUnreadDivider(
              layoutEntry,
              metrics.layoutH,
              metrics.contentH,
            );
            openUnreadAnchorMessageIdRef.current = anchorMessageId;
            applyProgrammaticScrollY(targetY);
            scheduleOpenUnreadAnchorRelease(800);
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
      if (!openScrollToUnreadDividerRef.current) {
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
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: "restore_cached",
        scrollY: state.scrollY,
        followingBottom: state.followingBottom,
        anchorMessageId: anchorId > 0 ? anchorId : null,
        openingUnread: openingUnreadCountRef.current,
      });
      beginOpenScrollRevealWait(false, "cached_scroll_restore");
      return true;
    }

    if (pendingInitialScrollRef.current) {
      const scrollToUnreadDivider = openScrollToUnreadDividerRef.current;
      if (!scrollToUnreadDivider) {
        pendingInitialScrollRef.current = false;
      }
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;
      if (scrollToUnreadDivider) {
        if (!settleOpenUnreadDividerScroll()) {
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
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: scrollToUnreadDivider ? "unread_divider" : "initial_bottom",
        scrollY: pinnedScrollYRef.current,
        messageCount: displayMessages.length,
        openingUnread: openingUnreadCountRef.current,
      });
      beginOpenScrollRevealWait(
        openScrollAnchorRef.current === "bottom" &&
          openingUnreadCountRef.current <= 0 &&
          followingBottomRef.current,
        scrollToUnreadDivider ? "unread_divider" : "initial_bottom",
      );
      return true;
    }

    if (!chatScrollPaintReadyRef.current) {
      beginOpenScrollRevealWait(false, "fallback_reveal");
    }
    return true;
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    displayMessages.length,
    lastDisplayMessageId,
    loadingInitial,
    restoreChatScrollPosition,
    revealChatScroll,
    resolveScrollLayoutMap,
    settleOpenBottomScroll,
    settleOpenUnreadDividerScroll,
    beginOpenScrollRevealWait,
  ]);

  const clearOpenScrollSettleRetry = useCallback(() => {
    if (openScrollSettleRetryRafRef.current != null) {
      cancelAnimationFrame(openScrollSettleRetryRafRef.current);
      openScrollSettleRetryRafRef.current = null;
    }
  }, []);

  const forceRevealOpenChatScroll = useCallback((reason: string) => {
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
    logPageDisplay("messages_open_scroll_settle", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      phase: "force_reveal",
      reason,
      scrollY: pinnedScrollYRef.current,
      openingUnread: openingUnreadCountRef.current,
    });
    revealChatScroll();
  }, [chat.peer_user_id, chat.telegram_chat_id, chat.title, clearOpenScrollRevealFallback, clearOpenScrollSettleRetry, revealChatScroll]);

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
        forceRevealOpenChatScroll("settle_retry_exhausted");
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
        forceRevealOpenChatScroll("force_reveal_timeout");
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
        !virtualActive &&
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
      }
    }
    if (pendingInitialScrollRef.current && openScrollToUnreadDividerRef.current) {
      trySettleOpenChatScroll();
    }
  }, [bumpVirtualLayoutFromMeasure, tryCompleteOpenScrollAfterLayout, trySettleOpenChatScroll]);

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
      logPageDisplay("messages_open_scroll_settle", {
        ...chatLogFields({
          chatId: chat.telegram_chat_id,
          peerUserId: chat.peer_user_id,
          title: chat.title,
        }),
        phase: "paged_load_gates",
        enableImmediately,
        loadOlderEnabled: enableImmediately && openingUnreadCountRef.current <= 0,
        loadNewerEnabled: enableImmediately,
        scrollY: metrics.scrollY,
        openingUnread: openingUnreadCountRef.current,
      });
      enablePagedLoadAfterOpenSettle(metrics, enableImmediately);
      scrollControllerRef.current?.clearNearTopLatch();
      scrollControllerRef.current?.clearNearBottomLatch();
    };

    requestAnimationFrame(settlePagedLoadGates);
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
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
      prevDisplayHeadIdRef.current = displayMessages[0]?.telegram_message_id ?? 0;
      return;
    }

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
    const headMovedOlder =
      newHeadId > 0 && prevHeadId > 0 && newHeadId < prevHeadId;
    prevDisplayLengthRef.current = displayMessages.length;
    prevDisplayLastIdRef.current = lastDisplayMessageId;
    prevDisplayHeadIdRef.current = newHeadId;

    if (
      openingUnreadCountRef.current <= 0 &&
      followingBottomRef.current &&
      isAtLoadedChatTail(lastDisplayMessageId, chatTailMessageIdRef.current) &&
      !loadingOlderRef.current &&
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
      (newerTail || lengthGrew || headMovedOlder) &&
      !loadingOlderRef.current &&
      !loadingNewerRef.current &&
      !followingBottomRef.current &&
      !pendingPreserveScrollYRef.current
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
          const plan = resolveChatOpenScrollPlan(chat);
          let result;
          if (
            plan.pendingScrollRestore?.anchorMessageId != null &&
            plan.pendingScrollRestore.anchorMessageId > 0
          ) {
            result = await fetchChatHistoryAroundCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              plan.pendingScrollRestore.anchorMessageId,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
            );
          } else if (plan.scrollToUnreadDivider) {
            result = await fetchChatHistoryAroundUnreadCharBudget(
              chat.telegram_chat_id,
              chat.peer_user_id,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
              MESSAGE_CHAT_VIEWPORT_CHAR_RANGE,
            );
          } else if (plan.openAnchor === "bottom") {
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
              result.lastReadInboxMessageId,
            );
            if (lastReadId != null) {
              scrollAnchorId = lastReadId;
            }
          }
          if (scrollAnchorId > 0) {
            scrollAnchorMessageIdRef.current = scrollAnchorId;
          }
          setCachedChatHistory(chat.telegram_chat_id, result, {
            previewOnly: false,
            aroundUnread: historyAnchorSpec.aroundUnread,
            aroundMessageId: historyAnchorSpec.aroundMessageId ?? null,
          });
          setMessages((prev) => {
            if (
              userHasScrolledSinceOpenRef.current &&
              prev.length > result.messages.length &&
              !pendingInitialScrollRef.current
            ) {
              return prev;
            }
            return mergeHistoryWithWindow(prev, result.messages, true);
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

  const loadOlderMessages = useCallback(async () => {
    const beforeMessageId = nextBeforeMessageIdRef.current;
    if (
      loadingInitial ||
      loadingOlderRef.current ||
      !hasMoreOlder ||
      beforeMessageId == null
    ) {
      return;
    }

    if (initialScrollInProgressRef.current) {
      return;
    }

    isReplacingHistoryRef.current = true;
    const startMetrics = scrollControllerRef.current?.getMetrics();
    const startScrollY = startMetrics?.scrollY ?? 0;
    loadOlderStartScrollYRef.current = startScrollY;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    followingBottomRef.current = false;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const scrollAnchor = scrollControllerRef.current?.captureScrollAnchor();
    const headBeforeLoad =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    const lengthBeforeLoad = displayMessagesRef.current.length;

    logPageDisplay("messages_history_load_older_start", {
      ...chatLogFields({
        chatId: chat.telegram_chat_id,
        peerUserId: chat.peer_user_id,
        title: chat.title,
      }),
      beforeMessageId,
    });

    try {
      let result = await fetchOlderHistoryCharBudget(
        chat.telegram_chat_id,
        chat.peer_user_id,
        beforeMessageId,
        MESSAGE_CHAT_PAGINATION_CHAR_RANGE,
      );
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
        requestAnimationFrame(() => {
          isReplacingHistoryRef.current = false;
        });
      });

      requestAnimationFrame(() => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return;
        tryUnlockPagedLoad(metrics);
        bumpViewportSliceTick();
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
    tryUnlockPagedLoad,
    bumpViewportSliceTick,
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

      const scrollAnchorBeforeMerge =
        !followingBottomRef.current
          ? scrollControllerRef.current?.captureScrollAnchor()
          : null;

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
    !initialScrollInProgress;

  const triggerLoadNewerFromSentinel = useCallback(() => {
    if (isReplacingHistoryRef.current) return;
    if (initialScrollInProgressRef.current || scrollAnchorRestorePending) return;
    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    if (display.length === 0) return;
    const displayTailId = display[display.length - 1]!.telegram_message_id;
    const loadedTailId =
      loaded.length > 0 ? loaded[loaded.length - 1]!.telegram_message_id : 0;
    if (displayTailId > 0 && loadedTailId > 0 && displayTailId < loadedTailId) {
      scrollAnchorMessageIdRef.current = displayTailId;
      bumpViewportSliceTick();
      return;
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
  }, [
    bumpViewportSliceTick,
    chat.last_message_telegram_id,
    loadNewerMessages,
    scrollAnchorRestorePending,
  ]);

  const triggerLoadOlderFromSentinel = useCallback(() => {
    if (isReplacingHistoryRef.current) return;
    if (initialScrollInProgressRef.current || scrollAnchorRestorePending) return;
    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    if (display.length === 0) return;
    const displayHeadId = display[0]!.telegram_message_id;
    const loadedHeadId = loaded.length > 0 ? loaded[0]!.telegram_message_id : 0;
    if (displayHeadId > 0 && loadedHeadId > 0 && displayHeadId > loadedHeadId) {
      scrollAnchorMessageIdRef.current = displayHeadId;
      bumpViewportSliceTick();
      return;
    }
    if (!hasMoreOlder || loadingOlderRef.current) return;
    void loadOlderMessages();
  }, [
    bumpViewportSliceTick,
    hasMoreOlder,
    loadOlderMessages,
    scrollAnchorRestorePending,
  ]);

  const effectiveChatTailMessageId = chat.last_message_telegram_id ?? null;
  const hasMoreNewerBelow = !isAtLoadedChatTail(
    lastDisplayMessageId,
    effectiveChatTailMessageId,
  );

  const fabUnreadCount = useMemo(() => {
    const serverUnread = Math.max(0, Math.trunc(chat.unread_count ?? 0));
    const openingUnread = Math.max(0, openScrollPlan.openingUnreadCount);
    const chatTail = chat.last_message_telegram_id ?? null;
    const loadedTail =
      loadedMessages.length > 0
        ? loadedMessages[loadedMessages.length - 1]!.telegram_message_id
        : 0;
    const atChatTail = isAtLoadedChatTail(loadedTail, chatTail);

    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) {
      return Math.max(serverUnread, openingUnread);
    }

    if (
      followingBottomRef.current &&
      atChatTail &&
      isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
    ) {
      return 0;
    }

    const layoutMap = resolveScrollLayoutMap(metrics);
    const belowViewport = countUnreadMessagesBelowViewport(
      displayMessages,
      layoutMap,
      metrics,
      lastReadInboxMessageIdRef.current,
    );
    if (belowViewport > 0) return belowViewport;
    if (!atChatTail) return Math.max(serverUnread, openingUnread);
    return serverUnread;
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
  const topHistoryLoadLineActive = loadingOlder;
  const showScrollToBottomButton = useMemo(() => {
    if (initialScrollInProgress) return false;
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
    isNearScrollBottom,
    chatScrollPaintReady,
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
        onScrollPositionChange={handleScrollPositionChange}
        onUserScrollIntent={markUserScrollInteraction}
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
          const previous = index > 0 ? displayMessages[index - 1] : null;
          const showDateDivider =
            previous == null ||
            messageDayKey(previous.sent_at) !== messageDayKey(item.sent_at);
          const dateDividerLabel = showDateDivider
            ? formatMessageDateDividerLabel(item.sent_at, new Date())
            : "";
          return (
          <View
            key={item.telegram_message_id}
            onLayout={(event) => handleMessageLayout(item.telegram_message_id, event)}
          >
            {index > 0 ? <View style={{ height: MESSAGE_BUBBLE_ROW_GAP_PX }} /> : null}
            {showDateDivider ? (
              <>
                <MessageDateDivider label={dateDividerLabel} colors={colors} />
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
