import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useColors } from "../../theme";
import { useTelegram } from "../Telegram";
import { MessageChatVoicePopover } from "./MessageChatVoicePopover";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { setVoiceDialogUiOpen } from "./voiceDialogUiGate";
import { setActiveVoiceDock } from "./activeVoiceDockStore";
import { logPageDisplay } from "../../pageDisplayLog";
import type { MessageChatRowData } from "./MessageChatRow";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppStringKey } from "../../../locales/appStrings";
import {
  createTelegramPrivateCall,
  discardTelegramPrivateCall,
  fetchTelegramPrivateCallStatus,
  type PrivateCallPhase,
  type PrivateCallSnapshot,
} from "../../telegram/fetchTelegramPrivateCall";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import {
  startPrivateCallRingback,
  stopPrivateCallRingback,
} from "../../telegram/privateCallRingback";
import {
  startPrivateCallAudioBridge,
  type PrivateCallAudioBridge,
} from "../../telegram/privateCallAudioBridge";
import {
  startPrivateCallVideoBridge,
  type PrivateCallVideoBridge,
} from "../../telegram/privateCallVideoBridge";
import type { TelegramRemoteVideoSource } from "../../telegram/telegramGroupCallWebSession";

export type PrivateCallPeer = {
  chat: MessageChatRowData;
};

type Props = {
  peer: PrivateCallPeer | null;
  visible: boolean;
  openSeq: number;
  onClose: () => void;
  onHangUp: () => void;
  onReopen: () => void;
};

function statusKeyForPhase(phase: PrivateCallPhase): AppStringKey {
  switch (phase) {
    case "dialing":
      return "messages.privateCall.dialing";
    case "ringing":
      return "messages.privateCall.ringing";
    case "exchanging":
      return "messages.privateCall.connecting";
    case "ready":
      return "messages.privateCall.connected";
    case "hanging_up":
      return "messages.privateCall.ending";
    case "discarded":
      return "messages.privateCall.ended";
    case "error":
      return "messages.privateCall.failed";
    default:
      return "messages.privateCall.calling";
  }
}

