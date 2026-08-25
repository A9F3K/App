import {
  disconnectTelegramMessages,
  getConnection,
  isTelegramMessagesConnected,
} from "../../database/telegramMessages.js";
import { getMtprotoSession } from "../../database/telegramMtproto.js";
import { revokeMtprotoSession } from "../../database/telegramMtproto.js";
import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";
import { telegramUsernameFromSessionCookie } from "../_lib/session-auth.js";
import { appLog, safeTelegramUserIdForLog, telegramUserIdLogField } from "../../shared/appLog.js";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { gatewayDisconnect, gatewayFetchChatAvatar, gatewayFetchChatMessages, gatewayFetchTelegramEmoji, gatewayFetchLiveChats, gatewayFetchMessageMedia, gatewayOpenMessageMediaStream, gatewayFetchUserAvatar, gatewayFetchUserProfile, gatewayOpenProfileAudioStream, gatewayFetchProfileAudioCover, gatewayBlockUser, gatewayUnblockUser, gatewaySearchChatLinks, gatewaySearchChatMedia, gatewayCreatePrivateCall, gatewayGetPrivateCall, gatewayDiscardPrivateCall, gatewayFocusChat, gatewayLoadMoreChats, gatewayOpenLiveChatsStream, gatewayOpenChatMessagesStream, gatewayOpenVoiceParticipantsStream, gatewayOpenVoiceCallMessagesStream, gatewayResyncChats, gatewaySendChatMessage, gatewaySendChatPhoto, gatewayEditChatMessage, gatewayDeleteChatMessages,   gatewayJoinChatVoice, gatewaySetChatVoiceMicMuted, gatewaySetChatVoiceParticipantVolume, gatewaySetChatVoiceParticipantSpeaking, gatewayStartChatVoice, gatewayLeaveChatVoice, gatewayStartChatVoiceScreenShare, gatewayEndChatVoiceScreenShare, gatewaySendChatVoiceCallMessage, gatewayFetchChatVoiceParticipants, gatewayResolvePublicChat, gatewaySearchChats, gatewaySearchRecentChats, gatewayAddRecentlyFoundChat, gatewayRemoveRecentlyFoundChat, gatewayClearRecentlyFoundChats, gatewayUserHasPersistedSession, gatewayWarmupSession, gatewayViewChatInboxMessages, gatewayToggleChatPinned, gatewaySetPinnedChatsOrder, gatewayListContacts, gatewayAddContact, gatewayCreateGroup, gatewayCreateChannel, gatewayFetchCallsOverview } from "../_lib/tdlib-gateway-client.js";
import { getGatewayPublicBaseUrl } from "../../telegram/tdlib/env.js";
import {
  gatewayHttpToWebSocketUrl,
  gatewayStreamPathForKind,
  isGatewayStreamKind,
  mintStreamTicket,
  type GatewayStreamKind,
} from "../../telegram/tdlib/streamTicket.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string | Buffer) => void;
  write?: (body: string | Buffer) => boolean;
  flushHeaders?: () => void;
};

type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const JSON_HEADERS = { "Content-Type": "application/json" };
const TELEGRAM_MESSAGES_API_LOG_PREFIX = "[telegram-messages-api]";

function logTelegramMessagesApi(event: string, details?: Record<string, unknown>): void {
  appLog(TELEGRAM_MESSAGES_API_LOG_PREFIX, event, details);
}

function isGatewaySessionWarmingError(error: string | undefined | null): boolean {
  return (
    error === "session_not_ready" ||
    error === "session_restoring" ||
    error === "warmup_timeout" ||
    error === "warmup_no_attempt"
  );
}

const GATEWAY_SESSION_RESTORE_POLL_MS = 90_000;
const GATEWAY_SESSION_RESTORE_RESYNC_MS = 25_000;

/** Avoid forcing QR when TDLib files exist on the gateway but restore is still in flight. */
async function gatewaySessionRestoringOrRevoke(
  telegramUsername: string,
): Promise<"restoring" | "revoke"> {
  const persistedOnGateway = await gatewayUserHasPersistedSession(telegramUsername);
  return persistedOnGateway ? "restoring" : "revoke";
}

function gatewayResyncWarmingResponse(
  request: AnyRequest,
  res: NodeRes | undefined,
  result: { chatCount?: number; error?: string },
  errorOverride?: string,
): Response | void {
  return finishJson(
    request,
    res,
    {
      ok: false,
      connected: true,
      warming: true,
      chatCount: result.chatCount ?? 0,
      error: errorOverride ?? result.error ?? "session_not_ready",
    },
    200,
  );
}

function requestMethod(request: AnyRequest): string {
  return ((request as { method?: string }).method ?? (request as Request).method ?? "GET").toUpperCase();
}

