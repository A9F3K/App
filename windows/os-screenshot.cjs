const { spawnSync } = require("child_process");
const path = require("path");

const VK_SNAPSHOT = 0x2c;
const KEYEVENTF_KEYUP = 0x0002;
const WDA_NONE = 0;

function isPrintScreenKey(input) {
  const key = String(input?.key || "").toLowerCase();
  const code = String(input?.code || "").toLowerCase();
  return (
    key === "printscreen" ||
    code === "printscreen" ||
    key === "snapshot" ||
    code === "snapshot" ||
    key === "sysrq"
  );
}

function hwndFromNativeBuffer(buf) {
  if (!buf || buf.length < 4) return 0;
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
  return buf.readUInt32LE(0);
}

function windowsPowerShellPath() {
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  return path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const WIN32_USER_SCRIPT = [
  "Add-Type @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class HspWinUser {",
  "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);",
  "}",
  "\"@",
].join("\n");

function runWindowsUserScript(body, log, label) {
  const ps = windowsPowerShellPath();
  const script = `${WIN32_USER_SCRIPT}; ${body}`;
  const result = spawnSync(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 8000 },
  );
  if (result.error) {
    log?.(`[screenshot] ${label}: ${result.error.message || result.error}`);
    return false;
  }
  if (result.status !== 0) {
    const err = String(result.stderr || result.stdout || "").trim();
    if (err) log?.(`[screenshot] ${label} exit=${result.status}: ${err.slice(0, 400)}`);
    return false;
  }
  return true;
}

function clearWindowDisplayAffinity(hwnd, log) {
  if (!hwnd) return false;
  return runWindowsUserScript(
    `[void][HspWinUser]::SetWindowDisplayAffinity([IntPtr]${hwnd}, ${WDA_NONE})`,
    log,
    "SetWindowDisplayAffinity",
  );
}

let lastSyntheticPrintScreenAt = 0;

/** Re-inject VK_SNAPSHOT when Chromium intercepts Print Screen on Windows. */
function triggerWindowsPrintScreenOsCapture(log) {
  const now = Date.now();
  if (now - lastSyntheticPrintScreenAt < 350) return true;
  lastSyntheticPrintScreenAt = now;

  return runWindowsUserScript(
    "[HspWinUser]::keybd_event(0x2C, 0, 0, [UIntPtr]::Zero); " +
      "[HspWinUser]::keybd_event(0x2C, 0, 2, [UIntPtr]::Zero)",
    log,
    "keybd_event",
  );
}

function ensureWebContentsAllowsOsCapture(contents, log) {
  try {
    if (typeof contents?.setContentProtection === "function") {
      contents.setContentProtection(false);
    }
  } catch (e) {
    log?.(`setContentProtection: ${e?.message || e}`);
  }
}

function ensureBrowserWindowAllowsOsCapture(browserWindow, log) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  try {
    if (typeof browserWindow.setOpacity === "function") {
      browserWindow.setOpacity(1);
    }
  } catch (_) {}
  ensureWebContentsAllowsOsCapture(browserWindow.webContents, log);
  if (process.platform !== "win32") return;
  try {
    if (typeof browserWindow.getNativeWindowHandle === "function") {
      const hwnd = hwndFromNativeBuffer(browserWindow.getNativeWindowHandle());
      clearWindowDisplayAffinity(hwnd, log);
    }
  } catch (e) {
    log?.(`getNativeWindowHandle: ${e?.message || e}`);
  }
}

async function copyFocusedWindowToClipboard(BrowserWindow, clipboard, log) {
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return false;
  try {
    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  } catch (e) {
    log?.(`capturePage clipboard: ${e?.message || e}`);
    return false;
  }
}

function handlePrintScreenKey(input, electron, log) {
  const { BrowserWindow, clipboard } = electron;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    ensureBrowserWindowAllowsOsCapture(focused, log);
  }

  const altActiveWindowShot = Boolean(input?.alt);
  if (altActiveWindowShot) {
    void copyFocusedWindowToClipboard(BrowserWindow, clipboard, log);
    return;
  }

  const reinjected = triggerWindowsPrintScreenOsCapture(log);
  if (!reinjected) {
    void copyFocusedWindowToClipboard(BrowserWindow, clipboard, log);
  }
}

/**
 * Allow OS screenshot tools (Print Screen, Snipping Tool) across every BrowserWindow.
 * @param {import("electron").App} electronApp
 * @param {{ BrowserWindow: typeof import("electron").BrowserWindow, clipboard: import("electron").Clipboard }} electron
 * @param {(msg: string) => void} [log]
 */
function registerOsScreenshotPassthrough(electronApp, electron, log) {
  electronApp.on("browser-window-created", (_event, browserWindow) => {
    ensureBrowserWindowAllowsOsCapture(browserWindow, log);
    browserWindow.on("show", () => ensureBrowserWindowAllowsOsCapture(browserWindow, log));
    browserWindow.on("focus", () => ensureBrowserWindowAllowsOsCapture(browserWindow, log));
  });

  electronApp.on("web-contents-created", (_event, contents) => {
    ensureWebContentsAllowsOsCapture(contents, log);
    contents.on("did-finish-load", () => ensureWebContentsAllowsOsCapture(contents, log));

    if (process.platform !== "win32") return;

    contents.on("before-input-event", (event, input) => {
      if (!input || input.type !== "keyDown" || !isPrintScreenKey(input)) return;
      try {
        event.preventDefault();
      } catch (_) {}
      handlePrintScreenKey(input, electron, log);
    });
  });
}

module.exports = {
  registerOsScreenshotPassthrough,
  ensureWebContentsAllowsOsCapture,
  ensureBrowserWindowAllowsOsCapture,
};
