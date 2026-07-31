import { useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { ThemeColors } from "../../theme";
import { typographyFixedRow30Label } from "../../theme";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX } from "./messageListLayout";
import { MessageChatMicIcon } from "./MessageChatVoiceIcons";
import {
  getActiveVoiceDock,
  subscribeActiveVoiceDock,
} from "./activeVoiceDockStore";

type Props = {
  colors: ThemeColors;
};

export function ActiveVoiceCallDock({ colors }: Props) {
  const { t } = useAppStrings();
  const dock = useSyncExternalStore(
    subscribeActiveVoiceDock,
    getActiveVoiceDock,
    () => null,
  );
  if (!dock) return null;

  return (
    <View
      style={{
        alignSelf: "stretch",
        height: MESSAGE_CHAT_VOICE_BAR_HEIGHT_PX,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.highlight,
        backgroundColor: colors.background,
        zIndex: 20,
      }}
    >
      <Pressable
        onPress={dock.onOpen}
        accessibilityRole="button"
        accessibilityLabel={t("messages.voiceChat.open")}
        testID="voice-global-dock-preview"
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
          style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
        >
          <MessageChatMicIcon
            muted={!dock.micActive}
            color={dock.micActive ? colors.accent : colors.primary}
            size={20}
          />
        </View>
        <View style={{ minWidth: 0, flexShrink: 1, flex: 1 }}>
          <Text
            numberOfLines={1}
            style={[
              typographyFixedRow30Label,
              {
                color: colors.primary,
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
              },
            ]}
          >
            {dock.title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              color: colors.secondary,
              fontSize: 11,
              lineHeight: 14,
              fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
            }}
          >
            {t("messages.voiceChat.active")}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={dock.onLeave}
        accessibilityRole="button"
        accessibilityLabel={t("messages.voiceChat.leave")}
        style={({ pressed }) => ({
          paddingHorizontal: 10,
          paddingVertical: 6,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text
          style={[
            typographyFixedRow30Label,
            {
              color: colors.accent,
              fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
            },
          ]}
        >
          {t("messages.voiceChat.controls.drop")}
        </Text>
      </Pressable>
    </View>
  );
}
