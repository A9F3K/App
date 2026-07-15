import type { MessageChatComposeReplyTarget } from "../../messageChatCompose";
import type { MessageChatHistoryItem } from "./messageChatHistoryTypes";

let nextOptimisticMessageId = -1;

export function allocateOptimisticOutgoingMessageId(): number {
  nextOptimisticMessageId -= 1;
  return nextOptimisticMessageId;
}

export function isOptimisticOutgoingMessageId(messageId: number): boolean {
  return Number.isFinite(messageId) && messageId < 0;
}

export function buildOptimisticOutgoingMessage(params: {
  text: string;
  replyTarget?: MessageChatComposeReplyTarget | null;
  selfUserId?: number | null;
  photo?: {
    localUri: string;
    width?: number | null;
    height?: number | null;
  } | null;
}): MessageChatHistoryItem {
  const trimmed = params.text.trim();
  const replyTarget = params.replyTarget ?? null;
  const photo = params.photo ?? null;
  return {
    telegram_message_id: allocateOptimisticOutgoingMessageId(),
    text: trimmed,
    sent_at: new Date().toISOString(),
    sender_name: "",
    sender_user_id: params.selfUserId ?? null,
    is_outgoing: true,
    outgoing_status: "pending",
    content_kind: photo ? "photo" : "text",
    has_media: Boolean(photo),
    media_width: photo?.width ?? null,
    media_height: photo?.height ?? null,
    local_media_uri: photo?.localUri ?? null,
    reply_to: replyTarget
      ? {
          sender_name: replyTarget.sender_name,
          sender_user_id: null,
          text: replyTarget.text,
        }
      : null,
    reply_to_message_id: replyTarget?.telegram_message_id ?? null,
  };
}

/** Drop local pending rows replaced by the confirmed server message. */
export function stripMatchingPendingOutgoingMessages(
  messages: readonly MessageChatHistoryItem[],
  confirmed: MessageChatHistoryItem,
): MessageChatHistoryItem[] {
  if (!confirmed.is_outgoing) return [...messages];
  const confirmedText = confirmed.text.trim();
  const confirmedIsPhoto =
    confirmed.content_kind === "photo" || Boolean(confirmed.has_media);
  let removedPhotoPending = false;
  return messages.filter((row) => {
    if (!isOptimisticOutgoingMessageId(row.telegram_message_id)) return true;
    if (row.outgoing_status !== "pending") return true;
    const rowIsPhoto = row.content_kind === "photo" || Boolean(row.has_media);
    if (confirmedIsPhoto && rowIsPhoto) {
      if (row.text.trim() !== confirmedText) return true;
      if (removedPhotoPending) return true;
      removedPhotoPending = true;
      return false;
    }
    if (confirmedIsPhoto || rowIsPhoto) return true;
    return row.text.trim() !== confirmedText;
  });
}

export function withoutOptimisticOutgoingMessage(
  messages: readonly MessageChatHistoryItem[],
  messageId: number,
): MessageChatHistoryItem[] {
  return messages.filter((row) => row.telegram_message_id !== messageId);
}
