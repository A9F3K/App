import { buildApiUrl } from "../../api/_base";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp";

export type JoinTelegramChatVoiceResult =
  | { ok: true; join_payload: string }
  | { ok: false; error: string };

export async function joinTelegramChatVoice(input: {
  chatId: number;
  groupCallId?: number | null;
  audioSourceId: number;
  payload: string;
  isMuted: boolean;
}): Promise<JoinTelegramChatVoiceResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const audioSourceId = telegramInt32AudioSourceId(Number(input.audioSourceId));
  if (!Number.isFinite(audioSourceId) || audioSourceId === 0) {
    return { ok: false, error: "invalid_audio_source" };
  }
  const response = await fetch(buildApiUrl("/api/telegram-messages-voice-join"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      ...(callId != null ? { group_call_id: callId } : {}),
      audio_source_id: audioSourceId,
      payload: input.payload,
      is_muted: input.isMuted,
      is_my_video_enabled: false,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    join_payload?: string;
  };
  if (!response.ok || !json.ok || typeof json.join_payload !== "string") {
    return { ok: false, error: json.error ?? "join_failed" };
  }
  return { ok: true, join_payload: json.join_payload };
}
