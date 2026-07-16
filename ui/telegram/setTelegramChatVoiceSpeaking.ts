import { buildApiUrl } from "../../api/_base";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp";

export type SetTelegramChatVoiceSpeakingResult = { ok: true } | { ok: false; error: string };

export async function setTelegramChatVoiceSpeaking(input: {
  chatId: number;
  groupCallId?: number | null;
  audioSourceId: number;
  isSpeaking: boolean;
}): Promise<SetTelegramChatVoiceSpeakingResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const source = telegramInt32AudioSourceId(Number(input.audioSourceId));
  if (!Number.isFinite(source) || source === 0) {
    return { ok: false, error: "invalid_audio_source" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const response = await fetch(buildApiUrl("/api/telegram-messages-voice-speaking"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      ...(callId != null ? { group_call_id: callId } : {}),
      audio_source_id: source,
      is_speaking: input.isSpeaking,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "speaking_failed" };
  }
  return { ok: true };
}
