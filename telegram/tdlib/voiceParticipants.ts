import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat } from "./chatPreview.js";
import { formattedTextPlain } from "./chatPreview.js";
import { emojiStatusCustomIdFromChat, emojiStatusCustomIdFromUser } from "./emojiStatus.js";

export type VoiceParticipantRow = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
  is_speaking: boolean;
  is_self: boolean;
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

type CollectedParticipant = {
  userId: number | null;
  chatId: number | null;
  isSpeaking: boolean;
};

type ProfileCacheEntry = {
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
  at: number;
};

type CallParticipantsCache = {
  uniqueId: string;
  members: Map<string, CollectedParticipant>;
  loadedAt: number;
  /** True once TDLib reported loaded_all_participants after a successful load pass. */
  loadedAll: boolean;
};

const PROFILE_TTL_MS = 5 * 60_000;
/** Fresh complete roster — reuse across presence polls. Incomplete never treated as fresh. */
const FULL_RELOAD_TTL_MS = 1_500;
/** TDLib delivers updateGroupCallParticipant asynchronously after each load. */
const LOAD_CHUNK_SETTLE_MS = 320;
const LOAD_FINAL_SETTLE_MS = 450;
const LOAD_MAX_ATTEMPTS = 12;
const profileCache = new Map<string, ProfileCacheEntry>();
const callMembersCache = new Map<number, CallParticipantsCache>();
/** Self user ids confirmed joined; empty-order updates must not drop them. */
const pinnedSelfUserIds = new Set<number>();

function pinVoiceParticipantSelfUserId(userId: number): void {
  if (Number.isFinite(userId) && userId > 0) pinnedSelfUserIds.add(Math.trunc(userId));
}

/**
 * Keep a live roster from updateGroupCallParticipant for the process lifetime.
 * Join floods these updates before presence polls attach a temporary listener;
 * without this cache those events are lost and loadGroupCallParticipants may
 * no-op when loaded_all_participants is already true.
 */
export function ingestGroupCallParticipantUpdate(update: Record<string, unknown>): void {
  if (update._ !== "updateGroupCallParticipant") return;
  const callId = Number(update.group_call_id);
  if (!Number.isFinite(callId) || callId <= 0) return;
  const participant = update.participant as GroupCallParticipantUpdate | undefined;
  if (!participant || typeof participant !== "object") return;
  const { userId, chatId } = parseSender(participant.participant_id);
  const key = participantKey(userId, chatId);
  if (!key) return;

  let cached = callMembersCache.get(callId);
  if (!cached) {
    cached = {
      uniqueId: "",
      members: new Map(),
      loadedAt: Date.now(),
      loadedAll: false,
    };
    callMembersCache.set(callId, cached);
  }

  const order = typeof participant.order === "string" ? participant.order : "";
  if (!order) {
    // Empty order means left per TDLib. Muted self can also get empty order while
    // still joined — keep pinned self. Do not drop other members on a lone empty
    // order while the roster is still loading (join floods partial updates).
    if (userId != null && pinnedSelfUserIds.has(userId)) {
      const prev = cached.members.get(key);
      if (prev) cached.members.set(key, { ...prev, isSpeaking: false });
    } else if (cached.loadedAll) {
      cached.members.delete(key);
    }
  } else {
    cached.members.set(key, {
      userId,
      chatId,
      isSpeaking: Boolean(participant.is_speaking),
    });
  }
  cached.loadedAt = Date.now();
}

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