function sendJson(body: object, status = 200, request?: AnyRequest): Response {
  const headers = new Headers(JSON_HEADERS);
  if (request) applyAuthApiCors(request, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

function sendJsonViaRes(res: NodeRes, body: object, status = 200, request?: AnyRequest): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  if (request) {
    const headers = new Headers();
    applyAuthApiCors(request, headers);
    headers.forEach((v, k) => res.setHeader(k, v));
  }
  res.end(JSON.stringify(body));
}

function finishPreflight(request: AnyRequest, res: NodeRes | undefined, preflight: Response): Response | void {
  if (res) {
    res.status(preflight.status);
    preflight.headers.forEach((v, k) => res.setHeader(k, v));
    res.end();
    return;
  }
  return preflight;
}

function finishJson(
  request: AnyRequest,
  res: NodeRes | undefined,
  body: object,
  status = 200,
): Response | void {
  if (res) {
    sendJsonViaRes(res, body, status, request);
    return;
  }
  return sendJson(body, status, request);
}

async function requireUser(request: AnyRequest): Promise<string | Response> {
  const username = await telegramUsernameFromSessionCookie(request);
  if (!username) {
    return sendJson({ ok: false, error: "unauthorized" }, 401, request);
  }
  return username;
}

async function parseRequestBody<T extends Record<string, unknown> = Record<string, unknown>>(
  request: AnyRequest,
): Promise<T> {
  const raw = request as {
    body?: unknown;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body === "object" && !Buffer.isBuffer(raw.body)) {
      return raw.body as T;
    }
    if (typeof raw.body === "string" && raw.body.trim()) {
      try {
        return JSON.parse(raw.body) as T;
      } catch {
        return {} as T;
      }
    }
  }
  const webReq = request as Request;
  if (typeof raw.json === "function") {
    try {
      const parsed = await raw.json();
      return (parsed && typeof parsed === "object" ? parsed : {}) as T;
    } catch {
      /* fall through */
    }
  }
  if (typeof webReq.text === "function") {
    try {
      const text = await webReq.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

function mapLiveChats(live: { chats: Record<string, unknown>[]; revision: number }) {
  const chats = live.chats.map((row) => ({
    id: row.telegram_chat_id,
    telegram_chat_id: row.telegram_chat_id,
    title: row.title,
    subtitle: row.subtitle ?? "",
    subtitle_segments: Array.isArray(row.subtitle_segments) ? row.subtitle_segments : null,
    avatar_url: row.avatar_url ?? null,
    last_message_at: row.last_message_at,
    unread_count: row.unread_count ?? 0,
    peer_user_id: row.peer_user_id ?? null,
    peer_username:
      typeof row.peer_username === "string" && row.peer_username.trim()
        ? row.peer_username.trim().replace(/^@+/, "")
        : null,
    chat_username:
      typeof row.chat_username === "string" && row.chat_username.trim()
        ? row.chat_username.trim().replace(/^@+/, "")
        : null,
    chat_kind:
      row.chat_kind === "private" ||
      row.chat_kind === "group" ||
      row.chat_kind === "supergroup" ||
      row.chat_kind === "channel"
        ? row.chat_kind
        : null,
    member_count:
      typeof row.member_count === "number" && Number.isFinite(row.member_count) && row.member_count > 0
        ? Math.trunc(row.member_count)
        : null,
    peer_emoji_status_custom_emoji_id:
      typeof row.peer_emoji_status_custom_emoji_id === "string" &&
      row.peer_emoji_status_custom_emoji_id.trim()
        ? row.peer_emoji_status_custom_emoji_id.trim()
        : null,
    peer_accent_color_light:
      typeof row.peer_accent_color_light === "string" && row.peer_accent_color_light.trim()
        ? row.peer_accent_color_light.trim()
        : null,
    peer_accent_color_dark:
      typeof row.peer_accent_color_dark === "string" && row.peer_accent_color_dark.trim()
        ? row.peer_accent_color_dark.trim()
        : null,
    peer_is_bot: Boolean(row.peer_is_bot),
    presence_kind: row.presence_kind ?? null,
    presence_at: row.presence_at ?? null,
    chat_action: row.chat_action ?? null,
    chat_action_user_id: row.chat_action_user_id ?? null,
    chat_action_user_name: row.chat_action_user_name ?? null,
    chat_action_expires_at: row.chat_action_expires_at ?? null,
    is_pinned: Boolean(row.is_pinned),
    pin_order: typeof row.pin_order === "string" ? row.pin_order : "0",
    list_tier:
      row.list_tier === "pinned" ||
      row.list_tier === "positioned" ||
      row.list_tier === "unpositioned"
        ? row.list_tier
        : null,
    last_read_outbox_message_id:
      typeof row.last_read_outbox_message_id === "number" &&
      Number.isFinite(row.last_read_outbox_message_id) &&
      row.last_read_outbox_message_id > 0
        ? row.last_read_outbox_message_id
        : null,
    last_read_inbox_message_id:
      typeof row.last_read_inbox_message_id === "number" &&
      Number.isFinite(row.last_read_inbox_message_id) &&
      row.last_read_inbox_message_id > 0
        ? row.last_read_inbox_message_id
        : null,
    last_message_is_outgoing: Boolean(row.last_message_is_outgoing),
    last_message_outgoing_status:
      row.last_message_outgoing_status === "pending" ||
      row.last_message_outgoing_status === "delivered" ||
      row.last_message_outgoing_status === "read" ||
      row.last_message_outgoing_status === "failed"
        ? row.last_message_outgoing_status
        : null,
    last_message_telegram_id: (() => {
      const raw = Number(row.last_message_telegram_id);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    last_message_sender_user_id: (() => {
      const raw = Number(row.last_message_sender_user_id);
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    })(),
    has_active_voice_chat: Boolean(row.has_active_voice_chat),
    voice_chat_group_call_id: normalizeTelegramGroupCallId(row.voice_chat_group_call_id),
    voice_chat_is_joined: Boolean(row.voice_chat_is_joined),
    pending_deleted_message_ids: Array.isArray(row.pending_deleted_message_ids)
      ? row.pending_deleted_message_ids
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .map((id) => Math.trunc(id))
      : undefined,
  }));
  return { chats, revision: live.revision };
}

export async function telegramMessagesStatusHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  let effectivelyConnected = connected;
  if (!effectivelyConnected) {
    // DB link can briefly disagree with on-disk TDLib auth after gateway idle
    // unload / race. Only heal when we already recorded an authorized Telegram
    // user id — a fresh QR attempt also creates a `db` folder and must not look
    // "connected" (that hides the Connect footer).
    const existing = await getMtprotoSession(userOrRes);
    const hadAuthorizedUser =
      existing?.telegram_user_id != null &&
      Number.isFinite(existing.telegram_user_id) &&
      existing.telegram_user_id > 0;
    if (hadAuthorizedUser) {
      const persistedOnGateway = await gatewayUserHasPersistedSession(userOrRes);
      if (persistedOnGateway) {
        const { markTelegramMessagesConnected } = await import("../../database/telegramMessages.js");
        const { upsertMtprotoSession } = await import("../../database/telegramMtproto.js");
        await upsertMtprotoSession({
          telegramUsername: userOrRes,
          telegramUserId: existing?.telegram_user_id ?? null,
          tdlibDbPath: existing?.tdlib_db_path?.trim() || `gateway:${userOrRes}`,
          status: "active",
        });
        await markTelegramMessagesConnected(userOrRes);
        effectivelyConnected = true;
        logTelegramMessagesApi("messages_status_healed_from_persisted_session", {
          telegramUsername: userOrRes,
        });
      }
    }
  }
  const conn = effectivelyConnected ? await getConnection(userOrRes) : null;
  const session = effectivelyConnected ? await getMtprotoSession(userOrRes) : null;
  const telegramUserId =
    session?.telegram_user_id != null &&
    Number.isFinite(session.telegram_user_id) &&
    session.telegram_user_id > 0
      ? Math.trunc(session.telegram_user_id)
      : null;
  return finishJson(
    request,
    res,
    {
      ok: true,
      connected: effectivelyConnected,
      connected_at: conn?.connected_at ?? null,
      telegram_user_id: telegramUserId,
    },
    200,
  );
}

export async function telegramMessagesConnectHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  return finishJson(
    request,
    res,
    {
      ok: false,
      error: "use_mtproto_connect_start",
      hint: "POST /api/telegram-mtproto-connect-start",
    },
    410,
  );
}

export async function telegramMessagesDisconnectHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  await gatewayDisconnect(userOrRes);
  await revokeMtprotoSession(userOrRes);
  await disconnectTelegramMessages(userOrRes);
  return finishJson(request, res, { ok: true, connected: false }, 200);
}

export async function telegramMessagesChatsHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    logTelegramMessagesApi("messages_chats_not_connected", {
      telegramUsername: userOrRes,
    });
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  const sinceRevision =
    sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "" ? Number(sinceRevisionRaw) : null;

  const started = Date.now();
  const live = await gatewayFetchLiveChats(userOrRes, {
    sinceRevision:
      sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
        ? sinceRevision
        : null,
  });

  if (live?.unchanged) {
    logTelegramMessagesApi("messages_chats_unchanged", {
      telegramUsername: userOrRes,
      revision: live.revision,
      elapsedMs: Date.now() - started,
    });
    return finishJson(
      request,
      res,
      {
        ok: true,
        connected: true,
        unchanged: true,
        source: "live",
        revision: live.revision,
        chatListSync: live.chatListSync,
      },
      200,
    );
  }

  const mapped = live ? mapLiveChats(live) : { chats: [], revision: 0 };
  const missingPreviewCount = mapped.chats.filter(
    (row) => typeof row.subtitle !== "string" || row.subtitle.trim().length === 0,
  ).length;
  const missingAvatarCount = mapped.chats.filter((row) => !row.avatar_url).length;
  const first = mapped.chats[0];
  logTelegramMessagesApi("messages_chats_served", {
    telegramUsername: userOrRes,
    count: mapped.chats.length,
    revision: mapped.revision,
    source: live ? "live" : "live_empty",
    missingPreviewCount,
    missingAvatarCount,
    firstId: first?.telegram_chat_id ?? null,
    firstUserId: safeTelegramUserIdForLog(first?.peer_user_id) ?? null,
    firstTitle: typeof first?.title === "string" ? first.title.trim() || null : null,
    elapsedMs: Date.now() - started,
  });
  return finishJson(
    request,
    res,
    {
      ok: true,
      connected: true,
      source: "live",
      revision: mapped.revision,
      chats: mapped.chats,
      chatListSync: live?.chatListSync,
    },
    200,
  );
}

export async function telegramMessagesChatsLoadMoreHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{ tier?: string }>(request);
  const tier = body.tier === "unpositioned" ? "unpositioned" : "positioned";
  const result = await gatewayLoadMoreChats(userOrRes, tier);
  const warming =
    result.warming === true || isGatewaySessionWarmingError(result.error);
  return finishJson(
    request,
    res,
    {
      ok: result.ok || warming || result.chatListSync?.inProgress === true,
      connected: true,
      started: result.started ?? false,
      warming,
      tier: result.tier ?? tier,
      chatListSync: result.chatListSync,
      error: result.error,
    },
    200,
  );
}

export async function telegramMessagesChatsStreamHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  const sinceRevision =
    sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "" ? Number(sinceRevisionRaw) : null;

  const abortController = new AbortController();
  const upstreamSignal =
    request instanceof Request && request.signal ? request.signal : undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortController.abort();
    } else {
      upstreamSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const gatewayResponse = await gatewayOpenLiveChatsStream(
    userOrRes,
    sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
      ? sinceRevision
      : null,
    abortController.signal,
  );
  if (!gatewayResponse?.body) {
    return finishJson(request, res, { ok: false, error: "stream_unavailable" }, 503);
  }

  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  applyAuthApiCors(request, sseHeaders);

  logTelegramMessagesApi("messages_chats_stream_open", {
    telegramUsername: userOrRes,
    sinceRevision:
      sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
        ? sinceRevision
        : null,
  });

  if (res && typeof res.write === "function") {
    res.status(200);
    sseHeaders.forEach((v, k) => res.setHeader(k, v));
    const reader = gatewayResponse.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      /* client disconnected */
    } finally {
      abortController.abort();
      res.end();
    }
    return;
  }

  return new Response(gatewayResponse.body, { status: 200, headers: sseHeaders });
}

export async function telegramMessagesVoiceParticipantsStreamHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const chatId = Number(url.searchParams.get("chat_id"));
  const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("group_call_id"));
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  const sinceRevision =
    sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "" ? Number(sinceRevisionRaw) : null;
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const abortController = new AbortController();
  const upstreamSignal =
    request instanceof Request && request.signal ? request.signal : undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortController.abort();
    } else {
      upstreamSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const gatewayResponse = await gatewayOpenVoiceParticipantsStream(
    userOrRes,
    Math.trunc(chatId),
    groupCallId,
    sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
      ? sinceRevision
      : null,
    abortController.signal,
  );
  if (!gatewayResponse?.body) {
    return finishJson(request, res, { ok: false, error: "stream_unavailable" }, 503);
  }

  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  applyAuthApiCors(request, sseHeaders);

  logTelegramMessagesApi("messages_voice_participants_stream_open", {
    telegramUsername: userOrRes,
    chatId: Math.trunc(chatId),
    groupCallId,
    sinceRevision:
      sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
        ? sinceRevision
        : null,
  });

  if (res && typeof res.write === "function") {
    res.status(200);
    sseHeaders.forEach((v, k) => res.setHeader(k, v));
    const reader = gatewayResponse.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      /* client disconnected */
    } finally {
      abortController.abort();
      res.end();
    }
    return;
  }

  return new Response(gatewayResponse.body, { status: 200, headers: sseHeaders });
}

export async function telegramMessagesHistoryStreamHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const chatId = Number(url.searchParams.get("chat_id"));
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  const sinceRevision =
    sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "" ? Number(sinceRevisionRaw) : null;
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const abortController = new AbortController();
  const upstreamSignal =
    request instanceof Request && request.signal ? request.signal : undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortController.abort();
    } else {
      upstreamSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const gatewayResponse = await gatewayOpenChatMessagesStream(
    userOrRes,
    Math.trunc(chatId),
    sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
      ? sinceRevision
      : null,
    abortController.signal,
  );
  if (!gatewayResponse?.body) {
    return finishJson(request, res, { ok: false, error: "stream_unavailable" }, 503);
  }

  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  applyAuthApiCors(request, sseHeaders);

  logTelegramMessagesApi("messages_history_stream_open", {
    telegramUsername: userOrRes,
    chatId: Math.trunc(chatId),
    sinceRevision:
      sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
        ? sinceRevision
        : null,
  });

  if (res && typeof res.write === "function") {
    res.status(200);
    sseHeaders.forEach((v, k) => res.setHeader(k, v));
    const reader = gatewayResponse.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      /* client disconnected */
    } finally {
      abortController.abort();
      res.end();
    }
    return;
  }

  return new Response(gatewayResponse.body, { status: 200, headers: sseHeaders });
}

export async function telegramMessagesResyncHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  let result = await gatewayResyncChats(userOrRes, { maxWaitMs: GATEWAY_SESSION_RESTORE_RESYNC_MS });

  if (result.error === "no_session" || result.error === "session_not_ready") {
    const warm = await gatewayWarmupSession(userOrRes, { maxPollMs: GATEWAY_SESSION_RESTORE_POLL_MS });
    if (warm.ok) {
      result = await gatewayResyncChats(userOrRes, { maxWaitMs: GATEWAY_SESSION_RESTORE_RESYNC_MS });
    } else if (
      result.error === "session_not_ready" ||
      warm.error === "warmup_timeout" ||
      warm.error === "no_session" ||
      isGatewaySessionWarmingError(warm.error)
    ) {
      if (warm.error === "no_session" || result.error === "no_session") {
        const action = await gatewaySessionRestoringOrRevoke(userOrRes);
        if (action === "restoring") {
          return gatewayResyncWarmingResponse(request, res, result, "session_restoring");
        }
      }
      return gatewayResyncWarmingResponse(request, res, result, result.error ?? warm.error ?? "session_not_ready");
    }
  }

  if (result.httpStatus >= 400 || isGatewaySessionWarmingError(result.error)) {
    return gatewayResyncWarmingResponse(request, res, result);
  }

  const sessionLost = result.error === "no_session";
  if (sessionLost) {
    const action = await gatewaySessionRestoringOrRevoke(userOrRes);
    if (action === "restoring") {
      return gatewayResyncWarmingResponse(request, res, result, "session_restoring");
    }
    return finishJson(request, res, {
      ok: false,
      connected: true,
      needsReconnect: true,
      chatCount: 0,
      error: result.error ?? "no_session",
    });
  }

  return finishJson(
    request,
    res,
    {
      ok: result.ok,
      connected: true,
      chatCount: result.chatCount ?? 0,
      error: result.error ?? null,
      warming: !result.ok && isGatewaySessionWarmingError(result.error),
    },
    200,
  );
}

function requestUrl(request: AnyRequest): URL {
  const raw = (request as { url?: string }).url ?? (request as Request).url ?? "";
  try {
    return new URL(raw);
  } catch {
    return new URL(raw, "http://localhost");
  }
}

function parseOptionalIdParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function telegramMessagesAvatarHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    logTelegramMessagesApi("messages_avatar_not_connected", {
      telegramUsername: userOrRes,
    });
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const userId = parseOptionalIdParam(url, "user_id");
  const animated =
    url.searchParams.get("animated") === "1" || url.searchParams.get("animated") === "true";
  const hasUserId = userId != null;
  const hasChatId = chatId != null;
  if (!hasChatId && !hasUserId) {
    logTelegramMessagesApi("messages_avatar_bad_request", {
      telegramUsername: userOrRes,
      chatIdRaw: url.searchParams.get("chat_id"),
      userIdRaw: url.searchParams.get("user_id"),
    });
    return finishJson(request, res, { ok: false, error: "chat_id_or_user_id_required" }, 400);
  }

  const started = Date.now();
  let avatar = hasUserId
    ? await gatewayFetchUserAvatar(userOrRes, userId, { animated })
    : animated
      ? "no_avatar"
      : await gatewayFetchChatAvatar(userOrRes, chatId!);
  if (avatar === "no_avatar" && hasUserId && chatId != null && !animated) {
    avatar = await gatewayFetchChatAvatar(userOrRes, chatId);
  }
  if (avatar === "no_avatar" && !hasUserId && userId != null) {
    avatar = await gatewayFetchUserAvatar(userOrRes, userId, { animated });
  }
  if (avatar === "no_avatar") {
    logTelegramMessagesApi("messages_avatar_no_avatar", {
      telegramUsername: userOrRes,
      chatId: hasUserId ? null : chatId,
      ...telegramUserIdLogField(hasUserId ? userId : null),
      elapsedMs: Date.now() - started,
    });
    // Never cache 404s — cold TDLib misses used to stick for a day and hide
    // real custom photos (e.g. voice roster) after the first empty getUser.
    if (res) {
      res.status(404);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "private, no-store");
      if (request) {
        const headers = new Headers();
        applyAuthApiCors(request, headers);
        headers.forEach((v, k) => res.setHeader(k, v));
      }
      res.end(JSON.stringify({ ok: false, error: "no_avatar" }));
      return;
    }
    const headers = new Headers({ ...JSON_HEADERS, "Cache-Control": "private, no-store" });
    if (request) applyAuthApiCors(request, headers);
    return new Response(JSON.stringify({ ok: false, error: "no_avatar" }), { status: 404, headers });
  }
  if (!avatar) {
    logTelegramMessagesApi("messages_avatar_unavailable", {
      telegramUsername: userOrRes,
      chatId: hasUserId ? null : chatId,
      ...telegramUserIdLogField(hasUserId ? userId : null),
      elapsedMs: Date.now() - started,
    });
    return finishJson(request, res, { ok: false, error: "avatar_unavailable" }, 503);
  }
  logTelegramMessagesApi("messages_avatar_ok", {
    telegramUsername: userOrRes,
    chatId: hasUserId ? null : chatId,
    ...telegramUserIdLogField(hasUserId ? userId : null),
    mime: avatar.mime,
    bytes: avatar.data.byteLength,
    animated,
    elapsedMs: Date.now() - started,
  });

  const headers = new Headers({
    "Content-Type": avatar.mime,
    "Cache-Control": "public, max-age=86400",
  });
  applyAuthApiCors(request, headers);
  const body = Buffer.from(avatar.data);

  if (res) {
    res.status(200);
    headers.forEach((v, k) => res.setHeader(k, v));
    res.end(body);
    return;
  }
  return new Response(new Uint8Array(avatar.data), { status: 200, headers });
}

export async function telegramMessagesProfileHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const userId = parseOptionalIdParam(url, "user_id");
  if (chatId == null && userId == null) {
    return finishJson(request, res, { ok: false, error: "chat_id_or_user_id_required" }, 400);
  }

  const result = await gatewayFetchUserProfile(userOrRes, chatId ?? 0, userId);
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error }, status);
  }
  return finishJson(request, res, { ok: true, profile: result.profile });
}

