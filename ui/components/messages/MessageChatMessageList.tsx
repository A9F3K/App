import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { HspScrollColumn, type HspScrollAnchor, type HspScrollColumnHandle, type HspScrollMetrics } from "../HspScrollColumn";
import {
  MESSAGE_BUBBLE_ROW_GAP_PX,
  MESSAGE_CHAT_BODY_PADDING_PX,
  MESSAGE_CHAT_HISTORY_LIVE_TAIL_SIZE,
  MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
  MESSAGE_CHAT_LOAD_NEWER_THRESHOLD_PX,
  MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX,
} from "./messageChatLayout";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import { patchAuthenticatedHomeSelectedChatReadOutbox, patchAuthenticatedHomeSelectedChatGroupMeta, bumpAuthenticatedHomeSelectedChatUnread, patchAuthenticatedHomeSelectedChatUnread, setAuthenticatedHomeOpenChatFollowingBottom } from "../../authenticatedHomeSelectedChat";
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
import { MessageChatScrollToBottomButton } from "./MessageChatScrollToBottomButton";
import { resolveChatOpenScrollPlan } from "./resolveChatOpenScrollPlan";
import { prefetchOpenChatAvatars, setOpenChatAvatarPriority, isOpenChatAvatarPriority } from "./messageChatAvatarPrefetch";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  collectFullyVisibleUnreadMessageIds,
  computeRemainingUnreadCount,
  formatScrollToBottomUnreadCountLabel,
  isAtLoadedChatTail,
  maxFullyVisibleMessageId,
  topViewportAnchorMessageId,
  type MessageScrollLayoutEntry,
} from "./messageListLayout";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
};

const MESSAGE_CHAT_LIVE_POLL_MS = 3_000;
const MESSAGE_CHAT_LIVE_POLL_STREAM_FALLBACK_MS = 30_000;
const CHAT_HISTORY_STREAM_ENABLED = typeof EventSource !== "undefined";
/** User must scroll up this far before older history loads after reopen. */
const LOAD_OLDER_SCROLL_UP_THRESHOLD_PX = 40;
/** User must scroll down this far before newer history loads after reopen. */
const LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX = 40;

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

