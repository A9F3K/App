import type { Client } from "tdl";
import { safeTelegramUserIdForLog } from "../../shared/appLog.js";
import { logGateway } from "./gatewayLog.js";
import { clearLiveChatCache, getLiveChatList, patchLiveChatAction, patchLiveChatChatEmojiStatus, patchLiveChatEmojiStatus, patchLiveChatFromTdlib, patchLiveChatPresence, patchLiveChatVideoChat, bumpLiveChatRevision } from "./liveChatCache.js";
import { bumpLiveChatMessageRevision, clearLiveChatMessageRevisions } from "./liveChatMessageRevisionNotify.js";
import { noteLiveChatMessageDeletes } from "./liveChatDeletedMessages.js";
import { chatActionFromTdlib, presenceFromTdlibStatus, isGenericMessagePreviewLabel, previewFromMessage, resolveLastMessagePreviewPayload, usernameFromTdUser, voiceChatFromTdChat, type TdChat, type TdMessage } from "./chatPreview.js";
import { shouldIncludeChatInList } from "./chatListFilter.js";
import { emojiStatusCustomIdFromUser, parseEmojiStatusCustomId } from "./emojiStatus.js";
import { userProfileFromTdUser } from "./tdUserProfile.js";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import {
  groupCallLooksLive,
  ingestGroupCallParticipantUpdate,
  ingestGroupCallUpdate,
  verifyGroupCallLiveState,
} from "./voiceParticipants.js";
import { ingestNewGroupCallMessage } from "./voiceCallMessages.js";

const CHAT_REFRESH_DEBOUNCE_MS = 800;

/** Confirm chat.video_chat against getGroupCall before painting rings / strip. */
async function verifyAndPatchVideoChat(
  record: LiveSyncRecord,
  chatId: number,
  candidate: {
    has_active_voice_chat: boolean;
    voice_chat_group_call_id: number | null;
  },
): Promise<void> {
  if (candidate.voice_chat_group_call_id == null) {
    patchLiveChatVideoChat(record.telegramUsername, chatId, {
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_chat_is_joined: false,
    });
    return;
  }
  // Bound id with unknown/false has_participants still needs getGroupCall —
  // otherwise empty leftover calls never clear after a prior live patch.
  const client = record.client;
  if (!client) {
    if (!candidate.has_active_voice_chat) {
      patchLiveChatVideoChat(record.telegramUsername, chatId, {
        has_active_voice_chat: false,
        voice_chat_group_call_id: candidate.voice_chat_group_call_id,
        voice_chat_is_joined: false,
      });
    }
    return;
  }
  const state = await verifyGroupCallLiveState(
    client,
    candidate.voice_chat_group_call_id,
  );
  patchLiveChatVideoChat(record.telegramUsername, chatId, {
    has_active_voice_chat: state.live,
    // Keep bound id when empty so Start voice can target the leftover call.
    voice_chat_group_call_id: candidate.voice_chat_group_call_id,
    // List verify must not paint green from sticky TDLib is_joined.
    voice_chat_is_joined: false,
  });
  if (!state.live) {
    logLiveSync(record, "live_chat_video_chat_cleared_inactive", {
      chatId,
      groupCallId: candidate.voice_chat_group_call_id,
    });
  }
}

const LIVE_UPDATE_TYPES = new Set([
  "updateNewMessage",
  "updateChatLastMessage",
  "updateChatReadInbox",
  "updateNewChat",
  "updateChatTitle",
  "updateChatEmojiStatus",
  "updateChatPhoto",
  "updateChatPosition",
  "updateMessageEdited",
  "updateMessageContent",
  "updateDeleteMessages",
  "updateUserStatus",
  "updateUser",
  "updateUserEmojiStatus",
  "updateUserChatAction",
  "updateChatReadOutbox",
  "updateChatVideoChat",
]);

type LiveSyncRecord = {
  attemptId: string;
  telegramUsername: string;
  get authState(): string;
  client: Client | null;
};

const refreshTimers = new Map<string, Map<number, ReturnType<typeof setTimeout>>>();
const attachedClients = new WeakSet<Client>();

