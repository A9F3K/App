import http from "http";
import { URL } from "url";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { getGatewayBindHost, getGatewayPort, getGatewaySecret, getTdlibDbRoot } from "./env.js";
import { logGateway } from "./gatewayLog.js";
import { safeTelegramUserIdForLog } from "../../shared/appLog.js";
import { serveLiveChatRevisionStream } from "./liveChatStream.js";
import { serveLiveChatMessageRevisionStream } from "./liveChatMessageStream.js";
import { serveVoiceParticipantsStream } from "./voiceParticipantsStream.js";
import { serveVoiceCallMessagesStream } from "./voiceCallMessagesStream.js";
import { buildChatListSyncStatus } from "./chatListSyncState.js";
import {
  gatewayStreamKindForPath,
  verifyStreamTicket,
  type StreamTicketPayload,
} from "./streamTicket.js";
import { attachPrivateCallAudioWebSocket } from "./privateCallAudioStream.js";
import { attachPrivateCallVideoWebSocket } from "./privateCallVideoStream.js";
import {
  disconnectUserSession,
  gatewayHealth,
  getChatAvatarImageForUser,
  getChatHistoryForUser,
  getTelegramEmojiForUser,
  getMessageMediaForUser,
  getUserAvatarImageForUser,
  getUserProfileForUser,
  getProfileAudioFileForUser,
  getProfileAudioCoverForUser,
  blockUserForUser,
  unblockUserForUser,
  searchChatLinksForUser,
  searchChatMediaForUser,
  createPrivateCallForSession,
  getPrivateCallForSession,
  discardPrivateCallForSession,
  acceptPrivateCallForSession,
  sendPrivateCallSignalingForSession,
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
  ensureGatewayUserSession,
  RESYNC_HTTP_SESSION_WAIT_MS,
  RESYNC_RESTORE_SESSION_WAIT_MS,
  searchChatsForUser,
  searchChatsCategorizedForUser,
  searchContactsForUser,
  searchMessagesForUser,
  searchRecentlyFoundChatsForUser,
  addRecentlyFoundChatForUser,
  removeRecentlyFoundChatForUser,
  clearRecentlyFoundChatsForUser,
  hydrateChatSearchHitsForUser,
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
  joinChatVoiceForUser,
  startChatVoiceScreenShareForUser,
  endChatVoiceScreenShareForUser,
  sendChatVoiceCallMessageForUser,
  startChatVoiceForUser,
  setChatVoiceMicMutedForUser,
  setChatVoiceParticipantVolumeForUser,
  setChatVoiceParticipantSpeakingForUser,
  getChatVoiceParticipantsForUser,
  editChatMessageForUser,
  deleteChatMessagesForUser,
  resolvePublicChatForUser,
} from "./connectAttempts.js";
import {
  pinGatewayUserSession,
  startClientIdleSweeper,
  touchGatewayUserActivity,
  unpinGatewayUserSession,
} from "./clientIdle.js";

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

function applyGatewayBrowserCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim()) {
    res.setHeader("Access-Control-Allow-Origin", origin.trim());
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function authorizeStreamRequest(
  req: http.IncomingMessage,
  url: URL,
  pathname: string,
): { ok: true; via: "secret" | "ticket"; ticket: StreamTicketPayload | null } | { ok: false } {
  if (authorized(req)) {
    return { ok: true, via: "secret", ticket: null };
  }
  const streamKind = gatewayStreamKindForPath(pathname);
  if (!streamKind) return { ok: false };
  const token = (url.searchParams.get("streamTicket") || "").trim();
  if (!token) return { ok: false };
  const chatIdRaw = Number(url.searchParams.get("chatId"));
  const chatId =
    Number.isFinite(chatIdRaw) && chatIdRaw !== 0 ? Math.trunc(chatIdRaw) : null;
  const groupCallIdRaw = Number(url.searchParams.get("groupCallId"));
  const groupCallId =
    Number.isFinite(groupCallIdRaw) && groupCallIdRaw > 0
      ? Math.trunc(groupCallIdRaw)
      : null;
  const ticket = verifyStreamTicket(token, {
    stream: streamKind,
    chatId: streamKind === "chats" ? null : chatId,
    groupCallId,
  });
  if (!ticket) return { ok: false };
  return { ok: true, via: "ticket", ticket };
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

        if (req.method === "OPTIONS") {
          applyGatewayBrowserCors(req, res);
          res.statusCode = 204;
          res.end();
          return;
        }

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

        const streamAuth = authorizeStreamRequest(req, url, pathname);
        if (!streamAuth.ok) {
          logGateway("unauthorized", { method: req.method, path: pathname });
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        if (streamAuth.via === "ticket") {
          applyGatewayBrowserCors(req, res);
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

        if (req.method === "GET" && pathname === "/v1/chats/search") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const query = (url.searchParams.get("query") || "").trim();
          if (!telegramUsername || !query) {
            sendJson(res, 400, { ok: false, error: "username_and_query_required" });
            return;
          }
          const messageSearchWithBudget = Promise.race([
            searchMessagesForUser(telegramUsername, query),
            new Promise<{ chatIds: number[]; messageCount: number }>((resolve) => {
              setTimeout(() => resolve({ chatIds: [], messageCount: 0 }), 6_000);
            }),
          ]);
          const [contacts, categorized, messageSearch] = await Promise.all([
            searchContactsForUser(telegramUsername, query),
            searchChatsCategorizedForUser(telegramUsername, query),
            messageSearchWithBudget,
          ]);
          type SearchChatRow = {
            chatId: number;
            title: string;
            peerUserId: number | null;
            peerUsername: string | null;
            chatUsername: string | null;
            chatKind: string | null;
          };
          const directByChatId = new Map<number, SearchChatRow>();
          const globalByChatId = new Map<number, SearchChatRow>();
          const peerUserIds = new Set<number>();
          const ingestHit = (bucket: Map<number, SearchChatRow>, row: {
            chatId: number;
            title: string;
            peerUserId: number | null;
            peerUsername: string | null;
            chatUsername: string | null;
            chatKind: string | null;
          }) => {
            if (!Number.isFinite(row.chatId) || row.chatId === 0) return;
            bucket.set(Math.trunc(row.chatId), {
              chatId: Math.trunc(row.chatId),
              title: row.title,
              peerUserId: row.peerUserId,
              peerUsername: row.peerUsername,
              chatUsername: row.chatUsername,
              chatKind: row.chatKind,
            });
            if (row.peerUserId != null && Number.isFinite(row.peerUserId) && row.peerUserId !== 0) {
              peerUserIds.add(Math.trunc(row.peerUserId));
            }
          };
          for (const row of categorized.direct) {
            ingestHit(directByChatId, row);
          }
          for (const row of categorized.global) {
            if (directByChatId.has(Math.trunc(row.chatId))) continue;
            ingestHit(globalByChatId, row);
          }
          for (const row of contacts) {
            if (row.chatId != null && Number.isFinite(row.chatId) && row.chatId !== 0) {
              const chatId = Math.trunc(row.chatId);
              if (!directByChatId.has(chatId)) {
                const title = [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
                  || row.username
                  || `User ${row.userId}`;
                ingestHit(directByChatId, {
                  chatId,
                  title,
                  peerUserId: Math.trunc(row.userId),
                  peerUsername: row.username,
                  chatUsername: null,
                  chatKind: "private",
                });
              }
            }
            if (Number.isFinite(row.userId) && row.userId !== 0) {
              peerUserIds.add(Math.trunc(row.userId));
            }
          }
          const messageByChatId = new Map<number, SearchChatRow>();
          const missingMessageIds = messageSearch.chatIds.filter((chatId) => {
            const id = Math.trunc(chatId);
            return (
              Number.isFinite(id) &&
              id !== 0 &&
              !directByChatId.has(id) &&
              !globalByChatId.has(id)
            );
          });
          if (missingMessageIds.length > 0) {
            const hydrated = await hydrateChatSearchHitsForUser(
              telegramUsername,
              missingMessageIds,
            );
            for (const row of hydrated) {
              ingestHit(messageByChatId, row);
            }
          }
          const directChats = [...directByChatId.values()];
          const globalChats = [...globalByChatId.values()];
          const messageChats = [...messageByChatId.values()];
          const chatRows = [...directChats, ...globalChats, ...messageChats];
          logGateway("chats_search_served", {
            telegramUsername,
            query,
            contactCount: contacts.length,
            directChatCount: directChats.length,
            globalChatCount: globalChats.length,
            messageChatCount: messageChats.length,
            messageCount: messageSearch.messageCount,
            chatIdCount: chatRows.length,
            peerUserIdCount: peerUserIds.size,
            sampleTitles: chatRows
              .slice(0, 5)
              .map((row) => row.title)
              .join(" | "),
          });
          sendJson(res, 200, {
            ok: true,
            chatIds: chatRows.map((row) => row.chatId),
            peerUserIds: [...peerUserIds],
            chats: chatRows,
            directChats,
            globalChats,
            messageChats,
            messageChatIds: messageSearch.chatIds,
            messageCount: messageSearch.messageCount,
            contacts,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chats/recent") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "telegram_username_required" });
            return;
          }
          const chats = await searchRecentlyFoundChatsForUser(telegramUsername);
          const peerUserIds = [
            ...new Set(
              chats
                .map((row) => row.peerUserId)
                .filter((id): id is number => id != null && Number.isFinite(id) && id !== 0)
                .map((id) => Math.trunc(id)),
            ),
          ];
          logGateway("chats_recent_served", {
            telegramUsername,
            chatCount: chats.length,
            sampleTitles: chats
              .slice(0, 5)
              .map((row) => row.title)
              .join(" | "),
          });
          sendJson(res, 200, {
            ok: true,
            chatIds: chats.map((row) => row.chatId),
            peerUserIds,
            chats,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chats/recent") {
          const body = (await readJson(req)) as {
            telegramUsername?: unknown;
            chatId?: unknown;
            chat_id?: unknown;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const chatId = Number(body.chatId ?? body.chat_id);
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0) {
            sendJson(res, 400, { ok: false, error: "username_and_chat_id_required" });
            return;
          }
          const ok = await addRecentlyFoundChatForUser(telegramUsername, chatId);
          sendJson(res, ok ? 200 : 502, { ok });
          return;
        }

        if (req.method === "DELETE" && pathname === "/v1/chats/recent") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "telegram_username_required" });
            return;
          }
          const chatIdRaw = url.searchParams.get("chatId") ?? url.searchParams.get("chat_id");
          const chatId = chatIdRaw != null ? Number(chatIdRaw) : NaN;
          if (Number.isFinite(chatId) && chatId !== 0) {
            const ok = await removeRecentlyFoundChatForUser(telegramUsername, chatId);
            sendJson(res, ok ? 200 : 502, { ok });
            return;
          }
          const ok = await clearRecentlyFoundChatsForUser(telegramUsername);
          sendJson(res, ok ? 200 : 502, { ok });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chats/list") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "username_required" });
            return;
          }
          touchGatewayUserActivity(telegramUsername);
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          let revision = getLiveChatListRevision(telegramUsername);
          let chats = getLiveChatList(telegramUsername);
          const needsWake =
            hasPersistedTdlibSession(telegramUsername) &&
            (revision <= 0 || !chats || chats.length === 0);
          if (needsWake) {
            const woken = await ensureGatewayUserSession(
              telegramUsername,
              RESYNC_HTTP_SESSION_WAIT_MS,
            );
            if (woken?.client && woken.authState === "ready") {
              revision = getLiveChatListRevision(telegramUsername);
              chats = getLiveChatList(telegramUsername);
            }
          }
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
            woken: needsWake,
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
            warming: needsWake && (chats?.length ?? 0) === 0,
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
          const telegramUsername = (
            streamAuth.ticket?.sub ||
            url.searchParams.get("telegramUsername") ||
            ""
          ).trim();
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
            {
              onOpen: () => {
                pinGatewayUserSession(telegramUsername, "chats_stream");
                void ensureGatewayUserSession(telegramUsername, RESYNC_HTTP_SESSION_WAIT_MS);
              },
              onClose: () => unpinGatewayUserSession(telegramUsername, "chats_stream"),
            },
          );
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/messages/stream") {
          const telegramUsername = (
            streamAuth.ticket?.sub ||
            url.searchParams.get("telegramUsername") ||
            ""
          ).trim();
          const chatId = Number(url.searchParams.get("chatId"));
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (
            streamAuth.ticket?.chatId != null &&
            streamAuth.ticket.chatId !== Math.trunc(chatId)
          ) {
            sendJson(res, 403, { ok: false, error: "ticket_chat_mismatch" });
            return;
          }
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          serveLiveChatMessageRevisionStream(
            req,
            res,
            telegramUsername,
            Math.trunc(chatId),
            sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : null,
            {
              onOpen: () => {
                pinGatewayUserSession(telegramUsername, "messages_stream");
                void ensureGatewayUserSession(telegramUsername, RESYNC_HTTP_SESSION_WAIT_MS);
              },
              onClose: () => unpinGatewayUserSession(telegramUsername, "messages_stream"),
            },
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

        if (req.method === "POST" && pathname === "/v1/chat/voice/mute") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            isMuted?: boolean;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await setChatVoiceMicMutedForUser(
            telegramUsername,
            chatId,
            groupCallId,
            Boolean(body.isMuted),
          );
          logGateway("chat_voice_mute", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/participant-volume") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            userId?: number | null;
            peerChatId?: number | null;
            volumePercent?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          const volumePercent = Number(body.volumePercent);
          if (!telegramUsername || !Number.isFinite(chatId) || !Number.isFinite(volumePercent)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await setChatVoiceParticipantVolumeForUser(
            telegramUsername,
            chatId,
            groupCallId,
            {
              userId: body.userId != null ? Number(body.userId) : null,
              chatId: body.peerChatId != null ? Number(body.peerChatId) : null,
            },
            volumePercent,
          );
          logGateway("chat_voice_participant_volume", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            volume_percent: result.volume_percent,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            error: result.error,
            volume_percent: result.volume_percent,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/speaking") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            audioSourceId?: number;
            isSpeaking?: boolean;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          // WebRTC SSRC is uint32; TDLib audio_source is signed int32 (may be negative).
          const audioSourceId = Number(body.audioSourceId) | 0;
          if (
            !telegramUsername ||
            !Number.isFinite(chatId) ||
            !Number.isFinite(Number(body.audioSourceId)) ||
            audioSourceId === 0
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await setChatVoiceParticipantSpeakingForUser(
            telegramUsername,
            chatId,
            groupCallId,
            audioSourceId,
            Boolean(body.isSpeaking),
          );
          logGateway("chat_voice_speaking", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/join") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            joinParameters?: {
              audio_source_id?: number;
              payload?: string;
              is_muted?: boolean;
              is_my_video_enabled?: boolean;
            };
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          const joinParameters = body.joinParameters;
          // WebRTC SSRC is uint32; TDLib audio_source_id is signed int32 (may be negative).
          const audioSourceId = Number(joinParameters?.audio_source_id) | 0;
          const payload = typeof joinParameters?.payload === "string" ? joinParameters.payload : "";
          if (
            !telegramUsername ||
            !Number.isFinite(chatId) ||
            !Number.isFinite(Number(joinParameters?.audio_source_id)) ||
            audioSourceId === 0 ||
            !payload.trim()
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await joinChatVoiceForUser(
            telegramUsername,
            chatId,
            groupCallId,
            {
              audio_source_id: audioSourceId,
              payload,
              is_muted: Boolean(joinParameters?.is_muted),
              is_my_video_enabled: Boolean(joinParameters?.is_my_video_enabled),
            },
          );
          logGateway("chat_voice_join", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            join_payload: result.join_payload,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/screen-share/start") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            joinParameters?: {
              audio_source_id?: number;
              payload?: string;
            };
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          const joinParameters = body.joinParameters;
          const audioSourceId = Number(joinParameters?.audio_source_id) | 0;
          const payload = typeof joinParameters?.payload === "string" ? joinParameters.payload : "";
          if (
            !telegramUsername ||
            !Number.isFinite(chatId) ||
            !Number.isFinite(Number(joinParameters?.audio_source_id)) ||
            audioSourceId === 0 ||
            !payload.trim()
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await startChatVoiceScreenShareForUser(
            telegramUsername,
            chatId,
            groupCallId,
            {
              audio_source_id: audioSourceId,
              payload,
            },
          );
          logGateway("chat_voice_screen_share_start", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            join_payload: result.join_payload,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/screen-share/end") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await endChatVoiceScreenShareForUser(
            telegramUsername,
            chatId,
            groupCallId,
          );
          logGateway("chat_voice_screen_share_end", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            error: result.error,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/message/send") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
            text?: string;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          const text = typeof body.text === "string" ? body.text : "";
          if (!telegramUsername || !Number.isFinite(chatId) || !text.trim()) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await sendChatVoiceCallMessageForUser(
            telegramUsername,
            chatId,
            groupCallId,
            text,
          );
          logGateway("chat_voice_message_send", {
            telegramUsername,
            chatId,
            ok: result.ok,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            error: result.error,
            message: result.message,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/chat/voice/start") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await startChatVoiceForUser(telegramUsername, chatId);
          logGateway("chat_voice_start", {
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

        if (req.method === "POST" && pathname === "/v1/chat/voice/leave") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            groupCallId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const groupCallId = normalizeTelegramGroupCallId(body.groupCallId);
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await leaveChatVoiceForUser(
            telegramUsername,
            chatId,
            groupCallId,
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
          const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("groupCallId"));
          const forceReload =
            url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
          if (!telegramUsername || !Number.isFinite(chatId)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await getChatVoiceParticipantsForUser(
            telegramUsername,
            chatId,
            groupCallId,
            { forceReload },
          );
          logGateway("chat_voice_participants", {
            telegramUsername,
            chatId,
            ok: result.ok,
            count: result.participants.length,
            participantCount: result.participant_count,
            hasActiveVoiceChat: result.has_active_voice_chat,
            groupCallId: result.voice_chat_group_call_id,
            resolveSource: result.voice_resolve_source,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.ok ? 200 : 503, {
            ok: result.ok,
            participants: result.participants,
            participant_count: result.participant_count,
            has_active_voice_chat: result.has_active_voice_chat,
            voice_chat_group_call_id: result.voice_chat_group_call_id,
            voice_resolve_source: result.voice_resolve_source,
            loaded_all_participants: Boolean(
              (result as { loaded_all_participants?: boolean }).loaded_all_participants,
            ),
            has_hidden_listeners: Boolean(
              (result as { has_hidden_listeners?: boolean }).has_hidden_listeners,
            ),
            video_chat: (result as { video_chat?: unknown }).video_chat ?? null,
            error: result.error,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/voice/participants/stream") {
          const telegramUsername = (
            streamAuth.ticket?.sub ||
            url.searchParams.get("telegramUsername") ||
            ""
          ).trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("groupCallId"));
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (
            streamAuth.ticket?.chatId != null &&
            streamAuth.ticket.chatId !== Math.trunc(chatId)
          ) {
            sendJson(res, 403, { ok: false, error: "ticket_chat_mismatch" });
            return;
          }
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          // Resolve live call id from getChat (same as join) so a stale client
          // preferred id cannot subscribe SSE to the wrong call.
          let resolvedCallId = groupCallId;
          try {
            const { resolveVoiceStreamGroupCallId } = await import("./connectAttempts.js");
            resolvedCallId = await resolveVoiceStreamGroupCallId(
              telegramUsername,
              Math.trunc(chatId),
              groupCallId,
            );
          } catch {
            /* fall back to client preferred / cache map */
          }
          // Open SSE immediately — awaiting soft-warm here blocked `ready` for
          // seconds (client never saw stream_ready) while 4s soft polls stacked
          // and froze the voice strip. Warm in background; revision bumps push.
          serveVoiceParticipantsStream(
            req,
            res,
            telegramUsername,
            Math.trunc(chatId),
            resolvedCallId,
            sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : null,
          );
          void getChatVoiceParticipantsForUser(
            telegramUsername,
            Math.trunc(chatId),
            resolvedCallId,
            { forceReload: false },
          ).catch(() => {
            /* stream still useful for later revisions */
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/voice/messages/stream") {
          const telegramUsername = (
            streamAuth.ticket?.sub ||
            url.searchParams.get("telegramUsername") ||
            ""
          ).trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("groupCallId"));
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          if (
            streamAuth.ticket?.chatId != null &&
            streamAuth.ticket.chatId !== Math.trunc(chatId)
          ) {
            sendJson(res, 403, { ok: false, error: "ticket_chat_mismatch" });
            return;
          }
          const sinceRevisionRaw = url.searchParams.get("sinceRevision");
          const sinceRevision =
            sinceRevisionRaw != null && sinceRevisionRaw.trim() !== ""
              ? Number(sinceRevisionRaw)
              : null;
          let resolvedCallId = groupCallId;
          try {
            const { resolveVoiceStreamGroupCallId } = await import("./connectAttempts.js");
            resolvedCallId = await resolveVoiceStreamGroupCallId(
              telegramUsername,
              Math.trunc(chatId),
              groupCallId,
            );
          } catch {
            /* fall back */
          }
          serveVoiceCallMessagesStream(
            req,
            res,
            telegramUsername,
            Math.trunc(chatId),
            resolvedCallId,
            sinceRevision != null && Number.isFinite(sinceRevision) ? sinceRevision : null,
          );
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

        if (req.method === "POST" && pathname === "/v1/chat/messages/delete") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            chatId?: number;
            messageIds?: number[];
            messageId?: number;
          };
          const telegramUsername = (body.telegramUsername || "").trim();
          const chatId = Number(body.chatId);
          const messageIds = Array.isArray(body.messageIds)
            ? body.messageIds
            : body.messageId != null
              ? [body.messageId]
              : [];
          if (!telegramUsername || !Number.isFinite(chatId) || messageIds.length === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await deleteChatMessagesForUser(telegramUsername, chatId, messageIds);
          logGateway("chat_messages_deleted", {
            telegramUsername,
            chatId,
            userId: liveChatPeerUserIdForLog(telegramUsername, chatId) ?? null,
            ok: !result.error,
            count: result.deleted_message_ids.length,
            error: result.error,
            ms: Date.now() - started,
          });
          sendJson(res, result.error ? 503 : 200, {
            ok: !result.error,
            deleted_message_ids: result.deleted_message_ids,
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

        if (req.method === "GET" && pathname === "/v1/user/profile") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatIdRaw = url.searchParams.get("chatId");
          const chatId =
            chatIdRaw != null && chatIdRaw.trim() !== "" ? Number(chatIdRaw) : 0;
          const peerUserIdRaw = url.searchParams.get("userId");
          const peerUserId =
            peerUserIdRaw != null && peerUserIdRaw.trim() !== ""
              ? Number(peerUserIdRaw)
              : null;
          const hasChat = Number.isFinite(chatId) && chatId !== 0;
          const hasUser =
            peerUserId != null && Number.isFinite(peerUserId) && peerUserId !== 0;
          if (!telegramUsername || (!hasChat && !hasUser)) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const result = await getUserProfileForUser(
            telegramUsername,
            hasChat ? chatId : 0,
            hasUser ? peerUserId : null,
          );
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          logGateway("user_profile_ok", {
            telegramUsername,
            chatId,
            userId: safeTelegramUserIdForLog(peerUserId) ?? null,
            ms: Date.now() - started,
          });
          sendJson(res, 200, { ok: true, profile: result.profile });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/user/profile-audio") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const peerUserId = Number(url.searchParams.get("userId"));
          const fileId = Number(url.searchParams.get("fileId"));
          if (
            !telegramUsername ||
            !Number.isFinite(peerUserId) ||
            peerUserId === 0 ||
            !Number.isFinite(fileId) ||
            fileId <= 0
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const media = await getProfileAudioFileForUser(
            telegramUsername,
            peerUserId,
            fileId,
          );
          if (!media) {
            logGateway("profile_audio_unavailable", {
              telegramUsername,
              userId: safeTelegramUserIdForLog(peerUserId) ?? null,
              fileId,
              ms: Date.now() - started,
            });
            sendJson(res, 404, { ok: false, error: "audio_unavailable" });
            return;
          }
          logGateway("profile_audio_ok", {
            telegramUsername,
            userId: safeTelegramUserIdForLog(peerUserId) ?? null,
            fileId,
            bytes: media.data.length,
            mime: media.mime,
            ms: Date.now() - started,
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", media.mime);
          res.setHeader("Cache-Control", "private, max-age=3600");
          res.end(media.data);
          return;
        }

        if (req.method === "GET" && pathname === "/v1/user/profile-audio-cover") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const peerUserId = Number(url.searchParams.get("userId"));
          const fileId = Number(url.searchParams.get("fileId"));
          if (
            !telegramUsername ||
            !Number.isFinite(peerUserId) ||
            peerUserId === 0 ||
            !Number.isFinite(fileId) ||
            fileId <= 0
          ) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const started = Date.now();
          const media = await getProfileAudioCoverForUser(
            telegramUsername,
            peerUserId,
            fileId,
          );
          if (!media) {
            logGateway("profile_audio_cover_unavailable", {
              telegramUsername,
              userId: safeTelegramUserIdForLog(peerUserId) ?? null,
              fileId,
              ms: Date.now() - started,
            });
            sendJson(res, 404, { ok: false, error: "cover_unavailable" });
            return;
          }
          logGateway("profile_audio_cover_ok", {
            telegramUsername,
            userId: safeTelegramUserIdForLog(peerUserId) ?? null,
            fileId,
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

        if (req.method === "POST" && pathname === "/v1/user/block") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            userId?: number;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const userId = Number(body.userId);
          if (!telegramUsername || !Number.isFinite(userId) || userId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await blockUserForUser(telegramUsername, userId);
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/user/unblock") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            userId?: number;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const userId = Number(body.userId);
          if (!telegramUsername || !Number.isFinite(userId) || userId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await unblockUserForUser(telegramUsername, userId);
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/links") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const fromMessageIdRaw = url.searchParams.get("fromMessageId");
          const fromMessageId =
            fromMessageIdRaw != null && fromMessageIdRaw.trim() !== ""
              ? Number(fromMessageIdRaw)
              : null;
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : 30;
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await searchChatLinksForUser(telegramUsername, chatId, {
            fromMessageId:
              fromMessageId != null && Number.isFinite(fromMessageId) ? fromMessageId : null,
            limit: Number.isFinite(limit) ? limit : 30,
          });
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            links: result.links,
            has_more: result.has_more,
          });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/chat/media") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const chatId = Number(url.searchParams.get("chatId"));
          const kindRaw = (url.searchParams.get("kind") || "").trim();
          const kind =
            kindRaw === "marked" ||
            kindRaw === "images" ||
            kindRaw === "photos" ||
            kindRaw === "links" ||
            kindRaw === "gifs"
              ? kindRaw
              : null;
          const fromMessageIdRaw = url.searchParams.get("fromMessageId");
          const fromMessageId =
            fromMessageIdRaw != null && fromMessageIdRaw.trim() !== ""
              ? Number(fromMessageIdRaw)
              : null;
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : 30;
          if (!telegramUsername || !Number.isFinite(chatId) || chatId === 0 || !kind) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await searchChatMediaForUser(telegramUsername, chatId, kind, {
            fromMessageId:
              fromMessageId != null && Number.isFinite(fromMessageId) ? fromMessageId : null,
            limit: Number.isFinite(limit) ? limit : 30,
          });
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            items: result.items,
            has_more: result.has_more,
          });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/call/create") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            userId?: number;
            isVideo?: boolean;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const userId = Number(body.userId);
          if (!telegramUsername || !Number.isFinite(userId) || userId === 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await createPrivateCallForSession(telegramUsername, userId, {
            isVideo: Boolean(body.isVideo),
          });
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true, call: result.call });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/call/status") {
          const telegramUsername = (url.searchParams.get("telegramUsername") || "").trim();
          const callIdRaw = url.searchParams.get("callId");
          const callId =
            callIdRaw != null && callIdRaw.trim() !== "" ? Number(callIdRaw) : null;
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await getPrivateCallForSession(
            telegramUsername,
            callId != null && Number.isFinite(callId) ? callId : null,
          );
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true, call: result.call });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/call/discard") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            callId?: number;
            duration?: number;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const callId = Number(body.callId);
          const duration = Number(body.duration);
          if (!telegramUsername) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await discardPrivateCallForSession(
            telegramUsername,
            Number.isFinite(callId) && callId > 0 ? callId : null,
            Number.isFinite(duration) && duration > 0 ? duration : null,
          );
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/call/accept") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            callId?: number;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const callId = Number(body.callId);
          if (!telegramUsername || !Number.isFinite(callId) || callId <= 0) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await acceptPrivateCallForSession(telegramUsername, callId);
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true, call: result.call });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/call/signaling") {
          const body = (await readJson(req)) as {
            telegramUsername?: string;
            callId?: number;
            data?: string;
          };
          const telegramUsername =
            typeof body.telegramUsername === "string" ? body.telegramUsername.trim() : "";
          const callId = Number(body.callId);
          const data = typeof body.data === "string" ? body.data : "";
          if (!telegramUsername || !Number.isFinite(callId) || callId <= 0 || !data) {
            sendJson(res, 400, { ok: false, error: "invalid_params" });
            return;
          }
          const result = await sendPrivateCallSignalingForSession(
            telegramUsername,
            callId,
            data,
          );
          if (!result.ok) {
            sendJson(res, result.error === "session_not_ready" ? 503 : 400, {
              ok: false,
              error: result.error,
            });
            return;
          }
          sendJson(res, 200, { ok: true });
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

  attachPrivateCallAudioWebSocket(server);
  attachPrivateCallVideoWebSocket(server);

  const port = getGatewayPort();
  const host = getGatewayBindHost();
  server.listen(port, host, () => {
    logGateway("listening", { url: `http://${host}:${port}` });
    restorePersistedGatewaySessions();
    startClientIdleSweeper();
  });

  return server;
}
