import { buildApiUrl } from "../../api/_base";
import { normalizeFormattedTextSegments } from "../../shared/formattedTextSegments";
import { safeTelegramUserIdForLog } from "../../shared/appLog";
import type {
  MessageChatContentKind,
  MessageChatHistoryItem,
  MessageChatKind,
} from "../components/messages/messageChatHistoryTypes";
import {
  coalesceOutgoingStatus,
  enrichHistoryMessageDisplay,
  resolveHistoryMessageIsOutgoing,
} from "../components/messages/messageChatHistoryTypes";
import { MESSAGE_CHAT_HISTORY_PAGE_SIZE } from "../components/messages/messageChatLayout";
import { warmupTelegramChatSession } from "./warmupTelegramChatSession";

export type ChatHistoryPageResult = {
  messages: MessageChatHistoryItem[];
  chatKind: MessageChatKind | null;
  error: string | null;
  hasMoreOlder: boolean;
  nextBeforeMessageId: number | null;
  lastReadOutboxMessageId: number | null;
  lastReadInboxMessageId: number | null;
  memberCount: number | null;
  selfUserId: number | null;
};

function normalizeChatKind(raw: unknown): MessageChatKind | null {
  if (
    raw === "private" ||
    raw === "group" ||
    raw === "supergroup" ||
    raw === "channel"
  ) {
    return raw;
  }
  return null;
}

export function normalizeHistoryMessage(
  raw: unknown,
  peerUserId: number | null | undefined,
  selfUserId: number | null | undefined,
): MessageChatHistoryItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const telegramMessageId = Number(row.telegram_message_id);
  if (!Number.isFinite(telegramMessageId)) return null;
  const text = typeof row.text === "string" ? row.text : "";
  const hasMedia = Boolean(row.has_media ?? row.hasMedia);
  const contentKindRaw = row.content_kind ?? row.contentKind;
  const contentKind =
    contentKindRaw === "text" ||
    contentKindRaw === "photo" ||
    contentKindRaw === "video" ||
    contentKindRaw === "document" ||
    contentKindRaw === "animation" ||
    contentKindRaw === "sticker" ||
    contentKindRaw === "call" ||
    contentKindRaw === "other"
      ? (contentKindRaw as MessageChatContentKind)
      : undefined;
  const isCall = contentKind === "call";
  if (!text.trim() && !hasMedia && !isCall) return null;
  const senderUserId = Number(row.sender_user_id);
  const senderChatId = Number(row.sender_chat_id);
  const safeSenderUserId = safeTelegramUserIdForLog(senderUserId) ?? null;
  const rawOutgoing = row.is_outgoing ?? row.isOutgoing;
  const isOutgoing = resolveHistoryMessageIsOutgoing({
    rawIsOutgoing: rawOutgoing,
    senderUserId: safeSenderUserId,
    peerUserId,
    selfUserId,
  });
  const outgoingRaw = row.outgoing_status ?? row.outgoingStatus;
  const outgoingStatus = coalesceOutgoingStatus(outgoingRaw, isOutgoing);
  let replyTo: MessageChatHistoryItem["reply_to"] = null;
  let replyToMessageId: number | null = null;
  const replyIdRaw = Number(row.reply_to_message_id ?? row.replyToMessageId);
  if (Number.isFinite(replyIdRaw) && replyIdRaw > 0) {
    replyToMessageId = Math.trunc(replyIdRaw);
  }
  const replyRaw = row.reply_to;
  if (replyRaw && typeof replyRaw === "object" && !Array.isArray(replyRaw)) {
    const replyRow = replyRaw as Record<string, unknown>;
    const replySenderName =
      typeof replyRow.sender_name === "string" ? replyRow.sender_name.trim() : "";
    const replyText = typeof replyRow.text === "string" ? replyRow.text.trim() : "";
    if (replyText) {
      const replySenderUserId = Number(replyRow.sender_user_id);
      replyTo = {
        sender_name: replySenderName || "…",
        sender_user_id: safeTelegramUserIdForLog(replySenderUserId) ?? null,
        text: replyText,
        text_segments: normalizeFormattedTextSegments(replyRow.text_segments),
        sender_emoji_status_custom_emoji_id:
          typeof replyRow.sender_emoji_status_custom_emoji_id === "string" &&
          replyRow.sender_emoji_status_custom_emoji_id.trim()
            ? replyRow.sender_emoji_status_custom_emoji_id.trim()
            : null,
        sender_accent_color_light:
          typeof replyRow.sender_accent_color_light === "string" &&
          replyRow.sender_accent_color_light.trim()
            ? replyRow.sender_accent_color_light.trim()
            : null,
        sender_accent_color_dark:
          typeof replyRow.sender_accent_color_dark === "string" &&
          replyRow.sender_accent_color_dark.trim()
            ? replyRow.sender_accent_color_dark.trim()
            : null,
      };
    }
  }
  return enrichHistoryMessageDisplay({
    telegram_message_id: telegramMessageId,
    text,
    text_segments: normalizeFormattedTextSegments(row.text_segments),
    sent_at: typeof row.sent_at === "string" ? row.sent_at : "",
    sender_name: typeof row.sender_name === "string" ? row.sender_name : "",
    sender_user_id: safeSenderUserId,
    sender_chat_id: Number.isFinite(senderChatId) ? senderChatId : null,
    sender_is_channel: Boolean(row.sender_is_channel),
    sender_author_signature:
      typeof row.sender_author_signature === "string" && row.sender_author_signature.trim()
        ? row.sender_author_signature.trim()
        : null,
    sender_emoji_status_custom_emoji_id:
      typeof row.sender_emoji_status_custom_emoji_id === "string" &&
      row.sender_emoji_status_custom_emoji_id.trim()
        ? row.sender_emoji_status_custom_emoji_id.trim()
        : null,
    sender_accent_color_light:
      typeof row.sender_accent_color_light === "string" && row.sender_accent_color_light.trim()
        ? row.sender_accent_color_light.trim()
        : null,
    sender_accent_color_dark:
      typeof row.sender_accent_color_dark === "string" && row.sender_accent_color_dark.trim()
        ? row.sender_accent_color_dark.trim()
        : null,
    is_outgoing: isOutgoing,
    outgoing_status: outgoingStatus,
    content_kind: contentKind,
    has_media: hasMedia,
    media_width: Number.isFinite(Number(row.media_width ?? row.mediaWidth))
      ? Number(row.media_width ?? row.mediaWidth)
      : null,
    media_height: Number.isFinite(Number(row.media_height ?? row.mediaHeight))
      ? Number(row.media_height ?? row.mediaHeight)
      : null,
    reply_to: replyTo,
    reply_to_message_id: replyToMessageId,
    call_success: isCall ? Boolean(row.call_success ?? row.callSuccess) : undefined,
  });
}

