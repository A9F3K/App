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
import { logPageDisplay } from "../pageDisplayLog";
import { joinTelegramChatVoice } from "./joinTelegramChatVoice";
import {
  endTelegramChatVoiceScreenShare,
  startTelegramChatVoiceScreenShare,
} from "./telegramChatVoiceScreenShare";
import { setTelegramChatVoiceMicMuted } from "./setTelegramChatVoiceMicMuted";
import { setTelegramChatVoiceSpeaking } from "./setTelegramChatVoiceSpeaking";
import { getVoiceAutoplayAudioContext, unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

/**
 * Match telegram-tt / tgcalls Full quality rungs (180 / 360 / 720 only).
 * Non-standard heights (e.g. 480) leave Colibri without a simulcast layer match —
 * prod forwarded 1080p at ~1fps so the stage looked frozen while currentTime ticked.
 */
const GROUP_CALL_VIDEO_MAX_HEIGHT = 720;
/** Softer rung after a Colibri mix stall — still a tgcalls simulcast step. */
const GROUP_CALL_VIDEO_MAX_HEIGHT_AFTER_STALL = 360;
/**
 * STUN so the join payload includes a public srflx address. Host-only LAN
 * candidates (192.168/10/172.16) are unreachable from Telegram's SFU — without
 * srflx, ICE stays in "checking" with inboundPackets=0 until conn=failed
 * (prod Vespiol: pairsSucceeded=0, ice_recover → join_timeout). Docker/Hyper-V
 * hosts are still stripped via {@link stripUnusableLocalIceCandidates}.
 */
const GROUP_CALL_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
/** Budget for host + STUN srflx (listen-only used to abort at 600ms). */
const GROUP_CALL_ICE_GATHER_MS = 2_200;

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
  /** True when presentation audio is getDisplayMedia system audio (not silent). */
  private presentationAudioIsSystem = false;
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
   * One soft restartIce() while local screen is up before tearing down the voice
   * PC. Screen upload often flakes consent (pairsSucceeded→0) without needing a
   * full rejoin that also interrupts presentation.
   */
  private iceSoftRestartAttempted = false;
  private static readonly ICE_DISCONNECT_GRACE_MS = 5_000;
  private static readonly ICE_DISCONNECT_GRACE_SCREEN_MS = 14_000;
  private static readonly ICE_SOFT_RESTART_GRACE_MS = 8_000;
  /** Temporarily ease presentation bitrate so voice ICE consent can recover. */
  private screenShareIceProtect = false;
  /** Presentation PC died while getDisplayMedia track is still live — rejoin only. */
  private presentationRecoverInFlight = false;
  private presentationIceDisconnectTimer: ReturnType<typeof setTimeout> | null =
    null;
  /**
   * Screencast painted this join. After the *first* audio-only recover, refuse
   * further recovers while this is set — recover↔resubscribe flickered the
   * stage on/off. The first recover is still allowed with a live screen because
   * sink heal cannot unfreeze a dead mix m-line (inboundPackets stuck, rms=0).
   */
  private preferStableScreencast = false;
  /** Wall clock when the last full remote-video renegotiate succeeded (soft-stall watch). */
  private postVideoRenegotiateAt = 0;
  /**
   * First remote video frameDecoded > 0 this subscribe. Mix getStats often
   * plateaus while H264 is still painting — do not mix-protect-drop yet.
   */
  private firstRemoteVideoFrameAt = 0;
  /**
   * One-shot: after mix-protect dropped an explicit/auto-shown screen, restore
   * once mix is healthy again (avoids permanent "screen turned off").
   */
  private mixProtectScreenAutoRestorePending = false;
  private mixProtectScreenAutoRestoreUsed = false;
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
  /**
   * Endpoints dropped to protect mix audio. VoiceBar treats these as screen-
   * muted for subscribe/UI until {@link preferExplicitRemoteVideoSubscribe}.
   */
  private mixPausedScreenEndpoints: string[] = [];
  private mixPausedScreenListeners = new Set<(endpoints: string[]) => void>();
  /** Local share (or similar) asked to re-arm remote screen once mix is healthy. */
  private preferExplicitWhenMixHealthyPending = false;
  private preferExplicitWhenMixHealthyTimer: ReturnType<typeof setTimeout> | null =
    null;
  private videoResubscribeAfterRecoverTimer: ReturnType<typeof setTimeout> | null =
    null;
  private videoResubscribeAfterRecoverAttempts = 0;
  /**
   * How many times we dropped remote video SDP to unstick the mix this join.
   * First two drops keep one screen pending for auto-restore; further drops
   * stay audio-only until an explicit menu unmute (don't loop forever).
   */
  private videoDropToRestoreMixCount = 0;
  /** Mix inbound packet count when video was last dropped (growth gate for restore). */
  private mixPacketsAtLastVideoDrop = 0;
  /** Wall clock when video SDP was last dropped to restore mix. */
  private lastVideoDropToRestoreMixAt = 0;
  /**
   * Menu unmute arms this before React prefs → VoiceBar requests arrive.
   * Without it, preferExplicit ran with empty restore and sticky block won.
   * Cleared once SDP is enabled; use {@link explicitVideoSubscribeSession}
   * for settle floors (auto vs explicit).
   */
  private explicitVideoSubscribeArmed = false;
  /**
   * Latched for the whole join after preferExplicit / auto-show. Settle gates
   * used to read Armed after it was cleared and treated auto-show as the
   * stricter auto path (explicit=false in logs → delayed / thin refuse).
   */
  private explicitVideoSubscribeSession = false;
  /** Prefer this screen endpoint on the next subscribe (2nd unmute under cap_1). */
  private preferredExplicitVideoEndpointId: string | null = null;
  /**
   * In-place strip of remote video m-lines (no PC teardown). Full rejoin after
   * a freeze often left inboundPackets=0 — both A/V dead.
   */
  private stripVideoInFlight = false;
  /** Screen/camera requests to restore after audio-only recover (needs full ssrcGroups). */
  private pendingRemoteVideoAfterRecover: TelegramRemoteVideoRequest[] = [];
  /**
   * One automatic remote-video restore after a mix stall per join. A second
   * stall stays audio-only until the user unmutes (avoids drop↔resub loops).
   */
  private autoResubAfterMixStallUsed = false;
  /** Bumped when VoiceBar must re-push roster video requests (sig would otherwise stick). */
  private remoteVideoRepushEpoch = 0;
  private remoteVideoRepushListeners = new Set<(epoch: number) => void>();
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
  /** Bumped to cancel an in-flight joinInternal (watchdog timeout / retry). */
  private joinEpoch = 0;
  /** PeerConnection owned by joinInternal before `this.joined` flips true. */
  private pendingJoinConnection: RTCPeerConnection | null = null;
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
  /**
   * Retry unmute after Telegram "Can't unmute user" / gateway 502 — do NOT swap
   * to silent outbound (that left the chip open with nobody hearing the mic).
   */
  private unmuteRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private unmuteRetryCount = 0;
  private static readonly MAX_UNMUTE_RETRIES = 4;
  /** Latest mic intent — coalesce rapid mute/unmute clicks into one apply. */
  private micDesiredEnabled: boolean | null = null;
  private micApplyChain: Promise<void> = Promise.resolve();
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

  /** True while joinInternal is awaiting SDP / joinVideoChat. */
  get isJoining(): boolean {
    return this.joining != null;
  }

  get chatId(): number {
    return this.input.chatId;
  }

  get groupCallId(): number | null {
    return this.input.groupCallId;
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

  /**
   * Voice or presentation transport is interrupted / recovering — UI should
   * show "Connection establishing" on screen/video tiles.
   */
  isMediaReconnecting(): boolean {
    if (this.isVoiceReconnecting()) return true;
    if (this.presentationRecoverInFlight) return true;
    if (this.screenSharing && !this.isScreenShareTransportHealthy()) {
      return true;
    }
    return false;
  }

  /**
   * Voice PC / ICE recover only — flash mic undercover and play reconnect ticks
   * instead of broken remote audio (do not mute mix for presentation-only recover).
   */
  isVoiceReconnecting(): boolean {
    if (this.iceRecoverInFlight || this.audioRecoverInFlight) {
      return true;
    }
    const pc = this.connection;
    if (!pc) {
      return this.iceRecoverInFlight;
    }
    if (!this.joined) return false;
    if (this.isMediaConnected() || this.isNegotiating()) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "disconnected" ||
      ice === "failed" ||
      conn === "disconnected" ||
      conn === "failed"
    );
  }

  /** True when local screencast track is live and presentation ICE looks usable. */
  isScreenShareTransportHealthy(): boolean {
    if (!this.screenSharing) return true;
    if (!this.screenTrack || this.screenTrack.readyState !== "live") {
      return false;
    }
    const pc = this.presentationConnection;
    if (!pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "connected" ||
      ice === "completed" ||
      ice === "checking" ||
      ice === "new" ||
      conn === "connected" ||
      conn === "connecting" ||
      conn === "new"
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

  /**
   * Fired when the session cleared remote video (mix stall / recover) or armed
   * an explicit unmute with an empty request list — VoiceBar must re-apply
   * roster publishers (request sig often unchanged).
   */
  onRemoteVideoRepushNeeded(listener: (epoch: number) => void): () => void {
    this.remoteVideoRepushListeners.add(listener);
    listener(this.remoteVideoRepushEpoch);
    return () => {
      this.remoteVideoRepushListeners.delete(listener);
    };
  }

  /**
   * Screencast endpoints paused after mix-protect drop. Empty after explicit
   * unmute / local-share re-arm.
   */
  onMixPausedScreensChange(
    listener: (endpoints: string[]) => void,
  ): () => void {
    this.mixPausedScreenListeners.add(listener);
    listener([...this.mixPausedScreenEndpoints]);
    return () => {
      this.mixPausedScreenListeners.delete(listener);
    };
  }

  getMixPausedScreenEndpoints(): string[] {
    return [...this.mixPausedScreenEndpoints];
  }

  private setMixPausedScreenEndpoints(endpoints: string[]): void {
    const next = [
      ...new Set(
        endpoints
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter(Boolean),
      ),
    ];
    const prevKey = this.mixPausedScreenEndpoints.join("|");
    const nextKey = next.join("|");
    if (prevKey === nextKey) return;
    this.mixPausedScreenEndpoints = next;
    for (const listener of this.mixPausedScreenListeners) {
      try {
        listener([...next]);
      } catch {
        // ignore
      }
    }
  }

  private bumpRemoteVideoRepush(reason: string): void {
    this.remoteVideoRepushEpoch += 1;
    logPageDisplay("messages_voice_remote_video_repush", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      epoch: this.remoteVideoRepushEpoch,
      reason,
      level: "info",
      note: "VoiceBar should re-apply roster video requests",
    });
    for (const listener of this.remoteVideoRepushListeners) {
      try {
        listener(this.remoteVideoRepushEpoch);
      } catch {
        // ignore
      }
    }
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
   * of the join after a stall recover (auto-resub of screen re-froze mix audio).
   */
  /**
   * Local share (or similar) wants remote screens re-armed, but only after mix
   * RTP is hearable — immediate preferExplicit after recover re-froze Opus.
   */
  private schedulePreferExplicitWhenMixHealthy(reason: string): void {
    if (
      this.heardRemoteMixAudio &&
      this.mixRtpPacketsAlive &&
      this.isMediaConnected()
    ) {
      this.preferExplicitWhenMixHealthyPending = false;
      if (this.preferExplicitWhenMixHealthyTimer) {
        clearTimeout(this.preferExplicitWhenMixHealthyTimer);
        this.preferExplicitWhenMixHealthyTimer = null;
      }
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: this.remoteVideoSdpSubscribeEnabled,
        requested: this.requestedRemoteVideo.length,
        reason,
        level: "info",
        note: "prefer explicit remote video — mix already healthy",
      });
      this.preferExplicitRemoteVideoSubscribe();
      return;
    }
    this.preferExplicitWhenMixHealthyPending = true;
    if (this.preferExplicitWhenMixHealthyTimer) {
      clearTimeout(this.preferExplicitWhenMixHealthyTimer);
    }
    logPageDisplay("messages_voice_remote_video_sdp_gate", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      enabled: this.remoteVideoSdpSubscribeEnabled,
      requested: this.requestedRemoteVideo.length,
      heardRemoteMixAudio: this.heardRemoteMixAudio,
      mixRtpPacketsAlive: this.mixRtpPacketsAlive,
      mediaConnected: this.isMediaConnected(),
      reason,
      level: "info",
      note: "defer prefer explicit remote video until mix healthy",
    });
    this.preferExplicitWhenMixHealthyTimer = setTimeout(() => {
      this.preferExplicitWhenMixHealthyTimer = null;
      this.maybeFlushPreferExplicitWhenMixHealthy();
    }, 2_500);
  }

  private maybeFlushPreferExplicitWhenMixHealthy(): void {
    if (!this.preferExplicitWhenMixHealthyPending) return;
    if (!this.joined) return;
    if (
      !this.heardRemoteMixAudio ||
      !this.mixRtpPacketsAlive ||
      !this.isMediaConnected()
    ) {
      if (this.preferExplicitWhenMixHealthyTimer) return;
      this.preferExplicitWhenMixHealthyTimer = setTimeout(() => {
        this.preferExplicitWhenMixHealthyTimer = null;
        this.maybeFlushPreferExplicitWhenMixHealthy();
      }, 1_500);
      return;
    }
    this.preferExplicitWhenMixHealthyPending = false;
    if (this.preferExplicitWhenMixHealthyTimer) {
      clearTimeout(this.preferExplicitWhenMixHealthyTimer);
      this.preferExplicitWhenMixHealthyTimer = null;
    }
    logPageDisplay("messages_voice_remote_video_sdp_gate", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      enabled: this.remoteVideoSdpSubscribeEnabled,
      requested: this.requestedRemoteVideo.length,
      level: "info",
      note: "mix healthy — flush deferred prefer explicit remote video",
    });
    this.preferExplicitRemoteVideoSubscribe();
  }

  /**
   * Video SDP opens only after {@link preferExplicitRemoteVideoSubscribe}
   * (participant menu unmute). Auto-arm on healthy mix freezes Colibri Opus
   * (prod: attach → inboundPackets flat → strip → audio recover).
   */
  private canArmExplicitRemoteVideoSdp(): boolean {
    if (!this.explicitVideoSubscribeArmed) return false;
    if (!this.joined) return false;
    // Menu unmute after mix recover: media-connected is enough (RMS may be quiet).
    if (this.isMediaConnected()) return true;
    if (this.mixRtpPacketsAlive || this.heardRemoteMixAudio) return true;
    return this.mixRecentlyHearableForScreenProtect(12_000);
  }

  /**
   * User unmuted a screencast in the participant menu (or started local share
   * while remotes are publishing). Clears a prior stall sticky-block and arms
   * video SDP; optional endpoint wins over cap_1 sticky on the first share.
   */
  preferExplicitRemoteVideoSubscribe(preferredEndpointId?: string | null): void {
    const preferred =
      typeof preferredEndpointId === "string" && preferredEndpointId.trim()
        ? preferredEndpointId.trim()
        : null;
    if (preferred) {
      this.preferredExplicitVideoEndpointId = preferred;
    }
    this.preferExplicitWhenMixHealthyPending = false;
    if (this.preferExplicitWhenMixHealthyTimer) {
      clearTimeout(this.preferExplicitWhenMixHealthyTimer);
      this.preferExplicitWhenMixHealthyTimer = null;
    }
    if (this.mixProtectScreenAutoRestorePending) {
      this.mixProtectScreenAutoRestorePending = false;
      this.mixProtectScreenAutoRestoreUsed = true;
    }
    // Explicit unmute / local-share re-arm clears mix-protect pause list.
    if (this.mixPausedScreenEndpoints.length > 0) {
      this.setMixPausedScreenEndpoints([]);
    }
    this.explicitVideoSubscribeArmed = true;
    this.explicitVideoSubscribeSession = true;
    // Menu unmute always gets another SDP chance after drop↔recover spirals.
    this.videoDropToRestoreMixCount = 0;
    this.audioRecoverAfterVideoDone = false;
    this.videoResubscribeAfterRecoverAttempts = 0;
    this.autoResubAfterMixStallUsed = false;
    if (this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo) {
      this.remoteVideoSdpBlockedAfterStall = false;
      this.remoteAudioStalledAfterVideo = false;
      this.preferStableScreencast = true;
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: this.remoteVideoSdpSubscribeEnabled,
        requested: this.requestedRemoteVideo.length,
        preferred: preferred,
        level: "info",
        note: "explicit unmute cleared sticky video SDP block",
      });
    } else {
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: this.remoteVideoSdpSubscribeEnabled,
        requested: this.requestedRemoteVideo.length,
        preferred: preferred,
        level: "info",
        note: "explicit unmute armed — await VoiceBar screen request",
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
      let pending = this.pendingRemoteVideoAfterRecover;
      this.pendingRemoteVideoAfterRecover = [];
      if (preferred) {
        const hit = pending.find((r) => r.endpointId === preferred);
        if (hit) pending = [hit];
      }
      this.setRequestedRemoteVideos(pending);
    } else if (
      this.requestedRemoteVideo.length > 0 &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      this.queueRemoteVideoRenegotiation();
    } else {
      // Roster still has publishers but request sig is sticky — force VoiceBar.
      this.bumpRemoteVideoRepush("explicit_unmute_await_roster");
    }
  }

  setRemoteVideoSdpEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    // Hard gate: never open remote video m-lines without menu unmute.
    // VoiceBar may still push screen requests from stale prefs / old builds.
    if (next && !this.explicitVideoSubscribeArmed) {
      logPageDisplay("messages_voice_remote_video_sdp_gate", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        enabled: false,
        requested: this.requestedRemoteVideo.length,
        level: "warn",
        note:
          this.remoteVideoSdpBlockedAfterStall || this.remoteAudioStalledAfterVideo
            ? "refuse video SDP — mix stalled earlier this join; audio-only"
            : "refuse video SDP — opt-in unmute required (protect mix audio)",
      });
      return;
    }
    if (next && this.explicitVideoSubscribeArmed) {
      this.remoteVideoSdpBlockedAfterStall = false;
      this.remoteAudioStalledAfterVideo = false;
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
    const normalizedRaw = requests
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
    // Safety net: Colibri mix Opus stalls when screen+camera m-lines attach
    // together. Prefer one screen (else one camera). Explicit 2nd unmute may
    // name a preferred endpoint so cap_1 does not stick on the first share.
    const screens = normalizedRaw.filter((r) => r.kind === "screen");
    const preferredId = this.preferredExplicitVideoEndpointId;
    let normalized =
      screens.length > 0 ? screens.slice(0, 1) : normalizedRaw.slice(0, 1);
    if (preferredId && screens.length > 0) {
      const preferredScreen = screens.find((r) => r.endpointId === preferredId);
      if (preferredScreen) {
        normalized = [preferredScreen];
      }
    }
    if (this.explicitVideoSubscribeArmed && normalized.length > 0) {
      this.remoteVideoSdpBlockedAfterStall = false;
      this.remoteAudioStalledAfterVideo = false;
      this.videoDropToRestoreMixCount = 0;
    }
    // Soft roster handling lives in MessageChatVoiceBar (short sticky window).
    // Do not ignore empty clears here — a stopped share leaves readyState=live
    // (often muted) and sticky_keep kept the tile on stage forever.
    const nextKey = this.remoteVideoKeyOf(normalized);
    const prevKey = this.remoteVideoKeyOf(this.requestedRemoteVideo);
    // Identical request while settle/renegotiate is pending — do not re-queue
    // (re-queue restarted the audio-settle timer and delayed the screencast).
    // Exception: menu unmute while sticky block only applied constraints —
    // same endpoint must force a real video SDP now that we are armed.
    if (nextKey === prevKey) {
      if (
        normalized.length > 0 &&
        this.explicitVideoSubscribeArmed &&
        this.canArmExplicitRemoteVideoSdp()
      ) {
        this.lastAppliedRemoteVideoKey = "";
        // Enable while still armed — setRemoteVideoSdpEnabled hard-gates on it.
        if (!this.remoteVideoSdpSubscribeEnabled) {
          this.setRemoteVideoSdpEnabled(true);
        } else {
          this.queueRemoteVideoRenegotiation();
        }
        this.explicitVideoSubscribeArmed = false;
        return;
      }
      if (
        normalized.length > 0 &&
        !this.remoteVideoSdpSubscribeEnabled &&
        this.canArmExplicitRemoteVideoSdp()
      ) {
        this.setRemoteVideoSdpEnabled(true);
        this.explicitVideoSubscribeArmed = false;
      } else if (nextKey === this.lastAppliedRemoteVideoKey && normalized.length > 0) {
        this.sendReceiverVideoConstraints();
      }
      return;
    }
    // During audio-only recover the stage briefly empties; VoiceBar may send [].
    // Only snapshot for auto-resub when we still prefer restoring screen.
    // After clearRemoteVideoSubscribeForMixStall, preferStableScreencast is
    // false — never refill pending from a transient empty clear.
    if (
      normalized.length === 0 &&
      this.requestedRemoteVideo.length > 0 &&
      (this.remoteVideoSdpBlockedAfterStall ||
        this.remoteAudioStalledAfterVideo ||
        this.audioRecoverInFlight)
    ) {
      if (
        this.preferStableScreencast &&
        !this.autoResubAfterMixStallUsed &&
        !this.remoteVideoSdpBlockedAfterStall &&
        this.pendingRemoteVideoAfterRecover.length === 0
      ) {
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
        preferStable: this.preferStableScreencast,
        cleared: this.requestedRemoteVideo.map((r) => r.endpointId),
        level: "warn",
        note: this.preferStableScreencast
          ? "ignore empty screen clear while audio recover holds video SDP"
          : "ignore empty clear after mix-protect drop — no auto-resub pending",
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
    // Only menu unmute arms video SDP. Storing requests without arm keeps the
    // mix alive until the user opts in (or after a prior explicit open).
    if (
      normalized.length > 0 &&
      !this.remoteVideoSdpSubscribeEnabled &&
      this.canArmExplicitRemoteVideoSdp()
    ) {
      this.setRemoteVideoSdpEnabled(true);
      this.explicitVideoSubscribeArmed = false;
    } else if (
      normalized.length > 0 &&
      !this.remoteVideoSdpSubscribeEnabled &&
      !this.explicitVideoSubscribeArmed
    ) {
      logPageDisplay("messages_voice_remote_video_wait_explicit_unmute", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        endpoints: normalized.map((r) => r.endpointId).slice(0, 4),
        level: "info",
        note: "screen request held — unmute in participant menu to open video SDP",
      });
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
    // Only refresh auto-resub pending when preferStableScreencast is still on.
    // Mix-protect clear sets prefer=false — VoiceBar must not re-arm pending.
    // Explicit menu unmute (armed) must fall through to full renegotiate.
    if (
      !this.explicitVideoSubscribeArmed &&
      (this.remoteAudioStalledAfterVideo ||
        this.remoteVideoSdpBlockedAfterStall ||
        !this.remoteVideoSdpSubscribeEnabled) &&
      normalized.length > 0
    ) {
      if (
        this.preferStableScreencast &&
        !this.autoResubAfterMixStallUsed &&
        !this.remoteVideoSdpBlockedAfterStall &&
        (this.remoteAudioStalledAfterVideo)
      ) {
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
    if (this.explicitVideoSubscribeArmed) {
      if (!this.remoteVideoSdpSubscribeEnabled) {
        this.setRemoteVideoSdpEnabled(true);
        this.explicitVideoSubscribeArmed = false;
        return;
      }
      this.explicitVideoSubscribeArmed = false;
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
    // Give mix RTP time to stabilize before Colibri video m-lines. Opening
    // screen at ~14 packets (prod) froze Opus immediately — require a healthier
    // floor; liveMix only shortens a bit.
    const liveMix = this.hasLiveMixAudioForVideoSettle();
    // Auto-subscribe needs a healthier floor than menu unmute — opening screen
    // at ~28 packets (prod) froze Opus immediately after attach.
    const settleMs =
      liveMix && this.isMediaConnected()
        ? this.explicitVideoSubscribeSession
          ? 1_400
          : 2_000
        : this.isMediaConnected()
          ? 2_200
          : 3_000;
    this.remoteAudioSettleArmed = true;
    logPageDisplay("messages_voice_remote_video_audio_settle", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      count: this.requestedRemoteVideo.length,
      settleMs,
      liveMix,
      mediaConnected: this.isMediaConnected(),
      explicit: this.explicitVideoSubscribeSession,
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
   * Mix had real RMS energy recently — protect live A/V from "flat counter"
   * heals while Opus may still play through a stats plateau.
   *
   * Do NOT use remoteSpeaking alone: the speaking latch stays true after a
   * brief ON_RMS spike while packets freeze and rms=0.
   * Only count hears AFTER video SDP attach — a pre-video hear must not
   * keep a frozen Opus m-line forever while H264 floods (prod: packets
   * stuck at 70, RMS→0, silent_mix_heal_keep_video for tens of seconds).
   */
  private mixRecentlyHearableForScreenProtect(withinMs = 4_000): boolean {
    if (this.lastHeardMixAudioAt <= 0) return false;
    const now = Date.now();
    // Pre-video hears do not prove the mix m-line survived screen SDP.
    if (
      this.postVideoRenegotiateAt > 0 &&
      this.lastHeardMixAudioAt < this.postVideoRenegotiateAt
    ) {
      return false;
    }
    return now - this.lastHeardMixAudioAt < withinMs;
  }

  /**
   * Colibri often keeps a high absolute packet floor after starving Opus —
   * counter stuck at 64–70 while inboundVideoPackets climb. That is not a
   * "healthy plateau"; sink heal cannot invent RTP.
   */
  /**
   * Fresh remote-video paint window — flat mix getStats must not kill the
   * auto-shown screencast (prod: framesDecoded climbing, Opus counter stuck).
   * Keep this long enough for Colibri to settle; Chrome often plateaus Opus
   * packet counters for 10–20s while H264 still paints.
   */
  private remoteVideoStillInPaintGrace(): boolean {
    if (this.firstRemoteVideoFrameAt <= 0) return false;
    return Date.now() - this.firstRemoteVideoFrameAt < 20_000;
  }

  private mixStarvedByVideoFlood(args: {
    audioGrowth: number;
    videoGrowth: number;
    inboundVideoPackets: number;
    sinceVideoMs?: number;
  }): boolean {
    if (args.audioGrowth > 0) return false;
    const videoFlood =
      args.inboundVideoPackets >= 40 ||
      args.videoGrowth >= 40 ||
      (args.inboundVideoPackets > 0 && args.videoGrowth > 0);
    if (!videoFlood) return false;
    const since = args.sinceVideoMs ?? 9_000;
    // While the stage is still painting, getStats mix counters often stick
    // (prod Vespiol: inboundPackets=55, framesDecoded climbing) — dropping at
    // ~2.8s killed auto-shown screencasts. Wait until decode has been live.
    // Growing video RTP during the sample window is a stats plateau, not a
    // confirmed Opus death — require a longer freeze before starving.
    if (this.firstRemoteVideoFrameAt > 0 || this.hasHealthyRemoteVideoMedia()) {
      const sinceFirstFrame =
        this.firstRemoteVideoFrameAt > 0
          ? Date.now() - this.firstRemoteVideoFrameAt
          : since;
      if (args.videoGrowth > 0) {
        return since >= 25_000 && sinceFirstFrame >= 20_000;
      }
      return since >= 18_000 && sinceFirstFrame >= 15_000;
    }
    // No paint yet — keep a modest grace so first RTP can land.
    return since >= 4_500;
  }

  /**
   * True Colibri stall: mix packet counter stopped while screen RTP still
   * climbs and we have not heard the mix for a while. Sink rebuild cannot
   * invent Opus — drop video SDP (or recover) so the mix m-line can resume
   * (prod Blox Fruits: packets=35 frozen, inboundAudio bytes stuck, video
   * 18→500+ while soft-silent only rebuilt HTML).
   */
  private mixTrulyFrozenUnderLiveScreen(args: {
    inboundPackets: number;
    audioGrowth: number;
    videoGrowth: number;
    inboundVideoPackets: number;
    sinceVideoMs?: number;
  }): boolean {
    if (args.audioGrowth > 0) return false;
    if (this.mixRecentlyHearableForScreenProtect()) return false;
    const screenAlive =
      args.inboundVideoPackets > 0 ||
      args.videoGrowth > 0 ||
      this.hasHealthyRemoteVideoMedia();
    if (!screenAlive) return false;
    // Fresh paint: do not treat flat mix counters as a stall yet.
    if (this.remoteVideoStillInPaintGrace()) {
      return false;
    }
    // Active H264 growth with a plateaued Opus counter is almost always a
    // Chrome getStats artifact (prod: packets stuck at 267 while frames climb).
    // Do not classify that as a frozen mix — sink heal only.
    if (args.videoGrowth > 0 && this.hasHealthyRemoteVideoMedia()) {
      return false;
    }
    // Video flood + flat mix: drop even with a high absolute packet floor.
    if (this.mixStarvedByVideoFlood(args)) return true;
    // Absolute packet floors that plateau under live screen are still stalls —
    // Colibri often freezes Opus at 30–70 while screen RTP continues. Sink
    // heal cannot invent growth; drop video so the mix m-line can resume.
    // Longer grace while a track is live / decoding (auto-show glance→gone).
    const painting =
      this.firstRemoteVideoFrameAt > 0 || this.hasHealthyRemoteVideoMedia();
    const graceMs = painting ? 20_000 : 4_500;
    const sinceMs = args.sinceVideoMs ?? 9_000;
    // Always honor the post-video time grace — a high absolute packet floor
    // (e.g. 213) used to skip this and mark "frozen" while the screen was
    // still attaching frames. Do not gate on silentMixHealCount: pre-video
    // heals used to burn this window before first frame.
    if (sinceMs < graceMs) {
      return false;
    }
    return true;
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
        const liveMix = this.hasLiveMixAudioForVideoSettle();
        // Packet floor alone is not enough — comfort-noise RTP grows to 100+
        // with RMS≈0 (prod: packets=192 liveMix=false → screen SDP → freeze).
        // Auto path: require ~55 packets (prod freeze at attach after ~28).
        const healthyHearableFloor =
          liveMix &&
          stats.inboundPackets >=
            (this.explicitVideoSubscribeSession ? 35 : 55);
        if (!healthyHearableFloor) {
          this.remoteAudioSettleExtended = true;
          this.remoteAudioSettlePacketsAtExtend = stats.inboundPackets;
          const extraMs = liveMix
            ? this.explicitVideoSubscribeSession
              ? 1_600
              : 2_000
            : 2_200;
          logPageDisplay("messages_voice_remote_video_audio_settle_extend", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            peakInboundAudio: this.peakInboundAudioPackets,
            liveMix,
            heardRemoteMixAudio: this.heardRemoteMixAudio,
            explicit: this.explicitVideoSubscribeSession,
            extraMs,
            level: "warn",
            note: liveMix
              ? "mix hearable but RTP snapshot thin — delay first video SDP once more"
              : "mix not hearable yet — delay first video SDP (do not open on packet floor alone)",
          });
          this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
            void this.finishRemoteAudioSettleForVideo();
          }, extraMs);
          return;
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
        // or a solid current packet floor — never bare liveMix at ~8 flat packets
        // (prod: settle_final packets=8 + liveMix → screen SDP → mix frozen).
        const regressBlocks = packetsRegressed && !liveMix;
        const autoFloor = this.explicitVideoSubscribeSession ? 25 : 45;
        const hardFloor = this.explicitVideoSubscribeSession ? 35 : 55;
        const mixPacketFloorOk =
          stats.inboundPackets >= hardFloor ||
          (liveMix && stats.inboundPackets >= autoFloor);
        const mixOk =
          !regressBlocks &&
          mixPacketFloorOk &&
          (packetsGrew ||
            stats.inboundPackets >= (this.explicitVideoSubscribeSession ? 30 : 50) ||
            (this.remoteSpeaking &&
              stats.inboundPackets >= (this.explicitVideoSubscribeSession ? 25 : 45)) ||
            (liveMix &&
              stats.inboundPackets >= (this.explicitVideoSubscribeSession ? 25 : 45)));
        const maxSettleRetries = this.explicitVideoSubscribeSession ? 4 : 10;
        if (!mixOk && this.remoteAudioSettleRetryCount < maxSettleRetries) {
          this.remoteAudioSettleRetryCount += 1;
          this.remoteAudioSettleExtended = false;
          this.remoteAudioSettleArmed = false;
          const extraMs = liveMix ? 1_600 : 2_200;
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
            explicit: this.explicitVideoSubscribeSession,
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
          // Auto-subscribe never opens on allow_thin — that froze mix at ~28–30.
          if (
            !this.explicitVideoSubscribeSession &&
            this.remoteAudioSettleRetryCount < 12
          ) {
            this.remoteAudioSettleRetryCount += 1;
            this.remoteAudioSettleExtended = false;
            this.remoteAudioSettleArmed = false;
            const extraMs = liveMix ? 2_000 : 2_400;
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
              note: "mix still thin — delay auto screen SDP (avoid freezing mix)",
            });
            this.pendingVideoRenegotiateOnAudio = setTimeout(() => {
              void this.finishRemoteAudioSettleForVideo();
            }, extraMs);
            return;
          }
          if (this.remoteAudioSettleRetryCount < 4) {
            this.remoteAudioSettleRetryCount += 1;
            this.remoteAudioSettleExtended = false;
            this.remoteAudioSettleArmed = false;
            const extraMs = liveMix ? 1_500 : 2_200;
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
          // After recover / mix-drop, refuse thin SDP only when mix is not live.
          // Hearable mix + thin getStats snapshot is common right after rejoin;
          // aborting here left publishers invisible forever (Merix camera).
          // Auto path: refuse thin forever this join — user can unmute.
          const refuseThinAfterMixStress =
            !liveMix &&
            (this.audioRecoverCount >= 1 || this.videoDropToRestoreMixCount >= 1);
          const refuseThinAuto =
            !this.explicitVideoSubscribeSession && stats.inboundPackets < 50;
          if (
            refuseThinAuto ||
            refuseThinAfterMixStress ||
            (!liveMix &&
              (!this.remoteSpeaking ||
                stats.inboundPackets < 25 ||
                packetsRegressed))
          ) {
            logPageDisplay("messages_voice_remote_video_audio_settle_abort", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: stats.inboundPackets,
              packetsAtExtend,
              packetsRegressed,
              remoteSpeaking: this.remoteSpeaking,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              recoverCount: this.audioRecoverCount,
              dropCount: this.videoDropToRestoreMixCount,
              requested: this.requestedRemoteVideo.length,
              explicit: this.explicitVideoSubscribeSession,
              level: "warn",
              note: refuseThinAuto
                ? "refuse thin auto screen SDP — unmute or wait for healthier mix"
                : refuseThinAfterMixStress
                  ? "refuse thin screen SDP after mix recover/drop — keep hearing"
                  : "mix not healthy enough for screen — keep audio-only this join",
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
    // Final hard gate: never open screen SDP without a hearable mix this join.
    if (!this.hasLiveMixAudioForVideoSettle()) {
      this.remoteAudioSettledForVideo = false;
      this.remoteAudioSettleArmed = false;
      this.remoteAudioSettleExtended = false;
      this.remoteAudioSettlePacketsAtExtend = 0;
      this.remoteAudioSettleRetryCount = 0;
      logPageDisplay("messages_voice_remote_video_audio_settle_abort", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        heardRemoteMixAudio: this.heardRemoteMixAudio,
        remoteSpeaking: this.remoteSpeaking,
        requested: this.requestedRemoteVideo.length,
        level: "warn",
        note: "abort screen SDP — mix never hearable this join",
      });
      return;
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
    const maxHeight =
      this.videoDropToRestoreMixCount > 0
        ? GROUP_CALL_VIDEO_MAX_HEIGHT_AFTER_STALL
        : GROUP_CALL_VIDEO_MAX_HEIGHT;
    const constraints: Record<string, { minHeight: number; maxHeight: number }> =
      {};
    for (const endpoint of endpoints) {
      // telegram-tt / tgcalls Full: maxHeight 720 (not 480 — non-rung heights
      // fail simulcast selection and trickle 1080p at ~1fps). After a Colibri
      // mix stall, prefer 360 to cut screen bitrate pressure on Opus.
      constraints[endpoint] = {
        minHeight: 0,
        maxHeight,
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
        maxHeight,
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
      // Skeleton must match the PC's current m-line count/order. Always rebuilding
      // from joinAnswer alone dropped extras on 2→1 screen shrink and Chrome
      // rejected: "order of m-lines in subsequent offer doesn't match".
      const remote = connection.remoteDescription;
      const localDesc = connection.localDescription;
      const sessionSdp = localDesc?.sdp || remote?.sdp || "";
      const joinAnswer = this.joinAnswerSdp;
      const sessionSections = sessionSdp
        ? parseOfferMediaSections(sessionSdp)
        : [];
      const sessionFirstVideo = sessionSections.findIndex(
        (s) => s.kind === "video",
      );
      const sessionExtraVideo = sessionSections.filter(
        (s, index) => s.kind === "video" && index !== sessionFirstVideo,
      ).length;
      // Prefer session SDP once remote-video m-lines exist so shrinks keep
      // inactive placeholders. First subscribe still grows from join answer.
      const useSessionSkeleton = Boolean(sessionSdp) && sessionExtraVideo > 0;
      const skeletonSdp = useSessionSkeleton
        ? sessionSdp
        : joinAnswer ||
          (remote?.type === "offer" ? remote.sdp : null) ||
          (remote?.type === "answer" ? remote.sdp : null) ||
          localDesc?.sdp ||
          remote?.sdp ||
          "";
      if (!skeletonSdp) return;
      const audioBase:
        | "remote_offer"
        | "join_answer"
        | "session_skeleton"
        | "remote_answer"
        | "local_description" = useSessionSkeleton
        ? joinAnswer
          ? "session_skeleton"
          : localDesc?.type === "answer"
            ? "local_description"
            : remote?.type === "offer"
              ? "remote_offer"
              : "remote_answer"
        : joinAnswer
          ? "join_answer"
          : remote?.type === "offer"
            ? "remote_offer"
            : remote?.type === "answer"
              ? "remote_answer"
              : "local_description";
      inboundBefore = await this.logIceDiagnostics(
        connection,
        "pre_video_renegotiate",
      );
      const offerSdp = groupCallRemoteSubscribeOfferSdp(
        transport,
        skeletonSdp,
        sections,
        {
          videoPayloadTypes: this.videoPayloadTypes,
          videoExtensions: this.videoExtensions,
          // Only strip client send SSRCs when falling back to local offer.
          stripSenderSsrcs: audioBase === "local_description" && !joinAnswer,
          // Keep SFU mix SSRCs from join answer while session skeleton holds m-lines.
          audioTemplateSdp:
            useSessionSkeleton && joinAnswer ? joinAnswer : undefined,
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
        sessionExtraVideo,
        wantedVideos: sections.length,
        stripSenderSsrcs: audioBase === "local_description" && !joinAnswer,
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
    // Empty wanted = in-place strip — do not arm post-video stall watch.
    if (wanted.length > 0) {
      this.postVideoRenegotiateAt = Date.now();
      this.postVideoSilenceTicks = 0;
      this.firstRemoteVideoFrameAt = 0;
      // Pre-video silence heals must not burn the post-video freeze grace
      // (prod: healCount=4 before screen → flat_recheck skipped 10s window).
      this.silentMixHealCount = 0;
      this.silentMixHealInFlight = false;
    } else {
      this.postVideoRenegotiateAt = 0;
      this.postVideoSilenceTicks = 0;
      this.firstRemoteVideoFrameAt = 0;
    }
    this.sendReceiverVideoConstraints();
    this.pullRemoteMediaTracks(connection);
    // Video subscribe used to leave WebAudio attached to a pre-renegotiate
    // stream snapshot — force rebuild so unmuted mix keeps playing.
    this.queueRemotePlayback("post-video-renegotiate");
    if (wanted.length === 0) return;
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
            // Classic Colibri stall: mix counter freezes at a *thin* floor while
            // video RTP climbs. A healthy absolute floor that briefly stops
            // growing (quiet talker / stats plateau) must NOT count as stall —
            // that tore working mix+screencast (prod: packets=41 flat → drop →
            // recover loop). Prolonged RMS silence still heals via soft watch.
            const mixPlateauWhileVideo =
              hadHealthyAudioBefore &&
              audioGrowth <= (screenPainting ? 0 : 2) &&
              videoGrowth > 15 &&
              stats.inboundPackets < 15 &&
              !this.mixRecentlyHearableForScreenProtect();
            // Mix collapsed to a trickle after we already heard it this join
            // (prod: settle gate 42pk → renegotiate 2pk → stuck 4pk + video flood).
            // Do NOT treat thin-but-still-growing counters during screen attach as
            // collapse (prod: 8→9 + video flood tore down live screens). Absolute
            // healthy floors alone must not suppress a frozen trickle.
            const mixCollapsedToTrickle =
              sessionHadHealthyMix &&
              stats.inboundPackets > 0 &&
              stats.inboundPackets < 12 &&
              audioGrowth <= 0 &&
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
            // Live screencast + stalled mix: heal when mix is still advancing;
            // otherwise drop remote video / audio-only recover. Do not set
            // preferStable before drop/recover — that re-armed auto-resub and
            // re-froze Opus (prod: soft_silent → recover → resub → silent).
            if (
              audioStalled &&
              this.shouldSkipRecoverToKeepScreen({
                inboundPackets: stats.inboundPackets,
                inboundVideoPackets: stats.inboundVideoPackets,
                audioGrowth,
                videoGrowth,
              })
            ) {
              if (
                this.dropRemoteVideoSdpToRestoreMix("post_video_stalled_after_recover")
              ) {
                // Video SDP removed — mix should resume without full rejoin.
              } else {
                // No remote video left to keep — do not preferStable (re-arms
                // pending refill / auto-resub from VoiceBar).
                this.preferStableScreencast = false;
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
                  note:
                    "mix stalled after prior recover — no video left, heal sink",
                });
                void this.healSilentMixDespiteRtp();
              }
            } else if (audioStalled && screenPainting) {
              // Mild plateau with live mix: keep stage + heal. Collapse/death
              // or thin freeze: drop remote video / audio-only recover — user
              // must unmute screencast again (no auto-resub).
              const needsAudioRejoin =
                mixCollapsedToTrickle ||
                mixDied ||
                mixRegressedHard ||
                mixNeverStartedStarved;
              // Soft plateau under live screen: keep only when mix is still
              // advancing or heard AFTER video attach. A high absolute floor
              // with audioGrowth≤0 under H264 flood is Colibri starvation —
              // sink heal cannot invent Opus (prod: packets stuck at 70).
              const sinceVideoForPlateau =
                this.postVideoRenegotiateAt > 0
                  ? Date.now() - this.postVideoRenegotiateAt
                  : 9_000;
              const starvedByVideo = this.mixStarvedByVideoFlood({
                audioGrowth,
                videoGrowth,
                inboundVideoPackets: stats.inboundVideoPackets,
                sinceVideoMs: sinceVideoForPlateau,
              });
              const softPlateauKeepScreen =
                !needsAudioRejoin &&
                !starvedByVideo &&
                (audioGrowth > 0 ||
                  this.mixRecentlyHearableForScreenProtect(4_000));
              if (softPlateauKeepScreen) {
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
                  note:
                    "post-video soft plateau — keep painting screen, heal mix sink",
                });
                this.queueRemotePlayback("post-video-plateau-keep");
                void this.healSilentMixDespiteRtp();
              } else if (
                !needsAudioRejoin &&
                this.dropRemoteVideoSdpToRestoreMix("post_video_plateau_thin_mix")
              ) {
                // Remote video cleared — audio-only until user re-unmutes.
              } else if (needsAudioRejoin) {
                this.preferStableScreencast = false;
                this.pendingRemoteVideoAfterRecover = [];
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
                  note:
                    "mix RTP stalled after video SDP — audio-only recover (no auto screen restore)",
                });
                this.scheduleAudioRecoverAfterVideoStall();
              } else {
                // Flat mix, drop failed / no remote video left — audio-only.
                this.preferStableScreencast = false;
                this.pendingRemoteVideoAfterRecover = [];
                this.remoteAudioStalledAfterVideo = true;
                logPageDisplay("messages_voice_remote_audio_stalled_after_video", {
                  chatId: this.input.chatId,
                  groupCallId: this.input.groupCallId,
                  inboundBefore: inboundBefore.inboundPackets,
                  inboundAfter: stats.inboundPackets,
                  audioGrowth,
                  videoGrowth,
                  inboundVideoPackets: stats.inboundVideoPackets,
                  recoverCount: this.audioRecoverCount,
                  level: "error",
                  note:
                    "mix plateau under screen, drop failed — audio-only recover (no auto screen restore)",
                });
                this.scheduleAudioRecoverAfterVideoStall();
              }
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
                note: "mix RTP stalled or starved after video SDP — recover audio-only",
              });
              this.scheduleAudioRecoverAfterVideoStall();
            } else if (audioGrowth > 5 && videoGrowth < 40) {
              // Meaningful mix growth without a video flood — disarm soft RMS.
              // Brief post-attach spikes (e.g. +10 pk) while video climbs used
              // to clear the watch and leave Opus frozen (prod: 33→43 then stuck).
              this.postVideoRenegotiateAt = 0;
              this.postVideoSilenceTicks = 0;
            } else if (
              audioGrowth > 5 &&
              videoGrowth >= 40 &&
              hadHealthyAudioBefore
            ) {
              // Growth under video flood — keep soft watch and recheck; a short
              // spike does not prove the mix is healthy.
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
                    "post_video_renegotiate_spike_recheck",
                  ).then((later) => {
                    if (this.connection !== connection || !this.joined) return;
                    const laterAudioGrowth =
                      later.inboundPackets - baselinePackets;
                    const laterVideoGrowth =
                      later.inboundVideoPackets - baselineVideo;
                    const screenAlive =
                      later.inboundVideoPackets > 0 ||
                      laterVideoGrowth > 0 ||
                      this.hasHealthyRemoteVideoMedia();
                    if (laterAudioGrowth > 5 && laterVideoGrowth < 40) {
                      this.postVideoRenegotiateAt = 0;
                      this.postVideoSilenceTicks = 0;
                      return;
                    }
                    if (screenAlive && laterAudioGrowth <= 2) {
                      // Fresh paint: flat Opus getStats is common while H264
                      // attaches — soft-heal only (prod: spike then glance→gone).
                      if (this.remoteVideoStillInPaintGrace()) {
                        logPageDisplay(
                          "messages_voice_remote_video_spike_paint_grace",
                          {
                            chatId: this.input.chatId,
                            groupCallId: this.input.groupCallId,
                            audioGrowth: laterAudioGrowth,
                            videoGrowth: laterVideoGrowth,
                            inboundVideoPackets: later.inboundVideoPackets,
                            level: "info",
                            note:
                              "post-video spike recheck during paint grace — keep screen, heal sink",
                          },
                        );
                        void this.healSilentMixDespiteRtp();
                        return;
                      }
                      const spikeSinceVideoMs =
                        this.postVideoRenegotiateAt > 0
                          ? Date.now() - this.postVideoRenegotiateAt
                          : 9_000;
                      const spikeStarved = this.mixStarvedByVideoFlood({
                        audioGrowth: laterAudioGrowth,
                        videoGrowth: laterVideoGrowth,
                        inboundVideoPackets: later.inboundVideoPackets,
                        sinceVideoMs: spikeSinceVideoMs,
                      });
                      const spikeTrulyFrozen =
                        this.mixTrulyFrozenUnderLiveScreen({
                          inboundPackets: later.inboundPackets,
                          audioGrowth: laterAudioGrowth,
                          videoGrowth: laterVideoGrowth,
                          inboundVideoPackets: later.inboundVideoPackets,
                          sinceVideoMs: spikeSinceVideoMs,
                        });
                      // Only drop on confirmed Colibri stall / video flood —
                      // never on mere laterAudioGrowth≤0 (that killed painting
                      // screens while mix counters plateaued).
                      if (
                        (spikeStarved || spikeTrulyFrozen) &&
                        this.dropRemoteVideoSdpToRestoreMix(
                          spikeTrulyFrozen
                            ? "post_video_spike_frozen_mix"
                            : "post_video_spike_then_flat",
                        )
                      ) {
                        return;
                      }
                      void this.healSilentMixDespiteRtp();
                    }
                  });
                }, 2_000);
              }
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
                      this.scheduleAudioRecoverAfterVideoStall();
                      return;
                    }
                    if (laterAudioGrowth > 5 && laterVideoGrowth < 40) {
                      this.postVideoRenegotiateAt = 0;
                      this.postVideoSilenceTicks = 0;
                    }
                    if (screenAlive && laterAudioGrowth <= 0) {
                      const sinceVideoMs =
                        this.postVideoRenegotiateAt > 0
                          ? Date.now() - this.postVideoRenegotiateAt
                          : 9_000;
                      // Fresh decode window / growing H264: do not strip a
                      // painting screencast just because Opus getStats
                      // plateaued (prod Vespiol: framesDecoded climbing →
                      // post_video_flat_frozen_mix).
                      if (
                        this.remoteVideoStillInPaintGrace() ||
                        laterVideoGrowth > 0
                      ) {
                        logPageDisplay(
                          "messages_voice_remote_video_flat_paint_grace",
                          {
                            chatId: this.input.chatId,
                            groupCallId: this.input.groupCallId,
                            inboundBefore: baselinePackets,
                            inboundAfter: later.inboundPackets,
                            audioGrowth: laterAudioGrowth,
                            videoGrowth: laterVideoGrowth,
                            inboundVideoPackets: later.inboundVideoPackets,
                            sinceVideoMs,
                            level: "info",
                            note:
                              laterVideoGrowth > 0
                                ? "flat mix while screen RTP grows — keep screen, heal sink"
                                : "flat mix during paint grace — keep screen, heal sink",
                          },
                        );
                        void this.healSilentMixDespiteRtp();
                        return;
                      }
                      const starved = this.mixStarvedByVideoFlood({
                        audioGrowth: laterAudioGrowth,
                        videoGrowth: laterVideoGrowth,
                        inboundVideoPackets: later.inboundVideoPackets,
                        sinceVideoMs,
                      });
                      const trulyFrozen = this.mixTrulyFrozenUnderLiveScreen({
                        inboundPackets: later.inboundPackets,
                        audioGrowth: laterAudioGrowth,
                        videoGrowth: laterVideoGrowth,
                        inboundVideoPackets: later.inboundVideoPackets,
                        sinceVideoMs,
                      });
                      // IMPORTANT: only drop when stall helpers say so — the
                      // old ternary always called dropRemoteVideoSdpToRestoreMix
                      // and only varied the reason string (glance → gone).
                      if (trulyFrozen || starved) {
                        this.preferStableScreencast = false;
                        if (
                          this.dropRemoteVideoSdpToRestoreMix(
                            trulyFrozen
                              ? "post_video_flat_frozen_mix"
                              : "post_video_flat_video_flood",
                          )
                        ) {
                          return;
                        }
                      }
                      // Thin counter without post-video hear — last-resort drop.
                      const mixTooThin =
                        later.inboundPackets < 15 &&
                        !this.mixRecentlyHearableForScreenProtect(4_000) &&
                        !this.mixCounterLooksHealthyForScreen(
                          later.inboundPackets,
                        );
                      if (
                        mixTooThin &&
                        this.dropRemoteVideoSdpToRestoreMix(
                          "post_video_flat_thin_mix",
                        )
                      ) {
                        return;
                      }
                      logPageDisplay(
                        "messages_voice_remote_video_flat_soft_heal",
                        {
                          chatId: this.input.chatId,
                          groupCallId: this.input.groupCallId,
                          inboundBefore: baselinePackets,
                          inboundAfter: later.inboundPackets,
                          audioGrowth: laterAudioGrowth,
                          videoGrowth: laterVideoGrowth,
                          inboundVideoPackets: later.inboundVideoPackets,
                          recoverCount: this.audioRecoverCount,
                          sinceVideoMs,
                          healthyFloor: this.mixCounterLooksHealthyForScreen(
                            later.inboundPackets,
                          ),
                          heardRemoteMixAudio: this.heardRemoteMixAudio,
                          level: "warn",
                          note:
                            "flat mix drop skipped — soft-heal sink only (no auto screen restore)",
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
              // Constraints alone sometimes leave muted tracks with 0 video RTP
              // after auto-show. One re-renegotiate after the 2nd miss.
              if (
                this.remoteVideoPacketRetries === 2 &&
                this.explicitVideoSubscribeSession &&
                this.remoteVideoSdpSubscribeEnabled
              ) {
                this.lastAppliedRemoteVideoKey = "";
                this.queueRemoteVideoRenegotiation();
                logPageDisplay("messages_voice_remote_video_zero_pk_renegotiate", {
                  chatId: this.input.chatId,
                  groupCallId: this.input.groupCallId,
                  attempt: this.remoteVideoPacketRetries,
                  level: "warn",
                  note: "inboundVideoPackets still 0 — force one video SDP retry",
                });
              }
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
        this.maybeFlushPreferExplicitWhenMixHealthy();
      }
      if (framesDecoded > 0 && this.firstRemoteVideoFrameAt <= 0) {
        this.firstRemoteVideoFrameAt = Date.now();
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
        if (this.trySoftIceRestartWhileScreenSharing(connection, reason)) {
          return;
        }
        void this.recoverFromIceFailure(reason);
      }
    }, delayMs);
  }

  /**
   * Screen upload can flake ICE consent without killing the presentation PC.
   * Prefer restartIce + wait before a full voice rejoin that interrupts the stream.
   */
  private trySoftIceRestartWhileScreenSharing(
    connection: RTCPeerConnection,
    reason: string,
  ): boolean {
    if (!this.screenSharing || this.iceSoftRestartAttempted) return false;
    if (this.connection !== connection) return false;
    if (typeof connection.restartIce !== "function") return false;
    if (reason.includes("failed") || reason.includes("closed")) return false;
    this.iceSoftRestartAttempted = true;
    try {
      connection.restartIce();
      logPageDisplay("messages_voice_ice_soft_restart", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        reason,
        presentationIce:
          this.presentationConnection?.iceConnectionState ?? "none",
        level: "warn",
        note: "local screen up — restartIce before tearing down voice PC",
      });
      this.queueRemotePlayback("ice-soft-restart");
      this.scheduleJoinLostIfStillBroken(
        connection,
        `${reason}_after_soft_restart`,
        TelegramGroupCallWebSession.ICE_SOFT_RESTART_GRACE_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  private isPresentationIceHealthy(): boolean {
    const pc = this.presentationConnection;
    if (!pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "connected" ||
      ice === "completed" ||
      conn === "connected"
    );
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
    this.clearPresentationIceDisconnectTimer();
    this.iceRecoverInFlight = true;
    this.iceRecoverCount += 1;
    const startMuted = !(
      this.micDesiredEnabled === true ||
      (this.micDesiredEnabled !== false && this.micEnabled)
    );
    const screenTrackLive =
      this.screenSharing &&
      this.screenTrack != null &&
      this.screenTrack.readyState === "live";
    // Keep a healthy presentation PC — preserveScreenCapture used to tear it
    // down and rejoin, which interrupted the local screencast every voice ICE flake.
    const keepPresentation =
      screenTrackLive && this.isPresentationIceHealthy();
    const preserveScreenCapture = screenTrackLive && !keepPresentation;
    logPageDisplay("messages_voice_ice_recover", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      recoverCount: this.iceRecoverCount,
      startMuted,
      micDesired: this.micDesiredEnabled,
      preserveScreenCapture,
      keepPresentation,
      heardRemoteMixAudio: this.heardRemoteMixAudio,
      level: "warn",
      note: keepPresentation
        ? "ICE/consent failed — rejoin voice only; keep live presentation PC"
        : "ICE/consent failed — silent rejoin to restore mix audio",
    });
    try {
      this.markJoinLost(`ice_recover_${reason}`, {
        silent: true,
        preserveScreenCapture,
        keepPresentation,
      });
      this.remoteAudioEnabled = true;
      unlockVoiceAutoplay();
      await this.ensureJoinedListenOnly(startMuted);
      this.resumeRemoteAudio();
      if (
        preserveScreenCapture &&
        this.screenTrack != null &&
        this.screenTrack.readyState === "live"
      ) {
        try {
          const keepSystemAudio =
            this.presentationAudioIsSystem &&
            this.presentationAudioTrack != null &&
            this.presentationAudioTrack.readyState === "live"
              ? this.presentationAudioTrack
              : null;
          this.presentationJoining = this.joinPresentationConnection(
            this.screenTrack,
            keepSystemAudio,
          );
          await this.presentationJoining;
          await this.applyScreenShareEncoding();
          this.notifyLocalMediaListeners();
          logPageDisplay("messages_voice_screen_share_restored", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            recoverCount: this.iceRecoverCount,
            reason,
            level: "info",
            note: "rejoined presentation PC after ICE recover with live display track",
          });
        } catch (screenErr) {
          logPageDisplay("messages_voice_screen_share_restore_fail", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            error:
              screenErr instanceof Error
                ? screenErr.message
                : String(screenErr),
            level: "error",
          });
        } finally {
          this.presentationJoining = null;
        }
      }
      logPageDisplay("messages_voice_ice_recover_ok", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        recoverCount: this.iceRecoverCount,
        ice: this.connection?.iceConnectionState ?? "none",
        conn: this.connection?.connectionState ?? "none",
        screenSharing: this.screenSharing,
        presentationIce:
          this.presentationConnection?.iceConnectionState ?? "none",
        keepPresentation,
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

  private clearPresentationIceDisconnectTimer(): void {
    if (this.presentationIceDisconnectTimer) {
      window.clearTimeout(this.presentationIceDisconnectTimer);
      this.presentationIceDisconnectTimer = null;
    }
  }

  /**
   * Presentation (screencast) ICE died but getDisplayMedia is still live —
   * rejoin presentation only without tearing down the voice PC.
   */
  private async recoverPresentationConnection(reason: string): Promise<void> {
    if (this.presentationRecoverInFlight || this.iceRecoverInFlight) return;
    if (
      !this.screenSharing ||
      !this.screenTrack ||
      this.screenTrack.readyState !== "live"
    ) {
      return;
    }
    if (!this.joined || !this.connection) return;
    this.clearPresentationIceDisconnectTimer();
    this.presentationRecoverInFlight = true;
    logPageDisplay("messages_voice_presentation_ice_recover", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      level: "warn",
      note: "presentation ICE lost — rejoin screencast with live display track",
    });
    try {
      const keepSystemAudio =
        this.presentationAudioIsSystem &&
        this.presentationAudioTrack != null &&
        this.presentationAudioTrack.readyState === "live"
          ? this.presentationAudioTrack
          : null;
      this.teardownPresentationConnection({
        keepAudioTrack: keepSystemAudio != null,
      });
      this.presentationJoining = this.joinPresentationConnection(
        this.screenTrack,
        keepSystemAudio,
      );
      await this.presentationJoining;
      await this.applyScreenShareEncoding();
      this.notifyLocalMediaListeners();
      logPageDisplay("messages_voice_presentation_ice_recover_ok", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        reason,
        presentationIce:
          this.presentationConnection?.iceConnectionState ?? "none",
        level: "info",
      });
    } catch (err) {
      logPageDisplay("messages_voice_presentation_ice_recover_fail", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        reason,
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
    } finally {
      this.presentationJoining = null;
      this.presentationRecoverInFlight = false;
    }
  }

  private schedulePresentationIceRecover(
    connection: RTCPeerConnection,
    reason: string,
    delayMs: number,
  ): void {
    this.clearPresentationIceDisconnectTimer();
    this.presentationIceDisconnectTimer = window.setTimeout(() => {
      this.presentationIceDisconnectTimer = null;
      if (this.presentationConnection !== connection) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      if (
        ice === "connected" ||
        ice === "completed" ||
        conn === "connected"
      ) {
        return;
      }
      void this.recoverPresentationConnection(reason);
    }, delayMs);
  }

  private markJoinLost(
    reason: string,
    opts?: {
      silent?: boolean;
      keepPresentation?: boolean;
      /** Tear down dead presentation PC but keep live getDisplayMedia track. */
      preserveScreenCapture?: boolean;
    },
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
    // ICE recover keeps the display track but must drop the dead presentation PC.
    const preserveScreenCapture = opts?.preserveScreenCapture === true;
    const keepPresentation =
      !preserveScreenCapture &&
      (opts?.keepPresentation === true ||
        reason === "audio_stalled_after_video");
    if (preserveScreenCapture) {
      this.stopLocalCameraCaptureOnly();
      // Keep live system-audio track across presentation PC teardown so restore
      // can republish it (otherwise others only get silent presentation audio).
      this.teardownPresentationConnection({
        keepAudioTrack:
          this.presentationAudioIsSystem &&
          this.presentationAudioTrack?.readyState === "live",
      });
    } else if (keepPresentation) {
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
    // Keep micDesiredEnabled — recover/ICE rejoin must restore an open mic.
    this.micEnabled = false;
    this.clearUnmuteRetry();
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
   * Refuse further audio-only recovers once a *remote* screencast is preferred
   * /live after at least one recover. Local screen share must NOT block recover
   * — Colibri can freeze Opus under remote video while we still publish local
   * presentation (prod: packets stuck at 64, local-screen on stage, endless
   * sink heal). Pass growth stats to force recover when mix is starved by video.
   */
  private shouldSkipRecoverToKeepScreen(args?: {
    inboundPackets?: number;
    audioGrowth?: number;
    videoGrowth?: number;
    inboundVideoPackets?: number;
    sinceVideoMs?: number;
  }): boolean {
    if (
      args &&
      this.mixStarvedByVideoFlood({
        audioGrowth: args.audioGrowth ?? 0,
        videoGrowth: args.videoGrowth ?? 0,
        inboundVideoPackets: args.inboundVideoPackets ?? 0,
        sinceVideoMs: args.sinceVideoMs,
      })
    ) {
      return false;
    }
    // After one recover, sticky preferStableScreencast + pending screen used to
    // skip every further rejoin while inboundPackets stayed frozen (prod: stuck
    // at 26 after auto-resub). Call sites often pass only audioGrowth:0 — do not
    // require inboundPackets in args. Live mix / unmute wins — latched "heard
    // recently" must not block recover after soft_silent killed RTP.
    const mixLooksDead =
      typeof args?.audioGrowth === "number" &&
      args.audioGrowth <= 0 &&
      !this.hasLiveMixAudioForVideoSettle() &&
      !this.isRemoteAudioUnmuted();
    if (mixLooksDead && this.audioRecoverCount >= 1) {
      this.preferStableScreencast = false;
      this.pendingRemoteVideoAfterRecover = [];
      this.lastAppliedRemoteVideoEndpoints = [];
      if (this.videoResubscribeAfterRecoverTimer) {
        clearTimeout(this.videoResubscribeAfterRecoverTimer);
        this.videoResubscribeAfterRecoverTimer = null;
      }
      // Do not treat UI-requested screen as a reason to skip recover while mix
      // is frozen — that left remotes silent after soft_silent + skip_stable.
      return false;
    }
    const hasRemoteScreenPreferred =
      this.hasHealthyRemoteVideoMedia() ||
      this.lastAppliedRemoteVideoEndpoints.length > 0 ||
      (this.preferStableScreencast &&
        this.pendingRemoteVideoAfterRecover.length > 0);
    // requestedRemoteVideo alone must NOT block recover — VoiceBar can keep
    // requesting a screen that already froze the mix.
    if (this.audioRecoverCount >= 1 && hasRemoteScreenPreferred) {
      return true;
    }
    if (
      this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      return false;
    }
    return hasRemoteScreenPreferred || this.preferStableScreencast;
  }

  /**
   * Soft RMS silence after video with a live screen.
   *
   * Growing mix RTP + quiet RMS: keep stage and heal sink.
   * Sustained frozen mix under live screen (not recently hearable): drop
   * remote video SDP so Opus can resume (audio-only until user re-unmutes
   * screencast). Brief grace after attach allows one sink heal first.
   */
  private async evaluateSoftSilentKeepVideo(sinceVideoMs: number): Promise<void> {
    if (this.softSilentVideoCheckInFlight) return;
    // After a mix-stall drop/recover we stay audio-only until the user
    // explicitly unmutes screencast — do not re-enter soft-silent (it used
    // to re-arm preferStable + heal while Opus stayed dead).
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
      // Already recovered once — drop remote video when mix stays frozen and
      // we have not heard it recently. Healthy absolute floor alone used to
      // keep a dead Opus m-line forever (prod: soft_silent after packets=35).
      // Probe first so video-flood starvation can force recover (do not skip).
      {
        const probe = await this.logIceDiagnostics(
          connection,
          "soft_silent_after_recover_probe",
        );
        const starveOpts = {
          audioGrowth: 0,
          videoGrowth: 0,
          inboundVideoPackets: probe.inboundVideoPackets,
          sinceVideoMs,
        };
        if (this.shouldSkipRecoverToKeepScreen(starveOpts)) {
          this.postVideoSilenceTicks = 0;
          if (
            !this.mixRecentlyHearableForScreenProtect() &&
            !this.remoteVideoStillInPaintGrace() &&
            this.dropRemoteVideoSdpToRestoreMix("soft_silent_after_recover")
          ) {
            return;
          }
          if (
            !this.mixRecentlyHearableForScreenProtect() &&
            !this.remoteVideoStillInPaintGrace()
          ) {
            // Drop failed and mix not recently hearable — stay audio-only.
            this.preferStableScreencast = false;
            this.remoteAudioStalledAfterVideo = true;
            logPageDisplay(
              "messages_voice_remote_audio_soft_silent_recover_rtp_stall",
              {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                rms: 0,
                sinceVideoMs,
                recoverCount: this.audioRecoverCount,
                inboundPackets: probe.inboundPackets,
                inboundVideoPackets: probe.inboundVideoPackets,
                sink: this.remotePlaybackSink,
                screens: this.lastAppliedRemoteVideoEndpoints,
                level: "error",
                note:
                  "soft silence after recover — mix not hearable, audio-only (no auto screen restore)",
              },
            );
            void this.recoverAudioOnlyAfterVideoStall().catch((err) => {
              logPageDisplay("messages_voice_soft_silent_recover_fail", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                error: err instanceof Error ? err.message : String(err),
                level: "error",
              });
            });
            return;
          }
          // Keep stage for a moment if mix was recently hearable, but do not
          // re-arm auto screen subscribe — that re-freezes audio in production.
          this.preferStableScreencast = false;
          this.remoteVideoSdpBlockedAfterStall = true;
          this.autoResubAfterMixStallUsed = true;
          logPageDisplay(
            "messages_voice_remote_audio_soft_silent_keep_after_recover",
            {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              rms: 0,
              sinceVideoMs,
              recoverCount: this.audioRecoverCount,
              inboundPackets: probe.inboundPackets,
              inboundVideoPackets: probe.inboundVideoPackets,
              sink: this.remotePlaybackSink,
              screens: this.lastAppliedRemoteVideoEndpoints,
              level: "warn",
              note:
                "soft silence after prior recover — mix recently hearable, heal sink (no auto screen restore)",
            },
          );
          void this.healSilentMixDespiteRtp();
          return;
        }
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
      // Growing mix RTP + quiet RMS: keep stage and heal — never tear down.
      // Do not clear postVideoRenegotiateAt here either (same disarm bug).
      if (screenStillLive && !mixRtpFrozen) {
        this.preferStableScreencast = true;
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
      // Brief quiet after hearing / early attach: sink heal only.
      // Sustained freeze under live screen: drop video SDP so Opus resumes
      // (audio-only until user re-unmutes screencast) — healthier than PC rejoin.
      if (mixRtpFrozen) {
        const trulyFrozen = this.mixTrulyFrozenUnderLiveScreen({
          inboundPackets: after.inboundPackets,
          audioGrowth,
          videoGrowth,
          inboundVideoPackets: after.inboundVideoPackets,
          sinceVideoMs,
        });
        // Live / growing screencast + flat Opus counters: treat as getStats
        // plateau. Never drop or rejoin while the stage is still painting or
        // H264 packets are still climbing in this sample window.
        if (
          screenStillLive &&
          (!trulyFrozen ||
            this.remoteVideoStillInPaintGrace() ||
            videoGrowth > 0)
        ) {
          // Grace keep of the stage, but do not re-arm auto-resub /
          // preferStable after a mix that already stalled once.
          this.preferStableScreencast = false;
          // Keep postVideoRenegotiateAt armed — clearing it here permanently
          // disarmed soft-silent after one grace heal (prod: speaking latch +
          // grace → forever silent mix under live screen).
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
              note: trulyFrozen
                ? "RMS quiet under screen during grace — keep stage, heal sink (no auto-resub)"
                : "RMS quiet under live screen — Opus getStats plateau, keep stage, heal sink",
            },
          );
          void this.healSilentMixDespiteRtp();
          return;
        }
        // Confirmed Colibri stall with stale video — drop screen SDP.
        if (
          screenStillLive &&
          trulyFrozen &&
          !this.remoteVideoStillInPaintGrace() &&
          this.dropRemoteVideoSdpToRestoreMix("soft_silent_frozen_mix")
        ) {
          return;
        }
        // trulyFrozen but drop failed (no remote video left) — fall through
        // to audio-only recover; do not keep painting a silent screen.
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
              ? "mix RTP frozen after video SDP — audio-only recover (no auto screen restore)"
              : "mix RTP frozen after video SDP, no screen — audio-only recover",
          },
        );
        void this.recoverAudioOnlyAfterVideoStall().catch((err) => {
          logPageDisplay("messages_voice_soft_silent_recover_fail", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            error: err instanceof Error ? err.message : String(err),
            level: "error",
          });
        });
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
      void this.recoverAudioOnlyAfterVideoStall().catch((err) => {
        logPageDisplay("messages_voice_soft_silent_recover_fail", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          error: err instanceof Error ? err.message : String(err),
          level: "error",
        });
      });
    } finally {
      this.softSilentVideoCheckInFlight = false;
    }
  }

  /**
   * Video SDP broke the mix m-line — drop video subscribe and rejoin listen-only
   * so inbound audio RTP can flow again. Stay audio-only until the user explicitly
   * unmutes a screencast (no auto-resub — that re-froze Opus after recover).
   */
  private scheduleAudioRecoverAfterVideoStall(): void {
    void this.recoverAudioOnlyAfterVideoStall().catch((err) => {
      logPageDisplay("messages_voice_audio_recover_uncaught", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        error: err instanceof Error ? err.message : String(err),
        level: "error",
      });
    });
  }

  private async recoverAudioOnlyAfterVideoStall(): Promise<void> {
    if (
      this.audioRecoverInFlight ||
      this.audioRecoverCount >= TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      return;
    }
    // After one recover, refuse further full rejoins while a screencast is
    // preferred — but if remote video SDP is still applied and mix is dead
    // under video flood, do not skip (shouldSkipRecover reads live stats).
    const recoverConn = this.connection;
    const recoverSkipStats = recoverConn
      ? await this.logIceDiagnostics(
          recoverConn,
          "audio_recover_skip_probe",
        ).catch(() => null)
      : null;
    if (
      this.shouldSkipRecoverToKeepScreen(
        recoverSkipStats
          ? {
              inboundPackets: recoverSkipStats.inboundPackets,
              inboundVideoPackets: recoverSkipStats.inboundVideoPackets,
              // Unknown short-window growth — flat + video flood still starves.
              audioGrowth: 0,
              videoGrowth: 0,
              sinceVideoMs:
                this.postVideoRenegotiateAt > 0
                  ? Date.now() - this.postVideoRenegotiateAt
                  : 9_000,
            }
          : undefined
      )
    ) {
      // Already recovered once with a healthy mix: clear stage UI, heal sink.
      if (
        this.requestedRemoteVideo.length > 0 ||
        this.lastAppliedRemoteVideoEndpoints.length > 0
      ) {
        this.clearRemoteVideoSubscribeForMixStall("recover_skip_clear_screen");
      }
      logPageDisplay("messages_voice_audio_recover_skip_stable_screen", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        preferStableScreencast: this.preferStableScreencast,
        healthyVideo: this.hasHealthyRemoteVideoMedia(),
        recoverCount: this.audioRecoverCount,
        inboundPackets: recoverSkipStats?.inboundPackets ?? null,
        inboundVideoPackets: recoverSkipStats?.inboundVideoPackets ?? null,
        level: "warn",
        note: "skip audio-only recover — mix still hearable / healthy video on stage",
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
    // Prefer stays false until explicit unmute — never auto one-shot resub.
    this.preferStableScreencast = false;
    this.autoResubAfterMixStallUsed = true;
    this.silentMixHealCount = 0;
    this.videoResubscribeAfterRecoverAttempts = 0;
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    // Keep one-shot restore snapshot from mix-protect drop (if any).
    if (!this.mixProtectScreenAutoRestorePending) {
      this.pendingRemoteVideoAfterRecover = [];
    }
    this.requestedRemoteVideo = [];
    this.lastAppliedRemoteVideoEndpoints = [];
    this.lastAppliedRemoteVideoKey = "";
    this.videoRecvSlots = [];
    this.clearRemoteVideoStream();
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners(true);
    // Prefer micDesiredEnabled — markJoinLost clears micEnabled but the user
    // may still want the mic open after audio-only rejoin.
    const startMuted = !(
      this.micDesiredEnabled === true ||
      (this.micDesiredEnabled !== false && this.micEnabled)
    );
    logPageDisplay("messages_voice_audio_recover_start", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      startMuted,
      micDesired: this.micDesiredEnabled,
      recoverCount: this.audioRecoverCount,
      pendingVideo: this.pendingRemoteVideoAfterRecover.length,
      allowResub: this.mixProtectScreenAutoRestorePending,
      level: "warn",
      note: this.mixProtectScreenAutoRestorePending
        ? "rejoin audio-only — will restore explicit screen once mix healthy"
        : "rejoin without video SDP after mix RTP stall — audio-only until user unmutes",
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
      this.notifyLocalMediaListeners();
      if (this.mixProtectScreenAutoRestorePending) {
        logPageDisplay("messages_voice_remote_video_resubscribe_arm", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          recoverCount: this.audioRecoverCount,
          dropCount: this.videoDropToRestoreMixCount,
          pending: this.pendingRemoteVideoAfterRecover.length,
          level: "info",
          note: "audio recover ok — restore explicit/auto-shown screen once mix healthy",
        });
        this.maybeArmMixProtectScreenRestore("mix_protect_restore_after_recover");
      } else {
        logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          recoverCount: this.audioRecoverCount,
          dropCount: this.videoDropToRestoreMixCount,
          level: "warn",
          note: "audio-only after mix stall — user can re-open screen manually",
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

  /** Preferred one-screen snapshot (explicit unmute / pending restore). */
  private snapshotPendingScreenForRecover(): TelegramRemoteVideoRequest[] {
    const copyOne = (
      list: TelegramRemoteVideoRequest[],
    ): TelegramRemoteVideoRequest[] =>
      list.slice(0, 1).map((r) => ({
        endpointId: r.endpointId,
        kind: r.kind,
        ssrcGroups: r.ssrcGroups.map((g) => ({
          semantics: g.semantics,
          sourceIds: [...g.sourceIds],
        })),
      }));
    const fromRequestedScreen = this.requestedRemoteVideo.filter(
      (r) => r.kind === "screen",
    );
    if (fromRequestedScreen.length > 0) return copyOne(fromRequestedScreen);
    if (this.requestedRemoteVideo.length > 0) {
      return copyOne(this.requestedRemoteVideo);
    }
    const fromPendingScreen = this.pendingRemoteVideoAfterRecover.filter(
      (r) => r.kind === "screen",
    );
    if (fromPendingScreen.length > 0) return copyOne(fromPendingScreen);
    if (this.pendingRemoteVideoAfterRecover.length > 0) {
      return copyOne(this.pendingRemoteVideoAfterRecover);
    }
    return [];
  }

  /** Clear remote screen subscribe UI/state without SDP (used before audio-only rejoin). */
  private clearRemoteVideoSubscribeForMixStall(reason: string): void {
    const wasExplicit = this.explicitVideoSubscribeSession;
    const screenSnapshot = this.snapshotPendingScreenForRecover();
    const preferredForRestore =
      this.preferredExplicitVideoEndpointId ||
      screenSnapshot[0]?.endpointId ||
      null;
    this.videoDropToRestoreMixCount += 1;
    this.mixPacketsAtLastVideoDrop = this.peakInboundAudioPackets;
    this.lastVideoDropToRestoreMixAt = Date.now();
    this.remoteVideoSdpSubscribeEnabled = false;
    this.preferStableScreencast = false;
    this.postVideoRenegotiateAt = 0;
    this.firstRemoteVideoFrameAt = 0;
    this.postVideoSilenceTicks = 0;
    this.remoteAudioSettledForVideo = false;
    this.remoteAudioSettleArmed = false;
    this.remoteAudioSettleExtended = false;
    this.remoteAudioSettlePacketsAtExtend = 0;
    this.remoteAudioSettleRetryCount = 0;
    this.clearVideoRenegotiateAudioWait();
    // Block unbounded drop↔resub loops; one explicit-session restore is armed below.
    this.autoResubAfterMixStallUsed = true;
    this.pendingRemoteVideoAfterRecover = [];
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    const pausedEndpoints = [
      ...this.requestedRemoteVideo.map((r) => r.endpointId),
      ...this.lastAppliedRemoteVideoEndpoints,
    ];
    this.requestedRemoteVideo = [];
    this.remoteVideoSdpBlockedAfterStall = true;
    this.remoteAudioStalledAfterVideo = true;
    this.lastAppliedRemoteVideoEndpoints = [];
    this.lastAppliedRemoteVideoKey = "";
    this.videoRecvSlots = [];
    this.clearRemoteVideoStream();
    this.notifyVideoListeners();
    this.notifyRemoteVideoSourceListeners(true);
    this.setMixPausedScreenEndpoints(pausedEndpoints);
    this.bumpRemoteVideoRepush("mix_protect_drop");
    const armOneShotRestore =
      wasExplicit &&
      Boolean(preferredForRestore) &&
      !this.mixProtectScreenAutoRestoreUsed &&
      !this.mixProtectScreenAutoRestorePending;
    if (armOneShotRestore && preferredForRestore) {
      this.mixProtectScreenAutoRestorePending = true;
      this.preferredExplicitVideoEndpointId = preferredForRestore;
      if (screenSnapshot.length > 0) {
        this.pendingRemoteVideoAfterRecover = screenSnapshot;
      }
    }
    logPageDisplay("messages_voice_remote_video_drop_restore_mix", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      recoverCount: this.audioRecoverCount,
      dropCount: this.videoDropToRestoreMixCount,
      pending: this.pendingRemoteVideoAfterRecover.length,
      paused: pausedEndpoints.slice(0, 4),
      allowResubscribe: armOneShotRestore,
      preferred: preferredForRestore,
      level: "warn",
      note: armOneShotRestore
        ? "clear remote video — one-shot restore when mix healthy"
        : "clear remote video — audio-only until user re-unmutes screencast",
    });
  }

  /** After mix-protect drop, restore auto-shown/explicit screen once Opus is healthy. */
  private maybeArmMixProtectScreenRestore(reason: string): void {
    if (!this.mixProtectScreenAutoRestorePending) return;
    if (this.mixProtectScreenAutoRestoreUsed) return;
    if (!this.joined) return;
    this.schedulePreferExplicitWhenMixHealthy(reason);
  }

  /**
   * Drop remote screen to restore mix audio. Prefer in-place inactive video
   * SDP (same PC) — full audio rejoin after a freeze often left
   * inboundPackets=0. Does not auto-resubscribe video after mix recovers.
   * @returns true if a drop/strip/recover was started
   */
  private dropRemoteVideoSdpToRestoreMix(reason: string): boolean {
    if (
      this.requestedRemoteVideo.length === 0 &&
      this.lastAppliedRemoteVideoEndpoints.length === 0
    ) {
      return false;
    }
    if (this.stripVideoInFlight || this.audioRecoverInFlight) {
      return true;
    }
    if (
      this.audioRecoverCount >= TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
    ) {
      this.clearRemoteVideoSubscribeForMixStall(reason);
      this.queueRemotePlayback("drop-video-restore-mix");
      return true;
    }
    void this.stripRemoteVideoSdpInPlaceThenMaybeRecover(reason);
    return true;
  }

  /**
   * Strip remote video m-lines to inactive on the current PeerConnection, wait
   * for mix RTP growth, then stay audio-only (or escalate to rejoin). Remote
   * screen returns only on explicit unmute — never auto one-shot resub.
   */
  private async stripRemoteVideoSdpInPlaceThenMaybeRecover(
    reason: string,
  ): Promise<void> {
    if (this.stripVideoInFlight || this.audioRecoverInFlight) return;
    if (
      this.requestedRemoteVideo.length === 0 &&
      this.lastAppliedRemoteVideoEndpoints.length === 0
    ) {
      return;
    }
    this.stripVideoInFlight = true;
    try {
      this.clearRemoteVideoSubscribeForMixStall(reason);
      this.queueRemotePlayback("strip-video-inplace");
      // clearRemoteVideo sets lastAppliedRemoteVideoKey="" — force past the
      // empty-key early return so inactive m-lines are actually renegotiated.
      this.lastAppliedRemoteVideoKey = "__needs_strip__";
      const connection = this.connection;
      if (!connection || !this.joined || !this.lastTransport) {
        // clear already emptied pending — still escalate if we can rejoin.
        if (
          this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS
        ) {
          this.scheduleAudioRecoverAfterVideoStall();
        }
        return;
      }
      logPageDisplay("messages_voice_remote_video_strip_inplace", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        reason,
        pending: this.pendingRemoteVideoAfterRecover.length,
        dropCount: this.videoDropToRestoreMixCount,
        level: "warn",
        note: "inactive remote video SDP on same PC — avoid full rejoin first",
      });
      try {
        this.renegotiationChain = this.renegotiationChain
          .then(() => this.renegotiateRemoteVideos())
          .catch((err) => {
            this.lastAppliedRemoteVideoKey = "";
            logPageDisplay("messages_voice_remote_video_strip_fail", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err instanceof Error ? err.message : String(err),
              level: "error",
            });
          });
        await this.renegotiationChain;
      } catch {
        // fall through to recover
      }
      if (this.connection !== connection || !this.joined) return;

      const before = await this.logIceDiagnostics(
        connection,
        "post_strip_video_0",
      );
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.setTimeout(resolve, 2_000);
      });
      if (this.connection !== connection || !this.joined) return;
      const after = await this.logIceDiagnostics(
        connection,
        "post_strip_video_2s",
      );
      const audioGrowth = after.inboundPackets - before.inboundPackets;
      // Absolute packet floor alone is NOT "alive" — Colibri often freezes at
      // 64–70 forever after video SDP. Require real growth or a fresh hear.
      const mixGrew = audioGrowth >= 4;
      const mixAlive =
        mixGrew || this.mixRecentlyHearableForScreenProtect(2_500);
      logPageDisplay("messages_voice_remote_video_strip_result", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        inboundBefore: before.inboundPackets,
        inboundAfter: after.inboundPackets,
        audioGrowth,
        mixGrew,
        mixAlive,
        pending: this.pendingRemoteVideoAfterRecover.length,
        level: mixGrew || mixAlive ? "info" : "warn",
        note:
          mixGrew || mixAlive
            ? "mix resumed after in-place strip — stay audio-only until user re-unmutes"
            : "mix still flat after strip — escalate audio-only rejoin",
      });

      if (mixGrew || mixAlive) {
        this.remoteAudioStalledAfterVideo = false;
        if (this.mixProtectScreenAutoRestorePending) {
          this.maybeArmMixProtectScreenRestore("mix_protect_restore_after_strip");
        } else {
          this.pendingRemoteVideoAfterRecover = [];
        }
        return;
      }

      // Strip did not revive Opus — full PC rejoin is the last resort.
      if (
        this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
        !this.audioRecoverInFlight
      ) {
        this.scheduleAudioRecoverAfterVideoStall();
      }
    } finally {
      this.stripVideoInFlight = false;
    }
  }

  /** Poll getStats until inbound mix packets resume after audio-only rejoin. */
  private async waitForInboundMixPacketsAfterRecover(
    timeoutMs: number,
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection) return false;
    const started = Date.now();
    // Absolute floors alone are wrong after a stalled session: getStats can
    // report a sticky packet total that never grows (logs: inboundPackets=26
    // forever). Require RMS hearability or packet growth from a baseline.
    let baselinePackets = -1;
    while (Date.now() - started < timeoutMs) {
      if (this.connection !== connection || !this.joined) return false;
      if (
        this.isRemoteAudioUnmuted() ||
        this.hasLiveMixAudioForVideoSettle()
      ) {
        return true;
      }
      try {
        const stats = await this.logIceDiagnostics(
          connection,
          "recover_mix_wait",
        );
        if (baselinePackets < 0) {
          baselinePackets = stats.inboundPackets;
        } else if (
          stats.inboundPackets >= 12 &&
          stats.inboundPackets > baselinePackets
        ) {
          return true;
        }
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.setTimeout(resolve, 400);
      });
    }
    return false;
  }

  /**
   * Legacy auto one-shot remote-video restore after mix stall.
   * Disabled: re-arming video SDP after recover/strip re-freezes inbound Opus.
   * Explicit unmute uses preferExplicitRemoteVideoSubscribe instead.
   */
  private scheduleRemoteVideoResubscribeAfterAudioHealthy(): void {
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    if (this.pendingRemoteVideoAfterRecover.length === 0) return;
    logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      recoverCount: this.audioRecoverCount,
      pending: this.pendingRemoteVideoAfterRecover.length,
      level: "info",
      note: "auto one-shot screen restore disabled — keep audio-only after mix stall",
    });
    this.pendingRemoteVideoAfterRecover = [];
    this.autoResubAfterMixStallUsed = true;
    this.preferStableScreencast = false;
    this.remoteVideoSdpBlockedAfterStall = true;
  }

  private async finishRemoteVideoResubscribeAfterRecover(): Promise<void> {
    if (this.videoResubscribeAfterRecoverTimer) {
      clearTimeout(this.videoResubscribeAfterRecoverTimer);
      this.videoResubscribeAfterRecoverTimer = null;
    }
    if (this.pendingRemoteVideoAfterRecover.length === 0) return;
    logPageDisplay("messages_voice_remote_video_resubscribe_skip", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      recoverCount: this.audioRecoverCount,
      pending: this.pendingRemoteVideoAfterRecover.length,
      level: "info",
      note: "finish one-shot screen restore disabled — explicit unmute required",
    });
    this.pendingRemoteVideoAfterRecover = [];
    this.autoResubAfterMixStallUsed = true;
    this.preferStableScreencast = false;
    this.remoteVideoSdpBlockedAfterStall = true;
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
          // Prefer system audio when the OS/browser exposes it — silent
          // presentation audio alone is not "the stream" others expect to hear.
          audio: true,
          video: true,
        });
      } catch (err) {
        // Some platforms reject audio:true — fall back to video-only capture.
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: true,
          });
        } catch (retryErr) {
          throw mapDisplayMediaError(retryErr ?? err);
        }
      }
    }
    const track = displayStream.getVideoTracks()[0];
    if (!track) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error("screen_share_unavailable");
    }
    track.enabled = true;
    try {
      if ("contentHint" in track) {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint =
          "detail";
      }
    } catch {
      // ignore
    }

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

      this.presentationJoining = this.joinPresentationConnection(
        track,
        displayStream.getAudioTracks()[0] ?? null,
      );
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
    // Do NOT preferExplicit remote video here — auto re-arm after local share
    // re-opened Colibri video SDP and froze the mix (and audio recover).
    // User unmutes a remote screencast from the participant menu when wanted.
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
    // Voice ICE consent flakes under full 2.5Mbps upload — ease bitrate until
    // the listen PC reconnects (prod: ice_disconnected right after screen start).
    const iceProtect = this.screenShareIceProtect;
    return {
      width,
      height,
      maxBitrate: iceProtect ? 1_200_000 : 2_500_000,
      maxFramerate: iceProtect ? 20 : 30,
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

  private teardownPresentationConnection(opts?: {
    keepAudioTrack?: boolean;
  }): void {
    this.clearPresentationIceDisconnectTimer();
    if (this.presentationAudioTrack) {
      if (!opts?.keepAudioTrack) {
        try {
          this.presentationAudioTrack.stop();
        } catch {
          // ignore
        }
        this.presentationAudioTrack = null;
        this.presentationAudioIsSystem = false;
      }
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

  /**
   * Ensure the presentation sender still owns a live display track and has
   * encodings applied. ICE can go connected while packetsSent stays 0 if the
   * encoder never starts (prod: outboundVideoPackets=0 after screen join).
   */
  private async ensurePresentationVideoSending(
    connection: RTCPeerConnection,
  ): Promise<void> {
    const track = this.screenTrack;
    if (!track || track.readyState !== "live") return;
    track.enabled = true;
    try {
      if ("contentHint" in track) {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint =
          "detail";
      }
    } catch {
      // ignore
    }
    const sender = connection
      .getSenders()
      .find((s) => s.track === track || s.track?.kind === "video");
    if (!sender) return;
    try {
      if (sender.track !== track) {
        await sender.replaceTrack(track);
      }
    } catch {
      // ignore replace failures
    }
    await this.applyScreenShareEncoding();
  }

  private schedulePresentationOutboundWatch(connection: RTCPeerConnection): void {
    if (typeof window === "undefined") return;
    const check = (delayMs: number) => {
      window.setTimeout(() => {
        if (this.presentationConnection !== connection) return;
        void this.ensurePresentationVideoSending(connection).then(() =>
          connection.getStats().then((stats) => {
            if (this.presentationConnection !== connection) return;
            let outboundVideoPackets = 0;
            let outboundVideoBytes = 0;
            let outboundAudioPackets = 0;
            stats.forEach((report) => {
              if (report.type === "outbound-rtp" && report.kind === "video") {
                outboundVideoPackets += Number(report.packetsSent) || 0;
                outboundVideoBytes += Number(report.bytesSent) || 0;
              }
              if (report.type === "outbound-rtp" && report.kind === "audio") {
                outboundAudioPackets += Number(report.packetsSent) || 0;
              }
            });
            logPageDisplay("messages_voice_screen_share_outbound", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              outboundVideoPackets,
              outboundVideoBytes,
              outboundAudioPackets,
              ice: connection.iceConnectionState,
              conn: connection.connectionState,
              systemAudio: this.presentationAudioIsSystem,
              level: outboundVideoPackets > 0 ? "info" : "warn",
            });
            // Connected but still no video RTP — rejoin presentation once.
            if (
              outboundVideoPackets === 0 &&
              delayMs >= 3_500 &&
              (connection.iceConnectionState === "connected" ||
                connection.iceConnectionState === "completed" ||
                connection.connectionState === "connected") &&
              !this.presentationRecoverInFlight
            ) {
              void this.recoverPresentationConnection(
                "presentation_outbound_zero",
              );
            }
          }),
        );
      }, delayMs);
    };
    check(1_500);
    check(4_000);
  }

  /** Publish screen on a dedicated presentation WebRTC connection (Telegram API). */
  private async joinPresentationConnection(
    screenTrack: MediaStreamTrack,
    systemAudioTrack?: MediaStreamTrack | null,
  ): Promise<void> {
    const reuseAudio =
      systemAudioTrack != null &&
      systemAudioTrack === this.presentationAudioTrack &&
      systemAudioTrack.readyState === "live";
    this.teardownPresentationConnection({ keepAudioTrack: reuseAudio });

    const useSystemAudio =
      systemAudioTrack != null && systemAudioTrack.readyState === "live";
    const presentationAudio = useSystemAudio
      ? systemAudioTrack!
      : createSilentAudioTrack();
    presentationAudio.enabled = true;
    this.presentationAudioIsSystem = useSystemAudio;

    const connection = new RTCPeerConnection({
      iceServers: GROUP_CALL_ICE_SERVERS,
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
      if (this.presentationConnection !== connection) return;
      if (ice === "failed" || ice === "closed") {
        void this.recoverPresentationConnection(`presentation_ice_${ice}`);
        return;
      }
      if (ice === "disconnected") {
        this.schedulePresentationIceRecover(
          connection,
          "presentation_ice_disconnected",
          3_000,
        );
        return;
      }
      this.clearPresentationIceDisconnectTimer();
      if (ice === "connected" || ice === "completed") {
        void this.ensurePresentationVideoSending(connection);
      }
    };

    connection.onconnectionstatechange = () => {
      if (this.presentationConnection !== connection) return;
      const state = connection.connectionState;
      if (state === "failed") {
        void this.recoverPresentationConnection(`presentation_pc_${state}`);
      } else if (state === "disconnected") {
        this.schedulePresentationIceRecover(
          connection,
          `presentation_pc_${state}`,
          3_000,
        );
      } else if (state === "connected") {
        this.clearPresentationIceDisconnectTimer();
        void this.ensurePresentationVideoSending(connection);
      }
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
      const timeout = window.setTimeout(() => {
        connection.removeEventListener("icegatheringstatechange", onGather);
        resolve();
      }, GROUP_CALL_ICE_GATHER_MS);
      const onGather = () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          connection.removeEventListener("icegatheringstatechange", onGather);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", onGather);
    });

    // Same docker/link-local strip as listen PC — Hyper-V hosts poison ICE.
    const rawPresentationLocal = connection.localDescription;
    if (rawPresentationLocal?.sdp) {
      const filtered = stripUnusableLocalIceCandidates(rawPresentationLocal.sdp);
      if (filtered !== rawPresentationLocal.sdp) {
        try {
          await connection.setLocalDescription({
            type: rawPresentationLocal.type,
            sdp: filtered,
          });
        } catch {
          // Keep unfiltered description if rewrite fails.
        }
      }
    }

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
      systemAudio: this.presentationAudioIsSystem,
      level: "info",
    });

    void this.ensurePresentationVideoSending(connection);
    this.schedulePresentationOutboundWatch(connection);
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

  /** Screen SDP only after explicit unmute + mix is connected. */
  private tryArmRemoteVideoSdpAfterHealthyMix(): void {
    if (
      this.requestedRemoteVideo.length === 0 ||
      this.remoteVideoSdpSubscribeEnabled ||
      !this.explicitVideoSubscribeArmed ||
      !this.canArmExplicitRemoteVideoSdp()
    ) {
      return;
    }
    this.setRemoteVideoSdpEnabled(true);
    this.explicitVideoSubscribeArmed = false;
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
      // Lower ON so quiet mixes latch "heard" before screen SDP (prod: peakRms
      // 0.004–0.005 under the old 0.006 gate → never heard → video on packet
      // floor alone → Opus freeze).
      const ON_RMS = 0.0035;
      const OFF_RMS = 0.0018;
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
          if (firstHearable) {
            this.maybeFlushPreferExplicitWhenMixHealthy();
          }
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
                  this.scheduleAudioRecoverAfterVideoStall();
                  return;
                }
              }
            } else if (rms >= ON_RMS) {
              this.postVideoSilenceTicks = 0;
              // One comfort-noise / latch spike must not permanently disarm the
              // soft watch while remote video is still subscribed — mix can go
              // silent again right after (prod: hear spike then frozen Opus).
              if (!this.hasHealthyRemoteVideoMedia()) {
                this.postVideoRenegotiateAt = 0;
              }
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
              this.scheduleAudioRecoverAfterVideoStall();
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
    if (
      this.silentMixHealInFlight ||
      this.audioRecoverInFlight ||
      this.stripVideoInFlight
    ) {
      return;
    }
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
        this.maybeFlushPreferExplicitWhenMixHealthy();
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
        // Pass flat audioGrowth so video-flood starvation does not skip recover.
        const thinStarve = {
          inboundPackets: stats.inboundPackets,
          inboundVideoPackets: stats.inboundVideoPackets,
          audioGrowth: 0,
          videoGrowth: 0,
          sinceVideoMs:
            this.postVideoRenegotiateAt > 0
              ? Date.now() - this.postVideoRenegotiateAt
              : 9_000,
        };
        if (
          this.postVideoRenegotiateAt > 0 &&
          this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
          !this.audioRecoverInFlight &&
          !this.shouldSkipRecoverToKeepScreen(thinStarve)
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
              "post-video mix too thin for heal — one-shot audio recover (audio-only)",
          });
          this.scheduleAudioRecoverAfterVideoStall();
        } else if (
          this.postVideoRenegotiateAt > 0 &&
          this.shouldSkipRecoverToKeepScreen(thinStarve)
        ) {
          this.preferStableScreencast = false;
          if (this.dropRemoteVideoSdpToRestoreMix("silent_heal_thin_after_recover")) {
            return;
          }
          logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: stats.inboundPackets,
            inboundVideoPackets: stats.inboundVideoPackets,
            recoverCount: this.audioRecoverCount,
            level: "warn",
            note: "thin mix after prior recover — no video left, skip heal",
          });
        }
        return;
      }
      if (thinButLikelyFrozen) {
        // getStats often resets after video SDP while Opus is still audible.
        // If we just heard the mix, prefer sink heal over tearing A/V down.
        if (this.mixRecentlyHearableForScreenProtect()) {
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
              "thin counter after video but mix recently hearable — keep A/V, sink heal",
          });
          // Fall through to sink rebuild below.
        } else {
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
          const thinFrozenStarve = {
            inboundPackets: stats.inboundPackets,
            inboundVideoPackets: stats.inboundVideoPackets,
            audioGrowth: 0,
            videoGrowth: 0,
            sinceVideoMs:
              this.postVideoRenegotiateAt > 0
                ? Date.now() - this.postVideoRenegotiateAt
                : 9_000,
          };
          if (
            this.audioRecoverCount < TelegramGroupCallWebSession.MAX_AUDIO_RECOVERS &&
            !this.audioRecoverInFlight &&
            !this.shouldSkipRecoverToKeepScreen(thinFrozenStarve)
          ) {
            this.remoteAudioStalledAfterVideo = true;
            this.scheduleAudioRecoverAfterVideoStall();
            return;
          }
          if (this.shouldSkipRecoverToKeepScreen(thinFrozenStarve)) {
            this.preferStableScreencast = false;
            if (this.dropRemoteVideoSdpToRestoreMix("silent_heal_thin_frozen")) {
              return;
            }
            // Fall through to sink heal when we already recovered once.
          } else {
            return;
          }
        }
      }
      // Stale plateau: packets exist but are not advancing — heal cannot invent RTP.
      // Run even if we already heard mix earlier this join: video SDP often freezes
      // a previously healthy m-line ("worked, then went silent").
      // Also run when the soft watch was already disarmed (brief spike cleared
      // postVideoRenegotiateAt) but remote video is still live — otherwise a
      // healthy absolute floor + flat packets only gets sink heal and Opus stays
      // stuck (prod: inboundPackets≈43, RMS→0, sink-only heal).
      const postVideoOrLiveScreen =
        this.postVideoRenegotiateAt > 0 ||
        this.lastAppliedRemoteVideoEndpoints.length > 0 ||
        this.hasHealthyRemoteVideoMedia() ||
        stats.inboundVideoPackets > 30;
      if (
        postVideoOrLiveScreen &&
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
          const videoGrowthDuringHeal =
            growthCheck.inboundVideoPackets - stats.inboundVideoPackets;
          const screenAliveDuringHeal =
            growthCheck.inboundVideoPackets > 0 ||
            videoGrowthDuringHeal > 0 ||
            this.hasHealthyRemoteVideoMedia();
          const trulyFrozen = this.mixTrulyFrozenUnderLiveScreen({
            inboundPackets: growthCheck.inboundPackets,
            audioGrowth: growthCheck.inboundPackets - stats.inboundPackets,
            videoGrowth: videoGrowthDuringHeal,
            inboundVideoPackets: growthCheck.inboundVideoPackets,
            sinceVideoMs:
              this.postVideoRenegotiateAt > 0
                ? Date.now() - this.postVideoRenegotiateAt
                : 9_000,
          });
          // Flat Opus + live/growing screen: keep the stage and sink-heal.
          // Prod bug: paintGrace + silentMixHealCount>0 fell through to
          // audio-only recover and killed an attached screencast.
          if (
            screenAliveDuringHeal &&
            (!trulyFrozen ||
              this.remoteVideoStillInPaintGrace() ||
              videoGrowthDuringHeal > 0)
          ) {
            this.preferStableScreencast = false;
            logPageDisplay("messages_voice_silent_mix_heal_keep_video", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundBefore: stats.inboundPackets,
              inboundAfter: growthCheck.inboundPackets,
              inboundVideoPackets: growthCheck.inboundVideoPackets,
              videoGrowth: videoGrowthDuringHeal,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              paintGrace: this.remoteVideoStillInPaintGrace(),
              healCount: this.silentMixHealCount,
              level: "warn",
              note:
                "mix counter flat under live screen — keep stage, sink heal (no auto-resub)",
            });
            // Fall through to sink rebuild below.
          } else if (
            screenAliveDuringHeal &&
            trulyFrozen &&
            !this.remoteVideoStillInPaintGrace() &&
            videoGrowthDuringHeal <= 0
          ) {
            // Confirmed Colibri stall with stale video RTP — drop screen so
            // Opus can resume (audio-only until explicit unmute).
            this.preferStableScreencast = false;
            if (
              this.dropRemoteVideoSdpToRestoreMix(
                "silent_heal_frozen_drop_video",
              )
            ) {
              return;
            }
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
                "flat mix under screen — drop failed, audio-only recover (no auto screen restore)",
            });
            this.scheduleAudioRecoverAfterVideoStall();
            return;
          } else if (
            this.shouldSkipRecoverToKeepScreen({
              audioGrowth:
                growthCheck.inboundPackets - stats.inboundPackets,
              videoGrowth: videoGrowthDuringHeal,
              inboundVideoPackets: growthCheck.inboundVideoPackets,
              sinceVideoMs:
                this.postVideoRenegotiateAt > 0
                  ? Date.now() - this.postVideoRenegotiateAt
                  : 9_000,
            })
          ) {
            this.preferStableScreencast = false;
            if (
              this.dropRemoteVideoSdpToRestoreMix("silent_heal_frozen_after_recover")
            ) {
              return;
            }
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
                "mix counter frozen after prior recover — no video left, continue sink heal",
            });
            // Fall through to sink rebuild below.
          } else if (
            this.videoDropToRestoreMixCount > 0 &&
            this.requestedRemoteVideo.length === 0
          ) {
            logPageDisplay("messages_voice_silent_mix_heal_after_drop", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundBefore: stats.inboundPackets,
              inboundAfter: growthCheck.inboundPackets,
              dropCount: this.videoDropToRestoreMixCount,
              recoverCount: this.audioRecoverCount,
              level: "warn",
              note:
                "screen already dropped for mix — sink heal only, no full rejoin",
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
                "mix packet counter frozen after video — one-shot audio recover (audio-only)",
            });
            this.scheduleAudioRecoverAfterVideoStall();
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
        const audioGrowth = after.inboundPackets - stats.inboundPackets;
        // Growing Opus counters are NOT frozen — quiet RMS alone must not
        // force audio-only rejoin (prod: 34→51 packets, never heard → recover
        // threw, then screen SDP on the same PC froze mix at 192).
        const mixStillFrozen = audioGrowth <= 0 && after.inboundPackets >= 8;
        if (mixStillFrozen) {
          const sinceVideoMs =
            this.postVideoRenegotiateAt > 0
              ? Date.now() - this.postVideoRenegotiateAt
              : 9_000;
          const videoGrowth =
            after.inboundVideoPackets - stats.inboundVideoPackets;
          const starved = this.mixStarvedByVideoFlood({
            audioGrowth,
            videoGrowth,
            inboundVideoPackets: after.inboundVideoPackets,
            sinceVideoMs,
          });
          const trulyFrozen = this.mixTrulyFrozenUnderLiveScreen({
            inboundPackets: after.inboundPackets,
            audioGrowth,
            videoGrowth,
            inboundVideoPackets: after.inboundVideoPackets,
            sinceVideoMs,
          });
          const screenAlive =
            after.inboundVideoPackets > 0 ||
            videoGrowth > 0 ||
            this.hasHealthyRemoteVideoMedia() ||
            this.lastAppliedRemoteVideoEndpoints.length > 0;
          // Prod: after 4 sink heals, Opus getStats stayed flat at 231 while
          // H264 kept climbing (1031pkts, framesDecoded↑) and paintGrace was
          // still true — silent_mix_recover yanked stage + mix. Match the
          // soft-silent / mid-heal keep_video gate before any drop/rejoin.
          if (
            screenAlive &&
            (!trulyFrozen ||
              this.remoteVideoStillInPaintGrace() ||
              videoGrowth > 0)
          ) {
            this.preferStableScreencast = false;
            logPageDisplay("messages_voice_silent_mix_heal_final_keep_video", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: after.inboundPackets,
              inboundVideoPackets: after.inboundVideoPackets,
              audioGrowth,
              videoGrowth,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              paintGrace: this.remoteVideoStillInPaintGrace(),
              healCount: this.silentMixHealCount,
              level: "warn",
              note:
                "max sink heals done but screen still painting — keep A/V (no audio-only recover)",
            });
            return;
          }
          if (
            this.shouldSkipRecoverToKeepScreen({
              audioGrowth,
              inboundPackets: after.inboundPackets,
              videoGrowth,
              inboundVideoPackets: after.inboundVideoPackets,
              sinceVideoMs,
            })
          ) {
            // Confirmed flat mix after max sink heals — drop screen or stay
            // audio-only. Do not preferStable (re-armed auto-resub froze Opus).
            this.preferStableScreencast = false;
            if (
              this.dropRemoteVideoSdpToRestoreMix(
                starved
                  ? "silent_heal_final_video_flood"
                  : "silent_heal_final_flat_mix",
              )
            ) {
              return;
            }
            this.remoteAudioStalledAfterVideo = true;
            logPageDisplay("messages_voice_silent_mix_heal_escalate", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              inboundPackets: after.inboundPackets,
              inboundVideoPackets: after.inboundVideoPackets,
              recoverCount: this.audioRecoverCount,
              heardRemoteMixAudio: this.heardRemoteMixAudio,
              level: "error",
              note:
                "heal failed with flat mix — audio-only recover (no auto screen restore)",
            });
            this.scheduleAudioRecoverAfterVideoStall();
            return;
          }
          this.remoteAudioStalledAfterVideo = true;
          logPageDisplay("messages_voice_silent_mix_recover", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundPackets: after.inboundPackets,
            inboundVideoPackets: after.inboundVideoPackets,
            audioGrowth,
            recoverCount: this.audioRecoverCount,
            heardRemoteMixAudio: this.heardRemoteMixAudio,
            level: "error",
            note:
              "heal failed with flat mix RTP — one-shot audio-only rejoin (screen stays blocked this join)",
          });
          void this.recoverAudioOnlyAfterVideoStall().catch((err) => {
            logPageDisplay("messages_voice_silent_mix_recover_fail", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err instanceof Error ? err.message : String(err),
              level: "error",
            });
          });
        } else if (!this.heardRemoteMixAudio && audioGrowth > 0) {
          logPageDisplay("messages_voice_silent_mix_heal_growing_quiet", {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            inboundBefore: stats.inboundPackets,
            inboundAfter: after.inboundPackets,
            audioGrowth,
            level: "warn",
            note:
              "mix RTP still growing with low RMS — keep sink, do not rejoin (wait for hear before screen)",
          });
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
  /**
   * Cancel a stuck joinInternal so the UI watchdog can retry cleanly.
   * Without this, Promise.race timed out while createOffer/joinVideoChat kept
   * running — retry raced a half-built PeerConnection and remote media died.
   */
  abortInFlightJoin(reason = "join_watchdog"): void {
    this.joinEpoch += 1;
    const pending = this.pendingJoinConnection;
    this.pendingJoinConnection = null;
    if (pending) {
      try {
        pending.close();
      } catch {
        // ignore
      }
      if (this.outboundVideoTrack) {
        try {
          this.outboundVideoTrack.stop();
        } catch {
          // ignore
        }
        this.outboundVideoTrack = null;
      }
    }
    if (this.joined || this.connection) {
      this.markJoinLost(reason, { silent: true });
      return;
    }
    logPageDisplay("messages_voice_join_aborted", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      level: "warn",
      note: "watchdog cancelled pre-joined PeerConnection",
    });
  }

  async ensureJoinedListenOnly(startMuted = true): Promise<void> {
    if (this.joined) {
      // Stay put while ICE connects — callers used to rejoin on !mediaConnected
      // and freeze the UI with repeated SDP offers.
      if (!startMuted && (this.usingSilentAudio || !this.micEnabled)) {
        await this.ensureLocalMic({ publish: true, enabled: true });
        if (this.audioTrack) this.audioTrack.enabled = true;
        this.micEnabled = true;
      }
      return;
    }
    if (this.joining) {
      await this.joining;
      // In-flight join may have been listen-only while caller wanted open mic
      // (mic press raced dialog auto-join). Upgrade without a second SDP offer.
      if (!startMuted && this.joined) {
        await this.ensureLocalMic({ publish: true, enabled: true });
        if (this.audioTrack) this.audioTrack.enabled = true;
        this.micEnabled = true;
      }
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
   * Force a fresh `joinVideoChat` even when WebRTC still looks connected.
   * TDLib can drop the join while the PeerConnection stays up — unmute,
   * speaking, and in-call messages then fail with GROUPCALL_JOIN_MISSING.
   */
  async rejoinForTdlibPresence(startMuted = true): Promise<boolean> {
    if (this.joining) {
      try {
        await this.joining;
        return this.joined;
      } catch {
        return false;
      }
    }
    logPageDisplay("messages_voice_tdlib_presence_rejoin", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      startMuted,
      wasJoined: this.joined,
      conn: this.connection?.connectionState ?? "none",
      ice: this.connection?.iceConnectionState ?? "none",
      level: "warn",
      note: "tear+rejoin to restore TDLib mute/speaking/messages",
    });
    this.markJoinLost("tdlib_presence_rejoin", { silent: true });
    this.joining = this.joinInternal(startMuted);
    try {
      await this.joining;
      if (!startMuted) {
        await this.ensureLocalMic({ publish: true, enabled: true });
        if (this.audioTrack) this.audioTrack.enabled = true;
        this.micEnabled = true;
        const muteRetry = await setTelegramChatVoiceMicMuted({
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          isMuted: false,
        });
        if (!muteRetry.ok) {
          appWarn("[voice-tdlib-rejoin]", muteRetry.error, {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            note: "unmute after rejoin failed",
          });
        }
      }
      this.resumeRemoteAudio();
      this.speakingSyncBlockedUntil = 0;
      return this.joined;
    } catch (err) {
      appWarn(
        "[voice-tdlib-rejoin]",
        err instanceof Error ? err.message : String(err),
        {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
        },
      );
      return false;
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
            channelCount: 1,
            ...({
              googEchoCancellation: true,
              googNoiseSuppression: true,
              googAutoGainControl: true,
              googHighpassFilter: true,
            } as Record<string, boolean>),
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
    // Optimistic + coalesce: rapid chip taps used to race two replaceTrack /
    // mute API calls so the icon flipped twice while RTP stayed on silence.
    this.micDesiredEnabled = enabled;
    this.micEnabled = enabled;
    if (!enabled) {
      this.clearUnmuteRetry();
      this.setLocalSpeaking(false);
    }
    const run = async (): Promise<void> => {
      const want = this.micDesiredEnabled;
      if (want == null) return;
      await this.applyMicEnabled(want);
    };
    this.micApplyChain = this.micApplyChain.then(run, run);
    await this.micApplyChain;
  }

  private async applyMicEnabled(enabled: boolean): Promise<void> {
    // Only acquire a real mic when unmuting. The previous `usingSilentAudio`
    // branch called getUserMedia on every muted joinListen path and could hang
    // the page (permission prompt / device enumeration) right as the dialog opened.
    if (enabled) {
      await this.ensureLocalMic({ publish: true, enabled: true });
      if (this.micDesiredEnabled === false) return;
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
        try {
          await sender.replaceTrack(silent);
        } catch {
          // ignore
        }
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
    // Re-assert latest intent (another click may have flipped mid-await).
    this.micEnabled = this.micDesiredEnabled ?? enabled;
    if (this.micEnabled) {
      this.startSpeakingMonitor();
      void this.analyserCtx?.resume().catch(() => undefined);
    } else {
      this.clearUnmuteRetry();
      this.setLocalSpeaking(false);
    }

    // Best-effort Telegram mute — never block the control chip on the network RTT.
    void this.syncMicMutedToTelegram(!this.micEnabled);
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

  private clearUnmuteRetry(): void {
    if (this.unmuteRetryTimer != null) {
      clearTimeout(this.unmuteRetryTimer);
      this.unmuteRetryTimer = null;
    }
    this.unmuteRetryCount = 0;
  }

  /**
   * Keep the real mic on the sender and retry TDLib unmute. Never swap to
   * silent outbound on "Can't unmute user" — that left the UI unmuted while
   * nobody could hear the mic (and inbound often died with the silent path).
   */
  private scheduleUnmuteRetry(reason: string): void {
    if (typeof window === "undefined") return;
    if (this.unmuteRetryCount >= TelegramGroupCallWebSession.MAX_UNMUTE_RETRIES) {
      const reasonText = typeof reason === "string" ? reason : String(reason ?? "");
      const needsPresenceRejoin =
        /GROUPCALL_JOIN_MISSING|GROUPCALL_FORBIDDEN|GROUPCALL_INVALID|GROUPCALL_SSRC_DUPLICATE/i.test(
          reasonText,
        );
      const pc = this.connection;
      const mediaLive =
        pc != null &&
        (pc.connectionState === "connected" ||
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed");
      // Gateway 502 / "Can't unmute user" often keeps failing after tear+rejoin
      // and the rejoin itself interrupts inbound mix (prod: recover → unmute
      // 502 loop → silent). Keep WebRTC when media is up unless TDLib join is gone.
      const shouldRejoin =
        needsPresenceRejoin ||
        (!mediaLive && this.joined) ||
        (!mediaLive && !this.connection);
      logPageDisplay("messages_voice_unmute_retry_exhausted", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        reason: reasonText,
        retries: this.unmuteRetryCount,
        mediaLive,
        willRejoin: shouldRejoin,
        level: "warn",
        note: shouldRejoin
          ? "rejoin unmuted to restore TDLib mic after join-missing"
          : "keep WebRTC after unmute retries — mic stays published; skip tear on 502",
      });
      this.clearUnmuteRetry();
      if (shouldRejoin) {
        void this.rejoinForTdlibPresence(false);
      }
      return;
    }
    if (this.unmuteRetryTimer != null) return;
    this.unmuteRetryCount += 1;
    const delayMs = Math.min(2_500, 600 * this.unmuteRetryCount);
    logPageDisplay("messages_voice_unmute_retry_scheduled", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      reason,
      attempt: this.unmuteRetryCount,
      delayMs,
      level: "warn",
      note: "keep real mic published; retry TDLib unmute",
    });
    this.unmuteRetryTimer = setTimeout(() => {
      this.unmuteRetryTimer = null;
      void (async () => {
        if (!this.joined || !this.micEnabled) return;
        try {
          await this.ensureLocalMic({ publish: true, enabled: true });
          if (this.audioTrack) this.audioTrack.enabled = true;
          if (this.connection && this.audioTrack && this.usingSilentAudio) {
            const sender = this.connection
              .getSenders()
              .find((s) => s.track?.kind === "audio");
            if (sender && sender.track !== this.audioTrack) {
              await sender.replaceTrack(this.audioTrack).catch(() => undefined);
            }
            this.usingSilentAudio = false;
          }
          const muteRetry = await setTelegramChatVoiceMicMuted({
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            isMuted: false,
          });
          if (muteRetry.ok) {
            this.clearUnmuteRetry();
            logPageDisplay("messages_voice_unmute_retry_ok", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              attempt: this.unmuteRetryCount,
              level: "info",
            });
            return;
          }
          const err = muteRetry.error ?? "";
          appWarn("[voice-mic-sync]", err, {
            chatId: this.input.chatId,
            groupCallId: this.input.groupCallId,
            enabled: true,
            note: "unmute retry failed",
          });
          this.scheduleUnmuteRetry(err);
        } catch (err) {
          appWarn(
            "[voice-mic-sync]",
            err instanceof Error ? err.message : String(err),
            {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              note: "unmute retry threw",
            },
          );
          this.scheduleUnmuteRetry("unmute_retry_threw");
        }
      })();
    }, delayMs);
  }

  private async syncMicMutedToTelegram(isMuted: boolean): Promise<void> {
    try {
      if (!this.joined) {
        // Match join mute intent — default listen-only raced an open-mic press
        // and deferred join_listen_muted after unmute failed.
        await this.ensureJoinedListenOnly(isMuted);
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
        const errText = typeof err === "string" ? err : String(err ?? "");
        const needsRejoin =
          errText.includes("GROUPCALL_JOIN_MISSING") ||
          errText.includes("GROUPCALL_FORBIDDEN") ||
          errText.includes("GROUPCALL_INVALID") ||
          errText.includes("GROUPCALL_SSRC_DUPLICATE_SIMULTANEOUS");
        const looksLikeGatewayFlake =
          errText.includes("502") ||
          errText.includes("Bad Gateway") ||
          errText.includes("gateway") ||
          errText.includes("504") ||
          errText.includes("timeout") ||
          errText.includes("mute_failed");
        const cantUnmute = /Can't unmute user/i.test(errText);
        if (needsRejoin) {
          const pc = this.connection;
          const mediaLive =
            pc != null &&
            (pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed");
          if (mediaLive && isMuted) {
            // Muting while WebRTC is up — soft-skip (RTP silence swap already
            // applied). Unmute must rebind TDLib or nobody hears the mic.
            this.speakingSyncBlockedUntil = Date.now() + 8_000;
            logPageDisplay("messages_voice_mic_join_missing_soft", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: "keep WebRTC; skip tear-rejoin on mute-only JOIN_MISSING",
            });
          } else {
            // Unmute (or media dead): TDLib left while PC stayed up — soft-skip
            // left the chip open with outbound silence and GROUPCALL_JOIN_MISSING
            // on call messages. Rejoin unmuted so mic + sendGroupCallMessage work.
            this.speakingSyncBlockedUntil = Date.now() + 2_000;
            logPageDisplay("messages_voice_mic_join_missing_rejoin", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              wantUnmute: !isMuted,
              mediaLive,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: "rejoin to restore TDLib mute/speaking/messages",
            });
            this.markJoinLost(errText, { silent: true });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await this.joinInternal(isMuted);
            if (!isMuted) {
              await this.ensureLocalMic({ publish: true, enabled: true });
              if (this.audioTrack) this.audioTrack.enabled = true;
              this.micEnabled = true;
              const muteRetry = await setTelegramChatVoiceMicMuted({
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                isMuted: false,
              });
              if (!muteRetry.ok) {
                appWarn("[voice-mic-sync]", muteRetry.error, {
                  chatId: this.input.chatId,
                  groupCallId: this.input.groupCallId,
                  enabled: true,
                  note: "unmute after rejoin failed",
                });
                this.scheduleUnmuteRetry(muteRetry.error ?? "unmute_after_rejoin");
              } else {
                this.clearUnmuteRetry();
              }
            }
            this.resumeRemoteAudio();
          }
        } else if (!isMuted && (cantUnmute || looksLikeGatewayFlake)) {
          // Keep real mic published — prior path swapped to silence and set
          // micEnabled=false while the chip stayed open.
          this.micEnabled = true;
          void this.ensureLocalMic({ publish: true, enabled: true }).then(() => {
            if (this.audioTrack) this.audioTrack.enabled = true;
          });
          this.scheduleUnmuteRetry(errText || "cant_unmute");
        }
      } else if (!isMuted) {
        this.clearUnmuteRetry();
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
        const needsPresenceRejoin =
          errText.includes("GROUPCALL_JOIN_MISSING") ||
          errText.includes("GROUPCALL_FORBIDDEN") ||
          errText.includes("GROUPCALL_INVALID");
        const looksLikeGatewayFlake =
          errText.includes("502") ||
          errText.includes("Bad Gateway") ||
          errText.includes("gateway") ||
          errText.includes("504") ||
          errText.includes("timeout");
        if (needsPresenceRejoin || looksLikeGatewayFlake) {
          const pc = this.connection;
          const mediaLive =
            pc != null &&
            (pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed");
          // Unmuted + JOIN_MISSING: TDLib left while WebRTC stayed up.
          // Soft-blocking 60s left outbound silence and broke call messages.
          // Gateway 502/504 alone must not tear+rejoin (storms under load).
          if (
            needsPresenceRejoin &&
            mediaLive &&
            this.micEnabled &&
            !this.usingSilentAudio
          ) {
            this.speakingSyncBlockedUntil = Date.now() + 8_000;
            logPageDisplay("messages_voice_speaking_join_missing_rejoin", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: "rejoin to restore TDLib speaking while mic open",
            });
            void this.rejoinForTdlibPresence(false);
          } else if (mediaLive) {
            this.speakingSyncBlockedUntil = Date.now() + 30_000;
            logPageDisplay("messages_voice_speaking_join_missing_soft", {
              chatId: this.input.chatId,
              groupCallId: this.input.groupCallId,
              error: err,
              conn: pc?.connectionState ?? "none",
              ice: pc?.iceConnectionState ?? "none",
              level: "warn",
              note: needsPresenceRejoin
                ? "keep joined; block speaking sync while muted/listen-only"
                : "gateway flake — keep joined; backoff speaking sync",
            });
          } else if (needsPresenceRejoin) {
            this.markJoinLost(errText);
          } else {
            this.speakingSyncBlockedUntil = Date.now() + 15_000;
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
    const joinEpoch = ++this.joinEpoch;
    const assertJoinLive = () => {
      if (joinEpoch !== this.joinEpoch) {
        throw new Error("join_aborted");
      }
    };
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
    assertJoinLive();
    const audioTrack = this.audioTrack;
    if (!audioTrack) {
      throw new Error("microphone_unavailable");
    }
    // Always keep the WebRTC sender enabled. Telegram mute is is_muted /
    // muteGroupCallParticipant — never track.enabled=false on the live sender.
    audioTrack.enabled = true;

    const localStream = new MediaStream([audioTrack]);

    // STUN for srflx in the join payload (SFU cannot send to private hosts).
    // Docker/Hyper-V hosts are stripped after gather — that was the consent
    // poison, not STUN itself (prod: ice checking forever, inboundPackets=0).
    const connection = new RTCPeerConnection({
      iceServers: GROUP_CALL_ICE_SERVERS,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    this.pendingJoinConnection = connection;
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
        if (this.screenSharing && !this.screenShareIceProtect) {
          this.screenShareIceProtect = true;
          void this.applyScreenShareEncoding();
        }
        // Longer grace while local screen upload contends for bandwidth —
        // consent often returns without a full rejoin that drops presentation.
        const graceMs = this.screenSharing
          ? TelegramGroupCallWebSession.ICE_DISCONNECT_GRACE_SCREEN_MS
          : TelegramGroupCallWebSession.ICE_DISCONNECT_GRACE_MS;
        this.scheduleJoinLostIfStillBroken(connection, "ice_disconnected", graceMs);
        return;
      }
      this.clearJoinLostTimer();
      if (ice === "connected" || ice === "completed") {
        this.iceSoftRestartAttempted = false;
        if (this.screenShareIceProtect) {
          this.screenShareIceProtect = false;
          void this.applyScreenShareEncoding();
        }
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
        this.iceSoftRestartAttempted = false;
        if (this.screenShareIceProtect) {
          this.screenShareIceProtect = false;
          void this.applyScreenShareEncoding();
        }
        this.pullRemoteMediaTracks(connection, { audioOnly: true });
        unlockVoiceAutoplay();
        this.queueRemotePlayback("pc-connected");
        this.tryArmRemoteVideoSdpAfterHealthyMix();
      } else if (state === "failed") {
        void this.recoverFromIceFailure(`pc_${state}`);
      } else if (state === "disconnected") {
        if (this.screenSharing && !this.screenShareIceProtect) {
          this.screenShareIceProtect = true;
          void this.applyScreenShareEncoding();
        }
        const graceMs = this.screenSharing
          ? TelegramGroupCallWebSession.ICE_DISCONNECT_GRACE_SCREEN_MS
          : TelegramGroupCallWebSession.ICE_DISCONNECT_GRACE_MS;
        this.scheduleJoinLostIfStillBroken(connection, `pc_${state}`, graceMs);
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
    assertJoinLive();
    if (!offer.sdp) {
      this.pendingJoinConnection = null;
      connection.close();
      stopJoinVideoPlaceholder();
      throw new Error("offer_sdp_missing");
    }

    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") {
        resolve();
        return;
      }
      // Need host + STUN srflx before join payload — aborting muted joins at
      // 600ms left only LAN hosts and ICE never left "checking".
      const timeout = window.setTimeout(() => {
        connection.removeEventListener("icegatheringstatechange", onGather);
        resolve();
      }, GROUP_CALL_ICE_GATHER_MS);
      const onGather = () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          connection.removeEventListener("icegatheringstatechange", onGather);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", onGather);
    });
    assertJoinLive();

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
      this.pendingJoinConnection = null;
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
    assertJoinLive();
    if (!joinResult.ok) {
      this.pendingJoinConnection = null;
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
      this.pendingJoinConnection = null;
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
      this.pendingJoinConnection = null;
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
    this.pendingJoinConnection = null;
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
      if (joinEpoch !== this.joinEpoch) {
        logPageDisplay("messages_voice_sdp_answer_skip_aborted", {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          level: "warn",
        });
        return;
      }
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
        if (joinEpoch !== this.joinEpoch) return;
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
            // User opened the mic while join was still settling — do not remute.
            if (this.micEnabled && !this.usingSilentAudio) {
              logPageDisplay("messages_voice_join_listen_mute_skipped", {
                chatId: this.input.chatId,
                groupCallId: this.input.groupCallId,
                level: "info",
                note: "mic already open — skip deferred listen-only mute",
              });
              return;
            }
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
    // Host-only / bad-path ICE can sit in "checking" for a long time with
    // inboundPackets=0 before Chrome flips to failed. Rejoin once with STUN
    // srflx rather than waiting for a silent watchdog forever.
    window.setTimeout(() => {
      if (!this.joined || this.connection !== connection) return;
      if (this.isMediaConnected()) return;
      if (this.mixRtpPacketsAlive || this.heardRemoteMixAudio) return;
      if (this.iceRecoverInFlight || this.audioRecoverInFlight) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      if (
        ice === "checking" ||
        ice === "new" ||
        (conn === "connecting" && ice !== "connected" && ice !== "completed")
      ) {
        logPageDisplay("messages_voice_ice_stuck_checking", {
          chatId: joinChatId,
          groupCallId: joinCallId,
          ice,
          conn,
          recoverCount: this.iceRecoverCount,
          level: "error",
          note: "ICE never nominated after answer — silent rejoin for mix RTP",
        });
        void this.recoverFromIceFailure("ice_stuck_checking");
      }
    }, 8_000);
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
    this.clearPresentationIceDisconnectTimer();
    this.clearVideoRenegotiateConnectWait();
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.remotePlaybackSink = "html_audio";
    this.preferHtmlRemotePlayback = true;
    this.remoteSilenceTicks = 0;
    this.heardRemoteMixAudio = false;
    this.lastHeardMixAudioAt = 0;
    this.mixRtpPacketsAlive = false;
    this.preferExplicitWhenMixHealthyPending = false;
    if (this.preferExplicitWhenMixHealthyTimer) {
      clearTimeout(this.preferExplicitWhenMixHealthyTimer);
      this.preferExplicitWhenMixHealthyTimer = null;
    }
    this.setMixPausedScreenEndpoints([]);
    this.mixPausedScreenListeners.clear();
    this.mixProtectScreenAutoRestorePending = false;
    this.mixProtectScreenAutoRestoreUsed = false;
    this.firstRemoteVideoFrameAt = 0;
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
    this.explicitVideoSubscribeArmed = false;
    this.explicitVideoSubscribeSession = false;
    this.preferredExplicitVideoEndpointId = null;
    this.audioRecoverAfterVideoDone = false;
    this.audioRecoverInFlight = false;
    this.audioRecoverCount = 0;
    this.iceRecoverInFlight = false;
    this.iceRecoverCount = 0;
    this.iceSoftRestartAttempted = false;
    this.screenShareIceProtect = false;
    this.presentationAudioIsSystem = false;
    this.preferStableScreencast = false;
    this.autoResubAfterMixStallUsed = false;
    this.mixProtectScreenAutoRestorePending = false;
    this.mixProtectScreenAutoRestoreUsed = false;
    this.firstRemoteVideoFrameAt = 0;
    this.remoteVideoRepushEpoch = 0;
    this.remoteVideoRepushListeners.clear();
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
    this.videoDropToRestoreMixCount = 0;
    this.mixPacketsAtLastVideoDrop = 0;
    this.lastVideoDropToRestoreMixAt = 0;
    this.stripVideoInFlight = false;
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
    this.clearUnmuteRetry();
    this.micPrefetch = null;
    this.speakingListeners.clear();
    this.localMediaListeners.clear();
  }
}
