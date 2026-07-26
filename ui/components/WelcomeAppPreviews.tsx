import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { Platform, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useEffect, useState } from "react";
import { useAppStrings } from "../../locales/AppStringsContext";
import { light, useColors } from "../theme";

/** Use `white/` previews only on a light app surface — not `primary` alone (TMA merge can set black text without a light bg). */
function useLightPreviewAssets(colors: { background: string }): boolean {
  return colors.background.trim().toLowerCase() === light.background.toLowerCase();
}

/**
 * Intrinsic size of each SVG root (`width` / `height` on `<svg>`) — must match files so the box matches the image.
 * Light vs dark assets can differ (e.g. different desktop art sizes).
 */
const PREVIEW_ASSETS = {
  mobile: {
    light: {
      src: require("../../assets/previews/white/mobile.svg"),
      width: 400,
      height: 685,
    },
    dark: {
      src: require("../../assets/previews/black/mobile.svg"),
      width: 400,
      height: 677,
    },
  },
  desktop: {
    light: {
      src: require("../../assets/previews/white/desktop.svg"),
      width: 1499,
      height: 1080,
    },
    dark: {
      src: require("../../assets/previews/black/desktop.svg"),
      width: 1499,
      height: 1080,
    },
  },
  full: {
    light: {
      src: require("../../assets/previews/white/full.svg"),
      width: 1920,
      height: 1080,
    },
    dark: {
      src: require("../../assets/previews/black/full.svg"),
      width: 1920,
      height: 1080,
    },
  },
} as const;

/** Below 400: mobile; 400–1024: desktop; above 1024: full */
const BREAKPOINT_MOBILE = 400;
const BREAKPOINT_DESKTOP_MAX = 1024;

const PREVIEW_WIDTH_FRACTION = 0.8;
const MAX_WIDTH_MOBILE = 180;
const MAX_WIDTH_DESKTOP = 768;
const MAX_WIDTH_FULL = 1024;

const GAP_ABOVE_PREVIEW = 20;
/** Space from preview image bottom to attribution line. */
const GAP_BELOW_PREVIEW_TO_CREDIT = 33;
const CREDIT_FONT_SIZE = 11;
/** Space from attribution to end of content area. */
const GAP_BELOW_CREDIT = 11;
const PREVIEW_BORDER_WIDTH = 1;

const MAX_WIDTH_BY_KIND: Record<keyof typeof PREVIEW_ASSETS, number> = {
  mobile: MAX_WIDTH_MOBILE,
  desktop: MAX_WIDTH_DESKTOP,
  full: MAX_WIDTH_FULL,
};

function previewKindForWidth(windowWidth: number): keyof typeof PREVIEW_ASSETS {
  if (windowWidth < BREAKPOINT_MOBILE) return "mobile";
  if (windowWidth <= BREAKPOINT_DESKTOP_MAX) return "desktop";
  return "full";
}

/**
 * Theme-aware app preview: mobile / desktop / full SVG by viewport width; 80% of screen width capped per tier.
 * `assets/previews/white` vs `black` — same surface tone as the app (`background`), not text color alone.
 */
export function WelcomeAppPreviews() {
  const { width: windowWidth } = useWindowDimensions();
  const colors = useColors();
  const { t } = useAppStrings();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);
  const useLightPreviews = useLightPreviewAssets(colors);

  const effectiveWidth = hydrated ? windowWidth : 0;
  const kind = previewKindForWidth(effectiveWidth);
  const variant = PREVIEW_ASSETS[kind];
  const spec = useLightPreviews ? variant.light : variant.dark;
  const maxW = MAX_WIDTH_BY_KIND[kind];
  const fromViewport = effectiveWidth * PREVIEW_WIDTH_FRACTION;
  const previewWidth = Math.max(
    1,
    Math.round(Math.min(fromViewport, maxW, spec.width)),
  );
  const previewHeight = (previewWidth * spec.height) / spec.width;
  const attributionUrl = t("welcome.attribution.url");

  return (
    <View
      style={[
        styles.wrap,
        { marginTop: GAP_ABOVE_PREVIEW, marginBottom: GAP_BELOW_CREDIT },
      ]}
    >
      <View
        style={[
          styles.frame,
          {
            width: previewWidth,
            height: previewHeight,
            borderWidth: PREVIEW_BORDER_WIDTH,
            borderColor: colors.highlight,
          },
        ]}
      >
        <Image
          source={spec.src}
          style={styles.imageFill}
          contentFit="contain"
          accessibilityLabel="App preview"
        />
      </View>
      <Text style={[styles.credit, { color: colors.secondary, marginTop: GAP_BELOW_PREVIEW_TO_CREDIT }]}>
        {t("welcome.attribution.prefix")}{" "}
        <Text
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(attributionUrl);
          }}
          style={styles.creditLink}
        >
          {attributionUrl}
        </Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    alignItems: "center",
  },
  /** Exact pixel size from each asset’s intrinsic ratio; border inside width/height on web (border-box). */
  frame: {
    overflow: "hidden",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  imageFill: {
    width: "100%",
    height: "100%",
  },
  credit: {
    fontSize: CREDIT_FONT_SIZE,
    lineHeight: CREDIT_FONT_SIZE + 4,
    fontWeight: "400",
    textAlign: "center",
  },
  creditLink: {
    textDecorationLine: "underline",
  },
});
