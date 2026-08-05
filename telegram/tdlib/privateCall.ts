import type { Client } from "tdl";
import { logGateway } from "./gatewayLog.js";
import { getPrivateCallMediaEstablished } from "./privateCallMedia.js";

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
  /** True once ntgcalls WebRTC transport is connected (peer can finish key exchange). */
  media_established: boolean;
};

type CallState = {
  _?: string;
  is_created?: boolean;
  is_received?: boolean;
  emojis?: string[];
  error?: { message?: string };
  encryption_key?: unknown;
  servers?: unknown[];
  allow_p2p?: boolean;
  protocol?: { library_versions?: string[]; max_layer?: number };
  custom_parameters?: string;
};

type CallPayload = {
  id?: number;
  user_id?: number;
  is_outgoing?: boolean;
  is_video?: boolean;
  state?: CallState;
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
  /** Last TDLib call object (needed because this TDLib build has no getCall). */
  callPayload?: CallPayload;
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

/** Unwrap TDLib bytes / { bytes: ... } / base64 / number[] into a Buffer. */
function unwrapTdlibBytes(raw: unknown): Buffer | null {
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "bytes" in raw) {
    return unwrapTdlibBytes((raw as { bytes: unknown }).bytes);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) {
    return raw.length > 0 ? raw : null;
  }
  if (raw instanceof Uint8Array) {
    return raw.length > 0 ? Buffer.from(raw) : null;
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((n) => typeof n === "number")) {
    return Buffer.from(raw as number[]);
  }
  if (typeof raw === "string" && raw.length > 0) {
    if (/^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length % 4 === 0) {
      const b64 = Buffer.from(raw, "base64");
      if (b64.length > 0) return b64;
    }
    return Buffer.from(raw, "binary");
  }
  return null;
}

function hasEncryptionKey(state: CallState | null | undefined): boolean {
  return unwrapTdlibBytes(state?.encryption_key) != null;
}

function serverCountFromState(state: CallState | null | undefined): number {
  return Array.isArray(state?.servers) ? state!.servers!.length : 0;
}

function snapshotFromCache(
  cached: CachedCall,
  telegramUsername: string,
): PrivateCallSnapshot {
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
    media_established: getPrivateCallMediaEstablished(telegramUsername),
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
    callPayload: {
      id: callId,
      user_id: Number(call.user_id) || existing?.userId || undefined,
      is_outgoing: Boolean(call.is_outgoing ?? existing?.isOutgoing ?? true),
      is_video: Boolean(call.is_video ?? existing?.isVideo ?? false),
      state:
        state && state._ === "callStateReady" && hasEncryptionKey(state)
          ? state
          : existing?.callPayload?.state?._ === "callStateReady" &&
              hasEncryptionKey(existing.callPayload.state)
            ? existing.callPayload.state
            : state ?? existing?.callPayload?.state,
    },
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
  return snapshotFromCache(cached, telegramUsername);
}

function mergeCallWithCache(
  telegramUsername: string,
  call: CallPayload | null | undefined,
): CallPayload | null {
  if (!call) return null;
  const cached = callsByUsername.get(telegramUsername);
  const userId = Number(call.user_id) || cached?.userId || 0;
  const cachedPayload = cached?.callPayload;
  const state =
    call.state && call.state._ === "callStateReady" && hasEncryptionKey(call.state)
      ? call.state
      : call.state?._ === "callStateReady" && cachedPayload?.state?._ === "callStateReady"
        ? { ...cachedPayload.state, ...call.state }
        : call.state ?? cachedPayload?.state;
  return {
    ...cachedPayload,
    ...call,
    id: Number(call.id) || cached?.callId,
    user_id: userId || undefined,
    is_outgoing: call.is_outgoing ?? cached?.isOutgoing,
    is_video: call.is_video ?? cached?.isVideo,
    state,
  };
}

