import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTelegram } from "../Telegram";
import { FONT_UI_SANS_BOLD, WEB_UI_SANS_STACK } from "../../fonts";
import { ProMetallicRocket } from "../../pro/ProMetallicRocket";
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
const WALLET_GLYPH_PX = 17;
const PRO_ROCKET_GLYPH_PX = 18;

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

function WalletGlyph({ color, size = WALLET_GLYPH_PX }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="6.5" width="17" height="12" rx="2.5" stroke={color} strokeWidth={1.75} />
      <Path d="M3.5 10h17" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
      <Circle cx="16.5" cy="14" r="1.25" fill={color} />
    </Svg>
  );
}

function undercoverChipColors(
  colors: ThemeColors,
  colorScheme: ReturnType<typeof useTelegram>["colorScheme"],
  active: boolean,
  hover: boolean,
) {
  const contentColor = colors.primary;
  const backgroundColor = active
    ? undercoverWithOpacity(colors.undercover, 0.71)
    : hover
      ? welcomeAuthButtonHoverBackground(colors, colorScheme)
      : colors.undercover;
  return { contentColor, backgroundColor };
}

/** Theme undercover at a fixed alpha (active header chips). */
function undercoverWithOpacity(hex: string, opacity: number): string {
  const raw = hex.trim().replace(/^#/, "");
  if (raw.length !== 6 || Number.isNaN(Number.parseInt(raw, 16))) {
    return hex;
  }
  const n = Number.parseInt(raw, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${opacity})`;
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
  /** Dialog open — undercover fill at 71% opacity. */
  active?: boolean;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hover, setHover] = useState(false);
  const { contentColor, backgroundColor } = undercoverChipColors(
    colors,
    colorScheme,
    active,
    hover,
  );

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
      <WalletGlyph color={contentColor} />
    </Pressable>
  );
}

/** Rectangle PRO chip: inactive = inner dotted border; subscribed = flat undercover. */
export function UndercoverProButton({
  onPress,
  accessibilityLabel,
  disabled,
  active = false,
  subscribed = false,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  /** Dialog open. */
  active?: boolean;
  /** Pro Access entitlement is active. */
  subscribed?: boolean;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const contentColor = colors.primary;
  const backgroundColor = subscribed
    ? active
      ? undercoverWithOpacity(colors.undercover, 0.71)
      : hover
        ? welcomeAuthButtonHoverBackground(colors, colorScheme)
        : colors.undercover
    : "transparent";
  const borderHot = pressed || active || hover;
  const borderColor = borderHot ? colors.primary : colors.highlight;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: active, selected: subscribed }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (!(width > 0) || !(height > 0)) return;
        setSize((prev) =>
          Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
            ? prev
            : { w: width, h: height },
        );
      }}
      style={{
        height: UNDERCOVER_CIRCLE_PX,
        paddingLeft: subscribed ? 8 : 7,
        // Rocket sits at the trailing edge — keep right inset tight (inner 2px border still clears).
        paddingRight: subscribed ? 5 : 4,
        paddingVertical: 0,
        borderRadius: 0,
        borderWidth: 0,
        position: "relative",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        backgroundColor:
          !subscribed && pressed
            ? "transparent"
            : subscribed && !active && pressed
              ? welcomeAuthButtonActiveBackground(colors, colorScheme)
              : backgroundColor,
      }}
    >
      {!subscribed && size.w > 0 && size.h > 0 ? (
        <Svg
          width={size.w}
          height={size.h}
          style={{ position: "absolute", left: 0, top: 0 }}
          pointerEvents="none"
        >
          {/*
            Inner 2px stroke: path inset by 1px so the full stroke sits inside the chip.
            Dash: 3px line / 1px gap.
          */}
          <Rect
            x={1}
            y={1}
            width={Math.max(0, size.w - 2)}
            height={Math.max(0, size.h - 2)}
            fill="none"
            stroke={borderColor}
            strokeWidth={2}
            strokeDasharray="3 1"
            strokeLinecap="butt"
            strokeLinejoin="miter"
          />
        </Svg>
      ) : null}
      <Text
        style={{
          color: contentColor,
          fontSize: 12,
          lineHeight: 14,
          fontWeight: "700",
          letterSpacing: 0.5,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_BOLD,
          includeFontPadding: false,
        }}
      >
        PRO
      </Text>
      <ProMetallicRocket sizePx={PRO_ROCKET_GLYPH_PX} />
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