function requestHeader(request: AnyRequest, name: string): string | null {
  const webHeaders = (request as Request).headers as Headers | undefined;
  if (webHeaders && typeof webHeaders.get === "function") {
    return webHeaders.get(name);
  }
  const nodeHeaders = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (!nodeHeaders) return null;
  const raw = nodeHeaders[name.toLowerCase()] ?? nodeHeaders[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

function finishBinary(
  request: AnyRequest,
  res: NodeRes | undefined,
  data: ArrayBuffer,
  mime: string,
  cacheControl: string,
): Response | void {
  const headers = new Headers({
    "Content-Type": mime,
    "Cache-Control": cacheControl,
  });
  applyAuthApiCors(request, headers);
  const body = Buffer.from(data);
  if (res) {
    res.status(200);
    headers.forEach((v, k) => res.setHeader(k, v));
    res.end(body);
    return;
  }
  return new Response(new Uint8Array(body), { status: 200, headers });
}

async function finishBinaryStream(
  request: AnyRequest,
  res: NodeRes | undefined,
  upstream: Response,
  cacheControl: string,
): Promise<Response | void> {
  const status = upstream.status || 200;
  const mime = upstream.headers.get("Content-Type") || "audio/mpeg";
  const headers = new Headers({
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    "Accept-Ranges": upstream.headers.get("Accept-Ranges") || "bytes",
    "X-Accel-Buffering": "no",
  });
  const contentRange = upstream.headers.get("Content-Range");
  if (contentRange) headers.set("Content-Range", contentRange);
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  applyAuthApiCors(request, headers);
  if (res) {
    res.status(status);
    headers.forEach((v, k) => res.setHeader(k, v));
    res.flushHeaders?.();
    const body = upstream.body;
    if (!body) {
      res.end();
      return;
    }
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        res.write?.(Buffer.from(value));
      }
    }
    res.end();
    return;
  }
  return new Response(upstream.body, { status, headers });
}

export async function telegramMessagesProfileAudioHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const userId = parseOptionalIdParam(url, "user_id");
  const fileId = parseOptionalIdParam(url, "file_id");
  if (userId == null || userId === 0 || fileId == null || fileId <= 0) {
    return finishJson(request, res, { ok: false, error: "user_id_and_file_id_required" }, 400);
  }

  const rangeHeader = requestHeader(request, "range");
  const upstream = await gatewayOpenProfileAudioStream(userOrRes, userId, fileId, rangeHeader);
  if (!upstream) {
    return finishJson(request, res, { ok: false, error: "audio_unavailable" }, 404);
  }
  return finishBinaryStream(request, res, upstream, "private, max-age=60");
}

export async function telegramMessagesProfileAudioCoverHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const userId = parseOptionalIdParam(url, "user_id");
  const fileId = parseOptionalIdParam(url, "file_id");
  if (userId == null || userId === 0 || fileId == null || fileId <= 0) {
    return finishJson(request, res, { ok: false, error: "user_id_and_file_id_required" }, 400);
  }

  const media = await gatewayFetchProfileAudioCover(userOrRes, userId, fileId);
  if (!media) {
    return finishJson(request, res, { ok: false, error: "cover_unavailable" }, 404);
  }
  return finishBinary(request, res, media.data, media.mime, "public, max-age=86400");
}

export async function telegramMessagesBlockHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  let body: { user_id?: number; userId?: number } = {};
  try {
    body = await parseRequestBody<{ user_id?: number; userId?: number }>(request);
  } catch {
    body = {};
  }
  const userId = Number(body.user_id ?? body.userId);
  if (!Number.isFinite(userId) || userId === 0) {
    return finishJson(request, res, { ok: false, error: "user_id_required" }, 400);
  }

  const result = await gatewayBlockUser(userOrRes, userId);
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error ?? "block_failed" }, status);
  }
  return finishJson(request, res, { ok: true });
}

export async function telegramMessagesUnblockHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  let body: { user_id?: number; userId?: number } = {};
  try {
    body = await parseRequestBody<{ user_id?: number; userId?: number }>(request);
  } catch {
    body = {};
  }
  const userId = Number(body.user_id ?? body.userId);
  if (!Number.isFinite(userId) || userId === 0) {
    return finishJson(request, res, { ok: false, error: "user_id_required" }, 400);
  }

  const result = await gatewayUnblockUser(userOrRes, userId);
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error ?? "unblock_failed" }, status);
  }
  return finishJson(request, res, { ok: true });
}

export async function telegramMessagesLinksHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const fromMessageId = parseOptionalIdParam(url, "from_message_id");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : 30;
  if (chatId == null) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const result = await gatewaySearchChatLinks(userOrRes, chatId, {
    fromMessageId,
    limit: Number.isFinite(limit) ? limit : 30,
  });
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error }, status);
  }
  return finishJson(request, res, {
    ok: true,
    links: result.links,
    has_more: result.has_more,
  });
}

export async function telegramMessagesProfileMediaHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const userId = parseOptionalIdParam(url, "user_id");
  const kindRaw = (url.searchParams.get("kind") || "").trim();
  const kind =
    kindRaw === "marked" ||
    kindRaw === "images" ||
    kindRaw === "photos" ||
    kindRaw === "links" ||
    kindRaw === "gifs"
      ? kindRaw
      : null;
  const fromMessageId = parseOptionalIdParam(url, "from_message_id");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw != null && limitRaw.trim() !== "" ? Number(limitRaw) : 30;
  if ((chatId == null && userId == null) || !kind) {
    return finishJson(request, res, { ok: false, error: "chat_id_and_kind_required" }, 400);
  }

  const result = await gatewaySearchChatMedia(userOrRes, chatId ?? 0, kind, {
    fromMessageId,
    limit: Number.isFinite(limit) ? limit : 30,
    userId,
  });
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error }, status);
  }
  return finishJson(request, res, {
    ok: true,
    items: result.items,
    has_more: result.has_more,
  });
}

export async function telegramMessagesCallCreateHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  let body: { user_id?: number; userId?: number; is_video?: boolean; isVideo?: boolean } = {};
  try {
    body = await parseRequestBody(request);
  } catch {
    body = {};
  }
  const userId = Number(body.user_id ?? body.userId);
  if (!Number.isFinite(userId) || userId === 0) {
    return finishJson(request, res, { ok: false, error: "user_id_required" }, 400);
  }
  const result = await gatewayCreatePrivateCall(userOrRes, userId, {
    isVideo: Boolean(body.is_video ?? body.isVideo),
  });
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error }, status);
  }
  return finishJson(request, res, { ok: true, call: result.call });
}

export async function telegramMessagesCallStatusHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const callId = parseOptionalIdParam(url, "call_id");
  const result = await gatewayGetPrivateCall(userOrRes, callId);
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error }, status);
  }
  return finishJson(request, res, { ok: true, call: result.call });
}

export async function telegramMessagesCallDiscardHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  let body: { call_id?: number; callId?: number; duration?: number } = {};
  try {
    body = await parseRequestBody(request);
  } catch {
    body = {};
  }
  const callId = Number(body.call_id ?? body.callId);
  const duration = Number(body.duration);
  const result = await gatewayDiscardPrivateCall(
    userOrRes,
    Number.isFinite(callId) && callId > 0 ? callId : null,
    Number.isFinite(duration) && duration > 0 ? duration : null,
  );
  if (!result.ok) {
    const status = result.error === "session_not_ready" ? 503 : 400;
    return finishJson(request, res, { ok: false, error: result.error ?? "discard_failed" }, status);
  }
  return finishJson(request, res, { ok: true });
}

