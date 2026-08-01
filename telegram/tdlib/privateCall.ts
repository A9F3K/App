import type { Client } from "tdl";
import { logGateway } from "./gatewayLog.js";

/**
 * Protocol layers / tgcalls versions accepted by current Telegram clients.
 * Versions come from tgcalls::Meta::Versions() (V2: 7–13; legacy: 2.4–5).
 * Prefer newest first so peers negotiate a modern stack.
 * @see https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1call_protocol.html
 */
const CALL_PROTOCOL = {
  _: "callProtocol" as const,
  udp_p2p: true,
  udp_reflector: true,
  min_layer: 65,
  max_layer: 92,
  library_versions: [
    "13.0.0",
    "12.0.0",
    "9.0.0",
    "8.0.0",
    "7.0.0",
    "5.0.0",
    "4.0.0",
    "3.0.0",
    "2.7.7",
    "2.4.4",
  ],
};

export type PrivateCallPhase =
  | "idle"
  | "dialing"
  | "ringing"
  | "exchanging"
  | "ready"
  | "hanging_up"
  | "discarded"
  | "error";

export type PrivateCallSnapshot = {
  call_id: number;
  user_id: number;
  is_outgoing: boolean;
  is_video: boolean;
  phase: PrivateCallPhase;
  error: string | null;
  /** Encryption key fingerprint emojis when connected. */
  emojis: string[];
  /** True once callStateReady exposed an encryption key (media needs tgcalls). */
  has_encryption_key: boolean;
  /** Reflector / P2P server count from callStateReady. */
  server_count: number;
};

type CallState = {
  _?: string;
  is_created?: boolean;
  is_received?: boolean;
  emojis?: string[];
  error?: { message?: string };
  encryption_key?: unknown;
  servers?: unknown[];
};

type CachedCall = {
  callId: number;
  userId: number;
  isOutgoing: boolean;
  isVideo: boolean;
  phase: PrivateCallPhase;
  error: string | null;
  emojis: string[];
  hasEncryptionKey: boolean;
  serverCount: number;
  updatedAt: number;
};

const callsByUsername = new Map<string, CachedCall>();
/** Pending signaling payloads awaiting tgcalls (updateNewCallSignalingData). */
const signalingByCallId = new Map<number, Buffer[]>();

function phaseFromState(state: CallState | null | undefined): PrivateCallPhase {
  const id = typeof state?._ === "string" ? state._ : "";
  switch (id) {
    case "callStatePending": {
      // is_received → peer's device got the call (ringing). Until then: dialing.
      if (state?.is_received === true) return "ringing";
      return "dialing";
    }
    case "callStateExchangingKeys":
      return "exchanging";
    case "callStateReady":
      return "ready";
    case "callStateHangingUp":
      return "hanging_up";
    case "callStateDiscarded":
      return "discarded";
    case "callStateError":
      return "error";
    default:
      return "dialing";
  }
}

function hasEncryptionKey(state: CallState | null | undefined): boolean {
  const key = state?.encryption_key;
  if (key == null) return false;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(key)) return key.length > 0;
  if (key instanceof Uint8Array) return key.length > 0;
  if (typeof key === "string") return key.length > 0;
  return true;
}

function serverCountFromState(state: CallState | null | undefined): number {
  return Array.isArray(state?.servers) ? state!.servers!.length : 0;
}

function snapshotFromCache(cached: CachedCall): PrivateCallSnapshot {
  return {
    call_id: cached.callId,
    user_id: cached.userId,
    is_outgoing: cached.isOutgoing,
    is_video: cached.isVideo,
    phase: cached.phase,
    error: cached.error,
    emojis: cached.emojis,
    has_encryption_key: cached.hasEncryptionKey,
    server_count: cached.serverCount,
  };
}

function rememberCall(telegramUsername: string, cached: CachedCall): void {
  callsByUsername.set(telegramUsername, cached);
}

function buildCachedFromCall(
  telegramUsername: string,
  call: {
    id?: number;
    user_id?: number;
    is_outgoing?: boolean;
    is_video?: boolean;
    state?: CallState;
  },
  existing?: CachedCall | null,
): CachedCall | null {
  if (!call || !Number.isFinite(Number(call.id))) return null;
  const callId = Math.trunc(Number(call.id));
  const state = call.state;
  const phase = phaseFromState(state);
  const emojis = Array.isArray(state?.emojis)
    ? state!.emojis!.filter((e): e is string => typeof e === "string")
    : existing?.emojis ?? [];
  const error =
    phase === "error"
      ? (typeof state?.error?.message === "string" && state.error.message.trim()) ||
        "call_error"
      : null;
  const next: CachedCall = {
    callId,
    userId: Number(call.user_id) || existing?.userId || 0,
    isOutgoing: Boolean(call.is_outgoing ?? existing?.isOutgoing ?? true),
    isVideo: Boolean(call.is_video ?? existing?.isVideo ?? false),
    phase,
    error,
    emojis,
    hasEncryptionKey: hasEncryptionKey(state) || existing?.hasEncryptionKey === true,
    serverCount: serverCountFromState(state) || existing?.serverCount || 0,
    updatedAt: Date.now(),
  };
  if (existing && existing.phase !== next.phase) {
    logGateway("private_call_phase", {
      telegramUsername,
      callId: next.callId,
      from: existing.phase,
      to: next.phase,
      hasEncryptionKey: next.hasEncryptionKey,
      serverCount: next.serverCount,
      emojiCount: next.emojis.length,
    });
  }
  return next;
}

