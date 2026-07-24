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

export type VoiceParticipantVideoInfo = {
  endpoint_id: string;
  source_groups: Array<{ semantics: string; source_ids: number[] }>;
};

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
  /** Camera video source groups when the participant streams video. */
  video_info?: VoiceParticipantVideoInfo | null;
  /** Screen-share video source groups when the participant presents. */
  screen_sharing_video_info?: VoiceParticipantVideoInfo | null;
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

type TdParticipantVideoInfo = {
  endpoint_id?: string;
  source_groups?: Array<{ semantics?: string; source_ids?: number[] }>;
  is_paused?: boolean;
};

type GroupCallParticipantUpdate = {
  participant_id?: { _?: string; user_id?: number; chat_id?: number };
  is_speaking?: boolean;
  is_muted_for_all_users?: boolean;
  order?: string;
  video_info?: TdParticipantVideoInfo | null;
  screen_sharing_video_info?: TdParticipantVideoInfo | null;
};

type CollectedParticipant = {
  userId: number | null;
  chatId: number | null;
  isSpeaking: boolean;
  isMuted: boolean;
  /** TDLib participant order (lexicographic); empty means left. */
  order: string;
  /** Last time speaking was reported true — short hold vs flapping updates. */
  lastSpokeAt?: number;
  videoInfo?: VoiceParticipantVideoInfo | null;
  screenInfo?: VoiceParticipantVideoInfo | null;
};

/** tdesktop keeps speaking painted ~1s past the last level; keep hold short so
 * green mics clear when people stop (2.5s looked "stuck after load"). */
const SPEAKING_HOLD_MS = 2_400;

function effectiveSpeaking(row: CollectedParticipant, now: number): boolean {
  if (row.isSpeaking) return true;
  return row.lastSpokeAt != null && now - row.lastSpokeAt < SPEAKING_HOLD_MS;
}

function ratchetParticipantCountHint(
  cached: CallParticipantsCache,
  nextHint: number,
): void {
  if (!Number.isFinite(nextHint) || nextHint < 0) return;
  const hint = Math.trunc(nextHint);
  // Soft getGroupCall often under-counts (1) before join. Never shrink the
  // high-water mark until a finished load confirms a smaller size — otherwise
  // recent_speakers stubs are filtered out (logs: listed=1 totalHint=1).
  if (!cached.loadedAll) {
    cached.participantCountHint = Math.max(cached.participantCountHint, hint);
    return;
  }
  if (hint >= cached.members.size) {
    cached.participantCountHint = Math.max(cached.participantCountHint, hint);
    return;
  }
  cached.participantCountHint = hint;
}

/** Sync profile peek — never blocks the request path on getUser. */
function peekParticipantProfile(
  userId: number | null,
  chatId: number | null,
): {
  title: string;
  description: string;
  emoji_status_custom_emoji_id: string | null;
} {
  const key = participantKey(userId, chatId);
  const cached = key ? profileCache.get(key) : undefined;
  return {
    title: cached?.title ?? "",
    description: cached?.description ?? "",
    emoji_status_custom_emoji_id: cached?.emoji_status_custom_emoji_id ?? null,
  };
}

function normalizeVideoInfo(
  raw: TdParticipantVideoInfo | null | undefined,
): VoiceParticipantVideoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const endpoint = typeof raw.endpoint_id === "string" ? raw.endpoint_id.trim() : "";
  const groups = Array.isArray(raw.source_groups) ? raw.source_groups : [];
  const sourceGroups = groups
    .map((group) => {
      const semantics =
        typeof group?.semantics === "string" && group.semantics.trim()
          ? group.semantics.trim()
          : "";
      const sourceIds = Array.isArray(group?.source_ids)
        ? group.source_ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id !== 0)
            .map((id) => Math.trunc(id))
        : [];
      if (!semantics || sourceIds.length === 0) return null;
      return { semantics, source_ids: sourceIds };
    })
    .filter((group): group is { semantics: string; source_ids: number[] } => group != null);
  if (!endpoint && sourceGroups.length === 0) return null;
  return { endpoint_id: endpoint, source_groups: sourceGroups };
}

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
  /**
   * Latest recent_speakers overlay from getGroupCall. Kept separate from
   * `members` (never inserted as roster ghosts) so the SSE snapshot can apply
   * the same speaking overlay + thin-roster stub fallback as the poll path.
   */
  speakers?: Map<string, CollectedParticipant>;
};