async function resolveParticipantProfile(
  client: Client,
  userId: number | null,
  chatId: number | null,
): Promise<{
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
}> {
  const key = participantKey(userId, chatId);
  if (key) {
    const cached = profileCache.get(key);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
      return {
        title: cached.title,
        description: cached.description,
        emoji_status_custom_emoji_id: cached.emoji_status_custom_emoji_id,
      };
    }
  }

  let title = "";
  let description = "";
  let emojiStatus: string | null = null;

  if (userId != null) {
    try {
      const user = (await client.invoke({
        _: "getUser",
        user_id: userId,
      })) as Record<string, unknown>;
      const parts = [user.first_name, user.last_name].filter(
        (part): part is string => typeof part === "string" && Boolean(part.trim()),
      );
      title = parts.join(" ").trim();
      if (!title) {
        const usernames = user.usernames as
          | { editable_username?: string; active_usernames?: string[] }
          | undefined;
        const username =
          typeof user.username === "string" && user.username.trim()
            ? user.username.trim()
            : usernames?.editable_username || usernames?.active_usernames?.[0] || "";
        if (username) title = `@${username}`;
      }
      emojiStatus = emojiStatusCustomIdFromUser(user);
    } catch {
      title = "";
    }

    try {
      const full = (await client.invoke({
        _: "getUserFullInfo",
        user_id: userId,
      })) as {
        bio?: unknown;
        bot_info?: { description?: string };
      };
      description = formattedTextPlain(full.bio) ?? "";
      if (!description) {
        const botDesc = full.bot_info?.description;
        if (typeof botDesc === "string" && botDesc.trim()) description = botDesc.trim();
      }
    } catch {
      description = "";
    }
  } else if (chatId != null) {
    try {
      const chat = (await client.invoke({
        _: "getChat",
        chat_id: chatId,
      })) as TdChat & {
        type?: { _?: string; supergroup_id?: number };
      };
      title = chat.title?.trim() || "";
      emojiStatus = emojiStatusCustomIdFromChat(chat);
      const type = chat.type;
      if (type?._ === "chatTypeSupergroup" && Number(type.supergroup_id) > 0) {
        try {
          const full = (await client.invoke({
            _: "getSupergroupFullInfo",
            supergroup_id: Math.trunc(Number(type.supergroup_id)),
          })) as { description?: string };
          if (typeof full.description === "string" && full.description.trim()) {
            description = full.description.trim();
          }
        } catch {
          description = "";
        }
      }
    } catch {
      title = "";
    }
  }

  if (key) {
    profileCache.set(key, {
      title,
      description,
      emoji_status_custom_emoji_id: emojiStatus,
      at: Date.now(),
    });
  }

  return { title, description, emoji_status_custom_emoji_id: emojiStatus };
}

