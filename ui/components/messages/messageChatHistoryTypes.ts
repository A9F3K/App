import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import {
  formattedSegmentsEqual,
  preferRicherTextSegments,
  resolveMessageDisplaySegments,
} from "./resolveMessageDisplaySegments";

export type MessageChatContentKind =
  | "text"
  | "photo"
  | "video"
  | "document"
  | "animation"
  | "sticker"
  | "call"
  | "other";

export type MessageChatKind =
  | "private"
  | "group"
  | "supergroup"
  | "channel";

export type MessageChatReplyPreview = {
  sender_name: string;
  sender_user_id: number | null;
  text: string;
  text_segments?: FormattedTextSegment[] | null;
  sender_emoji_status_custom_emoji_id?: string | null;
  sender_accent_color_light?: string | null;
  sender_accent_color_dark?: string | null;
};

/** Outgoing message delivery state for bubble checkmarks. */
export type MessageOutgoingStatus = "pending" | "delivered" | "read" | "failed";

export type MessageChatHistoryItem = {
  telegram_message_id: number;
  text: string;
  text_segments?: FormattedTextSegment[] | null;
  sent_at: string;
  sender_name: string;
  sender_user_id: number | null;
  sender_chat_id?: number | null;
  sender_is_channel?: boolean;
  /** Channel post signature (admin pen name) when enabled in the channel. */
  sender_author_signature?: string | null;
  sender_emoji_status_custom_emoji_id?: string | null;
  sender_accent_color_light?: string | null;
  sender_accent_color_dark?: string | null;
  is_outgoing: boolean;
  /** Outgoing delivery/read ticks (private chats use read receipts). */
  outgoing_status?: MessageOutgoingStatus | null;
  content_kind?: MessageChatContentKind;
  has_media?: boolean;
  media_width?: number | null;
  media_height?: number | null;
  reply_to?: MessageChatReplyPreview | null;
  /** Id of the message being replied to (even when preview text is unresolved). */
  reply_to_message_id?: number | null;
  /** Ended call was answered / had duration (content_kind call). */
  call_success?: boolean | null;
};

export type HistoryMessageContext = {
  peerUserId?: number | null;
  selfUserId?: number | null;
};

/** Resolve whether a history row is outgoing (only our messages get delivery ticks). */
export function resolveHistoryMessageIsOutgoing(params: {
  rawIsOutgoing: unknown;
  senderUserId: number | null;
  peerUserId?: number | null;
  selfUserId?: number | null;
}): boolean {
  const { rawIsOutgoing, senderUserId, peerUserId, selfUserId } = params;

  if (peerUserId != null && senderUserId === peerUserId) return false;
  if (selfUserId != null && senderUserId != null && senderUserId === selfUserId) return true;
  if (selfUserId != null && senderUserId != null && senderUserId !== selfUserId) {
    return false;
  }

  if (rawIsOutgoing === false) return false;
  if (rawIsOutgoing === true) return true;

  // Private chat: without a sender id we cannot infer direction beyond TDLib flags.
  if (peerUserId != null && senderUserId == null) return false;

  if (peerUserId != null && senderUserId != null && senderUserId !== peerUserId) {
    return true;
  }

  return false;
}

/** Delivery ticks render only on messages we actually sent. */
export function messageShowsOutgoingChecks(
  item: Pick<MessageChatHistoryItem, "is_outgoing" | "sender_user_id">,
  ctx?: HistoryMessageContext,
): boolean {
  if (!item.is_outgoing) return false;
  if (ctx?.peerUserId != null && item.sender_user_id === ctx.peerUserId) return false;
  if (ctx?.selfUserId != null && item.sender_user_id != null) {
    return item.sender_user_id === ctx.selfUserId;
  }
  if (ctx?.peerUserId != null && item.sender_user_id == null) return false;
  return true;
}

/** Normalize TDLib / API outgoing delivery state for UI ticks. */
export function coalesceOutgoingStatus(
  raw: unknown,
  isOutgoing: boolean,
): MessageOutgoingStatus | null {
  if (!isOutgoing) return null;
  if (raw === "failed") return "failed";
  if (raw === "read") return "read";
  if (raw === "delivered") return "delivered";
  if (raw === "pending") return "pending";
  return "delivered";
}

/**
 * After sendMessage succeeds, TDLib may still report `pending` briefly.
 * Treat that as delivered so the bubble shows a sent tick immediately.
 */
export function normalizeSuccessfulSendOutgoingStatus(
  raw: unknown,
  isOutgoing: boolean,
): MessageOutgoingStatus | null {
  const status = coalesceOutgoingStatus(raw, isOutgoing);
  if (!isOutgoing) return null;
  if (status === "failed") return "failed";
  if (status === "pending") return "delivered";
  return status;
}

