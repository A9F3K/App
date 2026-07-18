import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat, TdMessage } from "./chatPreview.js";
import { formattedTextPlain, readTdVideoChat, voiceChatFromTdChat } from "./chatPreview.js";
import { emojiStatusCustomIdFromChat, emojiStatusCustomIdFromUser } from "./emojiStatus.js";
import {
  beginVoiceParticipantsQuietLoad,
  emitVoiceParticipantsRevision,
  endVoiceParticipantsQuietLoad,
} from "./voiceParticipantsNotify.js";

export type VoiceParticipantRow = {
  user_id: number | null;
  chat_id: number | null;
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
  is_speaking: boolean;
  /** True when muted for all users (`is_muted_for_all_users`). */
  is_muted: boolean;
  is_self: boolean;
  /** TDLib lexicographic order — higher sorts first (Telegram Desktop). */
  order?: string;
};

type GroupCallSnapshot = {
  id?: number;
  participant_count?: number;
  is_active?: boolean;
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

const historyVoiceProbeAt = new Map<number, number>();
const HISTORY_VOICE_PROBE_MIN_INTERVAL_MS = 15_000;

function groupCallLooksLive(groupCall: GroupCallSnapshot | null | undefined): boolean {
  if (!groupCall || typeof groupCall !== "object") return false;
  if (groupCall.is_active === false) return false;
  const participantCount = Number(groupCall.participant_count) || 0;
  return (
    groupCall.is_active === true ||
    Boolean(groupCall.is_joined) ||
    Boolean(groupCall.need_rejoin) ||
    Boolean(groupCall.has_hidden_listeners) ||
    participantCount > 0
  );
}

/**
 * Resolve the bound group call id for a chat.
 * Prefer live `getChat.video_chat` (same as voice join) — client-cached preferred
 * ids are often stale/wrong and would desync SSE/poll from the real call.
 * Then preferred id, then a recent `messageVideoChatStarted` verified via getGroupCall.
 */
export async function resolveBoundGroupCallId(
  client: Client,
  chatId: number,
  preferredGroupCallId?: number | null,
  options?: { allowHistoryProbe?: boolean },
): Promise<{
  callId: number;
  source: "preferred" | "get_chat" | "history_started" | "none";
  videoChatRaw: ReturnType<typeof readTdVideoChat>["raw"];
  voice: ReturnType<typeof voiceChatFromTdChat>;
}> {
  let chat: TdChat | null = null;
  try {
    chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
  } catch {
    chat = null;
  }
  const video = readTdVideoChat(chat);
  const voice = chat
    ? voiceChatFromTdChat(chat)
    : { has_active_voice_chat: false, voice_chat_group_call_id: null };
  const fromChat = voice.voice_chat_group_call_id ?? 0;
  if (fromChat > 0) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: fromChat,
      })) as GroupCallSnapshot;
      if (groupCallLooksLive(groupCall)) {
        return {
          callId: fromChat,
          source: "get_chat",
          videoChatRaw: video.raw,
          voice,
        };
      }
    } catch {
      /* treat as inactive and continue */
    }
  }

  const preferred = normalizeTelegramGroupCallId(preferredGroupCallId) ?? 0;
  if (preferred > 0 && preferred !== fromChat) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: preferred,
      })) as GroupCallSnapshot;
      if (groupCallLooksLive(groupCall)) {
        return {
          callId: preferred,
          source: "preferred",
          videoChatRaw: video.raw,
          voice: {
            has_active_voice_chat: true,
            voice_chat_group_call_id: preferred,
          },
        };
      }
    } catch {
      /* fall through */
    }
  }

  const allowHistoryProbe = options?.allowHistoryProbe !== false;
  const lastProbe = historyVoiceProbeAt.get(chatId) ?? 0;
  const probeAllowed =
    allowHistoryProbe && Date.now() - lastProbe >= HISTORY_VOICE_PROBE_MIN_INTERVAL_MS;

  // Recovery: chat.video_chat can lag behind Desktop while a started-service
  // message still points at a live getGroupCall.
  if (probeAllowed) {
    historyVoiceProbeAt.set(chatId, Date.now());
    try {
      try {
        await client.invoke({ _: "openChat", chat_id: chatId });
      } catch {
        /* already open */
      }
      const history = (await client.invoke({
        _: "getChatHistory",
        chat_id: chatId,
        from_message_id: 0,
        offset: 0,
        limit: 40,
        only_local: false,
      })) as { messages?: TdMessage[] };
      const messages = Array.isArray(history.messages) ? history.messages : [];
      let endedSeen = false;
      for (const message of messages) {
        const content = message.content;
        const type = typeof content?._ === "string" ? content._ : "";
        if (type === "messageVideoChatEnded") {
          endedSeen = true;
          break;
        }
        if (type === "messageVideoChatStarted" && !endedSeen) {
          const startedId = normalizeTelegramGroupCallId(
            content?.group_call_id ?? content?.groupCallId,
          );
          if (startedId == null) continue;
          try {
            const groupCall = (await client.invoke({
              _: "getGroupCall",
              group_call_id: startedId,
            })) as GroupCallSnapshot;
            if (groupCallLooksLive(groupCall)) {
              logGateway("voice_call_id_recovered_from_history", {
                chatId,
                groupCallId: startedId,
                participantCount: Number(groupCall.participant_count) || 0,
                isActive: groupCall.is_active === true,
              });
              return {
                callId: startedId,
                source: "history_started",
                videoChatRaw: video.raw,
                voice: {
                  has_active_voice_chat: true,
                  voice_chat_group_call_id: startedId,
                },
              };
            }
          } catch {
            /* try older started messages */
          }
        }
      }
    } catch (err) {
      logGateway("voice_call_id_history_probe_failed", {
        chatId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logGateway("voice_call_id_missing", {
    chatId,
    videoChat: video.raw,
    hasParticipants: video.has_participants,
    normalizedCallId: video.group_call_id,
    historyProbed: probeAllowed,
  });
  return {
    callId: 0,
    source: "none",
    videoChatRaw: video.raw,
    voice: { has_active_voice_chat: false, voice_chat_group_call_id: null },
  };
}

type GroupCallParticipantUpdate = {
  participant_id?: { _?: string; user_id?: number; chat_id?: number };
  is_speaking?: boolean;
  is_muted_for_all_users?: boolean;
  order?: string;
};

type CollectedParticipant = {
  userId: number | null;
  chatId: number | null;
  isSpeaking: boolean;
  isMuted: boolean;
  /** TDLib participant order (lexicographic); empty means left. */
  order: string;
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
  /** Monotonic revision for SSE subscribers (speaking / roster). */
  revision: number;
  /** Last known TDLib participant_count hint for this call. */
  participantCountHint: number;
};

const PROFILE_TTL_MS = 30 * 60_000;
/** Serve stale profiles up to this age while a background refresh runs. */
const PROFILE_STALE_TTL_MS = 2 * 60 * 60_000;
/**
 * How long a loaded roster is trusted before a background reconcile. The live
 * `updateGroupCallParticipant` listener keeps the cache current, so this only
 * gates the (non-blocking) safety reconcile during long quiet stretches.
 */
const RECONCILE_TTL_MS = 45_000;
/** Min spacing between background roster reloads for one call (anti-stampede). */
const BG_RELOAD_MIN_INTERVAL_MS = 20_000;
/** TDLib delivers updateGroupCallParticipant asynchronously after each load. */
const LOAD_CHUNK_SETTLE_MS = 220;
const LOAD_FINAL_SETTLE_MS = 300;
const LOAD_MAX_ATTEMPTS = 8;

const profileCache = new Map<string, ProfileCacheEntry>();
const callMembersCache = new Map<number, CallParticipantsCache>();
/** chatId → last resolved group call id (for SSE subscribe by chat). */
const chatToGroupCallId = new Map<number, number>();
/** Calls with an in-flight background roster reload — avoid overlapping loads. */
const bgReloadInFlight = new Set<number>();
/** Last time a background reload started per call (throttle reconciles). */
const bgReloadLastAt = new Map<number, number>();
/** Self user ids confirmed joined; empty-order updates must not drop them. */
const pinnedSelfUserIds = new Set<number>();

function pinVoiceParticipantSelfUserId(userId: number): void {
  if (Number.isFinite(userId) && userId > 0) pinnedSelfUserIds.add(Math.trunc(userId));
}

function ensureCallCache(
  callId: number,
  seed?: Partial<CallParticipantsCache>,
): CallParticipantsCache {
  let cached = callMembersCache.get(callId);
  if (!cached) {
    cached = {
      uniqueId: seed?.uniqueId ?? "",
      members: seed?.members ?? new Map(),
      loadedAt: seed?.loadedAt ?? Date.now(),
      loadedAll: seed?.loadedAll ?? false,
      revision: seed?.revision ?? 0,
      participantCountHint: seed?.participantCountHint ?? 0,
    };
    callMembersCache.set(callId, cached);
  }
  return cached;
}

function bumpVoiceCallRevision(callId: number, options?: { immediate?: boolean }): number {
  const cached = callMembersCache.get(callId);
  if (!cached) return 0;
  cached.revision += 1;
  cached.loadedAt = Date.now();
  emitVoiceParticipantsRevision(callId, cached.revision, options);
  return cached.revision;
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

  const cached = ensureCallCache(callId);

  const order = typeof participant.order === "string" ? participant.order : "";
  let speakingBecameTrue = false;
  let speakingBecameFalse = false;
  if (!order) {
    // Empty order means left per TDLib. Muted self can also get empty order while
    // still joined — keep pinned self. Everyone else must drop immediately or the
    // roster grows past Telegram Desktop's participant list.
    if (userId != null && pinnedSelfUserIds.has(userId)) {
      const prev = cached.members.get(key);
      if (prev) {
        if (prev.isSpeaking) speakingBecameFalse = true;
        cached.members.set(key, {
          ...prev,
          isSpeaking: false,
          isMuted: participant.is_muted_for_all_users ?? prev.isMuted,
          order: prev.order || "0",
        });
      }
    } else {
      if (cached.members.delete(key)) {
        speakingBecameFalse = true;
      }
    }
  } else {
    const isSpeaking = Boolean(
      participant.is_speaking ?? (participant as { isSpeaking?: boolean }).isSpeaking,
    );
    const prev = cached.members.get(key);
    speakingBecameTrue = isSpeaking && !prev?.isSpeaking;
    speakingBecameFalse = Boolean(prev?.isSpeaking && !isSpeaking);
    cached.members.set(key, {
      userId,
      chatId,
      isSpeaking,
      // Speaking implies audible — don't keep a stale muted flag over a live voice.
      isMuted: isSpeaking ? false : Boolean(participant.is_muted_for_all_users),
      order,
    });
  }
  bumpVoiceCallRevision(callId, {
    immediate: speakingBecameTrue || speakingBecameFalse,
  });
}

/**
 * TDLib pushes speaking mostly via updateGroupCall.recent_speakers. Without this,
 * the roster cache only learns speaking on the next HTTP poll — mic icons stay grey.
 *
 * Do NOT clear speaking for members absent from recent_speakers — live
 * updateGroupCallParticipant flags are often ahead of that list, and wiping them
 * made green mics never stick.
 */
export function ingestGroupCallUpdate(update: Record<string, unknown>): void {
  if (update._ !== "updateGroupCall") return;
  const groupCall = update.group_call as GroupCallSnapshot | undefined;
  if (!groupCall || typeof groupCall !== "object") return;
  const callId = Number(groupCall.id);
  if (!Number.isFinite(callId) || callId <= 0) return;

  const speakers = speakersFromGroupCall(groupCall);
  const cached = ensureCallCache(callId, {
    uniqueId: String(groupCall.unique_id ?? ""),
    loadedAll: Boolean(groupCall.loaded_all_participants),
  });
  if (groupCall.unique_id != null) {
    cached.uniqueId = String(groupCall.unique_id);
  }
  const countHint = Number(groupCall.participant_count);
  if (Number.isFinite(countHint) && countHint >= 0) {
    cached.participantCountHint = Math.trunc(countHint);
  }

  let changed = false;
  let speakingBecameTrue = false;
  let speakingBecameFalse = false;

  for (const [key, speaker] of speakers) {
    const prev = cached.members.get(key);
    if (!prev) {
      // recent_speakers is not a join roster — never insert ghosts here.
      continue;
    }
    // Authoritative when the speaker is listed: honor is_speaking true/false.
    const isSpeaking = Boolean(speaker.isSpeaking);
    if (prev.isSpeaking === isSpeaking && !(isSpeaking && prev.isMuted)) continue;
    if (isSpeaking && !prev.isSpeaking) speakingBecameTrue = true;
    if (!isSpeaking && prev.isSpeaking) speakingBecameFalse = true;
    cached.members.set(key, {
      ...prev,
      isSpeaking,
      isMuted: isSpeaking ? false : prev.isMuted,
    });
    changed = true;
  }

  if (!changed) return;
  bumpVoiceCallRevision(callId, { immediate: speakingBecameTrue || speakingBecameFalse });
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

const profileRefreshInFlight = new Set<string>();
/** Cached getMe id for this gateway process (one TDLib account per process). */
let cachedSelfUserId: number | null = null;

async function loadParticipantProfile(
  client: Client,
  userId: number | null,
  chatId: number | null,
  opts?: { includeBio?: boolean },
): Promise<{
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
}> {
  const includeBio = opts?.includeBio !== false;
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

    if (includeBio) {
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
      if (includeBio) {
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
      }
    } catch {
      title = "";
    }
  }

  return { title, description, emoji_status_custom_emoji_id: emojiStatus };
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
    if (cached) {
      const age = Date.now() - cached.at;
      if (age < PROFILE_TTL_MS) {
        return {
          title: cached.title,
          description: cached.description,
          emoji_status_custom_emoji_id: cached.emoji_status_custom_emoji_id,
        };
      }
      // Stale-while-revalidate: never block a presence poll on a mid-call profile
      // stampede (all entries expire together after a long call).
      if (age < PROFILE_STALE_TTL_MS) {
        if (!profileRefreshInFlight.has(key)) {
          profileRefreshInFlight.add(key);
          void loadParticipantProfile(client, userId, chatId, { includeBio: false })
            .then((fresh) => {
              const prev = profileCache.get(key);
              profileCache.set(key, {
                title: fresh.title || prev?.title || "",
                description: prev?.description || fresh.description,
                emoji_status_custom_emoji_id:
                  fresh.emoji_status_custom_emoji_id ?? prev?.emoji_status_custom_emoji_id ?? null,
                at: Date.now(),
              });
            })
            .catch(() => undefined)
            .finally(() => {
              profileRefreshInFlight.delete(key);
            });
        }
        return {
          title: cached.title,
          description: cached.description,
          emoji_status_custom_emoji_id: cached.emoji_status_custom_emoji_id,
        };
      }
    }
  }

  const fresh = await loadParticipantProfile(client, userId, chatId, {
    // Bios are optional UI garnish — fetching getUserFullInfo for every member
    // on a cold roster stampede stalls TDLib and freezes the product UI.
    includeBio: false,
  });
  if (key) {
    profileCache.set(key, { ...fresh, at: Date.now() });
  }
  return fresh;
}

async function resolveSelfUserId(client: Client): Promise<number | null> {
  if (cachedSelfUserId != null) return cachedSelfUserId;
  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    const id = Number(me.id);
    if (Number.isFinite(id) && id > 0) {
      cachedSelfUserId = Math.trunc(id);
      return cachedSelfUserId;
    }
  } catch {
    /* ignore */
  }
  return null;
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
      isSpeaking: Boolean(
        speaker.is_speaking ?? (speaker as { isSpeaking?: boolean }).isSpeaking,
      ),
      // recent_speakers omit mute — speaking implies unmuted; otherwise unknown → unmuted UI.
      isMuted: false,
      order: "",
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
      // OR live updateGroupCallParticipant with getGroupCall.recent_speakers.
      // Preferring only recent_speakers wiped true flags when the snapshot lagged
      // a live speaking update (mic icons never turned green).
      isSpeaking: Boolean(row.isSpeaking) || Boolean(speaker?.isSpeaking),
      isMuted:
        Boolean(row.isSpeaking) || Boolean(speaker?.isSpeaking)
          ? false
          : row.isMuted,
      order: row.order || speaker?.order || "",
    });
  }
  // Do NOT promote recent_speakers into the permanent roster. They are a short
  // speaking preview and often linger after someone leaves — that inflated our
  // participant list above Telegram Desktop.
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
    next.set(
      key,
      prev
        ? {
            ...prev,
            isSpeaking: row.isSpeaking,
            isMuted: row.isMuted,
            order: row.order || prev.order,
          }
        : { ...row },
    );
  }
  return next;
}

