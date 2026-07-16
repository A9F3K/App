import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";

/** Short label for reply preview when the message has no text body. */
export function messageChatActionPreviewText(item: MessageChatHistoryItem): string {
  const text = item.text.trim();
  if (text) return text;
  const kind = item.content_kind;
  if (kind === "photo") return "Photo";
  if (kind === "video") return "Video";
  if (kind === "animation") return "GIF";
  if (kind === "sticker") return "Sticker";
  if (kind === "document") return "File";
  if (kind === "call") return "Call";
  if (item.has_media) return "Media";
  return "Message";
}

export function canReplyToMessage(_item: MessageChatHistoryItem): boolean {
  return true;
}

function isOwnMessage(
  item: MessageChatHistoryItem,
  selfUserId?: number | null,
  peerUserId?: number | null,
): boolean {
  if (peerUserId != null && item.sender_user_id === peerUserId) return false;
  if (selfUserId != null && item.sender_user_id === selfUserId) return true;
  if (item.is_outgoing) return true;
  return false;
}

/** Own messages with editable text (including media captions). */
export function canEditMessage(
  item: MessageChatHistoryItem,
  selfUserId?: number | null,
  peerUserId?: number | null,
): boolean {
  if (!isOwnMessage(item, selfUserId, peerUserId)) return false;
  if (item.content_kind === "call") return false;
  if (item.content_kind === "sticker" || item.content_kind === "animation") return false;
  return item.text.trim().length > 0;
}

/** Own messages that can be deleted from the context menu. */
export function canDeleteMessage(
  item: MessageChatHistoryItem,
  selfUserId?: number | null,
  peerUserId?: number | null,
): boolean {
  if (!isOwnMessage(item, selfUserId, peerUserId)) return false;
  if (item.content_kind === "call") return false;
  return Number(item.telegram_message_id) > 0;
}
