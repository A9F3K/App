import { useEffect, useRef, type ComponentType } from "react";
import type { ViewProps } from "react-native";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { WelcomeContent } from "../ui/components/WelcomeContent";
import { getBuildDisplaySnapshot, logPageDisplay } from "../ui/pageDisplayLog";
import { HomeAuthenticatedScreen } from "../ui/screens/HomeAuthenticatedScreen";
import { dark } from "../ui/theme";

/** react-native-web forwards this to the DOM; RN `View` typings omit it. */
const ShellView = View as ComponentType<ViewProps & { suppressHydrationWarning?: boolean }>;
/**
 * Root URL `http://localhost:3000/` (path `/`): welcome when signed out, main app when signed in.
 * Same URL for both — only session state chooses the screen; legacy `/home` redirects here.
 *
 * Waits for `authHydrated` + `authReady` (session `GET` finished); no optimistic route from
 * `localStorage` so we do not flash the authenticated home when the server session is missing.
 * When the session is valid, we show home after bootstrap.
 */
/** Stable first paint on web so server HTML and client hydration match (avoids React #418). */
const INDEX_WEB_HYDRATE_BG = "#000000";

export default function Index() {
  const { isAuthenticated, authReady, authHydrated } = useAuth();
  const lastLoggedVariantRef = useRef<string | null>(null);

  useEffect(() => {
    const variant = !authHydrated
      ? "bootstrap_pending_hydration"
      : !authReady
        ? "bootstrap_pending_auth"
      : isAuthenticated
        ? "home_authenticated"
        : "welcome";
    if (lastLoggedVariantRef.current === variant) return;
    lastLoggedVariantRef.current = variant;
    logPageDisplay("index_route", {
      variant,
      sessionPending: !authReady,
      authHydrated,
      authReady,
      isAuthenticated,
      build: getBuildDisplaySnapshot(),
    });
  }, [authHydrated, authReady, isAuthenticated]);

  if (!authHydrated || !authReady) {
    return (
      <ShellView
        suppressHydrationWarning
        style={{
          flex: 1,
          backgroundColor: INDEX_WEB_HYDRATE_BG,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator size="large" color={dark.primary} />
      </ShellView>
    );
  }

  if (isAuthenticated) {
    return (
      <ShellView suppressHydrationWarning style={{ flex: 1, minHeight: 0 }}>
        <HomeAuthenticatedScreen />
      </ShellView>
    );
  }
  return (
    <ShellView suppressHydrationWarning style={{ flex: 1, minHeight: 0 }}>
      <WelcomeContent />
    </ShellView>
  );
}
