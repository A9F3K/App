import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Platform, View } from "react-native";
import { normalizeTelegramGroupCallId } from "../../../shared/telegramGroupCallSdp";
import { layout, type ThemeColors } from "../../theme";
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
import { useProfileSheet } from "../../profile/ProfileContext";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { startTelegramChatVoice } from "../../telegram/startTelegramChatVoice";
import { fetchTelegramChatVoiceParticipants } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { appWarn } from "../../../shared/appLog";
import { logPageDisplay } from "../../pageDisplayLog";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageChatVoiceBar } from "./MessageChatVoiceBar";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import { isVoiceDialogUiOpen, setVoiceDialogUiOpen } from "./voiceDialogUiGate";
import type { MessageChatRowData } from "./MessageChatRow";
import { isGroupLikeChatRow } from "./isGroupLikeChatRow";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
  /** Chat pane is the on-screen focus — used for strip vs global dock placement. */
  visible?: boolean;
};

function isLiveVoiceChat(chat: MessageChatRowData): boolean {
  // Call id may be missing/stale after a bad coerce; server resolves from getChat on join.
  return Boolean(chat.has_active_voice_chat);
}

/** Groups / supergroups / channels can host a bound voice chat (not private DMs). */
function canStartVoiceChat(chat: MessageChatRowData): boolean {
  const kind = chat.chat_kind;
  if (kind === "group" || kind === "supergroup" || kind === "channel") return true;
  // chat_kind is often missing on list rows — match subheader/member-count heuristics.
  if (kind === "private") return false;
  return isGroupLikeChatRow(chat);
}

function resolveGroupCallId(
  chat: MessageChatRowData,
  startedCallId: number | null,
): number | null {
  const fromChat = normalizeTelegramGroupCallId(chat.voice_chat_group_call_id);
  const started = normalizeTelegramGroupCallId(startedCallId);
  // Live strip/SSE metadata wins over a stale started id (logs: stream
  // groupCallId=5 then reconnects as 1 before Join — joining 5 was silent).
  if (fromChat != null && started != null && fromChat !== started) {
    return fromChat;
  }
  return started ?? fromChat;
}

