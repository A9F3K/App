import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type TelegramChatVoiceParticipant = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
  is_speaking: boolean;
  is_muted: boolean;
  is_self: boolean;
};

export type FetchTelegramChatVoiceParticipantsResult =
  | {
      ok: true;
      participants: TelegramChatVoiceParticipant[];
      participant_count: number;
      has_active_voice_chat: boolean;
      voice_chat_group_call_id: number | null;
      voice_resolve_source: string;
    }
  | { ok: false; error: string };

/** Bound each poll so a slow gateway can never freeze participant updates. */
const REQUEST_TIMEOUT_MS = 4500;

export async function fetchTelegramChatVoiceParticipants(
  chatId: number,
  groupCallId?: number | null,
  options?: { forceReload?: boolean },
): Promise<FetchTelegramChatVoiceParticipantsResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const params = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
  const callId = normalizeTelegramGroupCallId(groupCallId);
  if (callId != null) {
    params.set("group_call_id", String(callId));
  }
  if (options?.forceReload) {
    params.set("force", "1");
  }
  // Hard timeout so a slow/hung server response never stalls the caller's poll
  // loop (the next tick is only scheduled once this resolves).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      buildApiUrl(`/api/telegram-messages-voice-participants?${params.toString()}`),
      { method: "GET", credentials: "include", signal: controller.signal },
    );
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    participants?: unknown;
    participant_count?: number;
    has_active_voice_chat?: boolean;
    voice_chat_group_call_id?: unknown;
    voice_resolve_source?: string;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "participants_failed" };
  }
  const participants = Array.isArray(json.participants)
    ? json.participants
        .map((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return null;
          const item = row as Record<string, unknown>;
          const userId = Number(item.user_id);
          const chatIdRaw = Number(item.chat_id);
          return {
            user_id: Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null,
            chat_id:
              Number.isFinite(chatIdRaw) && chatIdRaw !== 0 ? Math.trunc(chatIdRaw) : null,
            title: typeof item.title === "string" ? item.title : "",
            description: typeof item.description === "string" ? item.description : "",
            emoji_status_custom_emoji_id:
              typeof item.emoji_status_custom_emoji_id === "string" &&
              item.emoji_status_custom_emoji_id.trim()
                ? item.emoji_status_custom_emoji_id.trim()
                : null,
            is_speaking: Boolean(item.is_speaking),
            is_muted: Boolean(item.is_muted),
            is_self: Boolean(item.is_self),
          } satisfies TelegramChatVoiceParticipant;
        })
        .filter((row): row is TelegramChatVoiceParticipant => row != null)
    : [];
  const voiceCallId = normalizeTelegramGroupCallId(json.voice_chat_group_call_id);
  return {
    ok: true,
    participants,
    participant_count: Number.isFinite(Number(json.participant_count))
      ? Number(json.participant_count)
      : participants.length,
    has_active_voice_chat: Boolean(json.has_active_voice_chat) || voiceCallId != null,
    voice_chat_group_call_id: voiceCallId,
    voice_resolve_source:
      typeof json.voice_resolve_source === "string" ? json.voice_resolve_source : "none",
  };
}