export async function telegramMessagesHistoryHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const limitRaw = url.searchParams.get("limit");
  const parsedLimit = limitRaw == null || limitRaw.trim() === "" ? 50 : Number(limitRaw);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
  const beforeMessageId = parseOptionalIdParam(url, "before_message_id");
  const sinceMessageId = parseOptionalIdParam(url, "since_message_id");
  const aroundUnread = url.searchParams.get("around_unread") === "1";
  const aroundMessageId = parseOptionalIdParam(url, "around_message_id");
  const olderAboveRaw = url.searchParams.get("older_above");
  const parsedOlderAbove =
    olderAboveRaw == null || olderAboveRaw.trim() === "" ? null : Number(olderAboveRaw);
  const olderAbove =
    parsedOlderAbove != null && Number.isFinite(parsedOlderAbove) && parsedOlderAbove >= 0
      ? Math.trunc(parsedOlderAbove)
      : null;
  const newerBelowRaw = url.searchParams.get("newer_below");
  const parsedNewerBelow =
    newerBelowRaw == null || newerBelowRaw.trim() === "" ? null : Number(newerBelowRaw);
  const newerBelow =
    parsedNewerBelow != null && Number.isFinite(parsedNewerBelow) && parsedNewerBelow >= 0
      ? Math.trunc(parsedNewerBelow)
      : null;
  if (chatId == null) {
    logTelegramMessagesApi("messages_history_bad_request", {
      telegramUsername: userOrRes,
      chatIdRaw: url.searchParams.get("chat_id"),
      requestUrl: url.pathname + url.search,
    });
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (
    beforeMessageId != null &&
    sinceMessageId != null &&
    beforeMessageId > 0 &&
    sinceMessageId > 0
  ) {
    return finishJson(request, res, { ok: false, error: "invalid_params" }, 400);
  }
  if (aroundUnread && (beforeMessageId != null || sinceMessageId != null)) {
    return finishJson(request, res, { ok: false, error: "invalid_params" }, 400);
  }
  if (
    aroundMessageId != null &&
    aroundMessageId > 0 &&
    (beforeMessageId != null || sinceMessageId != null || aroundUnread)
  ) {
    return finishJson(request, res, { ok: false, error: "invalid_params" }, 400);
  }

  const started = Date.now();
  const result = await gatewayFetchChatMessages(
    userOrRes,
    chatId,
    limit,
    beforeMessageId,
    sinceMessageId,
    aroundUnread,
    aroundMessageId,
    olderAbove,
    newerBelow,
  );
  logTelegramMessagesApi("messages_history_served", {
    telegramUsername: userOrRes,
    chatId,
    beforeMessageId,
    sinceMessageId,
    aroundUnread,
    aroundMessageId,
    count: result.messages.length,
    hasMoreOlder: result.hasMoreOlder,
    nextBeforeMessageId: result.nextBeforeMessageId,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      {
        ok: false,
        error: result.error,
        messages: [],
        has_more_older: false,
        next_before_message_id: null,
      },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    {
      ok: true,
      chat_kind: result.chatKind,
      member_count: result.memberCount,
      self_user_id: result.selfUserId,
      messages: result.messages,
      has_more_older: result.hasMoreOlder,
      next_before_message_id: result.nextBeforeMessageId,
      last_read_outbox_message_id: result.lastReadOutboxMessageId,
      last_read_inbox_message_id: result.lastReadInboxMessageId,
    },
    200,
  );
}

export async function telegramMessagesMediaHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const chatId = parseOptionalIdParam(url, "chat_id");
  const messageId = parseOptionalIdParam(url, "message_id");
  if (chatId == null || messageId == null) {
    return finishJson(request, res, { ok: false, error: "chat_id_and_message_id_required" }, 400);
  }

  const previewParam = (url.searchParams.get("preview") || "").trim();
  const preview = previewParam === "1" || previewParam === "true";

  const started = Date.now();
  // Full media (incl. chat audio tracks) must be piped — buffering the body here
  // forces the browser to wait for the entire Telegram download before playback.
  if (!preview) {
    const rangeHeader = requestHeader(request, "range");
    const upstream = await gatewayOpenMessageMediaStream(
      userOrRes,
      chatId,
      messageId,
      false,
      rangeHeader,
    );
    if (!upstream) {
      logTelegramMessagesApi("messages_media_unavailable", {
        telegramUsername: userOrRes,
        chatId,
        messageId,
        preview,
        elapsedMs: Date.now() - started,
      });
      return finishJson(request, res, { ok: false, error: "media_unavailable" }, 404);
    }
    logTelegramMessagesApi("messages_media_stream_ok", {
      telegramUsername: userOrRes,
      chatId,
      messageId,
      preview,
      mime: upstream.headers.get("Content-Type") || null,
      elapsedMs: Date.now() - started,
    });
    return finishBinaryStream(request, res, upstream, "public, max-age=86400");
  }

  const media = await gatewayFetchMessageMedia(userOrRes, chatId, messageId, preview);
  if (!media) {
    logTelegramMessagesApi("messages_media_unavailable", {
      telegramUsername: userOrRes,
      chatId,
      messageId,
      preview,
      elapsedMs: Date.now() - started,
    });
    return finishJson(request, res, { ok: false, error: "media_unavailable" }, 404);
  }

  logTelegramMessagesApi("messages_media_ok", {
    telegramUsername: userOrRes,
    chatId,
    messageId,
    preview,
    mime: media.mime,
    bytes: media.data.byteLength,
    elapsedMs: Date.now() - started,
  });

  const headers = new Headers({
    "Content-Type": media.mime,
    "Cache-Control": "public, max-age=86400",
  });
  applyAuthApiCors(request, headers);
  const body = Buffer.from(media.data);

  if (res) {
    res.status(200);
    headers.forEach((v, k) => res.setHeader(k, v));
    res.end(body);
    return;
  }
  return new Response(new Uint8Array(media.data), { status: 200, headers });
}

export async function telegramMessagesCustomEmojiHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected" }, 403);
  }

  const url = requestUrl(request);
  const customEmojiId = (url.searchParams.get("custom_emoji_id") || "").trim();
  const emoji = (url.searchParams.get("emoji") || "").trim();
  const preferStatic =
    url.searchParams.get("static") === "1" || url.searchParams.get("prefer_static") === "1";
  if (!customEmojiId && !emoji) {
    return finishJson(request, res, { ok: false, error: "custom_emoji_id_or_emoji_required" }, 400);
  }

  const sticker = await gatewayFetchTelegramEmoji(userOrRes, {
    customEmojiId,
    emoji,
    preferStatic,
  });
  if (!sticker) {
    logTelegramMessagesApi("custom_emoji_unavailable", {
      telegramUsername: userOrRes,
      customEmojiId: customEmojiId || null,
      emoji: emoji || null,
      preferStatic,
    });
    if (res) {
      res.status(404);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=86400");
      if (request) {
        const headers = new Headers();
        applyAuthApiCors(request, headers);
        headers.forEach((v, k) => res.setHeader(k, v));
      }
      res.end(JSON.stringify({ ok: false, error: "custom_emoji_unavailable" }));
      return;
    }
    const headers = new Headers({ ...JSON_HEADERS, "Cache-Control": "public, max-age=86400" });
    if (request) applyAuthApiCors(request, headers);
    return new Response(JSON.stringify({ ok: false, error: "custom_emoji_unavailable" }), {
      status: 404,
      headers,
    });
  }

  const headers = new Headers({
    "Content-Type": sticker.mime,
    "Cache-Control": "public, max-age=86400",
  });
  applyAuthApiCors(request, headers);
  const body = Buffer.from(sticker.data);

  if (res) {
    res.status(200);
    headers.forEach((v, k) => res.setHeader(k, v));
    res.end(body);
    return;
  }
  return new Response(new Uint8Array(sticker.data), { status: 200, headers });
}

export async function telegramMessagesSendHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    text?: unknown;
    reply_to_message_id?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const replyToMessageId = Number(body.reply_to_message_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    logTelegramMessagesApi("messages_send_bad_request", {
      telegramUsername: userOrRes,
      chatIdRaw: body.chat_id,
      textLength: typeof body.text === "string" ? body.text.length : null,
      error: "chat_id_required",
    });
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!text) {
    return finishJson(request, res, { ok: false, error: "text_required" }, 400);
  }
  if (text.length > 4096) {
    return finishJson(request, res, { ok: false, error: "text_too_long" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySendChatMessage(
    userOrRes,
    chatId,
    text,
    Number.isFinite(replyToMessageId) && replyToMessageId > 0
      ? Math.trunc(replyToMessageId)
      : null,
  );
  logTelegramMessagesApi("messages_send", {
    telegramUsername: userOrRes,
    chatId,
    ok: !result.error,
    replyToMessageId:
      Number.isFinite(replyToMessageId) && replyToMessageId > 0
        ? Math.trunc(replyToMessageId)
        : null,
    messageId:
      result.message && typeof result.message.telegram_message_id === "number"
        ? result.message.telegram_message_id
        : null,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, message: null },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true, message: result.message }, 200);
}

export async function telegramMessagesSendPhotoHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    photo_base64?: unknown;
    caption?: unknown;
    mime?: unknown;
    reply_to_message_id?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const photoBase64 = typeof body.photo_base64 === "string" ? body.photo_base64.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const mime = typeof body.mime === "string" && body.mime.trim() ? body.mime.trim() : "image/jpeg";
  const replyToMessageId = Number(body.reply_to_message_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!photoBase64) {
    return finishJson(request, res, { ok: false, error: "photo_required" }, 400);
  }
  if (caption.length > 4096) {
    return finishJson(request, res, { ok: false, error: "text_too_long" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySendChatPhoto(userOrRes, chatId, photoBase64, {
    caption,
    mime,
    replyToMessageId:
      Number.isFinite(replyToMessageId) && replyToMessageId > 0
        ? Math.trunc(replyToMessageId)
        : null,
  });
  logTelegramMessagesApi("messages_send_photo", {
    telegramUsername: userOrRes,
    chatId,
    ok: !result.error,
    messageId:
      result.message && typeof result.message.telegram_message_id === "number"
        ? result.message.telegram_message_id
        : null,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, message: null },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true, message: result.message }, 200);
}

export async function telegramMessagesVoiceMuteHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    is_muted?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySetChatVoiceMicMuted(
    userOrRes,
    chatId,
    groupCallId,
    Boolean(body.is_muted),
  );
  logTelegramMessagesApi("messages_voice_mute", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true }, 200);
}

export async function telegramMessagesVoiceParticipantVolumeHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    user_id?: unknown;
    peer_chat_id?: unknown;
    volume_percent?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  const volumePercent = Number(body.volume_percent);
  const userId =
    body.user_id != null && body.user_id !== "" ? Number(body.user_id) : null;
  const peerChatId =
    body.peer_chat_id != null && body.peer_chat_id !== ""
      ? Number(body.peer_chat_id)
      : null;
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(volumePercent)) {
    return finishJson(request, res, { ok: false, error: "volume_percent_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySetChatVoiceParticipantVolume(
    userOrRes,
    chatId,
    groupCallId,
    { userId, peerChatId },
    volumePercent,
  );
  logTelegramMessagesApi("messages_voice_participant_volume", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    volume_percent: result.volume_percent,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, volume_percent: result.volume_percent },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    { ok: true, volume_percent: result.volume_percent },
    200,
  );
}

export async function telegramMessagesVoiceSpeakingHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    audio_source_id?: unknown;
    is_speaking?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  // WebRTC SSRC is uint32; TDLib audio_source is signed int32 (may be negative).
  const audioSourceId = Number(body.audio_source_id) | 0;
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(Number(body.audio_source_id)) || audioSourceId === 0) {
    return finishJson(request, res, { ok: false, error: "invalid_audio_source" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySetChatVoiceParticipantSpeaking(
    userOrRes,
    chatId,
    groupCallId,
    audioSourceId,
    Boolean(body.is_speaking),
  );
  logTelegramMessagesApi("messages_voice_speaking", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true }, 200);
}

export async function telegramMessagesVoiceJoinHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    audio_source_id?: unknown;
    payload?: unknown;
    is_muted?: unknown;
    is_my_video_enabled?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  // WebRTC SSRC is uint32; TDLib audio_source_id is signed int32 (may be negative).
  const audioSourceId = Number(body.audio_source_id) | 0;
  const payload = typeof body.payload === "string" ? body.payload : "";
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(Number(body.audio_source_id)) || audioSourceId === 0 || !payload.trim()) {
    return finishJson(request, res, { ok: false, error: "invalid_join_params" }, 400);
  }

  const started = Date.now();
  const result = await gatewayJoinChatVoice(
    userOrRes,
    chatId,
    groupCallId,
    {
      audio_source_id: audioSourceId,
      payload,
      is_muted: Boolean(body.is_muted),
      is_my_video_enabled: Boolean(body.is_my_video_enabled),
    },
  );
  logTelegramMessagesApi("messages_voice_join", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, join_payload: result.join_payload },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    { ok: true, join_payload: result.join_payload },
    200,
  );
}

export async function telegramMessagesVoiceScreenShareStartHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    audio_source_id?: unknown;
    payload?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  const audioSourceId = Number(body.audio_source_id) | 0;
  const payload = typeof body.payload === "string" ? body.payload : "";
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(Number(body.audio_source_id)) || audioSourceId === 0 || !payload.trim()) {
    return finishJson(request, res, { ok: false, error: "invalid_join_params" }, 400);
  }

  const started = Date.now();
  const result = await gatewayStartChatVoiceScreenShare(
    userOrRes,
    chatId,
    groupCallId,
    {
      audio_source_id: audioSourceId,
      payload,
    },
  );
  logTelegramMessagesApi("messages_voice_screen_share_start", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, join_payload: result.join_payload },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    { ok: true, join_payload: result.join_payload },
    200,
  );
}

export async function telegramMessagesVoiceScreenShareEndHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayEndChatVoiceScreenShare(userOrRes, chatId, groupCallId);
  logTelegramMessagesApi("messages_voice_screen_share_end", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true }, 200);
}

export async function telegramMessagesVoiceCallMessageSendHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
    text?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  const text = typeof body.text === "string" ? body.text : "";
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!text.trim()) {
    return finishJson(request, res, { ok: false, error: "text_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySendChatVoiceCallMessage(
    userOrRes,
    chatId,
    groupCallId,
    text,
  );
  logTelegramMessagesApi("messages_voice_call_message_send", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, message: result.message },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true, message: result.message }, 200);
}

export async function telegramMessagesVoiceCallMessagesStreamHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const chatId = Number(url.searchParams.get("chat_id"));
  const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("group_call_id"));
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  const sinceRevision =
    sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "" ? Number(sinceRevisionRaw) : null;
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const abortController = new AbortController();
  const upstreamSignal =
    request instanceof Request && request.signal ? request.signal : undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortController.abort();
    } else {
      upstreamSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const gatewayResponse = await gatewayOpenVoiceCallMessagesStream(
    userOrRes,
    Math.trunc(chatId),
    groupCallId,
    sinceRevision != null && Number.isFinite(sinceRevision) && sinceRevision > 0
      ? sinceRevision
      : null,
    abortController.signal,
  );
  if (!gatewayResponse?.body) {
    return finishJson(request, res, { ok: false, error: "stream_unavailable" }, 503);
  }

  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  applyAuthApiCors(request, sseHeaders);

  logTelegramMessagesApi("messages_voice_call_messages_stream_open", {
    telegramUsername: userOrRes,
    chatId: Math.trunc(chatId),
    groupCallId,
  });

  if (res && typeof res.write === "function") {
    res.status(200);
    sseHeaders.forEach((v, k) => res.setHeader(k, v));
    const reader = gatewayResponse.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      /* client disconnected */
    } finally {
      abortController.abort();
      res.end();
    }
    return;
  }

  return new Response(gatewayResponse.body, { status: 200, headers: sseHeaders });
}

export async function telegramMessagesVoiceStartHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayStartChatVoice(userOrRes, chatId);
  logTelegramMessagesApi("messages_voice_start", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    const status =
      result.error === "session_not_ready"
        ? 503
        : result.error === "voice_chat_not_supported"
          ? 400
          : 502;
    return finishJson(
      request,
      res,
      {
        ok: false,
        error: result.error,
        has_active_voice_chat: result.has_active_voice_chat,
        voice_chat_group_call_id: result.voice_chat_group_call_id,
      },
      status,
    );
  }

  return finishJson(
    request,
    res,
    {
      ok: true,
      has_active_voice_chat: result.has_active_voice_chat,
      voice_chat_group_call_id: result.voice_chat_group_call_id,
    },
    200,
  );
}

export async function telegramMessagesVoiceLeaveHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    group_call_id?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const groupCallId = normalizeTelegramGroupCallId(body.group_call_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayLeaveChatVoice(
    userOrRes,
    chatId,
    groupCallId,
  );
  logTelegramMessagesApi("messages_voice_leave", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      {
        ok: false,
        error: result.error,
        has_active_voice_chat: result.has_active_voice_chat,
        voice_chat_group_call_id: result.voice_chat_group_call_id,
      },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    {
      ok: true,
      has_active_voice_chat: result.has_active_voice_chat,
      voice_chat_group_call_id: result.voice_chat_group_call_id,
    },
    200,
  );
}

export async function telegramMessagesVoiceParticipantsHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const chatId = Number(url.searchParams.get("chat_id"));
  const groupCallId = normalizeTelegramGroupCallId(url.searchParams.get("group_call_id"));
  const forceReload =
    url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayFetchChatVoiceParticipants(
    userOrRes,
    chatId,
    groupCallId,
    { forceReload },
  );
  logTelegramMessagesApi("messages_voice_participants", {
    telegramUsername: userOrRes,
    chatId,
    ok: result.ok,
    count: result.participants.length,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, participants: [], participant_count: 0 },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    {
      ok: true,
      participants: result.participants,
      participant_count: result.participant_count,
      has_active_voice_chat: result.has_active_voice_chat,
      voice_chat_group_call_id: result.voice_chat_group_call_id,
      voice_chat_is_joined: Boolean(result.voice_chat_is_joined),
      voice_resolve_source: result.voice_resolve_source,
      loaded_all_participants: Boolean(result.loaded_all_participants),
      has_hidden_listeners: Boolean(result.has_hidden_listeners),
    },
    200,
  );
}

function mapResolvedChatRow(row: Record<string, unknown>) {
  const telegramChatId = Number(row.telegram_chat_id);
  return {
    id: Number.isFinite(telegramChatId) ? telegramChatId : 0,
    telegram_chat_id: telegramChatId,
    title: typeof row.title === "string" ? row.title : "",
    subtitle: typeof row.subtitle === "string" ? row.subtitle : "",
    avatar_url: typeof row.avatar_url === "string" ? row.avatar_url : null,
    last_message_at:
      typeof row.last_message_at === "string" || typeof row.last_message_at === "number"
        ? String(row.last_message_at)
        : null,
    unread_count: Number.isFinite(Number(row.unread_count)) ? Number(row.unread_count) : 0,
    peer_user_id: Number.isFinite(Number(row.peer_user_id)) ? Number(row.peer_user_id) : null,
    peer_username:
      typeof row.peer_username === "string" && row.peer_username.trim()
        ? row.peer_username.trim().replace(/^@+/, "")
        : null,
    chat_username:
      typeof row.chat_username === "string" && row.chat_username.trim()
        ? row.chat_username.trim().replace(/^@+/, "")
        : null,
    chat_kind:
      row.chat_kind === "private" ||
      row.chat_kind === "group" ||
      row.chat_kind === "supergroup" ||
      row.chat_kind === "channel"
        ? row.chat_kind
        : null,
    member_count: null,
    presence_kind: null,
    presence_at: null,
    chat_action: null,
    chat_action_user_id: null,
    chat_action_user_name: null,
    chat_action_expires_at: null,
    is_pinned: false,
    pin_order: "0",
    last_read_outbox_message_id: null,
  };
}

export async function telegramMessagesResolveChatHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const url = requestUrl(request);
  const username = (url.searchParams.get("username") || "").trim().replace(/^@+/, "");
  if (!username) {
    return finishJson(request, res, { ok: false, error: "username_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayResolvePublicChat(userOrRes, username);
  logTelegramMessagesApi("messages_resolve_chat", {
    telegramUsername: userOrRes,
    username,
    ok: !result.error,
    chatId:
      result.chat && typeof result.chat.telegram_chat_id === "number"
        ? result.chat.telegram_chat_id
        : null,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error || !result.chat) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error ?? "resolve_failed", chat: null },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    { ok: true, chat: mapResolvedChatRow(result.chat) },
    200,
  );
}

export async function telegramMessagesSearchHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  const method = requestMethod(request);

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  if (method === "POST") {
    const body = await parseRequestBody<{ chat_id?: unknown; chatId?: unknown }>(request);
    const chatId = Number(body.chat_id ?? body.chatId);
    if (!Number.isFinite(chatId) || chatId === 0) {
      return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
    }
    const result = await gatewayAddRecentlyFoundChat(userOrRes, Math.trunc(chatId));
    return finishJson(
      request,
      res,
      result.ok ? { ok: true } : { ok: false, error: result.error ?? "recent_chat_add_failed" },
      result.ok ? 200 : 502,
    );
  }

  if (method === "DELETE") {
    const url = requestUrl(request);
    const chatIdRaw = url.searchParams.get("chat_id") ?? url.searchParams.get("chatId");
    const chatId = chatIdRaw != null ? Number(chatIdRaw) : NaN;
    if (Number.isFinite(chatId) && chatId !== 0) {
      const result = await gatewayRemoveRecentlyFoundChat(userOrRes, Math.trunc(chatId));
      return finishJson(
        request,
        res,
        result.ok ? { ok: true } : { ok: false, error: result.error ?? "recent_chat_remove_failed" },
        result.ok ? 200 : 502,
      );
    }
    const result = await gatewayClearRecentlyFoundChats(userOrRes);
    return finishJson(
      request,
      res,
      result.ok ? { ok: true } : { ok: false, error: result.error ?? "recent_chats_clear_failed" },
      result.ok ? 200 : 502,
    );
  }

  if (method !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const url = requestUrl(request);
  const recent =
    url.searchParams.get("recent") === "1" || url.searchParams.get("recent") === "true";
  const query = (url.searchParams.get("query") || "").trim();
  if (!recent && !query) {
    return finishJson(request, res, { ok: true, chatIds: [], peerUserIds: [], chats: [] }, 200);
  }

  const started = Date.now();
  const result = recent
    ? await gatewaySearchRecentChats(userOrRes)
    : await gatewaySearchChats(userOrRes, query);
  logTelegramMessagesApi(recent ? "messages_search_recent" : "messages_search", {
    telegramUsername: userOrRes,
    query: recent ? "" : query,
    ok: !result.error,
    chatIdCount: result.chatIds.length,
    peerUserIdCount: result.peerUserIds.length,
    chatStubCount: result.chats.length,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      {
        ok: false,
        error: result.error,
        chatIds: [],
        peerUserIds: [],
        chats: [],
      },
      result.error === "session_not_ready" || result.error === "session_restoring" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    {
      ok: true,
      chatIds: result.chatIds,
      peerUserIds: result.peerUserIds,
      chats: result.chats,
      directChats: result.directChats,
      globalChats: result.globalChats,
      messageChats: result.messageChats,
      messageCount: result.messageCount,
    },
    200,
  );
}

/** Mint a short-lived ticket so the browser can open SSE directly on the gateway. */
export async function telegramMessagesStreamTicketHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const gatewayBaseUrl = getGatewayPublicBaseUrl();
  if (!gatewayBaseUrl) {
    return finishJson(request, res, { ok: false, error: "gateway_public_url_unavailable" }, 503);
  }

  const url = requestUrl(request);
  const streamRaw = (url.searchParams.get("stream") || "").trim();
  if (!isGatewayStreamKind(streamRaw)) {
    return finishJson(request, res, { ok: false, error: "invalid_stream" }, 400);
  }
  const stream = streamRaw as GatewayStreamKind;
  const chatIdRaw = Number(url.searchParams.get("chat_id"));
  const chatId =
    Number.isFinite(chatIdRaw) && chatIdRaw !== 0 ? Math.trunc(chatIdRaw) : null;
  const groupCallIdRaw = Number(url.searchParams.get("group_call_id"));
  const groupCallId =
    Number.isFinite(groupCallIdRaw) && groupCallIdRaw > 0
      ? Math.trunc(groupCallIdRaw)
      : null;
  const callIdRaw = Number(url.searchParams.get("call_id"));
  const callId =
    Number.isFinite(callIdRaw) && callIdRaw > 0 ? Math.trunc(callIdRaw) : null;

  if (
    (stream === "history" ||
      stream === "voice_participants" ||
      stream === "voice_messages") &&
    (chatId == null || chatId === 0)
  ) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }

  if (stream === "private_call_audio" || stream === "private_call_video") {
    if (callId == null || callId <= 0) {
      return finishJson(request, res, { ok: false, error: "call_id_required" }, 400);
    }
  }

  const minted = mintStreamTicket({
    telegramUsername: userOrRes,
    stream,
    chatId,
    groupCallId,
    callId,
  });
  const path = gatewayStreamPathForKind(stream);
  const params = new URLSearchParams({
    telegramUsername: userOrRes,
    streamTicket: minted.token,
  });
  if (chatId != null) params.set("chatId", String(chatId));
  if (groupCallId != null) params.set("groupCallId", String(groupCallId));
  if (callId != null) params.set("callId", String(callId));
  const sinceRevisionRaw = url.searchParams.get("since_revision");
  if (sinceRevisionRaw != null && sinceRevisionRaw.trim() !== "") {
    const sinceRevision = Number(sinceRevisionRaw);
    if (Number.isFinite(sinceRevision) && sinceRevision > 0) {
      params.set("sinceRevision", String(Math.trunc(sinceRevision)));
    }
  }

  const streamUrl = `${gatewayBaseUrl}${path}?${params.toString()}`;
  const wsUrl =
    stream === "private_call_audio" || stream === "private_call_video"
      ? `${gatewayHttpToWebSocketUrl(gatewayBaseUrl)}${path}?${params.toString()}`
      : null;
  logTelegramMessagesApi("messages_stream_ticket", {
    telegramUsername: userOrRes,
    stream,
    chatId,
    groupCallId,
    callId,
    expiresAt: minted.expiresAt,
  });

  return finishJson(
    request,
    res,
    {
      ok: true,
      stream,
      gatewayBaseUrl,
      path,
      token: minted.token,
      expiresAt: minted.expiresAt,
      url: streamUrl,
      wsUrl,
    },
    200,
  );
}

export async function telegramMessagesEditHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    message_id?: unknown;
    text?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const messageId = Number(body.message_id);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return finishJson(request, res, { ok: false, error: "message_id_required" }, 400);
  }
  if (!text) {
    return finishJson(request, res, { ok: false, error: "text_required" }, 400);
  }
  if (text.length > 4096) {
    return finishJson(request, res, { ok: false, error: "text_too_long" }, 400);
  }

  const started = Date.now();
  const result = await gatewayEditChatMessage(userOrRes, chatId, messageId, text);
  logTelegramMessagesApi("messages_edit", {
    telegramUsername: userOrRes,
    chatId,
    messageId,
    ok: !result.error,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, message: null },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, { ok: true, message: result.message }, 200);
}