function formatCallDuration(totalSec: number): string {
  const sec = Math.max(0, Math.trunc(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Profile phone action — TDLib createCall / discardCall signaling
 * (dial → ring → exchanging keys → ready) plus ntgcalls WebRTC on the gateway.
 * UI shows Connected only after media_established; until then peer may still
 * be on "exchange encryption keys" in native Telegram.
 */
export function MessageChatPrivateCallHost({
  peer,
  visible,
  openSeq,
  onClose,
  onHangUp,
  onReopen,
}: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const { t } = useAppStrings();
  const [micActive, setMicActive] = useState(true);
  const [cameraActive, setCameraActive] = useState(false);
  const [localCameraStream, setLocalCameraStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [localMicStream, setLocalMicStream] = useState<MediaStream | null>(null);
  const [remoteVideoSources, setRemoteVideoSources] = useState<TelegramRemoteVideoSource[]>([]);
  const audioBridgeRef = useRef<PrivateCallAudioBridge | null>(null);
  const videoBridgeRef = useRef<PrivateCallVideoBridge | null>(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [call, setCall] = useState<PrivateCallSnapshot | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [dropLeaving, setDropLeaving] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const callIdRef = useRef<number | null>(null);
  const hungUpRef = useRef(false);
  const readyLoggedRef = useRef(false);
  const connectedAtRef = useRef<number | null>(null);

  const chat = peer?.chat ?? null;
  const title = (chat?.title ?? "").trim() || t("messages.privateCall.active");
  const avatarUrl = chat ? resolveTelegramThreadAvatarUrl(chat) : null;
  const initials = useMemo(() => extractChatAvatarInitials(title), [title]);
  const [resolvedUserId, setResolvedUserId] = useState<number | null>(
    chat?.peer_user_id ?? null,
  );
  const peerUserId = resolvedUserId ?? chat?.peer_user_id ?? null;

  useEffect(() => {
    setResolvedUserId(chat?.peer_user_id ?? null);
  }, [chat?.peer_user_id, openSeq]);

  useEffect(() => {
    if (peerUserId != null && peerUserId !== 0) return;
    if (!chat) return;
    let cancelled = false;
    void import("../../telegram/fetchTelegramUserProfile").then(({ fetchTelegramUserProfile }) =>
      fetchTelegramUserProfile(chat.telegram_chat_id, chat.peer_user_id ?? null).then((result) => {
        if (cancelled || !result.ok) return;
        const id = result.profile.user_id;
        if (id != null && Number.isFinite(id) && id !== 0) {
          setResolvedUserId(Math.trunc(id));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [chat, peerUserId, openSeq]);

  const phase: PrivateCallPhase = call?.phase ?? (callError ? "error" : "dialing");
  const mediaReady = phase === "ready" && Boolean(call?.media_established);

  useEffect(() => {
    if (!mediaReady) {
      connectedAtRef.current = null;
      setElapsedSec(0);
      return;
    }
    if (connectedAtRef.current == null) {
      connectedAtRef.current = Date.now();
    }
    const tick = () => {
      const started = connectedAtRef.current;
      if (started == null) return;
      setElapsedSec(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [mediaReady]);

  const statusText = useMemo(() => {
    if (callError && phase === "error") return callError;
    if (phase === "ready" && !call?.media_established) {
      return t("messages.privateCall.connecting");
    }
    if (mediaReady) {
      const clock = formatCallDuration(elapsedSec);
      const base = `${t("messages.privateCall.connected")} · ${clock}`;
      if (call?.emojis?.length) {
        return `${base}  ${call.emojis.join(" ")}`;
      }
      return base;
    }
    return t(statusKeyForPhase(phase));
  }, [call?.emojis, call?.media_established, callError, elapsedSec, mediaReady, phase, t]);

  const stopTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const stopAllMedia = useCallback(() => {
    audioBridgeRef.current?.stop();
    audioBridgeRef.current = null;
    videoBridgeRef.current?.stop();
    videoBridgeRef.current = null;
    setRemoteVideoSources([]);
    setLocalCameraStream((prev) => {
      stopTracks(prev);
      return null;
    });
    setLocalScreenStream((prev) => {
      stopTracks(prev);
      return null;
    });
    setLocalMicStream((prev) => {
      stopTracks(prev);
      return null;
    });
    setCameraActive(false);
    setScreenSharing(false);
  }, [stopTracks]);

  const hangUp = useCallback(async () => {
    if (hungUpRef.current) return;
    hungUpRef.current = true;
    stopPrivateCallRingback();
    setDropLeaving(true);
    setActiveVoiceDock(null);
    const durationSec =
      connectedAtRef.current != null
        ? Math.max(0, Math.floor((Date.now() - connectedAtRef.current) / 1000))
        : elapsedSec;
    stopAllMedia();
    const id = callIdRef.current;
    await discardTelegramPrivateCall(id, { durationSec, keepalive: true });
    setDropLeaving(false);
    onHangUp();
  }, [elapsedSec, onHangUp, stopAllMedia]);

  // Tab/app close must discard — otherwise TDLib keeps the peer in the call.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const discardForUnload = () => {
      if (hungUpRef.current) return;
      const id = callIdRef.current;
      if (id == null) return;
      hungUpRef.current = true;
      stopPrivateCallRingback();
      stopAllMedia();
      setActiveVoiceDock(null);
      const durationSec =
        connectedAtRef.current != null
          ? Math.max(0, Math.floor((Date.now() - connectedAtRef.current) / 1000))
          : 0;
      void discardTelegramPrivateCall(id, { durationSec, keepalive: true });
    };
    window.addEventListener("pagehide", discardForUnload);
    window.addEventListener("beforeunload", discardForUnload);
    return () => {
      window.removeEventListener("pagehide", discardForUnload);
      window.removeEventListener("beforeunload", discardForUnload);
    };
  }, [stopAllMedia]);

  // Ringback only while waiting for answer — stop once peer starts key exchange.
  useEffect(() => {
    const shouldRing =
      !hungUpRef.current && (phase === "dialing" || phase === "ringing");
    if (shouldRing) {
      startPrivateCallRingback();
      return () => {
        stopPrivateCallRingback();
      };
    }
    stopPrivateCallRingback();
    return undefined;
  }, [phase]);

  // Start outgoing call once per host mount / peer — not on sheet reopen (openSeq).
  useEffect(() => {
    hungUpRef.current = false;
    if (peerUserId == null || peerUserId === 0) {
      if (chat != null && (chat.peer_user_id == null || chat.peer_user_id === 0)) {
        return;
      }
      setCallError(t("messages.privateCall.noUser"));
      return;
    }
    let cancelled = false;
    setCall(null);
    setCallError(null);
    callIdRef.current = null;
    readyLoggedRef.current = false;
    connectedAtRef.current = null;
    setElapsedSec(0);
    unlockVoiceAutoplay();
    setVoiceDialogUiOpen(true);
    logPageDisplay("messages_private_call_start", {
      chatId: chat?.telegram_chat_id ?? null,
      peerUserId,
    });
    void createTelegramPrivateCall(peerUserId).then((result) => {
      if (cancelled || hungUpRef.current) {
        if (result.ok) void discardTelegramPrivateCall(result.call.call_id);
        return;
      }
      if (!result.ok) {
        setCallError(result.error);
        return;
      }
      callIdRef.current = result.call.call_id;
      logPageDisplay("messages_private_call_status", {
        callId: result.call.call_id,
        phase: result.call.phase,
        peerUserId: result.call.user_id,
        source: "create",
      });
      setCall(result.call);
    });
    return () => {
      cancelled = true;
      stopPrivateCallRingback();
    };
  }, [peerUserId, chat, t]);

  const activeCallId = call?.call_id ?? null;
  useEffect(() => {
    if (hungUpRef.current) return;
    if (phase === "discarded" || phase === "error") return;
    const callId = activeCallId ?? callIdRef.current;
    if (callId == null) return;
    let cancelled = false;
    let lastLoggedPhase: string | null = null;
    const tick = () => {
      void fetchTelegramPrivateCallStatus(callId).then((result) => {
        if (cancelled || hungUpRef.current) return;
        if (!result.ok || !result.call) return;
        if (result.call.phase !== lastLoggedPhase) {
          lastLoggedPhase = result.call.phase;
          logPageDisplay("messages_private_call_status", {
            callId: result.call.call_id,
            phase: result.call.phase,
            peerUserId: result.call.user_id,
            hasEncryptionKey: result.call.has_encryption_key ?? false,
            serverCount: result.call.server_count ?? 0,
            emojiCount: result.call.emojis?.length ?? 0,
            mediaEstablished: result.call.media_established ?? false,
            source: "poll",
          });
        }
        setCall(result.call);
        if (
          result.call.phase === "ready" &&
          result.call.has_encryption_key &&
          result.call.media_established &&
          !readyLoggedRef.current
        ) {
          readyLoggedRef.current = true;
          logPageDisplay("messages_private_call_ready", {
            callId: result.call.call_id,
            serverCount: result.call.server_count ?? 0,
            emojiCount: result.call.emojis?.length ?? 0,
            mediaEstablished: true,
          });
        }
        if (result.call.phase === "discarded" || result.call.phase === "error") {
          stopAllMedia();
          setActiveVoiceDock(null);
          if (result.call.phase === "error" && result.call.error) {
            setCallError(result.call.error);
          }
          setTimeout(() => {
            if (!hungUpRef.current) onHangUp();
          }, 1200);
        }
      });
    };
    tick();
    const timer = setInterval(tick, phase === "ready" ? 2500 : 700);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeCallId, phase, onHangUp, stopAllMedia]);

  // Browser ↔ gateway PCM bridge once WebRTC media is up.
  useEffect(() => {
    if (phase !== "ready" || !call?.media_established || Platform.OS !== "web") return;
    const callId = call.call_id;
    if (callId == null) return;
    let cancelled = false;
    const abort = new AbortController();
    void startPrivateCallAudioBridge({
      callId,
      micEnabled: micActive,
      signal: abort.signal,
    }).then((bridge) => {
      if (cancelled || hungUpRef.current) {
        bridge?.stop();
        return;
      }
      if (!bridge) return;
      audioBridgeRef.current?.stop();
      audioBridgeRef.current = bridge;
      setLocalMicStream(null);
    });
    return () => {
      cancelled = true;
      abort.abort();
      audioBridgeRef.current?.stop();
      audioBridgeRef.current = null;
    };
  }, [phase, call?.media_established, call?.call_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browser ↔ gateway video bridge for camera / screencast.
  useEffect(() => {
    if (phase !== "ready" || !call?.media_established || Platform.OS !== "web") return;
    const callId = call.call_id;
    if (callId == null) return;
    let cancelled = false;
    const abort = new AbortController();
    void startPrivateCallVideoBridge({
      callId,
      signal: abort.signal,
      onRemoteSources: (sources) => {
        if (cancelled || hungUpRef.current) return;
        setRemoteVideoSources(sources);
      },
    }).then((bridge) => {
      if (cancelled || hungUpRef.current) {
        bridge?.stop();
        return;
      }
      if (!bridge) return;
      videoBridgeRef.current?.stop();
      videoBridgeRef.current = bridge;
      bridge.setLocalCameraStream(localCameraStream);
      bridge.setLocalScreenStream(localScreenStream);
    });
    return () => {
      cancelled = true;
      abort.abort();
      videoBridgeRef.current?.stop();
      videoBridgeRef.current = null;
      setRemoteVideoSources([]);
    };
  }, [phase, call?.media_established, call?.call_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    videoBridgeRef.current?.setLocalCameraStream(localCameraStream);
  }, [localCameraStream]);

  useEffect(() => {
    videoBridgeRef.current?.setLocalScreenStream(localScreenStream);
  }, [localScreenStream]);

  useEffect(() => {
    audioBridgeRef.current?.setMicEnabled(micActive);
    if (!localMicStream) return;
    for (const track of localMicStream.getAudioTracks()) {
      track.enabled = micActive;
    }
  }, [micActive, localMicStream]);

  useEffect(() => {
    return () => {
      stopPrivateCallRingback();
      stopAllMedia();
      setActiveVoiceDock(null);
      setVoiceDialogUiOpen(false);
    };
  }, [stopAllMedia]);

  useEffect(() => {
    const active =
      phase === "dialing" ||
      phase === "ringing" ||
      phase === "exchanging" ||
      phase === "ready";
    if (!active || visible) {
      setActiveVoiceDock(null);
      return;
    }
    setActiveVoiceDock({
      chatId: chat?.telegram_chat_id ?? call?.user_id ?? 0,
      title,
      participantCount: 2,
      micActive,
      onOpen: () => {
        setVoiceDialogUiOpen(true);
        onReopen();
      },
      onLeave: () => {
        void hangUp();
      },
    });
    return () => {
      setActiveVoiceDock(null);
    };
  }, [
    visible,
    phase,
    title,
    micActive,
    chat?.telegram_chat_id,
    call?.user_id,
    onReopen,
    hangUp,
  ]);

  useEffect(() => {
    if (visible) setVoiceDialogUiOpen(true);
  }, [visible]);

  const stopCamera = useCallback(() => {
    setLocalCameraStream((prev) => {
      stopTracks(prev);
      return null;
    });
    setCameraActive(false);
  }, [stopTracks]);

  const stopScreenShare = useCallback(() => {
    setLocalScreenStream((prev) => {
      stopTracks(prev);
      return null;
    });
    setScreenSharing(false);
  }, [stopTracks]);

  const onMicPress = useCallback(() => {
    setMicActive((prev) => !prev);
  }, []);

  const onCameraPress = useCallback(() => {
    if (cameraActive) {
      stopCamera();
      return;
    }
    if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.mediaDevices) {
      setCameraActive(true);
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15, max: 24 },
        },
        audio: false,
      })
      .then((stream) => {
        const track = stream.getVideoTracks()[0];
        track?.addEventListener("ended", () => {
          setLocalCameraStream((prev) => {
            if (prev === stream) {
              stopTracks(prev);
              return null;
            }
            return prev;
          });
          setCameraActive(false);
        });
        setLocalCameraStream(stream);
        setCameraActive(true);
      })
      .catch(() => setCameraActive(false));
  }, [cameraActive, stopCamera, stopTracks]);

  const onStartScreenShare = useCallback(() => {
    if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      setScreenSharing(true);
      return;
    }
    void navigator.mediaDevices
      .getDisplayMedia({ video: true, audio: false })
      .then((stream) => {
        const track = stream.getVideoTracks()[0];
        track?.addEventListener("ended", () => {
          setLocalScreenStream((prev) => {
            if (prev === stream) {
              stopTracks(prev);
              return null;
            }
            return prev;
          });
          setScreenSharing(false);
        });
        setLocalScreenStream(stream);
        setScreenSharing(true);
      })
      .catch(() => setScreenSharing(false));
  }, [stopTracks]);

  const handleDrop = useCallback(() => {
    void hangUp();
  }, [hangUp]);

  if (!chat) return null;

  return (
    <MessageChatVoicePopover
      openSeq={openSeq}
      visible={visible}
      onClose={onClose}
      title={title}
      participants={[]}
      colors={colors}
      micActive={micActive}
      micJoining={
        phase === "dialing" ||
        phase === "ringing" ||
        phase === "exchanging" ||
        (phase === "ready" && !call?.media_established)
      }
      onMicPress={onMicPress}
      cameraActive={cameraActive}
      onCameraPress={onCameraPress}
      screenSharing={screenSharing}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={stopScreenShare}
      onDropPress={handleDrop}
      dropLeaving={dropLeaving}
      localCameraStream={localCameraStream}
      localScreenStream={localScreenStream}
      remoteVideoSources={remoteVideoSources}
      videoActive={cameraActive || screenSharing || remoteVideoSources.length > 0}
      privateCall={{
        avatarUrl,
        initials,
        scheme: colorScheme,
        statusText,
      }}
    />
  );
}
