import type { FormattedTextSegment } from "../../shared/formattedTextSegments.js";
import type { Client } from "tdl";
import {
  chatTitle,
  formattedTextPlain,
  isGenericMessagePreviewLabel,
  lastReadOutboxMessageIdFromChat,
  messageBodyText,
  messageIsOutgoing,
  messageReadDateFromTdMessage,
  peerUserIdFromChat,
  previewFromMessage,
  type TdChat,
  type TdMessage,
} from "./chatPreview.js";
import { messageTextSegments } from "./formattedTextSegments.js";
import { segmentsContainTelegramEmoji } from "../../shared/formattedTextSegments.js";
import { largestPhotoDimensions } from "./photoParse.js";
import { resolveTdUserProfile, type TdUserProfileCache } from "./tdUserProfile.js";
import { parseTdAudioMeta } from "./audioMeta.js";

export type ChatKind = "private" | "group" | "supergroup" | "channel";

export type MessageContentKind =
  | "text"
  | "photo"
  | "video"
  | "document"
  | "animation"
  | "sticker"
  | "audio"
  | "call"
  | "other";

export type MessageOutgoingStatus = "pending" | "delivered" | "read" | "failed";

export type MappedChatHistoryMessage = {
  telegram_message_id: number;
  text: string;
  text_segments?: FormattedTextSegment[] | null;
  sent_at: string;
  sender_name: string;
  sender_user_id: number | null;
  sender_chat_id: number | null;
  sender_is_channel: boolean;
  sender_author_signature?: string | null;
  sender_emoji_status_custom_emoji_id?: string | null;
  sender_accent_color_light?: string | null;
  sender_accent_color_dark?: string | null;
  is_outgoing: boolean;
  outgoing_status: MessageOutgoingStatus | null;
  content_kind: MessageContentKind;
  has_media: boolean;
  media_width?: number | null;
  media_height?: number | null;
  reply_to?: {
    sender_name: string;
    sender_user_id: number | null;
    text: string;
    text_segments?: FormattedTextSegment[] | null;
    sender_emoji_status_custom_emoji_id?: string | null;
    sender_accent_color_light?: string | null;
    sender_accent_color_dark?: string | null;
  } | null;
  /** TDLib replied message id — set even when preview text could not be resolved. */
  reply_to_message_id?: number | null;
  /** Ended call was answered / had duration (messageCall only). */
  call_success?: boolean | null;
  audio?: {
    artist: string;
    title: string;
    duration_sec: number;
    size_bytes: number;
    cover_data_url: string | null;
  } | null;
};

type UserProfileCache = Map<number, TdUserProfileCache>;

export function chatKindFromTdChat(chat: TdChat): ChatKind {
  const kind = chat.type?._;
  if (kind === "chatTypePrivate") return "private";
  if (kind === "chatTypeBasicGroup") return "group";
  if (kind === "chatTypeSupergroup") {
    const row = chat.type as { is_channel?: boolean };
    return row.is_channel ? "channel" : "supergroup";
  }
  if (kind === "chatTypeChannel") return "channel";
  return chat.id < 0 ? "supergroup" : "private";
}

export function isGroupLikeChatKind(kind: ChatKind): boolean {
  return kind === "group" || kind === "supergroup" || kind === "channel";
}

function messageContentKind(message: TdMessage): MessageContentKind {
  const type = message.content?._;
  if (type === "messageText") return "text";
  if (type === "messagePhoto") return "photo";
  if (type === "messageVideo") return "video";
  if (type === "messageDocument") return "document";
  if (type === "messageAnimation") return "animation";
  if (type === "messageSticker") return "sticker";
  if (type === "messageAudio") return "audio";
  if (type === "messageCall") return "call";
  return "other";
}

function isCallMessage(message: TdMessage): boolean {
  return message.content?._ === "messageCall";
}

function parseCallSuccess(message: TdMessage): boolean {
  const content = message.content;
  if (!content || typeof content !== "object" || (content as { _?: string })._ !== "messageCall") {
    return false;
  }
  const row = content as Record<string, unknown>;
  const duration = Number(row.duration);
  if (Number.isFinite(duration) && duration > 0) return true;
  const reason = (row.discard_reason as { _?: string } | undefined)?._;
  return (
    reason === "callDiscardReasonHungUp" || reason === "callDiscardReasonDisconnected"
  );
}

