import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { appWarn } from "../../shared/appLog";
import { leaveTelegramChatVoice } from "./leaveTelegramChatVoice";
import {
  TelegramGroupCallWebSession,
  type TelegramRemoteVideoRequest,
  type TelegramRemoteVideoSource,
} from "./telegramGroupCallWebSession";
import { unlockVoiceAutoplay } from "./unlockVoiceAutoplay";

type Input = {
  chatId: number;
  groupCallId: number | null;
  /**
   * Keep a WebRTC session shell alive. Media joins via `joinListen` /
   * `toggleMic` once the parent sets `active` after explicit Join.
   */
  active: boolean;
  /**
   * Whether the chat dialog is currently on-screen. When false (panel hidden /
   * user navigated away) remote audio is muted so voice is only heard in-dialog.
   * Defaults to true.
   */
  visible?: boolean;
};

export type TelegramVoiceSession = {
  micActive: boolean;
  cameraActive: boolean;
  screenSharing: boolean;
  localSpeaking: boolean;
  /** True while mixed remote WebRTC audio has speech energy (green-mic fallback). */
  remoteSpeaking: boolean;
  joining: boolean;
  joined: boolean;
  mediaConnected: boolean;
  /** ICE / presentation recover — show reconnect overlay on screen/video. */
  mediaReconnecting: boolean;
  /** Voice ICE recover — mute mix, pastel mic flash, soft reconnect ticks. */
  voiceReconnecting: boolean;
  negotiating: boolean;
  error: string | null;
  /** Live remote camera / screen-share stream while someone is presenting. */
  remoteVideoStream: MediaStream | null;
  /** Per-endpoint remote video (camera / screen) for multi-stream UI. */
  remoteVideoSources: TelegramRemoteVideoSource[];
  localCameraStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  unlockAudio: () => void;
  /** Start getUserMedia during the Join click (before SDP). */
  prefetchMic: () => void;
  /**
   * Resolves when the WebRTC join finishes (or was already joined).
   * Pass `startMuted: false` when the account is already unmuted in the call
   * (another client) so web join does not remute and paint a red self mic.
   * On failure, `error` is set synchronously so callers can honor FLOOD_WAIT.
   */
  joinListen: (opts?: {
    startMuted?: boolean;
  }) => Promise<{ ok: boolean; error?: string | null }>;
  /**
   * Force TDLib rejoin while keeping (or restoring) mic state. Used when mute /
   * speaking / in-call messages fail with GROUPCALL_JOIN_MISSING despite a live PC.
   */
  rejoinForTdlib: (opts?: { startMuted?: boolean }) => Promise<boolean>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  startScreenShare: (preacquiredStream?: MediaStream | null) => Promise<void>;
  stopScreenShare: () => Promise<void>;
  /** Subscribe to remote camera / screencast publishers from the roster. */
  setRemoteVideoRequests: (requests: TelegramRemoteVideoRequest[]) => void;
  /**
   * User unmuted a screencast in the participant menu — arm video SDP even when
   * mix RMS is quiet (and clear a prior stall sticky-block). Pass the screen
   * endpoint so a 2nd unmute wins over sticky first share under the cap.
   */
  preferExplicitRemoteVideoSubscribe: (
    preferredEndpointId?: string | null,
    opts?: { autoShow?: boolean },
  ) => void;
  /**
   * Bumps when the session clears remote video (mix stall) or arms an unmute
   * with an empty request list — VoiceBar must re-apply roster publishers.
   */
  remoteVideoRepushEpoch: number;
  /**
   * Screencast endpoints paused after mix-protect drop. Treat as screen-muted
   * for subscribe/UI until preferExplicitRemoteVideoSubscribe clears them.
   */
  mixPausedScreenEndpoints: string[];
  /**
   * Latest mix-protect pause followed live remote video (not a zero-RTP ghost).
   * VoiceBar must soft-mute without failover / failed-endpoint bans when a
   * one-shot restore is also pending.
   */
  mixProtectDropHadLiveVideo: boolean;
  /**
   * Session armed a one-shot screen restore after mix-protect drop. When false
   * with a live drop, VoiceBar should ban the endpoint (not keep unmute chrome).
   */
  mixProtectScreenAutoRestorePending: boolean;
  /** Local WebAudio listen volumes for the mixed remote track (0–200%). */
  setParticipantListenVolumes: (input: {
    volumes: Record<string, number>;
    speakingKeys?: string[];
    participantKeys?: string[];
  }) => void;
  /** Rebuild remote mix playback after stalls / tab focus / silent-mix heal. */
  kickRemotePlayback: (reason?: string) => void;
  setScreenShareDisplaySize: (width: number, height: number) => void;
  leaveVoice: () => Promise<
    Awaited<ReturnType<typeof leaveTelegramChatVoice>>
  >;
};

