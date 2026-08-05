import { createRequire } from "node:module";
import type { Client } from "tdl";
import {
  PRIVATE_CALL_AUDIO_FRAME_BYTES,
  PRIVATE_CALL_AUDIO_SAMPLE_RATE,
  detachPrivateCallAudioClients,
  hasPrivateCallAudioClients,
  pushRemoteAudioToBrowsers,
} from "./privateCallAudioBridge.js";
import { logGateway } from "./gatewayLog.js";
type CallServer = {
  id?: number;
  ip_address?: string;
  ipv6_address?: string;
  port?: number;
  type?: {
    _?: string;
    is_tcp?: boolean;
    peer_tag?: unknown;
    username?: string;
    password?: string;
    supports_turn?: boolean;
    supports_stun?: boolean;
  };
};

type CallStateReady = {
  _?: string;
  encryption_key?: unknown;
  servers?: CallServer[];
  allow_p2p?: boolean;
  protocol?: { library_versions?: string[]; max_layer?: number };
  custom_parameters?: string;
};

/** ntgcalls N-API reads bytes via napi_get_array_length — plain number[], not Buffer. */
type NtBytes = number[];

type NtRtcServer = {
  id: bigint;
  ipv4: string;
  ipv6: string;
  port: number;
  username?: string;
  password?: string;
  turn: boolean;
  stun: boolean;
  tcp: boolean;
  peerTag?: NtBytes;
};

type NtConnectionState = {
  CONNECTING: number;
  CONNECTED: number;
  FAILED: number;
  TIMEOUT: number;
  CLOSED: number;
};

type NtMediaSource = { EXTERNAL: number };
type NtStreamMode = { CAPTURE: number; PLAYBACK: number };
type NtStreamDevice = { MICROPHONE: number; SPEAKER: number };
type NtVideoRotation = { VIDEO_ROTATION_0: number };

type NtFrameData = {
  absoluteCaptureTimestampMs: bigint;
  rotation: number;
  width: number;
  height: number;
};

type NtFrame = {
  ssrc: bigint;
  data: Buffer;
  frameData: NtFrameData;
};

type NtCallsModule = {
  NTgCalls: new () => {
    createP2pCall(userId: bigint): Promise<void>;
    skipExchange(userId: bigint, encryptionKey: NtBytes, isOutgoing: boolean): Promise<void>;
    connectP2p(
      userId: bigint,
      servers: NtRtcServer[],
      versions: string[],
      p2pAllowed: boolean,
      customParameters: string,
    ): Promise<void>;
    sendSignalingData(userId: bigint, data: NtBytes): Promise<void>;
    setStreamSources(
      userId: bigint,
      mode: number,
      media: {
        microphone?: {
          mediaSource: number;
          sampleRate: number;
          channelCount: number;
          input: string;
          keepOpen: boolean;
        };
        speaker?: {
          mediaSource: number;
          sampleRate: number;
          channelCount: number;
          input: string;
          keepOpen: boolean;
        };
      },
    ): Promise<void>;
    sendExternalFrame(
      userId: bigint,
      device: number,
      data: NtBytes,
      frameData: NtFrameData,
    ): Promise<void>;
    mute(userId: bigint): Promise<void>;
    unmute(userId: bigint): Promise<void>;
    resume(userId: bigint): Promise<void>;
    stop(userId: bigint): Promise<void>;
    onSignalingData(callback: (userId: bigint, data: Buffer) => void): void;
    onConnectionChange(
      callback: (userId: bigint, info: { state: number; kind: number }) => void,
    ): void;
    onFrames(
      callback: (
        userId: bigint,
        mode: number,
        device: number,
        frames: NtFrame[],
      ) => void,
    ): void;
  };
  ConnectionState: NtConnectionState;
  MediaSource: NtMediaSource;
  StreamMode: NtStreamMode;
  StreamDevice: NtStreamDevice;
  VideoRotation: NtVideoRotation;
  NTgCalls: { getProtocol(): { libraryVersions: string[] } };
};

type MediaSession = {
  callId: number;
  userId: number;
  isOutgoing: boolean;
  telegramUsername: string;
  nt: InstanceType<NtCallsModule["NTgCalls"]>;
  mediaEstablished: boolean;
  audioBridgeReady: boolean;
  captureReady: boolean;
  playbackReady: boolean;
  startPromise: Promise<void> | null;
  connectAttempts: number;
  silenceTimer: ReturnType<typeof setInterval> | null;
};

