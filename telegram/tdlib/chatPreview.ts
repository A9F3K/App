import type { Client } from "tdl";
import type { FormattedTextSegment } from "../../shared/formattedTextSegments.js";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { previewSegmentsFromMessage } from "./formattedTextSegments.js";

export type TdMessage = {
  id?: number;
  chat_id?: number;
  date?: number;
  is_outgoing?: boolean;
  sending_state?: { _?: string };
  interaction_info?: {
    _?: string;
    read_date?: number;
  };
  sender_id?: { _?: string; user_id?: number; chat_id?: number };
  reply_to?: {
    _?: string;
    chat_id?: number;
    message_id?: number;
    quote?: { text?: { text?: string } };
    origin?: {
      _?: string;
      sender_user_id?: number;
      sender_name?: string;
      sender_chat_id?: number;
      chat_id?: number;
      author_signature?: string;
    };
    content?: Record<string, unknown>;
  };
  content?: Record<string, unknown>;
};

export type TdChat = {
  id: number;
  title?: string;
  emoji_status?: unknown;
  type?: {
    _?: string;
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    user_id?: number;
    basic_group_id?: number;
    supergroup_id?: number;
    is_channel?: boolean;
  };
  last_message?: TdMessage;
  unread_count?: number;
  last_read_inbox_message_id?: number;
  last_read_outbox_message_id?: number;
  photo?: { small?: { id?: number }; big?: { id?: number } };
  /** Active voice / video chat for this chat (`group_call_id` is 0 when none). */
  video_chat?: {
    _?: string;
    group_call_id?: number;
    has_participants?: boolean;
  };
  positions?: Array<{
    list?: { _?: string };
    order?: string;
    is_pinned?: boolean;
  }>;
};

/** Active Telegram voice/video chat attached to a chat, if any. */
export function voiceChatFromTdChat(chat: TdChat): {
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
} {
  const groupCallId = normalizeTelegramGroupCallId(chat.video_chat?.group_call_id);
  if (groupCallId == null) {
    return { has_active_voice_chat: false, voice_chat_group_call_id: null };
  }
  // TDLib often keeps a non-zero group_call_id after the room empties.
  // Only surface voice UI while someone is actually in the call (started by
  // you or someone else) — matches Telegram's live voice-chat chrome.
  if (chat.video_chat?.has_participants !== true) {
    return { has_active_voice_chat: false, voice_chat_group_call_id: null };
  }
  return {
    has_active_voice_chat: true,
    voice_chat_group_call_id: groupCallId,
  };
}

export function isChatPinnedInMainList(chat: TdChat): boolean {
  const positions = chat.positions;
  if (!Array.isArray(positions)) return false;
  return positions.some((row) => row.list?._ === "chatListMain" && row.is_pinned === true);
}

/** True when TDLib places the chat on the main chat list (not archive-only / search-only). */
export function isChatInMainList(chat: TdChat): boolean {
  const positions = chat.positions;
  if (!Array.isArray(positions)) return false;
  return positions.some(
    (row) =>
      row.list?._ === "chatListMain" &&
      typeof row.order === "string" &&
      row.order !== "0",
  );
}

export function isPrivateTdChat(chat: TdChat): boolean {
  return chat.type?._ === "chatTypePrivate";
}

export function mainListOrderKey(chat: TdChat): string {
  const positions = chat.positions;
  if (!Array.isArray(positions)) return "0";
  const main = positions.find((row) => row.list?._ === "chatListMain");
  return typeof main?.order === "string" ? main.order : "0";
}

export type ChatPresenceKind = "online" | "recently" | "last_week" | "last_month" | "offline";

export type ChatPresence = {
  kind: ChatPresenceKind;
  at: string | null;
};

/** TDLib chat action shown in header / list subtitle (typing, recording, …). */
export type ChatActionKind =
  | "typing"
  | "recording_voice"
  | "recording_video"
  | "uploading_photo"
  | "uploading_video"
  | "uploading_file";

