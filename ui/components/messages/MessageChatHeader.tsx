import { useMemo } from "react";
import { Platform, PixelRatio, Pressable, Text, View, type ViewStyle } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { layout, type ThemeColors } from "../../theme";
import { useTelegram } from "../Telegram";
import { formatMessageChatSubheaderLabel, isMessageChatActionLive } from "./formatMessageChatSubheader";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  MESSAGE_CHAT_HEADER_STRIP_HEIGHT_PX,
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
} from "./messageListLayout";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import { resolveTelegramUserAccentColor } from "./resolveTelegramUserAccentColor";
import { MessageChatStartVoiceIcon } from "./MessageChatVoiceIcons";

const START_VOICE_ICON_HIT_PX = 36;
const START_VOICE_ICON_SIZE_PX = 22;

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
  /** No live voice yet, but this chat can start one — show voice-start icon. */
  showStartVoice?: boolean;
  onStartVoice?: () => void;
  startVoicePending?: boolean;
};

function menuStripRuleThickness(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

/** Left-aligned title/subheader for the open chat; optional start-voice icon on the right. */
export function MessageChatHeader({
  chat,
  colors,
  showStartVoice,
  onStartVoice,
  startVoicePending,
}: Props) {
  const { locale, t } = useAppStrings();
  const { colorScheme } = useTelegram();
  const lineT = menuStripRuleThickness();
  const stripPaddingX = layout.contentSideInsetPx;
  const title = chat.title.trim();
  const titleColor =
    resolveTelegramUserAccentColor(
      chat.peer_accent_color_light,
      chat.peer_accent_color_dark,
      colorScheme,
    ) ?? colors.primary;
  const subheaderLabel = formatMessageChatSubheaderLabel(chat, locale);
  const subheaderIsLiveAction = isMessageChatActionLive(chat);
  const showStart = Boolean(showStartVoice && onStartVoice);

  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  const borderLineStyle = useMemo((): ViewStyle => {
    return {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: lineT,
      backgroundColor: colors.highlight,
      zIndex: 1,
    };
  }, [colors.highlight, lineT]);

  return (
    <View
      style={{
        alignSelf: "stretch",
        height: MESSAGE_CHAT_HEADER_STRIP_HEIGHT_PX,
        position: "relative",
        overflow: "visible",
      }}
    >
      <View
        style={{
          ...Platform.select<ViewStyle>({
            default: {},
            web: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
          }),
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: stripPaddingX,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
          <SpecialTelegramUserName
            name={title}
            telegramUserId={chat.peer_user_id ?? null}
            telegramChatId={chat.telegram_chat_id}
            emojiStatusCustomEmojiId={chat.peer_emoji_status_custom_emoji_id ?? null}
            emojiStatusPriority
            inlineEmojiFetchEnabled
            inlineEmojiFetchPriority
            inlineEmojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
            textAlign="left"
            numberOfLines={1}
            textStyle={{
              ...textBase,
              color: titleColor,
            }}
          />
          {subheaderLabel ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{
                ...textBase,
                color: subheaderIsLiveAction ? colors.accent : colors.secondary,
                textAlign: "left",
                maxWidth: "100%",
                marginTop: 0,
              }}
            >
              {subheaderLabel}
            </Text>
          ) : null}
        </View>
        {showStart ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("messages.voiceChat.start")}
            onPress={onStartVoice}
            disabled={Boolean(startVoicePending)}
            hitSlop={8}
            style={({ pressed }) => ({
              marginLeft: 8,
              flexShrink: 0,
              width: START_VOICE_ICON_HIT_PX,
              height: START_VOICE_ICON_HIT_PX,
              alignItems: "center",
              justifyContent: "center",
              opacity: startVoicePending ? 0.5 : pressed ? 0.7 : 1,
            })}
          >
            <MessageChatStartVoiceIcon color={colors.primary} size={START_VOICE_ICON_SIZE_PX} />
          </Pressable>
        ) : null}
      </View>
      <View pointerEvents="none" collapsable={false} style={borderLineStyle} />
    </View>
  );
}
