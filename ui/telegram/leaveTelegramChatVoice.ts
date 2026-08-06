import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

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
  opts?: { keepalive?: boolean },
): Promise<LeaveTelegramChatVoiceResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(groupCallId);
  // keepalive: survive tab/app close — normal fetch is aborted on unload and
  // the account stayed in the Telegram group call.
  const keepalive = opts?.keepalive !== false;
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-voice-leave"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
      }),
      keepalive,
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      has_active_voice_chat?: boolean;
      voice_chat_group_call_id?: number | null;
      participant_count?: number;
      is_joined?: boolean;
      participants?: unknown[];
    };
    if (!response.ok || !json.ok) {
      return { ok: false, error: json.error ?? "leave_failed" };
    }
    const count = typeof json.participant_count === "number" ? Math.max(0, Math.floor(json.participant_count)) : 0;
    const participantsLen = Array.isArray(json.participants) ? json.participants.length : 0;
    const joined = Boolean(json.is_joined);
    // After leave, treat empty leftover calls as inactive so the client can show Start again.
    const hasActive =
      Boolean(json.has_active_voice_chat) && (count > 0 || participantsLen > 0 || joined);
    return {
      ok: true,
      has_active_voice_chat: hasActive,
      voice_chat_group_call_id: normalizeTelegramGroupCallId(json.voice_chat_group_call_id),
    };
  } catch {
    return { ok: false, error: "leave_failed" };
  }
}
