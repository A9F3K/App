import React, { useState } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";

const WHITE_NOISE_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<filter id="n">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch"/>` +
    `<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"/>` +
    `</filter>` +
    `<rect width="100%" height="100%" filter="url(%23n)"/>` +
    `</svg>`,
);

const WHITE_NOISE_BG = `url("data:image/svg+xml,${WHITE_NOISE_SVG}")`;

type Props = {
  text: string;
  style?: StyleProp<TextStyle>;
  revealLabel?: string;
  /** Bubble / panel background — solid fill under the white-noise overlay. */
  overlayBackgroundColor?: string;
};

function flatTextStyle(style: StyleProp<TextStyle>): TextStyle {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean)) as TextStyle;
  }
  if (typeof style === "object" && style) {
    return style as TextStyle;
  }
  return {};
}

/**
 * White-noise overlay over a login/verification code. Press once to reveal.
 */
export function MessageChatSpoilerCode({
  text,
  style,
  revealLabel = "Tap to reveal code",
  overlayBackgroundColor = "#323232",
}: Props) {
  const [revealed, setRevealed] = useState(false);
  const flat = flatTextStyle(style);

  if (revealed) {
    if (Platform.OS === "web") {
      return <span style={flat as object}>{text}</span>;
    }
    return <Text style={style}>{text}</Text>;
  }

  if (Platform.OS === "web") {
    return React.createElement(
      "span",
      {
        role: "button",
        title: revealLabel,
        "aria-label": revealLabel,
        onClick: (e: { stopPropagation?: () => void }) => {
          e.stopPropagation?.();
          setRevealed(true);
        },
        style: {
          position: "relative",
          display: "inline-block",
          verticalAlign: "baseline",
          cursor: "pointer",
          borderRadius: 4,
          paddingLeft: 2,
          paddingRight: 2,
          marginLeft: 1,
          marginRight: 1,
          lineHeight: flat.lineHeight,
          fontSize: flat.fontSize,
          fontFamily: flat.fontFamily,
          fontWeight: flat.fontWeight,
          color: "transparent",
          userSelect: "none",
          WebkitUserSelect: "none",
        },
      },
      React.createElement(
        "span",
        {
          style: {
            opacity: 0,
            color: "transparent",
            whiteSpace: "pre",
            pointerEvents: "none",
          },
        },
        text,
      ),
      React.createElement("span", {
        "aria-hidden": true,
        style: {
          position: "absolute",
          inset: 0,
          borderRadius: 4,
          zIndex: 1,
          backgroundColor: overlayBackgroundColor || "#323232",
          backgroundImage: WHITE_NOISE_BG,
          backgroundSize: "40px 40px",
          backgroundRepeat: "repeat",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
        },
      }),
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealLabel}
      onPress={() => setRevealed(true)}
      style={{ position: "relative", alignSelf: "flex-start", paddingHorizontal: 2 }}
    >
      <Text style={[style, { opacity: 0 }]}>{text}</Text>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: 4,
          backgroundColor: overlayBackgroundColor,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            opacity: 0.85,
            backgroundColor: "#ffffff",
          }}
        />
      </View>
    </Pressable>
  );
}