export async function fetchTelegramChatHistoryPage(
  chatId: number,
  limit: number,
  peerUserId: number | null | undefined,
  beforeMessageId?: number | null,
  sinceMessageId?: number | null,
  aroundUnread = false,
  aroundMessageId?: number | null,
  olderAbove?: number | null,
  newerBelow?: number | null,
): Promise<ChatHistoryPageResult> {
  const params = new URLSearchParams({
    chat_id: String(chatId),
    limit: String(limit),
  });
  if (
    typeof beforeMessageId === "number" &&
    Number.isFinite(beforeMessageId) &&
    beforeMessageId > 0
  ) {
    params.set("before_message_id", String(beforeMessageId));
  }
  if (
    typeof sinceMessageId === "number" &&
    Number.isFinite(sinceMessageId) &&
    sinceMessageId > 0
  ) {
    params.set("since_message_id", String(sinceMessageId));
  }
  if (aroundUnread) {
    params.set("around_unread", "1");
  }
  if (
    typeof aroundMessageId === "number" &&
    Number.isFinite(aroundMessageId) &&
    aroundMessageId > 0
  ) {
    params.set("around_message_id", String(aroundMessageId));
  }
  if (
    typeof olderAbove === "number" &&
    Number.isFinite(olderAbove) &&
    olderAbove >= 0
  ) {
    params.set("older_above", String(Math.trunc(olderAbove)));
  }
  if (
    typeof newerBelow === "number" &&
    Number.isFinite(newerBelow) &&
    newerBelow >= 0
  ) {
    params.set("newer_below", String(Math.trunc(newerBelow)));
  }
  const url = buildApiUrl(`/api/telegram-messages-history?${params.toString()}`);
  const response = await fetch(url, { method: "GET", credentials: "include" });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    messages?: unknown[];
    chat_kind?: unknown;
    member_count?: unknown;
    has_more_older?: boolean;
    next_before_message_id?: number;
    last_read_outbox_message_id?: number;
    last_read_inbox_message_id?: number;
    self_user_id?: number;
    error?: string;
  };
  if (!response.ok || !json.ok) {
    return {
      messages: [],
      chatKind: null,
      error: json.error || `HTTP_${response.status}`,
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      lastReadOutboxMessageId: null,
      lastReadInboxMessageId: null,
      memberCount: null,
      selfUserId: null,
    };
  }
  const rows: MessageChatHistoryItem[] = [];
  const selfUserRaw = Number(json.self_user_id);
  const selfUserId =
    Number.isFinite(selfUserRaw) && selfUserRaw > 0
      ? safeTelegramUserIdForLog(selfUserRaw) ?? null
      : null;
  if (Array.isArray(json.messages)) {
    for (const raw of json.messages) {
      const row = normalizeHistoryMessage(raw, peerUserId, selfUserId);
      if (row) rows.push(row);
    }
  }
  const lastReadRaw = Number(json.last_read_outbox_message_id);
  const lastReadInboxRaw = Number(json.last_read_inbox_message_id);
  const memberRaw = Number(json.member_count);
  return {
    messages: rows,
    chatKind: normalizeChatKind(json.chat_kind),
    error: null,
    hasMoreOlder: Boolean(json.has_more_older),
    nextBeforeMessageId:
      typeof json.next_before_message_id === "number" &&
      Number.isFinite(json.next_before_message_id) &&
      json.next_before_message_id > 0
        ? json.next_before_message_id
        : null,
    lastReadOutboxMessageId:
      Number.isFinite(lastReadRaw) && lastReadRaw > 0 ? lastReadRaw : null,
    lastReadInboxMessageId:
      Number.isFinite(lastReadInboxRaw) && lastReadInboxRaw > 0 ? lastReadInboxRaw : null,
    memberCount:
      Number.isFinite(memberRaw) && memberRaw > 0 ? Math.trunc(memberRaw) : null,
    selfUserId,
  };
}

