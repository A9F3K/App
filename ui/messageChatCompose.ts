import { useSyncExternalStore } from "react";
import type { MessageChatHistoryItem } from "./components/messages/messageChatHistoryTypes";
import type { ComposeReplySenderContext } from "./components/messages/resolveMessageSenderDisplayName";
import { resolveComposeReplySenderName } from "./components/messages/resolveMessageSenderDisplayName";
import { messageChatActionPreviewText } from "./components/messages/messageChatActionUtils";

export type MessageChatComposeReplyTarget = {
  telegram_message_id: number;
  sender_name: string;
  text: string;
};

export type MessageChatComposeEditTarget = {
  telegram_message_id: number;
  text: string;
};

export type MessageChatComposeState = {
  chatId: number;
  reply: MessageChatComposeReplyTarget | null;
  edit: MessageChatComposeEditTarget | null;
};

let composeState: MessageChatComposeState | null = null;
const listeners = new Set<() => void>();

function emitComposeChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getMessageChatCompose(chatId: number | null | undefined): MessageChatComposeState | null {
  if (chatId == null || composeState?.chatId !== chatId) return null;
  return composeState;
}

export function subscribeMessageChatCompose(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMessageChatCompose(chatId: number | null | undefined): MessageChatComposeState | null {
  return useSyncExternalStore(
    subscribeMessageChatCompose,
    () => getMessageChatCompose(chatId),
    () => getMessageChatCompose(chatId),
  );
}

export function setMessageChatComposeReply(
  chatId: number,
  item: MessageChatHistoryItem,
  ctx: ComposeReplySenderContext,
): void {
  composeState = {
    chatId,
    reply: {
      telegram_message_id: item.telegram_message_id,
      sender_name: resolveComposeReplySenderName(item, ctx),
      text: messageChatActionPreviewText(item),
    },
    edit: null,
  };
  emitComposeChange();
}

export function setMessageChatComposeEdit(chatId: number, item: MessageChatHistoryItem): void {
  composeState = {
    chatId,
    reply: null,
    edit: {
      telegram_message_id: item.telegram_message_id,
      text: item.text,
    },
  };
  emitComposeChange();
}

export function clearMessageChatCompose(chatId?: number): void {
  if (chatId != null && composeState?.chatId !== chatId) return;
  composeState = null;
  emitComposeChange();
}
