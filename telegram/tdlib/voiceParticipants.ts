import type { Client } from "tdl";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { logGateway } from "./gatewayLog.js";
import type { TdChat, TdMessage } from "./chatPreview.js";
import { formattedTextPlain, readTdVideoChat, voiceChatFromTdChat } from "./chatPreview.js";
import { emojiStatusCustomIdFromChat, emojiStatusCustomIdFromUser } from "./emojiStatus.js";
import { getLiveChatSelfUserId, setLiveChatSelfUserId } from "./liveChatCache.js";
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
  /**
   * TDLib `can_unmute_self`. When muted + true, they turned their own mic off
   * (secondary chrome). When muted + false, admin-muted (red chrome).
   */
  can_unmute_self: boolean;
  is_self: boolean;
  /** Local listen volume 0–200% (TDLib volume_level / 100; default 100%). */
  volume_percent?: number;
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

/** True when getGroupCall reports a call the UI should treat as live. */
export function groupCallLooksLive(groupCall: GroupCallSnapshot | null | undefined): boolean {
  if (!groupCall || typeof groupCall !== "object") return false;
  const speakers = Array.isArray(groupCall.recent_speakers)
    ? groupCall.recent_speakers
    : [];
  const count = Number(groupCall.participant_count);
  const hasPeople =
    speakers.length > 0 || (Number.isFinite(count) && count > 0);
  // Sticky TDLib is_joined / need_rejoin after a crashed leave must NOT paint
  // rings by itself when the call is empty (green "joined" avatar with nobody
  // there). Real joins always have participant_count ≥ 1 or recent_speakers.
  if (groupCall.is_joined || groupCall.need_rejoin) {
    return hasPeople;
  }
  if (groupCall.is_active !== true) return false;
  // has_hidden_listeners alone is not enough — TDLib can leave it set on empty
  // leftover calls while participant_count stays 0.
  return hasPeople;
}

/**
 * Chat-list / strip paint gate. Telegram Desktop uses `video_chat.has_participants`
 * for the avatar ring — stale getGroupCall participant_count can stay >0 after
 * the call ends while has_participants flips false (prod: rings + voice preview
 * on chats with no live call).
 */
export function groupCallLooksLiveForChat(
  groupCall: GroupCallSnapshot | null | undefined,
  chatHasParticipants: boolean | null | undefined,
): boolean {
  if (!groupCallLooksLive(groupCall)) return false;
  // Explicit false from getChat / updateChatVideoChat wins over stale getGroupCall.
  if (chatHasParticipants === false) return false;
  return true;
}