export function getCachedPrivateCall(telegramUsername: string): PrivateCallSnapshot | null {
  const cached = callsByUsername.get(telegramUsername);
  if (!cached) return null;
  if (cached.phase === "discarded" || cached.phase === "error") {
    if (Date.now() - cached.updatedAt > 15_000) {
      callsByUsername.delete(telegramUsername);
      signalingByCallId.delete(cached.callId);
      return null;
    }
  }
  return snapshotFromCache(cached);
}

export function applyPrivateCallUpdate(
  telegramUsername: string,
  update: Record<string, unknown>,
): PrivateCallSnapshot | null {
  if (update._ === "updateNewCallSignalingData") {
    const callId = Number(update.call_id);
    if (!Number.isFinite(callId) || callId <= 0) return null;
    const raw = update.data;
    let buf: Buffer | null = null;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) {
      buf = raw;
    } else if (raw instanceof Uint8Array) {
      buf = Buffer.from(raw);
    } else if (typeof raw === "string" && raw.length > 0) {
      buf = Buffer.from(raw, "base64");
    }
    if (buf && buf.length > 0) {
      const list = signalingByCallId.get(Math.trunc(callId)) ?? [];
      list.push(buf);
      // Cap buffer — without tgcalls we only keep recent packets for diagnostics.
      if (list.length > 64) list.splice(0, list.length - 64);
      signalingByCallId.set(Math.trunc(callId), list);
      logGateway("private_call_signaling_in", {
        telegramUsername,
        callId: Math.trunc(callId),
        byteLength: buf.length,
        queued: list.length,
      });
    }
    return getCachedPrivateCall(telegramUsername);
  }

  if (update._ !== "updateCall") return null;
  const call = update.call as
    | {
        id?: number;
        user_id?: number;
        is_outgoing?: boolean;
        is_video?: boolean;
        state?: CallState;
      }
    | undefined;
  const existing = callsByUsername.get(telegramUsername);
  if (
    existing &&
    call &&
    Number(call.id) !== existing.callId &&
    existing.phase === "ready"
  ) {
    // Ignore unrelated call updates while one is active.
    return snapshotFromCache(existing);
  }
  const next = buildCachedFromCall(telegramUsername, call ?? {}, existing);
  if (!next) return null;
  rememberCall(telegramUsername, next);
  return snapshotFromCache(next);
}

export function takePendingCallSignalingData(callId: number): Buffer[] {
  const id = Math.trunc(callId);
  const list = signalingByCallId.get(id) ?? [];
  signalingByCallId.delete(id);
  return list;
}

export async function createPrivateCallForUser(
  client: Client,
  telegramUsername: string,
  userId: number,
  options?: { isVideo?: boolean },
): Promise<
  | { ok: true; call: PrivateCallSnapshot }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  const existing = callsByUsername.get(telegramUsername);
  if (
    existing &&
    (existing.phase === "dialing" ||
      existing.phase === "ringing" ||
      existing.phase === "exchanging" ||
      existing.phase === "ready")
  ) {
    return { ok: true, call: snapshotFromCache(existing) };
  }
  try {
    const created = (await client.invoke({
      _: "createCall",
      user_id: Math.trunc(userId),
      protocol: CALL_PROTOCOL,
      is_video: Boolean(options?.isVideo),
    })) as {
      id?: number;
      user_id?: number;
      is_outgoing?: boolean;
      is_video?: boolean;
      state?: CallState;
    };
    const callId = Number(created.id);
    if (!Number.isFinite(callId) || callId <= 0) {
      return { ok: false, error: "create_call_failed" };
    }
    let cached =
      buildCachedFromCall(
        telegramUsername,
        {
          ...created,
          user_id: created.user_id ?? Math.trunc(userId),
          is_outgoing: created.is_outgoing !== false,
          is_video: Boolean(created.is_video ?? options?.isVideo),
        },
        null,
      ) ?? {
        callId: Math.trunc(callId),
        userId: Math.trunc(userId),
        isOutgoing: true,
        isVideo: Boolean(options?.isVideo),
        phase: "dialing" as const,
        error: null,
        emojis: [],
        hasEncryptionKey: false,
        serverCount: 0,
        updatedAt: Date.now(),
      };
    rememberCall(telegramUsername, cached);
    logGateway("private_call_created", {
      userId: cached.userId,
      callId: cached.callId,
      phase: cached.phase,
      protocolMaxLayer: CALL_PROTOCOL.max_layer,
      libraryVersions: CALL_PROTOCOL.library_versions.slice(0, 3),
    });
    // Refresh once — pending / is_received often arrives as a follow-up update.
    try {
      const fresh = (await client.invoke({
        _: "getCall",
        call_id: cached.callId,
      })) as {
        id?: number;
        state?: CallState;
        is_outgoing?: boolean;
        is_video?: boolean;
        user_id?: number;
      };
      const refreshed = buildCachedFromCall(telegramUsername, fresh, cached);
      if (refreshed) {
        cached = refreshed;
        rememberCall(telegramUsername, cached);
      }
    } catch {
      // keep create result
    }
    return { ok: true, call: snapshotFromCache(cached) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_create_failed", { userId, message });
    return { ok: false, error: message || "create_call_failed" };
  }
}

