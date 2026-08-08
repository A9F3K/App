import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { buildApiUrl } from "../api/_base";
import { clearDesktopSessionToken } from "./desktopSessionToken";
import { installDesktopAuthFetch } from "./installDesktopAuthFetch";
import {
  clearAuthSessionPayloadCache,
  rememberAuthSessionPayload,
} from "./lastAuthSessionCache";
import { kickEagerTelegramMessagesWarmup } from "./eagerTelegramMessagesWarmup";
import { useAppStrings } from "../locales/AppStringsContext";
import { logPageDisplay } from "../ui/pageDisplayLog";

export type AuthContextValue = {
  isAuthenticated: boolean;
  authReady: boolean;
  authHydrated: boolean;
  /** Feed rows from `GET /api/auth/session` (same shape as `/api/feed` → `items`). */
  sessionFeedItems: unknown[] | null;
  /** Telegram MTProto messages link persisted for this account (survives app logout/login). */
  sessionTelegramMessagesConnected: boolean | null;
  signIn: () => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_HINT_STORAGE_KEY = "hs_auth_hint_v1";

type AuthHint = "in" | "out";

function writeAuthHint(value: AuthHint): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_HINT_STORAGE_KEY, value);
  } catch {
    // ignore storage failures (private mode, strict browser settings)
  }
}

function dispatchAuthLifecycleEvent(name: "hsp-auth-signed-in" | "hsp-auth-signed-out"): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent(name));
}

type SessionJson = {
  authenticated?: boolean;
  feed_items?: unknown;
  telegram_messages_connected?: boolean;
  telegram_username?: string;
  display_name?: string;
  has_wallet?: boolean;
  wallet_required?: boolean;
  wallet?: {
    id?: string | number;
    wallet_address?: string;
    wallet_blockchain?: string;
    wallet_net?: string;
    type?: string;
    label?: string | null;
    is_default?: boolean;
    source?: string;
  } | null;
};

function parseSessionResponse(json: SessionJson, responseOk: boolean) {
  const authenticated = responseOk && json?.authenticated === true;
  const feedRaw = json.feed_items;
  const feedItems = Array.isArray(feedRaw) ? feedRaw : null;
  const telegramMessagesConnected =
    authenticated && json.telegram_messages_connected === true ? true : authenticated ? false : null;
  return { authenticated, feedItems, telegramMessagesConnected };
}

function cacheSessionPayload(json: SessionJson, authenticated: boolean): void {
  if (!authenticated) {
    rememberAuthSessionPayload({ authenticated: false });
    return;
  }
  rememberAuthSessionPayload({
    authenticated: true,
    telegram_username: json.telegram_username,
    display_name: json.display_name,
    has_wallet: json.has_wallet,
    wallet_required: json.wallet_required,
    wallet: json.wallet ?? null,
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { welcomeFeedCatalogLocale } = useAppStrings();
  // SSR / first paint: keep default state. Do not read the stored auth hint before session:
  // a stale "in" hint flashed `HomeAuthenticatedScreen` before `GET /api/auth/session` returned
  // (welcome blink) and could participate in client/server tree mismatch (React #418). Session
  // is the only source of truth for initial `isAuthenticated`; we still `writeAuthHint` after
  // bootstrap and on signIn/signOut for a soft cache only.
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [sessionFeedItems, setSessionFeedItems] = useState<unknown[] | null>(null);
  const [sessionTelegramMessagesConnected, setSessionTelegramMessagesConnected] = useState<boolean | null>(
    null,
  );

  useLayoutEffect(() => {
    installDesktopAuthFetch();
    setAuthHydrated(true);
  }, []);

  const refreshAuthSession = useCallback(async () => {
    const startedAt = Date.now();
    const sessionUrl = buildApiUrl(
      `/api/auth/session?catalog_locale=${encodeURIComponent(welcomeFeedCatalogLocale)}`,
    );
    try {
      const response = await fetch(sessionUrl, {
        method: "GET",
        credentials: "include",
      });
      const json = (await response.json().catch(() => ({}))) as SessionJson;
      const { authenticated, feedItems, telegramMessagesConnected } = parseSessionResponse(
        json,
        response.ok,
      );
      cacheSessionPayload(json, authenticated);
      // Kick gateway warmup before setState → Home commit (can block effects ~3s).
      if (authenticated && telegramMessagesConnected === true) {
        kickEagerTelegramMessagesWarmup("auth_session");
      }
      writeAuthHint(authenticated ? "in" : "out");
      setAuthenticated(authenticated);
      setSessionFeedItems(authenticated && feedItems && feedItems.length > 0 ? feedItems : null);
      setSessionTelegramMessagesConnected(telegramMessagesConnected);
      logPageDisplay("auth_session_refresh", {
        ok: response.ok,
        status: response.status,
        authenticated,
        telegramMessagesConnected,
        elapsedMs: Date.now() - startedAt,
        feedItemCount: feedItems?.length ?? null,
      });
      return authenticated;
    } catch (error) {
      logPageDisplay("auth_session_refresh_error", {
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setAuthReady(true);
    }
  }, [welcomeFeedCatalogLocale]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      const startedAt = Date.now();
      logPageDisplay("auth_bootstrap_start", {
        catalogLocale: welcomeFeedCatalogLocale,
      });
      const authenticated = await refreshAuthSession();
      if (!cancelled && authenticated) {
        logPageDisplay("auth_bootstrap_signed_in", {
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (!cancelled) {
        logPageDisplay("auth_bootstrap_ready", {
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [refreshAuthSession]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onSessionUpdated = () => {
      void refreshAuthSession();
    };
    document.addEventListener("hsp-auth-session-updated", onSessionUpdated);
    return () => {
      document.removeEventListener("hsp-auth-session-updated", onSessionUpdated);
    };
  }, [refreshAuthSession]);

  const signIn = useCallback(() => {
    writeAuthHint("in");
    setAuthenticated(true);
    setAuthReady(true);
    dispatchAuthLifecycleEvent("hsp-auth-signed-in");
    void refreshAuthSession();
  }, [refreshAuthSession]);

  const signOut = useCallback(() => {
    writeAuthHint("out");
    setAuthenticated(false);
    setAuthReady(true);
    setSessionFeedItems(null);
    setSessionTelegramMessagesConnected(null);
    clearAuthSessionPayloadCache();
    dispatchAuthLifecycleEvent("hsp-auth-signed-out");
    clearDesktopSessionToken();
    // App logout clears the OAuth cookie only; Telegram MTProto link stays in DB for relogin.
    void fetch(buildApiUrl("/api/auth/session"), {
      method: "DELETE",
      credentials: "include",
    }).catch(() => {
      // best effort
    });
  }, []);

  const value = useMemo(
    () => ({
      isAuthenticated,
      authReady,
      authHydrated,
      sessionFeedItems,
      sessionTelegramMessagesConnected,
      signIn,
      signOut,
    }),
    [
      isAuthenticated,
      authReady,
      authHydrated,
      sessionFeedItems,
      sessionTelegramMessagesConnected,
      signIn,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx == null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
