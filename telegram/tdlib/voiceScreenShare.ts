import type { Client } from "tdl";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";
import { scheduleVoiceRosterReloadAfterJoin } from "./voiceParticipants.js";

export type VoiceScreenShareStartInput = {
  audio_source_id: number;
  payload: string;
};

async function resolveGroupCallId(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
): Promise<number | null> {
  let callId = 0;
  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    callId = normalizeTelegramGroupCallId(chat.video_chat?.group_call_id) ?? 0;
  } catch {
    callId = 0;
  }
  if (callId <= 0) {
    callId = normalizeTelegramGroupCallId(groupCallId) ?? 0;
  }
  return callId > 0 ? callId : null;
}

/** Start screen sharing on an already-joined group call (separate presentation WebRTC). */
export async function startChatVoiceScreenShare(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  joinParameters: VoiceScreenShareStartInput,
): Promise<{
  ok: boolean;
  error: string | null;
  join_payload: string;
}> {
  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat", join_payload: "" };
  }

  const audioSourceId = telegramInt32AudioSourceId(Number(joinParameters.audio_source_id));
  if (!Number.isFinite(audioSourceId) || audioSourceId === 0) {
    return { ok: false, error: "invalid_audio_source", join_payload: "" };
  }
  const payload = typeof joinParameters.payload === "string" ? joinParameters.payload.trim() : "";
  if (!payload) {
    return { ok: false, error: "invalid_join_payload", join_payload: "" };
  }

  try {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as { is_joined?: boolean; need_rejoin?: boolean };
      if (!groupCall.is_joined && !groupCall.need_rejoin) {
        logGateway("voice_screen_share_not_joined", { chatId, groupCallId: callId });
        return { ok: false, error: "GROUPCALL_JOIN_MISSING", join_payload: "" };
      }
    } catch {
      // Fall through — getGroupCall can race during join.
    }

    const result = (await client.invoke({
      _: "startGroupCallScreenSharing",
      group_call_id: callId,
      audio_source_id: audioSourceId,
      payload,
    })) as { text?: string } | string;

    const joinPayload =
      typeof result === "string"
        ? result
        : typeof result?.text === "string"
          ? result.text
          : "";

    if (!joinPayload.trim()) {
      logGateway("voice_screen_share_empty_payload", { chatId, groupCallId: callId });
      return { ok: false, error: "empty_join_payload", join_payload: "" };
    }

    logGateway("voice_screen_share_start_ok", {
      chatId,
      groupCallId: callId,
      payloadBytes: joinPayload.length,
    });
    scheduleVoiceRosterReloadAfterJoin(client, callId);

    return { ok: true, error: null, join_payload: joinPayload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_screen_share_start_failed", { chatId, groupCallId: callId, message });
    return { ok: false, error: message, join_payload: "" };
  }
}

/** Stop screen sharing without leaving the main group call. */
export async function endChatVoiceScreenShare(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
): Promise<{ ok: boolean; error: string | null }> {
  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat" };
  }

  try {
    await client.invoke({
      _: "endGroupCallScreenSharing",
      group_call_id: callId,
    });
    logGateway("voice_screen_share_end_ok", { chatId, groupCallId: callId });
    scheduleVoiceRosterReloadAfterJoin(client, callId);
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_screen_share_end_failed", { chatId, groupCallId: callId, message });
    return { ok: false, error: message };
  }
}