function countNewerTailMessages(
  messages: readonly MessageChatHistoryItem[],
  afterMessageId: number,
): number {
  if (afterMessageId <= 0) return 0;
  let count = 0;
  for (const row of messages) {
    if (row.telegram_message_id > afterMessageId) count += 1;
  }
  return count;
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
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [nextBeforeMessageId, setNextBeforeMessageId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReadOutboxFromHistory, setLastReadOutboxFromHistory] = useState<number | null>(null);
  const [selfUserId, setSelfUserId] = useState<number | null>(null);
  const [columnWidthPx, setColumnWidthPx] = useState(0);
  const openScrollPlan = useMemo(
    () => resolveChatOpenScrollPlan(chat),
    [chat.telegram_chat_id, historyLoad.generation],
  );
  const [isFollowingBottom, setIsFollowingBottom] = useState(
    () => openScrollPlan.followingBottom,
  );
  const [initialScrollInProgress, setInitialScrollInProgress] = useState(false);
  const [chatScrollPaintReady, setChatScrollPaintReady] = useState(false);
  const scrollControllerRef = useRef<HspScrollColumnHandle | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const nextBeforeMessageIdRef = useRef<number | null>(null);
  const pendingScrollAnchorRef = useRef<HspScrollAnchor | null>(null);
  const pendingScrollRestoreRef = useRef<CachedChatScrollPosition | null>(null);
  const pendingPreserveScrollYRef = useRef<number | null>(null);
  const pinnedScrollYRef = useRef(0);
  const pendingInitialScrollRef = useRef(false);
  const followingBottomRef = useRef(openScrollPlan.followingBottom);
  const allowUnreadResetAtBottomRef = useRef(false);
  const initialScrollInProgressRef = useRef(false);
  const openingUnreadCountRef = useRef(0);
  const fullyReadUnreadIdsRef = useRef<Set<number>>(new Set());
  const unreadMarkingArmedRef = useRef(false);
  const unreadMarkingArmPendingRef = useRef(false);
  const unreadViewportBaselineMessageIdRef = useRef(0);
  const chatTailMessageIdRef = useRef<number | null>(null);
  const openScrollAnchorRef = useRef<"top" | "bottom">("bottom");
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
  const lastAvatarPrefetchSignatureRef = useRef("");
  const saveScrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevContentHForBottomStickRef = useRef(0);
  const historySyncKeyRef = useRef("");
  const chatScrollPaintReadyRef = useRef(false);
  const messageLayoutsRef = useRef<Map<number, MessageScrollLayoutEntry>>(new Map());
  const displayMessagesRef = useRef<MessageChatHistoryItem[]>([]);
  const syncScrollBelowUnreadRef = useRef<(metrics: HspScrollMetrics) => void>(() => {});
  const loadOlderEnabledRef = useRef(false);
  const loadNewerEnabledRef = useRef(false);
  const openScrollOlderGateYRef = useRef(0);
  const openScrollNewerGateYRef = useRef(0);
  const lastPagedLoadEnableGenerationRef = useRef(0);
  const chatLiveSignatureValue = chatLiveSignature(chat);
  const historyMessageContext = useMemo(
    (): HistoryMessageContext => ({
      peerUserId: chat.peer_user_id,
      selfUserId,
    }),
    [chat.peer_user_id, selfUserId],
  );

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
    pendingInitialScrollRef.current = plan.pendingInitialScroll;
    pendingScrollRestoreRef.current = plan.pendingScrollRestore;
    followingBottomRef.current = plan.followingBottom;
    setIsFollowingBottom(plan.followingBottom);
    setAuthenticatedHomeOpenChatFollowingBottom(plan.followingBottom);
    initialScrollInProgressRef.current = plan.pendingInitialScroll;
    setInitialScrollInProgress(plan.pendingInitialScroll);

    if (chatChanged) {
      lastPagedLoadEnableGenerationRef.current = 0;
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastDisplayMessageIdRef.current = 0;
      prevDisplayLengthRef.current = 0;
      prevDisplayLastIdRef.current = 0;
      lastAppliedCacheSignatureRef.current = "";
      lastAvatarPrefetchSignatureRef.current = "";
      messageLayoutsRef.current.clear();
      fullyReadUnreadIdsRef.current.clear();
      unreadMarkingArmedRef.current = false;
      unreadViewportBaselineMessageIdRef.current = 0;
      allowUnreadResetAtBottomRef.current = false;
      setChatScrollPaintReady(false);
      chatScrollPaintReadyRef.current = false;
      prevContentHForBottomStickRef.current = 0;
      loadOlderEnabledRef.current = false;
      loadNewerEnabledRef.current = false;
      openScrollOlderGateYRef.current = 0;
      openScrollNewerGateYRef.current = 0;
    } else if (generationChanged) {
      lastPagedLoadEnableGenerationRef.current = 0;
      lastLiveSignatureRef.current = "";
      lastMessageTailSigRef.current = "";
      lastAppliedCacheSignatureRef.current = "";
      fullyReadUnreadIdsRef.current.clear();
      unreadMarkingArmedRef.current = false;
      unreadViewportBaselineMessageIdRef.current = 0;
      allowUnreadResetAtBottomRef.current = false;
      loadOlderEnabledRef.current = false;
      loadNewerEnabledRef.current = false;
      setChatScrollPaintReady(false);
      chatScrollPaintReadyRef.current = false;
    }
  }, [chat.telegram_chat_id, historyLoad.generation]);

  useEffect(() => {
    const tailId = chat.last_message_telegram_id;
    if (tailId != null && Number.isFinite(tailId) && tailId > 0) {
      chatTailMessageIdRef.current = tailId;
    }
  }, [chat.last_message_telegram_id]);

  useEffect(() => {
    if ((chat.unread_count ?? 0) > openingUnreadCountRef.current) {
      openingUnreadCountRef.current = chat.unread_count ?? 0;
      if (!unreadMarkingArmedRef.current) {
        unreadMarkingArmPendingRef.current = true;
      }
    }
  }, [chat.unread_count]);

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

  const scrollToBottom = useCallback(() => {
    scrollControllerRef.current?.scrollToEnd();
    followingBottomRef.current = true;
    setIsFollowingBottom(true);
    allowUnreadResetAtBottomRef.current = true;
    setAuthenticatedHomeOpenChatFollowingBottom(true);
    openingUnreadCountRef.current = 0;
    fullyReadUnreadIdsRef.current.clear();
    unreadMarkingArmedRef.current = false;
    unreadMarkingArmPendingRef.current = false;
    unreadViewportBaselineMessageIdRef.current = 0;
    patchAuthenticatedHomeSelectedChatUnread(0);
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
      loadOlderEnabledRef.current = enableImmediately;
      loadNewerEnabledRef.current = enableImmediately;
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

  const tryArmUnreadMarking = useCallback((metrics: HspScrollMetrics): boolean => {
    if (!unreadMarkingArmPendingRef.current || unreadMarkingArmedRef.current) {
      return unreadMarkingArmedRef.current;
    }
    if (openingUnreadCountRef.current <= 0) {
      unreadMarkingArmPendingRef.current = false;
      return false;
    }
    if (metrics.contentH <= 0 || metrics.layoutH <= 0) return false;

    const anchorId = topViewportAnchorMessageId(
      displayMessagesRef.current,
      messageLayoutsRef.current,
      metrics,
    );
    let baselineExclusive = 0;
    if (anchorId != null && anchorId > 0) {
      baselineExclusive = anchorId - 1;
    } else {
      const maxVisibleId = maxFullyVisibleMessageId(
        displayMessagesRef.current,
        messageLayoutsRef.current,
        metrics,
      );
      if (maxVisibleId <= 0) return false;
      baselineExclusive = maxVisibleId - 1;
    }

    unreadViewportBaselineMessageIdRef.current = Math.max(0, baselineExclusive);
    unreadMarkingArmedRef.current = true;
    unreadMarkingArmPendingRef.current = false;
    return true;
  }, []);

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
      if (!isScrollNearBottom(metrics)) return false;
      return isAtLoadedChatTail(loadedDisplayTailId(), chatTailMessageIdRef.current);
    },
    [isScrollNearBottom, loadedDisplayTailId],
  );

  const tryUnlockPagedLoad = useCallback((metrics: HspScrollMetrics) => {
    if (!loadOlderEnabledRef.current) {
      const olderGateY = openScrollOlderGateYRef.current;
      if (
        olderGateY > 0 &&
        (metrics.scrollY < olderGateY - LOAD_OLDER_SCROLL_UP_THRESHOLD_PX ||
          metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX)
      ) {
        loadOlderEnabledRef.current = true;
      }
    }
    if (!loadNewerEnabledRef.current) {
      const newerGateY = openScrollNewerGateYRef.current;
      if (
        newerGateY > 0 &&
        (metrics.scrollY > newerGateY + LOAD_NEWER_SCROLL_DOWN_THRESHOLD_PX ||
          isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH))
      ) {
        loadNewerEnabledRef.current = true;
      }
    }
  }, []);

  const handleScrollPositionChange = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0) return;
      pinnedScrollYRef.current = metrics.scrollY;
      const nearBottom = isScrollNearBottom(metrics);

      tryUnlockPagedLoad(metrics);

      if (initialScrollInProgressRef.current) {
        if (
          followingBottomRef.current &&
          openingUnreadCountRef.current <= 0 &&
          metrics.contentH > prevContentHForBottomStickRef.current + 2
        ) {
          prevContentHForBottomStickRef.current = metrics.contentH;
          scrollToBottom();
        } else {
          prevContentHForBottomStickRef.current = metrics.contentH;
        }
        const markingReady = tryArmUnreadMarking(metrics);
        if (nearBottom && openingUnreadCountRef.current <= 0) {
          initialScrollInProgressRef.current = false;
          setInitialScrollInProgress(false);
          followingBottomRef.current = true;
          setIsFollowingBottom(true);
          setAuthenticatedHomeOpenChatFollowingBottom(true);
          allowUnreadResetAtBottomRef.current = true;
          patchAuthenticatedHomeSelectedChatUnread(0);
        } else if (openingUnreadCountRef.current > 0 && markingReady) {
          syncScrollBelowUnreadRef.current(metrics);
        }
        return;
      }

      if (
        followingBottomRef.current &&
        openingUnreadCountRef.current <= 0 &&
        metrics.contentH > prevContentHForBottomStickRef.current + 2
      ) {
        prevContentHForBottomStickRef.current = metrics.contentH;
        scrollToBottom();
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
          if (openingUnreadCountRef.current <= 0) {
            patchAuthenticatedHomeSelectedChatUnread(0);
          } else if (markingReady) {
            syncScrollBelowUnreadRef.current(metrics);
          }
        } else if (markingReady) {
          syncScrollBelowUnreadRef.current(metrics);
        }
      } else if (openingUnreadCountRef.current > 0 && markingReady) {
        syncScrollBelowUnreadRef.current(metrics);
      }

      if (saveScrollDebounceRef.current) {
        clearTimeout(saveScrollDebounceRef.current);
      }
      saveScrollDebounceRef.current = setTimeout(() => {
        saveScrollDebounceRef.current = null;
        persistChatScrollPosition(metrics);
      }, 300);
    },
    [
      tryArmUnreadMarking,
      tryUnlockPagedLoad,
      isScrollNearBottom,
      persistChatScrollPosition,
      resolveEffectiveFollowingBottom,
      scrollToBottom,
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
      followingBottomRef.current = isChatScrollNearBottom(
        targetY,
        metrics.layoutH,
        metrics.contentH,
      );
      setIsFollowingBottom(followingBottomRef.current);
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

    if (state.followingBottom) {
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
          return cached.messages;
        });
      } else {
        setMessages((prev) => {
          const merged = mergeHistoryMessages(prev, cached.messages, historyMessageContext);
          if (historyTailSignature(merged) === historyTailSignature(prev)) return prev;
          return merged;
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
      setLoadingInitial(false);
      setError(null);
    },
    [chat.telegram_chat_id, historyMessageContext],
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
    }
  }, [displayMessages]);

  const syncScrollBelowUnread = useCallback(
    (metrics: HspScrollMetrics) => {
      if (metrics.contentH <= 0 || metrics.layoutH <= 0) return;
      const openingUnread = openingUnreadCountRef.current;
      if (openingUnread <= 0) return;
      if (!unreadMarkingArmedRef.current) return;

      const newlyRead = collectFullyVisibleUnreadMessageIds(
        displayMessagesRef.current,
        messageLayoutsRef.current,
        metrics,
        unreadViewportBaselineMessageIdRef.current,
        fullyReadUnreadIdsRef.current,
      );
      for (const id of newlyRead) {
        fullyReadUnreadIdsRef.current.add(id);
      }

      const remaining = computeRemainingUnreadCount(
        openingUnread,
        fullyReadUnreadIdsRef.current,
      );

      const nearBottom = isScrollNearBottom(metrics);
      const atTrueTail = isAtLoadedChatTail(
        loadedDisplayTailId(),
        chatTailMessageIdRef.current,
      );
      if (
        remaining === 0 &&
        nearBottom &&
        atTrueTail &&
        allowUnreadResetAtBottomRef.current
      ) {
        patchAuthenticatedHomeSelectedChatUnread(0);
        return;
      }

      const chatTailId = chatTailMessageIdRef.current;
      const loadedTailId =
        displayMessagesRef.current[displayMessagesRef.current.length - 1]
          ?.telegram_message_id ?? 0;
      if (
        remaining === 0 &&
        chatTailId != null &&
        chatTailId > 0 &&
        loadedTailId > 0 &&
        loadedTailId < chatTailId
      ) {
        return;
      }

      const currentUnread = Math.max(
        0,
        Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
      );
      if (newlyRead.length > 0 || remaining !== currentUnread) {
        logPageDisplay("messages_scroll_unread_sync", {
          ...chatLogFields({
            chatId: chat.telegram_chat_id,
            peerUserId: chat.peer_user_id,
            title: chat.title,
          }),
          openingUnread,
          newlyRead: newlyRead.length,
          fullyRead: fullyReadUnreadIdsRef.current.size,
          remaining,
          baseline: unreadViewportBaselineMessageIdRef.current,
        });
      }
      if (remaining > currentUnread) return;
      patchAuthenticatedHomeSelectedChatUnread(remaining);
    },
    [chat.telegram_chat_id, chat.peer_user_id, chat.title, chat.unread_count, isScrollNearBottom, loadedDisplayTailId],
  );

  useEffect(() => {
    syncScrollBelowUnreadRef.current = syncScrollBelowUnread;
  }, [syncScrollBelowUnread]);

  useEffect(() => {
    if (openingUnreadCountRef.current <= 0) return;
    if (!unreadMarkingArmPendingRef.current && !unreadMarkingArmedRef.current) {
      return;
    }
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return;
    if (tryArmUnreadMarking(metrics) || unreadMarkingArmedRef.current) {
      syncScrollBelowUnread(metrics);
    }
  }, [displayMessagesLayoutSig, syncScrollBelowUnread, tryArmUnreadMarking]);

  const handleMessageLayout = useCallback((messageId: number, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    messageLayoutsRef.current.set(messageId, { y, height });
    const metrics = scrollControllerRef.current?.getMetrics();
    if (!metrics || metrics.contentH <= 0) return;
    if (tryArmUnreadMarking(metrics)) {
      syncScrollBelowUnreadRef.current(metrics);
      return;
    }
    if (unreadMarkingArmedRef.current) {
      syncScrollBelowUnreadRef.current(metrics);
    }
  }, [tryArmUnreadMarking]);

  const lastDisplayMessageId =
    displayMessages.length > 0
      ? displayMessages[displayMessages.length - 1]!.telegram_message_id
      : 0;

  useEffect(() => {
    chatScrollPaintReadyRef.current = chatScrollPaintReady;
  }, [chatScrollPaintReady]);

  const revealChatScroll = useCallback(() => {
    if (chatScrollPaintReadyRef.current) return;
    chatScrollPaintReadyRef.current = true;
    setChatScrollPaintReady(true);
  }, []);

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
      initialScrollInProgressRef.current = false;
      setInitialScrollInProgress(false);
      revealChatScroll();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const settledMetrics = scrollControllerRef.current?.getMetrics();
          if (settledMetrics && settledMetrics.contentH > 0) {
            enablePagedLoadAfterOpenSettle(settledMetrics, false);
            if (tryArmUnreadMarking(settledMetrics)) {
              syncScrollBelowUnreadRef.current(settledMetrics);
            }
          }
        });
      });
      return true;
    }

    if (pendingInitialScrollRef.current) {
      pendingInitialScrollRef.current = false;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      const metrics = scrollControllerRef.current?.getMetrics();
      if (!metrics || metrics.layoutH <= 0 || metrics.contentH <= 0) return false;
      settleOpenBottomScroll();
      revealChatScroll();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const settledMetrics = scrollControllerRef.current?.getMetrics();
          if (settledMetrics && settledMetrics.contentH > 0) {
            enablePagedLoadAfterOpenSettle(settledMetrics, true);
            if (tryArmUnreadMarking(settledMetrics)) {
              syncScrollBelowUnreadRef.current(settledMetrics);
            }
          }
        });
      });
      return true;
    }

    if (!chatScrollPaintReadyRef.current) revealChatScroll();
    return true;
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    loadingInitial,
    restoreChatScrollPosition,
    revealChatScroll,
    settleOpenBottomScroll,
    tryArmUnreadMarking,
    enablePagedLoadAfterOpenSettle,
  ]);

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
        openScrollAnchorRef.current === "bottom" &&
        openingUnreadCountRef.current <= 0 &&
        followingBottomRef.current;
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
      if (chatScrollPaintReadyRef.current) return;
      if (metrics.layoutH <= 0) return;
      if (displayMessages.length === 0 && !loadingInitial) {
        revealChatScroll();
        return;
      }
      if (displayMessages.length === 0) return;
      if (!trySettleOpenChatScroll() && metrics.contentH > 0) {
        revealChatScroll();
      }
    },
    [displayMessages.length, loadingInitial, revealChatScroll, trySettleOpenChatScroll],
  );

  useEffect(() => {
    if (!shouldLoadHistory) return;
    const effectiveChatKind = chatKind ?? chat.chat_kind ?? null;
    const signature = `${chat.telegram_chat_id}:${historyTailSignature(displayMessages)}:${effectiveChatKind ?? ""}`;
    if (signature === lastAvatarPrefetchSignatureRef.current) return;
    lastAvatarPrefetchSignatureRef.current = signature;
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
    lastDisplayMessageId,
    shouldLoadHistory,
  ]);

  useEffect(() => {
    nextBeforeMessageIdRef.current = nextBeforeMessageId;
  }, [nextBeforeMessageId]);

  useEffect(() => {
    lastDisplayMessageIdRef.current = lastDisplayMessageId;
  }, [lastDisplayMessageId]);

  useLayoutEffect(() => {
    if (!chatScrollPaintReadyRef.current) {
      trySettleOpenChatScroll();
    }

    if (displayMessages.length === 0) return;

    if (pendingScrollAnchorRef.current) return;

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
      (newerTail || lengthGrew)
    ) {
      scrollToBottom();
      return;
    }

    if (
      (newerTail || lengthGrew) &&
      !loadingOlderRef.current &&
      !loadingNewerRef.current &&
      !followingBottomRef.current
    ) {
      const added = countNewerTailMessages(displayMessages, prevLastId);
      if (added > 0 && openingUnreadCountRef.current <= 0) {
        bumpAuthenticatedHomeSelectedChatUnread(added);
      }
      const anchor = scrollControllerRef.current?.captureScrollAnchor();
      if (anchor) {
        pendingScrollAnchorRef.current = anchor;
      } else {
        preserveScrollY(pinnedScrollYRef.current);
      }
    }
  }, [
    displayMessages.length,
    lastDisplayMessageId,
    preserveScrollY,
    scrollToBottom,
    trySettleOpenChatScroll,
  ]);

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    scrollControllerRef.current?.restoreScrollAnchor(anchor);
    scrollControllerRef.current?.clearNearTopLatch();
    scrollControllerRef.current?.clearNearBottomLatch();
  }, [messages]);

  useEffect(() => {
    return subscribeOutgoingChatMessages(({ chatId, message }) => {
      if (chatId !== chat.telegram_chat_id) return;
      if (!followingBottomRef.current) {
        const anchor = scrollControllerRef.current?.captureScrollAnchor();
        if (anchor) pendingScrollAnchorRef.current = anchor;
      }
      setMessages((prev) => mergeHistoryMessages(prev, [message], historyMessageContext));
    });
  }, [chat.telegram_chat_id, historyMessageContext]);

  useEffect(() => {
    if (!shouldLoadHistory) return;
    return subscribeChatHistoryCache((chatId) => {
      if (chatId !== chat.telegram_chat_id) return;
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
      if (
        pendingScrollRestoreRef.current == null &&
        !pendingInitialScrollRef.current
      ) {
        chatScrollPaintReadyRef.current = true;
        setChatScrollPaintReady(true);
      }
      return;
    }

    const staleCached = getCachedChatHistory(chat.telegram_chat_id);
    if (staleCached != null && staleCached.messages.length > 0) {
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
      if (staleCached != null && staleCached.messages.length > 0) {
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
          if (cacheHit) {
            setMessages((prev) => mergeHistoryMessages(prev, result.messages, historyMessageContext));
          } else {
            setMessages(result.messages);
          }
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
        if (
          cacheComplete &&
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
          const merged = mergeHistoryMessages(prev, result.messages, historyMessageContext);
          const prevMaxId = prev.length > 0 ? prev[prev.length - 1]!.telegram_message_id : 0;
          const mergedMaxId =
            merged.length > 0 ? merged[merged.length - 1]!.telegram_message_id : 0;
          tailGrew = mergedMaxId > prevMaxId;
          return merged;
        });
        if (tailGrew && !followingBottomRef.current) {
          if (scrollAnchorBeforeMerge) {
            pendingScrollAnchorRef.current = scrollAnchorBeforeMerge;
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
    historyMessageContext,
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
      loadingNewerRef.current ||
      !hasMoreOlder ||
      beforeMessageId == null
    ) {
      return;
    }

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    followingBottomRef.current = false;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    const scrollAnchor = scrollControllerRef.current?.captureScrollAnchor();

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
        setHasMoreOlder(result.hasMoreOlder);
        setNextBeforeMessageId(result.nextBeforeMessageId);
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
      setMessages((prev) => {
        const merged = mergeHistoryMessages(prev, result.messages, historyMessageContext);
        addedCount = merged.length - prev.length;
        return merged;
      });
      if (addedCount === 0) {
        pendingScrollAnchorRef.current = null;
        const nextCursor =
          result.nextBeforeMessageId ??
          Math.min(...result.messages.map((row) => row.telegram_message_id));
        if (nextCursor != null && nextCursor < beforeMessageId) {
          setNextBeforeMessageId(nextCursor);
          setHasMoreOlder(result.hasMoreOlder);
          logPageDisplay("messages_history_load_older_advance_cursor", {
            ...chatLogFields({
              chatId: chat.telegram_chat_id,
              peerUserId: chat.peer_user_id,
              title: chat.title,
            }),
            beforeMessageId,
            nextBeforeMessageId: nextCursor,
            fetchedCount: result.messages.length,
          });
          return;
        }
        setHasMoreOlder(false);
        setNextBeforeMessageId(null);
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
      if (scrollAnchor) {
        pendingScrollAnchorRef.current = scrollAnchor;
      }
      setHasMoreOlder(result.hasMoreOlder);
      setNextBeforeMessageId(result.nextBeforeMessageId);
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
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      scrollControllerRef.current?.clearNearTopLatch();
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    hasMoreOlder,
    historyMessageContext,
    loadingInitial,
  ]);

  const loadNewerMessages = useCallback(async () => {
    const sinceMessageId = lastDisplayMessageIdRef.current;
    if (
      loadingInitial ||
      loadingNewerRef.current ||
      loadingOlderRef.current ||
      sinceMessageId <= 0 ||
      isAtLoadedChatTail(sinceMessageId, chatTailMessageIdRef.current)
    ) {
      return;
    }

    loadingNewerRef.current = true;

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
        MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
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
          MESSAGE_CHAT_HISTORY_NEWER_PAGE_SIZE,
          chat.peer_user_id,
        );
      }

      if (result.error) {
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

      const nearBottomBeforeMerge = (() => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return false;
        return isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH);
      })();

      let addedCount = 0;
      setMessages((prev) => {
        const merged = mergeHistoryMessages(prev, result.messages, historyMessageContext);
        addedCount = merged.length - prev.length;
        return merged;
      });

      if (addedCount === 0) {
        return;
      }

      if (unreadMarkingArmedRef.current) {
        requestAnimationFrame(() => {
          const metrics = scrollControllerRef.current?.getMetrics();
          if (metrics && metrics.contentH > 0) {
            syncScrollBelowUnreadRef.current(metrics);
          }
        });
      }

      if (result.selfUserId != null) {
        setSelfUserId(result.selfUserId);
      }
      setLastReadOutboxFromHistory((prev) =>
        mergeReadOutboxCursor(prev, result.lastReadOutboxMessageId),
      );
      mergeCachedChatHistoryTail(chat.telegram_chat_id, result);

      if (nearBottomBeforeMerge || followingBottomRef.current) {
        scrollToBottom();
      }

      scrollControllerRef.current?.clearNearBottomLatch();

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
    } finally {
      loadingNewerRef.current = false;
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    historyMessageContext,
    loadingInitial,
    scrollToBottom,
  ]);

  const handleNearTop = useCallback(() => {
    const metrics = scrollControllerRef.current?.getMetrics();
    if (metrics && metrics.contentH > 0) {
      tryUnlockPagedLoad(metrics);
      if (
        !loadOlderEnabledRef.current &&
        metrics.scrollY <= MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX
      ) {
        loadOlderEnabledRef.current = true;
      }
    }
    if (!loadOlderEnabledRef.current) return;
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    void loadOlderMessages();
  }, [loadOlderMessages, tryUnlockPagedLoad]);

  const handleNearBottom = useCallback(() => {
    if (!loadNewerEnabledRef.current) return;
    if (
      isAtLoadedChatTail(
        lastDisplayMessageIdRef.current,
        chatTailMessageIdRef.current,
      )
    ) {
      return;
    }
    void loadNewerMessages();
  }, [loadNewerMessages]);

  const hasMoreNewerBelow = !isAtLoadedChatTail(
    lastDisplayMessageId,
    chat.last_message_telegram_id ?? chatTailMessageIdRef.current,
  );

  const openChatUnread = chat.unread_count ?? 0;
  const scrollToBottomUnreadLabel = formatScrollToBottomUnreadCountLabel(
    openChatUnread,
    chat.telegram_chat_id,
  );
  const atTrueChatTail = isAtLoadedChatTail(
    lastDisplayMessageId,
    chat.last_message_telegram_id,
  );
  const showScrollToBottomButton =
    !initialScrollInProgress &&
    Boolean(scrollToBottomUnreadLabel) &&
    (!isFollowingBottom || !atTrueChatTail);

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
      unreadCount: openChatUnread,
      label: scrollToBottomUnreadLabel || null,
    });
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    isFollowingBottom,
    initialScrollInProgress,
    openChatUnread,
    scrollToBottomUnreadLabel,
    shouldLoadHistory,
    showScrollToBottomButton,
  ]);

  const innerWidthPx = Math.max(
    0,
    columnWidthPx - MESSAGE_CHAT_BODY_PADDING_PX * 2,
  );

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
    !chatScrollPaintReady &&
    displayMessages.length > 0 &&
    (pendingInitialScrollRef.current || pendingScrollRestoreRef.current != null);

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
      <MessageChatOlderHistoryLoadLine active={loadingOlder} color={colors.accent} />
      <View style={{ flex: 1, minHeight: 0, opacity: hideScrollUntilSettled ? 0 : 1 }}>
      <HspScrollColumn
        key={`${chat.telegram_chat_id}-${historyLoad.generation}`}
        style={{ flex: 1, minHeight: 0 }}
        indicatorColor={colors.accent}
        scrollbarRightInsetPx={layout.scrollIndicatorRightInsetPx}
        initialScrollPosition={openScrollPlan.openAnchor}
        nearTopThresholdPx={MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX}
        nearBottomThresholdPx={MESSAGE_CHAT_LOAD_NEWER_THRESHOLD_PX}
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

        {displayMessages.map((item, index) => (
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
            />
          </View>
        ))}
      </HspScrollColumn>
      </View>
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
