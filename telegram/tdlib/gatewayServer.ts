import http from "http";
import { URL } from "url";
import { getGatewayBindHost, getGatewayPort, getGatewaySecret, getTdlibDbRoot } from "./env.js";
import { logGateway } from "./gatewayLog.js";
import { safeTelegramUserIdForLog } from "../../shared/appLog.js";
import { serveLiveChatRevisionStream } from "./liveChatStream.js";
import { buildChatListSyncStatus } from "./chatListSyncState.js";
import {
  disconnectUserSession,
  gatewayHealth,
  getChatAvatarImageForUser,
  getChatHistoryForUser,
  getTelegramEmojiForUser,
  getMessageMediaForUser,
  getUserAvatarImageForUser,
  getConnectAttempt,
  getLiveChatList,
  getLiveChatListRevision,
  getUserConnectSnapshot,
  resyncUserChats,
  requestBackgroundChatSync,
  restorePersistedGatewaySessions,
  resumeExistingSession,
  hasPersistedTdlibSession,
  listPersistedSessionUsernames,
  RESYNC_HTTP_SESSION_WAIT_MS,
  RESYNC_RESTORE_SESSION_WAIT_MS,
  searchChatsForUser,
  searchContactsForUser,
  focusChatForUser,
  viewChatInboxMessagesForUser,
  startConnectAttempt,
  resendConnectCode,
  submitConnectCode,
  submitConnectPassword,
  submitConnectPhoneNumber,
  sendChatMessageForUser,
  sendChatPhotoForUser,
  leaveChatVoiceForUser,
  getChatVoiceParticipantsForUser,
  editChatMessageForUser,
  resolvePublicChatForUser,
} from "./connectAttempts.js";

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(json);
}

function authorized(req: http.IncomingMessage): boolean {
  const secret = getGatewaySecret();
  const header = req.headers["x-gateway-secret"];
  return typeof header === "string" && header === secret;
}

function liveChatPeerUserIdForLog(telegramUsername: string, chatId: number): number | undefined {
  const row = getLiveChatList(telegramUsername)?.find((c) => c.telegram_chat_id === chatId);
  return safeTelegramUserIdForLog(row?.peer_user_id);
}

