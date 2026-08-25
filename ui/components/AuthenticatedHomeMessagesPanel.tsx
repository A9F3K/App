import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { buildApiUrl } from "../../api/_base";
import { normalizeFormattedTextSegments, type FormattedTextSegment } from "../../shared/formattedTextSegments";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useProfileSheet } from "../profile/ProfileContext";
import { logPageDisplay, firstChatListLogFields, chatLogFields } from "../pageDisplayLog";
import { layout, type ThemeColors } from "../theme";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import { reorderTelegramPinnedChats } from "../telegram/reorderTelegramPinnedChats";
import { toggleTelegramChatPinned } from "../telegram/toggleTelegramChatPinned";
import {
  clearAuthenticatedHomeSelectedChat,
  mergeChatRowVoicePreferClientClear,
  openAuthenticatedHomeChatHistory,
  resolveAuthenticatedHomeOpenChatUnread,
  subscribeChatVoiceMeta,
  syncAuthenticatedHomeSelectedChat,
  useAuthenticatedHomeMiddleColumnFocus,
  useAuthenticatedHomeSelectedChat,
} from "../authenticatedHomeSelectedChat";
import {
  prefetchChatHistory,
  prefetchChatHistoryPriority,
  prefetchVisibleChatNeighbors,
  setOpenChatFocusHold,
} from "../messageChatHistoryPrefetch";
import { unlockVoiceAutoplay } from "../telegram/unlockVoiceAutoplay";
import { publishTelegramChatDirectory } from "../telegram/telegramChatDirectory";
import { getCachedChatHistory } from "../messageChatHistoryCache";
import {
  clearQueuedNormalNetworkFetches,
  demoteQueuedNetworkFetches,
} from "./messages/networkFetchQueue";
import { MessageChatRow, type MessageChatRowData, type MessageChatKind } from "./messages/MessageChatRow";
import { MessageChatListContextMenu } from "./messages/MessageChatListContextMenu";
import { useMessagesChatListSearch, markChatListSearchRowPressPending } from "../messages/MessagesChatListSearchContext";
import { ChatListBottomSentinel } from "./messages/ChatListBottomSentinel";
import {
  getChatListSyncStatus,
  setChatListSyncStatus,
  type ChatListSyncStatus,
} from "./messages/chatListSyncStatus";
import { setChatListBottomLoaderActive } from "./messages/chatListBottomLoaderStatus";
import { setChatListNearBottomHandler } from "./messages/chatListNearBottom";
import {
  invokeChatListSearchScrollToEnd,
  setChatListSearchScrollToEndHandler,
} from "./messages/chatListSearchScrollAnchor";
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
  chatListRowStridePx,
  chatListShellTopInsetPx,
  homeListShellStyle,
} from "./messages/messageListLayout";
import {
  isVoiceDialogUiOpen,
  subscribeVoiceDialogUiOpen,
} from "./messages/voiceDialogUiGate";
import { telegramEmojiDebug } from "./messages/telegramEmojiDebug";
import { useTelegramMessagesChatListStream } from "./messages/useTelegramMessagesChatListStream";
import { fetchTelegramChatListSearch, rememberTelegramFoundChat, clearTelegramRecentFoundChats, removeTelegramRecentFoundChat, type TelegramChatListSearchHit } from "../telegram/fetchTelegramChatListSearch";

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
    has_active_voice_chat: Boolean(hit.has_active_voice_chat),
    voice_chat_is_joined: Boolean(hit.has_active_voice_chat && hit.voice_chat_is_joined),
  };
}

/** Prefer the live chat-list row; keep search voice flags when the live row lags. */
function resolveSearchHitRow(
  hit: TelegramChatListSearchHit,
  liveById: Map<number, MessageChatRowData>,
): MessageChatRowData {
  const live = liveById.get(hit.chatId);
  if (!live) return remoteSearchHitToRow(hit);
  if (hit.has_active_voice_chat && !live.has_active_voice_chat) {
    return {
      ...live,
      has_active_voice_chat: true,
      voice_chat_is_joined: Boolean(hit.voice_chat_is_joined),
    };
  }
  return live;
}

type ChatListDisplayItem =
  | { kind: "chat"; key: string; row: MessageChatRowData }
  | { kind: "sectionHeader"; key: string; sectionId: string; title: string }
  | { kind: "messagesFooter"; key: string; count: number }
  | { kind: "recentsFooter"; key: string };

/** Chevron: closed → right; open → up (column-reverse search scrolls upward). */
function SearchSectionChevron({ open, color }: { open: boolean; color: string }) {
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [open, progress]);
  // Right (0°) → up (−90°) when opening.
  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "-90deg"],
  });
  return (
    <Animated.View
      style={{
        width: 14,
        height: 14,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate }],
      }}
    >
      <Svg width={14} height={14} viewBox="0 0 14 14" fill="none">
        <Path
          d="M5 2.5L9.5 7L5 11.5"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Animated.View>
  );
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

function mergeChatRowFields(
  prev: MessageChatRowData,
  fresh: MessageChatRowData,
): MessageChatRowData {
  const withVoice = mergeChatRowVoicePreferClientClear(prev, fresh);
  const unread = resolveAuthenticatedHomeOpenChatUnread(
    withVoice.unread_count,
    withVoice.telegram_chat_id,
  );
  const merged =
    unread === withVoice.unread_count
      ? withVoice
      : { ...withVoice, unread_count: unread };
  return reuseChatRowIfEqual(prev, merged);
}