export async function acceptPrivateCallForUser(
  client: Client,
  telegramUsername: string,
  callId: number,
): Promise<
  | { ok: true; call: PrivateCallSnapshot }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(callId) || callId <= 0) {
    return { ok: false, error: "call_id_required" };
  }
  try {
    await client.invoke({
      _: "acceptCall",
      call_id: Math.trunc(callId),
      protocol: CALL_PROTOCOL,
    });
    const refreshed = await refreshPrivateCallForUser(client, telegramUsername, callId);
    if (!refreshed) {
      return { ok: false, error: "accept_call_failed" };
    }
    logGateway("private_call_accepted", {
      telegramUsername,
      callId: refreshed.call_id,
      phase: refreshed.phase,
    });
    return { ok: true, call: refreshed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_accept_failed", { callId, message });
    return { ok: false, error: message || "accept_call_failed" };
  }
}

export async function sendPrivateCallSignalingData(
  client: Client,
  callId: number,
  data: Buffer | Uint8Array | string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(callId) || callId <= 0) {
    return { ok: false, error: "call_id_required" };
  }
  let bytes: Buffer;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    bytes = data;
  } else if (data instanceof Uint8Array) {
    bytes = Buffer.from(data);
  } else if (typeof data === "string") {
    bytes = Buffer.from(data, "base64");
  } else {
    return { ok: false, error: "invalid_signaling_data" };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "empty_signaling_data" };
  }
  try {
    await client.invoke({
      _: "sendCallSignalingData",
      call_id: Math.trunc(callId),
      data: bytes,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_signaling_out_failed", { callId, message });
    return { ok: false, error: message || "send_signaling_failed" };
  }
}

export async function refreshPrivateCallForUser(
  client: Client,
  telegramUsername: string,
  callId?: number | null,
): Promise<PrivateCallSnapshot | null> {
  const cached = callsByUsername.get(telegramUsername);
  const id =
    callId != null && Number.isFinite(callId) && callId! > 0
      ? Math.trunc(callId!)
      : cached?.callId;
  if (id == null || id <= 0) return cached ? snapshotFromCache(cached) : null;
  try {
    const fresh = (await client.invoke({
      _: "getCall",
      call_id: id,
    })) as {
      id?: number;
      user_id?: number;
      is_outgoing?: boolean;
      is_video?: boolean;
      state?: CallState;
    };
    const next = buildCachedFromCall(telegramUsername, fresh, cached);
    if (!next) return cached ? snapshotFromCache(cached) : null;
    rememberCall(telegramUsername, next);
    return snapshotFromCache(next);
  } catch {
    return cached ? snapshotFromCache(cached) : null;
  }
}

export async function discardPrivateCallForUser(
  client: Client,
  telegramUsername: string,
  callId?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cached = callsByUsername.get(telegramUsername);
  const id =
    callId != null && Number.isFinite(callId) && callId! > 0
      ? Math.trunc(callId!)
      : cached?.callId;
  if (id == null || id <= 0) {
    callsByUsername.delete(telegramUsername);
    return { ok: true };
  }
  try {
    await client.invoke({
      _: "discardCall",
      call_id: id,
      is_disconnected: false,
      duration: 0,
      is_video: Boolean(cached?.isVideo),
      connection_id: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Already ended is fine.
    if (!/CALL_ALREADY_DECLINED|CALL_NOT_FOUND|400/i.test(message)) {
      logGateway("private_call_discard_failed", { callId: id, message });
    }
  }
  signalingByCallId.delete(id);
  rememberCall(telegramUsername, {
    callId: id,
    userId: cached?.userId ?? 0,
    isOutgoing: cached?.isOutgoing ?? true,
    isVideo: cached?.isVideo ?? false,
    phase: "discarded",
    error: null,
    emojis: cached?.emojis ?? [],
    hasEncryptionKey: cached?.hasEncryptionKey ?? false,
    serverCount: cached?.serverCount ?? 0,
    updatedAt: Date.now(),
  });
  return { ok: true };
}
