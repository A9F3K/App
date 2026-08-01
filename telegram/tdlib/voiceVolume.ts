import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";

async function resolveGroupCallId(
  client: Client,
  chatId: number,
  groupCallId?: number | null,
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

/** UI 0–200% → TDLib volume_level 1–20000 (10000 = 100%). */
export function percentToTdlibVolumeLevel(percent: number): number {
  const p = Math.min(200, Math.max(0, Math.round(Number(percent) || 0)));
  if (p <= 0) return 1;
  return Math.min(20000, Math.max(1, p * 100));
}

/** TDLib volume_level → UI 0–200% (level ≤1 displays as 0%). */
export function tdlibVolumeLevelToPercent(level: number): number {
  if (!Number.isFinite(level) || level <= 1) return 0;
  return Math.min(200, Math.max(0, Math.round(level / 100)));
}

/**
 * Set per-participant volume for the current user (or for everyone if they can
 * manage the call). TDLib range is 1–20000; UI uses 0–200%.
 */
export async function setChatVoiceParticipantVolume(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  participant: { userId?: number | null; chatId?: number | null },
  volumePercent: number,
): Promise<{ ok: boolean; error: string | null; volume_percent: number }> {
  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat", volume_percent: volumePercent };
  }

  const userId =
    participant.userId != null && Number.isFinite(participant.userId)
      ? Math.trunc(participant.userId)
      : null;
  const peerChatId =
    participant.chatId != null && Number.isFinite(participant.chatId)
      ? Math.trunc(participant.chatId)
      : null;
  if ((userId == null || userId === 0) && (peerChatId == null || peerChatId === 0)) {
    return { ok: false, error: "participant_required", volume_percent: volumePercent };
  }

  const volumeLevel = percentToTdlibVolumeLevel(volumePercent);
  const volume_percent = tdlibVolumeLevelToPercent(volumeLevel);

  try {
    await client.invoke({
      _: "setGroupCallParticipantVolumeLevel",
      group_call_id: callId,
      participant_id:
        userId != null && userId !== 0
          ? { _: "messageSenderUser", user_id: userId }
          : { _: "messageSenderChat", chat_id: peerChatId! },
      volume_level: volumeLevel,
    });
    logGateway("voice_participant_volume_set", {
      chatId,
      groupCallId: callId,
      userId,
      peerChatId,
      volumeLevel,
      volume_percent,
    });
    return { ok: true, error: null, volume_percent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_participant_volume_failed", {
      chatId,
      groupCallId: callId,
      userId,
      peerChatId,
      volumeLevel,
      message,
    });
    return { ok: false, error: message, volume_percent };
  }
}
