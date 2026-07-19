import type { Client } from "tdl";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";
import { scheduleVoiceRosterReloadAfterJoin } from "./voiceParticipants.js";

export type VoiceJoinParametersInput = {
  audio_source_id: number;
  payload: string;
  is_muted: boolean;
  is_my_video_enabled?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until TDLib reports the call joined (or need_rejoin). */
async function waitUntilGroupCallJoined(
  client: Client,
  callId: number,
): Promise<{ isJoined: boolean; needRejoin: boolean }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as { is_joined?: boolean; need_rejoin?: boolean };
      const isJoined = Boolean(groupCall.is_joined);
      const needRejoin = Boolean(groupCall.need_rejoin);
      if (isJoined || needRejoin) {
        return { isJoined, needRejoin };
      }
    } catch {
      // retry
    }
    await sleep(80 + attempt * 40);
  }
  return { isJoined: false, needRejoin: false };
}

export async function joinChatVoiceForUser(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  joinParameters: VoiceJoinParametersInput,
): Promise<{
  ok: boolean;
  error: string | null;
  join_payload: string;
}> {
  // Prefer live TDLib state — client-cached call ids can be stale or wrong.
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
  if (callId <= 0) {
    return { ok: false, error: "no_active_voice_chat", join_payload: "" };
  }

  // WebRTC SSRC is uint32; TDLib expects signed int32 (0 is invalid).
  const audioSourceId = telegramInt32AudioSourceId(Number(joinParameters.audio_source_id));
  if (!Number.isFinite(audioSourceId) || audioSourceId === 0) {
    return { ok: false, error: "invalid_audio_source", join_payload: "" };
  }
  const payload = typeof joinParameters.payload === "string" ? joinParameters.payload.trim() : "";
  if (!payload) {
    return { ok: false, error: "invalid_join_payload", join_payload: "" };
  }

  try {
    const result = (await client.invoke({
      _: "joinVideoChat",
      group_call_id: callId,
      join_parameters: {
        _: "groupCallJoinParameters",
        audio_source_id: audioSourceId,
        payload,
        is_muted: Boolean(joinParameters.is_muted),
        is_my_video_enabled: Boolean(joinParameters.is_my_video_enabled),
      },
      invite_hash: "",
    })) as { text?: string } | string;

    const joinPayload =
      typeof result === "string"
        ? result
        : typeof result?.text === "string"
          ? result.text
          : "";

    if (!joinPayload.trim()) {
      logGateway("voice_join_empty_payload", { chatId, groupCallId: callId });
      return { ok: false, error: "empty_join_payload", join_payload: "" };
    }

    const joinState = await waitUntilGroupCallJoined(client, callId);
    logGateway("voice_join_ok", {
      chatId,
      groupCallId: callId,
      muted: Boolean(joinParameters.is_muted),
      payloadBytes: joinPayload.length,
      isJoined: joinState.isJoined,
      needRejoin: joinState.needRejoin,
      payloadHasTransport: (() => {
        try {
          const parsed = JSON.parse(joinPayload) as {
            transport?: unknown;
            ufrag?: unknown;
            stream?: boolean;
          };
          return Boolean(parsed.transport) || typeof parsed.ufrag === "string";
        } catch {
          return false;
        }
      })(),
      streamMode: (() => {
        try {
          return Boolean((JSON.parse(joinPayload) as { stream?: boolean }).stream);
        } catch {
          return false;
        }
      })(),
    });

    if (!joinState.isJoined && !joinState.needRejoin) {
      logGateway("voice_join_not_confirmed", { chatId, groupCallId: callId });
      // Still return the payload — WebRTC may work; presence/roster need a later rejoin.
    } else {
      // TDLib only allows loadGroupCallParticipants after join.
      scheduleVoiceRosterReloadAfterJoin(client, callId);
    }

    return { ok: true, error: null, join_payload: joinPayload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_join_failed", { chatId, groupCallId: callId, message });
    return { ok: false, error: message, join_payload: "" };
  }
}
