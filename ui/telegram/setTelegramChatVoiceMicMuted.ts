import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type SetTelegramChatVoiceMicMutedResult = { ok: true } | { ok: false; error: string };

export async function setTelegramChatVoiceMicMuted(input: {
  chatId: number;
  groupCallId?: number | null;
  isMuted: boolean;
}): Promise<SetTelegramChatVoiceMicMutedResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const response = await fetch(buildApiUrl("/api/telegram-messages-voice-mute"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      ...(callId != null ? { group_call_id: callId } : {}),
      is_muted: input.isMuted,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "mute_failed" };
  }
  return { ok: true };
}
