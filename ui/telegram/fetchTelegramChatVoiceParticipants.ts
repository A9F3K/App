import { buildApiUrl } from "../../api/_base";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp";

export type TelegramChatVoiceVideoInfo = {
  endpoint_id: string;
  source_groups: Array<{ semantics: string; source_ids: number[] }>;
};

export type TelegramChatVoiceParticipant = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
  is_speaking: boolean;
  is_muted: boolean;
  /**
   * TDLib can_unmute_self. Muted + true ⇒ they turned their mic off (secondary).
   * Muted + false ⇒ admin-muted (red). Default true when omitted.
   */
  can_unmute_self?: boolean;
  is_self: boolean;
  /** Local listen volume 0–200% (100 = API level). */
  volume_percent?: number;
  /**
   * TDLib participant order. Empty/missing ⇒ recent_speakers stub (mute unknown).
   * Real mute updates always carry a non-empty order.
   */
  order?: string;
  video_info?: TelegramChatVoiceVideoInfo | null;
  screen_sharing_video_info?: TelegramChatVoiceVideoInfo | null;
};

export type FetchTelegramChatVoiceParticipantsResult =
  | {
      ok: true;
      participants: TelegramChatVoiceParticipant[];
      participant_count: number;
      has_active_voice_chat: boolean;
      voice_chat_group_call_id: number | null;
      voice_resolve_source: string;
      loaded_all_participants: boolean;
      has_hidden_listeners: boolean;
    }
  | { ok: false; error: string };

/** Bound each poll so a slow gateway can never freeze participant updates. */
const REQUEST_TIMEOUT_MS = 4500;
/** Force reload awaits TDLib loadGroupCallParticipants — needs a longer budget. */
const FORCE_RELOAD_TIMEOUT_MS = 12_000;

function parseVideoInfo(raw: unknown): TelegramChatVoiceVideoInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const endpoint =
    typeof item.endpoint_id === "string" ? item.endpoint_id.trim() : "";
  const groups = Array.isArray(item.source_groups) ? item.source_groups : [];
  const sourceGroups = groups
    .map((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return null;
      const g = group as Record<string, unknown>;
      const semantics =
        typeof g.semantics === "string" && g.semantics.trim() ? g.semantics.trim() : "";
      const sourceIds = Array.isArray(g.source_ids)
        ? g.source_ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id !== 0)
            .map((id) => Math.trunc(id))
        : [];
      if (!semantics || sourceIds.length === 0) return null;
      return { semantics, source_ids: sourceIds };
    })
    .filter((group): group is { semantics: string; source_ids: number[] } => group != null);
  if (!endpoint && sourceGroups.length === 0) return null;
  return { endpoint_id: endpoint, source_groups: sourceGroups };
}

export async function fetchTelegramChatVoiceParticipants(
  chatId: number,
  groupCallId?: number | null,
  options?: { forceReload?: boolean; signal?: AbortSignal },
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
  const timeoutMs = options?.forceReload ? FORCE_RELOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options?.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: "aborted" };
    }
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let response: Response;
  try {
    response = await fetch(
      buildApiUrl(`/api/telegram-messages-voice-participants?${params.toString()}`),
      { method: "GET", credentials: "include", signal: controller.signal },
    );
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const external = Boolean(options?.signal?.aborted);
    return {
      ok: false,
      error: aborted ? (external ? "aborted" : "timeout") : "network_error",
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onExternalAbort);
  }
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    participants?: unknown;
    participant_count?: number;
    has_active_voice_chat?: boolean;
    voice_chat_group_call_id?: unknown;
    voice_resolve_source?: string;
    loaded_all_participants?: boolean;
    has_hidden_listeners?: boolean;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "participants_failed" };
  }
  const participants = Array.isArray(json.participants)
    ? json.participants
        .map((row): TelegramChatVoiceParticipant | null => {
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
            can_unmute_self:
              item.can_unmute_self == null ? true : Boolean(item.can_unmute_self),
            is_self: Boolean(item.is_self),
            order: typeof item.order === "string" ? item.order : "",
            volume_percent: (() => {
              const n = Number(item.volume_percent);
              if (!Number.isFinite(n)) return 100;
              return Math.min(200, Math.max(0, Math.round(n)));
            })(),
            video_info: parseVideoInfo(item.video_info),
            screen_sharing_video_info: parseVideoInfo(item.screen_sharing_video_info),
          };
        })
        .filter((row): row is TelegramChatVoiceParticipant => row != null)
    : [];
  const voiceCallId = normalizeTelegramGroupCallId(json.voice_chat_group_call_id);
  const rawCount = Number.isFinite(Number(json.participant_count))
    ? Number(json.participant_count)
    : participants.length;
  return {
    ok: true,
    participants,
    // TDLib getChat often reports participant_count=0 while still returning rows.
    participant_count: Math.max(rawCount, participants.length),
    has_active_voice_chat: Boolean(json.has_active_voice_chat) || voiceCallId != null,
    voice_chat_group_call_id: voiceCallId,
    voice_resolve_source:
      typeof json.voice_resolve_source === "string" ? json.voice_resolve_source : "none",
    loaded_all_participants: Boolean(json.loaded_all_participants),
    has_hidden_listeners: Boolean(json.has_hidden_listeners),
  };
}
