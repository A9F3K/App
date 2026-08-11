import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { buildApiUrl } from "../../api/_base";
import { normalizeFormattedTextSegments, type FormattedTextSegment } from "../../shared/formattedTextSegments";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useProfileSheet } from "../profile/ProfileContext";
import { logPageDisplay, firstChatListLogFields, chatLogFields } from "../pageDisplayLog";
import { layout, type ThemeColors } from "../theme";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import {
  clearAuthenticatedHomeSelectedChat,
  mergeChatRowVoicePreferClientClear,
  openAuthenticatedHomeChatHistory,
  resolveAuthenticatedHomeOpenChatUnread,
  subscribeChatVoiceMeta,
  syncAuthenticatedHomeSelectedChat,
  useAuthenticatedHomeSelectedChat,
} from "../authenticatedHomeSelectedChat";
import { prefetchChatHistory, prefetchChatHistoryPriority, prefetchVisibleChatNeighbors } from "../messageChatHistoryPrefetch";
import { unlockVoiceAutoplay } from "../telegram/unlockVoiceAutoplay";
import { getCachedChatHistory } from "../messageChatHistoryCache";
import { MessageChatRow, type MessageChatRowData, type MessageChatKind } from "./messages/MessageChatRow";
import { MessageChatListSearchField } from "./messages/MessageChatListSearchField";
import { ChatListBottomSentinel } from "./messages/ChatListBottomSentinel";
import {
  getChatListSyncStatus,
  setChatListSyncStatus,
  type ChatListSyncStatus,
} from "./messages/chatListSyncStatus";
import { setChatListBottomLoaderActive } from "./messages/chatListBottomLoaderStatus";
import { setChatListNearBottomHandler } from "./messages/chatListNearBottom";
import {
  getChatListScrollMetrics,
  subscribeChatListScrollMetrics,
} from "./messages/chatListScrollMetrics";
import {
  CHAT_LIST_VIRTUALIZE_MIN_ROWS,
  resolveChatListTier,
  resolveChatListVirtualWindow,
  sortChatRowsTierAware,
} from "./messages/chatListVirtualWindow";
import {
  MESSAGE_ROW_HEIGHT_PX,
  chatListRowStridePx,
  chatListSearchBlockHeightPx,
  chatListSearchMarginBelowPx,
  homeListShellStyle,
  MESSAGE_CHAT_LIST_SEARCH_VERTICAL_INSET_PX,
} from "./messages/messageListLayout";
import {
  isVoiceDialogUiOpen,
  subscribeVoiceDialogUiOpen,
} from "./messages/voiceDialogUiGate";
import { telegramEmojiDebug } from "./messages/telegramEmojiDebug";
import { useTelegramMessagesChatListStream } from "./messages/useTelegramMessagesChatListStream";
import { fetchTelegramChatListSearch, type TelegramChatListSearchHit } from "../telegram/fetchTelegramChatListSearch";

function normalizeSearchNeedle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

function chatMatchesLocalSearch(row: MessageChatRowData, needle: string): boolean {
  if (!needle) return true;
  const fields = [
    row.title,
    row.subtitle,
    row.peer_username,
    row.chat_username,
  ];
  for (const field of fields) {
    if (typeof field !== "string" || !field.trim()) continue;
    if (normalizeSearchNeedle(field).includes(needle)) return true;
  }
  if (Array.isArray(row.subtitle_segments)) {
    for (const segment of row.subtitle_segments) {
      if (segment && typeof segment.text === "string" && segment.text.trim()) {
        if (normalizeSearchNeedle(segment.text).includes(needle)) return true;
      }
    }
  }
  return false;
}

function chatSearchRank(row: MessageChatRowData, needle: string, serverHit: boolean): number {
  if (!needle) return 0;
  const title = normalizeSearchNeedle(row.title || "");
  const peer = normalizeSearchNeedle(row.peer_username || "");
  const chatUser = normalizeSearchNeedle(row.chat_username || "");
  const subtitle = normalizeSearchNeedle(row.subtitle || "");
  // Prefer exact / prefix username matches (global @user / channel finds).
  if (peer === needle || chatUser === needle) return 0;
  if (peer.startsWith(needle) || chatUser.startsWith(needle)) return 1;
  if (title.startsWith(needle)) return 2;
  if (title.includes(needle)) return 3;
  if (peer.includes(needle) || chatUser.includes(needle)) return 4;
  if (subtitle.includes(needle)) return 5;
  if (serverHit) return 6;
  return 7;
}

/** Remote TDLib hits for chats not yet in the scroll-synced local window. */
function remoteSearchHitToRow(hit: TelegramChatListSearchHit): MessageChatRowData {
  const username = (hit.peerUsername || hit.chatUsername || "").replace(/^@+/, "").trim();
  const kindLabel =
    hit.chatKind === "channel"
      ? "channel"
      : hit.chatKind === "supergroup" || hit.chatKind === "group"
        ? "group"
        : hit.chatKind === "private"
          ? "user"
          : "";
  const subtitleParts = [
    username ? `@${username}` : "",
    kindLabel,
  ].filter(Boolean);
  return {
    id: hit.chatId,
    telegram_chat_id: hit.chatId,
    title: hit.title,
    subtitle: subtitleParts.join(" · "),
    avatar_url: null,
    last_message_at: null,
    unread_count: 0,
    peer_user_id: hit.peerUserId,
    peer_username: hit.peerUsername,
    chat_username: hit.chatUsername,
    chat_kind: hit.chatKind,
    list_tier: "positioned",
  };
}

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
    last_read_inbox_message_id: (() => {
      const raw = Number(row.last_read_inbox_message_id);
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
    pin_order: typeof row.pin_order === "string" ? row.pin_order : "0",
    list_tier:
      row.list_tier === "pinned" ||
      row.list_tier === "positioned" ||
      row.list_tier === "unpositioned"
        ? row.list_tier
        : null,
    has_active_voice_chat: Boolean(row.has_active_voice_chat),
    voice_chat_group_call_id: normalizeTelegramGroupCallId(row.voice_chat_group_call_id),
    voice_chat_is_joined: Boolean(row.voice_chat_is_joined),
    peer_is_bot: Boolean(row.peer_is_bot),
    pending_deleted_message_ids: (() => {
      if (!Array.isArray(row.pending_deleted_message_ids)) return null;
      const ids = row.pending_deleted_message_ids
        .map((id: unknown) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0)
        .map((id: number) => Math.trunc(id));
      return ids.length > 0 ? ids : null;
    })(),
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
    if (a === b) continue;
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
      a.last_read_inbox_message_id !== b.last_read_inbox_message_id ||
      Boolean(a.last_message_is_outgoing) !== Boolean(b.last_message_is_outgoing) ||
      a.last_message_outgoing_status !== b.last_message_outgoing_status ||
      a.last_message_telegram_id !== b.last_message_telegram_id ||
      a.last_message_sender_user_id !== b.last_message_sender_user_id ||
      Boolean(a.is_pinned) !== Boolean(b.is_pinned) ||
      a.pin_order !== b.pin_order ||
      a.list_tier !== b.list_tier ||
      Boolean(a.has_active_voice_chat) !== Boolean(b.has_active_voice_chat) ||
      a.voice_chat_group_call_id !== b.voice_chat_group_call_id ||
      Boolean(a.voice_chat_is_joined) !== Boolean(b.voice_chat_is_joined) ||
      Boolean(a.peer_is_bot) !== Boolean(b.peer_is_bot)
    ) {
      return true;
    }
  }
  return false;
}

