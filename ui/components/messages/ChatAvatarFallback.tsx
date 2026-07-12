import { Platform, StyleSheet, Text, View } from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import type { ThemeColors, ThemeName } from "../../theme";
import { chatAvatarFallbackBackground, colorsForAvatarInitials } from "./chatAvatarInitials";

export function ChatAvatarFallback({
  initials,
  sizePx,
  colors,
  scheme,
  fill = false,
}: {
  initials: string[];
  sizePx: number;
  colors: ThemeColors;
  scheme: ThemeName;
  /** Fill the parent slot (keeps `sizePx` for letter sizing). */
  fill?: boolean;
}) {
  const backgroundColor = chatAvatarFallbackBackground(colors, scheme);
  const frameStyle = fill
    ? StyleSheet.absoluteFillObject
    : { width: sizePx, height: sizePx, borderRadius: 0 };

  if (initials.length === 0) {
    return (
      <View
        style={[
          frameStyle,
          {
            borderRadius: 0,
            backgroundColor,
          },
        ]}
      />
    );
  }

  const fontSize = initials.length > 1 ? Math.round(sizePx * 0.36) : Math.round(sizePx * 0.44);
  const fontFamily = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;
  const letterColors = colorsForAvatarInitials(initials, scheme);

  return (
    <View
      style={[
        frameStyle,
        {
          borderRadius: 0,
          backgroundColor,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
        },
      ]}
    >
      {initials.map((letter, index) => (
        <Text
          key={`${letter}-${index}`}
          style={{
            color: letterColors[index],
            fontSize,
            lineHeight: fontSize + 2,
            fontFamily,
            fontWeight: "600",
            includeFontPadding: false,
          }}
        >
          {letter}
        </Text>
      ))}
    </View>
  );
}