export function resolveMessageOutgoingStatus(
  item: Pick<MessageChatHistoryItem, "is_outgoing" | "outgoing_status">,
): MessageOutgoingStatus | null {
  return coalesceOutgoingStatus(item.outgoing_status, item.is_outgoing);
}

/** Highest known private-chat read cursor (outgoing messages with id <= cursor are read). */
export function effectiveReadOutboxMessageId(
  ...candidates: Array<number | null | undefined>
): number | null {
  let max: number | null = null;
  for (const raw of candidates) {
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0 && (max == null || id > max)) {
      max = id;
    }
  }
  return max;
}

export function maxReadOutboxMessageIdFromItems(
  items: Array<Pick<MessageChatHistoryItem, "is_outgoing" | "outgoing_status" | "telegram_message_id">>,
): number | null {
  let max: number | null = null;
  for (const item of items) {
    if (!item.is_outgoing || item.outgoing_status !== "read") continue;
    const id = Number(item.telegram_message_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (max == null || id > max) max = id;
  }
  return max;
}

export function patchOutgoingStatusWithReadOutbox(
  item: MessageChatHistoryItem,
  lastReadOutboxMessageId: number | null | undefined,
): MessageChatHistoryItem {
  if (!item.is_outgoing) return item;
  if (item.outgoing_status === "pending" || item.outgoing_status === "failed") return item;
  if (item.outgoing_status === "read") return item;
  const cursor = Number(lastReadOutboxMessageId);
  if (!Number.isFinite(cursor) || cursor <= 0) return item;
  if (item.telegram_message_id <= cursor) {
    return { ...item, outgoing_status: "read" };
  }
  return item;
}

export function patchOutgoingStatusesWithReadOutbox(
  items: MessageChatHistoryItem[],
  lastReadOutboxMessageId: number | null | undefined,
): MessageChatHistoryItem[] {
  const cursor = Number(lastReadOutboxMessageId);
  const patched =
    Number.isFinite(cursor) && cursor > 0
      ? items.map((item) => patchOutgoingStatusWithReadOutbox(item, cursor))
      : items;
  return applyCumulativeOutgoingReadStatuses(patched);
}

/** If any outgoing message is read, all older outgoing in the batch are read too. */
export function applyCumulativeOutgoingReadStatuses(
  items: MessageChatHistoryItem[],
): MessageChatHistoryItem[] {
  let maxReadId: number | null = null;
  for (const item of items) {
    if (!item.is_outgoing || item.outgoing_status !== "read") continue;
    const id = item.telegram_message_id;
    if (maxReadId == null || id > maxReadId) maxReadId = id;
  }
  if (maxReadId == null) return items;
  return items.map((item) => {
    if (!item.is_outgoing) return item;
    if (item.outgoing_status === "pending" || item.outgoing_status === "failed") return item;
    if (item.telegram_message_id <= maxReadId) {
      return { ...item, outgoing_status: "read" };
    }
    return item;
  });
}

export function isGroupLikeChatKind(kind: MessageChatKind | null | undefined): boolean {
  return kind === "group" || kind === "supergroup" || kind === "channel";
}

/** Incoming group/supergroup/channel rows show a sender line (name + emoji status). */
export function shouldShowMessageSenderHeader(
  chatKind: MessageChatKind | null | undefined,
  item: Pick<
    MessageChatHistoryItem,
    "is_outgoing" | "sender_name" | "sender_user_id" | "sender_author_signature"
  >,
): boolean {
  if (!isGroupLikeChatKind(chatKind) || item.is_outgoing) return false;
  if (chatKind === "channel") {
    if (item.sender_user_id != null) return true;
    return Boolean(item.sender_author_signature?.trim());
  }
  return Boolean(item.sender_name.trim());
}

/** Private chats use TDLib read-outbox cursors and double-check read receipts. */
export type MessageChatReadReceiptContext = {
  chat_kind?: MessageChatKind | null;
  telegram_chat_id?: number;
  peer_user_id?: number | null;
};

export function isPrivateChatForReadReceipts(
  chatKind: MessageChatKind | null | undefined,
  chat?: MessageChatReadReceiptContext | null,
): boolean {
  const kind = chatKind ?? chat?.chat_kind ?? null;
  if (kind === "private") return true;
  if (isGroupLikeChatKind(kind)) return false;
  const chatId = Number(chat?.telegram_chat_id);
  if (Number.isFinite(chatId) && chatId > 0 && chat?.peer_user_id != null) return true;
  return false;
}

/** Group chats do not show per-message read ticks; keep a single delivered tick. */
export function resolveOutgoingStatusForDisplay(
  item: Pick<MessageChatHistoryItem, "is_outgoing" | "outgoing_status">,
  chatKind: MessageChatKind | null | undefined,
  chat?: MessageChatReadReceiptContext | null,
): MessageOutgoingStatus | null {
  const status = resolveMessageOutgoingStatus(item);
  if (status !== "read") return status;
  if (isPrivateChatForReadReceipts(chatKind, chat)) return status;
  return "delivered";
}

const DISPLAYABLE_MEDIA_KINDS = new Set<MessageChatContentKind>([
  "photo",
  "video",
  "animation",
  "sticker",
]);

/** Matches TDLib preview labels from {@link previewFromMessage} for bare media rows. */
const MEDIA_PREVIEW_LABEL_TO_KIND: Record<string, MessageChatContentKind> = {
  Photo: "photo",
  Video: "video",
  GIF: "animation",
  Sticker: "sticker",
};

const GENERIC_BODY_TEXT_LABEL = "Message";

function isPlaceholderBodyText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === GENERIC_BODY_TEXT_LABEL) return true;
  return MEDIA_PREVIEW_LABEL_TO_KIND[trimmed] != null;
}

