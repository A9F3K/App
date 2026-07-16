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
   * `toggleMic` once the parent sets `active` (listen-only on chat enter, or Join).
   */
  active: boolean;
};

export type TelegramVoiceSession = {
  micActive: boolean;
  localSpeaking: boolean;
  joining: boolean;
  joined: boolean;
  error: string | null;
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
}: Input): TelegramVoiceSession {
  const [micActive, setMicActive] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<TelegramGroupCallWebSession | null>(null);
  const micActiveRef = useRef(false);
  const groupCallIdRef = useRef(groupCallId);
  groupCallIdRef.current = groupCallId;

  const speakingUnsubRef = useRef<(() => void) | null>(null);
  const joinLostUnsubRef = useRef<(() => void) | null>(null);

  const resetLocalUi = useCallback(() => {
    setJoined(false);
    setJoining(false);
    setMicActive(false);
    setLocalSpeaking(false);
    micActiveRef.current = false;
  }, []);

  const disposeSession = useCallback(() => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    resetLocalUi();
  }, [resetLocalUi]);

  const bindSession = useCallback(
    (session: TelegramGroupCallWebSession) => {
      speakingUnsubRef.current?.();
      joinLostUnsubRef.current?.();
      speakingUnsubRef.current = session.onLocalSpeakingChange((speaking) => {
        setLocalSpeaking(speaking);
      });
      joinLostUnsubRef.current = session.onJoinLost(() => {
        setJoined(false);
      });
    },
    [],
  );

  const createSessionShell = useCallback(() => {
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    sessionRef.current?.dispose();
    const session = new TelegramGroupCallWebSession({
      chatId,
      groupCallId: groupCallIdRef.current,
    });
    sessionRef.current = session;
    bindSession(session);
    setError(null);
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

  const joinListen = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "web") return false;
    const session = sessionRef.current;
    if (!session) return false;
    if (session.isJoined) {
      setJoined(true);
      session.resumeRemoteAudio();
      return true;
    }

    setJoining(true);
    setError(null);
    try {
      await session.ensureJoinedListenOnly();
      setJoined(true);
      session.resumeRemoteAudio();
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
  }, [chatId, groupCallId]);

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
      session.resumeRemoteAudio();
      setMicActive(micActiveRef.current);
    } catch (err) {
      const message = err instanceof Error ? err.message : "mic_toggle_failed";
      setError(message);
      appWarn("[voice-session-mic]", message, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

  const leaveVoice = useCallback(async () => {
    // Stop WebRTC immediately, then leave TDLib, then recreate the shell
    // so the next Join gesture can unlock remote audio / AudioContext again.
    speakingUnsubRef.current?.();
    speakingUnsubRef.current = null;
    joinLostUnsubRef.current?.();
    joinLostUnsubRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    const result = await leaveTelegramChatVoice(chatId, groupCallId);
    resetLocalUi();
    if (Platform.OS === "web" && active) {
      createSessionShell();
    }
    return result;
  }, [active, chatId, groupCallId, createSessionShell, resetLocalUi]);

  return {
    micActive,
    localSpeaking,
    joining,
    joined,
    error,
    unlockAudio,
    joinListen,
    toggleMic,
    leaveVoice,
  };
}
