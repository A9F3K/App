import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { getGatewayBaseUrl, getGatewaySecret } from "../../telegram/tdlib/env.js";
import {
  gatewayHealthCheckDetailed,
  logTdlibGatewayApi,
  type GatewayHealthResult,
} from "./tdlib-gateway-debug.js";

export type GatewayConnectSnapshot = {
  ok?: boolean;
  attemptId?: string;
  telegramUsername?: string;
  authState?: string;
  qrLink?: string | null;
  error?: string | null;
  chatCount?: number | null;
  codeDelivery?: {
    type: string;
    nextType?: string | null;
    timeoutSec?: number | null;
    phoneMasked?: string | null;
  } | null;
};

async function gatewayFetch(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; json: GatewayConnectSnapshot & Record<string, unknown> }> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const url = `${base}${path}`;
  const started = Date.now();
  logTdlibGatewayApi("gateway_fetch_start", {
    method: init?.method ?? "GET",
    path,
    gatewayHost: safeHost(url),
  });
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Secret": secret,
        ...(init?.headers ?? {}),
      },
    });
    const json = (await response.json().catch(() => ({}))) as GatewayConnectSnapshot &
      Record<string, unknown>;
    logTdlibGatewayApi("gateway_fetch_done", {
      path,
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      authState: typeof json.authState === "string" ? json.authState : null,
      error: typeof json.error === "string" ? json.error : null,
    });
    return { response, json };
  } catch (err) {
    logTdlibGatewayApi("gateway_fetch_error", {
      path,
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    throw err;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function gatewayConnectStart(
  telegramUsername: string,
  options?: { resume?: boolean; fresh?: boolean; resumeOnly?: boolean; authMethod?: "qr" | "phone" },
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch("/v1/connect/start", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      resume: Boolean(options?.resume),
      fresh: Boolean(options?.fresh),
      resumeOnly: Boolean(options?.resumeOnly),
      authMethod: options?.authMethod === "phone" ? "phone" : "qr",
    }),
  });
  return { ...json, httpStatus: response.status };
}

export async function gatewayConnectStatus(
  attemptId: string,
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch(
    `/v1/connect/status?attemptId=${encodeURIComponent(attemptId)}`,
    { method: "GET" },
  );
  return { ...json, httpStatus: response.status };
}

export async function gatewayConnectUserStatus(
  telegramUsername: string,
): Promise<(GatewayConnectSnapshot & { active?: boolean }) | null> {
  const { response, json } = await gatewayFetch(
    `/v1/connect/user-status?telegramUsername=${encodeURIComponent(telegramUsername)}`,
    { method: "GET" },
  );
  if (!response.ok) return null;
  if (json.active === false) return null;
  return json as GatewayConnectSnapshot & { active?: boolean };
}

export async function gatewayConnectPassword(
  attemptId: string,
  password: string,
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch("/v1/connect/password", {
    method: "POST",
    body: JSON.stringify({ attemptId, password }),
  });
  return { ...json, httpStatus: response.status };
}

export async function gatewayConnectPhone(
  attemptId: string,
  phoneNumber: string,
  options?: { isCurrentPhoneNumber?: boolean },
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch("/v1/connect/phone", {
    method: "POST",
    body: JSON.stringify({
      attemptId,
      phoneNumber,
      isCurrentPhoneNumber: Boolean(options?.isCurrentPhoneNumber),
    }),
  });
  return { ...json, httpStatus: response.status };
}

export async function gatewayConnectResendCode(
  attemptId: string,
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch("/v1/connect/code/resend", {
    method: "POST",
    body: JSON.stringify({ attemptId }),
  });
  return { ...json, httpStatus: response.status };
}

export async function gatewayConnectCode(
  attemptId: string,
  code: string,
): Promise<GatewayConnectSnapshot & { httpStatus: number }> {
  const { response, json } = await gatewayFetch("/v1/connect/code", {
    method: "POST",
    body: JSON.stringify({ attemptId, code }),
  });
  return { ...json, httpStatus: response.status };
}

