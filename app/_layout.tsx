import "../global.css";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { applyPlatformTextDefaults, ensureUiSansFontFamilyDefaults } from "../ui/platformTextDefaults";
import { UI_GOOGLE_FONT_LOAD_MAP } from "../ui/uiGoogleFonts";
import {
  View,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  AppState,
  Alert,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { Stack } from "expo-router";
import { DefaultTheme } from "@react-navigation/native";
import * as Updates from "expo-updates";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { TelegramProvider, useTelegram } from "../ui/components/Telegram";
import { AppStringsProvider, useAppStrings } from "../locales/AppStringsContext";
import { GlobalLogoBarWithFallback } from "../ui/components/GlobalLogoBarWithFallback";
import { GlobalBottomBar } from "../ui/components/GlobalBottomBar";
import { BottomBarLayoutProvider, useBottomBarLayout } from "../ui/components/BottomBarLayoutContext";
import { FloatingShield } from "../ui/components/FloatingShield";
import { TelegramConnectFooterStrip } from "../ui/components/TelegramConnectFooterStrip";
import { TelegramMessagesConnectionProvider } from "../ui/telegram/TelegramMessagesConnectionContext";
import { SettingsProvider } from "../ui/settings/SettingsContext";
import { ProfileProvider } from "../ui/profile/ProfileContext";
import { WelcomeEmailAuthProvider } from "../ui/welcome/WelcomeEmailAuthContext";
import { useTmaMobileNativeBackNavigation } from "../ui/telegram/useTmaMobileNativeBackNavigation";
import { logBuildSnapshotOnce, logPageDisplay } from "../ui/pageDisplayLog";
import { installGlobalVoiceFreezeLogger } from "../ui/components/messages/useVoiceDialogFreezeDetector";
import { appWarn } from "../shared/appLog";
import { syncWebDocumentOverflowForZoom } from "../ui/browserZoom";
import { isWelcomeLayoutRoute } from "../ui/isWelcomeLayoutRoute";
import { authenticatedHomeBottomBarDock, dark, layout, useColors } from "../ui/theme";
import { useResolvedPathname } from "../ui/useResolvedPathname";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Analytics } from "@vercel/analytics/react";

applyPlatformTextDefaults();

// ExpoRoot's NavigationContainer defaults to DefaultTheme (background #f2f2f2). That
// paints a full-viewport grey card on hard-reload before route chrome mounts.
DefaultTheme.dark = true;
DefaultTheme.colors.background = dark.background;
DefaultTheme.colors.card = dark.background;
DefaultTheme.colors.text = dark.primary;
DefaultTheme.colors.border = dark.highlight;
DefaultTheme.colors.primary = dark.primary;

void SplashScreen.preventAutoHideAsync();

/**
 * Three-block column layout (same as Flutter):
 * 1. Logo bar (optional in TMA when not fullscreen)
 * 2. Main area (flex, scrollable per screen) – Stack updates on route change
 * 3. AI & Search bar (fixed at bottom, platform-specific internals)
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(UI_GOOGLE_FONT_LOAD_MAP);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
    if (fontError) {
      appWarn("[fonts]", "ui_font_load_failed", undefined, fontError);
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  if (fontsLoaded) {
    ensureUiSansFontFamilyDefaults();
  }

  return (
    <TelegramProvider>
      <AppStringsProvider>
        <AuthProvider>
          <WelcomeEmailAuthProvider>
          <TelegramMessagesConnectionProvider>
            <SettingsProvider>
            <ProfileProvider>
            <BottomBarLayoutProvider>
            {Platform.OS === "ios" ? (
              <KeyboardAvoidingView
                style={styles.keyboardAvoid}
                behavior="padding"
                keyboardVerticalOffset={0}
              >
                <RootContent />
              </KeyboardAvoidingView>
            ) : (
              <RootContent />
            )}
            </BottomBarLayoutProvider>
            </ProfileProvider>
            </SettingsProvider>
          </TelegramMessagesConnectionProvider>
          </WelcomeEmailAuthProvider>
        </AuthProvider>
      </AppStringsProvider>
    </TelegramProvider>
  );
}

/** Web: allow browser pinch/Ctrl+wheel zoom; replaces restrictive scale caps from defaults. */
function useWebViewportAllowsPageZoom() {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const cur = meta.getAttribute("content") ?? "";
    const parts = cur
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => !/^(maximum-scale|minimum-scale|user-scalable)=/i.test(p));
    parts.push("minimum-scale=0.25", "maximum-scale=5", "user-scalable=yes");
    meta.setAttribute("content", parts.join(", "));
  }, []);
}

