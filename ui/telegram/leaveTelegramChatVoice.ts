import { buildApiUrl } from "../../api/_base";

export type LeaveTelegramChatVoiceResult =
  | {
      ok: true;
      has_active_voice_chat: boolean;
      voice_chat_group_call_id: number | null;
    }
  | { ok: false; error: string };

export async function leaveTelegramChatVoice(
  chatId: number,
  groupCallId?: number | null,
): Promise<LeaveTelegramChatVoiceResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = Number(groupCallId);
  const response = await fetch(buildApiUrl("/api/telegram-messages-voice-leave"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      ...(Number.isFinite(callId) && callId > 0
        ? { group_call_id: Math.trunc(callId) }
        : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    has_active_voice_chat?: boolean;
    voice_chat_group_call_id?: number | null;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "leave_failed" };
  }
  const nextCallId = Number(json.voice_chat_group_call_id);
  return {
    ok: true,
    has_active_voice_chat: Boolean(json.has_active_voice_chat),
    voice_chat_group_call_id:
      Number.isFinite(nextCallId) && nextCallId > 0 ? Math.trunc(nextCallId) : null,
  };
}
