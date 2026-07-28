import { useEffect } from "react";
import { Platform, StyleSheet, Text, View, useSyncExternalStore } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import type { ThemeColors, ThemeName } from "../../theme";
import {
  chatAvatarFallbackBackground,
  colorsForAvatarInitials,
  mixRgbHex,
} from "./chatAvatarInitials";
import {
  isVoiceDialogUiOpen,
  subscribeVoiceDialogUiOpen,
} from "./voiceDialogUiGate";

type Props = {
  initials: string[];
  sizePx: number;
  colors: ThemeColors;
  scheme: ThemeName;
  /** Fill the parent slot (keeps `sizePx` for letter sizing). */
  fill?: boolean;
};

/** Native: static extruded letters + tiny opacity pulse (paused in voice dialog). */
export function ChatAvatarFallback({
  initials,
  sizePx,
  colors,
  scheme,
  fill = false,
}: Props) {
  const backgroundColor = chatAvatarFallbackBackground(colors, scheme);
  const letterColors = colorsForAvatarInitials(initials, scheme);
  const accent = letterColors[0] ?? (scheme === "light" ? "#3949AB" : "#8C9EFF");
  const bgHot = mixRgbHex(backgroundColor, accent, scheme === "light" ? 0.28 : 0.36);
  const depth = mixRgbHex(accent, "#000000", 0.5);
  const frameStyle = fill
    ? StyleSheet.absoluteFillObject
    : { width: sizePx, height: sizePx, borderRadius: 0 };

  const voiceDialogOpen = useSyncExternalStore(
    subscribeVoiceDialogUiOpen,
    isVoiceDialogUiOpen,
    () => false,
  );

  const pulse = useSharedValue(0);

  useEffect(() => {
    if (voiceDialogOpen) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(pulse);
    };
  }, [pulse, voiceDialogOpen]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.22 + pulse.value * 0.18,
  }));

  const fontSize = initials.length > 1 ? Math.round(sizePx * 0.36) : Math.round(sizePx * 0.44);
  const fontFamily = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

  return (
    <View style={[frameStyle, { borderRadius: 0, overflow: "hidden", backgroundColor }]}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: bgHot }, glowStyle]}
      />
      {initials.length > 0 ? (
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
          }}
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
                textShadowColor: depth,
                textShadowOffset: { width: 1, height: 1 },
                textShadowRadius: 0,
                transform: [{ perspective: 120 }, { rotateY: "-10deg" }, { rotateX: "6deg" }],
              }}
            >
              {letter}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
