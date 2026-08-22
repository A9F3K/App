import { Image } from "expo-image";
import { Platform, Text, View } from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import type { ThemeColors } from "../../theme";

const textBase = {
  fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
  fontSize: 15,
  lineHeight: 15,
} as const;

export function TradeCollectionColumn({
  image,
  title,
  subtitle,
  colors,
}: {
  image: number;
  title: string;
  subtitle: string;
  colors: ThemeColors;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch" }}>
      <View style={{ width: "100%", aspectRatio: 1 }}>
        <Image source={image} pointerEvents="none" style={{ width: "100%", height: "100%" }} contentFit="contain" />
      </View>
      <View style={{ height: 15 }} />
      <Text style={{ ...textBase, color: colors.primary, fontWeight: "500" }}>{title}</Text>
      <View style={{ height: 5 }} />
      <Text style={{ ...textBase, color: colors.secondary, fontWeight: "500" }}>{subtitle}</Text>
    </View>
  );
}