export async function gatewayResyncChats(
  telegramUsername: string,
  options?: { chatIds?: number[]; maxWaitMs?: number },
): Promise<{
  ok: boolean;
  chatCount?: number;
  backfillCount?: number;
  error?: string;
  httpStatus: number;
}> {
  const { response, json } = await gatewayFetch("/v1/connect/resync", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      ...(options?.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {}),
      ...(options?.chatIds?.length ? { chatIds: options.chatIds } : {}),
    }),
  });
  return {
    ok: response.ok && json.ok !== false,
    chatCount: typeof json.chatCount === "number" ? json.chatCount : undefined,
    backfillCount: typeof json.backfillCount === "number" ? json.backfillCount : undefined,
    error: typeof json.error === "string" ? json.error : undefined,
    httpStatus: response.status,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether TDLib session files for this user exist on the gateway disk (survives redeploy with volume). */
export async function gatewayUserHasPersistedSession(telegramUsername: string): Promise<boolean> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({ telegramUsername });
  const url = `${base}/v1/connect/persisted?${params.toString()}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    if (!response.ok) return false;
    const json = (await response.json().catch(() => ({}))) as { persisted?: boolean };
    return json.persisted === true;
  } catch {
    return false;
  }
}

/** Resume TDLib from on-disk session on the gateway (no QR). Polls until ready or timeout. */
export async function gatewayWarmupSession(
  telegramUsername: string,
  options?: { maxPollMs?: number; pollMs?: number },
): Promise<{ ok: boolean; authState: string; error?: string }> {
  const maxPollMs = options?.maxPollMs ?? 90_000;
  const pollMs = options?.pollMs ?? 2_000;

  const resolveAttempt = async (): Promise<{
    attemptId: string | null;
    authState: string;
    error?: string;
  }> => {
    for (let tryIndex = 0; tryIndex < 3; tryIndex += 1) {
      const start = await gatewayConnectStart(telegramUsername, { resume: true, resumeOnly: true });
      if (start.authState === "ready") {
        return { attemptId: start.attemptId ?? null, authState: "ready" };
      }
      if (start.error === "no_session") {
        return { attemptId: null, authState: "failed", error: "no_session" };
      }
      if (start.attemptId) {
        return {
          attemptId: start.attemptId,
          authState: start.authState ?? "initializing",
          error: start.error ?? undefined,
        };
      }
      const user = await gatewayConnectUserStatus(telegramUsername);
      if (user?.authState === "ready") {
        return { attemptId: user.attemptId ?? null, authState: "ready" };
      }
      if (user?.attemptId) {
        return {
          attemptId: user.attemptId,
          authState: user.authState ?? "initializing",
        };
      }
      if (start.authState === "failed" && start.error) {
        return { attemptId: null, authState: "failed", error: start.error };
      }
      await sleepMs(1_000);
    }

    const user = await gatewayConnectUserStatus(telegramUsername);
    if (user?.authState === "ready") {
      return { attemptId: user.attemptId ?? null, authState: "ready" };
    }
    if (user?.attemptId) {
      return {
        attemptId: user.attemptId,
        authState: user.authState ?? "initializing",
      };
    }
    return { attemptId: null, authState: "session_not_ready", error: "session_not_ready" };
  };

  const resolved = await resolveAttempt();
  if (resolved.authState === "ready") {
    return { ok: true, authState: "ready" };
  }
  if (resolved.error === "no_session" || (resolved.authState === "failed" && resolved.error)) {
    return { ok: false, authState: "failed", error: resolved.error ?? "no_session" };
  }

  const attemptId = resolved.attemptId;
  if (!attemptId) {
    return { ok: false, authState: "session_not_ready", error: "session_not_ready" };
  }

  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    await sleepMs(pollMs);
    const snap = await gatewayConnectStatus(attemptId);
    if (snap.authState === "ready") {
      return { ok: true, authState: "ready" };
    }
    if (snap.authState === "failed") {
      return { ok: false, authState: "failed", error: snap.error ?? "warmup_failed" };
    }
  }

  return { ok: false, authState: "session_not_ready", error: "warmup_timeout" };
}

export async function gatewayFocusChat(
  telegramUsername: string,
  chatId: number,
): Promise<{ ok: boolean; error?: string }> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const url = `${base}/v1/chats/focus`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Secret": secret,
      },
      body: JSON.stringify({ telegramUsername, chatId }),
    });
    const json = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: Boolean(json.ok), error: json.error };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "focus_chat_failed",
    };
  }
}

export async function gatewayViewChatInboxMessages(
  telegramUsername: string,
  chatId: number,
  messageId: number,
): Promise<{
  unread_count: number;
  last_read_inbox_message_id: number | null;
  error: string | null;
}> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const url = `${base}/v1/chats/view-inbox`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Secret": secret,
      },
      body: JSON.stringify({ telegramUsername, chatId, messageId }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      unread_count?: number;
      last_read_inbox_message_id?: number;
      error?: string;
    };
    if (!response.ok || !json.ok) {
      return {
        unread_count: 0,
        last_read_inbox_message_id: null,
        error: json.error ?? "view_inbox_failed",
      };
    }
    const unreadRaw = Number(json.unread_count);
    const lastReadRaw = Number(json.last_read_inbox_message_id);
    return {
      unread_count: Number.isFinite(unreadRaw) && unreadRaw >= 0 ? Math.floor(unreadRaw) : 0,
      last_read_inbox_message_id:
        Number.isFinite(lastReadRaw) && lastReadRaw > 0 ? Math.trunc(lastReadRaw) : null,
      error: null,
    };
  } catch (err) {
    return {
      unread_count: 0,
      last_read_inbox_message_id: null,
      error: err instanceof Error ? err.message : "view_inbox_failed",
    };
  }
}

export type ChatListSyncStatus = {
  inProgress: boolean;
  cachedCount: number;
  positionedComplete?: boolean;
  tier3Available?: boolean;
  tier3InProgress?: boolean;
};

export async function gatewayFetchLiveChats(
  telegramUsername: string,
  options?: { sinceRevision?: number | null },
): Promise<{
  chats: Record<string, unknown>[];
  revision: number;
  unchanged?: boolean;
  chatListSync?: ChatListSyncStatus;
} | null> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({ telegramUsername });
  if (
    options?.sinceRevision != null &&
    Number.isFinite(options.sinceRevision) &&
    options.sinceRevision > 0
  ) {
    params.set("sinceRevision", String(options.sinceRevision));
  }
  const url = `${base}/v1/chats/list?${params.toString()}`;
  const started = Date.now();
  logTdlibGatewayApi("gateway_fetch_start", {
    method: "GET",
    path: "/v1/chats/list",
    gatewayHost: safeHost(url),
  });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    if (!response.ok) {
      logTdlibGatewayApi("gateway_fetch_done", {
        path: "/v1/chats/list",
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - started,
      });
      return null;
    }
    const json = (await response.json()) as {
      ok?: boolean;
      unchanged?: boolean;
      chats?: Record<string, unknown>[];
      revision?: number;
      chatListSync?: ChatListSyncStatus;
    };
    const chatListSync = json.chatListSync;
    if (json.unchanged === true) {
      logTdlibGatewayApi("gateway_fetch_done", {
        path: "/v1/chats/list",
        status: response.status,
        ok: true,
        elapsedMs: Date.now() - started,
        revision: Number(json.revision) || 0,
        unchanged: true,
      });
      return {
        chats: [],
        revision: Number(json.revision) || 0,
        unchanged: true,
        chatListSync,
      };
    }
    if (!Array.isArray(json.chats)) {
      logTdlibGatewayApi("gateway_fetch_done", {
        path: "/v1/chats/list",
        status: response.status,
        ok: true,
        elapsedMs: Date.now() - started,
        parseError: "chats_not_array",
      });
      return null;
    }
    logTdlibGatewayApi("gateway_fetch_done", {
      path: "/v1/chats/list",
      status: response.status,
      ok: true,
      elapsedMs: Date.now() - started,
      revision: Number(json.revision) || 0,
      count: json.chats.length,
    });
    return { chats: json.chats, revision: Number(json.revision) || 0, chatListSync };
  } catch (err) {
    logTdlibGatewayApi("gateway_fetch_error", {
      path: "/v1/chats/list",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export async function gatewayLoadMoreChats(
  telegramUsername: string,
  tier: "positioned" | "unpositioned" = "positioned",
): Promise<{
  ok: boolean;
  started?: boolean;
  warming?: boolean;
  tier?: "positioned" | "unpositioned";
  chatListSync?: ChatListSyncStatus;
  error?: string;
}> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const url = `${base}/v1/chats/load-more`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Secret": secret,
      },
      body: JSON.stringify({ telegramUsername, tier }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      started?: boolean;
      warming?: boolean;
      chatListSync?: ChatListSyncStatus;
      error?: string;
    };
    if (!response.ok) {
      return {
        ok: false,
        warming: json.warming === true,
        chatListSync: json.chatListSync,
        error: json.error ?? `HTTP_${response.status}`,
      };
    }
    return {
      ok: json.ok === true,
      started: json.started,
      warming: json.warming === true,
      chatListSync: json.chatListSync,
      error: json.error,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "load_more_failed",
    };
  }
}

export function gatewayLiveChatsStreamUrl(
  telegramUsername: string,
  sinceRevision?: number | null,
): string {
  const base = getGatewayBaseUrl();
  const params = new URLSearchParams({ telegramUsername });
  if (
    sinceRevision != null &&
    Number.isFinite(sinceRevision) &&
    sinceRevision > 0
  ) {
    params.set("sinceRevision", String(sinceRevision));
  }
  return `${base}/v1/chats/stream?${params.toString()}`;
}

export function gatewayVoiceParticipantsStreamUrl(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
  sinceRevision?: number | null,
): string {
  const base = getGatewayBaseUrl();
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(Math.trunc(chatId)),
  });
  const callId = normalizeTelegramGroupCallId(groupCallId);
  if (callId != null) {
    params.set("groupCallId", String(callId));
  }
  if (
    sinceRevision != null &&
    Number.isFinite(sinceRevision) &&
    sinceRevision > 0
  ) {
    params.set("sinceRevision", String(sinceRevision));
  }
  return `${base}/v1/chat/voice/participants/stream?${params.toString()}`;
}

export async function gatewayOpenVoiceParticipantsStream(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
  sinceRevision?: number | null,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = gatewayVoiceParticipantsStreamUrl(
    telegramUsername,
    chatId,
    groupCallId,
    sinceRevision,
  );
  const secret = getGatewaySecret();
  const started = Date.now();
  logTdlibGatewayApi("gateway_stream_start", {
    method: "GET",
    path: "/v1/chat/voice/participants/stream",
    gatewayHost: safeHost(url),
  });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
      signal,
    });
    if (!response.ok || !response.body) {
      logTdlibGatewayApi("gateway_stream_done", {
        path: "/v1/chat/voice/participants/stream",
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - started,
      });
      return null;
    }
    logTdlibGatewayApi("gateway_stream_open", {
      path: "/v1/chat/voice/participants/stream",
      status: response.status,
      ok: true,
      elapsedMs: Date.now() - started,
    });
    return response;
  } catch (err) {
    logTdlibGatewayApi("gateway_stream_error", {
      path: "/v1/chat/voice/participants/stream",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export function gatewayChatMessagesStreamUrl(
  telegramUsername: string,
  chatId: number,
  sinceRevision?: number | null,
): string {
  const base = getGatewayBaseUrl();
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(Math.trunc(chatId)),
  });
  if (
    sinceRevision != null &&
    Number.isFinite(sinceRevision) &&
    sinceRevision > 0
  ) {
    params.set("sinceRevision", String(sinceRevision));
  }
  return `${base}/v1/chat/messages/stream?${params.toString()}`;
}

export async function gatewayOpenChatMessagesStream(
  telegramUsername: string,
  chatId: number,
  sinceRevision?: number | null,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = gatewayChatMessagesStreamUrl(telegramUsername, chatId, sinceRevision);
  const secret = getGatewaySecret();
  const started = Date.now();
  logTdlibGatewayApi("gateway_stream_start", {
    method: "GET",
    path: "/v1/chat/messages/stream",
    gatewayHost: safeHost(url),
  });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
      signal,
    });
    if (!response.ok || !response.body) {
      logTdlibGatewayApi("gateway_stream_done", {
        path: "/v1/chat/messages/stream",
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - started,
      });
      return null;
    }
    logTdlibGatewayApi("gateway_stream_open", {
      path: "/v1/chat/messages/stream",
      status: response.status,
      ok: true,
      elapsedMs: Date.now() - started,
    });
    return response;
  } catch (err) {
    logTdlibGatewayApi("gateway_stream_error", {
      path: "/v1/chat/messages/stream",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export async function gatewayOpenLiveChatsStream(
  telegramUsername: string,
  sinceRevision?: number | null,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = gatewayLiveChatsStreamUrl(telegramUsername, sinceRevision);
  const secret = getGatewaySecret();
  const started = Date.now();
  logTdlibGatewayApi("gateway_stream_start", {
    method: "GET",
    path: "/v1/chats/stream",
    gatewayHost: safeHost(url),
  });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
      signal,
    });
    if (!response.ok || !response.body) {
      logTdlibGatewayApi("gateway_stream_done", {
        path: "/v1/chats/stream",
        status: response.status,
        ok: false,
        elapsedMs: Date.now() - started,
      });
      return null;
    }
    logTdlibGatewayApi("gateway_stream_open", {
      path: "/v1/chats/stream",
      status: response.status,
      ok: true,
      elapsedMs: Date.now() - started,
    });
    return response;
  } catch (err) {
    logTdlibGatewayApi("gateway_stream_error", {
      path: "/v1/chats/stream",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export async function gatewayFetchChatMessages(
  telegramUsername: string,
  chatId: number,
  limit = 50,
  beforeMessageId?: number | null,
  sinceMessageId?: number | null,
  aroundUnread = false,
  aroundMessageId?: number | null,
  olderAbove?: number | null,
  newerBelow?: number | null,
): Promise<{
  messages: Record<string, unknown>[];
  chatKind: string | null;
  memberCount: number | null;
  error: string | null;
  hasMoreOlder: boolean;
  nextBeforeMessageId: number | null;
  lastReadOutboxMessageId: number | null;
  lastReadInboxMessageId: number | null;
  selfUserId: number | null;
}> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(chatId),
    limit: String(limit),
  });
  if (
    typeof beforeMessageId === "number" &&
    Number.isFinite(beforeMessageId) &&
    beforeMessageId > 0
  ) {
    params.set("beforeMessageId", String(beforeMessageId));
  }
  if (
    typeof sinceMessageId === "number" &&
    Number.isFinite(sinceMessageId) &&
    sinceMessageId > 0
  ) {
    params.set("sinceMessageId", String(sinceMessageId));
  }
  if (aroundUnread) {
    params.set("aroundUnread", "1");
  }
  if (
    typeof aroundMessageId === "number" &&
    Number.isFinite(aroundMessageId) &&
    aroundMessageId > 0
  ) {
    params.set("aroundMessageId", String(aroundMessageId));
  }
  if (
    typeof olderAbove === "number" &&
    Number.isFinite(olderAbove) &&
    olderAbove >= 0
  ) {
    params.set("olderAbove", String(Math.trunc(olderAbove)));
  }
  if (
    typeof newerBelow === "number" &&
    Number.isFinite(newerBelow) &&
    newerBelow >= 0
  ) {
    params.set("newerBelow", String(Math.trunc(newerBelow)));
  }
  const url = `${base}/v1/chat/messages?${params.toString()}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      messages?: Record<string, unknown>[];
      chat_kind?: string;
      member_count?: number;
      has_more_older?: boolean;
      next_before_message_id?: number;
      last_read_outbox_message_id?: number;
      last_read_inbox_message_id?: number;
      self_user_id?: number;
      error?: string;
    };
    if (!response.ok || !json.ok) {
      return {
        messages: [],
        chatKind: null,
        error: json.error ?? "history_unavailable",
        hasMoreOlder: false,
        nextBeforeMessageId: null,
        lastReadOutboxMessageId: null,
        lastReadInboxMessageId: null,
        memberCount: null,
        selfUserId: null,
      };
    }
    const lastReadRaw = Number(json.last_read_outbox_message_id);
    const lastReadInboxRaw = Number(json.last_read_inbox_message_id);
    const memberRaw = Number(json.member_count);
    const selfUserRaw = Number(json.self_user_id);
    return {
      messages: Array.isArray(json.messages) ? json.messages : [],
      chatKind: typeof json.chat_kind === "string" ? json.chat_kind : null,
      error: null,
      hasMoreOlder: Boolean(json.has_more_older),
      nextBeforeMessageId:
        typeof json.next_before_message_id === "number" &&
        Number.isFinite(json.next_before_message_id) &&
        json.next_before_message_id > 0
          ? json.next_before_message_id
          : null,
      lastReadOutboxMessageId:
        Number.isFinite(lastReadRaw) && lastReadRaw > 0 ? lastReadRaw : null,
      lastReadInboxMessageId:
        Number.isFinite(lastReadInboxRaw) && lastReadInboxRaw > 0 ? lastReadInboxRaw : null,
      memberCount:
        Number.isFinite(memberRaw) && memberRaw > 0 ? Math.trunc(memberRaw) : null,
      selfUserId:
        Number.isFinite(selfUserRaw) && selfUserRaw > 0 ? Math.trunc(selfUserRaw) : null,
    };
  } catch (err) {
    return {
      messages: [],
      chatKind: null,
      error: err instanceof Error ? err.message : "gateway_unreachable",
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      lastReadOutboxMessageId: null,
      lastReadInboxMessageId: null,
      memberCount: null,
      selfUserId: null,
    };
  }
}

