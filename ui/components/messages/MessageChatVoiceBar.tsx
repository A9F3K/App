import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { appLocaleToBcp47 } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { layout, typographyFixedRow30Label, type ThemeColors } from "../../theme";
import {
  fetchTelegramChatVoiceParticipants,
  type TelegramChatVoiceParticipant,
} from "../../telegram/fetchTelegramChatVoiceParticipants";
import {
  focusAuthenticatedHomeMiddleColumnOnChat,
  patchAuthenticatedHomeSelectedChatVoice,
} from "../../authenticatedHomeSelectedChat";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { useTelegramVoiceSession } from "../../telegram/useTelegramVoiceSession";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { appWarn } from "../../../shared/appLog";
import { logPageDisplay } from "../../pageDisplayLog";
import { useTelegram } from "../Telegram";
import {
  MessageChatAvatarSlot,
  MESSAGE_CHAT_JOINED_VOICE_RING_COLOR,
  MESSAGE_CHAT_VOICE_RING_OUTSET_PX,
} from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import {
  MessageChatLeaveVoiceIcon,
  MessageChatMicIcon,
} from "./MessageChatVoiceIcons";
import {
  formatVoiceParticipantTitle,
  MessageChatVoicePopover,
  type VoiceChatMessage,
  voiceParticipantPrefsKey,
} from "./MessageChatVoicePopover";
import {
  isEffectivelyBlankDisplayName,
  stripInvisibleDisplayNameChars,
} from "../../../shared/telegramDisplayName";
import { MessageChatVoiceVideoPlane } from "./MessageChatVoiceVideoPlane";
import { setTelegramChatVoiceParticipantVolume } from "../../telegram/setTelegramChatVoiceParticipantVolume";
import {
  isIntentionalVoiceMute,
  patchStoredVoicePeerMediaPrefs,
  readStoredVoicePeerMediaPrefs,
  storedPrefsToSessionPrefs,
} from "../../telegram/voiceParticipantMediaPrefsStorage";
import {
  useTelegramVoiceParticipantsStream,
  type VoiceParticipantsStreamSnapshot,
} from "./useTelegramVoiceParticipantsStream";
import { useTelegramVoiceCallMessagesStream } from "./useTelegramVoiceCallMessagesStream";
import { sendTelegramChatVoiceCallMessage } from "../../telegram/sendTelegramChatVoiceCallMessage";
import type { TelegramVoiceCallMessage } from "../../telegram/sendTelegramChatVoiceCallMessage";
import { useVoiceDialogFreezeDetector } from "./useVoiceDialogFreezeDetector";
import {
  MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
  MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_DIVIDER_PX,
  MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_OVERLAP_PX,
  MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX,
  MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS,
  resolveVoiceBarParticipantPreview,
} from "./messageListLayout";
import { clearQueuedNetworkFetches } from "./networkFetchQueue";
import { clearQueuedChooseCurrencyYearCharts } from "../../swap/chooseCurrencyYearChartCache";
import { setActiveVoiceDock } from "./activeVoiceDockStore";

const JOIN_BUTTON_HEIGHT_PX = 30;
const JOIN_BUTTON_TEXT_INSET_PX = 30;

