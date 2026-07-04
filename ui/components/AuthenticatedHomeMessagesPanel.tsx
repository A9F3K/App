import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { buildApiUrl } from "../../api/_base";
import { normalizeFormattedTextSegments, type FormattedTextSegment } from "../../shared/formattedTextSegments";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { logPageDisplay, firstChatListLogFields, chatLogFields } from "../pageDisplayLog";
import { layout, type ThemeColors } from "../theme";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import {
  clearAuthenticatedHomeSelectedChat,
  openAuthenticatedHomeChatHistory,
  resolveAuthenticatedHomeOpenChatUnread,
  syncAuthenticatedHomeSelectedChat,
  useAuthenticatedHomeSelectedChat,
} from "../authenticatedHomeSelectedChat";
import { prefetchChatHistory } from "../messageChatHistoryPrefetch";
import { getCachedChatHistory } from "../messageChatHistoryCache";
import { MessageChatRow, type MessageChatRowData, type MessageChatKind } from "./messages/MessageChatRow";
import { MessageChatOlderHistoryLoadLine } from "./messages/MessageChatOlderHistoryLoadLine";
import { ChatListBottomSentinel } from "./messages/ChatListBottomSentinel";
import {
  setChatListSyncStatus,
  type ChatListSyncStatus,
} from "./messages/chatListSyncStatus";
import {
  CHAT_LIST_INITIAL_SYNC_LIMIT,
  useChatListViewport,
} from "../hooks/useChatListViewport";
import { telegramEmojiDebug } from "./messages/telegramEmojiDebug";
import { homeListShellStyle } from "./messages/messageListLayout";
import { useTelegramMessagesChatListStream } from "./messages/useTelegramMessagesChatListStream";

type Props = {
  colors: ThemeColors;
  scrollable?: boolean;
};

function normalizeChatKind(raw: unknown): MessageChatKind | null {
  if (raw === "private" || raw === "group" || raw === "supergroup" || raw === "channel") {
    return raw;
  }
  return null;
}

