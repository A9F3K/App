import { Platform, Pressable, Text, View } from "react-native";
import type { ThemeColors } from "../../theme";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";

type Props = {
  actorName: string;
  suffix: string;
  colors: ThemeColors;
  onPressActor?: (() => void) | null;
  accessibilityLabel?: string;
};

/**
 * Centered Telegram-style service notice (join / leave) in the message column.
 */
export function MessageChatServiceNotice({
  actorName,
  suffix,
  colors,
  onPressActor = null,
  accessibilityLabel,
}: Props) {
  const name = actorName.trim() || "…";
  const rest = suffix.startsWith(" ") ? suffix : ` ${suffix}`;
  const a11y = accessibilityLabel?.trim() || `${name}${rest}`.trim();
  const fontFamily = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={a11y}
      style={{
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 4,
        paddingHorizontal: 12,
      }}
    >
      <View
        style={{
          maxWidth: "100%",
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.undercover,
          borderRadius: 999,
          paddingHorizontal: 12,
          paddingVertical: 5,
        }}
      >
        {onPressActor ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={name}
            onPress={onPressActor}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text
              style={{
                color: colors.primary,
                fontSize: 13,
                lineHeight: 16,
                fontFamily,
                textDecorationLine: "underline",
              }}
            >
              {name}
            </Text>
          </Pressable>
        ) : (
          <Text
            style={{
              color: colors.primary,
              fontSize: 13,
              lineHeight: 16,
              fontFamily,
              fontWeight: "600",
            }}
          >
            {name}
          </Text>
        )}
        <Text
          style={{
            color: colors.primary,
            fontSize: 13,
            lineHeight: 16,
            fontFamily,
          }}
        >
          {rest}
        </Text>
      </View>
    </View>
  );
}