export async function gatewaySetChatVoiceMicMuted(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  isMuted: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const callId = normalizeTelegramGroupCallId(groupCallId);
  const { response, json } = await gatewayFetch("/v1/chat/voice/mute", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      ...(callId != null ? { groupCallId: callId } : {}),
      isMuted,
    }),
  });
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "mute_failed",
    };
  }
  return { ok: true, error: null };
}

export async function gatewaySetChatVoiceParticipantSpeaking(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  audioSourceId: number,
  isSpeaking: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const callId = normalizeTelegramGroupCallId(groupCallId);
  const { response, json } = await gatewayFetch("/v1/chat/voice/speaking", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      ...(callId != null ? { groupCallId: callId } : {}),
      audioSourceId,
      isSpeaking,
    }),
  });
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "speaking_failed",
    };
  }
  return { ok: true, error: null };
}

export async function gatewayJoinChatVoice(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  joinParameters: {
    audio_source_id: number;
    payload: string;
    is_muted: boolean;
    is_my_video_enabled?: boolean;
  },
): Promise<{
  ok: boolean;
  error: string | null;
  join_payload: string;
}> {
  const callId = normalizeTelegramGroupCallId(groupCallId);
  const { response, json } = await gatewayFetch("/v1/chat/voice/join", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      ...(callId != null ? { groupCallId: callId } : {}),
      joinParameters,
    }),
  });
  const joinPayload = typeof json.join_payload === "string" ? json.join_payload : "";
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "join_failed",
      join_payload: joinPayload,
    };
  }
  return {
    ok: true,
    error: null,
    join_payload: joinPayload,
  };
}

