import { buildApiUrl } from "../../api/_base";
import type { MessageChatHistoryItem } from "../components/messages/messageChatHistoryTypes";
import { normalizeSuccessfulSendOutgoingStatus } from "../components/messages/messageChatHistoryTypes";

export type SendTelegramChatMessageResult =
  | { ok: true; message: MessageChatHistoryItem }
  | { ok: false; error: string };

function normalizeSentMessage(raw: unknown): MessageChatHistoryItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const telegramMessageId = Number(row.telegram_message_id);
  if (!Number.isFinite(telegramMessageId)) return null;
  const text = typeof row.text === "string" ? row.text : "";
  if (!text.trim()) return null;
  const senderUserId = Number(row.sender_user_id);
  const senderChatId = Number(row.sender_chat_id);
  const outgoingStatus = normalizeSuccessfulSendOutgoingStatus(row.outgoing_status, true);
  return {
    telegram_message_id: telegramMessageId,
    text,
    sent_at: typeof row.sent_at === "string" ? row.sent_at : new Date().toISOString(),
    sender_name: typeof row.sender_name === "string" ? row.sender_name : "",
    sender_user_id: Number.isFinite(senderUserId) ? senderUserId : null,
    sender_chat_id: Number.isFinite(senderChatId) ? senderChatId : null,
    sender_is_channel: Boolean(row.sender_is_channel),
    is_outgoing: true,
    outgoing_status: outgoingStatus,
    content_kind: "text",
    has_media: false,
    media_width: null,
    media_height: null,
    reply_to: null,
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
