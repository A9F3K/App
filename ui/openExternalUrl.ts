import * as Linking from "expo-linking";
import { logPageDisplay } from "./pageDisplayLog";
import { getApiBaseUrl } from "../api/_base";
import { getDesktopOAuthBridge, isDesktopAppShell } from "./appShell";

export type ExternalAuthOpenMethod =
  | "top_location_replace"
  | "top_location_href"
  | "anchor_top"
  | "window_open"
  | "linking"
  | "desktop_oauth_window";

export type ExternalAuthOpenResult = {
  method: ExternalAuthOpenMethod;
  ok?: boolean;
  error?: string | null;
  sessionToken?: string | null;
};

function isInNestedFrame(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Open Telegram OIDC in the **top-level** browsing context.
 * Desktop: awaits the Electron oauth child window so the caller can apply the
 * session token and avoid leaving a second authenticated window open.
 * @see https://core.telegram.org/bots/telegram-login — Authorization Code + PKCE; URL must open in the user's browser, not a subframe.
 */
export async function openExternalAuthUrl(url: string): Promise<ExternalAuthOpenResult> {
  if (isDesktopAppShell()) {
    const bridge = getDesktopOAuthBridge();
    if (bridge) {
      const result = await bridge.openOAuthUrl(url, getApiBaseUrl());
      return {
        method: "desktop_oauth_window",
        ok: result?.ok !== false && !result?.error,
        error: result?.error ?? null,
        sessionToken: result?.sessionToken ?? null,
      };
    }
  }

  return { method: navigateExternalAuthUrl(url) };
}

/**
 * Sync navigate helper for non-desktop (and desktop fallback without bridge).
 * Prefer {@link openExternalAuthUrl} when a session token may be returned.
 */
export function navigateExternalAuthUrl(url: string): ExternalAuthOpenMethod {
  if (isDesktopAppShell()) {
    const bridge = getDesktopOAuthBridge();
    if (bridge) {
      void bridge.openOAuthUrl(url, getApiBaseUrl());
      return "desktop_oauth_window";
    }
  }

  if (typeof window === "undefined") {
    void Linking.openURL(url);
    return "linking";
  }

  const nestedFrame = isInNestedFrame();
  logPageDisplay("welcome_telegram_oidc_navigate", {
    nestedFrame,
    urlHost: (() => {
      try {
        return new URL(url).host;
      } catch {
        return null;
      }
    })(),
    hasQuery: url.includes("?") && url.length > url.indexOf("?") + 1,
  });

  if (!nestedFrame) {
    window.location.replace(url);
    return "top_location_replace";
  }

  try {
    window.top!.location.href = url;
    return "top_location_href";
  } catch {
    // Cross-origin parent: cannot assign top.location from here.
  }

  if (typeof document !== "undefined") {
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_top";
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return "anchor_top";
    } catch {
      // continue
    }
  }

  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (popup) {
    return "window_open";
  }

  void Linking.openURL(url);
  return "linking";
}
