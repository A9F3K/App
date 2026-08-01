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

/**
 * Profile phone action — TDLib createCall / getCall / discardCall signaling
 * (dial → ring → exchanging keys → ready). Same chrome as group voice with
 * peer avatar instead of roster. Peer audio still requires a tgcalls media
 * bridge after callStateReady; local mic stays live for mute UX.
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
  const [localMicStream, setLocalMicStream] = useState<MediaStream | null>(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [call, setCall] = useState<PrivateCallSnapshot | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [dropLeaving, setDropLeaving] = useState(false);
  const callIdRef = useRef<number | null>(null);
  const hungUpRef = useRef(false);
  const readyLoggedRef = useRef(false);

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
  const statusText =
    callError && phase === "error"
      ? callError
      : call?.emojis?.length && phase === "ready"
        ? `${t("messages.privateCall.connected")}  ${call.emojis.join(" ")}`
        : t(statusKeyForPhase(phase));

  const stopTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const stopAllMedia = useCallback(() => {
    setLocalCameraStream((prev) => {
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
    stopAllMedia();
    const id = callIdRef.current;
    await discardTelegramPrivateCall(id);
    setDropLeaving(false);
    onHangUp();
  }, [onHangUp, stopAllMedia]);

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
      // Still resolving user id from profile — wait.
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

  // Poll call state while we have a call id. Depend on call_id (not only phase) so
  // polling starts right after createCall — previously phase stayed "dialing" and
  // the effect never re-ran after callIdRef was set.
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
            source: "poll",
          });
        }
        setCall(result.call);
        if (
          result.call.phase === "ready" &&
          result.call.has_encryption_key &&
          !readyLoggedRef.current
        ) {
          readyLoggedRef.current = true;
          logPageDisplay("messages_private_call_ready", {
            callId: result.call.call_id,
            serverCount: result.call.server_count ?? 0,
            emojiCount: result.call.emojis?.length ?? 0,
            note: "signaling_ready_media_needs_tgcalls",
          });
        }
        if (result.call.phase === "discarded" || result.call.phase === "error") {
          stopAllMedia();
          setActiveVoiceDock(null);
          if (result.call.phase === "error" && result.call.error) {
            setCallError(result.call.error);
          }
          // Auto-close shortly after remote hangup.
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

  // Local mic while connected (peer audio requires tgcalls; keep capture + mute UX).
  useEffect(() => {
    if (phase !== "ready" || Platform.OS !== "web") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let cancelled = false;
    void navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (cancelled || hungUpRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        for (const track of stream.getAudioTracks()) {
          track.enabled = micActive;
        }
        setLocalMicStream(stream);
      })
      .catch(() => {
        // mic permission denied — UI still shows connected
      });
    return () => {
      cancelled = true;
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps -- remount mic only on ready

  useEffect(() => {
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

  // Minimized dock while call stays alive.
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
      .getUserMedia({ video: true, audio: false })
      .then((stream) => {
        setLocalCameraStream(stream);
        setCameraActive(true);
      })
      .catch(() => setCameraActive(false));
  }, [cameraActive, stopCamera]);

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
      micJoining={phase === "dialing" || phase === "ringing" || phase === "exchanging"}
      onMicPress={onMicPress}
      cameraActive={cameraActive}
      onCameraPress={onCameraPress}
      screenSharing={screenSharing}
      onStartScreenShare={() => setScreenSharing(true)}
      onStopScreenShare={() => setScreenSharing(false)}
      onDropPress={handleDrop}
      dropLeaving={dropLeaving}
      localCameraStream={localCameraStream}
      videoActive={cameraActive}
      privateCall={{
        avatarUrl,
        initials,
        scheme: colorScheme,
        statusText,
      }}
    />
  );
}
