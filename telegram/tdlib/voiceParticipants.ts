import type { Client } from "tdl";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";

export type VoiceParticipantRow = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  is_speaking: boolean;
};

type GroupCallSnapshot = {
  participant_count?: number;
  is_joined?: boolean;
  need_rejoin?: boolean;
  loaded_all_participants?: boolean;
  has_hidden_listeners?: boolean;
  unique_id?: number | string;
  recent_speakers?: Array<{
    participant_id?: { _?: string; user_id?: number; chat_id?: number };
    is_speaking?: boolean;
  }>;
};

type GroupCallParticipantUpdate = {
  participant_id?: { _?: string; user_id?: number; chat_id?: number };
  is_speaking?: boolean;
  order?: string;
};

function participantKey(userId: number | null, chatId: number | null): string | null {
  if (userId != null && userId > 0) return `u:${userId}`;
  if (chatId != null && chatId !== 0) return `c:${chatId}`;
  return null;
}

function parseSender(sender: { _?: string; user_id?: number; chat_id?: number } | undefined): {
  userId: number | null;
  chatId: number | null;
} {
  const userId = Number(sender?.user_id);
  const chatId = Number(sender?.chat_id);
  const hasUser = Number.isFinite(userId) && userId > 0;
  const hasChat = Number.isFinite(chatId) && chatId !== 0;
  return {
    userId: hasUser ? Math.trunc(userId) : null,
    chatId: hasChat ? Math.trunc(chatId) : null,
  };
}

/** Minimal join payload so TDLib can enter "joined/being joined" and load participants (no media). */
function mutedJoinParameters(): Record<string, unknown> {
  const ssrc = 1 + Math.floor(Math.random() * 0x7ffffffe);
  return {
    _: "groupCallJoinParameters",
    audio_source_id: ssrc,
    payload: JSON.stringify({
      ufrag: "hsp",
      pwd: "hsppassword0123456789",
      fingerprints: [
        {
          hash: "sha-256",
          setup: "passive",
          fingerprint: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
        },
      ],
      ssrc,
    }),
    is_muted: true,
    is_my_video_enabled: false,
  };
}

async function resolveParticipantTitle(
  client: Client,
  userId: number | null,
  chatId: number | null,
): Promise<string> {
  if (userId != null) {
    try {
      const user = (await client.invoke({
        _: "getUser",
        user_id: userId,
      })) as {
        first_name?: string;
        last_name?: string;
        username?: string;
        usernames?: { active_usernames?: string[]; editable_username?: string };
      };
      const parts = [user.first_name, user.last_name].filter(Boolean);
      let title = parts.join(" ").trim();
      if (!title) {
        const username =
          typeof user.username === "string" && user.username.trim()
            ? user.username.trim()
            : user.usernames?.editable_username ||
              user.usernames?.active_usernames?.[0] ||
              "";
        if (username) title = `@${username}`;
      }
      return title;
    } catch {
      return "";
    }
  }
  if (chatId != null) {
    try {
      const chat = (await client.invoke({
        _: "getChat",
        chat_id: chatId,
      })) as TdChat;
      return chat.title?.trim() || "";
    } catch {
      return "";
    }
  }
  return "";
}

function speakersFromGroupCall(groupCall: GroupCallSnapshot): Map<
  string,
  { userId: number | null; chatId: number | null; isSpeaking: boolean }
> {
  const map = new Map<
    string,
    { userId: number | null; chatId: number | null; isSpeaking: boolean }
  >();
  const speakers = Array.isArray(groupCall.recent_speakers) ? groupCall.recent_speakers : [];
  for (const speaker of speakers) {
    const { userId, chatId } = parseSender(speaker.participant_id);
    const key = participantKey(userId, chatId);
    if (!key) continue;
    map.set(key, {
      userId,
      chatId,
      isSpeaking: Boolean(speaker.is_speaking),
    });
  }
  return map;
}

async function ensureJoinedForParticipantLoad(
  client: Client,
  callId: number,
  groupCall: GroupCallSnapshot,
): Promise<boolean> {
  if (groupCall.is_joined || groupCall.need_rejoin) return false;
  try {
    await client.invoke({
      _: "joinVideoChat",
      group_call_id: callId,
      join_parameters: mutedJoinParameters(),
      invite_hash: "",
    });
    logGateway("voice_participants_join_for_load", { groupCallId: callId });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("voice_participants_join_for_load_failed", {
      groupCallId: callId,
      message,
    });
    return false;
  }
}

