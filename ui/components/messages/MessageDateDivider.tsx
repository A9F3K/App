import { Text, View } from "react-native";
import type { ThemeColors } from "../../theme";

type Props = {
  label: string;
  colors: ThemeColors;
};

export function MessageDateDivider({ label, colors }: Props) {
  return (
    <View
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
          color: colors.secondary,
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
