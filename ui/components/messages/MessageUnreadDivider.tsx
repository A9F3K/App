import { Text, View } from "react-native";
import type { ThemeColors } from "../../theme";

type Props = {
  unreadCount: number;
  colors: ThemeColors;
};

/** Separator before the first unread message (telegram-tt unread-divider). */
export function MessageUnreadDivider({ unreadCount, colors }: Props) {
  const label = unreadCount > 0 ? `${unreadCount} unread` : "Unread messages";
  return (
    <View
      nativeID="message-unread-divider"
      style={{
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 6,
        gap: 8,
      }}
      accessibilityRole="text"
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.highlight }} />
      <Text
        style={{
          color: colors.accent,
          fontSize: 13,
          lineHeight: 16,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.highlight }} />
    </View>
  );
}
