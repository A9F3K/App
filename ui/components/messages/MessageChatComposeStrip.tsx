import { Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, type ThemeColors } from "../../theme";
import { clearMessageChatCompose, type MessageChatComposeState } from "../../messageChatCompose";

type Props = {
  compose: MessageChatComposeState;
  colors: ThemeColors;
  onDismiss: () => void;
};

export function MessageChatComposeStrip({ compose, colors, onDismiss }: Props) {
  const { t, tf } = useAppStrings();
  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    includeFontPadding: false,
  } as const;

  const title = compose.edit
    ? t("messages.compose.editing")
    : compose.reply
      ? tf("messages.compose.replyTo", { name: compose.reply.sender_name })
      : "";

  const preview = compose.edit?.text ?? compose.reply?.text ?? "";

  if (!title) return null;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.highlight,
        backgroundColor: colors.background,
        paddingHorizontal: 16,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={[textBase, typographyRect15, { color: colors.accent, fontWeight: "500" }]}
        >
          {title}
        </Text>
        {preview ? (
          <Text
            numberOfLines={2}
            style={[textBase, typographyRect15, { color: colors.secondary, marginTop: 2 }]}
          >
            {preview}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => {
          clearMessageChatCompose(compose.chatId);
          onDismiss();
        }}
        hitSlop={8}
        style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1, padding: 4 })}
      >
        <Text style={[textBase, typographyRect15, { color: colors.secondary }]}>×</Text>
      </Pressable>
    </View>
  );
}
