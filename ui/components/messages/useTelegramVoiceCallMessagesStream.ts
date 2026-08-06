import type { TelegramVoiceCallMessage } from "../../telegram/sendTelegramChatVoiceCallMessage";

/** Native stub — voice call message SSE is web-only. */
export function useTelegramVoiceCallMessagesStream(_options: {
  enabled: boolean;
  chatId: number;
  groupCallId: number | null;
  getSinceRevision: () => number | null;
  onReadyMessages: (messages: TelegramVoiceCallMessage[], revision: number) => void;
  onMessage: (message: TelegramVoiceCallMessage, revision: number) => void;
}): void {
  // no-op on native
}
