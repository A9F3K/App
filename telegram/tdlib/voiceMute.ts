import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";

async function resolveGroupCallId(
  client: Client,
  chatId: number,
  groupCallId?: number | null,
): Promise<number | null> {
  // Prefer live TDLib state — client-cached call ids can be stale (e.g. Number(true) → 1).
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

/** Toggle whether the logged-in user is muted in an active group call. */
export async function setChatVoiceMicMuted(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  isMuted: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat" };
  }

  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    const userId = Number(me.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return { ok: false, error: "user_id_unavailable" };
    }

    await client.invoke({
      _: "toggleGroupCallParticipantIsMuted",
      group_call_id: callId,
      participant_id: {
        _: "messageSenderUser",
        user_id: Math.trunc(userId),
      },
      is_muted: isMuted,
    });

    logGateway("voice_mic_mute_set", { chatId, groupCallId: callId, isMuted });
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_mic_mute_failed", { chatId, groupCallId: callId, isMuted, message });
    return { ok: false, error: message };
  }
}