const sessionsByUsername = new Map<string, MediaSession>();
const mediaUnavailableLogged = new Set<string>();
let ntModule: NtCallsModule | null = null;
let ntLoadError: string | null = null;

function asBuffer(raw: unknown): Buffer | null {
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "bytes" in raw) {
    return asBuffer((raw as { bytes: unknown }).bytes);
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
    // tdl may hand latin1 binary strings or base64 depending on path.
    if (/^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length % 4 === 0) {
      const b64 = Buffer.from(raw, "base64");
      if (b64.length > 0) return b64;
    }
    return Buffer.from(raw, "binary");
  }
  return null;
}

/** Convert Buffer → number[] for ntgcalls (N-API requires a real JS Array). */
function toNtBytes(buf: Buffer): NtBytes {
  return Array.from(buf);
}

function hexString(buf: Buffer): string {
  return buf.toString("hex");
}

function getOurLibraryVersions(): string[] {
  try {
    const mod = loadNtModule();
    if (mod) return mod.NTgCalls.getProtocol().libraryVersions;
  } catch {
    // fall through
  }
  return ["13.0.0", "12.0.0", "9.0.0", "8.0.0"];
}

function pickPeerLibraryVersions(ready: CallStateReady): string[] {
  const fromReady = ready.protocol?.library_versions?.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (fromReady && fromReady.length > 0) return fromReady;
  return getOurLibraryVersions();
}

function negotiateLibraryVersions(ready: CallStateReady): string[] {
  const ours = getOurLibraryVersions();
  const theirs = pickPeerLibraryVersions(ready);
  const theirSet = new Set(theirs);
  // Keep our preference order (newest first) so ntgcalls best-match can pick 12/13.
  const overlap = ours.filter((v) => theirSet.has(v));
  if (overlap.length > 0) return overlap;
  // Never pass peer-only versions we cannot run.
  return ours;
}

/**
 * ntgcalls `connectP2p` parses customParameters with boost.json whenever the
 * optional string is present. Empty / non-object JSON → "incomplete JSON".
 * Valid object string or "{}" is safe (same as omitting experiments).
 */
function normalizeCustomParameters(raw: unknown): string {
  let text = "";
  if (typeof raw === "string") {
    text = raw.trim();
  } else if (raw != null) {
    const buf = asBuffer(raw);
    if (buf) text = buf.toString("utf8").trim();
  }
  if (!text) return "{}";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return text;
    }
  } catch {
    // fall through
  }
  return "{}";
}

function mapServers(servers: CallServer[] | undefined): NtRtcServer[] {
  if (!Array.isArray(servers) || servers.length === 0) return [];
  const mapped: NtRtcServer[] = [];

  for (const srv of servers) {
    const typeId = srv.type?._ ?? "";
    const id = Number(srv.id);
    if (!Number.isFinite(id)) continue;
    const ipv4 = typeof srv.ip_address === "string" ? srv.ip_address : "";
    const ipv6 = typeof srv.ipv6_address === "string" ? srv.ipv6_address : "";
    const port = Number(srv.port);
    if (!Number.isFinite(port) || port <= 0) continue;

    if (typeId === "callServerTypeTelegramReflector") {
      // Match pytgcalls: one RTCServer per TDLib CallServer (UDP and TCP arrive as separate entries).
      const peerTag = asBuffer(srv.type?.peer_tag);
      mapped.push({
        id: BigInt(Math.trunc(id)),
        ipv4,
        ipv6,
        port: Math.trunc(port),
        turn: true,
        stun: false,
        tcp: Boolean(srv.type?.is_tcp),
        peerTag: peerTag ? toNtBytes(peerTag) : undefined,
      });
    } else if (typeId === "callServerTypeWebrtc") {
      mapped.push({
        id: BigInt(Math.trunc(id)),
        ipv4,
        ipv6,
        port: Math.trunc(port),
        username: typeof srv.type?.username === "string" ? srv.type.username : undefined,
        password: typeof srv.type?.password === "string" ? srv.type.password : undefined,
        turn: Boolean(srv.type?.supports_turn),
        stun: Boolean(srv.type?.supports_stun),
        tcp: false,
      });
    }
  }

  return mapped;
}

