import { Platform, Text, View } from "react-native";

import { FONT_UI_SANS_SEMIBOLD, WEB_UI_SANS_STACK } from "../fonts";

/** Gap between the feature title and the SOON plate. */
export const PRO_SOON_NAMEPLATE_GAP_PX = 6;

const NAMEPLATE_HEIGHT_PX = 14;
const NAMEPLATE_PAD_X_PX = 5;
const NAMEPLATE_FONT_SIZE_PX = 8;
const NAMEPLATE_BORDER_PX = 1;

type Props = {
  color: string;
  /** Cap plate height to the host title line box. */
  lineHeightPx?: number;
};

/**
 * Fully-rounded “SOON” nameplate — same shape as {@link CrossTokenNameplate},
 * stroked and filled with the theme secondary color.
 */
export function ProSoonNameplate({ color, lineHeightPx = NAMEPLATE_HEIGHT_PX }: Props) {
  const height = Math.min(NAMEPLATE_HEIGHT_PX, lineHeightPx);
  const innerH = Math.max(NAMEPLATE_FONT_SIZE_PX, height - NAMEPLATE_BORDER_PX * 2);
  return (
    <View
      accessibilityLabel="SOON"
      style={{
        height,
        paddingHorizontal: NAMEPLATE_PAD_X_PX,
        borderRadius: height / 2,
        borderWidth: NAMEPLATE_BORDER_PX,
        borderColor: color,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...(Platform.OS === "web"
          ? ({
              boxSizing: "border-box",
              display: "flex",
              outline: "none",
            } as object)
          : null),
      }}
    >
      <Text
        style={{
          color,
          fontSize: NAMEPLATE_FONT_SIZE_PX,
          lineHeight: innerH,
          height: innerH,
          fontWeight: "600",
          letterSpacing: 0.35,
          textAlign: "center",
          ...(Platform.OS === "android"
            ? { includeFontPadding: false, textAlignVertical: "center" as const }
            : null),
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_SEMIBOLD,
          ...(Platform.OS === "web"
            ? ({
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                WebkitFontSmoothing: "antialiased",
                MozOsxFontSmoothing: "grayscale",
                userSelect: "none",
              } as object)
            : null),
        }}
        numberOfLines={1}
      >
        SOON
      </Text>
    </View>
  );
}