/** Reuse the previous row object when fields match — avoids 100+ row re-renders. */
function reuseChatRowIfEqual(
  prev: MessageChatRowData | undefined,
  next: MessageChatRowData,
): MessageChatRowData {
  if (!prev || prev.telegram_chat_id !== next.telegram_chat_id) return next;
  if (
    prev.title === next.title &&
    prev.subtitle === next.subtitle &&
    subtitleSegmentsEqual(prev.subtitle_segments, next.subtitle_segments) &&
    prev.last_message_at === next.last_message_at &&
    prev.unread_count === next.unread_count &&
    prev.avatar_url === next.avatar_url &&
    prev.peer_emoji_status_custom_emoji_id === next.peer_emoji_status_custom_emoji_id &&
    prev.peer_accent_color_light === next.peer_accent_color_light &&
    prev.peer_accent_color_dark === next.peer_accent_color_dark &&
    prev.chat_kind === next.chat_kind &&
    prev.member_count === next.member_count &&
    prev.presence_kind === next.presence_kind &&
    prev.presence_at === next.presence_at &&
    prev.chat_action === next.chat_action &&
    prev.chat_action_user_id === next.chat_action_user_id &&
    prev.chat_action_user_name === next.chat_action_user_name &&
    prev.chat_action_expires_at === next.chat_action_expires_at &&
    prev.last_read_outbox_message_id === next.last_read_outbox_message_id &&
    prev.last_read_inbox_message_id === next.last_read_inbox_message_id &&
    Boolean(prev.last_message_is_outgoing) === Boolean(next.last_message_is_outgoing) &&
    prev.last_message_outgoing_status === next.last_message_outgoing_status &&
    prev.last_message_telegram_id === next.last_message_telegram_id &&
    prev.last_message_sender_user_id === next.last_message_sender_user_id &&
    Boolean(prev.is_pinned) === Boolean(next.is_pinned) &&
    prev.pin_order === next.pin_order &&
    prev.list_tier === next.list_tier &&
    Boolean(prev.has_active_voice_chat) === Boolean(next.has_active_voice_chat) &&
    prev.voice_chat_group_call_id === next.voice_chat_group_call_id &&
    Boolean(prev.voice_chat_is_joined) === Boolean(next.voice_chat_is_joined) &&
    Boolean(prev.peer_is_bot) === Boolean(next.peer_is_bot)
  ) {
    return prev;
  }
  return next;
}

/** Keep stable rows when the gateway returns a truncated snapshot during resync. */
const CHAT_LIST_OVERSIZED_THRESHOLD = 250;

function applyOpenChatUnreadToRows(
  rows: MessageChatRowData[],
  prevRows?: MessageChatRowData[],
): MessageChatRowData[] {
  const prevById =
    prevRows && prevRows.length > 0
      ? new Map(prevRows.map((row) => [row.telegram_chat_id, row]))
      : null;
  let changed = false;
  const next = rows.map((row) => {
    const prevRow = prevById?.get(row.telegram_chat_id);
    const withVoice = mergeChatRowVoicePreferClientClear(prevRow, row);
    const unread = resolveAuthenticatedHomeOpenChatUnread(
      withVoice.unread_count,
      withVoice.telegram_chat_id,
    );
    const withUnread =
      unread === withVoice.unread_count ? withVoice : { ...withVoice, unread_count: unread };
    const reused = reuseChatRowIfEqual(prevRow, withUnread);
    if (reused !== row) changed = true;
    return reused;
  });
  if (!changed) return prevRows && prevRows.length === rows.length ? prevRows : rows;
  return next;
}

