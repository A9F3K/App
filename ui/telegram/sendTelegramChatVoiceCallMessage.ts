import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type TelegramVoiceCallMessage = {
  id: string;
  message_id: number;
  group_call_id: number;
  text: string;
  sender_name: string;
  sender_user_id: number | null;
  sender_chat_id: number | null;
  is_self: boolean;
  sent_at: number;
};

export type SendTelegramChatVoiceCallMessageResult =
  | { ok: true; message: TelegramVoiceCallMessage | null }
  | { ok: false; error: string };

function parseMessage(raw: unknown): TelegramVoiceCallMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!id || !text) return null;
  const messageId = Number(item.message_id);
  const groupCallId = Number(item.group_call_id);
  const senderUserId = Number(item.sender_user_id);
  const senderChatId = Number(item.sender_chat_id);
  const sentAt = Number(item.sent_at);
  return {
    id,
    message_id: Number.isFinite(messageId) ? Math.trunc(messageId) : 0,
    group_call_id: Number.isFinite(groupCallId) ? Math.trunc(groupCallId) : 0,
    text,
    sender_name: typeof item.sender_name === "string" ? item.sender_name : "?",
    sender_user_id:
      Number.isFinite(senderUserId) && senderUserId > 0 ? Math.trunc(senderUserId) : null,
    sender_chat_id:
      Number.isFinite(senderChatId) && senderChatId !== 0 ? Math.trunc(senderChatId) : null,
    is_self: Boolean(item.is_self),
    sent_at: Number.isFinite(sentAt) && sentAt > 0 ? Math.trunc(sentAt) : Date.now(),
  };
}

/** Send an in-call message (TDLib sendGroupCallMessage). */
export async function sendTelegramChatVoiceCallMessage(input: {
  chatId: number;
  groupCallId?: number | null;
  text: string;
}): Promise<SendTelegramChatVoiceCallMessageResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const trimmed = input.text.trim();
  if (!trimmed) return { ok: false, error: "text_required" };
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/telegram-messages-voice-call-message-send"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: input.chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
        text: trimmed,
      }),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: aborted ? "voice_call_message_timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: unknown;
  };
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "voice_call_message_failed",
    };
  }
  return { ok: true, message: parseMessage(json.message) };
}

export { parseMessage as parseTelegramVoiceCallMessage };