function normalizeChat(raw: unknown): MessageChatRowData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  const telegramChatId = Number(row.telegram_chat_id);
  if (!Number.isFinite(id) || !Number.isFinite(telegramChatId)) return null;
  const title = typeof row.title === "string" ? row.title : "";
  const subtitle = typeof row.subtitle === "string" ? row.subtitle : "";
  const avatarUrl = typeof row.avatar_url === "string" ? row.avatar_url : null;
  const lastAt =
    typeof row.last_message_at === "string" || typeof row.last_message_at === "number"
      ? row.last_message_at
      : null;
  const unread = Number(row.unread_count);
  const peerUserId = Number(row.peer_user_id);
  const peerUsername =
    typeof row.peer_username === "string" && row.peer_username.trim()
      ? row.peer_username.trim().replace(/^@+/, "")
      : null;
  const chatUsername =
    typeof row.chat_username === "string" && row.chat_username.trim()
      ? row.chat_username.trim().replace(/^@+/, "")
      : null;
  const memberCount = Number(row.member_count);
  const presenceKindRaw = row.presence_kind;
  const presenceKind =
    presenceKindRaw === "online" ||
    presenceKindRaw === "recently" ||
    presenceKindRaw === "last_week" ||
    presenceKindRaw === "last_month" ||
    presenceKindRaw === "offline"
      ? presenceKindRaw
      : null;
  const presenceAt =
    typeof row.presence_at === "string" || typeof row.presence_at === "number"
      ? String(row.presence_at)
      : null;
  const chatActionRaw = row.chat_action;
  const chatAction =
    chatActionRaw === "typing" ||
    chatActionRaw === "recording_voice" ||
    chatActionRaw === "recording_video" ||
    chatActionRaw === "uploading_photo" ||
    chatActionRaw === "uploading_video" ||
    chatActionRaw === "uploading_file"
      ? chatActionRaw
      : null;
  const chatActionUserId = Number(row.chat_action_user_id);
  const chatActionUserName =
    typeof row.chat_action_user_name === "string" ? row.chat_action_user_name : null;
  const chatActionExpiresAt =
    typeof row.chat_action_expires_at === "string" || typeof row.chat_action_expires_at === "number"
      ? String(row.chat_action_expires_at)
      : null;
  return {
    id,
    telegram_chat_id: telegramChatId,
    title,
    subtitle,
    subtitle_segments: normalizeFormattedTextSegments(row.subtitle_segments),
    avatar_url: avatarUrl,
    last_message_at: lastAt == null ? null : String(lastAt),
    unread_count: Number.isFinite(unread) ? unread : 0,
    peer_user_id: Number.isFinite(peerUserId) ? peerUserId : null,
    peer_username: peerUsername,
    chat_username: chatUsername,
    chat_kind: normalizeChatKind(row.chat_kind),
    member_count: Number.isFinite(memberCount) && memberCount > 0 ? Math.trunc(memberCount) : null,
    peer_emoji_status_custom_emoji_id:
      typeof row.peer_emoji_status_custom_emoji_id === "string" &&
      row.peer_emoji_status_custom_emoji_id.trim()
        ? row.peer_emoji_status_custom_emoji_id.trim()
        : null,
    peer_accent_color_light:
      typeof row.peer_accent_color_light === "string" && row.peer_accent_color_light.trim()
        ? row.peer_accent_color_light.trim()
        : null,
    peer_accent_color_dark:
      typeof row.peer_accent_color_dark === "string" && row.peer_accent_color_dark.trim()
        ? row.peer_accent_color_dark.trim()
        : null,
    presence_kind: presenceKind,
    presence_at: presenceAt,
    chat_action: chatAction,
    chat_action_user_id: Number.isFinite(chatActionUserId) ? chatActionUserId : null,
    chat_action_user_name: chatActionUserName,
    chat_action_expires_at: chatActionExpiresAt,
    last_read_outbox_message_id: (() => {
      const raw = Number(row.last_read_outbox_message_id);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    last_message_is_outgoing: Boolean(row.last_message_is_outgoing),
    last_message_outgoing_status:
      row.last_message_outgoing_status === "pending" ||
      row.last_message_outgoing_status === "delivered" ||
      row.last_message_outgoing_status === "read" ||
      row.last_message_outgoing_status === "failed"
        ? row.last_message_outgoing_status
        : null,
    last_message_telegram_id: (() => {
      const raw = Number(row.last_message_telegram_id);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    last_message_sender_user_id: (() => {
      const raw = Number(row.last_message_sender_user_id);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    is_pinned: Boolean(row.is_pinned),
  };
}

function subtitleSegmentsEqual(
  a: FormattedTextSegment[] | null | undefined,
  b: FormattedTextSegment[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind || left.text !== right.text) return false;
    if (left.kind === "link" && right.kind === "link" && left.url !== right.url) return false;
    if (
      left.kind === "custom_emoji" &&
      right.kind === "custom_emoji" &&
      left.custom_emoji_id !== right.custom_emoji_id
    ) {
      return false;
    }
    if (left.kind === "animated_emoji" && right.kind === "animated_emoji" && left.emoji !== right.emoji) {
      return false;
    }
  }
  return true;
}

function chatsChanged(prev: MessageChatRowData[], next: MessageChatRowData[]): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (prev[i]?.telegram_chat_id !== next[i]?.telegram_chat_id) return true;
  }
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.title !== b.title ||
      a.subtitle !== b.subtitle ||
      !subtitleSegmentsEqual(a.subtitle_segments, b.subtitle_segments) ||
      a.last_message_at !== b.last_message_at ||
      a.unread_count !== b.unread_count ||
      a.avatar_url !== b.avatar_url ||
      a.peer_emoji_status_custom_emoji_id !== b.peer_emoji_status_custom_emoji_id ||
      a.peer_accent_color_light !== b.peer_accent_color_light ||
      a.peer_accent_color_dark !== b.peer_accent_color_dark ||
      a.chat_kind !== b.chat_kind ||
      a.member_count !== b.member_count ||
      a.presence_kind !== b.presence_kind ||
      a.presence_at !== b.presence_at ||
      a.chat_action !== b.chat_action ||
      a.chat_action_user_id !== b.chat_action_user_id ||
      a.chat_action_user_name !== b.chat_action_user_name ||
      a.chat_action_expires_at !== b.chat_action_expires_at ||
      a.last_read_outbox_message_id !== b.last_read_outbox_message_id ||
      Boolean(a.last_message_is_outgoing) !== Boolean(b.last_message_is_outgoing) ||
      a.last_message_outgoing_status !== b.last_message_outgoing_status ||
      a.last_message_telegram_id !== b.last_message_telegram_id ||
      a.last_message_sender_user_id !== b.last_message_sender_user_id ||
      Boolean(a.is_pinned) !== Boolean(b.is_pinned)
    ) {
      return true;
    }
  }
  return false;
}

