import { resolveTelegramDisplayName } from "../../../shared/telegramDisplayName";
import { specialUserDisplayName } from "./specialTelegramUserDisplay";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";

export type ComposeReplySenderContext = {
  chatTitle: string;
  chatKind: MessageChatKind | null;
  telegramChatId: number;
  peerUserId?: number | null;
  selfUserId?: number | null;
};

/** Visible sender label for group message bubbles (handles invisible-name tricks). */
export function resolveMessageSenderDisplayName(
  senderName: string,
  senderUserId: number | null | undefined,
  telegramChatId?: number | null,
): string {
  const special = specialUserDisplayName(senderUserId, senderName, telegramChatId);
  return resolveTelegramDisplayName({
    name: special,
    userId: senderUserId,
  });
}

/** Label for the compose strip when replying to a message. */
export function resolveComposeReplySenderName(
  item: Pick<
    MessageChatHistoryItem,
    "sender_name" | "sender_user_id" | "is_outgoing" | "sender_author_signature"
  >,
  ctx: ComposeReplySenderContext,
): string {
  if (ctx.chatKind === "channel" && item.sender_author_signature?.trim()) {
    return item.sender_author_signature.trim();
  }

  // In 1:1 chats Telegram shows the contact name (chat title), not always the row sender_name.
  const labelSource =
    ctx.chatKind === "private" && !item.is_outgoing
      ? ctx.chatTitle.trim() || item.sender_name
      : item.sender_name;

  return resolveMessageSenderDisplayName(
    labelSource,
    item.sender_user_id,
    ctx.telegramChatId,
  );
}
