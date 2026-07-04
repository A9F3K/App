import { Alert, Pressable, StyleSheet, Text, View, Platform } from "react-native";
import { useEffect, useState } from "react";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import { buildApiUrl } from "../../api/_base";
import {
  useColors,
  typographyFixedRow40Label,
  uiIconButtonVerticalCompensationY,
  welcomeAuthButtonHoverBackground,
  welcomeAuthButtonActiveBackground,
} from "../theme";
import { useAppStrings } from "../../locales/AppStringsContext";
import type { AppStringKey } from "../../locales/appStrings";
import { WelcomeAppPreviews } from "./WelcomeAppPreviews";
import { WelcomeAuthFormField, WELCOME_AUTH_MAX_WIDTH } from "./WelcomeAuthFormField";
import { useWelcomeEmailAuth } from "../welcome/WelcomeEmailAuthContext";
import { useTelegram } from "./Telegram";
import { isActuallyInTelegram } from "./telegramWebApp";
import { getApiBaseUrl } from "../../api/_base";
import { navigateExternalAuthUrl } from "../openExternalUrl";
import { logPageDisplay } from "../pageDisplayLog";
import { appError } from "../../shared/appLog";
import { isDesktopAppShell } from "../appShell";

const BUTTON_HEIGHT = 40;
const BUTTON_GAP = 20;
const BUTTON_H_PADDING = 20;
const ICON_SIZE = 16;
const ICON_GAP = 10;
const GAP_BEFORE_EMAIL_BLOCK = 20;

const ICONS = {
  google: {
    black: require("../../assets/networks/black/Google.svg"),
    white: require("../../assets/networks/white/Google.svg"),
  },
  github: {
    black: require("../../assets/networks/black/GitHub.svg"),
    white: require("../../assets/networks/white/GitHub.svg"),
  },
  apple: {
    black: require("../../assets/networks/black/Apple.svg"),
    white: require("../../assets/networks/white/Apple.svg"),
  },
  telegram: {
    black: require("../../assets/networks/black/Telegram.svg"),
    white: require("../../assets/networks/white/Telegram.svg"),
  },
} as const;

type BrowserOAuthProvider = "telegram" | "google" | "github" | "apple";

const PROVIDER_ROWS: { id: BrowserOAuthProvider; labelKey: AppStringKey }[] = [
  { id: "google", labelKey: "welcome.auth.signInGoogle" },
  { id: "github", labelKey: "welcome.auth.signInGithub" },
  { id: "apple", labelKey: "welcome.auth.signInApple" },
  { id: "telegram", labelKey: "welcome.auth.signInTelegram" },
];

const BROWSER_OAUTH: Record<
  BrowserOAuthProvider,
  {
    startPath: string;
    callbackPath: string;
    logPrefix: string;
    alertTitleKey: AppStringKey;
    startErrorKey: AppStringKey;
  }
> = {
  telegram: {
    startPath: "/api/auth/telegram/start",
    callbackPath: "/api/auth/telegram/callback",
    logPrefix: "welcome_telegram_oidc",
    alertTitleKey: "welcome.auth.telegramBrowserAlertTitle",
    startErrorKey: "welcome.auth.telegramStartError",
  },
  google: {
    startPath: "/api/auth/google/start",
    callbackPath: "/api/auth/google/callback",
    logPrefix: "welcome_google_oidc",
    alertTitleKey: "welcome.auth.googleBrowserAlertTitle",
    startErrorKey: "welcome.auth.googleStartError",
  },
  github: {
    startPath: "/api/auth/github/start",
    callbackPath: "/api/auth/github/callback",
    logPrefix: "welcome_github_oauth",
    alertTitleKey: "welcome.auth.githubBrowserAlertTitle",
    startErrorKey: "welcome.auth.githubStartError",
  },
  apple: {
    startPath: "/api/auth/apple/start",
    callbackPath: "/api/auth/apple/callback",
    logPrefix: "welcome_apple_oidc",
    alertTitleKey: "welcome.auth.appleBrowserAlertTitle",
    startErrorKey: "welcome.auth.appleStartError",
  },
};

/**
 * Stacked auth provider rows: label + icon (reference: assets/networks/auth.png).
 * Light theme → black icons on `undercover`; dark → white icons.
 *
 * Row is `justifyContent: "center"` with [text, icon]. If an icon is slow or fails to render,
 * only the text measures — the label stays centered in the full button. When the icon appears,
 * the centered group may shift slightly (acceptable tradeoff).
 */
