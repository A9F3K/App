import { buildApiUrl } from "../../api/_base";
import type { MessageChatHistoryItem } from "../components/messages/messageChatHistoryTypes";
import { normalizeSuccessfulSendOutgoingStatus } from "../components/messages/messageChatHistoryTypes";
import { normalizeHistoryMessage } from "./fetchTelegramChatHistoryPage";

export type SendTelegramChatPhotoResult =
  | { ok: true; message: MessageChatHistoryItem }
  | { ok: false; error: string };

function normalizeSentMessage(raw: unknown): MessageChatHistoryItem | null {
  const normalized = normalizeHistoryMessage(raw, null, null);
  if (!normalized) return null;
  return {
    ...normalized,
    is_outgoing: true,
    content_kind: normalized.content_kind ?? "photo",
    has_media: true,
    outgoing_status: normalizeSuccessfulSendOutgoingStatus(
      normalized.outgoing_status,
      true,
    ),
  };
}

export async function sendTelegramChatPhoto(params: {
  chatId: number;
  photoBase64: string;
  caption?: string;
  mime?: string;
  replyToMessageId?: number | null;
}): Promise<SendTelegramChatPhotoResult> {
  const chatId = Number(params.chatId);
  const photoBase64 = params.photoBase64.trim();
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  if (!photoBase64) {
    return { ok: false, error: "photo_required" };
  }

  const replyId = Number(params.replyToMessageId);
  const response = await fetch(buildApiUrl("/api/telegram-messages-send-photo"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo_base64: photoBase64,
      caption: params.caption ?? "",
      mime: params.mime ?? "image/jpeg",
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