async function flushPendingSignaling(
  telegramUsername: string,
  callId: number,
): Promise<void> {
  const { takePendingCallSignalingData } = await import("./privateCall.js");
  for (const pending of takePendingCallSignalingData(callId)) {
    await pushPrivateCallSignalingData(telegramUsername, callId, pending);
  }
}

async function connectMediaSession(
  client: Client,
  mod: NtCallsModule,
  session: MediaSession,
  state: CallStateReady,
): Promise<void> {
  const encryptionKey = asBuffer(state.encryption_key);
  const servers = mapServers(state.servers);
  if (!encryptionKey || encryptionKey.length === 0 || servers.length === 0) {
    logGateway("private_call_media_start_deferred", {
      telegramUsername: session.telegramUsername,
      callId: session.callId,
      hasKey: Boolean(encryptionKey && encryptionKey.length > 0),
      serverCount: servers.length,
      attempt: session.connectAttempts,
    });
    return;
  }

  const peer = BigInt(session.userId);
  const versions = negotiateLibraryVersions(state);
  const customParameters = normalizeCustomParameters(state.custom_parameters);

  // TDLib already completed the DH exchange when it emits callStateReady with
  // encryption_key. Re-running connectP2p after the first attempt throws
  // "Connection already made" and stalls Telegram clients on
  // "Exchanging encryption keys". Later retries only flush buffered signaling.
  if (session.connectAttempts > 0) {
    await flushPendingSignaling(session.telegramUsername, session.callId);
    logGateway("private_call_media_signaling_flushed", {
      telegramUsername: session.telegramUsername,
      callId: session.callId,
      attempt: session.connectAttempts,
      mediaEstablished: session.mediaEstablished,
    });
    return;
  }

  // Verified P2P order: create → CAPTURE → skipExchange → connect → PLAYBACK → silence.
  logGateway("private_call_media_step", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    step: "createP2pCall",
    userId: session.userId,
  });
  await session.nt.createP2pCall(peer);

  await ensureCaptureSource(mod, session);

  logGateway("private_call_media_step", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    step: "skipExchange",
    keyBytes: encryptionKey.length,
    isOutgoing: session.isOutgoing,
  });
  // Must be a plain Array — Buffer triggers napi_array_expected ("An array was expected").
  await session.nt.skipExchange(peer, toNtBytes(encryptionKey), session.isOutgoing);

  logGateway("private_call_media_step", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    step: "connectP2p",
    serverCount: servers.length,
    versionSample: versions.slice(0, 3),
    customParametersLen: customParameters.length,
  });
  await session.nt.connectP2p(
    peer,
    servers,
    versions,
    state.allow_p2p !== false,
    customParameters,
  );
  session.connectAttempts = 1;

  await ensurePlaybackSource(mod, session);
  startSilenceKeepalive(mod, session);

  logGateway("private_call_media_started", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    userId: session.userId,
    isOutgoing: session.isOutgoing,
    serverCount: servers.length,
    versionSample: versions.slice(0, 2),
    attempt: session.connectAttempts,
  });

  await flushPendingSignaling(session.telegramUsername, session.callId);
  scheduleMediaConnectWatchdog(session);
}