const PROFILE_TTL_MS = 30 * 60_000;
/** Serve stale profiles up to this age while a background refresh runs. */
const PROFILE_STALE_TTL_MS = 2 * 60 * 60_000;
/** Empty-title profiles retry after this instead of the full TTL. */
const EMPTY_PROFILE_RETRY_MS = 10_000;
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
  let mediaBecameLive = false;
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
          lastSpokeAt: undefined,
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
    const now = Date.now();
    const isSpeaking = Boolean(
      participant.is_speaking ?? (participant as { isSpeaking?: boolean }).isSpeaking,
    );
    const prev = cached.members.get(key);
    const videoInfo = normalizeVideoInfo(participant.video_info);
    const screenInfo = normalizeVideoInfo(participant.screen_sharing_video_info);
    // Roster/order-sync updates often carry is_speaking=false while the person is
    // mid-sentence (speaking arrived via recent_speakers). Keep a short hold so
    // green mics don't get wiped by every unrelated participant update.
    const lastSpokeAt = isSpeaking ? now : prev?.lastSpokeAt;
    const effPrev = prev != null && effectiveSpeaking(prev, now);
    const effNext =
      isSpeaking || (lastSpokeAt != null && now - lastSpokeAt < SPEAKING_HOLD_MS);
    speakingBecameTrue = effNext && !effPrev;
    speakingBecameFalse = effPrev && !effNext;
    const nextVideo = videoInfo ?? prev?.videoInfo ?? null;
    const nextScreen = screenInfo ?? prev?.screenInfo ?? null;
    // Immediate SSE only when a camera/screencast endpoint newly appears — clears
    // must not flush every mute/order sync (that flooded renegotiation).
    mediaBecameLive =
      (Boolean(nextVideo?.endpoint_id) &&
        (nextVideo?.endpoint_id ?? "") !== (prev?.videoInfo?.endpoint_id ?? "")) ||
      (Boolean(nextScreen?.endpoint_id) &&
        (nextScreen?.endpoint_id ?? "") !== (prev?.screenInfo?.endpoint_id ?? ""));
    cached.members.set(key, {
      userId,
      chatId,
      isSpeaking,
      lastSpokeAt,
      // Mute and speaking are independent indicators (tdesktop parity) — a muted
      // flag must survive a speaking pulse from recent_speakers.
      isMuted:
        participant.is_muted_for_all_users != null
          ? Boolean(participant.is_muted_for_all_users)
          : (prev?.isMuted ?? true),
      order,
      videoInfo: nextVideo,
      screenInfo: nextScreen,
    });
  }
  // Speaking START and new camera/screencast endpoints flush immediately so the
  // dialog can renegotiate for presentation video without waiting on debounce.
  void speakingBecameFalse;
  bumpVoiceCallRevision(callId, {
    immediate: speakingBecameTrue || mediaBecameLive,
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

  const cached = ensureCallCache(callId, {
    uniqueId: String(groupCall.unique_id ?? ""),
    // Never seed loadedAll from soft getGroupCall — TDLib often reports
    // loaded_all_participants=true before any loadGroupCallParticipants pass,
    // which then filters recent_speakers stubs and sticks the UI at listed=1.
    loadedAll: false,
  });
  if (groupCall.unique_id != null) {
    cached.uniqueId = String(groupCall.unique_id);
  }
  const speakers = speakersFromGroupCall(groupCall, cached.speakers);
  const countHint = Number(groupCall.participant_count);
  if (Number.isFinite(countHint) && countHint >= 0) {
    const nextHint = Math.trunc(countHint);
    ratchetParticipantCountHint(cached, nextHint);
  }

  let changed = false;
  let speakingBecameTrue = false;
  let speakingBecameFalse = false;

  const now = Date.now();
  for (const [key, speaker] of speakers) {
    const prev = cached.members.get(key);
    if (!prev) {
      // recent_speakers is not a join roster — never insert ghosts here.
      continue;
    }
    const isSpeaking = Boolean(speaker.isSpeaking);
    // recent_speakers flaps false while people are mid-sentence. Promote true;
    // on false only drop the live flag and let lastSpokeAt hold expire — never
    // refresh lastSpokeAt to `now` (that pinned speakingCount forever / to 0).
    if (isSpeaking) {
      if (!prev.isSpeaking) speakingBecameTrue = true;
      cached.members.set(key, {
        ...prev,
        isSpeaking: true,
        lastSpokeAt: now,
      });
      changed = true;
      continue;
    }
    if (!prev.isSpeaking) continue;
    speakingBecameFalse = true;
    cached.members.set(key, {
      ...prev,
      isSpeaking: false,
      // Keep the prior pulse time so effectiveSpeaking holds ~SPEAKING_HOLD_MS.
      lastSpokeAt: prev.lastSpokeAt ?? now,
    });
    changed = true;
  }

  // Keep the raw speakers overlay for the SSE snapshot. Before joining, TDLib
  // sends no updateGroupCallParticipant, so the members map is often self-only —
  // the stream must fall back to these stubs (like the poll path) or the dialog
  // shows one grey row while the header counts 5.
  const prevSpeakers = cached.speakers;
  let speakersChanged = (prevSpeakers?.size ?? 0) !== speakers.size;
  for (const [key, speaker] of speakers) {
    const prev = prevSpeakers?.get(key);
    const prevEff = prev != null && effectiveSpeaking(prev, now);
    const nextEff = effectiveSpeaking(speaker, now);
    if (!prev || prevEff !== nextEff || Boolean(prev.isSpeaking) !== Boolean(speaker.isSpeaking)) {
      speakersChanged = true;
      // Immediate flush only for a speaker who newly STARTED — updateGroupCall
      // fires several times a second and flushing every flap froze the client.
      if (nextEff && !prevEff) speakingBecameTrue = true;
    }
  }
  cached.speakers = speakers;

  if (!changed && !speakersChanged) return;
  void speakingBecameFalse;
  if (speakingBecameTrue) {
    logGateway("voice_participants_speaking_pulse", {
      groupCallId: callId,
      revision: (callMembersCache.get(callId)?.revision ?? 0) + 1,
    });
  }
  bumpVoiceCallRevision(callId, { immediate: speakingBecameTrue });
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
              const title = fresh.title || prev?.title || "";
              profileCache.set(key, {
                title,
                description: prev?.description || fresh.description,
                emoji_status_custom_emoji_id:
                  fresh.emoji_status_custom_emoji_id ?? prev?.emoji_status_custom_emoji_id ?? null,
                at: title ? Date.now() : Date.now() - PROFILE_TTL_MS + EMPTY_PROFILE_RETRY_MS,
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
    // Empty titles are usually a transient getUser miss right after someone joins
    // (user not yet in the local TDLib cache). Caching "" for the full TTL pinned
    // "?" rows in the dialog for 30 minutes — retry these much sooner.
    const at = fresh.title
      ? Date.now()
      : Date.now() - PROFILE_TTL_MS + EMPTY_PROFILE_RETRY_MS;
    profileCache.set(key, { ...fresh, at });
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

function speakersFromGroupCall(
  groupCall: GroupCallSnapshot,
  prevSpeakers?: Map<string, CollectedParticipant>,
): Map<string, CollectedParticipant> {
  const map = new Map<string, CollectedParticipant>();
  const speakers = Array.isArray(groupCall.recent_speakers) ? groupCall.recent_speakers : [];
  const now = Date.now();
  for (const speaker of speakers) {
    const { userId, chatId } = parseSender(speaker.participant_id);
    const key = participantKey(userId, chatId);
    if (!key) continue;
    const isSpeaking = Boolean(
      speaker.is_speaking ?? (speaker as { isSpeaking?: boolean }).isSpeaking,
    );
    const prev = prevSpeakers?.get(key);
    // Only pulse lastSpokeAt when TDLib says speaking — inventing `now` for every
    // recent_speakers row (is_speaking=false) painted the whole roster green for
    // SPEAKING_HOLD_MS after every soft poll / join load.
    const lastSpokeAt = isSpeaking ? now : prev?.lastSpokeAt;
    map.set(key, {
      userId,
      chatId,
      isSpeaking,
      // Preserve hold across flaps — rebuilding with lastSpokeAt:undefined made
      // every SSE snapshot report speakingCount=0 a tick after someone spoke.
      lastSpokeAt,
      // recent_speakers omit mute — default muted (most members are listeners);
      // a live participant update corrects this. Unmuted-by-default painted every
      // stub with an open mic, unlike Telegram Desktop.
      isMuted: true,
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
  const now = Date.now();
  for (const [key, row] of members) {
    const speaker = speakers.get(key);
    // Live flags only — hold rides lastSpokeAt via effectiveSpeaking().
    const liveSpeaking = Boolean(row.isSpeaking) || Boolean(speaker?.isSpeaking);
    next.set(key, {
      ...row,
      // OR live updateGroupCallParticipant with getGroupCall.recent_speakers.
      // Preferring only recent_speakers wiped true flags when the snapshot lagged
      // a live speaking update (mic icons never turned green).
      isSpeaking: liveSpeaking,
      // Only pulse lastSpokeAt while TDLib still reports speaking. Refreshing
      // `now` whenever a prior hold was active forever-extended green mics.
      lastSpokeAt: liveSpeaking
        ? now
        : (row.lastSpokeAt ?? speaker?.lastSpokeAt),
      // Mute is independent from speaking (tdesktop parity).
      order: row.order || speaker?.order || "",
    });
  }
  // Do NOT promote recent_speakers into the permanent roster. They are a short
  // speaking preview and often linger after someone leaves — that inflated our
  // participant list above Telegram Desktop.
  return next;
}

/** Union recent_speakers stubs into a thin roster for display until a real load. */
function mergeSpeakerStubsForDisplay(
  members: Map<string, CollectedParticipant>,
  speakers: Map<string, CollectedParticipant>,
): Map<string, CollectedParticipant> {
  if (speakers.size === 0) return members;
  const next = new Map(members);
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
    next.set(
      key,
      prev
        ? {
            ...prev,
            isSpeaking: row.isSpeaking,
            // Preserve the speaking hold across partial reloads (chunks report
            // false for everyone and wiped green mics mid-sentence).
            lastSpokeAt: row.isSpeaking
              ? (row.lastSpokeAt ?? Date.now())
              : (prev.lastSpokeAt ?? row.lastSpokeAt),
            isMuted: row.isMuted,
            order: row.order || prev.order,
            videoInfo: row.videoInfo ?? prev.videoInfo ?? null,
            screenInfo: row.screenInfo ?? prev.screenInfo ?? null,
          }
        : { ...row },
    );
  }
  return next;
}

/**
 * Keep live speaking / hold from the process cache when a load map replaces it.
 * `loadGroupCallParticipants` listens only for participant updates; speaking that
 * arrived via `updateGroupCall.recent_speakers` (or concurrent ingest into
 * `callMembersCache.members`) must not be discarded when the bg reload commits.
 */
function preserveSpeakingOnRoster(
  roster: Map<string, CollectedParticipant>,
  priorMembers: Map<string, CollectedParticipant> | undefined,
  speakers: Map<string, CollectedParticipant> | undefined,
): Map<string, CollectedParticipant> {
  if ((!priorMembers || priorMembers.size === 0) && (!speakers || speakers.size === 0)) {
    return roster;
  }
  const next = new Map(roster);
  const now = Date.now();
  for (const [key, row] of next) {
    const prior = priorMembers?.get(key);
    const speaker = speakers?.get(key);
    // Do NOT OR prior.isSpeaking into the permanent flag — that pinned green
    // mics after every force-reload (load says false, prior still true).
    const liveSpeaking =
      Boolean(row.isSpeaking) || Boolean(speaker?.isSpeaking);
    const lastSpokeAt = liveSpeaking
      ? now
      : (row.lastSpokeAt ?? prior?.lastSpokeAt ?? speaker?.lastSpokeAt);
    if (
      liveSpeaking === Boolean(row.isSpeaking) &&
      lastSpokeAt === row.lastSpokeAt
    ) {
      continue;
    }
    next.set(key, {
      ...row,
      isSpeaking: liveSpeaking,
      lastSpokeAt,
    });
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
      const { members: loaded, loadedAll, loadFailed } = await loadJoinedParticipants(
        client,
        callId,
      );
      // Not joined yet — keep whatever the live listener / speakers already have.
      if (loadFailed) return;
      if (loaded.size === 0) return;
      const prev = callMembersCache.get(callId);
      // Prefer a larger previous cache over a thin load when not forcing.
      const preferCached =
        !options?.force &&
        !loadedAll &&
        prev != null &&
        (prev.uniqueId === uniqueId || !prev.uniqueId) &&
        prev.members.size > loaded.size &&
        !rosterLooksComplete(loaded.size, participantCountHint, hasHiddenListeners, loadedAll);
      // Prefer the load map for roster/mute/order, but keep speaking that landed
      // on the live cache (or recent_speakers) while the load was in flight.
      const mergedRoster = preferCached
        ? mergeParticipantMaps(prev!.members, loaded)
        : loaded;
      const members = preserveSpeakingOnRoster(
        mergedRoster,
        prev?.members,
        prev?.speakers,
      );
      const nextLoadedAll = rosterLooksComplete(
        members.size,
        participantCountHint,
        hasHiddenListeners,
        loadedAll,
      );
      callMembersCache.set(callId, {
        uniqueId,
        members,
        loadedAt: Date.now(),
        loadedAll: nextLoadedAll,
        revision: prev?.revision ?? 0,
        // Never shrink the high-water hint on a thin force/bg load — soft
        // getGroupCall under-count (1) used to wipe a larger prior hint.
        participantCountHint: Math.max(
          prev?.participantCountHint ?? 0,
          Number.isFinite(participantCountHint) && participantCountHint >= 0
            ? Math.trunc(participantCountHint)
            : 0,
          members.size,
        ),
        // Must keep recent_speakers — SSE snapshots overlay speaking from here.
        // Dropping it left every mic grey after the first post-join reload.
        speakers: prev?.speakers,
      });
      bumpVoiceCallRevision(callId);
      // Background title warm — do not block the TDLib event loop on the
      // reload critical path (speaking updates starve during sequential getUser).
      void warmMissingProfiles(client, members).then((warmed) => {
        if (warmed > 0) bumpVoiceCallRevision(callId);
      });
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

/**
 * After a successful WebRTC join, TDLib finally allows loadGroupCallParticipants.
 * Kick an immediate force reload so the dialog fills past the self-only stub.
 */
export function scheduleVoiceRosterReloadAfterJoin(
  client: Client,
  callId: number,
): void {
  if (!Number.isFinite(callId) || callId <= 0) return;
  const cached = callMembersCache.get(callId);
  const hint = Math.max(
    cached?.participantCountHint ?? 0,
    cached?.members.size ?? 0,
    cached?.speakers?.size ?? 0,
  );
  scheduleBackgroundRosterReload(
    client,
    callId,
    cached?.uniqueId ?? "",
    hint,
    false,
    { force: true },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll TDLib until join propagates — client force-reload often races joinVideoChat. */
async function waitUntilGroupCallJoinedForLoad(
  client: Client,
  callId: number,
  maxWaitMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as GroupCallSnapshot;
      if (groupCall.is_joined || groupCall.need_rejoin) return true;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  return false;
}

/** Resolve profiles for members with no usable cached title. Returns count warmed. */
async function warmMissingProfiles(
  client: Client,
  members: Map<string, CollectedParticipant>,
): Promise<number> {
  const pending: Array<{ key: string; userId: number | null; chatId: number | null }> =
    [];
  for (const [key, row] of members) {
    const cached = profileCache.get(key);
    if (cached?.title) continue;
    pending.push({ key, userId: row.userId, chatId: row.chatId });
  }
  if (pending.length === 0) return 0;
  let warmed = 0;
  // Sequential with a cap — a parallel getUser stampede stalls TDLib.
  for (const { key, userId, chatId } of pending.slice(0, 25)) {
    try {
      // Bypass resolveParticipantProfile cache — empty titles from a join race
      // must not block a second getUser a few hundred ms later.
      let profile = await loadParticipantProfile(client, userId, chatId, {
        includeBio: false,
      });
      if (!profile.title && userId != null) {
        await sleep(200);
        profile = await loadParticipantProfile(client, userId, chatId, {
          includeBio: false,
        });
      }
      const at = profile.title
        ? Date.now()
        : Date.now() - PROFILE_TTL_MS + EMPTY_PROFILE_RETRY_MS;
      profileCache.set(key, { ...profile, at });
      if (profile.title) warmed += 1;
    } catch {
      /* keep warming the rest */
    }
  }
  return warmed;
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
): Promise<{ members: Map<string, CollectedParticipant>; loadedAll: boolean; loadFailed: boolean }> {
  const map = new Map<string, CollectedParticipant>();
  // Seed from join-time updates already ingested into the process cache.
  const seeded = callMembersCache.get(callId);
  if (seeded) {
    for (const [key, row] of seeded.members) map.set(key, { ...row });
  }
  let sawLoadedAll = Boolean(seeded?.loadedAll);
  let loadFailed = false;

  // TDLib rejects loadGroupCallParticipants until we are joined ("Can't load
  // group call participants"). Skip the invoke and keep the seed so a later
  // post-join force reload can fill the roster.
  try {
    const preflight = (await client.invoke({
      _: "getGroupCall",
      group_call_id: callId,
    })) as GroupCallSnapshot;
    if (!preflight.is_joined && !preflight.need_rejoin) {
      logGateway("voice_participants_load_skipped_not_joined", {
        groupCallId: callId,
        listed: map.size,
        participantCount: Number(preflight.participant_count) || 0,
      });
      return { members: map, loadedAll: false, loadFailed: true };
    }
  } catch (err) {
    logGateway("voice_participants_load_preflight_failed", {
      groupCallId: callId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { members: map, loadedAll: false, loadFailed: true };
  }

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
    const prev = map.get(key);
    const isSpeaking = Boolean(participant.is_speaking);
    const videoInfo = normalizeVideoInfo(participant.video_info);
    const screenInfo = normalizeVideoInfo(participant.screen_sharing_video_info);
    map.set(key, {
      userId,
      chatId,
      isSpeaking,
      lastSpokeAt: isSpeaking ? Date.now() : prev?.lastSpokeAt,
      isMuted: Boolean(participant.is_muted_for_all_users),
      order,
      videoInfo: videoInfo ?? prev?.videoInfo ?? null,
      screenInfo: screenInfo ?? prev?.screenInfo ?? null,
    });
  };

  client.on("update", onUpdate);
  beginVoiceParticipantsQuietLoad(callId);
  try {
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
        loadFailed = true;
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
      if (refreshed.is_active === false) break;
      if (!refreshed.is_joined && !refreshed.need_rejoin) {
        loadFailed = true;
        break;
      }

      const expected = Number(refreshed.participant_count);
      const hasHidden = Boolean(refreshed.has_hidden_listeners);
      const loadedAll = Boolean(refreshed.loaded_all_participants);
      if (loadedAll) sawLoadedAll = true;

      if (rosterLooksComplete(map.size, expected, hasHidden, loadedAll)) {
        break;
      }

      noGrowthStreak = map.size > sizeBefore ? 0 : noGrowthStreak + 1;
      if (hasHidden && map.size > 0 && noGrowthStreak >= 2) {
        // Telegram Web stops on loaded_all / noGrowth with hidden listeners —
        // listed will never equal participant_count. Accept any non-empty visible
        // map after two quiet chunks (including solo self).
        sawLoadedAll = true;
        break;
      }

      if (loadedAll) {
        await sleep(LOAD_FINAL_SETTLE_MS);
        if (rosterLooksComplete(map.size, expected, hasHidden, true)) break;
        continue;
      }
    }
  } finally {
    client.removeListener("update", onUpdate);
    endVoiceParticipantsQuietLoad(callId);
  }

  return { members: map, loadedAll: sawLoadedAll, loadFailed };
}

/** Telegram Desktop: higher `order` first; speaking floats up; then title. */
function compareVoiceParticipantRows(a: VoiceParticipantRow, b: VoiceParticipantRow): number {
  // tdesktop parity: order by TDLib participant order, NOT by speaking — sorting
  // speakers first made row order flap with every voice pulse.
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
  loaded_all_participants: boolean;
  has_hidden_listeners: boolean;
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
      loaded_all_participants: false,
      has_hidden_listeners: false,
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
      loaded_all_participants: false,
      has_hidden_listeners: false,
      video_chat: resolved.videoChatRaw,
    };
  }

  const uniqueId = String(groupCall.unique_id ?? "");
  const isJoined = Boolean(groupCall.is_joined || groupCall.need_rejoin);

  const participantCountHint = Number(groupCall.participant_count);
  const hasHiddenListeners = Boolean(groupCall.has_hidden_listeners);

  // Write the fresh recent_speakers overlay into the shared cache. The SSE
  // snapshot reads only the cache — without this, speaking learned via polling
  // never reached the stream and green mics stayed grey while the dialog was
  // open (SSE snapshots with is_speaking=false overrode poll data).
  // speakersFromGroupCall runs inside ingest so lastSpokeAt hold is preserved.
  ingestGroupCallUpdate({ _: "updateGroupCall", group_call: groupCall });
  const speakers =
    callMembersCache.get(callId)?.speakers ?? speakersFromGroupCall(groupCall);

  // TDLib only allows loadGroupCallParticipants after join. Until then we serve
  // cache + recent_speakers; after join we force a background load.
  let collected = speakers;
  {
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

    // Explicit force after join: await the load so the HTTP response carries the
    // full roster. Scheduling-only left clients stuck on recent_speakers (listed=1
    // while participant_count was 4+) until a later SSE race — often never.
    // If not joined yet, do NOT block TDLib for seconds — return soft roster and
    // let the client retry after webrtcJoined (pre-join waits starved joinVideoChat).
    if (options?.forceReload) {
      const joinedForLoad = isJoined
        ? true
        : await waitUntilGroupCallJoinedForLoad(client, callId);
      if (joinedForLoad) {
      try {
        // Join already schedules scheduleVoiceRosterReloadAfterJoin — wait for
        // that in-flight load instead of starting a second loadGroupCallParticipants
        // pass (double quiet-load starved TDLib and timed out soft polls).
        let reusedJoinReload = false;
        if (bgReloadInFlight.has(callId)) {
          const waitDeadline = Date.now() + 3_000;
          while (bgReloadInFlight.has(callId) && Date.now() < waitDeadline) {
            await sleep(150);
          }
          const after = callMembersCache.get(callId);
          if (after && after.members.size > 1) {
            collected = applySpeakingOverlay(
              after.members,
              after.speakers ?? speakers,
            );
            reusedJoinReload = true;
            logGateway("voice_participants_force_reuse_join_reload", {
              groupCallId: callId,
              listed: after.members.size,
              loadedAll: after.loadedAll,
            });
          }
        }
        if (!reusedJoinReload) {
        let { members: loaded, loadedAll, loadFailed } = await loadJoinedParticipants(
          client,
          callId,
        );
        // First pass can race joinVideoChat — one short retry only.
        // Extra passes stacked with WebRTC and froze the browser UI thread.
        for (let pass = 0; pass < 1; pass += 1) {
          const completeEnough =
            !loadFailed &&
            loaded.size > 0 &&
            (loadedAll ||
              rosterLooksComplete(
                loaded.size,
                participantCountHint,
                hasHiddenListeners,
                loadedAll,
              ));
          if (completeEnough) break;
          await sleep(400);
          const retry = await loadJoinedParticipants(client, callId);
          if (retry.members.size >= loaded.size) {
            loaded = retry.members;
            loadedAll = retry.loadedAll;
            loadFailed = retry.loadFailed;
          } else if (!retry.loadFailed && retry.members.size > 0) {
            loaded = mergeParticipantMaps(loaded, retry.members);
            loadedAll = retry.loadedAll || loadedAll;
            loadFailed = false;
          }
        }
        if (!loadFailed && loaded.size > 0) {
          const prev = callMembersCache.get(callId);
          const members = preserveSpeakingOnRoster(loaded, prev?.members, speakers);
          const nextLoadedAll = rosterLooksComplete(
            members.size,
            participantCountHint,
            hasHiddenListeners,
            loadedAll,
          );
          callMembersCache.set(callId, {
            uniqueId,
            members,
            loadedAt: Date.now(),
            loadedAll: nextLoadedAll,
            revision: prev?.revision ?? 0,
            participantCountHint: Math.max(
              prev?.participantCountHint ?? 0,
              Number.isFinite(participantCountHint) && participantCountHint >= 0
                ? Math.trunc(participantCountHint)
                : 0,
              members.size,
            ),
            speakers: prev?.speakers ?? speakers,
          });
          bumpVoiceCallRevision(callId);
          collected = applySpeakingOverlay(members, speakers);
          void warmMissingProfiles(client, members).then((warmed) => {
            if (warmed > 0) bumpVoiceCallRevision(callId);
          });
        } else if (cacheUsable) {
          collected = applySpeakingOverlay(cached!.members, speakers);
        }
        }
      } catch (err) {
        logGateway("voice_participants_force_reload_failed", {
          groupCallId: callId,
          message: err instanceof Error ? err.message : String(err),
        });
        if (cacheUsable) {
          collected = applySpeakingOverlay(cached!.members, speakers);
        }
      }
      } else {
        logGateway("voice_participants_force_reload_not_joined", {
          groupCallId: callId,
          participantCount: participantCountHint,
        });
        if (cacheUsable) {
          collected = applySpeakingOverlay(cached!.members, speakers);
        }
      }
    } else if (cacheUsable) {
      collected = applySpeakingOverlay(cached!.members, speakers);
      // Pinning self alone used to hide recent_speakers (empty order filtered
      // out once any ordered row existed). Union stubs while the roster is thin.
      if (
        !cached!.loadedAll &&
        (speakers.size > 0 ||
          (Number.isFinite(participantCountHint) &&
            participantCountHint > collected.size))
      ) {
        collected = mergeSpeakerStubsForDisplay(collected, speakers);
      }
      const rosterComplete = rosterLooksComplete(
        cached!.members.size,
        participantCountHint,
        hasHiddenListeners,
        cached!.loadedAll,
      );
      const stale = Date.now() - cached!.loadedAt > RECONCILE_TTL_MS;
      // Force reload once we are joined and still short — TDLib rejected loads
      // before join, so the 20s throttle would otherwise leave listed=1 forever.
      const forceAfterJoin = isJoined && countAheadOfRoster;
      if (
        forceAfterJoin ||
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
          { force: forceAfterJoin },
        );
      }
    } else {
      collected = speakers;
      if (isJoined) {
        scheduleBackgroundRosterReload(
          client,
          callId,
          uniqueId,
          participantCountHint,
          hasHiddenListeners,
          { force: true },
        );
      }
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
    ratchetParticipantCountHint(cached, participantCountHint);
  }

  // Always union recent_speakers into the painted roster — they are live people
  // even after loaded_all (which can arrive with a thin self-only map when
  // has_hidden_listeners trips early). Filtering stubs left dialog rows empty.
  const rosterLoadedAll = Boolean(callMembersCache.get(callId)?.loadedAll);
  const hintForDisplay = Math.max(
    callMembersCache.get(callId)?.participantCountHint ?? 0,
    Number.isFinite(participantCountHint) ? Math.trunc(participantCountHint) : 0,
    collected.size,
  );
  if (speakers.size > 0) {
    collected = mergeSpeakerStubsForDisplay(collected, speakers);
  }
  const orderedRows = [...collected.values()].filter((row) => {
    if (row.order) return true;
    if (isJoined && selfUserId != null && row.userId === selfUserId) return true;
    const key = participantKey(row.userId, row.chatId);
    // Keep speaker stubs visible — never drop them once loaded_all flips early.
    return !rosterLoadedAll || (key != null && speakers.has(key));
  });
  const displayRows =
    orderedRows.length > 0 || rosterLoadedAll
      ? orderedRows
      : [...collected.values()];
  // Never await getUser on the HTTP path — that serialized behind history/chat
  // loads and timed out soft polls (message-voice-participants timeout).
  const participants: VoiceParticipantRow[] = displayRows.map((row) => {
    const profile = peekParticipantProfile(row.userId, row.chatId);
    return {
      user_id: row.userId,
      chat_id: row.chatId,
      title: profile.title,
      description: profile.description,
      emoji_status_custom_emoji_id: profile.emoji_status_custom_emoji_id,
      is_speaking: effectiveSpeaking(row, Date.now()),
      is_muted: row.isMuted,
      is_self: selfUserId != null && row.userId === selfUserId,
      order: row.order || "",
      video_info: row.videoInfo ?? null,
      screen_sharing_video_info: row.screenInfo ?? null,
    };
  });

  participants.sort(compareVoiceParticipantRows);

  void warmMissingProfiles(
    client,
    new Map(
      displayRows
        .map((row) => {
          const key = participantKey(row.userId, row.chatId);
          return key ? ([key, row] as const) : null;
        })
        .filter((entry): entry is readonly [string, CollectedParticipant] => entry != null),
    ),
  ).then((warmed) => {
    if (warmed > 0) bumpVoiceCallRevision(callId);
  });

  // Prefer high-water hint over a soft under-count so the UI header matches
  // Telegram Desktop ("N participants") before the full load lands.
  const participantCount = Number(groupCall.participant_count);
  const listedCount = participants.length;
  const tdlibCount =
    Number.isFinite(participantCount) && participantCount >= 0
      ? Math.trunc(participantCount)
      : 0;
  const resolvedCount = Math.max(tdlibCount, hintForDisplay, listedCount);
  logGateway("voice_participants_resolved", {
    chatId,
    groupCallId: callId,
    listed: listedCount,
    participantCount: resolvedCount,
    tdlibCount: tdlibCount > 0 ? tdlibCount : null,
    hint: hintForDisplay,
    isJoined,
    hasHiddenListeners: Boolean(groupCall.has_hidden_listeners),
    usedCache: callMembersCache.has(callId),
    resolveSource: resolved.source,
  });

  const cachedAfter = callMembersCache.get(callId);
  return {
    ok: true,
    error: null,
    participant_count: resolvedCount,
    participants,
    has_active_voice_chat: true,
    voice_chat_group_call_id: callId,
    voice_resolve_source: resolved.source,
    // Client must stop force-reload when the visible roster is done — listed
    // will never equal participant_count while has_hidden_listeners is set.
    loaded_all_participants: Boolean(cachedAfter?.loadedAll),
    has_hidden_listeners: hasHiddenListeners,
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
  const nowMs = Date.now();
  // Mirror the poll path: overlay recent_speakers onto the live roster, and
  // union speaker stubs whenever the painted map is thin — chat-preview strip
  // relies on these faces when loadGroupCallParticipants is not allowed yet.
  let collected = cached.members;
  if (cached.speakers && cached.speakers.size > 0) {
    collected = applySpeakingOverlay(cached.members, cached.speakers);
    const hintGap =
      cached.participantCountHint > collected.size ||
      cached.members.size === 0 ||
      !cached.loadedAll;
    if (hintGap) {
      collected = mergeSpeakerStubsForDisplay(collected, cached.speakers);
    }
  }
  const orderedRows = [...collected.values()].filter((row) => {
    if (row.order) return true;
    if (selfUserId != null && row.userId === selfUserId) return true;
    const key = participantKey(row.userId, row.chatId);
    // Keep recent_speakers stubs visible after loadedAll — otherwise SSE drops
    // every face without an order string and the strip paints empty.
    if (key != null && cached.speakers?.has(key)) return true;
    return !cached.loadedAll;
  });
  const displayRows =
    orderedRows.length > 0 || cached.loadedAll
      ? orderedRows
      : [...collected.values()];
  const participants: VoiceParticipantRow[] = displayRows
    .map((row) => {
      const key = participantKey(row.userId, row.chatId);
      const profile = key ? profileCache.get(key) : undefined;
      return {
        user_id: row.userId,
        chat_id: row.chatId,
        title: profile?.title ?? "",
        description: profile?.description ?? "",
        emoji_status_custom_emoji_id: profile?.emoji_status_custom_emoji_id ?? null,
        is_speaking: effectiveSpeaking(row, nowMs),
        is_muted: row.isMuted,
        is_self: selfUserId != null && row.userId === selfUserId,
        order: row.order || "",
        video_info: row.videoInfo ?? null,
        screen_sharing_video_info: row.screenInfo ?? null,
      };
    });
  participants.sort(compareVoiceParticipantRows);
  const hint = Math.max(cached.participantCountHint, participants.length);
  return {
    revision: cached.revision,
    participant_count: hint > 0 ? hint : participants.length,
    participants,
  };
}

