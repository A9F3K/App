import { useState } from "react";
import { Linking, Platform, Pressable } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useTelegram } from "./Telegram";
import {
  useColors,
  welcomeAuthButtonActiveBackground,
  welcomeAuthButtonHoverBackground,
} from "../theme";

const CIRCLE_PX = 20;
const ICON_PX = 14;

/** Official Tonviewer mark (diamond) from tonviewer.com branding. */
function TonviewerGlyph({ size = ICON_PX }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <Path fill="#89B8FF" d="m11 20 9-14 9 14-9 14z" />
      <Path fill="#2E5FDC" d="M20 34V20h-7z" />
      <Path fill="#1D2DC6" d="M20 34V20h7z" />
      <Path fill="#4576F3" d="M20 20V6l-7 14z" />
      <Path fill="#3346F6" d="M20 20V6l7 14z" />
      <Path fill="#4486EB" d="M20 34 8 20h6z" />
      <Path fill="#89B8FF" d="M8 20 20 6l-6 14z" />
      <Path fill="#0F1D9D" d="M32 20 20 34l6-14z" />
      <Path fill="#213DD1" d="m20 6 12 14h-6z" />
    </Svg>
  );
}

export function tonviewerAccountUrl(address: string): string {
  const trimmed = address.trim();
  return `https://tonviewer.com/${encodeURIComponent(trimmed)}`;
}

/** 20×20 undercover circle with Tonviewer mark — opens the account on tonviewer.com. */
export function TonviewerExplorerButton({
  address,
  accessibilityLabel,
}: {
  address: string;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hover, setHover] = useState(false);
  const trimmed = address.trim();
  if (!trimmed) return null;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      onPress={() => {
        void Linking.openURL(tonviewerAccountUrl(trimmed));
      }}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      style={({ pressed }) => ({
        width: CIRCLE_PX,
        height: CIRCLE_PX,
        borderRadius: CIRCLE_PX / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed
          ? welcomeAuthButtonActiveBackground(colors, colorScheme)
          : hover
            ? welcomeAuthButtonHoverBackground(colors, colorScheme)
            : colors.undercover,
      })}
    >
      <TonviewerGlyph />
    </Pressable>
  );
}
