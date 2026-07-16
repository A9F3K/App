import type { MessageChatRowData } from "./MessageChatRow";

/** Live poll / EventSource change detection for an open chat row. */
export function chatLiveSignature(chat: MessageChatRowData): string {
  const deleted =
    Array.isArray(chat.pending_deleted_message_ids) && chat.pending_deleted_message_ids.length > 0
      ? chat.pending_deleted_message_ids.join(",")
      : "";
  return [
    chat.last_message_at ?? "",
    chat.subtitle,
    chat.unread_count,
    chat.last_read_outbox_message_id ?? "",
    chat.chat_action ?? "",
    chat.chat_action_expires_at ?? "",
    chat.presence_kind ?? "",
    deleted,
  ].join("|");
}

/** Tail-only signature — ignores unread/presence noise for live history poll. */
export function chatMessageTailSignature(chat: MessageChatRowData): string {
  return `${chat.last_message_at ?? ""}|${chat.subtitle}`;
}
