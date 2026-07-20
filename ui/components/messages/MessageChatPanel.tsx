import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Platform, View } from "react-native";
import { normalizeTelegramGroupCallId } from "../../../shared/telegramGroupCallSdp";
import { layout, type ThemeColors } from "../../theme";
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { startTelegramChatVoice } from "../../telegram/startTelegramChatVoice";
import { fetchTelegramChatVoiceParticipants } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { appWarn } from "../../../shared/appLog";
import { logPageDisplay } from "../../pageDisplayLog";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageChatVoiceBar } from "./MessageChatVoiceBar";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import { setVoiceDialogUiOpen } from "./voiceDialogUiGate";
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
  /** True from Join/Start until Leave — covers the deferred WebRTC arm window. */
  const [voiceEngaged, setVoiceEngaged] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startedCallId, setStartedCallId] = useState<number | null>(null);
  /** After an explicit leave, do not auto-listen again until the user rejoins or opens another chat. */
  const userLeftVoiceRef = useRef(false);
  /** Closing the sheet can click-through onto the voice strip — block reopen briefly. */
  const ignoreVoicePopoverOpenUntilRef = useRef(0);
  /** Same close gesture must not re-join / re-open via the strip underneath. */
  const suppressStripPressUntilRef = useRef(0);
  /** Pending deferred setVoiceJoined — cancel on Leave or Close-before-connect. */
  const joinArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceJoinedRef = useRef(false);
  voiceJoinedRef.current = voiceJoined;
  const groupCallId = resolveGroupCallId(chat, startedCallId);
  const showVoiceBar = liveVoiceAvailable || voiceJoined;

  const clearJoinArmTimer = useCallback(() => {
    if (joinArmTimerRef.current != null) {
      clearTimeout(joinArmTimerRef.current);
      joinArmTimerRef.current = null;
    }
  }, []);

  const armDeferredJoin = useCallback(() => {
    if (voiceJoinedRef.current || joinArmTimerRef.current != null) return;
    if (typeof window === "undefined") {
      setVoiceJoined(true);
      return;
    }
    // Wait for the sheet + Close handlers to paint, then arm WebRTC only when
    // the main thread is idle — SDP during open was swallowing Close presses.
    const arm = () => {
      if (voiceJoinedRef.current || joinArmTimerRef.current != null) return;
      joinArmTimerRef.current = window.setTimeout(() => {
        joinArmTimerRef.current = null;
        setVoiceJoined(true);
      }, 3_500);
    };
    window.requestAnimationFrame(() => {
      const ric = (
        window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === "function") {
        ric(() => arm(), { timeout: 4_000 });
      } else {
        window.setTimeout(arm, 1_200);
      }
    });
  }, []);

  useEffect(() => {
    userLeftVoiceRef.current = false;
    clearJoinArmTimer();
    setVoicePopoverOpen(false);
    setStartPending(false);
    setStartedCallId(null);
    setVoiceEngaged(false);
    // tdesktop parity: opening a chat with a live call shows the bar + roster but
    // does NOT connect audio. The user must press Join (or open the popover) to
    // hear the call. Prevents remote voice leaking in just from loading the chat.
    setVoiceJoined(false);
  }, [chat.telegram_chat_id, clearJoinArmTimer]);

  useEffect(() => {
    if (!liveVoiceAvailable && !voiceJoined) {
      setStartedCallId(null);
    }
  }, [liveVoiceAvailable, voiceJoined]);

  // Publish dialog-open / joined / engaged voice so chat-list SSE can defer while
  // the sheet is up or a call is arming — without wiring React context through
  // the whole tree.
  // IMPORTANT: do not clear the gate in this effect's cleanup — that briefly
  // flipped open→false→open on every popover toggle and scheduled chat-list
  // flushes that froze Close/Escape.
  useEffect(() => {
    setVoiceDialogUiOpen(voicePopoverOpen || voiceJoined || voiceEngaged);
  }, [voicePopoverOpen, voiceJoined, voiceEngaged]);

  useEffect(() => {
    return () => {
      setVoiceDialogUiOpen(false);
    };
  }, []);

  // TDLib chat-list sync can miss video_chat OR keep a stale flag after the call
  // ends. Probe sparingly — VoiceBar SSE/poll owns presence once the bar is live.
  useEffect(() => {
    if (!canStart || voiceJoined || !visible || voicePopoverOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Once we already know the call is live, back off hard — getChat every 5s
    // was saturating the main thread alongside chat-list SSE.
    const intervalMs = liveVoiceAvailable ? 20_000 : 8_000;

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

    // Skip the immediate probe when presence is already confirmed — strip/SSE
    // will refresh; an extra getChat on chat open was a longtask source.
    if (!liveVoiceAvailable) void probe();
    const schedule = () => {
      timer = setTimeout(() => {
        void probe().finally(() => {
          if (!cancelled) schedule();
        });
      }, intervalMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [
    canStart,
    chat.telegram_chat_id,
    liveVoiceAvailable,
    visible,
    voiceJoined,
    voicePopoverOpen,
  ]);

  const openVoicePopover = useCallback(() => {
    const now = Date.now();
    if (now < ignoreVoicePopoverOpenUntilRef.current) {
      logPageDisplay("messages_voice_dialog_open_blocked", {
        chatId: chat.telegram_chat_id,
        reason: "post_close_guard",
        msRemaining: ignoreVoicePopoverOpenUntilRef.current - now,
      });
      return;
    }
    logPageDisplay("messages_voice_dialog_open_request", { chatId: chat.telegram_chat_id });
    setVoicePopoverOpen(true);
  }, [chat.telegram_chat_id]);

  const closeVoicePopover = useCallback(() => {
    // Swallow the same pointer's click-through onto the strip / Join control.
    const until = Date.now() + 900;
    ignoreVoicePopoverOpenUntilRef.current = until;
    suppressStripPressUntilRef.current = until;
    // Closing before WebRTC actually connects cancels the arm — otherwise the
    // deferred setVoiceJoined still fires under a closed sheet and freezes Escape
    // / reopen. Once joined, Close only hides the sheet (call stays up).
    if (!voiceJoinedRef.current) {
      clearJoinArmTimer();
      setVoiceEngaged(false);
    }
    // Native window capture handlers are outside React's discrete event system;
    // without flushSync the sheet can stay data-voice-dialog="open" for seconds
    // under chat/voice longtasks (Close looked dead to Playwright).
    if (Platform.OS === "web") {
      try {
        flushSync(() => {
          setVoicePopoverOpen(false);
        });
        return;
      } catch {
        // fall through
      }
    }
    setVoicePopoverOpen(false);
  }, [clearJoinArmTimer]);

  const joinVoice = useCallback(() => {
    if (!liveVoiceAvailable && groupCallId == null) {
      logPageDisplay("messages_voice_join_skipped", {
        chatId: chat.telegram_chat_id,
        liveVoiceAvailable,
        groupCallId,
      });
      return;
    }
    userLeftVoiceRef.current = false;
    setVoiceEngaged(true);
    unlockVoiceAutoplay();
    logPageDisplay("messages_voice_join_start", {
      chatId: chat.telegram_chat_id,
      groupCallId,
      liveVoiceAvailable,
    });
    // Paint the dialog first so Close / Escape stay interactive, then start
    // WebRTC after the sheet has had time to settle (SDP/ICE freezes Close).
    openVoicePopover();
    armDeferredJoin();
  }, [armDeferredJoin, groupCallId, liveVoiceAvailable, openVoicePopover]);

  const startVoice = useCallback(async () => {
    if (liveVoiceAvailable || startPending || !canStart) return;
    setStartPending(true);
    userLeftVoiceRef.current = false;
    setVoiceEngaged(true);
    unlockVoiceAutoplay();
    try {
      const result = await startTelegramChatVoice(chat.telegram_chat_id);
      if (!result.ok) {
        appWarn("[message-voice-start]", result.error, {
          chatId: chat.telegram_chat_id,
        });
        setVoiceEngaged(false);
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
      armDeferredJoin();
    } finally {
      setStartPending(false);
    }
  }, [
    armDeferredJoin,
    canStart,
    chat.telegram_chat_id,
    liveVoiceAvailable,
    openVoicePopover,
    startPending,
  ]);

  const leaveVoiceUi = useCallback(() => {
    userLeftVoiceRef.current = true;
    clearJoinArmTimer();
    setVoiceEngaged(false);
    setVoiceJoined(false);
    closeVoicePopover();
    setStartedCallId(null);
  }, [clearJoinArmTimer, closeVoicePopover]);

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
          suppressStripPressUntilRef={suppressStripPressUntilRef}
        />
      ) : null}
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
