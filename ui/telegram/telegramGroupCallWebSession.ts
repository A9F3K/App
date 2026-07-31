import { appWarn } from "../../shared/appLog";
import {
  buildGroupCallJoinPayloadJson,
  groupCallAnswerDtlsSetup,
  groupCallAnswerSdpFromTransport,
  groupCallRemoteSubscribeOfferSdp,
  parseGroupCallJoinTransport,
  parseGroupCallOfferSdp,
  parseOfferMediaSections,
  parsePrimarySsrcFromSdp,
  type TelegramGroupCallCandidate,
  type TelegramGroupCallPayloadType,
  type TelegramGroupCallRemoteVideoSection,
  type TelegramGroupCallRtpExtension,
  type TelegramGroupCallTransport,
} from "../../shared/telegramGroupCallSdp";

/** Match telegram-tt: SFU forwards remote video only after Colibri constraints. */
const GROUP_CALL_VIDEO_MAX_HEIGHT = 720;
import { logPageDisplay } from "../pageDisplayLog";
import { joinTelegramChatVoice } from "./joinTelegramChatVoice";
import {
  endTelegramChatVoiceScreenShare,
  startTelegramChatVoiceScreenShare,
} from "./telegramChatVoiceScreenShare";
import { setTelegramChatVoiceMicMuted } from "./setTelegramChatVoiceMicMuted";
import { setTelegramChatVoiceSpeaking } from "./setTelegramChatVoiceSpeaking";
import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

/** Hot-path ICE/track logs freeze DevTools when console is open — gate behind flag. */
const VOICE_DEBUG =
  typeof window !== "undefined" &&
  Boolean((window as { __HSP_VOICE_DEBUG__?: boolean }).__HSP_VOICE_DEBUG__);

function voiceDebug(tag: string, event: string, details?: Record<string, unknown>): void {
  if (!VOICE_DEBUG) return;
  appWarn(tag, event, details);
}

/**
 * telegram-tt embeds every SFU transport candidate in the answer (no trickle).
 * Prefer IPv4 — broken IPv6 often stalls ICE — but do not rank-cut to 1–3 hosts;
 * that caused join_ok + permanent silence when the reachable SFU IP was dropped.
 * Soft-cap only pathological payloads so setRemoteDescription stays cheap.
 */
function pickJoinAnswerCandidates(
  candidates: TelegramGroupCallCandidate[],
): TelegramGroupCallCandidate[] {
  const ipv4 = candidates.filter((c) => !String(c.ip).includes(":"));
  const pool = ipv4.length > 0 ? ipv4 : candidates;
  if (pool.length <= 16) return pool;
  const typeRank = (t: string) => {
    const typ = String(t || "").toLowerCase();
    if (typ === "host") return 0;
    if (typ === "srflx") return 1;
    if (typ === "relay") return 2;
    return 3;
  };
  return [...pool]
    .sort((a, b) => {
      const byType = typeRank(a.type) - typeRank(b.type);
      if (byType !== 0) return byType;
      return Number(b.priority) - Number(a.priority);
    })
    .slice(0, 16);
}

type SessionInput = {
  chatId: number;
  groupCallId: number | null;
};

export type TelegramRemoteVideoKind = "camera" | "screen";

/** A remote participant video we want to receive (from TDLib participant info). */
export type TelegramRemoteVideoRequest = {
  endpointId: string;
  kind: TelegramRemoteVideoKind;
  ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
};

/** A live remote video source mapped back to its publisher endpoint. */
export type TelegramRemoteVideoSource = {
  endpointId: string;
  kind: TelegramRemoteVideoKind;
  stream: MediaStream;
};

let sharedSilentVideoTrack: MediaStreamTrack | null = null;

function createSilentVideoTrack(): MediaStreamTrack {
  // Reuse one canvas captureStream — creating a new one per Join in headless
  // Chrome stacked with setRemoteDescription and permanently wedged the tab
  // (Playwright evaluate/screenshot hung forever after webrtc_join_ok).
  if (
    sharedSilentVideoTrack &&
    sharedSilentVideoTrack.readyState === "live"
  ) {
    try {
      return sharedSilentVideoTrack.clone();
    } catch {
      sharedSilentVideoTrack = null;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 2, 2);
  }
  const stream = canvas.captureStream(1);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("silent_video_track_failed");
  }
  sharedSilentVideoTrack = track;
  return track.clone();
}

/**
 * Local audio for listen-only joins — no mic permission / user gesture.
 * Real mic is swapped in later via setMicEnabled().
 * Prefer the Join-gesture AudioContext (already resumed). A separate suspended
 * context produces no outbound RTP → SFU sends nothing → remote track stays
 * muted with inboundAudio=0 forever.
 */
let sharedSilentAudioCtx: AudioContext | null = null;

/**
 * Near-silent (~-42 dB). 0.001 was often DTX'd by Chrome despite usedtx=0 in SDP
 * (outboundPackets rose slowly while inboundPackets stayed 0 / remoteMuted forever).
 */
const SILENT_OUTBOUND_GAIN = 0.008;

function createSilentAudioTrack(): MediaStreamTrack {
  if (typeof AudioContext === "undefined") {
    throw new Error("silent_audio_unavailable");
  }
  // Reuse the gesture-unlocked context whenever possible.
  unlockVoiceAutoplay();
  const unlocked = getVoiceAutoplayAudioContext();
  if (unlocked && unlocked.state !== "closed") {
    sharedSilentAudioCtx = unlocked;
  } else if (!sharedSilentAudioCtx || sharedSilentAudioCtx.state === "closed") {
    sharedSilentAudioCtx = new AudioContext();
  }
  const ctx = sharedSilentAudioCtx;
  void ctx.resume().catch(() => undefined);
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = 20;
  const gain = ctx.createGain();
  gain.gain.value = SILENT_OUTBOUND_GAIN;
  oscillator.connect(gain);
  const dest = ctx.createMediaStreamDestination();
  gain.connect(dest);
  oscillator.start();
  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    oscillator.stop();
    throw new Error("silent_audio_track_failed");
  }
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    try {
      oscillator.stop();
    } catch {
      // already stopped
    }
    // Do not close sharedSilentAudioCtx — reused across joins / shared with unlock.
    stopTrack();
  };
  // Keep enabled so the transceiver stays live and the SFU can deliver remote audio.
  // Telegram mute is signaled separately via is_muted / muteGroupCallParticipant.
  track.enabled = true;
  logPageDisplay("messages_voice_silent_track", {
    ctxState: ctx.state,
    sampleRate: ctx.sampleRate,
    gain: SILENT_OUTBOUND_GAIN,
    reusedUnlockCtx: unlocked != null && unlocked === ctx,
    level: ctx.state === "running" ? "info" : "warn",
  });
  return track;
}

/** Keep the live audio sender out of Opus DTX — silence must still produce RTP. */
async function disableAudioSenderDtx(connection: RTCPeerConnection): Promise<void> {
  const sender = connection.getSenders().find((s) => s.track?.kind === "audio");
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (params.encodings?.length) {
      for (const encoding of params.encodings) {
        encoding.dtx = false;
      }
      await sender.setParameters(params);
    }
  } catch {
    // ignore — setParameters can fail before the first negotiation completes
  }
}

async function resumeSilentOutboundContext(): Promise<void> {
  const ctx = sharedSilentAudioCtx ?? getVoiceAutoplayAudioContext();
  if (!ctx || ctx.state === "closed") return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // ignore
    }
  }
  if (ctx.state !== "running") {
    logPageDisplay("messages_voice_silent_ctx_suspended", {
      ctxState: ctx.state,
      level: "warn",
      note: "outbound silence may not produce RTP — inbound stays muted",
    });
  }
}