/** Verify a chat-bound group call id before painting list rings / voice strip. */
export async function verifyGroupCallLiveState(
  client: Client,
  groupCallId: number | null | undefined,
  options?: { chatId?: number | null; chatHasParticipants?: boolean | null },
): Promise<{ live: boolean; isJoined: boolean }> {
  const callId = normalizeTelegramGroupCallId(groupCallId) ?? 0;
  if (callId <= 0) return { live: false, isJoined: false };
  let chatHasParticipants =
    options?.chatHasParticipants === undefined
      ? null
      : options.chatHasParticipants;
  const chatId = options?.chatId;
  if (
    chatHasParticipants == null &&
    chatId != null &&
    Number.isFinite(chatId) &&
    chatId !== 0
  ) {
    try {
      const chat = (await client.invoke({
        _: "getChat",
        chat_id: chatId,
      })) as TdChat;
      chatHasParticipants = readTdVideoChat(chat).has_participants;
    } catch {
      /* keep null — fall through to getGroupCall only */
    }
  }
  try {
    const groupCall = (await client.invoke({
      _: "getGroupCall",
      group_call_id: callId,
    })) as GroupCallSnapshot;
    const live = groupCallLooksLiveForChat(groupCall, chatHasParticipants);
    return {
      live,
      isJoined: live && Boolean(groupCall.is_joined || groupCall.need_rejoin),
    };
  } catch {
    return { live: false, isJoined: false };
  }
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
  // Desktop hides the ring when has_participants is false — do not resurrect
  // live paint from a stale getGroupCall / history probe on an empty shell.
  const chatHasParticipants = video.has_participants;
  if (fromChat > 0) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: fromChat,
      })) as GroupCallSnapshot;
      if (groupCallLooksLiveForChat(groupCall, chatHasParticipants)) {
        return {
          callId: fromChat,
          source: "get_chat",
          videoChatRaw: video.raw,
          voice: {
            has_active_voice_chat: true,
            voice_chat_group_call_id: fromChat,
          },
        };
      }
      // Chat still advertises this call id, but getGroupCall says it is empty/dead.
      // Clear the sticky map and fall through to preferred/history — returning
      // none here blocked a live preferred id when chat metadata lagged
      // (client logs: stream groupCallId=5 then reconnects as 1).
      chatToGroupCallId.delete(Math.trunc(chatId));
      logGateway("voice_call_id_inactive_on_chat", {
        chatId,
        groupCallId: fromChat,
        isActive: groupCall.is_active === true,
        isJoined: Boolean(groupCall.is_joined),
        participantCount: Number(groupCall.participant_count) || 0,
        hasHiddenListeners: Boolean(groupCall.has_hidden_listeners),
        chatHasParticipants,
      });
    } catch {
      /* treat as inactive and continue */
    }
  }

  // Empty leftover shell: keep bound id for Start, never paint live / probe history.
  if (fromChat > 0 && chatHasParticipants === false) {
    return {
      callId: fromChat,
      source: "get_chat",
      videoChatRaw: video.raw,
      voice: {
        has_active_voice_chat: false,
        voice_chat_group_call_id: fromChat,
      },
    };
  }

  const preferred = normalizeTelegramGroupCallId(preferredGroupCallId) ?? 0;
  if (preferred > 0 && preferred !== fromChat) {
    try {
      const groupCall = (await client.invoke({
        _: "getGroupCall",
        group_call_id: preferred,
      })) as GroupCallSnapshot;
      // Preferred ids from the client are often stale after switching chats —
      // require real presence, not bare is_active on an empty leftover call.
      if (groupCallLooksLiveForChat(groupCall, chatHasParticipants)) {
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
            // History recovery must see real presence — bare is_active on empty
            // leftovers otherwise reopens rings / Join after the call ended.
            if (groupCallLooksLiveForChat(groupCall, chatHasParticipants)) {
              logGateway("voice_call_id_recovered_from_history", {
                chatId,
                groupCallId: startedId,
                participantCount: Number(groupCall.participant_count) || 0,
                isActive: true,
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
  // Keep a bound but empty call id so Start voice can target it; never paint live.
  return {
    callId: fromChat > 0 ? fromChat : 0,
    source: fromChat > 0 ? "get_chat" : "none",
    videoChatRaw: video.raw,
    voice: {
      has_active_voice_chat: false,
      voice_chat_group_call_id: fromChat > 0 ? fromChat : null,
    },
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
  /** Some tdl builds expose camelCase. */
  isMutedForAllUsers?: boolean;
  is_hand_raised?: boolean;
  isHandRaised?: boolean;
  can_unmute_self?: boolean;
  canUnmuteSelf?: boolean;
  /** TDLib 1–20000 (10000 = 100%). */
  volume_level?: number;
  order?: string;
  video_info?: TdParticipantVideoInfo | null;
  screen_sharing_video_info?: TdParticipantVideoInfo | null;
};

/** True/false when TDLib sent a mute flag; null when omitted (do not invent). */
function readMutedForAllUsers(
  participant: GroupCallParticipantUpdate,
): boolean | null {
  const raw =
    participant.is_muted_for_all_users ?? participant.isMutedForAllUsers;
  if (raw == null) return null;
  return Boolean(raw);
}

function readHandRaised(participant: GroupCallParticipantUpdate): boolean {
  return Boolean(participant.is_hand_raised ?? participant.isHandRaised);
}

/** Null when omitted — keep prior; default true for self-mute chrome when unknown. */
function readCanUnmuteSelf(
  participant: GroupCallParticipantUpdate,
): boolean | null {
  const raw = participant.can_unmute_self ?? participant.canUnmuteSelf;
  if (raw == null) return null;
  return Boolean(raw);
}

/**
 * Chrome mute for the painted roster. Trust TDLib's mute flag only — green ring
 * is `is_speaking` / effectiveSpeaking, never conflated with mic on/off.
 * Clearing mute while speaking left muted faces looking unmuted after a pulse.
 */
function resolvePaintedMuted(input: {
  muted: boolean;
  isSpeaking: boolean;
  isHandRaised: boolean;
  hasHiddenListeners: boolean;
  isPinnedSelf: boolean;
}): boolean {
  void input.isHandRaised;
  void input.hasHiddenListeners;
  void input.isPinnedSelf;
  // Live speaking only (not hold) — tdesktop shows an open green mic on the
  // speaking face. Do not sticky-write unmuted into the store; paint only.
  if (input.isSpeaking) return false;
  return Boolean(input.muted);
}

type CollectedParticipant = {
  userId: number | null;
  chatId: number | null;
  isSpeaking: boolean;
  isMuted: boolean;
  isHandRaised?: boolean;
  /** True when they can unmute themselves (self-off vs admin mute). Default true. */
  canUnmuteSelf?: boolean;
  /** TDLib volume_level 1–20000; default 10000. */
  volumeLevel: number;
  /** TDLib participant order (lexicographic); empty means left. */
  order: string;
  /** Last time speaking was reported true — short hold vs flapping updates. */
  lastSpokeAt?: number;
  videoInfo?: VoiceParticipantVideoInfo | null;
  screenInfo?: VoiceParticipantVideoInfo | null;
};

function normalizeVolumeLevel(raw: unknown, fallback = 10000): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  // TDLib range is 1–20000 (10000 = 100%). 0 / negative means unset — never
  // coerce to 1, or volumeLevelToPercent maps everyone to 0% and the WebRTC
  // mix GainNode mutes the whole call while the analyser still sees speech.
  if (n < 1) return fallback;
  return Math.min(20000, Math.max(1, Math.trunc(n)));
}

function volumeLevelToPercent(level: number): number {
  if (!Number.isFinite(level) || level < 1) return 100;
  // level 1 ≈ 0% (Telegram min / muted-for-me); 10000 = 100%.
  return Math.min(200, Math.max(0, Math.round(level / 100)));
}

/** tdesktop keeps speaking painted ~1s past the last level. After join TDLib
 * often stops pulsing is_speaking while audio continues — hold long enough for
 * the next pulse / client mix-RMS extend of recent speakers; still clears when
 * silence outlasts the hold. */
const SPEAKING_HOLD_MS = 8_000;
/** Block recent_speakers / soft-load from re-inserting someone who just left. */
const LEAVE_TOMBSTONE_MS = 60_000;

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
  const listed = cached.members.size;
  const prev = cached.participantCountHint;
  // Soft getGroupCall often flashes participant_count=0/1 before the real
  // total. Ignore that collapse. Otherwise follow live TDLib up and down so a
  // leftover high-water (7) cannot stick after the call drops to 6.
  if (hint <= 1 && prev > hint) {
    cached.participantCountHint = Math.max(prev, listed);
    return;
  }
  if (!cached.loadedAll) {
    if (hint >= 2) {
      cached.participantCountHint = Math.max(hint, listed);
      return;
    }
    cached.participantCountHint = Math.max(prev, hint, listed);
    return;
  }
  if (hint >= listed) {
    cached.participantCountHint = Math.max(hint, listed);
    return;
  }
  cached.participantCountHint = hint;
}

/** Strip / SSE headline: live TDLib count, with a soft-undercount floor. */
function resolveDisplayParticipantCount(
  liveTdlib: number,
  stickyHint: number,
  listed: number,
): number {
  const live =
    Number.isFinite(liveTdlib) && liveTdlib >= 0 ? Math.trunc(liveTdlib) : 0;
  const sticky =
    Number.isFinite(stickyHint) && stickyHint >= 0 ? Math.trunc(stickyHint) : 0;
  const painted = Math.max(0, Math.trunc(listed));
  // Soft polls can flash 0/1 while recent_speakers are still loading — keep the
  // prior floor then. Once TDLib reports a real total (2+), trust it alone so
  // untitled speaker stubs cannot inflate "3 participants" → "4" / "5".
  if (live <= 1 && sticky > live) {
    return Math.max(sticky, painted);
  }
  if (live > 0) return live;
  return Math.max(sticky, painted);
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

/** Cached roster title for in-call message overlays (empty until profiles warm). */
export function peekVoiceParticipantTitle(
  userId: number | null,
  chatId: number | null,
): string {
  return peekParticipantProfile(userId, chatId).title;
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
  /** TDLib getMe for the client that last fetched/joined this call cache. */
  selfUserId?: number | null;
  /**
   * Per TDLib account join flags (userId → joined). A single process-global
   * boolean mixed multi-tenant gateways: Сева's is_joined flipped Vsevolod's
   * spectator SSE (and the reverse), so You / screencast titles swapped.
   */
  selfJoinedByUserId?: Map<number, boolean>;
  /** From getGroupCall / updateGroupCall — muted listeners omitted from the list. */
  hasHiddenListeners?: boolean;
  /**
   * Latest recent_speakers overlay from getGroupCall. Kept separate from
   * `members` (never inserted as roster ghosts) so the SSE snapshot can apply
   * the same speaking overlay + thin-roster stub fallback as the poll path.
   */
  speakers?: Map<string, CollectedParticipant>;
  /**
   * participantKey → left-at ms. Empty-order leave sets this so TDLib's lingering
   * recent_speakers / partial loads cannot re-paint ghosts (пэшка after exit).
   * Cleared when the same key rejoins with a non-empty order.
   */
  leftAt?: Map<string, number>;
  /** Throttle SSE refresh while is_speaking stays true (long utterances). */
  lastSpeakingRefreshAt?: number;
};

function pruneLeaveTombstones(cached: CallParticipantsCache, now = Date.now()): void {
  const leftAt = cached.leftAt;
  if (!leftAt || leftAt.size === 0) return;
  for (const [key, at] of leftAt) {
    if (now - at >= LEAVE_TOMBSTONE_MS) leftAt.delete(key);
  }
}

function isLeaveTombstoned(
  cached: CallParticipantsCache,
  key: string,
  now = Date.now(),
): boolean {
  pruneLeaveTombstones(cached, now);
  const at = cached.leftAt?.get(key);
  return at != null && now - at < LEAVE_TOMBSTONE_MS;
}

function markLeaveTombstone(cached: CallParticipantsCache, key: string): void {
  if (!cached.leftAt) cached.leftAt = new Map();
  cached.leftAt.set(key, Date.now());
}

function clearLeaveTombstone(cached: CallParticipantsCache, key: string): void {
  cached.leftAt?.delete(key);
}

/** Drop leave-tombstoned faces unless they rejoined with a non-empty order. */
function stripLeaveTombstones(
  members: Map<string, CollectedParticipant>,
  cached: CallParticipantsCache | undefined,
): Map<string, CollectedParticipant> {
  if (!cached?.leftAt?.size) return members;
  const now = Date.now();
  let changed = false;
  const next = new Map(members);
  for (const [key, row] of next) {
    if (!isLeaveTombstoned(cached, key, now)) continue;
    if (row.order) {
      clearLeaveTombstone(cached, key);
      continue;
    }
    next.delete(key);
    changed = true;
  }
  return changed ? next : members;
}

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
      selfUserId: seed?.selfUserId ?? null,
      selfJoinedByUserId: seed?.selfJoinedByUserId,
    };
    callMembersCache.set(callId, cached);
  }
  return cached;
}

function isAccountJoined(
  cached: CallParticipantsCache,
  selfUserId: number | null | undefined,
): boolean {
  if (selfUserId == null || selfUserId <= 0) return false;
  return cached.selfJoinedByUserId?.get(Math.trunc(selfUserId)) === true;
}

/** Returns true when the joined flag actually changed. */
function setAccountJoined(
  cached: CallParticipantsCache,
  selfUserId: number | null | undefined,
  joined: boolean,
): boolean {
  if (selfUserId == null || selfUserId <= 0) return false;
  const id = Math.trunc(selfUserId);
  if (!cached.selfJoinedByUserId) cached.selfJoinedByUserId = new Map();
  const prev = cached.selfJoinedByUserId.get(id) === true;
  if (prev === joined) return false;
  if (joined) cached.selfJoinedByUserId.set(id, true);
  else cached.selfJoinedByUserId.delete(id);
  return true;
}

/** Synthetic listen-only self row while joined (hidden listeners / solo muted). */
function isListenOnlySelfInject(
  row: CollectedParticipant,
  selfUserId: number | null | undefined,
): boolean {
  return (
    row.order === "\uffff" &&
    selfUserId != null &&
    selfUserId > 0 &&
    row.userId === selfUserId
  );
}

/**
 * Drop listen-only self injects from a member map (and optionally the call cache)
 * when the account is not joined — leftover injects painted "You" for spectators.
 */
function stripListenOnlySelfInjects(
  members: Map<string, CollectedParticipant>,
  selfUserId: number | null | undefined,
  cached?: CallParticipantsCache,
): Map<string, CollectedParticipant> {
  if (selfUserId == null || selfUserId <= 0) return members;
  let changed = false;
  const next = new Map(members);
  for (const [key, row] of next) {
    if (!isListenOnlySelfInject(row, selfUserId)) continue;
    next.delete(key);
    cached?.members.delete(key);
    cached?.speakers?.delete(key);
    if (cached) markLeaveTombstone(cached, key);
    changed = true;
  }
  return changed ? next : members;
}

/**
 * Shared call caches outlive a single TDLib account. When getMe flips (multi-tenant
 * gateway: Сева then Vsevolod), drop the previous account from the cache unless
 * they are still present in this client's live TDLib roster.
 */
function adoptCallSelfUserId(
  cached: CallParticipantsCache,
  selfUserId: number | null,
  liveMembers?: Map<string, CollectedParticipant>,
): boolean {
  if (selfUserId == null || selfUserId <= 0) return false;
  const nextId = Math.trunc(selfUserId);
  const prevId =
    cached.selfUserId != null && cached.selfUserId > 0
      ? Math.trunc(cached.selfUserId)
      : null;
  cached.selfUserId = nextId;
  if (prevId == null || prevId === nextId) return false;
  let removed = false;
  for (const [key, row] of [...cached.members.entries()]) {
    if (row.userId !== prevId) continue;
    if (liveMembers?.has(key)) continue;
    cached.members.delete(key);
    cached.speakers?.delete(key);
    markLeaveTombstone(cached, key);
    removed = true;
  }
  return removed;
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
  let mediaCleared = false;
  let speakingRefresh = false;
  let memberLeft = false;
  if (!order) {
    // Empty order means left per TDLib. Muted self can also get empty order while
    // still joined — keep this call's self. Everyone else must drop immediately or
    // the roster grows past Telegram Desktop's participant list.
    if (
      userId != null &&
      isAccountJoined(cached, userId)
    ) {
      const prev = cached.members.get(key);
      if (prev) {
        if (prev.isSpeaking) speakingBecameFalse = true;
        const isHandRaised = readHandRaised(participant);
        const mutedRaw =
          readMutedForAllUsers(participant) ?? prev.isMuted;
        const canUnmuteSelf =
          readCanUnmuteSelf(participant) ?? prev.canUnmuteSelf ?? true;
        cached.members.set(key, {
          ...prev,
          isSpeaking: false,
          lastSpokeAt: undefined,
          isHandRaised,
          canUnmuteSelf,
          isMuted: mutedRaw,
          volumeLevel:
            participant.volume_level != null
              ? normalizeVolumeLevel(participant.volume_level, prev.volumeLevel)
              : prev.volumeLevel,
          order: prev.order || "0",
        });
      }
    } else {
      if (cached.members.delete(key)) {
        speakingBecameFalse = true;
        memberLeft = true;
      }
      // recent_speakers often still lists leavers for a while. Drop the stub or
      // mergeSpeakerStubsForDisplay re-paints them after empty-order leave.
      if (cached.speakers?.delete(key)) {
        memberLeft = true;
      }
      markLeaveTombstone(cached, key);
    }
  } else {
    const now = Date.now();
    clearLeaveTombstone(cached, key);
    const isSpeaking = Boolean(
      participant.is_speaking ?? (participant as { isSpeaking?: boolean }).isSpeaking,
    );
    const prev = cached.members.get(key);
    const videoInfo = normalizeVideoInfo(participant.video_info);
    const screenInfo = normalizeVideoInfo(participant.screen_sharing_video_info);
    // Missing mute field: keep prior. Brand-new without prior → muted — default
    // unmuted invented open-mic chrome on soft ingest (vs Telegram Desktop).
    const mutedFromTdlib =
      readMutedForAllUsers(participant) ?? (prev?.isMuted ?? true);
    const isHandRaised = readHandRaised(participant);
    const canUnmuteSelf =
      readCanUnmuteSelf(participant) ?? prev?.canUnmuteSelf ?? true;
    const isPinnedSelf =
      userId != null && cached.selfUserId != null && userId === cached.selfUserId;
    void isPinnedSelf;
    const volumeLevel =
      participant.volume_level != null
        ? normalizeVolumeLevel(participant.volume_level, prev?.volumeLevel ?? 10000)
        : (prev?.volumeLevel ?? 10000);
    // Muting clears the speaking hold immediately — otherwise SPEAKING_HOLD_MS
    // kept green/open-mic chrome after everyone turned their mics off.
    const lastSpokeAt = isSpeaking
      ? now
      : mutedFromTdlib
        ? undefined
        : prev?.lastSpokeAt;
    const effPrev = prev != null && effectiveSpeaking(prev, now);
    const effNext =
      isSpeaking || (lastSpokeAt != null && now - lastSpokeAt < SPEAKING_HOLD_MS);
    speakingBecameTrue = effNext && !effPrev;
    speakingBecameFalse = effPrev && !effNext;
    // Trust TDLib nulls — sticky keep made stopped shares keep a green icon and
    // inflated self as a publisher so remote screencasts never requested.
    const nextVideo = videoInfo;
    const nextScreen = screenInfo;
    // Immediate SSE when a camera/screencast endpoint newly appears OR clears.
    mediaBecameLive =
      (Boolean(nextVideo?.endpoint_id) &&
        (nextVideo?.endpoint_id ?? "") !== (prev?.videoInfo?.endpoint_id ?? "")) ||
      (Boolean(nextScreen?.endpoint_id) &&
        (nextScreen?.endpoint_id ?? "") !== (prev?.screenInfo?.endpoint_id ?? ""));
    mediaCleared =
      (Boolean(prev?.videoInfo?.endpoint_id) && !nextVideo?.endpoint_id) ||
      (Boolean(prev?.screenInfo?.endpoint_id) && !nextScreen?.endpoint_id);
    cached.members.set(key, {
      userId,
      chatId,
      isSpeaking,
      lastSpokeAt,
      isHandRaised,
      canUnmuteSelf,
      // Store TDLib mute only — speaking opens mic chrome at serialize via
      // resolvePaintedMuted. Writing painted unmuted here sticky-opened faces.
      isMuted: mutedFromTdlib,
      volumeLevel,
      order,
      videoInfo: nextVideo,
      screenInfo: nextScreen,
    });
    if (isSpeaking) {
      const lastRefresh = cached.lastSpeakingRefreshAt ?? 0;
      if (now - lastRefresh >= 900) {
        cached.lastSpeakingRefreshAt = now;
        speakingRefresh = true;
      }
    }
  }
  // Speaking START, leave, and camera/screencast appear/clear flush immediately
  // so the dialog drops ghosts / renegotiates without waiting on debounce.
  void speakingBecameFalse;
  bumpVoiceCallRevision(callId, {
    immediate:
      speakingBecameTrue ||
      memberLeft ||
      mediaBecameLive ||
      mediaCleared ||
      speakingRefresh,
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
export function ingestGroupCallUpdate(
  update: Record<string, unknown>,
  options?: { telegramUsername?: string; selfUserId?: number | null },
): void {
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
  if (groupCall.has_hidden_listeners != null) {
    cached.hasHiddenListeners = Boolean(groupCall.has_hidden_listeners);
  }
  // Resolve which TDLib account this update belongs to — never use a shared
  // process-global joined flag (that swapped Сева ↔ Vsevolod self/screencast).
  const actorSelfId =
    options?.selfUserId != null && options.selfUserId > 0
      ? Math.trunc(options.selfUserId)
      : options?.telegramUsername?.trim()
        ? getLiveChatSelfUserId(options.telegramUsername.trim())
        : null;
  const tdlibJoined = Boolean(groupCall.is_joined || groupCall.need_rejoin);
  let selfJoinChanged = false;
  if (actorSelfId != null) {
    selfJoinChanged = setAccountJoined(cached, actorSelfId, tdlibJoined);
    if (!tdlibJoined) {
      const before = cached.members.size;
      stripListenOnlySelfInjects(cached.members, actorSelfId, cached);
      if (cached.members.size !== before) selfJoinChanged = true;
    }
  }
  const speakers = speakersFromGroupCall(groupCall, cached.speakers, cached);
  const prevSpeakersSnapshot = cached.speakers;
  const countHint = Number(groupCall.participant_count);
  if (Number.isFinite(countHint) && countHint >= 0) {
    const nextHint = Math.trunc(countHint);
    ratchetParticipantCountHint(cached, nextHint);
  }

  let changed = false;
  let speakingBecameTrue = false;
  let speakingBecameFalse = false;
  let speakingRefresh = false;

  const now = Date.now();
  for (const [key, speaker] of speakers) {
    if (isLeaveTombstoned(cached, key, now)) {
      cached.speakers?.delete(key);
      continue;
    }
    const prev = cached.members.get(key);
    if (!prev) {
      // Speaking (or hold) peers missing from the ordered load still need a face —
      // Desktop shows kapirdosha while speaking even before a full participant
      // chunk arrives. Never insert silent leavers (tombstoned above).
      if (!speaker.isSpeaking && !effectiveSpeaking(speaker, now)) continue;
      cached.members.set(key, {
        ...speaker,
        isMuted: true,
        order: "",
      });
      changed = true;
      if (speaker.isSpeaking || effectiveSpeaking(speaker, now)) {
        speakingBecameTrue = true;
      }
      continue;
    }
    const isSpeaking = Boolean(speaker.isSpeaking);
    const newlyListed = prevSpeakersSnapshot?.get(key) == null;
    // recent_speakers flaps false while people are mid-sentence. Promote true;
    // on false only drop the live flag and let lastSpokeAt hold expire — never
    // refresh lastSpokeAt to `now` (that pinned speakingCount forever / to 0).
    // Newly listed faces (Telegram rotated the list) also pulse — listen-only
    // clients often never see is_speaking=true.
    if (isSpeaking || newlyListed) {
      if (isSpeaking) {
        if (!prev.isSpeaking) speakingBecameTrue = true;
        cached.members.set(key, {
          ...prev,
          isSpeaking: true,
          lastSpokeAt: now,
          // Keep TDLib mute — resolvePaintedMuted clears chrome while speaking.
        });
        changed = true;
        const lastRefresh = cached.lastSpeakingRefreshAt ?? 0;
        if (now - lastRefresh >= 900) {
          cached.lastSpeakingRefreshAt = now;
          speakingRefresh = true;
        }
        continue;
      }
      // newlyListed without is_speaking: pulse hold only for open-mic faces.
      // Muted people entering recent_speakers must stay muted/grey.
      if (!prev.isMuted && !effectiveSpeaking(prev, now)) {
        speakingBecameTrue = true;
        cached.members.set(key, {
          ...prev,
          isSpeaking: false,
          lastSpokeAt: now,
        });
        changed = true;
      }
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
  const prevSpeakers = prevSpeakersSnapshot;
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

  if (!changed && !speakersChanged && !selfJoinChanged) return;
  void speakingBecameFalse;
  if (speakingBecameTrue) {
    logGateway("voice_participants_speaking_pulse", {
      groupCallId: callId,
      revision: (callMembersCache.get(callId)?.revision ?? 0) + 1,
    });
  }
  bumpVoiceCallRevision(callId, {
    immediate: speakingBecameTrue || speakingRefresh || selfJoinChanged,
  });
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
/**
 * Per-TDLib-client getMe id. A process-global cache mixed multi-tenant
 * gateways (Сева vs Vsevolod) so the wrong face was marked is_self / You.
 */
const selfUserIdByClient = new WeakMap<object, number>();

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
  const cached = selfUserIdByClient.get(client);
  if (cached != null) return cached;
  try {
    const me = (await client.invoke({ _: "getMe" })) as { id?: number };
    const id = Number(me.id);
    if (Number.isFinite(id) && id > 0) {
      const trunc = Math.trunc(id);
      selfUserIdByClient.set(client, trunc);
      return trunc;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function speakersFromGroupCall(
  groupCall: GroupCallSnapshot,
  prevSpeakers?: Map<string, CollectedParticipant>,
  leaveGuard?: CallParticipantsCache,
): Map<string, CollectedParticipant> {
  const map = new Map<string, CollectedParticipant>();
  const speakers = Array.isArray(groupCall.recent_speakers) ? groupCall.recent_speakers : [];
  const now = Date.now();
  for (const speaker of speakers) {
    const { userId, chatId } = parseSender(speaker.participant_id);
    const key = participantKey(userId, chatId);
    if (!key) continue;
    if (leaveGuard && isLeaveTombstoned(leaveGuard, key, now)) continue;
    const isSpeaking = Boolean(
      speaker.is_speaking ?? (speaker as { isSpeaking?: boolean }).isSpeaking,
    );
    const prev = prevSpeakers?.get(key);
    // Only pulse lastSpokeAt when TDLib says speaking. Newly-listed silent faces
    // must not invent a speaking hold — that painted muted calls green/open-mic.
    const lastSpokeAt = isSpeaking ? now : prev?.lastSpokeAt;
    map.set(key, {
      userId,
      chatId,
      isSpeaking,
      // Preserve hold across flaps — rebuilding with lastSpokeAt:undefined made
      // every SSE snapshot report speakingCount=0 a tick after someone spoke.
      lastSpokeAt,
      // recent_speakers omit mute entirely. Never invent unmuted (open green
      // mics on listeners vs Telegram Desktop). Speaking opens mic chrome at
      // paint time via resolvePaintedMuted — do not sticky-write unmuted here.
      isMuted: prev?.isMuted ?? true,
      canUnmuteSelf: prev?.canUnmuteSelf ?? true,
      volumeLevel: prev?.volumeLevel ?? 10000,
      order: "",
    });
  }
  // Empty recent_speakers mid-call is often a flap (esp. right after join). Keep
  // prior stubs that are still inside the speaking hold so SSE speakingCount
  // does not drop to 0 for a full silence tick while people are mid-sentence.
  if (map.size === 0 && prevSpeakers && prevSpeakers.size > 0) {
    for (const [key, prev] of prevSpeakers) {
      if (leaveGuard && isLeaveTombstoned(leaveGuard, key, now)) continue;
      if (effectiveSpeaking(prev, now)) {
        map.set(key, { ...prev, isSpeaking: false });
      }
    }
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
      // Keep TDLib mute in the store — paint clears mute chrome only while
      // live speaking via resolvePaintedMuted. Writing isMuted:false here left
      // everyone unmuted after the first recent_speakers pulse.
      isMuted: row.isMuted,
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
  liveCount = 0,
  leaveGuard?: CallParticipantsCache,
): Map<string, CollectedParticipant> {
  if (speakers.size === 0) return members;
  const next = new Map(members);
  const now = Date.now();
  const hasOrderedMember = [...members.values()].some((row) =>
    Boolean(row.order),
  );
  const cap =
    Number.isFinite(liveCount) && liveCount > 0
      ? Math.trunc(liveCount)
      : Number.POSITIVE_INFINITY;
  const rosterThin = Number.isFinite(liveCount) && liveCount > next.size;
  for (const [key, speaker] of speakers) {
    if (next.has(key)) continue;
    if (leaveGuard && isLeaveTombstoned(leaveGuard, key, now)) continue;
    // After ordered members exist, only fill gaps: live speakers (Desktop shows
    // them before load catches up) or thin roster vs participant_count. Silent
    // recent_speakers leftovers must not re-paint leavers (пэшка after exit).
    if (hasOrderedMember) {
      const liveSpeak =
        Boolean(speaker.isSpeaking) || effectiveSpeaking(speaker, now);
      if (!liveSpeak && !rosterThin) continue;
    }
    if (next.size >= cap) break;
    next.set(key, { ...speaker });
  }
  return next;
}

/** Drop excess soft-merge stubs so painted size cannot exceed live TDLib.
 * Never drop ordered members — a soft undercount used to trim a full load
 * (ordered=6, liveTdlib=3) and hide real participants. */
function trimCollectedToLiveCount(
  members: Map<string, CollectedParticipant>,
  speakers: Map<string, CollectedParticipant> | undefined,
  liveCount: number,
  selfUserId?: number | null,
): Map<string, CollectedParticipant> {
  if (members.size <= liveCount) return members;
  const ordered = [...members.entries()].filter(([, row]) => Boolean(row.order));
  const orderless = [...members.entries()].filter(([, row]) => !row.order);
  if (ordered.length >= liveCount) {
    return new Map(ordered);
  }
  const rankedOrderless = orderless.sort(([keyA, a], [keyB, b]) => {
    const score = (row: CollectedParticipant, key: string) => {
      let s = 0;
      if (row.screenInfo?.source_groups?.length) s += 16;
      if (row.videoInfo?.source_groups?.length) s += 8;
      if (speakers?.has(key)) s += 4;
      if (row.userId != null && selfUserId != null && row.userId === selfUserId) {
        s += 2;
      }
      if (
        row.isSpeaking ||
        (row.lastSpokeAt != null && Date.now() - row.lastSpokeAt < SPEAKING_HOLD_MS)
      ) {
        s += 1;
      }
      return s;
    };
    return score(b, keyB) - score(a, keyA);
  });
  const need = Math.max(0, liveCount - ordered.length);
  return new Map([...ordered, ...rankedOrderless.slice(0, need)]);
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
            // Orderless stubs omit mute — never remute OR unmute from them.
            // Speaking must not write unmuted into the store (mute ≠ green).
            isMuted: !row.order ? prev.isMuted : row.isMuted,
            canUnmuteSelf: row.canUnmuteSelf ?? prev.canUnmuteSelf ?? true,
            volumeLevel: row.volumeLevel ?? prev.volumeLevel ?? 10000,
            order: row.order || prev.order,
            // Trust TDLib nulls — do not sticky-keep cleared camera/screen.
            videoInfo: row.videoInfo,
            screenInfo: row.screenInfo,
          }
        : {
            ...row,
            volumeLevel: row.volumeLevel ?? 10000,
            // Unknown mute on a brand-new orderless stub → muted until ordered
            // (default unmuted invented open-mic chrome vs Telegram Desktop).
            isMuted: row.order ? row.isMuted : true,
          },
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
      // Rejoin with order clears the leave tombstone before strip.
      if (prev) {
        for (const [key, row] of loaded) {
          if (row.order) clearLeaveTombstone(prev, key);
        }
      }
      const members = stripLeaveTombstones(
        preserveSpeakingOnRoster(
          mergedRoster,
          prev?.members,
          prev?.speakers,
        ),
        prev,
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
        selfUserId: prev?.selfUserId ?? null,
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
        leftAt: prev?.leftAt,
        hasHiddenListeners: prev?.hasHiddenListeners,
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
      const callSelfId = callMembersCache.get(callId)?.selfUserId ?? null;
      if (userId != null && callSelfId != null && userId === callSelfId) {
        const prev = map.get(key);
        if (prev) {
          const isHandRaised = readHandRaised(participant);
          const mutedRaw =
            readMutedForAllUsers(participant) ?? prev.isMuted;
          const canUnmuteSelf =
            readCanUnmuteSelf(participant) ?? prev.canUnmuteSelf ?? true;
          map.set(key, {
            ...prev,
            isSpeaking: false,
            isHandRaised,
            canUnmuteSelf,
            isMuted: mutedRaw,
            volumeLevel:
              participant.volume_level != null
                ? normalizeVolumeLevel(participant.volume_level, prev.volumeLevel)
                : prev.volumeLevel,
            order: prev.order || "0",
          });
        }
      } else {
        map.delete(key);
        callMembersCache.get(callId)?.speakers?.delete(key);
      }
      return;
    }
    const prev = map.get(key);
    const isSpeaking = Boolean(participant.is_speaking);
    const videoInfo = normalizeVideoInfo(participant.video_info);
    const screenInfo = normalizeVideoInfo(participant.screen_sharing_video_info);
    const mutedFromTdlib = readMutedForAllUsers(participant);
    const isHandRaised = readHandRaised(participant);
    const canUnmuteSelf =
      readCanUnmuteSelf(participant) ?? prev?.canUnmuteSelf ?? true;
    // Missing mute on a load chunk: keep prev, else muted — default unmuted
    // invented open-mic chrome when TDLib omitted the field on soft chunks.
    const mutedRaw =
      mutedFromTdlib ?? prev?.isMuted ?? true;
    map.set(key, {
      userId,
      chatId,
      isSpeaking,
      lastSpokeAt: isSpeaking ? Date.now() : prev?.lastSpokeAt,
      isHandRaised,
      canUnmuteSelf,
      // Store TDLib mute only — speaking opens mic chrome at serialize via
      // resolvePaintedMuted. Writing painted unmuted here sticky-opened faces.
      isMuted: mutedRaw,
      volumeLevel:
        participant.volume_level != null
          ? normalizeVolumeLevel(participant.volume_level, prev?.volumeLevel ?? 10000)
          : (prev?.volumeLevel ?? 10000),
      order,
      // Trust TDLib nulls — do not sticky-keep cleared camera/screen.
      videoInfo,
      screenInfo,
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
        // listed will never equal participant_count. Do not treat a solo/self
        // seed (or thin recent_speakers) as complete after two quiet chunks —
        // that left half the call missing while has_hidden_listeners stayed true.
        const visibleFloor =
          Number.isFinite(expected) && expected >= 2
            ? Math.min(expected, Math.max(3, Math.ceil(expected * 0.5)))
            : 3;
        if (
          loadedAll ||
          map.size >= visibleFloor ||
          noGrowthStreak >= 4
        ) {
          sawLoadedAll = true;
          break;
        }
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
  options?: { forceReload?: boolean; telegramUsername?: string },
): Promise<{
  ok: boolean;
  error: string | null;
  participant_count: number;
  participants: VoiceParticipantRow[];
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
  voice_chat_is_joined: boolean;
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
      voice_chat_is_joined: false,
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

  const chatHasParticipants = readTdVideoChat({
    video_chat: resolved.videoChatRaw ?? undefined,
  }).has_participants;

  if (!groupCallLooksLiveForChat(groupCall, chatHasParticipants)) {
    // Keep bound id so Start voice can reuse the empty shell; only clear live
    // paint. Do NOT map chat→call for SSE — that streamed stale rosters after
    // the call ended (inactive set still connected the participants stream).
    chatToGroupCallId.delete(Math.trunc(chatId));
    logGateway("voice_participants_inactive", {
      chatId,
      groupCallId: callId,
      isActive: groupCall.is_active === true,
      isJoined: Boolean(groupCall.is_joined),
      participantCount: Number(groupCall.participant_count) || 0,
      chatHasParticipants,
      resolveSource: resolved.source,
    });
    return {
      ok: true,
      error: null,
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: callId,
      voice_chat_is_joined: false,
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
  // Resolve getMe before ingest so per-account join flags are attributed correctly
  // (shared selfJoined previously mixed Сева ↔ Vsevolod on the same callId).
  const selfUserId = await resolveSelfUserId(client);
  if (selfUserId != null) {
    const username = options?.telegramUsername?.trim();
    if (username) setLiveChatSelfUserId(username, selfUserId);
  }
  {
    const cached = ensureCallCache(callId, {
      uniqueId: groupCall.unique_id != null ? String(groupCall.unique_id) : undefined,
    });
    cached.hasHiddenListeners = hasHiddenListeners;
  }

  // Write the fresh recent_speakers overlay into the shared cache. The SSE
  // snapshot reads only the cache — without this, speaking learned via polling
  // never reached the stream and green mics stayed grey while the dialog was
  // open (SSE snapshots with is_speaking=false overrode poll data).
  // speakersFromGroupCall runs inside ingest so lastSpokeAt hold is preserved.
  ingestGroupCallUpdate(
    { _: "updateGroupCall", group_call: groupCall },
    {
      telegramUsername: options?.telegramUsername,
      selfUserId,
    },
  );
  const speakers =
    callMembersCache.get(callId)?.speakers ?? speakersFromGroupCall(groupCall, undefined, callMembersCache.get(callId));

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
            selfUserId: prev?.selfUserId ?? null,
            participantCountHint: Math.max(
              prev?.participantCountHint ?? 0,
              Number.isFinite(participantCountHint) && participantCountHint >= 0
                ? Math.trunc(participantCountHint)
                : 0,
              members.size,
            ),
            speakers: prev?.speakers ?? speakers,
            leftAt: prev?.leftAt,
            hasHiddenListeners:
              prev?.hasHiddenListeners ?? hasHiddenListeners,
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
        collected = mergeSpeakerStubsForDisplay(collected, speakers, participantCountHint, cached!);
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

  if (selfUserId != null) {
    const ownerCache = ensureCallCache(callId);
    adoptCallSelfUserId(ownerCache, selfUserId, collected);
    // Drop prior-account rows tombstoned above + leftover synthetic injects.
    collected = stripLeaveTombstones(collected, ownerCache);
    collected = new Map(
      [...collected.entries()].filter(([, row]) => {
        if (row.order !== "\uffff") return true;
        return row.userId === selfUserId;
      }),
    );
  }

  // Listen-only / muted self is often omitted when has_hidden_listeners is set, and
  // updateGroupCallParticipant with empty order can drop us from the live cache.
  // While TDLib reports us as joined, always keep self visible in the roster —
  // including the solo-participant case where recent_speakers is empty.
  const ownerCache = ensureCallCache(callId);
  setAccountJoined(ownerCache, selfUserId, isJoined);
  if (isJoined && selfUserId != null) {
    const selfKey = participantKey(selfUserId, null);
    if (selfKey && !collected.has(selfKey)) {
      collected = new Map(collected);
      collected.set(selfKey, {
        userId: selfUserId,
        chatId: null,
        isSpeaking: false,
        isMuted: true,
        canUnmuteSelf: true,
        volumeLevel: 10000,
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
        canUnmuteSelf: collected.get(selfKey)?.canUnmuteSelf ?? true,
        volumeLevel: collected.get(selfKey)?.volumeLevel ?? 10000,
        order: collected.get(selfKey)?.order || "\uffff",
      };
      if (cached) {
        adoptCallSelfUserId(cached, selfUserId, collected);
        setAccountJoined(cached, selfUserId, true);
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
          selfUserId,
          selfJoinedByUserId: new Map([[selfUserId, true]]),
          participantCountHint: Number.isFinite(participantCountHint)
            ? Math.trunc(participantCountHint)
            : 0,
        });
      }
    }
  } else if (selfUserId != null) {
    // Spectator / after leave: never keep the listen-only inject in cache or paint.
    collected = stripListenOnlySelfInjects(collected, selfUserId, ownerCache);
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
  const liveTdlibCount =
    Number.isFinite(participantCountHint) && participantCountHint >= 0
      ? Math.trunc(participantCountHint)
      : 0;
  const stickyHint = callMembersCache.get(callId)?.participantCountHint ?? 0;
  // Cap stubs at the live TDLib total — using collected.size as a floor let
  // leftover speakers keep growing the painted roster past the real call.
  const stubCap =
    liveTdlibCount >= 2
      ? liveTdlibCount
      : Math.max(liveTdlibCount, stickyHint, collected.size);
  if (speakers.size > 0) {
    collected = mergeSpeakerStubsForDisplay(collected, speakers, stubCap, callMembersCache.get(callId));
    collected = stripLeaveTombstones(collected, callMembersCache.get(callId));
  }
  if (liveTdlibCount >= 2 && collected.size > liveTdlibCount) {
    collected = trimCollectedToLiveCount(
      collected,
      speakers,
      liveTdlibCount,
      selfUserId,
    );
  }
  const hasOrderedCollected = [...collected.values()].some((r) =>
    Boolean(r.order),
  );
  const orderedRows = [...collected.values()].filter((row) => {
    // Prior-account listen-only injects must never paint as remotes.
    // Current-account injects only while TDLib reports this client joined —
    // otherwise spectators see themselves without Join.
    if (row.order === "\uffff") {
      if (selfUserId == null || row.userId !== selfUserId) return false;
      return isJoined;
    }
    // After leave / spectator: do not paint this account even if a stale ordered
    // row lingered in the shared call cache.
    if (
      !isJoined &&
      selfUserId != null &&
      row.userId === selfUserId
    ) {
      return false;
    }
    if (row.order) return true;
    if (isJoined && selfUserId != null && row.userId === selfUserId) return true;
    const key = participantKey(row.userId, row.chatId);
    // Orderless stubs: allow live speakers / thin-roster fills; never tombstones.
    if (hasOrderedCollected) {
      if (key == null || !speakers.has(key)) return false;
      const cached = callMembersCache.get(callId);
      if (cached && isLeaveTombstoned(cached, key)) return false;
      const sp = speakers.get(key);
      const liveSpeak =
        Boolean(row.isSpeaking) ||
        (sp != null && effectiveSpeaking(sp, Date.now())) ||
        effectiveSpeaking(row, Date.now());
      const thin =
        liveTdlibCount > 0 &&
        [...collected.values()].filter((r) => Boolean(r.order)).length < liveTdlibCount;
      return liveSpeak || thin;
    }
    return !rosterLoadedAll || (key != null && speakers.has(key));
  });
  const displayRows =
    orderedRows.length > 0 || rosterLoadedAll
      ? orderedRows
      : [...collected.values()].filter((row) => {
          if (selfUserId == null || row.userId !== selfUserId) return true;
          return isJoined;
        });
  // Soft polls must stay fast — await a short warm only for small painted sets so
  // the HTTP body is not all empty titles ("?"). Force reload awaits a full warm.
  // One warm promise only — racing a second getUser stampede freezes TDLib.
  const profileMembers = new Map(
    displayRows
      .map((row) => {
        const key = participantKey(row.userId, row.chatId);
        return key ? ([key, row] as const) : null;
      })
      .filter((entry): entry is readonly [string, CollectedParticipant] => entry != null),
  );
  const forceReload = Boolean(options?.forceReload);
  const warmPromise =
    profileMembers.size > 0
      ? warmMissingProfiles(client, profileMembers)
      : Promise.resolve(0);
  if (profileMembers.size > 0) {
    if (forceReload) {
      await warmPromise;
    } else if (profileMembers.size <= 8) {
      await Promise.race([warmPromise, sleep(900)]);
    }
  }

  const participants: VoiceParticipantRow[] = displayRows.map((row) => {
    const profile = peekParticipantProfile(row.userId, row.chatId);
    const isSelf =
      isJoined && selfUserId != null && row.userId === selfUserId;
    const paintedMuted = resolvePaintedMuted({
      muted: row.isMuted,
      // Live speaking only — hold must not clear mute chrome.
      isSpeaking: Boolean(row.isSpeaking),
      isHandRaised: Boolean(row.isHandRaised),
      hasHiddenListeners,
      isPinnedSelf: isSelf,
    });
    return {
      user_id: row.userId,
      chat_id: row.chatId,
      title: profile.title,
      description: profile.description,
      emoji_status_custom_emoji_id: profile.emoji_status_custom_emoji_id,
      is_speaking: effectiveSpeaking(row, Date.now()),
      is_muted: paintedMuted,
      can_unmute_self: row.canUnmuteSelf !== false,
      volume_percent: volumeLevelToPercent(row.volumeLevel ?? 10000),
      is_self: isSelf,
      order: row.order || "",
      // Never paint self camera/screen from TDLib — this client's local
      // getDisplayMedia / camera owns that chrome. Sticky TDLib self-share left
      // a green screencast icon on join while local share was off.
      video_info: isSelf ? null : (row.videoInfo ?? null),
      screen_sharing_video_info: isSelf ? null : (row.screenInfo ?? null),
    };
  });

  participants.sort(compareVoiceParticipantRows);

  void warmPromise.then((warmed) => {
    if (warmed > 0) bumpVoiceCallRevision(callId);
  });

  // Prefer live TDLib participant_count as the strip headline (Telegram Desktop).
  // Soft polls only return recent_speakers faces, so listed alone under-counts —
  // but never floor on a sticky high-water above the live count (7 stuck vs 6).
  const listedCount = participants.length;
  const resolvedCount = resolveDisplayParticipantCount(
    liveTdlibCount,
    stickyHint,
    listedCount,
  );
  const mutedRows = participants.filter((p) => p.is_muted);
  logGateway("voice_participants_resolved", {
    chatId,
    groupCallId: callId,
    listed: listedCount,
    participantCount: resolvedCount,
    tdlibCount: liveTdlibCount > 0 ? liveTdlibCount : null,
    hint: stickyHint,
    mutedCount: mutedRows.length,
    unmutedCount: participants.filter((p) => !p.is_muted).length,
    mutedTitles: mutedRows.map((p) => p.title || "?").slice(0, 8),
    isJoined,
    hasHiddenListeners,
    usedCache: callMembersCache.has(callId),
    resolveSource: resolved.source,
  });

  const cachedAfter = callMembersCache.get(callId);
  // Green "joined" ring must mean self is on the roster — not sticky TDLib
  // is_joined after leave/WebRTC disconnect (client logs: isJoined=true while
  // joined=false and no is_self row).
  const selfOnRoster = participants.some((row) => row.is_self);
  return {
    ok: true,
    error: null,
    participant_count: resolvedCount,
    participants,
    has_active_voice_chat: true,
    voice_chat_group_call_id: callId,
    voice_chat_is_joined: selfOnRoster,
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
  // Only return ids verified by a participants fetch that saw a live getGroupCall.
  // Falling back to the client's preferred id resurrected ended calls on chat
  // switch (SSE painted Brainrot with a stale groupCallId=6 roster).
  if (mapped != null && mapped > 0) return mapped;
  void preferredGroupCallId;
  return null;
}

export function getVoiceParticipantsRevision(
  groupCallId: number,
): number {
  return callMembersCache.get(Math.trunc(groupCallId))?.revision ?? 0;
}

/**
 * Sync snapshot for SSE — uses profile cache only (no TDLib round-trips).
 * Titles may be empty until a full participants fetch warms profiles.
 */
export function getVoiceParticipantsStreamSnapshot(
  groupCallId: number,
  telegramUsername?: string,
): {
  revision: number;
  participant_count: number;
  participants: VoiceParticipantRow[];
} {
  const callId = Math.trunc(groupCallId);
  const cached = callMembersCache.get(callId);
  if (!cached) {
    return { revision: 0, participant_count: 0, participants: [] };
  }
  // Prefer per-account getMe (live chat cache). Never fall back to another
  // account's cached.selfUserId when telegramUsername is known — that painted
  // Сева as You / "Сева is streaming" for Vsevolod's session.
  const usernameKey = telegramUsername?.trim() || "";
  const fromUsername = usernameKey ? getLiveChatSelfUserId(usernameKey) : null;
  const selfUserId = usernameKey
    ? fromUsername
    : (fromUsername ?? cached.selfUserId ?? null);
  const selfJoined = isAccountJoined(cached, selfUserId);
  const nowMs = Date.now();
  // Mirror the poll path: overlay recent_speakers onto the live roster, and
  // union speaker stubs whenever the painted map is thin — chat-preview strip
  // relies on these faces when loadGroupCallParticipants is not allowed yet.
  let collected = stripLeaveTombstones(cached.members, cached);
  if (!selfJoined && selfUserId != null) {
    collected = stripListenOnlySelfInjects(collected, selfUserId, cached);
  }
  if (cached.speakers && cached.speakers.size > 0) {
    collected = applySpeakingOverlay(collected, cached.speakers);
    // Persist speaking hold clocks onto members. Overlay is ephemeral; without
    // this, a speakers map that drops mid-hold left SSE speakingCount=0 while
    // people were still mid-sentence (green mics never stuck after join).
    for (const [key, row] of collected) {
      const prev = cached.members.get(key);
      if (!prev) continue;
      const lastSpokeAt =
        row.lastSpokeAt != null &&
        (prev.lastSpokeAt == null || row.lastSpokeAt > prev.lastSpokeAt)
          ? row.lastSpokeAt
          : prev.lastSpokeAt;
      if (
        Boolean(row.isSpeaking) === Boolean(prev.isSpeaking) &&
        lastSpokeAt === prev.lastSpokeAt
      ) {
        continue;
      }
      cached.members.set(key, {
        ...prev,
        isSpeaking: Boolean(row.isSpeaking),
        lastSpokeAt,
      });
    }
    const hintGap =
      cached.participantCountHint > collected.size ||
      cached.members.size === 0 ||
      !cached.loadedAll;
    if (hintGap) {
      collected = mergeSpeakerStubsForDisplay(
        collected,
        cached.speakers,
        cached.participantCountHint,
        cached,
      );
      collected = stripLeaveTombstones(collected, cached);
    }
  }
  const hasOrderedCollected = [...collected.values()].some((r) =>
    Boolean(r.order),
  );
  const orderedRows = [...collected.values()].filter((row) => {
    // Prior-account listen-only injects must never paint as remotes.
    // Current-account injects only while this client's TDLib session is joined.
    if (row.order === "\uffff") {
      if (selfUserId == null || row.userId !== selfUserId) return false;
      return selfJoined;
    }
    if (
      !selfJoined &&
      selfUserId != null &&
      row.userId === selfUserId
    ) {
      return false;
    }
    if (row.order) return true;
    // Orderless self only while joined — otherwise SSE paints You for spectators.
    if (selfJoined && selfUserId != null && row.userId === selfUserId) return true;
    const key = participantKey(row.userId, row.chatId);
    // Orderless stubs: live speakers / thin roster only — never leave tombstones.
    if (hasOrderedCollected) {
      if (key == null || !cached.speakers?.has(key)) return false;
      if (isLeaveTombstoned(cached, key)) return false;
      const sp = cached.speakers.get(key);
      const liveSpeak =
        Boolean(row.isSpeaking) ||
        (sp != null && effectiveSpeaking(sp, Date.now())) ||
        effectiveSpeaking(row, Date.now());
      const orderedN = [...collected.values()].filter((r) => Boolean(r.order)).length;
      const thin =
        cached.participantCountHint > 0 &&
        orderedN < cached.participantCountHint;
      return liveSpeak || thin;
    }
    if (key != null && cached.speakers?.has(key)) return true;
    return !cached.loadedAll;
  });
  const displayRows =
    orderedRows.length > 0 || cached.loadedAll
      ? orderedRows
      : [...collected.values()].filter((row) => {
          if (selfUserId == null || row.userId !== selfUserId) return true;
          return selfJoined;
        });
  const participants: VoiceParticipantRow[] = displayRows
    .map((row) => {
      const key = participantKey(row.userId, row.chatId);
      const profile = key ? profileCache.get(key) : undefined;
      const isSelf =
        selfJoined && selfUserId != null && row.userId === selfUserId;
      const speaking = effectiveSpeaking(row, nowMs);
      return {
        user_id: row.userId,
        chat_id: row.chatId,
        title: profile?.title ?? "",
        description: profile?.description ?? "",
        emoji_status_custom_emoji_id: profile?.emoji_status_custom_emoji_id ?? null,
        is_speaking: speaking,
        is_muted: resolvePaintedMuted({
          muted: row.isMuted,
          // Live speaking only — SPEAKING_HOLD_MS must not wipe mute icons.
          isSpeaking: Boolean(row.isSpeaking),
          isHandRaised: Boolean(row.isHandRaised),
          hasHiddenListeners: Boolean(cached.hasHiddenListeners),
          isPinnedSelf: isSelf,
        }),
        can_unmute_self: row.canUnmuteSelf !== false,
        volume_percent: volumeLevelToPercent(row.volumeLevel ?? 10000),
        is_self: isSelf,
        order: row.order || "",
        video_info: isSelf ? null : (row.videoInfo ?? null),
        screen_sharing_video_info: isSelf ? null : (row.screenInfo ?? null),
      };
    });
  participants.sort(compareVoiceParticipantRows);
  const listed = participants.length;
  const count = resolveDisplayParticipantCount(
    cached.participantCountHint,
    cached.participantCountHint,
    listed,
  );
  return {
    revision: cached.revision,
    participant_count: count > 0 ? count : listed,
    participants,
  };
}