export function startTdlibGatewayServer(): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!req.url) {
          sendJson(res, 400, { ok: false, error: "bad_request" });
          return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        const pathname = url.pathname;

        if (req.method === "GET" && (pathname === "/" || pathname === "/v1/health")) {
          const persistedUsernames = listPersistedSessionUsernames();
          const persistedSessions = persistedUsernames.length;
          const body = {
            ...gatewayHealth(),
            persistedSessions,
            tdlibDbRoot: getTdlibDbRoot(),
            hint: "TDLib gateway is running",
          };
          logGateway("health", {
            method: req.method,
            path: pathname,
            remote: req.socket.remoteAddress ?? null,
            persistedSessions,
          });
          sendJson(res, 200, body);
          return;
        }

        if (!authorized(req)) {
          logGateway("unauthorized", { method: req.method, path: pathname });
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/connect/persisted") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const persisted = hasPersistedTdlibSession(telegramUsername);
          sendJson(res, 200, { ok: true, persisted, telegramUsername });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/start") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            resume?: boolean;
            fresh?: boolean;
            resumeOnly?: boolean;
            authMethod?: "qr" | "phone";
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const authMethod = body.authMethod === "phone" ? "phone" : "qr";
          logGateway("connect_start", {
            telegramUsername: telegramUsername || null,
            resume: Boolean(body.resume),
            fresh: Boolean(body.fresh),
            authMethod,
          });
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          let snap = body.resume
            ? await resumeExistingSession(telegramUsername, { authMethod })
            : await startConnectAttempt(telegramUsername, {
                fresh: Boolean(body.fresh),
                authMethod,
              });
          if (body.resume && snap.authState === "failed" && snap.error === "no_session" && !body.resumeOnly) {
            logGateway("connect_start_no_session_fallback", { telegramUsername });
            snap = await startConnectAttempt(telegramUsername, { authMethod });
          }
          logGateway("connect_start_result", {
            telegramUsername,
            authState: snap.authState,
            error: snap.error,
            hasQrLink: Boolean(snap.qrLink),
          });
          sendJson(res, 200, { ok: snap.authState !== "failed" || Boolean(snap.attemptId), ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/resync") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatIds?: number[];
            maxWaitMs?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const chatIds = Array.isArray(body.chatIds)
            ? body.chatIds.filter((id) => typeof id === "number" && Number.isFinite(id))
            : undefined;
          const maxWaitMs =
            typeof body.maxWaitMs === "number" && Number.isFinite(body.maxWaitMs) && body.maxWaitMs > 0
              ? Math.min(body.maxWaitMs, RESYNC_RESTORE_SESSION_WAIT_MS)
              : RESYNC_HTTP_SESSION_WAIT_MS;
          const result = await resyncUserChats(
            telegramUsername,
            chatIds?.length ? { chatIds, maxWaitMs } : { maxWaitMs },
          );
          sendJson(res, 200, {
            ok: !result.error,
            chatCount: result.chatCount,
            backfillCount: result.backfillCount,
            error: result.error,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/users/search") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const query = (url.searchParams.get("query") || "").trim();
          if (!telegramUsername || !query) {
            sendJson(res, 400, { ok: false, error: "username_and_query_required" });
            return;
          }
          const [contacts, chats] = await Promise.all([
            searchContactsForUser(telegramUsername, query),
            searchChatsForUser(telegramUsername, query),
          ]);
          logGateway("users_search_served", {
            telegramUsername,
            query,
            contactCount: contacts.length,
            chatCount: chats.length,
            userIds: contacts
              .map((row) => safeTelegramUserIdForLog(row.userId))
              .filter((id): id is number => id != null)
              .join(","),
            chatPeerUserIds: chats
              .map((row) => safeTelegramUserIdForLog(row.peerUserId))
              .filter((id): id is number => id != null)
              .join(","),
          });
          sendJson(res, 200, { ok: true, contacts, chats });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chats/list") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          const revision = getLiveChatListRevision(telegramUsername);
          if (
            sinceRevision != null &&
            Number.isFinite(sinceRevision) &&
            sinceRevision > 0 &&
            sinceRevision === revision
          ) {
            sendJson(res, 200, {
              ok: true,
              unchanged: true,
              source: "live",
              revision,
              chatListSync: buildChatListSyncStatus(telegramUsername),
            });
            return;
          }
          const chats = getLiveChatList(telegramUsername);
          const currentRevision = getLiveChatListRevision(telegramUsername);
          const missingPreviewCount = (chats ?? []).filter(
            (row) => typeof row.subtitle !== "string" || row.subtitle.trim().length === 0,
          ).length;
          const missingAvatarCount = (chats ?? []).filter((row) => !row.avatar_url).length;
          const first = chats?.[0];
          logGateway("chats_list_served", {
            telegramUsername,
            count: chats?.length ?? 0,
            revision: currentRevision,
            missingPreviewCount,
            missingAvatarCount,
            firstId: first?.telegram_chat_id ?? null,
            firstUserId: safeTelegramUserIdForLog(first?.peer_user_id) ?? null,
            firstTitle: first?.title?.trim() || null,
          });
          sendJson(res, 200, {
            ok: true,
            source: "live",
            revision: currentRevision,
            chats: chats ?? [],
            chatListSync: buildChatListSyncStatus(telegramUsername),
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chats/load-more") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            tier?: "positioned" | "unpositioned";
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const tier = body.tier === "unpositioned" ? "unpositioned" : "positioned";
          const result = requestBackgroundChatSync(telegramUsername, tier);
          sendJson(res, 200, {
            ok: true,
            started: result.started,
            warming: result.warming === true,
            tier,
            chatListSync: buildChatListSyncStatus(telegramUsername),
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chats/stream") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          serveLiveChatRevisionStream(
            req,
            res,
            telegramUsername,
            sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : null,
          );
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chats/focus") {
          const body = (await readJson(req)) as { telegramUsername?: string; chatId?: number };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "username_and_chat_id_required" });
            return;
          }
          const result = await focusChatForUser(telegramUsername, chatId);
          sendJson(res, result.ok ? 200 : 503, { ok: result.ok, error: result.error ?? null });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chats/view-inbox") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            messageId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const messageId = Number(body.messageId);
          if (!telegramUsername || !Number.isFinite(chatId) || !Number.isFinite(messageId)) {
            sendJson(res, 400, { ok: false, error: "username_chat_id_and_message_id_required" });
            return;
          }
          const result = await viewChatInboxMessagesForUser(
            telegramUsername,
            chatId,
            messageId,
          );
          if (result.error) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 502, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            unread_count: result.unread_count,
            last_read_inbox_message_id: result.last_read_inbox_message_id,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/messages") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const limit = Number(url.searchParams.get("limit") || "50");
          const beforeMessageIdRaw = url.searchParams.get("beforeMessageId");
          const beforeMessageId =
            beforeMessageIdRaw != null && beforeMessageIdRaw.trim() !== ""
              ? Number(beforeMessageIdRaw)
              : null;
          const sinceMessageIdRaw = url.searchParams.get("sinceMessageId");
          const sinceMessageId =
            sinceMessageIdRaw != null && sinceMessageIdRaw.trim() !== ""
              ? Number(sinceMessageIdRaw)
              : null;
          const aroundUnread = url.searchParams.get("aroundUnread") === "1";
          const aroundMessageIdRaw = url.searchParams.get("aroundMessageId");
          const aroundMessageId =
            aroundMessageIdRaw != null && aroundMessageIdRaw.trim() !== ""
              ? Number(aroundMessageIdRaw)
              : null;
          const olderAboveRaw = url.searchParams.get("olderAbove");
          const olderAbove =
            olderAboveRaw != null && olderAboveRaw.trim() !== ""
              ? Number(olderAboveRaw)
              : null;
          const newerBelowRaw = url.searchParams.get("newerBelow");
          const newerBelow =
            newerBelowRaw != null && newerBelowRaw.trim() !== ""
              ? Number(newerBelowRaw)
              : null;
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (
            Number.isFinite(beforeMessageId) &&
            Number.isFinite(sinceMessageId) &&
            beforeMessageId! > 0 &&
            sinceMessageId! > 0
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (aroundUnread && (Number.isFinite(beforeMessageId) || Number.isFinite(sinceMessageId))) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (
            Number.isFinite(aroundMessageId) &&
            aroundMessageId! > 0 &&
            (Number.isFinite(beforeMessageId) || Number.isFinite(sinceMessageId) || aroundUnread)
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await getChatHistoryForUser(
            telegramUsername,
            chatId,
            limit,
            Number.isFinite(beforeMessageId) ? beforeMessageId : null,
            Number.isFinite(sinceMessageId) ? sinceMessageId : null,
            aroundUnread,
            Number.isFinite(aroundMessageId) ? aroundMessageId : null,
            Number.isFinite(olderAbove) ? olderAbove : null,
            Number.isFinite(newerBelow) ? newerBelow : null,
          );
          logGateway("chat_history_served", {
            telegramUsername,
            chatId,
            userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
            beforeMessageId: Number.isFinite(beforeMessageId) ? beforeMessageId : null,
            sinceMessageId: Number.isFinite(sinceMessageId) ? sinceMessageId : null,
            aroundUnread,
            aroundMessageId: Number.isFinite(aroundMessageId) ? aroundMessageId : null,
            count: result.messages.length,
            hasMoreOlder: result.has_more_older,
            nextBeforeMessageId: result.next_before_message_id,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            chat_kind: result.chat_kind,
            member_count: result.member_count,
            self_user_id: result.self_user_id,
            messages: result.messages,
            has_more_older: !result.error && result.has_more_older,
            next_before_message_id: result.next_before_message_id,
            last_read_outbox_message_id: result.last_read_outbox_message_id,
            last_read_inbox_message_id: result.last_read_inbox_message_id,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/messages/send") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            text?: string;
            replyToMessageId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const text = typeof body.text === "string" ? body.text : "";
          const replyToMessageId = Number(body.replyToMessageId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await sendChatMessageForUser(
            telegramUsername,
            chatId,
            text,
            Number.isFinite(replyToMessageId) && replyToMessageId > 0
              ? Math.trunc(replyToMessageId)
              : null,
          );
          logGateway("chat_message_sent", {
            telegramUsername,
            chatId,
            userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
            ok: !result.error,
            messageId: result.message?.telegram_message_id ?? null,
            replyToMessageId:
              Number.isFinite(replyToMessageId) && replyToMessageId > 0
                ? Math.trunc(replyToMessageId)
                : null,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            message: result.message,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/messages/send-photo") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            photoBase64?: string;
            caption?: string;
            mime?: string;
            replyToMessageId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const photoBase64 = typeof body.photoBase64 === "string" ? body.photoBase64 : "";
          const caption = typeof body.caption === "string" ? body.caption : "";
          const mime = typeof body.mime === "string" ? body.mime : "image/jpeg";
          const replyToMessageId = Number(body.replyToMessageId);
          if (!telegramUsername || !Number.isFinite(chatId) || !photoBase64) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await sendChatPhotoForUser(telegramUsername, chatId, photoBase64, {
            caption,
            mime,
            replyToMessageId:
              Number.isFinite(replyToMessageId) && replyToMessageId > 0
                ? Math.trunc(replyToMessageId)
                : null,
          });
          logGateway("chat_photo_sent", {
            telegramUsername,
            chatId,
            ok: !result.error,
            messageId: result.message?.telegram_message_id ?? null,
            bytes: Math.floor((photoBase64.length * 3) / 4),
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            message: result.message,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/leave") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = Number(body.groupCallId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await leaveChatVoiceForUser(
            telegramUsername,
            chatId,
            Number.isFinite(groupCallId) && groupCallId > 0 ? Math.trunc(groupCallId) : null,
          );
          logGateway("chat_voice_leave", {
            telegramUsername,
            chatId,
            ok: result.ok,
            groupCallId: result.voice_chat_group_call_id,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            has_active_voice_chat: result.has_active_voice_chat,
            voice_chat_group_call_id: result.voice_chat_group_call_id,
            error: result.error,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/voice/participants") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const groupCallId = Number(url.searchParams.get("groupCallId"));
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await getChatVoiceParticipantsForUser(
            telegramUsername,
            chatId,
            Number.isFinite(groupCallId) && groupCallId > 0 ? Math.trunc(groupCallId) : null,
          );
          logGateway("chat_voice_participants", {
            telegramUsername,
            chatId,
            ok: result.ok,
            count: result.participants.length,
            participantCount: result.participant_count,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            participants: result.participants,
            participant_count: result.participant_count,
            error: result.error,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/resolve") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const username = (url.searchParams.get("username") || "").trim();
          if (!telegramUsername || !username) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await resolvePublicChatForUser(telegramUsername, username);
          logGateway("chat_resolve", {
            telegramUsername,
            username,
            ok: !result.error,
            chatId: result.chat?.telegram_chat_id ?? null,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            chat: result.chat,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/messages/edit") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            messageId?: number;
            text?: string;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const messageId = Number(body.messageId);
          const text = typeof body.text === "string" ? body.text : "";
          if (!telegramUsername || !Number.isFinite(chatId) || !Number.isFinite(messageId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await editChatMessageForUser(telegramUsername, chatId, messageId, text);
          logGateway("chat_message_edited", {
            telegramUsername,
            chatId,
            userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
            ok: !result.error,
            messageId: result.message?.telegram_message_id ?? messageId,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            message: result.message,
            error: result.error,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/message-media") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const messageId = Number(url.searchParams.get("messageId"));
          if (!telegramUsername || !Number.isFinite(chatId) || !Number.isFinite(messageId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const previewParam = (url.searchParams.get("preview") || "").trim();
          const mode = previewParam === "1" || previewParam === "true" ? "preview" : "full";
          const media = await getMessageMediaForUser(telegramUsername, chatId, messageId, mode);
          if (!media) {
            logGateway("message_media_unavailable", {
              telegramUsername,
              chatId,
              messageId,
              ms: Date.now() - started,
            });
            sendJson(res, 404, { ok: false, error: "media_unavailable" });
            return;
          }
          logGateway("message_media_ok", {
            telegramUsername,
            chatId,
            messageId,
            bytes: media.data.length,
            mime: media.mime,
            ms: Date.now() - started,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", media.mime);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(media.data);
          return;
        }

        if (req.method === "GET" && pathname === "/v1/custom-emoji") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const customEmojiId = (url.searchParams.get("customEmojiId") || "").trim();
          const emoji = (url.searchParams.get("emoji") || "").trim();
          logGateway("custom_emoji_request", {
            telegramUsername: telegramUsername || null,
            hasCustomEmojiId: Boolean(customEmojiId),
            hasEmoji: Boolean(emoji),
          });
          if (!telegramUsername || (!customEmojiId && !emoji)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const sticker = await getTelegramEmojiForUser(telegramUsername, { customEmojiId, emoji });
          if (!sticker) {
            logGateway("custom_emoji_unavailable", {
              telegramUsername,
              customEmojiId: customEmojiId || null,
              emoji: emoji || null,
              ms: Date.now() - started,
            });
            sendJson(res, 404, { ok: false, error: "custom_emoji_unavailable" });
            return;
          }
          logGateway("custom_emoji_served", {
            telegramUsername,
            customEmojiId: customEmojiId || null,
            emoji: emoji || null,
            bytes: sticker.data.length,
            mime: sticker.mime,
            ms: Date.now() - started,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", sticker.mime);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(sticker.data);
          return;
        }

        if (req.method === "GET" && pathname === "/v1/user/avatar") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const userId = Number(url.searchParams.get("userId"));
          if (!telegramUsername || !Number.isFinite(userId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const avatar = await getUserAvatarImageForUser(telegramUsername, userId);
          if (avatar === "no_avatar") {
            sendJson(res, 404, { ok: false, error: "no_avatar" });
            return;
          }
          if (!avatar) {
            sendJson(res, 503, { ok: false, error: "avatar_unavailable" });
            return;
          }
          logGateway("user_avatar_ok", {
            telegramUsername,
            userId,
            bytes: avatar.data.length,
            ms: Date.now() - started,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", avatar.mime);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(avatar.data);
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/avatar") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          if (!telegramUsername || !Number.isFinite(chatId)) {
            logGateway("chat_avatar_invalid_params", {
              telegramUsername: telegramUsername || null,
              chatId: Number.isFinite(chatId) ? chatId : null,
            });
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const avatar = await getChatAvatarImageForUser(telegramUsername, chatId);
          if (avatar === "no_avatar") {
            logGateway("chat_avatar_no_avatar", {
              telegramUsername,
              chatId,
              userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
              ms: Date.now() - started,
            });
            sendJson(res, 404, { ok: false, error: "no_avatar" });
            return;
          }
          if (!avatar) {
            logGateway("chat_avatar_unavailable", {
              telegramUsername,
              chatId,
              userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
              ms: Date.now() - started,
            });
            sendJson(res, 503, { ok: false, error: "avatar_unavailable" });
            return;
          }
          logGateway("chat_avatar_ok", {
            telegramUsername,
            chatId,
            userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
            bytes: avatar.data.length,
            mime: avatar.mime,
            ms: Date.now() - started,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", avatar.mime);
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(avatar.data);
          return;
        }

        if (req.method === "GET" && pathname === "/v1/connect/status") {
          const attemptId = (url.searchParams.get("attemptId") || "").trim();
          if (!attemptId) {
            sendJson(res, 400, { ok: false, error: "attempt_id_required" });
            return;
          }
          const snap = getConnectAttempt(attemptId);
          if (!snap) {
            sendJson(res, 404, { ok: false, error: "attempt_not_found" });
            return;
          }
          sendJson(res, 200, { ok: true, ...snap });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/connect/user-status") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          const snap = getUserConnectSnapshot(telegramUsername);
          if (!snap) {
            sendJson(res, 200, { ok: true, active: false });
            return;
          }
          sendJson(res, 200, { ok: true, active: true, ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/phone") {
          const body = (await readJson(req)) as {
            attemptId?: string;
            phoneNumber?: string;
            isCurrentPhoneNumber?: boolean;
          };
          const attemptId = (body.attemptId || "").trim();
          const phoneNumber = body.phoneNumber || "";
          if (!attemptId || !phoneNumber.trim()) {
            sendJson(res, 400, { ok: false, error: "attempt_id_and_phone_required" });
            return;
          }
          const snap = await submitConnectPhoneNumber(attemptId, phoneNumber, {
            isCurrentPhoneNumber: Boolean(body.isCurrentPhoneNumber),
          });
          if (!snap) {
            sendJson(res, 404, { ok: false, error: "attempt_not_found" });
            return;
          }
          sendJson(res, 200, { ok: true, ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/code/resend") {
          const body = (await readJson(req)) as { attemptId?: string };
          const attemptId = (body.attemptId || "").trim();
          if (!attemptId) {
            sendJson(res, 400, { ok: false, error: "attempt_id_required" });
            return;
          }
          const snap = await resendConnectCode(attemptId);
          if (!snap) {
            sendJson(res, 404, { ok: false, error: "attempt_not_found" });
            return;
          }
          sendJson(res, 200, { ok: true, ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/code") {
          const body = (await readJson(req)) as { attemptId?: string; code?: string };
          const attemptId = (body.attemptId || "").trim();
          const code = body.code || "";
          if (!attemptId || !code.trim()) {
            sendJson(res, 400, { ok: false, error: "attempt_id_and_code_required" });
            return;
          }
          const snap = await submitConnectCode(attemptId, code);
          if (!snap) {
            sendJson(res, 404, { ok: false, error: "attempt_not_found" });
            return;
          }
          sendJson(res, 200, { ok: true, ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/connect/password") {
          const body = (await readJson(req)) as { attemptId?: string; password?: string };
          const attemptId = (body.attemptId || "").trim();
          const password = body.password || "";
          if (!attemptId || !password) {
            sendJson(res, 400, { ok: false, error: "attempt_id_and_password_required" });
            return;
          }
          const snap = await submitConnectPassword(attemptId, password);
          if (!snap) {
            sendJson(res, 404, { ok: false, error: "attempt_not_found" });
            return;
          }
          sendJson(res, 200, { ok: true, ...snap });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/disconnect") {
          const body = (await readJson(req)) as { telegramUsername?: string };
          const telegramUsername = (body.telegramUsername || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          await disconnectUserSession(telegramUsername);
          sendJson(res, 200, { ok: true, disconnected: true });
          return;
        }

        logGateway("route_not_found", { method: req.method, path: pathname });
        sendJson(res, 404, { ok: false, error: "not_found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal_error";
        sendJson(res, 500, { ok: false, error: message });
      }
    })();
  });

  const port = getGatewayPort();
  const host = getGatewayBindHost();
  server.listen(port, host, () => {
    logGateway("listening", { url: `http://${host}:${port}` });
    restorePersistedGatewaySessions();
  });

  return server;
}
