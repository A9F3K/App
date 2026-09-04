import { Platform, Text, View } from "react-native";

import { HYPERLINKS_SPACE_LOGO_GREEN } from "../HyperlinksSpaceLogo";
import { FONT_UI_SANS_SEMIBOLD, WEB_UI_SANS_STACK } from "../../fonts";

/** Kept for DLLR mark assets; nameplate uses app logo green. */
export const DLLR_LOGO_COLOR = "#F12323";

/** Gap between the currency name and the CROSS plate. */
export const CROSS_NAMEPLATE_GAP_PX = 6;

const NAMEPLATE_HEIGHT_PX = 14;
const NAMEPLATE_PAD_X_PX = 5;
const NAMEPLATE_FONT_SIZE_PX = 8;
const NAMEPLATE_BORDER_PX = 1;

/** Approx plate width for column measure (pad + “CROSS” + borders). */
export const CROSS_NAMEPLATE_WIDTH_PX = 44;

type Props = {
  /** Cap plate height to the host name line box. */
  lineHeightPx?: number;
};

/** Fully-rounded “CROSS” nameplate in app-logo green — vertically centered glyph. */
export function CrossTokenNameplate({ lineHeightPx = NAMEPLATE_HEIGHT_PX }: Props) {
  const height = Math.min(NAMEPLATE_HEIGHT_PX, lineHeightPx);
  const innerH = Math.max(NAMEPLATE_FONT_SIZE_PX, height - NAMEPLATE_BORDER_PX * 2);
  return (
    <View
      accessibilityLabel="CROSS"
      style={{
        height,
        paddingHorizontal: NAMEPLATE_PAD_X_PX,
        borderRadius: height / 2,
        borderWidth: NAMEPLATE_BORDER_PX,
        borderColor: HYPERLINKS_SPACE_LOGO_GREEN,
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
          color: HYPERLINKS_SPACE_LOGO_GREEN,
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
        CROSS
      </Text>
    </View>
  );
}

export function isDllrCurrencyRow(row: {
  rowKey?: string;
  currency?: { ticker?: string; name?: string };
}): boolean {
  const ticker = row.currency?.ticker?.trim().toUpperCase() ?? "";
  if (ticker === "DLLR") return true;
  const key = row.rowKey?.trim().toLowerCase() ?? "";
  return key === "jetton:dllr" || key.includes(":dllr") || key.endsWith("/dllr");
}