export const CHAT_ACTION_TTL_MS = 6_000;

export function chatActionFromTdlib(action: unknown): ChatActionKind | "cancel" | null {
  if (!action || typeof action !== "object") return null;
  const type = (action as { _?: string })._;
  switch (type) {
    case "chatActionTyping":
      return "typing";
    case "chatActionRecordingVoice":
      return "recording_voice";
    case "chatActionRecordingVideoNote":
    case "chatActionRecordingVideo":
      return "recording_video";
    case "chatActionUploadingPhoto":
      return "uploading_photo";
    case "chatActionUploadingVideo":
      return "uploading_video";
    case "chatActionUploadingDocument":
    case "chatActionUploadingVoiceNote":
      return "uploading_file";
    case "chatActionUploadingVideoNote":
      return "recording_video";
    case "chatActionCancel":
      return "cancel";
    default:
      return null;
  }
}

export function isChatActionActive(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) && ts > Date.now();
}

export function peerUserIdFromChat(chat: TdChat): number | null {
  if (chat.type?._ !== "chatTypePrivate") return null;
  const userId = chat.type.user_id;
  return typeof userId === "number" && Number.isFinite(userId) ? userId : null;
}

export function normalizeTelegramUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function usernameFromTdUser(user: {
  username?: string;
  usernames?: { active_usernames?: string[]; editable_username?: string };
}): string | null {
  const active = user.usernames?.active_usernames;
  if (Array.isArray(active)) {
    for (const entry of active) {
      const normalized = normalizeTelegramUsername(entry);
      if (normalized) return normalized;
    }
  }
  const editable = normalizeTelegramUsername(user.usernames?.editable_username);
  if (editable) return editable;
  return normalizeTelegramUsername(user.username);
}

export function peerUsernameFromChat(chat: TdChat): string | null {
  if (chat.type?._ !== "chatTypePrivate") return null;
  return normalizeTelegramUsername(chat.type?.username);
}

export function chatUsernameFromChat(chat: TdChat): string | null {
  const type = chat.type?._;
  if (type === "chatTypeSupergroup" || type === "chatTypeChannel") {
    return normalizeTelegramUsername(chat.type?.username);
  }
  return null;
}

