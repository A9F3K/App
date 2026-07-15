import { useEffect, type ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { layout, typographyRect15, type ThemeColors } from "../../theme";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { HspScrollColumn } from "../HspScrollColumn";
import { LiquidGlassShaderUndercover } from "../LiquidGlassShaderUndercover";
import { useTelegram } from "../Telegram";
import { appModalSheetStyles } from "../AppModalSheet";
import type { TelegramChatVoiceParticipant } from "../../telegram/fetchTelegramChatVoiceParticipants";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramUserAvatarUrl } from "./resolveTelegramUserAvatarUrl";
import {
  MESSAGE_AVATAR_PX,
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_ICON_TEXT_GAP_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_ROW_HEIGHT_PX,
} from "./messageListLayout";
import {
  VoiceCameraIcon,
  VoiceDropIcon,
  VoiceMessagesIcon,
  VoiceMicControlIcon,
  VoiceMoreIcon,
  VoiceStatusMicIcon,
  VoiceWindowCrossIcon,
  VoiceWindowSizeIcon,
  VoiceWindowTrayIcon,
} from "./MessageChatVoiceControlIcons";

const WINDOW_ICON_SIZE_PX = 15;
const WINDOW_ICON_GAP_PX = 12;
const CONTROL_CHIP_PX = 50;
const CONTROL_ICON_PX = 20;
const CONTROL_CHIP_GAP_PX = 15;
const DIVIDER_INSET_PX = 20;

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  participants: TelegramChatVoiceParticipant[];
  colors: ThemeColors;
};

function VoiceParticipantRow({
  participant,
  isLast,
  colors,
}: {
  participant: TelegramChatVoiceParticipant;
  isLast: boolean;
  colors: ThemeColors;
}) {
  const { colorScheme } = useTelegram();
  const title = participant.title.trim() || "?";
  const avatarUrl = resolveTelegramUserAvatarUrl(participant);
  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: MESSAGE_ROW_HEIGHT_PX,
        width: "100%",
        marginBottom: isLast ? 0 : 10,
      }}
    >
      <View
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={avatarUrl}
          initials={extractChatAvatarInitials(title)}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          fetchPriority="high"
        />
      </View>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <Text
          numberOfLines={1}
          style={{
            ...textBase,
            color: colors.primary,
          }}
        >
          {title}
        </Text>
      </View>
      <View
        accessibilityRole="image"
        style={{
          width: 28,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
          marginLeft: 8,
        }}
      >
        <VoiceStatusMicIcon
          color={participant.is_speaking ? colors.accent : colors.primary}
          size={20}
        />
      </View>
    </View>
  );
}

function VoiceControlChip({
  label,
  phaseOffset,
  isLightTheme,
  children,
}: {
  label: string;
  phaseOffset: number;
  isLightTheme: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <LiquidGlassShaderUndercover
        size={CONTROL_CHIP_PX}
        phaseOffset={phaseOffset}
        isLightTheme={isLightTheme}
      >
        {children}
      </LiquidGlassShaderUndercover>
    </Pressable>
  );
}

/** Settings-style modal for an active chat voice call. */
export function MessageChatVoicePopover({
  visible,
  onClose,
  title,
  participants,
  colors,
}: Props) {
  const { t } = useAppStrings();
  const { height: windowHeight } = useWindowDimensions();
  const isLightTheme = colors.primary === "#000000";
  const iconColor = colors.primary;
  const chatTitle = title.trim() || t("messages.voiceChat.active");

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <HspScrollColumn
        style={{ height: windowHeight, width: "100%", minHeight: 0 }}
        contentContainerStyle={{
          flexGrow: 1,
          minHeight: windowHeight,
          justifyContent: "center",
          alignItems: "center",
        }}
        containOverscroll
      >
        <View style={[appModalSheetStyles.overlayBlock, { minHeight: windowHeight }]}>
          <Pressable
            style={appModalSheetStyles.backdropFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
          />
          <View
            style={[
              appModalSheetStyles.sheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.highlight,
                paddingTop: 20,
                paddingBottom: 20,
                maxHeight: Math.min(windowHeight - 2 * layout.contentSideInsetPx, 560),
              },
            ]}
            {...(Platform.OS === "web"
              ? ({
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                } as object)
              : {})}
            onStartShouldSetResponder={() => true}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                marginBottom: 16,
                gap: 12,
              }}
            >
              <Text
                numberOfLines={1}
                style={[
                  typographyRect15,
                  { color: colors.primary, flex: 1, minWidth: 0, marginBottom: 0 },
                ]}
              >
                {chatTitle}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: WINDOW_ICON_GAP_PX,
                  flexShrink: 0,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.back")}
                  onPress={onClose}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <VoiceWindowCrossIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </Pressable>
                <View
                  accessibilityRole="image"
                  style={{
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <VoiceWindowSizeIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </View>
                <View
                  accessibilityRole="image"
                  style={{
                    width: WINDOW_ICON_SIZE_PX + 4,
                    height: WINDOW_ICON_SIZE_PX + 4,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <VoiceWindowTrayIcon color={iconColor} size={WINDOW_ICON_SIZE_PX} />
                </View>
              </View>
            </View>

            <View style={{ paddingHorizontal: 20, maxHeight: 280 }}>
              <ScrollView style={{ maxHeight: 280 }} nestedScrollEnabled>
                {participants.length > 0 ? (
                  participants.map((participant, index) => (
                    <VoiceParticipantRow
                      key={
                        participant.user_id != null
                          ? `u:${participant.user_id}`
                          : `c:${participant.chat_id}:${index}`
                      }
                      participant={participant}
                      isLast={index === participants.length - 1}
                      colors={colors}
                    />
                  ))
                ) : (
                  <Text style={[typographyRect15, { color: colors.secondary }]}>
                    {t("messages.voiceChat.participants")}
                  </Text>
                )}
              </ScrollView>
            </View>

            <View
              style={{
                height: 1,
                marginTop: 16,
                marginBottom: 16,
                marginHorizontal: DIVIDER_INSET_PX,
                backgroundColor: colors.highlight,
              }}
            />

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: CONTROL_CHIP_GAP_PX,
                paddingHorizontal: 20,
              }}
            >
              <VoiceControlChip
                label={t("messages.voiceChat.controls.camera")}
                phaseOffset={0.08}
                isLightTheme={isLightTheme}
              >
                <VoiceCameraIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                label={t("messages.voiceChat.controls.drop")}
                phaseOffset={0.18}
                isLightTheme={isLightTheme}
              >
                <VoiceDropIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                label={t("messages.voiceChat.controls.messages")}
                phaseOffset={0.28}
                isLightTheme={isLightTheme}
              >
                <VoiceMessagesIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                label={t("messages.voiceChat.controls.mic")}
                phaseOffset={0.38}
                isLightTheme={isLightTheme}
              >
                <VoiceMicControlIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
              <VoiceControlChip
                label={t("messages.voiceChat.controls.more")}
                phaseOffset={0.48}
                isLightTheme={isLightTheme}
              >
                <VoiceMoreIcon color={iconColor} size={CONTROL_ICON_PX} />
              </VoiceControlChip>
            </View>
          </View>
        </View>
      </HspScrollColumn>
    </Modal>
  );
}
