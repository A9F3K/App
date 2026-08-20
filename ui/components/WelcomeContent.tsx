import { Alert, View, Text, useWindowDimensions, StyleSheet, Platform } from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildApiUrl } from "../../api/_base";
import { useAuth } from "../../auth/AuthContext";
import {
  dispatchAuthSessionUpdated,
  setDesktopSessionToken,
} from "../../auth/desktopSessionToken";
import { layout, useColors } from "../theme";
import { useAppStrings } from "../../locales/AppStringsContext";
import { logPageDisplay } from "../pageDisplayLog";
import { hasWelcomeBrowserAuthContext } from "../appShell";
import { WelcomeAuthButtons } from "./WelcomeAuthButtons";
import { WelcomeLanguageSwitcher } from "./WelcomeLanguageSwitcher";
import { isActuallyInTelegram } from "./telegramWebApp";
import { HspScrollColumn } from "./HspScrollColumn";

const CONTENT_GAP_BELOW_HEADER = 16;
const MAX_TEXT_WIDTH = 360;
const WIDE_LAYOUT_MIN_WIDTH = 480;
/** Title → language */
const GAP_TITLE_TO_LANGUAGE = 14;
/** Language → subtitle */
const GAP_LANGUAGE_TO_SUBTITLE = 10;
/** Subtitle → auth */
const GAP_SUBTITLE_TO_AUTH = 22;

const HEADING_FONT_WIDE = 35;
const HEADING_LINE_NARROW = 30;
const HEADING_LINE_WIDE = 42;

/**
 * Welcome marketing + auth controls. Rendered at `/` when unauthenticated (same URL as signed-in home).
 */