function sortChatRows(rows: MessageChatRowData[]): MessageChatRowData[] {
  return [...rows].sort((a, b) => {
    const aPinned = Boolean(a.is_pinned);
    const bPinned = Boolean(b.is_pinned);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return tb - ta;
  });
}

/** Keep stable rows when the gateway returns a truncated snapshot during resync. */
const CHAT_LIST_OVERSIZED_THRESHOLD = 250;

function applyOpenChatUnreadToRows(rows: MessageChatRowData[]): MessageChatRowData[] {
  let changed = false;
  const next = rows.map((row) => {
    const unread = resolveAuthenticatedHomeOpenChatUnread(
      row.unread_count,
      row.telegram_chat_id,
    );
    if (unread === row.unread_count) return row;
    changed = true;
    return { ...row, unread_count: unread };
  });
  return changed ? next : rows;
}

function mergeChatRows(
  prev: MessageChatRowData[],
  incoming: MessageChatRowData[],
): MessageChatRowData[] {
  if (incoming.length === 0) return prev;
  if (prev.length === 0) {
    return applyOpenChatUnreadToRows(sortChatRows(incoming));
  }
  if (
    prev.length >= CHAT_LIST_OVERSIZED_THRESHOLD &&
    incoming.length < prev.length * 0.25
  ) {
    return applyOpenChatUnreadToRows(sortChatRows(incoming));
  }

  const byId = new Map(incoming.map((row) => [row.telegram_chat_id, row]));
  const merged: MessageChatRowData[] = [];
  const mergedIds = new Set<number>();

  for (const row of prev) {
    const fresh = byId.get(row.telegram_chat_id);
    if (fresh) {
      merged.push({
        ...fresh,
        unread_count: resolveAuthenticatedHomeOpenChatUnread(
          fresh.unread_count,
          fresh.telegram_chat_id,
        ),
      });
    } else {
      merged.push(row);
    }
    mergedIds.add(row.telegram_chat_id);
  }

  for (const row of incoming) {
    if (!mergedIds.has(row.telegram_chat_id)) {
      merged.push({
        ...row,
        unread_count: resolveAuthenticatedHomeOpenChatUnread(
          row.unread_count,
          row.telegram_chat_id,
        ),
      });
      mergedIds.add(row.telegram_chat_id);
    }
  }

  if (incoming.length >= prev.length * 0.9) {
    return applyOpenChatUnreadToRows(sortChatRows(incoming));
  }

  return sortChatRows(merged);
}

const MESSAGES_POLL_FAST_MS = 2_000;
const MESSAGES_POLL_SLOW_MS = 5_000;
const MESSAGES_POLL_SLOW_AFTER = 4;
/** Web uses SSE push; slow poll is a reconnect safety net only. */
const MESSAGES_POLL_STREAM_FALLBACK_MS = 60_000;
const CHAT_LIST_STREAM_ENABLED = typeof EventSource !== "undefined";

