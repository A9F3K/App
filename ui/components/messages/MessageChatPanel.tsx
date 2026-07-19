import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { normalizeTelegramGroupCallId } from "../../../shared/telegramGroupCallSdp";
import { layout, type ThemeColors } from "../../theme";
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { startTelegramChatVoice } from "../../telegram/startTelegramChatVoice";
import { fetchTelegramChatVoiceParticipants } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { appWarn } from "../../../shared/appLog";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageChatVoiceBar } from "./MessageChatVoiceBar";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import type { MessageChatRowData } from "./MessageChatRow";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
  /** Chat pane is the on-screen focus — voice audio only plays while visible. */
  visible?: boolean;
};

function isLiveVoiceChat(chat: MessageChatRowData): boolean {
  // Call id may be missing/stale after a bad coerce; server resolves from getChat on join.
  return Boolean(chat.has_active_voice_chat);
}

/** Groups / supergroups / channels can host a bound voice chat (not private DMs). */
function canStartVoiceChat(chat: MessageChatRowData): boolean {
  const kind = chat.chat_kind;
  return kind === "group" || kind === "supergroup" || kind === "channel";
}

function resolveGroupCallId(
  chat: MessageChatRowData,
  startedCallId: number | null,
): number | null {
  return (
    normalizeTelegramGroupCallId(chat.voice_chat_group_call_id) ??
    normalizeTelegramGroupCallId(startedCallId)
  );
}

