import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ActivityIndicator, PixelRatio, Platform, Text, View, type LayoutChangeEvent } from "react-native";
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
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";
import {
  sliceMessagesByCountAroundId,
  trimMessagesAroundAnchorCount,
  expandDisplaySliceOlder,
  MESSAGE_LIST_SLICE,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  type CountSliceBounds,
} from "./messageChatViewportSlice";
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
import { MessageUnreadDivider } from "./MessageUnreadDivider";
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
  scrollYToAlignUnreadDivider,
  scrollYToPreserveViewportOffset,
  countUnreadMessagesBelowViewport,
  countUnreadMessagesNewerThanViewport,
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
const LOAD_OLDER_PAGE_COOLDOWN_MS = 500;
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
const DATE_DIVIDER_LINE_PX = 1 / Math.max(1, PixelRatio.get());

function startOfLocalDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatMessageDateDividerLabel(sentAt: string, now: Date): string {
  const sentDate = new Date(sentAt);
  if (!Number.isFinite(sentDate.getTime())) return "";
  const dayDiff = Math.floor(
    (startOfLocalDayMs(now) - startOfLocalDayMs(sentDate)) / 86_400_000,
  );
  if (dayDiff === 0) return "Today";
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

/** Hide a date divider when older loaded history still has messages on the same day. */
function shouldShowMessageDateDivider(
  item: { sent_at: string; telegram_message_id: number },
  previousInDisplay: { sent_at: string } | null,
  loadedMessages: readonly { sent_at: string; telegram_message_id: number }[],
  allLoadedMessagesAreFromToday: boolean,
): boolean {
  if (allLoadedMessagesAreFromToday) return false;
  const itemDay = messageDayKey(item.sent_at);
  if (previousInDisplay != null && messageDayKey(previousInDisplay.sent_at) === itemDay) {
    return false;
  }
  const loadedIndex = loadedMessages.findIndex(
    (row) => row.telegram_message_id === item.telegram_message_id,
  );
  if (loadedIndex > 0) {
    const olderNeighbor = loadedMessages[loadedIndex - 1]!;
    if (messageDayKey(olderNeighbor.sent_at) === itemDay) {
      return false;
    }
  }
  return true;
}

function todayDayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

function MessageDateDivider({ label, colors }: { label: string; colors: ThemeColors }) {
  return (
    <View
      style={{
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 6,
        gap: 8,
      }}
      accessibilityRole="text"
    >
      <View
        style={{
          flex: 1,
          height: DATE_DIVIDER_LINE_PX,
          minHeight: DATE_DIVIDER_LINE_PX,
          maxHeight: DATE_DIVIDER_LINE_PX,
          backgroundColor: colors.highlight,
        }}
      />
      <Text
        style={{
          color: colors.secondary,
          fontSize: 13,
          lineHeight: 16,
          fontWeight: "400",
        }}
      >
        {label}
      </Text>
      <View
        style={{
          flex: 1,
          height: DATE_DIVIDER_LINE_PX,
          minHeight: DATE_DIVIDER_LINE_PX,
          maxHeight: DATE_DIVIDER_LINE_PX,
          backgroundColor: colors.highlight,
        }}
      />
    </View>
  );
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
  /** Suppress preserveViewportOnResize while prepend/expand anchor restore runs. */
  const [prependAnchorRestorePending, setPrependAnchorRestorePending] = useState(false);
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
  const pendingScrollRestoreRef = useRef<CachedChatScrollPosition | null>(null);
  /** Cached scroll to re-apply once message layouts (and content height) are ready. */
  const displaySliceBoundsRef = useRef<CountSliceBounds>({ startIndex: 0, endIndex: -1 });
  /** Expanded start index toward older rows; merged into anchor slice until cleared at bottom. */
  const displaySliceBoundsOverrideRef = useRef<CountSliceBounds | null>(null);
  const pendingItemAnchorRef = useRef<HspItemAnchor | null>(null);
  /** After in-buffer expand reaches loaded head, fetch the next older API page. */
  const loadOlderAfterExpandSnapshotRef = useRef<number | null>(null);
  const tryTriggerOlderHistoryLoadRef = useRef<() => void>(() => {});
  const loadOlderMessagesRef = useRef<
    (options?: { expandArmed?: boolean; beforeMessageId?: number }) => Promise<void>
  >(async () => {});
  const openScrollAppliedRef = useRef(false);
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
  const loadOlderAdvanceChainRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const userScrollingUpRef = useRef(false);
  const loadOlderStartScrollYRef = useRef<number | null>(null);
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
  /** Display-slice expansion vs API older fetch — different scroll-keep rules. */
  const olderPrependKindRef = useRef<"display_expand" | "api_load" | null>(null);
  /** Viewport anchor pinned while expanding the display char slice (no API fetch). */
  const displayExpandAnchorIdRef = useRef(0);
  /** Defer prepend lock release until row heights stop changing (media measure). */
  const olderPrependSettleUntilRef = useRef(0);
  const prependKeepRafRef = useRef<number | null>(null);
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
    ): MessageChatHistoryItem[] => {
      const isOlderPrependMerge = !keepEnd;
      const skipTrim = isOlderPrependMerge && loadingOlderRef.current;
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
      openScrollAppliedRef.current = false;
      pendingItemAnchorRef.current = null;
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
      lastReadInboxMessageIdRef.current = null;
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
          distanceFromBottom: Math.max(0, metrics.contentH - metrics.scrollY),
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
      const domAnchor = pendingScrollAnchorRef.current;
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

  const verifyPrependScrollKept = useCallback(
    (domAnchor: HspScrollAnchor | null, expectedScrollY?: number): boolean => {
      const live = scrollControllerRef.current?.captureScrollAnchor();
      if (!live) return false;
      if (expectedScrollY != null && Math.abs(live.scrollTop - expectedScrollY) <= 2) {
        return true;
      }
      if (!domAnchor) return live.scrollTop > 0;
      if (domAnchor.scrollTop <= 80) {
        return live.scrollTop <= domAnchor.scrollTop + 120;
      }
      const heightDelta = live.scrollHeight - domAnchor.scrollHeight;
      if (heightDelta <= 0) return false;
      const minExpected = domAnchor.scrollTop + heightDelta - 80;
      return live.scrollTop >= minExpected;
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
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.layoutH <= 0) return null;
    const layoutMap = resolveScrollLayoutMap(metrics);
    const anchorId =
      topViewportAnchorMessageId(display, layoutMap, metrics) ??
      display[0]!.telegram_message_id;
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
      const prependKind = olderPrependKindRef.current;

      if (
        Platform.OS === "web" &&
        prependKind !== "display_expand" &&
        prependKind !== "api_load"
      ) {
        const domRestored =
          scrollControllerRef.current?.restoreItemAnchor(anchor) ?? false;
        if (domRestored && verifyPrependScrollKept(domAnchor)) {
          const nextMetrics = scrollControllerRef.current?.getMetrics();
          if (nextMetrics) {
            pinnedScrollYRef.current = nextMetrics.scrollY;
            lastScrollYRef.current = nextMetrics.scrollY;
          }
          return true;
        }
      }

      if (anchor.offsetFromViewportTop == null) return false;
      const layoutMap = resolveScrollLayoutMap(metrics);
      const entry = layoutMap.get(anchor.messageId);
      if (!entry || entry.height <= 0) return false;
      const liveAnchor = scrollControllerRef.current?.captureScrollAnchor();
      const measuredContentH = liveAnchor?.scrollHeight ?? metrics.contentH;
      const estimatedContentH = estimateMessageListBlockTotalHeight(
        displayMessagesRef.current,
        messageLayoutsRef.current,
        messageRowHeightCacheRef.current,
        MESSAGE_BUBBLE_ROW_GAP_PX,
      );
      const contentH = Math.max(metrics.contentH, measuredContentH, estimatedContentH);
      const targetY = scrollYToPreserveViewportOffset(
        entry,
        anchor.offsetFromViewportTop,
        metrics.layoutH,
        contentH,
      );
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
    enableEdgeLoadingAfterOpen();
    return true;
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

  const expandDisplaySliceTowardOlder = useCallback(() => {
    if (pendingItemAnchorRef.current) return false;
    const loaded = loadedMessagesRef.current;
    const bounds = displaySliceBoundsRef.current;
    if (bounds.endIndex < bounds.startIndex) return false;
    if (bounds.startIndex <= 0) return false;
    const nextBounds = expandDisplaySliceOlder(loaded, bounds, MESSAGE_LIST_SLICE);
    if (nextBounds.startIndex >= bounds.startIndex) return false;
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    olderLoadDomAnchorRef.current =
      scrollControllerRef.current?.captureScrollAnchor() ?? null;
    olderPrependKindRef.current = "display_expand";
    olderPrependInProgressRef.current = true;
    displayExpandAnchorIdRef.current =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    if (
      nextBounds.startIndex === 0 &&
      hasMoreOlderRef.current &&
      nextBeforeMessageIdRef.current != null
    ) {
      loadOlderAfterExpandSnapshotRef.current = nextBeforeMessageIdRef.current;
    } else {
      loadOlderAfterExpandSnapshotRef.current = null;
    }
    pendingItemAnchorRef.current = capturePrependItemAnchor();
    displaySliceBoundsOverrideRef.current = {
      startIndex: nextBounds.startIndex,
      endIndex: Math.max(nextBounds.endIndex, bounds.endIndex),
    };
    programmaticScrollRef.current = true;
    setPrependAnchorRestorePending(true);
    logMessagesScrollAction("display_expand_start", {
      prevStart: bounds.startIndex,
      nextStart: nextBounds.startIndex,
      displayCount: nextBounds.endIndex - nextBounds.startIndex + 1,
      loadOlderAfterExpand: loadOlderAfterExpandSnapshotRef.current != null,
    });
    bumpViewportSliceTick();
    return true;
  }, [bumpViewportSliceTick, capturePrependItemAnchor, logMessagesScrollAction]);

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
        userScrollingUpRef.current &&
        !initialScrollInProgressRef.current &&
        Date.now() >= openUnreadAnchorLockUntilRef.current
      ) {
        /* prepend anchor handled via pendingItemAnchorRef */
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
          return mergeHistoryWithWindow([], cached.messages, true);
        });
      } else {
        setMessages((prev) => {
          const prevHead = prev[0]?.telegram_message_id ?? 0;
          const cacheHeadInner = cached.messages[0]?.telegram_message_id ?? 0;
          const extendsOlderInner =
            cacheHeadInner > 0 && (prevHead === 0 || cacheHeadInner < prevHead);
          const next = mergeHistoryWithWindow(prev, cached.messages, !extendsOlderInner);
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
    [bumpViewportSliceTick, chat.telegram_chat_id, historyMessageContext, mergeHistoryWithWindow],
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
      anchorId = loadedMessages[loadedMessages.length - 1]!.telegram_message_id;
      scrollAnchorMessageIdRef.current = anchorId;
    }

    let bounds = sliceMessagesByCountAroundId(
      loadedMessages,
      anchorId,
      MESSAGE_LIST_SLICE,
    );
    const override = displaySliceBoundsOverrideRef.current;
    if (override && override.endIndex >= override.startIndex) {
      bounds = {
        startIndex: Math.min(bounds.startIndex, override.startIndex),
        endIndex: Math.max(bounds.endIndex, override.endIndex),
      };
      bounds.startIndex = Math.max(0, bounds.startIndex);
      bounds.endIndex = Math.min(loadedMessages.length - 1, bounds.endIndex);
    }
    displaySliceBoundsRef.current = bounds;
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
    if (loadedMessages.length === 0) return;
    if (frozenUnreadDividerBeforeId != null) return;
    const firstUnread = resolveFirstUnreadMessageId(
      loadedMessages,
      lastReadInboxMessageIdRef.current,
    );
    if (firstUnread == null) return;
    const unreadIndex = loadedMessages.findIndex(
      (row) => row.telegram_message_id === firstUnread,
    );
    if (unreadIndex >= 0) {
      const bounds = displaySliceBoundsRef.current;
      const inSlice =
        bounds.endIndex >= bounds.startIndex &&
        unreadIndex >= bounds.startIndex &&
        unreadIndex <= bounds.endIndex;
      if (!inSlice && openingUnreadCountRef.current > 0) {
        scrollAnchorMessageIdRef.current = firstUnread;
        viewportSliceTickRef.current += 1;
        setViewportSliceTick(viewportSliceTickRef.current);
      }
    }
    memoFirstUnreadIdRef.current = firstUnread;
    memoUnreadDividerBeforeIdRef.current = firstUnread;
    setFrozenUnreadDividerBeforeId(firstUnread);
  }, [loadedMessages, frozenUnreadDividerBeforeId]);

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

  const applyOpenScrollOnce = useCallback((): boolean => {
    if (chatScrollPaintReadyRef.current || openScrollAppliedRef.current) return true;
    if (displayMessagesRef.current.length === 0) {
      if (!loadingInitial) {
        openScrollAppliedRef.current = true;
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
      });
    }

    initialScrollInProgressRef.current = false;
    setInitialScrollInProgress(false);
    enableEdgeLoadingAfterOpen();
    openScrollAppliedRef.current = true;
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
        openScrollAppliedRef.current = true;
        revealChatScroll();
        enableEdgeLoadingAfterOpen();
      }
    };
    openScrollSettleRetryRafRef.current = requestAnimationFrame(tick);
  }, [applyOpenScrollOnce, enableEdgeLoadingAfterOpen, revealChatScroll]);

  const scheduleOpenScrollForceReveal = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    if (openScrollForceRevealTimerRef.current != null) return;
    openScrollForceRevealTimerRef.current = setTimeout(() => {
      openScrollForceRevealTimerRef.current = null;
      if (!chatScrollPaintReadyRef.current) {
        openScrollAppliedRef.current = true;
        revealChatScroll();
        enableEdgeLoadingAfterOpen();
      }
    }, 600);
  }, [enableEdgeLoadingAfterOpen, revealChatScroll]);

  openScrollSettleRef.current = {
    trySettle: applyOpenScrollOnce,
    scheduleRetry: scheduleOpenScrollApply,
    forceReveal: () => {
      openScrollAppliedRef.current = true;
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
    }
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    preserveScrollY,
    scheduleOpenScrollApply,
    scheduleOpenScrollForceReveal,
  ]);

  useLayoutEffect(() => {
    const itemAnchor = pendingItemAnchorRef.current;
    if (!itemAnchor) return;
    pendingItemAnchorRef.current = null;
    const loadOlderBeforeId = loadOlderAfterExpandSnapshotRef.current;
    loadOlderAfterExpandSnapshotRef.current = null;
    let attempts = 0;
    let released = false;
    const release = (restored: boolean) => {
      if (released) return;
      released = true;
      programmaticScrollRef.current = false;
      setPrependAnchorRestorePending(false);
      releaseOlderLoadViewportLock();
      logMessagesScrollAction(
        restored ? "prepend_keep_release" : "prepend_keep_miss",
        {
          messageId: itemAnchor.messageId,
          attempts,
          loadOlderAfterExpand: loadOlderBeforeId != null,
        },
      );
      scrollControllerRef.current?.clearNearTopLatch();
      if (loadOlderBeforeId != null) {
        requestAnimationFrame(() => {
          void loadOlderMessagesRef.current({
            expandArmed: true,
            beforeMessageId: loadOlderBeforeId,
          });
        });
      }
    };
    const run = () => {
      let restored = restorePrependDomAnchor();
      if (!restored) {
        restored = restorePrependItemAnchor(itemAnchor);
      }
      if (restored || ++attempts >= 32) {
        release(restored);
        return;
      }
      requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    viewportSliceTick,
    restorePrependItemAnchor,
    restorePrependDomAnchor,
    logMessagesScrollAction,
    releaseOlderLoadViewportLock,
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
          if (
            messagesCountRef.current > 0 &&
            (loadingOlderRef.current || loadingNewerRef.current)
          ) {
            logPageDisplay("messages_history_cache_revalidate_skipped_during_paging", {
              ...chatLogFields({
                chatId: chat.telegram_chat_id,
                peerUserId: chat.peer_user_id,
                title: chat.title,
              }),
              count: result.messages.length,
            });
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

  const loadOlderMessages = useCallback(async (options?: { expandArmed?: boolean; beforeMessageId?: number }) => {
    const expandArmed = options?.expandArmed === true;
    const beforeMessageId =
      options?.beforeMessageId ?? nextBeforeMessageIdRef.current;
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
    if (!expandArmed && !hasMoreOlder) {
      return;
    }
    if (olderLoadInFlightBeforeIdRef.current === beforeMessageId) {
      return;
    }

    if (initialScrollInProgressRef.current) {
      return;
    }

    isReplacingHistoryRef.current = true;
    olderLoadInFlightBeforeIdRef.current = beforeMessageId;
    const startMetrics = scrollControllerRef.current?.getMetrics();
    const startScrollY = startMetrics?.scrollY ?? 0;
    loadOlderStartScrollYRef.current = startScrollY;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    followingBottomRef.current = false;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const headBeforeLoad =
      displayMessagesRef.current[0]?.telegram_message_id ?? 0;
    const lengthBeforeLoad = displayMessagesRef.current.length;
    olderLoadDomAnchorRef.current =
      scrollControllerRef.current?.captureScrollAnchor() ?? null;
    olderPrependKindRef.current = "api_load";
    olderPrependInProgressRef.current = true;
    pendingItemAnchorRef.current = capturePrependItemAnchor();
    programmaticScrollRef.current = true;
    setPrependAnchorRestorePending(true);
    const anchorId = pendingItemAnchorRef.current?.messageId ?? 0;
    if (anchorId > 0) {
      scrollAnchorMessageIdRef.current = anchorId;
    }
    logMessagesScrollAction("prepend_lock", {
      anchorMessageId: anchorId,
      prependKind: "api_load",
      loadingOlder: true,
    });

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
        pendingItemAnchorRef.current = null;
        setPrependAnchorRestorePending(false);
        programmaticScrollRef.current = false;
        releaseOlderLoadViewportLock();
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
        pendingItemAnchorRef.current = null;
        setPrependAnchorRestorePending(false);
        programmaticScrollRef.current = false;
        releaseOlderLoadViewportLock();
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
        if (grewViaCache || grewViaMerge) {
          const loaded = loadedMessagesRef.current;
          const prevOverride = displaySliceBoundsOverrideRef.current;
          const prevEnd = Math.max(
            displaySliceBoundsRef.current.endIndex,
            prevOverride?.endIndex ?? displaySliceBoundsRef.current.endIndex,
          );
          let nextStart = prevOverride?.startIndex ?? displaySliceBoundsRef.current.startIndex;
          if (nextHeadAfter > 0 && headBeforeLoad > 0 && nextHeadAfter < headBeforeLoad) {
            const headIndex = loaded.findIndex(
              (row) => row.telegram_message_id === nextHeadAfter,
            );
            if (headIndex >= 0) {
              nextStart = Math.min(nextStart, headIndex);
            }
          }
          displaySliceBoundsOverrideRef.current = {
            startIndex: Math.max(0, nextStart),
            endIndex: Math.min(loaded.length - 1, prevEnd),
          };
          bumpViewportSliceTick();
          logMessagesScrollAction("prepend_merge_applied", {
            addedCount: 0,
            nextHeadAfter,
            headBeforeLoad,
            grewViaCache,
            grewViaMerge,
          });
        } else {
          pendingItemAnchorRef.current = null;
        }
        const nextCursor =
          result.nextBeforeMessageId ??
          Math.min(...result.messages.map((row) => row.telegram_message_id));
        if (nextCursor != null && nextCursor < beforeMessageId) {
          loadOlderAdvanceChainRef.current = false;
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
      bumpViewportSliceTick();
      logMessagesScrollAction("prepend_merge_applied", {
        addedCount,
        nextHeadAfter,
        headBeforeLoad,
      });
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
      olderLoadInFlightBeforeIdRef.current = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isReplacingHistoryRef.current = false;
        });
      });
      scrollControllerRef.current?.clearNearTopLatch();
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    hasMoreOlder,
    applyOlderPaginationCursor,
    historyMessageContext,
    logMessagesScrollAction,
    capturePrependItemAnchor,
    mergeHistoryWithWindow,
    loadingInitial,
    releaseOlderLoadViewportLock,
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

  const tryTriggerOlderHistoryLoad = useCallback(() => {
    if (isReplacingHistoryRef.current) return;
    if (initialScrollInProgressRef.current) return;
    if (loadingOlderRef.current || loadingNewerRef.current) return;
    if (pendingItemAnchorRef.current) return;
    if (!chatScrollPaintReadyRef.current || loadingInitial) return;
    if (Date.now() - lastOlderLoadFinishedAtRef.current < LOAD_OLDER_PAGE_COOLDOWN_MS) {
      return;
    }

    const loaded = loadedMessagesRef.current;
    const display = displayMessagesRef.current;
    if (display.length === 0) return;

    const displayHeadId = display[0]!.telegram_message_id;
    const loadedHeadId = loaded.length > 0 ? loaded[0]!.telegram_message_id : 0;
    if (
      viewportAtLoadedTopRef.current &&
      hasMoreOlderRef.current &&
      (displayHeadId <= 0 ||
        loadedHeadId <= 0 ||
        displayHeadId <= loadedHeadId)
    ) {
      void loadOlderMessages();
      return;
    }
    if (displayHeadId > 0 && loadedHeadId > 0 && displayHeadId > loadedHeadId) {
      expandDisplaySliceTowardOlder();
      return;
    }
    if (
      !viewportAtLoadedTopRef.current &&
      displaySliceBoundsRef.current.startIndex > 0
    ) {
      expandDisplaySliceTowardOlder();
      return;
    }
    if (!hasMoreOlderRef.current) return;
    void loadOlderMessages();
  }, [expandDisplaySliceTowardOlder, loadOlderMessages, loadingInitial]);

  useEffect(() => {
    tryTriggerOlderHistoryLoadRef.current = tryTriggerOlderHistoryLoad;
  }, [tryTriggerOlderHistoryLoad]);

  const triggerLoadOlderFromSentinel = useCallback(() => {
    tryTriggerOlderHistoryLoad();
  }, [tryTriggerOlderHistoryLoad]);

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
      if (followingBottomRef.current) return 0;
      return Math.max(serverUnread, openingUnread);
    }

    const nearBottom = isChatScrollNearBottom(
      metrics.scrollY,
      metrics.layoutH,
      metrics.contentH,
    );

    if (followingBottomRef.current && atChatTail && nearBottom) {
      return 0;
    }

    const layoutMap = resolveScrollLayoutMap(metrics);
    const readCursor = lastReadInboxMessageIdRef.current;
    const belowViewport = nearBottom
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

    if (belowViewport > 0) return belowViewport;

    // Scrolled up through read history — arrow-only FAB, no stale server badge.
    if (!nearBottom) return 0;

    // Near bottom: only show a badge for not-yet-loaded newer tail when server still reports unreads.
    if (!atChatTail && serverUnread > 0) return serverUnread;

    return 0;
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
        skipInitialTopReset
        nearTopThresholdPx={MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX}
        onNearTop={tryTriggerOlderHistoryLoad}
        onScrollPositionChange={handleScrollPositionChange}
        onUserScrollIntent={markUserScrollInteraction}
        onMetricsChange={handleOpenScrollMetrics}
        scrollControllerRef={scrollControllerRef}
        preserveViewportOnResize={chatScrollPaintReady && !prependAnchorRestorePending}
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
