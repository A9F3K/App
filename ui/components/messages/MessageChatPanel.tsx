import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { normalizeTelegramGroupCallId } from "../../../shared/telegramGroupCallSdp";
import { layout, type ThemeColors } from "../../theme";
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { startTelegramChatVoice } from "../../telegram/startTelegramChatVoice";
import { appWarn } from "../../../shared/appLog";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageChatVoiceBar } from "./MessageChatVoiceBar";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import type { MessageChatRowData } from "./MessageChatRow";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
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
export function MessageChatPanel({ chat, colors }: Props) {
  const columnBleedPx = layout.contentSideInsetPx;
  const liveVoiceAvailable = isLiveVoiceChat(chat);
  const canStart = canStartVoiceChat(chat);
  const [voiceJoined, setVoiceJoined] = useState(false);
  const [voicePopoverOpen, setVoicePopoverOpen] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startedCallId, setStartedCallId] = useState<number | null>(null);
  /** After an explicit leave, do not auto-listen again until the user rejoins or opens another chat. */
  const userLeftVoiceRef = useRef(false);
  const groupCallId = resolveGroupCallId(chat, startedCallId);
  const showVoiceBar = liveVoiceAvailable || voiceJoined;

  useEffect(() => {
    userLeftVoiceRef.current = false;
    setVoicePopoverOpen(false);
    setStartPending(false);
    setStartedCallId(null);
    // Listen-only on enter when a call is already live (mic stays off until toggled).
    if (isLiveVoiceChat(chat)) {
      unlockVoiceAutoplay();
      setVoiceJoined(true);
    } else {
      setVoiceJoined(false);
    }
  }, [chat.telegram_chat_id]);

  useEffect(() => {
    if (!liveVoiceAvailable) {
      if (!voiceJoined) setStartedCallId(null);
      return;
    }
    if (userLeftVoiceRef.current || voiceJoined) return;
    unlockVoiceAutoplay();
    setVoiceJoined(true);
  }, [liveVoiceAvailable, voiceJoined]);

  const joinVoice = useCallback(() => {
    if (!liveVoiceAvailable && groupCallId == null) return;
    userLeftVoiceRef.current = false;
    unlockVoiceAutoplay();
    setVoiceJoined(true);
    setVoicePopoverOpen(true);
  }, [groupCallId, liveVoiceAvailable]);

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
      setVoiceJoined(true);
      setVoicePopoverOpen(true);
    } finally {
      setStartPending(false);
    }
  }, [canStart, chat.telegram_chat_id, liveVoiceAvailable, startPending]);

  const leaveVoiceUi = useCallback(() => {
    userLeftVoiceRef.current = true;
    setVoiceJoined(false);
    setVoicePopoverOpen(false);
    setStartedCallId(null);
  }, []);

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
          popoverOpen={voicePopoverOpen}
          onJoin={joinVoice}
          onOpenPopover={() => {
            if (!voiceJoined) {
              joinVoice();
              return;
            }
            unlockVoiceAutoplay();
            setVoicePopoverOpen(true);
          }}
          onClosePopover={() => setVoicePopoverOpen(false)}
          onLeftVoice={leaveVoiceUi}
        />
      ) : null}
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