export async function gatewayStartChatVoice(
  telegramUsername: string,
  chatId: number,
): Promise<{
  ok: boolean;
  error: string | null;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
}> {
  const { response, json } = await gatewayFetch("/v1/chat/voice/start", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
    }),
  });
  const hasActive = Boolean(json.has_active_voice_chat);
  const voiceCallId = normalizeTelegramGroupCallId(json.voice_chat_group_call_id);
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "start_failed",
      has_active_voice_chat: hasActive,
      voice_chat_group_call_id: voiceCallId,
    };
  }
  return {
    ok: true,
    error: null,
    has_active_voice_chat: hasActive,
    voice_chat_group_call_id: voiceCallId,
  };
}

export async function gatewayLeaveChatVoice(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
): Promise<{
  ok: boolean;
  error: string | null;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
}> {
  const callId = normalizeTelegramGroupCallId(groupCallId);
  const { response, json } = await gatewayFetch("/v1/chat/voice/leave", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      ...(callId != null ? { groupCallId: callId } : {}),
    }),
  });
  const hasActive = Boolean(json.has_active_voice_chat);
  const voiceCallId = normalizeTelegramGroupCallId(json.voice_chat_group_call_id);
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "leave_failed",
      has_active_voice_chat: hasActive,
      voice_chat_group_call_id: voiceCallId,
    };
  }
  return {
    ok: true,
    error: null,
    has_active_voice_chat: hasActive,
    voice_chat_group_call_id: voiceCallId,
  };
}

