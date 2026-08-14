const { desktopCapturer, dialog, BrowserWindow } = require("electron");

/**
 * Enable navigator.mediaDevices.getDisplayMedia in the Electron shell.
 * Without this handler Chromium throws NotSupportedError → UI "open in Chrome/Edge".
 *
 * @param {{
 *   session: import("electron").Session,
 *   getMainWindow: () => import("electron").BrowserWindow | null,
 *   log?: (msg: string) => void,
 * }} opts
 */
function allowDisplayCapturePermissions(session, log) {
  try {
    if (typeof session.setPermissionCheckHandler === "function") {
      session.setPermissionCheckHandler(() => true);
    }
    if (typeof session.setPermissionRequestHandler === "function") {
      session.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(true);
      });
    }
    log?.("[display-media] media/display-capture permissions allowed");
  } catch (err) {
    log?.(`[display-media] permission handlers: ${err?.message || err}`);
  }
}

function registerDisplayMediaHandler({ session, getMainWindow, log }) {
  if (!session || typeof session.setDisplayMediaRequestHandler !== "function") {
    log?.("[display-media] setDisplayMediaRequestHandler unavailable");
    return;
  }

  allowDisplayCapturePermissions(session, log);

  const handler = async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        // Zero-size thumbs failed to enumerate sources on some Windows builds.
        thumbnailSize: { width: 150, height: 150 },
        fetchWindowIcons: false,
      });
      const screens = sources.filter((s) => String(s.id || "").startsWith("screen:"));
      const pickList = (screens.length > 0 ? screens : sources).slice(0, 8);
      if (pickList.length === 0) {
        log?.("[display-media] no desktop sources");
        callback({});
        return;
      }

      const parent =
        BrowserWindow.getFocusedWindow() ||
        getMainWindow?.() ||
        BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed()) ||
        null;

      const labels = pickList.map((s) => {
        const name = String(s.name || s.id || "Screen").trim() || "Screen";
        return name.length > 48 ? `${name.slice(0, 45)}…` : name;
      });

      const result = await dialog.showMessageBox(parent ?? undefined, {
        type: "question",
        buttons: [...labels, "Cancel"],
        defaultId: 0,
        cancelId: labels.length,
        title: "Screen sharing",
        message: "Choose a screen or window to share",
        noLink: true,
      });

      if (result.response < 0 || result.response >= labels.length) {
        log?.("[display-media] user cancelled");
        callback({});
        return;
      }

      const chosen = pickList[result.response];
      log?.(
        `[display-media] granted id=${chosen.id} name=${JSON.stringify(chosen.name || "")}`,
      );
      // Video only — system loopback would feed into the voice SFU as mic noise.
      callback({ video: chosen });
    } catch (err) {
      log?.(`[display-media] handler failed: ${err?.message || err}`);
      try {
        callback({});
      } catch (_) {
        /* ignore */
      }
    }
  };

  try {
    // Windows 10 1809+ / macOS 15+: native picker (same path Chrome uses).
    // The JS handler is skipped when the OS picker is shown.
    session.setDisplayMediaRequestHandler(handler, { useSystemPicker: true });
    log?.("[display-media] getDisplayMedia handler registered (useSystemPicker)");
  } catch (err) {
    session.setDisplayMediaRequestHandler(handler);
    log?.(
      `[display-media] getDisplayMedia handler registered (legacy): ${err?.message || err}`,
    );
  }
}

module.exports = { registerDisplayMediaHandler };