function mediaDimensions(message: TdMessage): { width: number | null; height: number | null } {
  const content = message.content;
  if (!content || typeof content !== "object") return { width: null, height: null };
  const row = content as Record<string, unknown>;
  const type = row._;
  if (type === "messagePhoto") {
    return largestPhotoDimensions(row);
  }
  if (type === "messageVideo" || type === "messageAnimation") {
    const media = (row.video ?? row.animation) as { width?: number; height?: number } | undefined;
    const w = Number(media?.width);
    const h = Number(media?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  if (type === "messageSticker") {
    const sticker = row.sticker as { width?: number; height?: number } | undefined;
    const w = Number(sticker?.width);
    const h = Number(sticker?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  return { width: null, height: null };
}

function hasDisplayableMedia(message: TdMessage): boolean {
  const kind = messageContentKind(message);
  return kind === "photo" || kind === "video" || kind === "animation" || kind === "sticker";
}

function captionText(message: TdMessage): string | null {
  const c = message.content;
  if (!c || typeof c !== "object") return null;
  const caption = formattedTextPlain((c as { caption?: unknown }).caption);
  return caption ?? null;
}

function bodyText(message: TdMessage): string {
  return messageBodyText(message);
}

function messageNeedsFullFetch(message: TdMessage): boolean {
  const text = bodyText(message).trim();
  const content = message.content;
  if (!content || typeof content !== "object") return true;
  const type = content._;
  if (type === "messageText") {
    const textRow = (content as { text?: { text?: string; entities?: unknown[] } }).text;
    const plain = typeof textRow?.text === "string" ? textRow.text.trim() : "";
    if (!plain || isGenericMessagePreviewLabel(plain)) return true;
    const entities = Array.isArray(textRow?.entities) ? textRow.entities : [];
    if (entities.length > 0) {
      const segments = messageTextSegments(message);
      if (!segments || !segmentsContainTelegramEmoji(segments)) return true;
    }
    return false;
  }
  if (typeof type === "string" && type.startsWith("message")) {
    return !text || isGenericMessagePreviewLabel(text);
  }
  return false;
}

async function resolveFullMessage(
  client: Client,
  message: TdMessage,
  chatId: number,
): Promise<TdMessage> {
  if (!messageNeedsFullFetch(message)) return message;
  const messageId = Number(message.id);
  if (!Number.isFinite(messageId) || messageId <= 0) return message;
  try {
    return (await client.invoke({
      _: "getMessage",
      chat_id: chatId,
      message_id: messageId,
    })) as TdMessage;
  } catch {
    return message;
  }
}

function readAuthorSignature(message: TdMessage): string | null {
  const sig = (message as { author_signature?: unknown }).author_signature;
  return typeof sig === "string" && sig.trim() ? sig.trim() : null;
}

async function resolveMessageSenderUserId(
  client: Client,
  chatId: number,
  messageId: number,
): Promise<number | null> {
  try {
    const sender = (await client.invoke({
      _: "getMessageSender",
      chat_id: chatId,
      message_id: messageId,
    })) as { _?: string; user_id?: number };
    if (sender?._ === "messageSenderUser" && typeof sender.user_id === "number") {
      return sender.user_id;
    }
  } catch {
    /* optional enrichment for signed channel posts */
  }
  return null;
}

type ReplyPreviewPayload = {
  sender_name: string;
  sender_user_id: number | null;
  text: string;
  text_segments: FormattedTextSegment[] | null;
  sender_emoji_status_custom_emoji_id?: string | null;
  sender_accent_color_light?: string | null;
  sender_accent_color_dark?: string | null;
};

function isMessageReplyToMessage(reply: TdMessage["reply_to"]): boolean {
  if (!reply || typeof reply !== "object") return false;
  // Current TDLib: messageReplyToMessage. Older typo / aliases kept for safety.
  return (
    reply._ === "messageReplyToMessage" ||
    reply._ === "messageReplyMessage" ||
    (typeof reply.message_id === "number" && reply.message_id > 0)
  );
}

function extractReplyToMessageId(message: TdMessage): number | null {
  const reply = message.reply_to;
  if (!isMessageReplyToMessage(reply) || !reply) return null;
  const messageId = reply.message_id;
  return typeof messageId === "number" && messageId > 0 ? messageId : null;
}

async function resolveReplyOriginSender(
  client: Client,
  reply: NonNullable<TdMessage["reply_to"]>,
  userCache: UserProfileCache,
  chatCache: Map<number, { title: string; isChannel: boolean }>,
): Promise<{ name: string; userId: number | null; profile: TdUserProfileCache | null }> {
  const origin = reply.origin;
  if (origin?._ === "messageOriginUser" && typeof origin.sender_user_id === "number") {
    const profile = await resolveTdUserProfile(client, origin.sender_user_id, userCache);
    return { name: profile.name, userId: origin.sender_user_id, profile };
  }
  if (origin?._ === "messageOriginHiddenUser" && typeof origin.sender_name === "string") {
    const name = origin.sender_name.trim();
    if (name) return { name, userId: null, profile: null };
  }
  if (origin?._ === "messageOriginChat" && typeof origin.sender_chat_id === "number") {
    const resolved = await resolveChatName(client, origin.sender_chat_id, chatCache);
    return { name: resolved.title, userId: null, profile: null };
  }
  if (origin?._ === "messageOriginChannel" && typeof origin.chat_id === "number") {
    const resolved = await resolveChatName(client, origin.chat_id, chatCache);
    const signature =
      typeof origin.author_signature === "string" ? origin.author_signature.trim() : "";
    return { name: signature || resolved.title, userId: null, profile: null };
  }
  return { name: "", userId: null, profile: null };
}

function replyPreviewTextFromInline(reply: NonNullable<TdMessage["reply_to"]>): {
  text: string;
  text_segments: FormattedTextSegment[] | null;
} {
  const quoteText =
    typeof reply.quote?.text?.text === "string" ? reply.quote.text.text.trim() : "";
  if (quoteText) {
    return { text: quoteText.slice(0, 200), text_segments: null };
  }
  if (reply.content && typeof reply.content === "object") {
    const stub = { content: reply.content } as TdMessage;
    const text = bodyText(stub).trim() || previewFromMessage(stub) || "";
    if (text) {
      return {
        text: text.slice(0, 200),
        text_segments: messageTextSegments(stub, { enrichStandardEmojis: true }),
      };
    }
  }
  return { text: "", text_segments: null };
}

async function resolveReplyPreview(
  client: Client,
  message: TdMessage,
  userCache: UserProfileCache,
  chatCache: Map<number, { title: string; isChannel: boolean }>,
): Promise<ReplyPreviewPayload | null> {
  const reply = message.reply_to;
  if (!isMessageReplyToMessage(reply) || !reply) return null;
  const chatId = typeof reply.chat_id === "number" ? reply.chat_id : message.chat_id;
  const messageId = reply.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number" || messageId <= 0) {
    return null;
  }

  try {
    const replied = (await client.invoke({
      _: "getMessage",
      chat_id: chatId,
      message_id: messageId,
    })) as TdMessage;
    const sender = await resolveSenderName(client, replied, { id: chatId } as TdChat, userCache, chatCache);
    const text = bodyText(replied).trim() || previewFromMessage(replied) || "";
    if (text) {
      return {
        sender_name: sender.name,
        sender_user_id: senderUserId(replied),
        text: text.slice(0, 200),
        text_segments: messageTextSegments(replied, { enrichStandardEmojis: true }),
        sender_emoji_status_custom_emoji_id: sender.profile?.emoji_status_custom_emoji_id ?? null,
        sender_accent_color_light: sender.profile?.accent_color_light ?? null,
        sender_accent_color_dark: sender.profile?.accent_color_dark ?? null,
      };
    }
  } catch {
    /* Fall through to inline reply_to quote/content/origin. */
  }

  const inline = replyPreviewTextFromInline(reply);
  if (!inline.text) return null;
  const originSender = await resolveReplyOriginSender(client, reply, userCache, chatCache);
  return {
    sender_name: originSender.name || "…",
    sender_user_id: originSender.userId,
    text: inline.text,
    text_segments: inline.text_segments,
    sender_emoji_status_custom_emoji_id: originSender.profile?.emoji_status_custom_emoji_id ?? null,
    sender_accent_color_light: originSender.profile?.accent_color_light ?? null,
    sender_accent_color_dark: originSender.profile?.accent_color_dark ?? null,
  };
}

function senderUserId(message: TdMessage): number | null {
  const sender = message.sender_id;
  if (sender?._ === "messageSenderUser" && typeof sender.user_id === "number") {
    return sender.user_id;
  }
  return null;
}

function senderChatId(message: TdMessage): number | null {
  const sender = message.sender_id;
  if (sender?._ === "messageSenderChat" && typeof sender.chat_id === "number") {
    return sender.chat_id;
  }
  return null;
}

function messageSentAtIso(message: TdMessage): string {
  const ts = message.date;
  if (typeof ts === "number" && ts > 0) {
    return new Date(ts * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function resolveSenderName(
  client: Client,
  message: TdMessage,
  chat: TdChat,
  userCache: UserProfileCache,
  chatCache: Map<number, { title: string; isChannel: boolean }>,
): Promise<{ name: string; isChannel: boolean; profile: TdUserProfileCache | null }> {
  const userId = senderUserId(message);
  if (userId != null) {
    const profile = await resolveTdUserProfile(client, userId, userCache);
    return { name: profile.name, isChannel: false, profile };
  }
  const senderChatIdValue = senderChatId(message);
  if (senderChatIdValue != null) {
    const resolved = await resolveChatName(client, senderChatIdValue, chatCache);
    return { name: resolved.title, isChannel: resolved.isChannel, profile: null };
  }
  return {
    name: chatTitle(chat),
    isChannel: chatKindFromTdChat(chat) === "channel",
    profile: null,
  };
}

async function resolveChatName(
  client: Client,
  chatId: number,
  cache: Map<number, { title: string; isChannel: boolean }>,
): Promise<{ title: string; isChannel: boolean }> {
  const cached = cache.get(chatId);
  if (cached) return cached;
  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    const title = chatTitle(chat);
    const kind = chatKindFromTdChat(chat);
    const resolved = { title, isChannel: kind === "channel" };
    cache.set(chatId, resolved);
    return resolved;
  } catch {
    return { title: "Channel", isChannel: true };
  }
}

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

export async function enrichOutgoingReadStatuses(
  client: Client,
  chat: TdChat,
  messages: MappedChatHistoryMessage[],
): Promise<MappedChatHistoryMessage[]> {
  if (chatKindFromTdChat(chat) !== "private") return messages;

  const readIds = new Set<number>();
  const lastReadOutbox = lastReadOutboxMessageIdFromChat(chat);
  if (lastReadOutbox != null) {
    for (const row of messages) {
      if (row.is_outgoing && row.telegram_message_id <= lastReadOutbox) {
        readIds.add(row.telegram_message_id);
      }
    }
  }

  const pending = messages.filter(
    (row) =>
      row.is_outgoing &&
      !readIds.has(row.telegram_message_id) &&
      row.outgoing_status !== "pending" &&
      row.outgoing_status !== "failed",
  );
  if (pending.length === 0 && readIds.size === 0) return messages;

  await Promise.all(
    pending.map(async (row) => {
      try {
        const readState = (await client.invoke({
          _: "getMessageReadDate",
          chat_id: chat.id,
          message_id: row.telegram_message_id,
        })) as { _?: string; date?: number };
        if (
          readState._ === "messageReadDateRead" &&
          typeof readState.date === "number" &&
          readState.date > 0
        ) {
          readIds.add(row.telegram_message_id);
          return;
        }
      } catch {
        /* fall through */
      }
      try {
        const full = (await client.invoke({
          _: "getMessage",
          chat_id: chat.id,
          message_id: row.telegram_message_id,
        })) as TdMessage;
        if (messageReadDateFromTdMessage(full) != null) {
          readIds.add(row.telegram_message_id);
        }
      } catch {
        /* per-message read info unavailable */
      }
    }),
  );

  if (readIds.size === 0) return messages;
  return messages.map((row) =>
    readIds.has(row.telegram_message_id) ? { ...row, outgoing_status: "read" } : row,
  );
}

export { lastReadOutboxMessageIdFromChat };

/** Private-chat fallback when TDLib omits `is_outgoing` on chat.last_message. */
function messageIsOutgoingForChatPreview(
  message: TdMessage,
  chat: TdChat,
  myUserId?: number | null,
): boolean {
  if (messageIsOutgoing(message, myUserId)) return true;
  const peerId = peerUserIdFromChat(chat);
  const sender = message.sender_id;
  if (sender?._ !== "messageSenderUser" || peerId == null) return false;
  return sender.user_id !== peerId;
}

export function resolveOutgoingStatusFromTdMessage(
  message: TdMessage,
  chat: TdChat,
  myUserId?: number | null,
): MessageOutgoingStatus | null {
  if (!messageIsOutgoingForChatPreview(message, chat, myUserId)) return null;

  const sendingState = message.sending_state?._;
  if (sendingState === "messageSendingStateFailed") return "failed";
  if (sendingState === "messageSendingStatePending") return "pending";

  if (messageReadDateFromTdMessage(message) != null) {
    return "read";
  }

  const messageId = Number(message.id);
  const lastReadOutbox = lastReadOutboxMessageIdFromChat(chat);
  if (
    Number.isFinite(messageId) &&
    messageId > 0 &&
    lastReadOutbox != null &&
    messageId <= lastReadOutbox
  ) {
    return "read";
  }

  return "delivered";
}

export function lastMessageOutgoingPreviewFromChat(
  chat: TdChat,
  myUserId?: number | null,
): {
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
} {
  const message = chat.last_message;
  if (!message || !messageIsOutgoingForChatPreview(message, chat, myUserId)) {
    return { last_message_is_outgoing: false, last_message_outgoing_status: null };
  }
  return {
    last_message_is_outgoing: true,
    last_message_outgoing_status: resolveOutgoingStatusFromTdMessage(message, chat, myUserId),
  };
}

function lastMessageSenderUserIdFromTdMessage(message: TdMessage | null | undefined): number | null {
  const sender = message?.sender_id;
  if (sender?._ === "messageSenderUser" && typeof sender.user_id === "number") {
    return sender.user_id;
  }
  return null;
}

function lastMessageTelegramIdFromTdMessage(message: TdMessage | null | undefined): number | null {
  const id = Number(message?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Chat list row: outgoing ticks + ids for client-side inference when flags are stale. */
export function lastMessageListRowMetaFromChat(
  chat: TdChat,
  myUserId?: number | null,
): {
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
  last_message_telegram_id: number | null;
  last_message_sender_user_id: number | null;
} {
  const message = chat.last_message ?? null;
  return {
    ...lastMessageOutgoingPreviewFromChat(chat, myUserId),
    last_message_telegram_id: lastMessageTelegramIdFromTdMessage(message),
    last_message_sender_user_id: lastMessageSenderUserIdFromTdMessage(message),
  };
}

export function lastMessageListRowMetaFromMessage(
  message: TdMessage,
  lastReadOutboxMessageId: number | null,
  myUserId?: number | null,
): {
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
  last_message_telegram_id: number | null;
  last_message_sender_user_id: number | null;
} {
  const chatId = Number(message.chat_id);
  const pseudoChat: TdChat = {
    id: Number.isFinite(chatId) ? chatId : 0,
    ...(lastReadOutboxMessageId != null
      ? { last_read_outbox_message_id: lastReadOutboxMessageId }
      : {}),
  };
  return lastMessageListRowMetaFromChat({ ...pseudoChat, last_message: message }, myUserId);
}

export function lastMessageOutgoingPreviewFromMessage(
  message: TdMessage,
  lastReadOutboxMessageId: number | null,
  myUserId?: number | null,
): {
  last_message_is_outgoing: boolean;
  last_message_outgoing_status: MessageOutgoingStatus | null;
} {
  const chatId = Number(message.chat_id);
  const pseudoChat: TdChat = {
    id: Number.isFinite(chatId) ? chatId : 0,
    ...(lastReadOutboxMessageId != null
      ? { last_read_outbox_message_id: lastReadOutboxMessageId }
      : {}),
  };
  return lastMessageOutgoingPreviewFromChat(
    { ...pseudoChat, last_message: message },
    myUserId,
  );
}

/** In private chats, any read outgoing message implies all older outgoing are read. */
export function applyCumulativeOutgoingReadStatuses(
  messages: MappedChatHistoryMessage[],
): MappedChatHistoryMessage[] {
  let maxReadId: number | null = null;
  for (const row of messages) {
    if (!row.is_outgoing || row.outgoing_status !== "read") continue;
    const id = row.telegram_message_id;
    if (maxReadId == null || id > maxReadId) maxReadId = id;
  }
  if (maxReadId == null) return messages;
  return messages.map((row) => {
    if (!row.is_outgoing) return row;
    if (row.outgoing_status === "pending" || row.outgoing_status === "failed") return row;
    if (row.telegram_message_id <= maxReadId!) {
      return { ...row, outgoing_status: "read" };
    }
    return row;
  });
}

/** Re-apply private-chat read cursor to mapped history rows. */
export function applyReadOutboxToHistoryMessages(
  messages: MappedChatHistoryMessage[],
  chat: TdChat,
): MappedChatHistoryMessage[] {
  const lastReadOutbox = lastReadOutboxMessageIdFromChat(chat);
  if (lastReadOutbox == null) return messages;
  return messages.map((row) => {
    if (!row.is_outgoing) return row;
    if (row.outgoing_status === "pending" || row.outgoing_status === "failed") return row;
    if (row.telegram_message_id <= lastReadOutbox) {
      return { ...row, outgoing_status: "read" };
    }
    if (row.outgoing_status === "read") return row;
    return { ...row, outgoing_status: "delivered" };
  });
}

export async function mapHistoryMessage(
  client: Client,
  message: TdMessage,
  chat: TdChat,
  userCache: UserProfileCache,
  chatCache: Map<number, { title: string; isChannel: boolean }>,
  myUserId?: number | null,
): Promise<MappedChatHistoryMessage | null> {
  const resolved = await resolveFullMessage(client, message, chat.id);
  const telegramMessageId = Number(resolved.id);
  if (!Number.isFinite(telegramMessageId)) return null;

  const chatKind = chatKindFromTdChat(chat);
  const authorSignature = chatKind === "channel" ? readAuthorSignature(resolved) : null;
  let resolvedSenderUserId = senderUserId(resolved);
  if (chatKind === "channel" && authorSignature && resolvedSenderUserId == null) {
    resolvedSenderUserId = await resolveMessageSenderUserId(client, chat.id, telegramMessageId);
  }

  const isCall = isCallMessage(resolved);
  const isAudio = messageContentKind(resolved) === "audio";
  const audioMeta = isAudio ? parseTdAudioMeta(resolved.content) : null;
  const text = bodyText(resolved).trim();
  const hasMedia = hasDisplayableMedia(resolved);
  if (!text && !hasMedia && !isCall && !isAudio) return null;

  const sender = await resolveSenderName(client, resolved, chat, userCache, chatCache);
  const senderChatIdValue = senderChatId(resolved);
  const replyToMessageId = extractReplyToMessageId(resolved);
  const replyTo =
    replyToMessageId != null
      ? await resolveReplyPreview(client, resolved, userCache, chatCache)
      : null;
  const dimensions = mediaDimensions(resolved);

  const textSegments = messageTextSegments(resolved, { enrichStandardEmojis: true });
  const displaySenderName = authorSignature ?? sender.name;
  let senderProfile = sender.profile;
  if (resolvedSenderUserId != null && resolvedSenderUserId !== senderUserId(resolved)) {
    senderProfile = await resolveTdUserProfile(client, resolvedSenderUserId, userCache);
  } else if (resolvedSenderUserId != null && senderProfile == null) {
    senderProfile = await resolveTdUserProfile(client, resolvedSenderUserId, userCache);
  }

  return {
    telegram_message_id: telegramMessageId,
    text,
    ...(textSegments ? { text_segments: textSegments } : {}),
    sent_at: messageSentAtIso(resolved),
    sender_name: displaySenderName,
    sender_user_id: resolvedSenderUserId ?? senderUserId(resolved),
    sender_chat_id: senderChatIdValue,
    sender_is_channel: sender.isChannel,
    ...(authorSignature ? { sender_author_signature: authorSignature } : {}),
    sender_emoji_status_custom_emoji_id: senderProfile?.emoji_status_custom_emoji_id ?? null,
    sender_accent_color_light: senderProfile?.accent_color_light ?? null,
    sender_accent_color_dark: senderProfile?.accent_color_dark ?? null,
    is_outgoing: messageIsOutgoing(resolved, myUserId),
    outgoing_status: resolveOutgoingStatusFromTdMessage(resolved, chat, myUserId),
    content_kind: messageContentKind(resolved),
    has_media: hasMedia,
    media_width: dimensions.width,
    media_height: dimensions.height,
    reply_to: replyTo,
    reply_to_message_id: replyToMessageId,
    ...(isCall ? { call_success: parseCallSuccess(resolved) } : {}),
    ...(audioMeta
      ? {
          audio: {
            artist: audioMeta.artist,
            title: audioMeta.title,
            duration_sec: audioMeta.duration_sec,
            size_bytes: audioMeta.size_bytes,
            cover_data_url: audioMeta.cover_data_url,
          },
        }
      : {}),
  };
}