/** Member count for groups, supergroups, and channels (null for private chats). */
export async function memberCountFromChat(client: Client, chat: TdChat): Promise<number | null> {
  const type = chat.type?._;
  if (type === "chatTypePrivate") return null;

  try {
    if (type === "chatTypeBasicGroup") {
      const basicGroupId = chat.type?.basic_group_id;
      if (typeof basicGroupId !== "number") return null;
      const group = (await client.invoke({
        _: "getBasicGroup",
        basic_group_id: basicGroupId,
      })) as { member_count?: number };
      const count = group.member_count;
      return typeof count === "number" && count > 0 ? count : null;
    }

    if (type === "chatTypeSupergroup" || type === "chatTypeChannel") {
      const supergroupId = chat.type?.supergroup_id;
      if (typeof supergroupId !== "number") return null;
      const group = (await client.invoke({
        _: "getSupergroup",
        supergroup_id: supergroupId,
      })) as { member_count?: number };
      const count = group.member_count;
      return typeof count === "number" && count > 0 ? count : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function presenceFromTdlibStatus(status: unknown): ChatPresence | null {
  if (!status || typeof status !== "object") return null;
  const row = status as { _?: string; was_online?: number };
  switch (row._) {
    case "userStatusOnline":
      return { kind: "online", at: null };
    case "userStatusRecently":
      return { kind: "recently", at: null };
    case "userStatusLastWeek":
      return { kind: "last_week", at: null };
    case "userStatusLastMonth":
      return { kind: "last_month", at: null };
    case "userStatusOffline": {
      const was = row.was_online;
      const at =
        typeof was === "number" && was > 0 ? new Date(was * 1000).toISOString() : null;
      return { kind: "offline", at };
    }
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chatTitle(chat: TdChat): string {
  if (chat.title?.trim()) return chat.title.trim();
  const t = chat.type;
  if (t?._ === "chatTypePrivate") {
    const parts = [t.first_name, t.last_name].filter(Boolean);
    if (parts.length) return parts.join(" ");
    if (t.username) return `@${t.username}`;
  }
  if (t?._ === "chatTypeBasicGroup" || t?._ === "chatTypeSupergroup") {
    if (t.title?.trim()) return t.title.trim();
  }
  return `Chat ${chat.id}`;
}

export function formattedTextPlain(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as { text?: string; _?: string };
  const text = obj.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** Generic chat-list / history fallback when TDLib content is not yet mapped. */
export const GENERIC_MESSAGE_PREVIEW_LABEL = "Message";

export function isGenericMessagePreviewLabel(text: string | null | undefined): boolean {
  return text?.trim() === GENERIC_MESSAGE_PREVIEW_LABEL;
}

function truncatePreview(text: string, maxLen = 240): string {
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function captionPlain(content: Record<string, unknown>): string | null {
  return formattedTextPlain(content.caption);
}

function webPagePlainText(content: Record<string, unknown>): string | null {
  const caption = captionPlain(content);
  if (caption) return caption;
  const webPage = content.web_page as Record<string, unknown> | undefined;
  if (!webPage || typeof webPage !== "object") return null;
  for (const key of ["title", "description", "site_name", "display_url", "url"] as const) {
    const value = webPage[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function animatedEmojiPlainText(content: Record<string, unknown>): string | null {
  const animated = content.animated_emoji as { emoji?: string } | undefined;
  if (typeof animated?.emoji === "string" && animated.emoji.trim()) {
    return animated.emoji.trim();
  }
  const custom = content.emoji as { emoji?: string } | undefined;
  if (typeof custom?.emoji === "string" && custom.emoji.trim()) {
    return custom.emoji.trim();
  }
  return null;
}

function venuePlainText(content: Record<string, unknown>): string | null {
  const venue = content.venue as { title?: string; address?: string } | undefined;
  const title = typeof venue?.title === "string" ? venue.title.trim() : "";
  const address = typeof venue?.address === "string" ? venue.address.trim() : "";
  if (title && address) return `${title} · ${address}`;
  return title || address || null;
}

function extractPrimaryMessageText(content: Record<string, unknown>, type: string): string | null {
  if (type === "messageText") {
    return formattedTextPlain(content.text);
  }
  if (type === "messageForwardedMessage") {
    const nested = content.message as TdMessage | undefined;
    return nested ? messageBodyText(nested) || null : null;
  }
  if (
    type === "messagePhoto" ||
    type === "messageVideo" ||
    type === "messageDocument" ||
    type === "messageAnimation" ||
    type === "messageAudio" ||
    type === "messageVoiceNote" ||
    type === "messagePaidMedia"
  ) {
    return captionPlain(content);
  }
  if (type === "messageWebPage") {
    return webPagePlainText(content);
  }
  if (type === "messageAnimatedEmoji") {
    return animatedEmojiPlainText(content);
  }
  if (type === "messageVenue") {
    return venuePlainText(content);
  }
  return null;
}

/** Full bubble text for chat history (never returns the generic \"Message\" placeholder). */
export function messageBodyText(msg: TdMessage | undefined | null): string {
  const c = msg?.content;
  if (!c || typeof c !== "object") return "";
  const type = c._;
  if (typeof type !== "string") return "";

  const primary = extractPrimaryMessageText(c as Record<string, unknown>, type);
  if (primary) return primary;

  if (
    type === "messagePhoto" ||
    type === "messageVideo" ||
    type === "messageDocument" ||
    type === "messageAnimation" ||
    type === "messageSticker" ||
    type === "messagePaidMedia"
  ) {
    return "";
  }

  const preview = previewFromMessage(msg);
  if (preview && !isGenericMessagePreviewLabel(preview)) return preview;
  return "";
}

export function previewFromMessage(msg: TdMessage | undefined | null): string | null {
  const c = msg?.content;
  if (!c || typeof c !== "object") return null;
  const type = c._;
  if (typeof type !== "string") return null;

  const primary = extractPrimaryMessageText(c as Record<string, unknown>, type);
  if (primary) return truncatePreview(primary);

  if (type === "messagePhoto" || type === "messageVideo" || type === "messageDocument") {
    const caption = captionPlain(c as Record<string, unknown>);
    if (caption) return truncatePreview(caption);
  }

  if (type === "messagePhoto") return "Photo";
  if (type === "messageVideo") return "Video";
  if (type === "messageDocument") return "Document";
  if (type === "messageSticker") return "Sticker";
  if (type === "messageAnimation") return "GIF";
  if (type === "messageVoiceNote") return "Voice message";
  if (type === "messageVideoNote") return "Video message";
  if (type === "messageAudio") return "Audio";
  if (type === "messagePoll") return "Poll";
  if (type === "messageLocation") return "Location";
  if (type === "messageContact") return "Contact";
  if (type === "messageDice") return "Dice";
  if (type === "messageGame") return "Game";
  if (type === "messageInvoice") return "Invoice";
  if (type === "messageCall") return "Call";
  if (type === "messagePinnedMessage") return "Pinned message";
  if (type === "messageStory") return "Story";
  if (type === "messageGiveaway") return "Giveaway";
  if (type === "messageGiveawayWinners") return "Giveaway winners";
  if (type === "messageForumTopicCreated") return "Topic created";
  if (type === "messageForumTopicEdited") return "Topic updated";
  if (type === "messageChatChangePhoto") return "Chat photo updated";
  if (type === "messageChatChangeTitle") {
    const title = typeof c.title === "string" ? c.title.trim() : "";
    return title ? `Chat title: ${title}` : "Chat title updated";
  }
  if (type === "messageChatAddMembers") return "Members added";
  if (type === "messageChatDeleteMember") return "Member left";
  if (type === "messageChatJoinByLink") return "Joined via link";
  if (type === "messageChatUpgradeTo") return "Group upgraded";
  if (type === "messagePaidMedia") return "Paid media";
  if (type.startsWith("message")) return GENERIC_MESSAGE_PREVIEW_LABEL;
  return null;
}

/** Full text for chat body (no preview truncation on plain text messages). */
export function messageDisplayText(msg: TdMessage | undefined | null): string | null {
  const text = messageBodyText(msg);
  return text || null;
}

export function lastMessageAtIso(chat: TdChat, message?: TdMessage | null): string {
  const ts = message?.date ?? chat.last_message?.date;
  if (typeof ts === "number" && ts > 0) {
    return new Date(ts * 1000).toISOString();
  }
  return new Date().toISOString();
}

export function normalizeUnreadCount(chat: TdChat): number {
  const raw = Number(chat.unread_count);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Guard corrupt values (e.g. message/chat ids mistaken for unread).
  if (raw > 50_000 || raw === chat.id || raw === Math.abs(chat.id)) return 0;
  return Math.floor(raw);
}

export function lastReadInboxMessageIdFromChat(chat: TdChat): number | null {
  const row = chat as Record<string, unknown>;
  for (const key of ["last_read_inbox_message_id", "lastReadInboxMessageId"] as const) {
    const id = Number(row[key]);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

export function lastReadOutboxMessageIdFromChat(chat: TdChat): number | null {
  const row = chat as Record<string, unknown>;
  for (const key of ["last_read_outbox_message_id", "lastReadOutboxMessageId"] as const) {
    const id = Number(row[key]);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

export function messageReadDateFromTdMessage(message: TdMessage): number | null {
  const info = message.interaction_info as Record<string, unknown> | undefined;
  if (!info) return null;
  const raw = info.read_date ?? info.readDate;
  const date = Number(raw);
  return Number.isFinite(date) && date > 0 ? date : null;
}

export function messageIsOutgoing(message: TdMessage, myUserId?: number | null): boolean {
  const sender = message.sender_id;
  if (sender?._ === "messageSenderUser" && myUserId != null) {
    return sender.user_id === myUserId;
  }

  const row = message as Record<string, unknown>;
  if (message.is_outgoing === false || row.isOutgoing === false) return false;
  if (message.is_outgoing === true || row.isOutgoing === true) return true;
  const sendingState = message.sending_state?._;
  if (
    sendingState === "messageSendingStatePending" ||
    sendingState === "messageSendingStateFailed"
  ) {
    return true;
  }
  return false;
}

async function fetchLatestMessagePreview(client: Client, chatId: number): Promise<string | null> {
  try {
    try {
      await client.invoke({ _: "openChat", chat_id: chatId });
      await sleep(150);
    } catch {
      /* chat may already be open */
    }

    const history = (await client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: 0,
      offset: 0,
      limit: 1,
      only_local: false,
    })) as { messages?: TdMessage[] };

    const fromHistory = previewFromMessage(history.messages?.[0]);
    if (fromHistory) return fromHistory;

    const refreshed = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    return previewFromMessage(refreshed.last_message);
  } catch {
    return null;
  }
}

export async function resolveLastMessagePreview(client: Client, chat: TdChat): Promise<string | null> {
  const payload = await resolveLastMessagePreviewPayload(client, chat);
  return payload.subtitle;
}

async function fetchMessageById(
  client: Client,
  chatId: number,
  messageId: number,
): Promise<TdMessage | null> {
  try {
    return (await client.invoke({
      _: "getMessage",
      chat_id: chatId,
      message_id: messageId,
    })) as TdMessage;
  } catch {
    return null;
  }
}

/** Subtitle text plus rich segments (custom emoji, links) for chat-list previews. */
export async function resolveLastMessagePreviewPayload(
  client: Client,
  chat: TdChat,
): Promise<{ subtitle: string | null; subtitleSegments: FormattedTextSegment[] | null }> {
  let message = chat.last_message ?? null;
  let subtitle = previewFromMessage(message);
  let subtitleSegments = previewSegmentsFromMessage(message);

  if (!subtitleSegments && typeof message?.id === "number") {
    const full = await fetchMessageById(client, chat.id, message.id);
    if (full) {
      message = full;
      subtitleSegments = previewSegmentsFromMessage(full);
      if (!subtitle) subtitle = previewFromMessage(full);
    }
  }

  if (!subtitle) {
    subtitle = await resolveLastMessagePreviewText(client, chat);
    if (!subtitleSegments) {
      const messageId = message?.id ?? chat.last_message?.id;
      if (typeof messageId === "number") {
        const full = await fetchMessageById(client, chat.id, messageId);
        if (full) {
          subtitleSegments = previewSegmentsFromMessage(full);
        }
      }
    }
  }

  return { subtitle, subtitleSegments };
}

async function resolveLastMessagePreviewText(client: Client, chat: TdChat): Promise<string | null> {
  const direct = previewFromMessage(chat.last_message);
  if (direct) return direct;

  const messageId = chat.last_message?.id;
  if (typeof messageId === "number") {
    try {
      const full = (await client.invoke({
        _: "getMessage",
        chat_id: chat.id,
        message_id: messageId,
      })) as TdMessage;
      const fromMessage = previewFromMessage(full);
      if (fromMessage) return fromMessage;
    } catch {
      /* fall through */
    }
  }

  return fetchLatestMessagePreview(client, chat.id);
}
