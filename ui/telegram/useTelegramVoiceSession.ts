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
  /** Resolves true when the WebRTC join succeeded (or was already joined). */
  joinListen: () => Promise<boolean>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  /** Subscribe to remote camera / screencast publishers from the roster. */
  setRemoteVideoRequests: (requests: TelegramRemoteVideoRequest[]) => void;
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
  const [negotiating, setNegotiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoSources, setRemoteVideoSources] = useState<TelegramRemoteVideoSource[]>([]);
  const [localCameraStream, setLocalCameraStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const sessionRef = useRef<TelegramGroupCallWebSession | null>(null);
  const micActiveRef = useRef(false);
  const cameraActiveRef = useRef(false);
  const groupCallIdRef = useRef(groupCallId);
  groupCallIdRef.current = groupCallId;

  const speakingUnsubRef = useRef<(() => void) | null>(null);
  const remoteSpeakingUnsubRef = useRef<(() => void) | null>(null);
  const joinLostUnsubRef = useRef<(() => void) | null>(null);
  const videoUnsubRef = useRef<(() => void) | null>(null);
  const videoSourcesUnsubRef = useRef<(() => void) | null>(null);
  const localMediaUnsubRef = useRef<(() => void) | null>(null);

  const resetLocalUi = useCallback(() => {
    setJoined(false);
    setMediaConnected(false);
    setNegotiating(false);
    setJoining(false);
    setMicActive(false);
    setCameraActive(false);
    setScreenSharing(false);
    setLocalSpeaking(false);
    setRemoteSpeaking(false);
    setRemoteVideoStream(null);
    setRemoteVideoSources([]);
    setLocalCameraStream(null);
    setLocalScreenStream(null);
    micActiveRef.current = false;
    cameraActiveRef.current = false;
  }, []);

  const disposeSession = useCallback(() => {
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
    localMediaUnsubRef.current?.();
    localMediaUnsubRef.current = null;
    const wasJoined = Boolean(sessionRef.current?.isJoined);
    sessionRef.current?.dispose();
    sessionRef.current = null;
    if (wasJoined) {
      void leaveTelegramChatVoice(chatId, groupCallIdRef.current).catch(() => undefined);
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
      localMediaUnsubRef.current?.();
      speakingUnsubRef.current = session.onLocalSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
      remoteSpeakingUnsubRef.current = session.onRemoteSpeakingChange((speaking) => {
        setRemoteSpeaking(speaking);
      });
      joinLostUnsubRef.current = session.onJoinLost(() => {
        setJoined(false);
        setMediaConnected(false);
        setNegotiating(false);
        setMicActive(false);
        setCameraActive(false);
        setScreenSharing(false);
        setLocalSpeaking(false);
        setRemoteSpeaking(false);
        setRemoteVideoStream(null);
        setRemoteVideoSources([]);
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

    createSessionShell();
    resetLocalUi();

    return () => {
      disposeSession();
    };
  }, [active, chatId, createSessionShell, disposeSession, resetLocalUi]);

  useEffect(() => {
    sessionRef.current?.updateGroupCallId(groupCallId);
  }, [groupCallId]);

  // Keep remote audio while joined — including minimized strip / other menus
  // (Swap/Trade/…). Do NOT disable when joined===false: that raced join SDP
  // (playback_kick remoteAudioEnabled=false) and tore down WebAudio mid-apply.
  // Leaving/dispose is the only way to stop hearing.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!joined) return;
    sessionRef.current?.setRemoteAudioEnabled(true);
    sessionRef.current?.resumeRemoteAudio();
  }, [joined, mediaConnected]);

  useEffect(() => {
    if (!joined || Platform.OS !== "web") return;
    const id = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session?.isJoined) {
        setMediaConnected(false);
        setNegotiating(false);
        return;
      }
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
    }, 1_500);
    return () => window.clearInterval(id);
  }, [joined]);

  const joinListen = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "web") return false;
    const session = sessionRef.current;
    if (!session) return false;
    if (session.isJoined) {
      setJoined(true);
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      session.setRemoteAudioEnabled(true);
      session.resumeRemoteAudio();
      return true;
    }
    if (session.isNegotiating()) {
      setJoined(false);
      setNegotiating(true);
      return false;
    }

    setMediaConnected(false);
    setNegotiating(false);
    setJoining(true);
    setError(null);
    // Enable sinks before SDP/ontrack — otherwise apply_ok playback_kick runs
    // with remoteAudioEnabled=false and tears WebAudio down until joined flips.
    session.setRemoteAudioEnabled(true);
    // Enter listen-only with mic/camera/screen off (parity with muted join).
    micActiveRef.current = false;
    setMicActive(false);
    cameraActiveRef.current = false;
    setCameraActive(false);
    setScreenSharing(false);
    setLocalCameraStream(null);
    setLocalScreenStream(null);
    if (session.isScreenSharing || session.isCameraEnabled) {
      void session.stopScreenShare().catch(() => undefined);
      void session.setCameraEnabled(false).catch(() => undefined);
    }
    let joinWatchdog: ReturnType<typeof setTimeout> | null = null;
    try {
      const joinedOk = await Promise.race([
        session.ensureJoinedListenOnly().then(() => true as const),
        new Promise<false>((resolve) => {
          joinWatchdog = setTimeout(() => resolve(false), 20_000);
        }),
      ]);
      if (joinWatchdog) {
        clearTimeout(joinWatchdog);
        joinWatchdog = null;
      }
      if (!joinedOk) {
        setError("voice_join_timeout");
        appWarn("[voice-session-join]", "voice_join_timeout", { chatId, groupCallId });
        return false;
      }
      setJoined(true);
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      session.setRemoteAudioEnabled(true);
      // Kick playback again after join_ok — apply_ok already started sinks; this
      // catches late ontrack and reuses the Join-gesture AudioContext (tweb wires
      // WebAudio on track without waiting for another click).
      session.resumeRemoteAudio();
      // Join muted: keep silent outbound RTP until the user unmutes. Auto-mic-on
      // raced the silent sender (usingSilentAudio flipped early) and also
      // contradicted enter-with-mic-off UX.
      micActiveRef.current = false;
      setMicActive(false);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "voice_join_failed";
      setError(message);
      appWarn("[voice-session-join]", message, { chatId, groupCallId });
      return false;
    } finally {
      if (joinWatchdog) clearTimeout(joinWatchdog);
      setJoining(false);
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

    setError(null);
    if (next) unlockVoiceAutoplay();
    session.unlockRemoteAudio();
    // Never await here — mute/unmute chip must flip instantly; network sync is background.
    void session
      .setMicEnabled(next)
      .then(() => {
        setJoined(session.isJoined);
        setMediaConnected(session.isMediaConnected());
        session.resumeRemoteAudio();
        const enabled = session.isMicEnabled;
        micActiveRef.current = enabled;
        setMicActive(enabled);
        if (!enabled) setLocalSpeaking(false);
      })
      .catch((err) => {
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

  const startScreenShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || Platform.OS !== "web") return;
    try {
      setError(null);
      session.unlockRemoteAudio();
      await session.startScreenShare();
      setJoined(session.isJoined);
      setMediaConnected(session.isMediaConnected());
      setScreenSharing(session.isScreenSharing);
      setLocalScreenStream(session.getLiveLocalScreenStream());
    } catch (err) {
      const message = err instanceof Error ? err.message : "screen_share_failed";
      setError(message);
      setScreenSharing(session.isScreenSharing);
      setLocalScreenStream(session.getLiveLocalScreenStream());
      appWarn("[voice-session-screen]", message, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

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
    localMediaUnsubRef.current?.();
    localMediaUnsubRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    const result = await leaveTelegramChatVoice(chatId, groupCallId);
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
    negotiating,
    error,
    remoteVideoStream,
    remoteVideoSources,
    localCameraStream,
    localScreenStream,
    unlockAudio,
    prefetchMic,
    joinListen,
    toggleMic,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    setRemoteVideoRequests,
    setScreenShareDisplaySize,
    leaveVoice,
  };
}