/** Wide-layout chat pane (middle column). */
export function MessageChatPanel({ chat, colors, visible = true }: Props) {
  const columnBleedPx = layout.contentSideInsetPx;
  const liveVoiceAvailable = isLiveVoiceChat(chat);
  const canStart = canStartVoiceChat(chat);
  const [voiceJoined, setVoiceJoined] = useState(false);
  const [voicePopoverOpen, setVoicePopoverOpen] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startedCallId, setStartedCallId] = useState<number | null>(null);
  /** After an explicit leave, do not auto-listen again until the user rejoins or opens another chat. */
  const userLeftVoiceRef = useRef(false);
  /** Closing the sheet can click-through onto the voice strip and reopen it — ignore briefly. */
  const ignoreVoicePopoverOpenUntilRef = useRef(0);
  const groupCallId = resolveGroupCallId(chat, startedCallId);
  const showVoiceBar = liveVoiceAvailable || voiceJoined;

  useEffect(() => {
    userLeftVoiceRef.current = false;
    setVoicePopoverOpen(false);
    setStartPending(false);
    setStartedCallId(null);
    // tdesktop parity: opening a chat with a live call shows the bar + roster but
    // does NOT connect audio. The user must press Join (or open the popover) to
    // hear the call. Prevents remote voice leaking in just from loading the chat.
    setVoiceJoined(false);
  }, [chat.telegram_chat_id]);

  useEffect(() => {
    if (!liveVoiceAvailable && !voiceJoined) {
      setStartedCallId(null);
    }
  }, [liveVoiceAvailable, voiceJoined]);

  // TDLib chat-list sync can miss video_chat OR keep a stale flag after the call
  // ends. Always verify while this group is open (not only when the flag is false).
  useEffect(() => {
    if (!canStart || voiceJoined || !visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const probe = async () => {
      const result = await fetchTelegramChatVoiceParticipants(chat.telegram_chat_id);
      if (cancelled || !result.ok) return;
      const nonSelf = result.participants.filter((row) => !row.is_self);
      const hasSelf = result.participants.some((row) => row.is_self);
      // Self-only is live when this account is already in the call elsewhere.
      const live =
        Boolean(result.has_active_voice_chat) &&
        (result.participant_count > 0 || nonSelf.length > 0 || hasSelf);
      patchAuthenticatedHomeSelectedChatVoice({
        has_active_voice_chat: live,
        voice_chat_group_call_id: live ? result.voice_chat_group_call_id : null,
      });
      if (!live) return;
      appWarn("[message-voice-detect]", result.voice_resolve_source, {
        chatId: chat.telegram_chat_id,
        groupCallId: result.voice_chat_group_call_id,
        participantCount: result.participant_count,
      });
    };

    void probe();
    const schedule = () => {
      timer = setTimeout(() => {
        void probe().finally(() => {
          if (!cancelled) schedule();
        });
      }, 5000);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [canStart, chat.telegram_chat_id, visible, voiceJoined]);

  const openVoicePopover = useCallback(() => {
    if (Date.now() < ignoreVoicePopoverOpenUntilRef.current) return;
    setVoicePopoverOpen(true);
  }, []);

  const closeVoicePopover = useCallback(() => {
    // Swallow the same pointer's click-through onto the strip / Join control.
    ignoreVoicePopoverOpenUntilRef.current = Date.now() + 500;
    setVoicePopoverOpen(false);
  }, []);

  const joinVoice = useCallback(() => {
    if (!liveVoiceAvailable && groupCallId == null) return;
    userLeftVoiceRef.current = false;
    unlockVoiceAutoplay();
    // Paint the dialog first so Close / Escape stay interactive, then start
    // WebRTC on the next frames (SDP/ICE used to freeze the sheet on open).
    openVoicePopover();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          setVoiceJoined(true);
        }, 0);
      });
    } else {
      setVoiceJoined(true);
    }
  }, [groupCallId, liveVoiceAvailable, openVoicePopover]);

  const startVoice = useCallback(async () => {
    if (liveVoiceAvailable || startPending || !canStart) return;
    setStartPending(true);
    userLeftVoiceRef.current = false;
    unlockVoiceAutoplay();
    try {
      const result = await startTelegramChatVoice(chat.telegram_chat_id);
      if (!result.ok) {
        appWarn("[message-voice-start]", result.error, {
          chatId: chat.telegram_chat_id,
        });
        return;
      }
      const callId = normalizeTelegramGroupCallId(result.voice_chat_group_call_id);
      if (callId != null) {
        setStartedCallId(callId);
      }
      patchAuthenticatedHomeSelectedChatVoice({
        has_active_voice_chat: result.has_active_voice_chat,
        voice_chat_group_call_id: result.voice_chat_group_call_id,
      });
      openVoicePopover();
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          window.setTimeout(() => {
            setVoiceJoined(true);
          }, 0);
        });
      } else {
        setVoiceJoined(true);
      }
    } finally {
      setStartPending(false);
    }
  }, [canStart, chat.telegram_chat_id, liveVoiceAvailable, openVoicePopover, startPending]);

  const leaveVoiceUi = useCallback(() => {
    userLeftVoiceRef.current = true;
    setVoiceJoined(false);
    closeVoicePopover();
    setStartedCallId(null);
  }, [closeVoicePopover]);

  return (
    <View
      style={{
        flex: 1,
        alignSelf: "stretch",
        minHeight: 0,
        overflow: "visible",
        marginHorizontal: -columnBleedPx,
      }}
    >
      <MessageChatHeader
        chat={chat}
        colors={colors}
        showStartVoice={!liveVoiceAvailable && canStart && !voiceJoined}
        onStartVoice={() => void startVoice()}
        startVoicePending={startPending}
      />
      {showVoiceBar ? (
        <MessageChatVoiceBar
          chatId={chat.telegram_chat_id}
          groupCallId={groupCallId}
          title={chat.title}
          colors={colors}
          joined={voiceJoined}
          visible={visible}
          popoverOpen={voicePopoverOpen}
          onJoin={joinVoice}
          onOpenPopover={() => {
            if (!voiceJoined) {
              joinVoice();
              return;
            }
            unlockVoiceAutoplay();
            openVoicePopover();
          }}
          onClosePopover={closeVoicePopover}
          onLeftVoice={leaveVoiceUi}
        />
      ) : null}
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