/** Wide-layout chat pane (middle column). */
export function MessageChatPanel({ chat, colors, visible = true }: Props) {
  const columnBleedPx = layout.contentSideInsetPx;
  const { openProfileSheet } = useProfileSheet();
  const liveVoiceAvailable = isLiveVoiceChat(chat);
  const canStart = canStartVoiceChat(chat);
  const [voiceJoined, setVoiceJoined] = useState(false);
  const [voicePopoverOpen, setVoicePopoverOpen] = useState(false);
  /** True from Join/Start until Leave — covers the deferred WebRTC arm window. */
  const [voiceEngaged, setVoiceEngaged] = useState(false);
  /**
   * VoiceBar confirmed speakers/participants (or joined). Chat-list can keep a
   * stale has_active_voice_chat; until this is true, show Start not Join-only.
   */
  const [voicePresenceConfirmed, setVoicePresenceConfirmed] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startedCallId, setStartedCallId] = useState<number | null>(null);
  /** After an explicit leave, do not auto-listen again until the user rejoins or opens another chat. */
  const userLeftVoiceRef = useRef(false);
  /** Closing the sheet can click-through onto the voice strip — block reopen briefly. */
  const ignoreVoicePopoverOpenUntilRef = useRef(0);
  /** Same close gesture must not re-join / re-open via the strip underneath. */
  const suppressStripPressUntilRef = useRef(0);
  /** Bumps on every open request so the popover can clear a stuck forceClosed latch. */
  const [voiceOpenSeq, setVoiceOpenSeq] = useState(0);
  /** Pending deferred setVoiceJoined — cancel on Leave or Close-before-connect. */
  const joinArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceJoinedRef = useRef(false);
  voiceJoinedRef.current = voiceJoined;
  const voiceEngagedRef = useRef(false);
  voiceEngagedRef.current = voiceEngaged;
  const groupCallId = resolveGroupCallId(chat, startedCallId);
  // Mount Join strip only after probe/SSE confirms speakers (or user joined).
  // Do not require chat.has_active_voice_chat — list poll often lags / stays
  // false, and AND-ing it with presenceConfirmed caused a remount loop when
  // VoiceBar's mount effect cleared the confirmed bit.
  const showVoiceBar = voicePresenceConfirmed || voiceJoined;

  const clearJoinArmTimer = useCallback(() => {
    if (joinArmTimerRef.current != null) {
      clearTimeout(joinArmTimerRef.current);
      joinArmTimerRef.current = null;
    }
  }, []);

  const armDeferredJoin = useCallback(() => {
    if (voiceJoinedRef.current) return;
    // Arm Join immediately so VoiceBar skips soft participant HTTP while
    // joinVideoChat runs. SDP still waits one frame inside VoiceBar — the old
    // 350ms panel delay left voiceJoined=false long enough for a soft reload
    // (open_defer_force after ~1.5s) that starved the gateway mid-join.
    clearJoinArmTimer();
    voiceJoinedRef.current = true;
    setVoiceJoined(true);
    // Join is armed — stop holding the chat-list deferral via `engaged`.
    // The open sheet still keeps the gate via `voicePopoverOpen`.
    voiceEngagedRef.current = false;
    setVoiceEngaged(false);
  }, [clearJoinArmTimer]);

  useEffect(() => {
    userLeftVoiceRef.current = false;
    clearJoinArmTimer();
    setVoicePopoverOpen(false);
    setStartPending(false);
    setStartedCallId(null);
    setVoiceEngaged(false);
    setVoicePresenceConfirmed(false);
    // tdesktop parity: opening a chat with a live call shows the bar + roster but
    // does NOT connect audio. The user must press Join (or open the popover) to
    // hear the call. Prevents remote voice leaking in just from loading the chat.
    setVoiceJoined(false);
  }, [chat.telegram_chat_id, clearJoinArmTimer]);

  useEffect(() => {
    // Drop a Start-voice call id once the list/probe no longer advertises live.
    // Do not clear voicePresenceConfirmed here — that raced with probe patches
    // and unmounted VoiceBar while a real call was still live.
    if (!liveVoiceAvailable && !voiceJoined) {
      setStartedCallId(null);
    }
  }, [liveVoiceAvailable, voiceJoined]);

  // Defer heavy chat-list applies only while the voice sheet is open.
  // Merely being joined (docked strip) must not freeze list updates.
  // IMPORTANT: do not clear the gate in this effect's cleanup — that briefly
  // flipped open→false→open on every popover toggle and scheduled chat-list
  // flushes that froze Close/Escape.
  // Join/start paths call setVoiceDialogUiOpen(true) synchronously before the
  // popover state commits; this effect keeps the gate aligned with the sheet.
  useEffect(() => {
    setVoiceDialogUiOpen(voicePopoverOpen);
  }, [voicePopoverOpen]);

  useEffect(() => {
    return () => {
      setVoiceDialogUiOpen(false);
    };
  }, []);

  // TDLib chat-list sync can miss video_chat OR keep a stale flag after the call
  // ends. Probe to clear rings / show Start — including when canStart is false
  // but the list still paints live (otherwise VoiceBar stays gated off forever).
  // VoiceBar SSE/poll owns presence once joined.
  useEffect(() => {
    if (voiceJoined || !visible || voicePopoverOpen) return;
    if (!canStart && !liveVoiceAvailable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Stale "active" flags need a fast first check; idle chats can poll slower.
    const intervalMs = liveVoiceAvailable ? 4_000 : 12_000;

    const probeChatId = chat.telegram_chat_id;
    const probe = async () => {
      if (isVoiceDialogUiOpen()) return;
      const result = await fetchTelegramChatVoiceParticipants(probeChatId);
      if (cancelled || !result.ok || isVoiceDialogUiOpen()) return;
      if (chat.telegram_chat_id !== probeChatId) return;
      // Server may still advertise a bound empty call — require participants.
      // Do not trust has_hidden_listeners alone (stale leftovers).
      // Green joined ring is only for *this* client's voice session — this
      // probe runs only while !voiceJoined, so never paint joined=true here
      // (sticky TDLib is_joined logged as isJoined=true while joined=false).
      const live =
        Boolean(result.has_active_voice_chat) &&
        (result.participant_count > 0 || result.participants.length > 0);
      patchAuthenticatedHomeSelectedChatVoice(probeChatId, {
        has_active_voice_chat: live,
        // Keep bound id when clearing live so Start voice can reuse it.
        voice_chat_group_call_id:
          result.voice_chat_group_call_id ?? chat.voice_chat_group_call_id ?? null,
        voice_chat_is_joined: false,
      });
      // After explicit Leave, keep the Join/face preview hidden until the user
      // rejoins or opens another chat — probe must not resurrect the strip.
      if (userLeftVoiceRef.current) {
        setVoicePresenceConfirmed(false);
        return;
      }
      setVoicePresenceConfirmed(live);
      if (!live) return;
      appWarn("[message-voice-detect]", result.voice_resolve_source, {
        chatId: probeChatId,
        groupCallId: result.voice_chat_group_call_id,
        participantCount: result.participant_count,
        isJoined: false,
      });
    };

    void probe();
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

  useEffect(() => {
    if (!voiceJoined) return;
    patchAuthenticatedHomeSelectedChatVoice(chat.telegram_chat_id, {
      has_active_voice_chat: true,
      voice_chat_group_call_id: groupCallId,
      voice_chat_is_joined: true,
    });
  }, [chat.telegram_chat_id, groupCallId, voiceJoined]);

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
    logPageDisplay("messages_voice_dialog_open_request", {
      chatId: chat.telegram_chat_id,
    });
    // Publish gate before React paints so in-flight chat-list startTransitions
    // see isVoiceDialogUiOpen() and defer (logs: chats_poll_updated mid-dialog).
    setVoiceDialogUiOpen(true);
    // Always bump seq so MessageChatVoicePopover clears forceClosed even when
    // React state was already `true` (close mid-join left the portal latched).
    setVoiceOpenSeq((n) => n + 1);
    setVoicePopoverOpen((wasOpen) => {
      if (wasOpen) {
        // Bounce false→true so the popover sees a real open edge.
        if (typeof window !== "undefined") {
          window.requestAnimationFrame(() => {
            setVoicePopoverOpen(true);
          });
          return false;
        }
      }
      return true;
    });
  }, [chat.telegram_chat_id]);

  const closeVoicePopover = useCallback(() => {
    // Swallow the same pointer's click-through onto the strip / Join control.
    // Keep this short — a 900ms guard made "close then reopen" feel broken.
    const until = Date.now() + 350;
    ignoreVoicePopoverOpenUntilRef.current = until;
    suppressStripPressUntilRef.current = until;
    // Native window capture handlers are outside React's discrete event system;
    // without flushSync the sheet can stay data-voice-dialog="open" for seconds
    // under chat/voice longtasks (Close looked dead to Playwright).
    const applyClose = () => {
      setVoicePopoverOpen(false);
      // Close before audio is up: cancel deferred Join so SDP cannot continue
      // after the sheet is gone (logs: close → webrtc_join_ok → stuck gate).
      if (!voiceJoinedRef.current) {
        clearJoinArmTimer();
        setVoiceEngaged(false);
        voiceEngagedRef.current = false;
        setVoiceDialogUiOpen(false);
        return;
      }
      // Already joined — minimize to strip. Clear engaged + chat-list deferral
      // so previews keep flowing while the call stays docked.
      setVoiceEngaged(false);
      voiceEngagedRef.current = false;
      setVoiceDialogUiOpen(false);
    };
    if (Platform.OS === "web") {
      try {
        flushSync(applyClose);
        return;
      } catch {
        // fall through
      }
    }
    applyClose();
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
    voiceEngagedRef.current = true;
    // Sync gate before any await/paint so deferred chat-list work cannot land.
    setVoiceDialogUiOpen(true);
    unlockVoiceAutoplay();
    logPageDisplay("messages_voice_join_start", {
      chatId: chat.telegram_chat_id,
      groupCallId,
      liveVoiceAvailable,
    });
    // Paint the dialog + kick roster HTTP first. Arming WebRTC in the same tick
    // as open left Close dead (setLocal/RemoteDescription main-thread wedge).
    // ~900ms gives the sheet + Close a chance to commit before SDP work.
    openVoicePopover();
    clearJoinArmTimer();
    joinArmTimerRef.current = setTimeout(() => {
      joinArmTimerRef.current = null;
      armDeferredJoin();
    }, 900);
  }, [armDeferredJoin, clearJoinArmTimer, groupCallId, liveVoiceAvailable, openVoicePopover]);

  const startVoice = useCallback(async () => {
    // Confirmed live presence (or in-flight start) must not allow a second Start.
    if (voicePresenceConfirmed || startPending || !canStart) {
      return;
    }
    const startChatId = chat.telegram_chat_id;
    setStartPending(true);
    userLeftVoiceRef.current = false;
    setVoiceEngaged(true);
    voiceEngagedRef.current = true;
    setVoiceDialogUiOpen(true);
    unlockVoiceAutoplay();
    try {
      const result = await startTelegramChatVoice(startChatId);
      if (!result.ok) {
        appWarn("[message-voice-start]", result.error, {
          chatId: startChatId,
        });
        setVoiceEngaged(false);
        voiceEngagedRef.current = false;
        setVoiceDialogUiOpen(false);
        return;
      }
      const callId = normalizeTelegramGroupCallId(result.voice_chat_group_call_id);
      if (callId != null) {
        setStartedCallId(callId);
      }
      patchAuthenticatedHomeSelectedChatVoice(startChatId, {
        has_active_voice_chat: result.has_active_voice_chat,
        voice_chat_group_call_id: result.voice_chat_group_call_id,
      });
      openVoicePopover();
      clearJoinArmTimer();
      joinArmTimerRef.current = setTimeout(() => {
        joinArmTimerRef.current = null;
        armDeferredJoin();
      }, 900);
    } finally {
      setStartPending(false);
    }
  }, [
    armDeferredJoin,
    canStart,
    chat.telegram_chat_id,
    clearJoinArmTimer,
    openVoicePopover,
    startPending,
    voicePresenceConfirmed,
  ]);

  const leaveVoiceUi = useCallback(
    (opts?: { keepJoinPreview?: boolean }) => {
      const keepJoinPreview = Boolean(opts?.keepJoinPreview);
      // Only latch “hide Join strip” when the call itself is gone.
      userLeftVoiceRef.current = !keepJoinPreview;
      clearJoinArmTimer();
      setVoiceEngaged(false);
      voiceEngagedRef.current = false;
      setVoiceJoined(false);
      voiceJoinedRef.current = false;
      closeVoicePopover();
      setStartedCallId(null);
      setVoiceDialogUiOpen(false);
      if (!keepJoinPreview) {
        setVoicePresenceConfirmed(false);
      }
    },
    [clearJoinArmTimer, closeVoicePopover],
  );

  const onVoicePresenceConfirmedChange = useCallback((confirmed: boolean) => {
    // After Leave on a dead call, ignore late SSE/poll that resurrect presence
    // until the user explicitly rejoins. Live-call Leave keeps Join preview.
    if (confirmed && userLeftVoiceRef.current) return;
    setVoicePresenceConfirmed(confirmed);
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
      {showVoiceBar ? (
        <MessageChatVoiceBar
          chatId={chat.telegram_chat_id}
          groupCallId={groupCallId}
          title={chat.title}
          colors={colors}
          joined={voiceJoined}
          visible={visible}
          popoverOpen={voicePopoverOpen}
          openSeq={voiceOpenSeq}
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
          onPresenceConfirmedChange={onVoicePresenceConfirmedChange}
          suppressStripPressUntilRef={suppressStripPressUntilRef}
        />
      ) : null}
      <MessageChatHeader
        chat={chat}
        colors={colors}
        showStartVoice={
          !voiceJoined && canStart && !voicePresenceConfirmed
        }
        onStartVoice={() => void startVoice()}
        startVoicePending={startPending}
        onOpenProfile={() => openProfileSheet(chat)}
      />
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