/** True when every index has the same chat id (order unchanged). */
function chatListOrderMatches(
  prev: MessageChatRowData[],
  sortedIncoming: MessageChatRowData[],
): boolean {
  if (prev.length !== sortedIncoming.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i]!.telegram_chat_id !== sortedIncoming[i]!.telegram_chat_id) return false;
  }
  return true;
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

  // Truncated / warm-race snapshot must never wipe a large painted list.
  // Patch overlapping ids, keep prev-only tails, then re-sort so new activity bubbles.
  if (
    !tier3Shrinking &&
    prev.length >= CHAT_LIST_OVERSIZED_THRESHOLD &&
    incoming.length < prev.length * 0.25
  ) {
    const byId = new Map(sortedIncoming.map((row) => [row.telegram_chat_id, row]));
    const prevIds = new Set(prev.map((row) => row.telegram_chat_id));
    const merged: MessageChatRowData[] = prev.map((row) => {
      const fresh = byId.get(row.telegram_chat_id);
      return fresh ? mergeChatRowFields(row, fresh) : row;
    });
    for (const row of sortedIncoming) {
      if (!prevIds.has(row.telegram_chat_id)) {
        merged.push({
          ...row,
          unread_count: resolveAuthenticatedHomeOpenChatUnread(
            row.unread_count,
            row.telegram_chat_id,
          ),
        });
      }
    }
    return sortChatRowsTierAware(merged);
  }

  if (incoming.length >= prev.length) {
    const prevIdSet = new Set(prev.map((row) => row.telegram_chat_id));
    const hasNewIds = sortedIncoming.some((row) => !prevIdSet.has(row.telegram_chat_id));
    // In-place field merge only when order is identical — otherwise chats never
    // bubble (top id can stay put while #2/#3 swap on new messages).
    if (
      prev.length >= CHAT_LIST_VIRTUALIZE_MIN_ROWS &&
      !hasNewIds &&
      chatListOrderMatches(prev, sortedIncoming)
    ) {
      let changed = false;
      const next = prev.map((row, index) => {
        const fresh = sortedIncoming[index]!;
        const reused = mergeChatRowFields(row, fresh);
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
      merged.push(mergeChatRowFields(row, fresh));
    } else {
      // Keep prev rows (including unpositioned) when a mid-sync snapshot shrinks.
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
/** Web uses SSE push; slow poll is a reconnect safety net only when stream is healthy. */
const MESSAGES_POLL_STREAM_FALLBACK_MS = 60_000;
const CHAT_LIST_STREAM_ENABLED = typeof EventSource !== "undefined";
/** Keep paging incomplete lists without requiring the user to scroll to the bottom. */
const CHAT_LIST_AUTO_LOAD_MORE_MS = 1_800;

export function AuthenticatedHomeMessagesPanel({ colors, scrollable = true }: Props) {
  const { t, tf } = useAppStrings();
  const { openProfileSheet } = useProfileSheet();
  const { authReady, isAuthenticated, sessionTelegramMessagesConnected } = useAuth();
  const { isTelegramMessagesConnected, refreshStatus, recoverTelegramMessagesSession } =
    useTelegramMessagesConnection();
  const recoverChatsInFlightRef = useRef(false);
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
   * False until the gateway finishes the first positioned chat-list sync.
   * While false, partial cache snapshots stay behind the spinner so the list
   * appears all at once instead of growing 7 → 15 → 287 on cold open.
   */
  const [initialChatListRevealed, setInitialChatListRevealed] = useState(false);
  const initialChatListRevealedRef = useRef(false);
  initialChatListRevealedRef.current = initialChatListRevealed;
  /**
   * True after a successful chat-list fetch returned 0 rows while connected.
   * Avoids flashing `messages.empty` when chats wipe during reconnect races.
   */
  const [emptyListConfirmed, setEmptyListConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    chatListSearchQuery,
    setChatListSearchQuery,
    chatListSearchFocused,
    setChatListSearchFocused,
    dismissChatListSearch,
  } = useMessagesChatListSearch();
  /** Collapsed search sections (`true` = closed). Default open. */
  const [collapsedSearchSections, setCollapsedSearchSections] = useState<Record<string, boolean>>(
    {},
  );
  const [remoteSearchPeerUserIds, setRemoteSearchPeerUserIds] = useState<number[]>([]);
  const [remoteDirectHits, setRemoteDirectHits] = useState<TelegramChatListSearchHit[]>([]);
  const [remoteGlobalHits, setRemoteGlobalHits] = useState<TelegramChatListSearchHit[]>([]);
  const [remoteMessageHits, setRemoteMessageHits] = useState<TelegramChatListSearchHit[]>([]);
  const [remoteMessageCount, setRemoteMessageCount] = useState(0);
  const [recentSearchHits, setRecentSearchHits] = useState<TelegramChatListSearchHit[]>([]);
  const [recentSearchLoaded, setRecentSearchLoaded] = useState(false);
  const selectedChat = useAuthenticatedHomeSelectedChat();
  const middleColumnFocus = useAuthenticatedHomeMiddleColumnFocus();
  const selectedChatId = selectedChat?.telegram_chat_id ?? null;
  const selectedChatRef = useRef(selectedChat);
  selectedChatRef.current = selectedChat;
  /** Keep applyChats urgent while the list is still empty (hard-reload first paint). */
  const chatsCountRef = useRef(0);
  chatsCountRef.current = chats.length;
  const emptyUnchangedForceRef = useRef(false);

  useEffect(() => {
    publishTelegramChatDirectory(chats);
  }, [chats]);

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
  /** SSE open + recent ready/ping/revision — gates the 60s safety poll. */
  const chatListStreamHealthyRef = useRef(false);
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
        started?: boolean;
        chatListSync?: ChatListSyncStatus;
      };
      if (json.chatListSync) {
        applyChatListSync(json.chatListSync);
      }
      // Only re-pull when the gateway actually grew the cache or is still paging.
      const cached = json.chatListSync?.cachedCount ?? 0;
      const grew = cached > chatsCountRef.current;
      const stillPaging = json.chatListSync?.inProgress === true || json.started === true;
      if ((grew || stillPaging) && !isVoiceDialogUiOpen()) {
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
      if (response.status >= 500) {
        setGatewayWarming(false);
        logPageDisplay("messages_gateway_resync_timeout", {
          reason,
          status: response.status,
          elapsedMs: Date.now() - started,
        });
        const recovered = await recoverTelegramMessagesSession();
        if (!recovered) await refreshStatus();
        return false;
      }
      if (json.warming) {
        return true;
      }
      if (json.needsReconnect || json.connected === false || response.status === 403) {
        setGatewayWarming(false);
        const recovered = await recoverTelegramMessagesSession();
        if (!recovered) await refreshStatus();
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
  }, [recoverTelegramMessagesSession, refreshStatus]);

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
        if (sessionTelegramMessagesConnected === true && !recoverChatsInFlightRef.current) {
          recoverChatsInFlightRef.current = true;
          void recoverTelegramMessagesSession()
            .then((ok) => {
              if (ok) void loadChatsRef.current({ silent: false, forceFull: true });
            })
            .finally(() => {
              recoverChatsInFlightRef.current = false;
            });
        }
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
            // Text-first: show titles/previews immediately; avatars fill in later.
            if (!initialChatListRevealedRef.current) {
              setInitialChatListRevealed(true);
              setGatewayWarming(false);
            }
            const syncReady =
              json.chatListSync?.positionedComplete === true &&
              json.chatListSync?.inProgress !== true;
            if (syncReady) {
              setGatewayWarming(false);
            } else if (initialChatListRevealedRef.current) {
              setGatewayWarming(false);
            }
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
      } else if (
        initialChatListRevealedRef.current &&
        (rows.length >= 24 || Boolean(options?.silent))
      ) {
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
      if (message === "not_connected" || message.startsWith("HTTP_403")) {
        const recovered = await recoverTelegramMessagesSession();
        if (recovered) {
          void loadChatsRef.current({
            silent: Boolean(options?.silent),
            forceFull: true,
            allowAvatarResync: options?.allowAvatarResync,
          });
          return;
        }
      }
      if (!options?.silent) {
        logPageDisplay("messages_chats_error", { message, elapsedMs: Date.now() - started });
        setError(message);
        // Keep existing rows when link dropped mid-session — empty flash is worse.
        if (chatsCountRef.current === 0) {
          setChats([]);
          setEmptyListConfirmed(true);
        }
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
  }, [
    applyChatListSync,
    isAuthenticated,
    isTelegramMessagesConnected,
    recoverTelegramMessagesSession,
    sessionTelegramMessagesConnected,
  ]);

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
      // Busy chats emit revisions faster than a large apply can finish.
      // ~450ms keeps previews flowing; voice sheet still coalesces harder.
      const debounceMs = isVoiceDialogUiOpen() ? 12_000 : 450;
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
      }, 400);
    });
  }, [flushStreamChatLoad]);

  useTelegramMessagesChatListStream({
    enabled: authReady && isTelegramMessagesConnected,
    getSinceRevision: () => lastLiveRevisionRef.current,
    onRevision: onStreamRevision,
    onStreamHealthyChange: (healthy) => {
      chatListStreamHealthyRef.current = healthy;
      if (healthy) {
        unchangedPollStreakRef.current = 0;
      }
    },
  });

  useEffect(() => {
    if (!isTelegramMessagesConnected) {
      setInitialChatListRevealed(false);
    }
  }, [isTelegramMessagesConnected]);

  useEffect(() => {
    if (initialChatListRevealed) return;
    if (
      chatListSync?.positionedComplete === true &&
      chatListSync.inProgress !== true
    ) {
      setInitialChatListRevealed(true);
      setGatewayWarming(false);
    }
  }, [chatListSync, initialChatListRevealed]);

  useEffect(() => {
    if (!authReady || !isTelegramMessagesConnected || initialChatListRevealed) return;
    const id = setTimeout(() => {
      if (chatsCountRef.current > 0) {
        setInitialChatListRevealed(true);
        setGatewayWarming(false);
        logPageDisplay("messages_chats_initial_reveal_timeout", {
          count: chatsCountRef.current,
        });
      }
    }, 1_500);
    return () => clearTimeout(id);
  }, [authReady, initialChatListRevealed, isTelegramMessagesConnected]);

  useEffect(() => {
    if (!authReady) return;
    lastGatewayResyncRef.current = 0;
    pollCountRef.current = 0;
    if (isTelegramMessagesConnected) {
      setGatewayWarming(true);
      setListBootstrapPending(true);
      setInitialChatListRevealed(false);
    } else {
      setListBootstrapPending(false);
      setGatewayWarming(false);
      setInitialChatListRevealed(false);
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
          setInitialChatListRevealed(true);
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
      const streamHealthy = CHAT_LIST_STREAM_ENABLED && chatListStreamHealthyRef.current;
      const delay = isVoiceDialogUiOpen()
        ? 15_000
        : streamHealthy
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
      const hadSearchUi =
        chatListSearchFocused || chatListSearchQuery.trim().length > 0;
      if (hadSearchUi) {
        markChatListSearchRowPressPending();
      }
      const liveRow = chats.find(
        (row) => row.telegram_chat_id === item.telegram_chat_id,
      );
      const resolvedItem = liveRow ?? item;
      const sameChatAlreadyOpen =
        selectedChatRef.current?.telegram_chat_id === resolvedItem.telegram_chat_id;
      // Unlock autoplay in the same user gesture as chat selection so WebRTC
      // remote audio can play after auto listen-only join (useEffect is too late).
      if (resolvedItem.has_active_voice_chat) {
        unlockVoiceAutoplay();
      }
      logPageDisplay("messages_chat_open", chatLogFields({
        chatId: resolvedItem.telegram_chat_id,
        peerUserId: resolvedItem.peer_user_id,
        title: resolvedItem.title,
      }));
      // Pause neighbor history + demote leftover media so voice strip / open
      // history win the gateway (prod: soft poll 4–5s timeouts while previews ran).
      setOpenChatFocusHold(resolvedItem.telegram_chat_id);
      demoteQueuedNetworkFetches();
      clearQueuedNormalNetworkFetches();
      // tdesktop: start full history warm before the message list mounts.
      prefetchChatHistoryPriority(resolvedItem);
      void import("../telegram/warmupTelegramChatSession").then(({ warmupTelegramChatSession }) => {
        void warmupTelegramChatSession(resolvedItem.telegram_chat_id);
      });
      openAuthenticatedHomeChatHistory(
        resolvedItem,
        hadSearchUi && sameChatAlreadyOpen ? { forceReload: true } : undefined,
      );
      if (hadSearchUi) {
        void rememberTelegramFoundChat(resolvedItem.telegram_chat_id);
        dismissChatListSearch();
      }
      void import("./messages/messageChatAvatarPrefetch").then(
        ({ prefetchOpenChatListAvatar, prefetchOpenChatAvatars }) => {
          prefetchOpenChatListAvatar(resolvedItem);
          const cached = getCachedChatHistory(resolvedItem.telegram_chat_id);
          if (cached != null && cached.messages.length > 0) {
            prefetchOpenChatAvatars(resolvedItem, cached.messages, cached.chatKind);
          }
        },
      );
    },
    [
      chatListSearchFocused,
      chatListSearchQuery,
      chatSelectionEnabled,
      chats,
      dismissChatListSearch,
    ],
  );

  const handleRowPrefetch = useCallback((item: MessageChatRowData) => {
    prefetchChatHistory(item);
  }, []);

  const handleClearSelection = useCallback(() => {
    if (!chatSelectionEnabled) return;
    setOpenChatFocusHold(null);
    clearAuthenticatedHomeSelectedChat();
  }, [chatSelectionEnabled]);

  const [chatListMenu, setChatListMenu] = useState<{
    row: MessageChatRowData;
    anchor: { x: number; y: number };
  } | null>(null);

  const handleOpenChatListMenu = useCallback(
    (row: MessageChatRowData, anchor: { x: number; y: number }) => {
      setChatListMenu({ row, anchor });
    },
    [],
  );

  const handleCloseChatListMenu = useCallback(() => {
    setChatListMenu(null);
  }, []);

  const handleToggleChatPinned = useCallback((row: MessageChatRowData) => {
    const chatId = row.telegram_chat_id;
    const nextPinned = !Boolean(row.is_pinned);
    setChatListMenu(null);
    setChats((prev) =>
      prev.map((item) =>
        item.telegram_chat_id === chatId
          ? {
              ...item,
              is_pinned: nextPinned,
              list_tier: nextPinned ? "pinned" : "positioned",
            }
          : item,
      ),
    );
    void toggleTelegramChatPinned(chatId, nextPinned).then((result) => {
      if (result.ok) {
        setChats((prev) =>
          prev.map((item) =>
            item.telegram_chat_id === chatId
              ? {
                  ...item,
                  is_pinned: result.is_pinned,
                  list_tier: result.is_pinned ? "pinned" : "positioned",
                }
              : item,
          ),
        );
        return;
      }
      setChats((prev) =>
        prev.map((item) =>
          item.telegram_chat_id === chatId
            ? { ...item, is_pinned: row.is_pinned, list_tier: row.list_tier }
            : item,
        ),
      );
    });
  }, []);

  const pinnedDragFromRef = useRef<number | null>(null);
  const pinnedDragStartYRef = useRef(0);
  const pinnedDragMovedRef = useRef(false);
  const pinnedOrderBeforeDragRef = useRef<number[] | null>(null);
  const pinnedOrderLiveRef = useRef<number[] | null>(null);
  const pinnedCommitPendingRef = useRef(false);

  const movePinnedChat = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setChats((prev) => {
      const sorted = sortChatRowsTierAware(prev);
      const pinned = sorted.filter((row) => resolveChatListTier(row) === "pinned");
      if (from >= pinned.length || to >= pinned.length) return prev;
      const nextPinned = [...pinned];
      const [moved] = nextPinned.splice(from, 1);
      if (!moved) return prev;
      nextPinned.splice(to, 0, moved);
      const ids = nextPinned.map((row) => row.telegram_chat_id);
      pinnedOrderLiveRef.current = ids;
      const base = Date.now();
      const orderById = new Map(
        ids.map((id, i) => [id, `${base}${String(Math.max(0, 9999 - i)).padStart(4, "0")}`]),
      );
      return prev.map((row) => {
        const nextOrder = orderById.get(row.telegram_chat_id);
        if (nextOrder == null) return row;
        return {
          ...row,
          is_pinned: true,
          list_tier: "pinned" as const,
          pin_order: nextOrder,
        };
      });
    });
    pinnedDragMovedRef.current = true;
  }, []);

  const applyOptimisticPinnedOrder = useCallback((pinnedIdsTopToBottom: number[]) => {
    const base = Date.now();
    const orderById = new Map(
      pinnedIdsTopToBottom.map((id, i) => [
        id,
        `${base}${String(Math.max(0, 9999 - i)).padStart(4, "0")}`,
      ]),
    );
    setChats((prev) =>
      prev.map((row) => {
        const nextOrder = orderById.get(row.telegram_chat_id);
        if (nextOrder == null) return row;
        return {
          ...row,
          is_pinned: true,
          list_tier: "pinned" as const,
          pin_order: nextOrder,
        };
      }),
    );
  }, []);

  const commitPinnedOrder = useCallback(() => {
    if (pinnedCommitPendingRef.current) return;
    const before = pinnedOrderBeforeDragRef.current;
    const current = pinnedOrderLiveRef.current;
    pinnedOrderBeforeDragRef.current = null;
    pinnedOrderLiveRef.current = null;
    if (!before || !current || !pinnedDragMovedRef.current) return;
    if (
      current.length === 0 ||
      (current.length === before.length && current.every((id, i) => id === before[i]))
    ) {
      return;
    }
    pinnedCommitPendingRef.current = true;
    void reorderTelegramPinnedChats(current).then((result) => {
      pinnedCommitPendingRef.current = false;
      if (result.ok) return;
      applyOptimisticPinnedOrder(before);
    });
  }, [applyOptimisticPinnedOrder]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onMove = (event: PointerEvent) => {
      const from = pinnedDragFromRef.current;
      if (from == null) return;
      if (!pinnedDragMovedRef.current) {
        if (Math.abs(event.clientY - pinnedDragStartYRef.current) < 6) return;
        pinnedDragMovedRef.current = true;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const row = el?.closest?.("[data-pinned-index]") as HTMLElement | null;
      if (!row) return;
      const to = Number(row.dataset.pinnedIndex);
      if (!Number.isFinite(to) || to === from) return;
      movePinnedChat(from, to);
      pinnedDragFromRef.current = to;
    };
    const onUp = () => {
      if (pinnedDragFromRef.current == null) return;
      pinnedDragFromRef.current = null;
      commitPinnedOrder();
      window.setTimeout(() => {
        pinnedDragMovedRef.current = false;
      }, 0);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [commitPinnedOrder, movePinnedChat]);

  const handleViewChatProfile = useCallback(
    (row: MessageChatRowData) => {
      setChatListMenu(null);
      openProfileSheet(row);
    },
    [openProfileSheet],
  );

  const sortedChats = useMemo(() => sortChatRowsTierAware(chats), [chats]);
  const pinnedIndexByChatId = useMemo(() => {
    const map = new Map<number, number>();
    let pinnedIndex = 0;
    for (const row of sortedChats) {
      if (resolveChatListTier(row) !== "pinned") continue;
      map.set(row.telegram_chat_id, pinnedIndex);
      pinnedIndex += 1;
    }
    return map;
  }, [sortedChats]);
  const searchNeedle = useMemo(
    () => normalizeSearchNeedle(chatListSearchQuery),
    [chatListSearchQuery],
  );
  const recentsMode = chatListSearchFocused && !searchNeedle;
  const listSearchActive = Boolean(searchNeedle) || recentsMode;
  useEffect(() => {
    if (!searchNeedle) {
      setCollapsedSearchSections({});
    }
  }, [searchNeedle]);

  useEffect(() => {
    if (!isTelegramMessagesConnected || !searchNeedle) {
      setRemoteSearchPeerUserIds([]);
      setRemoteDirectHits([]);
      setRemoteGlobalHits([]);
      setRemoteMessageHits([]);
      setRemoteMessageCount(0);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchTelegramChatListSearch(chatListSearchQuery, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) return;
        setRemoteSearchPeerUserIds(result.peerUserIds);
        setRemoteDirectHits(result.directChats);
        setRemoteGlobalHits(result.globalChats);
        setRemoteMessageHits(result.messageChats);
        setRemoteMessageCount(result.messageCount);
        logPageDisplay("messages_chat_list_search", {
          query: chatListSearchQuery.trim(),
          chatIdCount: result.chatIds.length,
          peerUserIdCount: result.peerUserIds.length,
          directCount: result.directChats.length,
          globalCount: result.globalChats.length,
          messageChatCount: result.messageChats.length,
          messageCount: result.messageCount,
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

  useEffect(() => {
    if (!isTelegramMessagesConnected || !recentsMode) {
      if (!recentsMode) {
        setRecentSearchLoaded(false);
      }
      return;
    }
    const controller = new AbortController();
    setRecentSearchLoaded(false);
    void fetchTelegramChatListSearch("", controller.signal, { recent: true }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        if (result.error === "aborted") return;
        setRecentSearchHits([]);
        setRecentSearchLoaded(true);
        return;
      }
      setRecentSearchHits(result.chats);
      setRecentSearchLoaded(true);
    });
    return () => {
      controller.abort();
    };
  }, [isTelegramMessagesConnected, recentsMode]);

  const handleClearRecentSearch = useCallback(() => {
    void clearTelegramRecentFoundChats().then((ok) => {
      if (!ok) return;
      setRecentSearchHits([]);
      setRecentSearchLoaded(true);
    });
  }, []);

  const handleRemoveRecentSearch = useCallback(
    (chatId: number) => {
      void removeTelegramRecentFoundChat(chatId).then((ok) => {
        if (!ok) return;
        setRecentSearchHits((prev) => prev.filter((hit) => hit.chatId !== chatId));
      });
    },
    [],
  );

  const remoteDirectChatIdSet = useMemo(
    () => new Set(remoteDirectHits.map((hit) => hit.chatId)),
    [remoteDirectHits],
  );

  const displayListItems = useMemo((): ChatListDisplayItem[] => {
    // Search/recents use column-reverse: first array item sits nearest the search field (bottom).
    if (recentsMode) {
      const liveById = new Map(sortedChats.map((row) => [row.telegram_chat_id, row]));
      const items: ChatListDisplayItem[] = [];
      // column-reverse: footer first in array → nearest the search field (visual bottom).
      if (recentSearchLoaded && recentSearchHits.length > 0) {
        items.push({ kind: "recentsFooter", key: "recents-footer" });
      }
      for (const hit of recentSearchHits) {
        items.push({
          kind: "chat",
          key: `chat-${hit.chatId}`,
          row: resolveSearchHitRow(hit, liveById),
        });
      }
      return items;
    }
    if (!searchNeedle) {
      return sortedChats.map((row) => ({
        kind: "chat" as const,
        key: `chat-${row.telegram_chat_id}`,
        row,
      }));
    }

    const liveById = new Map(sortedChats.map((row) => [row.telegram_chat_id, row]));
    const directPeerIdSet = new Set(remoteSearchPeerUserIds);
    for (const hit of remoteDirectHits) {
      if (hit.peerUserId != null && Number.isFinite(hit.peerUserId) && hit.peerUserId !== 0) {
        directPeerIdSet.add(Math.trunc(hit.peerUserId));
      }
    }

    const directIds = new Set<number>();
    const directRows: MessageChatRowData[] = [];
    const localDirect = sortedChats
      .filter((row) => {
        if (chatMatchesLocalSearch(row, searchNeedle)) return true;
        if (remoteDirectChatIdSet.has(row.telegram_chat_id)) return true;
        if (
          row.peer_user_id != null &&
          Number.isFinite(row.peer_user_id) &&
          directPeerIdSet.has(Math.trunc(row.peer_user_id))
        ) {
          return true;
        }
        return false;
      })
      .map((row, index) => ({
        row,
        index,
        rank: chatSearchRank(
          row,
          searchNeedle,
          remoteDirectChatIdSet.has(row.telegram_chat_id) ||
            (row.peer_user_id != null &&
              directPeerIdSet.has(Math.trunc(row.peer_user_id))),
        ),
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.row);

    for (const row of localDirect) {
      if (directIds.has(row.telegram_chat_id)) continue;
      directIds.add(row.telegram_chat_id);
      directRows.push(row);
    }
    for (const hit of remoteDirectHits) {
      if (directIds.has(hit.chatId)) continue;
      directIds.add(hit.chatId);
      directRows.push(resolveSearchHitRow(hit, liveById));
    }

    const globalRows = remoteGlobalHits
      .filter((hit) => !directIds.has(hit.chatId))
      .map((hit) => resolveSearchHitRow(hit, liveById));
    const globalIdSet = new Set(globalRows.map((row) => row.telegram_chat_id));

    const messageRows = remoteMessageHits
      .filter((hit) => !directIds.has(hit.chatId) && !globalIdSet.has(hit.chatId))
      .map((hit) => resolveSearchHitRow(hit, liveById));

    const items: ChatListDisplayItem[] = [];
    // column-reverse: first item sits nearest the search field (visual bottom).
    // Messages-found chrome belongs there so results read upward.
    const foundCount = Math.max(
      0,
      Number.isFinite(remoteMessageCount) ? remoteMessageCount : 0,
      messageRows.length,
    );
    if (foundCount > 0 || messageRows.length > 0 || globalRows.length > 0 || directRows.length > 0) {
      items.push({
        kind: "messagesFooter",
        key: "search-messages-footer",
        count: foundCount,
      });
    }
    for (const row of directRows) {
      items.push({ kind: "chat", key: `chat-${row.telegram_chat_id}`, row });
    }
    if (globalRows.length > 0) {
      const globalOpen = collapsedSearchSections.global !== true;
      items.push({
        kind: "sectionHeader",
        key: "search-global-header",
        sectionId: "global",
        title: t("messages.search.globalResults"),
      });
      if (globalOpen) {
        for (const row of globalRows) {
          items.push({ kind: "chat", key: `chat-${row.telegram_chat_id}`, row });
        }
      }
    }
    for (const row of messageRows) {
      items.push({ kind: "chat", key: `chat-msg-${row.telegram_chat_id}`, row });
    }
    return items;
  }, [
    collapsedSearchSections,
    recentsMode,
    recentSearchHits,
    recentSearchLoaded,
    remoteDirectChatIdSet,
    remoteDirectHits,
    remoteGlobalHits,
    remoteMessageCount,
    remoteMessageHits,
    searchNeedle,
    sortedChats,
    t,
  ]);

  const displayChats = useMemo(
    () =>
      displayListItems
        .filter((item): item is Extract<ChatListDisplayItem, { kind: "chat" }> => item.kind === "chat")
        .map((item) => item.row),
    [displayListItems],
  );

  const cachedChatCount = chatListSync?.cachedCount ?? chats.length;
  const chatListRowStride = chatListRowStridePx(wideListChrome);
  const chatListShellTopInset = chatListShellTopInsetPx(wideListChrome);

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
  const chatListVirtualTotalCount = listSearchActive
    ? displayListItems.length
    : displayChats.length;
  const chatListVirtualWindow = useMemo(() => {
    if (listSearchActive) {
      return {
        enabled: false,
        startIndex: 0,
        endIndex: Math.max(0, displayListItems.length - 1),
        topSpacerPx: 0,
        bottomSpacerPx: 0,
      };
    }
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
    displayListItems.length,
    listSearchActive,
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
  // Telegram Desktop / WebK: page until the main list is complete, then optional
  // supplementary tail. Do NOT use "unpositioned row count" as a missing-page signal.
  const listBehindCache = chats.length < cachedChatCount;
  const needsPositionedPage = !positionedComplete || (listBehindCache && syncInProgress);
  const needsTier3Page = positionedComplete && !listBehindCache && tier3Available;
  const mayHaveMoreOnServer =
    needsPositionedPage || needsTier3Page || syncInProgress || tier3InProgress;
  const showBottomLoader =
    !searchNeedle &&
    !recentsMode &&
    (syncInProgress ||
      tier3InProgress ||
      (chatListAtBottomRef.current && mayHaveMoreOnServer));

  const visibleListItems = chatListVirtualWindow.enabled
    ? displayListItems.slice(
        Math.min(chatListVirtualWindow.startIndex, displayListItems.length),
        Math.min(displayListItems.length, chatListVirtualWindow.endIndex + 1),
      )
    : displayListItems;
  const visibleChatStartIndex = chatListVirtualWindow.enabled
    ? chatListVirtualWindow.startIndex
    : 0;
  const visibleChats = visibleListItems
    .filter((item): item is Extract<ChatListDisplayItem, { kind: "chat" }> => item.kind === "chat")
    .map((item) => item.row);
  const visibleChatIdsKey = visibleChats
    .map((row) => row.telegram_chat_id)
    .join(",");
  /**
   * Boost avatar fetch for the visual top of the viewport first.
   * Default list is top→bottom (index 0 = top). Search/recents use column-reverse
   * (last indices = visual top).
   */
  const prioritizeAvatarChatIds = useMemo(() => {
    const topVisibleCount = Math.min(12, visibleChats.length);
    if (topVisibleCount === 0) return new Set<number>();
    const topFirst = listSearchActive
      ? visibleChats.slice(-topVisibleCount)
      : visibleChats.slice(0, topVisibleCount);
    return new Set(topFirst.map((row) => row.telegram_chat_id));
  }, [listSearchActive, visibleChatIdsKey]);

  // tdesktop: keep neighbors warm so the next switch paints from cache.
  useEffect(() => {
    if (!isTelegramMessagesConnected || visibleChats.length === 0) return;
    if (isVoiceDialogUiOpen()) return;
    // Live voice on the open chat already runs SSE/soft-poll + WebRTC — neighbor
    // history storms competed for the main thread (logs: prefetch_ok mid-freeze).
    const selected = visibleChats.find((row) => row.telegram_chat_id === selectedChatId);
    if (selected?.has_active_voice_chat) return;
    prefetchVisibleChatNeighbors(visibleChats, selectedChatId, {
      radius: 1,
      visualTopAtEnd: listSearchActive,
    });
    // visibleChats identity changes every render; key on ids + selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibleChatIdsKey
  }, [isTelegramMessagesConnected, listSearchActive, selectedChatId, visibleChatIdsKey]);

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
    if (listSearchActive) return;
    if (!listBehindCache) return;
    if (isVoiceDialogUiOpen()) return;
    void loadChatsRef.current({ silent: true, forceFull: true });
  }, [listBehindCache, listSearchActive, cachedChatCount, chats.length]);

  useEffect(() => {
    if (listSearchActive) return;
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
    listSearchActive,
  ]);

  // Background sync alone is not enough if SSE is quiet — keep paging until the
  // gateway reports the main list (and tier-3 tail) is complete.
  useEffect(() => {
    if (!authReady || !isTelegramMessagesConnected) return;
    if (listSearchActive) return;
    if (!mayHaveMoreOnServer) return;

    const tick = () => {
      if (isVoiceDialogUiOpen()) return;
      void requestLoadMoreChats(needsPositionedPage ? "positioned" : "unpositioned");
    };
    tick();
    const id = setInterval(tick, CHAT_LIST_AUTO_LOAD_MORE_MS);
    return () => clearInterval(id);
  }, [
    authReady,
    isTelegramMessagesConnected,
    mayHaveMoreOnServer,
    needsPositionedPage,
    requestLoadMoreChats,
    listSearchActive,
  ]);

  const handleChatListNearBottom = useCallback(() => {
    chatListAtBottomRef.current = true;
    if (listSearchActive) return;
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
    listSearchActive,
  ]);

  useEffect(() => {
    setChatListNearBottomHandler(handleChatListNearBottom);
    return () => {
      setChatListNearBottomHandler(null);
    };
  }, [handleChatListNearBottom]);

  useEffect(() => {
    if (!listSearchActive) return;
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        invokeChatListSearchScrollToEnd();
      });
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
    };
  }, [
    listSearchActive,
    searchNeedle,
    recentsMode,
    recentSearchLoaded,
  ]);

  const renderListItems = (items: ChatListDisplayItem[], startIndex: number) => (
    <>
      {chatListVirtualWindow.enabled && chatListVirtualWindow.topSpacerPx > 0 ? (
        <View style={{ height: chatListVirtualWindow.topSpacerPx }} />
      ) : null}
      {items.map((item, index) => {
        const absoluteIndex = startIndex + index;
        // column-reverse: first item is nearest the search field (visual bottom).
        const isVisualBottomEdge = listSearchActive
          ? absoluteIndex === 0
          : absoluteIndex === displayListItems.length - 1 && !showBottomLoader;
        if (item.kind === "sectionHeader") {
          const sectionOpen = collapsedSearchSections[item.sectionId] !== true;
          // 1px between closed section dividers; slightly more when open.
          const gapPx = sectionOpen ? 2 : 1;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityState={{ expanded: sectionOpen }}
              onPress={() => {
                setCollapsedSearchSections((prev) => ({
                  ...prev,
                  [item.sectionId]: sectionOpen,
                }));
              }}
              style={{
                backgroundColor: colors.undercover,
                paddingVertical: 8,
                paddingHorizontal: layout.contentSideInsetPx,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                // column-reverse: marginTop separates toward the next section above.
                marginBottom: listSearchActive ? 0 : 2,
                marginTop: listSearchActive ? gapPx : 0,
              }}
            >
              <SearchSectionChevron
                open={sectionOpen}
                color={sectionOpen ? colors.primary : colors.secondary}
              />
              <Text
                style={{
                  color: sectionOpen ? colors.primary : colors.secondary,
                  fontSize: 13,
                  lineHeight: 18,
                  flex: 1,
                }}
              >
                {item.title}
              </Text>
            </Pressable>
          );
        }
        if (item.kind === "recentsFooter") {
          return (
            <View
              key={item.key}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                backgroundColor: colors.undercover,
                borderTopWidth: 1,
                borderTopColor: colors.highlight,
                paddingVertical: 8,
                paddingHorizontal: layout.contentSideInsetPx,
                // Nearest the search field in column-reverse — chats stack upward from here.
                marginTop: 0,
                marginBottom: 2,
                minHeight: 24,
              }}
            >
              <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }}>
                {t("messages.search.recentsTitle")}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("messages.search.recentsClear")}
                onPress={handleClearRecentSearch}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.65 : 1,
                  paddingVertical: 4,
                  paddingLeft: 8,
                })}
              >
                <Text style={{ color: colors.accent, fontSize: 13, lineHeight: 18 }}>
                  {t("messages.search.recentsClear")}
                </Text>
              </Pressable>
            </View>
          );
        }
        if (item.kind === "messagesFooter") {
          const countLabel = tf("messages.search.messagesFound", {
            count: String(Math.max(0, Math.trunc(Number(item.count) || 0))),
          });
          return (
            <View
              key={item.key}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                backgroundColor: colors.undercover,
                borderTopWidth: listSearchActive ? 1 : 0,
                borderBottomWidth: listSearchActive ? 0 : 1,
                borderTopColor: colors.highlight,
                borderBottomColor: colors.highlight,
                paddingVertical: 10,
                paddingHorizontal: layout.contentSideInsetPx,
                // Nearest the search field in column-reverse — content stacks upward from here.
                marginTop: listSearchActive ? 0 : 2,
                marginBottom: listSearchActive ? 2 : 0,
              }}
            >
              <Text
                style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, flex: 1, flexShrink: 1, minWidth: 0 }}
                numberOfLines={1}
              >
                {countLabel}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("messages.search.allChats")}
                onPress={dismissChatListSearch}
                hitSlop={8}
              >
                <Text style={{ color: colors.primary, fontSize: 13, lineHeight: 18 }}>
                  {t("messages.search.allChats")}
                </Text>
              </Pressable>
            </View>
          );
        }
        return (
          <View
            key={item.key}
            {...(Platform.OS === "web" &&
            listSearchActive
              ? ({
                  onPointerDown: (e: { button?: number; stopPropagation?: () => void }) => {
                    if (e.button != null && e.button !== 0) return;
                    if (pinnedDragMovedRef.current) return;
                    markChatListSearchRowPressPending();
                  },
                } as object)
              : Platform.OS === "web" &&
            !listSearchActive &&
            pinnedIndexByChatId.has(item.row.telegram_chat_id)
              ? ({
                  "data-pinned-index": String(
                    pinnedIndexByChatId.get(item.row.telegram_chat_id),
                  ),
                  onPointerDown: (e: {
                    button?: number;
                    clientY: number;
                    stopPropagation?: () => void;
                  }) => {
                    if (e.button != null && e.button !== 0) return;
                    const idx = pinnedIndexByChatId.get(item.row.telegram_chat_id);
                    if (idx == null) return;
                    pinnedDragFromRef.current = idx;
                    pinnedDragStartYRef.current = e.clientY;
                    pinnedDragMovedRef.current = false;
                    pinnedOrderBeforeDragRef.current = sortedChats
                      .filter((row) => resolveChatListTier(row) === "pinned")
                      .map((row) => row.telegram_chat_id);
                    pinnedOrderLiveRef.current = pinnedOrderBeforeDragRef.current;
                  },
                  style: { cursor: "grab" },
                } as object)
              : {})}
          >
            <MessageChatRow
              item={item.row}
              isLast={isVisualBottomEdge}
              isActive={
                chatSelectionEnabled &&
                middleColumnFocus === "chat" &&
                selectedChatId === item.row.telegram_chat_id
              }
              prioritizeAvatar={prioritizeAvatarChatIds.has(item.row.telegram_chat_id)}
              colors={colors}
              timePendingLabel={t("feed.timePending")}
              onPress={
                chatSelectionEnabled
                  ? () => {
                      if (pinnedDragMovedRef.current) return;
                      handleChatPress(item.row);
                    }
                  : undefined
              }
              onPressIn={
                listSearchActive && chatSelectionEnabled
                  ? () => {
                      markChatListSearchRowPressPending();
                    }
                  : undefined
              }
              onOpenContextMenu={(anchor) => handleOpenChatListMenu(item.row, anchor)}
              onAvatarPress={() => openProfileSheet(item.row)}
              onPrefetch={() => handleRowPrefetch(item.row)}
            />
          </View>
        );
      })}
      {chatListVirtualWindow.enabled && chatListVirtualWindow.bottomSpacerPx > 0 ? (
        <View style={{ height: chatListVirtualWindow.bottomSpacerPx }} />
      ) : null}
      {!listSearchActive ? (
        <ChatListBottomSentinel
          enabled={sortedChats.length > 0}
          onNearBottom={handleChatListNearBottom}
        />
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

  if (error && chats.length === 0) {
    return (
      <View style={[listShellStyle, { paddingVertical: 16 }]}>
        <Text style={{ textAlign: "center", color: colors.secondary, fontSize: 15, lineHeight: 20 }}>
          {t("messages.loadError")}
        </Text>
      </View>
    );
  }

  const showChatListSpinner =
    chats.length === 0 &&
    (loading || gatewayWarming || listBootstrapPending || !emptyListConfirmed);

  if (showChatListSpinner) {
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

  const searchResultChatCount = displayListItems.filter((item) => item.kind === "chat").length;
  const searchEmpty =
    searchNeedle.length > 0 && searchResultChatCount === 0 && remoteMessageCount === 0 ? (
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
    ) : recentsMode && recentSearchLoaded && displayChats.length === 0 ? (
      <Text
        style={{
          textAlign: "center",
          color: colors.secondary,
          fontSize: 15,
          lineHeight: 20,
          paddingVertical: 16,
        }}
      >
        {t("messages.search.recentsEmpty")}
      </Text>
    ) : null;

  const list = (
    <View style={{ width: "100%", alignSelf: "stretch" }} pointerEvents="box-none">
      <View
        style={[
          listShellStyle,
          listSearchActive
            ? {
                // Grow upward from the search field: first result sits at the visual bottom.
                // No minHeight — stretching to the viewport left a large empty gap above the field.
                flexDirection: "column-reverse",
                justifyContent: "flex-start",
              }
            : null,
        ]}
        pointerEvents="box-none"
      >
        {searchEmpty}
        {renderListItems(visibleListItems, visibleChatStartIndex)}
      </View>
    </View>
  );

  const chatListMenuEl = (
    <MessageChatListContextMenu
      visible={chatListMenu != null}
      anchor={chatListMenu?.anchor ?? null}
      colors={colors}
      row={chatListMenu?.row ?? null}
      onClose={handleCloseChatListMenu}
      onTogglePin={handleToggleChatPinned}
      onViewProfile={handleViewChatProfile}
    />
  );

  if (!scrollable) {
    return (
      <>
        {list}
        {chatListMenuEl}
      </>
    );
  }

  return (
    <>
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
      {chatListMenuEl}
    </>
  );
}
