import type { MessageChatHistoryItem } from "./components/messages/messageChatHistoryTypes";
import { normalizeSuccessfulSendOutgoingStatus } from "./components/messages/messageChatHistoryTypes";
import {
  mergeCachedChatHistoryMessages,
  removeCachedChatHistoryMessages,
} from "./messageChatHistoryCache";

export type OutgoingChatMessageEvent = {
  chatId: number;
  message: MessageChatHistoryItem;
};

export type OutgoingChatMessageRemoveEvent = {
  chatId: number;
  messageId: number;
};

const listeners = new Set<(event: OutgoingChatMessageEvent) => void>();
const removeListeners = new Set<(event: OutgoingChatMessageRemoveEvent) => void>();

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

export function removeOutgoingChatMessage(chatId: number, messageId: number): void {
  removeCachedChatHistoryMessages(chatId, [messageId]);
  const event = { chatId, messageId };
  for (const listener of removeListeners) {
    listener(event);
  }
}

export function subscribeOutgoingChatMessageRemovals(
  listener: (event: OutgoingChatMessageRemoveEvent) => void,
): () => void {
  removeListeners.add(listener);
  return () => {
    removeListeners.delete(listener);
  };
}