function scheduleMediaConnectWatchdog(session: MediaSession): void {
  const delaysMs = [5000, 10_000];
  for (const delayMs of delaysMs) {
    setTimeout(() => {
      void (async () => {
        if (session.mediaEstablished) return;
        if (sessionsByUsername.get(session.telegramUsername) !== session) return;
        if (session.startPromise) return;
        logGateway("private_call_media_awaiting_connection", {
          telegramUsername: session.telegramUsername,
          callId: session.callId,
          attempt: session.connectAttempts,
          delayMs,
        });
        try {
          await flushPendingSignaling(session.telegramUsername, session.callId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logGateway("private_call_media_signaling_flush_failed", {
            telegramUsername: session.telegramUsername,
            callId: session.callId,
            delayMs,
            message,
          });
        }
      })();
    }, delayMs);
  }
}

const require = createRequire(import.meta.url);

function loadNtModule(): NtCallsModule | null {
  if (ntModule) return ntModule;
  if (ntLoadError) return null;
  try {
    ntModule = require("ntgcalls") as NtCallsModule;
    return ntModule;
  } catch (err) {
    ntLoadError = err instanceof Error ? err.message : String(err);
    logGateway("private_call_media_load_failed", { message: ntLoadError });
    return null;
  }
}

export function isPrivateCallMediaAvailable(): boolean {
  return loadNtModule() != null;
}

export function getPrivateCallMediaLoadError(): string | null {
  loadNtModule();
  return ntLoadError;
}

export function getPrivateCallMediaEstablished(telegramUsername: string): boolean {
  return sessionsByUsername.get(telegramUsername)?.mediaEstablished === true;
}

function emptyFrameData(mod: NtCallsModule): NtFrameData {
  return {
    absoluteCaptureTimestampMs: BigInt(Date.now()),
    rotation: mod.VideoRotation.VIDEO_ROTATION_0,
    width: 0,
    height: 0,
  };
}

const silencePcm = Buffer.alloc(PRIVATE_CALL_AUDIO_FRAME_BYTES);

async function ensureCaptureSource(
  mod: NtCallsModule,
  session: MediaSession,
): Promise<void> {
  if (session.captureReady) return;
  const peer = BigInt(session.userId);
  await session.nt.setStreamSources(peer, mod.StreamMode.CAPTURE, {
    microphone: {
      mediaSource: mod.MediaSource.EXTERNAL,
      sampleRate: PRIVATE_CALL_AUDIO_SAMPLE_RATE,
      channelCount: 1,
      input: "",
      keepOpen: true,
    },
  });
  session.captureReady = true;
  logGateway("private_call_media_step", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    step: "capture_source",
  });
}

async function ensurePlaybackSource(
  mod: NtCallsModule,
  session: MediaSession,
): Promise<void> {
  if (session.playbackReady) return;
  const peer = BigInt(session.userId);
  // Inbound P2P frames arrive on PLAYBACK + MICROPHONE (not SPEAKER).
  await session.nt.setStreamSources(peer, mod.StreamMode.PLAYBACK, {
    microphone: {
      mediaSource: mod.MediaSource.EXTERNAL,
      sampleRate: PRIVATE_CALL_AUDIO_SAMPLE_RATE,
      channelCount: 1,
      input: "",
      keepOpen: true,
    },
    speaker: {
      mediaSource: mod.MediaSource.EXTERNAL,
      sampleRate: PRIVATE_CALL_AUDIO_SAMPLE_RATE,
      channelCount: 1,
      input: "",
      keepOpen: true,
    },
  });
  session.playbackReady = true;
  session.audioBridgeReady = session.captureReady && session.playbackReady;
  logGateway("private_call_audio_bridge_ready", {
    telegramUsername: session.telegramUsername,
    callId: session.callId,
    userId: session.userId,
  });
}

async function ensureExternalAudioBridge(
  mod: NtCallsModule,
  session: MediaSession,
): Promise<void> {
  await ensureCaptureSource(mod, session);
  await ensurePlaybackSource(mod, session);
}

function startSilenceKeepalive(mod: NtCallsModule, session: MediaSession): void {
  if (session.silenceTimer) return;
  const peer = BigInt(session.userId);
  session.silenceTimer = setInterval(() => {
    if (sessionsByUsername.get(session.telegramUsername) !== session) {
      stopSilenceKeepalive(session);
      return;
    }
    // Browser mic frames replace silence once the audio WS attaches.
    if (hasPrivateCallAudioClients(session.telegramUsername, session.callId)) return;
    void session.nt
      .sendExternalFrame(
        peer,
        mod.StreamDevice.MICROPHONE,
        toNtBytes(silencePcm),
        emptyFrameData(mod),
      )
      .catch(() => {
        // ignore per-frame failures while connecting
      });
  }, 10);
}

function stopSilenceKeepalive(session: MediaSession): void {
  if (!session.silenceTimer) return;
  clearInterval(session.silenceTimer);
  session.silenceTimer = null;
}