/** TDLib / Telegram FLOOD_WAIT — "Too Many Requests: retry after 32". */
function parseTelegramFloodWaitMs(
  message: string | null | undefined,
): number | null {
  if (!message) return null;
  const match =
    message.match(/retry after\s+(\d+)/i) ||
    message.match(/FLOOD_WAIT[_\s:-]*(\d+)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Cap so a huge wait does not look like a hung UI forever.
  return Math.min(Math.max(Math.ceil(seconds) * 1000 + 500, 1_500), 120_000);
}

function voiceVideoInfoSignature(
  info: TelegramChatVoiceParticipant["video_info"] | null | undefined,
): string {
  if (!info) return "";
  const groups = (info.source_groups ?? [])
    .map((g) => `${g.semantics}:${g.source_ids.join(",")}`)
    .join(";");
  return `${info.endpoint_id}|g${info.source_groups?.length ?? 0}|${groups}`;
}

function participantHasScreenPublisher(row: TelegramChatVoiceParticipant): boolean {
  const screen = row.screen_sharing_video_info;
  return Boolean(
    (screen?.endpoint_id && screen.endpoint_id.trim()) ||
      (screen?.source_groups?.length ?? 0) > 0,
  );
}

function participantNeedsVideoForceReload(row: TelegramChatVoiceParticipant): boolean {
  if (row.is_self) return false;
  const screen = row.screen_sharing_video_info;
  const camera = row.video_info;
  const screenNeeds =
    Boolean(screen?.endpoint_id?.trim()) && !(screen?.source_groups?.length);
  const cameraNeeds =
    Boolean(camera?.endpoint_id?.trim()) && !(camera?.source_groups?.length);
  return screenNeeds || cameraNeeds;
}

/**
 * Soft/recent_speakers rows always serialize `video_info`/`screen_sharing_video_info`
 * as null (never undefined). Trusting those nulls wiped real SFU endpoints and
 * blocked screencast auto-show (`screens=[]` → constraints count=0).
 */
function mergeParticipantVideoInfo(
  incoming: TelegramChatVoiceParticipant["video_info"] | null | undefined,
  previous: TelegramChatVoiceParticipant["video_info"] | null | undefined,
  incomingOrderless: boolean,
): TelegramChatVoiceParticipant["video_info"] | null {
  if (incoming === undefined) return previous ?? null;
  if (incomingOrderless && !incoming && previous) return previous;
  return incoming ?? null;
}

type Props = {
  chatId: number;
  groupCallId: number | null;
  title: string;
  colors: ThemeColors;
  /** User pressed Join — media session may start. */
  joined: boolean;
  /** Chat pane focus — strip vs global dock; audio stays on while joined. */
  visible?: boolean;
  popoverOpen: boolean;
  /** Increments on each open request — clears a stuck forceClosed portal latch. */
  openSeq?: number;
  onJoin: () => void;
  onOpenPopover: () => void;
  onClosePopover: () => void;
  /** Called after a successful leave so the parent can show Join again. */
  onLeftVoice?: () => void;
  /** Brief post-close window — ignore strip presses (click-through from X). */
  suppressStripPressUntilRef?: MutableRefObject<number>;
  /**
   * Fired when soft poll / SSE confirms (or clears) real call presence.
   * Parent uses this so Start voice stays available while TDLib still
   * advertises a stale empty bound call.
   */
  onPresenceConfirmedChange?: (confirmed: boolean) => void;
};

/**
 * Above-header strip for an active chat voice.
 * Shows participant avatars while a call is live (including self when this
 * account is already in from another client). WebRTC starts only after
 * explicit Join (`joined`) so opening a chat preview never saturates the link.
 */
export function MessageChatVoiceBar({
  chatId,
  groupCallId,
  title,
  colors,
  joined,
  visible = true,
  popoverOpen,
  openSeq = 0,
  onJoin,
  onOpenPopover,
  onClosePopover,
  onLeftVoice,
  suppressStripPressUntilRef,
  onPresenceConfirmedChange,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { colorScheme, telegramUsername } = useTelegram();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const [leaving, setLeaving] = useState(false);
  const [participants, setParticipants] = useState<TelegramChatVoiceParticipant[]>([]);
  /** Local listen volume + hide video/screen for me (per participant). */
  const [participantMediaPrefs, setParticipantMediaPrefs] = useState<
    Record<string, { volumePercent: number; muteVideo: boolean; muteScreen: boolean }>
  >({});
  const participantMediaPrefsRef = useRef(participantMediaPrefs);
  participantMediaPrefsRef.current = participantMediaPrefs;
  const lastNonZeroVolumeRef = useRef<Record<string, number>>({});
  const volumeApiTimerRef = useRef<number | null>(null);
  /** Peers we already restored from TDLib volume_level=1 (0%) this join. */
  const volumeZeroRepairAttemptedRef = useRef<Set<string>>(new Set());
  /** Intentional muted-for-me peers we re-applied volume 0 to on the SFU this join. */
  const intentionalMuteReapplyAttemptedRef = useRef<Set<string>>(new Set());
  /** Unmuted remotes we already nudged to 100% listen volume this join (SFU). */
  const listenVolumeNudgeAttemptedRef = useRef<Set<string>>(new Set());
  /** TDLib account user_id when volume API reports self (may differ from UI is_self). */
  const tdlibSelfUserIdRef = useRef<number | null>(null);
  /** Account key for persisted mute / stream prefs (Telegram username). */
  const voicePrefsAccountId = telegramUsername?.trim() || "anon";
  /** Listed row count — always matches dialog roster / strip avatars. */
  const [participantCount, setParticipantCount] = useState(0);
  /** TDLib total hint (may exceed loaded rows until force reload). */
  const rosterTotalHintRef = useRef(0);
  const [rosterCountHint, setRosterCountHint] = useState(0);
  const rosterCountHintStateRef = useRef(0);
  /** Speaking glow is a side map (tdesktop parity) — never rebuilds roster order. */
  const [speakingByKey, setSpeakingByKey] = useState<Record<string, true>>({});
  /** In-call ephemeral messages (TDLib sendGroupCallMessage / updateNewGroupCallMessage). */
  const [voiceChatMessages, setVoiceChatMessages] = useState<VoiceChatMessage[]>([]);
  const voiceChatMessagesRevisionRef = useRef(0);
  /** Hide the empty strip until a poll/SSE proves real (non-self) presence. */
  const [presenceConfirmed, setPresenceConfirmed] = useState(false);
  const onPresenceConfirmedChangeRef = useRef(onPresenceConfirmedChange);
  onPresenceConfirmedChangeRef.current = onPresenceConfirmedChange;
  const setPresenceConfirmedAndNotify = useCallback((next: boolean) => {
    setPresenceConfirmed((prev) => {
      if (prev === next) return prev;
      onPresenceConfirmedChangeRef.current?.(next);
      return next;
    });
  }, []);
  const stripPaddingX = layout.contentSideInsetPx;
  const speakingByKeyRef = useRef(speakingByKey);
  speakingByKeyRef.current = speakingByKey;
  // Preview faces = other people only (never lead with self).
  const previewParticipants = participants.filter((row) => !row.is_self);
  const { displayTotal: totalParticipantCount, overflowCount, stackedLimit } =
    resolveVoiceBarParticipantPreview({
      listedTotal: participants.length,
      othersListed: previewParticipants.length,
      tdlibHint: rosterCountHint,
      maxAvatars: MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS,
      joined,
    });
  const stackedParticipants = previewParticipants.slice(0, stackedLimit);
  const participantsA11yLabel =
    totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(appLocaleToBcp47(locale)),
        })
      : t("messages.voiceChat.participants");

  const voiceJoinedRef = useRef(false);
  voiceJoinedRef.current = Boolean(joined);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = Boolean(popoverOpen);
  const participantsRef = useRef(participants);
  /**
   * Speak-keys removed by an authoritative roster shrink. Soft-merge must not
   * re-add them from thin recent_speakers SSE (пэшка ghost after leave).
   */
  const leaveTombstonesRef = useRef<Map<string, number>>(new Map());
  const LEAVE_TOMBSTONE_MS = 60_000;
  /** From gateway — muted listeners omitted; refuse remuting open remotes. */
  const hasHiddenListenersRef = useRef(false);
  /** Last time the painted roster grew — resist shrink snapshots for a short window. */
  const lastRosterExpandAtRef = useRef(0);
  participantsRef.current = participants;
  const participantCountRef = useRef(participantCount);
  participantCountRef.current = participantCount;
  /** Soft roster often drops source_groups briefly — sticky last good screen requests. */
  const lastGoodRemoteVideoRequestsRef = useRef<
    Array<{
      endpointId: string;
      kind: "camera" | "screen";
      ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
    }>
  >([]);
  const lastGoodRemoteVideoAtRef = useRef(0);
  /** Skip identical auto-subscribe payloads — duplicates restarted audio-settle. */
  const lastRemoteVideoRequestSigRef = useRef("");
  /** Endpoint from the latest menu unmute — wins over lastGood under cap. */
  const preferredExplicitScreenEndpointRef = useRef<string | null>(null);
  /**
   * Auto-show already committed setRequestedVideoChannels for these endpoints
   * (telegram-tt). Do not re-prefer / re-push until leave, deny, or failover.
   */
  const autoScreenCommittedEndpointsRef = useRef<Set<string>>(new Set());
  /**
   * Peers whose screen/camera this session should subscribe (menu unmute or
   * join-time auto-show for live screencasts).
   */
  const explicitScreenWantedKeysRef = useRef<Set<string>>(new Set());
  /** User muted a peer's screen this join — do not auto-show that peer again. */
  const userDeniedScreenKeysRef = useRef<Set<string>>(new Set());
  /**
   * Endpoints that failed after auto/explicit subscribe (0 video RTP / mix-protect).
   * Skip on the next auto-show pick so a stale ghost (e.g. ".") does not block Сева.
   */
  const failedAutoScreenEndpointsRef = useRef<Set<string>>(new Set());
  /** After a live H264 share froze the mix — stop auto-picking other screens. */
  const autoScreenBlockedAfterLiveMixStallRef = useRef(false);
  /** First time we saw each screen endpoint this join — prefer newer publishers. */
  const screenEndpointFirstSeenAtRef = useRef<Map<string, number>>(new Map());
  /** Mirror of denied keys for roster/menu chrome (refs alone do not re-render). */
  const [deniedScreenPeerKeys, setDeniedScreenPeerKeys] = useState<string[]>([]);
  /** Peers we opted into for screen this join (auto-show or menu unmute). */
  const [wantedScreenPeerKeys, setWantedScreenPeerKeys] = useState<string[]>([]);

  const syncVoicePresence = useCallback(
    (
      forChatId: number,
      hasActive: boolean,
      callId: number | null | undefined,
      rows: TelegramChatVoiceParticipant[],
      countHint: number,
      options?: { allowClear?: boolean },
    ) => {
      // Drop late callbacks after the user switched chats.
      if (chatIdRef.current !== forChatId) return false;
      const nonSelf = rows.filter((row) => !row.is_self);
      // Account already in the call from another Telegram client still counts as
      // live presence — otherwise a solo self join hides the preview strip.
      const hasSelf = rows.some((row) => row.is_self);
      const live =
        Boolean(hasActive) &&
        (Math.max(0, countHint) > 0 || nonSelf.length > 0 || hasSelf);

      if (voiceJoinedRef.current) {
        setPresenceConfirmedAndNotify(true);
        if (live) {
          patchAuthenticatedHomeSelectedChatVoice(forChatId, {
            has_active_voice_chat: true,
            voice_chat_group_call_id: callId ?? null,
            voice_chat_is_joined: true,
          });
        }
        return true;
      }

      if (live) {
        setPresenceConfirmedAndNotify(true);
        patchAuthenticatedHomeSelectedChatVoice(forChatId, {
          has_active_voice_chat: true,
          voice_chat_group_call_id: callId ?? null,
          // Green = this web session is in the call. TDLib/self-on-another-client
          // must not paint joined while local WebRTC is idle.
          voice_chat_is_joined: false,
        });
        return true;
      }

      // Empty roster / inactive: always clear live paint. TDLib keeps bound
      // group_call_id with is_active + participant_count=0; older SSE paths
      // also passed hasActive=true with no rows. Refusing to clear left rings
      // + Join strip stuck with no Start button (kapibara / other chats).
      // Keep the bound call id so Start voice stays available.
      void hasActive;
      void options;
      setPresenceConfirmedAndNotify(false);
      const keepCallId =
        typeof callId === "number" && Number.isFinite(callId) && callId > 0
          ? Math.trunc(callId)
          : null;
      patchAuthenticatedHomeSelectedChatVoice(forChatId, {
        has_active_voice_chat: false,
        voice_chat_group_call_id: keepCallId,
        voice_chat_is_joined: false,
      });
      return false;
    },
    [setPresenceConfirmedAndNotify],
  );

  useEffect(() => {
    if (joined) setPresenceConfirmedAndNotify(true);
  }, [joined, setPresenceConfirmedAndNotify]);

  // Only clear parent presence on leave/unmount — never on mount. Mounting with
  // false immediately flipped MessageChatPanel's showVoiceBar off (remount loop:
  // probe confirms → bar mounts → this effect clears → bar unmounts).
  useEffect(() => {
    return () => {
      onPresenceConfirmedChangeRef.current?.(false);
    };
  }, [chatId]);

  // Keep the WebRTC shell mounted with the bar so Join can unlock the real
  // remote <audio> / AudioContext during a user gesture (before join completes).
  const voiceSession = useTelegramVoiceSession({
    chatId,
    groupCallId,
    active: Platform.OS === "web",
    visible,
  });
  const voiceSessionJoinedRef = useRef(false);
  voiceSessionJoinedRef.current = Boolean(voiceSession.joined);
  const voiceSessionJoiningRef = useRef(false);
  voiceSessionJoiningRef.current = Boolean(voiceSession.joining);
  const voiceSessionNegotiatingRef = useRef(false);
  voiceSessionNegotiatingRef.current = Boolean(voiceSession.negotiating);
  /** Abort in-flight soft participant polls when Join starts (TDLib contention). */
  const softPollAbortRef = useRef<AbortController | null>(null);
  const micActiveRef = useRef(voiceSession.micActive);
  micActiveRef.current = voiceSession.micActive;
  const micPressAtRef = useRef(0);
  const localSpeakingRef = useRef(voiceSession.localSpeaking);
  localSpeakingRef.current = voiceSession.localSpeaking;
  const remoteSpeakingRef = useRef(voiceSession.remoteSpeaking);
  remoteSpeakingRef.current = voiceSession.remoteSpeaking;
  /** Latched once mix RMS proves hearable this join — greens must not depend on
   * the instantaneous remoteSpeaking frame (HTML sink / speech pauses flap it). */
  const heardRemoteMixRef = useRef(false);
  const joinListenRef = useRef(voiceSession.joinListen);
  joinListenRef.current = voiceSession.joinListen;
  const rejoinForTdlibRef = useRef(voiceSession.rejoinForTdlib);
  rejoinForTdlibRef.current = voiceSession.rejoinForTdlib;
  const unlockAudioRef = useRef(voiceSession.unlockAudio);
  unlockAudioRef.current = voiceSession.unlockAudio;
  const selfTitleRef = useRef("");
  // Never use Hyperlinks displayName for the optimistic self row — it can be
  // another linked account (Сева) while TDLib getMe is Vsevolod. Prefer @username
  // or plain "You" until an ordered TDLib self title arrives.
  selfTitleRef.current =
    typeof telegramUsername === "string" && telegramUsername.trim()
      ? `@${telegramUsername.trim().replace(/^@/, "")}`
      : "";

  const onLeftVoiceRef = useRef(onLeftVoice);
  onLeftVoiceRef.current = onLeftVoice;
  const leaveVoiceRef = useRef(voiceSession.leaveVoice);
  leaveVoiceRef.current = voiceSession.leaveVoice;

  // Minimize/dock only hides the sheet — keep Join/WebRTC going until hangup
  // (chrome X / strip leave / onDropFromPopover). Canceling join on popoverOpen
  // false used to drop audio mid-handshake when the user only minimized.

  // Join only after the user presses Join — never auto-join on chat preview open.
  // Cap retries so a flaky ICE path cannot re-offer SDP forever and freeze the UI.
  //
  // IMPORTANT: do not put voiceSession.joining / negotiating / joined in the
  // effect deps. Those flip when joinListen starts, which used to cancel the
  // settle delay, burn an attempt without calling joinListen, and leave
  // webrtcJoined=false forever (speakingCount=0, thin roster).
  const joinAttemptsRef = useRef(0);
  const kickPostJoinForceReloadRef = useRef<((source: string) => void) | null>(null);
  useEffect(() => {
    if (!joined) {
      joinAttemptsRef.current = 0;
      return;
    }
    if (!isTelegramMessagesConnected) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const tryJoin = async () => {
      if (cancelled || inFlight) return;
      if (voiceSessionJoinedRef.current) return;
      if (joinAttemptsRef.current >= 3) return;
      // Wait out an in-progress join without burning an attempt.
      if (voiceSessionJoiningRef.current || voiceSessionNegotiatingRef.current) {
        timer = setTimeout(() => {
          void tryJoin();
        }, 500);
        return;
      }
      inFlight = true;
      // Soft polls on the same TDLib gateway starve joinVideoChat — cancel them.
      softPollAbortRef.current?.abort();
      unlockVoiceAutoplay();
      unlockAudioRef.current();
      // Panel already waited ~900ms before arming voiceJoined. One more short
      // settle is enough for Close to bind — a second 1.2s delay stacked with
      // the post-join_ok SDP defer and left audio silent for seconds.
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.setTimeout(resolve, 280);
          });
        });
      });
      if (cancelled || voiceSessionJoinedRef.current) {
        inFlight = false;
        return;
      }
      // Sheet may be minimized/docked — still complete SDP so audio keeps working.
      // Count only real joinListen calls — cancelled settle delays must not
      // exhaust the 3-attempt budget.
      joinAttemptsRef.current += 1;
      // If self is already in the call with an open mic (Desktop/mobile), do not
      // remute via listen-only join — that painted Vsevolod's row red/crossed.
      const selfRow = participantsRef.current.find((row) => row.is_self);
      const startMuted = !(selfRow && selfRow.is_muted === false);
      logPageDisplay("messages_voice_webrtc_join_attempt", {
        chatId,
        groupCallId,
        attempt: joinAttemptsRef.current,
        popoverOpen: popoverOpenRef.current,
        startMuted,
        preserveUnmuted: !startMuted,
      });
      const joinResult = await joinListenRef.current({ startMuted });
      const ok = joinResult.ok;
      inFlight = false;
      logPageDisplay(
        ok ? "messages_voice_webrtc_join_ok" : "messages_voice_webrtc_join_fail",
        {
          chatId,
          groupCallId,
          attempt: joinAttemptsRef.current,
          popoverOpen: popoverOpenRef.current,
          error: ok ? null : joinResult.error ?? null,
          level: ok ? "info" : "warn",
        },
      );
      // Do NOT kick force-reload on join_ok in the same turn as setRemoteDescription
      // — that froze the tab. Thin recent_speakers (listed≪hint) still need a
      // short deferred force so the dialog does not stay at 2/6 participants.
      if (ok && typeof window !== "undefined") {
        const kickChatId = chatId;
        window.setTimeout(() => {
          if (chatIdRef.current !== kickChatId) return;
          if (!popoverOpenRef.current || !voiceJoinedRef.current) return;
          const listed = participantsRef.current.length;
          const hint = rosterTotalHintRef.current;
          if (listed <= 3 && hint > listed) {
            kickPostJoinForceReloadRef.current?.("webrtc_join_ok_thin_roster");
          }
        }, 200);
      } else if (!ok && typeof window !== "undefined") {
        // Join API / SDP may have partially succeeded — kick roster on fail only.
        const kickChatId = chatId;
        window.setTimeout(() => {
          if (chatIdRef.current !== kickChatId) return;
          if (!voiceJoinedRef.current) return;
          kickPostJoinForceReloadRef.current?.(
            `webrtc_join_fail_kick_${joinAttemptsRef.current}`,
          );
        }, 400);
      }
      if (cancelled || ok || voiceSessionJoinedRef.current) return;
      const attempt = joinAttemptsRef.current;
      if (attempt >= 3) {
        const kickChatId = chatId;
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            if (chatIdRef.current !== kickChatId) return;
            if (!voiceJoinedRef.current) return;
            kickPostJoinForceReloadRef.current?.("webrtc_join_give_up");
          }, 200);
        }
        return;
      }
      // Telegram FLOOD_WAIT / "Too Many Requests: retry after N" must be honored —
      // retrying in 2s burns the budget and leaves screencast auto-show dead
      // (webrtcJoined=false while roster already lists screen publishers).
      const floodWaitMs = parseTelegramFloodWaitMs(joinResult.error);
      const delayMs =
        floodWaitMs ??
        Math.min(2000 * 2 ** Math.min(attempt - 1, 2), 12_000);
      logPageDisplay("messages_voice_webrtc_join_retry", {
        chatId,
        groupCallId,
        attempt,
        delayMs,
        floodWaitMs: floodWaitMs ?? null,
        error: joinResult.error ?? null,
        level: "warn",
      });
      timer = setTimeout(() => {
        void tryJoin();
      }, delayMs);
    };

    void tryJoin();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [joined, isTelegramMessagesConnected, chatId, groupCallId]);

  const streamActiveRef = useRef(false);
  const streamRevisionRef = useRef(0);
  /** Brief hold after TDLib is_speaking drops so the green mic does not flicker. */
  const speakingHoldUntilRef = useRef(new Map<string, number>());
  /** Last time TDLib/SSE marked this key speaking (debug / self timing). */
  const lastTdlibSpeakingAtRef = useRef(new Map<string, number>());
  /** Mix-RMS fallback: keys that should stay green while inbound audio is live. */
  const mixCarrySpeakingKeysRef = useRef(new Set<string>());
  /** Thin recent_speakers / strip faces before join — mix attribution seeds. */
  const recentSpeakerFaceKeysRef = useRef(new Set<string>());
  const mixSilentSinceRef = useRef(0);
  const mixSpeakingExtendTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const speakingHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coalesce speaking setState to one rAF — Telegram Web toggles CSS, not React storms. */
  const pendingSpeakingMapRef = useRef<Record<string, true> | null>(null);
  const speakingRafRef = useRef<number | null>(null);
  const speakingListedRef = useRef(0);

  useEffect(() => {
    setParticipants([]);
    setParticipantMediaPrefs({});
    leaveTombstonesRef.current.clear();
    lastNonZeroVolumeRef.current = {};
    volumeZeroRepairAttemptedRef.current.clear();
    intentionalMuteReapplyAttemptedRef.current.clear();
    listenVolumeNudgeAttemptedRef.current.clear();
    tdlibSelfUserIdRef.current = null;
    hasHiddenListenersRef.current = false;
    if (volumeApiTimerRef.current != null) {
      window.clearTimeout(volumeApiTimerRef.current);
      volumeApiTimerRef.current = null;
    }
    setParticipantCount(0);
    setRosterCountHint(0);
    rosterTotalHintRef.current = 0;
    rosterCountHintStateRef.current = 0;
    setPresenceConfirmedAndNotify(false);
    softPollAbortRef.current?.abort();
    speakingHoldUntilRef.current.clear();
    lastTdlibSpeakingAtRef.current.clear();
    mixCarrySpeakingKeysRef.current.clear();
    recentSpeakerFaceKeysRef.current.clear();
    mixSilentSinceRef.current = 0;
    heardRemoteMixRef.current = false;
    if (speakingHoldTimerRef.current) {
      clearTimeout(speakingHoldTimerRef.current);
      speakingHoldTimerRef.current = null;
    }
    if (mixSpeakingExtendTimerRef.current) {
      clearInterval(mixSpeakingExtendTimerRef.current);
      mixSpeakingExtendTimerRef.current = null;
    }
    streamRevisionRef.current = 0;
    streamActiveRef.current = false;
    // Only reset on chat change — groupCallId often fills in after the first poll
    // and must not wipe presence (that remounted WebRTC/SSE in a tight loop).
  }, [chatId]);

  useEffect(() => {
    return () => {
      if (speakingHoldTimerRef.current) {
        clearTimeout(speakingHoldTimerRef.current);
        speakingHoldTimerRef.current = null;
      }
      if (mixSpeakingExtendTimerRef.current) {
        clearInterval(mixSpeakingExtendTimerRef.current);
        mixSpeakingExtendTimerRef.current = null;
      }
      if (speakingRafRef.current != null && typeof window !== "undefined") {
        window.clearTimeout(speakingRafRef.current);
        speakingRafRef.current = null;
      }
      pendingSpeakingMapRef.current = null;
    };
  }, []);

  const participantsEqual = useCallback(
    (a: TelegramChatVoiceParticipant[], b: TelegramChatVoiceParticipant[]) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        const left = a[i]!;
        const right = b[i]!;
        if (
          left.user_id !== right.user_id ||
          left.chat_id !== right.chat_id ||
          left.title !== right.title ||
          left.description !== right.description ||
          left.emoji_status_custom_emoji_id !== right.emoji_status_custom_emoji_id ||
          Boolean(left.is_muted) !== Boolean(right.is_muted) ||
          Boolean(left.can_unmute_self) !== Boolean(right.can_unmute_self) ||
          Boolean(left.is_self) !== Boolean(right.is_self) ||
          (left.video_info?.endpoint_id ?? "") !== (right.video_info?.endpoint_id ?? "") ||
          (left.screen_sharing_video_info?.endpoint_id ?? "") !==
            (right.screen_sharing_video_info?.endpoint_id ?? "") ||
          voiceVideoInfoSignature(left.video_info) !==
            voiceVideoInfoSignature(right.video_info) ||
          voiceVideoInfoSignature(left.screen_sharing_video_info) !==
            voiceVideoInfoSignature(right.screen_sharing_video_info)
        ) {
          return false;
        }
      }
      return true;
    },
    [],
  );

  const participantSpeakKey = useCallback((row: TelegramChatVoiceParticipant): string => {
    if (row.is_self) return "self";
    if (row.user_id != null && row.user_id > 0) return `u:${row.user_id}`;
    if (row.chat_id != null && row.chat_id !== 0) return `c:${row.chat_id}`;
    const order = String(row.order ?? "").trim();
    if (order) return `o:${order}`;
    const endpoint =
      row.screen_sharing_video_info?.endpoint_id?.trim() ||
      row.video_info?.endpoint_id?.trim() ||
      "";
    if (endpoint) return `e:${endpoint}`;
    const title = row.title.trim();
    // Never key multiple untitled stubs as `t:` — Map merge swapped names onto "?".
    if (title) return `t:${title}`;
    return `anon:${row.user_id ?? "x"}:${row.chat_id ?? "x"}:${endpoint || "_"}`;
  }, []);

  /** Prefer stable u:/c: keys — SSE stubs often lack user_id while the roster has it. */
  const canonicalSpeakKey = useCallback(
    (row: TelegramChatVoiceParticipant): string => {
      if (row.is_self) return "self";
      if (row.user_id != null && row.user_id > 0) return `u:${row.user_id}`;
      if (row.chat_id != null && row.chat_id !== 0) return `c:${row.chat_id}`;
      const title = row.title.trim();
      if (title) {
        const match = participantsRef.current.find((candidate) => {
          if (candidate.is_self) return false;
          if (candidate.title.trim() !== title) return false;
          return candidate.user_id != null && candidate.user_id > 0;
        });
        if (match?.user_id != null) return `u:${match.user_id}`;
        const chatMatch = participantsRef.current.find(
          (candidate) =>
            candidate.title.trim() === title &&
            candidate.chat_id != null &&
            candidate.chat_id !== 0,
        );
        if (chatMatch?.chat_id != null) return `c:${chatMatch.chat_id}`;
      }
      return `t:${title || "?"}`;
    },
    [],
  );

  const rowSpeakKeys = useCallback(
    (row: TelegramChatVoiceParticipant): string[] => {
      const keys = [canonicalSpeakKey(row), participantSpeakKey(row)];
      const title = row.title.trim();
      if (title) keys.push(`t:${title}`);
      return keys;
    },
    [canonicalSpeakKey, participantSpeakKey],
  );

  const clearSpeakingHoldsForRow = useCallback(
    (row: TelegramChatVoiceParticipant) => {
      for (const speakKey of rowSpeakKeys(row)) {
        speakingHoldUntilRef.current.delete(speakKey);
      }
    },
    [rowSpeakKeys],
  );

  /** Only TDLib-marked speakers become mix-RMS green targets — never the whole roster. */
  const seedRecentSpeakerFaces = useCallback(
    (
      rows: TelegramChatVoiceParticipant[],
      _options?: { force?: boolean; countHint?: number },
    ) => {
      for (const row of rows) {
        if (row.is_self || !row.is_speaking) continue;
        for (const key of rowSpeakKeys(row)) {
          if (key === "self") continue;
          recentSpeakerFaceKeysRef.current.add(key);
          mixCarrySpeakingKeysRef.current.add(key);
        }
      }
    },
    [rowSpeakKeys],
  );

  const applySpeakingMap = useCallback(
    (rows: TelegramChatVoiceParticipant[]) => {
      // Green mic = TDLib/SSE is_speaking (+ hold), extended by mix RMS for
      // recent faces when SSE speakingCount stays 0 after WebRTC join.
      const now = Date.now();
      // Short hold — 8s left multiple faces green after they stopped talking
      // (SSE speakingCount flopped while holds kept painting wrong mics).
      const holdMs = 2_500;
      let soonestExpiry = 0;
      const next: Record<string, true> = {};
      const joinedLocally = voiceJoinedRef.current;
      // Union SSE/poll rows with the painted roster so speaking flags reach faces
      // already on screen when a partial recent_speakers payload omits them.
      // Index by canonical keys so title-only stubs merge onto u:/c: roster rows.
      const mergedByKey = new Map<string, TelegramChatVoiceParticipant>();
      // Title → painted canonical key so thin SSE stubs (t: only) merge onto u:/c:.
      const titleToCanonical = new Map<string, string>();
      for (const row of participantsRef.current) {
        const key = canonicalSpeakKey(row);
        mergedByKey.set(key, row);
        const title = row.title.trim();
        if (title && !key.startsWith("t:")) titleToCanonical.set(title, key);
      }
      for (const row of rows) {
        let key = canonicalSpeakKey(row);
        if (key.startsWith("t:")) {
          const byTitle = titleToCanonical.get(row.title.trim());
          if (byTitle) key = byTitle;
        }
        const prev = mergedByKey.get(key);
        mergedByKey.set(
          key,
          prev
            ? {
                ...prev,
                ...row,
                title: row.title.trim() || prev.title,
                description: row.description || prev.description,
                user_id: row.user_id && row.user_id > 0 ? row.user_id : prev.user_id,
                chat_id: row.chat_id && row.chat_id !== 0 ? row.chat_id : prev.chat_id,
                is_speaking: Boolean(row.is_speaking),
                // Orderless recent_speakers stubs omit mute — never remute OR
                // unmute from them. Speaking opens mic chrome in the popover
                // (not a sticky is_muted flip that left listeners open-mic).
                is_muted: !String(row.order ?? "").trim()
                  ? Boolean(prev.is_muted)
                  : Boolean(row.is_muted),
                can_unmute_self:
                  typeof row.can_unmute_self === "boolean"
                    ? row.can_unmute_self
                    : prev.can_unmute_self,
                // Ordered TDLib rows own is_self. Thin speaking stubs must not
                // promote others OR sticky-keep a wrong You (Сева vs Vsevolod).
                is_self: !String(row.order ?? "").trim()
                  ? Boolean(prev.is_self)
                  : Boolean(row.is_self),
              }
            : {
                ...row,
                // New orderless stubs omit mute — stay unmuted until ordered
                // TDLib data (default muted painted silent faces as call-muted).
                is_muted: !String(row.order ?? "").trim()
                  ? false
                  : Boolean(row.is_muted),
              },
        );
      }
      const mergedRows = [...mergedByKey.values()];
      const markSpeaking = (row: TelegramChatVoiceParticipant) => {
        for (const speakKey of rowSpeakKeys(row)) {
          speakingHoldUntilRef.current.set(speakKey, now + holdMs);
          lastTdlibSpeakingAtRef.current.set(speakKey, now);
          mixCarrySpeakingKeysRef.current.add(speakKey);
          recentSpeakerFaceKeysRef.current.add(speakKey);
          next[speakKey] = true;
        }
      };
      let remoteSpeakingMarked = 0;
      let selfSpeakingSkipped = 0;
      for (const row of mergedRows) {
        const key = canonicalSpeakKey(row);
        // Local self: only RMS + live mic. TDLib often marks self speaking on join
        // while the mic is still muted — that painted a green ring incorrectly.
        if (key === "self" && joinedLocally) {
          if (micActiveRef.current && localSpeakingRef.current) {
            speakingHoldUntilRef.current.set(key, now + holdMs);
            next[key] = true;
          } else {
            if (row.is_speaking) selfSpeakingSkipped += 1;
            clearSpeakingHoldsForRow(row);
          }
          continue;
        }
        // Speaking wins for green ring. Do NOT permanently flip is_muted here —
        // that left mute icons wrong after a speaking pulse (unmuteKeys).
        if (row.is_speaking) {
          const prefs =
            participantMediaPrefsRef.current[voiceParticipantPrefsKey(row)];
          const volumePercent =
            prefs?.volumePercent ??
            (typeof row.volume_percent === "number" ? row.volume_percent : 100);
          // Prefer TDLib is_speaking for green mics (Telegram Desktop). The old
          // "wait until mix RMS latched" gate left remotes grey while
          // speakingCount>0 (silent_mix_heal / HTML sink flaps).
          if (volumePercent <= 0) {
            for (const speakKey of rowSpeakKeys(row)) {
              lastTdlibSpeakingAtRef.current.set(speakKey, now);
            }
            clearSpeakingHoldsForRow(row);
            continue;
          }
          markSpeaking(row);
          remoteSpeakingMarked += 1;
          continue;
        }
        // Soft stubs omit mute and often stay is_muted. Still honor an active
        // speaking hold so the live speaker keeps a green mic (tdesktop) —
        // clearing holds on mute wiped speaking chrome right after a pulse.
        if (row.is_muted) {
          const aliases = rowSpeakKeys(row);
          let until = 0;
          for (const speakKey of aliases) {
            until = Math.max(
              until,
              speakingHoldUntilRef.current.get(speakKey) ?? 0,
            );
          }
          if (until > now) {
            for (const speakKey of aliases) next[speakKey] = true;
          } else {
            clearSpeakingHoldsForRow(row);
          }
          continue;
        }
        const aliases = rowSpeakKeys(row);
        let until = 0;
        for (const speakKey of aliases) {
          until = Math.max(until, speakingHoldUntilRef.current.get(speakKey) ?? 0);
        }
        if (until > now) {
          for (const speakKey of aliases) next[speakKey] = true;
          if (soonestExpiry === 0 || until < soonestExpiry) soonestExpiry = until;
        } else {
          clearSpeakingHoldsForRow(row);
        }
      }
      // Partial SSE snapshots omit people still inside the speaking hold —
      // keep their green briefly, but never for muted roster faces.
      const mutedKeys = new Set<string>();
      for (const row of participantsRef.current) {
        if (!row.is_muted) continue;
        for (const speakKey of rowSpeakKeys(row)) mutedKeys.add(speakKey);
      }
      for (const [key, until] of speakingHoldUntilRef.current.entries()) {
        if (mutedKeys.has(key)) {
          speakingHoldUntilRef.current.delete(key);
          continue;
        }
        if (until > now) {
          if (!next[key]) next[key] = true;
          if (soonestExpiry === 0 || until < soonestExpiry) soonestExpiry = until;
        } else {
          speakingHoldUntilRef.current.delete(key);
        }
      }
      if (speakingHoldTimerRef.current) {
        clearTimeout(speakingHoldTimerRef.current);
        speakingHoldTimerRef.current = null;
      }
      if (soonestExpiry > now) {
        speakingHoldTimerRef.current = setTimeout(() => {
          speakingHoldTimerRef.current = null;
          const expiredAt = Date.now();
          setSpeakingByKey((prev) => {
            let changed = false;
            const cleared: Record<string, true> = { ...prev };
            for (const key of Object.keys(cleared)) {
              const until = speakingHoldUntilRef.current.get(key) ?? 0;
              if (until > 0 && until <= expiredAt) {
                speakingHoldUntilRef.current.delete(key);
                delete cleared[key];
                changed = true;
              }
            }
            return changed ? cleared : prev;
          });
        }, soonestExpiry - now + 16);
      }
      speakingListedRef.current = mergedRows.length;
      pendingSpeakingMapRef.current = next;
      const commitSpeaking = () => {
        speakingRafRef.current = null;
        const pending = pendingSpeakingMapRef.current;
        pendingSpeakingMapRef.current = null;
        if (!pending) return;
        setSpeakingByKey((prev) => {
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(pending);
          if (prevKeys.length === nextKeys.length) {
            let same = true;
            for (const key of nextKeys) {
              if (!prev[key]) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          if (nextKeys.length > 0 || remoteSpeakingMarked > 0 || selfSpeakingSkipped > 0) {
            logPageDisplay("messages_voice_roster_speaking_applied", {
              chatId,
              speakingCount: nextKeys.length,
              remoteSpeakingMarked,
              selfSpeakingSkipped,
              listed: speakingListedRef.current,
              applyMs: 0,
              popoverOpen: popoverOpenRef.current,
              source: "tdlib_is_speaking",
            });
          }
          return pending;
        });
      };
      // Positive speaking must paint immediately — deferred apply never ran during
      // voice_dialog freezes (rAF gaps / setTimeout starved), so green mics stayed off
      // while SSE speakingCount>0.
      if (remoteSpeakingMarked > 0 || Object.keys(next).length > 0) {
        if (speakingRafRef.current != null) {
          clearTimeout(speakingRafRef.current);
          speakingRafRef.current = null;
        }
        commitSpeaking();
        return;
      }
      // Listen-muted join: TDLib often pulses only self is_speaking — log so we
      // can tell "SSE speakingCount=1" is not a remote green candidate.
      if (selfSpeakingSkipped > 0) {
        logPageDisplay("messages_voice_roster_speaking_self_only", {
          chatId,
          selfSpeakingSkipped,
          listed: speakingListedRef.current,
          popoverOpen: popoverOpenRef.current,
          level: "info",
          note: "TDLib speaking pulse was self — remotes rely on mix open-mic paint",
        });
      }
      if (speakingRafRef.current != null) return;
      speakingRafRef.current = window.setTimeout(commitSpeaking, 0) as unknown as number;
    },
    [
      canonicalSpeakKey,
      chatId,
      clearSpeakingHoldsForRow,
      participantSpeakKey,
      rowSpeakKeys,
    ],
  );

  const applyRosterRows = useCallback(
    (
      incoming: TelegramChatVoiceParticipant[],
      countHint: number,
      options?: { preferMerge?: boolean },
    ) => {
      const applyStarted =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const joinedLocally = voiceJoinedRef.current;
      let withLocalSpeaking = incoming.map((row) => {
        if (!row.is_self || !joinedLocally) return row;
        return {
          ...row,
          // Never trust server speaking for the local row — join pulses green mic.
          is_speaking: Boolean(micActiveRef.current && localSpeakingRef.current),
          is_muted: !micActiveRef.current,
          can_unmute_self: true,
          // Local getDisplayMedia owns the self screencast icon — strip TDLib sticky.
          video_info: null,
          screen_sharing_video_info: null,
        };
      });
      // Spectator / after local leave: never paint You from poll/SSE. Gateway
      // listen-only injects and sticky TDLib is_joined used to re-add self after
      // the leave effect stripped it.
      if (!joinedLocally) {
        withLocalSpeaking = withLocalSpeaking.filter((row) => !row.is_self);
      }
      // Speaking map updates separately — never rebuild membership for a mic pulse.
      applySpeakingMap(withLocalSpeaking);
      seedRecentSpeakerFaces(withLocalSpeaking, { countHint });

      const prev = participantsRef.current;
      let next = withLocalSpeaking;
      if (joinedLocally && !next.some((row) => row.is_self)) {
        const prevSelf = prev.find((row) => row.is_self);
        // Only reuse a prior self title when it belongs to a real TDLib user_id.
        // Untitled / synthetic optimistic rows used to sticky-keep Hyperlinks
        // displayName (Сева) onto Vsevolod's local screencast label.
        const stickyTitle =
          prevSelf?.user_id != null &&
          prevSelf.user_id > 0 &&
          prevSelf.title.trim()
            ? prevSelf.title.trim()
            : "";
        next = [
          {
            user_id: prevSelf?.user_id ?? null,
            chat_id: prevSelf?.chat_id ?? null,
            title: stickyTitle || selfTitleRef.current || "You",
            description: prevSelf?.description ?? "",
            emoji_status_custom_emoji_id: prevSelf?.emoji_status_custom_emoji_id ?? null,
            is_speaking: false,
            is_muted: !micActiveRef.current,
            can_unmute_self: true,
            is_self: true,
          },
          ...next,
        ];
      }

      const speakKey = participantSpeakKey;
      const prevByKey = new Map(prev.map((row) => [speakKey(row), row]));
      const nextByKey = new Map(next.map((row) => [speakKey(row), row]));

      const hint = Math.max(0, countHint);
      // Never wipe a painted roster with an empty soft/SSE payload. Empty SSE
      // `ready` (cache miss, participant_count=0) used to clear recent_speakers
      // the soft poll just painted — strip showed 0 faces while the call had 3.
      // Call-end clears via setParticipants([]) on has_active_voice_chat=false.
      if (withLocalSpeaking.length === 0 && prev.length > 0) {
        const totalHint =
          hint >= 2
            ? hint
            : hint > 0
              ? Math.max(hint, prev.length)
              : Math.max(rosterTotalHintRef.current, prev.length);
        rosterTotalHintRef.current = totalHint;
        if (rosterCountHintStateRef.current !== totalHint) {
          rosterCountHintStateRef.current = totalHint;
          setRosterCountHint(totalHint);
        }
        return;
      }
      // SSE / soft polls often send a recent-speakers subset while participant_count
      // is still 4–5. Never replace a fuller roster with that subset. Soft / SSE
      // recent_speakers can also arrive *larger* than the painted roster
      // (orderless stubs) — never treat that as an authoritative membership grow
      // (that replaced listed=4 with listed=11 "?" while TDLib stayed at 5).
      const incomingLooksOrderless =
        next.length > 0 &&
        next.every((row) => !String(row.order ?? "").trim());
      const growsRoster = next.length > prev.length && !incomingLooksOrderless;
      if (growsRoster) {
        lastRosterExpandAtRef.current = Date.now();
      }
      // Authoritative shrink only when TDLib's participant_count has caught up to
      // the smaller payload AND every row is ordered (full load). An ordered
      // listed=1 (often self-only) with hint still 5+ used to tombstone every
      // remote and paint only "You" (prod SSE flaps). Soft recent_speakers
      // (orderless) with a matching undercount hint must never wipe a fuller
      // force-reload paint.
      const incomingLooksOrdered =
        next.length > 0 &&
        next.every((row) => Boolean(String(row.order ?? "").trim()));
      const hintConfirmsShrink = hint > 0 && hint <= next.length;
      const authoritativeShrink =
        !growsRoster &&
        next.length < prev.length &&
        next.length > 0 &&
        hintConfirmsShrink &&
        incomingLooksOrdered &&
        !incomingLooksOrderless;
      const nowMs = Date.now();
      for (const [key, at] of leaveTombstonesRef.current) {
        if (nowMs - at >= LEAVE_TOMBSTONE_MS) leaveTombstonesRef.current.delete(key);
      }
      const isTombstoned = (key: string) => {
        const at = leaveTombstonesRef.current.get(key);
        return at != null && nowMs - at < LEAVE_TOMBSTONE_MS;
      };
      // Clear tombstone when an ordered snapshot re-includes them (rejoin).
      for (const row of next) {
        if (String(row.order ?? "").trim()) {
          leaveTombstonesRef.current.delete(speakKey(row));
        }
      }
      // Only tombstone on confirmed shrink — never on thin ordered SSE, or merge
      // drops remotes and the sheet collapses to self.
      if (authoritativeShrink) {
        for (const row of prev) {
          const key = speakKey(row);
          if (!nextByKey.has(key)) leaveTombstonesRef.current.set(key, nowMs);
        }
      }
      // Drop tombstoned faces from the incoming soft payload before merge/replace.
      if (next.some((row) => isTombstoned(speakKey(row)))) {
        next = next.filter((row) => !isTombstoned(speakKey(row)));
        nextByKey.clear();
        for (const row of next) nextByKey.set(speakKey(row), row);
      }
      const looksLikeRecentSpeakersOnly =
        !growsRoster &&
        !authoritativeShrink &&
        next.length > 0 &&
        (incomingLooksOrderless ||
          hint === 0 ||
          hint > next.length) &&
        (options?.preferMerge ||
          incomingLooksOrderless ||
          (next.length <= 3 && prev.length > next.length) ||
          (hint > next.length && prev.length >= next.length && prev.length > 0));
      if (looksLikeRecentSpeakersOnly) {
        const merged = prev.flatMap((row) => {
          const key = speakKey(row);
          if (isTombstoned(key)) return [];
          const inc = nextByKey.get(key);
          if (!inc) {
            // Soft stubs absent from this snap are gone — keeping them unioned
            // ghosts after leave. Ordered faces stay during thin preferMerge
            // (hidden listeners / incomplete load) unless tombstoned above.
            if (!String(row.order ?? "").trim()) return [];
            // Never keep You while this web session is not in the call.
            if (row.is_self && !joinedLocally) return [];
            // Synthetic optimistic self without a TDLib user_id must not linger
            // once an ordered remote roster arrives (that painted Сева from
            // Hyperlinks displayName beside the real Vsevolod self).
            if (row.is_self && (row.user_id == null || row.user_id <= 0)) {
              const hasOrderedSelf = next.some(
                (r) => r.is_self && r.user_id != null && r.user_id > 0,
              );
              if (hasOrderedSelf) return [];
            }
            return [row];
          }
          // Thin recent_speakers stubs omit mute — never remute OR unmute from
          // them. Speaking opens mic chrome in the popover, not via is_muted.
          const nextMuted = !String(inc.order ?? "").trim()
            ? Boolean(row.is_muted)
            : Boolean(inc.is_muted);
          // Drop Hyperlinks displayName sticky when an ordered TDLib self arrives
          // with an empty title (profile still warming) — otherwise "Сева" stays
          // on the screencast label after getMe is Vsevolod.
          const promotingOrderedSelf =
            Boolean(inc.is_self) &&
            (row.user_id == null || row.user_id <= 0) &&
            inc.user_id != null &&
            inc.user_id > 0;
          const nextTitle = promotingOrderedSelf
            ? (!isEffectivelyBlankDisplayName(inc.title)
                ? stripInvisibleDisplayNameChars(inc.title).trim()
                : "") ||
              selfTitleRef.current ||
              "You"
            : (!isEffectivelyBlankDisplayName(inc.title)
                ? stripInvisibleDisplayNameChars(inc.title).trim()
                : "") || row.title;
          const nextDescription = inc.description || row.description;
          const nextEmoji =
            inc.emoji_status_custom_emoji_id ?? row.emoji_status_custom_emoji_id;
          // Ordered TDLib nulls clear stopped shares. Orderless soft stubs must
          // not wipe endpoints — their mapper always sends null for media.
          const incOrderless = !String(inc.order ?? "").trim();
          const nextVideo = mergeParticipantVideoInfo(
            inc.video_info,
            row.video_info,
            incOrderless,
          );
          const nextScreen = mergeParticipantVideoInfo(
            inc.screen_sharing_video_info,
            row.screen_sharing_video_info,
            incOrderless,
          );
          if (
            Boolean(row.is_muted) === nextMuted &&
            row.title === nextTitle &&
            row.description === nextDescription &&
            row.emoji_status_custom_emoji_id === nextEmoji &&
            (row.video_info?.endpoint_id ?? "") === (nextVideo?.endpoint_id ?? "") &&
            (row.screen_sharing_video_info?.endpoint_id ?? "") ===
              (nextScreen?.endpoint_id ?? "") &&
            voiceVideoInfoSignature(row.video_info) ===
              voiceVideoInfoSignature(nextVideo) &&
            voiceVideoInfoSignature(row.screen_sharing_video_info) ===
              voiceVideoInfoSignature(nextScreen)
          ) {
            return [row];
          }
          return [{
            ...row,
            is_muted: nextMuted,
            is_self: Boolean(inc.is_self),
            can_unmute_self:
              inc.can_unmute_self == null
                ? (row.can_unmute_self ?? true)
                : Boolean(inc.can_unmute_self),
            title: nextTitle,
            description: nextDescription,
            emoji_status_custom_emoji_id: nextEmoji,
            order: String(inc.order ?? "").trim() || row.order,
            volume_percent:
              typeof inc.volume_percent === "number"
                ? inc.volume_percent
                : row.volume_percent,
            video_info: nextVideo,
            screen_sharing_video_info: nextScreen,
            user_id:
              inc.user_id != null && inc.user_id > 0 ? inc.user_id : row.user_id,
            chat_id:
              inc.chat_id != null && inc.chat_id !== 0
                ? inc.chat_id
                : row.chat_id,
          }];
        });
        for (const inc of next) {
          if (!prevByKey.has(speakKey(inc))) {
            if (isTombstoned(speakKey(inc))) continue;
            // Untitled soft stubs must not grow the roster past TDLib's count —
            // that painted "+1 / 4 participants" for a 3-person call.
            if (hint >= 2 && merged.length >= hint) continue;
            if (!inc.title.trim() && hint > 0 && merged.length >= hint) continue;
            const orderless = !String(inc.order ?? "").trim();
            merged.push({
              ...inc,
              is_speaking: false,
              // Unknown mute on soft stubs → unmuted until an ordered update
              // (default muted painted silent non-streaming faces as call-muted).
              is_muted: orderless ? false : Boolean(inc.is_muted),
            });
          }
        }
        next = merged;
      } else {
        next = next.map((row) => {
          const prevMatch = prevByKey.get(speakKey(row));
          const titleFromIncoming = isEffectivelyBlankDisplayName(row.title)
            ? ""
            : stripInvisibleDisplayNameChars(row.title).trim();
          // Do not sticky-keep another account's title onto a newly identified self.
          const title =
            titleFromIncoming ||
            (prevMatch &&
            prevMatch.user_id != null &&
            row.user_id != null &&
            prevMatch.user_id === row.user_id
              ? prevMatch.title
              : "") ||
            (row.is_self ? selfTitleRef.current || "You" : "") ||
            prevMatch?.title ||
            "";
          const description = row.description || prevMatch?.description || "";
          const emoji =
            row.emoji_status_custom_emoji_id ??
            prevMatch?.emoji_status_custom_emoji_id ??
            null;
          // Ordered nulls clear media; orderless soft rows keep prior endpoints.
          const rowOrderless = !String(row.order ?? "").trim();
          const video = mergeParticipantVideoInfo(
            row.video_info,
            prevMatch?.video_info,
            rowOrderless,
          );
          const screen = mergeParticipantVideoInfo(
            row.screen_sharing_video_info,
            prevMatch?.screen_sharing_video_info,
            rowOrderless,
          );
          if (
            prevMatch &&
            prevMatch.user_id === row.user_id &&
            prevMatch.chat_id === row.chat_id &&
            prevMatch.title === title &&
            prevMatch.description === description &&
            prevMatch.emoji_status_custom_emoji_id === emoji &&
            Boolean(prevMatch.is_muted) === Boolean(row.is_muted) &&
            Boolean(prevMatch.is_self) === Boolean(row.is_self) &&
            (prevMatch.order ?? "") === (row.order ?? "") &&
            (prevMatch.volume_percent ?? 100) === (row.volume_percent ?? 100) &&
            (prevMatch.video_info?.endpoint_id ?? "") === (video?.endpoint_id ?? "") &&
            (prevMatch.screen_sharing_video_info?.endpoint_id ?? "") ===
              (screen?.endpoint_id ?? "") &&
            voiceVideoInfoSignature(prevMatch.video_info) ===
              voiceVideoInfoSignature(video) &&
            voiceVideoInfoSignature(prevMatch.screen_sharing_video_info) ===
              voiceVideoInfoSignature(screen)
          ) {
            return prevMatch;
          }
          // Orderless recent_speakers stubs must not invent mute either way —
          // keep the prior TDLib mute until an ordered participant update lands.
          // Unknown (no prior) → unmuted (soft default muted painted false mute).
          const nextMuted = !String(row.order ?? "").trim()
            ? Boolean(prevMatch?.is_muted ?? false)
            : Boolean(row.is_muted);
          return {
            ...row,
            is_speaking: false,
            is_muted: nextMuted,
            can_unmute_self:
              row.can_unmute_self == null
                ? (prevMatch?.can_unmute_self ?? true)
                : Boolean(row.can_unmute_self),
            title,
            description,
            emoji_status_custom_emoji_id: emoji,
            order: String(row.order ?? "").trim() || prevMatch?.order,
            volume_percent:
              typeof row.volume_percent === "number"
                ? row.volume_percent
                : prevMatch?.volume_percent,
            video_info: video,
            screen_sharing_video_info: screen,
          };
        });
        // Server soft payloads can still arrive oversized before the gateway
        // trim lands — clip orderless stubs to the TDLib floor. Never slice an
        // ordered force-reload roster when hint briefly undercounts (that hid
        // real participants: listed=6 → slice to hint=3).
        if (hint >= 2 && next.length > hint) {
          const ordered = next.filter((row) =>
            Boolean(String(row.order ?? "").trim()),
          );
          const orderless = next.filter(
            (row) => !String(row.order ?? "").trim(),
          );
          if (ordered.length >= hint) {
            next = ordered;
          } else {
            const ranked = [...orderless].sort((a, b) => {
              const score = (row: TelegramChatVoiceParticipant) =>
                (row.screen_sharing_video_info?.source_groups?.length ? 8 : 0) +
                (row.video_info?.source_groups?.length ? 4 : 0) +
                (row.title.trim() ? 4 : 0) +
                (row.is_self ? 2 : 0) +
                (row.is_speaking ? 1 : 0);
              return score(b) - score(a);
            });
            next = [...ordered, ...ranked.slice(0, hint - ordered.length)];
          }
        }
      }

      // tdesktop parity: roster order is STABLE while rows exist.
      const prevOrder = new Map(prev.map((row, index) => [speakKey(row), index]));
      next = [...next].sort((a, b) => {
        const ia = prevOrder.get(speakKey(a));
        const ib = prevOrder.get(speakKey(b));
        if (ia != null && ib != null) return ia - ib;
        if (ia != null) return -1;
        if (ib != null) return 1;
        if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      });

      const speakingCount = Object.keys(speakingByKeyRef.current).length;
      const applyMs = Math.round(
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now() - applyStarted
          : 0,
      );
      if (applyMs >= 32 || next.length >= 40) {
        logPageDisplay("messages_voice_roster_apply_cost", {
          chatId,
          applyMs,
          listed: next.length,
          speakingCount,
          popoverOpen: popoverOpenRef.current,
          level: applyMs >= 80 ? "warn" : "info",
        });
      }

      // Keep a TDLib floor for the strip label / reload. Once TDLib reports a
      // real total (≥2), trust it alone — do not let soft-merge ghost rows raise
      // the label via next.length (listed=11 totalHint=12 while get_chat=5).
      const totalHint =
        hint >= 2
          ? hint
          : hint > 0
            ? Math.max(hint, next.length)
            : Math.max(rosterTotalHintRef.current, next.length);
      rosterTotalHintRef.current = totalHint;
      const nextCount = next.length;

      const rosterChanged = !participantsEqual(prev, next);
      const countChanged = participantCountRef.current !== nextCount;
      const hintChanged = rosterCountHintStateRef.current !== totalHint;
      if (rosterChanged || countChanged) {
        logPageDisplay("messages_voice_roster_painted", {
          chatId,
          listed: next.length,
          count: nextCount,
          totalHint,
          prevListed: prev.length,
          mutedCount: next.filter((row) => row.is_muted).length,
          unmutedCount: next.filter((row) => !row.is_muted).length,
          zeroVolumeRemoteCount: next.filter(
            (row) =>
              !row.is_self &&
              typeof row.volume_percent === "number" &&
              row.volume_percent <= 0,
          ).length,
          popoverOpen: popoverOpenRef.current,
          titles: next.slice(0, 6).map((row) => formatVoiceParticipantTitle(row)),
          volumes: next
            .filter((row) => !row.is_self)
            .slice(0, 6)
            .map((row) => ({
              title: formatVoiceParticipantTitle(row),
              muted: row.is_muted,
              volume: row.volume_percent ?? null,
            })),
          screens: next
            .filter((row) => row.screen_sharing_video_info?.endpoint_id)
            .slice(0, 4)
            .map((row) => ({
              title: formatVoiceParticipantTitle(row),
              endpoint: row.screen_sharing_video_info?.endpoint_id,
              groups: row.screen_sharing_video_info?.source_groups?.length ?? 0,
            })),
        });
      }

      // Urgent setState — startTransition deferred forever under chat-list longtasks,
      // which left the strip/dialog empty despite successful polls.
      if (rosterChanged) {
        participantsRef.current = next;
        setParticipants(next);
      }
      if (countChanged) {
        participantCountRef.current = nextCount;
        setParticipantCount(nextCount);
      }
      if (hintChanged) {
        rosterCountHintStateRef.current = totalHint;
        setRosterCountHint(totalHint);
      }
    },
    [applySpeakingMap, chatId, participantSpeakKey, participantsEqual, seedRecentSpeakerFaces],
  );

  const pendingStreamSnapRef = useRef<VoiceParticipantsStreamSnapshot | null>(null);
  const streamApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamApplyAtRef = useRef(0);
  /** Bumps when a newer SSE snap supersedes a deferred double-rAF apply. */
  const streamApplyGenerationRef = useRef(0);

  useEffect(() => {
    pendingStreamSnapRef.current = null;
    if (streamApplyTimerRef.current != null) {
      clearTimeout(streamApplyTimerRef.current);
      streamApplyTimerRef.current = null;
    }
    streamApplyGenerationRef.current += 1;
    lastStreamApplyAtRef.current = 0;
  }, [chatId]);

  /** While the dialog is open, coalesce SSE roster merges to ≥3s (complete roster). */
  const STREAM_APPLY_OPEN_MIN_MS = 3_000;
  /** Thin roster while dialog open — apply membership quickly so rows appear. */
  const STREAM_APPLY_OPEN_THIN_MS = 400;
  /** Preview strip (dialog closed) — lighter throttle, still must show avatars. */
  const STREAM_APPLY_STRIP_MIN_MS = 1_200;

  const cancelStreamRosterFlush = useCallback(() => {
    if (streamApplyTimerRef.current != null) {
      clearTimeout(streamApplyTimerRef.current);
      streamApplyTimerRef.current = null;
    }
  }, []);

  const flushPendingStreamSnap = useCallback(() => {
    cancelStreamRosterFlush();
    lastStreamApplyAtRef.current = Date.now();
    const snapshot = pendingStreamSnapRef.current;
    pendingStreamSnapRef.current = null;
    if (!snapshot) return;
    // Speaking glow first — membership apply can wait.
    applySpeakingMap(snapshot.participants);
    const sheetOpen = popoverOpenRef.current;
    // SSE can fire for a bound empty call (participant_count=0, no rows). Do
    // not force hasActive=true — that stuck rings/Join with no Start button.
    const count =
      typeof snapshot.participant_count === "number" &&
      Number.isFinite(snapshot.participant_count)
        ? Math.max(0, Math.trunc(snapshot.participant_count))
        : 0;
    const looksLive =
      count > 0 ||
      snapshot.participants.length > 0 ||
      voiceJoinedRef.current;
    const live = syncVoicePresence(
      chatId,
      looksLive,
      snapshot.group_call_id,
      snapshot.participants,
      count,
      { allowClear: !looksLive },
    );
    if (!live && snapshot.participants.length === 0 && !voiceJoinedRef.current) return;

    const applyRows = (rows: TelegramChatVoiceParticipant[], countHint: number) => {
      // Thin recent-speakers stubs still merge inside applyRosterRows. Do not
      // early-return on shrink — that kept leavers (Сева) painted when SSE
      // sent listed=1 with a stale hint≥prevListed (sse_skip_thin).
      applyRosterRows(rows, countHint, {
        preferMerge: countHint > rows.length,
      });
    };

    const expandsRoster =
      snapshot.participants.length > participantsRef.current.length;

    if (!sheetOpen) {
      // Preview strip — apply immediately (no dialog controls to block).
      streamApplyGenerationRef.current += 1;
      applyRows(snapshot.participants, snapshot.participant_count);
      return;
    }

    logPageDisplay("messages_voice_dialog_sse_apply", {
      chatId,
      revision: snapshot.revision,
      listed: snapshot.participants.length,
      speakingCount: snapshot.participants.filter((p) => p.is_speaking).length,
      expandsRoster,
    });

    // Growing the roster must not wait on double-rAF — a later thin snap used to
    // schedule applyRows(listed=1) that ran after speaking_applied(listed=4) and
    // painted listed=1 (green mics had keys nobody rendered).
    if (expandsRoster || typeof window === "undefined") {
      streamApplyGenerationRef.current += 1;
      applyRows(snapshot.participants, snapshot.participant_count);
      return;
    }

    const generation = ++streamApplyGenerationRef.current;
    const rows = snapshot.participants;
    const countHint = snapshot.participant_count;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (generation !== streamApplyGenerationRef.current) return;
        applyRows(rows, countHint);
      });
    });
  }, [applyRosterRows, applySpeakingMap, cancelStreamRosterFlush, chatId, participantSpeakKey, syncVoicePresence]);

  const onStreamParticipants = useCallback(
    (snapshot: VoiceParticipantsStreamSnapshot) => {
      // Pending stream (no call resolved yet) — ignore; never treat as "call ended".
      if (snapshot.group_call_id == null) {
        streamRevisionRef.current = Math.max(streamRevisionRef.current, snapshot.revision);
        return;
      }
      streamRevisionRef.current = Math.max(streamRevisionRef.current, snapshot.revision);
      // Speaking must update immediately (green mics). Membership thrash is throttled.
      applySpeakingMap(snapshot.participants);
      seedRecentSpeakerFaces(snapshot.participants, {
        countHint: snapshot.participant_count,
      });
      pendingStreamSnapRef.current = snapshot;
      const listed = participantsRef.current.length;
      const hint = Math.max(rosterTotalHintRef.current, snapshot.participant_count);
      const expandsRoster = snapshot.participants.length > listed;
      const fillsTitles =
        snapshot.participants.some((row) => Boolean(row.title.trim())) &&
        participantsRef.current.some((row) => !row.title.trim() && !row.is_self);
      // Screencast/camera endpoints must not wait the 3s open-dialog coalesce —
      // that left crossed mute-chrome from join until a late force-reload.
      const bringsRemoteMedia = snapshot.participants.some((row) => {
        if (row.is_self) return false;
        const screen = row.screen_sharing_video_info;
        const camera = row.video_info;
        const hasScreen = Boolean(
          screen?.endpoint_id?.trim() || (screen?.source_groups?.length ?? 0) > 0,
        );
        const hasCamera = Boolean(
          camera?.endpoint_id?.trim() || (camera?.source_groups?.length ?? 0) > 0,
        );
        if (!hasScreen && !hasCamera) return false;
        const prev = participantsRef.current.find(
          (p) => participantSpeakKey(p) === participantSpeakKey(row),
        );
        if (!prev) return true;
        return (
          voiceVideoInfoSignature(prev.screen_sharing_video_info) !==
            voiceVideoInfoSignature(screen) ||
          voiceVideoInfoSignature(prev.video_info) !==
            voiceVideoInfoSignature(camera)
        );
      });
      const rosterThin =
        hint > listed || expandsRoster || fillsTitles || bringsRemoteMedia;
      // Expanding the painted roster mid-SDP (listed 3→7 during join_attempt) caused
      // voice_dialog_longtask / stuck UI. Keep speaking live; defer membership until
      // WebRTC is up (or Join was never armed).
      const joinBusy =
        voiceSessionJoiningRef.current ||
        voiceSessionNegotiatingRef.current ||
        (voiceJoinedRef.current &&
          !voiceSessionJoinedRef.current &&
          joinAttemptsRef.current < 3);
      if ((expandsRoster || fillsTitles || bringsRemoteMedia) && !joinBusy) {
        cancelStreamRosterFlush();
        flushPendingStreamSnap();
        return;
      }
      if ((expandsRoster || fillsTitles || bringsRemoteMedia) && joinBusy) {
        // Always keep the newest pending snap — a prior thin timer used to
        // swallow expands (new joiner never painted until soft poll, which timed out).
        cancelStreamRosterFlush();
        streamApplyTimerRef.current = setTimeout(() => {
          streamApplyTimerRef.current = null;
          if (
            voiceSessionJoiningRef.current ||
            voiceSessionNegotiatingRef.current ||
            (voiceJoinedRef.current && !voiceSessionJoinedRef.current)
          ) {
            // Still busy — check again shortly after join_ok.
            streamApplyTimerRef.current = setTimeout(() => {
              streamApplyTimerRef.current = null;
              flushPendingStreamSnap();
            }, 400);
            return;
          }
          flushPendingStreamSnap();
        }, STREAM_APPLY_OPEN_THIN_MS);
        return;
      }
      if (streamApplyTimerRef.current != null) return;
      const minMs = popoverOpenRef.current
        ? rosterThin
          ? STREAM_APPLY_OPEN_THIN_MS
          : STREAM_APPLY_OPEN_MIN_MS
        : STREAM_APPLY_STRIP_MIN_MS;
      const sinceLast = Date.now() - lastStreamApplyAtRef.current;
      if (sinceLast >= minMs) {
        flushPendingStreamSnap();
        return;
      }
      streamApplyTimerRef.current = setTimeout(() => {
        streamApplyTimerRef.current = null;
        flushPendingStreamSnap();
      }, minMs - sinceLast);
    },
    [applySpeakingMap, cancelStreamRosterFlush, flushPendingStreamSnap, participantSpeakKey, seedRecentSpeakerFaces],
  );

  useEffect(() => {
    if (popoverOpen) return;
    cancelStreamRosterFlush();
    // Do NOT flush pending SSE membership onto the strip in the same tick as
    // close — that remounted avatars/roster and froze Escape/X reopen. Speaking
    // map already updated live; membership can land on the next throttled tick.
    if (!pendingStreamSnapRef.current) {
      return () => {
        cancelStreamRosterFlush();
      };
    }
    const timer = setTimeout(() => {
      if (popoverOpenRef.current) return;
      if (pendingStreamSnapRef.current) {
        flushPendingStreamSnap();
      }
    }, 1_200);
    return () => {
      clearTimeout(timer);
      cancelStreamRosterFlush();
    };
  }, [popoverOpen, cancelStreamRosterFlush, flushPendingStreamSnap]);

  const [popoverMountKey, setPopoverMountKey] = useState(0);
  const postJoinRosterLoadedRef = useRef(false);
  const postJoinForceInFlightRef = useRef(false);

  const onStreamActiveChange = useCallback((active: boolean) => {
    streamActiveRef.current = active;
  }, []);

  useTelegramVoiceParticipantsStream({
    // Only subscribe once we have a call id or confirmed presence — a pending
    // stream reconnects every ~8s and was thrashing mount/presence sync.
    enabled:
      isTelegramMessagesConnected &&
      visible &&
      (Boolean(joined) ||
        presenceConfirmed ||
        (groupCallId != null && groupCallId > 0)),
    chatId,
    groupCallId,
    getSinceRevision: () => streamRevisionRef.current || null,
    onParticipants: onStreamParticipants,
    onStreamActiveChange,
  });

  const mapVoiceCallMessage = useCallback(
    (row: TelegramVoiceCallMessage): VoiceChatMessage => ({
      id: row.id,
      text: row.text,
      senderName: row.sender_name || (row.is_self ? "You" : "?"),
      sentAt: row.sent_at,
    }),
    [],
  );

  const appendVoiceChatMessage = useCallback(
    (row: TelegramVoiceCallMessage) => {
      const mapped = mapVoiceCallMessage(row);
      setVoiceChatMessages((prev) => {
        if (prev.some((m) => m.id === mapped.id)) return prev;
        // Prefer the TDLib-backed id over the optimistic local row.
        // Match text only — sender display name can differ ("You" vs roster title).
        if (!mapped.id.includes(":local:")) {
          const withoutLocal = prev.filter(
            (m) => !(m.id.includes(":local:") && m.text === mapped.text),
          );
          const next = [...withoutLocal, mapped];
          return next.length > 40 ? next.slice(-40) : next;
        }
        if (prev.some((m) => !m.id.includes(":local:") && m.text === mapped.text)) {
          return prev;
        }
        const next = [...prev, mapped];
        return next.length > 40 ? next.slice(-40) : next;
      });
    },
    [mapVoiceCallMessage],
  );

  useTelegramVoiceCallMessagesStream({
    enabled:
      isTelegramMessagesConnected &&
      Boolean(popoverOpen) &&
      Boolean(joined) &&
      groupCallId != null &&
      groupCallId > 0,
    chatId,
    groupCallId,
    getSinceRevision: () => voiceChatMessagesRevisionRef.current || null,
    onReadyMessages: (messages, revision) => {
      voiceChatMessagesRevisionRef.current = revision;
      setVoiceChatMessages(messages.map(mapVoiceCallMessage));
    },
    onMessage: (message, revision) => {
      if (revision > voiceChatMessagesRevisionRef.current) {
        voiceChatMessagesRevisionRef.current = revision;
      }
      appendVoiceChatMessage(message);
    },
  });

  useEffect(() => {
    if (popoverOpen) return;
    setVoiceChatMessages([]);
    voiceChatMessagesRevisionRef.current = 0;
  }, [popoverOpen]);

  const onSendVoiceChatMessage = useCallback(
    async (text: string) => {
      const sendOnce = () =>
        sendTelegramChatVoiceCallMessage({
          chatId,
          groupCallId,
          text,
        });
      let result = await sendOnce();
      if (
        !result.ok &&
        typeof result.error === "string" &&
        result.error.includes("GROUPCALL_JOIN_MISSING")
      ) {
        // joinListen no-ops when WebRTC still reports joined — force TDLib rebind.
        logPageDisplay("messages_voice_call_message_rejoin", {
          chatId,
          groupCallId,
          level: "warn",
          note: "GROUPCALL_JOIN_MISSING on send — force TDLib rejoin then retry",
        });
        const rejoined = await rejoinForTdlibRef.current({
          startMuted: !micActiveRef.current,
        });
        if (rejoined) {
          result = await sendOnce();
        }
      }
      if (!result.ok) {
        appWarn("[voice-call-message]", result.error, { chatId, groupCallId });
        return;
      }
      if (result.message) {
        appendVoiceChatMessage(result.message);
      }
    },
    [appendVoiceChatMessage, chatId, groupCallId],
  );

  const refreshParticipants = useCallback(async (): Promise<"ok" | "retry_soon" | "backoff"> => {
    if (!isTelegramMessagesConnected) return "backoff";
    // Soft HTTP polls contend with joinVideoChat on TDLib. While Join is armed
    // but WebRTC is not up yet, skip entirely. After webrtc_join_ok, allow soft
    // polls even with the sheet open so speaking/roster recover if SSE stalls.
    if (
      voiceJoinedRef.current &&
      !voiceSessionJoinedRef.current &&
      joinAttemptsRef.current < 3
    ) {
      return "ok";
    }
    if (popoverOpenRef.current && !voiceSessionJoinedRef.current) {
      return "ok";
    }
    softPollAbortRef.current?.abort();
    const abort = new AbortController();
    softPollAbortRef.current = abort;
    const pollChatId = chatId;
    try {
      const result = await fetchTelegramChatVoiceParticipants(pollChatId, null, {
        signal: abort.signal,
      });
      if (chatIdRef.current !== pollChatId) return "ok";
      if (result.ok) {
        const live = syncVoicePresence(
          pollChatId,
          result.has_active_voice_chat,
          result.voice_chat_group_call_id,
          result.participants,
          result.participant_count,
          { allowClear: true },
        );
        // Empty / inactive call — drop strip even when API still reports a bound
        // has_active_voice_chat with participant_count=0 (stale TDLib metadata).
        if (!live && !voiceJoinedRef.current) {
          setParticipants([]);
          setParticipantCount(0);
          rosterTotalHintRef.current = 0;
          rosterCountHintStateRef.current = 0;
          setRosterCountHint(0);
          setPresenceConfirmedAndNotify(false);
          return "ok";
        }
        // Always paint rows when TDLib returned any participants — countHint of 0
        // used to leave the strip empty despite a real self/other roster.
        if (result.participants.length > 0 || live || voiceJoinedRef.current) {
          if (result.has_hidden_listeners) {
            hasHiddenListenersRef.current = true;
          }
          applyRosterRows(result.participants, result.participant_count, {
            preferMerge: result.participant_count > result.participants.length,
          });
        }
        return "ok";
      }
      if (result.error === "aborted") {
        return "ok";
      }
      if (result.error === "not_connected" || result.error === "session_not_ready") {
        return "backoff";
      }
      if (result.error === "timeout" || result.error === "network_error") {
        appWarn("[message-voice-participants]", result.error, { chatId, groupCallId });
        return "backoff";
      }
      appWarn("[message-voice-participants]", result.error, { chatId, groupCallId });
      return "retry_soon";
    } catch (err) {
      appWarn("[message-voice-participants]", err instanceof Error ? err.message : String(err), {
        chatId,
        groupCallId,
      });
      return "backoff";
    }
  }, [
    applyRosterRows,
    chatId,
    groupCallId,
    isTelegramMessagesConnected,
    syncVoicePresence,
  ]);

  useEffect(() => {
    // Local WebRTC mic/speaking only applies after an explicit Join on this client.
    // Before that, keep server mute/speaking for the account's other-client presence.
    if (!joined) return;
    setParticipants((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (!row.is_self) return row;
        const isMuted = !voiceSession.micActive;
        if (row.is_muted === isMuted) return row;
        changed = true;
        return { ...row, is_muted: isMuted };
      });
      return changed ? next : prev;
    });
    if (voiceSession.localSpeaking && voiceSession.micActive) {
      setSpeakingByKey((prev) => (prev.self ? prev : { ...prev, self: true }));
      speakingHoldUntilRef.current.set("self", Date.now() + 2_500);
    } else {
      const until = speakingHoldUntilRef.current.get("self") ?? 0;
      if (!voiceSession.micActive || until <= Date.now()) {
        speakingHoldUntilRef.current.delete("self");
        setSpeakingByKey((prev) => {
          if (!prev.self) return prev;
          const next = { ...prev };
          delete next.self;
          return next;
        });
      }
    }
  }, [joined, voiceSession.localSpeaking, voiceSession.micActive]);

  // Mix RMS is not per-participant identity. After WebRTC join TDLib often only
  // pulses is_speaking for self (skipped while listen-muted) while remotes keep
  // talking — SSE speakingCount stays 0 and greens never light. Prefer TDLib
  // identity; otherwise, if exactly one unmuted remote exists, light them while
  // mix RMS is hot. Never invent unmute / speaking for the whole roster from
  // mixed-track energy (that painted every face open-mic vs Telegram Desktop).
  // Keep grace short — an 18s window re-lit every recent speaker whenever mix
  // RMS pulsed, so wrong green mics stacked (Blox: speakingCount=6 from 2 marks).
  const MIX_SPEAKING_GRACE_MS = 3_500;
  const MIX_SPEAKING_HOLD_MS = 1_800;
  const extendMixSpeakingHolds = useCallback(() => {
    if (!voiceJoinedRef.current || !remoteSpeakingRef.current) return;
    heardRemoteMixRef.current = true;
    mixSilentSinceRef.current = 0;
    const roster = participantsRef.current;
    const remotes = roster.filter(
      (row) => !row.is_self && canonicalSpeakKey(row) !== "self",
    );
    if (remotes.length === 0) return;
    const now = Date.now();
    const graceMs = MIX_SPEAKING_GRACE_MS;
    const holdMs = MIX_SPEAKING_HOLD_MS;
    const remoteVolumePercent = (row: TelegramChatVoiceParticipant) => {
      const prefs =
        participantMediaPrefsRef.current[voiceParticipantPrefsKey(row)];
      return (
        prefs?.volumePercent ??
        (typeof row.volume_percent === "number" ? row.volume_percent : 100)
      );
    };
    const lastTdlibAt = (row: TelegramChatVoiceParticipant) => {
      let best = 0;
      for (const key of rowSpeakKeys(row)) {
        best = Math.max(best, lastTdlibSpeakingAtRef.current.get(key) ?? 0);
      }
      return best;
    };
    // TDLib-backed identity only — do not invent from speakingByKey/hold (loops).
    const isTdlibRecentSpeaker = (row: TelegramChatVoiceParticipant) => {
      const seen = lastTdlibAt(row);
      return seen > 0 && now - seen < graceMs;
    };
    let targets = remotes.filter(
      (row) =>
        !row.is_muted &&
        remoteVolumePercent(row) > 0 &&
        isTdlibRecentSpeaker(row),
    );
    let mixSource: "tdlib_hold" | "solo" = "tdlib_hold";
    if (targets.length > 1) {
      // Mix energy is one bit — never paint every recent face green at once.
      let bestRow = targets[0]!;
      let bestAt = lastTdlibAt(bestRow);
      for (let i = 1; i < targets.length; i += 1) {
        const row = targets[i]!;
        const at = lastTdlibAt(row);
        if (at > bestAt || (at === bestAt && row.is_speaking && !bestRow.is_speaking)) {
          bestRow = row;
          bestAt = at;
        }
      }
      targets = [bestRow];
    }
    if (targets.length === 0) {
      const unmutedRemotes = remotes.filter((row) => {
        if (row.is_muted) return false;
        return remoteVolumePercent(row) > 0;
      });
      // Only safe without TDLib identity when exactly one open mic exists.
      if (unmutedRemotes.length !== 1) return;
      targets = unmutedRemotes;
      mixSource = "solo";
    }
    const targetKeys = new Set<string>();
    for (const row of targets) {
      for (const key of rowSpeakKeys(row)) {
        speakingHoldUntilRef.current.set(key, now + holdMs);
        mixCarrySpeakingKeysRef.current.add(key);
        targetKeys.add(key);
      }
    }
    // Drop mix-carried greens on non-targets so wrong faces clear when someone
    // else talks (do not touch fresh TDLib holds from applySpeakingMap).
    for (const key of [...mixCarrySpeakingKeysRef.current]) {
      if (targetKeys.has(key)) continue;
      const tdlibAt = lastTdlibSpeakingAtRef.current.get(key) ?? 0;
      const stillTdlibPulse = tdlibAt > 0 && now - tdlibAt < 1_200;
      if (stillTdlibPulse) continue;
      mixCarrySpeakingKeysRef.current.delete(key);
      speakingHoldUntilRef.current.delete(key);
    }
    setSpeakingByKey((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key === "self" || targetKeys.has(key)) continue;
        const until = speakingHoldUntilRef.current.get(key) ?? 0;
        if (until > now) continue;
        delete next[key];
        changed = true;
      }
      for (const row of targets) {
        for (const key of rowSpeakKeys(row)) {
          if (!next[key]) {
            next[key] = true;
            changed = true;
          }
        }
      }
      for (const key of Object.keys(prev)) {
        const until = speakingHoldUntilRef.current.get(key) ?? 0;
        if (until > now && !next[key]) {
          next[key] = true;
          changed = true;
        }
      }
      if (!changed) return prev;
      logPageDisplay("messages_voice_roster_speaking_applied", {
        chatId,
        speakingCount: Object.keys(next).length,
        remoteSpeakingMarked: targets.length,
        selfSpeakingSkipped: 0,
        listed: roster.length,
        applyMs: 0,
        popoverOpen: popoverOpenRef.current,
        source:
          mixSource === "solo"
            ? "remote_audio_level_solo"
            : "remote_audio_level_tdlib_hold",
      });
      return next;
    });
    if (speakingHoldTimerRef.current != null) {
      clearTimeout(speakingHoldTimerRef.current);
    }
    speakingHoldTimerRef.current = setTimeout(() => {
      speakingHoldTimerRef.current = null;
      if (remoteSpeakingRef.current && voiceJoinedRef.current) return;
      const expired = Date.now();
      setSpeakingByKey((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, until] of speakingHoldUntilRef.current.entries()) {
          if (until <= expired) {
            speakingHoldUntilRef.current.delete(key);
            if (next[key]) {
              delete next[key];
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    }, holdMs + 50);
  }, [canonicalSpeakKey, chatId, rowSpeakKeys]);

  useEffect(() => {
    if (!joined) {
      heardRemoteMixRef.current = false;
      return;
    }
    if (voiceSession.remoteSpeaking) {
      heardRemoteMixRef.current = true;
    }
  }, [joined, voiceSession.remoteSpeaking]);

  useEffect(() => {
    if (!joined) return;
    const now = Date.now();
    for (const [key, seen] of lastTdlibSpeakingAtRef.current.entries()) {
      if (seen > 0 && now - seen < MIX_SPEAKING_GRACE_MS) {
        mixCarrySpeakingKeysRef.current.add(key);
      }
    }
    for (const key of Object.keys(speakingByKeyRef.current)) {
      mixCarrySpeakingKeysRef.current.add(key);
    }
    for (const key of recentSpeakerFaceKeysRef.current) {
      mixCarrySpeakingKeysRef.current.add(key);
    }
  }, [joined]);

  useEffect(() => {
    if (mixSpeakingExtendTimerRef.current != null) {
      clearInterval(mixSpeakingExtendTimerRef.current);
      mixSpeakingExtendTimerRef.current = null;
    }
    if (!joined || !voiceSession.remoteSpeaking) {
      if (!voiceSession.remoteSpeaking) {
        if (mixSilentSinceRef.current === 0) mixSilentSinceRef.current = Date.now();
      }
      const silenceClearTimer =
        joined &&
        !voiceSession.remoteSpeaking &&
        typeof window !== "undefined"
          ? window.setTimeout(() => {
              if (voiceJoinedRef.current && !remoteSpeakingRef.current) {
                mixCarrySpeakingKeysRef.current.clear();
              }
            }, 750)
          : null;
      const now = Date.now();
      let soonest = 0;
      for (const until of speakingHoldUntilRef.current.values()) {
        if (until > now && (soonest === 0 || until < soonest)) soonest = until;
      }
      if (soonest > now) {
        if (speakingHoldTimerRef.current != null) {
          clearTimeout(speakingHoldTimerRef.current);
        }
        speakingHoldTimerRef.current = setTimeout(() => {
          speakingHoldTimerRef.current = null;
          const expired = Date.now();
          setSpeakingByKey((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const [key, until] of speakingHoldUntilRef.current.entries()) {
              if (until <= expired) {
                speakingHoldUntilRef.current.delete(key);
                if (next[key]) {
                  delete next[key];
                  changed = true;
                }
              }
            }
            return changed ? next : prev;
          });
        }, soonest - now + 16);
      }
      return () => {
        if (silenceClearTimer != null) window.clearTimeout(silenceClearTimer);
      };
    }
    extendMixSpeakingHolds();
    mixSpeakingExtendTimerRef.current = setInterval(extendMixSpeakingHolds, 900);
    return () => {
      if (mixSpeakingExtendTimerRef.current != null) {
        clearInterval(mixSpeakingExtendTimerRef.current);
        mixSpeakingExtendTimerRef.current = null;
      }
    };
  }, [extendMixSpeakingHolds, joined, voiceSession.remoteSpeaking]);

  // As soon as we join locally, show self immediately — don't wait for the first
  // poll (solo muted calls often come back empty until TDLib catches up).
  // On local leave, drop the optimistic self row; the next poll restores it if
  // the account is still in the call from another client.
  useEffect(() => {
    if (!joined) {
      setParticipants((prev) => {
        if (!prev.some((row) => row.is_self)) return prev;
        return prev.filter((row) => !row.is_self);
      });
      return;
    }
    setParticipants((prev) => {
      if (prev.some((row) => row.is_self)) return prev;
      return [
        {
          user_id: null,
          chat_id: null,
          title: selfTitleRef.current || "You",
          description: "",
          emoji_status_custom_emoji_id: null,
          is_speaking: Boolean(micActiveRef.current && localSpeakingRef.current),
          is_muted: !micActiveRef.current,
          can_unmute_self: true,
          is_self: true,
        },
        ...prev,
      ];
    });
    setParticipantCount((prev) => Math.max(prev, 1));
  }, [joined]);

  // Presence poll even before Join so avatars show who's already in the call.
  // Metronome uses refs so refreshParticipants identity churn cannot restart the
  // loop and stack overlapping polls (that froze the voice dialog).
  const refreshParticipantsRef = useRef(refreshParticipants);
  refreshParticipantsRef.current = refreshParticipants;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let consecutiveBackoffs = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tickCount = 0;

    // Read popoverOpen via ref so opening/closing the sheet does not tear down
    // this metronome (that raced force-reload and stacked polls → UI freeze).
    const nextBaseMs = () => {
      const sheetOpen = popoverOpenRef.current;
      if (!visible) return 30_000;
      // Only treat a truly empty roster as "fill me" — only-self still paints a
      // count and used to keep a 4s soft-poll forever (2–5s each), freezing UI.
      const stripEmpty = participantsRef.current.length === 0;
      if (!sheetOpen && stripEmpty) return 8_000;
      // SSE owns live roster — soft HTTP is only a slow safety net. Aggressive
      // 6–8s polls (often 3–6s each) stacked with chat-list paint and froze UI.
      // While joined + sheet open, keep a tighter net so speaking/roster recover
      // if SSE stalls during SDP (logs: join_ok then speakingCount frozen).
      if (streamActiveRef.current) {
        if (sheetOpen && voiceJoinedRef.current) return 8_000;
        return sheetOpen ? 20_000 : 30_000;
      }
      if (joined) return sheetOpen ? 12_000 : 20_000;
      return sheetOpen ? 12_000 : 25_000;
    };

    const arm = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled) return;
      const sheetOpen = popoverOpenRef.current;
      const baseMs = nextBaseMs();
      // Soft polls starve joinVideoChat — skip while Join is in flight. After
      // webrtc_join_ok, allow a slow safety net so speaking recovers if SSE
      // stalls during setRemoteDescription (logs: join_ok then frozen mics).
      const joiningInFlight =
        voiceJoinedRef.current &&
        !voiceSessionJoinedRef.current &&
        joinAttemptsRef.current < 3;
      if (joiningInFlight || (sheetOpen && !voiceSessionJoinedRef.current)) {
        arm(baseMs);
        return;
      }
      // SSE only replays the gateway cache. Soft getGroupCall warms recent_speakers
      // into that cache; without it the strip stays empty after an empty `ready`.
      // Once any row is painted (including only-self), stop hammering — background
      // soft-warm + SSE revisions fill other faces.
      if (!sheetOpen && streamActiveRef.current && participantsRef.current.length > 0) {
        arm(baseMs);
        return;
      }
      if (inFlight) {
        logPageDisplay("messages_voice_dialog_poll_skip_inflight", {
          chatId,
          popoverOpen: sheetOpen,
          joined,
          baseMs,
        });
        arm(baseMs);
        return;
      }
      inFlight = true;
      tickCount += 1;
      const started =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      let status: "ok" | "retry_soon" | "backoff" = "ok";
      try {
        status = await refreshParticipantsRef.current();
      } catch {
        status = "backoff";
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      const elapsedMs = Math.round(
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - started,
      );
      if (sheetOpen || elapsedMs >= 800 || tickCount % 8 === 1) {
        logPageDisplay("messages_voice_dialog_poll_tick", {
          chatId,
          popoverOpen: sheetOpen,
          joined,
          status,
          elapsedMs,
          tickCount,
          nextBaseMs: baseMs,
          level: elapsedMs >= 1200 ? "warn" : "info",
        });
      }
      if (status === "ok") {
        consecutiveBackoffs = 0;
      } else {
        consecutiveBackoffs += 1;
      }
      const intervalMs =
        status === "ok"
          ? nextBaseMs()
          : Math.min(baseMs * 2 ** Math.min(consecutiveBackoffs, 3), 12_000);
      arm(intervalMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [joined, visible, chatId]);

  // After WebRTC/TDLib join lands, reload immediately — join floods participant
  // updates that presence polls would otherwise miss until the next interval.
  // While the sheet is open the post-join force-reload effect owns this.
  useEffect(() => {
    if (!voiceSession.joined) return;
    if (popoverOpenRef.current) return;
    void refreshParticipantsRef.current();
  }, [voiceSession.joined]);

  // Auto-show the best live remote screencast (Telegram-like). Cameras stay
  // opt-in. Soft-start 180p + constraints throttle in the session limit mix
  // freeze risk; after a live stall we soft-pause and stop auto-picking.
  const setRemoteVideoRequests = voiceSession.setRemoteVideoRequests;
  const preferExplicitRemoteVideoSubscribe =
    voiceSession.preferExplicitRemoteVideoSubscribe;
  const setParticipantListenVolumes = voiceSession.setParticipantListenVolumes;
  const voiceJoined = voiceSession.joined;
  const remoteVideoRepushEpoch = voiceSession.remoteVideoRepushEpoch;
  const remoteVideoSources = voiceSession.remoteVideoSources;
  const mixPausedScreenEndpoints = voiceSession.mixPausedScreenEndpoints;
  const mixProtectDropHadLiveVideo = voiceSession.mixProtectDropHadLiveVideo;
  const mixProtectScreenAutoRestorePending =
    voiceSession.mixProtectScreenAutoRestorePending;
  const mixPausedScreenSet = useMemo(
    () => new Set(mixPausedScreenEndpoints),
    [mixPausedScreenEndpoints],
  );
  const remoteVideoSourceKey = useMemo(() => {
    const muteSig = Object.entries(participantMediaPrefs)
      .map(
        ([key, prefs]) =>
          `${key}:${prefs.muteScreen ? 1 : 0}:${prefs.muteVideo ? 1 : 0}`,
      )
      .sort()
      .join(",");
    const pausedSig = mixPausedScreenEndpoints.slice().sort().join(",");
    return (
      participants
        .filter((row) => !row.is_self)
        .map(
          (row) =>
            `${row.user_id ?? row.chat_id}:s${voiceVideoInfoSignature(row.screen_sharing_video_info)}:c${voiceVideoInfoSignature(row.video_info)}`,
        )
        .join("|") + `|mute:${muteSig}|paused:${pausedSig}`
    );
  }, [participants, participantMediaPrefs, mixPausedScreenEndpoints]);

  // Mix-protect pause handling:
  // - Ghost (0 video RTP): revoke + ban endpoint so auto-show can pick next.
  // - Live H264 that froze Opus + one-shot restore armed: keep unmuted intent
  //   (explicit unmute and auto-show that already painted both arm restore).
  // - Live H264 without restore: ban endpoint + block further auto-show.
  useEffect(() => {
    if (!voiceJoined || Platform.OS !== "web") return;
    if (mixPausedScreenSet.size === 0) return;
    const liveStall = mixProtectDropHadLiveVideo;
    const expectsRestore = liveStall && mixProtectScreenAutoRestorePending;
    let revoked = false;
    for (const row of participantsRef.current) {
      if (row.is_self) continue;
      const endpoint = row.screen_sharing_video_info?.endpoint_id?.trim() || "";
      if (!endpoint || !mixPausedScreenSet.has(endpoint)) continue;
      if (!expectsRestore) {
        failedAutoScreenEndpointsRef.current.add(endpoint);
        if (liveStall) {
          // Live screen froze Opus and session will not auto-restore —
          // stop auto-show for this join (user can unmute manually).
          autoScreenBlockedAfterLiveMixStallRef.current = true;
        } else {
          autoScreenBlockedAfterLiveMixStallRef.current = false;
        }
        const key = voiceParticipantPrefsKey(row);
        if (explicitScreenWantedKeysRef.current.delete(key)) {
          revoked = true;
        }
        const cur = participantMediaPrefsRef.current[key];
        if (cur && cur.muteScreen === false) {
          const next = { ...cur, muteScreen: true };
          participantMediaPrefsRef.current = {
            ...participantMediaPrefsRef.current,
            [key]: next,
          };
          revoked = true;
        }
        if (
          preferredExplicitScreenEndpointRef.current &&
          preferredExplicitScreenEndpointRef.current === endpoint
        ) {
          preferredExplicitScreenEndpointRef.current = null;
        }
        if (autoScreenCommittedEndpointsRef.current.has(endpoint)) {
          autoScreenCommittedEndpointsRef.current.delete(endpoint);
        }
      } else {
        // Live stall with restore armed: keep muteScreen=false + wanted key.
        const key = voiceParticipantPrefsKey(row);
        if (!explicitScreenWantedKeysRef.current.has(key)) {
          explicitScreenWantedKeysRef.current.add(key);
          revoked = true;
        }
        const cur = participantMediaPrefsRef.current[key];
        if (cur && cur.muteScreen !== false) {
          participantMediaPrefsRef.current = {
            ...participantMediaPrefsRef.current,
            [key]: { ...cur, muteScreen: false },
          };
          revoked = true;
        } else if (!cur) {
          participantMediaPrefsRef.current = {
            ...participantMediaPrefsRef.current,
            [key]: {
              volumePercent:
                typeof row.volume_percent === "number" ? row.volume_percent : 100,
              muteScreen: false,
              muteVideo: true,
            },
          };
          revoked = true;
        }
        preferredExplicitScreenEndpointRef.current = endpoint;
      }
    }
    if (!revoked && !expectsRestore) return;
    if (revoked) {
      setWantedScreenPeerKeys([...explicitScreenWantedKeysRef.current]);
      setParticipantMediaPrefs({ ...participantMediaPrefsRef.current });
    }
    logPageDisplay(
      expectsRestore
        ? "messages_voice_remote_screen_soft_pause_live"
        : liveStall
          ? "messages_voice_remote_screen_mix_stall_ban"
          : "messages_voice_remote_screen_auto_show_failover",
      {
        chatId,
        paused: [...mixPausedScreenSet].slice(0, 4),
        failed: [...failedAutoScreenEndpointsRef.current].slice(0, 4),
        level: "info",
        note: expectsRestore
          ? "live screen paused for mix — keep unmuted chrome, await restore"
          : liveStall
            ? "live screen froze mix — ban endpoint, no auto-restore (audio-only)"
            : "revoked paused ghost share — will auto-show next candidate",
      },
    );
  }, [
    voiceJoined,
    mixPausedScreenSet,
    mixProtectDropHadLiveVideo,
    mixProtectScreenAutoRestorePending,
    chatId,
  ]);

  useEffect(() => {
    if (!voiceJoined || Platform.OS !== "web") {
      userDeniedScreenKeysRef.current.clear();
      failedAutoScreenEndpointsRef.current.clear();
      autoScreenBlockedAfterLiveMixStallRef.current = false;
      screenEndpointFirstSeenAtRef.current.clear();
      autoScreenCommittedEndpointsRef.current.clear();
      setDeniedScreenPeerKeys((prev) => (prev.length === 0 ? prev : []));
      setWantedScreenPeerKeys((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    if (autoScreenBlockedAfterLiveMixStallRef.current) {
      return;
    }
    // While mix-protect restore is pending, do not failover-auto-show another
    // publisher — that burned the one-shot restore during audio recover.
    if (mixProtectScreenAutoRestorePending) {
      return;
    }
    // Prefer is armed + unmute prefs are enough — do NOT wait for live paint.
    // Requiring remoteVideoSources caused: prefer → bump epoch → re-run prefer
    // → cancel applyRequests (120ms) forever (sdp_gate requested=0 loop).
    type ScreenCand = {
      key: string;
      endpoint: string;
      title: string;
      score: number;
      firstSeenAt: number;
      hasGroups: boolean;
      ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
    };
    const now = Date.now();
    const cands: ScreenCand[] = [];
    for (const row of participantsRef.current) {
      if (row.is_self) continue;
      const screen = row.screen_sharing_video_info;
      if (!participantHasScreenPublisher(row) || !screen) continue;
      const endpoint =
        screen.endpoint_id?.trim() ||
        `screen-${row.user_id ?? row.chat_id ?? "x"}`;
      if (mixPausedScreenSet.has(endpoint)) continue;
      if (failedAutoScreenEndpointsRef.current.has(endpoint)) continue;
      const key = voiceParticipantPrefsKey(row);
      if (userDeniedScreenKeysRef.current.has(key)) continue;
      const groups = screen.source_groups ?? [];
      const hasSim = groups.some((g) => g.semantics.toUpperCase() === "SIM");
      const fidCount = groups.filter((g) =>
        g.semantics.toUpperCase() === "FID",
      ).length;
      let firstSeenAt = screenEndpointFirstSeenAtRef.current.get(endpoint);
      if (firstSeenAt == null) {
        firstSeenAt = now;
        screenEndpointFirstSeenAtRef.current.set(endpoint, firstSeenAt);
      }
      const score =
        (hasSim ? 100 : 0) +
        fidCount * 20 +
        groups.length * 10 +
        (screen.endpoint_id?.trim() ? 5 : 0) +
        (row.is_speaking ? 25 : 0) +
        (row.order && row.order.trim() ? 5 : 0);
      cands.push({
        key,
        endpoint,
        title: formatVoiceParticipantTitle(row),
        score,
        firstSeenAt,
        hasGroups: groups.length > 0,
        ssrcGroups: groups.map((g) => ({
          semantics: g.semantics,
          sourceIds: g.source_ids,
        })),
      });
    }
    if (cands.length === 0) return;
    cands.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.hasGroups !== b.hasGroups) return a.hasGroups ? -1 : 1;
      return b.firstSeenAt - a.firstSeenAt;
    });
    // Prefer complete SSRC (SIM+FID). Auto-show every eligible remote screen.
    const eligible = cands.filter((c) => c.hasGroups && c.score >= 100);
    if (eligible.length === 0) {
      const pick = cands[0];
      logPageDisplay("messages_voice_remote_screen_auto_show_wait_ssrc", {
        chatId,
        title: pick.title,
        endpoint: pick.endpoint,
        score: pick.score,
        hasGroups: pick.hasGroups,
        candidates: cands.length,
        level: "info",
        note: "defer auto-show until SIM+FID source_groups are ready",
      });
      return;
    }
    const target = eligible.length;
    const committed = autoScreenCommittedEndpointsRef.current;
    const stillValid = eligible.filter((c) => committed.has(c.endpoint));
    if (stillValid.length >= target) {
      return;
    }
    const toAdd = eligible
      .filter((c) => !committed.has(c.endpoint))
      .slice(0, target - stillValid.length);
    if (toAdd.length === 0) return;

    const nextRequests: Array<{
      endpointId: string;
      kind: "screen";
      ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
    }> = [];
    for (const pick of [...stillValid, ...toAdd].slice(0, target)) {
      explicitScreenWantedKeysRef.current.add(pick.key);
      const existingPrefs =
        participantMediaPrefsRef.current[pick.key] ?? {
          volumePercent: 100,
          muteVideo: true,
          muteScreen: true,
        };
      participantMediaPrefsRef.current = {
        ...participantMediaPrefsRef.current,
        [pick.key]: { ...existingPrefs, muteScreen: false },
      };
      committed.add(pick.endpoint);
      nextRequests.push({
        endpointId: pick.endpoint,
        kind: "screen",
        ssrcGroups: pick.ssrcGroups,
      });
    }
    setWantedScreenPeerKeys([...explicitScreenWantedKeysRef.current]);
    setParticipantMediaPrefs({ ...participantMediaPrefsRef.current });
    const primary = toAdd[0] ?? stillValid[0];
    preferredExplicitScreenEndpointRef.current = primary.endpoint;
    // Arm SDP gate first (telegram-tt arms then setRequestedVideoChannels).
    preferExplicitRemoteVideoSubscribe(primary.endpoint, { autoShow: true });
    const nextSig = nextRequests
      .map(
        (r) =>
          `screen:${r.endpointId}:${r.ssrcGroups
            .map((g) => `${g.semantics}:${g.sourceIds.join(",")}`)
            .join(";")}`,
      )
      .sort()
      .join("|");
    lastGoodRemoteVideoRequestsRef.current = nextRequests;
    lastGoodRemoteVideoAtRef.current = Date.now();
    lastRemoteVideoRequestSigRef.current = nextSig;
    setRemoteVideoRequests(nextRequests);
    for (const pick of toAdd) {
      logPageDisplay("messages_voice_remote_screen_auto_show", {
        chatId,
        title: pick.title,
        endpoint: pick.endpoint,
        score: pick.score,
        hasGroups: pick.hasGroups,
        candidates: cands.length,
        candidateTitles: cands.slice(0, 4).map((c) => c.title),
        subscribed: nextRequests.length,
        level: "info",
        note:
          "instant setRequestedVideoChannels (tt/tgcalls); soft 180p; mix-protect may drop if Opus freezes",
      });
    }
    logPageDisplay("messages_voice_remote_video_requests", {
      chatId,
      count: nextRequests.length,
      kinds: nextRequests.map((r) => r.kind),
      endpoints: nextRequests.map((r) => r.endpointId).slice(0, 4),
      listed: participantsRef.current.length,
      hint: rosterTotalHintRef.current,
      level: "info",
      note: "auto_show_instant_subscribe",
    });
  }, [
    voiceJoined,
    // Roster / publisher identity — NOT remoteVideoRepushEpoch (that is for
    // apply-requests only; including it re-prefer-loops and cancels subscribe).
    remoteVideoSourceKey,
    mixPausedScreenSet,
    mixProtectScreenAutoRestorePending,
    chatId,
    preferExplicitRemoteVideoSubscribe,
    setRemoteVideoRequests,
  ]);

  useEffect(() => {
    if (!voiceJoined || Platform.OS !== "web") {
      lastGoodRemoteVideoRequestsRef.current = [];
      lastGoodRemoteVideoAtRef.current = 0;
      lastRemoteVideoRequestSigRef.current = "";
      explicitScreenWantedKeysRef.current.clear();
      failedAutoScreenEndpointsRef.current.clear();
      autoScreenBlockedAfterLiveMixStallRef.current = false;
      screenEndpointFirstSeenAtRef.current.clear();
      preferredExplicitScreenEndpointRef.current = null;
      autoScreenCommittedEndpointsRef.current.clear();
      setWantedScreenPeerKeys((prev) => (prev.length === 0 ? prev : []));
      setRemoteVideoRequests([]);
      return;
    }
    // Session cleared video (mix stall) or armed unmute with empty pending —
    // force re-apply even when roster video signatures did not change.
    if (remoteVideoRepushEpoch > 0) {
      lastRemoteVideoRequestSigRef.current = "";
    }
    let cancelled = false;
    let stickyExpireTimer: number | null = null;
    const hasVideoPublishers = participantsRef.current.some(
      (row) =>
        !row.is_self &&
        (participantHasScreenPublisher(row) ||
          Boolean(
            row.video_info?.endpoint_id?.trim() ||
              (row.video_info?.source_groups?.length ?? 0) > 0,
          )),
    );
    const applyRequests = () => {
      if (cancelled) return;
      const requests: Array<{
        endpointId: string;
        kind: "camera" | "screen";
        ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
      }> = [];
      const pendingGroups: Array<{
        user: string;
        kind: "camera" | "screen";
        endpoint: string;
      }> = [];
      for (const row of participantsRef.current) {
        if (row.is_self) continue;
        const prefs = participantMediaPrefsRef.current[voiceParticipantPrefsKey(row)];
        const screen = row.screen_sharing_video_info;
        const camera = row.video_info;
        const screenEndpoint =
          screen?.endpoint_id?.trim() ||
          (screen?.source_groups?.length
            ? `screen-${row.user_id ?? row.chat_id ?? "x"}`
            : "");
        const prefsKey = voiceParticipantPrefsKey(row);
        // Opt-in / auto-show: screenAllowed requires this session key (menu unmute
        // or join-time auto-show). Cameras stay menu-only.
        const screenAllowed =
          prefs != null &&
          prefs.muteScreen === false &&
          explicitScreenWantedKeysRef.current.has(prefsKey) &&
          !(screenEndpoint && mixPausedScreenSet.has(screenEndpoint));
        const cameraAllowed =
          prefs != null &&
          prefs.muteVideo === false &&
          explicitScreenWantedKeysRef.current.has(`cam:${prefsKey}`);
        if (screen?.source_groups?.length && screenAllowed) {
          requests.push({
            endpointId: screen.endpoint_id || `screen-${row.user_id ?? row.chat_id ?? "x"}`,
            kind: "screen",
            ssrcGroups: screen.source_groups.map((g) => ({
              semantics: g.semantics,
              sourceIds: g.source_ids,
            })),
          });
        } else if (screen?.endpoint_id?.trim() && screenAllowed) {
          pendingGroups.push({
            user: formatVoiceParticipantTitle(row),
            kind: "screen",
            endpoint: screen.endpoint_id,
          });
        }
        if (camera?.source_groups?.length && cameraAllowed) {
          requests.push({
            endpointId: camera.endpoint_id || `cam-${row.user_id ?? row.chat_id ?? "x"}`,
            kind: "camera",
            ssrcGroups: camera.source_groups.map((g) => ({
              semantics: g.semantics,
              sourceIds: g.source_ids,
            })),
          });
        } else if (camera?.endpoint_id?.trim() && cameraAllowed) {
          pendingGroups.push({
            user: formatVoiceParticipantTitle(row),
            kind: "camera",
            endpoint: camera.endpoint_id,
          });
        }
      }
      // Prefer complete SIM+FID groups. Multi FID-only (Nekit-style groups:1)
      // used to stall mix audio — never subscribe more than one incomplete.
      const scoreSsrcGroups = (
        groups: Array<{ semantics: string; sourceIds: number[] }>,
      ): number => {
        const hasSim = groups.some((g) => g.semantics.toUpperCase() === "SIM");
        const fidCount = groups.filter(
          (g) => g.semantics.toUpperCase() === "FID",
        ).length;
        return (hasSim ? 100 : 0) + fidCount * 20 + groups.length * 10;
      };
      const COMPLETE_SSRC_MIN = 100; // requires SIM
      // Screens only when any share is live; camera only when nobody is sharing.
      const hasScreenRequest = requests.some((r) => r.kind === "screen");
      const MAX_REMOTE_VIDEOS = hasScreenRequest ? Number.POSITIVE_INFINITY : 1;
      const sortVideoRequests = (
        list: typeof requests,
      ): typeof requests =>
        [...list].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "screen" ? -1 : 1;
          return scoreSsrcGroups(b.ssrcGroups) - scoreSsrcGroups(a.ssrcGroups);
        });
      const pool = hasScreenRequest
        ? requests.filter((r) => r.kind === "screen")
        : requests;
      const completeRequests = sortVideoRequests(
        pool.filter(
          (r) => scoreSsrcGroups(r.ssrcGroups) >= COMPLETE_SSRC_MIN,
        ),
      );
      const incompleteRequests = sortVideoRequests(
        pool.filter(
          (r) => scoreSsrcGroups(r.ssrcGroups) < COMPLETE_SSRC_MIN,
        ),
      );
      // Build subscribe set. Bug: when a 2nd FID-only share appeared,
      // `requests.length === 1` gate cleared *all* incomplete → first tile
      // vanished then stage went empty. Keep sticky incomplete; prefer SIM.
      const lastGood = lastGoodRemoteVideoRequestsRef.current;
      const lastGoodIds = new Set(lastGood.map((r) => r.endpointId));
      const next: typeof requests = [];
      const picked = new Set<string>();
      const take = (row: (typeof requests)[number]) => {
        if (picked.has(row.endpointId) || next.length >= MAX_REMOTE_VIDEOS) {
          return;
        }
        picked.add(row.endpointId);
        next.push(row);
      };
      if (completeRequests.length > 0) {
        // Prefer the endpoint the user just unmuted.
        const preferredEndpoint =
          preferredExplicitScreenEndpointRef.current?.trim() || "";
        if (preferredEndpoint) {
          const preferred = completeRequests.find(
            (r) => r.endpointId === preferredEndpoint,
          );
          if (preferred) {
            take(preferred);
            preferredExplicitScreenEndpointRef.current = null;
          }
        }
        // SIM publishers only — mixing FID-only with SIM stalled mix audio.
        for (const prev of lastGood) {
          const match = completeRequests.find(
            (r) => r.endpointId === prev.endpointId,
          );
          if (match) take(match);
        }
        for (const row of completeRequests) take(row);
      } else {
        // No SIM: keep the live incomplete tile (sticky), else best screen.
        const preferredEndpoint =
          preferredExplicitScreenEndpointRef.current?.trim() || "";
        if (preferredEndpoint) {
          const preferred = incompleteRequests.find(
            (r) => r.endpointId === preferredEndpoint,
          );
          if (preferred) {
            take(preferred);
            preferredExplicitScreenEndpointRef.current = null;
          }
        }
        for (const prev of lastGood) {
          const match = incompleteRequests.find(
            (r) => r.endpointId === prev.endpointId,
          );
          if (match) {
            take(match);
            break;
          }
        }
        if (next.length === 0) {
          const sticky = incompleteRequests.find((r) =>
            lastGoodIds.has(r.endpointId),
          );
          if (sticky) take(sticky);
          else if (incompleteRequests[0]) take(incompleteRequests[0]);
        }
      }
      const SOFT_VIDEO_STICKY_MS = 5_000;
      // Sticky only while the user explicitly opted into a screen/camera.
      const wantsVideoSubscribe = participantsRef.current.some((row) => {
        if (row.is_self) return false;
        const prefsKey = voiceParticipantPrefsKey(row);
        if (!explicitScreenWantedKeysRef.current.has(prefsKey)) return false;
        const prefs = participantMediaPrefsRef.current[prefsKey];
        const sharing = Boolean(
          row.screen_sharing_video_info?.endpoint_id?.trim() ||
            row.video_info?.endpoint_id?.trim(),
        );
        if (!sharing) return false;
        if (prefs == null) return false;
        const screenEndpoint =
          row.screen_sharing_video_info?.endpoint_id?.trim() || "";
        const screenOn = Boolean(screenEndpoint)
          ? prefs.muteScreen === false && !mixPausedScreenSet.has(screenEndpoint)
          : false;
        const camOn = Boolean(row.video_info?.endpoint_id?.trim())
          ? prefs.muteVideo === false
          : false;
        return screenOn || camOn;
      });
      if (
        next.length === 0 &&
        wantsVideoSubscribe &&
        lastGoodRemoteVideoRequestsRef.current.length > 0
      ) {
        // Drop sticky keep for mix-paused endpoints — otherwise we re-request
        // a screen the session just cleared to protect audio.
        const stickyAlive = lastGoodRemoteVideoRequestsRef.current.filter(
          (r) => !(r.kind === "screen" && mixPausedScreenSet.has(r.endpointId)),
        );
        if (stickyAlive.length === 0) {
          lastGoodRemoteVideoRequestsRef.current = [];
          lastGoodRemoteVideoAtRef.current = 0;
        } else if (stickyAlive.length !== lastGoodRemoteVideoRequestsRef.current.length) {
          lastGoodRemoteVideoRequestsRef.current = stickyAlive;
        }
        const stillHasVideoEndpoint = participantsRef.current.some(
          (row) =>
            !row.is_self &&
            Boolean(
              row.screen_sharing_video_info?.endpoint_id?.trim() ||
                row.video_info?.endpoint_id?.trim(),
            ),
        );
        const stickyAgeMs = Date.now() - lastGoodRemoteVideoAtRef.current;
        if (
          (stillHasVideoEndpoint || pendingGroups.length > 0) &&
          stickyAgeMs < SOFT_VIDEO_STICKY_MS
        ) {
          logPageDisplay("messages_voice_remote_video_requests", {
            chatId,
            count: lastGoodRemoteVideoRequestsRef.current.length,
            kinds: lastGoodRemoteVideoRequestsRef.current.map((r) => r.kind),
            endpoints: lastGoodRemoteVideoRequestsRef.current
              .map((r) => r.endpointId)
              .slice(0, 4),
            pendingGroups: pendingGroups.slice(0, 4),
            listed: participantsRef.current.length,
            hint: rosterTotalHintRef.current,
            stickyAgeMs,
            level: "warn",
            note: "sticky keep last good video requests — soft roster missing source_groups",
          });
          if (stickyExpireTimer != null) window.clearTimeout(stickyExpireTimer);
          stickyExpireTimer = window.setTimeout(() => {
            stickyExpireTimer = null;
            if (!cancelled) applyRequests();
          }, Math.max(50, SOFT_VIDEO_STICKY_MS - stickyAgeMs + 50));
          return;
        }
      }
      if (stickyExpireTimer != null) {
        window.clearTimeout(stickyExpireTimer);
        stickyExpireTimer = null;
      }
      if (next.length > 0) {
        lastGoodRemoteVideoRequestsRef.current = next;
        lastGoodRemoteVideoAtRef.current = Date.now();
      } else if (!wantsVideoSubscribe) {
        // Publishers gone / user muted — drop sticky. Soft roster blanks must
        // not wipe lastGood or the 2nd-share transition clears both tiles.
        lastGoodRemoteVideoRequestsRef.current = [];
      }
      const nextSig = next
        .map(
          (r) =>
            `${r.kind}:${r.endpointId}:${r.ssrcGroups
              .map((g) => `${g.semantics}:${g.sourceIds.join(",")}`)
              .join(";")}`,
        )
        .sort()
        .join("|");
      if (nextSig === lastRemoteVideoRequestSigRef.current) {
        return;
      }
      lastRemoteVideoRequestSigRef.current = nextSig;
      setRemoteVideoRequests(next);
      logPageDisplay("messages_voice_remote_video_requests", {
        chatId,
        count: next.length,
        kinds: next.map((r) => r.kind),
        endpoints: next.map((r) => r.endpointId).slice(0, 4),
        pendingGroups: pendingGroups.slice(0, 4),
        listed: participantsRef.current.length,
        hint: rosterTotalHintRef.current,
        level: next.length > 0 ? "info" : "warn",
        note:
          next.length > 0
            ? hasScreenRequest
              ? "explicit_video_screen_only"
              : pendingGroups.length > 0 ||
                  requests.length > next.length ||
                  incompleteRequests.length > 0
                ? "explicit_video_complete_ssrc"
                : "explicit_video_subscribe"
            : requests.length > 0
              ? "skipped_incomplete_ssrc_video — audio-first"
              : participantsRef.current.some(
                    (row) =>
                      !row.is_self &&
                      Boolean(
                        row.screen_sharing_video_info?.endpoint_id ||
                          row.video_info?.endpoint_id,
                      ),
                  )
                ? "video_publishers_present_but_not_subscribed"
                : "no video source_groups on roster — force-reload may still be pending",
      });
    };
    // Faster first paint when a share is already on the roster (was 600/2200ms).
    const timer = window.setTimeout(applyRequests, hasVideoPublishers ? 120 : 2_500);
    const retry = window.setTimeout(applyRequests, hasVideoPublishers ? 900 : 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(retry);
      if (stickyExpireTimer != null) window.clearTimeout(stickyExpireTimer);
    };
  }, [chatId, mixPausedScreenSet, remoteVideoRepushEpoch, remoteVideoSourceKey, setRemoteVideoRequests, voiceJoined]);

  const displayParticipants = useMemo(() => {
    return participants.map((row) => {
      // Prefer gated speaking map — never OR raw TDLib is_speaking after join
      // (that painted Сева green while the mix was silent / recovering).
      const speaking = Boolean(rowSpeakKeys(row).some((k) => speakingByKey[k]));
      const speakingFallback =
        !voiceJoinedRef.current && Boolean(row.is_speaking);
      const nextSpeaking = speaking || speakingFallback;
      return nextSpeaking === Boolean(row.is_speaking)
        ? row
        : { ...row, is_speaking: nextSpeaking };
    });
  }, [participants, rowSpeakKeys, speakingByKey]);

  const resolveParticipantSpeaking = useCallback(
    (row: TelegramChatVoiceParticipant) => {
      const prefs = participantMediaPrefs[voiceParticipantPrefsKey(row)];
      const volume =
        prefs?.volumePercent ??
        (typeof row.volume_percent === "number" ? row.volume_percent : 100);
      if (volume <= 0) return false;
      // Side map is gated on hearable mix / holds. Do not fall back to raw
      // TDLib is_speaking while WebRTC mix is silent — that painted unmuted
      // speakers as live when Opus was frozen.
      if (rowSpeakKeys(row).some((k) => speakingByKey[k])) return true;
      if (!voiceJoinedRef.current) return Boolean(row.is_speaking);
      return false;
    },
    [participantMediaPrefs, rowSpeakKeys, speakingByKey],
  );

  const ensureParticipantPrefs = useCallback(
    (participant: TelegramChatVoiceParticipant) => {
      const key = voiceParticipantPrefsKey(participant);
      const existing = participantMediaPrefsRef.current[key];
      if (existing) return { key, prefs: existing };
      const tdlibVolume =
        typeof participant.volume_percent === "number" ? participant.volume_percent : 100;
      const stored = readStoredVoicePeerMediaPrefs(voicePrefsAccountId, key);
      const fromStore = storedPrefsToSessionPrefs(stored, tdlibVolume);
      // Colibri: do NOT auto-subscribe — default muteScreen/muteVideo=true until
      // the user unmutes from the participant menu (opens video SDP intentionally).
      if (fromStore) {
        if (fromStore.volumePercent > 0) {
          lastNonZeroVolumeRef.current[key] = fromStore.volumePercent;
        } else if (
          typeof stored?.volumePercent === "number" &&
          stored.volumePercent > 0
        ) {
          lastNonZeroVolumeRef.current[key] = stored.volumePercent;
        }
        return {
          key,
          prefs: {
            volumePercent: fromStore.volumePercent,
            muteVideo: true,
            // Never inherit stored unmute as auto-subscribe — that froze mix.
            muteScreen: true,
          },
        };
      }
      // Stale TDLib muted-for-me (0%) without an intentional mute → treat as 100%.
      const volumePercent =
        tdlibVolume <= 0 && !isIntentionalVoiceMute(voicePrefsAccountId, key)
          ? 100
          : tdlibVolume;
      if (volumePercent > 0) lastNonZeroVolumeRef.current[key] = volumePercent;
      // Opt-in screen/camera — participant menu unmute opens video SDP.
      const prefs = { volumePercent, muteVideo: true, muteScreen: true };
      return { key, prefs };
    },
    [voicePrefsAccountId],
  );

  const onParticipantVolumeChange = useCallback(
    (participant: TelegramChatVoiceParticipant, volumePercent: number) => {
      const { key, prefs } = ensureParticipantPrefs(participant);
      const nextPercent = Math.min(200, Math.max(0, Math.round(volumePercent)));
      if (nextPercent > 0) lastNonZeroVolumeRef.current[key] = nextPercent;
      // Persist intentional muted-for-me at account scope; clear on unmute.
      if (nextPercent <= 0) {
        patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
          voiceMuted: true,
          volumePercent: lastNonZeroVolumeRef.current[key] ?? 100,
        });
      } else {
        patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
          voiceMuted: false,
          volumePercent: nextPercent,
        });
      }
      setParticipantMediaPrefs((prev) => ({
        ...prev,
        [key]: { ...prefs, ...prev[key], volumePercent: nextPercent },
      }));
      // Debounce TDLib writes — slider fires every tick; local gain updates immediately
      // via the participantMediaPrefs → setParticipantListenVolumes effect.
      if (volumeApiTimerRef.current != null) {
        window.clearTimeout(volumeApiTimerRef.current);
      }
      volumeApiTimerRef.current = window.setTimeout(() => {
        volumeApiTimerRef.current = null;
        void setTelegramChatVoiceParticipantVolume({
          chatId,
          groupCallId,
          userId: participant.user_id,
          peerChatId: participant.chat_id,
          volumePercent: nextPercent,
        }).then((result) => {
          if (!result.ok) {
            appWarn("[voice-participant-volume]", result.error, {
              chatId,
              groupCallId,
              userId: participant.user_id,
            });
            return;
          }
          setParticipantMediaPrefs((prev) => ({
            ...prev,
            [key]: {
              ...(prev[key] ?? prefs),
              volumePercent: result.volume_percent,
            },
          }));
          if (result.volume_percent > 0) {
            lastNonZeroVolumeRef.current[key] = result.volume_percent;
            patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
              voiceMuted: false,
              volumePercent: result.volume_percent,
            });
          } else {
            patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
              voiceMuted: true,
            });
          }
        });
      }, 120);
    },
    [chatId, ensureParticipantPrefs, groupCallId, voicePrefsAccountId],
  );

  const onParticipantToggleMuteVoice = useCallback(
    (participant: TelegramChatVoiceParticipant) => {
      const { key, prefs } = ensureParticipantPrefs(participant);
      const current =
        participantMediaPrefsRef.current[key]?.volumePercent ?? prefs.volumePercent;
      const stored = readStoredVoicePeerMediaPrefs(voicePrefsAccountId, key);
      const restore =
        lastNonZeroVolumeRef.current[key] ||
        (typeof stored?.volumePercent === "number" && stored.volumePercent > 0
          ? stored.volumePercent
          : 100);
      const next = current > 0 ? 0 : restore;
      onParticipantVolumeChange(participant, next);
    },
    [ensureParticipantPrefs, onParticipantVolumeChange, voicePrefsAccountId],
  );

  const onParticipantToggleMuteVideo = useCallback(
    (participant: TelegramChatVoiceParticipant) => {
      const { key, prefs } = ensureParticipantPrefs(participant);
      const cur = participantMediaPrefsRef.current[key] ?? prefs;
      const nextMute = !cur.muteVideo;
      if (nextMute) {
        explicitScreenWantedKeysRef.current.delete(`cam:${key}`);
      } else {
        explicitScreenWantedKeysRef.current.add(`cam:${key}`);
      }
      patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
        muteVideo: nextMute,
      });
      setParticipantMediaPrefs((prev) => {
        const existing = prev[key] ?? prefs;
        return { ...prev, [key]: { ...existing, muteVideo: nextMute } };
      });
      if (!nextMute) {
        voiceSession.preferExplicitRemoteVideoSubscribe(
          participant.video_info?.endpoint_id?.trim() || null,
        );
      }
    },
    [ensureParticipantPrefs, voicePrefsAccountId, voiceSession],
  );

  const onParticipantToggleMuteScreen = useCallback(
    (participant: TelegramChatVoiceParticipant) => {
      const { key, prefs } = ensureParticipantPrefs(participant);
      const cur = participantMediaPrefsRef.current[key] ?? prefs;
      const endpoint =
        participant.screen_sharing_video_info?.endpoint_id?.trim() || null;
      const pausedForMix = Boolean(
        endpoint && voiceSession.mixPausedScreenEndpoints.includes(endpoint),
      );
      const optedIn = explicitScreenWantedKeysRef.current.has(key);
      // Default (not opted in) must count as muted — otherwise the first menu
      // tap denied the share while the UI already looked "on", and video never
      // subscribed (prod: auto_show_skip + muteScreen chrome mismatch).
      const effectivelyMuted =
        userDeniedScreenKeysRef.current.has(key) ||
        pausedForMix ||
        !optedIn ||
        cur.muteScreen !== false;
      const nextMute = !effectivelyMuted;
      if (nextMute) {
        explicitScreenWantedKeysRef.current.delete(key);
        userDeniedScreenKeysRef.current.add(key);
      } else {
        userDeniedScreenKeysRef.current.delete(key);
        explicitScreenWantedKeysRef.current.add(key);
        // Manual unmute retries even after mix-protect marked the endpoint failed.
        if (endpoint) failedAutoScreenEndpointsRef.current.delete(endpoint);
        autoScreenBlockedAfterLiveMixStallRef.current = false;
      }
      setDeniedScreenPeerKeys([...userDeniedScreenKeysRef.current]);
      setWantedScreenPeerKeys([...explicitScreenWantedKeysRef.current]);
      patchStoredVoicePeerMediaPrefs(voicePrefsAccountId, key, {
        muteScreen: nextMute,
      });
      const nextPrefs = {
        ...(participantMediaPrefsRef.current[key] ?? prefs),
        muteScreen: nextMute,
      };
      participantMediaPrefsRef.current = {
        ...participantMediaPrefsRef.current,
        [key]: nextPrefs,
      };
      setParticipantMediaPrefs((prev) => {
        const existing = prev[key] ?? prefs;
        return { ...prev, [key]: { ...existing, muteScreen: nextMute } };
      });
      // Unmute must arm video SDP even when mix RMS is quiet; pass endpoint so
      // additional shares merge into the subscribe set.
      // telegram-tt: setRequestedVideoChannels in the same turn (not await
      // remoteVideoRepushEpoch / delayed apply).
      if (!nextMute && endpoint) {
        preferredExplicitScreenEndpointRef.current = endpoint;
        autoScreenCommittedEndpointsRef.current.add(endpoint);
        voiceSession.preferExplicitRemoteVideoSubscribe(endpoint);
        const groups = participant.screen_sharing_video_info?.source_groups;
        if (groups && groups.length > 0) {
          const request = {
            endpointId: endpoint,
            kind: "screen" as const,
            ssrcGroups: groups.map((g) => ({
              semantics: g.semantics,
              sourceIds: g.source_ids,
            })),
          };
          const merged = [
            request,
            ...lastGoodRemoteVideoRequestsRef.current.filter(
              (r) => r.endpointId !== endpoint && r.kind === "screen",
            ),
          ];
          const nextSig = merged
            .map(
              (r) =>
                `screen:${r.endpointId}:${r.ssrcGroups
                  .map((g) => `${g.semantics}:${g.sourceIds.join(",")}`)
                  .join(";")}`,
            )
            .sort()
            .join("|");
          lastGoodRemoteVideoRequestsRef.current = merged;
          lastGoodRemoteVideoAtRef.current = Date.now();
          lastRemoteVideoRequestSigRef.current = nextSig;
          setRemoteVideoRequests(merged);
          logPageDisplay("messages_voice_remote_video_requests", {
            chatId,
            count: merged.length,
            kinds: merged.map((r) => r.kind),
            endpoints: merged.map((r) => r.endpointId),
            level: "info",
            note: "menu_unmute_instant_subscribe",
          });
        }
      } else if (!nextMute) {
        preferredExplicitScreenEndpointRef.current = endpoint;
        voiceSession.preferExplicitRemoteVideoSubscribe(endpoint);
      } else if (
        nextMute &&
        endpoint &&
        autoScreenCommittedEndpointsRef.current.has(endpoint)
      ) {
        autoScreenCommittedEndpointsRef.current.delete(endpoint);
      }
    },
    [
      chatId,
      ensureParticipantPrefs,
      setRemoteVideoRequests,
      voicePrefsAccountId,
      voiceSession,
    ],
  );

  // Hydrate account-persisted mute / stream prefs into session state so roster
  // icons (red mic, crossed screen) match before WebRTC join.
  useEffect(() => {
    if (participants.length === 0) return;
    setParticipantMediaPrefs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const row of participants) {
        if (row.is_self) continue;
        const key = voiceParticipantPrefsKey(row);
        if (next[key]) continue;
        const { prefs } = ensureParticipantPrefs(row);
        next[key] = prefs;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [participants, ensureParticipantPrefs]);

  // Auto-show first live remote screencast (opt-in keys + muteScreen=false).
  // Mix-protect may still drop video if Colibri freezes Opus; user can unmute.

  // Push local listen volumes into the WebRTC mix GainNode. TDLib volume_level
  // also gates SFU mix contribution — volume_level=1 (0%) mutes that peer for
  // you server-side. On join: unmute everyone unless this account intentionally
  // muted them (persisted + red mic); stale TDLib 0% without that mark is repaired.
  useEffect(() => {
    if (!voiceJoined || Platform.OS !== "web") return;
    const volumes: Record<string, number> = {};
    const participantKeys: string[] = [];
    const speakingKeys: string[] = [];
    const repairRows: TelegramChatVoiceParticipant[] = [];
    const intentionalMuteRows: TelegramChatVoiceParticipant[] = [];
    for (const row of participants) {
      if (row.is_self) continue;
      const key = voiceParticipantPrefsKey(row);
      participantKeys.push(key);
      const prefs = participantMediaPrefs[key];
      const intentionalMute = isIntentionalVoiceMute(voicePrefsAccountId, key);
      const hasLocalVolumePref = prefs?.volumePercent != null;
      let volumePercent =
        prefs?.volumePercent ??
        (typeof row.volume_percent === "number" ? row.volume_percent : 100);

      if (intentionalMute) {
        // Keep muted-for-me; paint red mic and ensure SFU stays at 0.
        volumePercent = 0;
        if (!hasLocalVolumePref || (prefs?.volumePercent ?? 1) > 0) {
          intentionalMuteRows.push(row);
        } else if (
          typeof row.volume_percent === "number" &&
          row.volume_percent > 0
        ) {
          intentionalMuteRows.push(row);
        }
      } else if (volumePercent <= 0) {
        // Stale SFU muted-for-me without an intentional mute — hear them.
        volumePercent = 100;
        repairRows.push(row);
      } else if (
        typeof row.volume_percent === "number" &&
        row.volume_percent <= 0 &&
        volumePercent > 0
      ) {
        // Hydrated session prefs already 100% but TDLib/SFU still at 0.
        repairRows.push(row);
      }

      volumes[key] = volumePercent;
      const peerSpeaking = Boolean(
        !row.is_muted && rowSpeakKeys(row).some((k) => speakingByKey[k]),
      );
      if (peerSpeaking) speakingKeys.push(key);
    }
    if (intentionalMuteRows.length > 0) {
      logPageDisplay("messages_voice_listen_volume_intentional_mute", {
        chatId,
        count: intentionalMuteRows.length,
        titles: intentionalMuteRows.map((r) => r.title || "?").slice(0, 4),
        level: "info",
        note: "account-persisted muted-for-me — keep 0% and show unmute in menu",
      });
      setParticipantMediaPrefs((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const row of intentionalMuteRows) {
          const key = voiceParticipantPrefsKey(row);
          const stored = readStoredVoicePeerMediaPrefs(voicePrefsAccountId, key);
          if (
            typeof stored?.volumePercent === "number" &&
            stored.volumePercent > 0
          ) {
            lastNonZeroVolumeRef.current[key] = stored.volumePercent;
          }
          const base = next[key] ?? {
            volumePercent: 0,
            muteVideo: stored?.muteVideo === true,
            muteScreen: stored?.muteScreen === true,
          };
          if (base.volumePercent !== 0) {
            next[key] = { ...base, volumePercent: 0 };
            changed = true;
          } else if (!next[key]) {
            next[key] = base;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      for (const row of intentionalMuteRows) {
        const key = voiceParticipantPrefsKey(row);
        if (intentionalMuteReapplyAttemptedRef.current.has(key)) continue;
        intentionalMuteReapplyAttemptedRef.current.add(key);
        void setTelegramChatVoiceParticipantVolume({
          chatId,
          groupCallId,
          userId: row.user_id,
          peerChatId: row.chat_id,
          volumePercent: 0,
        }).then((result) => {
          if (!result.ok) {
            appWarn("[voice-participant-volume-intentional-mute]", result.error, {
              chatId,
              groupCallId,
              userId: row.user_id,
              title: row.title,
            });
            intentionalMuteReapplyAttemptedRef.current.delete(key);
            return;
          }
          logPageDisplay("messages_voice_listen_volume_sfu_muted", {
            chatId,
            groupCallId,
            userId: row.user_id,
            title: row.title,
            volume_percent: result.volume_percent,
            level: "info",
            note: "setGroupCallParticipantVolumeLevel 0% for intentional muted-for-me",
          });
        });
      }
    }
    if (repairRows.length > 0) {
      logPageDisplay("messages_voice_listen_volume_repaired", {
        chatId,
        repaired: repairRows.length,
        titles: repairRows.map((r) => r.title || "?").slice(0, 4),
        level: "warn",
        note: "remote volume_percent=0 without intentional mute — restored to 100%",
      });
      setParticipantMediaPrefs((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const row of repairRows) {
          const key = voiceParticipantPrefsKey(row);
          if (isIntentionalVoiceMute(voicePrefsAccountId, key)) continue;
          const base = next[key] ?? {
            volumePercent: 100,
            muteVideo: true,
            muteScreen: true,
          };
          if ((base.volumePercent ?? 0) <= 0 || !next[key]) {
            next[key] = { ...base, volumePercent: 100 };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      for (const row of repairRows) {
        const key = voiceParticipantPrefsKey(row);
        if (isIntentionalVoiceMute(voicePrefsAccountId, key)) continue;
        if (volumeZeroRepairAttemptedRef.current.has(key)) continue;
        volumeZeroRepairAttemptedRef.current.add(key);
        lastNonZeroVolumeRef.current[key] = 100;
        void setTelegramChatVoiceParticipantVolume({
          chatId,
          groupCallId,
          userId: row.user_id,
          peerChatId: row.chat_id,
          volumePercent: 100,
        }).then((result) => {
          if (!result.ok) {
            appWarn("[voice-participant-volume-repair]", result.error, {
              chatId,
              groupCallId,
              userId: row.user_id,
              title: row.title,
            });
            volumeZeroRepairAttemptedRef.current.delete(key);
            return;
          }
          logPageDisplay("messages_voice_listen_volume_sfu_restored", {
            chatId,
            groupCallId,
            userId: row.user_id,
            title: row.title,
            volume_percent: result.volume_percent,
            level: "info",
            note: "setGroupCallParticipantVolumeLevel 100% after muted-for-me default",
          });
        });
      }
    }
    // Proactive SFU listen-volume nudge: roster can show unmuted @ 100% while
    // the SFU never got setGroupCallParticipantVolumeLevel for this client
    // (prod: hear some peers, silence for others e.g. Зоро). Once per peer/join.
    if (groupCallId != null && groupCallId > 0) {
      for (const row of participants) {
        if (row.is_self || row.is_muted) continue;
        if (
          row.user_id != null &&
          tdlibSelfUserIdRef.current != null &&
          row.user_id === tdlibSelfUserIdRef.current
        ) {
          continue;
        }
        const key = voiceParticipantPrefsKey(row);
        if (listenVolumeNudgeAttemptedRef.current.has(key)) continue;
        if (isIntentionalVoiceMute(voicePrefsAccountId, key)) continue;
        const prefs = participantMediaPrefs[key];
        if (prefs?.volumePercent != null && prefs.volumePercent <= 0) continue;
        const volumePercent =
          prefs?.volumePercent ??
          (typeof row.volume_percent === "number" && row.volume_percent > 0
            ? row.volume_percent
            : 100);
        if (volumePercent <= 0) continue;
        listenVolumeNudgeAttemptedRef.current.add(key);
        void setTelegramChatVoiceParticipantVolume({
          chatId,
          groupCallId,
          userId: row.user_id,
          peerChatId: row.chat_id,
          volumePercent: Math.max(100, volumePercent),
        }).then((result) => {
          if (!result.ok) {
            const errText =
              typeof result.error === "string" ? result.error : String(result.error ?? "");
            if (/Can't change self volume/i.test(errText)) {
              // Optimistic self row can use a different identity than TDLib's
              // account (display name vs linked user) — never retry this peer.
              if (row.user_id != null) {
                tdlibSelfUserIdRef.current = row.user_id;
              }
              logPageDisplay("messages_voice_listen_volume_self_skip", {
                chatId,
                groupCallId,
                userId: row.user_id,
                title: row.title,
                level: "info",
                note: "TDLib self — skip SFU volume nudge",
              });
              setParticipants((prev) => {
                const uid = row.user_id;
                if (uid == null) return prev;
                let changed = false;
                const next = prev.flatMap((p) => {
                  if (p.user_id === uid) {
                    if (p.is_self) return [p];
                    changed = true;
                    // Keep TDLib title — never copy Hyperlinks displayName
                    // (Сева) onto the real Telegram self (Vsevolod).
                    return [{ ...p, is_self: true }];
                  }
                  if (p.is_self && p.user_id !== uid) {
                    changed = true;
                    return [];
                  }
                  return [p];
                });
                return changed ? next : prev;
              });
              return;
            }
            // Missing / left participants and other non-retryable TDLib errors
            // must keep the key so we do not storm POST …/voice-participant-volume
            // (prod: 502 "Can't find group call participant" starved text I/O).
            // Transient gateway/proxy 502 without a TDLib reason must retry —
            // otherwise a peer who joins mid-call stays silent in the SFU mix.
            const nonRetryable =
              /Can't find group call participant/i.test(errText) ||
              /PARTICIPANT_ID_INVALID/i.test(errText) ||
              /USER_NOT_PARTICIPANT/i.test(errText) ||
              /GROUPCALL_INVALID/i.test(errText);
            const transientGateway =
              !nonRetryable &&
              (/bad gateway/i.test(errText) ||
                /\b502\b/.test(errText) ||
                /ECONNRESET|ETIMEDOUT|fetch failed/i.test(errText));
            appWarn("[voice-participant-volume-nudge]", result.error, {
              chatId,
              groupCallId,
              userId: row.user_id,
              title: row.title,
              nonRetryable,
              transientGateway,
            });
            if (!nonRetryable) {
              listenVolumeNudgeAttemptedRef.current.delete(key);
            }
            return;
          }
          logPageDisplay("messages_voice_listen_volume_sfu_nudged", {
            chatId,
            groupCallId,
            userId: row.user_id,
            title: row.title,
            volume_percent: result.volume_percent,
            level: "info",
            note: "setGroupCallParticipantVolumeLevel after join for unmuted remote",
          });
        });
      }
    }
    setParticipantListenVolumes({
      volumes,
      speakingKeys,
      participantKeys,
    });
  }, [
    voiceJoined,
    participants,
    participantMediaPrefs,
    speakingByKey,
    rowSpeakKeys,
    setParticipantListenVolumes,
    chatId,
    groupCallId,
    voicePrefsAccountId,
  ]);

  // Opening the sheet: paint first, then load roster. Do NOT wait for WebRTC
  // `joined` — that delayed the first reload until after SDP and left the sheet
  // on a single grey row while speaking updates had nobody to light up.
  const applyRosterRowsRef = useRef(applyRosterRows);
  applyRosterRowsRef.current = applyRosterRows;

  const rosterIncomplete = useCallback(() => {
    // Endpoint without source_groups cannot request SFU video — keep forcing
    // even after listed===hint (soft roster often omits groups).
    if (participantsRef.current.some(participantNeedsVideoForceReload)) return true;
    if (postJoinRosterLoadedRef.current) return false;
    const listed = participantsRef.current.length;
    const hint = rosterTotalHintRef.current;
    // Soft polls only return recent_speakers (typically ≤3). Treating
    // listed>=2 as "done" left listed=3 hint=9 forever (no force after join).
    // Post-join effect still waits ~2s after webrtc_join_ok before force HTTP.
    if (listed <= 1) return true;
    // Any gap vs TDLib means the roster is incomplete — listed=5 hint=6 used
    // to skip force-reload and hide the screencaster (no video_info rows).
    if (hint > listed) return true;
    // Any untitled non-self row (blank / invisible) needs another force pass.
    if (
      participantsRef.current.some(
        (row) => !row.is_self && isEffectivelyBlankDisplayName(row.title),
      )
    ) {
      return true;
    }
    return false;
  }, []);

  const reloadVoiceRoster = useCallback(
    async (options?: { force?: boolean; cancelled?: () => boolean }) => {
      const requestChatId = chatId;
      // Prefer the live call id the strip is bound to — null used getChat alone
      // and could race a stale preferred id on the gateway.
      const result = await fetchTelegramChatVoiceParticipants(
        requestChatId,
        groupCallId,
        {
          forceReload: Boolean(options?.force),
        },
      );
      if (chatIdRef.current !== requestChatId) {
        return { ok: false as const, error: "chat_switched" };
      }
      if (options?.cancelled?.() || !result.ok) return result;
      if (result.has_hidden_listeners) {
        hasHiddenListenersRef.current = true;
      }
      applyRosterRowsRef.current(result.participants, result.participant_count);
      if (result.ok) {
        syncVoicePresence(
          requestChatId,
          result.has_active_voice_chat,
          result.voice_chat_group_call_id,
          result.participants,
          result.participant_count,
          { allowClear: Boolean(options?.force) },
        );
      }
      return result;
    },
    [chatId, groupCallId, syncVoicePresence],
  );

  const markPostJoinRosterComplete = useCallback(
    (
      listed: number,
      hint: number,
      meta?: { loadedAll?: boolean; hasHiddenListeners?: boolean },
    ) => {
      // Telegram Web/Desktop: complete from loaded_all / hidden-listeners, never
      // from listed === participant_count alone (muted listeners are omitted) and
      // never from a soft recent_speakers subset (listed=3 while hint=9).
      if (listed <= 0) return false;
      const emptyTitles = participantsRef.current.filter(
        (row) => !row.is_self && isEffectivelyBlankDisplayName(row.title),
      ).length;
      // Keep forcing while TDLib count is higher or names are still blank —
      // loaded_all with listed=5/hint=8 left "?" rows and missing people.
      if (hint > listed) return false;
      if (emptyTitles > 0) return false;
      if (participantsRef.current.some(participantNeedsVideoForceReload)) {
        return false;
      }
      if (meta?.loadedAll) {
        postJoinRosterLoadedRef.current = true;
        return true;
      }
      if (meta?.hasHiddenListeners && listed >= 1) {
        hasHiddenListenersRef.current = true;
        postJoinRosterLoadedRef.current = true;
        return true;
      }
      if (hint > 0 && listed >= hint) {
        postJoinRosterLoadedRef.current = true;
        return true;
      }
      // Still thin vs TDLib's count — keep forcing (no-growth / give-up paths
      // accept a visible roster when hidden listeners never set the flag).
      return false;
    },
    [],
  );

  const kickPostJoinForceReload = useCallback(
    (source: string) => {
      if (!isTelegramMessagesConnected) {
        logPageDisplay("messages_voice_dialog_postjoin_reload_skip", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          reason: "not_connected",
          source,
        });
        return;
      }
      if (postJoinForceInFlightRef.current) {
        logPageDisplay("messages_voice_dialog_postjoin_reload_skip", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          reason: "in_flight",
          source,
        });
        return;
      }
      if (!rosterIncomplete()) {
        markPostJoinRosterComplete(
          participantsRef.current.length,
          rosterTotalHintRef.current,
        );
        if (postJoinRosterLoadedRef.current) {
          logPageDisplay("messages_voice_dialog_postjoin_reload_skip", {
            chatId,
            listed: participantsRef.current.length,
            hint: rosterTotalHintRef.current,
            reason: "roster_already_filled",
            source,
          });
        }
        return;
      }
      postJoinForceInFlightRef.current = true;
      logPageDisplay("messages_voice_dialog_postjoin_reload_start", {
        chatId,
        listed: participantsRef.current.length,
        hint: rosterTotalHintRef.current,
        attempt: 0,
        webrtcJoined: voiceSessionJoinedRef.current,
        panelJoined: voiceJoinedRef.current,
        popoverOpen: popoverOpenRef.current,
        source,
      });
      void reloadVoiceRoster({ force: true })
        .then((result) => {
          if (!result?.ok) {
            logPageDisplay("messages_voice_dialog_postjoin_reload_fail", {
              chatId,
              error: "error" in result ? result.error : "unknown",
              attempt: 0,
              source,
              level: "warn",
            });
            return;
          }
          const listed = participantsRef.current.length;
          const hint = rosterTotalHintRef.current;
          const screenPublishers = participantsRef.current.filter(
            (row) => !row.is_self && participantHasScreenPublisher(row),
          );
          logPageDisplay("messages_voice_dialog_postjoin_reload_ok", {
            chatId,
            listed,
            count: listed,
            hint,
            attempt: 0,
            fetched: result.participants.length,
            loadedAll: result.loaded_all_participants,
            hasHidden: result.has_hidden_listeners,
            screenPublishers: screenPublishers.length,
            screens: screenPublishers.slice(0, 4).map((row) => ({
              title: formatVoiceParticipantTitle(row),
              endpoint: row.screen_sharing_video_info?.endpoint_id ?? "",
              groups: row.screen_sharing_video_info?.source_groups?.length ?? 0,
            })),
            source,
          });
          markPostJoinRosterComplete(listed, hint, {
            loadedAll: result.loaded_all_participants,
            hasHiddenListeners: result.has_hidden_listeners,
          });
        })
        .finally(() => {
          postJoinForceInFlightRef.current = false;
        });
    },
    [
      chatId,
      isTelegramMessagesConnected,
      markPostJoinRosterComplete,
      reloadVoiceRoster,
      rosterIncomplete,
    ],
  );
  kickPostJoinForceReloadRef.current = kickPostJoinForceReload;

  // Log join commit only — do NOT kick a second force-reload here. Dual kicks
  // (this effect + the wait-loop below) stacked TDLib loads with SDP and froze
  // Close. Telegram Web learns roster from the update stream after one load.
  useEffect(() => {
    if (!joined || !voiceSession.joined) return;
    logPageDisplay("messages_voice_session_joined_commit", {
      chatId,
      listed: participantsRef.current.length,
      hint: rosterTotalHintRef.current,
      popoverOpen: popoverOpenRef.current,
    });
  }, [joined, voiceSession.joined, chatId]);

  const flushPendingStreamSnapRef = useRef(flushPendingStreamSnap);
  flushPendingStreamSnapRef.current = flushPendingStreamSnap;
  const reloadVoiceRosterRef = useRef(reloadVoiceRoster);
  reloadVoiceRosterRef.current = reloadVoiceRoster;
  const dialogSessionOpenRef = useRef(false);

  useEffect(() => {
    if (!popoverOpen) {
      if (dialogSessionOpenRef.current) {
        dialogSessionOpenRef.current = false;
        logPageDisplay("messages_voice_dialog_close", { chatId });
        // Remount next open only after a full close — never mid-Join.
        setPopoverMountKey((k) => k + 1);
      }
      return;
    }
    if (!isTelegramMessagesConnected) return;

    // Open once per sheet session — do not remount the portal when callback
    // identities churn (that briefly dropped data-voice-dialog and froze Close).
    const isFreshOpen = !dialogSessionOpenRef.current;
    dialogSessionOpenRef.current = true;
    if (isFreshOpen) {
      // Do NOT bump popoverMountKey here — remounting the portal in the same
      // turn as Join stacked WebGL/DOM teardown with createOffer and wedged
      // the tab (Playwright evaluate timed out for 8s+ after join_ok).
      // openSeq already clears forceClosed; remount only after a full close.
      // Prior voice_join_timeout left attempts capped — reopen must retry WebRTC.
      joinAttemptsRef.current = 0;
      logPageDisplay("messages_voice_dialog_open", {
        chatId,
        groupCallId,
      });
      // Keep high/critical so voice roster avatars already queued can finish;
      // drop queued avatar/emoji/media work that remounts under the sheet.
      clearQueuedNetworkFetches();
      clearQueuedChooseCurrencyYearCharts();
      softPollAbortRef.current?.abort();
    }

    let cancelled = false;
    const openedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

    void (async () => {
      if (!isFreshOpen) return;
      // Let the sheet paint and bind click handlers before any network work.
      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!cancelled && pendingStreamSnapRef.current) {
              flushPendingStreamSnapRef.current();
            }
            window.setTimeout(resolve, 80);
          });
        });
      });
      if (cancelled || !popoverOpenRef.current) return;
      // During an in-flight WebRTC join, skip soft HTTP reload — it contends with
      // joinVideoChat. Do NOT keep skipping after join has failed/exhausted
      // (panelJoined && !webrtcJoined forever → listed=1 stuck, logs:
      // open_skip_reload_joining with webrtcJoining=false).
      const joinInFlight =
        voiceSessionJoiningRef.current || voiceSessionNegotiatingRef.current;
      const joinStillPending =
        voiceJoinedRef.current &&
        !voiceSessionJoinedRef.current &&
        joinAttemptsRef.current < 3 &&
        (joinInFlight || joinAttemptsRef.current === 0);
      if (joinInFlight || joinStillPending) {
        logPageDisplay("messages_voice_dialog_open_skip_reload_joining", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          panelJoined: voiceJoinedRef.current,
          webrtcJoined: voiceSessionJoinedRef.current,
          webrtcJoining: voiceSessionJoiningRef.current,
          webrtcNegotiating: voiceSessionNegotiatingRef.current,
          joinAttempts: joinAttemptsRef.current,
        });
        return;
      }
      const listed = participantsRef.current.length;
      const hint = rosterTotalHintRef.current;
      const emptyTitles = participantsRef.current.filter(
        (row) => !row.title.trim() && !row.is_self,
      ).length;
      // Soft recent_speakers (≤3) with a higher hint still needs a later force;
      // skip only a soft HTTP here so we don't contend with Join/SDP.
      const stuckOnSpeakers = listed > 0 && listed <= 3 && hint > listed;
      const titlesThin = emptyTitles > 0 && emptyTitles >= Math.ceil(Math.max(listed, 1) / 2);
      const rosterLooksComplete = listed > 1 && !stuckOnSpeakers && !titlesThin;
      if (rosterLooksComplete) {
        logPageDisplay("messages_voice_dialog_open_skip_reload", {
          chatId,
          listed,
          hint,
          elapsedMs: Math.round(
            (typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now()) - openedAt,
          ),
        });
        return;
      }
      if (stuckOnSpeakers && !titlesThin) {
        // Membership fill is owned by post-join force after webrtc_join_ok.
        logPageDisplay("messages_voice_dialog_open_defer_force_to_webrtc", {
          chatId,
          listed,
          hint,
          reason: "thin_speakers_await_join_force",
          webrtcJoined: voiceSessionJoinedRef.current,
          elapsedMs: Math.round(
            (typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now()) - openedAt,
          ),
        });
        return;
      }
      try {
        const result = await reloadVoiceRosterRef.current({
          cancelled: () => cancelled || !popoverOpenRef.current,
        });
        if (cancelled || !popoverOpenRef.current || !result?.ok) return;
        const listedAfter = participantsRef.current.length;
        const hintAfter = Math.max(
          rosterTotalHintRef.current,
          result.participant_count,
          result.participants.length,
        );
        if (listedAfter < hintAfter) {
          // TDLib rejects loadGroupCallParticipants until we are joined — a
          // pre-join force reload only returns recent_speakers (~1 row). Panel
          // `joined` arms Join; WebRTC may still be negotiating — still schedule
          // force (server waits for is_joined). Only bail when Join was never armed.
          if (!voiceJoinedRef.current && !voiceSessionJoinedRef.current) {
            logPageDisplay("messages_voice_dialog_open_wait_join_for_roster", {
              chatId,
              listed: listedAfter,
              hint: hintAfter,
              elapsedMs: Math.round(
                (typeof performance !== "undefined" && typeof performance.now === "function"
                  ? performance.now()
                  : Date.now()) - openedAt,
              ),
            });
            return;
          }
          // Force reload is owned by the post-join effect once webrtcJoined —
          // doing it here before joinVideoChat blocked TDLib for up to 12s.
          logPageDisplay("messages_voice_dialog_open_defer_force_to_webrtc", {
            chatId,
            listed: listedAfter,
            hint: hintAfter,
            webrtcJoined: voiceSessionJoinedRef.current,
            elapsedMs: Math.round(
              (typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now()) - openedAt,
            ),
          });
          return;
        }
        logPageDisplay("messages_voice_dialog_force_reload_ok", {
          chatId,
          listed: result.participants.length,
          count: result.participants.length,
          hint: hintAfter,
          forced: false,
          elapsedMs: Math.round(
            (typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now()) - openedAt,
          ),
        });
      } catch (err) {
        logPageDisplay("messages_voice_dialog_force_reload_fail", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
          level: "warn",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popoverOpen, chatId, isTelegramMessagesConnected, groupCallId]);

  // After Join, TDLib allows loadGroupCallParticipants. Soft polls before join
  // only return recent_speakers — force ONLY while the roster is still a solo
  // stub. Never chase listed === hint (hidden listeners make that unreachable
  // and the force GET mid-SDP freezes the tab).
  //
  // Depend only on panel `joined`, NOT voiceSession.joined. Flipping webrtcJoined
  // used to remount this effect: cleanup cancelled the wait loop, then an 800ms
  // re-delay left listed=1 after messages_voice_webrtc_join_ok with no
  // postjoin_reload_start in the same window.
  useEffect(() => {
    if (!joined) {
      postJoinRosterLoadedRef.current = false;
      return;
    }
    // Do not force-reload after Close — joined can lag while leave cancels SDP
    // (logs: close → postjoin_wait_webrtc → stuck feel).
    if (!popoverOpen) return;
    if (!isTelegramMessagesConnected) return;
    if (!rosterIncomplete()) {
      markPostJoinRosterComplete(
        participantsRef.current.length,
        rosterTotalHintRef.current,
      );
      if (postJoinRosterLoadedRef.current) {
        logPageDisplay("messages_voice_dialog_postjoin_reload_skip", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          reason: "roster_already_filled",
          source: "joined_effect",
        });
        return;
      }
    }
    let cancelled = false;
    let attempts = 0;
    // Telegram Web: a few load passes after join, then update stream.
    const maxAttempts = 4;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let loggedWaitWebrtc = false;
    let lastForceListed = -1;
    let webrtcJoinedSeenAt = 0;

    const armRetry = (ms: number) => {
      if (cancelled) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(run, ms);
    };

    const run = () => {
      if (cancelled || inFlight) return;
      if (!rosterIncomplete()) {
        postJoinRosterLoadedRef.current = true;
        return;
      }
      if (attempts >= maxAttempts) {
        logPageDisplay("messages_voice_dialog_postjoin_reload_give_up", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          attempts,
          level: "warn",
        });
        // Stop hammering TDLib even if listed < hint (hidden listeners).
        postJoinRosterLoadedRef.current = true;
        return;
      }
      // Prefer waiting for WebRTC join before force-reload (pre-join force can
      // starve joinVideoChat). Once join attempts are exhausted, force anyway —
      // TDLib may already be joined after a client-side SDP/join timeout.
      const joinGiveUp =
        joinAttemptsRef.current >= 3 &&
        !voiceSessionJoiningRef.current &&
        !voiceSessionNegotiatingRef.current;
      if (!voiceSessionJoinedRef.current && !joinGiveUp) {
        if (!loggedWaitWebrtc) {
          loggedWaitWebrtc = true;
          logPageDisplay("messages_voice_dialog_postjoin_wait_webrtc", {
            chatId,
            listed: participantsRef.current.length,
            hint: rosterTotalHintRef.current,
            panelJoined: joined,
            joinAttempts: joinAttemptsRef.current,
            level: "info",
          });
        }
        // Poll faster so we catch webrtc_join_ok without a long listed=1 stall.
        armRetry(120);
        return;
      }
      if (!voiceSessionJoinedRef.current && joinGiveUp && !loggedWaitWebrtc) {
        logPageDisplay("messages_voice_dialog_postjoin_force_after_join_give_up", {
          chatId,
          listed: participantsRef.current.length,
          hint: rosterTotalHintRef.current,
          joinAttempts: joinAttemptsRef.current,
          level: "warn",
        });
      }
      // Settle SDP / ICE before force roster HTTP — overlapping them froze the
      // UI (join_ok → postjoin_reload_start → Close dead, pointer backdrop stuck).
      // Thin recent_speakers (listed=2 hint=6) must not wait the full media settle
      // or the dialog stays half-empty while the call feels stuck.
      if (voiceSessionJoinedRef.current) {
        const now =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        if (webrtcJoinedSeenAt <= 0) webrtcJoinedSeenAt = now;
        const settleMs = now - webrtcJoinedSeenAt;
        const listedNow = participantsRef.current.length;
        const hintNow = rosterTotalHintRef.current;
        const thinVsHint = listedNow <= 3 && hintNow > listedNow;
        const settleNeedMs = thinVsHint ? 200 : 2_500;
        if (settleMs < settleNeedMs) {
          armRetry(Math.max(80, settleNeedMs - settleMs));
          return;
        }
      }
      if (postJoinForceInFlightRef.current) {
        armRetry(400);
        return;
      }
      attempts += 1;
      inFlight = true;
      postJoinForceInFlightRef.current = true;
      logPageDisplay("messages_voice_dialog_postjoin_reload_start", {
        chatId,
        listed: participantsRef.current.length,
        hint: rosterTotalHintRef.current,
        attempt: attempts,
        webrtcJoined: voiceSessionJoinedRef.current,
        panelJoined: joined,
        popoverOpen: popoverOpenRef.current,
      });
      void (async () => {
        try {
          const result = await reloadVoiceRoster({
            force: true,
            cancelled: () => cancelled,
          });
          if (cancelled) return;
          if (!result?.ok) {
            logPageDisplay("messages_voice_dialog_postjoin_reload_fail", {
              chatId,
              error: result && "error" in result ? result.error : "unknown",
              attempt: attempts,
              level: "warn",
            });
            armRetry(1_500);
            return;
          }
          const listed = participantsRef.current.length;
          const hint = rosterTotalHintRef.current;
          const screenPublishers = participantsRef.current.filter(
            (row) => !row.is_self && participantHasScreenPublisher(row),
          );
          logPageDisplay("messages_voice_dialog_postjoin_reload_ok", {
            chatId,
            listed,
            count: listed,
            hint,
            attempt: attempts,
            fetched: result.participants.length,
            loadedAll: result.loaded_all_participants,
            hasHidden: result.has_hidden_listeners,
            screenPublishers: screenPublishers.length,
            screens: screenPublishers.slice(0, 4).map((row) => ({
              title: formatVoiceParticipantTitle(row),
              endpoint: row.screen_sharing_video_info?.endpoint_id ?? "",
              groups: row.screen_sharing_video_info?.source_groups?.length ?? 0,
            })),
          });
          if (
            markPostJoinRosterComplete(listed, hint, {
              loadedAll: result.loaded_all_participants,
              hasHiddenListeners: result.has_hidden_listeners,
            })
          ) {
            return;
          }
          // No growth after a joined force. Accept when we've matched TDLib's
          // total, or Telegram hides muted listeners so listed will never catch
          // up. Do NOT stop early on listed < hint without has_hidden — that
          // left half the call missing after two thin force passes.
          if (listed >= 1 && listed === lastForceListed) {
            const hidden =
              Boolean(result.has_hidden_listeners) ||
              hasHiddenListenersRef.current;
            const caughtUp = hint > 0 && listed >= hint;
            if (hidden || caughtUp || hint <= 0) {
              postJoinRosterLoadedRef.current = true;
              logPageDisplay("messages_voice_dialog_postjoin_reload_accept_visible", {
                chatId,
                listed,
                hint,
                attempt: attempts,
                hasHidden: hidden,
                level: "info",
              });
              return;
            }
            logPageDisplay("messages_voice_dialog_postjoin_reload_keep_forcing", {
              chatId,
              listed,
              hint,
              attempt: attempts,
              level: "warn",
              note: "listed still below TDLib count — keep force-reload",
            });
            armRetry(2_500);
            return;
          }
          lastForceListed = listed;
          armRetry(2_500);
        } catch (err) {
          logPageDisplay("messages_voice_dialog_postjoin_reload_fail", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
            attempt: attempts,
            level: "warn",
          });
          armRetry(2_000);
        } finally {
          inFlight = false;
          postJoinForceInFlightRef.current = false;
        }
      })();
    };

    // Paint sheet first; the wait loop polls voiceSessionJoinedRef so webrtc
    // join mid-flight kicks force reload on the next tick (no remount).
    const timer = setTimeout(run, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    joined,
    popoverOpen,
    chatId,
    isTelegramMessagesConnected,
    markPostJoinRosterComplete,
    reloadVoiceRoster,
    rosterIncomplete,
  ]);

  // NOTE: exactly ONE effect computes remote-video requests (above). A second
  // duplicate with different endpoint fallbacks ping-ponged the renegotiation
  // key and spun full SDP offer/answer cycles in a loop (CPU overload).

  const unlockThenJoin = useCallback(() => {
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
    // Prefetch mic only when preserving an already-open Telegram mic; otherwise
    // stay listen-muted (no getUserMedia / mic light until the user unmutes).
    const selfRow = participantsRef.current.find((row) => row.is_self);
    if (selfRow && selfRow.is_muted === false) {
      voiceSession.prefetchMic();
    }
    onJoin();
  }, [onJoin, voiceSession]);

  const handleStripPress = useCallback(() => {
    if (
      suppressStripPressUntilRef &&
      Date.now() < suppressStripPressUntilRef.current
    ) {
      logPageDisplay("messages_voice_strip_press_swallowed", {
        chatId,
        reason: "post_close_guard",
        msRemaining: suppressStripPressUntilRef.current - Date.now(),
      });
      return;
    }
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
    if (!joined) {
      logPageDisplay("messages_voice_strip_press", { chatId, joined: false, action: "join" });
      unlockThenJoin();
      return;
    }
    logPageDisplay("messages_voice_strip_press", {
      chatId,
      joined: true,
      action: "open_dialog",
      popoverOpen: popoverOpenRef.current,
    });
    onOpenPopover();
  }, [
    chatId,
    joined,
    onOpenPopover,
    suppressStripPressUntilRef,
    unlockThenJoin,
    voiceSession,
  ]);

  const onLeave = useCallback(async () => {
    if (leaving || !joined) return;
    setLeaving(true);
    try {
      const result = await voiceSession.leaveVoice();
      if (result.ok) {
        volumeZeroRepairAttemptedRef.current.clear();
        intentionalMuteReapplyAttemptedRef.current.clear();
        listenVolumeNudgeAttemptedRef.current.clear();
        tdlibSelfUserIdRef.current = null;
        onClosePopover();
        // Drop strip / dock immediately — do not keep Join preview after Leave
        // even when others remain in the call (probe may still mark chat live).
        onLeftVoice?.();
        setParticipants([]);
        setParticipantCount(0);
        rosterTotalHintRef.current = 0;
        rosterCountHintStateRef.current = 0;
        setRosterCountHint(0);
        setPresenceConfirmedAndNotify(false);
        setActiveVoiceDock(null);
        const live = Boolean(result.has_active_voice_chat);
        const keepCallId =
          typeof result.voice_chat_group_call_id === "number" &&
          Number.isFinite(result.voice_chat_group_call_id) &&
          result.voice_chat_group_call_id > 0
            ? Math.trunc(result.voice_chat_group_call_id)
            : null;
        patchAuthenticatedHomeSelectedChatVoice(chatId, {
          has_active_voice_chat: live,
          voice_chat_group_call_id: keepCallId,
          voice_chat_is_joined: false,
        });
      } else {
        appWarn("[message-voice-leave]", result.error, { chatId, groupCallId });
      }
    } finally {
      setLeaving(false);
    }
  }, [
    chatId,
    groupCallId,
    joined,
    leaving,
    onClosePopover,
    onLeftVoice,
    setPresenceConfirmedAndNotify,
    voiceSession,
  ]);

  const onDropFromPopover = useCallback(async () => {
    if (leaving) return;
    // Hide the sheet immediately — leave may take a moment on the gateway.
    onClosePopover();
    if (!joined) {
      setPresenceConfirmedAndNotify(false);
      setActiveVoiceDock(null);
      onLeftVoice?.();
      return;
    }
    setLeaving(true);
    try {
      const result = await voiceSession.leaveVoice();
      if (result.ok) {
    volumeZeroRepairAttemptedRef.current.clear();
    intentionalMuteReapplyAttemptedRef.current.clear();
    listenVolumeNudgeAttemptedRef.current.clear();
    tdlibSelfUserIdRef.current = null;
        onLeftVoice?.();
        setParticipants([]);
        setParticipantCount(0);
        rosterTotalHintRef.current = 0;
        rosterCountHintStateRef.current = 0;
        setRosterCountHint(0);
        setPresenceConfirmedAndNotify(false);
        setActiveVoiceDock(null);
        const live = Boolean(result.has_active_voice_chat);
        const keepCallId =
          typeof result.voice_chat_group_call_id === "number" &&
          Number.isFinite(result.voice_chat_group_call_id) &&
          result.voice_chat_group_call_id > 0
            ? Math.trunc(result.voice_chat_group_call_id)
            : null;
        patchAuthenticatedHomeSelectedChatVoice(chatId, {
          has_active_voice_chat: live,
          voice_chat_group_call_id: keepCallId,
          voice_chat_is_joined: false,
        });
      } else {
        appWarn("[message-voice-leave]", result.error, { chatId, groupCallId });
      }
    } finally {
      setLeaving(false);
    }
  }, [
    chatId,
    groupCallId,
    joined,
    leaving,
    onClosePopover,
    onLeftVoice,
    setPresenceConfirmedAndNotify,
    voiceSession,
  ]);

  const onMicPress = useCallback(() => {
    if (!joined) {
      // If the popover is already open, a join arm-timer is already pending —
      // do not fire a second join (which would re-open the dialog / call onJoin
      // again and generate a spurious messages_voice_join_start log).
      if (popoverOpenRef.current) return;
      unlockThenJoin();
      return;
    }
    const now = Date.now();
    if (now - micPressAtRef.current < 280) return;
    micPressAtRef.current = now;
    void voiceSession.toggleMic();
  }, [joined, unlockThenJoin, voiceSession]);

  const onCameraPress = useCallback(() => {
    if (!joined) {
      if (popoverOpenRef.current) return;
      unlockThenJoin();
      return;
    }
    void voiceSession.toggleCamera();
  }, [joined, unlockThenJoin, voiceSession]);

  const onStartScreenShare = useCallback(() => {
    // Always attempt share — session acquires getDisplayMedia first (user
    // gesture), then joins if needed. Do not no-op when the dialog is open
    // but WebRTC is not joined yet (that looked like a dead Start sharing).
    void voiceSession.startScreenShare();
  }, [voiceSession]);

  const onStopScreenShare = useCallback(() => {
    void voiceSession.stopScreenShare();
  }, [voiceSession]);

  const sessionErrorLabel = useMemo(() => {
    const code = voiceSession.error;
    if (!code) return null;
    if (
      code === "screen_share_unsupported" ||
      code === "screen_share_unavailable"
    ) {
      return t("messages.voiceChat.errors.screenShareUnsupported");
    }
    if (code === "screen_share_denied") {
      return t("messages.voiceChat.errors.screenShareDenied");
    }
    if (code === "screen_share_cancelled") {
      return t("messages.voiceChat.errors.screenShareCancelled");
    }
    if (
      code === "screen_share_failed" ||
      code.startsWith("screen_share") ||
      code.startsWith("presentation_") ||
      code === "voice_not_joined"
    ) {
      return t("messages.voiceChat.errors.screenShareFailed");
    }
    const floodMs = parseTelegramFloodWaitMs(code);
    if (floodMs != null) {
      const seconds = Math.max(1, Math.ceil(floodMs / 1000));
      return tf("messages.voiceChat.errors.joinRateLimited", { seconds });
    }
    return null;
  }, [t, tf, voiceSession.error]);

  const showStrip = Boolean(joined || presenceConfirmed);

  const onOpenPopoverRef = useRef(onOpenPopover);
  onOpenPopoverRef.current = onOpenPopover;
  const onLeaveRefForDock = useRef(onLeave);
  onLeaveRefForDock.current = onLeave;

  // When the sheet is minimized (or the messages column is hidden) but we are
  // still in the call, publish a global dock so Swap/Trade/… and 2-column home
  // keep a live preview — not only the 3-column chat layout.
  useEffect(() => {
    if (!joined || !voiceSession.joined) {
      setActiveVoiceDock(null);
      return;
    }
    if (popoverOpen) {
      setActiveVoiceDock(null);
      return;
    }
    // In-chat strip covers the focused messages column; publish dock whenever
    // that column is not focused OR whenever the strip is not shown.
    if (visible && showStrip) {
      setActiveVoiceDock(null);
      return;
    }
    setActiveVoiceDock({
      chatId,
      title,
      participantCount: totalParticipantCount,
      micActive: voiceSession.micActive,
      onOpen: () => {
        focusAuthenticatedHomeMiddleColumnOnChat();
        unlockVoiceAutoplay();
        onOpenPopoverRef.current();
      },
      onLeave: () => {
        void onLeaveRefForDock.current();
      },
    });
    return () => {
      setActiveVoiceDock(null);
    };
  }, [
    chatId,
    joined,
    popoverOpen,
    showStrip,
    title,
    totalParticipantCount,
    visible,
    voiceSession.joined,
    voiceSession.micActive,
  ]);

  // Freeze detector: logs longtask + rAF stalls to [page-display] while the
  // dialog is open or a WebRTC join is in progress — the freeze usually happens
  // during getUserMedia / SDP negotiation right after the user presses Join.
  // Freeze detector: only while the sheet is open — joining after Close must
  // not keep rAF monitors attributing WebRTC work to the dialog.
  // Skip stall-recover during Join/SDP — WebAudio rebuild mid-negotiate cut
  // remote audio (logs: voice_dialog_longtask storms → interrupted stream).
  useVoiceDialogFreezeDetector(popoverOpen, () => {
    if (
      voiceSessionJoiningRef.current ||
      voiceSessionNegotiatingRef.current ||
      !voiceSessionJoinedRef.current
    ) {
      return;
    }
    voiceSession.kickRemotePlayback("stall-recover");
  });

  return (
    <>
      {showStrip ? (
      <View
        style={{
          alignSelf: "stretch",
          height: MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: stripPaddingX,
          borderBottomWidth: 1,
          borderBottomColor: colors.highlight,
          backgroundColor: colors.background,
          overflow: "visible",
        }}
      >
        <Pressable
          onPress={handleStripPress}
          accessibilityRole="button"
          accessibilityLabel={
            joined ? t("messages.voiceChat.open") : t("messages.voiceChat.join")
          }
          testID="voice-strip-preview"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            flexShrink: 1,
            flex: 1,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <View
            accessibilityRole="image"
            accessibilityLabel={t("messages.voiceChat.active")}
            style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
          >
            <MessageChatMicIcon
              muted={!(joined && voiceSession.micActive)}
              color={joined && voiceSession.micActive ? colors.accent : colors.primary}
              size={20}
            />
          </View>
          {stackedParticipants.length > 0 ? (
            <View
              accessibilityLabel={participantsA11yLabel}
              style={{
                flexDirection: "row",
                alignItems: "center",
                height: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                gap: 6,
                minWidth: 0,
                flexShrink: 1,
                overflow: "visible",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  height: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                  flexShrink: 0,
                  overflow: "visible",
                }}
              >
                {stackedParticipants.map((participant, index) => {
                  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
                  const participantTitle = formatVoiceParticipantTitle(participant);
                  const speaking = Boolean(
                    rowSpeakKeys(participant).some((k) => speakingByKey[k]),
                  );
                  const avatarPx = MESSAGE_CHAT_VOICE_BAR_AVATAR_PX;
                  const dividerPx = MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_DIVIDER_PX;
                  const ringOutsetPx = MESSAGE_CHAT_VOICE_RING_OUTSET_PX;
                  const isLast = index >= stackedParticipants.length - 1;
                  return (
                    <View
                      key={
                        participant.user_id != null
                          ? `u:${participant.user_id}`
                          : `c:${participant.chat_id}`
                      }
                      style={{
                        marginLeft:
                          index === 0
                            ? 0
                            : -MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_OVERLAP_PX,
                        // Leftmost stays on top (chat-list style); right-edge
                        // seam divider masks this face's speaking ring.
                        zIndex: stackedParticipants.length - index,
                        width: avatarPx,
                        height: avatarPx,
                        alignItems: "center",
                        justifyContent: "center",
                        // Speaking ring sits outside the face (chat-list style).
                        overflow: "visible",
                      }}
                    >
                      <MessageChatAvatarSlot
                        iconUrl={avatarUrl}
                        initials={extractChatAvatarInitials(participantTitle)}
                        sizePx={avatarPx}
                        colors={colors}
                        scheme={colorScheme}
                        fetchPriority="high"
                        borderColor={
                          speaking ? MESSAGE_CHAT_JOINED_VOICE_RING_COLOR : undefined
                        }
                        activeVoiceRing={speaking}
                        joinedVoiceRing={speaking}
                      />
                      {!isLast ? (
                        <View
                          pointerEvents="none"
                          style={{
                            position: "absolute",
                            // 1px seam into the face + full right speaking ring
                            // so the green stroke never overlays the next avatar.
                            left: avatarPx - dividerPx,
                            top: -ringOutsetPx,
                            width: dividerPx + ringOutsetPx,
                            height: avatarPx + ringOutsetPx * 2,
                            backgroundColor: colors.background,
                            zIndex: 40,
                          }}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
              {overflowCount > 0 ? (
                <Text
                  numberOfLines={1}
                  style={{
                    color: colors.secondary,
                    fontSize: 13,
                    lineHeight: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                    flexShrink: 1,
                  }}
                >
                  {`+${overflowCount}`}
                </Text>
              ) : null}
              <Text
                numberOfLines={1}
                style={{
                  color: colors.primary,
                  fontSize: 13,
                  lineHeight: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                  fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                  flexShrink: 1,
                  minWidth: 0,
                }}
              >
                {participantsA11yLabel}
              </Text>
            </View>
          ) : (
            <Text
              numberOfLines={1}
              style={{
                color: totalParticipantCount > 0 ? colors.primary : colors.secondary,
                fontSize: 13,
                lineHeight: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {participantsA11yLabel}
            </Text>
          )}
        </Pressable>
        {joined ? (
          <Pressable
            onPress={onLeave}
            disabled={leaving}
            accessibilityRole="button"
            accessibilityLabel={t("messages.voiceChat.leave")}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              alignItems: "center",
              justifyContent: "center",
              opacity: leaving ? 0.5 : pressed ? 0.7 : 1,
            })}
          >
            <MessageChatLeaveVoiceIcon color={colors.primary} size={22} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("messages.voiceChat.join")}
            onPress={unlockThenJoin}
            testID="voice-strip-join-button"
            style={({ pressed }) => ({
              marginLeft: 12,
              flexShrink: 0,
              height: JOIN_BUTTON_HEIGHT_PX,
              paddingHorizontal: JOIN_BUTTON_TEXT_INSET_PX,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.undercover,
              opacity: pressed ? 0.7 : 1,
              ...Platform.select({
                web: { boxSizing: "border-box" as const },
                default: {},
              }),
            })}
          >
            <Text
              style={[
                typographyFixedRow30Label,
                {
                  color: colors.primary,
                  textAlign: "center",
                  fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                },
              ]}
              numberOfLines={1}
            >
              {t("messages.voiceChat.join")}
            </Text>
          </Pressable>
        )}
      </View>
      ) : null}
      {/* No strip screencast when the dialog is minimized — stage lives in the popover. */}
      <MessageChatVoiceVideoPlane
        stream={voiceSession.remoteVideoStream}
        active={false}
      />
      <MessageChatVoicePopover
        mountKey={popoverMountKey}
        openSeq={openSeq}
        visible={popoverOpen}
        onClose={onClosePopover}
        title={title}
        participantCount={totalParticipantCount}
        participants={displayParticipants}
        isParticipantSpeaking={resolveParticipantSpeaking}
        colors={colors}
        micActive={voiceSession.micActive}
        micJoining={voiceSession.joining}
        onMicPress={() => void onMicPress()}
        cameraActive={voiceSession.cameraActive}
        onCameraPress={() => void onCameraPress()}
        screenSharing={voiceSession.screenSharing}
        onStartScreenShare={() => void onStartScreenShare()}
        onStopScreenShare={() => void onStopScreenShare()}
        mediaReconnecting={voiceSession.mediaReconnecting}
        voiceReconnecting={voiceSession.voiceReconnecting}
        sessionError={sessionErrorLabel}
        onDropPress={() => void onDropFromPopover()}
        dropLeaving={leaving}
        remoteVideoStream={voiceSession.remoteVideoStream}
        remoteVideoSources={voiceSession.remoteVideoSources}
        localCameraStream={voiceSession.localCameraStream}
        localScreenStream={voiceSession.localScreenStream}
        videoActive={Boolean(joined && voiceSession.joined && visible)}
        onScreenShareDisplaySize={voiceSession.setScreenShareDisplaySize}
        chatMessages={voiceChatMessages}
        onSendChatMessage={onSendVoiceChatMessage}
        participantMediaPrefs={participantMediaPrefs}
        mixPausedScreenEndpoints={mixPausedScreenEndpoints}
        deniedScreenPeerKeys={deniedScreenPeerKeys}
        wantedScreenPeerKeys={wantedScreenPeerKeys}
        onParticipantVolumeChange={onParticipantVolumeChange}
        onParticipantToggleMuteVoice={onParticipantToggleMuteVoice}
        onParticipantToggleMuteVideo={onParticipantToggleMuteVideo}
        onParticipantToggleMuteScreen={onParticipantToggleMuteScreen}
      />
    </>
  );
}