function mergeTextFields(
  preferred: MessageChatHistoryItem,
  fallback: MessageChatHistoryItem,
): MessageChatHistoryItem {
  const preferredText = preferred.text.trim();
  const fallbackText = fallback.text.trim();
  const preferredOk = !isPlaceholderBodyText(preferredText);
  const fallbackOk = !isPlaceholderBodyText(fallbackText);
  if (preferredOk) return preferred;
  if (fallbackOk) return { ...preferred, text: fallback.text };
  if (preferredText === GENERIC_BODY_TEXT_LABEL) {
    return { ...preferred, text: "" };
  }
  return preferred;
}

function mediaPlaceholderLabel(kind: MessageChatContentKind): string | null {
  if (kind === "photo") return "Photo";
  if (kind === "video") return "Video";
  if (kind === "animation") return "GIF";
  if (kind === "sticker") return "Sticker";
  return null;
}

export function isDisplayableMediaContentKind(
  kind: MessageChatContentKind | null | undefined,
): boolean {
  return kind != null && DISPLAYABLE_MEDIA_KINDS.has(kind);
}

export function isDisplayableMediaMessage(
  item: Pick<MessageChatHistoryItem, "has_media" | "content_kind">,
): boolean {
  return Boolean(item.has_media) && isDisplayableMediaContentKind(item.content_kind);
}

/**
 * Backfill media metadata for history rows that only carry preview text (e.g. "Video", "GIF")
 * so older pages render with the same bare-media layout as freshly mapped messages.
 */
export function enrichHistoryMessageDisplay(item: MessageChatHistoryItem): MessageChatHistoryItem {
  let contentKind = item.content_kind;
  let hasMedia = Boolean(item.has_media);
  let text = item.text;

  if (!isDisplayableMediaContentKind(contentKind)) {
    const trimmed = text.trim();
    const inferred = MEDIA_PREVIEW_LABEL_TO_KIND[trimmed];
    if (inferred) {
      contentKind = inferred;
      hasMedia = true;
      text = "";
    }
  }

  if (isDisplayableMediaContentKind(contentKind)) {
    hasMedia = true;
    const placeholder = mediaPlaceholderLabel(contentKind);
    if (placeholder && text.trim() === placeholder) {
      text = "";
    }
  }

  if (text.trim() === GENERIC_BODY_TEXT_LABEL) {
    text = "";
  }

  const resolvedTextSegments = resolveMessageDisplaySegments(text, item.text_segments);
  const text_segments = formattedSegmentsEqual(resolvedTextSegments, item.text_segments)
    ? item.text_segments
    : resolvedTextSegments;
  let reply_to = item.reply_to;
  if (reply_to) {
    const resolvedReplySegments = resolveMessageDisplaySegments(
      reply_to.text,
      reply_to.text_segments,
    );
    if (!formattedSegmentsEqual(resolvedReplySegments, reply_to.text_segments)) {
      reply_to = { ...reply_to, text_segments: resolvedReplySegments };
    }
  }

  const mediaUnchanged =
    contentKind === item.content_kind &&
    hasMedia === Boolean(item.has_media) &&
    text === item.text;
  const segmentsUnchanged =
    text_segments === item.text_segments && reply_to === item.reply_to;

  if (mediaUnchanged && segmentsUnchanged) {
    return item;
  }

  return {
    ...item,
    content_kind: contentKind ?? item.content_kind,
    has_media: hasMedia,
    text,
    text_segments,
    reply_to,
  };
}

