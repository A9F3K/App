import { buildApiUrl } from "../../api/_base";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp";

export type StartTelegramChatVoiceScreenShareResult =
  | { ok: true; join_payload: string }
  | { ok: false; error: string };

export async function startTelegramChatVoiceScreenShare(input: {
  chatId: number;
  groupCallId?: number | null;
  audioSourceId: number;
  payload: string;
}): Promise<StartTelegramChatVoiceScreenShareResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const audioSourceId = telegramInt32AudioSourceId(Number(input.audioSourceId));
  if (!Number.isFinite(audioSourceId) || audioSourceId === 0) {
    return { ok: false, error: "invalid_audio_source" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/telegram-messages-voice-screen-share-start"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: input.chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
        audio_source_id: audioSourceId,
        payload: input.payload,
      }),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: aborted ? "screen_share_timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    join_payload?: string;
  };
  if (!response.ok || !json.ok || typeof json.join_payload !== "string") {
    return { ok: false, error: json.error ?? "screen_share_start_failed" };
  }
  return { ok: true, join_payload: json.join_payload };
}

export type EndTelegramChatVoiceScreenShareResult =
  | { ok: true }
  | { ok: false; error: string };

export async function endTelegramChatVoiceScreenShare(input: {
  chatId: number;
  groupCallId?: number | null;
}): Promise<EndTelegramChatVoiceScreenShareResult> {
  if (!Number.isFinite(input.chatId) || input.chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const callId = normalizeTelegramGroupCallId(input.groupCallId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/telegram-messages-voice-screen-share-end"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: input.chatId,
        ...(callId != null ? { group_call_id: callId } : {}),
      }),
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: aborted ? "screen_share_timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || !json.ok) {
    return { ok: false, error: json.error ?? "screen_share_end_failed" };
  }
  return { ok: true };
}