export async function gatewayFetchChatVoiceParticipants(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
  options?: { forceReload?: boolean },
): Promise<{
  ok: boolean;
  error: string | null;
  participant_count: number;
  participants: Array<{
    user_id: number | null;
    chat_id: number | null;
    title: string;
    description: string;
    emoji_status_custom_emoji_id: string | null;
    is_speaking: boolean;
    is_muted: boolean;
    is_self: boolean;
  }>;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
  voice_resolve_source: string;
}> {
  const callId = normalizeTelegramGroupCallId(groupCallId);
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(chatId),
  });
  if (callId != null) {
    params.set("groupCallId", String(callId));
  }
  if (options?.forceReload) {
    params.set("force", "1");
  }
  const { response, json } = await gatewayFetch(
    `/v1/chat/voice/participants?${params.toString()}`,
    { method: "GET" },
  );
  const participants = Array.isArray(json.participants)
    ? (json.participants as Array<{
        user_id?: unknown;
        chat_id?: unknown;
        title?: unknown;
        description?: unknown;
        emoji_status_custom_emoji_id?: unknown;
        is_speaking?: unknown;
        is_muted?: unknown;
        is_self?: unknown;
      }>).map((row) => {
        const userId = Number(row.user_id);
        const senderChatId = Number(row.chat_id);
        const emojiStatus =
          typeof row.emoji_status_custom_emoji_id === "string" &&
          row.emoji_status_custom_emoji_id.trim()
            ? row.emoji_status_custom_emoji_id.trim()
            : null;
        const isSpeaking = Boolean(row.is_speaking);
        return {
          user_id: Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null,
          chat_id:
            Number.isFinite(senderChatId) && senderChatId !== 0
              ? Math.trunc(senderChatId)
              : null,
          title: typeof row.title === "string" ? row.title : "",
          description: typeof row.description === "string" ? row.description : "",
          emoji_status_custom_emoji_id: emojiStatus,
          is_speaking: isSpeaking,
          is_muted: Boolean(row.is_muted),
          is_self: Boolean(row.is_self),
        };
      })
    : [];
  const participantCount = Number(json.participant_count);
  const voiceCallId = normalizeTelegramGroupCallId(json.voice_chat_group_call_id);
  const hasActive = Boolean(json.has_active_voice_chat) || voiceCallId != null;
  const resolveSource =
    typeof json.voice_resolve_source === "string" ? json.voice_resolve_source : "none";
  if (!response.ok || !json.ok) {
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "participants_failed",
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_resolve_source: "none",
    };
  }
  return {
    ok: true,
    error: null,
    participant_count:
      Number.isFinite(participantCount) && participantCount >= 0
        ? Math.trunc(participantCount)
        : participants.length,
    participants,
    has_active_voice_chat: hasActive,
    voice_chat_group_call_id: voiceCallId,
    voice_resolve_source: resolveSource,
  };
}

