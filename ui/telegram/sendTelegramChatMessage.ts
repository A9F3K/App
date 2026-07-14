import { buildApiUrl } from "../../api/_base";
import type { MessageChatHistoryItem } from "../components/messages/messageChatHistoryTypes";
import { normalizeSuccessfulSendOutgoingStatus } from "../components/messages/messageChatHistoryTypes";
import { normalizeHistoryMessage } from "./fetchTelegramChatHistoryPage";

export type SendTelegramChatMessageResult =
  | { ok: true; message: MessageChatHistoryItem }
  | { ok: false; error: string };

function normalizeSentMessage(raw: unknown): MessageChatHistoryItem | null {
  const normalized = normalizeHistoryMessage(raw, null, null);
  if (!normalized || !normalized.text.trim()) return null;
  return {
    ...normalized,
    is_outgoing: true,
    outgoing_status: normalizeSuccessfulSendOutgoingStatus(
      normalized.outgoing_status,
      true,
    ),
  };
}

export async function sendTelegramChatMessage(
  chatId: number,
  text: string,
  replyToMessageId?: number | null,
): Promise<SendTelegramChatMessageResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "text_required" };
  }

  const replyId = Number(replyToMessageId);
  const response = await fetch(buildApiUrl("/api/telegram-messages-send"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: trimmed,
      ...(Number.isFinite(replyId) && replyId > 0
        ? { reply_to_message_id: Math.trunc(replyId) }
        : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: unknown;
    error?: string;
  };

  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "send_failed" };
  }

  const message = normalizeSentMessage(json.message);
  if (!message) {
    return { ok: false, error: "invalid_response" };
  }

  return { ok: true, message };
}
