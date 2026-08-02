const { BrowserWindow } = require("electron");
const { ensureBrowserWindowAllowsOsCapture } = require("./os-screenshot.cjs");

const SESSION_COOKIE = "hs_auth_session";

function normalizeOrigin(raw) {
  try {
    return new URL(String(raw || "").trim()).origin;
  } catch {
    return "";
  }
}

function isAuthCallbackPath(pathname) {
  return (
    pathname === "/api/auth/google/callback" ||
    pathname === "/api/auth/telegram/callback" ||
    pathname === "/api/auth/github/callback" ||
    pathname === "/api/auth/apple/callback"
  );
}

function isAuthApiPath(pathname) {
  return typeof pathname === "string" && pathname.startsWith("/api/auth/");
}

/**
 * OAuth in a modal window sharing the main session so `hs_auth_session` cookies land in Electron,
 * not the user's external browser.
 *
 * The main UI loads from `app://`, so cross-site fetches to the HTTPS API do not send cookies.
 * On success we read the session cookie from the shared partition and pass it to the renderer
 * (see auth/desktopSessionToken.ts + Authorization bearer on /api/*).
 *
 * Important: after Telegram/Google redirect to the API host home (`/`), we must close this window
 * *before* the production SPA boots inside it — otherwise the user ends up with two app windows
 * (Landing on `app://` + authenticated home in the oauth child).
 */
