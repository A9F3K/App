import { Image, Pressable, View } from "react-native";
import type { ThemeColors } from "../../theme";

type Props = {
  previewUri: string;
  colors: ThemeColors;
  onClear: () => void;
  clearAccessibilityLabel: string;
};

/** Compact preview of a clipboard-pasted photo waiting to send. */
export function MessageChatComposePhotoPreview({
  previewUri,
  colors,
  onClear,
  clearAccessibilityLabel,
}: Props) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
        gap: 8,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderWidth: 1,
          borderColor: colors.highlight,
          backgroundColor: colors.undercover,
          overflow: "hidden",
        }}
      >
        <Image source={{ uri: previewUri }} style={{ width: 72, height: 72 }} resizeMode="cover" />
      </View>
      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel={clearAccessibilityLabel}
        hitSlop={8}
        style={({ pressed }) => ({
          paddingHorizontal: 6,
          paddingVertical: 2,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View
          style={{
            width: 22,
            height: 22,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.highlight,
          }}
        >
          <View style={{ width: 10, height: 1, backgroundColor: colors.primary }} />
        </View>
      </Pressable>
    </View>
  );
}