async function maybeStartPrivateCallMedia(
  client: Client,
  telegramUsername: string,
  callOrCallId: CallPayload | number,
): Promise<void> {
  const callId =
    typeof callOrCallId === "number"
      ? Math.trunc(callOrCallId)
      : Math.trunc(Number(callOrCallId.id));
  if (!Number.isFinite(callId) || callId <= 0) {
    logGateway("private_call_media_skip", {
      telegramUsername,
      reason: "no_call_id",
      callId,
    });
    return;
  }

  // This prebuilt-tdlib build has no getCall — rely on updateCall + cached payload.
  const fromArg =
    typeof callOrCallId === "number" ? null : mergeCallWithCache(telegramUsername, callOrCallId);
  const cached = callsByUsername.get(telegramUsername);
  const call =
    fromArg &&
    fromArg.state?._ === "callStateReady" &&
    hasEncryptionKey(fromArg.state) &&
    serverCountFromState(fromArg.state) > 0
      ? fromArg
      : mergeCallWithCache(telegramUsername, cached?.callPayload ?? fromArg);

  if (!call?.state || call.state._ !== "callStateReady") {
    logGateway("private_call_media_skip", {
      telegramUsername,
      callId,
      reason: "not_ready",
      stateType: call?.state?._ ?? null,
    });
    return;
  }
  if (!hasEncryptionKey(call.state) || serverCountFromState(call.state) === 0) {
    logGateway("private_call_media_skip", {
      telegramUsername,
      callId,
      reason: "ready_incomplete",
      hasKey: hasEncryptionKey(call.state),
      serverCount: serverCountFromState(call.state),
    });
    return;
  }

  const cachedUserId = cached?.userId ?? 0;
  if (!(Number(call.user_id) || cachedUserId)) {
    logGateway("private_call_media_skip", {
      telegramUsername,
      callId,
      reason: "no_user_id",
    });
    return;
  }

  try {
    const { ensurePrivateCallMediaStarted } = await import("./privateCallMedia.js");
    ensurePrivateCallMediaStarted(
      client,
      telegramUsername,
      {
        ...call,
        user_id: Number(call.user_id) || cachedUserId,
      },
      async (id, data) => {
        const result = await sendPrivateCallSignalingData(client, id, data);
        return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
      },
      cachedUserId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_media_hook_failed", { telegramUsername, message });
  }
}

export function applyPrivateCallUpdate(
  telegramUsername: string,
  update: Record<string, unknown>,
  client?: Client | null,
): PrivateCallSnapshot | null {
  if (update._ === "updateNewCallSignalingData") {
    const callId = Number(update.call_id);
    if (!Number.isFinite(callId) || callId <= 0) return null;
    // TDLib often wraps bytes as { bytes: Buffer|base64 }; unwrap before gating.
    const buf = unwrapTdlibBytes(update.data);
    if (buf && buf.length > 0) {
      const list = signalingByCallId.get(Math.trunc(callId)) ?? [];
      list.push(buf);
      if (list.length > 64) list.splice(0, list.length - 64);
      signalingByCallId.set(Math.trunc(callId), list);
      logGateway("private_call_signaling_in", {
        telegramUsername,
        callId: Math.trunc(callId),
        byteLength: buf.length,
        queued: list.length,
      });
      void import("./privateCallMedia.js").then(({ pushPrivateCallSignalingData }) =>
        pushPrivateCallSignalingData(telegramUsername, Math.trunc(callId), buf),
      );
    } else {
      logGateway("private_call_signaling_in_skipped", {
        telegramUsername,
        callId: Math.trunc(callId),
        dataType: typeof update.data,
        dataKeys:
          update.data && typeof update.data === "object"
            ? Object.keys(update.data as object).slice(0, 8)
            : [],
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
    return snapshotFromCache(existing, telegramUsername);
  }
  const next = buildCachedFromCall(telegramUsername, call ?? {}, existing);
  if (!next) return null;
  rememberCall(telegramUsername, next);
  if (client && next.phase === "ready") {
    // Start media immediately from the update payload (merged with cache).
    // Do not wait on a follow-up getCall — that used to swallow failures and
    // leave ntgcalls never started while signaling piled up.
    const merged = mergeCallWithCache(telegramUsername, {
      ...(call ?? {}),
      id: next.callId,
      user_id: next.userId,
      is_outgoing: next.isOutgoing,
      is_video: next.isVideo,
      state: call?.state,
    });
    void maybeStartPrivateCallMedia(client, telegramUsername, merged ?? next.callId);
    if (existing?.phase !== "ready") {
      void refreshPrivateCallForUser(client, telegramUsername, next.callId);
    }
  }
  return snapshotFromCache(next, telegramUsername);
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
    return { ok: true, call: snapshotFromCache(existing, telegramUsername) };
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
    // Refresh is driven by updateCall — this TDLib build has no getCall.
    return { ok: true, call: snapshotFromCache(cached, telegramUsername) };
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
  if (id == null || id <= 0) return cached ? snapshotFromCache(cached, telegramUsername) : null;
  // prebuilt-tdlib 0.1008066 has no getCall — serve cache and (re)try media from it.
  if (cached?.phase === "ready" && cached.callPayload) {
    await maybeStartPrivateCallMedia(
      client,
      telegramUsername,
      mergeCallWithCache(telegramUsername, cached.callPayload) ?? cached.callPayload,
    );
  }
  return cached ? snapshotFromCache(cached, telegramUsername) : null;
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
  void import("./privateCallMedia.js").then(({ stopPrivateCallMedia }) =>
    stopPrivateCallMedia(telegramUsername, id),
  );
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