function logLiveSync(record: LiveSyncRecord, event: string, extra?: Record<string, unknown>): void {
  logGateway(event, {
    attemptId: record.attemptId,
    telegramUsername: record.telegramUsername,
    authState: record.authState,
    ...extra,
  });
}

function chatIdFromUpdate(update: Record<string, unknown>): number | null {
  const type = update._;
  if (type === "updateNewMessage") {
    const msg = update.message as { chat_id?: number } | undefined;
    return typeof msg?.chat_id === "number" ? msg.chat_id : null;
  }
  if (
    type === "updateChatLastMessage" ||
    type === "updateChatReadInbox" ||
    type === "updateChatTitle" ||
    type === "updateChatPhoto" ||
    type === "updateChatPosition"
  ) {
    return typeof update.chat_id === "number" ? update.chat_id : null;
  }
  if (type === "updateNewChat") {
    const chat = update.chat as { id?: number } | undefined;
    return typeof chat?.id === "number" ? chat.id : null;
  }
  if (type === "updateMessageEdited" || type === "updateMessageContent" || type === "updateDeleteMessages") {
    const chatId = update.chat_id;
    return typeof chatId === "number" ? chatId : null;
  }
  return null;
}

async function applyLiveUpdate(record: LiveSyncRecord, update: Record<string, unknown>): Promise<void> {
  const client = record.client;
  if (!client || record.authState !== "ready") return;

  const type = update._;

  if (type === "updateNewMessage") {
    const message = update.message as TdMessage & { chat_id?: number };
    if (typeof message?.chat_id !== "number") return;
    let preview = previewFromMessage(message);
    let lastMessage: TdMessage = message;
    try {
      if (!preview || isGenericMessagePreviewLabel(preview)) {
        const messageId = Number(message.id);
        if (Number.isFinite(messageId) && messageId > 0) {
          try {
            const full = (await client.invoke({
              _: "getMessage",
              chat_id: message.chat_id,
              message_id: messageId,
            })) as TdMessage;
            lastMessage = full;
            preview = previewFromMessage(full);
          } catch {
            /* keep partial update payload */
          }
        }
      }
      const chat = (await client.invoke({ _: "getChat", chat_id: message.chat_id })) as TdChat;
      const { subtitle: resolvedSubtitle, subtitleSegments } = await resolveLastMessagePreviewPayload(
        client,
        { ...chat, last_message: lastMessage },
      );
      patchLiveChatFromTdlib(record.telegramUsername, chat, {
        subtitle: resolvedSubtitle ?? preview,
        subtitle_segments: subtitleSegments,
        last_message: lastMessage,
      });
      bumpLiveChatMessageRevision(record.telegramUsername, message.chat_id);
      logLiveSync(record, "live_chat_message_applied", {
        chatId: message.chat_id,
        userId: safeTelegramUserIdForLog(
          getLiveChatList(record.telegramUsername)?.find(
            (row) => row.telegram_chat_id === message.chat_id,
          )?.peer_user_id,
        ) ?? null,
        preview,
        previewMissing: !preview,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLiveSync(record, "live_chat_message_error", { chatId: message.chat_id, message: msg });
    }
    return;
  }

  if (type === "updateChatLastMessage") {
    const chatId = update.chat_id;
    const lastMessage = update.last_message as TdMessage | undefined;
    if (typeof chatId !== "number") return;
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      const mergedChat: TdChat = {
        ...chat,
        last_message: lastMessage ?? chat.last_message ?? undefined,
      };
      const { subtitle, subtitleSegments } = await resolveLastMessagePreviewPayload(client, mergedChat);
      patchLiveChatFromTdlib(record.telegramUsername, chat, {
        subtitle,
        subtitle_segments: subtitleSegments,
        last_message: mergedChat.last_message ?? null,
      });
    } catch {
      /* ignore */
    }
    bumpLiveChatMessageRevision(record.telegramUsername, chatId);
    logLiveSync(record, "live_chat_last_message_applied", { chatId });
    return;
  }

  if (type === "updateChatReadInbox") {
    const chatId = update.chat_id;
    if (typeof chatId !== "number") return;
    const unreadRaw = Number(update.unread_count);
    if (Number.isFinite(unreadRaw) && unreadRaw >= 0) {
      const { patchLiveChatReadInbox } = await import("./liveChatCache.js");
      const lastReadInboxRaw = Number(update.last_read_inbox_message_id);
      const lastReadInbox =
        Number.isFinite(lastReadInboxRaw) && lastReadInboxRaw > 0
          ? Math.trunc(lastReadInboxRaw)
          : undefined;
      patchLiveChatReadInbox(
        record.telegramUsername,
        chatId,
        Math.floor(unreadRaw),
        lastReadInbox,
      );
      logLiveSync(record, "live_chat_read_inbox_applied", {
        chatId,
        unreadCount: Math.floor(unreadRaw),
        lastReadInbox: update.last_read_inbox_message_id ?? null,
      });
      return;
    }
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      patchLiveChatFromTdlib(record.telegramUsername, chat, { last_message: chat.last_message ?? null });
    } catch {
      /* ignore */
    }
    return;
  }

  if (type === "updateChatReadOutbox") {
    const chatId = update.chat_id;
    if (typeof chatId !== "number") return;
    try {
      const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      patchLiveChatFromTdlib(record.telegramUsername, chat, {});
      logLiveSync(record, "live_chat_read_outbox_applied", {
        chatId,
        lastReadOutbox: chat.last_read_outbox_message_id ?? null,
      });
    } catch {
      /* ignore */
    }
    return;
  }

  if (type === "updateNewChat") {
    const chat = update.chat as TdChat | undefined;
    if (!chat?.id) return;
    if (!shouldIncludeChatInList(chat)) return;
    patchLiveChatFromTdlib(record.telegramUsername, chat, {});
    return;
  }

  if (type === "updateUserStatus") {
    const userId = update.user_id;
    const status = update.status;
    if (typeof userId !== "number") return;
    const presence = presenceFromTdlibStatus(status);
    if (!presence) return;
    patchLiveChatPresence(record.telegramUsername, userId, presence);
    logLiveSync(record, "live_chat_presence_applied", {
      peerUserId: userId,
      kind: presence.kind,
    });
    return;
  }

  if (type === "updateUser") {
    const user = update.user;
    if (!user || typeof user !== "object") return;
    const userId = (user as { id?: number }).id;
    if (typeof userId !== "number") return;
    const profile = userProfileFromTdUser(user);
    patchLiveChatEmojiStatus(
      record.telegramUsername,
      userId,
      profile.emoji_status_custom_emoji_id,
      profile.accent_color_light,
      profile.accent_color_dark,
    );
    logLiveSync(record, "live_chat_user_profile_applied", {
      peerUserId: userId,
      hasEmojiStatus: Boolean(profile.emoji_status_custom_emoji_id),
    });
    return;
  }

  if (type === "updateUserEmojiStatus") {
    const userId = update.user_id;
    if (typeof userId !== "number") return;
    const customEmojiId = parseEmojiStatusCustomId(update.emoji_status ?? update.emojiStatus);
    patchLiveChatEmojiStatus(record.telegramUsername, userId, customEmojiId);
    logLiveSync(record, "live_chat_emoji_status_applied", {
      peerUserId: userId,
      hasCustomEmoji: Boolean(customEmojiId),
    });
    return;
  }

  if (type === "updateChatEmojiStatus") {
    const chatId = update.chat_id;
    if (typeof chatId !== "number") return;
    const customEmojiId = parseEmojiStatusCustomId(update.emoji_status ?? update.emojiStatus);
    patchLiveChatChatEmojiStatus(record.telegramUsername, chatId, customEmojiId);
    logLiveSync(record, "live_chat_chat_emoji_status_applied", {
      chatId,
      hasCustomEmoji: Boolean(customEmojiId),
    });
    return;
  }

  if (type === "updateUserChatAction") {
    const chatId = update.chat_id;
    const userId = update.user_id;
    const actionRaw = update.action;
    if (typeof chatId !== "number" || typeof userId !== "number") return;
    const parsed = chatActionFromTdlib(actionRaw);
    if (parsed === null) return;

    if (parsed === "cancel") {
      patchLiveChatAction(record.telegramUsername, chatId, {
        action: null,
        userId: null,
        userName: null,
      });
      logLiveSync(record, "live_chat_action_cleared", { chatId, userId });
      return;
    }

    let userName: string | null = null;
    try {
      const user = (await client.invoke({ _: "getUser", user_id: userId })) as {
        first_name?: string;
        last_name?: string;
        username?: string;
        usernames?: { active_usernames?: string[]; editable_username?: string };
      };
      const parts = [user.first_name, user.last_name].filter(Boolean);
      userName = parts.join(" ").trim();
      if (!userName) {
        const username = usernameFromTdUser(user);
        if (username) userName = `@${username}`;
      }
    } catch {
      /* optional display name */
    }

    patchLiveChatAction(record.telegramUsername, chatId, {
      action: parsed,
      userId,
      userName,
    });
    logLiveSync(record, "live_chat_action_applied", { chatId, userId, action: parsed });
    return;
  }

  if (type === "updateChatVideoChat") {
    const chatId = update.chat_id;
    if (typeof chatId !== "number") return;
    const voice = voiceChatFromTdChat({
      id: chatId,
      video_chat:
        update.video_chat && typeof update.video_chat === "object"
          ? (update.video_chat as TdChat["video_chat"])
          : update.videoChat && typeof update.videoChat === "object"
            ? (update.videoChat as TdChat["video_chat"])
            : undefined,
    });
    // Always verify when a group_call_id is bound — unknown has_participants
    // must not paint, and empty leftovers must clear prior live patches.
    if (voice.voice_chat_group_call_id == null) {
      patchLiveChatVideoChat(record.telegramUsername, chatId, {
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
        voice_chat_is_joined: false,
      });
    } else {
      await verifyAndPatchVideoChat(record, chatId, voice);
    }
    logLiveSync(record, "live_chat_video_chat_applied", {
      chatId,
      hasActiveVoiceChat: voice.has_active_voice_chat,
      groupCallId: voice.voice_chat_group_call_id,
      rawVideoChat: update.video_chat ?? update.videoChat ?? null,
    });
    return;
  }

  const chatId = chatIdFromUpdate(update);
  if (chatId == null) return;

  try {
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    patchLiveChatFromTdlib(record.telegramUsername, chat, { last_message: chat.last_message ?? null });
    const voice = voiceChatFromTdChat(chat);
    if (voice.voice_chat_group_call_id != null) {
      await verifyAndPatchVideoChat(record, chatId, voice);
    } else {
      patchLiveChatVideoChat(record.telegramUsername, chatId, {
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
        voice_chat_is_joined: false,
      });
    }
    if (
      type === "updateMessageEdited" ||
      type === "updateMessageContent" ||
      type === "updateDeleteMessages"
    ) {
      bumpLiveChatMessageRevision(record.telegramUsername, chatId);
    }
    logLiveSync(record, "live_chat_refreshed", { chatId, updateType: type });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLiveSync(record, "live_chat_refresh_error", { chatId, message });
  }
}