async function loadJoinedParticipants(
  client: Client,
  callId: number,
): Promise<Map<string, { userId: number | null; chatId: number | null; isSpeaking: boolean }>> {
  const map = new Map<
    string,
    { userId: number | null; chatId: number | null; isSpeaking: boolean }
  >();

  const onUpdate = (update: Record<string, unknown>) => {
    if (update._ !== "updateGroupCallParticipant") return;
    if (Number(update.group_call_id) !== callId) return;
    const participant = update.participant as GroupCallParticipantUpdate | undefined;
    if (!participant || typeof participant !== "object") return;
    const { userId, chatId } = parseSender(participant.participant_id);
    const key = participantKey(userId, chatId);
    if (!key) return;
    const order = typeof participant.order === "string" ? participant.order : "";
    if (!order) {
      map.delete(key);
      return;
    }
    map.set(key, {
      userId,
      chatId,
      isSpeaking: Boolean(participant.is_speaking),
    });
  };

  client.on("update", onUpdate);
  try {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await client.invoke({
          _: "loadGroupCallParticipants",
          group_call_id: callId,
          limit: 100,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logGateway("voice_participants_load_chunk_failed", {
          groupCallId: callId,
          attempt,
          message,
        });
        break;
      }

      // Allow updateGroupCallParticipant to settle between page loads.
      await new Promise((resolve) => setTimeout(resolve, 80));

      const refreshed = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as GroupCallSnapshot;
      if (refreshed.loaded_all_participants) break;
      if (!refreshed.is_joined && !refreshed.need_rejoin) break;
    }
  } finally {
    client.removeListener("update", onUpdate);
  }

  return map;
}

/**
 * Full voice/video chat participant list for a chat-bound group call.
 * Prefer loadGroupCallParticipants (requires joined); fall back to recent_speakers (max 3).
 */
export async function fetchChatVoiceParticipants(
  client: Client,
  chatId: number,
  groupCallId?: number | null,
): Promise<{
  ok: boolean;
  error: string | null;
  participant_count: number;
  participants: VoiceParticipantRow[];
}> {
  let callId = Number(groupCallId);
  if (!Number.isFinite(callId) || callId <= 0) {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    callId = Number(chat.video_chat?.group_call_id);
  }
  if (!Number.isFinite(callId) || callId <= 0) {
    return { ok: true, error: null, participant_count: 0, participants: [] };
  }
  callId = Math.trunc(callId);

  const groupCall = (await client.invoke({
    _: "getGroupCall",
    group_call_id: callId,
  })) as GroupCallSnapshot;

  const joinedForLoad = await ensureJoinedForParticipantLoad(client, callId, groupCall);
  let collected = speakersFromGroupCall(groupCall);

  try {
    const afterJoin = joinedForLoad
      ? ((await client.invoke({
          _: "getGroupCall",
          group_call_id: callId,
        })) as GroupCallSnapshot)
      : groupCall;

    if (afterJoin.is_joined || afterJoin.need_rejoin || joinedForLoad) {
      const loaded = await loadJoinedParticipants(client, callId);
      if (loaded.size > 0) {
        collected = loaded;
      } else {
        // Keep speakers if load returned empty (hidden listeners / race).
        for (const [key, row] of speakersFromGroupCall(afterJoin)) {
          if (!collected.has(key)) collected.set(key, row);
        }
      }
    }
  } finally {
    if (joinedForLoad) {
      try {
        await client.invoke({
          _: "leaveGroupCall",
          group_call_id: callId,
        });
        logGateway("voice_participants_leave_after_load", { groupCallId: callId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logGateway("voice_participants_leave_after_load_failed", {
          groupCallId: callId,
          message,
        });
      }
    }
  }

  const participants: VoiceParticipantRow[] = [];
  for (const row of collected.values()) {
    const title = await resolveParticipantTitle(client, row.userId, row.chatId);
    participants.push({
      user_id: row.userId,
      chat_id: row.chatId,
      title,
      is_speaking: row.isSpeaking,
    });
  }

  participants.sort((a, b) => {
    if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const participantCount = Number(groupCall.participant_count);
  logGateway("voice_participants_resolved", {
    chatId,
    groupCallId: callId,
    listed: participants.length,
    participantCount: Number.isFinite(participantCount) ? participantCount : null,
    joinedForLoad,
    hasHiddenListeners: Boolean(groupCall.has_hidden_listeners),
  });

  return {
    ok: true,
    error: null,
    participant_count:
      Number.isFinite(participantCount) && participantCount >= 0
        ? Math.trunc(participantCount)
        : participants.length,
    participants,
  };
}
