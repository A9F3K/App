import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { appWarn } from "../../shared/appLog";
import { leaveTelegramChatVoice } from "./leaveTelegramChatVoice";
import { TelegramGroupCallWebSession } from "./telegramGroupCallWebSession";

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
  localSpeaking: boolean;
  joining: boolean;
  joined: boolean;
  mediaConnected: boolean;
  negotiating: boolean;
  error: string | null;
  /** Live remote camera / screen-share stream while someone is presenting. */
  remoteVideoStream: MediaStream | null;
  unlockAudio: () => void;
  /** Resolves true when the WebRTC join succeeded (or was already joined). */
  joinListen: () => Promise<boolean>;
  toggleMic: () => Promise<void>;
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
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [mediaConnected, setMediaConnected] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const sessionRef = useRef<TelegramGroupCallWebSession | null>(null);
  const micActiveRef = useRef(false);
  const groupCallIdRef = useRef(groupCallId);
  groupCallIdRef.current = groupCallId;

  const speakingUnsubRef = useRef<(() => void) | null>(null);
  const joinLostUnsubRef = useRef<(() => void) | null>(null);
  const videoUnsubRef = useRef<(() => void) | null>(null);

  const resetLocalUi = useCallback(() => {
    setJoined(false);
    setMediaConnected(false);
    setNegotiating(false);
    setJoining(false);
    setMicActive(false);
    setLocalSpeaking(false);
    setRemoteVideoStream(null);
    micActiveRef.current = false;
  }, []);

  const disposeSession = useCallback(() => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
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
      joinLostUnsubRef.current?.();
      videoUnsubRef.current?.();
      speakingUnsubRef.current = session.onLocalSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
      joinLostUnsubRef.current = session.onJoinLost(() => {
        setJoined(false);
        setMediaConnected(false);
        setNegotiating(false);
        setMicActive(false);
        setLocalSpeaking(false);
        setRemoteVideoStream(null);
        micActiveRef.current = false;
      });
      videoUnsubRef.current = session.onRemoteVideoChange((stream) => {
        setRemoteVideoStream(stream);
      });
    },
    [],
  );

  const createSessionShell = useCallback(() => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
    sessionRef.current?.dispose();
    const session = new TelegramGroupCallWebSession({
      chatId,
      groupCallId: groupCallIdRef.current,
    });
    sessionRef.current = session;
    bindSession(session);
    setError(null);
    setRemoteVideoStream(null);
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

  // Gate remote audio on dialog visibility — call stays joined, output is muted
  // while the chat panel is hidden so voice is heard only while in the dialog.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    sessionRef.current?.setRemoteAudioEnabled(visible);
    if (visible) sessionRef.current?.resumeRemoteAudio();
  }, [visible, joined, mediaConnected]);

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
      if (visible) {
        session.setRemoteAudioEnabled(true);
        session.resumeRemoteAudio();
      } else {
        session.setRemoteAudioEnabled(false);
      }
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
    try {
      await session.ensureJoinedListenOnly();
      setJoined(true);
      setMediaConnected(session.isMediaConnected());
      setNegotiating(session.isNegotiating());
      session.setRemoteAudioEnabled(Boolean(visible));
      if (visible) session.resumeRemoteAudio();
      if (micActiveRef.current) {
        await session.setMicEnabled(true);
        setMicActive(true);
      } else {
        const enabled = session.isMicEnabled;
        setMicActive(enabled);
        micActiveRef.current = enabled;
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "voice_join_failed";
      setError(message);
      appWarn("[voice-session-join]", message, { chatId, groupCallId });
      return false;
    } finally {
      setJoining(false);
    }
  }, [chatId, groupCallId, visible]);

  const unlockAudio = useCallback(() => {
    sessionRef.current?.unlockRemoteAudio();
  }, []);

  const toggleMic = useCallback(async () => {
    const next = !micActiveRef.current;
    micActiveRef.current = next;
    setMicActive(next);
    if (!next) setLocalSpeaking(false);

    const session = sessionRef.current;
    if (!session || Platform.OS !== "web") return;

    try {
      setError(null);
      session.unlockRemoteAudio();
      await session.setMicEnabled(next);
      setJoined(session.isJoined);
      setMediaConnected(session.isMediaConnected());
      session.resumeRemoteAudio();
      const enabled = session.isMicEnabled;
      micActiveRef.current = enabled;
      setMicActive(enabled);
      if (!enabled) setLocalSpeaking(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "mic_toggle_failed";
      setError(message);
      micActiveRef.current = session.isMicEnabled;
      setMicActive(session.isMicEnabled);
      appWarn("[voice-session-mic]", message, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

  const leaveVoice = useCallback(async () => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    videoUnsubRef.current?.();
    videoUnsubRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    const result = await leaveTelegramChatVoice(chatId, groupCallId);
    createSessionShell();
    resetLocalUi();
    return result;
  }, [chatId, createSessionShell, groupCallId, resetLocalUi]);

  return {
    micActive,
    localSpeaking,
    joining,
    joined,
    mediaConnected,
    negotiating,
    error,
    remoteVideoStream,
    unlockAudio,
    joinListen,
    toggleMic,
    leaveVoice,
  };
}