/** Browser WebRTC session for a Telegram group voice call. */
export class TelegramGroupCallWebSession {
  private connection: RTCPeerConnection | null = null;
  /** Separate WebRTC connection for screen-share presentation (Telegram SFU). */
  private presentationConnection: RTCPeerConnection | null = null;
  private presentationAudioTrack: MediaStreamTrack | null = null;
  private presentationAudioSourceId: number | null = null;
  private presentationJoining: Promise<void> | null = null;
  private localStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  /** True when `audioTrack` is a placeholder (no real mic yet). */
  private usingSilentAudio = false;
  /**
   * Real mic from Join-click prefetch, held while listen-only publishes silence.
   * Attaching the prefetched track with enabled=false sent zero RTP and the SFU
   * never delivered remote audio (outboundPackets=0, remoteMuted forever).
   */
  private prefetchedMicTrack: MediaStreamTrack | null = null;
  /** Reused near-silent outbound track for mute — avoids oscillator churn on every toggle. */
  private silentOutboundTrack: MediaStreamTrack | null = null;
  /** Outbound video sender track (silent placeholder, camera, or screen). */
  private outboundVideoTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private cameraEnabled = false;
  private screenSharing = false;
  /** In-dialog stage size used to adapt screen-share encode quality. */
  private screenShareDisplaySize = { width: 640, height: 360 };
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private localMediaListeners = new Set<
    (state: {
      cameraActive: boolean;
      screenSharing: boolean;
      localCameraStream: MediaStream | null;
      localScreenStream: MediaStream | null;
    }) => void
  >();
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;
  /** Remote camera / screen-share tracks (separate from audio so sinks stay independent). */
  private remoteVideoStream: MediaStream | null = null;
  private videoListeners = new Set<(stream: MediaStream | null) => void>();
  /** Join-time SFU transport — reused to synthesize renegotiation answers. */
  private lastTransport: TelegramGroupCallTransport | null = null;
  /** SFU video codecs from join payload — required to decode screencast RTP. */
  private videoPayloadTypes: TelegramGroupCallPayloadType[] = [];
  private videoExtensions: TelegramGroupCallRtpExtension[] = [];
  /**
   * Colibri data channel (`label=data`, id=0) — carries ReceiverVideoConstraints.
   * Without an open channel the SFU never sends screencast RTP (inboundVideo=0).
   */
  private dataChannel: RTCDataChannel | null = null;
  /** Remote participant videos we want to receive (endpoint + ssrc groups). */
  private requestedRemoteVideo: TelegramRemoteVideoRequest[] = [];
  /** recvonly transceiver slots for remote video, in m-line order after mid 0/1. */
  private videoRecvSlots: Array<{
    transceiver: RTCRtpTransceiver | null;
    endpointId: string | null;
  }> = [];
  /** Serialize renegotiations — parallel setLocalDescription calls throw. */
  private renegotiationChain: Promise<void> = Promise.resolve();
  private lastAppliedRemoteVideoKey = "";
  /** Endpoint ids from the last successful video renegotiation. */
  private lastAppliedRemoteVideoEndpoints: string[] = [];
  /** Caps automatic re-renegotiate when inboundVideoPackets stay 0. */
  private remoteVideoPacketRetries = 0;
  private remoteVideoByEndpoint = new Map<string, MediaStream>();
  /** Stable UI MediaStreams so React does not remount video on every notify. */
  private remoteVideoUiByEndpoint = new Map<string, MediaStream>();
  private lastRemoteVideoSourcesSig = "";
  private remoteVideoSourceListeners = new Set<
    (sources: TelegramRemoteVideoSource[]) => void
  >();
  /** Gate remote playback (false only on leave/dispose — stay on while minimized). */
  private remoteAudioEnabled = true;
  /** Wait for PC connected before first video renegotiate (protects audio m-line). */
  private pendingVideoRenegotiateOnConnect = false;
  private videoRenegotiateConnectListener: (() => void) | null = null;
  private playbackCtx: AudioContext | null = null;
  private playbackSource: MediaStreamAudioSourceNode | null = null;
  /** Track-id key for the live WebAudio MediaStreamSource — skip no-op rebuilds. */
  private playbackTrackKey = "";
  /** Rate-limit join-placeholder video skip logs (pull/watchdog used to spam). */
  private remoteVideoSkipLogAt = 0;
  private remoteVideoSkipLogTrackId = "";
  /** Serialize play() / graph rebuild — concurrent calls interrupt each other. */
  private remotePlayChain: Promise<void> = Promise.resolve();
  private audioSourceId: number | null = null;
  /** One-shot document gesture listener to unmute after auto-join. */
  private gestureUnmuteCleanup: (() => void) | null = null;
  private joined = false;
  private joining: Promise<void> | null = null;
  private micEnabled = false;
  private localSpeaking = false;
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private analyserCtx: AudioContext | null = null;
  private analyserRaf: number | null = null;
  /** In-flight getUserMedia from the Join click — reused by setMicEnabled. */
  private micPrefetch: Promise<void> | null = null;
  private lastSpeakingSyncAt = 0;
  private lastSpeakingSynced: boolean | null = null;
  /** After GROUPCALL_JOIN_MISSING, stop hammering speaking until we rejoin. */
  private speakingSyncBlockedUntil = 0;
  private joinLostListeners = new Set<() => void>();
  private iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private input: SessionInput) {
    // Pre-create the element so unlockRemoteAudio during Join hits the real sink.
    if (typeof document !== "undefined") {
      this.ensureRemoteAudioElement();
    }
  }

  /** Update call id without tearing down WebRTC (chat list refreshes often). */
  updateGroupCallId(groupCallId: number | null): void {
    this.input = { ...this.input, groupCallId };
  }

  get isJoined(): boolean {
    return this.joined;
  }

  /** True when ICE/DTLS path is up and RTP can flow. */
  isMediaConnected(): boolean {
    const pc = this.connection;
    if (!this.joined || !pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "connected" ||
      ice === "completed" ||
      conn === "connected"
    );
  }

  /** Offer/answer done but ICE still checking — do not tear down yet. */
  isNegotiating(): boolean {
    const pc = this.connection;
    if (!this.joined || !pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "new" ||
      ice === "checking" ||
      conn === "new" ||
      conn === "connecting"
    );
  }

  /** Drop stale joined flag when WebRTC died but UI still thinks we're in. */
  rejoinIfStale(): boolean {
    if (!this.joined || this.joining) return false;
    const pc = this.connection;
    if (!pc) {
      if (this.joined) {
        this.markJoinLost("stale_no_pc");
        return true;
      }
      return false;
    }
    if (this.isNegotiating() || this.isMediaConnected()) return false;
    // disconnected / failed — scheduleJoinLostIfStillBroken owns teardown timing.
    if (
      pc.iceConnectionState === "disconnected" ||
      pc.connectionState === "disconnected"
    ) {
      return false;
    }
    if (
      pc.iceConnectionState === "failed" ||
      pc.iceConnectionState === "closed" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    ) {
      this.markJoinLost("stale_connection");
      return true;
    }
    return false;
  }

  /** Fired when TDLib reports we are no longer joined (roster/speaking broken). */
  onJoinLost(listener: () => void): () => void {
    this.joinLostListeners.add(listener);
    return () => {
      this.joinLostListeners.delete(listener);
    };
  }

  /**
   * Remote camera / screen-share MediaStream (or null when none is live).
   * Subscribe to show a video plane under the voice bar.
   */
  onRemoteVideoChange(listener: (stream: MediaStream | null) => void): () => void {
    this.videoListeners.add(listener);
    listener(this.getLiveRemoteVideoStream());
    return () => {
      this.videoListeners.delete(listener);
    };
  }

  /**
   * Per-endpoint remote video sources (camera / screencast). Prefer this over
   * {@link onRemoteVideoChange} when the UI needs to distinguish them.
   */
  onRemoteVideoSourcesChange(
    listener: (sources: TelegramRemoteVideoSource[]) => void,
  ): () => void {
    this.remoteVideoSourceListeners.add(listener);
    listener(this.getLiveRemoteVideoSources());
    return () => {
      this.remoteVideoSourceListeners.delete(listener);
    };
  }

  /** Current live remote video stream, or null. */
  getLiveRemoteVideoStream(): MediaStream | null {
    const sources = this.getLiveRemoteVideoSources();
    if (sources.length === 0) return null;
    // Prefer screencast when both are live (tdesktop docks presentation first).
    const preferred =
      sources.find((s) => s.kind === "screen") ?? sources[0]!;
    return preferred.stream;
  }

  getLiveRemoteVideoSources(): TelegramRemoteVideoSource[] {
    const out: TelegramRemoteVideoSource[] = [];
    const keep = new Set<string>();
    for (const req of this.requestedRemoteVideo) {
      const stream = this.remoteVideoByEndpoint.get(req.endpointId);
      if (!stream) continue;
      // Wait for RTP (track.muted=false). Emitting muted join leftovers as
      // "live" made the media stage lock onto a black main tile and hide
      // local screencast PiPs until mainHasFrames (never).
      const live = stream
        .getVideoTracks()
        .find((t) => t.readyState === "live" && t.enabled && !t.muted);
      if (!live) continue;
      keep.add(req.endpointId);
      // Reuse one MediaStream per endpoint. `new MediaStream([live])` on every
      // notify remounted <video> and reset mainHasFrames forever under SSE churn.
      let ui = this.remoteVideoUiByEndpoint.get(req.endpointId);
      const uiTrack = ui?.getVideoTracks()[0];
      if (!ui || uiTrack?.id !== live.id) {
        ui = new MediaStream([live]);
        this.remoteVideoUiByEndpoint.set(req.endpointId, ui);
      }
      out.push({
        endpointId: req.endpointId,
        kind: req.kind,
        stream: ui,
      });
    }
    for (const endpointId of [...this.remoteVideoUiByEndpoint.keys()]) {
      if (!keep.has(endpointId)) this.remoteVideoUiByEndpoint.delete(endpointId);
    }
    return out;
  }

  /**
   * Ask the SFU to deliver the given participant videos. Triggers a WebRTC
   * renegotiation that declares each publisher's SSRC groups in the answer.
   */
  setRequestedRemoteVideos(requests: TelegramRemoteVideoRequest[]): void {
    const normalized = requests
      .filter((req) => req.endpointId && req.ssrcGroups.length > 0)
      .map((req) => ({
        endpointId: req.endpointId.trim(),
        kind: req.kind,
        ssrcGroups: req.ssrcGroups
          .filter((g) => g.semantics && g.sourceIds.length > 0)
          .map((g) => ({
            semantics: g.semantics,
            sourceIds: g.sourceIds.map((id) => Math.trunc(id)),
          })),
      }));
    // Soft roster handling lives in MessageChatVoiceBar (short sticky window).
    // Do not ignore empty clears here — a stopped share leaves readyState=live
    // (often muted) and sticky_keep kept the tile on stage forever.
    const nextKey = normalized
      .map(
        (r) =>
          `${r.kind}:${r.endpointId}:${r.ssrcGroups
            .map((g) => `${g.semantics}:${g.sourceIds.join(",")}`)
            .join(";")}`,
      )
      .sort()
      .join("|");
    const keepEndpoints = new Set(normalized.map((r) => r.endpointId));
    for (const endpointId of [...this.remoteVideoByEndpoint.keys()]) {
      if (keepEndpoints.has(endpointId)) continue;
      const mapped = this.remoteVideoByEndpoint.get(endpointId);
      if (mapped) {
        for (const track of mapped.getVideoTracks()) {
          try {
            mapped.removeTrack(track);
          } catch {
            // ignore
          }
        }
      }
      this.remoteVideoByEndpoint.delete(endpointId);
      this.remoteVideoUiByEndpoint.delete(endpointId);
    }
    this.requestedRemoteVideo = normalized;
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners();
    if (nextKey === this.lastAppliedRemoteVideoKey) return;
    // Same endpoints already slotted — roster SSRC churn / join kicks used to
    // re-renegotiate and zero inboundVideoPackets before the SFU could forward.
    const nextEndpoints = normalized.map((r) => r.endpointId);
    const prevEndpoints = this.lastAppliedRemoteVideoEndpoints;
    const sameEndpoints =
      prevEndpoints.length === nextEndpoints.length &&
      nextEndpoints.every((id) => prevEndpoints.includes(id));
    const hasSlotted =
      sameEndpoints &&
      this.videoRecvSlots.some(
        (slot) => slot.endpointId && nextEndpoints.includes(slot.endpointId),
      );
    if (hasSlotted && normalized.length > 0) {
      this.lastAppliedRemoteVideoKey = nextKey;
      this.sendReceiverVideoConstraints();
      logPageDisplay("messages_voice_remote_video_skip_renegotiate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        endpoints: nextEndpoints,
        level: "info",
        note: "kept live slots; refreshed Colibri constraints only",
      });
      return;
    }
    this.remoteVideoPacketRetries = 0;
    if (!this.joined || !this.connection || !this.lastTransport) {
      // Do not stamp lastApplied — join's deferred apply must still renegotiate.
      logPageDisplay("messages_voice_remote_video_deferred", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        count: normalized.length,
        joined: this.joined,
        hasTransport: Boolean(this.lastTransport),
        level: "info",
      });
      return;
    }
    this.queueRemoteVideoRenegotiation();
  }

  private notifyVideoListeners(): void {
    const payload = this.getLiveRemoteVideoStream();
    for (const listener of this.videoListeners) {
      try {
        listener(payload);
      } catch {
        // ignore listener errors
      }
    }
  }

  private remoteVideoSourcesSignature(
    sources: TelegramRemoteVideoSource[],
  ): string {
    return sources
      .map((s) => {
        const trackIds = s.stream
          .getVideoTracks()
          .map((t) => t.id)
          .join(",");
        return `${s.kind}:${s.endpointId}:${trackIds}`;
      })
      .sort()
      .join("|");
  }

  private notifyRemoteVideoSourceListeners(force = false): void {
    const payload = this.getLiveRemoteVideoSources();
    const sig = this.remoteVideoSourcesSignature(payload);
    if (!force && sig === this.lastRemoteVideoSourcesSig) return;
    this.lastRemoteVideoSourcesSig = sig;
    for (const listener of this.remoteVideoSourceListeners) {
      try {
        listener(payload);
      } catch {
        // ignore
      }
    }
  }

  private clearRemoteVideoStream(): void {
    if (this.remoteVideoStream) {
      for (const track of this.remoteVideoStream.getVideoTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
        try {
          this.remoteVideoStream.removeTrack(track);
        } catch {
          // ignore
        }
      }
      this.remoteVideoStream = null;
    }
    for (const stream of this.remoteVideoByEndpoint.values()) {
      for (const track of stream.getVideoTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    this.remoteVideoByEndpoint.clear();
    this.remoteVideoUiByEndpoint.clear();
    this.lastRemoteVideoSourcesSig = "";
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners(true);
  }

  private ensureRemoteVideoStream(): MediaStream {
    if (!this.remoteVideoStream) {
      this.remoteVideoStream = new MediaStream();
    }
    return this.remoteVideoStream;
  }

  private resolveEndpointIdForTrack(
    track: MediaStreamTrack,
    eventStreams: readonly MediaStream[],
  ): string | null {
    // Prefer transceiver mid → slot.endpointId first. Falling through to
    // requestedRemoteVideo[0] mis-attached second screencasts onto the first
    // endpoint when stream.id did not match Telegram's endpoint id.
    const pc = this.connection;
    if (pc) {
      for (const slot of this.videoRecvSlots) {
        if (
          slot.endpointId &&
          slot.transceiver?.receiver.track?.id === track.id
        ) {
          return slot.endpointId;
        }
      }
    }
    // telegram-tt msid: track.id / stream.id === endpointId
    const byTrackId = this.requestedRemoteVideo.find(
      (r) => r.endpointId === track.id,
    );
    if (byTrackId) return byTrackId.endpointId;
    for (const stream of eventStreams) {
      if (this.remoteVideoByEndpoint.has(stream.id)) return stream.id;
      const match = this.requestedRemoteVideo.find((r) => r.endpointId === stream.id);
      if (match) return match.endpointId;
    }
    const unassigned = this.requestedRemoteVideo.find(
      (r) => !this.remoteVideoByEndpoint.has(r.endpointId),
    );
    return unassigned?.endpointId ?? this.requestedRemoteVideo[0]?.endpointId ?? null;
  }

  /** True when this receiver belongs to an explicit recvonly remote-video slot. */
  private isSlottedRemoteVideoTrack(
    track: MediaStreamTrack,
    eventStreams: readonly MediaStream[] = [],
  ): boolean {
    if (
      this.videoRecvSlots.some(
        (slot) => slot.transceiver?.receiver.track?.id === track.id,
      )
    ) {
      return true;
    }
    // telegram-tt msid uses endpointId as stream/track id — accept those even
    // when slot sync races behind ontrack.
    if (this.requestedRemoteVideo.some((r) => r.endpointId === track.id)) {
      return true;
    }
    for (const stream of eventStreams) {
      if (this.requestedRemoteVideo.some((r) => r.endpointId === stream.id)) {
        return true;
      }
    }
    return false;
  }

  private attachRemoteVideoTrack(
    track: MediaStreamTrack,
    eventStreams: readonly MediaStream[] = [],
  ): void {
    if (track.kind !== "video") return;
    // Ignore ended placeholders / silent negotiation leftovers from the SFU.
    if (track.readyState === "ended") return;
    // Join always adds a black canvas video m-line (telegram-tt FID parity). Its
    // receiver fires ontrack with muted=true and no SSRCs. Mapping that ghost onto
    // the first screen endpoint made HTMLVideoElement play a dead first track —
    // local + remote screencasts stayed invisible (mainHasFrames never latched).
    if (!this.isSlottedRemoteVideoTrack(track, eventStreams)) {
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      // Playback pulls re-walk every receiver; logging each skip froze DevTools
      // and competed with WebAudio on the main thread during join.
      if (
        track.id !== this.remoteVideoSkipLogTrackId ||
        now - this.remoteVideoSkipLogAt > 5_000
      ) {
        this.remoteVideoSkipLogAt = now;
        this.remoteVideoSkipLogTrackId = track.id;
        logPageDisplay("messages_voice_remote_video_skip_non_slot", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          trackId: track.id,
          muted: track.muted,
          slotCount: this.videoRecvSlots.length,
          requested: this.requestedRemoteVideo.map((r) => r.endpointId),
          level: "info",
        });
      }
      return;
    }
    track.enabled = true;
    const stream = this.ensureRemoteVideoStream();
    const already = stream.getVideoTracks().some((t) => t.id === track.id);
    if (!already) {
      stream.addTrack(track);
      logPageDisplay("messages_voice_remote_video_attached", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        muted: track.muted,
        readyState: track.readyState,
        trackCount: stream.getVideoTracks().length,
        level: "info",
      });
    }
    const endpointId = this.resolveEndpointIdForTrack(track, eventStreams);
    if (endpointId) {
      let endpointStream = this.remoteVideoByEndpoint.get(endpointId);
      if (!endpointStream) {
        endpointStream = new MediaStream();
        this.remoteVideoByEndpoint.set(endpointId, endpointStream);
      }
      if (!endpointStream.getVideoTracks().some((t) => t.id === track.id)) {
        endpointStream.addTrack(track);
      }
      logPageDisplay("messages_voice_remote_video_endpoint", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        endpointId,
        endpointTrackCount: endpointStream.getVideoTracks().length,
        mappedEndpoints: [...this.remoteVideoByEndpoint.keys()],
        level: "info",
      });
    } else {
      logPageDisplay("messages_voice_remote_video_unmapped", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        requested: this.requestedRemoteVideo.map((r) => r.endpointId),
        level: "warn",
      });
    }
    track.onunmute = () => {
      logPageDisplay("messages_voice_remote_video_unmute", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        endpointId,
        level: "info",
      });
      this.notifyVideoListeners();
      this.notifyRemoteVideoSourceListeners();
    };
    // SFU mutes presentation tracks when the peer stops sharing — without this
    // notify, React kept the last unmuted MediaStream and the stage froze.
    track.onmute = () => {
      logPageDisplay("messages_voice_remote_video_mute", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        endpointId,
        level: "info",
      });
      this.notifyVideoListeners();
      this.notifyRemoteVideoSourceListeners();
    };
    track.onended = () => {
      try {
        stream.removeTrack(track);
      } catch {
        // ignore
      }
      if (endpointId) {
        const endpointStream = this.remoteVideoByEndpoint.get(endpointId);
        if (endpointStream) {
          try {
            endpointStream.removeTrack(track);
          } catch {
            // ignore
          }
          if (endpointStream.getVideoTracks().length === 0) {
            this.remoteVideoByEndpoint.delete(endpointId);
            this.remoteVideoUiByEndpoint.delete(endpointId);
          }
        }
      }
      appWarn("[voice-remote-video]", "ended", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        remaining: stream.getVideoTracks().length,
      });
      this.notifyVideoListeners();
      this.notifyRemoteVideoSourceListeners();
    };
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners();
  }

  private remoteVideoKeyOf(
    requests: TelegramRemoteVideoRequest[],
  ): string {
    return requests
      .map(
        (r) =>
          `${r.kind}:${r.endpointId}:${r.ssrcGroups
            .map((g) => `${g.semantics}:${g.sourceIds.join(",")}`)
            .join(";")}`,
      )
      .sort()
      .join("|");
  }

  private clearVideoRenegotiateConnectWait(): void {
    const connection = this.connection;
    if (connection && this.videoRenegotiateConnectListener) {
      connection.removeEventListener(
        "connectionstatechange",
        this.videoRenegotiateConnectListener,
      );
    }
    this.videoRenegotiateConnectListener = null;
    this.pendingVideoRenegotiateOnConnect = false;
  }

  private queueRemoteVideoRenegotiation(): void {
    const connection = this.connection;
    // Renegotiating video while DTLS is still connecting left inboundAudio=0
    // and constraints_skip (data channel not open). Wait for PC connected.
    if (
      connection &&
      connection.connectionState !== "connected" &&
      this.requestedRemoteVideo.length > 0
    ) {
      if (!this.pendingVideoRenegotiateOnConnect) {
        this.pendingVideoRenegotiateOnConnect = true;
        const onState = () => {
          if (this.connection !== connection) {
            this.clearVideoRenegotiateConnectWait();
            return;
          }
          if (connection.connectionState === "connected") {
            this.clearVideoRenegotiateConnectWait();
            this.queueRemoteVideoRenegotiation();
          }
        };
        this.videoRenegotiateConnectListener = onState;
        connection.addEventListener("connectionstatechange", onState);
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            if (!this.pendingVideoRenegotiateOnConnect) return;
            if (this.connection !== connection || !this.joined) {
              this.clearVideoRenegotiateConnectWait();
              return;
            }
            this.clearVideoRenegotiateConnectWait();
            this.queueRemoteVideoRenegotiation();
          }, 6_000);
        }
        logPageDisplay("messages_voice_remote_video_wait_pc", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          conn: connection.connectionState,
          ice: connection.iceConnectionState,
          count: this.requestedRemoteVideo.length,
          level: "info",
          note: "defer video renegotiate until PeerConnection connected",
        });
      }
      return;
    }
    this.renegotiationChain = this.renegotiationChain
      .then(() => this.renegotiateRemoteVideos())
      .catch((err) => {
        this.lastAppliedRemoteVideoKey = "";
        logPageDisplay("messages_voice_remote_video_renegotiate_fail", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          error: err instanceof Error ? err.message : String(err),
          level: "error",
        });
        appWarn(
          "[voice-remote-video-renegotiate]",
          err instanceof Error ? err.message : String(err),
          { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
        );
      });
  }

  /**
   * telegram-tt / Colibri: SFU only forwards camera/screen once we name the
   * endpoints in ReceiverVideoConstraints over the SCTP data channel.
   */
  private sendReceiverVideoConstraints(): void {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") {
      logPageDisplay("messages_voice_video_constraints_skip", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        readyState: channel?.readyState ?? "missing",
        endpoints: this.requestedRemoteVideo.map((r) => r.endpointId),
        level: "warn",
      });
      // Data channel often opens only after remote-offer createAnswer — poll
      // longer so a late onopen still delivers constraints.
      if (
        channel &&
        channel.readyState === "connecting" &&
        typeof window !== "undefined" &&
        this.requestedRemoteVideo.length > 0
      ) {
        const started = Date.now();
        const poll = () => {
          if (!this.joined || this.dataChannel !== channel) return;
          if (channel.readyState === "open") {
            this.sendReceiverVideoConstraints();
            return;
          }
          if (channel.readyState !== "connecting") return;
          if (Date.now() - started > 8_000) {
            logPageDisplay("messages_voice_data_channel_stuck", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              readyState: channel.readyState,
              elapsedMs: Date.now() - started,
              level: "error",
            });
            return;
          }
          window.setTimeout(poll, 250);
        };
        window.setTimeout(poll, 250);
      }
      return;
    }
    const endpoints = this.requestedRemoteVideo
      .map((r) => r.endpointId)
      .filter(Boolean);
    const constraints: Record<string, { minHeight: number; maxHeight: number }> =
      {};
    for (const endpoint of endpoints) {
      constraints[endpoint] = {
        minHeight: 0,
        maxHeight: GROUP_CALL_VIDEO_MAX_HEIGHT,
      };
    }
    const message = {
      colibriClass: "ReceiverVideoConstraints",
      // Match telegram-tt groupCall.ts updateRemoteVideoConstraints.
      defaultConstraints: { maxHeight: 0 },
      constraints,
      onStageEndpoints: endpoints,
    };
    try {
      channel.send(JSON.stringify(message));
      logPageDisplay("messages_voice_video_constraints_sent", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        count: endpoints.length,
        endpoints,
        level: "info",
      });
    } catch (err) {
      logPageDisplay("messages_voice_video_constraints_fail", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
    }
  }

  private attachGroupCallDataChannel(connection: RTCPeerConnection): void {
    try {
      this.dataChannel?.close();
    } catch {
      // ignore
    }
    this.dataChannel = null;
    // Same negotiated channel as telegram-tt (label data, id 0).
    const channel = connection.createDataChannel("data", {
      id: 0,
      ordered: true,
    });
    this.dataChannel = channel;
    logPageDisplay("messages_voice_data_channel_created", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      readyState: channel.readyState,
      level: "info",
    });
    channel.onopen = () => {
      logPageDisplay("messages_voice_data_channel_open", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        level: "info",
      });
      this.sendReceiverVideoConstraints();
    };
    channel.onclose = () => {
      logPageDisplay("messages_voice_data_channel_close", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        level: "warn",
      });
    };
    channel.onerror = () => {
      logPageDisplay("messages_voice_data_channel_error", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        readyState: channel.readyState,
        level: "warn",
      });
    };
  }

  /**
   * Prefer join-payload codecs (H264 first — Telegram mobile screencasts) on
   * recvonly slots so createOffer advertises them before we mirror PTs in the answer.
   */
  private applyJoinVideoCodecPreferences(transceiver: RTCRtpTransceiver): void {
    try {
      const caps = RTCRtpReceiver.getCapabilities?.("video");
      if (!caps?.codecs?.length) return;
      const preferNames = this.videoPayloadTypes
        .map((p) => p.name.toUpperCase())
        .filter((name) => name && name !== "RTX" && name !== "RED" && name !== "ULPFEC");
      const order =
        preferNames.length > 0
          ? preferNames
          : ["H264", "VP8", "VP9", "AV1"];
      // H264 first for Telegram desktop/mobile screencasts.
      if (!order.includes("H264")) order.unshift("H264");
      const preferred: RTCRtpCodecCapability[] = [];
      const seen = new Set<string>();
      for (const name of order) {
        for (const codec of caps.codecs) {
          const mime = codec.mimeType?.toUpperCase() ?? "";
          if (!mime.endsWith(`/${name}`)) continue;
          const key = `${mime}|${codec.sdpFmtpLine ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          preferred.push(codec);
        }
      }
      for (const codec of caps.codecs) {
        const mime = codec.mimeType?.toUpperCase() ?? "";
        if (mime.endsWith("/RTX") || mime.endsWith("/RED") || mime.endsWith("/ULPFEC")) {
          preferred.push(codec);
        }
      }
      if (preferred.length > 0 && typeof transceiver.setCodecPreferences === "function") {
        transceiver.setCodecPreferences(preferred);
      }
    } catch {
      // Older browsers / unsupported — offer still mirrors whatever Chrome emits.
    }
  }

  private async renegotiateRemoteVideos(): Promise<void> {
    const connection = this.connection;
    const transport = this.lastTransport;
    if (!connection || !transport || !this.joined) return;

    const wanted = this.requestedRemoteVideo.slice(0, 8);
    const wantedKey = this.remoteVideoKeyOf(wanted);
    if (wantedKey === this.lastAppliedRemoteVideoKey) return;

    logPageDisplay("messages_voice_remote_video_renegotiate_start", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      count: wanted.length,
      endpoints: wanted.map((r) => r.endpointId),
      ssrcGroups: wanted.map((r) =>
        r.ssrcGroups.map((g) => `${g.semantics}:${g.sourceIds.join(",")}`),
      ),
      level: "info",
    });

    // Map slots for ontrack → endpoint association. Do NOT addTransceiver here —
    // telegram-tt grows m-lines via the remote offer; pre-adding slots made
    // Chrome's local m-line order diverge from a crafted answer and starved SCTP.
    while (this.videoRecvSlots.length < wanted.length) {
      this.videoRecvSlots.push({ transceiver: null, endpointId: null });
    }
    for (let i = 0; i < this.videoRecvSlots.length; i += 1) {
      const slot = this.videoRecvSlots[i]!;
      const req = wanted[i];
      slot.endpointId = req?.endpointId ?? null;
    }

    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.setTimeout(resolve, 32);
    });
    if (this.connection !== connection || !this.joined) return;

    const sections: TelegramGroupCallRemoteVideoSection[] = wanted.map((req) => ({
      endpointId: req.endpointId,
      ssrcGroups: req.ssrcGroups.map((g) => ({
        semantics: g.semantics,
        sourceIds: g.sourceIds,
      })),
    }));

    try {
      // Prefer the last remote *offer* (has our SCTP + video layout). Fall back
      // to local description (join offer, or createAnswer after subscribe).
      const localSdp =
        (connection.remoteDescription?.type === "offer"
          ? connection.remoteDescription.sdp
          : null) ||
        connection.localDescription?.sdp ||
        connection.remoteDescription?.sdp ||
        "";
      if (!localSdp) return;
      const offerSdp = groupCallRemoteSubscribeOfferSdp(
        transport,
        localSdp,
        sections,
        {
          videoPayloadTypes: this.videoPayloadTypes,
          videoExtensions: this.videoExtensions,
          audioSourceId: parsePrimarySsrcFromSdp(
            connection.localDescription?.sdp || localSdp,
            "audio",
          ),
        },
      );
      const offerMedia = parseOfferMediaSections(offerSdp);
      logPageDisplay("messages_voice_remote_video_offer_codecs", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        mode: "remote_offer",
        signaling: connection.signalingState,
        conn: connection.connectionState,
        dataChannel: this.dataChannel?.readyState ?? "missing",
        mids: offerMedia.map((s) => `${s.kind}:${s.mid}`),
        hasApplication: offerMedia.some((s) => s.kind === "application"),
        joinPayloadIds: this.videoPayloadTypes.map((p) => p.id).slice(0, 8),
        level: "info",
      });
      await connection.setRemoteDescription({
        type: "offer",
        sdp: offerSdp,
      });
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.setTimeout(resolve, 16);
      });
      if (this.connection !== connection || !this.joined) return;
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
    } catch (err) {
      this.lastAppliedRemoteVideoKey = "";
      logPageDisplay("messages_voice_remote_video_renegotiate_fail", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        mode: "remote_offer",
        signaling: connection.signalingState,
        conn: connection.connectionState,
        dataChannel: this.dataChannel?.readyState ?? "missing",
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
      throw err;
    }

    this.lastAppliedRemoteVideoKey = wantedKey;
    this.lastAppliedRemoteVideoEndpoints = wanted.map((r) => r.endpointId);
    // Bind any new recv transceivers Chrome created for the extra m-lines.
    const extraVideoTransceivers = connection
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === "video")
      .filter((t) => t.mid && t.mid !== "1");
    for (let i = 0; i < wanted.length; i += 1) {
      const slot = this.videoRecvSlots[i];
      if (!slot) continue;
      const transceiver = extraVideoTransceivers[i];
      if (transceiver) slot.transceiver = transceiver;
    }
    logPageDisplay("messages_voice_remote_video_renegotiated", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      sections: sections.filter(Boolean).length,
      mids: parseOfferMediaSections(connection.localDescription?.sdp ?? "").length,
      mediaKinds: parseOfferMediaSections(connection.localDescription?.sdp ?? "").map(
        (s) => s.kind,
      ),
      endpoints: wanted.map((r) => r.endpointId),
      mode: "remote_offer",
      dataChannel: this.dataChannel?.readyState ?? "missing",
      level: "info",
    });
    this.sendReceiverVideoConstraints();
    this.pullRemoteMediaTracks(connection);
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        if (this.connection !== connection || !this.joined) return;
        void this.logIceDiagnostics(connection, "post_video_renegotiate_1s").then(
          (stats) => {
            if (this.connection !== connection || !this.joined) return;
            logPageDisplay("messages_voice_remote_video_packets", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundVideoPackets: stats.inboundVideoPackets,
              inboundPackets: stats.inboundPackets,
              outboundPackets: stats.outboundPackets,
              dataChannel: this.dataChannel?.readyState ?? "missing",
              slotted: this.videoRecvSlots.filter((s) => s.endpointId).length,
              mapped: this.remoteVideoByEndpoint.size,
              level: stats.inboundVideoPackets > 0 ? "info" : "warn",
            });
            if (stats.inboundVideoPackets > 0) {
              this.remoteVideoPacketRetries = 0;
              return;
            }
            if (
              this.requestedRemoteVideo.length > 0 &&
              this.remoteVideoPacketRetries < 3
            ) {
              this.remoteVideoPacketRetries += 1;
              this.sendReceiverVideoConstraints();
              logPageDisplay("messages_voice_remote_video_constraints_retry", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                attempt: this.remoteVideoPacketRetries,
                dataChannel: this.dataChannel?.readyState ?? "missing",
                slotted: this.videoRecvSlots.filter((s) => s.endpointId).length,
                mapped: this.remoteVideoByEndpoint.size,
                level: "warn",
              });
            }
          },
        );
      }, 1_000);
    }
  }

  private pullRemoteMediaTracks(
    connection: RTCPeerConnection,
    opts?: { audioOnly?: boolean },
  ): void {
    const audioOnly = Boolean(opts?.audioOnly);
    for (const receiver of connection.getReceivers()) {
      const track = receiver.track;
      if (!track) continue;
      if (track.kind === "audio") this.attachRemoteAudioTrack(track);
      else if (track.kind === "video" && !audioOnly) {
        this.attachRemoteVideoTrack(track);
      }
    }
  }

  private async logIceDiagnostics(
    connection: RTCPeerConnection,
    label: string,
  ): Promise<{
    inboundPackets: number;
    inboundVideoPackets: number;
    outboundPackets: number;
  }> {
    try {
      const stats = await connection.getStats();
      let inboundAudio = 0;
      let outboundAudio = 0;
      let inboundPackets = 0;
      let outboundPackets = 0;
      let inboundVideo = 0;
      let inboundVideoPackets = 0;
      let framesDecoded = 0;
      let framesReceived = 0;
      const videoCodecs: string[] = [];
      let pairsSucceeded = 0;
      let pairsInProgress = 0;
      let pairsFailed = 0;
      const locals: string[] = [];
      const remotes: string[] = [];
      const codecById = new Map<string, string>();
      stats.forEach((report) => {
        if (report.type === "codec" && report.mimeType) {
          codecById.set(report.id, String(report.mimeType));
        }
      });
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          inboundAudio += Number(report.bytesReceived) || 0;
          inboundPackets += Number(report.packetsReceived) || 0;
        }
        if (report.type === "inbound-rtp" && report.kind === "video") {
          inboundVideo += Number(report.bytesReceived) || 0;
          inboundVideoPackets += Number(report.packetsReceived) || 0;
          framesDecoded += Number(report.framesDecoded) || 0;
          framesReceived += Number(report.framesReceived) || 0;
          const codecId = report.codecId ? String(report.codecId) : "";
          const mime = codecId ? codecById.get(codecId) : null;
          if (mime) videoCodecs.push(mime);
        }
        if (report.type === "outbound-rtp" && report.kind === "audio") {
          outboundAudio += Number(report.bytesSent) || 0;
          outboundPackets += Number(report.packetsSent) || 0;
        }
        if (report.type === "candidate-pair") {
          if (report.state === "succeeded") pairsSucceeded++;
          else if (report.state === "in-progress") pairsInProgress++;
          else if (report.state === "failed") pairsFailed++;
        }
        if (report.type === "local-candidate") {
          const addr = report.address || report.ip || "?";
          locals.push(`${addr}:${report.port}/${report.candidateType}`);
        }
        if (report.type === "remote-candidate") {
          const addr = report.address || report.ip || "?";
          remotes.push(`${addr}:${report.port}/${report.candidateType}`);
        }
      });
      const silentCtx = sharedSilentAudioCtx ?? getVoiceAutoplayAudioContext();
      appWarn("[voice-ice-stats]", label, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice: connection.iceConnectionState,
        conn: connection.connectionState,
        inboundAudio,
        inboundPackets,
        inboundVideo,
        inboundVideoPackets,
        framesDecoded,
        framesReceived,
        videoCodecs: videoCodecs.slice(0, 4).join(",") || "none",
        outboundAudio,
        outboundPackets,
        usingSilentAudio: this.usingSilentAudio,
        silentCtxState: silentCtx?.state ?? "none",
        pairsSucceeded,
        pairsInProgress,
        pairsFailed,
        localCandidates: locals.join(","),
        remoteCandidates: remotes.join(","),
      });
      return { inboundPackets, inboundVideoPackets, outboundPackets };
    } catch {
      // ignore stats errors
      return { inboundPackets: 0, inboundVideoPackets: 0, outboundPackets: 0 };
    }
  }

  private scheduleJoinLostIfStillBroken(
    connection: RTCPeerConnection,
    reason: string,
    delayMs = 12_000,
  ): void {
    if (this.iceDisconnectTimer) return;
    this.iceDisconnectTimer = window.setTimeout(() => {
      this.iceDisconnectTimer = null;
      if (this.connection !== connection) return;
      if (this.isMediaConnected()) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      // Ignore transient "disconnected" — Chrome flaps this during healthy calls
      // and rejoining from here froze the UI after a while in voice.
      if (ice === "failed" || ice === "closed" || conn === "failed" || conn === "closed") {
        this.markJoinLost(reason);
      }
    }, delayMs);
  }

  private clearJoinLostTimer(): void {
    if (this.iceDisconnectTimer) {
      window.clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
  }

  private markJoinLost(reason: string, opts?: { silent?: boolean }): void {
    if (!this.joined && !this.connection) return;
    this.speakingSyncBlockedUntil = Date.now() + 4_000;
    this.lastSpeakingSynced = null;
    // Tear down media so ensureJoinedListenOnly can open a fresh PeerConnection.
    // Do not remove the remote <audio> shell — unlock gestures still need it.
    this.stopSpeakingMonitor();
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    // Keep prefetched mic across silent markJoinLost so unmute after rejoin
    // does not re-prompt — only drop ended tracks.
    if (this.prefetchedMicTrack && this.prefetchedMicTrack.readyState !== "live") {
      this.prefetchedMicTrack = null;
    }
    this.stopLocalVideoCaptures();
    this.teardownPresentationConnection();
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }
    this.clearRemoteVideoStream();
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }
    const wasJoined = this.joined;
    this.clearVideoRenegotiateConnectWait();
    this.joined = false;
    this.micEnabled = false;
    this.lastTransport = null;
    this.videoPayloadTypes = [];
    this.videoExtensions = [];
    this.lastAppliedRemoteVideoEndpoints = [];
    this.videoRecvSlots = [];
    this.requestedRemoteVideo = [];
    this.lastAppliedRemoteVideoKey = "";
    this.remoteAudioEnabled = false;
    appWarn("[voice-join-lost]", reason, {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      wasJoined,
      silent: Boolean(opts?.silent),
    });
    if (opts?.silent) return;
    for (const listener of this.joinLostListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get isCameraEnabled(): boolean {
    return this.cameraEnabled;
  }

  get isScreenSharing(): boolean {
    return this.screenSharing;
  }

  getLiveLocalCameraStream(): MediaStream | null {
    return this.cameraEnabled ? this.localCameraStream : null;
  }

  getLiveLocalScreenStream(): MediaStream | null {
    return this.screenSharing ? this.localScreenStream : null;
  }

  get isLocalSpeaking(): boolean {
    return this.localSpeaking;
  }

  onLocalMediaChange(
    listener: (state: {
      cameraActive: boolean;
      screenSharing: boolean;
      localCameraStream: MediaStream | null;
      localScreenStream: MediaStream | null;
    }) => void,
  ): () => void {
    this.localMediaListeners.add(listener);
    listener(this.getLocalMediaState());
    return () => {
      this.localMediaListeners.delete(listener);
    };
  }

  private getLocalMediaState(): {
    cameraActive: boolean;
    screenSharing: boolean;
    localCameraStream: MediaStream | null;
    localScreenStream: MediaStream | null;
  } {
    return {
      cameraActive: this.cameraEnabled,
      screenSharing: this.screenSharing,
      localCameraStream: this.getLiveLocalCameraStream(),
      localScreenStream: this.getLiveLocalScreenStream(),
    };
  }

  private notifyLocalMediaListeners(): void {
    const payload = this.getLocalMediaState();
    for (const listener of this.localMediaListeners) {
      try {
        listener(payload);
      } catch {
        // ignore
      }
    }
  }

  private findVideoSender(): RTCRtpSender | null {
    if (!this.connection) return null;
    return (
      this.connection.getSenders().find((s) => s.track?.kind === "video") ??
      this.connection.getSenders().find((s) => !s.track || s.track.kind === "video") ??
      null
    );
  }

  private async replaceOutboundVideo(track: MediaStreamTrack): Promise<void> {
    const sender = this.findVideoSender();
    if (sender) {
      await sender.replaceTrack(track);
    }
    this.outboundVideoTrack = track;
    if (this.localStream) {
      for (const existing of this.localStream.getVideoTracks()) {
        this.localStream.removeTrack(existing);
      }
      this.localStream.addTrack(track);
    }
  }

  /** Prefer camera on the main PC; screen share uses a separate presentation PC. */
  private async syncOutboundVideoTrack(): Promise<void> {
    const preferred = this.screenSharing ? null : this.cameraTrack;
    if (preferred) {
      await this.replaceOutboundVideo(preferred);
      return;
    }
    if (this.outboundVideoTrack && this.outboundVideoTrack.readyState === "live") {
      // Already on silent / leftover — keep it if it isn't camera/screen.
      if (this.outboundVideoTrack !== this.cameraTrack && this.outboundVideoTrack !== this.screenTrack) {
        await this.replaceOutboundVideo(this.outboundVideoTrack);
        return;
      }
    }
    const silent = createSilentVideoTrack();
    if (this.outboundVideoTrack && this.outboundVideoTrack !== silent) {
      try {
        this.outboundVideoTrack.stop();
      } catch {
        // ignore
      }
    }
    await this.replaceOutboundVideo(silent);
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.cameraEnabled && (enabled ? this.cameraTrack != null : true)) {
      this.notifyLocalMediaListeners();
      return;
    }
    if (!enabled) {
      this.cameraTrack?.stop();
      this.cameraTrack = null;
      this.localCameraStream = null;
      this.cameraEnabled = false;
      await this.syncOutboundVideoTrack();
      this.notifyLocalMediaListeners();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("camera_unavailable");
    }
    const camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    const track = camStream.getVideoTracks()[0];
    if (!track) {
      camStream.getTracks().forEach((t) => t.stop());
      throw new Error("camera_unavailable");
    }
    track.enabled = true;
    this.cameraTrack?.stop();
    this.cameraTrack = track;
    this.localCameraStream = new MediaStream([track]);
    this.cameraEnabled = true;
    if (!this.joined) {
      await this.ensureJoinedListenOnly();
    }
    await this.syncOutboundVideoTrack();
    this.notifyLocalMediaListeners();
  }

  async startScreenShare(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("screen_share_unavailable");
    }
    if (!this.joined) {
      await this.ensureJoinedListenOnly();
    }
    if (!this.joined) {
      throw new Error("voice_not_joined");
    }
    if (this.presentationJoining) {
      await this.presentationJoining;
      if (this.screenSharing) return;
    }
    if (this.screenSharing && this.presentationConnection) {
      this.notifyLocalMediaListeners();
      return;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        // Cap capture intent at 360p — browsers may ignore; encoding still enforces.
        width: { max: 640, ideal: 640 },
        height: { max: 360, ideal: 360 },
        frameRate: { max: 15, ideal: 10 },
      },
    });
    const track = displayStream.getVideoTracks()[0];
    if (!track) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error("screen_share_unavailable");
    }
    track.enabled = true;
    await this.constrainScreenShareTrack(track);

    try {
      this.presentationJoining = this.joinPresentationConnection(track);
      await this.presentationJoining;
    } catch (err) {
      track.stop();
      displayStream.getTracks().forEach((t) => t.stop());
      throw err;
    } finally {
      this.presentationJoining = null;
    }

    this.screenTrack?.stop();
    this.screenTrack = track;
    this.localScreenStream = new MediaStream([track]);
    this.screenSharing = true;
    track.onended = () => {
      void this.stopScreenShare();
    };
    await this.applyScreenShareEncoding();
    this.notifyLocalMediaListeners();
    logPageDisplay("messages_voice_screen_share_started", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      presentationAudioSourceId: this.presentationAudioSourceId,
      level: "info",
    });
  }

  /** Tune encode target from the in-dialog screenshare stage size. */
  setScreenShareDisplaySize(width: number, height: number): void {
    const nextW = Math.max(1, Math.round(width));
    const nextH = Math.max(1, Math.round(height));
    if (
      nextW === this.screenShareDisplaySize.width &&
      nextH === this.screenShareDisplaySize.height
    ) {
      return;
    }
    this.screenShareDisplaySize = { width: nextW, height: nextH };
    if (this.screenSharing && this.screenTrack) {
      void this.constrainScreenShareTrack(this.screenTrack);
      void this.applyScreenShareEncoding();
    }
  }

  private async constrainScreenShareTrack(track: MediaStreamTrack): Promise<void> {
    const { width: targetW, height: targetH, maxFramerate } =
      this.computeScreenShareTargets();
    try {
      await track.applyConstraints({
        width: { max: targetW, ideal: targetW },
        height: { max: targetH, ideal: targetH },
        frameRate: { max: maxFramerate, ideal: Math.min(10, maxFramerate) },
      });
    } catch {
      // Screen tracks often reject resolution constraints — encoding still caps.
    }
  }

  private computeScreenShareTargets(): {
    width: number;
    height: number;
    maxBitrate: number;
    maxFramerate: number;
    scaleResolutionDownBy: number;
  } {
    const dpr =
      typeof window !== "undefined"
        ? Math.min(window.devicePixelRatio || 1, 1.5)
        : 1;
    const displayW = this.screenShareDisplaySize.width;
    const displayH = this.screenShareDisplaySize.height;
    // Never exceed 360p; shrink further when the stage is small.
    const width = Math.min(640, Math.max(160, Math.round(displayW * dpr)));
    const height = Math.min(360, Math.max(90, Math.round(displayH * dpr)));
    const areaRatio = (width * height) / (640 * 360);
    const maxBitrate = Math.round(120_000 + areaRatio * 380_000);
    const maxFramerate = width < 320 ? 8 : 12;
    const settings = this.screenTrack?.getSettings?.() ?? {};
    const srcW = typeof settings.width === "number" && settings.width > 0 ? settings.width : 1920;
    const scaleResolutionDownBy = Math.max(1, srcW / width);
    return { width, height, maxBitrate, maxFramerate, scaleResolutionDownBy };
  }

  private async applyScreenShareEncoding(): Promise<void> {
    const pc = this.presentationConnection;
    const track = this.screenTrack;
    if (!pc || !track) return;
    const sender = pc
      .getSenders()
      .find((s) => s.track === track || s.track?.kind === "video");
    if (!sender) return;
    const targets = this.computeScreenShareTargets();
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) {
        params.encodings = [{}];
      }
      for (const encoding of params.encodings) {
        encoding.scaleResolutionDownBy = targets.scaleResolutionDownBy;
        encoding.maxBitrate = targets.maxBitrate;
        encoding.maxFramerate = targets.maxFramerate;
      }
      await sender.setParameters(params);
      logPageDisplay("messages_voice_screen_share_quality", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        displayW: this.screenShareDisplaySize.width,
        displayH: this.screenShareDisplaySize.height,
        targetW: targets.width,
        targetH: targets.height,
        maxBitrate: targets.maxBitrate,
        scale: targets.scaleResolutionDownBy,
        level: "info",
      });
    } catch {
      // setParameters can fail before the first negotiation completes
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenSharing && !this.screenTrack && !this.presentationConnection) {
      this.notifyLocalMediaListeners();
      return;
    }
    if (this.joined) {
      void endTelegramChatVoiceScreenShare({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
      }).catch((err) => {
        appWarn(
          "[voice-screen-share-end]",
          err instanceof Error ? err.message : String(err),
          { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
        );
      });
    }
    this.teardownPresentationConnection();
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    this.screenSharing = false;
    await this.syncOutboundVideoTrack();
    this.notifyLocalMediaListeners();
    logPageDisplay("messages_voice_screen_share_stopped", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      level: "info",
    });
  }

  private teardownPresentationConnection(): void {
    if (this.presentationAudioTrack) {
      try {
        this.presentationAudioTrack.stop();
      } catch {
        // ignore
      }
      this.presentationAudioTrack = null;
    }
    if (this.presentationConnection) {
      try {
        this.presentationConnection.close();
      } catch {
        // ignore
      }
      this.presentationConnection = null;
    }
    this.presentationAudioSourceId = null;
  }

  /** Publish screen on a dedicated presentation WebRTC connection (Telegram API). */
  private async joinPresentationConnection(screenTrack: MediaStreamTrack): Promise<void> {
    this.teardownPresentationConnection();

    const presentationAudio = createSilentAudioTrack();
    presentationAudio.enabled = true;

    const connection = new RTCPeerConnection({
      iceServers: [],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    // Presentation is publish-only — sendonly m-lines require a recvonly answer
    // (see groupCallAnswerSdpFromTransport presentation:true).
    connection.addTransceiver(presentationAudio, { direction: "sendonly" });
    connection.addTransceiver(screenTrack, { direction: "sendonly" });

    connection.oniceconnectionstatechange = () => {
      const ice = connection.iceConnectionState;
      logPageDisplay("messages_voice_presentation_pc_ice", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice,
        conn: connection.connectionState,
        level: ice === "connected" || ice === "completed" ? "info" : "warn",
      });
    };

    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 32);
      });
    });

    const offer = await connection.createOffer();
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.setTimeout(resolve, 32);
    });
    await connection.setLocalDescription(offer);
    await disableAudioSenderDtx(connection);

    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const gatherBudgetMs = 1_800;
      const timeout = window.setTimeout(() => {
        connection.removeEventListener("icegatheringstatechange", onGather);
        resolve();
      }, gatherBudgetMs);
      const onGather = () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          connection.removeEventListener("icegatheringstatechange", onGather);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", onGather);
    });

    const localSdp = connection.localDescription?.sdp ?? offer.sdp;
    if (!localSdp) {
      connection.close();
      presentationAudio.stop();
      throw new Error("presentation_offer_sdp_missing");
    }

    const parsed = parseGroupCallOfferSdp(localSdp);
    const joinPayloadJson = buildGroupCallJoinPayloadJson(parsed);
    if (!joinPayloadJson || parsed.source == null) {
      connection.close();
      presentationAudio.stop();
      throw new Error("presentation_join_payload_build_failed");
    }
    if (!parsed.sourceGroup || parsed.sourceGroup.length === 0) {
      connection.close();
      presentationAudio.stop();
      throw new Error("presentation_video_ssrc_missing");
    }

    logPageDisplay("messages_voice_screen_share_join_start", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      fidCount: parsed.sourceGroup.length,
      level: "info",
    });

    // Yield so dialog Close / emoji work can run before the TDLib round-trip —
    // createOffer + setLocalDescription already burned the main thread and the
    // 15s fetch abort fired as screen_share_timeout while the UI was frozen.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 48);
      });
    });

    const joinResult = await startTelegramChatVoiceScreenShare({
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      payload: joinPayloadJson,
    });
    if (!joinResult.ok) {
      connection.close();
      presentationAudio.stop();
      throw new Error(joinResult.error);
    }

    const rollbackTdlibShare = () => {
      void endTelegramChatVoiceScreenShare({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
      }).catch(() => undefined);
    };

    const joinParsed = parseGroupCallJoinTransport(joinResult.join_payload);
    if (!joinParsed) {
      connection.close();
      presentationAudio.stop();
      rollbackTdlibShare();
      throw new Error("presentation_join_transport_invalid");
    }
    const slimTransport = {
      ...joinParsed.transport,
      candidates: pickJoinAnswerCandidates(joinParsed.transport.candidates),
    };
    const answerSdp = groupCallAnswerSdpFromTransport(slimTransport, localSdp, [], {
      minimalVideo: false,
      presentation: true,
      videoPayloadTypes:
        joinParsed.videoPayloadTypes.length > 0
          ? joinParsed.videoPayloadTypes
          : this.videoPayloadTypes,
      videoExtensions:
        joinParsed.videoExtensions.length > 0
          ? joinParsed.videoExtensions
          : this.videoExtensions,
    });

    try {
      await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await disableAudioSenderDtx(connection);
    } catch (err) {
      connection.close();
      presentationAudio.stop();
      rollbackTdlibShare();
      throw err;
    }

    this.presentationConnection = connection;
    this.presentationAudioTrack = presentationAudio;
    this.presentationAudioSourceId = parsed.source;

    logPageDisplay("messages_voice_screen_share_join_ok", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      candidateCount: slimTransport.candidates.length,
      level: "info",
    });

    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        if (this.presentationConnection !== connection) return;
        void connection.getStats().then((stats) => {
          let outboundVideoPackets = 0;
          let outboundVideoBytes = 0;
          stats.forEach((report) => {
            if (report.type === "outbound-rtp" && report.kind === "video") {
              outboundVideoPackets += Number(report.packetsSent) || 0;
              outboundVideoBytes += Number(report.bytesSent) || 0;
            }
          });
          logPageDisplay("messages_voice_screen_share_outbound", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            outboundVideoPackets,
            outboundVideoBytes,
            ice: connection.iceConnectionState,
            conn: connection.connectionState,
            level: outboundVideoPackets > 0 ? "info" : "warn",
          });
        });
      }, 1_500);
    }
  }

  private stopLocalVideoCaptures(): void {
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    this.cameraEnabled = false;
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    this.screenSharing = false;
    this.notifyLocalMediaListeners();
  }

  onLocalSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(listener);
    return () => {
      this.speakingListeners.delete(listener);
    };
  }

  async ensureJoinedListenOnly(): Promise<void> {
    if (this.joined) {
      // Stay put while ICE connects — callers used to rejoin on !mediaConnected
      // and freeze the UI with repeated SDP offers.
      return;
    }
    if (this.joining) {
      await this.joining;
      return;
    }
    this.joining = this.joinInternal(true);
    try {
      await this.joining;
    } finally {
      this.joining = null;
    }
  }

  /**
   * Start getUserMedia during the Join click (user gesture). Call before SDP so
   * the post-join unmute does not wait on a permission prompt mid-dialog.
   *
   * Stash-only: never replaceTrack onto the live PC. A late prefetch that
   * attached enabled=false over the silent sender killed outbound RTP
   * (outboundPackets=0 → SFU keeps remoteMuted forever).
   */
  prefetchLocalMic(): void {
    if (typeof window === "undefined") return;
    if (this.audioTrack && !this.usingSilentAudio) return;
    if (this.prefetchedMicTrack && this.prefetchedMicTrack.readyState === "live") return;
    if (this.micPrefetch) return;
    this.micPrefetch = this.ensureLocalMic({ fromUserGesture: true, publish: false })
      .catch((err) => {
        appWarn(
          "[voice-mic-prefetch]",
          err instanceof Error ? err.message : String(err),
          { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
        );
      })
      .finally(() => {
        this.micPrefetch = null;
      });
  }

  /**
   * Acquire a real mic (user gesture).
   * - publish:false → stash in prefetchedMicTrack only (Join-click prefetch).
   * - publish:true → replace silent sender; enable before replaceTrack so RTP
   *   never drops to a disabled track mid-call.
   */
  async ensureLocalMic(options?: {
    fromUserGesture?: boolean;
    publish?: boolean;
    enabled?: boolean;
  }): Promise<void> {
    const publish = options?.publish !== false;
    if (this.audioTrack && !this.usingSilentAudio) return;
    if (this.micPrefetch && !options?.fromUserGesture) {
      await this.micPrefetch;
      if (this.audioTrack && !this.usingSilentAudio) return;
    }
    // Prefer the Join-click stash over a second getUserMedia.
    let audioTrack: MediaStreamTrack | null =
      this.prefetchedMicTrack && this.prefetchedMicTrack.readyState === "live"
        ? this.prefetchedMicTrack
        : null;
    if (audioTrack) {
      this.prefetchedMicTrack = null;
    } else {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("microphone_unavailable");
      }
      // Yield so the voice dialog can paint / handle Close before getUserMedia
      // device enumeration freezes the main thread (logs: unmute → stuck UI).
      // Skip the yield when prefetching from the Join click — Safari needs the
      // gesture stack for the permission prompt.
      if (!options?.fromUserGesture) {
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          } else {
            setTimeout(resolve, 0);
          }
        });
      }
      if (this.audioTrack && !this.usingSilentAudio) return;
      // Prefetch may have finished while we yielded.
      if (this.prefetchedMicTrack && this.prefetchedMicTrack.readyState === "live") {
        audioTrack = this.prefetchedMicTrack;
        this.prefetchedMicTrack = null;
      } else {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        audioTrack = micStream.getAudioTracks()[0] ?? null;
        if (!audioTrack) {
          micStream.getTracks().forEach((track) => track.stop());
          throw new Error("microphone_unavailable");
        }
      }
    }

    if (!publish) {
      // Keep listen-only silent RTP on the PC; stash mic for later unmute.
      audioTrack.enabled = false;
      if (this.prefetchedMicTrack && this.prefetchedMicTrack !== audioTrack) {
        try {
          this.prefetchedMicTrack.stop();
        } catch {
          // ignore
        }
      }
      this.prefetchedMicTrack = audioTrack;
      logPageDisplay("messages_voice_mic_prefetched", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        usingSilentAudio: this.usingSilentAudio,
        hasConnection: Boolean(this.connection),
        level: "info",
      });
      return;
    }

    // Publishing: never put enabled=false on the live sender (DTX / SFU stall).
    audioTrack.enabled = options?.enabled !== false;

    const previous = this.audioTrack;
    if (this.connection && previous) {
      const sender = this.connection
        .getSenders()
        .find((s) => s.track?.kind === "audio" || s.track === previous);
      if (sender) {
        // Don't block unmute UI on replaceTrack — local swap is enough for the chip.
        void sender.replaceTrack(audioTrack).catch(() => undefined);
      }
    }
    if (previous && previous !== audioTrack) {
      if (this.usingSilentAudio) {
        // Keep silence for the next mute instead of recreating oscillators.
        this.silentOutboundTrack = previous;
      } else if (previous !== this.prefetchedMicTrack) {
        previous.stop();
      }
    }

    this.audioTrack = audioTrack;
    this.usingSilentAudio = false;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) {
        this.localStream.removeTrack(t);
      }
      this.localStream.addTrack(audioTrack);
    } else {
      this.localStream = new MediaStream([audioTrack]);
    }
    this.startSpeakingMonitor();
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    // Only acquire a real mic when unmuting. The previous `usingSilentAudio`
    // branch called getUserMedia on every muted joinListen path and could hang
    // the page (permission prompt / device enumeration) right as the dialog opened.
    if (enabled) {
      await this.ensureLocalMic({ publish: true, enabled: true });
      if (this.audioTrack) this.audioTrack.enabled = true;
    } else if (this.audioTrack && !this.usingSilentAudio && this.connection) {
      // Swap back to near-silent outbound instead of track.enabled=false — a
      // disabled sender stops RTP and Telegram's SFU often stops forwarding
      // remote audio (same failure mode as the prefetch+muted join bug).
      const silent = this.getOrCreateSilentOutboundTrack();
      silent.enabled = true;
      const previous = this.audioTrack;
      const sender = this.connection
        .getSenders()
        .find((s) => s.track?.kind === "audio" || s.track === previous);
      if (sender) {
        // Don't await — UI unmute/mute must feel instant; replaceTrack is local.
        void sender.replaceTrack(silent).catch(() => undefined);
      }
      // Keep the real mic around for a quick unmute (don't stop it).
      this.prefetchedMicTrack = previous;
      previous.enabled = false;
      this.audioTrack = silent;
      this.usingSilentAudio = true;
      if (this.localStream) {
        for (const t of this.localStream.getAudioTracks()) {
          this.localStream.removeTrack(t);
        }
        this.localStream.addTrack(silent);
      }
    } else if (this.audioTrack) {
      // Already on silence — keep the sender enabled so RTP continues.
      this.audioTrack.enabled = true;
    }
    this.micEnabled = enabled;
    if (!enabled) {
      this.setLocalSpeaking(false);
    } else {
      // Track may already exist from a prior unmute — ensure the RMS monitor is live.
      this.startSpeakingMonitor();
      void this.analyserCtx?.resume().catch(() => undefined);
    }

    // Best-effort Telegram mute — never block the control chip on the network RTT.
    void this.syncMicMutedToTelegram(!enabled);
  }

  private getOrCreateSilentOutboundTrack(): MediaStreamTrack {
    if (
      this.silentOutboundTrack &&
      this.silentOutboundTrack.readyState === "live"
    ) {
      this.silentOutboundTrack.enabled = true;
      return this.silentOutboundTrack;
    }
    const silent = createSilentAudioTrack();
    silent.enabled = true;
    this.silentOutboundTrack = silent;
    return silent;
  }

  private async syncMicMutedToTelegram(isMuted: boolean): Promise<void> {
    try {
      if (!this.joined) {
        await this.ensureJoinedListenOnly();
        if (!isMuted) {
          await this.ensureLocalMic({ publish: true, enabled: true });
          if (this.audioTrack) this.audioTrack.enabled = true;
          this.micEnabled = true;
        } else if (this.audioTrack) {
          this.audioTrack.enabled = true;
        }
      }
      this.resumeRemoteAudio();
      const muteResult = await setTelegramChatVoiceMicMuted({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        isMuted,
      });
      if (!muteResult.ok) {
        appWarn("[voice-mic-sync]", muteResult.error, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          enabled: !isMuted,
        });
        const err = muteResult.error;
        const needsRejoin =
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID") ||
            err.includes("GROUPCALL_SSRC_DUPLICATE_SIMULTANEOUS"));
        if (needsRejoin) {
          this.markJoinLost(err, { silent: true });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          await this.joinInternal(isMuted);
          if (!isMuted) {
            await this.ensureLocalMic({ publish: true, enabled: true });
            if (this.audioTrack) this.audioTrack.enabled = true;
            this.micEnabled = true;
          }
          this.resumeRemoteAudio();
        } else if (
          typeof err === "string" &&
          /Can't unmute user/i.test(err)
        ) {
          if (this.audioTrack && !this.usingSilentAudio && this.connection) {
            const silent = this.getOrCreateSilentOutboundTrack();
            silent.enabled = true;
            const previous = this.audioTrack;
            const sender = this.connection
              .getSenders()
              .find((s) => s.track?.kind === "audio" || s.track === previous);
            if (sender) {
              void sender.replaceTrack(silent).catch(() => undefined);
            }
            this.prefetchedMicTrack = previous;
            previous.enabled = false;
            this.audioTrack = silent;
            this.usingSilentAudio = true;
          } else if (this.audioTrack) {
            this.audioTrack.enabled = true;
          }
          this.micEnabled = false;
          this.setLocalSpeaking(false);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-mic-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId, enabled: !isMuted },
      );
    }
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (this.localSpeaking === speaking) return;
    this.localSpeaking = speaking;
    for (const listener of this.speakingListeners) {
      try {
        listener(speaking);
      } catch {
        // ignore listener errors
      }
    }
    void this.syncSpeakingToTelegram(speaking);
  }

  private async syncSpeakingToTelegram(speaking: boolean): Promise<void> {
    if (!this.joined || this.audioSourceId == null) return;
    const now = Date.now();
    if (now < this.speakingSyncBlockedUntil) return;
    // Debounce Telegram updates; always flush "not speaking" promptly.
    if (
      speaking &&
      this.lastSpeakingSynced === true &&
      now - this.lastSpeakingSyncAt < 350
    ) {
      return;
    }
    this.lastSpeakingSyncAt = now;
    this.lastSpeakingSynced = speaking;
    try {
      const result = await setTelegramChatVoiceSpeaking({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        audioSourceId: this.audioSourceId,
        isSpeaking: speaking,
      });
      if (!result.ok) {
        const err = result.error;
        appWarn("[voice-speaking-sync]", err, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
        });
        if (
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID"))
        ) {
          this.markJoinLost(err);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-speaking-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
    }
  }

  private startSpeakingMonitor(): void {
    if (this.analyserRaf != null || !this.audioTrack) return;
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;

    try {
      const ctx = new AudioContext();
      this.analyserCtx = ctx;
      const source = ctx.createMediaStreamSource(new MediaStream([this.audioTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      // Hysteresis — oscillating around a single threshold re-rendered the whole
      // voice dialog roster every frame and froze the page.
      const ON_RMS = 0.055;
      const OFF_RMS = 0.028;
      const MIN_FLIP_MS = 220;
      let lastFlipAt = 0;
      let speaking = this.localSpeaking;

      const tick = () => {
        this.analyserRaf = window.requestAnimationFrame(tick);
        if (!this.micEnabled || !this.audioTrack?.enabled) {
          if (speaking) {
            speaking = false;
            lastFlipAt = Date.now();
            this.setLocalSpeaking(false);
          }
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i]! - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        let next = speaking;
        if (!speaking && rms >= ON_RMS) next = true;
        else if (speaking && rms <= OFF_RMS) next = false;
        if (next !== speaking && now - lastFlipAt >= MIN_FLIP_MS) {
          speaking = next;
          lastFlipAt = now;
          this.setLocalSpeaking(speaking);
        }
      };
      this.analyserRaf = window.requestAnimationFrame(tick);
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      appWarn(
        "[voice-speaking-analyser]",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private stopSpeakingMonitor(): void {
    if (this.analyserRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.analyserRaf);
      this.analyserRaf = null;
    }
    if (this.analyserCtx) {
      void this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    this.setLocalSpeaking(false);
  }

  private ensureRemoteAudioElement(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.muted = false;
    audio.volume = 1;
    // Keep off-screen but in the document — some browsers won't play detached elements.
    audio.style.position = "fixed";
    audio.style.width = "0";
    audio.style.height = "0";
    audio.style.opacity = "0";
    audio.style.pointerEvents = "none";
    audio.setAttribute("aria-hidden", "true");
    document.body.appendChild(audio);
    this.remoteAudio = audio;
    return audio;
  }

  private armGestureUnmute(): void {
    if (typeof document === "undefined" || this.gestureUnmuteCleanup) return;
    const onGesture = () => {
      this.resumeRemoteAudio();
      this.gestureUnmuteCleanup?.();
      this.gestureUnmuteCleanup = null;
    };
    document.addEventListener("pointerdown", onGesture, { capture: true, once: true });
    document.addEventListener("keydown", onGesture, { capture: true, once: true });
    this.gestureUnmuteCleanup = () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }

  private ensureRemoteStream(): MediaStream {
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    return this.remoteStream;
  }

  private ensurePlaybackContext(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    const shared = getVoiceAutoplayAudioContext();
    if (shared) {
      this.playbackCtx = shared;
    } else if (!this.playbackCtx || this.playbackCtx.state === "closed") {
      this.playbackCtx = new AudioContext();
    }
    return this.playbackCtx;
  }

  private teardownWebAudioPlayback(): void {
    try {
      this.playbackSource?.disconnect();
    } catch {
      // ignore
    }
    this.playbackSource = null;
    this.playbackTrackKey = "";
  }

  private remoteAudioTrackKey(stream: MediaStream): string {
    return stream
      .getAudioTracks()
      .map((t) => `${t.id}:${t.readyState}:${t.muted ? "m" : "u"}`)
      .sort()
      .join("|");
  }

  /**
   * Connect remote audio → AudioContext.destination (telegram-tt hearable path).
   * Pass force=true after track unmute — Chrome can keep a muted-era source silent.
   */
  private rebuildWebAudioPlayback(force = false): boolean {
    const ctx = this.playbackCtx;
    const stream = this.remoteStream;
    if (!ctx || !stream || stream.getAudioTracks().length === 0) return false;
    const key = this.remoteAudioTrackKey(stream);
    if (!force && this.playbackSource && this.playbackTrackKey === key) {
      return true;
    }
    try {
      this.teardownWebAudioPlayback();
      // Fresh MediaStream snapshot so createMediaStreamSource sees current tracks.
      const snapshot = new MediaStream(stream.getAudioTracks());
      this.playbackSource = ctx.createMediaStreamSource(snapshot);
      this.playbackSource.connect(ctx.destination);
      this.playbackTrackKey = key;
      return true;
    } catch (err) {
      appWarn(
        "[voice-webaudio]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
      return false;
    }
  }

  /** Caps nested queueRemotePlayback — attach→pull→attach used to infinite-loop. */
  private remotePlayQueueDepth = 0;
  private remotePlayLoopWarnAt = 0;

  private queueRemotePlayback(reason: string): void {
    this.remotePlayQueueDepth += 1;
    // attachRemoteAudioTrack used to always queue, and ensureRemotePlaybackInternal
    // always pull→attach — that formed an endless promise chain after join_ok
    // (UI dead; ice_post_apply timers never ran). Drop excess while a kick runs.
    if (this.remotePlayQueueDepth > 4) {
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      if (now - this.remotePlayLoopWarnAt > 2_000) {
        this.remotePlayLoopWarnAt = now;
        logPageDisplay("messages_voice_playback_queue_storm", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          reason,
          depth: this.remotePlayQueueDepth,
          level: "error",
          note: "dropped nested playback kick — would freeze the tab",
        });
      }
      this.remotePlayQueueDepth -= 1;
      return;
    }
    this.remotePlayChain = this.remotePlayChain
      .then(() => this.ensureRemotePlaybackInternal(reason))
      .catch(() => undefined)
      .finally(() => {
        this.remotePlayQueueDepth = Math.max(0, this.remotePlayQueueDepth - 1);
      });
  }

  private async ensureRemotePlaybackInternal(reason: string): Promise<void> {
    if (typeof document === "undefined") return;

    // Leave/dispose only — minimized dock must keep hearing the call.
    if (!this.remoteAudioEnabled) {
      this.teardownWebAudioPlayback();
      if (this.remoteAudio) {
        this.remoteAudio.muted = true;
        this.remoteAudio.pause();
      }
      return;
    }

    // Re-pull audio receivers for late/replaced tracks. Video is handled by
    // ontrack + slotted renegotiation — pulling video here only spammed
    // skip_non_slot and competed with WebAudio on the main thread.
    const pc = this.connection;
    if (pc) {
      this.pullRemoteMediaTracks(pc, { audioOnly: true });
    }

    const stream = this.remoteStream;
    if (!stream || stream.getAudioTracks().length === 0) return;

    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
    }

    const ctx = this.ensurePlaybackContext();
    if (ctx) {
      await ctx.resume().catch(() => undefined);
    }

    // Force rebuild after unmute / ICE reconnect — Chrome can keep a MediaStreamSource
    // silent if it was built while the track was still muted.
    const forceRebuild =
      reason === "track-unmute" ||
      reason === "ice-connected" ||
      reason === "pc-connected";

    // telegram-tt: WebAudio → destination is the hearable sink. A muted Audio
    // element with the same MediaStream is a Chrome WebRTC+AudioContext hack —
    // not the playback path. Unmuted HTML <audio> is fallback only.
    const webaudioOk = Boolean(
      ctx &&
        ctx.state === "running" &&
        this.rebuildWebAudioPlayback(forceRebuild),
    );
    if (webaudioOk) {
      try {
        const probe = new Audio();
        probe.muted = true;
        probe.srcObject = stream;
        probe.remove();
      } catch {
        // ignore
      }
    }

    const audio = this.ensureRemoteAudioElement();
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    if (webaudioOk) {
      // Keep muted — dual unmuted sinks steal / silence WebAudio on Chrome.
      audio.muted = true;
      audio.volume = 0;
      try {
        if (audio.paused) {
          await audio.play().catch(() => undefined);
        }
      } catch {
        // ignore
      }
      logPageDisplay("messages_voice_remote_playback_ok", {
        reason,
        sink: "webaudio",
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx?.state ?? "none",
        mutedTracks: stream.getAudioTracks().filter((t) => t.muted).length,
        level: "info",
      });
      return;
    }

    audio.muted = false;
    audio.volume = 1;
    try {
      if (audio.paused) {
        await audio.play();
      }
      logPageDisplay("messages_voice_remote_playback_ok", {
        reason,
        sink: "html_audio",
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx?.state ?? "none",
        level: "info",
      });
      return;
    } catch (err) {
      this.armGestureUnmute();
      appWarn("[voice-remote-audio]", err instanceof Error ? err.message : String(err), {
        reason,
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx?.state ?? "none",
      });
    }
  }

  private attachRemoteAudioTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    track.enabled = true;
    const stream = this.ensureRemoteStream();
    const already = stream.getAudioTracks().some((t) => t.id === track.id);
    if (!already) {
      stream.addTrack(track);
      logPageDisplay("messages_voice_remote_track", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        muted: track.muted,
        readyState: track.readyState,
        trackCount: stream.getAudioTracks().length,
        level: "info",
      });
    }
    track.onunmute = () => {
      // Ungated — silence after join_ok was common while track stayed muted until
      // the first RTP packet; without this log we could not tell unmute fired.
      logPageDisplay("messages_voice_remote_track_unmute", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        ice: this.connection?.iceConnectionState ?? "none",
        level: "info",
      });
      // Chrome can keep a MediaStreamSource silent if it was built while muted.
      // Force rebuild via playback reason — do not tear down here and race the
      // queued ensure (watchdog used to leave a gap with no sink).
      this.queueRemotePlayback("track-unmute");
    };
    track.onmute = () => {
      logPageDisplay("messages_voice_remote_track_mute", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        ice: this.connection?.iceConnectionState ?? "none",
        level: "warn",
      });
    };
    // Only for newly attached tracks. ensureRemotePlaybackInternal → pull →
    // attach used to always queue here and loop forever after join_ok.
    if (!already) {
      this.queueRemotePlayback("track-attach");
    }
  }

  /**
   * Unlock autoplay during a user gesture (Join / open strip / mic).
   * Must run synchronously in the gesture stack so later remote tracks can play.
   */
  unlockRemoteAudio(): void {
    if (typeof document === "undefined") return;
    this.ensureRemoteStream();
    const ctx = this.ensurePlaybackContext();
    void ctx?.resume().catch(() => undefined);
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.queueRemotePlayback("unlock");
  }

  /** Retry autoplay after a user gesture (mic toggle / UI click). */
  resumeRemoteAudio(): void {
    if (typeof document === "undefined") return;
    this.ensureRemoteStream();
    const ctx = this.ensurePlaybackContext();
    void ctx?.resume().catch(() => undefined);
    this.queueRemotePlayback("resume");
  }

  /**
   * Enable/disable remote playback. Keep enabled while joined (including
   * minimized dock); disable only when leaving/disposing the session.
   */
  setRemoteAudioEnabled(enabled: boolean): void {
    if (this.remoteAudioEnabled === enabled) return;
    this.remoteAudioEnabled = enabled;
    if (enabled) {
      this.queueRemotePlayback("visible");
    } else {
      this.teardownWebAudioPlayback();
      if (this.remoteAudio) {
        this.remoteAudio.muted = true;
        this.remoteAudio.pause();
      }
    }
  }

  private async joinInternal(startMuted: boolean): Promise<void> {
    if (this.joined || typeof RTCPeerConnection === "undefined") {
      return;
    }

    // Resume autoplay/silent AudioContext in the Join turn before we create the
    // outbound silence track — suspended ctx → no RTP → inboundAudio=0.
    unlockVoiceAutoplay();

    // Listen-only: always publish enabled near-silence. Join-click prefetch may
    // already own a real mic with enabled=false — using that as the PC sender
    // produced outboundPackets=0 and the SFU never unmuted the remote track.
    if (startMuted) {
      if (this.audioTrack && !this.usingSilentAudio) {
        if (
          this.audioTrack.readyState === "live" &&
          this.audioTrack !== this.prefetchedMicTrack
        ) {
          this.prefetchedMicTrack = this.audioTrack;
        }
        this.audioTrack = createSilentAudioTrack();
        this.usingSilentAudio = true;
      } else if (!this.audioTrack) {
        this.audioTrack = createSilentAudioTrack();
        this.usingSilentAudio = true;
      }
      await resumeSilentOutboundContext();
    } else {
      await this.ensureLocalMic();
    }
    const audioTrack = this.audioTrack;
    if (!audioTrack) {
      throw new Error("microphone_unavailable");
    }
    // Always keep the WebRTC sender enabled. Telegram mute is is_muted /
    // muteGroupCallParticipant — never track.enabled=false on the live sender.
    audioTrack.enabled = true;

    const localStream = new MediaStream([audioTrack]);

    // Match tweb/tgcalls: no STUN. Telegram SFU is a public host candidate;
    // extra srflx pairs confuse ICE (pairsInProgress without nomination) and
    // then Chrome consent-freshness tears the link down after a brief audio blip.
    const connection = new RTCPeerConnection({
      iceServers: [],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    connection.addTrack(audioTrack, localStream);
    // telegram-tt always attaches a black canvas video track (disabled) on join
    // so the offer carries FID ssrc-groups — required by their parseSdp and
    // matching TDLib joinVideoChat. An inactive transceiver skipped FID and
    // left a thinner SFU session that often never delivered remote audio.
    const placeholderVideo = createSilentVideoTrack();
    placeholderVideo.enabled = false;
    connection.addTrack(placeholderVideo, new MediaStream([placeholderVideo]));
    this.outboundVideoTrack = placeholderVideo;
    // Open Colibri data channel before createOffer so the offer includes SCTP
    // (mid usually 2). Screencast RTP is gated on ReceiverVideoConstraints.
    this.attachGroupCallDataChannel(connection);
    const stopJoinVideoPlaceholder = () => {
      const track = this.outboundVideoTrack;
      this.outboundVideoTrack = null;
      if (track && track.readyState === "live") {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    };

    connection.ontrack = (event) => {
      const track = event.track;
      if (!track) return;
      track.enabled = true;
      voiceDebug("[voice-ontrack]", track.kind, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        streams: event.streams.length,
        muted: track.muted,
        readyState: track.readyState,
        streamIds: event.streams.map((s) => s.id).join(","),
      });
      if (event.streams[0]) {
        for (const streamTrack of event.streams[0].getAudioTracks()) {
          streamTrack.enabled = true;
          this.attachRemoteAudioTrack(streamTrack);
        }
        for (const streamTrack of event.streams[0].getVideoTracks()) {
          streamTrack.enabled = true;
          this.attachRemoteVideoTrack(streamTrack, event.streams);
        }
      } else if (track.kind === "audio") {
        this.attachRemoteAudioTrack(track);
      } else if (track.kind === "video") {
        this.attachRemoteVideoTrack(track, event.streams);
      }
    };

    connection.oniceconnectionstatechange = () => {
      const ice = connection.iceConnectionState;
      logPageDisplay("messages_voice_pc_ice", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice,
        conn: connection.connectionState,
        remoteTracks: this.remoteStream?.getAudioTracks().length ?? 0,
        remoteMuted: (this.remoteStream?.getAudioTracks() ?? []).some((t) => t.muted),
        level: ice === "connected" || ice === "completed" ? "info" : "warn",
      });
      if (ice === "failed" || ice === "closed") {
        void this.logIceDiagnostics(connection, `ice_${ice}`);
        this.scheduleJoinLostIfStillBroken(connection, `ice_${ice}`);
        return;
      }
      if (ice === "disconnected") {
        void this.logIceDiagnostics(connection, "ice_disconnected");
        this.scheduleJoinLostIfStillBroken(connection, "ice_disconnected");
        return;
      }
      this.clearJoinLostTimer();
      if (ice === "connected" || ice === "completed") {
        this.pullRemoteMediaTracks(connection, { audioOnly: true });
        unlockVoiceAutoplay();
        void resumeSilentOutboundContext();
        this.queueRemotePlayback("ice-connected");
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      logPageDisplay("messages_voice_pc_state", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        conn: state,
        ice: connection.iceConnectionState,
        level: state === "connected" ? "info" : "warn",
      });
      if (state === "connected") {
        this.pullRemoteMediaTracks(connection, { audioOnly: true });
        unlockVoiceAutoplay();
        this.queueRemotePlayback("pc-connected");
      } else if (state === "failed" || state === "disconnected") {
        this.scheduleJoinLostIfStillBroken(connection, `pc_${state}`);
      }
    };

    // Yield so dialog Close / Escape handlers can run before SDP blocks the main thread.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 32);
      });
    });

    const offer = await connection.createOffer({
      offerToReceiveAudio: true,
      // telegram-tt always offers to receive video on group join.
      offerToReceiveVideo: true,
    });
    // Yield after createOffer — it is the heaviest sync chunk and used to freeze
    // Close for hundreds of ms when Join armed in the same turn as open.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.setTimeout(resolve, 32);
    });
    await connection.setLocalDescription(offer);
    await disableAudioSenderDtx(connection);
    // Yield after setLocalDescription — ICE candidate work otherwise stacks into
    // one longtask and freezes dialog Close for the whole gather window.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.setTimeout(resolve, 32);
    });
    if (!offer.sdp) {
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error("offer_sdp_missing");
    }

    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") {
        resolve();
        return;
      }
      // Listen joins only need a host candidate for the SFU — long gather windows
      // stacked under createOffer and made Join feel frozen before join_ok.
      const gatherBudgetMs = startMuted ? 600 : 1_800;
      const timeout = window.setTimeout(() => {
        connection.removeEventListener("icegatheringstatechange", onGather);
        resolve();
      }, gatherBudgetMs);
      const onGather = () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          connection.removeEventListener("icegatheringstatechange", onGather);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", onGather);
    });

    const localSdp = connection.localDescription?.sdp ?? offer.sdp;
    const localCandidateCount = (localSdp.match(/a=candidate:/g) ?? []).length;
    voiceDebug("[voice-ice-local]", "gathered", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      candidateCount: localCandidateCount,
      iceGather: connection.iceGatheringState,
      hostCount: (localSdp.match(/ typ host /g) ?? []).length,
      srflxCount: (localSdp.match(/ typ srflx /g) ?? []).length,
    });
    const parsed = parseGroupCallOfferSdp(localSdp);
    const joinPayloadJson = buildGroupCallJoinPayloadJson(parsed);
    if (!joinPayloadJson || parsed.source == null) {
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error("join_payload_build_failed");
    }

    const joinResult = await joinTelegramChatVoice({
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      payload: joinPayloadJson,
      // Join unmuted on the SFU so mixed inbound audio is routed immediately.
      // Listen-only still publishes near-silent RTP locally; Telegram mute is
      // signaled right after SDP apply (is_muted / toggleGroupCallParticipant).
      isMuted: false,
    });
    if (!joinResult.ok) {
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error(joinResult.error);
    }

    let transportRoot: { stream?: boolean } | null = null;
    try {
      transportRoot = JSON.parse(joinResult.join_payload) as { stream?: boolean };
    } catch {
      transportRoot = null;
    }
    if (transportRoot?.stream) {
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error("voice_stream_mode_unsupported");
    }

    const joinParsed = parseGroupCallJoinTransport(joinResult.join_payload);
    if (!joinParsed) {
      appWarn("[voice-join-transport]", "join_transport_invalid", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        payloadBytes: joinResult.join_payload.length,
        payloadPrefix: joinResult.join_payload.slice(0, 80),
      });
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error("join_transport_invalid");
    }
    const transport = joinParsed.transport;
    this.videoPayloadTypes = joinParsed.videoPayloadTypes;
    this.videoExtensions = joinParsed.videoExtensions;
    // Prefer all IPv4 SFU candidates (telegram-tt). Soft-cap only huge lists.
    const slimTransport = {
      ...transport,
      candidates: pickJoinAnswerCandidates(transport.candidates),
    };
    logPageDisplay("messages_voice_join_transport", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      candidateCount: slimTransport.candidates.length,
      rawCandidateCount: transport.candidates.length,
      fingerprintCount: transport.fingerprints.length,
      videoCodecs: this.videoPayloadTypes.map((p) => `${p.id}:${p.name}`).slice(0, 12),
      videoCodecCount: this.videoPayloadTypes.length,
      candidateIps: slimTransport.candidates
        .slice(0, 8)
        .map((c) => `${c.ip}:${c.port}/${c.type}`)
        .join(","),
      level: "info",
    });
    voiceDebug("[voice-dtls]", "roles", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      offerSetup: parsed.setup,
      joinSetup: "passive",
      answerSetup: groupCallAnswerDtlsSetup(localSdp),
    });
    voiceDebug("[voice-join-transport]", "ok", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      candidateCount: slimTransport.candidates.length,
      fingerprintCount: transport.fingerprints.length,
      answerDtlsSetup: groupCallAnswerDtlsSetup(localSdp),
      candidateIps: slimTransport.candidates.map((c) => `${c.ip}:${c.port}/${c.type}`).join(","),
    });

    // Apply answer before returning join_ok (see await applyAnswer below).
    // Mark session joined first so ontrack during SRD can attach playback.
    this.connection = connection;
    this.localStream = localStream;
    this.audioTrack = audioTrack;
    this.audioSourceId = parsed.source;
    this.lastTransport = slimTransport;
    this.joined = true;
    this.micEnabled = !startMuted;

    const isWebDriver =
      typeof navigator !== "undefined" &&
      Boolean((navigator as { webdriver?: boolean }).webdriver);
    if (isWebDriver) {
      // Live PeerConnection after setLocalDescription deadlocks headless
      // Chromium (heartbeat stops at join_ok). Tear it down before returning
      // so dialog UI tests can exercise Open/Close; real browsers keep media.
      appWarn("[voice-sdp-answer]", "skip_webdriver_close_pc", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
      });
      try {
        connection.close();
      } catch {
        // ignore
      }
      this.connection = null;
    }

    const answerSdp = groupCallAnswerSdpFromTransport(slimTransport, localSdp, [], {
      // Full sendrecv video answer — minimal recvonly starved mixed audio demux.
      minimalVideo: false,
      videoPayloadTypes: this.videoPayloadTypes,
      videoExtensions: this.videoExtensions,
    });
    const applyAnswer = async () => {
      if (isWebDriver) return;
      if (this.connection !== connection || !this.joined) {
        logPageDisplay("messages_voice_sdp_answer_skip_stale", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          hasConnection: this.connection === connection,
          joined: this.joined,
          level: "warn",
        });
        return;
      }
      // Skip only when no open sheet. Checking for any "closed" node was wrong:
      // the portal stays mounted with data-voice-dialog="closed" after Close, and
      // remounts can briefly leave a closed sibling while the live sheet is open —
      // that skipped setRemoteDescription forever (join_ok, no audio).
      const sheetOpen =
        typeof document === "undefined" ||
        Boolean(document.querySelector('[data-voice-dialog="open"]'));
      if (!sheetOpen) {
        logPageDisplay("messages_voice_sdp_answer_skip_sheet_closed", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          level: "warn",
        });
        this.markJoinLost("sdp_skipped_sheet_closed");
        return;
      }
      try {
        logPageDisplay("messages_voice_sdp_answer_apply_start", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          sdpBytes: answerSdp.length,
          candidates: slimTransport.candidates.length,
          minimalVideo: false,
          level: "info",
        });
        // Yield once more immediately before the sync Chromium wedge.
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        });
        if (this.connection !== connection || !this.joined) return;
        await connection.setRemoteDescription({
          type: "answer",
          sdp: answerSdp,
        });
        logPageDisplay("messages_voice_sdp_answer_apply_ok", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          dataChannel: this.dataChannel?.readyState ?? "missing",
          hasApplication: parseOfferMediaSections(answerSdp).some(
            (s) => s.kind === "application",
          ),
          level: "info",
        });
        this.sendReceiverVideoConstraints();
        await disableAudioSenderDtx(connection);
        if (startMuted) {
          // Defer TDLib mute until inbound RTP starts (or a short settle). Muting
          // in the same turn as setRemoteDescription left inboundPackets=0 /
          // remoteMuted forever on some SFU joins while outbound silence still
          // flowed.
          const applyListenMute = async () => {
            if (this.connection !== connection || !this.joined) return;
            const muteResult = await setTelegramChatVoiceMicMuted({
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              isMuted: true,
            });
            if (!muteResult.ok) {
              appWarn("[voice-join-mute]", muteResult.error, {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                note: "listen-only post-join mute failed — inbound may still work",
              });
            } else {
              logPageDisplay("messages_voice_join_listen_muted", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                level: "info",
              });
            }
          };
          const waitForInboundOrTimeout = () =>
            new Promise<void>((resolve) => {
              const tracks = this.remoteStream?.getAudioTracks() ?? [];
              if (tracks.some((t) => !t.muted)) {
                resolve();
                return;
              }
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                for (const track of tracks) {
                  track.removeEventListener("unmute", onUnmute);
                }
                window.clearTimeout(timer);
                resolve();
              };
              const onUnmute = () => finish();
              for (const track of tracks) {
                track.addEventListener("unmute", onUnmute);
              }
              const timer = window.setTimeout(finish, 2_800);
            });
          void waitForInboundOrTimeout().then(() => applyListenMute());
        }
      } catch (err) {
        logPageDisplay("messages_voice_sdp_answer_apply_fail", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          error: err instanceof Error ? err.message : String(err),
          level: "warn",
        });
        appWarn(
          "[voice-sdp-answer]",
          err instanceof Error ? err.message : String(err),
          { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
        );
        return;
      }
      if (this.connection !== connection || !this.joined) return;
      // Start playback in this turn (shared AudioContext already resumed on Join
      // gesture). Deferring with setTimeout(0) lost the gesture for HTML audio
      // and raced React roster work. telegram-tt wires WebAudio immediately on
      // ontrack; we kick both sinks here and again from ontrack/ICE.
      if (!this.usingSilentAudio) {
        this.startSpeakingMonitor();
      }
      // Re-unlock in case the Join gesture's AudioContext suspended during SDP.
      unlockVoiceAutoplay();
      this.resumeRemoteAudio();
      this.armGestureUnmute();
      this.startPlaybackWatchdog(connection);
      // Ungated — silence after apply_ok was invisible when voiceDebug was off.
      logPageDisplay("messages_voice_playback_kick", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        remoteTracks: this.remoteStream?.getAudioTracks().length ?? 0,
        ice: connection.iceConnectionState,
        conn: connection.connectionState,
        remoteAudioEnabled: this.remoteAudioEnabled,
        level: "info",
      });
      // Video renegotiation stays deferred — full publisher SDP can freeze Close.
      // Retry a few times: React often sets requests after join_ok, and a failed
      // first renegotiate used to stamp lastApplied and never retry.
      if (typeof window !== "undefined") {
        const kickRemoteVideo = (delayMs: number) => {
          window.setTimeout(() => {
            if (this.connection !== connection || !this.joined) return;
            if (this.requestedRemoteVideo.length === 0) return;
            const key = this.remoteVideoKeyOf(this.requestedRemoteVideo);
            // Do NOT clear lastApplied — that force-renegotiated at 1.2/3/5.5s
            // and kept inboundVideoPackets=0 while Сева was already sharing.
            if (key && key === this.lastAppliedRemoteVideoKey) {
              this.sendReceiverVideoConstraints();
              return;
            }
            this.queueRemoteVideoRenegotiation();
          }, delayMs);
        };
        // Do not kick at 0ms — video renegotiate while DTLS connecting
        // correlated with inboundAudio=0. queueRemoteVideoRenegotiation waits
        // for PC connected; schedule after ICE has had time to finish.
        kickRemoteVideo(1_200);
        kickRemoteVideo(3_000);
        kickRemoteVideo(5_500);
      }
    };

    // Apply the answer BEFORE returning to React. Deferring past join_ok left the
    // timer unable to run when the main thread was already wedged, and logs died
    // at session_joined_commit with no apply_start. Minimal listen SDP keeps this
    // short enough that Close stays usable.
    logPageDisplay("messages_voice_sdp_answer_scheduled", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      sdpBytes: answerSdp.length,
      candidates: slimTransport.candidates.length,
      minimalVideo: false,
      level: "info",
    });
    if (!isWebDriver) {
      await applyAnswer();
    }

    // Yield so Close/Escape can run before React processes webrtc_join_ok and
    // stacks roster/force-reload work on the same frame as SDP apply.
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(resolve, 0);
      });
    });

    const joinChatId = this.input.chatId;
    const joinCallId = this.input.groupCallId;
    // Surface ICE health after apply — silence with apply_ok usually means the
    // wrong candidate set or consent failure (logs used to stop at join_ok).
    const logPostApply = (label: string, delayMs: number) => {
      window.setTimeout(() => {
        if (!this.joined || this.connection !== connection) return;
        const tracks = this.remoteStream?.getAudioTracks() ?? [];
        void this.logIceDiagnostics(connection, label).then((stats) => {
          logPageDisplay("messages_voice_ice_post_apply", {
            chatId: joinChatId,
            groupCallId: joinCallId,
            label,
            ice: connection.iceConnectionState,
            conn: connection.connectionState,
            mediaConnected: this.isMediaConnected(),
            remoteTracks: tracks.length,
            remoteMuted: tracks.some((t) => t.muted),
            inboundPackets: stats.inboundPackets,
            inboundVideoPackets: stats.inboundVideoPackets,
            level: this.isMediaConnected() && !tracks.some((t) => t.muted)
              ? "info"
              : "warn",
          });
          // No inbound RTP after ICE is up — refresh silent sender + DTX kill so
          // the SFU starts forwarding the mix (classic listen-only stall).
          if (
            this.isMediaConnected() &&
            stats.inboundPackets === 0 &&
            this.usingSilentAudio
          ) {
            void (async () => {
              await resumeSilentOutboundContext();
              await disableAudioSenderDtx(connection);
              if (this.connection !== connection || !this.joined) return;
              const fresh = createSilentAudioTrack();
              fresh.enabled = true;
              const sender = connection
                .getSenders()
                .find((s) => s.track?.kind === "audio");
              if (sender) {
                try {
                  await sender.replaceTrack(fresh);
                  const previous = this.audioTrack;
                  this.audioTrack = fresh;
                  this.silentOutboundTrack = fresh;
                  if (previous && previous !== fresh) {
                    try {
                      previous.stop();
                    } catch {
                      // ignore
                    }
                  }
                  logPageDisplay("messages_voice_silent_sender_refresh", {
                    chatId: joinChatId,
                    groupCallId: joinCallId,
                    label,
                    level: "warn",
                  });
                } catch {
                  try {
                    fresh.stop();
                  } catch {
                    // ignore
                  }
                }
              }
            })();
          }
          if (
            this.requestedRemoteVideo.length > 0 &&
            stats.inboundVideoPackets === 0 &&
            this.remoteVideoPacketRetries < 3
          ) {
            this.remoteVideoPacketRetries += 1;
            this.sendReceiverVideoConstraints();
          }
        });
        // Still muted while ICE checks — rebuild sinks in case WebAudio latched
        // onto a silent muted track (common Chrome quirk).
        if (tracks.some((t) => t.muted) || !this.isMediaConnected()) {
          unlockVoiceAutoplay();
          void resumeSilentOutboundContext();
          this.teardownWebAudioPlayback();
          this.queueRemotePlayback(`post_apply_${label}`);
        }
      }, delayMs);
    };
    logPostApply("post_apply_800ms", 800);
    logPostApply("post_apply_2s", 2_000);
    // Do NOT markJoinLost on a slow ICE check — tearing down and auto-rejoining
    // every ~20s freezes the whole app. Log only; scheduleJoinLostIfStillBroken
    // still handles failed/closed.
    window.setTimeout(() => {
      if (!this.joined || this.connection !== connection) return;
      if (this.isMediaConnected()) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      if (ice === "checking" || ice === "new" || conn === "connecting") {
        appWarn("[voice-join-timeout]", "ice_still_pending", {
          chatId: joinChatId,
          groupCallId: joinCallId,
          ice,
          conn,
        });
      }
    }, 20_000);
  }

  /** Keep WebAudio (or HTML fallback) alive while ICE stays up. */
  private startPlaybackWatchdog(connection: RTCPeerConnection): void {
    this.clearPlaybackWatchdog();
    this.playbackWatchdog = window.setInterval(() => {
      if (this.connection !== connection || !this.joined) {
        this.clearPlaybackWatchdog();
        return;
      }
      if (!this.remoteAudioEnabled) return;
      // Tracks often arrive while ICE is still "checking" — don't wait for
      // connected or we never kick WebAudio/HTML after apply_ok silence.
      const ice = connection.iceConnectionState;
      if (
        ice === "failed" ||
        ice === "closed" ||
        ice === "disconnected"
      ) {
        return;
      }
      const audio = this.remoteAudio;
      const tracks = this.remoteStream?.getAudioTracks() ?? [];
      const hasTracks = tracks.length > 0;
      const anyMuted = tracks.some((t) => t.muted);
      const ctx = this.playbackCtx;
      const webAudioLive =
        Boolean(this.playbackSource) && Boolean(ctx && ctx.state === "running");
      const htmlLive =
        Boolean(audio) &&
        !audio!.paused &&
        Boolean(audio!.srcObject) &&
        audio!.readyState >= 2 &&
        !audio!.muted;
      // WebAudio alone is healthy (telegram-tt). Requiring unmuted HTML play()
      // used to rebuild the graph every 2s → silence while RTP still flowed.
      if (hasTracks && !anyMuted && (webAudioLive || htmlLive)) {
        return;
      }
      if (!hasTracks && !this.isMediaConnected()) {
        this.pullRemoteMediaTracks(connection, { audioOnly: true });
      }
      if (anyMuted || !webAudioLive) {
        logPageDisplay("messages_voice_playback_watchdog", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          ice,
          conn: connection.connectionState,
          remoteTracks: tracks.length,
          remoteMuted: anyMuted,
          webAudioLive,
          htmlLive,
          audioPaused: audio?.paused ?? true,
          level: "warn",
        });
      }
      this.queueRemotePlayback("watchdog");
    }, 2_000);
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog != null) {
      window.clearInterval(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
  }

  dispose(): void {
    this.stopSpeakingMonitor();
    this.clearPlaybackWatchdog();
    this.clearJoinLostTimer();
    this.clearVideoRenegotiateConnectWait();
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.teardownWebAudioPlayback();
    if (this.playbackCtx && this.playbackCtx !== getVoiceAutoplayAudioContext()) {
      void this.playbackCtx.close().catch(() => undefined);
    }
    this.playbackCtx = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteStream = null;
    this.clearRemoteVideoStream();
    this.videoListeners.clear();
    this.remoteVideoSourceListeners.clear();
    this.lastTransport = null;
    this.videoPayloadTypes = [];
    this.videoExtensions = [];
    this.dataChannel = null;
    this.videoRecvSlots = [];
    this.requestedRemoteVideo = [];
    this.lastAppliedRemoteVideoKey = "";
    this.lastAppliedRemoteVideoEndpoints = [];
    this.remoteAudioEnabled = false;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.prefetchedMicTrack) {
      this.prefetchedMicTrack.stop();
      this.prefetchedMicTrack = null;
    }
    const silentOutbound = this.silentOutboundTrack;
    this.silentOutboundTrack = null;
    if (silentOutbound && silentOutbound !== this.audioTrack) {
      silentOutbound.stop();
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    this.stopLocalVideoCaptures();
    this.teardownPresentationConnection();
    this.outboundVideoTrack = null;
    this.audioSourceId = null;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.joined = false;
    this.micEnabled = false;
    this.micPrefetch = null;
    this.speakingListeners.clear();
    this.localMediaListeners.clear();
  }
}
