import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import { formattedTextPlain, type TdChat } from "./chatPreview.js";
import { getLiveChatSelfUserId } from "./liveChatCache.js";
import { emitVoiceCallMessage } from "./voiceCallMessagesNotify.js";
import { peekVoiceParticipantTitle } from "./voiceParticipants.js";

export type VoiceCallMessageRow = {
  id: string;
  message_id: number;
  group_call_id: number;
  text: string;
  sender_name: string;
  sender_user_id: number | null;
  sender_chat_id: number | null;
  is_self: boolean;
  /** Unix ms */
  sent_at: number;
};

const MAX_MESSAGES_PER_CALL = 64;
const messagesByCall = new Map<number, VoiceCallMessageRow[]>();
const revisionByCall = new Map<number, number>();

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

function parseSender(sender: unknown): {
  userId: number | null;
  chatId: number | null;
} {
  if (!sender || typeof sender !== "object" || Array.isArray(sender)) {
    return { userId: null, chatId: null };
  }
  const row = sender as { _?: string; user_id?: unknown; chat_id?: unknown };
  if (row._ === "messageSenderUser") {
    const userId = Number(row.user_id);
    return {
      userId: Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null,
      chatId: null,
    };
  }
  if (row._ === "messageSenderChat") {
    const chatId = Number(row.chat_id);
    return {
      userId: null,
      chatId: Number.isFinite(chatId) && chatId !== 0 ? Math.trunc(chatId) : null,
    };
  }
  return { userId: null, chatId: null };
}

function bumpRevision(groupCallId: number): number {
  const next = (revisionByCall.get(groupCallId) ?? 0) + 1;
  revisionByCall.set(groupCallId, next);
  return next;
}

function appendMessage(row: VoiceCallMessageRow): void {
  const callId = row.group_call_id;
  const list = messagesByCall.get(callId) ?? [];
  if (list.some((m) => m.id === row.id)) return;
  // Replace optimistic local rows when the real updateNewGroupCallMessage arrives.
  // Match on text only — is_self / sender title can race before getMe / roster titles resolve.
  if (!row.id.includes(":local:")) {
    const idx = list.findIndex(
      (m) => m.id.includes(":local:") && m.text === row.text,
    );
    if (idx >= 0) {
      list[idx] = row;
      messagesByCall.set(callId, list);
      const revision = bumpRevision(callId);
      emitVoiceCallMessage(callId, revision, row);
      return;
    }
  } else if (list.some((m) => !m.id.includes(":local:") && m.text === row.text)) {
    // Canonical row already present — drop late optimistic.
    return;
  }
  list.push(row);
  while (list.length > MAX_MESSAGES_PER_CALL) list.shift();
  messagesByCall.set(callId, list);
  const revision = bumpRevision(callId);
  emitVoiceCallMessage(callId, revision, row);
}

export function getVoiceCallMessagesRevision(groupCallId: number): number {
  return revisionByCall.get(Math.trunc(groupCallId)) ?? 0;
}

export function getRecentVoiceCallMessages(groupCallId: number): VoiceCallMessageRow[] {
  return [...(messagesByCall.get(Math.trunc(groupCallId)) ?? [])];
}

/**
 * TDLib updateNewGroupCallMessage — ephemeral in-call chat (no history API).
 */
export function ingestNewGroupCallMessage(
  update: Record<string, unknown>,
  options?: { telegramUsername?: string },
): void {
  const groupCallId = normalizeTelegramGroupCallId(update.group_call_id);
  if (groupCallId == null) return;
  const message = update.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const msg = message as Record<string, unknown>;
  const messageId = Number(msg.message_id);
  if (!Number.isFinite(messageId)) return;
  const text = formattedTextPlain(msg.text) ?? "";
  if (!text) return;
  const { userId, chatId } = parseSender(msg.sender_id);
  const selfId =
    options?.telegramUsername != null
      ? getLiveChatSelfUserId(options.telegramUsername)
      : null;
  const isSelf = selfId != null && userId != null && userId === selfId;
  const cachedTitle = peekVoiceParticipantTitle(userId, chatId);
  const dateSec = Number(msg.date);
  const sentAt =
    Number.isFinite(dateSec) && dateSec > 0 ? Math.trunc(dateSec) * 1000 : Date.now();

  appendMessage({
    id: `${groupCallId}:${Math.trunc(messageId)}`,
    message_id: Math.trunc(messageId),
    group_call_id: groupCallId,
    text,
    sender_name:
      cachedTitle ||
      (userId != null ? `User ${userId}` : chatId != null ? `Chat ${Math.abs(chatId)}` : "?"),
    sender_user_id: userId,
    sender_chat_id: chatId,
    is_self: isSelf,
    sent_at: sentAt,
  });
}

/** Send an in-call message via TDLib sendGroupCallMessage. */
export async function sendChatVoiceCallMessage(
  client: Client,
  chatId: number,
  groupCallId: number | null | undefined,
  text: string,
  telegramUsername?: string,
): Promise<{ ok: boolean; error: string | null; message: VoiceCallMessageRow | null }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "empty_text", message: null };
  }
  if (trimmed.length > 128) {
    // TDLib option group_call_message_text_length_max is typically small.
    return { ok: false, error: "text_too_long", message: null };
  }

  const callId = await resolveGroupCallId(client, chatId, groupCallId);
  if (callId == null) {
    return { ok: false, error: "no_active_voice_chat", message: null };
  }

  try {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as {
        is_joined?: boolean;
        need_rejoin?: boolean;
        can_send_messages?: boolean;
        are_messages_allowed?: boolean;
      };
      if (groupCall.are_messages_allowed === false || groupCall.can_send_messages === false) {
        return { ok: false, error: "messages_not_allowed", message: null };
      }
      // Do not hard-fail on !is_joined here — getGroupCall can lag while WebRTC
      // is still live. sendGroupCallMessage is the source of truth.
    } catch {
      // Fall through — getGroupCall can race during join.
    }

    await client.invoke({
      _: "sendGroupCallMessage",
      group_call_id: callId,
      text: {
        _: "formattedText",
        text: trimmed,
        entities: [],
      },
      paid_message_star_count: 0,
    });

    let selfUserId: number | null =
      telegramUsername != null ? getLiveChatSelfUserId(telegramUsername) : null;
    if (selfUserId == null) {
      try {
        const me = (await client.invoke({ _: "getMe" })) as { id?: number };
        const id = Number(me.id);
        selfUserId = Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
      } catch {
        selfUserId = null;
      }
    }
    const title = peekVoiceParticipantTitle(selfUserId, null) || "You";
    // HTTP-only optimistic row — do not append/emit here. SSE delivers the
    // canonical updateNewGroupCallMessage; double-emitting caused duplicate bubbles.
    const optimistic: VoiceCallMessageRow = {
      id: `${callId}:local:${Date.now()}`,
      message_id: 0,
      group_call_id: callId,
      text: trimmed,
      sender_name: title,
      sender_user_id: selfUserId,
      sender_chat_id: null,
      is_self: true,
      sent_at: Date.now(),
    };

    logGateway("voice_call_message_sent", {
      chatId,
      groupCallId: callId,
      chars: trimmed.length,
    });
    return { ok: true, error: null, message: optimistic };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_call_message_send_failed", {
      chatId,
      groupCallId: callId,
      message,
    });
    return { ok: false, error: message, message: null };
  }
}
