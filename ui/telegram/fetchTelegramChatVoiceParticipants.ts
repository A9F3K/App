import { buildApiUrl } from "../../api/_base";

export type TelegramChatVoiceParticipant = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  is_speaking: boolean;
};

export type FetchTelegramChatVoiceParticipantsResult =
  | { ok: true; participants: TelegramChatVoiceParticipant[]; participant_count: number }
  | { ok: false; error: string };

export async function fetchTelegramChatVoiceParticipants(
  chatId: number,
  groupCallId?: number | null,
): Promise<FetchTelegramChatVoiceParticipantsResult> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const params = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
  const callId = Number(groupCallId);
  if (Number.isFinite(callId) && callId > 0) {
    params.set("group_call_id", String(Math.trunc(callId)));
  }
  const response = await fetch(
    buildApiUrl(`/api/telegram-messages-voice-participants?${params.toString()}`),
    { method: "GET", credentials: "include" },
  );
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    participants?: unknown;
    participant_count?: number;
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
            is_speaking: Boolean(item.is_speaking),
          } satisfies TelegramChatVoiceParticipant;
        })
        .filter((row): row is TelegramChatVoiceParticipant => row != null)
    : [];
  return {
    ok: true,
    participants,
    participant_count: Number.isFinite(Number(json.participant_count))
      ? Number(json.participant_count)
      : participants.length,
  };
}
