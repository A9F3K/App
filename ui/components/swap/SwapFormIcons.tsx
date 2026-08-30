import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTelegram } from "../Telegram";
import {
  layout,
  useColors,
  welcomeAuthButtonActiveBackground,
  welcomeAuthButtonHoverBackground,
  type ThemeColors,
} from "../../theme";
import {
  swapRotateIconDark,
  swapRotateIconLight,
  swapSelectChevronDark,
  swapSelectChevronLight,
} from "./swapFormAssets";

const UNDERCOVER_CIRCLE_PX = layout.bottomBar.undercoverButtonHeightPx;

function isLightTheme(colors: ThemeColors): boolean {
  return colors.primary === "#000000";
}

export function SwapSelectChevron() {
  const colors = useColors();
  const src = isLightTheme(colors) ? swapSelectChevronLight : swapSelectChevronDark;
  return <Image source={src} style={{ width: 5, height: 10 }} contentFit="contain" />;
}

export function SwapSelectChevronDown() {
  return (
    <View style={{ transform: [{ rotate: "90deg" }] }}>
      <SwapSelectChevron />
    </View>
  );
}

function WalletGlyph({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="6.5" width="17" height="12" rx="2.5" stroke={color} strokeWidth={1.75} />
      <Path d="M3.5 10h17" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
      <Circle cx="16.5" cy="14" r="1.25" fill={color} />
    </Svg>
  );
}

/** Circular undercover chip wrapping a wallet icon (header balance control). */
export function UndercoverWalletButton({
  onPress,
  accessibilityLabel,
  disabled,
  active = false,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  /** Dialog open — primary chip, secondary icon. */
  active?: boolean;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hover, setHover] = useState(false);

  const iconColor = active ? colors.secondary : colors.primary;
  const backgroundColor = active
    ? colors.primary
    : hover
      ? welcomeAuthButtonHoverBackground(colors, colorScheme)
      : colors.undercover;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: active }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      style={({ pressed }) => ({
        width: UNDERCOVER_CIRCLE_PX,
        height: UNDERCOVER_CIRCLE_PX,
        borderRadius: UNDERCOVER_CIRCLE_PX / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor:
          !active && pressed
            ? welcomeAuthButtonActiveBackground(colors, colorScheme)
            : backgroundColor,
      })}
    >
      <WalletGlyph color={iconColor} />
    </Pressable>
  );
}

/** Circular undercover chip wrapping a down chevron (Get balance row). */
export function UndercoverChevronDownButton({
  onPress,
  accessibilityLabel,
  disabled,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hover, setHover] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      style={({ pressed }) => ({
        width: UNDERCOVER_CIRCLE_PX,
        height: UNDERCOVER_CIRCLE_PX,
        borderRadius: UNDERCOVER_CIRCLE_PX / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed
          ? welcomeAuthButtonActiveBackground(colors, colorScheme)
          : hover
            ? welcomeAuthButtonHoverBackground(colors, colorScheme)
            : colors.undercover,
      })}
    >
      <SwapSelectChevronDown />
    </Pressable>
  );
}

export function SwapRotateIcon() {
  const colors = useColors();
  const src = isLightTheme(colors) ? swapRotateIconLight : swapRotateIconDark;
  return <Image source={src} style={{ width: 20, height: 20 }} contentFit="contain" />;
}