/** Screen footer: welcome AI bar when signed out; authenticated narrow routes use inactive footers or {@link GlobalBottomBar}. */
function RootScreenFooter({
  pathname,
  bottomBarDock,
  isAuthenticated,
  authHydrated,
  authReady,
  themeBgReady,
  useTelegramTheme,
}: {
  pathname: string | null | undefined;
  bottomBarDock: ReturnType<typeof authenticatedHomeBottomBarDock>;
  isAuthenticated: boolean;
  authHydrated: boolean;
  authReady: boolean;
  themeBgReady: boolean;
  useTelegramTheme: boolean;
}) {
  if (Platform.OS === "web" && useTelegramTheme && !themeBgReady) return null;

  if (isAuthenticated) {
    if (bottomBarDock !== "screenFooter") return null;
    if (pathname === "/swap") return <GlobalBottomBar />;
    if (pathname === "/send") return <GlobalBottomBar />;
    if (pathname === "/trade") return <GlobalBottomBar />;
    if (pathname === "/smart") return <GlobalBottomBar />;
    if (pathname === "/get") return null;
    return <GlobalBottomBar />;
  }

  if (isWelcomeLayoutRoute(pathname, { authHydrated, authReady, isAuthenticated })) {
    return <GlobalBottomBar />;
  }

  return null;
}

/** Web-only Vercel Analytics; passes route so SPA navigations are tracked. */
function WebVercelAnalytics({ pathname }: { pathname: string | null | undefined }) {
  if (Platform.OS !== "web" || pathname == null) return null;
  return <Analytics route={pathname} path={pathname} />;
}