function isValidBasicEmail(value: string): boolean {
  const email = value.trim();
  // Basic structure only: local@domain.zone (no provider allow-list).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function WelcomeAuthButtons() {
  const router = useRouter();
  const { signIn } = useAuth();
  const colors = useColors();
  const { t } = useAppStrings();
  const { colorScheme, isInTelegram, triggerHaptic } = useTelegram();
  const { openEmailCodeSheet } = useWelcomeEmailAuth();
  const [browserOAuthPending, setBrowserOAuthPending] = useState<BrowserOAuthProvider | null>(null);
  const [email, setEmail] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  /** Web hover: RN `Pressable` style state has no `hovered` in typings; use hover events (see theme hover helpers). */
  const [hoverOAuthId, setHoverOAuthId] = useState<BrowserOAuthProvider | null>(null);
  const useBlackIcons = colorScheme === "light";

  useEffect(() => {
    if (!isDesktopAppShell() || typeof document === "undefined") return;
    const onOAuthComplete = () => {
      setBrowserOAuthPending(null);
    };
    document.addEventListener("hsp-oauth-complete", onOAuthComplete);
    return () => document.removeEventListener("hsp-oauth-complete", onOAuthComplete);
  }, []);

  /**
   * Telegram Login / OIDC via `/api/auth/telegram/start` whenever we are **not** in a real Mini App
   * session (`isActuallyInTelegram`). Includes normal browsers **and** Windows/Electron (or other
   * `Platform.OS` values) where `window.location.assign` may be absent — then {@link Linking.openURL}
   * opens the system browser.
   *
   * Do not gate on `Platform.OS === "web"` alone: desktop shells report other OS values and would
   * otherwise fall through to `Alert` only (often invisible / no-op).
   */
  const useTelegramWebAuthOutsideMiniApp =
    typeof globalThis !== "undefined" &&
    typeof globalThis.fetch === "function" &&
    !isActuallyInTelegram();

  const useBrowserOAuth =
    typeof globalThis !== "undefined" && typeof globalThis.fetch === "function";

  const startBrowserOAuth = async (provider: BrowserOAuthProvider) => {
    const cfg = BROWSER_OAUTH[provider];
    const startUrl = buildApiUrl(cfg.startPath);
    const redirectUri = buildApiUrl(cfg.callbackPath);
    const startedAt = Date.now();
    let navigated = false;
    const alertTitle = t(cfg.alertTitleKey);
    const startError = t(cfg.startErrorKey);

    try {
      setBrowserOAuthPending(provider);
      logPageDisplay(`${cfg.logPrefix}_start`, {
        apiBase: getApiBaseUrl(),
        startUrl,
        redirectUri,
        platform: Platform.OS,
        pageOrigin: typeof window !== "undefined" ? window.location?.origin : null,
      });
      const response = await fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "welcome",
          redirect_uri: redirectUri,
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authUrl?: string;
        error?: string;
      };
      logPageDisplay(`${cfg.logPrefix}_response`, {
        status: response.status,
        ok: response.ok,
        bodyOk: json?.ok,
        hasAuthUrl: Boolean(json?.authUrl),
        error: json?.error ?? null,
        elapsedMs: Date.now() - startedAt,
      });
      if (!response.ok || !json?.authUrl) {
        throw new Error(json?.error || `HTTP_${response.status}`);
      }
      let authUrlHost: string | null = null;
      try {
        authUrlHost = new URL(json.authUrl).host;
      } catch {
        authUrlHost = null;
      }
      const openMethod = navigateExternalAuthUrl(json.authUrl);
      navigated = openMethod !== "desktop_oauth_window";
      logPageDisplay(`${cfg.logPrefix}_redirect`, {
        authUrlHost,
        openMethod,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appError("[welcome]", `${provider}_auth_start_failed`, { message }, error);
      logPageDisplay(`${cfg.logPrefix}_error`, {
        message,
        startUrl,
        elapsedMs: Date.now() - startedAt,
      });
      Alert.alert(alertTitle, startError);
    } finally {
      if (!navigated) {
        setBrowserOAuthPending(null);
      }
    }
  };

  const startEmailSignIn = async () => {
    if (!useBrowserOAuth) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidBasicEmail(normalizedEmail)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setEmailSubmitting(true);
    const startedAt = Date.now();
    const startUrl = buildApiUrl("/api/auth/email/start");
    try {
      logPageDisplay("welcome_email_start", {
        apiBase: getApiBaseUrl(),
        startUrl,
        platform: Platform.OS,
      });
      const response = await fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: normalizedEmail,
          source: "welcome",
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        attemptId?: string;
        error?: string;
      };
      logPageDisplay("welcome_email_start_response", {
        status: response.status,
        ok: response.ok,
        bodyOk: json?.ok,
        hasAttemptId: Boolean(json?.attemptId),
        error: json?.error ?? null,
        elapsedMs: Date.now() - startedAt,
      });
      if (!response.ok || !json?.ok || !json.attemptId) {
        throw new Error(json?.error || `HTTP_${response.status}`);
      }
      setEmail(normalizedEmail);
      openEmailCodeSheet({ email: normalizedEmail, attemptId: json.attemptId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appError("[welcome]", "email_auth_start_failed", { message }, error);
      logPageDisplay("welcome_email_start_error", {
        message,
        startUrl,
        elapsedMs: Date.now() - startedAt,
      });
      Alert.alert(t("welcome.auth.emailBrowserAlertTitle"), t("welcome.auth.emailStartError"));
    } finally {
      setEmailSubmitting(false);
    }
  };

  const onProviderPress = async (id: BrowserOAuthProvider) => {
    if (id === "google" || id === "github" || id === "apple") {
      if (!useBrowserOAuth) return;
      await startBrowserOAuth(id);
      return;
    }

    if (id === "telegram") {
      const actuallyInTelegram = isActuallyInTelegram();
      logPageDisplay("welcome_telegram_press", {
        useTelegramWebAuthOutsideMiniApp,
        isInTelegram,
        actuallyInTelegram,
        platform: Platform.OS,
        pageOrigin: typeof window !== "undefined" ? window.location?.origin : null,
      });

      if (useTelegramWebAuthOutsideMiniApp) {
        await startBrowserOAuth("telegram");
        return;
      }
      if (!isInTelegram) {
        logPageDisplay("welcome_telegram_oidc_unavailable", {
          reason: "not_in_telegram_and_web_auth_disabled",
          actuallyInTelegram,
          useTelegramWebAuthOutsideMiniApp,
        });
        Alert.alert(
          t("welcome.auth.telegramBrowserAlertTitle"),
          t("welcome.auth.telegramBrowserAlertMessage"),
        );
        return;
      }
      // Web / TMA: any Telegram haptic (sync or deferred) can desync react-native-web’s touch bank on
      // tdesktop. Native keeps haptics; web skips.
      if (Platform.OS !== "web") {
        triggerHaptic("light");
      }
      logPageDisplay("welcome_telegram_miniapp_sign_in", { actuallyInTelegram });
      signIn();
      router.replace("/");
      return;
    }
  };

  return (
    <View style={styles.column}>
      {PROVIDER_ROWS.map((row, index) => {
        const src = useBlackIcons ? ICONS[row.id].black : ICONS[row.id].white;
        const label = t(row.labelKey);
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => onProviderPress(row.id)}
            onHoverIn={
              Platform.OS === "web"
                ? () => {
                    setHoverOAuthId(row.id);
                  }
                : undefined
            }
            onHoverOut={
              Platform.OS === "web"
                ? () => {
                    setHoverOAuthId((cur) => (cur === row.id ? null : cur));
                  }
                : undefined
            }
            style={({ pressed }) => {
              const webHover = Platform.OS === "web" && hoverOAuthId === row.id;
              let backgroundColor = colors.undercover;
              if (pressed) {
                backgroundColor = welcomeAuthButtonActiveBackground(colors, colorScheme);
              } else if (webHover) {
                backgroundColor = welcomeAuthButtonHoverBackground(colors, colorScheme);
              }
              return [
                styles.button,
                {
                  backgroundColor,
                  marginTop: index > 0 ? BUTTON_GAP : 0,
                  opacity:
                    row.id === browserOAuthPending ? 0.6 : pressed ? 0.92 : 1,
                },
              ];
            }}
          >
            <Text style={[styles.label, { color: colors.primary }]} numberOfLines={1}>
              {label}
            </Text>
            <Image
              source={src}
              style={[
                styles.iconDims,
                {
                  transform: [{ translateY: uiIconButtonVerticalCompensationY }],
                },
              ]}
              contentFit="contain"
            />
          </Pressable>
        );
      })}
      <View style={{ marginTop: GAP_BEFORE_EMAIL_BLOCK, width: "100%", alignItems: "center" }}>
        <WelcomeAuthFormField
          label={t("welcome.auth.signInEmailTitle")}
          value={email}
          onChangeText={(next) => {
            setEmail(next);
            if (emailInvalid) setEmailInvalid(false);
          }}
          placeholder={t("welcome.auth.emailPlaceholder")}
          keyboardType="email-address"
          inputId="welcome-email-input"
          errorText={emailInvalid ? t("welcome.auth.emailInvalid") : null}
          submitLabel={t("welcome.auth.signInButton")}
          onSubmit={startEmailSignIn}
          submitting={emailSubmitting}
          submitDisabled={emailSubmitting}
        />
      </View>
      <WelcomeAppPreviews />
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    width: "100%",
    maxWidth: WELCOME_AUTH_MAX_WIDTH,
    alignItems: "center",
  },
  button: {
    width: "100%",
    maxWidth: WELCOME_AUTH_MAX_WIDTH,
    height: BUTTON_HEIGHT,
    paddingHorizontal: BUTTON_H_PADDING,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: ICON_GAP,
  },
  label: {
    ...typographyFixedRow40Label,
    flexShrink: 1,
  },
  iconDims: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
});