export async function pushInboundPrivateCallAudio(
  telegramUsername: string,
  callId: number,
  pcm: Buffer,
): Promise<void> {
  const session = sessionsByUsername.get(telegramUsername);
  if (!session || session.callId !== Math.trunc(callId)) return;
  if (!session.mediaEstablished) return;
  const mod = loadNtModule();
  if (!mod) return;
  if (pcm.length === 0) return;
  try {
    if (!session.audioBridgeReady) {
      await ensureExternalAudioBridge(mod, session);
    }
    const frame =
      pcm.length > PRIVATE_CALL_AUDIO_FRAME_BYTES
        ? pcm.subarray(0, PRIVATE_CALL_AUDIO_FRAME_BYTES)
        : pcm;
    await session.nt.sendExternalFrame(
      BigInt(session.userId),
      mod.StreamDevice.MICROPHONE,
      toNtBytes(Buffer.isBuffer(frame) ? frame : Buffer.from(frame)),
      emptyFrameData(mod),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_audio_in_failed", {
      telegramUsername,
      callId,
      byteLength: pcm.length,
      message,
    });
  }
}

export async function pushPrivateCallSignalingData(
  telegramUsername: string,
  callId: number,
  data: Buffer,
): Promise<void> {
  const session = sessionsByUsername.get(telegramUsername);
  if (!session || session.callId !== Math.trunc(callId)) return;
  try {
    await session.nt.sendSignalingData(BigInt(session.userId), toNtBytes(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_media_signaling_in_failed", {
      telegramUsername,
      callId,
      byteLength: data.length,
      message,
    });
  }
}

