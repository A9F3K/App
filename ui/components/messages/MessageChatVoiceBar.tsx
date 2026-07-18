import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
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
import {
  MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
  MESSAGE_CHAT_VOICE_BAR_AVATAR_STACK_OVERLAP_PX,
  MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX,
  MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS,
} from "./messageListLayout";

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
  onJoin: () => void;
  onOpenPopover: () => void;
  onClosePopover: () => void;
  /** Called after a successful leave so the parent can show Join again. */
  onLeftVoice?: () => void;
};

/**
 * Under-header strip for an active chat voice.
 * Shows participant avatars while a call is live. WebRTC starts only after
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
  onJoin,
  onOpenPopover,
  onClosePopover,
  onLeftVoice,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { colorScheme, displayName, telegramUsername } = useTelegram();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const [leaving, setLeaving] = useState(false);
  const [participants, setParticipants] = useState<TelegramChatVoiceParticipant[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  /** Hide the empty strip until a poll/SSE proves real (non-self) presence. */
  const [presenceConfirmed, setPresenceConfirmed] = useState(false);
  const stripPaddingX = layout.contentSideInsetPx;
  const totalParticipantCount = Math.max(participantCount, participants.length);
  // Speakers first in the strip so the active talker isn't buried behind self/+N.
  const stackedParticipants = [...participants]
    .sort((a, b) => {
      if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
      if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
      return 0;
    })
    .slice(0, MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS);
  const overflowCount = Math.max(0, totalParticipantCount - stackedParticipants.length);
  const participantsA11yLabel =
    totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(locale === "ru" ? "ru-RU" : "en-US"),
        })
      : t("messages.voiceChat.participants");

  const voiceJoinedRef = useRef(false);
  voiceJoinedRef.current = Boolean(joined);
  const popoverOpenRef = useRef(false);
  popoverOpenRef.current = Boolean(popoverOpen);

  const syncVoicePresence = useCallback(
    (
      hasActive: boolean,
      callId: number | null | undefined,
      rows: TelegramChatVoiceParticipant[],
      countHint: number,
      options?: { allowClear?: boolean },
    ) => {
      const nonSelf = rows.filter((row) => !row.is_self);
      const live =
        Boolean(hasActive) &&
        (Math.max(0, countHint) > 0 || nonSelf.length > 0);

      if (voiceJoinedRef.current) {
        setPresenceConfirmed(true);
        if (live) {
          patchAuthenticatedHomeSelectedChatVoice({
            has_active_voice_chat: true,
            voice_chat_group_call_id: callId ?? null,
          });
        }
        return true;
      }

      if (live) {
        setPresenceConfirmed(true);
        patchAuthenticatedHomeSelectedChatVoice({
          has_active_voice_chat: true,
          voice_chat_group_call_id: callId ?? null,
        });
        return true;
      }

      // SSE thin/empty snapshots must not clear presence — that remounted the bar
      // in a loop with the HTTP poll and froze the page ("Page Unresponsive").
      if (!options?.allowClear) return false;

      setPresenceConfirmed(false);
      patchAuthenticatedHomeSelectedChatVoice({
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

  // Join only after the user presses Join — never auto-join on chat preview open.
  // Cap retries so a flaky ICE path cannot re-offer SDP forever and freeze the UI.
  const joinAttemptsRef = useRef(0);
  useEffect(() => {
    if (!joined) {
      joinAttemptsRef.current = 0;
      return;
    }
    if (!isTelegramMessagesConnected) return;
    if (voiceSession.joining || voiceSession.negotiating || voiceSession.joined) return;
    if (joinAttemptsRef.current >= 3) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const tryJoin = async () => {
      if (cancelled || inFlight) return;
      if (joinAttemptsRef.current >= 3) return;
      inFlight = true;
      joinAttemptsRef.current += 1;
      unlockVoiceAutoplay();
      unlockAudioRef.current();
      const ok = await joinListenRef.current();
      inFlight = false;
      if (cancelled || ok) return;
      const attempt = joinAttemptsRef.current;
      const delayMs = Math.min(2000 * 2 ** Math.min(attempt - 1, 2), 12_000);
      timer = setTimeout(() => {
        void tryJoin();
      }, delayMs);
    };

    void tryJoin();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    joined,
    isTelegramMessagesConnected,
    voiceSession.joined,
    voiceSession.negotiating,
    voiceSession.joining,
    chatId,
    groupCallId,
  ]);

  useEffect(() => {
    setParticipants([]);
    setParticipantCount(0);
    setPresenceConfirmed(false);
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
          Boolean(left.is_speaking) !== Boolean(right.is_speaking) ||
          Boolean(left.is_muted) !== Boolean(right.is_muted) ||
          Boolean(left.is_self) !== Boolean(right.is_self)
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

  const participantSpeakKey = useCallback((row: TelegramChatVoiceParticipant): string => {
    if (row.is_self) return "self";
    if (row.user_id != null && row.user_id > 0) return `u:${row.user_id}`;
    if (row.chat_id != null && row.chat_id !== 0) return `c:${row.chat_id}`;
    return `t:${row.title}`;
  }, []);

  const applySpeakingHold = useCallback(
    (rows: TelegramChatVoiceParticipant[]): TelegramChatVoiceParticipant[] => {
      // Keep a short hold so brief speaking pulses remain visible whether they
      // arrived via SSE or the safety poll (SSE can miss sub-debounce flashes).
      const now = Date.now();
      const holdMs = 1_200;
      let soonestExpiry = 0;
      const next = rows.map((row) => {
        const key = participantSpeakKey(row);
        if (row.is_speaking) {
          speakingHoldUntilRef.current.set(key, now + holdMs);
          return row;
        }
        const until = speakingHoldUntilRef.current.get(key) ?? 0;
        if (until > now) {
          if (soonestExpiry === 0 || until < soonestExpiry) soonestExpiry = until;
          return { ...row, is_speaking: true };
        }
        speakingHoldUntilRef.current.delete(key);
        return row;
      });
      if (speakingHoldTimerRef.current) {
        clearTimeout(speakingHoldTimerRef.current);
        speakingHoldTimerRef.current = null;
      }
      if (soonestExpiry > now) {
        speakingHoldTimerRef.current = setTimeout(() => {
          speakingHoldTimerRef.current = null;
          const expiredAt = Date.now();
          setParticipants((prev) => {
            let changed = false;
            const cleared = prev.map((row) => {
              const key = participantSpeakKey(row);
              const until = speakingHoldUntilRef.current.get(key) ?? 0;
              if (until > 0 && until <= expiredAt) {
                speakingHoldUntilRef.current.delete(key);
                if (row.is_speaking) {
                  changed = true;
                  return { ...row, is_speaking: false };
                }
              }
              return row;
            });
            return changed ? cleared : prev;
          });
        }, soonestExpiry - now + 16);
      }
      return next;
    },
    [participantSpeakKey],
  );

  const applyRosterRows = useCallback(
    (incoming: TelegramChatVoiceParticipant[], countHint: number) => {
      const applyStarted =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      const joinedLocally = voiceJoinedRef.current;
      // Presence can include self when TDLib still has a stale join from a prior
      // session. Only show "You" after an explicit Join in this UI — never auto-leave
      // on open (that raced Join and hung the gateway → stuck voice UI).
      const base = joinedLocally ? incoming : incoming.filter((row) => !row.is_self);
      const hadServerSelf = incoming.some((row) => row.is_self);
      const withLocalSpeaking = base.map((row) => {
        if (!row.is_self) return row;
        return {
          ...row,
          is_speaking: localSpeakingRef.current ? true : row.is_speaking,
          is_muted: !micActiveRef.current,
        };
      });
      // Speaking must paint synchronously — startTransition deferred greens and a
      // missing import threw ReferenceError on every roster tick (UI freeze).
      setParticipants((prev) => {
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
              is_speaking: localSpeakingRef.current,
              is_muted: !micActiveRef.current,
              is_self: true,
            },
            ...next,
          ];
        }

        const speakKey = participantSpeakKey;
        const prevByKey = new Map(prev.map((row) => [speakKey(row), row]));
        const nextByKey = new Map(next.map((row) => [speakKey(row), row]));

        // Thin recent-speakers snapshots (≤3) must not wipe a richer joined roster —
        // only overlay speaking/mute. Full/near-full snapshots REPLACE so leavers
        // disappear (the old merge-grow path kept ghosts forever).
        const hint = Math.max(0, countHint);
        const looksLikeRecentSpeakersOnly =
          next.length > 0 &&
          next.length <= 3 &&
          prev.length > next.length &&
          (hint === 0 || hint > Math.max(next.length, 3));
        if (looksLikeRecentSpeakersOnly) {
          const merged = prev.map((row) => {
            const inc = nextByKey.get(speakKey(row));
            if (!inc) return row;
            return {
              ...row,
              is_speaking: inc.is_speaking,
              is_muted: inc.is_muted,
              title: inc.title.trim() || row.title,
              description: inc.description || row.description,
              emoji_status_custom_emoji_id:
                inc.emoji_status_custom_emoji_id ?? row.emoji_status_custom_emoji_id,
            };
          });
          for (const inc of next) {
            if (!prevByKey.has(speakKey(inc))) merged.push(inc);
          }
          next = merged;
        } else {
          // Prefer richer titles from previous poll when SSE snapshot titles are empty.
          next = next.map((row) => {
            if (row.title.trim()) return row;
            const prevMatch = prevByKey.get(speakKey(row));
            if (!prevMatch?.title.trim()) return row;
            return {
              ...row,
              title: prevMatch.title,
              description: row.description || prevMatch.description,
              emoji_status_custom_emoji_id:
                row.emoji_status_custom_emoji_id ?? prevMatch.emoji_status_custom_emoji_id,
            };
          });
        }

        next = [...next].sort((a, b) => {
          // Active speakers always float to the top of the voice dialog.
          if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
          if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        });
        next = applySpeakingHold(next);
        // Re-sort after hold so briefly-held speakers stay pinned at the top.
        next = [...next].sort((a, b) => {
          if (a.is_speaking !== b.is_speaking) return a.is_speaking ? -1 : 1;
          if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        });
        const speakingCount = next.filter((row) => row.is_speaking).length;
        const applyMs = Math.round(
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now() - applyStarted
            : 0,
        );
        if (speakingCount > 0 && speakingCount !== prev.filter((row) => row.is_speaking).length) {
          logPageDisplay("messages_voice_roster_speaking_applied", {
            chatId,
            speakingCount,
            listed: next.length,
            applyMs,
            popoverOpen: popoverOpenRef.current,
          });
        }
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
        return participantsEqual(prev, next) ? prev : next;
      });
      setParticipantCount((prev) => {
        // Prefer TDLib participant_count. Only fall back to listed length when
        // the server did not send a count (never inflate above Telegram).
        const hint = joinedLocally
          ? countHint
          : Math.max(0, countHint - (hadServerSelf ? 1 : 0));
        const nextCount =
          hint > 0
            ? hint
            : Math.max(withLocalSpeaking.length, joinedLocally ? 1 : 0);
        return prev === nextCount ? prev : nextCount;
      });
    },
    [applySpeakingHold, chatId, participantSpeakKey, participantsEqual],
  );

  const pendingStreamSnapRef = useRef<VoiceParticipantsStreamSnapshot | null>(null);
  const streamApplyRafRef = useRef<number | null>(null);

  const flushPendingStreamSnap = useCallback(() => {
    streamApplyRafRef.current = null;
    const snapshot = pendingStreamSnapRef.current;
    pendingStreamSnapRef.current = null;
    if (!snapshot) return;
    const live = syncVoicePresence(
      true,
      snapshot.group_call_id,
      snapshot.participants,
      snapshot.participant_count,
      { allowClear: false },
    );
    if (!live && snapshot.participants.length === 0 && !voiceJoinedRef.current) return;
    if (popoverOpenRef.current) {
      logPageDisplay("messages_voice_dialog_sse_apply", {
        chatId,
        revision: snapshot.revision,
        listed: snapshot.participants.length,
        speakingCount: snapshot.participants.filter((p) => p.is_speaking).length,
      });
    }
    applyRosterRows(snapshot.participants, snapshot.participant_count);
  }, [applyRosterRows, chatId, syncVoicePresence]);

  const onStreamParticipants = useCallback(
    (snapshot: VoiceParticipantsStreamSnapshot) => {
      // Pending stream (no call resolved yet) — ignore; never treat as "call ended".
      if (snapshot.group_call_id == null) {
        streamRevisionRef.current = Math.max(streamRevisionRef.current, snapshot.revision);
        return;
      }
      streamRevisionRef.current = Math.max(streamRevisionRef.current, snapshot.revision);
      // Coalesce SSE floods to one React apply per frame while the dialog is open —
      // speaking updates can arrive every ~100ms and were freezing the page.
      pendingStreamSnapRef.current = snapshot;
      if (popoverOpenRef.current && typeof window !== "undefined") {
        if (streamApplyRafRef.current == null) {
          streamApplyRafRef.current = window.requestAnimationFrame(() => {
            flushPendingStreamSnap();
          });
        }
        return;
      }
      flushPendingStreamSnap();
    },
    [flushPendingStreamSnap],
  );

  useEffect(() => {
    return () => {
      if (streamApplyRafRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame(streamApplyRafRef.current);
        streamApplyRafRef.current = null;
      }
    };
  }, []);

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
    try {
      const result = await fetchTelegramChatVoiceParticipants(chatId, null);
      if (result.ok) {
        const live = syncVoicePresence(
          result.has_active_voice_chat,
          result.voice_chat_group_call_id,
          result.participants,
          result.participant_count,
          { allowClear: true },
        );
        if (live || voiceJoinedRef.current) {
          applyRosterRows(result.participants, result.participant_count);
        } else {
          setParticipants([]);
          setParticipantCount(0);
        }
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
  }, [applyRosterRows, chatId, groupCallId, isTelegramMessagesConnected, syncVoicePresence]);

  useEffect(() => {
    setParticipants((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (!row.is_self) return row;
        const isSpeaking = voiceSession.localSpeaking;
        const isMuted = !voiceSession.micActive;
        if (row.is_speaking === isSpeaking && row.is_muted === isMuted) return row;
        changed = true;
        return { ...row, is_speaking: isSpeaking, is_muted: isMuted };
      });
      if (!changed) return prev;
      return applySpeakingHold(next);
    });
  }, [applySpeakingHold, voiceSession.localSpeaking, voiceSession.micActive]);

  // As soon as we join, show self immediately — don't wait for the first poll
  // (solo muted calls often come back empty until TDLib catches up).
  // When not joined, strip any stale self row from a prior TDLib session.
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
          is_speaking: localSpeakingRef.current,
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
      if (!visible) return 12_000;
      if (joined) {
        if (sheetOpen) return streamActiveRef.current ? 4_500 : 2_500;
        return 1_200;
      }
      return sheetOpen ? 3_000 : streamActiveRef.current ? 3_000 : 5_000;
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
  useEffect(() => {
    if (!voiceSession.joined) return;
    void refreshParticipantsRef.current();
  }, [voiceSession.joined]);

  // Opening the sheet: ask the gateway to refill beyond recent_speakers once.
  const applyRosterRowsRef = useRef(applyRosterRows);
  applyRosterRowsRef.current = applyRosterRows;
  useEffect(() => {
    if (!popoverOpen || !joined) return;
    if (!isTelegramMessagesConnected) return;
    let cancelled = false;
    const openedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    logPageDisplay("messages_voice_dialog_open", {
      chatId,
      groupCallId,
    });
    void (async () => {
      try {
        const result = await fetchTelegramChatVoiceParticipants(chatId, null, {
          forceReload: true,
        });
        if (cancelled || !result.ok) return;
        applyRosterRowsRef.current(result.participants, result.participant_count);
        logPageDisplay("messages_voice_dialog_force_reload_ok", {
          chatId,
          listed: result.participants.length,
          count: result.participant_count,
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
      logPageDisplay("messages_voice_dialog_close", { chatId });
    };
  }, [popoverOpen, joined, chatId, isTelegramMessagesConnected, groupCallId]);

  const unlockThenJoin = useCallback(() => {
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
    onJoin();
  }, [onJoin, voiceSession]);

  const handleStripPress = useCallback(() => {
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
    if (!joined) {
      // Parent joinVoice opens the participant sheet with the same gesture.
      unlockThenJoin();
      return;
    }
    onOpenPopover();
  }, [joined, unlockThenJoin, onOpenPopover, voiceSession]);

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
        patchAuthenticatedHomeSelectedChatVoice({
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
        patchAuthenticatedHomeSelectedChatVoice({
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
      unlockThenJoin();
      return;
    }
    void voiceSession.toggleMic();
  }, [joined, unlockThenJoin, voiceSession]);

  const showStrip = Boolean(joined || presenceConfirmed);

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
                  const speaking = Boolean(participant.is_speaking);
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
                        sizePx={speaking ? avatarPx - 4 : avatarPx}
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
            </View>
          ) : null}
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
        visible={popoverOpen && joined}
        onClose={onClosePopover}
        title={title}
        participantCount={totalParticipantCount}
        participants={participants}
        colors={colors}
        micActive={voiceSession.micActive}
        micJoining={voiceSession.joining}
        onMicPress={() => void onMicPress()}
        onDropPress={() => void onDropFromPopover()}
        dropLeaving={leaving}
        remoteVideoStream={voiceSession.remoteVideoStream}
        videoActive={Boolean(joined && voiceSession.joined && visible)}
      />
    </>
  );
}