export function AuthenticatedHomeMessagesPanel({ colors, scrollable = true }: Props) {
  const { t } = useAppStrings();
  const { authReady, isAuthenticated } = useAuth();
  const { isTelegramMessagesConnected, refreshStatus } = useTelegramMessagesConnection();
  const [chats, setChats] = useState<MessageChatRowData[]>([]);
  const [chatListSync, setChatListSync] = useState<ChatListSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [gatewayWarming, setGatewayWarming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedChat = useAuthenticatedHomeSelectedChat();
  const selectedChatId = selectedChat?.telegram_chat_id ?? null;
  const selectedChatRef = useRef(selectedChat);
  selectedChatRef.current = selectedChat;

  useEffect(() => {
    if (selectedChatId == null || selectedChat == null) return;
    setChats((prev) =>
      prev.map((row) =>
        row.telegram_chat_id === selectedChatId
          ? { ...row, unread_count: selectedChat.unread_count }
          : row,
      ),
    );
  }, [selectedChat, selectedChat?.unread_count, selectedChatId]);
  const { width: windowWidth } = useWindowDimensions();
  const wideListChrome = windowWidth > layout.authenticatedHome.firstBreakpoint;
  const chatSelectionEnabled = wideListChrome;
  const lastGatewayResyncRef = useRef(0);
  const pollCountRef = useRef(0);
  const lastLiveRevisionRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const unchangedPollStreakRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { viewportCount, expandViewport, canExpandViewport } = useChatListViewport(chats.length);
  const loadChatsRef = useRef<(options?: { allowAvatarResync?: boolean; silent?: boolean }) => Promise<void>>(
    async () => {},
  );

  const applyChatListSync = useCallback((status: ChatListSyncStatus | null | undefined) => {
    if (!status) return;
    setChatListSync(status);
    setChatListSyncStatus(status);
  }, []);

  const requestLoadMoreChats = useCallback(async () => {
    try {
      const response = await fetch(buildApiUrl("/api/telegram-messages-chats-load-more"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        chatListSync?: ChatListSyncStatus;
      };
      if (json.chatListSync) {
        applyChatListSync(json.chatListSync);
      }
    } catch {
      /* poll / SSE will pick up background pages */
    }
  }, [applyChatListSync]);

  const triggerGatewayResync = useCallback(async (reason: string) => {
    const url = buildApiUrl("/api/telegram-messages-resync");
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        chatCount?: number;
        error?: string;
        needsReconnect?: boolean;
        connected?: boolean;
        warming?: boolean;
      };
      setGatewayWarming(Boolean(json.warming));
      logPageDisplay("messages_gateway_resync", {
        reason,
        ok: json.ok ?? false,
        warming: json.warming ?? false,
        chatCount: json.chatCount ?? null,
        error: json.error ?? null,
        needsReconnect: json.needsReconnect ?? false,
        elapsedMs: Date.now() - started,
        status: response.status,
      });
      lastGatewayResyncRef.current = Date.now();
      if (json.warming) {
        return true;
      }
      if (json.needsReconnect || json.connected === false) {
        setGatewayWarming(false);
        await refreshStatus();
        return false;
      }
      if (json.ok && (json.chatCount ?? 0) > 0) {
        setGatewayWarming(false);
      }
      return response.ok && (json.ok !== false || json.warming === true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logPageDisplay("messages_gateway_resync_error", { reason, message });
      return false;
    }
  }, [refreshStatus]);

  const loadChats = useCallback(async (options?: { allowAvatarResync?: boolean; silent?: boolean }) => {
    if (!isAuthenticated || !isTelegramMessagesConnected) {
      setChats([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    const params = new URLSearchParams();
    if (
      options?.silent &&
      lastLiveRevisionRef.current != null &&
      lastLiveRevisionRef.current > 0
    ) {
      params.set("since_revision", String(lastLiveRevisionRef.current));
    }
    const query = params.toString();
    const url = buildApiUrl(query ? `/api/telegram-messages-chats?${query}` : "/api/telegram-messages-chats");
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "GET", credentials: "include" });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        unchanged?: boolean;
        chats?: unknown[];
        error?: string;
        source?: string;
        revision?: number;
        chatListSync?: ChatListSyncStatus;
      };
      if (!response.ok || !json.ok) {
        throw new Error(json.error || `HTTP_${response.status}`);
      }
      if (json.unchanged) {
        if (typeof json.revision === "number") {
          lastLiveRevisionRef.current = json.revision;
        }
        applyChatListSync(json.chatListSync);
        unchangedPollStreakRef.current += 1;
        if (options?.silent && pollCountRef.current % 10 === 0) {
          logPageDisplay("messages_chats_poll_unchanged", {
            poll: pollCountRef.current,
            revision: json.revision ?? null,
            elapsedMs: Date.now() - started,
          });
        }
        return;
      }
      unchangedPollStreakRef.current = 0;
      const rows: MessageChatRowData[] = [];
      if (Array.isArray(json.chats)) {
        for (const raw of json.chats) {
          const row = normalizeChat(raw);
          if (row) rows.push(row);
        }
      }
      const missingPreviewCount = rows.filter((row) => !row.subtitle.trim()).length;
      const missingAvatarFieldCount = rows.filter((row) => !row.avatar_url).length;
      if (json.source === "live" && typeof json.revision === "number") {
        lastLiveRevisionRef.current = json.revision;
      }
      applyChatListSync(json.chatListSync);
      setChats((prev) => {
        const next = mergeChatRows(prev, rows);
        const changed = chatsChanged(prev, next);
        if (rows.length > 0) {
          setGatewayWarming(false);
        }
        if (options?.silent) {
          if (changed) {
            logPageDisplay("messages_chats_poll_updated", {
              count: next.length,
              ...firstChatListLogFields(next),
              poll: pollCountRef.current,
              source: json.source ?? null,
              revision: json.revision ?? null,
              elapsedMs: Date.now() - started,
              missingPreviewCount,
              missingAvatarFieldCount,
            });
          } else if (pollCountRef.current % 10 === 0) {
            logPageDisplay("messages_chats_poll_steady", {
              count: next.length,
              poll: pollCountRef.current,
              source: json.source ?? null,
              revision: json.revision ?? null,
              elapsedMs: Date.now() - started,
            });
          }
          return changed ? next : prev;
        }
        return next;
      });
      syncAuthenticatedHomeSelectedChat(rows);
      if (!options?.silent) {
        logPageDisplay("messages_chats_loaded", {
          count: rows.length,
          ...firstChatListLogFields(rows),
          source: json.source ?? null,
          revision: json.revision ?? null,
          status: response.status,
          elapsedMs: Date.now() - started,
          missingPreviewCount,
          missingAvatarFieldCount,
        });
        telegramEmojiDebug.chatListSummary(rows);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!options?.silent) {
        logPageDisplay("messages_chats_error", { message, elapsedMs: Date.now() - started });
        setError(message);
        setChats([]);
      } else {
        logPageDisplay("messages_chats_poll_error", {
          message,
          poll: pollCountRef.current,
          elapsedMs: Date.now() - started,
        });
      }
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [applyChatListSync, isAuthenticated, isTelegramMessagesConnected]);

  useEffect(() => {
    loadChatsRef.current = loadChats;
  }, [loadChats]);

  const streamRevisionPendingRef = useRef<number | null>(null);
  const streamLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreamChatLoad = useCallback(async () => {
    const pendingRevision = streamRevisionPendingRef.current;
    if (
      pendingRevision != null &&
      lastLiveRevisionRef.current != null &&
      pendingRevision <= lastLiveRevisionRef.current
    ) {
      return;
    }
    if (pollInFlightRef.current) {
      streamLoadTimerRef.current = setTimeout(() => {
        void flushStreamChatLoad();
      }, 250);
      return;
    }
    pollInFlightRef.current = true;
    try {
      await loadChats({ silent: true, allowAvatarResync: false });
    } finally {
      pollInFlightRef.current = false;
      const stillPending = streamRevisionPendingRef.current;
      if (
        stillPending != null &&
        (lastLiveRevisionRef.current == null || stillPending > lastLiveRevisionRef.current)
      ) {
        streamLoadTimerRef.current = setTimeout(() => {
          void flushStreamChatLoad();
        }, 150);
      }
    }
  }, [loadChats]);

  const onStreamRevision = useCallback(
    (revision: number) => {
      if (lastLiveRevisionRef.current != null && revision <= lastLiveRevisionRef.current) {
        return;
      }
      streamRevisionPendingRef.current = revision;
      unchangedPollStreakRef.current = 0;
      if (streamLoadTimerRef.current != null) {
        clearTimeout(streamLoadTimerRef.current);
      }
      streamLoadTimerRef.current = setTimeout(() => {
        streamLoadTimerRef.current = null;
        logPageDisplay("messages_chats_stream_revision", { revision });
        void flushStreamChatLoad();
      }, 600);
    },
    [flushStreamChatLoad],
  );

  useTelegramMessagesChatListStream({
    enabled: authReady && isTelegramMessagesConnected,
    getSinceRevision: () => lastLiveRevisionRef.current,
    onRevision: onStreamRevision,
  });

  useEffect(() => {
    if (!authReady) return;
    lastGatewayResyncRef.current = 0;
    pollCountRef.current = 0;
    if (isTelegramMessagesConnected) {
      setGatewayWarming(true);
    }
    void (async () => {
      await loadChats({ silent: true });
      await triggerGatewayResync("initial_mount");
      await loadChats({ silent: true });
    })();
  }, [authReady, isTelegramMessagesConnected, loadChats, triggerGatewayResync]);

  useEffect(() => {
    if (!authReady || !isTelegramMessagesConnected) return;

    let cancelled = false;

    const runPoll = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      pollCountRef.current += 1;
      try {
        await loadChats({ silent: true, allowAvatarResync: false });
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = CHAT_LIST_STREAM_ENABLED
        ? MESSAGES_POLL_STREAM_FALLBACK_MS
        : unchangedPollStreakRef.current >= MESSAGES_POLL_SLOW_AFTER
          ? MESSAGES_POLL_SLOW_MS
          : MESSAGES_POLL_FAST_MS;
      pollTimerRef.current = setTimeout(() => {
        void runPoll().finally(scheduleNext);
      }, delay);
    };

    const onVisibilityChange = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      unchangedPollStreakRef.current = 0;
      if (pollTimerRef.current != null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      void runPoll().finally(scheduleNext);
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    scheduleNext();

    return () => {
      cancelled = true;
      if (pollTimerRef.current != null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (streamLoadTimerRef.current != null) {
        clearTimeout(streamLoadTimerRef.current);
        streamLoadTimerRef.current = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [authReady, isTelegramMessagesConnected, loadChats]);

  const handleChatPress = useCallback(
    (item: MessageChatRowData) => {
      if (!chatSelectionEnabled) return;
      logPageDisplay("messages_chat_open", chatLogFields({
        chatId: item.telegram_chat_id,
        peerUserId: item.peer_user_id,
        title: item.title,
      }));
      void import("../telegram/warmupTelegramChatSession").then(({ warmupTelegramChatSession }) => {
        void warmupTelegramChatSession(item.telegram_chat_id);
      });
      openAuthenticatedHomeChatHistory(item);
      void import("./messages/messageChatAvatarPrefetch").then(
        ({ prefetchOpenChatListAvatar, prefetchOpenChatAvatars }) => {
          prefetchOpenChatListAvatar(item);
          const cached = getCachedChatHistory(item.telegram_chat_id);
          if (cached != null && cached.messages.length > 0) {
            prefetchOpenChatAvatars(item, cached.messages, cached.chatKind);
          }
        },
      );
    },
    [chatSelectionEnabled],
  );

  const handleRowPrefetch = useCallback((item: MessageChatRowData) => {
    prefetchChatHistory(item);
  }, []);

  const handleClearSelection = useCallback(() => {
    if (!chatSelectionEnabled) return;
    clearAuthenticatedHomeSelectedChat();
  }, [chatSelectionEnabled]);

  const visibleChats = chats.slice(0, viewportCount);
  const mayHaveMoreOnServer =
    chatListSync?.inProgress === true ||
    (chats.length >= CHAT_LIST_INITIAL_SYNC_LIMIT && chatListSync?.inProgress !== false);
  const showBottomLoader =
    chatListSync?.inProgress === true ||
    (mayHaveMoreOnServer && !canExpandViewport);

  const handleChatListNearBottom = useCallback(() => {
    if (canExpandViewport) {
      expandViewport();
      return;
    }
    void requestLoadMoreChats();
    void loadChatsRef.current({ silent: true });
  }, [canExpandViewport, expandViewport, requestLoadMoreChats]);

  const renderChatRows = (items: MessageChatRowData[]) => (
    <>
      {items.map((item, index) => (
        <MessageChatRow
          key={item.telegram_chat_id}
          item={item}
          isLast={index === items.length - 1 && !showBottomLoader}
          isActive={chatSelectionEnabled && selectedChatId === item.telegram_chat_id}
          colors={colors}
          timePendingLabel={t("feed.timePending")}
          onPress={chatSelectionEnabled ? () => handleChatPress(item) : undefined}
          onPrefetch={() => handleRowPrefetch(item)}
        />
      ))}
      <ChatListBottomSentinel
        enabled={chats.length > 0}
        onNearBottom={handleChatListNearBottom}
      />
      {showBottomLoader ? (
        <MessageChatOlderHistoryLoadLine active edge="bottom" color={colors.accent} />
      ) : null}
    </>
  );

  const listShellStyle = homeListShellStyle(wideListChrome);

  if (!isTelegramMessagesConnected) {
    return (
      <View style={[listShellStyle, { paddingVertical: 24, alignItems: "center" }]}>
        <Text
          style={{
            textAlign: "center",
            color: colors.secondary,
            fontSize: 15,
            lineHeight: 20,
            maxWidth: 320,
          }}
        >
          {t("messages.connectPrompt")}
        </Text>
      </View>
    );
  }

  if ((loading || gatewayWarming) && chats.length === 0) {
    return (
      <View style={[listShellStyle, { paddingVertical: 24, alignItems: "center" }]}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  if (error && chats.length === 0) {
    return (
      <View style={[listShellStyle, { paddingVertical: 16 }]}>
        <Text style={{ textAlign: "center", color: colors.secondary, fontSize: 15, lineHeight: 20 }}>
          {t("messages.loadError")}
        </Text>
      </View>
    );
  }

  if (chats.length === 0) {
    return (
      <View style={[listShellStyle, { paddingVertical: 16 }]}>
        <Text style={{ textAlign: "center", color: colors.secondary, fontSize: 15, lineHeight: 20 }}>
          {t("messages.empty")}
        </Text>
      </View>
    );
  }

  const list = (
    <View style={{ width: "100%", alignSelf: "stretch" }} pointerEvents="box-none">
      <View style={listShellStyle} pointerEvents="box-none">
        {renderChatRows(visibleChats)}
      </View>
    </View>
  );

  if (!scrollable) {
    return list;
  }

  return (
    <ScrollView
      style={{ width: "100%" }}
      contentContainerStyle={{ ...listShellStyle, flexGrow: 1 }}
      onScrollBeginDrag={handleClearSelection}
    >
      {renderChatRows(visibleChats)}
      <Pressable style={{ flexGrow: 1, minHeight: 1 }} onPress={handleClearSelection} />
    </ScrollView>
  );
}