function speakersFromGroupCall(groupCall: GroupCallSnapshot): Map<string, CollectedParticipant> {
  const map = new Map<string, CollectedParticipant>();
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

function applySpeakingOverlay(
  members: Map<string, CollectedParticipant>,
  speakers: Map<string, CollectedParticipant>,
): Map<string, CollectedParticipant> {
  const next = new Map<string, CollectedParticipant>();
  for (const [key, row] of members) {
    const speaker = speakers.get(key);
    next.set(key, {
      ...row,
      isSpeaking: speaker ? Boolean(speaker.isSpeaking) : false,
    });
  }
  for (const [key, speaker] of speakers) {
    if (next.has(key)) continue;
    next.set(key, { ...speaker });
  }
  return next;
}

/** Keep larger base roster; overlay fresher speaking flags from a partial reload. */
function mergeParticipantMaps(
  base: Map<string, CollectedParticipant>,
  overlay: Map<string, CollectedParticipant>,
): Map<string, CollectedParticipant> {
  const next = new Map(base);
  for (const [key, row] of overlay) {
    const prev = next.get(key);
    next.set(key, prev ? { ...prev, isSpeaking: row.isSpeaking } : { ...row });
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rosterLooksComplete(
  listed: number,
  participantCount: number,
  hasHiddenListeners: boolean,
  loadedAllParticipants: boolean,
): boolean {
  if (listed <= 0) return false;
  // TDLib's own signal that the visible roster finished loading.
  if (loadedAllParticipants) return true;
  // has_hidden_listeners means muted people are omitted — listed will never equal
  // participant_count. Do NOT treat that flag alone as "done" or we stop after
  // the first partial chunk / recent_speakers merge.
  if (hasHiddenListeners) return false;
  if (!Number.isFinite(participantCount) || participantCount <= 0) return false;
  return listed >= participantCount;
}

async function loadJoinedParticipants(
  client: Client,
  callId: number,
): Promise<{ members: Map<string, CollectedParticipant>; loadedAll: boolean }> {
  const map = new Map<string, CollectedParticipant>();
  // Seed from join-time updates already ingested into the process cache.
  const seeded = callMembersCache.get(callId);
  if (seeded) {
    for (const [key, row] of seeded.members) map.set(key, { ...row });
  }
  let sawLoadedAll = Boolean(seeded?.loadedAll);

  const onUpdate = (update: Record<string, unknown>) => {
    if (update._ !== "updateGroupCallParticipant") return;
    if (Number(update.group_call_id) !== callId) return;
    ingestGroupCallParticipantUpdate(update);
    const participant = update.participant as GroupCallParticipantUpdate | undefined;
    if (!participant || typeof participant !== "object") return;
    const { userId, chatId } = parseSender(participant.participant_id);
    const key = participantKey(userId, chatId);
    if (!key) return;
    const order = typeof participant.order === "string" ? participant.order : "";
    if (!order) {
      if (userId != null && pinnedSelfUserIds.has(userId)) {
        const prev = map.get(key);
        if (prev) map.set(key, { ...prev, isSpeaking: false });
      } else if (sawLoadedAll) {
        map.delete(key);
      }
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
    // Keep loading until TDLib says all participants are loaded, but wait long enough
    // after each chunk for updateGroupCallParticipant events to land.
    for (let attempt = 0; attempt < LOAD_MAX_ATTEMPTS; attempt += 1) {
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
          listed: map.size,
        });
        break;
      }

      await sleep(LOAD_CHUNK_SETTLE_MS);

      const refreshed = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as GroupCallSnapshot;
      if (!refreshed.is_joined && !refreshed.need_rejoin) break;

      const expected = Number(refreshed.participant_count);
      const hasHidden = Boolean(refreshed.has_hidden_listeners);
      const loadedAll = Boolean(refreshed.loaded_all_participants);
      if (loadedAll) sawLoadedAll = true;

      if (rosterLooksComplete(map.size, expected, hasHidden, loadedAll)) {
        break;
      }
      if (loadedAll) {
        // Flag means TDLib finished requesting; last chunk updates may still be in flight.
        await sleep(LOAD_FINAL_SETTLE_MS);
        if (rosterLooksComplete(map.size, expected, hasHidden, true)) break;
        // Keep settling rather than exiting with a truncated map on the first flag.
        continue;
      }
    }
  } finally {
    client.removeListener("update", onUpdate);
  }

  return { members: map, loadedAll: sawLoadedAll };
}

/**
 * Full voice/video chat participant list for a chat-bound group call.
 * Requires an existing join (media session) for the complete roster.
 * Falls back to recent_speakers (max ~3). Never temp-joins.
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
  if (callId <= 0) {
    return { ok: true, error: null, participant_count: 0, participants: [] };
  }

  // Single snapshot — no busy-wait. Recent speakers update without being joined.
  const groupCall = (await client.invoke({
    _: "getGroupCall",
    group_call_id: callId,
  })) as GroupCallSnapshot;
  const speakers = speakersFromGroupCall(groupCall);
  const uniqueId = String(groupCall.unique_id ?? "");
  const isJoined = Boolean(groupCall.is_joined || groupCall.need_rejoin);

  const participantCountHint = Number(groupCall.participant_count);
  const hasHiddenListeners = Boolean(groupCall.has_hidden_listeners);

  let collected = speakers;
  if (isJoined) {
    const cached = callMembersCache.get(callId);
    const countAheadOfRoster =
      Number.isFinite(participantCountHint) &&
      participantCountHint > (cached?.members.size ?? 0) &&
      !hasHiddenListeners;
    const cacheFresh =
      cached != null &&
      cached.uniqueId === uniqueId &&
      Date.now() - cached.loadedAt < FULL_RELOAD_TTL_MS &&
      cached.members.size > 0 &&
      !countAheadOfRoster &&
      rosterLooksComplete(
        cached.members.size,
        participantCountHint,
        hasHiddenListeners,
        cached.loadedAll,
      );

    if (cacheFresh) {
      collected = applySpeakingOverlay(cached.members, speakers);
    } else {
      const { members: loaded, loadedAll } = await loadJoinedParticipants(client, callId);
      if (loaded.size > 0) {
        // Prefer the larger of previous/new when the new load still looks truncated —
        // a flaky load should not wipe a better roster for 20s.
        const preferCached =
          cached != null &&
          (cached.uniqueId === uniqueId || !cached.uniqueId) &&
          cached.members.size > loaded.size &&
          !rosterLooksComplete(loaded.size, participantCountHint, hasHiddenListeners, loadedAll);
        const members = preferCached
          ? mergeParticipantMaps(cached.members, loaded)
          : loaded;
        const nextLoadedAll = loadedAll || Boolean(preferCached && cached?.loadedAll);
        callMembersCache.set(callId, {
          uniqueId,
          members,
          loadedAt: Date.now(),
          loadedAll: nextLoadedAll,
        });
        collected = applySpeakingOverlay(members, speakers);
      } else if (cached && cached.members.size > 0 && (cached.uniqueId === uniqueId || !cached.uniqueId)) {
        collected = applySpeakingOverlay(cached.members, speakers);
      } else {
        collected = speakers;
      }
    }
  } else {
    callMembersCache.delete(callId);
  }

  let selfUserId: number | null = null;
  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    const id = Number(me.id);
    if (Number.isFinite(id) && id > 0) selfUserId = Math.trunc(id);
  } catch {
    selfUserId = null;
  }

  // Listen-only / muted self is often omitted when has_hidden_listeners is set, and
  // updateGroupCallParticipant with empty order can drop us from the live cache.
  // While TDLib reports us as joined, always keep self visible in the roster.
  if (isJoined && selfUserId != null) {
    pinVoiceParticipantSelfUserId(selfUserId);
    const selfKey = participantKey(selfUserId, null);
    if (selfKey && !collected.has(selfKey)) {
      collected = new Map(collected);
      collected.set(selfKey, {
        userId: selfUserId,
        chatId: null,
        isSpeaking: false,
      });
      const cached = callMembersCache.get(callId);
      if (cached) {
        cached.members.set(selfKey, {
          userId: selfUserId,
          chatId: null,
          isSpeaking: false,
        });
      } else if (uniqueId) {
        callMembersCache.set(callId, {
          uniqueId,
          members: new Map([
            [
              selfKey,
              { userId: selfUserId, chatId: null, isSpeaking: false },
            ],
          ]),
          loadedAt: Date.now(),
          loadedAll: false,
        });
      }
    }
  } else if (!isJoined && selfUserId != null) {
    pinnedSelfUserIds.delete(selfUserId);
  }

  const rows = [...collected.values()];
  const profiles = await Promise.all(
    rows.map((row) => resolveParticipantProfile(client, row.userId, row.chatId)),
  );

  const participants: VoiceParticipantRow[] = rows.map((row, index) => {
    const profile = profiles[index]!;
    return {
      user_id: row.userId,
      chat_id: row.chatId,
      title: profile.title,
      description: profile.description,
      emoji_status_custom_emoji_id: profile.emoji_status_custom_emoji_id,
      is_speaking: row.isSpeaking,
      is_self: selfUserId != null && row.userId === selfUserId,
    };
  });

  participants.sort((a, b) => {
    if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
    if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const participantCount = Number(groupCall.participant_count);
  logGateway("voice_participants_resolved", {
    chatId,
    groupCallId: callId,
    listed: participants.length,
    participantCount: Number.isFinite(participantCount) ? participantCount : null,
    isJoined,
    hasHiddenListeners: Boolean(groupCall.has_hidden_listeners),
    usedCache: isJoined && callMembersCache.has(callId),
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