export async function telegramMessagesDeleteHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    message_id?: unknown;
    message_ids?: unknown;
  }>(request);

  const chatId = Number(body.chat_id);
  const messageIds = Array.isArray(body.message_ids)
    ? body.message_ids.map((id) => Number(id))
    : body.message_id != null
      ? [Number(body.message_id)]
      : [];
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  const normalizedIds = [
    ...new Set(
      messageIds
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id)),
    ),
  ];
  if (normalizedIds.length === 0) {
    return finishJson(request, res, { ok: false, error: "message_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayDeleteChatMessages(userOrRes, chatId, normalizedIds);
  logTelegramMessagesApi("messages_delete", {
    telegramUsername: userOrRes,
    chatId,
    count: normalizedIds.length,
    ok: !result.error,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error, deleted_message_ids: [] },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(
    request,
    res,
    { ok: true, deleted_message_ids: result.deleted_message_ids },
    200,
  );
}

export async function telegramMessagesWarmupHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  let connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    const existing = await getMtprotoSession(userOrRes);
    const hadAuthorizedUser =
      existing?.telegram_user_id != null &&
      Number.isFinite(existing.telegram_user_id) &&
      existing.telegram_user_id > 0;
    if (hadAuthorizedUser) {
      const persistedOnGateway = await gatewayUserHasPersistedSession(userOrRes);
      if (persistedOnGateway) {
        const { markTelegramMessagesConnected } = await import("../../database/telegramMessages.js");
        const { upsertMtprotoSession } = await import("../../database/telegramMtproto.js");
        await upsertMtprotoSession({
          telegramUsername: userOrRes,
          telegramUserId: existing?.telegram_user_id ?? null,
          tdlibDbPath: existing?.tdlib_db_path?.trim() || `gateway:${userOrRes}`,
          status: "active",
        });
        await markTelegramMessagesConnected(userOrRes);
        connected = true;
        logTelegramMessagesApi("messages_warmup_healed_from_persisted_session", {
          telegramUsername: userOrRes,
        });
      }
    }
  }
  if (!connected) {
    return finishJson(request, res, { ok: false, connected: false, error: "not_connected" }, 403);
  }

  const body = await parseRequestBody<{ chat_id?: number }>(request);
  const focusChatId = Number(body.chat_id);

  const warm = await gatewayWarmupSession(userOrRes, { maxPollMs: 25_000 });
  if (warm.error === "no_session") {
    const persistedOnGateway = await gatewayUserHasPersistedSession(userOrRes);
    if (persistedOnGateway) {
      return finishJson(request, res, {
        ok: false,
        connected: true,
        warming: true,
        gatewayReady: false,
        authState: warm.authState,
        error: "session_restoring",
      });
    }
    // Keep the product-level link in DB; client will resume MTProto silently.
    // Revoking here raced auth/session and surfaced a false "disconnected" UI.
    return finishJson(request, res, {
      ok: false,
      connected: true,
      needsReconnect: true,
      gatewayReady: false,
      authState: warm.authState,
      error: warm.error,
    });
  }

  if (!warm.ok && isGatewaySessionWarmingError(warm.error)) {
    return finishJson(request, res, {
      ok: false,
      connected: true,
      warming: true,
      gatewayReady: false,
      authState: warm.authState,
      error: warm.error ?? "session_not_ready",
    });
  }

  let focusOk: boolean | null = null;
  if (warm.ok && Number.isFinite(focusChatId) && focusChatId !== 0) {
    const focus = await gatewayFocusChat(userOrRes, focusChatId);
    focusOk = focus.ok;
  }

  return finishJson(request, res, {
    ok: warm.ok,
    connected: true,
    gatewayReady: warm.ok,
    warming: !warm.ok && isGatewaySessionWarmingError(warm.error),
    authState: warm.authState,
    focusOk,
    error: warm.error ?? null,
  });
}

export async function telegramMessagesViewInboxHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    message_id?: unknown;
  }>(request);
  const chatId = Number(body.chat_id);
  const messageId = Number(body.message_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return finishJson(request, res, { ok: false, error: "message_id_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewayViewChatInboxMessages(userOrRes, chatId, Math.trunc(messageId));
  logTelegramMessagesApi("messages_view_inbox", {
    telegramUsername: userOrRes,
    chatId,
    messageId: Math.trunc(messageId),
    unreadCount: result.unread_count,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (result.error) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, {
    ok: true,
    unread_count: result.unread_count,
    last_read_inbox_message_id: result.last_read_inbox_message_id,
  });
}

export async function telegramMessagesPinChatHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_id?: unknown;
    is_pinned?: unknown;
  }>(request);
  const chatId = Number(body.chat_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return finishJson(request, res, { ok: false, error: "chat_id_required" }, 400);
  }
  const isPinned = Boolean(body.is_pinned);

  const started = Date.now();
  const result = await gatewayToggleChatPinned(userOrRes, chatId, isPinned);
  logTelegramMessagesApi("messages_pin_chat", {
    telegramUsername: userOrRes,
    chatId,
    isPinned,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error ?? "pin_failed" },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, {
    ok: true,
    is_pinned: result.is_pinned,
  });
}

export async function telegramMessagesPinnedChatsOrderHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }

  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return;
    }
    return userOrRes;
  }

  const connected = await isTelegramMessagesConnected(userOrRes);
  if (!connected) {
    return finishJson(request, res, { ok: false, error: "not_connected", connected: false }, 403);
  }

  const body = await parseRequestBody<{
    chat_ids?: unknown;
    archive?: unknown;
  }>(request);
  const chatIds = Array.isArray(body.chat_ids)
    ? body.chat_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id !== 0)
    : [];
  if (chatIds.length === 0) {
    return finishJson(request, res, { ok: false, error: "chat_ids_required" }, 400);
  }

  const started = Date.now();
  const result = await gatewaySetPinnedChatsOrder(userOrRes, chatIds, {
    archive: Boolean(body.archive),
  });
  logTelegramMessagesApi("messages_pinned_chats_order", {
    telegramUsername: userOrRes,
    chatCount: chatIds.length,
    error: result.error,
    elapsedMs: Date.now() - started,
  });

  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error ?? "reorder_pinned_failed" },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }

  return finishJson(request, res, {
    ok: true,
    chat_ids: result.chat_ids,
  });
}

async function requireConnectedUser(
  request: AnyRequest,
  res?: NodeRes,
): Promise<string | Response | null> {
  const userOrRes = await requireUser(request);
  if (userOrRes instanceof Response) {
    if (res) {
      res.status(userOrRes.status);
      userOrRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await userOrRes.text());
      return null;
    }
    return userOrRes;
  }
  if (!(await isTelegramMessagesConnected(userOrRes))) {
    await finishJson(request, res, { ok: false, error: "not_connected" }, 403);
    return null;
  }
  return userOrRes;
}

export async function telegramMessagesContactsHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  const method = requestMethod(request);
  if (method !== "GET" && method !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }
  const userOrRes = await requireConnectedUser(request, res);
  if (userOrRes instanceof Response) return userOrRes;
  if (!userOrRes) return;

  if (method === "GET") {
    const result = await gatewayListContacts(userOrRes);
    if (!result.ok) {
      return finishJson(
        request,
        res,
        { ok: false, error: result.error },
        result.error === "session_not_ready" ? 503 : 502,
      );
    }
    return finishJson(request, res, { ok: true, contacts: result.contacts });
  }

  const body = await parseRequestBody<{
    phoneNumber?: unknown;
    phone_number?: unknown;
    firstName?: unknown;
    first_name?: unknown;
    lastName?: unknown;
    last_name?: unknown;
  }>(request);
  const result = await gatewayAddContact(userOrRes, {
    phoneNumber: String(body.phoneNumber ?? body.phone_number ?? ""),
    firstName: String(body.firstName ?? body.first_name ?? ""),
    lastName: String(body.lastName ?? body.last_name ?? ""),
  });
  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 400,
    );
  }
  return finishJson(request, res, {
    ok: true,
    user_id: result.userId,
    chat_id: result.chatId,
  });
}

export async function telegramMessagesCreateGroupHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }
  const userOrRes = await requireConnectedUser(request, res);
  if (userOrRes instanceof Response) return userOrRes;
  if (!userOrRes) return;
  const body = await parseRequestBody<{
    title?: unknown;
    userIds?: unknown;
    user_ids?: unknown;
  }>(request);
  const rawIds = Array.isArray(body.userIds)
    ? body.userIds
    : Array.isArray(body.user_ids)
      ? body.user_ids
      : [];
  const result = await gatewayCreateGroup(userOrRes, {
    title: String(body.title ?? ""),
    userIds: rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
  });
  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 400,
    );
  }
  return finishJson(request, res, {
    ok: true,
    chat: {
      telegram_chat_id: result.chat.chatId,
      title: result.chat.title,
      chat_kind: result.chat.chatKind,
    },
  });
}

export async function telegramMessagesCreateChannelHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "POST") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }
  const userOrRes = await requireConnectedUser(request, res);
  if (userOrRes instanceof Response) return userOrRes;
  if (!userOrRes) return;
  const body = await parseRequestBody<{ title?: unknown; description?: unknown }>(request);
  const result = await gatewayCreateChannel(userOrRes, {
    title: String(body.title ?? ""),
    description: String(body.description ?? ""),
  });
  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 400,
    );
  }
  return finishJson(request, res, {
    ok: true,
    chat: {
      telegram_chat_id: result.chat.chatId,
      title: result.chat.title,
      chat_kind: result.chat.chatKind,
    },
  });
}

export async function telegramMessagesCallsHandler(
  request: AnyRequest,
  res?: NodeRes,
): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) return finishPreflight(request, res, preflight);
  if (requestMethod(request) !== "GET") {
    return finishJson(request, res, { ok: false, error: "method_not_allowed" }, 405);
  }
  const userOrRes = await requireConnectedUser(request, res);
  if (userOrRes instanceof Response) return userOrRes;
  if (!userOrRes) return;
  const result = await gatewayFetchCallsOverview(userOrRes);
  if (!result.ok) {
    return finishJson(
      request,
      res,
      { ok: false, error: result.error },
      result.error === "session_not_ready" ? 503 : 502,
    );
  }
  return finishJson(request, res, {
    ok: true,
    active_voice_chats: result.activeVoiceChats,
    history: result.history,
  });
}

