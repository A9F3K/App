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
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { useTelegramVoiceSession } from "../../telegram/useTelegramVoiceSession";
import { unlockVoiceAutoplay } from "../../telegram/unlockVoiceAutoplay";
import { appWarn } from "../../../shared/appLog";
import { logPageDisplay } from "../../pageDisplayLog";
import { useTelegram } from "../Telegram";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import {
  MessageChatLeaveVoiceIcon,
  MessageChatMicIcon,
} from "./MessageChatVoiceIcons";
import { MessageChatVoicePopover } from "./MessageChatVoicePopover";
import { MessageChatVoiceVideoPlane } from "./MessageChatVoiceVideoPlane";
import {
  useTelegramVoiceParticipantsStream,
  type VoiceParticipantsStreamSnapshot,
} from "./useTelegramVoiceParticipantsStream";
import { useVoiceDialogFreezeDetector } from "./useVoiceDialogFreezeDetector";
import {
  MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
  MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_OVERLAP_PX,
  MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX,
  MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS,
  resolveVoiceBarParticipantPreview,
} from "./messageListLayout";
import { clearQueuedNetworkFetches } from "./networkFetchQueue";
import { clearQueuedChooseCurrencyYearCharts } from "../../swap/chooseCurrencyYearChartCache";

const JOIN_BUTTON_HEIGHT_PX = 30;
const JOIN_BUTTON_TEXT_INSET_PX = 30;

type Props = {
  chatId: number;
  groupCallId: number | null;
  title: string;
  colors: ThemeColors;
  /** User pressed Join — media session may start. */
  joined: boolean;
  /** Chat dialog is on-screen — remote audio only plays while visible. */
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
};

