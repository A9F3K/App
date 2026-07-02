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
  shouldPrefetchHistoryAroundUnread,
} from "../../messageChatHistoryPrefetch";
import {
  getChatScrollPosition,
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
  MESSAGE_CHAT_HISTORY_PAGE_SIZE,
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
import { prefetchOpenChatAvatars, setOpenChatAvatarPriority, isOpenChatAvatarPriority } from "./messageChatAvatarPrefetch";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD,
  formatMessageUnreadCountLabel,
} from "./messageListLayout";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
};

const MESSAGE_CHAT_LIVE_POLL_MS = 3_000;
const MESSAGE_CHAT_LIVE_POLL_STREAM_FALLBACK_MS = 30_000;
const CHAT_HISTORY_STREAM_ENABLED = typeof EventSource !== "undefined";

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
  const [isFollowingBottom, setIsFollowingBottom] = useState(true);
  const [initialScrollInProgress, setInitialScrollInProgress] = useState(false);
  const [initialScrollAnchor, setInitialScrollAnchor] = useState<"top" | "bottom">("bottom");
  const scrollControllerRef = useRef<HspScrollColumnHandle | null>(null);
  const loadingOlderRef = useRef(false);
  const nextBeforeMessageIdRef = useRef<number | null>(null);
  const pendingScrollAnchorRef = useRef<HspScrollAnchor | null>(null);
  const pendingScrollRestoreRef = useRef<CachedChatScrollPosition | null>(null);
  const pendingPreserveScrollYRef = useRef<number | null>(null);
  const pinnedScrollYRef = useRef(0);
  const pendingInitialScrollRef = useRef(false);
  const followingBottomRef = useRef(true);
  const allowUnreadResetAtBottomRef = useRef(false);
  const initialScrollInProgressRef = useRef(false);
  const openingUnreadCountRef = useRef(0);
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

  useEffect(() => {
    lastLiveSignatureRef.current = "";
    lastMessageTailSigRef.current = "";
    lastDisplayMessageIdRef.current = 0;
    prevDisplayLengthRef.current = 0;
    prevDisplayLastIdRef.current = 0;
    lastAppliedCacheSignatureRef.current = "";
    lastAvatarPrefetchSignatureRef.current = "";
    allowUnreadResetAtBottomRef.current = false;
    initialScrollInProgressRef.current = false;
    setInitialScrollInProgress(false);
    openingUnreadCountRef.current = Math.max(
      0,
      Math.trunc(Number.isFinite(chat.unread_count) ? chat.unread_count : 0),
    );
    const openAnchor =
      openingUnreadCountRef.current > MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD
        ? "top"
        : "bottom";
    openScrollAnchorRef.current = openAnchor;
    setInitialScrollAnchor(openAnchor);
    setAuthenticatedHomeOpenChatFollowingBottom(openAnchor === "bottom");

    const cachedScroll = getChatScrollPosition(chat.telegram_chat_id);
    if (cachedScroll) {
      pendingInitialScrollRef.current = false;
      pendingScrollRestoreRef.current = cachedScroll;
      followingBottomRef.current = cachedScroll.followingBottom;
      setIsFollowingBottom(cachedScroll.followingBottom);
      setAuthenticatedHomeOpenChatFollowingBottom(cachedScroll.followingBottom);
      if (!cachedScroll.followingBottom) {
        allowUnreadResetAtBottomRef.current = true;
      }
    } else {
      pendingInitialScrollRef.current = true;
      pendingScrollRestoreRef.current = null;
      const followsBottom = openAnchor === "bottom";
      followingBottomRef.current = followsBottom;
      setIsFollowingBottom(followsBottom);
    }

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
    requestAnimationFrame(() => {
      scrollControllerRef.current?.scrollToEnd();
      requestAnimationFrame(() => scrollControllerRef.current?.scrollToEnd());
    });
    followingBottomRef.current = true;
    setIsFollowingBottom(true);
    allowUnreadResetAtBottomRef.current = true;
    setAuthenticatedHomeOpenChatFollowingBottom(true);
    patchAuthenticatedHomeSelectedChatUnread(0);
  }, []);

  const handleScrollPositionChange = useCallback((metrics: HspScrollMetrics) => {
    if (metrics.contentH <= 0) return;
    pinnedScrollYRef.current = metrics.scrollY;
    const contentOverflows = metrics.contentH > metrics.layoutH + 0.5;
    const nearBottom = contentOverflows
      ? isChatScrollNearBottom(metrics.scrollY, metrics.layoutH, metrics.contentH)
      : openScrollAnchorRef.current === "bottom";

    if (initialScrollInProgressRef.current) {
      if (nearBottom) {
        initialScrollInProgressRef.current = false;
        setInitialScrollInProgress(false);
        allowUnreadResetAtBottomRef.current = true;
        followingBottomRef.current = true;
        setIsFollowingBottom(true);
        setAuthenticatedHomeOpenChatFollowingBottom(true);
        patchAuthenticatedHomeSelectedChatUnread(0);
      }
      return;
    }

    followingBottomRef.current = nearBottom;
    setIsFollowingBottom((current) => (current === nearBottom ? current : nearBottom));
    setAuthenticatedHomeOpenChatFollowingBottom(nearBottom);
    if (!nearBottom) {
      allowUnreadResetAtBottomRef.current = true;
      return;
    }
    if (allowUnreadResetAtBottomRef.current) {
      patchAuthenticatedHomeSelectedChatUnread(0);
    }
  }, []);

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

  const restoreChatScrollPosition = useCallback(
    (state: CachedChatScrollPosition) => {
      let attempts = 0;
      const maxAttempts = 12;

      const tryRestore = (): boolean => {
        const metrics = scrollControllerRef.current?.getMetrics();
        if (!metrics || metrics.contentH <= 0 || metrics.layoutH <= 0) return false;

        if (state.followingBottom) {
          scrollToBottom();
          return true;
        }

        const maxScroll = Math.max(0, metrics.contentH - metrics.layoutH);
        const targetY = Math.min(Math.max(0, state.scrollY), maxScroll);
        scrollControllerRef.current?.scrollToY(targetY);
        followingBottomRef.current = isChatScrollNearBottom(
          targetY,
          metrics.layoutH,
          metrics.contentH,
        );
        setIsFollowingBottom(followingBottomRef.current);
        if (!followingBottomRef.current) {
          allowUnreadResetAtBottomRef.current = true;
        }
        return true;
      };

      const run = () => {
        if (tryRestore() || ++attempts >= maxAttempts) return;
        requestAnimationFrame(run);
      };

      requestAnimationFrame(() => {
        run();
        requestAnimationFrame(run);
      });
    },
    [scrollToBottom],
  );

  const applyCachedHistoryPage = useCallback(
    (cached: NonNullable<ReturnType<typeof getCachedChatHistory>>, options?: { replace?: boolean }) => {
      const replace = options?.replace !== false;
      const cachedMaxId =
        cached.messages.length > 0
          ? cached.messages[cached.messages.length - 1]!.telegram_message_id
          : 0;
      const cacheSignature = `${cached.fetchedAt}:${cached.messages.length}:${cachedMaxId}:${cached.previewOnly ? 1 : 0}:${cached.aroundUnread ? 1 : 0}`;
      if (!replace && cacheSignature === lastAppliedCacheSignatureRef.current) {
        return;
      }
      if (replace) {
        setMessages(cached.messages);
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
  }, [chat, chatKind, messages, readOutboxCursor]);

  const lastDisplayMessageId =
    displayMessages.length > 0
      ? displayMessages[displayMessages.length - 1]!.telegram_message_id
      : 0;

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
    if (displayMessages.length === 0) return;

    if (pendingScrollRestoreRef.current) {
      const state = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      restoreChatScrollPosition(state);
      return;
    }

    if (pendingScrollAnchorRef.current) return;

    if (pendingPreserveScrollYRef.current != null) {
      const scrollY = pendingPreserveScrollYRef.current;
      pendingPreserveScrollYRef.current = null;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      preserveScrollY(scrollY);
      return;
    }

    if (pendingInitialScrollRef.current) {
      pendingInitialScrollRef.current = false;
      prevDisplayLengthRef.current = displayMessages.length;
      prevDisplayLastIdRef.current = lastDisplayMessageId;
      const openingUnread = openingUnreadCountRef.current;
      if (openingUnread > MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD) {
        followingBottomRef.current = false;
        setIsFollowingBottom(false);
        allowUnreadResetAtBottomRef.current = true;
        setAuthenticatedHomeOpenChatFollowingBottom(false);
        return;
      }
      initialScrollInProgressRef.current = true;
      setInitialScrollInProgress(true);
      if (openScrollAnchorRef.current === "bottom") {
        scrollToBottom();
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const metrics = scrollControllerRef.current?.getMetrics();
            if (metrics) handleScrollPositionChange(metrics);
          });
        });
      }
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
      !loadingOlderRef.current &&
      (newerTail || lengthGrew)
    ) {
      scrollToBottom();
      return;
    }

    if (
      (newerTail || lengthGrew) &&
      !loadingOlderRef.current &&
      !followingBottomRef.current
    ) {
      const added = countNewerTailMessages(displayMessages, prevLastId);
      if (added > 0) {
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
    restoreChatScrollPosition,
    scrollToBottom,
    handleScrollPositionChange,
  ]);

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    scrollControllerRef.current?.restoreScrollAnchor(anchor);
    scrollControllerRef.current?.clearNearTopLatch();
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
          shouldPrefetchHistoryAroundUnread(chat),
        )
      ) {
        return;
      }
      const cachedMaxId =
        cached.messages[cached.messages.length - 1]?.telegram_message_id ?? 0;
      const cacheSignature = `${cached.fetchedAt}:${cached.messages.length}:${cachedMaxId}:${cached.previewOnly ? 1 : 0}:${cached.aroundUnread ? 1 : 0}`;
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

    const aroundUnread = shouldPrefetchHistoryAroundUnread(chat);
    const cached = getCachedChatHistory(chat.telegram_chat_id);
    const cacheHit =
      cached != null &&
      cached.messages.length > 0 &&
      isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, aroundUnread);

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
      setLoadingInitial(true);
      setMessages([]);
      setChatKind(null);
      setHasMoreOlder(false);
      setNextBeforeMessageId(null);
      setLastReadOutboxFromHistory(null);
      setSelfUserId(null);
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
            aroundUnread,
          });
          setMessages(result.messages);
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
          isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, aroundUnread)
        ) {
          return;
        }

        const previewFresh =
          cacheHit &&
          cached!.previewOnly &&
          isChatHistoryCacheFresh(chat.telegram_chat_id, PREVIEW_FRESH_MS) &&
          isChatHistoryCacheAnchorMatch(chat.telegram_chat_id, aroundUnread);

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

        await runNetworkLoad();
      } catch {
        /* runNetworkLoad handles errors */
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
    }
  }, [
    chat.peer_user_id,
    chat.telegram_chat_id,
    chat.title,
    hasMoreOlder,
    historyMessageContext,
    loadingInitial,
  ]);

  const handleNearTop = useCallback(() => {
    followingBottomRef.current = false;
    setIsFollowingBottom(false);
    allowUnreadResetAtBottomRef.current = true;
    setAuthenticatedHomeOpenChatFollowingBottom(false);
    void loadOlderMessages();
  }, [loadOlderMessages]);

  const openChatUnread = chat.unread_count ?? 0;
  const scrollToBottomUnreadLabel = formatMessageUnreadCountLabel(
    openChatUnread,
    chat.telegram_chat_id,
  );
  const showScrollToBottomButton =
    !initialScrollInProgress &&
    !isFollowingBottom &&
    openChatUnread > MESSAGE_CHAT_SCROLL_TO_BOTTOM_UNREAD_THRESHOLD &&
    Boolean(scrollToBottomUnreadLabel);

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
      <HspScrollColumn
        key={`${chat.telegram_chat_id}-${historyLoad.generation}`}
        style={{ flex: 1, minHeight: 0 }}
        indicatorColor={colors.accent}
        scrollbarRightInsetPx={layout.scrollIndicatorRightInsetPx}
        initialScrollPosition={initialScrollAnchor}
        nearTopThresholdPx={MESSAGE_CHAT_LOAD_OLDER_THRESHOLD_PX}
        onNearTop={hasMoreOlder ? handleNearTop : undefined}
        onScrollPositionChange={handleScrollPositionChange}
        scrollControllerRef={scrollControllerRef}
        contentContainerStyle={{
          padding: MESSAGE_CHAT_BODY_PADDING_PX,
        }}
      >
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
          <View key={item.telegram_message_id}>
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
