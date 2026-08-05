/**
 * Global logo bar: default header, welcome marketing row (web), or welcome TMA immersive layout.
 * Variant follows route + Telegram viewport (see `resolveLogoBarVariant`).
 */
import React, { useEffect, useMemo } from "react";
import {
  View,
  Pressable,
  StyleSheet,
  Platform,
  Text,
  Linking,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { appLog } from "../../shared/appLog";
import { useTelegram } from "./Telegram";
import { HyperlinksSpaceLogo } from "./HyperlinksSpaceLogo";
import { LOGO_WORDMARK_ASPECT, LogoWordmark } from "./LogoWordmark";
import { getTmaInitAndWebAppDebugSnapshot, showGlobalLogoBarOnWelcomeTma } from "./telegramWebApp";
import { layout, useColors } from "../theme";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { isWelcomeLayoutRoute } from "../isWelcomeLayoutRoute";
import { useResolvedPathname } from "../useResolvedPathname";

const LOGO_HEIGHT = 32;
/** Welcome header glyph height — matches `assets/HyperlinksSpaceLogo.svg` (94×31). */
const WELCOME_LOGO_HEIGHT = 31;
/** When also in phone TMA, use a smaller 24px header glyph; width alone is not enough (see `useCompactHeaderGlyph`). */
const HEADER_NARROW_MAX_WIDTH = 480;
const MOBILE_LOGO_SIZE = 24;
const WELCOME_VERTICAL_INDENT = 15;
const BOTTOM_PADDING = 10;
const BROWSER_FALLBACK_TOP_PADDING = 30;
const ABOUT_URL = "https://landing.app.hyperlinks.space/";

/**
 * TMA / web top offset for a header glyph, matching `prev-main` Flutter `GlobalLogoBar._getLogoTopPadding`:
 * `safeAreaInsetTop + (contentSafeAreaInsetTop / 2) - (contentGlyphHeight / 2)`.
 * The container height is `top + contentGlyphHeight + bottomPadding` with the glyph centered
 * in the same way as Flutter’s `Container` + `Center` (tight content box, not a separate flex band).
 */
function useLogoTopOffset(
  safeAreaInsetTop: number,
  contentSafeAreaInsetTop: number,
  contentGlyphHeight: number,
): number {
  return useMemo(() => {
    if (safeAreaInsetTop === 0 && contentSafeAreaInsetTop === 0) {
      return BROWSER_FALLBACK_TOP_PADDING;
    }
    const half = Number.isFinite(contentGlyphHeight) ? contentGlyphHeight / 2 : 16;
    const value = safeAreaInsetTop + contentSafeAreaInsetTop / 2 - half;
    return Number.isFinite(value) ? value : BROWSER_FALLBACK_TOP_PADDING;
  }, [safeAreaInsetTop, contentSafeAreaInsetTop, contentGlyphHeight]);
}

type LogoBarVariant = "default" | "welcomeMarketing" | "welcomeImmersiveTma";

function resolveLogoBarVariant(
  isWelcomeLayout: boolean,
  isInTelegram: boolean,
  mergedImmersiveFullscreen: boolean,
  isTelegramMiniAppDesktop: boolean,
): LogoBarVariant {
  if (!isWelcomeLayout) return "default";

  // Mobile TMA: never the marketing row (wordmark + About); logo-only — default or immersive.
  if (isInTelegram && !isTelegramMiniAppDesktop) {
    const immersiveWelcome = showGlobalLogoBarOnWelcomeTma(isInTelegram, mergedImmersiveFullscreen);
    return immersiveWelcome ? "welcomeImmersiveTma" : "default";
  }

  const immersiveWelcome = showGlobalLogoBarOnWelcomeTma(isInTelegram, mergedImmersiveFullscreen);
  if (isInTelegram && immersiveWelcome) {
    return "welcomeImmersiveTma";
  }
  if (Platform.OS === "web" && (!isInTelegram || !immersiveWelcome)) {
    return "welcomeMarketing";
  }
  return "default";
}

function WelcomeMarketingBarContent({
  backgroundColor,
  borderBottomColor,
  hideTopBorder,
  wordmarkHeight,
  contentPaddingTop,
  contentPaddingBottom,
}: {
  backgroundColor: string;
  borderBottomColor: string;
  hideTopBorder: boolean;
  wordmarkHeight: number;
  contentPaddingTop: number;
  contentPaddingBottom: number;
}) {
  const { t } = useAppStrings();
  const { triggerHaptic } = useTelegram();
  const colors = useColors();
  // Dark: HyperlinksSpaceLogo.svg (white wordmark). Light: HyperlinksSpaceLogoWhiteTheme.svg (black).
  const logoTextColor = colors.primary;
  const wordmarkWidth = LOGO_WORDMARK_ASPECT * wordmarkHeight;

  const onAbout = () => {
    if (Platform.OS !== "web") {
      triggerHaptic("light");
    }
    void Linking.openURL(ABOUT_URL);
  };

  return (
    <View
      style={[
        styles.marketingBar,
        {
          // Equal top/bottom padding + centered row → logo sits on the header’s vertical midpoint.
          paddingTop: contentPaddingTop,
          paddingBottom: contentPaddingBottom,
          paddingHorizontal: layout.contentSideInsetPx,
          backgroundColor,
          borderTopColor: borderBottomColor,
          borderBottomColor,
          borderTopWidth: hideTopBorder ? 0 : 1,
          justifyContent: "center",
        },
      ]}
    >
      <View style={[styles.marketingRow, { minHeight: wordmarkHeight }]}>
        <View
          style={[styles.marketingLeft, { height: wordmarkHeight, justifyContent: "center" }]}
          accessible
          accessibilityLabel={t("global.logoBar.wordmarkA11y")}
        >
          <LogoWordmark
            width={wordmarkWidth}
            height={wordmarkHeight}
            textColor={logoTextColor}
          />
        </View>
        <Pressable
          onPress={onAbout}
          style={[styles.aboutHit, { minHeight: wordmarkHeight }]}
          accessibilityRole="link"
          accessibilityLabel={t("global.logoBar.about")}
          accessibilityHint={t("global.logoBar.aboutHint")}
        >
          <Text style={[styles.aboutText, { color: colors.primary }]}>{t("global.logoBar.about")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function GlobalLogoBar() {
  const { t } = useAppStrings();
  const router = useRouter();
  const pathname = useResolvedPathname();
  const auth = useAuth();
  // Keep root header neutral until auth is fully known to avoid wrong-header flashes.
  const isWelcomeLayout = isWelcomeLayoutRoute(pathname, auth);
  const colors = useColors();
  const {
    isInTelegram,
    triggerHaptic,
    safeAreaInsetTop,
    contentSafeAreaInsetTop,
    layoutStartup,
    themeBgReady,
  } = useTelegram();
  const mergedImmersiveFullscreen = layoutStartup.mergedImmersiveFullscreen;
  const stableWelcomeImmersiveFullscreen =
    layoutStartup.mergedImmersiveFullscreen || layoutStartup.launchHashFullscreenPositive;
  const isTelegramMiniAppDesktop = layoutStartup.isTelegramMiniAppDesktop;

  const { width: dimensionsWidth } = useWindowDimensions();
  const windowWidth = useMemo(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      return Math.max(dimensionsWidth, window.innerWidth || 0);
    }
    return dimensionsWidth;
  }, [dimensionsWidth]);
  const isNarrowHeader = windowWidth <= HEADER_NARROW_MAX_WIDTH;
  const useCompactHeaderGlyph = isNarrowHeader && isInTelegram && !isTelegramMiniAppDesktop;
  const defaultLogoSize = useCompactHeaderGlyph ? MOBILE_LOGO_SIZE : LOGO_HEIGHT;

  const backgroundColor = themeBgReady ? colors.background : "transparent";

  const variant = resolveLogoBarVariant(
    isWelcomeLayout,
    isInTelegram,
    stableWelcomeImmersiveFullscreen,
    isTelegramMiniAppDesktop,
  );
  /** Immersive fullscreen on Telegram Desktop: same full wordmark as browser marketing (no N-only). */
  const isDesktopTmaImmersiveWelcome =
    variant === "welcomeImmersiveTma" && isInTelegram && isTelegramMiniAppDesktop;
  const hideHeaderTopBorder = isInTelegram && !isTelegramMiniAppDesktop;

  useEffect(() => {
    if (!isWelcomeLayout) return;
    const payload = {
      variant,
      isInTelegram,
      isFullscreenContext: mergedImmersiveFullscreen,
      showDefaultLogoOnWelcomeTma: showGlobalLogoBarOnWelcomeTma(
        isInTelegram,
        stableWelcomeImmersiveFullscreen,
      ),
      initAndWebApp: getTmaInitAndWebAppDebugSnapshot(),
    };
    appLog("[GlobalLogoBar]", "welcome_header_variant", payload);
  }, [isWelcomeLayout, variant, isInTelegram, mergedImmersiveFullscreen, stableWelcomeImmersiveFullscreen]);

  /**
   * Logo-only bar (signed-in home + TMA welcome): one rhythm — same glyph size and Telegram top offset
   * as the home header. The old `welcomeImmersiveTma` path used 15px bands + 40px logo and looked
   * misaligned next to the native TMA title row compared to the wallet home screen.
   */
  const logoBlockHeight = defaultLogoSize;
  const wordmarkForMarketing = useCompactHeaderGlyph ? MOBILE_LOGO_SIZE : WELCOME_LOGO_HEIGHT;
  const headerContentHeight = isDesktopTmaImmersiveWelcome ? wordmarkForMarketing : logoBlockHeight;
  /** Same as Flutter: offset matches the glyph you’re placing (N logo, wordmark, or welcome size). */
  const contentGlyphForTopOffset =
    variant === "welcomeMarketing" ? wordmarkForMarketing : headerContentHeight;
  const baseTelegramStyleTop = useLogoTopOffset(
    safeAreaInsetTop,
    contentSafeAreaInsetTop,
    contentGlyphForTopOffset,
  );
  /**
   * Desktop TMA (Telegram Desktop, etc.): `safeArea` / `contentSafeArea` from WebApp are often
   * relative to a viewport that already sits below the client’s titlebar — applying the full
   * Flutter-style offset adds a second band of empty space above the bar.
   */
  const isDesktopTma = isInTelegram && isTelegramMiniAppDesktop;
  const logoBarTopOffset = isDesktopTma ? WELCOME_VERTICAL_INDENT : baseTelegramStyleTop;

  const belowLogoPad = BOTTOM_PADDING;
  const topPadGlyph = logoBarTopOffset;
  const blockHeight = topPadGlyph + headerContentHeight + belowLogoPad;

  /**
   * Signed-in home: logo-only bar in TMA only when **immersive** fullscreen (desktop and mobile).
   * Expanded-without-fullscreen / browser: no logo bar on home.
   * Browser welcome (`/` signed out) keeps the marketing row via the web branch above.
   */
  const shouldShow = useMemo(() => {
    if (isWelcomeLayout && Platform.OS === "web") {
      return true;
    }
    if (!isInTelegram) {
      return false;
    }
    return showGlobalLogoBarOnWelcomeTma(isInTelegram, stableWelcomeImmersiveFullscreen);
  }, [isInTelegram, stableWelcomeImmersiveFullscreen, isWelcomeLayout]);

  const onPressLogoHome = () => {
    if (Platform.OS !== "web") {
      triggerHaptic("light");
    }
    router.replace("/");
  };

  const logoWordmarkTextColor = colors.primary;
  const desktopImmersiveWordmarkWidth = LOGO_WORDMARK_ASPECT * wordmarkForMarketing;

  if (!shouldShow) {
    return <View style={[styles.container, { height: 0, backgroundColor }]} />;
  }

  if (variant === "welcomeMarketing") {
    return (
      <View style={[styles.container, { backgroundColor }]}>
        <WelcomeMarketingBarContent
          backgroundColor={backgroundColor}
          borderBottomColor={colors.highlight}
          hideTopBorder={hideHeaderTopBorder}
          wordmarkHeight={wordmarkForMarketing}
          contentPaddingTop={
            isInTelegram && !isTelegramMiniAppDesktop
              ? baseTelegramStyleTop
              : WELCOME_VERTICAL_INDENT
          }
          contentPaddingBottom={WELCOME_VERTICAL_INDENT}
        />
      </View>
    );
  }

  /** Single hairline under the logo bar on home and welcome (marketing row uses its own chrome). */
  const logoBarBottomSeparator = { borderBottomWidth: 1 as const, borderBottomColor: colors.highlight };

  return (
    <View
      style={[
        styles.container,
        { height: blockHeight, backgroundColor },
        logoBarBottomSeparator,
      ]}
    >
      <View
        style={[
          styles.inner,
          isDesktopTmaImmersiveWelcome && styles.innerAlignStart,
          {
            paddingTop: topPadGlyph,
            paddingBottom: belowLogoPad,
            paddingHorizontal: layout.contentSideInsetPx,
          },
        ]}
      >
        <Pressable
          onPress={onPressLogoHome}
          style={[styles.logoWrap, isDesktopTmaImmersiveWelcome && styles.logoWrapAlignStart]}
          accessibilityRole="button"
          accessibilityLabel={t("key.header.goHomeA11y")}
        >
          {isDesktopTmaImmersiveWelcome ? (
            <View accessible accessibilityLabel={t("global.logoBar.wordmarkA11y")}>
              <LogoWordmark
                width={desktopImmersiveWordmarkWidth}
                height={wordmarkForMarketing}
                textColor={logoWordmarkTextColor}
              />
            </View>
          ) : (
            <View style={[styles.logoBox, { width: logoBlockHeight, height: logoBlockHeight }]}>
              <HyperlinksSpaceLogo width={logoBlockHeight} height={logoBlockHeight} />
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    backgroundColor: "transparent",
    flexShrink: 0,
  },
  inner: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  /** Match ordinary desktop TMA marketing row: content starts at the same horizontal band. */
  innerAlignStart: {
    alignItems: "flex-start",
    justifyContent: "center",
  },
  logoWrap: {
    maxWidth: 600,
    alignItems: "center",
    justifyContent: "center",
  },
  logoWrapAlignStart: {
    alignItems: "flex-start",
    alignSelf: "flex-start",
  },
  logoBox: {
    width: LOGO_HEIGHT,
    height: LOGO_HEIGHT,
  },
  marketingBar: {
    width: "100%",
    alignSelf: "stretch",
    flexShrink: 0,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  marketingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  marketingLeft: {
    flexShrink: 1,
    marginRight: 12,
    justifyContent: "center",
  },
  aboutHit: {
    paddingHorizontal: 4,
    justifyContent: "center",
    alignItems: "center",
  },
  aboutText: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "400",
    includeFontPadding: false,
    paddingVertical: 0,
    textAlignVertical: "center",
  },
});
