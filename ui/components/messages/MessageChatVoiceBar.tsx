import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { layout, type ThemeColors } from "../../theme";
import { leaveTelegramChatVoice } from "../../telegram/leaveTelegramChatVoice";
import {
  fetchTelegramChatVoiceParticipants,
  type TelegramChatVoiceParticipant,
} from "../../telegram/fetchTelegramChatVoiceParticipants";
import { patchAuthenticatedHomeSelectedChatVoice } from "../../authenticatedHomeSelectedChat";
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

type Props = {
  chatId: number;
  groupCallId: number | null;
  title: string;
  colors: ThemeColors;
};

/** Under-header strip for an active chat voice: mic + participant avatars, leave on the right. */
export function MessageChatVoiceBar({ chatId, groupCallId, title, colors }: Props) {
  const { t } = useAppStrings();
  const { colorScheme } = useTelegram();
  const [leaving, setLeaving] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [participants, setParticipants] = useState<TelegramChatVoiceParticipant[]>([]);
  const stripPaddingX = layout.contentSideInsetPx;
  const stackedParticipants = participants.slice(0, MESSAGE_CHAT_VOICE_BAR_MAX_AVATARS);

  const refreshParticipants = useCallback(async () => {
    const result = await fetchTelegramChatVoiceParticipants(chatId, groupCallId);
    if (result.ok) {
      setParticipants(result.participants);
    } else {
      setParticipants([]);
      appWarn("[message-voice-participants]", result.error, { chatId, groupCallId });
    }
  }, [chatId, groupCallId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchTelegramChatVoiceParticipants(chatId, groupCallId);
      if (cancelled) return;
      if (result.ok) {
        setParticipants(result.participants);
      } else {
        setParticipants([]);
        appWarn("[message-voice-participants]", result.error, { chatId, groupCallId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, groupCallId]);

  useEffect(() => {
    if (!popoverOpen) return;
    void refreshParticipants();
  }, [popoverOpen, refreshParticipants]);

  const onLeave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      const result = await leaveTelegramChatVoice(chatId, groupCallId);
      if (result.ok) {
        setPopoverOpen(false);
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
  }, [chatId, groupCallId, leaving]);

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
          onPress={() => setPopoverOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t("messages.voiceChat.open")}
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
            <MessageChatMicIcon color={colors.accent} size={20} />
          </View>
          {stackedParticipants.length > 0 ? (
            <View
              accessibilityLabel={t("messages.voiceChat.participants")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                height: MESSAGE_CHAT_VOICE_BAR_AVATAR_PX,
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
          ) : null}
        </Pressable>
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
      </View>
      <MessageChatVoicePopover
        visible={popoverOpen}
        onClose={() => setPopoverOpen(false)}
        title={title}
        participants={participants}
        colors={colors}
      />
    </>
  );
}
