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
import { useTelegram } from "../Telegram";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import {
  MessageChatLeaveVoiceIcon,
  MessageChatMicIcon,
} from "./MessageChatVoiceIcons";
import { MessageChatVoicePopover } from "./MessageChatVoicePopover";
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
  popoverOpen: boolean;
  onJoin: () => void;
  onOpenPopover: () => void;
  onClosePopover: () => void;
  /** Called after a successful leave so the parent can show Join again. */
  onLeftVoice?: () => void;
};

/**
 * Under-header strip for an active chat voice.
 * Shows participant avatars while a call is live; WebRTC starts when `joined`
 * (auto listen-only on chat enter, or after an explicit Join).
 */
export function MessageChatVoiceBar({
  chatId,
  groupCallId,
  title,
  colors,
  joined,
  popoverOpen,
  onJoin,
  onOpenPopover,
  onClosePopover,
  onLeftVoice,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const { colorScheme } = useTelegram();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const [leaving, setLeaving] = useState(false);
  const [participants, setParticipants] = useState<TelegramChatVoiceParticipant[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  const stripPaddingX = layout.contentSideInsetPx;
  const totalParticipantCount = Math.max(participantCount, participants.length);
  const stackedParticipants = participants.slice(0, MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS);
  const overflowCount = Math.max(0, totalParticipantCount - stackedParticipants.length);
  const participantsA11yLabel =
    totalParticipantCount > 0
      ? tf("messages.chatMemberCount.participants", {
          count: totalParticipantCount.toLocaleString(locale === "ru" ? "ru-RU" : "en-US"),
        })
      : t("messages.voiceChat.participants");

  // Keep the WebRTC shell mounted with the bar so Join can unlock the real
  // remote <audio> / AudioContext during a user gesture (before join completes).
  const voiceSession = useTelegramVoiceSession({
    chatId,
    groupCallId,
    active: Platform.OS === "web",
  });
  const localSpeakingRef = useRef(voiceSession.localSpeaking);
  localSpeakingRef.current = voiceSession.localSpeaking;
  const joinListenRef = useRef(voiceSession.joinListen);
  joinListenRef.current = voiceSession.joinListen;
  const unlockAudioRef = useRef(voiceSession.unlockAudio);
  unlockAudioRef.current = voiceSession.unlockAudio;

  // Listen-only join: retry after TDLib reconnect / failed join / call-id refresh.
  // Parent `joined` stays true after a failed attempt, so we must not depend on it alone.
  // Do not depend on `joining` — that would cancel backoff and spin the effect.
  useEffect(() => {
    if (!joined || !isTelegramMessagesConnected) return;
    if (voiceSession.joined) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let inFlight = false;

    const tryJoin = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      unlockVoiceAutoplay();
      unlockAudioRef.current();
      const ok = await joinListenRef.current();
      inFlight = false;
      if (cancelled || ok) return;
      attempt += 1;
      const delayMs = Math.min(1500 * 2 ** Math.min(attempt - 1, 2), 8000);
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
    chatId,
    groupCallId,
  ]);

  useEffect(() => {
    setParticipants([]);
    setParticipantCount(0);
  }, [chatId, groupCallId]);

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
          Boolean(left.is_self) !== Boolean(right.is_self)
        ) {
          return false;
        }
      }
      return true;
    },
    [],
  );

  const voiceJoinedRef = useRef(false);
  voiceJoinedRef.current = Boolean(joined || voiceSession.joined);

  const refreshParticipants = useCallback(async (): Promise<"ok" | "retry_soon" | "backoff"> => {
    if (!isTelegramMessagesConnected) return "backoff";
    try {
      const result = await fetchTelegramChatVoiceParticipants(chatId, groupCallId);
      if (result.ok) {
        const withLocalSpeaking = result.participants.map((row) =>
          row.is_self && localSpeakingRef.current
            ? { ...row, is_speaking: true }
            : row,
        );
        setParticipants((prev) => {
          let next = withLocalSpeaking;
          // Keep local self visible across polls that omit muted/hidden listeners.
          if (voiceJoinedRef.current) {
            const prevSelf = prev.find((row) => row.is_self);
            if (prevSelf && !next.some((row) => row.is_self)) {
              next = [
                {
                  ...prevSelf,
                  is_speaking: localSpeakingRef.current ? true : prevSelf.is_speaking,
                },
                ...next,
              ];
            }
          }
          return participantsEqual(prev, next) ? prev : next;
        });
        setParticipantCount((prev) =>
          prev === result.participant_count ? prev : result.participant_count,
        );
        return "ok";
      }
      if (result.error === "not_connected" || result.error === "session_not_ready") {
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
  }, [chatId, groupCallId, isTelegramMessagesConnected, participantsEqual]);

  useEffect(() => {
    if (!voiceSession.localSpeaking) return;
    setParticipants((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (!row.is_self || row.is_speaking) return row;
        changed = true;
        return { ...row, is_speaking: true };
      });
      return changed ? next : prev;
    });
  }, [voiceSession.localSpeaking]);

  // Presence poll even before Join so avatars show who's already in the call.
  // Back off hard while TDLib is disconnected / restoring so we do not stampede.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveBackoffs = 0;

    const tick = async () => {
      const status = await refreshParticipants();
      if (cancelled) return;
      if (status === "backoff") {
        consecutiveBackoffs += 1;
      } else {
        consecutiveBackoffs = 0;
      }
      const baseMs = popoverOpen ? 250 : joined ? 600 : 2000;
      const intervalMs =
        status === "backoff"
          ? Math.min(baseMs * 2 ** Math.min(consecutiveBackoffs, 3), 12_000)
          : baseMs;
      timer = setTimeout(tick, intervalMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [popoverOpen, refreshParticipants, joined]);

  // After WebRTC/TDLib join lands, reload immediately — join floods participant
  // updates that presence polls would otherwise miss until the next interval.
  useEffect(() => {
    if (!voiceSession.joined) return;
    void refreshParticipants();
  }, [voiceSession.joined, refreshParticipants]);

  const unlockThenJoin = useCallback(() => {
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
    onJoin();
  }, [onJoin, voiceSession]);

  const handleStripPress = useCallback(() => {
    if (!joined) {
      unlockThenJoin();
      return;
    }
    unlockVoiceAutoplay();
    voiceSession.unlockAudio();
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
        patchAuthenticatedHomeSelectedChatVoice({
          has_active_voice_chat: result.has_active_voice_chat,
          voice_chat_group_call_id: result.voice_chat_group_call_id,
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
        patchAuthenticatedHomeSelectedChatVoice({
          has_active_voice_chat: result.has_active_voice_chat,
          voice_chat_group_call_id: result.voice_chat_group_call_id,
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

  return (
    <>
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
                        borderRadius: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX / 2,
                        overflow: "hidden",
                        backgroundColor: colors.background,
                      }}
                    >
                      <MessageChatAvatarSlot
                        iconUrl={avatarUrl}
                        initials={extractChatAvatarInitials(participantTitle)}
                        sizePx={MESSAGE_CHAT_VOICE_BAR_AVATAR_PX}
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
      />
    </>
  );
}
