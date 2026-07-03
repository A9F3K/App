import { getCachedChatHistory } from "../../messageChatHistoryCache";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  coalesceOutgoingStatus,
  resolveOutgoingStatusForDisplay,
  type MessageOutgoingStatus,
} from "./messageChatHistoryTypes";

/** Outgoing ticks for chat list rows (API fields + private-chat inference + history tail fallback). */
export function resolveChatListOutgoingPreview(item: MessageChatRowData): {
  isOutgoing: boolean;
  status: MessageOutgoingStatus | null;
} {
  let isOutgoing = Boolean(item.last_message_is_outgoing);
  let rawStatus = item.last_message_outgoing_status ?? null;

  if (
    !isOutgoing &&
    item.last_message_sender_user_id != null &&
    item.peer_user_id != null &&
    item.last_message_sender_user_id !== item.peer_user_id
  ) {
    isOutgoing = true;
    if (!rawStatus) {
      const msgId = item.last_message_telegram_id;
      const readOutbox = item.last_read_outbox_message_id;
      if (msgId != null && readOutbox != null && msgId <= readOutbox) {
        rawStatus = "read";
      } else if (!rawStatus) {
        rawStatus = "pending";
      }
    }
  }

  if (!isOutgoing) {
    const cached = getCachedChatHistory(item.telegram_chat_id);
    const messages = cached?.messages;
    const tail = messages?.length ? messages[messages.length - 1]! : null;
    if (tail?.is_outgoing) {
      isOutgoing = true;
      rawStatus = tail.outgoing_status ?? "pending";
    }
  }

  if (!isOutgoing) {
    return { isOutgoing: false, status: null };
  }

  const status = resolveOutgoingStatusForDisplay(
    {
      is_outgoing: true,
      outgoing_status: coalesceOutgoingStatus(rawStatus, true),
    },
    item.chat_kind,
    item,
  );
  return { isOutgoing: true, status };
}