export async function gatewaySendChatMessage(
  telegramUsername: string,
  chatId: number,
  text: string,
  replyToMessageId?: number | null,
): Promise<{ message: Record<string, unknown> | null; error: string | null }> {
  const replyId = Number(replyToMessageId);
  const { response, json } = await gatewayFetch("/v1/chat/messages/send", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      text,
      ...(Number.isFinite(replyId) && replyId > 0 ? { replyToMessageId: Math.trunc(replyId) } : {}),
    }),
  });
  const message =
    json.message && typeof json.message === "object" && !Array.isArray(json.message)
      ? (json.message as Record<string, unknown>)
      : null;
  if (!response.ok || !json.ok) {
    return {
      message: null,
      error: typeof json.error === "string" ? json.error : "send_failed",
    };
  }
  return { message, error: null };
}

export async function gatewaySendChatPhoto(
  telegramUsername: string,
  chatId: number,
  photoBase64: string,
  options?: {
    caption?: string | null;
    mime?: string | null;
    replyToMessageId?: number | null;
  },
): Promise<{ message: Record<string, unknown> | null; error: string | null }> {
  const replyId = Number(options?.replyToMessageId);
  const { response, json } = await gatewayFetch("/v1/chat/messages/send-photo", {
    method: "POST",
    body: JSON.stringify({
      telegramUsername,
      chatId,
      photoBase64,
      caption: options?.caption ?? "",
      mime: options?.mime ?? "image/jpeg",
      ...(Number.isFinite(replyId) && replyId > 0
        ? { replyToMessageId: Math.trunc(replyId) }
        : {}),
    }),
  });
  const message =
    json.message && typeof json.message === "object" && !Array.isArray(json.message)
      ? (json.message as Record<string, unknown>)
      : null;
  if (!response.ok || !json.ok) {
    return {
      message: null,
      error: typeof json.error === "string" ? json.error : "send_failed",
    };
  }
  return { message, error: null };
}

