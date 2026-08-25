const { spawnSync } = require("child_process");
const path = require("path");

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

/**
 * Sync: Electron maps this to SetWindowDisplayAffinity on Windows.
 * Must run before OS Snipping Tool / PrtScn samples the frame.
 */
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
      // Best-effort; PowerShell is slow — contentProtection(false) above is the fast path.
      clearWindowDisplayAffinity(hwnd, log);
    }
  } catch (e) {
    log?.(`getNativeWindowHandle: ${e?.message || e}`);
  }
}

function ensureAllWindowsAllowOsCapture(BrowserWindow, log) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      ensureBrowserWindowAllowsOsCapture(win, log);
    }
  } catch (e) {
    log?.(`ensureAllWindowsAllowOsCapture: ${e?.message || e}`);
  }
}

/**
 * Allow OS screenshot tools (Print Screen, Snipping Tool, Win+Shift+S).
 *
 * Important: do NOT preventDefault PrintScreen. On Windows 10/11 that key often
 * opens Snipping Tool / screen capture — swallowing it left users unable to
 * screenshot, and synthetic keybd_event(VK_SNAPSHOT) is ignored by modern Windows.
 *
 * @param {import("electron").App} electronApp
 * @param {{ BrowserWindow: typeof import("electron").BrowserWindow, clipboard?: import("electron").Clipboard }} electron
 * @param {(msg: string) => void} [log]
 */
function registerOsScreenshotPassthrough(electronApp, electron, log) {
  const { BrowserWindow } = electron;

  electronApp.on("browser-window-created", (_event, browserWindow) => {
    ensureBrowserWindowAllowsOsCapture(browserWindow, log);
    browserWindow.on("show", () => ensureBrowserWindowAllowsOsCapture(browserWindow, log));
    browserWindow.on("focus", () => ensureBrowserWindowAllowsOsCapture(browserWindow, log));
    browserWindow.on("restore", () => ensureBrowserWindowAllowsOsCapture(browserWindow, log));
  });

  electronApp.on("web-contents-created", (_event, contents) => {
    ensureWebContentsAllowsOsCapture(contents, log);
    contents.on("did-finish-load", () => ensureWebContentsAllowsOsCapture(contents, log));
    contents.on("dom-ready", () => ensureWebContentsAllowsOsCapture(contents, log));

    if (process.platform !== "win32") return;

    contents.on("before-input-event", (_event, input) => {
      if (!input || input.type !== "keyDown" || !isPrintScreenKey(input)) return;
      // Never preventDefault — pass PrintScreen through to the OS.
      ensureAllWindowsAllowOsCapture(BrowserWindow, log);
    });
  });
}

module.exports = {
  registerOsScreenshotPassthrough,
  ensureWebContentsAllowsOsCapture,
  ensureBrowserWindowAllowsOsCapture,
};
