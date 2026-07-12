import type { MessageChatHistoryItem } from "./components/messages/messageChatHistoryTypes";
import { normalizeSuccessfulSendOutgoingStatus } from "./components/messages/messageChatHistoryTypes";
import { mergeCachedChatHistoryMessages } from "./messageChatHistoryCache";

export type OutgoingChatMessageEvent = {
  chatId: number;
  message: MessageChatHistoryItem;
};

const listeners = new Set<(event: OutgoingChatMessageEvent) => void>();

export function publishOutgoingChatMessage(chatId: number, message: MessageChatHistoryItem): void {
  const normalized: MessageChatHistoryItem = {
    ...message,
    outgoing_status: normalizeSuccessfulSendOutgoingStatus(
      message.outgoing_status,
      message.is_outgoing,
    ),
  };
  mergeCachedChatHistoryMessages(chatId, [normalized]);
  const event = { chatId, message: normalized };
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeOutgoingChatMessages(
  listener: (event: OutgoingChatMessageEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