/**
 * Reconcile the roster off the request path. The live update listener keeps the
 * cache current between reloads; this only runs a full `loadGroupCallParticipants`
 * pass occasionally so a single poll never blocks on the multi-second load loop.
 */
function scheduleBackgroundRosterReload(
  client: Client,
  callId: number,
  uniqueId: string,
  participantCountHint: number,
  hasHiddenListeners: boolean,
  options?: { force?: boolean },
): void {
  if (bgReloadInFlight.has(callId)) return;
  const last = bgReloadLastAt.get(callId) ?? 0;
  if (!options?.force && Date.now() - last < BG_RELOAD_MIN_INTERVAL_MS) return;
  bgReloadInFlight.add(callId);
  bgReloadLastAt.set(callId, Date.now());
  void (async () => {
    try {
      const { members: loaded, loadedAll } = await loadJoinedParticipants(client, callId);
      if (loaded.size === 0) return;
      const prev = callMembersCache.get(callId);
      // Force / fully-loaded snapshots replace the cache so leavers disappear.
      // Only merge speaking onto a larger prior roster while TDLib is still
      // streaming an incomplete chunk (otherwise ghosts accumulate forever).
      const preferCached =
        !options?.force &&
        !loadedAll &&
        prev != null &&
        (prev.uniqueId === uniqueId || !prev.uniqueId) &&
        prev.members.size > loaded.size &&
        !rosterLooksComplete(loaded.size, participantCountHint, hasHiddenListeners, loadedAll);
      const members = preferCached ? mergeParticipantMaps(prev!.members, loaded) : loaded;
      const nextLoadedAll = loadedAll || Boolean(options?.force) || Boolean(preferCached && prev?.loadedAll);
      callMembersCache.set(callId, {
        uniqueId,
        members,
        loadedAt: Date.now(),
        loadedAll: nextLoadedAll,
        revision: prev?.revision ?? 0,
        participantCountHint:
          Number.isFinite(participantCountHint) && participantCountHint >= 0
            ? Math.trunc(participantCountHint)
            : (prev?.participantCountHint ?? 0),
      });
      bumpVoiceCallRevision(callId);
    } catch (err) {
      logGateway("voice_participants_bg_reload_failed", {
        groupCallId: callId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      bgReloadInFlight.delete(callId);
    }
  })();
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
  // has_hidden_listeners: muted people are omitted from the visible list, so
  // listed will never equal participant_count. Rely on loaded_all / load-loop
  // noGrowth (which sets loadedAll) — never treat a partial recent_speakers
  // merge as complete.
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
        if (prev) {
          map.set(key, {
            ...prev,
            isSpeaking: false,
            isMuted: participant.is_muted_for_all_users ?? prev.isMuted,
            order: prev.order || "0",
          });
        }
      } else {
        map.delete(key);
      }
      return;
    }
    map.set(key, {
      userId,
      chatId,
      isSpeaking: Boolean(participant.is_speaking),
      isMuted: Boolean(participant.is_muted_for_all_users),
      order,
    });
  };

  client.on("update", onUpdate);
  beginVoiceParticipantsQuietLoad(callId);
  try {
    // Keep loading until TDLib says all participants are loaded, but wait long enough
    // after each chunk for updateGroupCallParticipant events to land.
    let noGrowthStreak = 0;
    for (let attempt = 0; attempt < LOAD_MAX_ATTEMPTS; attempt += 1) {
      const sizeBefore = map.size;
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

      noGrowthStreak = map.size > sizeBefore ? 0 : noGrowthStreak + 1;
      // Calls with hidden listeners rarely report loaded_all_participants, so the
      // count never matches the visible roster. Once the visible list stops
      // growing, treat it as fully loaded instead of spending the whole attempt
      // budget (the previous behaviour blocked each reload for seconds).
      if (hasHidden && map.size > 0 && noGrowthStreak >= 2) {
        sawLoadedAll = true;
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
    endVoiceParticipantsQuietLoad(callId);
  }

  return { members: map, loadedAll: sawLoadedAll };
}

/** Telegram Desktop: higher `order` first; speaking floats up; then title. */
function compareVoiceParticipantRows(a: VoiceParticipantRow, b: VoiceParticipantRow): number {
  if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
  const orderA = a.order ?? "";
  const orderB = b.order ?? "";
  if (orderA && orderB && orderA !== orderB) {
    // Lexicographic: bigger order = higher in list.
    return orderA < orderB ? 1 : -1;
  }
  if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/**
 * Full voice/video chat participant list for a chat-bound group call.
 * Requires an existing join (media session) for the complete roster.
 * Falls back to recent_speakers (max ~3) when not joined. Never temp-joins.
 */
export async function fetchChatVoiceParticipants(
  client: Client,
  chatId: number,
  groupCallId?: number | null,
  options?: { forceReload?: boolean },
): Promise<{
  ok: boolean;
  error: string | null;
  participant_count: number;
  participants: VoiceParticipantRow[];
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
  voice_resolve_source: string;
  video_chat?: unknown;
}> {
  const resolved = await resolveBoundGroupCallId(client, chatId, groupCallId);
  const callId = resolved.callId;
  if (callId <= 0) {
    return {
      ok: true,
      error: null,
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_resolve_source: resolved.source,
      video_chat: resolved.videoChatRaw,
    };
  }

  // Single snapshot — no busy-wait. Recent speakers update without being joined.
  const groupCall = (await client.invoke({
    _: "getGroupCall",
    group_call_id: callId,
  })) as GroupCallSnapshot;

  if (!groupCallLooksLive(groupCall)) {
    chatToGroupCallId.delete(Math.trunc(chatId));
    logGateway("voice_participants_inactive", {
      chatId,
      groupCallId: callId,
      isActive: groupCall.is_active === true,
      isJoined: Boolean(groupCall.is_joined),
      participantCount: Number(groupCall.participant_count) || 0,
      resolveSource: resolved.source,
    });
    return {
      ok: true,
      error: null,
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_resolve_source: resolved.source,
      video_chat: resolved.videoChatRaw,
    };
  }

  const speakers = speakersFromGroupCall(groupCall);
  const uniqueId = String(groupCall.unique_id ?? "");
  const isJoined = Boolean(groupCall.is_joined || groupCall.need_rejoin);

  const participantCountHint = Number(groupCall.participant_count);
  const hasHiddenListeners = Boolean(groupCall.has_hidden_listeners);

  let collected = speakers;
  if (isJoined) {
    const cached = callMembersCache.get(callId);
    const stuckOnRecentSpeakers =
      (cached?.members.size ?? 0) <= Math.max(speakers.size, 3) &&
      Number.isFinite(participantCountHint) &&
      participantCountHint > Math.max(speakers.size, 3);
    const countAheadOfRoster =
      Number.isFinite(participantCountHint) &&
      participantCountHint > (cached?.members.size ?? 0) &&
      !hasHiddenListeners;
    const cacheUsable =
      cached != null &&
      (cached.uniqueId === uniqueId || !cached.uniqueId) &&
      cached.members.size > 0;

    if (cacheUsable) {
      // Fast path: serve the live-synced roster immediately (speaking flags come
      // from the fresh getGroupCall snapshot). Reconcile in the background so a
      // slow loadGroupCallParticipants pass never blocks — this was the source of
      // the multi-second freezes where participants stopped updating.
      collected = applySpeakingOverlay(cached!.members, speakers);
      const rosterComplete = rosterLooksComplete(
        cached!.members.size,
        participantCountHint,
        hasHiddenListeners,
        cached!.loadedAll,
      );
      const stale = Date.now() - cached!.loadedAt > RECONCILE_TTL_MS;
      if (
        options?.forceReload ||
        cached!.uniqueId !== uniqueId ||
        countAheadOfRoster ||
        stuckOnRecentSpeakers ||
        (!rosterComplete && !hasHiddenListeners) ||
        (stale && !cached!.loadedAll)
      ) {
        scheduleBackgroundRosterReload(
          client,
          callId,
          uniqueId,
          participantCountHint,
          hasHiddenListeners,
          { force: Boolean(options?.forceReload) },
        );
      }
    } else {
      // Cold start: return recent_speakers immediately and load in the background.
      collected = speakers;
      scheduleBackgroundRosterReload(
        client,
        callId,
        uniqueId,
        participantCountHint,
        hasHiddenListeners,
        { force: Boolean(options?.forceReload) },
      );
    }
  } else {
    // Keep roster warm across brief is_joined flickers so the next poll does not
    // fall into the blocking cold-load path and freeze the UI.
    const cached = callMembersCache.get(callId);
    if (cached && cached.members.size > 0) {
      collected = applySpeakingOverlay(cached.members, speakers);
    }
  }

  const selfUserId = await resolveSelfUserId(client);

  // Listen-only / muted self is often omitted when has_hidden_listeners is set, and
  // updateGroupCallParticipant with empty order can drop us from the live cache.
  // While TDLib reports us as joined, always keep self visible in the roster —
  // including the solo-participant case where recent_speakers is empty.
  if (isJoined && selfUserId != null) {
    pinVoiceParticipantSelfUserId(selfUserId);
    const selfKey = participantKey(selfUserId, null);
    if (selfKey && !collected.has(selfKey)) {
      collected = new Map(collected);
      collected.set(selfKey, {
        userId: selfUserId,
        chatId: null,
        isSpeaking: false,
        isMuted: true,
        order: "\uffff",
      });
    }
    if (selfKey) {
      const cached = callMembersCache.get(callId);
      const selfRow: CollectedParticipant = {
        userId: selfUserId,
        chatId: null,
        isSpeaking: collected.get(selfKey)?.isSpeaking ?? false,
        isMuted: collected.get(selfKey)?.isMuted ?? true,
        order: collected.get(selfKey)?.order || "\uffff",
      };
      if (cached) {
        if (!cached.members.has(selfKey)) {
          cached.members.set(selfKey, selfRow);
        }
      } else {
        callMembersCache.set(callId, {
          uniqueId: uniqueId || "",
          members: new Map([[selfKey, selfRow]]),
          loadedAt: Date.now(),
          loadedAll: false,
          revision: 0,
          participantCountHint: Number.isFinite(participantCountHint)
            ? Math.trunc(participantCountHint)
            : 0,
        });
      }
    }
  } else if (!isJoined && selfUserId != null) {
    pinnedSelfUserIds.delete(selfUserId);
  }

  chatToGroupCallId.set(Math.trunc(chatId), callId);
  {
    const cached = ensureCallCache(callId, { uniqueId });
    if (Number.isFinite(participantCountHint) && participantCountHint >= 0) {
      cached.participantCountHint = Math.trunc(participantCountHint);
    }
  }

  // Only people with a TDLib participant order are actually in the call.
  // Empty-order rows are leave leftovers (or recent_speakers stubs) — drop them
  // except pinned self while we are joined.
  const rosterLoadedAll = Boolean(callMembersCache.get(callId)?.loadedAll);
  const rows = [...collected.values()].filter((row) => {
    if (row.order) return true;
    if (isJoined && selfUserId != null && row.userId === selfUserId) return true;
    return false;
  });
  // Cold / not-joined preview: recent_speakers have no order — keep them until a
  // real load finishes. After loadedAll, never fall back to unordered ghosts.
  const displayRows =
    rows.length > 0 || rosterLoadedAll ? rows : [...collected.values()];
  const profiles = await Promise.all(
    displayRows.map((row) => resolveParticipantProfile(client, row.userId, row.chatId)),
  );

  const participants: VoiceParticipantRow[] = displayRows.map((row, index) => {
    const profile = profiles[index]!;
    return {
      user_id: row.userId,
      chat_id: row.chatId,
      title: profile.title,
      description: profile.description,
      emoji_status_custom_emoji_id: profile.emoji_status_custom_emoji_id,
      is_speaking: row.isSpeaking,
      is_muted: row.isMuted,
      is_self: selfUserId != null && row.userId === selfUserId,
      order: row.order || "",
    };
  });

  participants.sort(compareVoiceParticipantRows);

  // Telegram Desktop uses getGroupCall.participant_count as the authoritative
  // total (includes hidden listeners). Do not inflate it with our listed length.
  const participantCount = Number(groupCall.participant_count);
  const listedCount = participants.length;
  const resolvedCount =
    Number.isFinite(participantCount) && participantCount >= 0
      ? Math.trunc(participantCount)
      : listedCount;
  logGateway("voice_participants_resolved", {
    chatId,
    groupCallId: callId,
    listed: listedCount,
    participantCount: resolvedCount,
    tdlibCount: Number.isFinite(participantCount) ? Math.trunc(participantCount) : null,
    isJoined,
    hasHiddenListeners: Boolean(groupCall.has_hidden_listeners),
    usedCache: isJoined && callMembersCache.has(callId),
    resolveSource: resolved.source,
  });

  return {
    ok: true,
    error: null,
    participant_count: resolvedCount,
    participants,
    has_active_voice_chat: true,
    voice_chat_group_call_id: callId,
    voice_resolve_source: resolved.source,
    video_chat: resolved.videoChatRaw,
  };
}

/** Resolve group call id previously seen for a chat (SSE subscribe). */
export function resolveCachedGroupCallIdForChat(
  chatId: number,
  preferredGroupCallId?: number | null,
): number | null {
  const mapped = chatToGroupCallId.get(Math.trunc(chatId));
  // Prefer the chat→call map from a successful participants fetch over a stale
  // client preferred id (historically `1` from boolean coercion).
  if (mapped != null && mapped > 0) return mapped;
  const preferred = normalizeTelegramGroupCallId(preferredGroupCallId);
  if (preferred != null) return preferred;
  return null;
}

export function getVoiceParticipantsRevision(groupCallId: number): number {
  return callMembersCache.get(Math.trunc(groupCallId))?.revision ?? 0;
}

/**
 * Sync snapshot for SSE — uses profile cache only (no TDLib round-trips).
 * Titles may be empty until a full participants fetch warms profiles.
 */
export function getVoiceParticipantsStreamSnapshot(groupCallId: number): {
  revision: number;
  participant_count: number;
  participants: VoiceParticipantRow[];
} {
  const callId = Math.trunc(groupCallId);
  const cached = callMembersCache.get(callId);
  if (!cached) {
    return { revision: 0, participant_count: 0, participants: [] };
  }
  const selfUserId = cachedSelfUserId;
  const participants: VoiceParticipantRow[] = [...cached.members.values()]
    .filter((row) => {
      if (row.order) return true;
      if (selfUserId != null && row.userId === selfUserId) return true;
      return false;
    })
    .map((row) => {
      const key = participantKey(row.userId, row.chatId);
      const profile = key ? profileCache.get(key) : undefined;
      return {
        user_id: row.userId,
        chat_id: row.chatId,
        title: profile?.title ?? "",
        description: profile?.description ?? "",
        emoji_status_custom_emoji_id: profile?.emoji_status_custom_emoji_id ?? null,
        is_speaking: row.isSpeaking,
        is_muted: row.isMuted,
        is_self: selfUserId != null && row.userId === selfUserId,
        order: row.order || "",
      };
    });
  participants.sort(compareVoiceParticipantRows);
  const hint = cached.participantCountHint;
  return {
    revision: cached.revision,
    participant_count: hint > 0 ? hint : participants.length,
    participants,
  };
}