function mergeChatRows(
  prev: MessageChatRowData[],
  incoming: MessageChatRowData[],
): MessageChatRowData[] {
  if (incoming.length === 0) return prev;
  const sortedIncoming = sortChatRowsTierAware(incoming);
  if (prev.length === 0) {
    return applyOpenChatUnreadToRows(sortedIncoming);
  }

  const prevTier3Count = prev.filter((row) => resolveChatListTier(row) === "unpositioned").length;
  const incomingTier3Count = incoming.filter(
    (row) => resolveChatListTier(row) === "unpositioned",
  ).length;
  const tier3Shrinking = incomingTier3Count < prevTier3Count;

  if (
    !tier3Shrinking &&
    prev.length >= CHAT_LIST_OVERSIZED_THRESHOLD &&
    incoming.length < prev.length * 0.25
  ) {
    return applyOpenChatUnreadToRows(sortedIncoming, prev);
  }

  if (incoming.length >= prev.length) {
    const prevTopId = prev[0]?.telegram_chat_id ?? 0;
    const incomingTopId = sortedIncoming[0]?.telegram_chat_id ?? 0;
    const prevIdSet = new Set(prev.map((row) => row.telegram_chat_id));
    const hasNewIds = sortedIncoming.some((row) => !prevIdSet.has(row.telegram_chat_id));
    if (
      prev.length >= CHAT_LIST_VIRTUALIZE_MIN_ROWS &&
      !hasNewIds &&
      prevTopId > 0 &&
      prevTopId === incomingTopId
    ) {
      const byId = new Map(sortedIncoming.map((row) => [row.telegram_chat_id, row]));
      let changed = false;
      const next = prev.map((row) => {
        const fresh = byId.get(row.telegram_chat_id);
        if (!fresh) return row;
        const withVoice = mergeChatRowVoicePreferClientClear(row, fresh);
        const unread = resolveAuthenticatedHomeOpenChatUnread(
          withVoice.unread_count,
          withVoice.telegram_chat_id,
        );
        const merged =
          unread === withVoice.unread_count
            ? withVoice
            : { ...withVoice, unread_count: unread };
        const reused = reuseChatRowIfEqual(row, merged);
        if (reused !== row) changed = true;
        return reused;
      });
      return changed ? next : prev;
    }
    return applyOpenChatUnreadToRows(sortedIncoming, prev);
  }

  const byId = new Map(sortedIncoming.map((row) => [row.telegram_chat_id, row]));
  const merged: MessageChatRowData[] = [];
  const mergedIds = new Set<number>();

  for (const row of prev) {
    const fresh = byId.get(row.telegram_chat_id);
    if (fresh) {
      const withVoice = mergeChatRowVoicePreferClientClear(row, fresh);
      const unread = resolveAuthenticatedHomeOpenChatUnread(
        withVoice.unread_count,
        withVoice.telegram_chat_id,
      );
      const withUnread =
        unread === withVoice.unread_count
          ? withVoice
          : { ...withVoice, unread_count: unread };
      merged.push(reuseChatRowIfEqual(row, withUnread));
    } else if (resolveChatListTier(row) !== "unpositioned") {
      merged.push(row);
    }
    mergedIds.add(row.telegram_chat_id);
  }

  for (const row of sortedIncoming) {
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

  return sortChatRowsTierAware(merged);
}

const MESSAGES_POLL_FAST_MS = 2_000;
const MESSAGES_POLL_SLOW_MS = 5_000;
const MESSAGES_POLL_SLOW_AFTER = 4;
/** Web uses SSE push; slow poll is a reconnect safety net only. */
const MESSAGES_POLL_STREAM_FALLBACK_MS = 60_000;
const CHAT_LIST_STREAM_ENABLED = typeof EventSource !== "undefined";

export function AuthenticatedHomeMessagesPanel({ colors, scrollable = true }: Props) {
  const { t } = useAppStrings();
  const { openProfileSheet } = useProfileSheet();
  const { authReady, isAuthenticated } = useAuth();
  const { isTelegramMessagesConnected, refreshStatus } = useTelegramMessagesConnection();
  const [chats, setChats] = useState<MessageChatRowData[]>([]);
  const [chatListSync, setChatListSync] = useState<ChatListSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [gatewayWarming, setGatewayWarming] = useState(false);
  /**
   * True until the first chat-list fetch finishes. Without this, silent mount
   * load + gatewayWarming=false on the first frame flashes "No chats yet".
   */
  const [listBootstrapPending, setListBootstrapPending] = useState(true);
  /**
   * True after a successful chat-list fetch returned 0 rows while connected.
   * Avoids flashing `messages.empty` when chats wipe during reconnect races.
   */
  const [emptyListConfirmed, setEmptyListConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatListSearchQuery, setChatListSearchQuery] = useState("");
  const [remoteSearchChatIds, setRemoteSearchChatIds] = useState<number[]>([]);
  const [remoteSearchPeerUserIds, setRemoteSearchPeerUserIds] = useState<number[]>([]);
  const [remoteSearchHits, setRemoteSearchHits] = useState<TelegramChatListSearchHit[]>([]);
  const selectedChat = useAuthenticatedHomeSelectedChat();
  const selectedChatId = selectedChat?.telegram_chat_id ?? null;
  const selectedChatRef = useRef(selectedChat);
  selectedChatRef.current = selectedChat;
  /** Keep applyChats urgent while the list is still empty (hard-reload first paint). */
  const chatsCountRef = useRef(0);
  chatsCountRef.current = chats.length;
  const emptyUnchangedForceRef = useRef(false);

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

  useEffect(() => {
    return subscribeChatVoiceMeta((patch) => {
      setChats((prev) => {
        let changed = false;
        const next = prev.map((row) => {
          if (row.telegram_chat_id !== patch.chatId) return row;
          const nextJoined = patch.has_active_voice_chat
            ? Boolean(patch.voice_chat_is_joined ?? row.voice_chat_is_joined)
            : false;
          if (
            Boolean(row.has_active_voice_chat) === patch.has_active_voice_chat &&
            row.voice_chat_group_call_id === patch.voice_chat_group_call_id &&
            Boolean(row.voice_chat_is_joined) === nextJoined
          ) {
            return row;
          }
          changed = true;
          return {
            ...row,
            has_active_voice_chat: patch.has_active_voice_chat,
            voice_chat_group_call_id: patch.voice_chat_group_call_id,
            voice_chat_is_joined: nextJoined,
          };
        });
        return changed ? next : prev;
      });
    });
  }, []);

  const { width: windowWidth } = useWindowDimensions();
  const wideListChrome = windowWidth > layout.authenticatedHome.firstBreakpoint;
  const chatSelectionEnabled = wideListChrome;
  const lastGatewayResyncRef = useRef(0);
  const pollCountRef = useRef(0);
  const lastLiveRevisionRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  /** True while any loadChats fetch+normalize is running (mount, SSE, metronome). */
  const chatListFetchBusyRef = useRef(false);
  const chatListFetchQueuedRef = useRef<{
    allowAvatarResync?: boolean;
    silent?: boolean;
    forceFull?: boolean;
  } | null>(null);
  const unchangedPollStreakRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListAtBottomRef = useRef(false);
  const loadMoreTierRef = useRef<"positioned" | "unpositioned">("positioned");
  /** Chat-list rows fetched while the voice dialog was open — apply on close. */
  const deferredVoiceChatListRef = useRef<{
    rows: MessageChatRowData[];
    json: {
      source?: string | null;
      revision?: number | null;
    };
    started: number;
    missingPreviewCount: number;
    missingAvatarFieldCount: number;
    silent: boolean;
  } | null>(null);
  /** Silent poll skipped entirely while voice dialog open — refetch on close. */
  const deferredSilentChatLoadRef = useRef(false);
  /** Bumped when the voice sheet opens so in-flight startTransition applies abort. */
  const chatListApplyEpochRef = useRef(0);
  const [chatListScrollTick, setChatListScrollTick] = useState(0);
  const chatListScrollRafRef = useRef<number | null>(null);
  const chatListVirtualStickyRef = useRef({ startIndex: 0, endIndex: 0 });
  const chatListVirtualWindowRef = useRef<ReturnType<typeof resolveChatListVirtualWindow> | null>(null);
  const loadChatsRef = useRef<
    (options?: { allowAvatarResync?: boolean; silent?: boolean; forceFull?: boolean }) => Promise<void>
  >(async () => {});

  const applyChatListSync = useCallback((status: ChatListSyncStatus | null | undefined) => {
    if (!status) return;
    setChatListSync(status);
    setChatListSyncStatus(status);
  }, []);

  const requestLoadMoreChats = useCallback(async (tier: "positioned" | "unpositioned" = "positioned") => {
    loadMoreTierRef.current = tier;
    try {
      const response = await fetch(buildApiUrl("/api/telegram-messages-chats-load-more"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        chatListSync?: ChatListSyncStatus;
      };
      if (json.chatListSync) {
        applyChatListSync(json.chatListSync);
      }
      // Gateway pages more into cache — pull the expanded snapshot into the UI.
      if (!isVoiceDialogUiOpen()) {
        void loadChatsRef.current({ silent: true, forceFull: true });
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
      // Do not clear warming while the list is still empty — resync often
      // finishes before startTransition applies the first chat rows, which
      // briefly showed "No chats yet." and raced a heavy sync apply.
      if (json.ok && (json.chatCount ?? 0) > 0 && chatsCountRef.current > 0) {
        setGatewayWarming(false);
      }
      return response.ok && json.ok !== false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logPageDisplay("messages_gateway_resync_error", { reason, message });
      return false;
    }
  }, [refreshStatus]);

  const loadChats = useCallback(async (options?: {
    allowAvatarResync?: boolean;
    silent?: boolean;
    forceFull?: boolean;
  }) => {
    if (!isAuthenticated || !isTelegramMessagesConnected) {
      // Keep painted rows on brief disconnect — wiping flashed "No chats yet"
      // while status/warmup raced. Only clear on logout.
      if (!isAuthenticated) {
        setChats([]);
        setEmptyListConfirmed(false);
        setListBootstrapPending(false);
      } else {
        setListBootstrapPending(true);
      }
      setError(null);
      setLoading(false);
      setGatewayWarming(false);
      return;
    }
    // Coalesce overlapping callers (mount + SSE + metronome). Without this,
    // 3–4×170-row normalize/apply stacks freeze the shell and voice Close.
    if (chatListFetchBusyRef.current) {
      const prev = chatListFetchQueuedRef.current;
      chatListFetchQueuedRef.current = {
        allowAvatarResync: Boolean(prev?.allowAvatarResync || options?.allowAvatarResync),
        forceFull: Boolean(prev?.forceFull || options?.forceFull),
        // Non-silent wins so the visible first paint is never dropped.
        silent: prev != null
          ? prev.silent === true && options?.silent === true
          : options?.silent === true,
      };
      return;
    }
    chatListFetchBusyRef.current = true;
    // Telegram Web: while the call sheet is open, do not fetch/parse the chat
    // list on the UI thread at all (not only silent polls).
    if (isVoiceDialogUiOpen()) {
      deferredSilentChatLoadRef.current = true;
      chatListFetchBusyRef.current = false;
      logPageDisplay("messages_chats_poll_skip_fetch_voice_dialog", {
        forceFull: Boolean(options?.forceFull),
        silent: Boolean(options?.silent),
      });
      const skippedQueued = chatListFetchQueuedRef.current;
      if (skippedQueued) {
        chatListFetchQueuedRef.current = null;
        if (skippedQueued.silent === true || isVoiceDialogUiOpen()) {
          deferredSilentChatLoadRef.current = true;
        } else {
          void loadChatsRef.current(skippedQueued);
        }
      }
      return;
    }
    if (!options?.silent) {
      setLoading(true);
      setError(null);
    }
    const params = new URLSearchParams();
    if (
      options?.silent &&
      !options?.forceFull &&
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
      // Sheet may have opened while the request was in flight — skip JSON parse
      // of ~260 chats (main-thread longtask) and apply on close instead.
      if (isVoiceDialogUiOpen()) {
        deferredSilentChatLoadRef.current = true;
        logPageDisplay("messages_chats_poll_skip_parse_voice_dialog", {
          forceFull: Boolean(options?.forceFull),
          silent: Boolean(options?.silent),
          elapsedMs: Date.now() - started,
          status: response.status,
        });
        return;
      }
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
      if (isVoiceDialogUiOpen()) {
        deferredSilentChatLoadRef.current = true;
        logPageDisplay("messages_chats_poll_skip_apply_voice_dialog", {
          forceFull: Boolean(options?.forceFull),
          silent: Boolean(options?.silent),
          elapsedMs: Date.now() - started,
          revision: typeof json.revision === "number" ? json.revision : null,
        });
        return;
      }
      if (json.unchanged) {
        if (typeof json.revision === "number") {
          lastLiveRevisionRef.current = json.revision;
        }
        applyChatListSync(json.chatListSync);
        // Cold paint: an "unchanged" with no rows must not clear bootstrap and
        // leave emptyListConfirmed=false (infinite spinner / delayed list).
        if (chatsCountRef.current === 0 && !emptyUnchangedForceRef.current) {
          emptyUnchangedForceRef.current = true;
          setEmptyListConfirmed(false);
          queueMicrotask(() => {
            void loadChatsRef.current({ silent: false, forceFull: true });
          });
        }
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
      // Drop ALL in-flight chat-list paints while the voice sheet is open —
      // including forceFull. forceFull used to bypass this gate and land
      // messages_chats_poll_updated + avatar remounts mid-dialog (535ms freeze).
      if (isVoiceDialogUiOpen()) {
        deferredVoiceChatListRef.current = {
          rows,
          json: {
            source: json.source ?? null,
            revision: typeof json.revision === "number" ? json.revision : null,
          },
          started,
          missingPreviewCount,
          missingAvatarFieldCount,
          silent: Boolean(options?.silent),
        };
        logPageDisplay("messages_chats_poll_deferred_voice_dialog", {
          count: rows.length,
          poll: pollCountRef.current,
          revision: json.revision ?? null,
          elapsedMs: Date.now() - started,
          forceFull: Boolean(options?.forceFull),
          silent: Boolean(options?.silent),
        });
        return;
      }
      const applyEpoch = chatListApplyEpochRef.current;
      const stashDeferredVoiceRows = (reason: string) => {
        deferredVoiceChatListRef.current = {
          rows,
          json: {
            source: json.source ?? null,
            revision: typeof json.revision === "number" ? json.revision : null,
          },
          started,
          missingPreviewCount,
          missingAvatarFieldCount,
          silent: Boolean(options?.silent),
        };
        logPageDisplay("messages_chats_poll_deferred_voice_dialog", {
          count: rows.length,
          poll: pollCountRef.current,
          revision: json.revision ?? null,
          elapsedMs: Date.now() - started,
          reason,
          forceFull: Boolean(options?.forceFull),
        });
      };
      const applyChats = () => {
        // Re-check inside startTransition — the gate above can pass before Join,
        // then this callback runs after the sheet opens and freezes Close.
        if (
          applyEpoch !== chatListApplyEpochRef.current ||
          isVoiceDialogUiOpen()
        ) {
          stashDeferredVoiceRows(
            applyEpoch !== chatListApplyEpochRef.current
              ? "apply_epoch_bumped"
              : "start_transition_after_open",
          );
          return;
        }
        deferredVoiceChatListRef.current = null;
        setChats((prev) => {
          // Critical: React may run this updater after Join even when applyChats
          // checked the gate earlier (logs: chats_poll_updated mid-dialog →
          // avatar storm → UI dead after one green mic).
          if (
            applyEpoch !== chatListApplyEpochRef.current ||
            isVoiceDialogUiOpen()
          ) {
            deferredVoiceChatListRef.current = {
              rows,
              json: {
                source: json.source ?? null,
                revision: typeof json.revision === "number" ? json.revision : null,
              },
              started,
              missingPreviewCount,
              missingAvatarFieldCount,
              silent: Boolean(options?.silent),
            };
            queueMicrotask(() => {
              logPageDisplay("messages_chats_poll_deferred_voice_dialog", {
                count: rows.length,
                poll: pollCountRef.current,
                revision: json.revision ?? null,
                elapsedMs: Date.now() - started,
                reason: "set_chats_updater_after_open",
                forceFull: Boolean(options?.forceFull),
              });
            });
            return prev;
          }
          const next = mergeChatRows(prev, rows);
          const changed = chatsChanged(prev, next);
          queueMicrotask(() => syncAuthenticatedHomeSelectedChat(next));
          if (rows.length > 0) {
            setGatewayWarming(false);
            setEmptyListConfirmed(false);
          } else if (prev.length === 0) {
            setEmptyListConfirmed(true);
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
      };
      // First paint must stay urgent — startTransition deferred the empty→rows
      // apply for seconds behind history/voice work (long "No chats yet" / spinner).
      // Large silent refreshes stay interruptible once the list already has rows.
      if (chatsCountRef.current === 0) {
        applyChats();
      } else if (rows.length >= 24 || Boolean(options?.silent)) {
        startTransition(applyChats);
      } else {
        applyChats();
      }
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
        // Let the error UI render — otherwise !emptyListConfirmed keeps spinner.
        setEmptyListConfirmed(true);
      } else {
        logPageDisplay("messages_chats_poll_error", {
          message,
          poll: pollCountRef.current,
          elapsedMs: Date.now() - started,
        });
      }
    } finally {
      if (!options?.silent) setLoading(false);
      setListBootstrapPending(false);
      chatListFetchBusyRef.current = false;
      const queued = chatListFetchQueuedRef.current;
      if (queued) {
        chatListFetchQueuedRef.current = null;
        void loadChatsRef.current(queued);
      }
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
      streamRevisionPendingRef.current = null;
      return;
    }
    if (pollInFlightRef.current) {
      // Coalesce — a 250ms retry stack raced the metronome and duplicated loads.
      if (streamLoadTimerRef.current == null) {
        streamLoadTimerRef.current = setTimeout(() => {
          streamLoadTimerRef.current = null;
          void flushStreamChatLoad();
        }, 1_500);
      }
      return;
    }
    pollInFlightRef.current = true;
    const pendingAtStart = streamRevisionPendingRef.current;
    try {
      await loadChats({ silent: true, allowAvatarResync: false });
    } finally {
      pollInFlightRef.current = false;
      const stillPending = streamRevisionPendingRef.current;
      // Only re-flush when a *newer* revision arrived during this fetch.
      // The old `stillPending > lastLive` check spun every 150ms whenever SSE
      // stayed ahead of the poll API — after voice-dialog close that froze the
      // chat preview so clicks never landed.
      if (
        stillPending != null &&
        pendingAtStart != null &&
        stillPending > pendingAtStart
      ) {
        if (streamLoadTimerRef.current == null) {
          streamLoadTimerRef.current = setTimeout(() => {
            streamLoadTimerRef.current = null;
            void flushStreamChatLoad();
          }, 2_500);
        }
      } else {
        streamRevisionPendingRef.current = null;
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
      // Busy chats emit revisions faster than a 170-row apply can finish.
      // 800ms still stacked overlapping paints; 2.5s coalesces without feeling stale.
      const debounceMs = isVoiceDialogUiOpen() ? 12_000 : 2_500;
      streamLoadTimerRef.current = setTimeout(() => {
        streamLoadTimerRef.current = null;
        if (isVoiceDialogUiOpen()) {
          // Keep pending; flush on close via subscription below.
          logPageDisplay("messages_chats_stream_revision_deferred", {
            revision,
            reason: "voice_dialog_open",
          });
          return;
        }
        logPageDisplay("messages_chats_stream_revision", { revision });
        void flushStreamChatLoad();
      }, debounceMs);
    },
    [flushStreamChatLoad],
  );

  // Flush any deferred chat-list revision when the voice dialog closes.
  // Keep this delayed so Close paints first, but only one load — a tight
  // revision-retry loop after close froze the chat preview (unclickable).
  const voiceCloseFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return subscribeVoiceDialogUiOpen((open) => {
      if (open) {
        chatListApplyEpochRef.current += 1;
        if (voiceCloseFlushTimerRef.current != null) {
          clearTimeout(voiceCloseFlushTimerRef.current);
          voiceCloseFlushTimerRef.current = null;
        }
        // Stop a pending SSE→loadChats timer from firing mid-open longtask.
        if (streamLoadTimerRef.current != null) {
          clearTimeout(streamLoadTimerRef.current);
          streamLoadTimerRef.current = null;
        }
        return;
      }
      const pending = streamRevisionPendingRef.current;
      const deferredRows = deferredVoiceChatListRef.current;
      const needsSilentReload = deferredSilentChatLoadRef.current;
      if (pending == null && deferredRows == null && !needsSilentReload) return;
      if (
        pending != null &&
        lastLiveRevisionRef.current != null &&
        pending <= lastLiveRevisionRef.current &&
        deferredRows == null &&
        !needsSilentReload
      ) {
        streamRevisionPendingRef.current = null;
        return;
      }
      if (streamLoadTimerRef.current != null) {
        clearTimeout(streamLoadTimerRef.current);
        streamLoadTimerRef.current = null;
      }
      if (voiceCloseFlushTimerRef.current != null) {
        clearTimeout(voiceCloseFlushTimerRef.current);
      }
      logPageDisplay("messages_chats_stream_revision", {
        revision: pending,
        reason: "voice_dialog_closed_flush_scheduled",
        hasDeferredRows: deferredRows != null,
        needsSilentReload,
      });
      voiceCloseFlushTimerRef.current = setTimeout(() => {
        voiceCloseFlushTimerRef.current = null;
        if (isVoiceDialogUiOpen()) return;
        const stash = deferredVoiceChatListRef.current;
        if (stash != null) {
          deferredVoiceChatListRef.current = null;
          startTransition(() => {
            if (isVoiceDialogUiOpen()) {
              deferredVoiceChatListRef.current = stash;
              return;
            }
            setChats((prev) => {
              const next = mergeChatRows(prev, stash.rows);
              const changed = chatsChanged(prev, next);
              queueMicrotask(() => syncAuthenticatedHomeSelectedChat(next));
              if (stash.rows.length > 0) setGatewayWarming(false);
              if (changed) {
                logPageDisplay("messages_chats_poll_updated", {
                  count: next.length,
                  ...firstChatListLogFields(next),
                  poll: pollCountRef.current,
                  source: stash.json.source ?? null,
                  revision: stash.json.revision ?? null,
                  elapsedMs: Date.now() - stash.started,
                  missingPreviewCount: stash.missingPreviewCount,
                  missingAvatarFieldCount: stash.missingAvatarFieldCount,
                  reason: "voice_dialog_closed_deferred_rows",
                });
              }
              return changed ? next : prev;
            });
          });
        }
        if (deferredSilentChatLoadRef.current) {
          deferredSilentChatLoadRef.current = false;
          void loadChatsRef.current({ silent: true, forceFull: true });
        }
        if (streamRevisionPendingRef.current == null) return;
        logPageDisplay("messages_chats_stream_revision", {
          revision: streamRevisionPendingRef.current,
          reason: "voice_dialog_closed_flush",
        });
        void flushStreamChatLoad();
      }, 2_500);
    });
  }, [flushStreamChatLoad]);

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
      setListBootstrapPending(true);
    } else {
      setListBootstrapPending(false);
      setGatewayWarming(false);
    }
    void (async () => {
      // Paint the first chat list ASAP — do not await gateway resync first.
      await loadChats({ silent: true, forceFull: true });
      void (async () => {
        await triggerGatewayResync("initial_mount");
        if (isVoiceDialogUiOpen()) {
          deferredSilentChatLoadRef.current = true;
          return;
        }
        // Skip a second full download only when the first paint already matches
        // gateway cache size (or cache is unknown and we already have rows).
        const sync = getChatListSyncStatus();
        const count = chatsCountRef.current;
        const cached =
          typeof sync?.cachedCount === "number" && sync.cachedCount > 0
            ? sync.cachedCount
            : null;
        const incomplete =
          count === 0 ||
          (cached != null && cached > count) ||
          sync?.inProgress === true ||
          sync?.tier3InProgress === true;
        if (!incomplete) {
          setGatewayWarming(false);
          return;
        }
        await loadChats({ silent: true, forceFull: true });
      })();
    })();
  }, [authReady, isTelegramMessagesConnected, loadChats, triggerGatewayResync]);

  useEffect(() => {
    if (!authReady || !isTelegramMessagesConnected) return;

    let cancelled = false;

    const runPoll = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (isVoiceDialogUiOpen()) return;
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
      const delay = isVoiceDialogUiOpen()
        ? 15_000
        : CHAT_LIST_STREAM_ENABLED
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
      // Unlock autoplay in the same user gesture as chat selection so WebRTC
      // remote audio can play after auto listen-only join (useEffect is too late).
      if (item.has_active_voice_chat) {
        unlockVoiceAutoplay();
      }
      logPageDisplay("messages_chat_open", chatLogFields({
        chatId: item.telegram_chat_id,
        peerUserId: item.peer_user_id,
        title: item.title,
      }));
      // tdesktop: start full history warm before the message list mounts.
      prefetchChatHistoryPriority(item);
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

  const sortedChats = useMemo(() => sortChatRowsTierAware(chats), [chats]);
  const searchNeedle = useMemo(
    () => normalizeSearchNeedle(chatListSearchQuery),
    [chatListSearchQuery],
  );
  const remoteSearchChatIdSet = useMemo(
    () => new Set(remoteSearchChatIds),
    [remoteSearchChatIds],
  );
  const remoteSearchPeerUserIdSet = useMemo(
    () => new Set(remoteSearchPeerUserIds),
    [remoteSearchPeerUserIds],
  );

  useEffect(() => {
    if (!isTelegramMessagesConnected || !searchNeedle) {
      setRemoteSearchChatIds([]);
      setRemoteSearchPeerUserIds([]);
      setRemoteSearchHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchTelegramChatListSearch(chatListSearchQuery, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) return;
        setRemoteSearchChatIds(result.chatIds);
        setRemoteSearchPeerUserIds(result.peerUserIds);
        setRemoteSearchHits(result.chats);
        logPageDisplay("messages_chat_list_search", {
          query: chatListSearchQuery.trim(),
          chatIdCount: result.chatIds.length,
          peerUserIdCount: result.peerUserIds.length,
          stubCount: result.chats.length,
          sampleTitles: result.chats
            .slice(0, 5)
            .map((row) => row.title)
            .join(" | "),
        });
      });
    }, 220);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [chatListSearchQuery, isTelegramMessagesConnected, searchNeedle]);

  const displayChats = useMemo(() => {
    if (!searchNeedle) return sortedChats;
    const localIds = new Set(sortedChats.map((row) => row.telegram_chat_id));
    const matched = sortedChats.filter((row) => {
      if (chatMatchesLocalSearch(row, searchNeedle)) return true;
      if (remoteSearchChatIdSet.has(row.telegram_chat_id)) return true;
      if (
        row.peer_user_id != null &&
        Number.isFinite(row.peer_user_id) &&
        remoteSearchPeerUserIdSet.has(Math.trunc(row.peer_user_id))
      ) {
        return true;
      }
      return false;
    });
    // Include TDLib hits that are not in the scroll-synced window yet.
    const remoteOnly: MessageChatRowData[] = [];
    for (const hit of remoteSearchHits) {
      if (localIds.has(hit.chatId)) continue;
      if (matched.some((row) => row.telegram_chat_id === hit.chatId)) continue;
      remoteOnly.push(remoteSearchHitToRow(hit));
    }
    const combined = [...matched, ...remoteOnly];
    return combined
      .map((row, index) => ({
        row,
        index,
        rank: chatSearchRank(
          row,
          searchNeedle,
          remoteSearchChatIdSet.has(row.telegram_chat_id) ||
            (row.peer_user_id != null &&
              remoteSearchPeerUserIdSet.has(Math.trunc(row.peer_user_id))),
        ),
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.row);
  }, [
    remoteSearchChatIdSet,
    remoteSearchHits,
    remoteSearchPeerUserIdSet,
    searchNeedle,
    sortedChats,
  ]);

  const cachedChatCount = chatListSync?.cachedCount ?? chats.length;
  const chatListRowStride = chatListRowStridePx(wideListChrome);
  const chatListSearchMarginBelow = chatListSearchMarginBelowPx(wideListChrome);
  const chatListShellTopInset =
    MESSAGE_CHAT_LIST_SEARCH_VERTICAL_INSET_PX + chatListSearchBlockHeightPx(wideListChrome);

  useEffect(() => {
    return subscribeChatListScrollMetrics(() => {
      if (chatListScrollRafRef.current != null) return;
      chatListScrollRafRef.current = requestAnimationFrame(() => {
        chatListScrollRafRef.current = null;
        setChatListScrollTick((tick) => tick + 1);
      });
    });
  }, []);

  const chatListScrollMetrics = getChatListScrollMetrics();
  const chatListEffectiveLayoutH =
    chatListScrollMetrics.layoutH > 0 ? chatListScrollMetrics.layoutH : 480;
  const chatListVirtualTotalCount = displayChats.length;
  const chatListVirtualWindow = useMemo(() => {
    const next = resolveChatListVirtualWindow(chatListVirtualTotalCount, {
      scrollY: chatListScrollMetrics.scrollY,
      layoutH: chatListEffectiveLayoutH,
    }, {
      rowStridePx: chatListRowStride,
      contentTopInsetPx: chatListShellTopInset,
      stickyWindow: chatListVirtualStickyRef.current,
    });
    chatListVirtualStickyRef.current = {
      startIndex: next.startIndex,
      endIndex: next.endIndex,
    };
    return next;
  }, [
    chatListRowStride,
    chatListScrollTick,
    chatListShellTopInset,
    chatListVirtualTotalCount,
    chatListEffectiveLayoutH,
    chatListScrollMetrics.scrollY,
  ]);
  chatListVirtualWindowRef.current = chatListVirtualWindow;

  const chatListVirtualLogRef = useRef({
    enabled: false,
    startIndex: 0,
    endIndex: 0,
    scrollY: 0,
    totalCount: 0,
  });
  useEffect(() => {
    const prev = chatListVirtualLogRef.current;
    const changed =
      prev.enabled !== chatListVirtualWindow.enabled ||
      prev.startIndex !== chatListVirtualWindow.startIndex ||
      prev.endIndex !== chatListVirtualWindow.endIndex ||
      Math.abs(prev.scrollY - chatListScrollMetrics.scrollY) > chatListRowStride ||
      prev.totalCount !== chatListVirtualTotalCount;
    if (!changed) return;
    chatListVirtualLogRef.current = {
      enabled: chatListVirtualWindow.enabled,
      startIndex: chatListVirtualWindow.startIndex,
      endIndex: chatListVirtualWindow.endIndex,
      scrollY: chatListScrollMetrics.scrollY,
      totalCount: chatListVirtualTotalCount,
    };
    logPageDisplay("messages_chat_list_virtual_window", {
      enabled: chatListVirtualWindow.enabled,
      startIndex: chatListVirtualWindow.startIndex,
      endIndex: chatListVirtualWindow.endIndex,
      topSpacerPx: chatListVirtualWindow.topSpacerPx,
      bottomSpacerPx: chatListVirtualWindow.bottomSpacerPx,
      scrollY: chatListScrollMetrics.scrollY,
      layoutH: chatListEffectiveLayoutH,
      totalCount: chatListVirtualTotalCount,
      loadedCount: displayChats.length,
      rowStridePx: chatListRowStride,
    });
  }, [
    chatListEffectiveLayoutH,
    chatListRowStride,
    chatListScrollMetrics.scrollY,
    chatListVirtualTotalCount,
    chatListVirtualWindow.bottomSpacerPx,
    chatListVirtualWindow.enabled,
    chatListVirtualWindow.endIndex,
    chatListVirtualWindow.startIndex,
    chatListVirtualWindow.topSpacerPx,
    displayChats.length,
  ]);

  const positionedComplete = chatListSync?.positionedComplete === true;
  const tier3Available = chatListSync?.tier3Available === true;
  const tier3InProgress = chatListSync?.tier3InProgress === true;
  const syncInProgress = chatListSync?.inProgress === true;
  const positionedChatCount = sortedChats.filter(
    (row) => resolveChatListTier(row) !== "unpositioned",
  ).length;
  const needsPositionedPage =
    cachedChatCount > positionedChatCount ||
    (!positionedComplete && (syncInProgress || tier3InProgress));
  const needsTier3Page =
    (positionedComplete || (!syncInProgress && !needsPositionedPage)) && tier3Available;
  const mayHaveMoreOnServer = needsPositionedPage || needsTier3Page;
  const showBottomLoader =
    !searchNeedle &&
    (syncInProgress ||
      tier3InProgress ||
      (chatListAtBottomRef.current && mayHaveMoreOnServer));

  const firstTier3Index = displayChats.findIndex(
    (row) => resolveChatListTier(row) === "unpositioned",
  );
  const showTier3Divider =
    !searchNeedle &&
    positionedComplete &&
    tier3Available &&
    firstTier3Index >= 0;

  const visibleChats = chatListVirtualWindow.enabled
    ? displayChats.slice(
        Math.min(chatListVirtualWindow.startIndex, displayChats.length),
        Math.min(displayChats.length, chatListVirtualWindow.endIndex + 1),
      )
    : displayChats;
  const visibleChatStartIndex = chatListVirtualWindow.enabled
    ? chatListVirtualWindow.startIndex
    : 0;
  const visibleChatIdsKey = visibleChats
    .map((row) => row.telegram_chat_id)
    .join(",");

  // tdesktop: keep neighbors warm so the next switch paints from cache.
  useEffect(() => {
    if (!isTelegramMessagesConnected || visibleChats.length === 0) return;
    if (isVoiceDialogUiOpen()) return;
    // Live voice on the open chat already runs SSE/soft-poll + WebRTC — neighbor
    // history storms competed for the main thread (logs: prefetch_ok mid-freeze).
    const selected = visibleChats.find((row) => row.telegram_chat_id === selectedChatId);
    if (selected?.has_active_voice_chat) return;
    prefetchVisibleChatNeighbors(visibleChats, selectedChatId, { radius: 1 });
    // visibleChats identity changes every render; key on ids + selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleChatIdsKey
  }, [isTelegramMessagesConnected, selectedChatId, visibleChatIdsKey]);

  useEffect(() => {
    setChatListBottomLoaderActive(showBottomLoader);
    return () => {
      setChatListBottomLoaderActive(false);
    };
  }, [showBottomLoader]);

  const prevChatListSyncRef = useRef(false);
  useEffect(() => {
    const inProgress = chatListSync?.inProgress === true;
    if (prevChatListSyncRef.current && !inProgress) {
      if (isVoiceDialogUiOpen()) {
        logPageDisplay("messages_chats_force_full_deferred_voice_dialog", {
          reason: "chat_list_sync_idle",
        });
      } else {
        void loadChatsRef.current({ silent: true, forceFull: true });
      }
    }
    prevChatListSyncRef.current = inProgress;
  }, [chatListSync?.inProgress]);

  useEffect(() => {
    if (searchNeedle) return;
    if (!chatListAtBottomRef.current) return;
    if (isVoiceDialogUiOpen()) return;
    if (mayHaveMoreOnServer) {
      void requestLoadMoreChats(needsPositionedPage ? "positioned" : "unpositioned");
    }
  }, [
    mayHaveMoreOnServer,
    needsPositionedPage,
    requestLoadMoreChats,
    displayChats.length,
    searchNeedle,
  ]);

  const handleChatListNearBottom = useCallback(() => {
    chatListAtBottomRef.current = true;
    if (searchNeedle) return;
    if (isVoiceDialogUiOpen()) return;
    void loadChatsRef.current({
      silent: true,
      forceFull: cachedChatCount > chats.length,
    });
    if (needsPositionedPage) {
      void requestLoadMoreChats("positioned");
    } else if (needsTier3Page) {
      void requestLoadMoreChats("unpositioned");
    }
  }, [
    cachedChatCount,
    chats.length,
    needsPositionedPage,
    needsTier3Page,
    requestLoadMoreChats,
    searchNeedle,
  ]);

  useEffect(() => {
    setChatListNearBottomHandler(handleChatListNearBottom);
    return () => {
      setChatListNearBottomHandler(null);
    };
  }, [handleChatListNearBottom]);

  const renderChatRows = (items: MessageChatRowData[], startIndex: number) => (
    <>
      {chatListVirtualWindow.enabled && chatListVirtualWindow.topSpacerPx > 0 ? (
        <View style={{ height: chatListVirtualWindow.topSpacerPx }} />
      ) : null}
      {items.map((item, index) => {
        const absoluteIndex = startIndex + index;
        const showDivider =
          showTier3Divider && absoluteIndex === firstTier3Index && firstTier3Index > 0;
        return (
          <View key={item.telegram_chat_id}>
            {showDivider ? (
              <View
                style={{
                  height: MESSAGE_ROW_HEIGHT_PX,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                }}
              >
                <Text
                  style={{
                    color: colors.secondary,
                    fontSize: 13,
                    lineHeight: 18,
                  }}
                >
                  {t("messages.moreChats")}
                </Text>
              </View>
            ) : null}
            <MessageChatRow
              item={item}
              isLast={absoluteIndex === displayChats.length - 1 && !showBottomLoader}
              isActive={chatSelectionEnabled && selectedChatId === item.telegram_chat_id}
              colors={colors}
              timePendingLabel={t("feed.timePending")}
              onPress={chatSelectionEnabled ? () => handleChatPress(item) : undefined}
              onAvatarPress={() => openProfileSheet(item)}
              onPrefetch={() => handleRowPrefetch(item)}
            />
          </View>
        );
      })}
      {chatListVirtualWindow.enabled && chatListVirtualWindow.bottomSpacerPx > 0 ? (
        <View style={{ height: chatListVirtualWindow.bottomSpacerPx }} />
      ) : null}
      <ChatListBottomSentinel
        enabled={!searchNeedle && sortedChats.length > 0}
        onNearBottom={handleChatListNearBottom}
      />
    </>
  );

  const listShellStyle = {
    ...homeListShellStyle(wideListChrome),
    paddingTop: MESSAGE_CHAT_LIST_SEARCH_VERTICAL_INSET_PX,
  };

  const searchField = (
    <MessageChatListSearchField
      value={chatListSearchQuery}
      onChangeText={setChatListSearchQuery}
      placeholder={t("messages.search.placeholder")}
      clearAccessibilityLabel={t("messages.search.clear")}
      marginBottomPx={chatListSearchMarginBelow}
    />
  );

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

  if (error && chats.length === 0) {
    return (
      <View style={[listShellStyle, { paddingVertical: 16 }]}>
        <Text style={{ textAlign: "center", color: colors.secondary, fontSize: 15, lineHeight: 20 }}>
          {t("messages.loadError")}
        </Text>
      </View>
    );
  }

  if (
    chats.length === 0 &&
    (loading || gatewayWarming || listBootstrapPending || !emptyListConfirmed)
  ) {
    return (
      <View style={[listShellStyle, { paddingVertical: 24, alignItems: "center" }]}>
        <ActivityIndicator size="small" color={colors.primary} />
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

  const searchEmpty =
    searchNeedle.length > 0 && displayChats.length === 0 ? (
      <Text
        style={{
          textAlign: "center",
          color: colors.secondary,
          fontSize: 15,
          lineHeight: 20,
          paddingVertical: 16,
        }}
      >
        {t("messages.search.noResults")}
      </Text>
    ) : null;

  const list = (
    <View style={{ width: "100%", alignSelf: "stretch" }} pointerEvents="box-none">
      <View style={listShellStyle} pointerEvents="box-none">
        {searchField}
        {searchEmpty}
        {renderChatRows(visibleChats, visibleChatStartIndex)}
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
      {searchField}
      {searchEmpty}
      {renderChatRows(visibleChats, visibleChatStartIndex)}
      <Pressable style={{ flexGrow: 1, minHeight: 1 }} onPress={handleClearSelection} />
    </ScrollView>
  );
}
