import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import { readTdVideoChat, type TdChat } from "./chatPreview.js";

function chatSupportsBoundVoiceChat(chat: TdChat): boolean {
  const type = chat.type?._;
  return type === "chatTypeBasicGroup" || type === "chatTypeSupergroup";
}

/**
 * Ensure a group voice chat exists for this chat (create if needed).
 * Does not join WebRTC — the client joins after receiving group_call_id.
 */
export async function startChatVoiceForUser(
  client: Client,
  chatId: number,
): Promise<{
  ok: boolean;
  error: string | null;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
}> {
  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    if (!chatSupportsBoundVoiceChat(chat)) {
      return {
        ok: false,
        error: "voice_chat_not_supported",
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
      };
    }

    let callId = readTdVideoChat(chat).group_call_id ?? 0;
    if (callId <= 0) {
      const created = (await client.invoke({
        _: "createVideoChat",
        chat_id: chatId,
        title: "",
        start_date: 0,
        is_rtmp_stream: false,
      })) as { id?: number; group_call_id?: number; groupCallId?: number };

      callId =
        normalizeTelegramGroupCallId(
          created?.id ?? created?.group_call_id ?? created?.groupCallId,
        ) ?? 0;
      if (callId <= 0) {
        const refreshed = (await client.invoke({
          _: "getChat",
          chat_id: chatId,
        })) as TdChat;
        callId = readTdVideoChat(refreshed).group_call_id ?? 0;
      }
    }

    if (callId <= 0) {
      logGateway("voice_start_no_call_id", { chatId });
      return {
        ok: false,
        error: "create_voice_chat_failed",
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
      };
    }

    logGateway("voice_start_ok", { chatId, groupCallId: callId });

    // Starter is about to join — treat as live so chat list / header update immediately.
    return {
      ok: true,
      error: null,
      has_active_voice_chat: true,
      voice_chat_group_call_id: callId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_start_failed", { chatId, message });

    // Race: another client created the call — reuse it when present.
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      const callId = readTdVideoChat(chat).group_call_id;
      if (callId != null) {
        return {
          ok: true,
          error: null,
          has_active_voice_chat: true,
          voice_chat_group_call_id: callId,
        };
      }
    } catch {
      // fall through
    }

    return {
      ok: false,
      error: message,
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
    };
  }
}