function mergeMediaFields(
  preferred: MessageChatHistoryItem,
  fallback: MessageChatHistoryItem,
): MessageChatHistoryItem {
  const preferredMedia = isDisplayableMediaMessage(preferred);
  const fallbackMedia = isDisplayableMediaMessage(fallback);
  if (preferredMedia) return preferred;
  if (!fallbackMedia) return preferred;

  const enrichedFallback = enrichHistoryMessageDisplay(fallback);
  return {
    ...preferred,
    content_kind: enrichedFallback.content_kind,
    has_media: enrichedFallback.has_media,
    text: enrichedFallback.text.trim() ? preferred.text : enrichedFallback.text,
    media_width: preferred.media_width ?? enrichedFallback.media_width ?? null,
    media_height: preferred.media_height ?? enrichedFallback.media_height ?? null,
  };
}

function outgoingStatusRank(status: MessageOutgoingStatus | null | undefined): number {
  if (status === "read") return 4;
  if (status === "delivered") return 3;
  if (status === "pending") return 2;
  if (status === "failed") return 1;
  return 0;
}

function mergeIsOutgoing(
  prev: MessageChatHistoryItem,
  incoming: MessageChatHistoryItem,
  ctx?: HistoryMessageContext,
): boolean {
  const senderId = incoming.sender_user_id ?? prev.sender_user_id;
  if (ctx?.peerUserId != null && senderId === ctx.peerUserId) return false;
  if (ctx?.selfUserId != null && senderId != null && senderId === ctx.selfUserId) return true;
  if (ctx?.selfUserId != null && senderId != null && senderId !== ctx.selfUserId) {
    return false;
  }
  if (incoming.is_outgoing) return true;
  if (incoming.is_outgoing === false && !prev.is_outgoing) return false;
  if (prev.is_outgoing && prev.outgoing_status != null) {
    if (ctx?.peerUserId != null && senderId == null) return false;
    return true;
  }
  return false;
}

function mergeOutgoingStatus(
  prev: MessageOutgoingStatus | null | undefined,
  incoming: MessageOutgoingStatus | null | undefined,
  isOutgoing: boolean,
): MessageOutgoingStatus | null {
  if (!isOutgoing) return null;
  const prevStatus = coalesceOutgoingStatus(prev, true);
  const incomingStatus = coalesceOutgoingStatus(incoming, true);
  return outgoingStatusRank(prevStatus) >= outgoingStatusRank(incomingStatus)
    ? prevStatus
    : incomingStatus;
}

/** Merge two rows for the same telegram_message_id, keeping the richest media metadata. */
export function mergeHistoryMessageRow(
  prev: MessageChatHistoryItem | undefined,
  incoming: MessageChatHistoryItem,
  ctx?: HistoryMessageContext,
): MessageChatHistoryItem {
  const incomingEnriched = enrichHistoryMessageDisplay(incoming);
  if (!prev) return incomingEnriched;

  const prevEnriched = enrichHistoryMessageDisplay(prev);
  const isOutgoing = mergeIsOutgoing(prevEnriched, incomingEnriched, ctx);
  const outgoingStatus = mergeOutgoingStatus(
    prevEnriched.outgoing_status,
    incomingEnriched.outgoing_status,
    isOutgoing,
  );

  return enrichHistoryMessageDisplay({
    ...mergeTextFields(mergeMediaFields(incomingEnriched, prevEnriched), prevEnriched),
    text_segments: preferRicherTextSegments(
      incomingEnriched.text_segments,
      prevEnriched.text_segments,
    ),
    sender_author_signature:
      incomingEnriched.sender_author_signature ?? prevEnriched.sender_author_signature ?? null,
    sender_emoji_status_custom_emoji_id:
      incomingEnriched.sender_emoji_status_custom_emoji_id ??
      prevEnriched.sender_emoji_status_custom_emoji_id ??
      null,
    sender_accent_color_light:
      incomingEnriched.sender_accent_color_light ?? prevEnriched.sender_accent_color_light ?? null,
    sender_accent_color_dark:
      incomingEnriched.sender_accent_color_dark ?? prevEnriched.sender_accent_color_dark ?? null,
    is_outgoing: isOutgoing,
    outgoing_status: outgoingStatus,
    reply_to:
      incomingEnriched.reply_to?.text?.trim()
        ? incomingEnriched.reply_to
        : prevEnriched.reply_to?.text?.trim()
          ? prevEnriched.reply_to
          : (incomingEnriched.reply_to ?? prevEnriched.reply_to ?? null),
    reply_to_message_id:
      incomingEnriched.reply_to_message_id ?? prevEnriched.reply_to_message_id ?? null,
  });
}
