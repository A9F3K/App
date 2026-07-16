import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type StartTelegramChatVoiceResult =
  | {
      ok: true;
      has_active_voice_chat: boolean;
      voice_chat_group_call_id: number | null;
    }
  | { ok: false; error: string };

export async function startTelegramChatVoice(
  chatId: number,
): Promise<StartTelegramChatVoiceResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const response = await fetch(buildApiUrl("/api/telegram-messages-voice-start"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    has_active_voice_chat?: boolean;
    voice_chat_group_call_id?: number | null;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "start_failed" };
  }
  return {
    ok: true,
    has_active_voice_chat: Boolean(json.has_active_voice_chat),
    voice_chat_group_call_id: normalizeTelegramGroupCallId(json.voice_chat_group_call_id),
  };
}
