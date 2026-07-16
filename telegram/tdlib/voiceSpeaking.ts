import type { Client } from "tdl";
import {
  normalizeTelegramGroupCallId,
  telegramInt32AudioSourceId,
} from "../../shared/telegramGroupCallSdp.js";
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

/** Tell Telegram whether our local audio source is currently speaking. */
export async function setChatVoiceParticipantSpeaking(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  audioSourceId: number,
  isSpeaking: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat" };
  }
  const source = telegramInt32AudioSourceId(Number(audioSourceId));
  if (!Number.isFinite(source) || source === 0) {
    return { ok: false, error: "invalid_audio_source" };
  }

  try {
    await client.invoke({
      _: "setGroupCallParticipantIsSpeaking",
      group_call_id: callId,
      audio_source: source,
      is_speaking: Boolean(isSpeaking),
    });
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_speaking_set_failed", {
      chatId,
      groupCallId: callId,
      audioSourceId: source,
      isSpeaking,
      message,
    });
    return { ok: false, error: message };
  }
}
