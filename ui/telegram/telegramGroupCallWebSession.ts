import { appWarn } from "../../shared/appLog";
import {
  buildGroupCallJoinPayloadJson,
  groupCallAnswerDtlsSetup,
  groupCallAnswerSdpFromTransport,
  groupCallRemoteSubscribeOfferSdp,
  parseGroupCallJoinTransport,
  parseGroupCallOfferSdp,
  parseOfferMediaSections,
  type TelegramGroupCallCandidate,
  type TelegramGroupCallPayloadType,
  type TelegramGroupCallRemoteVideoSection,
  type TelegramGroupCallRtpExtension,
  type TelegramGroupCallTransport,
} from "../../shared/telegramGroupCallSdp";

/**
 * Match telegram-tt / tgcalls Full quality rungs (180 / 360 / 720 only).
 * Non-standard heights (e.g. 480) leave Colibri without a simulcast layer match —
 * prod forwarded 1080p at ~1fps so the stage looked frozen while currentTime ticked.
 */
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

/** Normalize getDisplayMedia failures into stable error codes for UI copy. */
function mapDisplayMediaError(err: unknown): Error {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name ?? "")
      : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (
    name === "NotSupportedError" ||
    /not supported/i.test(message)
  ) {
    return new Error("screen_share_unsupported");
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return new Error("screen_share_denied");
  }
  if (name === "AbortError") {
    return new Error("screen_share_cancelled");
  }
  if (name === "NotFoundError") {
    return new Error("screen_share_unavailable");
  }
  if (err instanceof Error && err.message) {
    return err;
  }
  return new Error("screen_share_failed");
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

/**
 * Drop local ICE candidates Chrome gathers on Docker/WSL/Hyper-V bridges and
 * link-local ranges. Those pairs often win briefly then fail consent freshness
 * (prod: pairsSucceeded→0, ice_disconnected, join lost while mix was hearable).
 */
function stripUnusableLocalIceCandidates(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  let dropped = 0;
  const kept = lines.filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    // a=candidate:<foundation> <component> <proto> <priority> <ip> <port> typ ...
    const parts = line.split(/\s+/);
    const ip = parts[4] ?? "";
    if (!ip || ip.includes(":")) {
      // Keep IPv6 for now — pickJoinAnswerCandidates already prefers IPv4 on the SFU side.
      return true;
    }
    if (ip.startsWith("169.254.")) {
      dropped += 1;
      return false;
    }
    // RFC1918 docker/hyper-v style bridges commonly seen as 172.16–31.x (esp. 172.18.0.1).
    const m = /^172\.(\d+)\./.exec(ip);
    if (m) {
      const second = Number(m[1]);
      if (second >= 16 && second <= 31) {
        dropped += 1;
        return false;
      }
    }
    return true;
  });
  if (dropped === 0) return sdp;
  const out = kept.join("\r\n");
  // Preserve trailing newline shape if the original had one.
  return sdp.endsWith("\n") && !out.endsWith("\n") ? `${out}\r\n` : out;
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
 * Near-inaudible bed for listen-only RTP. Dedicated AudioContext already fixed
 * outboundPackets=0 — do NOT use mid-range tones / high gain (audible beep in
 * the call mix). 20 Hz + tiny gain stays under hearing for most setups while
 * still defeating Opus DTX when usedtx is off in SDP.
 */
/** Slightly above DTX floor — 0.0015 left outboundPackets=0 on some Chrome builds. */
const SILENT_OUTBOUND_GAIN = 0.008;

