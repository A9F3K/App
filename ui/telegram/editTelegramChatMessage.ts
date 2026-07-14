import { buildApiUrl } from "../../api/_base";
import type { MessageChatHistoryItem } from "../components/messages/messageChatHistoryTypes";
import { coalesceOutgoingStatus } from "../components/messages/messageChatHistoryTypes";
import { normalizeHistoryMessage } from "./fetchTelegramChatHistoryPage";

export type EditTelegramChatMessageResult =
  | { ok: true; message: MessageChatHistoryItem }
  | { ok: false; error: string };

function normalizeEditedMessage(raw: unknown): MessageChatHistoryItem | null {
  const normalized = normalizeHistoryMessage(raw, null, null);
  if (!normalized || !normalized.text.trim()) return null;
  return {
    ...normalized,
    is_outgoing: true,
    outgoing_status: coalesceOutgoingStatus(normalized.outgoing_status, true),
  };
}

export async function editTelegramChatMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<EditTelegramChatMessageResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "text_required" };
  }

  const response = await fetch(buildApiUrl("/api/telegram-messages-edit"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: trimmed,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: unknown;
    error?: string;
  };

  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "edit_failed" };
  }

  const message = normalizeEditedMessage(json.message);
  if (!message) {
    return { ok: false, error: "invalid_response" };
  }

  return { ok: true, message };
}