export async function stopPrivateCallMedia(
  telegramUsername: string,
  callId?: number | null,
): Promise<void> {
  const session = sessionsByUsername.get(telegramUsername);
  if (!session) return;
  if (callId != null && session.callId !== Math.trunc(callId)) return;
  stopSilenceKeepalive(session);
  detachPrivateCallAudioClients(telegramUsername, session.callId);
  sessionsByUsername.delete(telegramUsername);
  try {
    await session.nt.stop(BigInt(session.userId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGateway("private_call_media_stop_failed", {
      telegramUsername,
      callId: session.callId,
      message,
    });
  }
}

export function ensurePrivateCallMediaStarted(
  client: Client,
  telegramUsername: string,
  call: {
    id?: number;
    user_id?: number;
    is_outgoing?: boolean;
    state?: CallStateReady;
  },
  sendSignaling: (callId: number, data: Buffer) => Promise<{ ok: boolean; error?: string }>,
  cachedUserId = 0,
): void {
  const callId = Number(call.id);
  const userId = Number(call.user_id) || Number(cachedUserId) || 0;
  if (!Number.isFinite(callId) || callId <= 0) {
    logGateway("private_call_media_skip", {
      telegramUsername,
      reason: "ensure_no_call_id",
      callId,
    });
    return;
  }
  if (!Number.isFinite(userId) || userId === 0) {
    logGateway("private_call_media_skip", {
      telegramUsername,
      callId: Math.trunc(callId),
      reason: "ensure_no_user_id",
      callUserId: call.user_id ?? null,
      cachedUserId,
    });
    return;
  }
  const state = call.state;
  if (!state || state._ !== "callStateReady") {
    logGateway("private_call_media_skip", {
      telegramUsername,
      callId: Math.trunc(callId),
      reason: "ensure_not_ready",
      stateType: state?._ ?? null,
    });
    return;
  }

  const mod = loadNtModule();
  if (!mod) {
    const logKey = `${telegramUsername}:${Math.trunc(callId)}`;
    if (!mediaUnavailableLogged.has(logKey)) {
      mediaUnavailableLogged.add(logKey);
      logGateway("private_call_media_unavailable", {
        telegramUsername,
        callId: Math.trunc(callId),
        error: ntLoadError ?? "ntgcalls_not_loaded",
      });
    }
    return;
  }

  const existing = sessionsByUsername.get(telegramUsername);
  if (existing?.callId === Math.trunc(callId)) {
    if (existing.startPromise || existing.mediaEstablished) return;
    existing.isOutgoing = call.is_outgoing !== false;
    // Already past createP2pCall: only flush signaling. Never re-connectP2p.
    if (existing.connectAttempts > 0) {
      void flushPendingSignaling(existing.telegramUsername, existing.callId);
      return;
    }
    existing.startPromise = (async () => {
      try {
        await connectMediaSession(client, mod, existing, state);
      } catch (err) {
        stopSilenceKeepalive(existing);
        sessionsByUsername.delete(telegramUsername);
        const message = err instanceof Error ? err.message : String(err);
        logGateway("private_call_media_start_failed", {
          telegramUsername,
          callId: existing.callId,
          userId: existing.userId,
          message,
        });
      } finally {
        existing.startPromise = null;
      }
    })();
    return;
  }

  logGateway("private_call_media_ensure", {
    telegramUsername,
    callId: Math.trunc(callId),
    userId: Math.trunc(userId),
    isOutgoing: call.is_outgoing !== false,
    serverCount: Array.isArray(state.servers) ? state.servers.length : 0,
    hasKey: Boolean(asBuffer(state.encryption_key)),
  });

  const nt = new mod.NTgCalls();
  const session: MediaSession = {
    callId: Math.trunc(callId),
    userId: Math.trunc(userId),
    isOutgoing: call.is_outgoing !== false,
    telegramUsername,
    nt,
    mediaEstablished: false,
    audioBridgeReady: false,
    captureReady: false,
    playbackReady: false,
    startPromise: null,
    connectAttempts: 0,
    silenceTimer: null,
  };
  sessionsByUsername.set(telegramUsername, session);

  nt.onSignalingData((peerUserId, data) => {
    if (Number(peerUserId) !== session.userId) return;
    void sendSignaling(session.callId, data).then((result) => {
      if (!result.ok) {
        logGateway("private_call_media_signaling_out_failed", {
          telegramUsername,
          callId: session.callId,
          byteLength: data.length,
          error: result.error ?? "send_failed",
        });
      }
    });
  });

  nt.onConnectionChange((peerUserId, info) => {
    if (Number(peerUserId) !== session.userId) return;
    const connected = info.state === mod.ConnectionState.CONNECTED;
    if (connected && !session.mediaEstablished) {
      session.mediaEstablished = true;
      logGateway("private_call_media_connected", {
        telegramUsername,
        callId: session.callId,
        userId: session.userId,
      });
      // ntgcalls starts muted/paused until unmute+resume; without this the peer
      // stays on "Exchanging encryption keys" even though WebRTC is CONNECTED.
      void (async () => {
        try {
          await ensureExternalAudioBridge(mod, session);
          await nt.unmute(BigInt(session.userId));
          await nt.resume(BigInt(session.userId));
          logGateway("private_call_media_unmuted", {
            telegramUsername,
            callId: session.callId,
            userId: session.userId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logGateway("private_call_media_unmute_failed", {
            telegramUsername,
            callId: session.callId,
            userId: session.userId,
            message,
          });
        }
      })();
    } else if (
      info.state === mod.ConnectionState.FAILED ||
      info.state === mod.ConnectionState.TIMEOUT ||
      info.state === mod.ConnectionState.CLOSED
    ) {
      logGateway("private_call_media_connection_lost", {
        telegramUsername,
        callId: session.callId,
        userId: session.userId,
        state: info.state,
      });
    }
  });

  nt.onFrames((peerUserId, mode, device, frames) => {
    if (Number(peerUserId) !== session.userId) return;
    if (mode !== mod.StreamMode.PLAYBACK) return;
    // P2P inbound audio arrives on MICROPHONE; keep SPEAKER as a fallback.
    if (
      device !== mod.StreamDevice.MICROPHONE &&
      device !== mod.StreamDevice.SPEAKER
    ) {
      return;
    }
    for (const frame of frames) {
      if (!frame.data?.length) continue;
      pushRemoteAudioToBrowsers(session.telegramUsername, session.callId, frame.data);
    }
  });

  session.startPromise = (async () => {
    try {
      await connectMediaSession(client, mod, session, state);
    } catch (err) {
      stopSilenceKeepalive(session);
      sessionsByUsername.delete(telegramUsername);
      const message = err instanceof Error ? err.message : String(err);
      logGateway("private_call_media_start_failed", {
        telegramUsername,
        callId: session.callId,
        userId: session.userId,
        message,
      });
    } finally {
      session.startPromise = null;
    }
  })();
}
