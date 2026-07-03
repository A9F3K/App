const { BrowserWindow } = require("electron");
const { ensureBrowserWindowAllowsOsCapture } = require("./os-screenshot.cjs");

const SESSION_COOKIE = "hs_auth_session";

/**
 * OAuth in a modal window sharing the main session so `hs_auth_session` cookies land in Electron,
 * not the user's external browser.
 *
 * The main UI loads from `app://`, so cross-site fetches to the HTTPS API do not send cookies.
 * On success we read the session cookie from the shared partition and pass it to the renderer
 * (see auth/desktopSessionToken.ts + Authorization bearer on /api/*).
 */
function openOAuthBrowserWindow({ authUrl, apiOrigin, parentWindow, log }) {
  return new Promise((resolve) => {
    if (!parentWindow || parentWindow.isDestroyed()) {
      resolve({ ok: false, error: "parent_window_unavailable" });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow,
      modal: true,
      show: false,
      autoHideMenuBar: true,
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

    const readSessionToken = async () => {
      try {
        const cookies = await authWindow.webContents.session.cookies.get({
          url: `${apiOrigin}/`,
          name: SESSION_COOKIE,
        });
        const value = cookies[0]?.value;
        return typeof value === "string" && value.trim() ? value.trim() : null;
      } catch (e) {
        log?.(`oauth readSessionToken: ${e?.message || e}`);
        return null;
      }
    };

    const tryFinishFromUrl = async (targetUrl, phase) => {
      let u;
      try {
        u = new URL(targetUrl);
      } catch {
        return false;
      }
      if (u.origin !== apiOrigin) return false;

      if (u.pathname === "/api/auth/google/callback" || u.pathname === "/api/auth/telegram/callback") {
        return false;
      }

      if (u.pathname !== "/") return false;

      const oauthError =
        u.searchParams.get("googleAuthError") ||
        u.searchParams.get("telegramAuthError") ||
        u.searchParams.get("githubAuthError") ||
        u.searchParams.get("appleAuthError") ||
        null;

      let sessionToken = null;
      if (!oauthError) {
        sessionToken = await readSessionToken();
        if (!sessionToken) {
          log?.(`oauth success redirect but no ${SESSION_COOKIE} cookie on ${apiOrigin}`);
        }
      }

      if (!authWindow.isDestroyed()) authWindow.close();
      notifyMain({ success: !oauthError, error: oauthError, phase, sessionToken });
      finish({ ok: !oauthError, error: oauthError, sessionToken });
      return true;
    };

    authWindow.once("ready-to-show", () => {
      try {
        authWindow.show();
      } catch (_) {}
    });

    authWindow.webContents.on("did-navigate", (_event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "did-navigate");
    });

    authWindow.webContents.on("did-navigate-in-page", (_event, targetUrl) => {
      void tryFinishFromUrl(targetUrl, "did-navigate-in-page");
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

    authWindow.loadURL(authUrl).catch((e) => {
      log?.(`oauth loadURL failed: ${e?.message || e}`);
      if (!authWindow.isDestroyed()) authWindow.close();
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