export function useTelegramVoiceSession({
  chatId,
  groupCallId,
  active,
  visible = true,
}: Input): TelegramVoiceSession {
  const [micActive, setMicActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [mediaConnected, setMediaConnected] = useState(false);
  const [mediaReconnecting, setMediaReconnecting] = useState(false);
  const [voiceReconnecting, setVoiceReconnecting] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoSources, setRemoteVideoSources] = useState<TelegramRemoteVideoSource[]>([]);
  const [remoteVideoRepushEpoch, setRemoteVideoRepushEpoch] = useState(0);
  const [mixPausedScreenEndpoints, setMixPausedScreenEndpoints] = useState<
    string[]
  >([]);
  const [mixProtectDropHadLiveVideo, setMixProtectDropHadLiveVideo] =
    useState(false);
  const [
    mixProtectScreenAutoRestorePending,
    setMixProtectScreenAutoRestorePending,
  ] = useState(false);
  const [localCameraStream, setLocalCameraStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const sessionRef = useRef<TelegramGroupCallWebSession | null>(null);
  const micActiveRef = useRef(false);
  const micToggleGenRef = useRef(0);
  const cameraActiveRef = useRef(false);
  const joinedRef = useRef(false);
  const joiningRef = useRef(false);
  const unloadLeftRef = useRef(false);
  const groupCallIdRef = useRef(groupCallId);
  groupCallIdRef.current = groupCallId;

  const speakingUnsubRef = useRef<(() => void) | null>(null);
  const remoteSpeakingUnsubRef = useRef<(() => void) | null>(null);
  const joinLostUnsubRef = useRef<(() => void) | null>(null);
  const videoUnsubRef = useRef<(() => void) | null>(null);
  const videoSourcesUnsubRef = useRef<(() => void) | null>(null);
  const videoRepushUnsubRef = useRef<(() => void) | null>(null);
  const mixPausedUnsubRef = useRef<(() => void) | null>(null);
  const localMediaUnsubRef = useRef<(() => void) | null>(null);

  const resetLocalUi = useCallback(() => {
    setJoined(false);
    joinedRef.current = false;
    setMediaConnected(false);
    setMediaReconnecting(false);
    setVoiceReconnecting(false);
    setNegotiating(false);
    setJoining(false);
    joiningRef.current = false;
    setMicActive(false);
    setCameraActive(false);
    setScreenSharing(false);
    setLocalSpeaking(false);
    setRemoteSpeaking(false);
    setRemoteVideoStream(null);
    setRemoteVideoSources([]);
    setRemoteVideoRepushEpoch(0);
    setMixPausedScreenEndpoints([]);
    setMixProtectDropHadLiveVideo(false);
    setMixProtectScreenAutoRestorePending(false);
    setLocalCameraStream(null);
    setLocalScreenStream(null);
    micActiveRef.current = false;
    cameraActiveRef.current = false;
  }, []);

  const disposeSession = useCallback((opts?: { fromUnload?: boolean }) => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    remoteSpeakingUnsubRef.current?.();
    remoteSpeakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
    videoSourcesUnsubRef.current?.();
    videoSourcesUnsubRef.current = null;
    videoRepushUnsubRef.current?.();
    videoRepushUnsubRef.current = null;
    mixPausedUnsubRef.current?.();
    mixPausedUnsubRef.current = null;
    localMediaUnsubRef.current?.();
    localMediaUnsubRef.current = null;
    const session = sessionRef.current;
    const wasJoined =
      Boolean(session?.isJoined) || joinedRef.current || joiningRef.current;
    // Snapshot before dispose / before parent can overwrite groupCallIdRef on
    // chat switch — leaving chat A with B's call id left TDLib JOIN_MISSING.
    const leaveChatId = session?.chatId ?? chatId;
    const leaveGroupCallId = session?.groupCallId ?? groupCallIdRef.current;
    session?.dispose();
    sessionRef.current = null;
    if (wasJoined && !unloadLeftRef.current) {
      if (opts?.fromUnload) unloadLeftRef.current = true;
      void leaveTelegramChatVoice(leaveChatId, leaveGroupCallId, {
        keepalive: true,
      }).catch(() => undefined);
    }
    resetLocalUi();
  }, [chatId, resetLocalUi]);

  const bindSession = useCallback(
    (session: TelegramGroupCallWebSession) => {
      speakingUnsubRef.current?.();
      remoteSpeakingUnsubRef.current?.();
      joinLostUnsubRef.current?.();
      videoUnsubRef.current?.();
      videoSourcesUnsubRef.current?.();
      videoRepushUnsubRef.current?.();
      mixPausedUnsubRef.current?.();
      localMediaUnsubRef.current?.();
      speakingUnsubRef.current = session.onLocalSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
      remoteSpeakingUnsubRef.current = session.onRemoteSpeakingChange((speaking) => {
        setRemoteSpeaking(speaking);
      });
      joinLostUnsubRef.current = session.onJoinLost(() => {
        setJoined(false);
        joinedRef.current = false;
        setMediaConnected(false);
        setNegotiating(false);
        setMicActive(false);
        setCameraActive(false);
        setScreenSharing(false);
        setLocalSpeaking(false);
        setRemoteSpeaking(false);
        setRemoteVideoStream(null);
        setRemoteVideoSources([]);
        setRemoteVideoRepushEpoch(0);
        setMixPausedScreenEndpoints([]);
        setLocalCameraStream(null);
        setLocalScreenStream(null);
        micActiveRef.current = false;
        cameraActiveRef.current = false;
      });
      videoUnsubRef.current = session.onRemoteVideoChange((stream) => {
        setRemoteVideoStream(stream);
      });
      videoSourcesUnsubRef.current = session.onRemoteVideoSourcesChange((sources) => {
        setRemoteVideoSources((prev) => {
          if (
            prev.length === sources.length &&
            prev.every(
              (row, i) =>
                row.endpointId === sources[i]?.endpointId &&
                row.kind === sources[i]?.kind &&
                row.stream === sources[i]?.stream,
            )
          ) {
            return prev;
          }
          return sources;
        });
      });
      videoRepushUnsubRef.current = session.onRemoteVideoRepushNeeded((epoch) => {
        setRemoteVideoRepushEpoch(epoch);
      });
      mixPausedUnsubRef.current = session.onMixPausedScreensChange((endpoints) => {
        const hadLive =
          typeof session.getLastMixProtectDropHadLiveVideo === "function"
            ? session.getLastMixProtectDropHadLiveVideo()
            : false;
        const restorePending =
          typeof session.getMixProtectScreenAutoRestorePending === "function"
            ? session.getMixProtectScreenAutoRestorePending()
            : false;
        setMixProtectDropHadLiveVideo(endpoints.length > 0 ? hadLive : false);
        setMixProtectScreenAutoRestorePending(
          endpoints.length > 0 ? restorePending : false,
        );
        setMixPausedScreenEndpoints((prev) => {
          if (
            prev.length === endpoints.length &&
            prev.every((id, i) => id === endpoints[i])
          ) {
            return prev;
          }
          return endpoints;
        });
      });
      localMediaUnsubRef.current = session.onLocalMediaChange((state) => {
        setCameraActive(state.cameraActive);
        setScreenSharing(state.screenSharing);
        setLocalCameraStream(state.localCameraStream);
        setLocalScreenStream(state.localScreenStream);
        cameraActiveRef.current = state.cameraActive;
      });
    },
    [],
  );

  const createSessionShell = useCallback(() => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    remoteSpeakingUnsubRef.current?.();
    remoteSpeakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
    videoSourcesUnsubRef.current?.();
    videoSourcesUnsubRef.current = null;
    videoRepushUnsubRef.current?.();
    videoRepushUnsubRef.current = null;
    mixPausedUnsubRef.current?.();
    mixPausedUnsubRef.current = null;
    localMediaUnsubRef.current?.();
    localMediaUnsubRef.current = null;
    sessionRef.current?.dispose();
    const session = new TelegramGroupCallWebSession({
      chatId,
      groupCallId: groupCallIdRef.current,
    });
    sessionRef.current = session;
    bindSession(session);
    setError(null);
    setRemoteVideoStream(null);
    setRemoteVideoSources([]);
    setRemoteVideoRepushEpoch(0);
    setMixPausedScreenEndpoints([]);
    setMixProtectDropHadLiveVideo(false);
    setMixProtectScreenAutoRestorePending(false);
    setLocalCameraStream(null);
    setLocalScreenStream(null);
    setScreenSharing(false);
    setCameraActive(false);
    cameraActiveRef.current = false;
    return session;
  }, [bindSession, chatId]);

  // Remount only when the chat changes — call-id refreshes must not drop WebRTC.
  useEffect(() => {
    if (!active || Platform.OS !== "web") {
      disposeSession();
      return;
    }

    unloadLeftRef.current = false;
    createSessionShell();
    resetLocalUi();

    return () => {
      disposeSession();
    };
  }, [active, chatId, createSessionShell, disposeSession, resetLocalUi]);

  // Tab/app close aborts in-flight leave fetch — fire keepalive leave on pagehide.
  useEffect(() => {
    if (!active || Platform.OS !== "web") return;
    const leaveForUnload = () => {
      if (unloadLeftRef.current) return;
      const session = sessionRef.current;
      const inCall =
        Boolean(session?.isJoined) || joinedRef.current || joiningRef.current;
      if (!inCall) return;
      disposeSession({ fromUnload: true });
    };
    window.addEventListener("pagehide", leaveForUnload);
    window.addEventListener("beforeunload", leaveForUnload);
    return () => {
      window.removeEventListener("pagehide", leaveForUnload);
      window.removeEventListener("beforeunload", leaveForUnload);
    };
  }, [active, disposeSession]);

  useEffect(() => {
    sessionRef.current?.updateGroupCallId(groupCallId);
  }, [groupCallId]);

  // Keep remote audio while joined — including minimized strip / other menus
  // (Swap/Trade/…). Mute mix only while voice ICE is reconnecting so
  // the soft reconnect tick can be heard instead of broken audio.
  // Presentation-only recover keeps remote voice audible.
  // Do NOT disable when joined===false: that raced join SDP
  // (playback_kick remoteAudioEnabled=false) and tore down WebAudio mid-apply.
  // Leaving/dispose is the only way to stop hearing.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!joined) return;
    const session = sessionRef.current;
    if (!session) return;
    if (voiceReconnecting) {
      session.setRemoteAudioEnabled(false);
      return;
    }
    session.setRemoteAudioEnabled(true);
    session.resumeRemoteAudio();
  }, [joined, mediaConnected, voiceReconnecting]);

  useEffect(() => {
    if (!joined || Platform.OS !== "web") return;
    const tick = () => {
      const session = sessionRef.current;
      if (!session?.isJoined) {
        setMediaConnected(false);
        setMediaReconnecting(false);
        setVoiceReconnecting(false);
        setNegotiating(false);
        return;
      }
      setMediaConnected(session.isMediaConnected());
      setMediaReconnecting(session.isMediaReconnecting());
      setVoiceReconnecting(session.isVoiceReconnecting());
      setNegotiating(session.isNegotiating());
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [joined]);

  const joinListen = useCallback(async (opts?: {
    startMuted?: boolean;
  }): Promise<{ ok: boolean; error?: string | null }> => {
    if (Platform.OS !== "web") return { ok: false, error: "unsupported" };
    const session = sessionRef.current;
    if (!session) return { ok: false, error: "no_session" };
    const startMuted = opts?.startMuted !== false;
    if (session.isJoined) {
      setJoined(true);
      joinedRef.current = true;
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      session.setRemoteAudioEnabled(true);
      session.resumeRemoteAudio();
      return { ok: true };
    }
    if (session.isNegotiating()) {
      setJoined(false);
      joinedRef.current = false;
      setNegotiating(true);
      return { ok: false, error: "negotiating" };
    }

    setMediaConnected(false);
    setNegotiating(false);
    setJoining(true);
    joiningRef.current = true;
    setError(null);
    // Enable sinks before SDP/ontrack — otherwise apply_ok playback_kick runs
    // with remoteAudioEnabled=false and tears WebAudio down until joined flips.
    session.setRemoteAudioEnabled(true);
    // Default listen-only: mic/camera/screen off. Preserve-unmuted joins keep
    // micActive true so self row / chip match Telegram (no remute red X).
    micActiveRef.current = !startMuted;
    setMicActive(!startMuted);
    cameraActiveRef.current = false;
    setCameraActive(false);
    setScreenSharing(false);
    setLocalCameraStream(null);
    setLocalScreenStream(null);
    if (session.isScreenSharing || session.isCameraEnabled) {
      void session.stopScreenShare().catch(() => undefined);
      void session.setCameraEnabled(false).catch(() => undefined);
    }
    if (!startMuted) {
      session.prefetchLocalMic();
    }
    let joinWatchdog: ReturnType<typeof setTimeout> | null = null;
    try {
      // 45s: createOffer + ICE gather + joinVideoChat routinely exceeds 20s when
      // the main thread is busy (emoji/history). Timing out without abort left a
      // zombie PeerConnection that raced the retry and cut remote media.
      const JOIN_WATCHDOG_MS = 45_000;
      const joinedOk = await Promise.race([
        session
          .ensureJoinedListenOnly(startMuted)
          .then(() => true as const)
          .catch((err: unknown) => {
            // Watchdog abort rejects joinInternal — already counted as timeout.
            if (err instanceof Error && err.message === "join_aborted") {
              return false as const;
            }
            throw err;
          }),
        new Promise<false>((resolve) => {
          joinWatchdog = setTimeout(() => resolve(false), JOIN_WATCHDOG_MS);
        }),
      ]);
      if (joinWatchdog) {
        clearTimeout(joinWatchdog);
        joinWatchdog = null;
      }
      // Late success: join finished just after the race — keep the media.
      if (!joinedOk && session.isJoined) {
        setJoined(true);
        joinedRef.current = true;
        setMediaConnected(session.isMediaConnected());
        setNegotiating(session.isNegotiating());
        session.setRemoteAudioEnabled(true);
        session.resumeRemoteAudio();
        const enabled = session.isMicEnabled;
        micActiveRef.current = enabled;
        setMicActive(enabled);
        return { ok: true };
      }
      if (!joinedOk) {
        session.abortInFlightJoin("voice_join_timeout");
        setError("voice_join_timeout");
        appWarn("[voice-session-join]", "voice_join_timeout", { chatId, groupCallId });
        return { ok: false, error: "voice_join_timeout" };
      }
      setJoined(true);
      joinedRef.current = true;
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      session.setRemoteAudioEnabled(true);
      // Kick playback again after join_ok — apply_ok already started sinks; this
      // catches late ontrack and reuses the Join-gesture AudioContext (tweb wires
      // WebAudio on track without waiting for another click).
      session.resumeRemoteAudio();
      const enabled = session.isMicEnabled;
      micActiveRef.current = enabled;
      setMicActive(enabled);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "voice_join_failed";
      if (message === "join_aborted") {
        setError("voice_join_timeout");
        appWarn("[voice-session-join]", "voice_join_timeout", {
          chatId,
          groupCallId,
          note: "join_aborted",
        });
        return { ok: false, error: "voice_join_timeout" };
      }
      setError(message);
      appWarn("[voice-session-join]", message, { chatId, groupCallId });
      return { ok: false, error: message };
    } finally {
      if (joinWatchdog) clearTimeout(joinWatchdog);
      setJoining(false);
      joiningRef.current = false;
    }
  }, [chatId, groupCallId]);

  const rejoinForTdlib = useCallback(async (opts?: { startMuted?: boolean }): Promise<boolean> => {
    if (Platform.OS !== "web") return false;
    const session = sessionRef.current;
    if (!session) return false;
    const startMuted = opts?.startMuted !== false;
    setJoining(true);
    joiningRef.current = true;
    setError(null);
    micActiveRef.current = !startMuted;
    setMicActive(!startMuted);
    try {
      const ok = await session.rejoinForTdlibPresence(startMuted);
      setJoined(ok);
      joinedRef.current = ok;
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      if (ok) {
        session.setRemoteAudioEnabled(true);
        session.resumeRemoteAudio();
        const enabled = session.isMicEnabled;
        micActiveRef.current = enabled;
        setMicActive(enabled);
      }
      return ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : "voice_rejoin_failed";
      setError(message);
      appWarn("[voice-session-rejoin]", message, { chatId, groupCallId });
      return false;
    } finally {
      setJoining(false);
      joiningRef.current = false;
    }
  }, [chatId, groupCallId]);

  const unlockAudio = useCallback(() => {
    sessionRef.current?.unlockRemoteAudio();
  }, []);

  const prefetchMic = useCallback(() => {
    sessionRef.current?.prefetchLocalMic();
  }, []);

  const toggleMic = useCallback(() => {
    const next = !micActiveRef.current;
    micActiveRef.current = next;
    setMicActive(next);
    if (!next) setLocalSpeaking(false);

    const session = sessionRef.current;
    if (!session || Platform.OS !== "web") return;

    const toggleGen = (micToggleGenRef.current += 1);
    setError(null);
    if (next) unlockVoiceAutoplay();
    session.unlockRemoteAudio();
    // Never await here — mute/unmute chip must flip instantly; network sync is background.
    void session
      .setMicEnabled(next)
      .then(() => {
        // Ignore stale applies after a newer tap (prevents on→off flicker).
        if (toggleGen !== micToggleGenRef.current) return;
        setJoined(session.isJoined);
        setMediaConnected(session.isMediaConnected());
        session.resumeRemoteAudio();
        const enabled = session.isMicEnabled;
        micActiveRef.current = enabled;
        setMicActive(enabled);
        if (!enabled) setLocalSpeaking(false);
      })
      .catch((err) => {
        if (toggleGen !== micToggleGenRef.current) return;
        const message = err instanceof Error ? err.message : "mic_toggle_failed";
        setError(message);
        micActiveRef.current = session.isMicEnabled;
        setMicActive(session.isMicEnabled);
        appWarn("[voice-session-mic]", message, { chatId, groupCallId });
      });
  }, [chatId, groupCallId]);

  const toggleCamera = useCallback(async () => {
    const next = !cameraActiveRef.current;
    cameraActiveRef.current = next;
    setCameraActive(next);

    const session = sessionRef.current;
    if (!session || Platform.OS !== "web") return;

    try {
      setError(null);
      session.unlockRemoteAudio();
      await session.setCameraEnabled(next);
      setJoined(session.isJoined);
      setMediaConnected(session.isMediaConnected());
      const enabled = session.isCameraEnabled;
      cameraActiveRef.current = enabled;
      setCameraActive(enabled);
      setLocalCameraStream(session.getLiveLocalCameraStream());
    } catch (err) {
      const message = err instanceof Error ? err.message : "camera_toggle_failed";
      setError(message);
      cameraActiveRef.current = session.isCameraEnabled;
      setCameraActive(session.isCameraEnabled);
      setLocalCameraStream(session.getLiveLocalCameraStream());
      appWarn("[voice-session-camera]", message, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

  const startScreenShare = useCallback(
    async (preacquiredStream?: MediaStream | null) => {
      const session = sessionRef.current;
      if (!session || Platform.OS !== "web") {
        setError("screen_share_unavailable");
        return;
      }
      try {
        setError(null);
        session.unlockRemoteAudio();
        await session.startScreenShare(preacquiredStream);
        setJoined(session.isJoined);
        setMediaConnected(session.isMediaConnected());
        setScreenSharing(session.isScreenSharing);
        setLocalScreenStream(session.getLiveLocalScreenStream());
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "screen_share_failed";
        setError(message);
        setScreenSharing(session.isScreenSharing);
        setLocalScreenStream(session.getLiveLocalScreenStream());
        appWarn("[voice-session-screen]", message, { chatId, groupCallId });
      }
    },
    [chatId, groupCallId],
  );

  const stopScreenShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || Platform.OS !== "web") return;
    try {
      setError(null);
      await session.stopScreenShare();
      setScreenSharing(false);
      setLocalScreenStream(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "screen_share_stop_failed";
      setError(message);
      setScreenSharing(session.isScreenSharing);
      setLocalScreenStream(session.getLiveLocalScreenStream());
      appWarn("[voice-session-screen-stop]", message, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

  const setRemoteVideoRequests = useCallback((requests: TelegramRemoteVideoRequest[]) => {
    sessionRef.current?.setRequestedRemoteVideos(requests);
  }, []);

  const preferExplicitRemoteVideoSubscribe = useCallback(
    (
      preferredEndpointId?: string | null,
      opts?: { autoShow?: boolean },
    ) => {
      sessionRef.current?.preferExplicitRemoteVideoSubscribe(
        preferredEndpointId,
        opts,
      );
    },
    [],
  );

  const setParticipantListenVolumes = useCallback(
    (input: {
      volumes: Record<string, number>;
      speakingKeys?: string[];
      participantKeys?: string[];
    }) => {
      sessionRef.current?.setParticipantListenVolumes(input);
    },
    [],
  );

  const kickRemotePlayback = useCallback((reason?: string) => {
    sessionRef.current?.kickRemotePlayback(reason);
  }, []);

  const setScreenShareDisplaySize = useCallback((width: number, height: number) => {
    sessionRef.current?.setScreenShareDisplaySize(width, height);
  }, []);

  const leaveVoice = useCallback(async () => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    remoteSpeakingUnsubRef.current?.();
    remoteSpeakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
    videoSourcesUnsubRef.current?.();
    videoSourcesUnsubRef.current = null;
    videoRepushUnsubRef.current?.();
    videoRepushUnsubRef.current = null;
    mixPausedUnsubRef.current?.();
    mixPausedUnsubRef.current = null;
    localMediaUnsubRef.current?.();
    localMediaUnsubRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    unloadLeftRef.current = true;
    const result = await leaveTelegramChatVoice(chatId, groupCallId, {
      keepalive: true,
    });
    unloadLeftRef.current = false;
    createSessionShell();
    resetLocalUi();
    return result;
  }, [chatId, createSessionShell, groupCallId, resetLocalUi]);

  return {
    micActive,
    cameraActive,
    screenSharing,
    localSpeaking,
    remoteSpeaking,
    joining,
    joined,
    mediaConnected,
    mediaReconnecting,
    voiceReconnecting,
    negotiating,
    error,
    remoteVideoStream,
    remoteVideoSources,
    remoteVideoRepushEpoch,
    mixPausedScreenEndpoints,
    mixProtectDropHadLiveVideo,
    mixProtectScreenAutoRestorePending,
    localCameraStream,
    localScreenStream,
    unlockAudio,
    prefetchMic,
    joinListen,
    rejoinForTdlib,
    toggleMic,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    setRemoteVideoRequests,
    preferExplicitRemoteVideoSubscribe,
    setParticipantListenVolumes,
    kickRemotePlayback,
    setScreenShareDisplaySize,
    leaveVoice,
  };
}