function createSilentAudioTrack(): MediaStreamTrack {
  if (typeof AudioContext === "undefined") {
    throw new Error("silent_audio_unavailable");
  }
  // Dedicated outbound context — sharing the unlock/playback AudioContext with a
  // MediaStreamDestination left outboundPackets=0 while inbound eventually unmuted
  // (Chrome stalls RTP from the shared graph under dialog load).
  unlockVoiceAutoplay();
  const unlocked = getVoiceAutoplayAudioContext();
  if (unlocked && unlocked.state === "suspended") {
    void unlocked.resume().catch(() => undefined);
  }
  if (!sharedSilentAudioCtx || sharedSilentAudioCtx.state === "closed") {
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
  // Never connect to ctx.destination — that would beep into local speakers.
  gain.connect(dest);
  oscillator.start();
  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    try {
      oscillator.stop();
    } catch {
      // ignore
    }
    throw new Error("silent_audio_track_failed");
  }
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    try {
      oscillator.stop();
    } catch {
      // already stopped
    }
    // Keep sharedSilentAudioCtx open — reused across mute toggles / silent refreshes.
    stopTrack();
  };
  // Keep enabled so the transceiver stays live and the SFU can deliver remote audio.
  // Telegram mute is signaled separately via is_muted / muteGroupCallParticipant.
  track.enabled = true;
  logPageDisplay("messages_voice_silent_track", {
    ctxState: ctx.state,
    sampleRate: ctx.sampleRate,
    gain: SILENT_OUTBOUND_GAIN,
    freqHz: 20,
    reusedUnlockCtx: false,
    dedicatedSilentCtx: true,
    unlockCtxState: unlocked?.state ?? "none",
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
  /** In-dialog stage size (UI only) — encode quality stays full-resolution. */
  private screenShareDisplaySize = { width: 1920, height: 1080 };
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
  /** Join answer SDP — preferred audio template for first video remote_offer. */
  private joinAnswerSdp: string | null = null;
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
  /** True once mixed audio unmuted *and* settle timer fired — then video SDP is safe. */
  private remoteAudioSettledForVideo = false;
  /**
   * True once the post-unmute settle timer is armed. Roster / setRequestedRemoteVideos
   * churn must not clear+restart that timer — that made screencast "lazy" for many
   * seconds (or forever while SSE kept updating).
   */
  private remoteAudioSettleArmed = false;
  /** One extra settle delay when mix RTP is still thin before first video SDP. */
  private remoteAudioSettleExtended = false;
  /** Inbound mix packets when the first settle extend armed (detect regression). */
  private remoteAudioSettlePacketsAtExtend = 0;
  /** Extra settle retries before allowing screen SDP despite a quiet meter. */
  private remoteAudioSettleRetryCount = 0;
  private pendingVideoRenegotiateOnAudio: ReturnType<typeof setTimeout> | null =
    null;
  /** After video SDP freezes mix RTP, skip further full renegotiates (constraints only). */
  private remoteAudioStalledAfterVideo = false;
  /** Soft/deferred recover already ran; cleared when we re-open video after healthy audio. */
  private audioRecoverAfterVideoDone = false;
  private audioRecoverInFlight = false;
  /** Cap audio-only rejoins so a flapping mix cannot loop forever. */
  private audioRecoverCount = 0;
  private static readonly MAX_AUDIO_RECOVERS = 2;
  /** ICE consent death → silent rejoin (separate budget from video-stall recover). */
  private iceRecoverInFlight = false;
  private iceRecoverCount = 0;
  private static readonly MAX_ICE_RECOVERS = 2;
  /**
   * Screencast painted this join. After the *first* audio-only recover, refuse
   * further recovers while this is set — recover↔resubscribe flickered the
   * stage on/off. The first recover is still allowed with a live screen because
   * sink heal cannot unfreeze a dead mix m-line (inboundPackets stuck, rms=0).
   */
  private preferStableScreencast = false;
  /** Wall clock when the last full remote-video renegotiate succeeded (soft-stall watch). */
  private postVideoRenegotiateAt = 0;
  /** Consecutive near-zero RMS samples after {@link postVideoRenegotiateAt}. */
  private postVideoSilenceTicks = 0;
  /**
   * Soft-silence + live screen path is checking whether mix RTP is still growing.
   * Prevents re-entry / permanent disarm while the async probe runs.
   */
  private softSilentVideoCheckInFlight = false;
  /**
   * Full remote video SDP (extra m-lines / remote_offer) can freeze the mixed
   * audio m-line on Colibri. Off until roster screen requests arrive (or
   * {@link setRemoteVideoSdpEnabled}); sticky-blocked after a stall recover so
   * VoiceBar cannot re-open the gate for the rest of this join.
   */
  private remoteVideoSdpSubscribeEnabled = false;
  /** Sticky after mix RTP died on video SDP; stays set for the rest of this join. */
  private remoteVideoSdpBlockedAfterStall = false;
  private videoResubscribeAfterRecoverTimer: ReturnType<typeof setTimeout> | null =
    null;
  private videoResubscribeAfterRecoverAttempts = 0;
  /** Screen/camera requests to restore after audio-only recover (needs full ssrcGroups). */
  private pendingRemoteVideoAfterRecover: TelegramRemoteVideoRequest[] = [];
  private playbackCtx: AudioContext | null = null;
  private playbackSource: MediaStreamAudioSourceNode | null = null;
  /** Per-listener volume gain between remote mix and speakers (0–2 for 0–200%). */
  private playbackGain: GainNode | null = null;
  /** Last applied listen gain (linear). */
  private playbackGainValue = 1;
  /**
   * Participant listen volumes (0–200%) keyed like the roster prefs map.
   * SFU audio is a single mix — we approximate by ducking the master gain from
   * speaking participants' volumes (telegram-tt uses per-track GainNodes).
   */
  private listenVolumes = new Map<string, number>();
  private listenSpeakingKeys = new Set<string>();
  private listenParticipantKeys: string[] = [];
  /** Track-id key for the live WebAudio MediaStreamSource — skip no-op rebuilds. */
  private playbackTrackKey = "";
  /** Rate-limit join-placeholder video skip logs (pull/watchdog used to spam). */
  private remoteVideoSkipLogAt = 0;
  private remoteVideoSkipLogTrackId = "";
  /** Low-FPS stage heal: last framesDecoded sample from getStats. */
  private lastVideoFramesDecoded = 0;
  private lastVideoFpsCheckAt = 0;
  private videoLowFpsConstraintRetries = 0;
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
  /** Mixed remote audio activity — TDLib speakingCount often stays 0 for listeners. */
  private remoteSpeaking = false;
  private remoteSpeakingListeners = new Set<(speaking: boolean) => void>();
  private remoteSpeakingRaf: number | null = null;
  private remoteSpeakingTimer: ReturnType<typeof setInterval> | null = null;
  private remoteSpeakingAnalyser: AnalyserNode | null = null;
  private remoteSpeakingSource: MediaStreamAudioSourceNode | null = null;
  /** Cloned from the live remote track so HTML <audio> playback cannot starve the meter. */
  private remoteSpeakingTrack: MediaStreamTrack | null = null;
  /** Consecutive low-RMS samples while unmuted — triggers HTML-audio fallback. */
  private remoteSilenceTicks = 0;
  /**
   * Once the mix has produced real energy this join, treat later RMS=0 as a
   * normal pause — flipping WebAudio→HTML then kills hearable audio.
   */
  private heardRemoteMixAudio = false;
  /** Wall clock of last hearable mix energy (meter or speaking). */
  private lastHeardMixAudioAt = 0;
  /** Document visibility → playback rebuild after background tab mute. */
  private visibilityPlaybackCleanup: (() => void) | null = null;
  /**
   * Inbound Opus RTP is flowing (bytes/packets) even if the WebAudio meter is
   * latched at RMS=0 — used to open the video settle gate and trigger heal.
   */
  private mixRtpPacketsAlive = false;
  /**
   * Peak inbound mix packets this PeerConnection. Video renegotiate often
   * resets the counter to a trickle (prod: 42→2) while the session already
   * proved the mix was healthy — stall detectors must not use only the
   * pre-renegotiate snapshot.
   */
  private peakInboundAudioPackets = 0;
  /** Wall clock when the remote mix track last unmuted. */
  private remoteAudioUnmutedAt = 0;
  private silentMixHealInFlight = false;
  private silentMixHealCount = 0;
  private static readonly MAX_SILENT_MIX_HEALS = 4;
  /** Sustained silence after we once heard the mix (conversation pause vs dead sink). */
  private static readonly POST_HEARD_SILENCE_MS = 2_500;
  private static readonly POST_HEARD_SILENCE_TICKS = 30;
  /** Prefer a dedicated AudioContext after a silent-mix heal (shared unlock can latch). */
  private preferDedicatedPlaybackCtx = false;
  /**
   * Prefer unmuted HTML <audio> for remote mix. WebAudio MediaStreamSource often
   * latches RMS=0 on Telegram SFU comfort-noise for seconds (prod: silent_mix_heal
   * while RTP grows). HTML is hearable immediately after track unmute.
   */
  private preferHtmlRemotePlayback = true;
  private remotePlaybackSink: "webaudio" | "html_audio" = "html_audio";
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
   * When true, roster video requests may renegotiate SDP (risks killing mix
   * audio). Default false until screen requests arrive; blocked for the rest
   * of the join after a stall recover (auto-resubscribe re-froze mix audio).
   */
  /**
   * Explicit screen unmute must not wait for RMS "speaking". Quiet mixes often
   * stay under ON_RMS forever (prod: rms≈0.005) so unmute never opened video SDP.
   * Media-connected + mix RTP is enough; stall sticky blocks still apply.
   */
  private canArmExplicitRemoteVideoSdp(): boolean {
    if (this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo) {
      return false;
    }
    if (!this.joined) return false;
    if (this.isMediaConnected()) return true;
    if (this.mixRtpPacketsAlive || this.heardRemoteMixAudio) return true;
    return false;
  }

  /**
   * User unmuted a screencast in the participant menu (or started local share
   * while remotes are publishing). Clears a prior stall sticky-block once and
   * arms video SDP if mix is ready.
   */
  preferExplicitRemoteVideoSubscribe(): void {
    if (this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo) {
      this.remoteVideoSdpBlockedAfterStall = false;
      this.remoteAudioStalledAfterVideo = false;
      this.preferStableScreencast = true;
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: this.remoteVideoSdpSubscribeEnabled,
        requested: this.requestedRemoteVideo.length,
        level: "info",
        note: "explicit unmute cleared sticky video SDP block",
      });
    }
    const restore =
      this.requestedRemoteVideo.length > 0
        ? this.requestedRemoteVideo
        : this.pendingRemoteVideoAfterRecover;
    if (
      restore.length > 0 &&
      !this.remoteVideoSdpSubscribeEnabled &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      this.setRemoteVideoSdpEnabled(true);
    }
    if (
      this.pendingRemoteVideoAfterRecover.length > 0 &&
      this.requestedRemoteVideo.length === 0 &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      const pending = this.pendingRemoteVideoAfterRecover;
      this.pendingRemoteVideoAfterRecover = [];
      this.setRequestedRemoteVideos(pending);
    } else if (
      this.requestedRemoteVideo.length > 0 &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      this.queueRemoteVideoRenegotiation();
    }
  }

  setRemoteVideoSdpEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (
      next &&
      (this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo)
    ) {
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: false,
        requested: this.requestedRemoteVideo.length,
        level: "warn",
        note: "refuse video SDP — mix stalled earlier this join; audio-only",
      });
      return;
    }
    if (next === this.remoteVideoSdpSubscribeEnabled) return;
    this.remoteVideoSdpSubscribeEnabled = next;
    logPageDisplay("messages_voice_remote_video_sdp_gate", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      enabled: next,
      requested: this.requestedRemoteVideo.length,
      level: "info",
      note: next
        ? "video SDP subscribe allowed — may stall mix audio"
        : "video SDP blocked — audio-only join",
    });
    if (
      next &&
      this.joined &&
      this.requestedRemoteVideo.length > 0 &&
      !this.remoteAudioStalledAfterVideo
    ) {
      this.lastAppliedRemoteVideoKey = "";
      this.queueRemoteVideoRenegotiation();
    }
  }

  /**
   * Ask the SFU to deliver the given participant videos. Triggers a WebRTC
   * renegotiation that declares each publisher's SSRC groups in the answer
   * only when {@link setRemoteVideoSdpEnabled} is true.
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
    const nextKey = this.remoteVideoKeyOf(normalized);
    const prevKey = this.remoteVideoKeyOf(this.requestedRemoteVideo);
    // Identical request while settle/renegotiate is pending — do not re-queue
    // (re-queue restarted the audio-settle timer and delayed the screencast).
    if (nextKey === prevKey) {
      if (
        normalized.length > 0 &&
        !this.remoteVideoSdpSubscribeEnabled &&
        this.canArmExplicitRemoteVideoSdp()
      ) {
        this.setRemoteVideoSdpEnabled(true);
      } else if (nextKey === this.lastAppliedRemoteVideoKey && normalized.length > 0) {
        this.sendReceiverVideoConstraints();
      }
      return;
    }
    // During audio-only recover the stage briefly empties; VoiceBar may send [].
    // Do not drop maps / SSRC groups — pending resubscribe needs them.
    if (
      normalized.length === 0 &&
      this.requestedRemoteVideo.length > 0 &&
      (this.remoteVideoSdpBlockedAfterStall ||
        this.remoteAudioStalledAfterVideo ||
        this.audioRecoverInFlight)
    ) {
      if (this.pendingRemoteVideoAfterRecover.length === 0) {
        this.pendingRemoteVideoAfterRecover = this.requestedRemoteVideo.map(
          (r) => ({
            endpointId: r.endpointId,
            kind: r.kind,
            ssrcGroups: r.ssrcGroups.map((g) => ({
              semantics: g.semantics,
              sourceIds: [...g.sourceIds],
            })),
          }),
        );
      }
      logPageDisplay("messages_voice_remote_video_clear_ignored_during_recover", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        pending: this.pendingRemoteVideoAfterRecover.length,
        cleared: this.requestedRemoteVideo.map((r) => r.endpointId),
        level: "warn",
        note: "ignore empty screen clear while audio recover holds video SDP",
      });
      return;
    }
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
    const prevRequested = this.requestedRemoteVideo;
    this.requestedRemoteVideo = normalized;
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners();
    // Roster screen requests opt into video SDP once media is connected.
    // Do NOT require currently-hot RMS speaking — quiet shares never crossed
    // ON_RMS and explicit unmute stayed stuck on constraints-only forever.
    if (
      normalized.length > 0 &&
      !this.remoteVideoSdpSubscribeEnabled &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      this.setRemoteVideoSdpEnabled(true);
    } else if (
      normalized.length > 0 &&
      !this.remoteVideoSdpSubscribeEnabled &&
      !this.remoteVideoSdpBlockedAfterStall &&
      !this.remoteAudioStalledAfterVideo
    ) {
      logPageDisplay("messages_voice_remote_video_wait_hearable_mix", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        endpoints: normalized.map((r) => r.endpointId).slice(0, 4),
        heardRemoteMixAudio: this.heardRemoteMixAudio,
        remoteSpeaking: this.remoteSpeaking,
        mediaConnected: this.isMediaConnected(),
        mixRtpPacketsAlive: this.mixRtpPacketsAlive,
        level: "info",
        note: "defer video SDP until media connected / mix RTP alive",
      });
    }
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
    // Further full video SDP after mix RTP stalled — constraints only.
    // Also skip SDP when the audio-protect gate is off (default).
    // Refresh pending so post-recover resubscribe keeps current SSRC groups.
    if (
      (this.remoteAudioStalledAfterVideo ||
        this.remoteVideoSdpBlockedAfterStall ||
        !this.remoteVideoSdpSubscribeEnabled) &&
      normalized.length > 0
    ) {
      if (this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo) {
        this.pendingRemoteVideoAfterRecover = normalized.map((r) => ({
          ...r,
          ssrcGroups: r.ssrcGroups.map((g) => ({
            semantics: g.semantics,
            sourceIds: [...g.sourceIds],
          })),
        }));
      }
      {
        const prevByEndpoint = new Map(
          this.videoRecvSlots
            .filter((slot) => Boolean(slot.endpointId))
            .map((slot) => [slot.endpointId as string, slot] as const),
        );
        this.videoRecvSlots = nextEndpoints.map((endpointId) => {
          const prev = prevByEndpoint.get(endpointId);
          return {
            transceiver: prev?.transceiver ?? null,
            endpointId,
          };
        });
      }
      this.lastAppliedRemoteVideoKey = nextKey;
      this.lastAppliedRemoteVideoEndpoints = nextEndpoints;
      this.sendReceiverVideoConstraints();
      logPageDisplay("messages_voice_remote_video_skip_renegotiate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        endpoints: nextEndpoints,
        level:
          this.remoteAudioStalledAfterVideo || this.remoteVideoSdpBlockedAfterStall
            ? "warn"
            : "info",
        note: this.remoteVideoSdpBlockedAfterStall
          ? "sticky block after mix stall — constraints only; pending refreshed for resubscribe"
          : this.remoteAudioStalledAfterVideo
            ? "audio stalled after prior video SDP — constraints only"
            : "video SDP disabled — protect mix audio (constraints only)",
      });
      return;
    }
    // Clearing publishers: Colibri constraints alone — a full remote_offer with
    // sections=0 mid-call reset receivers and left inboundAudio=0 / remoteMuted
    // forever while speakers still lit up in TDLib.
    // Keep slots + lastApplied endpoints so a brief roster flicker (same camera
    // back) hits hasSlotted and skips a second full renegotiate that used to
    // rebuild from remote_offer and stall mix RTP at inboundPackets=32.
    if (normalized.length === 0 && prevRequested.length > 0) {
      this.lastAppliedRemoteVideoKey = nextKey;
      this.sendReceiverVideoConstraints();
      logPageDisplay("messages_voice_remote_video_clear_constraints_only", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        cleared: prevRequested.map((r) => r.endpointId),
        level: "info",
        note: "skip empty SDP renegotiate to protect inbound audio",
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
    try {
      // Prefer temporal smoothness for game/desktop casts. "detail" told Chromium
      // to sacrifice frame rate for sharpness (built-in browser: ~1fps frozen stage).
      if ("contentHint" in track) {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = "motion";
      }
    } catch {
      // ignore
    }
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
      this.preferStableScreencast = true;
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

  private clearVideoRenegotiateAudioWait(): void {
    if (this.pendingVideoRenegotiateOnAudio != null) {
      clearTimeout(this.pendingVideoRenegotiateOnAudio);
      this.pendingVideoRenegotiateOnAudio = null;
    }
  }

  /**
   * Arm the post-unmute settle timer once. Do NOT flip
   * `remoteAudioSettledForVideo` until the timer fires — otherwise kickRemoteVideo
   * / roster updates see the flag early and renegotiate immediately, freezing
   * inbound mix RTP (inboundPackets stuck while video floods).
   * Do NOT restart the timer on every queue — that delayed screencast forever.
   */
  private markRemoteAudioSettledForVideo(): void {
    if (!this.remoteVideoSdpSubscribeEnabled || this.remoteVideoSdpBlockedAfterStall) {
      return;
    }
    if (this.remoteAudioSettledForVideo) return;
    if (typeof window === "undefined") {
      this.remoteAudioSettledForVideo = true;
      this.remoteAudioSettleArmed = true;
      if (this.requestedRemoteVideo.length > 0 && this.joined) {
        this.queueRemoteVideoRenegotiation();
      }
      return;
    }
    // Settle already counting down — ignore roster/request churn.
    if (this.remoteAudioSettleArmed && this.pendingVideoRenegotiateOnAudio != null) {
      return;
    }
    // Convert an unmute-wait (8s) into a settle delay from this unmute (once).
    if (this.pendingVideoRenegotiateOnAudio != null) {
      clearTimeout(this.pendingVideoRenegotiateOnAudio);
      this.pendingVideoRenegotiateOnAudio = null;
    }
    // Give mix RTP time to stabilize before Colibri video m-lines. 800ms was
    // too short — screen SDP can freeze mix counters (Chrome). Soft-silent
    // probe keeps video when mix still has packets; hard recover drops screen
    // for the rest of the join (auto-resubscribe re-froze audio).
    const settleMs = this.isMediaConnected() ? 2_500 : 3_500;
    this.remoteAudioSettleArmed = true;
    logPageDisplay("messages_voice_remote_video_audio_settle", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      count: this.requestedRemoteVideo.length,
      settleMs,
      mediaConnected: this.isMediaConnected(),
      level: "info",
      note: "defer first video SDP until mixed audio RTP stays healthy",
    });
    this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
      void this.finishRemoteAudioSettleForVideo();
    }, settleMs);
  }

  /**
   * Mix is audibly alive this join — open screen SDP even when the current
   * inbound-rtp snapshot looks thin (quiet room, PC rebuild, or counter reset
   * after a prior renegotiate that made packetsRegressed=true).
   */
  private hasLiveMixAudioForVideoSettle(): boolean {
    return (
      (this.heardRemoteMixAudio || this.remoteSpeaking) &&
      (this.mixRtpPacketsAlive ||
        this.peakInboundAudioPackets >= 8 ||
        this.isRemoteAudioUnmuted())
    );
  }

  /**
   * Inbound mix packet counter has a solid floor — a brief pause in growth
   * while screencast RTP climbs is usually quiet audio, not a dead m-line.
   */
  private mixCounterLooksHealthyForScreen(inboundPackets: number): boolean {
    return (
      inboundPackets >= 15 || this.peakInboundAudioPackets >= 15
    );
  }

  /**
   * After settle delay, require a minimum inbound mix packet count before video
   * SDP — otherwise extend once. Thin mixes + immediate screen subscribe kill audio.
   */
  private async finishRemoteAudioSettleForVideo(): Promise<void> {
    this.pendingVideoRenegotiateOnAudio = null;
    if (!this.joined) {
      this.remoteAudioSettledForVideo = true;
      return;
    }
    const connection = this.connection;
    if (connection && !this.remoteAudioSettleExtended) {
      try {
        const stats = await this.logIceDiagnostics(
          connection,
          "audio_settle_gate",
        );
        if (stats.inboundPackets < 30) {
          const liveMix = this.hasLiveMixAudioForVideoSettle();
          const peakOk = this.peakInboundAudioPackets >= 8;
          if (liveMix && (stats.inboundPackets >= 8 || peakOk)) {
            // fall through — hearable mix already latched
          } else {
            this.remoteAudioSettleExtended = true;
            this.remoteAudioSettlePacketsAtExtend = stats.inboundPackets;
            const extraMs = 2_500;
            logPageDisplay("messages_voice_remote_video_audio_settle_extend", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: stats.inboundPackets,
              liveMix,
              extraMs,
              level: "warn",
              note: liveMix
                ? "mix RTP thin but not hearable yet — delay first video SDP once more"
                : "mix RTP still thin — delay first video SDP once more",
            });
            this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
              void this.finishRemoteAudioSettleForVideo();
            }, extraMs);
            return;
          }
        }
      } catch {
        // fall through and settle
      }
    } else if (connection && this.remoteAudioSettleExtended) {
      // Second gate: prefer a healthy mix, but never permanently block screencast
      // because the WebAudio meter stayed at RMS=0 (prod: settle_abort while
      // inbound Opus bytes were still growing — no audio, no screen, no greens).
      try {
        const stats = await this.logIceDiagnostics(
          connection,
          "audio_settle_gate_final",
        );
        const packetsAtExtend = this.remoteAudioSettlePacketsAtExtend;
        const liveMix = this.hasLiveMixAudioForVideoSettle();
        const packetsRegressed =
          packetsAtExtend > 0 && stats.inboundPackets + 2 < packetsAtExtend;
        const packetsGrew =
          packetsAtExtend <= 0 ||
          stats.inboundPackets >= packetsAtExtend + 8;
        // Historical heardRemoteMixAudio alone used to pass while RTP was
        // regressing (25→12) — then screen SDP froze Opus. Require live growth
        // or a currently hot meter with a solid packet floor. When the meter
        // and RTP-alive latch say the mix is hearable, ignore counter regression
        // (common after PC rebuild) and allow a lower packet floor.
        const regressBlocks = packetsRegressed && !liveMix;
        const mixPacketFloorOk =
          stats.inboundPackets >= 40 ||
          (liveMix &&
            (stats.inboundPackets >= 8 || this.peakInboundAudioPackets >= 8));
        const mixOk =
          !regressBlocks &&
          mixPacketFloorOk &&
          (packetsGrew || this.remoteSpeaking || liveMix);
        if (!mixOk && this.remoteAudioSettleRetryCount < 2) {
          this.remoteAudioSettleRetryCount += 1;
          this.remoteAudioSettleExtended = false;
          this.remoteAudioSettleArmed = false;
          const extraMs = 2_500;
          logPageDisplay("messages_voice_remote_video_audio_settle_defer", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            packetsAtExtend,
            packetsRegressed,
            packetsGrew,
            remoteSpeaking: this.remoteSpeaking,
            heardRemoteMixAudio: this.heardRemoteMixAudio,
            mixRtpPacketsAlive: this.mixRtpPacketsAlive,
            retry: this.remoteAudioSettleRetryCount,
            extraMs,
            level: "warn",
            note: "mix still thin/regressing — keep screen requests, retry settle",
          });
          this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
            void this.finishRemoteAudioSettleForVideo();
          }, extraMs);
          return;
        }
        if (!mixOk) {
          // Prefer waiting over screen-first: thin mixes + immediate screen SDP
          // freeze inbound Opus (prod: inboundPackets plateau at ~13, rms=0).
          if (this.remoteAudioSettleRetryCount < 4) {
            this.remoteAudioSettleRetryCount += 1;
            this.remoteAudioSettleExtended = false;
            this.remoteAudioSettleArmed = false;
            const extraMs = 3_000;
            logPageDisplay("messages_voice_remote_video_audio_settle_defer", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: stats.inboundPackets,
              packetsAtExtend,
              packetsRegressed,
              remoteSpeaking: this.remoteSpeaking,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              mixRtpPacketsAlive: this.mixRtpPacketsAlive,
              retry: this.remoteAudioSettleRetryCount,
              extraMs,
              level: "warn",
              note: "mix still thin — delay screen SDP (avoid freezing mix)",
            });
            this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
              void this.finishRemoteAudioSettleForVideo();
            }, extraMs);
            return;
          }
          if (
            !liveMix &&
            (!this.remoteSpeaking ||
              stats.inboundPackets < 25 ||
              packetsRegressed)
          ) {
            logPageDisplay("messages_voice_remote_video_audio_settle_abort", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: stats.inboundPackets,
              packetsAtExtend,
              packetsRegressed,
              remoteSpeaking: this.remoteSpeaking,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              requested: this.requestedRemoteVideo.length,
              level: "warn",
              note: "mix not healthy enough for screen — keep audio-only this join",
            });
            this.remoteAudioSettledForVideo = false;
            this.remoteAudioSettleArmed = false;
            this.remoteAudioSettleExtended = false;
            this.remoteAudioSettlePacketsAtExtend = 0;
            this.remoteAudioSettleRetryCount = 0;
            return;
          }
          logPageDisplay("messages_voice_remote_video_audio_settle_allow_thin", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            remoteSpeaking: this.remoteSpeaking,
            heardRemoteMixAudio: this.heardRemoteMixAudio,
            mixRtpPacketsAlive: this.mixRtpPacketsAlive,
            liveMix,
            requested: this.requestedRemoteVideo.length,
            level: "warn",
            note: liveMix
              ? "hearable mix latched — allow screen SDP despite thin RTP snapshot"
              : "live speaking + non-regressing RTP — allow screen SDP",
          });
        }
      } catch {
        // fall through
      }
    }
    this.remoteAudioSettledForVideo = true;
    if (this.requestedRemoteVideo.length === 0) return;
    this.queueRemoteVideoRenegotiation();
  }

  private isRemoteAudioUnmuted(): boolean {
    return (this.remoteStream?.getAudioTracks() ?? []).some(
      (t) => t.readyState === "live" && !t.muted,
    );
  }

  private queueRemoteVideoRenegotiation(): void {
    if (
      !this.remoteVideoSdpSubscribeEnabled ||
      this.remoteVideoSdpBlockedAfterStall
    ) {
      if (this.requestedRemoteVideo.length > 0) {
        this.sendReceiverVideoConstraints();
        logPageDisplay("messages_voice_remote_video_sdp_blocked", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          count: this.requestedRemoteVideo.length,
          level: "info",
          note: this.remoteVideoSdpBlockedAfterStall
            ? "skip video SDP — temporary block until post-recover resubscribe"
            : "skip video SDP renegotiate to keep inbound mix audio alive",
        });
      }
      return;
    }
    if (this.remoteAudioStalledAfterVideo) {
      this.sendReceiverVideoConstraints();
      return;
    }
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
    // First video subscribe before mix audio is healthy starved inbound RTP
    // (packets stuck ~20–32 while video flooded; remote_rms stayed 0).
    if (this.requestedRemoteVideo.length > 0 && !this.remoteAudioSettledForVideo) {
      if (this.isRemoteAudioUnmuted()) {
        this.markRemoteAudioSettledForVideo();
      } else if (
        this.pendingVideoRenegotiateOnAudio == null &&
        typeof window !== "undefined"
      ) {
        logPageDisplay("messages_voice_remote_video_wait_audio", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          count: this.requestedRemoteVideo.length,
          level: "info",
          note: "defer video SDP until remote audio unmutes (or 8s)",
        });
        this.remoteAudioSettleArmed = false;
        this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
          this.pendingVideoRenegotiateOnAudio = null;
          this.remoteAudioSettledForVideo = true;
          this.remoteAudioSettleArmed = true;
          if (this.joined && this.requestedRemoteVideo.length > 0) {
            this.queueRemoteVideoRenegotiation();
          }
        }, 8_000);
      }
      return;
    }
    // Colibri only forwards screen/camera after ReceiverVideoConstraints on an
    // open SCTP channel. Renegotiating while DC is still connecting attached
    // muted tracks with inboundVideoPackets=0 (icon on, black stage).
    const dataChannel = this.dataChannel;
    if (
      this.requestedRemoteVideo.length > 0 &&
      dataChannel &&
      dataChannel.readyState !== "open"
    ) {
      logPageDisplay("messages_voice_remote_video_wait_data_channel", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        readyState: dataChannel.readyState,
        count: this.requestedRemoteVideo.length,
        level: "info",
        note: "defer video SDP until Colibri data channel opens",
      });
      if (typeof window !== "undefined") {
        const started = Date.now();
        const poll = () => {
          if (!this.joined || this.dataChannel !== dataChannel) return;
          if (dataChannel.readyState === "open") {
            this.queueRemoteVideoRenegotiation();
            return;
          }
          if (dataChannel.readyState !== "connecting") return;
          if (Date.now() - started > 8_000) {
            this.queueRemoteVideoRenegotiation();
            return;
          }
          window.setTimeout(poll, 250);
        };
        window.setTimeout(poll, 250);
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
    // Do not put video endpoints on-stage while audio settle is still running —
    // Colibri constraints without a video m-line still steal mix bandwidth.
    if (
      this.requestedRemoteVideo.length > 0 &&
      this.remoteVideoSdpSubscribeEnabled &&
      !this.remoteAudioSettledForVideo &&
      !this.remoteVideoSdpBlockedAfterStall
    ) {
      logPageDisplay("messages_voice_video_constraints_defer", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        endpoints: this.requestedRemoteVideo.map((r) => r.endpointId),
        level: "info",
        note: "wait for audio settle before ReceiverVideoConstraints",
      });
      return;
    }
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
      // telegram-tt / tgcalls Full: maxHeight 720 (not 480 — non-rung heights
      // fail simulcast selection and trickle 1080p at ~1fps).
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
        maxHeight: GROUP_CALL_VIDEO_MAX_HEIGHT,
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
    // Preserve existing endpoint→transceiver bindings when the set grows
    // (1→2 shares). Blind index remap stole the first live transceiver and the
    // first tile went black while the second never unmuted.
    const prevSlotsByEndpoint = new Map(
      this.videoRecvSlots
        .filter((slot) => Boolean(slot.endpointId))
        .map((slot) => [slot.endpointId as string, slot] as const),
    );
    this.videoRecvSlots = wanted.map((req) => {
      const prev = prevSlotsByEndpoint.get(req.endpointId);
      return {
        transceiver: prev?.transceiver ?? null,
        endpointId: req.endpointId,
      };
    });

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

    let inboundBefore = {
      inboundPackets: 0,
      inboundVideoPackets: 0,
      outboundPackets: 0,
    };
    try {
      // Always prefer the join *answer* (SFU mix SSRCs). After the first video
      // subscribe, remoteDescription is our crafted offer — reusing it as the
      // audio template froze inboundPackets while video kept growing.
      const remote = connection.remoteDescription;
      const audioBase:
        | "remote_offer"
        | "join_answer"
        | "remote_answer"
        | "local_description" = this.joinAnswerSdp
        ? "join_answer"
        : remote?.type === "offer"
          ? "remote_offer"
          : remote?.type === "answer"
            ? "remote_answer"
            : "local_description";
      const localSdp =
        this.joinAnswerSdp ||
        (remote?.type === "offer" ? remote.sdp : null) ||
        (remote?.type === "answer" ? remote.sdp : null) ||
        connection.localDescription?.sdp ||
        remote?.sdp ||
        "";
      if (!localSdp) return;
      inboundBefore = await this.logIceDiagnostics(
        connection,
        "pre_video_renegotiate",
      );
      const offerSdp = groupCallRemoteSubscribeOfferSdp(
        transport,
        localSdp,
        sections,
        {
          videoPayloadTypes: this.videoPayloadTypes,
          videoExtensions: this.videoExtensions,
          // Only strip client send SSRCs when falling back to local offer.
          stripSenderSsrcs: audioBase === "local_description",
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
        audioBase,
        stripSenderSsrcs: audioBase === "local_description",
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
    // Never overwrite a slot that already owns a transceiver for its endpoint —
    // index assignment after 1→2 renegotiate remapped the first live track away.
    const extraVideoTransceivers = connection
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === "video")
      .filter((t) => t.mid && t.mid !== "1");
    const usedTransceivers = new Set(
      this.videoRecvSlots
        .map((slot) => slot.transceiver)
        .filter((t): t is RTCRtpTransceiver => t != null),
    );
    // Re-associate by receiver track id when the PC replaced the transceiver
    // object but the track is still mapped under this endpoint.
    for (const slot of this.videoRecvSlots) {
      if (!slot.endpointId || slot.transceiver) continue;
      const mapped = this.remoteVideoByEndpoint.get(slot.endpointId);
      const trackId = mapped?.getVideoTracks()[0]?.id;
      if (!trackId) continue;
      const match = extraVideoTransceivers.find(
        (t) => t.receiver.track?.id === trackId,
      );
      if (match && !usedTransceivers.has(match)) {
        slot.transceiver = match;
        usedTransceivers.add(match);
      }
    }
    const freeTransceivers = extraVideoTransceivers.filter(
      (t) => !usedTransceivers.has(t),
    );
    for (const slot of this.videoRecvSlots) {
      if (slot.transceiver || !slot.endpointId) continue;
      const nextTx = freeTransceivers.shift();
      if (!nextTx) break;
      slot.transceiver = nextTx;
      usedTransceivers.add(nextTx);
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
    // Arm soft-stall RMS watch — mix m-line can die while inboundPackets trickle.
    this.postVideoRenegotiateAt = Date.now();
    this.postVideoSilenceTicks = 0;
    this.sendReceiverVideoConstraints();
    this.pullRemoteMediaTracks(connection);
    // Video subscribe used to leave WebAudio attached to a pre-renegotiate
    // stream snapshot — force rebuild so unmuted mix keeps playing.
    this.queueRemotePlayback("post-video-renegotiate");
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
            const audioGrowth =
              stats.inboundPackets - inboundBefore.inboundPackets;
            const videoGrowth =
              stats.inboundVideoPackets - inboundBefore.inboundVideoPackets;
            const outboundGrowth =
              stats.outboundPackets - inboundBefore.outboundPackets;
            // Hard stall must not fire when mix was already healthy and merely
            // paused packet growth for ~1s while video attaches — that tore down
            // working screencasts (Seva glance-then-gone: audioGrowth=0 with
            // inboundPackets=71 + inboundVideoPackets=52).
            // Prefer session peak / heard flags: renegotiate often snapshots a
            // collapsed counter (prod: peak 42 → pre_video 2 → stuck at 4).
            const sessionHadHealthyMix =
              this.peakInboundAudioPackets > 20 ||
              this.heardRemoteMixAudio ||
              this.mixRtpPacketsAlive;
            const hadHealthyAudioBefore =
              inboundBefore.inboundPackets > 20 || sessionHadHealthyMix;
            const mixDied =
              hadHealthyAudioBefore && stats.inboundPackets === 0;
            const mixRegressedHard =
              hadHealthyAudioBefore && audioGrowth < -15 && videoGrowth > 30;
            // Live screencast while measuring — treat mild +1/+2 packet ticks as
            // attach jitter, not a Colibri freeze (prod: audioGrowth=2 + video
            // attach tore down both local + remote stages).
            const screenPainting =
              stats.inboundVideoPackets > 0 ||
              this.hasHealthyRemoteVideoMedia() ||
              this.screenSharing ||
              this.presentationConnection != null;
            // Classic Colibri stall: mix counter freezes (growth≈0) while video
            // RTP climbs — audioGrowth<-15 never fires (prod: packets stuck at 107).
            const mixPlateauWhileVideo =
              hadHealthyAudioBefore &&
              audioGrowth <= (screenPainting ? 0 : 2) &&
              videoGrowth > 15 &&
              !(
                screenPainting &&
                this.mixCounterLooksHealthyForScreen(stats.inboundPackets)
              );
            // Mix collapsed to a trickle after we already heard it this join
            // (prod: settle gate 42pk → renegotiate 2pk → stuck 4pk + video flood).
            const mixCollapsedToTrickle =
              sessionHadHealthyMix &&
              stats.inboundPackets > 0 &&
              stats.inboundPackets < 12 &&
              audioGrowth <= 2 &&
              videoGrowth > 15;
            // Classic incomplete-SSRC failure: mix never really started, video
            // floods, outbound keeps going.
            const mixNeverStartedStarved =
              !hadHealthyAudioBefore &&
              outboundGrowth > 5 &&
              audioGrowth <= 0 &&
              videoGrowth > 50;
            const audioStalled =
              outboundGrowth > 5 &&
              (mixDied ||
                mixRegressedHard ||
                mixPlateauWhileVideo ||
                mixCollapsedToTrickle ||
                mixNeverStartedStarved);
            // Live screencast + stalled mix: allow ONE recover to restore voice,
            // then keep the stage (recover↔resubscribe flickered on/off).
            if (screenPainting) {
              this.preferStableScreencast = true;
            }
            if (audioStalled && this.shouldSkipRecoverToKeepScreen()) {
              logPageDisplay("messages_voice_remote_audio_stalled_keep_video", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                inboundBefore: inboundBefore.inboundPackets,
                inboundAfter: stats.inboundPackets,
                audioGrowth,
                videoGrowth,
                inboundVideoPackets: stats.inboundVideoPackets,
                recoverCount: this.audioRecoverCount,
                peakInboundAudio: this.peakInboundAudioPackets,
                level: "warn",
                note: "mix stalled with live screencast — keep stage, heal sink (no recover flicker)",
              });
              void this.healSilentMixDespiteRtp();
            } else if (
              audioStalled &&
              screenPainting &&
              !mixDied &&
              !mixRegressedHard &&
              !mixCollapsedToTrickle
            ) {
              // Live screencast + mild mix plateau — heal sink; never rejoin and
              // drop both stages (prod: flat counter at 44pk tore down screen).
              this.preferStableScreencast = true;
              logPageDisplay("messages_voice_remote_audio_stalled_keep_video", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                inboundBefore: inboundBefore.inboundPackets,
                inboundAfter: stats.inboundPackets,
                audioGrowth,
                videoGrowth,
                inboundVideoPackets: stats.inboundVideoPackets,
                recoverCount: this.audioRecoverCount,
                level: "warn",
                note: "mix plateau during video attach — keep both stages, heal sink",
              });
              void this.healSilentMixDespiteRtp();
            } else if (audioStalled) {
              this.remoteAudioStalledAfterVideo = true;
              logPageDisplay("messages_voice_remote_audio_stalled_after_video", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                inboundBefore: inboundBefore.inboundPackets,
                inboundAfter: stats.inboundPackets,
                outboundBefore: inboundBefore.outboundPackets,
                outboundAfter: stats.outboundPackets,
                audioGrowth,
                videoGrowth,
                screenPainting,
                recoverCount: this.audioRecoverCount,
                level: "error",
                note: screenPainting
                  ? "mix RTP stalled after video SDP — one-shot audio recover (screen stays blocked)"
                  : "mix RTP stalled or starved after video SDP — recover audio-only",
              });
              void this.recoverAudioOnlyAfterVideoStall();
            } else if (audioGrowth > 5) {
              // Meaningful mix growth — disarm soft RMS recover.
              this.postVideoRenegotiateAt = 0;
              this.postVideoSilenceTicks = 0;
            } else if (hadHealthyAudioBefore && videoGrowth > 0) {
              // Flat / trickle mix while video floods — keep soft RMS watch armed.
              // A single +1 packet used to clear the watch and leave the user in
              // permanent silence after screen SDP (html sink also rms=0).
              if (typeof window !== "undefined") {
                const baselinePackets = stats.inboundPackets;
                const baselineVideo = stats.inboundVideoPackets;
                window.setTimeout(() => {
                  if (this.connection !== connection || !this.joined) return;
                  if (
                    this.remoteAudioStalledAfterVideo ||
                    this.audioRecoverAfterVideoDone ||
                    this.audioRecoverInFlight ||
                    this.audioRecoverCount >=
                      TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
                  ) {
                    return;
                  }
                  void this.logIceDiagnostics(
                    connection,
                    "post_video_renegotiate_flat_recheck",
                  ).then((later) => {
                    if (this.connection !== connection || !this.joined) return;
                    const laterAudioGrowth =
                      later.inboundPackets - baselinePackets;
                    const laterVideoGrowth =
                      later.inboundVideoPackets - baselineVideo;
                    // Never tear down a healthy screencast on deferred recheck.
                    // Flat mix + climbing video used to call audio-only recover
                    // ("glance then gone"). Soft RMS / WebAudio heal instead.
                    const screenAlive =
                      later.inboundVideoPackets > 0 ||
                      laterVideoGrowth > 0 ||
                      this.hasHealthyRemoteVideoMedia();
                    if (later.inboundPackets === 0 && !screenAlive) {
                      this.remoteAudioStalledAfterVideo = true;
                      logPageDisplay(
                        "messages_voice_remote_audio_stalled_after_video",
                        {
                          chatId: this.input.chatId,
                          groupCallId: this.input.groupCallId,
                          inboundBefore: baselinePackets,
                          inboundAfter: later.inboundPackets,
                          audioGrowth: laterAudioGrowth,
                          videoGrowth: laterVideoGrowth,
                          level: "error",
                          note: "mix dead on deferred recheck — no screen RTP, audio-only recover",
                        },
                      );
                      void this.recoverAudioOnlyAfterVideoStall();
                      return;
                    }
                    if (laterAudioGrowth > 5) {
                      this.postVideoRenegotiateAt = 0;
                      this.postVideoSilenceTicks = 0;
                    }
                    if (screenAlive && laterAudioGrowth <= 0) {
                      this.preferStableScreencast = true;
                      logPageDisplay(
                        "messages_voice_remote_audio_stalled_keep_video",
                        {
                          chatId: this.input.chatId,
                          groupCallId: this.input.groupCallId,
                          inboundBefore: baselinePackets,
                          inboundAfter: later.inboundPackets,
                          audioGrowth: laterAudioGrowth,
                          videoGrowth: laterVideoGrowth,
                          inboundVideoPackets: later.inboundVideoPackets,
                          recoverCount: this.audioRecoverCount,
                          level: "warn",
                          note:
                            "flat mix counter with live screen — keep stage, heal sink (no recover flicker)",
                        },
                      );
                      void this.healSilentMixDespiteRtp();
                      return;
                    }
                    logPageDisplay(
                      "messages_voice_remote_video_flat_audio_ok",
                      {
                        chatId: this.input.chatId,
                        groupCallId: this.input.groupCallId,
                        inboundPackets: later.inboundPackets,
                        inboundVideoPackets: later.inboundVideoPackets,
                        audioGrowth: laterAudioGrowth,
                        videoGrowth: laterVideoGrowth,
                        level: "info",
                        note: screenAlive
                          ? "trickle mix + live screen — keep screencast, soft heal"
                          : laterAudioGrowth < 5 && laterVideoGrowth > 80
                            ? "flat mix + video flood — keep soft RMS watch"
                            : "kept screen after flat window — mix still alive",
                      },
                    );
                    if (screenAlive && laterAudioGrowth < 5) {
                      void this.healSilentMixDespiteRtp();
                    }
                  });
                }, 2500);
              }
            }
            if (stats.inboundPackets > inboundBefore.inboundPackets) {
              this.queueRemotePlayback("post-video-audio-check");
            } else if (stats.inboundPackets > 0) {
              this.queueRemotePlayback("post-video-audio-check");
            }
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
    framesDecoded: number;
    framesReceived: number;
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
      if (inboundPackets > this.peakInboundAudioPackets) {
        this.peakInboundAudioPackets = inboundPackets;
      }
      if (inboundPackets >= 8) {
        this.mixRtpPacketsAlive = true;
      }
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
      return {
        inboundPackets,
        inboundVideoPackets,
        outboundPackets,
        framesDecoded,
        framesReceived,
      };
    } catch {
      // ignore stats errors
      return {
        inboundPackets: 0,
        inboundVideoPackets: 0,
        outboundPackets: 0,
        framesDecoded: 0,
        framesReceived: 0,
      };
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
      // Transient "disconnected" often recovers — only act when failed/closed, or
      // when still disconnected after the grace window (consent often never returns).
      if (
        ice === "failed" ||
        ice === "closed" ||
        conn === "failed" ||
        conn === "closed" ||
        ice === "disconnected" ||
        conn === "disconnected"
      ) {
        void this.recoverFromIceFailure(reason);
      }
    }, delayMs);
  }

  /**
   * ICE/consent died after a healthy stretch (prod: hearable RMS then
   * pairsSucceeded=0 → ice_disconnected → join lost). Silently rejoin instead
   * of dropping the user out of the call UI.
   */
  private async recoverFromIceFailure(reason: string): Promise<void> {
    if (this.iceRecoverInFlight || this.audioRecoverInFlight) return;
    if (
      this.iceRecoverCount >= TelegramGroupCallWebSession.MAX_ICE_RECOVERS
    ) {
      this.markJoinLost(reason);
      return;
    }
    if (!this.joined && !this.connection) {
      this.markJoinLost(reason);
      return;
    }
    this.clearJoinLostTimer();
    this.iceRecoverInFlight = true;
    this.iceRecoverCount += 1;
    const startMuted = !this.micEnabled;
    logPageDisplay("messages_voice_ice_recover", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      recoverCount: this.iceRecoverCount,
      startMuted,
      heardRemoteMixAudio: this.heardRemoteMixAudio,
      level: "warn",
      note: "ICE/consent failed — silent rejoin to restore mix audio",
    });
    try {
      this.markJoinLost(`ice_recover_${reason}`, { silent: true });
      this.remoteAudioEnabled = true;
      unlockVoiceAutoplay();
      await this.ensureJoinedListenOnly(startMuted);
      this.resumeRemoteAudio();
      logPageDisplay("messages_voice_ice_recover_ok", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        recoverCount: this.iceRecoverCount,
        ice: this.connection?.iceConnectionState ?? "none",
        conn: this.connection?.connectionState ?? "none",
        level: "info",
      });
    } catch (err) {
      logPageDisplay("messages_voice_ice_recover_fail", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        recoverCount: this.iceRecoverCount,
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
      this.markJoinLost(reason);
    } finally {
      this.iceRecoverInFlight = false;
    }
  }

  private clearJoinLostTimer(): void {
    if (this.iceDisconnectTimer) {
      window.clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
  }

  private markJoinLost(
    reason: string,
    opts?: { silent?: boolean; keepPresentation?: boolean },
  ): void {
    if (!this.joined && !this.connection) return;
    this.speakingSyncBlockedUntil = Date.now() + 4_000;
    this.lastSpeakingSynced = null;
    // Tear down media so ensureJoinedListenOnly can open a fresh PeerConnection.
    // Do not remove the remote <audio> shell — unlock gestures still need it.
    this.stopSpeakingMonitor();
    this.stopRemoteSpeakingMonitor();
    this.clearPlaybackWatchdog();
    this.teardownWebAudioPlayback();
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
    // Audio-stall recover must not stop getDisplayMedia / presentation PC —
    // that wiped the local stage when unmuting a second remote screencast.
    const keepPresentation =
      opts?.keepPresentation === true || reason === "audio_stalled_after_video";
    if (keepPresentation) {
      this.stopLocalCameraCaptureOnly();
    } else {
      this.stopLocalVideoCaptures();
      this.teardownPresentationConnection();
    }
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }
    this.clearRemoteVideoStream();
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }
    const wasJoined = this.joined;
    const connection = this.connection;
    this.connection = null;
    this.dataChannel = null;
    if (connection) {
      try {
        connection.close();
      } catch {
        // ignore
      }
    }
    this.clearVideoRenegotiateConnectWait();
    this.clearVideoRenegotiateAudioWait();
    this.remoteAudioSettledForVideo = false;
    this.remoteAudioSettleArmed = false;
    this.remoteAudioSettleExtended = false;
    this.remoteAudioSettlePacketsAtExtend = 0;
    this.remoteAudioSettleRetryCount = 0;
    this.remoteAudioStalledAfterVideo = false;
    this.remoteVideoSdpSubscribeEnabled = false;
    this.softSilentVideoCheckInFlight = false;
    this.joined = false;
    this.micEnabled = false;
    this.lastTransport = null;
    this.joinAnswerSdp = null;
    this.videoPayloadTypes = [];
    this.videoExtensions = [];
    this.lastAppliedRemoteVideoEndpoints = [];
    this.videoRecvSlots = [];
    this.requestedRemoteVideo = [];
    this.lastAppliedRemoteVideoKey = "";
    this.remoteAudioEnabled = false;
    this.heardRemoteMixAudio = false;
    this.lastHeardMixAudioAt = 0;
    this.mixRtpPacketsAlive = false;
    this.peakInboundAudioPackets = 0;
    this.remoteAudioUnmutedAt = 0;
    this.silentMixHealInFlight = false;
    this.silentMixHealCount = 0;
    this.preferDedicatedPlaybackCtx = false;
    this.preferHtmlRemotePlayback = true;
    this.remoteAudioSettleRetryCount = 0;
    this.remotePlaybackSink = "html_audio";
    this.remoteSilenceTicks = 0;
    this.uninstallVisibilityPlaybackKick();
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

  /**
   * True when a remote screen/camera slot is actually painting (or at least
   * live). Soft RMS silence after video SDP must not tear this down — that is
   * the "glance then gone" bug while the sharer keeps casting and mix RTP is
   * merely quiet / sink-flipped.
   */
  private hasHealthyRemoteVideoMedia(): boolean {
    for (const stream of this.remoteVideoByEndpoint.values()) {
      for (const track of stream.getVideoTracks()) {
        if (track.readyState === "live") return true;
      }
    }
    for (const stream of this.remoteVideoUiByEndpoint.values()) {
      for (const track of stream.getVideoTracks()) {
        if (track.readyState === "live") return true;
      }
    }
    return (
      this.lastAppliedRemoteVideoEndpoints.length > 0 &&
      this.requestedRemoteVideo.length > 0
    );
  }

  /**
   * Refuse further audio-only recovers only after the recover budget is spent.
   * Skipping after the *first* recover while a screencast was live blocked the
   * second recover when auto screen-resubscribe froze the mix again (prod:
   * recover_ok → resubscribe → inboundPackets plateau, silence forever).
   */
  private shouldSkipRecoverToKeepScreen(): boolean {
    if (
      this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      return false;
    }
    if (this.screenSharing || this.presentationConnection != null) {
      return true;
    }
    if (this.hasHealthyRemoteVideoMedia()) {
      return true;
    }
    if (this.preferStableScreencast) {
      return true;
    }
    return false;
  }

  /**
   * Soft RMS silence after video with a live screen.
   *
   * First frozen-mix stall: one audio-only recover (screen briefly drops, then
   * resubscribes). Later stalls: keep stage and heal sink only (no flicker).
   * Growing mix RTP + quiet RMS: keep stage and heal — never tear down.
   */
  private async evaluateSoftSilentKeepVideo(sinceVideoMs: number): Promise<void> {
    if (this.softSilentVideoCheckInFlight) return;
    if (
      this.audioRecoverInFlight ||
      this.remoteAudioStalledAfterVideo ||
      this.audioRecoverCount >= TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      return;
    }
    const connection = this.connection;
    if (!connection || !this.joined) return;
    this.softSilentVideoCheckInFlight = true;
    try {
      this.queueRemotePlayback("post-video-soft-silent");
      // Already recovered once — keep stage, do not flicker again.
      if (this.shouldSkipRecoverToKeepScreen()) {
        this.preferStableScreencast = true;
        // Keep postVideoRenegotiateAt armed only if we still need soft watch;
        // after a completed recover, clear so we do not loop probes forever.
        this.postVideoRenegotiateAt = 0;
        this.postVideoSilenceTicks = 0;
        logPageDisplay(
          "messages_voice_remote_audio_soft_silent_keep_video",
          {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            rms: 0,
            sinceVideoMs,
            recoverCount: this.audioRecoverCount,
            sink: this.remotePlaybackSink,
            screens: this.lastAppliedRemoteVideoEndpoints,
            level: "warn",
            note:
              "soft silence after prior recover — keep stage, heal (no recover flicker)",
          },
        );
        void this.healSilentMixDespiteRtp();
        return;
      }
      const before = await this.logIceDiagnostics(
        connection,
        "soft_silent_mix_check_a",
      );
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.setTimeout(resolve, 1_600);
      });
      if (this.connection !== connection || !this.joined) return;
      const after = await this.logIceDiagnostics(
        connection,
        "soft_silent_mix_check_b",
      );
      const audioGrowth = after.inboundPackets - before.inboundPackets;
      const videoGrowth =
        after.inboundVideoPackets - before.inboundVideoPackets;
      const screenStillLive =
        this.hasHealthyRemoteVideoMedia() ||
        after.inboundVideoPackets > 0 ||
        videoGrowth > 0 ||
        this.lastAppliedRemoteVideoEndpoints.length > 0;
      const mixRtpFrozen = audioGrowth <= 0;
      // Mix still advancing — quiet RMS is a sink problem, not an SFU stall.
      if (screenStillLive && !mixRtpFrozen) {
        this.preferStableScreencast = true;
        this.postVideoRenegotiateAt = 0;
        this.postVideoSilenceTicks = 0;
        logPageDisplay(
          "messages_voice_remote_audio_soft_silent_keep_video",
          {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            rms: 0,
            sinceVideoMs,
            audioGrowth,
            videoGrowth,
            inboundPackets: after.inboundPackets,
            inboundVideoPackets: after.inboundVideoPackets,
            sink: this.remotePlaybackSink,
            screens: this.lastAppliedRemoteVideoEndpoints,
            level: "warn",
            note: "RMS quiet but mix RTP growing — keep screencast, heal WebAudio",
          },
        );
        this.queueRemotePlayback("post-video-soft-silent");
        void this.healSilentMixDespiteRtp();
        return;
      }
      // Frozen mix — recover even with live screen (first time; gate above).
      // Sink heal cannot invent RTP when the mix m-line is dead.
      if (mixRtpFrozen) {
        this.postVideoRenegotiateAt = 0;
        this.postVideoSilenceTicks = 0;
        this.remoteAudioStalledAfterVideo = true;
        logPageDisplay(
          "messages_voice_remote_audio_soft_silent_recover_rtp_stall",
          {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            sinceVideoMs,
            audioGrowth,
            videoGrowth,
            inboundBefore: before.inboundPackets,
            inboundAfter: after.inboundPackets,
            inboundVideoPackets: after.inboundVideoPackets,
            sink: this.remotePlaybackSink,
            screens: this.lastAppliedRemoteVideoEndpoints,
            screenStillLive,
            recoverCount: this.audioRecoverCount,
            level: "error",
            note: screenStillLive
              ? "mix RTP frozen after video SDP — one-shot audio recover (screen stays blocked)"
              : "mix RTP frozen after video SDP, no screen — audio-only recover",
          },
        );
        void this.recoverAudioOnlyAfterVideoStall();
        return;
      }
      this.postVideoRenegotiateAt = 0;
      this.remoteAudioStalledAfterVideo = true;
      logPageDisplay(
        "messages_voice_remote_audio_soft_silent_recover_despite_video",
        {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          sinceVideoMs,
          audioGrowth,
          inboundBefore: before.inboundPackets,
          inboundAfter: after.inboundPackets,
          inboundVideoPackets: after.inboundVideoPackets,
          sink: this.remotePlaybackSink,
          screens: this.lastAppliedRemoteVideoEndpoints,
          level: "error",
          note:
            "soft silence with no screen — audio-only recover",
        },
      );
      void this.recoverAudioOnlyAfterVideoStall();
    } finally {
      this.softSilentVideoCheckInFlight = false;
    }
  }

  /**
   * Video SDP broke the mix m-line — drop video subscribe and rejoin listen-only
   * so inbound audio RTP can flow again. After mix is healthy again, one remote
   * screen restore is allowed (preferStableScreencast prevents tear-down loops).
   */
  private async recoverAudioOnlyAfterVideoStall(): Promise<void> {
    if (
      this.audioRecoverInFlight ||
      this.audioRecoverCount >= TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      return;
    }
    // After one recover, refuse further tears while screencast is preferred.
    if (this.shouldSkipRecoverToKeepScreen()) {
      this.preferStableScreencast = true;
      logPageDisplay("messages_voice_audio_recover_skip_stable_screen", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        preferStableScreencast: this.preferStableScreencast,
        healthyVideo: this.hasHealthyRemoteVideoMedia(),
        recoverCount: this.audioRecoverCount,
        level: "warn",
        note: "skip audio-only recover — already recovered once, keep screencast stable",
      });
      void this.healSilentMixDespiteRtp();
      return;
    }
    if (!this.joined && !this.connection) return;
    this.audioRecoverInFlight = true;
    this.audioRecoverCount += 1;
    this.audioRecoverAfterVideoDone = true;
    this.remoteVideoSdpSubscribeEnabled = false;
    this.remoteVideoSdpBlockedAfterStall = true;
    this.preferStableScreencast = true;
    this.videoResubscribeAfterRecoverAttempts = 0;
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    const savedScreens =
      this.requestedRemoteVideo.length > 0
        ? this.requestedRemoteVideo
        : this.pendingRemoteVideoAfterRecover;
    this.pendingRemoteVideoAfterRecover = savedScreens.map((r) => ({
      endpointId: r.endpointId,
      kind: r.kind,
      ssrcGroups: r.ssrcGroups.map((g) => ({
        semantics: g.semantics,
        sourceIds: [...g.sourceIds],
      })),
    }));
    this.requestedRemoteVideo = [];
    const startMuted = !this.micEnabled;
    logPageDisplay("messages_voice_audio_recover_start", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      startMuted,
      recoverCount: this.audioRecoverCount,
      pendingVideo: this.pendingRemoteVideoAfterRecover.length,
      level: "warn",
      note: "rejoin without video SDP after mix RTP stall — one remote screen restore after mix healthy",
    });
    try {
      this.markJoinLost("audio_stalled_after_video", {
        silent: true,
        keepPresentation: true,
      });
      this.remoteAudioEnabled = true;
      unlockVoiceAutoplay();
      await this.ensureJoinedListenOnly(startMuted);
      this.resumeRemoteAudio();
      logPageDisplay("messages_voice_audio_recover_ok", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice: this.connection?.iceConnectionState ?? "none",
        conn: this.connection?.connectionState ?? "none",
        recoverCount: this.audioRecoverCount,
        keptPresentation: Boolean(
          this.screenSharing && this.presentationConnection,
        ),
        pendingVideo: this.pendingRemoteVideoAfterRecover.length,
        level: "info",
      });
      this.remoteVideoSdpBlockedAfterStall = true;
      this.remoteVideoSdpSubscribeEnabled = false;
      this.preferStableScreencast = true;
      this.notifyLocalMediaListeners();
      // Only auto-restore screens after the *first* recover. A second recover
      // means resubscribe already killed the mix once — keep audio, leave
      // screens for explicit unmute (preferExplicitRemoteVideoSubscribe).
      if (
        this.pendingRemoteVideoAfterRecover.length > 0 &&
        this.audioRecoverCount < 2
      ) {
        this.scheduleRemoteVideoResubscribeAfterAudioHealthy();
      } else if (this.pendingRemoteVideoAfterRecover.length > 0) {
        logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          recoverCount: this.audioRecoverCount,
          pendingVideo: this.pendingRemoteVideoAfterRecover.length,
          level: "warn",
          note:
            "skip auto screen restore after repeated mix stall — unmute screen from menu",
        });
      } else {
        logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          recoverCount: this.audioRecoverCount,
          level: "warn",
          note: "no pending remote screens after audio recover",
        });
      }
    } catch (err) {
      logPageDisplay("messages_voice_audio_recover_fail", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
    } finally {
      this.audioRecoverInFlight = false;
    }
  }

  /**
   * Wait for mix RTP to stay healthy, then one-shot restore remote screens.
   * preferStableScreencast stays on so a later mild stall will not tear the stage.
   */
  private scheduleRemoteVideoResubscribeAfterAudioHealthy(): void {
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    if (this.pendingRemoteVideoAfterRecover.length === 0) return;
    if (this.videoResubscribeAfterRecoverAttempts >= 3) {
      logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        recoverCount: this.audioRecoverCount,
        attempts: this.videoResubscribeAfterRecoverAttempts,
        level: "warn",
        note: "give up remote screen restore — mix never settled",
      });
      this.pendingRemoteVideoAfterRecover = [];
      return;
    }
    const delayMs = 2_800;
    logPageDisplay("messages_voice_remote_video_resubscribe_armed", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      recoverCount: this.audioRecoverCount,
      pending: this.pendingRemoteVideoAfterRecover.length,
      attempt: this.videoResubscribeAfterRecoverAttempts + 1,
      delayMs,
      level: "info",
      note: "will restore remote screens once after mix settle",
    });
    this.videoResubscribeAfterRecoverTimer = setTimeout(() => {
      this.videoResubscribeAfterRecoverTimer = null;
      this.finishRemoteVideoResubscribeAfterRecover();
    }, delayMs);
  }

  private finishRemoteVideoResubscribeAfterRecover(): void {
    const pending = this.pendingRemoteVideoAfterRecover;
    if (pending.length === 0) return;
    if (!this.joined) {
      this.pendingRemoteVideoAfterRecover = [];
      return;
    }
    this.videoResubscribeAfterRecoverAttempts += 1;
    if (!this.isMediaConnected() && !this.mixRtpPacketsAlive) {
      this.scheduleRemoteVideoResubscribeAfterAudioHealthy();
      return;
    }
    this.pendingRemoteVideoAfterRecover = [];
    this.remoteVideoSdpBlockedAfterStall = false;
    this.remoteAudioStalledAfterVideo = false;
    this.preferStableScreencast = true;
    this.audioRecoverAfterVideoDone = false;
    this.remoteVideoSdpSubscribeEnabled = true;
    logPageDisplay("messages_voice_remote_video_resubscribe_start", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      recoverCount: this.audioRecoverCount,
      count: pending.length,
      endpoints: pending.map((r) => r.endpointId).slice(0, 4),
      level: "info",
      note: "one-shot remote screen restore after audio recover",
    });
    this.setRequestedRemoteVideos(pending);
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

  async startScreenShare(preacquiredStream?: MediaStream | null): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("screen_share_unavailable");
    }

    // Capture first while the click still has transient user activation.
    // Joining / SDP must not run before getDisplayMedia or Chrome drops the prompt.
    let displayStream = preacquiredStream ?? null;
    if (!displayStream) {
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: true,
        });
      } catch (err) {
        throw mapDisplayMediaError(err);
      }
    }
    const track = displayStream.getVideoTracks()[0];
    if (!track) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error("screen_share_unavailable");
    }
    track.enabled = true;

    const releaseAcquired = () => {
      try {
        track.stop();
      } catch {
        // ignore
      }
      displayStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
    };

    try {
      if (this.presentationJoining) {
        await this.presentationJoining;
        if (this.screenSharing) {
          releaseAcquired();
          return;
        }
      }
      if (this.screenSharing && this.presentationConnection) {
        releaseAcquired();
        this.notifyLocalMediaListeners();
        return;
      }

      if (!this.joined) {
        await this.ensureJoinedListenOnly();
      }
      if (!this.joined) {
        throw new Error("voice_not_joined");
      }

      this.presentationJoining = this.joinPresentationConnection(track);
      await this.presentationJoining;
    } catch (err) {
      releaseAcquired();
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
    // Local share while a remote is publishing — clear sticky video block so
    // both tiles can paint (prod: only local-screen after stall recover).
    this.preferExplicitRemoteVideoSubscribe();
    logPageDisplay("messages_voice_screen_share_started", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      presentationAudioSourceId: this.presentationAudioSourceId,
      level: "info",
    });
  }

  /** Keep stage size for UI metrics — do not downscale encode to the docked preview. */
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
  }

  private computeScreenShareTargets(): {
    width: number;
    height: number;
    maxBitrate: number;
    maxFramerate: number;
    scaleResolutionDownBy: number;
  } {
    const settings = this.screenTrack?.getSettings?.() ?? {};
    const width =
      typeof settings.width === "number" && settings.width > 0
        ? settings.width
        : 1920;
    const height =
      typeof settings.height === "number" && settings.height > 0
        ? settings.height
        : 1080;
    return {
      width,
      height,
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    };
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

  private stopLocalCameraCaptureOnly(): void {
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    this.cameraEnabled = false;
    this.notifyLocalMediaListeners();
  }

  private stopLocalVideoCaptures(): void {
    this.stopLocalCameraCaptureOnly();
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

  get isRemoteSpeaking(): boolean {
    return this.remoteSpeaking;
  }

  onRemoteSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.remoteSpeakingListeners.add(listener);
    try {
      listener(this.remoteSpeaking);
    } catch {
      // ignore
    }
    return () => {
      this.remoteSpeakingListeners.delete(listener);
    };
  }

  private setRemoteSpeaking(speaking: boolean): void {
    if (this.remoteSpeaking === speaking) return;
    this.remoteSpeaking = speaking;
    logPageDisplay("messages_voice_remote_speaking", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      speaking,
      level: "info",
      note: "mixed inbound audio level — playback/sink heuristics only; not per-participant mic paint",
    });
    for (const listener of this.remoteSpeakingListeners) {
      try {
        listener(speaking);
      } catch {
        // ignore
      }
    }
    // Arm video only once the mix meter is currently hot — not on a one-shot
    // RMS spike before speaking sticks (that opened screen and froze Opus).
    if (speaking) this.tryArmRemoteVideoSdpAfterHealthyMix();
  }

  /** Screen SDP after mix is connected — not only when RMS speaking is hot. */
  private tryArmRemoteVideoSdpAfterHealthyMix(): void {
    if (
      this.requestedRemoteVideo.length === 0 ||
      this.remoteVideoSdpSubscribeEnabled ||
      !this.canArmExplicitRemoteVideoSdp()
    ) {
      return;
    }
    this.setRemoteVideoSdpEnabled(true);
  }

  private stopRemoteSpeakingMonitor(options?: { keepSpeaking?: boolean }): void {
    if (this.remoteSpeakingTimer != null) {
      clearInterval(this.remoteSpeakingTimer);
      this.remoteSpeakingTimer = null;
    }
    if (this.remoteSpeakingRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.remoteSpeakingRaf);
      this.remoteSpeakingRaf = null;
    }
    try {
      this.remoteSpeakingSource?.disconnect();
    } catch {
      // ignore
    }
    this.remoteSpeakingSource = null;
    this.remoteSpeakingAnalyser = null;
    try {
      this.remoteSpeakingTrack?.stop();
    } catch {
      // ignore
    }
    this.remoteSpeakingTrack = null;
    if (this.remoteSpeaking && !options?.keepSpeaking) this.setRemoteSpeaking(false);
  }

  /** Level-meter the mixed remote track so green mics work when SSE speaking stays 0. */
  private startRemoteSpeakingMonitor(): void {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
    const stream = this.remoteStream;
    const track = stream?.getAudioTracks().find((t) => t.readyState === "live");
    if (!stream || !track) return;
    if (this.remoteSpeakingTimer != null || this.remoteSpeakingRaf != null) return;

    try {
      const ctx = this.ensurePlaybackContext() ?? new AudioContext();
      if (!this.playbackCtx) this.playbackCtx = ctx;
      // Clone so HTML <audio> + WebAudio playback do not leave the meter silent
      // (Chrome often starves a shared MediaStreamSource after sink flips).
      let meterTrack: MediaStreamTrack = track;
      try {
        meterTrack = track.clone();
        meterTrack.enabled = true;
        this.remoteSpeakingTrack = meterTrack;
      } catch {
        this.remoteSpeakingTrack = null;
        meterTrack = track;
      }
      const snapshot = new MediaStream([meterTrack]);
      const source = ctx.createMediaStreamSource(snapshot);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      // Do not connect analyser → destination (playback already has its own graph).
      this.remoteSpeakingSource = source;
      this.remoteSpeakingAnalyser = analyser;
      this.remoteSilenceTicks = 0;
      const data = new Uint8Array(analyser.frequencyBinCount);
      // Lower ON so attenuated / comfort-noise mixes latch "heard" sooner
      // (prod Vespiol: peakRms≈0.0078 under the old 0.01 gate for many seconds).
      const ON_RMS = 0.006;
      const OFF_RMS = 0.003;
      const MIN_FLIP_MS = 180;
      /** Require sustained silence before clearing — brief dips were flapping
       * remoteSpeaking every 200ms and tore down the mix→green extend interval.
       * ~400ms hold so greens stay lit through short pauses while speech is heard. */
      const OFF_HOLD_TICKS = 24;
      let lastFlipAt = 0;
      let speaking = this.remoteSpeaking;
      let offHoldTicks = 0;
      let lastRmsLogAt = 0;
      let peakRms = 0;

      const sample = () => {
        if (!this.joined || !this.remoteSpeakingAnalyser) return;
        const live = this.remoteStream
          ?.getAudioTracks()
          .some((t) => t.readyState === "live" && !t.muted);
        if (!live) {
          this.remoteSilenceTicks = 0;
          peakRms = 0;
          offHoldTicks = 0;
          if (speaking) {
            speaking = false;
            lastFlipAt = Date.now();
            this.setRemoteSpeaking(false);
          }
          return;
        }
        this.remoteSpeakingAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i]! - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > peakRms) peakRms = rms;
        const now = Date.now();
        if (now - lastRmsLogAt >= 4_000) {
          lastRmsLogAt = now;
          logPageDisplay("messages_voice_remote_rms", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            rms: Number(rms.toFixed(4)),
            peakRms: Number(peakRms.toFixed(4)),
            speaking,
            sink: this.remotePlaybackSink,
            gain: Number(this.playbackGainValue.toFixed(3)),
            level: "info",
          });
          peakRms = rms;
        }
        let next = speaking;
        if (rms >= ON_RMS) {
          offHoldTicks = 0;
          const firstHearable = !this.heardRemoteMixAudio;
          this.heardRemoteMixAudio = true;
          this.lastHeardMixAudioAt = now;
          if (firstHearable && this.remotePlaybackSink === "webaudio") {
            // Meter can spike on a clone while WebAudio playback stays silent —
            // flip to HTML (do NOT rebuild WebAudio — that re-latched silence).
            void this.switchRemotePlaybackToHtml("mix-energy-first", {
              force: true,
            });
          }
          if (!speaking) next = true;
          // Do not open video SDP on the first RMS spike — wait until
          // setRemoteSpeaking(true) (speaking stick) + settle health checks.
          if (firstHearable && this.requestedRemoteVideo.length > 0) {
            logPageDisplay("messages_voice_remote_video_wait_speaking_stick", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              endpoints: this.requestedRemoteVideo
                .map((r) => r.endpointId)
                .slice(0, 4),
              level: "info",
              note: "mix crossed ON_RMS — arm video after speaking sticks",
            });
          }
        } else if (rms <= OFF_RMS) {
          offHoldTicks += 1;
          if (speaking && offHoldTicks >= OFF_HOLD_TICKS) next = false;
        } else {
          offHoldTicks = 0;
        }
        if (next !== speaking && now - lastFlipAt >= MIN_FLIP_MS) {
          speaking = next;
          lastFlipAt = now;
          this.setRemoteSpeaking(speaking);
        }
        // Soft stall: after video SDP, sustained RMS silence means the mix is
        // effectively dead even if a trickle of RTP packets still arrive.
        // Keep this armed until meaningful audioGrowth (>5) clears the flag —
        // a single packet must not disarm it (prod: +1 packet → forever silent).
        // NEVER tear down while remote screen/camera is healthy — that drops a
        // live screencast ("glance then gone") while the sharer keeps casting.
        if (
          this.postVideoRenegotiateAt > 0 &&
          !this.remoteAudioStalledAfterVideo &&
          !this.audioRecoverAfterVideoDone &&
          !this.audioRecoverInFlight &&
          !this.softSilentVideoCheckInFlight &&
          this.audioRecoverCount <
            TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
        ) {
          const sinceVideo = now - this.postVideoRenegotiateAt;
          if (sinceVideo >= 2_500) {
            if (rms < OFF_RMS) {
              this.postVideoSilenceTicks += 1;
              // ~2.5s of silence samples after the 2.5s settle window
              if (this.postVideoSilenceTicks >= 25) {
                this.postVideoSilenceTicks = 0;
                if (this.hasHealthyRemoteVideoMedia()) {
                  // Do not disarm here — probe mix RTP; flat → audio-first recover.
                  void this.evaluateSoftSilentKeepVideo(sinceVideo);
                } else {
                  this.postVideoRenegotiateAt = 0;
                  this.remoteAudioStalledAfterVideo = true;
                  logPageDisplay(
                    "messages_voice_remote_audio_soft_stalled_after_video",
                    {
                      chatId: this.input.chatId,
                      groupCallId: this.input.groupCallId,
                      rms: Number(rms.toFixed(4)),
                      sinceVideoMs: sinceVideo,
                      sink: this.remotePlaybackSink,
                      level: "error",
                      note:
                        "RMS silent after video SDP — recover audio-only (packets may still trickle)",
                    },
                  );
                  void this.recoverAudioOnlyAfterVideoStall();
                  return;
                }
              }
            } else if (rms >= ON_RMS) {
              this.postVideoSilenceTicks = 0;
              this.postVideoRenegotiateAt = 0;
            }
          }
        }
        // WebAudio can latch silent after a muted-era MediaStreamSource.
        // Never-heard: heal after unmute settle.
        // Post-heard: a brief RMS spike latches heardRemoteMixAudio while the
        // playback graph stays dead — keep healing when RTP is alive and
        // silence persists after lastHeardMixAudioAt (prod: hear spike then
        // forever mute for peers like Zoro).
        //
        // Critical: use ON_RMS (not OFF_RMS) for heal eligibility. Comfort-
        // noise / attenuated mixes sit in the dead zone OFF..ON
        // (prod Vespiol: peakRms≈0.0078 with RTP growing) — OFF_RMS gate
        // never healed and never latched "heard".
        const silenceEligible =
          rms < ON_RMS &&
          !speaking &&
          this.silentMixHealCount <
            TelegramGroupCallWebSession.MAX_SILENT_MIX_HEALS &&
          !this.silentMixHealInFlight &&
          !this.audioRecoverInFlight;
        const unmuteSettled =
          this.remoteAudioUnmutedAt > 0 &&
          now - this.remoteAudioUnmutedAt >= 800;
        const neverHeardSilent =
          silenceEligible &&
          !this.heardRemoteMixAudio &&
          unmuteSettled &&
          (this.mixRtpPacketsAlive ||
            now - this.remoteAudioUnmutedAt >= 1_500);
        const postHeardSilent =
          silenceEligible &&
          this.heardRemoteMixAudio &&
          this.mixRtpPacketsAlive &&
          this.lastHeardMixAudioAt > 0 &&
          now - this.lastHeardMixAudioAt >=
            TelegramGroupCallWebSession.POST_HEARD_SILENCE_MS;
        if (neverHeardSilent || postHeardSilent) {
          this.remoteSilenceTicks += 1;
          const tickNeed = postHeardSilent
            ? TelegramGroupCallWebSession.POST_HEARD_SILENCE_TICKS
            : this.mixRtpPacketsAlive
              ? 8
              : 12;
          if (this.remoteSilenceTicks >= tickNeed) {
            this.remoteSilenceTicks = 0;
            void this.healSilentMixDespiteRtp();
          }
        } else if (
          this.remotePlaybackSink === "webaudio" &&
          rms < ON_RMS &&
          !speaking &&
          !this.heardRemoteMixAudio &&
          !this.remoteAudioStalledAfterVideo
        ) {
          this.remoteSilenceTicks += 1;
          // ~1s never-heard on WebAudio — flip to HTML immediately.
          if (this.remoteSilenceTicks >= 10) {
            this.remoteSilenceTicks = 0;
            void this.switchRemotePlaybackToHtml("remote_rms_silence");
          }
        } else if (
          this.remotePlaybackSink === "html_audio" &&
          this.postVideoRenegotiateAt > 0 &&
          rms < OFF_RMS &&
          !speaking &&
          !this.remoteAudioStalledAfterVideo &&
          !this.audioRecoverAfterVideoDone &&
          !this.audioRecoverInFlight &&
          !this.softSilentVideoCheckInFlight &&
          this.audioRecoverCount <
            TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
        ) {
          // HTML flip after video often stays silent too — escalate via the same
          // mix-RTP probe (do not permanently skip when a screen is painted).
          this.remoteSilenceTicks += 1;
          if (this.remoteSilenceTicks >= 30) {
            const sinceVideoMs = now - this.postVideoRenegotiateAt;
            this.remoteSilenceTicks = 0;
            if (this.hasHealthyRemoteVideoMedia()) {
              void this.evaluateSoftSilentKeepVideo(sinceVideoMs);
            } else {
              this.postVideoRenegotiateAt = 0;
              this.remoteAudioStalledAfterVideo = true;
              logPageDisplay(
                "messages_voice_remote_audio_soft_stalled_after_video",
                {
                  chatId: this.input.chatId,
                  groupCallId: this.input.groupCallId,
                  rms: Number(rms.toFixed(4)),
                  sinceVideoMs,
                  sink: this.remotePlaybackSink,
                  level: "error",
                  note: "HTML sink also silent after video — recover audio-only",
                },
              );
              void this.recoverAudioOnlyAfterVideoStall();
              return;
            }
          }
        } else if (rms >= ON_RMS || speaking) {
          this.remoteSilenceTicks = 0;
        } else {
          // Waiting for POST_HEARD wall-clock / unmute settle — do not latch
          // ticks from a prior path, but also do not treat "already heard"
          // alone as a reason to zero the counter forever.
          if (!silenceEligible || !this.heardRemoteMixAudio) {
            this.remoteSilenceTicks = 0;
          }
        }
      };
      // Interval survives voice_dialog rAF stalls better than requestAnimationFrame.
      this.remoteSpeakingTimer = setInterval(sample, 100);
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      appWarn(
        "[voice-remote-speaking]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
    }
  }

  /** Fall back to unmuted HTML <audio> when WebAudio hears nothing on a live track. */
  private async switchRemotePlaybackToHtml(
    reason: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!this.remoteAudioEnabled) return;
    if (this.remotePlaybackSink === "html_audio" && !opts?.force) return;
    const stream = this.remoteStream;
    if (!stream || stream.getAudioTracks().length === 0) return;
    this.teardownWebAudioPlayback();
    this.remotePlaybackSink = "html_audio";
    const audio = this.ensureRemoteAudioElement();
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.muted = false;
    audio.volume = 1;
    this.applyListenGain();
    try {
      if (audio.paused) await audio.play();
      else await audio.play().catch(() => undefined);
      logPageDisplay("messages_voice_remote_playback_ok", {
        reason,
        sink: "html_audio",
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: this.playbackCtx?.state ?? "none",
        mutedTracks: stream.getAudioTracks().filter((t) => t.muted).length,
        level: "warn",
        note: "switched from webaudio after prolonged remote silence",
      });
    } catch (err) {
      this.armGestureUnmute();
      appWarn("[voice-remote-audio]", err instanceof Error ? err.message : String(err), {
        reason,
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
      });
    }
    // Rebuild the meter on a fresh clone after the sink flip — the prior
    // MediaStreamSource often stays at RMS=0 while HTML audio is hearable.
    this.stopRemoteSpeakingMonitor({ keepSpeaking: true });
    if (stream.getAudioTracks().some((t) => t.readyState === "live" && !t.muted)) {
      this.startRemoteSpeakingMonitor();
    }
  }

  /**
   * Opus RTP is arriving (bytes/packets) but the meter stays at RMS=0 — Chrome
   * often latches a muted-era WebAudio graph. Heal with a dedicated context +
   * unmuted HTML sink; if still dead after retries, audio-only rejoin.
   */
  private async healSilentMixDespiteRtp(): Promise<void> {
    if (this.silentMixHealInFlight || this.audioRecoverInFlight) return;
    if (
      this.silentMixHealCount >= TelegramGroupCallWebSession.MAX_SILENT_MIX_HEALS
    ) {
      return;
    }
    const connection = this.connection;
    if (!connection || !this.joined) return;
    this.silentMixHealInFlight = true;
    try {
      const stats = await this.logIceDiagnostics(
        connection,
        "silent_mix_heal_probe",
      );
      if (stats.inboundPackets >= 10) {
        this.mixRtpPacketsAlive = true;
      }
      // Thin but non-zero counters after video often mean the mix m-line died
      // mid-renegotiate (prod: stuck at inboundPackets=4 while video flooded).
      // Treating <8 as "no RTP yet" skipped heal *and* blocked escalate forever.
      const thinButLikelyFrozen =
        stats.inboundPackets > 0 &&
        stats.inboundPackets < 8 &&
        (this.postVideoRenegotiateAt > 0 ||
          this.lastAppliedRemoteVideoEndpoints.length > 0 ||
          stats.inboundVideoPackets > 30) &&
        (this.heardRemoteMixAudio ||
          this.mixRtpPacketsAlive ||
          this.peakInboundAudioPackets > 15 ||
          stats.inboundVideoPackets > 50);
      if (stats.inboundPackets < 8 && !thinButLikelyFrozen) {
        logPageDisplay("messages_voice_silent_mix_heal_skip", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          inboundPackets: stats.inboundPackets,
          healCount: this.silentMixHealCount,
          level: "info",
          note: "no mix RTP yet — skip heal",
        });
        // After video, a thin/frozen counter usually means the mix m-line died —
        // escalate once even with a live screen; further recovers keep the stage.
        if (
          this.postVideoRenegotiateAt > 0 &&
          this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
          !this.audioRecoverInFlight &&
          !this.shouldSkipRecoverToKeepScreen()
        ) {
          this.remoteAudioStalledAfterVideo = true;
          logPageDisplay("messages_voice_silent_mix_heal_escalate", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            inboundVideoPackets: stats.inboundVideoPackets,
            recoverCount: this.audioRecoverCount,
            level: "error",
            note:
              "post-video mix too thin for heal — one-shot audio recover (screen may resubscribe)",
          });
          void this.recoverAudioOnlyAfterVideoStall();
        } else if (
          this.postVideoRenegotiateAt > 0 &&
          this.shouldSkipRecoverToKeepScreen()
        ) {
          this.preferStableScreencast = true;
          logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            inboundVideoPackets: stats.inboundVideoPackets,
            recoverCount: this.audioRecoverCount,
            level: "warn",
            note: "thin mix after prior recover — keep stage (no recover flicker)",
          });
        }
        return;
      }
      if (thinButLikelyFrozen) {
        logPageDisplay("messages_voice_silent_mix_heal_thin_frozen", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          inboundPackets: stats.inboundPackets,
          inboundVideoPackets: stats.inboundVideoPackets,
          peakInboundAudio: this.peakInboundAudioPackets,
          healCount: this.silentMixHealCount,
          recoverCount: this.audioRecoverCount,
          level: "warn",
          note:
            "thin mix counter with live video — escalate recover instead of skip",
        });
        if (
          this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
          !this.audioRecoverInFlight &&
          !this.shouldSkipRecoverToKeepScreen()
        ) {
          this.remoteAudioStalledAfterVideo = true;
          void this.recoverAudioOnlyAfterVideoStall();
          return;
        }
        if (this.shouldSkipRecoverToKeepScreen()) {
          this.preferStableScreencast = true;
          // Fall through to sink heal when we already recovered once.
        } else {
          return;
        }
      }
      // Stale plateau: packets exist but are not advancing — heal cannot invent RTP.
      // Run even if we already heard mix earlier this join: video SDP often freezes
      // a previously healthy m-line ("worked, then went silent").
      if (
        this.postVideoRenegotiateAt > 0 &&
        this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
        !this.audioRecoverInFlight
      ) {
        await new Promise<void>((resolve) => {
          if (typeof window === "undefined") {
            resolve();
            return;
          }
          window.setTimeout(resolve, 1_200);
        });
        if (this.connection !== connection || !this.joined) return;
        const growthCheck = await this.logIceDiagnostics(
          connection,
          "silent_mix_heal_growth",
        );
        if (growthCheck.inboundPackets <= stats.inboundPackets) {
          const screenAliveDuringHeal =
            growthCheck.inboundVideoPackets > 0 ||
            growthCheck.inboundVideoPackets > stats.inboundVideoPackets ||
            this.hasHealthyRemoteVideoMedia();
          const healthyMixFloor = this.mixCounterLooksHealthyForScreen(
            growthCheck.inboundPackets,
          );
          if (
            screenAliveDuringHeal &&
            healthyMixFloor &&
            growthCheck.inboundPackets > 0
          ) {
            this.preferStableScreencast = true;
            logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundBefore: stats.inboundPackets,
              inboundAfter: growthCheck.inboundPackets,
              inboundVideoPackets: growthCheck.inboundVideoPackets,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              level: "warn",
              note:
                "mix counter paused with live screen — heal sink only (no recover flicker)",
            });
            // Fall through to sink rebuild below.
          } else if (this.shouldSkipRecoverToKeepScreen()) {
            this.preferStableScreencast = true;
            logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundBefore: stats.inboundPackets,
              inboundAfter: growthCheck.inboundPackets,
              inboundVideoPackets: growthCheck.inboundVideoPackets,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              level: "warn",
              note: "mix counter frozen after prior recover — keep stage, continue sink heal",
            });
            // Fall through to sink rebuild below.
          } else {
            this.remoteAudioStalledAfterVideo = true;
            logPageDisplay("messages_voice_silent_mix_heal_escalate", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundBefore: stats.inboundPackets,
              inboundAfter: growthCheck.inboundPackets,
              inboundVideoPackets: growthCheck.inboundVideoPackets,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              level: "error",
              note:
                "mix packet counter frozen after video — one-shot audio recover (screen may resubscribe)",
            });
            void this.recoverAudioOnlyAfterVideoStall();
            return;
          }
        }
      }
      this.silentMixHealCount += 1;
      this.preferHtmlRemotePlayback = true;
      logPageDisplay("messages_voice_silent_mix_heal", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        inboundPackets: stats.inboundPackets,
        outboundPackets: stats.outboundPackets,
        healCount: this.silentMixHealCount,
        sink: this.remotePlaybackSink,
        level: "warn",
        note: "RTP flowing but RMS=0 — rebuild dedicated playback + HTML sink",
      });
      // Refresh outbound — SFU starves mix when outbound=0 (silent OR real mic).
      // Unmute used fire-and-forget replaceTrack; sender can stay on a dead track.
      if (stats.outboundPackets === 0) {
        await resumeSilentOutboundContext();
        await disableAudioSenderDtx(connection);
        try {
          const fresh = this.usingSilentAudio
            ? (() => {
                const t = createSilentAudioTrack();
                t.enabled = true;
                return t;
              })()
            : this.audioTrack && this.audioTrack.readyState === "live"
              ? this.audioTrack
              : null;
          if (fresh) {
            fresh.enabled = true;
            const sender = connection
              .getSenders()
              .find((s) => s.track?.kind === "audio");
            if (sender) {
              await sender.replaceTrack(fresh);
              if (this.usingSilentAudio) {
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
              }
              logPageDisplay("messages_voice_outbound_sender_refresh", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                usingSilentAudio: this.usingSilentAudio,
                micEnabled: this.micEnabled,
                level: "warn",
                note: "outboundPackets=0 — reattached audio sender for SFU mix",
              });
            } else if (this.usingSilentAudio && fresh !== this.audioTrack) {
              try {
                fresh.stop();
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
      }
      this.preferDedicatedPlaybackCtx = true;
      // Skip WebAudio rebuild thrash — go straight to HTML (prod: heal then
      // stall-recover yanked back to silent WebAudio for seconds).
      this.remoteSilenceTicks = 0;
      unlockVoiceAutoplay();
      await this.switchRemotePlaybackToHtml("silent_mix_heal", { force: true });
      // After the last heal attempt, rejoin if the mix counter is still dead —
      // including when we heard audio earlier and video SDP froze it afterward.
      if (
        this.silentMixHealCount >=
          TelegramGroupCallWebSession.MAX_SILENT_MIX_HEALS &&
        this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
      ) {
        await new Promise<void>((resolve) => {
          if (typeof window === "undefined") {
            resolve();
            return;
          }
          window.setTimeout(resolve, 2_000);
        });
        if (
          this.connection !== connection ||
          !this.joined ||
          this.audioRecoverInFlight
        ) {
          return;
        }
        const after = await this.logIceDiagnostics(
          connection,
          "silent_mix_heal_final",
        );
        const mixStillFrozen =
          after.inboundPackets <= stats.inboundPackets ||
          (!this.heardRemoteMixAudio && after.inboundPackets >= 15);
        if (mixStillFrozen) {
          if (this.shouldSkipRecoverToKeepScreen()) {
            this.preferStableScreencast = true;
            logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: after.inboundPackets,
              inboundVideoPackets: after.inboundVideoPackets,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              level: "warn",
              note: "heal failed after prior recover — keep stage (no recover flicker)",
            });
            return;
          }
          this.remoteAudioStalledAfterVideo = true;
          logPageDisplay("messages_voice_silent_mix_recover", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: after.inboundPackets,
            inboundVideoPackets: after.inboundVideoPackets,
            recoverCount: this.audioRecoverCount,
            heardRemoteMixAudio: this.heardRemoteMixAudio,
            level: "error",
            note:
              "heal failed with frozen/stale mix RTP — one-shot audio-only rejoin (screen stays blocked this join)",
          });
          void this.recoverAudioOnlyAfterVideoStall();
        }
      }
    } finally {
      this.silentMixHealInFlight = false;
    }
  }

  /**
   * @param startMuted When true (default), publish silent RTP and mute in TDLib
   * after SDP. When false, acquire a real mic and leave Telegram unmuted — used
   * when the account is already in the call with an open mic (e.g. Desktop).
   */
  async ensureJoinedListenOnly(startMuted = true): Promise<void> {
    if (this.joined) {
      // Stay put while ICE connects — callers used to rejoin on !mediaConnected
      // and freeze the UI with repeated SDP offers.
      return;
    }
    if (this.joining) {
      await this.joining;
      return;
    }
    this.joining = this.joinInternal(startMuted);
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
      // Await sender attach — fire-and-forget left outboundPackets=0 while the
      // chip looked unmuted (SFU then starved the remote mix).
      if (this.connection && this.audioTrack) {
        const sender = this.connection
          .getSenders()
          .find((s) => s.track?.kind === "audio" || s.track === this.audioTrack);
        if (sender && sender.track !== this.audioTrack) {
          try {
            await sender.replaceTrack(this.audioTrack);
          } catch {
            // ignore — chip already flipped; watchdog/heal can retry
          }
        }
        void disableAudioSenderDtx(this.connection);
      }
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
          const pc = this.connection;
          const mediaLive =
            pc != null &&
            (pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed");
          if (mediaLive) {
            // Tear+rejoin while PC is live destroyed inbound audio and left
            // call-message send on GROUPCALL_JOIN_MISSING after a gateway blip.
            this.speakingSyncBlockedUntil = Date.now() + 8_000;
            logPageDisplay("messages_voice_mic_join_missing_soft", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: "keep WebRTC; skip tear-rejoin on transient JOIN_MISSING",
            });
          } else {
            this.markJoinLost(err, { silent: true });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await this.joinInternal(isMuted);
            if (!isMuted) {
              await this.ensureLocalMic({ publish: true, enabled: true });
              if (this.audioTrack) this.audioTrack.enabled = true;
              this.micEnabled = true;
            }
            this.resumeRemoteAudio();
          }
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
    // Listen-only / muted mic: no local speaking to publish — hammering the
    // gateway during join caused 502 + GROUPCALL_JOIN_MISSING storms.
    if (this.usingSilentAudio || !this.micEnabled) return;
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
        const errText = typeof err === "string" ? err : String(err ?? "");
        if (
          errText.includes("GROUPCALL_JOIN_MISSING") ||
          errText.includes("GROUPCALL_FORBIDDEN") ||
          errText.includes("GROUPCALL_INVALID") ||
          errText.includes("502") ||
          errText.includes("Bad Gateway") ||
          errText.includes("gateway")
        ) {
          // Soft-fail while WebRTC is still up — gateway 502 / getGroupCall races
          // used to markJoinLost and then call-message send failed with the same
          // error even though the PC was still connected.
          const pc = this.connection;
          const mediaLive =
            pc != null &&
            (pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed");
          this.speakingSyncBlockedUntil = Date.now() + 60_000;
          if (mediaLive) {
            logPageDisplay("messages_voice_speaking_join_missing_soft", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: "keep joined; block speaking sync 60s",
            });
          } else {
            this.markJoinLost(errText);
          }
        }
      }
    } catch (err) {
      appWarn(
        "[voice-speaking-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
      this.speakingSyncBlockedUntil = Date.now() + 30_000;
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
    if (this.preferDedicatedPlaybackCtx) {
      const shared = getVoiceAutoplayAudioContext();
      if (
        !this.playbackCtx ||
        this.playbackCtx.state === "closed" ||
        (shared != null && this.playbackCtx === shared)
      ) {
        this.playbackCtx = new AudioContext();
      }
      return this.playbackCtx;
    }
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
    try {
      this.playbackGain?.disconnect();
    } catch {
      // ignore
    }
    this.playbackSource = null;
    this.playbackGain = null;
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
   * Mixed SFU track: per-peer volume is applied via TDLib
   * setGroupCallParticipantVolumeLevel (server-side). Scaling the whole
   * GainNode by max(speaking peer %) boosted/ducked everyone when open-mic
   * paint marked Сева@200% (gain=2) or a quiet peer — listen felt wrong.
   * Local GainNode only implements mute-all (every remote at 0%).
   */
  private computeListenGain(): number {
    const keys = this.listenParticipantKeys;
    if (keys.length === 0) return 1;
    const volOf = (key: string) => this.listenVolumes.get(key) ?? 100;
    if (keys.every((key) => volOf(key) <= 0)) {
      // Bad TDLib volume_level→0% on everyone while speech still arrives —
      // keep unity if the mix meter / RTP is live.
      if (
        this.remoteSpeaking ||
        this.heardRemoteMixAudio ||
        this.mixRtpPacketsAlive
      ) {
        return 1;
      }
      return this.listenVolumes.size > 0 ? 0 : 1;
    }
    return 1;
  }

  private applyListenGain(): void {
    const next = this.computeListenGain();
    if (next !== this.playbackGainValue) {
      logPageDisplay("messages_voice_listen_gain", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        gain: Number(next.toFixed(3)),
        prevGain: Number(this.playbackGainValue.toFixed(3)),
        participants: this.listenParticipantKeys.length,
        speaking: this.listenSpeakingKeys.size,
        zeroVolCount: this.listenParticipantKeys.filter(
          (key) => (this.listenVolumes.get(key) ?? 100) <= 0,
        ).length,
        level: next <= 0 ? "warn" : "info",
      });
    }
    this.playbackGainValue = next;
    if (this.playbackGain) {
      try {
        this.playbackGain.gain.value = next;
      } catch {
        // ignore
      }
    }
    // HTMLAudioElement.volume is capped at 1 — still honor mute / attenuate.
    if (this.remoteAudio && this.remotePlaybackSink === "html_audio") {
      this.remoteAudio.volume = Math.min(1, Math.max(0, next));
      this.remoteAudio.muted = next <= 0;
    }
  }

  /**
   * Apply local listen volumes for the mixed remote audio track.
   * Keys must match roster prefs keys; speakingKeys drive ducking while peers talk.
   */
  setParticipantListenVolumes(input: {
    volumes: Record<string, number>;
    speakingKeys?: string[];
    participantKeys?: string[];
  }): void {
    this.listenVolumes = new Map(
      Object.entries(input.volumes).map(([key, value]) => [
        key,
        Math.min(200, Math.max(0, Math.round(Number(value) || 0))),
      ]),
    );
    this.listenSpeakingKeys = new Set(
      (input.speakingKeys ?? []).filter((key) => typeof key === "string" && key.length > 0),
    );
    this.listenParticipantKeys = (input.participantKeys ?? Object.keys(input.volumes)).filter(
      (key) => typeof key === "string" && key.length > 0,
    );
    this.applyListenGain();
  }

  /**
   * Connect remote audio → GainNode → AudioContext.destination (telegram-tt path).
   * Pass force=true after track unmute — Chrome can keep a muted-era source silent.
   */
  private rebuildWebAudioPlayback(force = false): boolean {
    const ctx = this.playbackCtx;
    const stream = this.remoteStream;
    if (!ctx || !stream || stream.getAudioTracks().length === 0) return false;
    const key = this.remoteAudioTrackKey(stream);
    if (!force && this.playbackSource && this.playbackGain && this.playbackTrackKey === key) {
      this.applyListenGain();
      return true;
    }
    try {
      this.teardownWebAudioPlayback();
      // Fresh MediaStream snapshot so createMediaStreamSource sees current tracks.
      const snapshot = new MediaStream(stream.getAudioTracks());
      this.playbackSource = ctx.createMediaStreamSource(snapshot);
      this.playbackGain = ctx.createGain();
      this.playbackGain.gain.value = this.playbackGainValue;
      this.playbackSource.connect(this.playbackGain);
      this.playbackGain.connect(ctx.destination);
      this.playbackTrackKey = key;
      this.applyListenGain();
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
      reason === "pc-connected" ||
      reason === "post-video-renegotiate" ||
      reason === "post-video-audio-check" ||
      reason === "post-video-soft-silent" ||
      reason === "silent-mix-heal" ||
      reason === "visibility-resume";

    // Prefer HTML for instant hearable mix. Never yank HTML→WebAudio after a
    // silence heal or while preferHtml is set (prod: mix-energy-first /
    // stall-recover re-latched silent WebAudio for many seconds).
    const stickHtml =
      this.preferHtmlRemotePlayback ||
      this.preferDedicatedPlaybackCtx ||
      this.silentMixHealCount > 0 ||
      (this.remotePlaybackSink === "html_audio" &&
        (this.heardRemoteMixAudio || reason === "stall-recover"));
    const keepHtmlSilenceFallback =
      this.remotePlaybackSink === "html_audio" &&
      (this.silentMixHealCount > 0 ||
        this.preferDedicatedPlaybackCtx ||
        this.preferHtmlRemotePlayback ||
        this.heardRemoteMixAudio);
    if (
      stickHtml ||
      keepHtmlSilenceFallback ||
      (this.remotePlaybackSink === "html_audio" && !forceRebuild) ||
      reason === "silent_mix_heal" ||
      reason === "silent-mix-heal" ||
      reason === "remote_rms_silence" ||
      reason === "mix-energy-first"
    ) {
      const audio = this.ensureRemoteAudioElement();
      if (audio.srcObject !== stream) {
        audio.srcObject = stream;
      }
      audio.muted = false;
      audio.volume = 1;
      this.remotePlaybackSink = "html_audio";
      this.preferHtmlRemotePlayback = true;
      this.applyListenGain();
      try {
        if (audio.paused) await audio.play().catch(() => undefined);
      } catch {
        // ignore
      }
      if (stream.getAudioTracks().some((t) => t.readyState === "live" && !t.muted)) {
        this.startRemoteSpeakingMonitor();
      }
      if (
        reason === "track-attach" ||
        reason === "track-unmute" ||
        reason === "ice-connected" ||
        reason === "pc-connected" ||
        reason === "resume" ||
        reason === "unlock"
      ) {
        logPageDisplay("messages_voice_remote_playback_ok", {
          reason,
          sink: "html_audio",
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          tracks: stream.getAudioTracks().length,
          ctxState: ctx?.state ?? "none",
          mutedTracks: stream.getAudioTracks().filter((t) => t.muted).length,
          level: "info",
          note: "html_first_instant_hear",
        });
      }
      return;
    }
    if (forceRebuild) {
      this.remotePlaybackSink = "webaudio";
      this.remoteSilenceTicks = 0;
    }

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
      this.remotePlaybackSink = "webaudio";
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
      if (stream.getAudioTracks().some((t) => t.readyState === "live" && !t.muted)) {
        this.startRemoteSpeakingMonitor();
      }
      return;
    }

    audio.muted = false;
    audio.volume = 1;
    this.remotePlaybackSink = "html_audio";
    this.applyListenGain();
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
      this.remoteAudioUnmutedAt = Date.now();
      this.markRemoteAudioSettledForVideo();
      // Chrome can keep a MediaStreamSource silent if it was built while muted.
      // Force rebuild via playback reason — do not tear down here and race the
      // queued ensure (watchdog used to leave a gap with no sink).
      this.queueRemotePlayback("track-unmute");
      this.stopRemoteSpeakingMonitor();
      this.startRemoteSpeakingMonitor();
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

  /**
   * Force remote playback rebuild after main-thread stalls / tab focus.
   * Safe to call repeatedly — queue coalesces.
   */
  kickRemotePlayback(reason: string = "stall-recover"): void {
    if (!this.joined || typeof document === "undefined") return;
    this.ensureRemoteStream();
    // Do not rebuild WebAudio on UI freezes when HTML is already the sink —
    // stall-recover storms re-latched silence and burned the main thread.
    if (
      this.preferHtmlRemotePlayback ||
      this.remotePlaybackSink === "html_audio" ||
      this.silentMixHealCount > 0 ||
      this.heardRemoteMixAudio
    ) {
      const stream = this.remoteStream;
      const audio = this.ensureRemoteAudioElement();
      if (stream && audio.srcObject !== stream) {
        audio.srcObject = stream;
      }
      audio.muted = false;
      this.remotePlaybackSink = "html_audio";
      this.preferHtmlRemotePlayback = true;
      this.applyListenGain();
      void audio.play().catch(() => undefined);
      if (
        stream?.getAudioTracks().some((t) => t.readyState === "live" && !t.muted)
      ) {
        this.startRemoteSpeakingMonitor();
      }
      return;
    }
    const ctx = this.ensurePlaybackContext();
    void ctx?.resume().catch(() => undefined);
    this.queueRemotePlayback(reason);
  }

  private installVisibilityPlaybackKick(): void {
    if (typeof document === "undefined" || this.visibilityPlaybackCleanup) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (!this.joined || !this.remoteAudioEnabled) return;
      this.kickRemotePlayback("visibility-resume");
    };
    document.addEventListener("visibilitychange", onVis);
    this.visibilityPlaybackCleanup = () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }

  private uninstallVisibilityPlaybackKick(): void {
    this.visibilityPlaybackCleanup?.();
    this.visibilityPlaybackCleanup = null;
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
    // Keep audioRecoverAfterVideoDone / audioRecoverCount / iceRecoverCount across
    // recover rejoins — ICE recover and dispose own those resets. Screen SDP stays
    // blocked via remoteVideoSdpBlockedAfterStall for the rest of this join.
    this.audioRecoverInFlight = false;
    this.postVideoRenegotiateAt = 0;
    this.postVideoSilenceTicks = 0;

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
        // Fail fast into silent rejoin — waiting out disconnected→failed just
        // leaves the user in a dead call after they already heard the mix.
        void this.recoverFromIceFailure(`ice_${ice}`);
        return;
      }
      if (ice === "disconnected") {
        void this.logIceDiagnostics(connection, "ice_disconnected");
        void resumeSilentOutboundContext();
        this.queueRemotePlayback("ice-disconnected");
        // Shorter grace than before — consent rarely returns once pairsSucceeded=0.
        this.scheduleJoinLostIfStillBroken(connection, "ice_disconnected", 5_000);
        return;
      }
      this.clearJoinLostTimer();
      if (ice === "connected" || ice === "completed") {
        this.pullRemoteMediaTracks(connection, { audioOnly: true });
        unlockVoiceAutoplay();
        void resumeSilentOutboundContext();
        this.queueRemotePlayback("ice-connected");
        this.tryArmRemoteVideoSdpAfterHealthyMix();
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
        this.tryArmRemoteVideoSdpAfterHealthyMix();
      } else if (state === "failed") {
        void this.recoverFromIceFailure(`pc_${state}`);
      } else if (state === "disconnected") {
        this.scheduleJoinLostIfStillBroken(connection, `pc_${state}`, 5_000);
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

    // Strip Docker/WSL bridge host candidates so Chrome does not nominate a
    // pair that dies on consent freshness after a brief audio blip.
    const rawLocal = connection.localDescription;
    if (rawLocal?.sdp) {
      const filtered = stripUnusableLocalIceCandidates(rawLocal.sdp);
      if (filtered !== rawLocal.sdp) {
        try {
          await connection.setLocalDescription({
            type: rawLocal.type,
            sdp: filtered,
          });
          logPageDisplay("messages_voice_ice_local_filter", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            before: (rawLocal.sdp.match(/a=candidate:/g) ?? []).length,
            after: (filtered.match(/a=candidate:/g) ?? []).length,
            level: "info",
            note: "dropped docker/link-local local ICE candidates",
          });
        } catch (err) {
          appWarn(
            "[voice-ice-local-filter]",
            err instanceof Error ? err.message : String(err),
            { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
          );
        }
      }
    }

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
    this.heardRemoteMixAudio = false;
    this.lastHeardMixAudioAt = 0;
    this.mixRtpPacketsAlive = false;
    this.peakInboundAudioPackets = 0;
    this.installVisibilityPlaybackKick();
    this.remoteAudioUnmutedAt = 0;
    this.silentMixHealInFlight = false;
    this.silentMixHealCount = 0;
    this.preferDedicatedPlaybackCtx = false;
    this.preferHtmlRemotePlayback = true;
    this.remoteAudioSettleRetryCount = 0;
    this.remotePlaybackSink = "html_audio";
    this.remoteSilenceTicks = 0;
    this.remoteAudioSettleExtended = false;
    this.remoteAudioSettlePacketsAtExtend = 0;
    this.softSilentVideoCheckInFlight = false;
    this.micEnabled = !startMuted;
    if (!startMuted) {
      logPageDisplay("messages_voice_join_preserve_unmuted", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        level: "info",
        note: "skipped listen-mute — account already unmuted in call",
      });
    }

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
      // Apply SDP while still joined even if the sheet is minimized/docked
      // (data-voice-dialog="closed"). Leaving the call clears this.joined first.
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
        this.joinAnswerSdp = answerSdp;
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
          // flowed. Skipped when startMuted=false (preserve already-open mic).
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
          // Outbound silent RTP stuck at 0 — refresh sender + DTX so the SFU
          // accepts the listen-only participant. Do NOT replaceTrack just because
          // inbound is still 0 (remote often stays muted until SFU forwards); that
          // churn correlated with ICE flaps after a healthy outbound trickle.
          if (
            this.isMediaConnected() &&
            this.usingSilentAudio &&
            stats.outboundPackets === 0
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
                    inboundPackets: stats.inboundPackets,
                    outboundPackets: stats.outboundPackets,
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
        // Kick autoplay / resume while ICE settles. Do not teardown WebAudio here
        // — repeated muted-era rebuilds race track-unmute force-rebuild and leave
        // a silent graph. Unmute / ice-connected already force-rebuild.
        if (tracks.some((t) => t.muted) || !this.isMediaConnected()) {
          unlockVoiceAutoplay();
          void resumeSilentOutboundContext();
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
      if (
        this.requestedRemoteVideo.length > 0 &&
        this.remoteVideoByEndpoint.size > 0
      ) {
        void this.healLowFpsRemoteVideo(connection);
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
      // WebAudio graph can look "live" (source+running ctx) while the meter
      // never crosses ON_RMS — comfort-noise dead zone with growing RTP.
      // Kick silent-mix heal instead of no-op returning (prod: Vespiol).
      if (hasTracks && !anyMuted && (webAudioLive || htmlLive)) {
        if (
          !this.heardRemoteMixAudio &&
          this.mixRtpPacketsAlive &&
          this.remoteAudioUnmutedAt > 0 &&
          Date.now() - this.remoteAudioUnmutedAt >= 1_200 &&
          this.silentMixHealCount <
            TelegramGroupCallWebSession.MAX_SILENT_MIX_HEALS &&
          !this.silentMixHealInFlight &&
          !this.audioRecoverInFlight
        ) {
          logPageDisplay("messages_voice_playback_watchdog", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            ice,
            conn: connection.connectionState,
            remoteTracks: tracks.length,
            remoteMuted: anyMuted,
            webAudioLive,
            htmlLive,
            heardRemoteMixAudio: false,
            mixRtpPacketsAlive: true,
            level: "warn",
            note: "graph live but never heard mix — silent-mix heal",
          });
          void this.healSilentMixDespiteRtp();
        }
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

  /**
   * Screencast painted but decode ~1fps (frozen stage): wrong Colibri height
   * rung or stale constraints. Re-send Full(720) constraints a few times.
   */
  private async healLowFpsRemoteVideo(
    connection: RTCPeerConnection,
  ): Promise<void> {
    if (this.connection !== connection || !this.joined) return;
    if (
      !this.remoteVideoSdpSubscribeEnabled ||
      this.remoteVideoSdpBlockedAfterStall
    ) {
      return;
    }
    const now = Date.now();
    if (now - this.lastVideoFpsCheckAt < 3_500) return;
    this.lastVideoFpsCheckAt = now;
    const stats = await this.logIceDiagnostics(connection, "video_fps_watch");
    if (this.connection !== connection || !this.joined) return;
    const prev = this.lastVideoFramesDecoded;
    const decoded = stats.framesDecoded;
    this.lastVideoFramesDecoded = decoded;
    if (prev <= 0) return;
    const growth = decoded - prev;
    // Healthy screen is well above ~1fps; 3.5s window → expect ≥8 frames.
    if (growth >= 8) {
      this.videoLowFpsConstraintRetries = 0;
      return;
    }
    if (this.videoLowFpsConstraintRetries >= 4) return;
    this.videoLowFpsConstraintRetries += 1;
    logPageDisplay("messages_voice_remote_video_low_fps", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      framesDecoded: decoded,
      growth,
      inboundVideoPackets: stats.inboundVideoPackets,
      attempt: this.videoLowFpsConstraintRetries,
      maxHeight: GROUP_CALL_VIDEO_MAX_HEIGHT,
      level: "warn",
      note: "stage decode ~1fps — refresh Colibri Full(720) constraints",
    });
    this.sendReceiverVideoConstraints();
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog != null) {
      window.clearInterval(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
  }

  dispose(): void {
    this.stopSpeakingMonitor();
    this.stopRemoteSpeakingMonitor();
    this.clearPlaybackWatchdog();
    this.clearJoinLostTimer();
    this.clearVideoRenegotiateConnectWait();
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.remotePlaybackSink = "html_audio";
    this.preferHtmlRemotePlayback = true;
    this.remoteSilenceTicks = 0;
    this.heardRemoteMixAudio = false;
    this.lastHeardMixAudioAt = 0;
    this.mixRtpPacketsAlive = false;
    this.peakInboundAudioPackets = 0;
    this.remoteAudioUnmutedAt = 0;
    this.silentMixHealInFlight = false;
    this.silentMixHealCount = 0;
    this.preferDedicatedPlaybackCtx = false;
    this.remoteAudioSettleRetryCount = 0;
    this.uninstallVisibilityPlaybackKick();
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
    this.joinAnswerSdp = null;
    this.videoPayloadTypes = [];
    this.videoExtensions = [];
    this.dataChannel = null;
    this.videoRecvSlots = [];
    this.requestedRemoteVideo = [];
    this.lastAppliedRemoteVideoKey = "";
    this.lastAppliedRemoteVideoEndpoints = [];
    this.clearVideoRenegotiateConnectWait();
    this.clearVideoRenegotiateAudioWait();
    this.remoteAudioSettledForVideo = false;
    this.remoteAudioSettleArmed = false;
    this.remoteAudioSettleExtended = false;
    this.remoteAudioSettlePacketsAtExtend = 0;
    this.remoteAudioSettleRetryCount = 0;
    this.remoteAudioStalledAfterVideo = false;
    this.remoteVideoSdpSubscribeEnabled = false;
    this.remoteVideoSdpBlockedAfterStall = false;
    this.audioRecoverAfterVideoDone = false;
    this.audioRecoverInFlight = false;
    this.audioRecoverCount = 0;
    this.iceRecoverInFlight = false;
    this.iceRecoverCount = 0;
    this.preferStableScreencast = false;
    this.softSilentVideoCheckInFlight = false;
    this.lastVideoFramesDecoded = 0;
    this.lastVideoFpsCheckAt = 0;
    this.videoLowFpsConstraintRetries = 0;
    this.postVideoRenegotiateAt = 0;
    this.postVideoSilenceTicks = 0;
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    this.videoResubscribeAfterRecoverAttempts = 0;
    this.pendingRemoteVideoAfterRecover = [];
    this.postVideoRenegotiateAt = 0;
    this.postVideoSilenceTicks = 0;
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