export function WelcomeContent() {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const { signIn } = useAuth();
  const { width: dimensionsWidth } = useWindowDimensions();
  /** RN-web sometimes reports width 0 on the first frame; `innerWidth` matches the real viewport immediately. */
  const windowWidth = useMemo(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      return Math.max(dimensionsWidth, window.innerWidth || 0);
    }
    return dimensionsWidth;
  }, [dimensionsWidth]);
  /** Web: ready on first paint so wide/narrow heading matches viewport (no narrow→wide flash). Native: defer until mount so first layout pass has real dimensions. */
  const [layoutReady, setLayoutReady] = useState(() => Platform.OS === "web");

  useEffect(() => {
    setLayoutReady(true);
  }, []);

  useEffect(() => {
    if (!hasWelcomeBrowserAuthContext() || typeof window === "undefined") return;
    if (isActuallyInTelegram()) return;

    const params = new URLSearchParams(window.location.search);
    const telegramAuthError = params.get("telegramAuthError");
    if (telegramAuthError) {
      logPageDisplay("welcome_telegram_oidc_callback_error", {
        reason: telegramAuthError,
        href: window.location.href,
      });
      Alert.alert(
        t("welcome.auth.telegramBrowserAlertTitle"),
        tf("welcome.auth.telegramCallbackError", { reason: telegramAuthError }),
      );
      params.delete("telegramAuthError");
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    const googleAuthError = params.get("googleAuthError");
    if (googleAuthError) {
      logPageDisplay("welcome_google_oidc_callback_error", {
        reason: googleAuthError,
        href: window.location.href,
      });
      Alert.alert(
        t("welcome.auth.googleBrowserAlertTitle"),
        tf("welcome.auth.googleCallbackError", { reason: googleAuthError }),
      );
      params.delete("googleAuthError");
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    const githubAuthError = params.get("githubAuthError");
    if (githubAuthError) {
      logPageDisplay("welcome_github_oauth_callback_error", {
        reason: githubAuthError,
        href: window.location.href,
      });
      const githubMessage =
        githubAuthError === "access_denied"
          ? t("welcome.auth.githubAccessDenied")
          : tf("welcome.auth.githubCallbackError", { reason: githubAuthError });
      Alert.alert(t("welcome.auth.githubBrowserAlertTitle"), githubMessage);
      params.delete("githubAuthError");
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }

    const appleAuthError = params.get("appleAuthError");
    if (appleAuthError) {
      logPageDisplay("welcome_apple_oidc_callback_error", {
        reason: appleAuthError,
        href: window.location.href,
      });
      const appleMessage =
        appleAuthError === "access_denied"
          ? t("welcome.auth.appleAccessDenied")
          : tf("welcome.auth.appleCallbackError", { reason: appleAuthError });
      Alert.alert(t("welcome.auth.appleBrowserAlertTitle"), appleMessage);
      params.delete("appleAuthError");
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }
  }, [t, tf]);

  const probeBrowserSession = useCallback(
    async (source: "mount" | "visibility" | "oauth_complete") => {
      const startedAt = Date.now();
      logPageDisplay("welcome_telegram_oidc_session_probe", { source });
      try {
        // AuthContext already owns cold-start session; skip_feed keeps OAuth probes cheap.
        const sessionUrl = buildApiUrl("/api/auth/session?skip_feed=1");
        const response = await fetch(sessionUrl, {
          method: "GET",
          credentials: "include",
        });
        const json = (await response.json().catch(() => ({}))) as { authenticated?: boolean };
        const authenticated = response.ok && json?.authenticated === true;
        logPageDisplay("welcome_telegram_oidc_session_probe_result", {
          source,
          status: response.status,
          ok: response.ok,
          authenticated,
          elapsedMs: Date.now() - startedAt,
        });
        if (authenticated) {
          logPageDisplay("welcome_telegram_oidc_sign_in", {
            source,
            elapsedMs: Date.now() - startedAt,
          });
          signIn();
        }
      } catch (error) {
        logPageDisplay("welcome_telegram_oidc_session_probe_error", {
          source,
          message: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
        });
      }
    },
    [signIn],
  );

  useEffect(() => {
    if (!hasWelcomeBrowserAuthContext() || typeof document === "undefined") return;
    if (isActuallyInTelegram()) return;

    const onOAuthComplete = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          error?: string | null;
          success?: boolean;
          sessionToken?: string | null;
        }>
      ).detail;
      if (detail?.sessionToken) {
        setDesktopSessionToken(detail.sessionToken);
        dispatchAuthSessionUpdated();
      }
      if (detail?.error) {
        logPageDisplay("welcome_oauth_desktop_callback_error", { reason: detail.error });
        Alert.alert(
          t("welcome.auth.telegramBrowserAlertTitle"),
          tf("welcome.auth.telegramCallbackError", { reason: detail.error }),
        );
        return;
      }
      void probeBrowserSession("oauth_complete");
    };

    document.addEventListener("hsp-oauth-complete", onOAuthComplete);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void probeBrowserSession("visibility");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("hsp-oauth-complete", onOAuthComplete);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [probeBrowserSession, t, tf]);

  const isWideLayout = layoutReady && windowWidth > WIDE_LAYOUT_MIN_WIDTH;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <HspScrollColumn style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View
          style={[
            styles.content,
            { paddingHorizontal: layout.contentSideInsetPx, paddingTop: CONTENT_GAP_BELOW_HEADER },
          ]}
        >
          <View style={styles.introBlock}>
            <View style={styles.headingBlock}>
              <Text
                style={[
                  styles.headingText,
                  isWideLayout ? styles.headingTextWide : styles.headingTextNarrow,
                  { color: colors.primary },
                ]}
              >
                {t("welcome.title")}
              </Text>
            </View>
            <View style={styles.languageBlock}>
              <WelcomeLanguageSwitcher />
            </View>
            <View style={styles.subtitleBlock}>
              <Text style={[styles.subtitleText, { color: colors.secondary }]}>
                {t("welcome.subtitle")}
              </Text>
            </View>
          </View>
          <View style={styles.authBlock}>
            <WelcomeAuthButtons />
          </View>
        </View>
      </HspScrollColumn>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 0,
  },
  content: {
    alignItems: "center",
  },
  introBlock: {
    width: "100%",
    maxWidth: MAX_TEXT_WIDTH,
    alignItems: "center",
  },
  subtitleBlock: {
    width: "100%",
    maxWidth: MAX_TEXT_WIDTH,
    marginTop: GAP_LANGUAGE_TO_SUBTITLE,
  },
  subtitleText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "400",
    textAlign: "center",
    includeFontPadding: false,
    paddingVertical: 0,
  },
  headingBlock: {
    width: "100%",
    maxWidth: MAX_TEXT_WIDTH,
  },
  headingText: {
    fontWeight: "400",
    textAlign: "center",
    includeFontPadding: false,
    paddingVertical: 0,
    width: "100%",
    flexShrink: 0,
  },
  headingTextWide: {
    fontSize: HEADING_FONT_WIDE,
    lineHeight: HEADING_LINE_WIDE,
  },
  headingTextNarrow: {
    fontSize: 25,
    lineHeight: HEADING_LINE_NARROW,
  },
  languageBlock: {
    width: "100%",
    maxWidth: MAX_TEXT_WIDTH,
    marginTop: GAP_TITLE_TO_LANGUAGE,
    alignItems: "center",
  },
  authBlock: {
    width: "100%",
    maxWidth: MAX_TEXT_WIDTH,
    marginTop: GAP_SUBTITLE_TO_AUTH,
    alignItems: "center",
  },
});
