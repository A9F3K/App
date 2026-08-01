import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type SetTelegramChatVoiceParticipantVolumeResult =
  | { ok: true; volume_percent: number }
  | { ok: false; error: string; volume_percent?: number };

export async function setTelegramChatVoiceParticipantVolume(input: {
  chatId: number;
  groupCallId?: number | null;
  userId?: number | null;
  peerChatId?: number | null;
  volumePercent: number;
}): Promise<SetTelegramChatVoiceParticipantVolumeResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const volumePercent = Math.min(200, Math.max(0, Math.round(Number(input.volumePercent) || 0)));
  const response = await fetch(
    buildApiUrl("/api/telegram-messages-voice-participant-volume"),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
        user_id: input.userId ?? null,
        peer_chat_id: input.peerChatId ?? null,
        volume_percent: volumePercent,
      }),
    },
  );
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    volume_percent?: number;
  };
  const nextPercent =
    typeof json.volume_percent === "number" && Number.isFinite(json.volume_percent)
      ? Math.min(200, Math.max(0, Math.round(json.volume_percent)))
      : volumePercent;
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "volume_failed", volume_percent: nextPercent };
  }
  return { ok: true, volume_percent: nextPercent };
}