function openOAuthBrowserWindow({ authUrl, apiOrigin, parentWindow, log }) {
  return new Promise((resolve) => {
    if (!parentWindow || parentWindow.isDestroyed()) {
      resolve({ ok: false, error: "parent_window_unavailable" });
      return;
    }

    const apiOriginNormalized = normalizeOrigin(apiOrigin);
    if (!apiOriginNormalized) {
      resolve({ ok: false, error: "invalid_api_origin" });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (cookiePollTimer != null) {
        clearInterval(cookiePollTimer);
        cookiePollTimer = null;
      }
      resolve(result);
    };

    /** @type {ReturnType<typeof setInterval> | null} */
    let cookiePollTimer = null;
    let sawTelegramOrProviderHost = false;

    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow,
      modal: true,
      show: false,
      autoHideMenuBar: true,
      title: "Sign in",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: false,
        session: parentWindow.webContents.session,
      },
    });
    ensureBrowserWindowAllowsOsCapture(authWindow, log);

    const notifyMain = (detail) => {
      if (parentWindow.isDestroyed()) return;
      try {
        const payload = JSON.stringify(detail ?? {});
        parentWindow.webContents.executeJavaScript(
          `document.dispatchEvent(new CustomEvent("hsp-oauth-complete", { detail: ${payload} }))`,
        );
      } catch (e) {
        log?.(`oauth notifyMain: ${e?.message || e}`);
      }
    };

    const focusParent = () => {
      try {
        if (parentWindow.isDestroyed()) return;
        if (parentWindow.isMinimized()) parentWindow.restore();
        parentWindow.show();
        parentWindow.focus();
      } catch (e) {
        log?.(`oauth focusParent: ${e?.message || e}`);
      }
    };

    const closeAuthWindow = () => {
      try {
        if (!authWindow.isDestroyed()) authWindow.close();
      } catch (_) {}
    };

    const readSessionToken = async () => {
      try {
        const cookies = await authWindow.webContents.session.cookies.get({
          url: `${apiOriginNormalized}/`,
          name: SESSION_COOKIE,
        });
        const value = cookies[0]?.value;
        return typeof value === "string" && value.trim() ? value.trim() : null;
      } catch (e) {
        log?.(`oauth readSessionToken: ${e?.message || e}`);
        return null;
      }
    };

    const isPostAuthAppUrl = (targetUrl) => {
      let u;
      try {
        u = new URL(targetUrl);
      } catch {
        return false;
      }
      if (u.origin !== apiOriginNormalized) return false;
      // Still on the OAuth callback / start endpoints — wait for the next hop.
      if (isAuthCallbackPath(u.pathname) || isAuthApiPath(u.pathname)) return false;
      return true;
    };

    const completeSuccess = async (targetUrl, phase, opts = {}) => {
      if (settled) return true;
      const oauthError =
        (() => {
          try {
            const u = new URL(targetUrl);
            return (
              u.searchParams.get("googleAuthError") ||
              u.searchParams.get("telegramAuthError") ||
              u.searchParams.get("githubAuthError") ||
              u.searchParams.get("appleAuthError") ||
              null
            );
          } catch {
            return null;
          }
        })() || null;

      let sessionToken = null;
      if (!oauthError) {
        sessionToken = await readSessionToken();
        // Cookie can lag a tick behind will-redirect; retry briefly.
        if (!sessionToken) {
          for (let i = 0; i < 8 && !sessionToken; i += 1) {
            await new Promise((r) => setTimeout(r, 50));
            sessionToken = await readSessionToken();
          }
        }
        if (!sessionToken) {
          log?.(`oauth success redirect but no ${SESSION_COOKIE} cookie on ${apiOriginNormalized} phase=${phase}`);
        }
      }

      log?.(
        `oauth finish phase=${phase} ok=${!oauthError} hasToken=${Boolean(sessionToken)} url=${String(targetUrl).slice(0, 120)}`,
      );
      closeAuthWindow();
      focusParent();
      notifyMain({
        success: !oauthError,
        error: oauthError,
        phase,
        sessionToken,
      });
      finish({ ok: !oauthError, error: oauthError, sessionToken });
      return true;
    };

    const tryFinishFromUrl = async (targetUrl, phase, opts = {}) => {
      if (settled) return true;
      let u;
      try {
        u = new URL(targetUrl);
      } catch {
        return false;
      }

      if (
        u.hostname === "oauth.telegram.org" ||
        u.hostname.endsWith(".telegram.org") ||
        u.hostname === "accounts.google.com" ||
        u.hostname === "github.com" ||
        u.hostname.endsWith(".github.com") ||
        u.hostname === "appleid.apple.com"
      ) {
        sawTelegramOrProviderHost = true;
      }

      if (!isPostAuthAppUrl(targetUrl)) return false;

      // Prefer aborting navigation so the production SPA never mounts in this window.
      if (opts.preventDefault && typeof opts.preventDefault === "function") {
        try {
          opts.preventDefault();
        } catch (_) {}
      }

      return completeSuccess(targetUrl, phase, opts);
    };

    // Once the session cookie appears after visiting the IdP, finish even if URL
    // matching missed a soft navigation (Expo client router, etc.).
    const startCookiePoll = () => {
      if (cookiePollTimer != null) return;
      cookiePollTimer = setInterval(() => {
        if (settled || authWindow.isDestroyed()) {
          if (cookiePollTimer != null) {
            clearInterval(cookiePollTimer);
            cookiePollTimer = null;
          }
          return;
        }
        if (!sawTelegramOrProviderHost) return;
        void (async () => {
          const token = await readSessionToken();
          if (!token || settled) return;
          const current = authWindow.isDestroyed() ? "" : authWindow.webContents.getURL();
          if (current && isPostAuthAppUrl(current)) {
            await completeSuccess(current, "cookie_poll");
            return;
          }
          // Cookie set after callback but still mid-redirect — finish on next tick.
          if (current && normalizeOrigin(current) === apiOriginNormalized) {
            await completeSuccess(current || `${apiOriginNormalized}/`, "cookie_poll_api_host");
          }
        })();
      }, 250);
    };

    authWindow.once("ready-to-show", () => {
      try {
        authWindow.show();
      } catch (_) {}
    });

    // Abort the home redirect before the SPA loads (primary fix for dual windows).
    authWindow.webContents.on("will-redirect", (event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "will-redirect", {
        preventDefault: () => event.preventDefault(),
      });
    });

    authWindow.webContents.on("will-navigate", (event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "will-navigate", {
        preventDefault: () => event.preventDefault(),
      });
    });

    authWindow.webContents.on("did-navigate", (_event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "did-navigate");
    });

    authWindow.webContents.on("did-navigate-in-page", (_event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "did-navigate-in-page");
    });

    authWindow.webContents.on("did-finish-load", () => {
      if (settled || authWindow.isDestroyed()) return;
      const current = authWindow.webContents.getURL();
      void tryFinishFromUrl(current, "did-finish-load");
    });

    authWindow.on("closed", () => {
      if (!settled) {
        notifyMain({ success: false, error: "oauth_window_closed", phase: "closed" });
        finish({ ok: false, error: "oauth_window_closed" });
      }
    });

    authWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
      log?.(`oauth did-fail-load code=${code} ${desc} ${url}`);
    });

    startCookiePoll();

    authWindow.loadURL(authUrl).catch((e) => {
      log?.(`oauth loadURL failed: ${e?.message || e}`);
      closeAuthWindow();
      notifyMain({ success: false, error: "oauth_load_failed", phase: "load" });
      finish({ ok: false, error: "oauth_load_failed" });
    });
  });
}

function registerOAuthIpc({ ipcMain, getMainWindow, log }) {
  ipcMain.handle("hsp-open-oauth-url", async (_event, payload) => {
    const authUrl = payload?.authUrl;
    const apiOrigin = payload?.apiOrigin;
    if (typeof authUrl !== "string" || !authUrl.trim()) {
      return { ok: false, error: "missing_auth_url" };
    }
    if (typeof apiOrigin !== "string" || !apiOrigin.trim()) {
      return { ok: false, error: "missing_api_origin" };
    }
    const parentWindow = getMainWindow?.();
    log?.(
      `oauth start authUrlHost=${(() => {
        try {
          return new URL(authUrl).host;
        } catch {
          return "?";
        }
      })()} apiOrigin=${apiOrigin}`,
    );
    return openOAuthBrowserWindow({ authUrl, apiOrigin, parentWindow, log });
  });
}

module.exports = { openOAuthBrowserWindow, registerOAuthIpc };
