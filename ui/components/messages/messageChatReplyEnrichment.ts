import type { MessageChatHistoryItem, MessageChatReplyPreview } from "./messageChatHistoryTypes";
import { messageChatActionPreviewText } from "./messageChatActionUtils";

function replyPreviewFromParent(parent: MessageChatHistoryItem): MessageChatReplyPreview {
  return {
    sender_name: parent.sender_name || "…",
    sender_user_id: parent.sender_user_id ?? null,
    text: messageChatActionPreviewText(parent).slice(0, 200),
    text_segments: parent.text_segments ?? null,
    sender_emoji_status_custom_emoji_id: parent.sender_emoji_status_custom_emoji_id ?? null,
    sender_accent_color_light: parent.sender_accent_color_light ?? null,
    sender_accent_color_dark: parent.sender_accent_color_dark ?? null,
  };
}

/**
 * Fill missing in-bubble reply quotes from other rows already in the loaded window.
 * Used when TDLib gave `reply_to_message_id` but not a resolved `reply_to` preview.
 */
export function enrichReplyPreviewsFromLoadedHistory(
  messages: MessageChatHistoryItem[],
): MessageChatHistoryItem[] {
  if (messages.length === 0) return messages;
  const byId = new Map<number, MessageChatHistoryItem>();
  for (const row of messages) {
    byId.set(row.telegram_message_id, row);
  }

  let changed = false;
  const next = messages.map((item) => {
    if (item.reply_to?.text?.trim()) return item;
    const replyId = Number(item.reply_to_message_id);
    if (!Number.isFinite(replyId) || replyId <= 0) return item;
    const parent = byId.get(replyId);
    if (!parent) return item;
    changed = true;
    return {
      ...item,
      reply_to: replyPreviewFromParent(parent),
      reply_to_message_id: replyId,
    };
  });
  return changed ? next : messages;
}