function RootContent() {
  /**
   * Web: render a single static shell on the server + on the client's first commit so prerendered HTML
   * matches hydration. The real tree (theme, pathname, Stack) only mounts after useLayoutEffect — that
   * subtree is then a client-only paint, which avoids React #418 from TMA / auth / router divergence.
   * Native: no split (always ready).
   */
  const { t } = useAppStrings();
  const lastOtaCheckAtRef = useRef(0);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const checkForOtaUpdate = async () => {
      const now = Date.now();
      if (now - lastOtaCheckAtRef.current < 10 * 60 * 1000) return;
      lastOtaCheckAtRef.current = now;

      try {
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) return;

        await Updates.fetchUpdateAsync();
        Alert.alert(t("ota.title"), t("ota.message"), [
          { text: t("ota.later"), style: "cancel" },
          {
            text: t("ota.restart"),
            onPress: () => {
              void Updates.reloadAsync();
            },
          },
        ]);
      } catch (error) {
        appWarn("[updates]", "ota_check_failed", undefined, error);
      }
    };

    void checkForOtaUpdate();
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void checkForOtaUpdate();
      }
    });
    return () => sub.remove();
  }, [t]);

  const [webHydrationReady, setWebHydrationReady] = useState(Platform.OS !== "web");
  useLayoutEffect(() => {
    if (Platform.OS === "web") {
      setWebHydrationReady(true);
    }
  }, []);

  useWebViewportAllowsPageZoom();
  const pathname = useResolvedPathname();
  const auth = useAuth();
  const { authHydrated, authReady, isAuthenticated } = auth;
  useTmaMobileNativeBackNavigation(pathname, isAuthenticated);
  const { width: windowWidth } = useWindowDimensions();
  const { setFooterDockedToScreenEdge } = useBottomBarLayout();
  const bottomBarDock = authenticatedHomeBottomBarDock(pathname, windowWidth, isAuthenticated);

  useEffect(() => {
    setFooterDockedToScreenEdge(bottomBarDock === "screenFooter");
  }, [bottomBarDock, setFooterDockedToScreenEdge]);
  const colors = useColors();
  const { themeBgReady, useTelegramTheme, isInTelegram, isExpanded, layoutStartup } = useTelegram();
  const shellLogKeyRef = useRef<string | null>(null);
  // Outside Telegram theme, use app palette immediately (avoids SSR/client mismatch from bootstrapping
  // themeBgReady true on client only). In TMA, wait for WebApp theme before painting.
  const shellPaintReady = themeBgReady || !useTelegramTheme;
  const backgroundColor = shellPaintReady ? colors.background : "transparent";
  // Stronger than opacity:0 — avoids one frame of dark RN-web compositing before themeBgReady.
  const hideWebUntilTheme =
    Platform.OS === "web" && useTelegramTheme && !themeBgReady;

  /** Web: default UA scrollbars (root zoom / any overflow) use `accent` thumb + app background track. */
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !shellPaintReady) return;
    document.documentElement.style.setProperty(
      "scrollbar-color",
      `${colors.accent} ${backgroundColor}`,
    );
    return () => {
      document.documentElement.style.removeProperty("scrollbar-color");
    };
  }, [backgroundColor, colors.accent, shellPaintReady]);

  /** Panel routes + home: clip document scroll unless the page is zoomed (then allow pan). */
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !shellPaintReady) return;

    syncWebDocumentOverflowForZoom();

    const viewport = window.visualViewport;
    const onViewportChange = () => syncWebDocumentOverflowForZoom();
    viewport?.addEventListener("resize", onViewportChange);
    viewport?.addEventListener("scroll", onViewportChange);
    window.addEventListener("resize", onViewportChange);

    return () => {
      viewport?.removeEventListener("resize", onViewportChange);
      viewport?.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [shellPaintReady]);

  useEffect(() => {
    logBuildSnapshotOnce("root_layout_mount");
    // Opt-in longtask logger (`window.__HSP_VOICE_DEBUG__=true`) — always-on
    // observe+POST was stacking with hard-reload chat paint.
    const cleanup = installGlobalVoiceFreezeLogger();
    return cleanup;
  }, []);

  useEffect(() => {
    const key = [
      pathname ?? "",
      shellPaintReady,
      themeBgReady,
      useTelegramTheme,
      hideWebUntilTheme,
    ].join("|");
    if (shellLogKeyRef.current === key) return;
    shellLogKeyRef.current = key;
    logPageDisplay("root_shell", {
      pathname: pathname ?? null,
      shellPaintReady,
      themeBgReady,
      useTelegramTheme,
      hideWebUntilTheme,
      isInTelegram,
      isExpanded,
    });
  }, [
    pathname,
    shellPaintReady,
    themeBgReady,
    useTelegramTheme,
    hideWebUntilTheme,
    isInTelegram,
    isExpanded,
  ]);

  const showGlobalLogoBar = useMemo(() => {
    if (pathname == null || pathname === "") {
      return true;
    }
    if (
      pathname === "/welcome" ||
      pathname === "/home" ||
      pathname === "/" ||
      pathname === ""
    ) {
      // Keep header mounted on root / legacy routes and let GlobalLogoBar choose the variant.
      // This avoids startup mount/unmount flashes while TMA fullscreen signals settle.
      return true;
    }
    if (pathname === "/swap" || pathname === "/swap/currency" || pathname === "/key" || pathname === "/trade" || pathname === "/send" || pathname === "/get" || pathname === "/smart") {
      // In-screen {@link CenteredLogoOnlyHeader} on narrow swap, smart, trade, send, get, and key routes.
      return false;
    }
    if (isInTelegram && layoutStartup.isTelegramMiniAppDesktop) {
      return false;
    }
    return !isInTelegram || isExpanded;
  }, [pathname, isInTelegram, layoutStartup, isExpanded]);
  const isRootBootstrapPending =
    (pathname === "/" || pathname === "" || pathname == null) &&
    (!authHydrated || !authReady);

  if (Platform.OS === "web" && !webHydrationReady) {
    return (
      <View
        {...(Platform.OS === "web" ? { suppressHydrationWarning: true } : {})}
        style={[styles.root, styles.rootWebClipped, { backgroundColor: "#000000" }]}
      />
    );
  }

  return (
    <View
      // TMA / Vercel web: theme and display toggles after mount can mismatch pre-hydration HTML (React #418).
      {...(Platform.OS === "web" ? { suppressHydrationWarning: true } : {})}
      style={[
        styles.root,
        Platform.OS === "web" ? styles.rootWebClipped : styles.rootOverflowHidden,
        {
          backgroundColor,
          opacity: shellPaintReady ? 1 : 0,
          pointerEvents: shellPaintReady ? "auto" : "none",
          ...(Platform.OS === "web"
            ? { display: hideWebUntilTheme ? "none" : "flex" }
            : {}),
        },
      ]}
    >
      {showGlobalLogoBar && !isRootBootstrapPending ? <GlobalLogoBarWithFallback /> : null}
      {Platform.OS === "web" ? (
        <View style={styles.mainShell}>
          <Stack
            screenOptions={{
              headerShown: false,
              // Avoid RN default card #f2f2f2 flash on hard-reload before route paints.
              contentStyle: { flex: 1, minHeight: 0, backgroundColor },
            }}
          />
        </View>
      ) : (
        <View style={styles.main}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { flex: 1, minHeight: 0, backgroundColor },
            }}
          />
        </View>
      )}
      {
        // Avoid mounting web internals before theme — kills dark flash from RN-web inputs.
        // Wide authenticated home mounts the same bar inside split columns instead.
        Platform.OS !== "web" || !useTelegramTheme || themeBgReady ? (
          <RootScreenFooter
            pathname={pathname}
            bottomBarDock={bottomBarDock}
            isAuthenticated={isAuthenticated}
            authHydrated={authHydrated}
            authReady={authReady}
            themeBgReady={themeBgReady}
            useTelegramTheme={useTelegramTheme}
          />
        ) : null
      }
      {authHydrated && authReady && (isAuthenticated || isWelcomeLayoutRoute(pathname, auth)) ? (
        <>
          <TelegramConnectFooterStrip />
          <FloatingShield />
        </>
      ) : null}
      <WebVercelAnalytics pathname={pathname} />
    </View>
  );
}

const styles = StyleSheet.create({
  keyboardAvoid: {
    flex: 1,
  },
  root: {
    flex: 1,
    flexDirection: "column",
  },
  /** Native + default clipping */
  rootOverflowHidden: {
    overflow: "hidden",
  },
  /** Web: clip root; each screen column owns vertical scroll. */
  rootWebClipped: {
    minWidth: "100%",
    overflow: "hidden",
  } as unknown as ViewStyle,
  main: {
    flex: 1,
    minHeight: 0,
  },
  mainShell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    alignSelf: "stretch",
    width: "100%",
  },
});