/**
 * Under-header strip for an active chat voice.
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
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { colorScheme, displayName, telegramUsername } = useTelegram();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const [leaving, setLeaving] = useState(false);
  const [participants, setParticipants] = useState<TelegramChatVoiceParticipant[]>([]);
  /** Listed row count — always matches dialog roster / strip avatars. */
  const [participantCount, setParticipantCount] = useState(0);
  /** TDLib total hint (may exceed loaded rows until force reload). */
  const rosterTotalHintRef = useRef(0);
  const [rosterCountHint, setRosterCountHint] = useState(0);
  const rosterCountHintStateRef = useRef(0);
  /** Speaking glow is a side map (tdesktop parity) — never rebuilds roster order. */
  const [speakingByKey, setSpeakingByKey] = useState<Record<string, true>>({});
  /** Hide the empty strip until a poll/SSE proves real (non-self) presence. */
  const [presenceConfirmed, setPresenceConfirmed] = useState(false);
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
  participantsRef.current = participants;
  const participantCountRef = useRef(participantCount);
  participantCountRef.current = participantCount;

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
        setPresenceConfirmed(true);
        if (live) {
          patchAuthenticatedHomeSelectedChatVoice(forChatId, {
            has_active_voice_chat: true,
            voice_chat_group_call_id: callId ?? null,
          });
        }
        return true;
      }

      if (live) {
        setPresenceConfirmed(true);
        patchAuthenticatedHomeSelectedChatVoice(forChatId, {
          has_active_voice_chat: true,
          voice_chat_group_call_id: callId ?? null,
        });
        return true;
      }

      // Call still flagged active but roster snapshot is thin — keep the strip up.
      if (Boolean(hasActive)) {
        setPresenceConfirmed(true);
        patchAuthenticatedHomeSelectedChatVoice(forChatId, {
          has_active_voice_chat: true,
          voice_chat_group_call_id: callId ?? null,
        });
        return false;
      }

      // SSE thin/empty snapshots must not clear presence — that remounted the bar
      // in a loop with the HTTP poll and froze the page ("Page Unresponsive").
      if (!options?.allowClear) return false;

      setPresenceConfirmed(false);
      patchAuthenticatedHomeSelectedChatVoice(forChatId, {
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
      });
      return false;
    },
    [],
  );

  useEffect(() => {
    if (joined) setPresenceConfirmed(true);
  }, [joined]);

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
  const localSpeakingRef = useRef(voiceSession.localSpeaking);
  localSpeakingRef.current = voiceSession.localSpeaking;
  const joinListenRef = useRef(voiceSession.joinListen);
  joinListenRef.current = voiceSession.joinListen;
  const unlockAudioRef = useRef(voiceSession.unlockAudio);
  unlockAudioRef.current = voiceSession.unlockAudio;
  const selfTitleRef = useRef("");
  selfTitleRef.current =
    (typeof displayName === "string" && displayName.trim()) ||
    (typeof telegramUsername === "string" && telegramUsername.trim()
      ? `@${telegramUsername.trim().replace(/^@/, "")}`
      : "") ||
    "";

  const onLeftVoiceRef = useRef(onLeftVoice);
  onLeftVoiceRef.current = onLeftVoice;
  const leaveVoiceRef = useRef(voiceSession.leaveVoice);
  leaveVoiceRef.current = voiceSession.leaveVoice;

  // Closing the sheet before WebRTC connects must cancel Join — otherwise SDP
  // finishes after close (logs: close_click → webrtc_join_ok) and the page stays
  // engaged/gated with no dialog (feels stuck).
  useEffect(() => {
    if (popoverOpen) return;
    if (!joined) return;
    if (voiceSessionJoinedRef.current) return;
    let cancelled = false;
    void (async () => {
      logPageDisplay("messages_voice_dialog_close_cancel_join", {
        chatId,
        joining: voiceSessionJoiningRef.current,
        negotiating: voiceSessionNegotiatingRef.current,
      });
      softPollAbortRef.current?.abort();
      try {
        await leaveVoiceRef.current();
      } catch {
        /* best-effort */
      }
      if (!cancelled) onLeftVoiceRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [popoverOpen, joined, chatId]);

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
      // User closed the sheet during the settle delay — do not start SDP.
      if (!popoverOpenRef.current) {
        inFlight = false;
        logPageDisplay("messages_voice_webrtc_join_aborted_sheet_closed", {
          chatId,
          groupCallId,
        });
        onLeftVoiceRef.current?.();
        return;
      }
      // Count only real joinListen calls — cancelled settle delays must not
      // exhaust the 3-attempt budget.
      joinAttemptsRef.current += 1;
      logPageDisplay("messages_voice_webrtc_join_attempt", {
        chatId,
        groupCallId,
        attempt: joinAttemptsRef.current,
        popoverOpen: popoverOpenRef.current,
      });
      const ok = await joinListenRef.current();
      inFlight = false;
      logPageDisplay(
        ok ? "messages_voice_webrtc_join_ok" : "messages_voice_webrtc_join_fail",
        {
          chatId,
          groupCallId,
          attempt: joinAttemptsRef.current,
          popoverOpen: popoverOpenRef.current,
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
      const delayMs = Math.min(2000 * 2 ** Math.min(attempt - 1, 2), 12_000);
      logPageDisplay("messages_voice_webrtc_join_retry", {
        chatId,
        groupCallId,
        attempt,
        delayMs,
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

  useEffect(() => {
    setParticipants([]);
    setParticipantCount(0);
    setRosterCountHint(0);
    rosterTotalHintRef.current = 0;
    rosterCountHintStateRef.current = 0;
    setPresenceConfirmed(false);
    softPollAbortRef.current?.abort();
    speakingHoldUntilRef.current.clear();
    if (speakingHoldTimerRef.current) {
      clearTimeout(speakingHoldTimerRef.current);
      speakingHoldTimerRef.current = null;
    }
    // Only reset on chat change — groupCallId often fills in after the first poll
    // and must not wipe presence (that remounted WebRTC/SSE in a tight loop).
  }, [chatId]);

  useEffect(() => {
    return () => {
      if (speakingHoldTimerRef.current) {
        clearTimeout(speakingHoldTimerRef.current);
        speakingHoldTimerRef.current = null;
      }
      if (speakingRafRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame?.(speakingRafRef.current);
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
          Boolean(left.is_self) !== Boolean(right.is_self) ||
          (left.video_info?.endpoint_id ?? "") !== (right.video_info?.endpoint_id ?? "") ||
          (left.screen_sharing_video_info?.endpoint_id ?? "") !==
            (right.screen_sharing_video_info?.endpoint_id ?? "")
        ) {
          return false;
        }
      }
      return true;
    },
    [],
  );

  const streamActiveRef = useRef(false);
  const streamRevisionRef = useRef(0);
  /** Hold only matters for poll fallback — SSE speaking updates are already live. */
  const speakingHoldUntilRef = useRef(new Map<string, number>());
  const speakingHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coalesce speaking setState to one rAF — Telegram Web toggles CSS, not React storms. */
  const pendingSpeakingMapRef = useRef<Record<string, true> | null>(null);
  const speakingRafRef = useRef<number | null>(null);
  const speakingListedRef = useRef(0);

  useEffect(() => {
    streamRevisionRef.current = 0;
    streamActiveRef.current = false;
  }, [chatId]);

  const participantSpeakKey = useCallback((row: TelegramChatVoiceParticipant): string => {
    if (row.is_self) return "self";
    if (row.user_id != null && row.user_id > 0) return `u:${row.user_id}`;
    if (row.chat_id != null && row.chat_id !== 0) return `c:${row.chat_id}`;
    return `t:${row.title}`;
  }, []);

  const applySpeakingMap = useCallback(
    (rows: TelegramChatVoiceParticipant[]) => {
      // Speaking glow lives in speakingByKey so membership rows stay referentially
      // stable (tdesktop / Telegram Web parity). Keep hold short so mics clear.
      const now = Date.now();
      const holdMs = 2_400;
      let soonestExpiry = 0;
      const next: Record<string, true> = {};
      const joinedLocally = voiceJoinedRef.current;
      for (const row of rows) {
        const key = participantSpeakKey(row);
        // Local self: only RMS + live mic. TDLib often marks self speaking on join
        // while the mic is still muted — that painted a green ring incorrectly.
        if (key === "self" && joinedLocally) {
          if (micActiveRef.current && localSpeakingRef.current) {
            speakingHoldUntilRef.current.set(key, now + holdMs);
            next[key] = true;
          } else {
            speakingHoldUntilRef.current.delete(key);
          }
          continue;
        }
        if (row.is_speaking) {
          speakingHoldUntilRef.current.set(key, now + holdMs);
          next[key] = true;
          continue;
        }
        const until = speakingHoldUntilRef.current.get(key) ?? 0;
        if (until > now) {
          next[key] = true;
          if (soonestExpiry === 0 || until < soonestExpiry) soonestExpiry = until;
        } else {
          speakingHoldUntilRef.current.delete(key);
        }
      }
      // Partial SSE snapshots (recent_speakers, thin roster) omit people who are
      // still inside the speaking hold — never wipe them by replacing the map.
      for (const [key, until] of speakingHoldUntilRef.current.entries()) {
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
      speakingListedRef.current = rows.length;
      pendingSpeakingMapRef.current = next;
      if (speakingRafRef.current != null) return;
      const schedule =
        typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
      speakingRafRef.current = schedule(() => {
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
          if (nextKeys.length > 0) {
            logPageDisplay("messages_voice_roster_speaking_applied", {
              chatId,
              speakingCount: nextKeys.length,
              listed: speakingListedRef.current,
              applyMs: 0,
              popoverOpen: popoverOpenRef.current,
            });
          }
          return pending;
        });
      });
    },
    [chatId, participantSpeakKey],
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
      const withLocalSpeaking = incoming.map((row) => {
        if (!row.is_self || !joinedLocally) return row;
        return {
          ...row,
          // Never trust server speaking for the local row — join pulses green mic.
          is_speaking: Boolean(micActiveRef.current && localSpeakingRef.current),
          is_muted: !micActiveRef.current,
        };
      });
      // Speaking map updates separately — never rebuild membership for a mic pulse.
      applySpeakingMap(withLocalSpeaking);

      const prev = participantsRef.current;
      let next = withLocalSpeaking;
      if (joinedLocally && !next.some((row) => row.is_self)) {
        const prevSelf = prev.find((row) => row.is_self);
        next = [
          {
            user_id: prevSelf?.user_id ?? null,
            chat_id: prevSelf?.chat_id ?? null,
            title: prevSelf?.title?.trim() || selfTitleRef.current || "You",
            description: prevSelf?.description ?? "",
            emoji_status_custom_emoji_id: prevSelf?.emoji_status_custom_emoji_id ?? null,
            is_speaking: false,
            is_muted: !micActiveRef.current,
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
          hint > 0
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
      // is still 4–5. Never replace a fuller roster with that subset. When the
      // payload grows the roster, take it as membership (merge path starting from
      // a listed=1 prev left green-mic keys with nobody rendered).
      const growsRoster = next.length > prev.length;
      const looksLikeRecentSpeakersOnly =
        !growsRoster &&
        next.length > 0 &&
        (hint === 0 || hint > next.length) &&
        (options?.preferMerge ||
          (next.length <= 3 && prev.length > next.length) ||
          (hint > next.length && prev.length >= next.length && prev.length > 0));
      if (looksLikeRecentSpeakersOnly) {
        const merged = prev.map((row) => {
          const inc = nextByKey.get(speakKey(row));
          if (!inc) return row;
          const nextMuted = Boolean(inc.is_muted);
          const nextTitle = inc.title.trim() || row.title;
          const nextDescription = inc.description || row.description;
          const nextEmoji =
            inc.emoji_status_custom_emoji_id ?? row.emoji_status_custom_emoji_id;
          const nextVideo = inc.video_info ?? row.video_info ?? null;
          const nextScreen =
            inc.screen_sharing_video_info ?? row.screen_sharing_video_info ?? null;
          if (
            Boolean(row.is_muted) === nextMuted &&
            row.title === nextTitle &&
            row.description === nextDescription &&
            row.emoji_status_custom_emoji_id === nextEmoji &&
            (row.video_info?.endpoint_id ?? "") === (nextVideo?.endpoint_id ?? "") &&
            (row.screen_sharing_video_info?.endpoint_id ?? "") ===
              (nextScreen?.endpoint_id ?? "")
          ) {
            return row;
          }
          return {
            ...row,
            is_muted: nextMuted,
            title: nextTitle,
            description: nextDescription,
            emoji_status_custom_emoji_id: nextEmoji,
            video_info: nextVideo,
            screen_sharing_video_info: nextScreen,
          };
        });
        for (const inc of next) {
          if (!prevByKey.has(speakKey(inc))) {
            // Untitled soft stubs must not grow the roster past TDLib's count —
            // that painted "+1 / 4 participants" for a 3-person call.
            if (hint >= 2 && merged.length >= hint) continue;
            if (!inc.title.trim() && hint > 0 && merged.length >= hint) continue;
            merged.push({ ...inc, is_speaking: false });
          }
        }
        next = merged;
      } else {
        next = next.map((row) => {
          const prevMatch = prevByKey.get(speakKey(row));
          const title = row.title.trim() || prevMatch?.title || "";
          const description = row.description || prevMatch?.description || "";
          const emoji =
            row.emoji_status_custom_emoji_id ??
            prevMatch?.emoji_status_custom_emoji_id ??
            null;
          const video = row.video_info ?? prevMatch?.video_info ?? null;
          const screen =
            row.screen_sharing_video_info ??
            prevMatch?.screen_sharing_video_info ??
            null;
          if (
            prevMatch &&
            prevMatch.user_id === row.user_id &&
            prevMatch.chat_id === row.chat_id &&
            prevMatch.title === title &&
            prevMatch.description === description &&
            prevMatch.emoji_status_custom_emoji_id === emoji &&
            Boolean(prevMatch.is_muted) === Boolean(row.is_muted) &&
            Boolean(prevMatch.is_self) === Boolean(row.is_self) &&
            (prevMatch.video_info?.endpoint_id ?? "") === (video?.endpoint_id ?? "") &&
            (prevMatch.screen_sharing_video_info?.endpoint_id ?? "") ===
              (screen?.endpoint_id ?? "")
          ) {
            return prevMatch;
          }
          return {
            ...row,
            is_speaking: false,
            title,
            description,
            emoji_status_custom_emoji_id: emoji,
            video_info: video,
            screen_sharing_video_info: screen,
          };
        });
        // Server soft payloads can still arrive oversized before the gateway
        // trim lands — keep the painted roster at the TDLib floor.
        if (hint >= 2 && next.length > hint) {
          const ranked = [...next].sort((a, b) => {
            const score = (row: TelegramChatVoiceParticipant) =>
              (row.screen_sharing_video_info?.source_groups?.length ? 8 : 0) +
              (row.video_info?.source_groups?.length ? 4 : 0) +
              (row.title.trim() ? 4 : 0) +
              (row.is_self ? 2 : 0) +
              (row.is_speaking ? 1 : 0);
            return score(b) - score(a);
          });
          next = ranked.slice(0, hint);
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

      // Keep a TDLib floor for the strip label / reload. Follow the live server
      // hint when present — do not let ghost soft-merge rows raise it via
      // next.length (listed=3 totalHint=4 with "?" titles).
      const totalHint =
        hint > 0
          ? hint
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
          popoverOpen: popoverOpenRef.current,
          titles: next.slice(0, 4).map((row) => row.title || "?"),
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
    [applySpeakingMap, chatId, participantSpeakKey, participantsEqual],
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
    const live = syncVoicePresence(
      chatId,
      true,
      snapshot.group_call_id,
      snapshot.participants,
      snapshot.participant_count,
      { allowClear: false },
    );
    if (!live && snapshot.participants.length === 0 && !voiceJoinedRef.current) return;

    const applyRows = (rows: TelegramChatVoiceParticipant[], countHint: number) => {
      // SSE payloads are often recent-speakers-only; merge so we never drop a
      // fuller roster that force-reload already painted.
      const prevListed = participantsRef.current.length;
      if (
        popoverOpenRef.current &&
        prevListed > 0 &&
        rows.length > 0 &&
        rows.length < prevListed &&
        countHint >= prevListed
      ) {
        logPageDisplay("messages_voice_dialog_sse_skip_thin", {
          chatId,
          listed: rows.length,
          prevListed,
          hint: countHint,
        });
        return;
      }
      applyRosterRows(rows, countHint, {
        preferMerge: true,
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
  }, [applyRosterRows, applySpeakingMap, cancelStreamRosterFlush, chatId, syncVoicePresence]);

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
      pendingStreamSnapRef.current = snapshot;
      const listed = participantsRef.current.length;
      const hint = Math.max(rosterTotalHintRef.current, snapshot.participant_count);
      const expandsRoster = snapshot.participants.length > listed;
      const fillsTitles =
        snapshot.participants.some((row) => Boolean(row.title.trim())) &&
        participantsRef.current.some((row) => !row.title.trim() && !row.is_self);
      const rosterThin = hint > listed || expandsRoster || fillsTitles;
      // Expanding the painted roster mid-SDP (listed 3→7 during join_attempt) caused
      // voice_dialog_longtask / stuck UI. Keep speaking live; defer membership until
      // WebRTC is up (or Join was never armed).
      const joinBusy =
        voiceSessionJoiningRef.current ||
        voiceSessionNegotiatingRef.current ||
        (voiceJoinedRef.current &&
          !voiceSessionJoinedRef.current &&
          joinAttemptsRef.current < 3);
      if ((expandsRoster || fillsTitles) && !joinBusy) {
        cancelStreamRosterFlush();
        flushPendingStreamSnap();
        return;
      }
      if ((expandsRoster || fillsTitles) && joinBusy) {
        if (streamApplyTimerRef.current != null) return;
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
    [applySpeakingMap, cancelStreamRosterFlush, flushPendingStreamSnap],
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
        // Dead / missing call — always drop the strip, even if a stale SSE painted
        // rows before the soft poll finished (false preview on chats with no call).
        if (!result.has_active_voice_chat && !voiceJoinedRef.current) {
          setParticipants([]);
          setParticipantCount(0);
          rosterTotalHintRef.current = 0;
          rosterCountHintStateRef.current = 0;
          setRosterCountHint(0);
          setPresenceConfirmed(false);
          return "ok";
        }
        // Always paint rows when TDLib returned any participants — countHint of 0
        // used to leave the strip empty despite a real self/other roster.
        if (result.participants.length > 0 || live || voiceJoinedRef.current) {
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

  // Ask the SFU for any remote camera / screencast publishers listed in the roster.
  const setRemoteVideoRequests = voiceSession.setRemoteVideoRequests;
  const voiceJoined = voiceSession.joined;
  const remoteVideoSourceKey = useMemo(() => {
    return participants
      .filter((row) => !row.is_self)
      .map(
        (row) =>
          `${row.user_id ?? row.chat_id}:${row.video_info?.endpoint_id ?? ""}:${row.screen_sharing_video_info?.endpoint_id ?? ""}`,
      )
      .join("|");
  }, [participants]);
  useEffect(() => {
    if (!voiceJoined || Platform.OS !== "web") {
      setRemoteVideoRequests([]);
      return;
    }
    // Defer publisher renegotiation until after join SDP/ICE settle — running
    // createOffer in the same window as join_ok froze the dialog hard.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const requests: Array<{
        endpointId: string;
        kind: "camera" | "screen";
        ssrcGroups: Array<{ semantics: string; sourceIds: number[] }>;
      }> = [];
      for (const row of participantsRef.current) {
        if (row.is_self) continue;
        const screen = row.screen_sharing_video_info;
        if (screen?.source_groups?.length) {
          requests.push({
            endpointId: screen.endpoint_id || `screen-${row.user_id ?? row.chat_id ?? "x"}`,
            kind: "screen",
            ssrcGroups: screen.source_groups.map((g) => ({
              semantics: g.semantics,
              sourceIds: g.source_ids,
            })),
          });
        }
        const camera = row.video_info;
        if (camera?.source_groups?.length) {
          requests.push({
            endpointId: camera.endpoint_id || `cam-${row.user_id ?? row.chat_id ?? "x"}`,
            kind: "camera",
            ssrcGroups: camera.source_groups.map((g) => ({
              semantics: g.semantics,
              sourceIds: g.source_ids,
            })),
          });
        }
      }
      // Prefer screencasts first (tdesktop docks presentation above camera).
      requests.sort((a, b) => {
        if (a.kind === b.kind) return 0;
        return a.kind === "screen" ? -1 : 1;
      });
      setRemoteVideoRequests(requests.slice(0, 4));
      logPageDisplay("messages_voice_remote_video_requests", {
        chatId,
        count: requests.length,
        kinds: requests.map((r) => r.kind),
        endpoints: requests.map((r) => r.endpointId).slice(0, 4),
        listed: participantsRef.current.length,
        hint: rosterTotalHintRef.current,
        level: requests.length > 0 ? "info" : "warn",
        note:
          requests.length > 0
            ? undefined
            : "no screen/camera source_groups on roster — force-reload may still be pending",
      });
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatId, remoteVideoSourceKey, setRemoteVideoRequests, voiceJoined]);

  const displayParticipants = useMemo(() => {
    return participants.map((row) => {
      const key = participantSpeakKey(row);
      const speaking = Boolean(speakingByKey[key]);
      return speaking === Boolean(row.is_speaking)
        ? row
        : { ...row, is_speaking: speaking };
    });
  }, [participantSpeakKey, participants, speakingByKey]);

  const resolveParticipantSpeaking = useCallback(
    (row: TelegramChatVoiceParticipant) => {
      const key = participantSpeakKey(row);
      return Boolean(speakingByKey[key] || row.is_speaking);
    },
    [participantSpeakKey, speakingByKey],
  );

  // Opening the sheet: paint first, then load roster. Do NOT wait for WebRTC
  // `joined` — that delayed the first reload until after SDP and left the sheet
  // on a single grey row while speaking updates had nobody to light up.
  const applyRosterRowsRef = useRef(applyRosterRows);
  applyRosterRowsRef.current = applyRosterRows;

  const rosterIncomplete = useCallback(() => {
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
    const emptyTitles = participantsRef.current.filter(
      (row) => !row.title.trim() && !row.is_self,
    ).length;
    if (emptyTitles > 0 && emptyTitles >= Math.ceil(listed / 2)) return true;
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
      if (meta?.loadedAll) {
        postJoinRosterLoadedRef.current = true;
        return true;
      }
      if (meta?.hasHiddenListeners && listed >= 1) {
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
          logPageDisplay("messages_voice_dialog_postjoin_reload_ok", {
            chatId,
            listed,
            count: listed,
            hint,
            attempt: 0,
            fetched: result.participants.length,
            loadedAll: result.loaded_all_participants,
            hasHidden: result.has_hidden_listeners,
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
    // Telegram Web: one load after join, then update stream — not N force GETs.
    const maxAttempts = 2;
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
          logPageDisplay("messages_voice_dialog_postjoin_reload_ok", {
            chatId,
            listed,
            count: listed,
            hint,
            attempt: attempts,
            fetched: result.participants.length,
            loadedAll: result.loaded_all_participants,
            hasHidden: result.has_hidden_listeners,
          });
          if (
            markPostJoinRosterComplete(listed, hint, {
              loadedAll: result.loaded_all_participants,
              hasHiddenListeners: result.has_hidden_listeners,
            })
          ) {
            return;
          }
          // No growth after a joined force — accept the visible roster (even
          // listed=1). Hint often includes hidden listeners Telegram never lists.
          if (listed >= 1 && listed === lastForceListed) {
            postJoinRosterLoadedRef.current = true;
            logPageDisplay("messages_voice_dialog_postjoin_reload_accept_visible", {
              chatId,
              listed,
              hint,
              attempt: attempts,
              level: "info",
            });
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
    // Start mic during the click gesture so default-unmute after join_ok does not
    // block on a permission prompt (and freezes less after SDP).
    voiceSession.prefetchMic();
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
        onClosePopover();
        onLeftVoice?.();
        const live = Boolean(result.has_active_voice_chat);
        setPresenceConfirmed(live);
        patchAuthenticatedHomeSelectedChatVoice(chatId, {
          has_active_voice_chat: live,
          voice_chat_group_call_id: live ? result.voice_chat_group_call_id : null,
        });
      } else {
        appWarn("[message-voice-leave]", result.error, { chatId, groupCallId });
      }
    } finally {
      setLeaving(false);
    }
  }, [chatId, groupCallId, joined, leaving, onClosePopover, onLeftVoice, voiceSession]);

  const onDropFromPopover = useCallback(async () => {
    if (leaving || !joined) return;
    setLeaving(true);
    try {
      const result = await voiceSession.leaveVoice();
      if (result.ok) {
        onClosePopover();
        onLeftVoice?.();
        const live = Boolean(result.has_active_voice_chat);
        setPresenceConfirmed(live);
        patchAuthenticatedHomeSelectedChatVoice(chatId, {
          has_active_voice_chat: live,
          voice_chat_group_call_id: live ? result.voice_chat_group_call_id : null,
        });
      } else {
        appWarn("[message-voice-leave]", result.error, { chatId, groupCallId });
      }
    } finally {
      setLeaving(false);
    }
  }, [chatId, groupCallId, joined, leaving, onClosePopover, onLeftVoice, voiceSession]);

  const onMicPress = useCallback(() => {
    if (!joined) {
      // If the popover is already open, a join arm-timer is already pending —
      // do not fire a second join (which would re-open the dialog / call onJoin
      // again and generate a spurious messages_voice_join_start log).
      if (popoverOpenRef.current) return;
      unlockThenJoin();
      return;
    }
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
    if (!joined) {
      if (popoverOpenRef.current) return;
      unlockThenJoin();
      return;
    }
    void voiceSession.startScreenShare();
  }, [joined, unlockThenJoin, voiceSession]);

  const onStopScreenShare = useCallback(() => {
    void voiceSession.stopScreenShare();
  }, [voiceSession]);

  const showStrip = Boolean(joined || presenceConfirmed);

  // Freeze detector: logs longtask + rAF stalls to [page-display] while the
  // dialog is open or a WebRTC join is in progress — the freeze usually happens
  // during getUserMedia / SDP negotiation right after the user presses Join.
  // Freeze detector: only while the sheet is open — joining after Close must
  // not keep rAF monitors attributing WebRTC work to the dialog.
  useVoiceDialogFreezeDetector(popoverOpen);

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
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  height: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
                  flexShrink: 0,
                }}
              >
                {stackedParticipants.map((participant, index) => {
                  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
                  const participantTitle = participant.title.trim() || "?";
                  const speaking = Boolean(
                    speakingByKey[participantSpeakKey(participant)] ||
                      participant.is_speaking,
                  );
                  const avatarPx = MESSAGE_CHAT_VOICE_BAR_AVATAR_PX;
                  return (
                    <View
                      key={
                        participant.user_id != null
                          ? `u:${participant.user_id}`
                          : `c:${participant.chat_id}`
                      }
                      style={{
                        marginLeft: index === 0 ? 0 : -MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_OVERLAP_PX,
                        zIndex: stackedParticipants.length - index,
                        width: avatarPx,
                        height: avatarPx,
                        borderRadius: avatarPx / 2,
                        // Ring outside the clipped avatar so speaking stays visible.
                        boxSizing: "border-box" as const,
                        borderWidth: speaking ? 2 : 0,
                        borderColor: "#34C759",
                        backgroundColor: colors.background,
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                      }}
                    >
                      <MessageChatAvatarSlot
                        iconUrl={avatarUrl}
                        initials={extractChatAvatarInitials(participantTitle)}
                        sizePx={avatarPx}
                        colors={colors}
                        scheme={colorScheme}
                        fetchPriority="high"
                      />
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
      <MessageChatVoiceVideoPlane
        stream={voiceSession.remoteVideoStream}
        active={Boolean(joined && voiceSession.joined && visible && !popoverOpen && showStrip)}
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
        onDropPress={() => void onDropFromPopover()}
        dropLeaving={leaving}
        remoteVideoStream={voiceSession.remoteVideoStream}
        localCameraStream={voiceSession.localCameraStream}
        localScreenStream={voiceSession.localScreenStream}
        videoActive={Boolean(joined && voiceSession.joined && visible)}
      />
    </>
  );
}
