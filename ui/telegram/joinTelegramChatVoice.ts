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
  /** Optional external abort (e.g. ICE/audio recover join watchdog). */
  signal?: AbortSignal;
}): Promise<JoinTelegramChatVoiceResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const audioSourceId = telegramInt32AudioSourceId(Number(input.audioSourceId));
  if (!Number.isFinite(audioSourceId) || audioSourceId === 0) {
    return { ok: false, error: "invalid_audio_source" };
  }
  if (input.signal?.aborted) {
    return { ok: false, error: "aborted" };
  }
  const controller = new AbortController();
  // Gateway can stall under voice-dialog load (prod: ice_recover → join_timeout
  // while participants SSE also times out). Give TDLib join room to finish.
  const timer = setTimeout(() => controller.abort(), 45_000);
  const onExternalAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/telegram-messages-voice-join"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: input.chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
        audio_source_id: audioSourceId,
        payload: input.payload,
        is_muted: input.isMuted,
        is_my_video_enabled: false,
      }),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const external = Boolean(input.signal?.aborted);
    return {
      ok: false,
      error: aborted ? (external ? "aborted" : "join_timeout") : "network_error",
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
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