/** First history page with optional gateway warmup retry. */
export async function loadTelegramChatHistoryFirstPage(
  chatId: number,
  peerUserId: number | null | undefined,
  options?: {
    warmup?: boolean;
    limit?: number;
    aroundUnread?: boolean;
    aroundMessageId?: number | null;
    olderAbove?: number | null;
    newerBelow?: number | null;
  },
): Promise<ChatHistoryPageResult> {
  const warmup = options?.warmup !== false;
  const aroundUnread = options?.aroundUnread === true;
  const aroundMessageId = options?.aroundMessageId ?? null;
  const olderAbove = options?.olderAbove ?? null;
  const newerBelow = options?.newerBelow ?? null;
  const limit =
    typeof options?.limit === "number" &&
    Number.isFinite(options.limit) &&
    options.limit > 0
      ? Math.trunc(options.limit)
      : MESSAGE_CHAT_HISTORY_PAGE_SIZE;
  const warmupPromise = warmup ? warmupTelegramChatSession(chatId) : Promise.resolve();
  const fetchArgs = [
    chatId,
    limit,
    peerUserId,
    null,
    null,
    aroundUnread,
    aroundMessageId,
    olderAbove,
    newerBelow,
  ] as const;
  let result = await fetchTelegramChatHistoryPage(...fetchArgs);
  if (
    result.error === "session_not_ready" ||
    result.error === "history_unavailable" ||
    result.error === "not_found"
  ) {
    await warmupPromise;
    result = await fetchTelegramChatHistoryPage(...fetchArgs);
  }
  return result;
}

/** Live tail sync — only messages newer than sinceMessageId. */
export async function fetchTelegramChatHistorySince(
  chatId: number,
  sinceMessageId: number,
  limit: number,
  peerUserId: number | null | undefined,
): Promise<ChatHistoryPageResult> {
  return fetchTelegramChatHistoryPage(chatId, limit, peerUserId, null, sinceMessageId);
}