function scheduleChatRefresh(record: LiveSyncRecord, chatId: number, update: Record<string, unknown>): void {
  const userKey = record.telegramUsername;
  let userTimers = refreshTimers.get(userKey);
  if (!userTimers) {
    userTimers = new Map();
    refreshTimers.set(userKey, userTimers);
  }
  if (userTimers.has(chatId)) return;

  const timer = setTimeout(() => {
    userTimers!.delete(chatId);
    void applyLiveUpdate(record, update);
  }, CHAT_REFRESH_DEBOUNCE_MS);

  userTimers.set(chatId, timer);
  logLiveSync(record, "live_chat_refresh_scheduled", {
    chatId,
    updateType: update._,
    debounceMs: CHAT_REFRESH_DEBOUNCE_MS,
  });
}

export function attachLiveChatSync(record: LiveSyncRecord): void {
  const client = record.client;
  if (!client || attachedClients.has(client)) return;
  attachedClients.add(client);

  client.on("update", (update: Record<string, unknown>) => {
    if (record.authState !== "ready") return;
    const type = update._;
    // Always ingest voice roster updates — they are not chat-list events.
    if (type === "updateGroupCallParticipant") {
      ingestGroupCallParticipantUpdate(update);
      return;
    }
    if (type === "updateGroupCall") {
      ingestGroupCallUpdate(update);
      // Keep chat-list rings in sync with getGroupCall participant counts —
      // syncChats verify is one-shot and message upserts must not be the only
      // path that can clear/paint spectator live (Blox Fruits mid-call).
      const groupCall = update.group_call as
        | {
            id?: number;
            participant_count?: number;
            is_active?: boolean;
            is_joined?: boolean;
            need_rejoin?: boolean;
            has_hidden_listeners?: boolean;
            recent_speakers?: unknown[];
          }
        | undefined;
      const callId = normalizeTelegramGroupCallId(groupCall?.id) ?? 0;
      if (callId > 0 && groupCall) {
        const live = groupCallLooksLive(groupCall);
        const list = getLiveChatList(record.telegramUsername) ?? [];
        for (const row of list) {
          if (row.voice_chat_group_call_id !== callId) continue;
          // Never set joined=true here — sticky TDLib is_joined painted green
          // while the web client was not in the call. Preserve an existing
          // client-owned joined flag while the call stays live.
          patchLiveChatVideoChat(record.telegramUsername, row.telegram_chat_id, {
            has_active_voice_chat: live,
            voice_chat_group_call_id: callId,
            voice_chat_is_joined: live ? Boolean(row.voice_chat_is_joined) : false,
          });
        }
      }
      return;
    }
    if (type === "updateCall" || type === "updateNewCallSignalingData") {
      void import("./privateCall.js").then(({ applyPrivateCallUpdate }) => {
        applyPrivateCallUpdate(record.telegramUsername, update, record.client);
      });
      return;
    }
    if (type === "updateNewGroupCallMessage") {
      ingestNewGroupCallMessage(update, {
        telegramUsername: record.telegramUsername,
      });
      return;
    }
    if (typeof type !== "string" || !LIVE_UPDATE_TYPES.has(type)) return;

    if (type === "updateNewMessage" || type === "updateChatLastMessage" || type === "updateUserStatus" || type === "updateUser" || type === "updateUserEmojiStatus" || type === "updateUserChatAction" || type === "updateChatReadOutbox") {
      void applyLiveUpdate(record, update);
      return;
    }

    if (type === "updateDeleteMessages") {
      const chatId = update.chat_id;
      const fromCache = Boolean(update.from_cache);
      const rawIds = Array.isArray(update.message_ids) ? update.message_ids : [];
      const messageIds = rawIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id));
      if (typeof chatId === "number" && !fromCache && messageIds.length > 0) {
        if (noteLiveChatMessageDeletes(record.telegramUsername, chatId, messageIds)) {
          bumpLiveChatRevision(record.telegramUsername);
          bumpLiveChatMessageRevision(record.telegramUsername, chatId);
          logLiveSync(record, "live_chat_messages_deleted", {
            chatId,
            count: messageIds.length,
          });
        }
      }
      if (typeof chatId === "number") {
        scheduleChatRefresh(record, chatId, update);
      }
      return;
    }

    if (type === "updateMessageEdited" || type === "updateMessageContent") {
      const chatId = chatIdFromUpdate(update);
      if (chatId != null) {
        bumpLiveChatMessageRevision(record.telegramUsername, chatId);
        scheduleChatRefresh(record, chatId, update);
      }
      return;
    }

    const chatId = chatIdFromUpdate(update);
    if (chatId == null) return;
    scheduleChatRefresh(record, chatId, update);
  });

  logLiveSync(record, "live_chat_sync_attached");
}

export function detachLiveChatSync(telegramUsername: string): void {
  const userTimers = refreshTimers.get(telegramUsername);
  if (userTimers) {
    for (const timer of userTimers.values()) clearTimeout(timer);
    refreshTimers.delete(telegramUsername);
  }
  clearLiveChatCache(telegramUsername);
  clearLiveChatMessageRevisions(telegramUsername);
}
