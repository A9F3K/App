/** Packaged desktop shell (Electron `app://`, local `file://` previews). */
export function isDesktopAppShell(): boolean {
  if (typeof window === "undefined" || !window.location?.href) return false;
  try {
    const { protocol } = new URL(window.location.href);
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return false;
  }
}

/** Browser-style welcome OAuth (web tab or desktop shell with fetch). */
export function hasWelcomeBrowserAuthContext(): boolean {
  return typeof globalThis !== "undefined" && typeof globalThis.fetch === "function";
}

export type DesktopOAuthBridge = {
  openOAuthUrl: (
    authUrl: string,
    apiOrigin: string,
  ) => Promise<{
    ok: boolean;
    error?: string | null;
    sessionToken?: string | null;
  }>;
};

declare global {
  interface Window {
    __HSP_DESKTOP__?: DesktopOAuthBridge;
  }
}

export function getDesktopOAuthBridge(): DesktopOAuthBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.__HSP_DESKTOP__;
  return bridge && typeof bridge.openOAuthUrl === "function" ? bridge : null;
}