export async function gatewayResolvePublicChat(
  telegramUsername: string,
  username: string,
): Promise<{ chat: Record<string, unknown> | null; error: string | null }> {
  const name = username.trim().replace(/^@+/, "");
  const { response, json } = await gatewayFetch(
    `/v1/chat/resolve?telegramUsername=${encodeURIComponent(telegramUsername)}&username=${encodeURIComponent(name)}`,
    { method: "GET" },
  );
  const chat =
    json.chat && typeof json.chat === "object" && !Array.isArray(json.chat)
      ? (json.chat as Record<string, unknown>)
      : null;
  if (!response.ok || !json.ok) {
    return {
      chat: null,
      error: typeof json.error === "string" ? json.error : "resolve_failed",
    };
  }
  return { chat, error: null };
}

export async function gatewayEditChatMessage(
  telegramUsername: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<{ message: Record<string, unknown> | null; error: string | null }> {
  const { response, json } = await gatewayFetch("/v1/chat/messages/edit", {
    method: "POST",
    body: JSON.stringify({ telegramUsername, chatId, messageId, text }),
  });
  const message =
    json.message && typeof json.message === "object" && !Array.isArray(json.message)
      ? (json.message as Record<string, unknown>)
      : null;
  if (!response.ok || !json.ok) {
    return {
      message: null,
      error: typeof json.error === "string" ? json.error : "edit_failed",
    };
  }
  return { message, error: null };
}

export async function gatewayDeleteChatMessages(
  telegramUsername: string,
  chatId: number,
  messageIds: number[],
): Promise<{ deleted_message_ids: number[]; error: string | null }> {
  const { response, json } = await gatewayFetch("/v1/chat/messages/delete", {
    method: "POST",
    body: JSON.stringify({ telegramUsername, chatId, messageIds }),
  });
  const deleted =
    Array.isArray(json.deleted_message_ids)
      ? json.deleted_message_ids
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .map((id) => Math.trunc(id))
      : [];
  if (!response.ok || !json.ok) {
    return {
      deleted_message_ids: [],
      error: typeof json.error === "string" ? json.error : "delete_failed",
    };
  }
  return { deleted_message_ids: deleted, error: null };
}

export async function gatewayFetchMessageMedia(
  telegramUsername: string,
  chatId: number,
  messageId: number,
  preview = false,
): Promise<{ data: ArrayBuffer; mime: string } | null> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(chatId),
    messageId: String(messageId),
  });
  if (preview) params.set("preview", "1");
  const url = `${base}/v1/chat/message-media?${params.toString()}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    if (!response.ok) return null;
    const mime = response.headers.get("Content-Type") || "application/octet-stream";
    const data = await response.arrayBuffer();
    return { data, mime };
  } catch {
    return null;
  }
}

export async function gatewayFetchTelegramEmoji(
  telegramUsername: string,
  options: { customEmojiId?: string; emoji?: string },
): Promise<{ data: ArrayBuffer; mime: string } | null> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({ telegramUsername });
  if (options.customEmojiId?.trim()) params.set("customEmojiId", options.customEmojiId.trim());
  if (options.emoji?.trim()) params.set("emoji", options.emoji.trim());
  const url = `${base}/v1/custom-emoji?${params.toString()}`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    logTdlibGatewayApi("gateway_fetch_done", {
      path: "/v1/custom-emoji",
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      hasCustomEmojiId: Boolean(options.customEmojiId?.trim()),
      hasEmoji: Boolean(options.emoji?.trim()),
    });
    if (!response.ok) return null;
    const mime = response.headers.get("Content-Type") || "application/octet-stream";
    const data = await response.arrayBuffer();
    return { data, mime };
  } catch (err) {
    logTdlibGatewayApi("gateway_fetch_error", {
      path: "/v1/custom-emoji",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export async function gatewayFetchCustomEmoji(
  telegramUsername: string,
  customEmojiId: string,
): Promise<{ data: ArrayBuffer; mime: string } | null> {
  return gatewayFetchTelegramEmoji(telegramUsername, { customEmojiId });
}

export async function gatewayFetchUserAvatar(
  telegramUsername: string,
  userId: number,
): Promise<{ data: ArrayBuffer; mime: string } | "no_avatar" | null> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const url = `${base}/v1/user/avatar?telegramUsername=${encodeURIComponent(telegramUsername)}&userId=${encodeURIComponent(String(userId))}`;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    logTdlibGatewayApi("gateway_fetch_done", {
      path: "/v1/user/avatar",
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      userId,
    });
    if (response.status === 404) return "no_avatar";
    if (!response.ok) return null;
    const mime = response.headers.get("content-type") ?? "image/jpeg";
    return { data: await response.arrayBuffer(), mime };
  } catch (err) {
    logTdlibGatewayApi("gateway_fetch_error", {
      path: "/v1/user/avatar",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      userId,
    });
    return null;
  }
}

export async function gatewayFetchChatAvatar(
  telegramUsername: string,
  chatId: number,
): Promise<{ data: ArrayBuffer; mime: string } | "no_avatar" | null> {
  const base = getGatewayBaseUrl();
  const secret = getGatewaySecret();
  const params = new URLSearchParams({
    telegramUsername,
    chatId: String(chatId),
  });
  const url = `${base}/v1/chat/avatar?${params.toString()}`;
  const started = Date.now();
  logTdlibGatewayApi("gateway_fetch_start", {
    method: "GET",
    path: "/v1/chat/avatar",
    gatewayHost: safeHost(url),
    chatId,
  });
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Gateway-Secret": secret },
    });
    logTdlibGatewayApi("gateway_fetch_done", {
      path: "/v1/chat/avatar",
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      chatId,
    });
    if (response.status === 404) return "no_avatar";
    if (!response.ok) return null;
    const mime = response.headers.get("content-type") ?? "image/jpeg";
    return { data: await response.arrayBuffer(), mime };
  } catch (err) {
    logTdlibGatewayApi("gateway_fetch_error", {
      path: "/v1/chat/avatar",
      elapsedMs: Date.now() - started,
      fetchError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      chatId,
    });
    return null;
  }
}

export async function gatewayDisconnect(telegramUsername: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { response, json } = await gatewayFetch("/v1/disconnect", {
      method: "POST",
      body: JSON.stringify({ telegramUsername }),
    });
    return { ok: response.ok && json.ok !== false, error: typeof json.error === "string" ? json.error : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "gateway_unreachable" };
  }
}

export async function gatewayHealthCheck(): Promise<boolean> {
  const result = await gatewayHealthCheckDetailed();
  return result.ok;
}

export { gatewayHealthCheckDetailed, type GatewayHealthResult };

export function gatewayNotConfiguredResponse(): GatewayConnectSnapshot {
  return {
    authState: "failed",
    error: "tdlib_gateway_not_configured",
    qrLink: null,
    chatCount: null,
  };
}
