const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const ZOOM_STORE_FILE = "zoom-factor.json";
const ROW_FULL_W = 292;
const ROW_EXT_W = 142;
const ROW_H = 34;

/** @type {() => import('electron').BrowserWindow | null} */
let getMainWindow = () => null;
/** @type {(msg: string) => void} */
let log = () => {};
/** @type {import('electron').BrowserWindow | null} */
let rowPopupRef = null;
let zoomFactor = 1;

function zoomStorePath() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), ZOOM_STORE_FILE);
}

function clampZoomFactor(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

function loadStoredZoomFactor() {
  try {
    const raw = fs.readFileSync(zoomStorePath(), "utf8").trim();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.factor === "number") {
      zoomFactor = clampZoomFactor(parsed.factor);
      return;
    }
  } catch (_) {}
  zoomFactor = 1;
}

function saveZoomFactor(factor) {
  try {
    fs.writeFileSync(zoomStorePath(), `${JSON.stringify({ factor })}\n`, "utf8");
  } catch (e) {
    log(`[zoom] save failed: ${e?.message || e}`);
  }
}

function broadcastZoomToPopup() {
  if (!rowPopupRef || rowPopupRef.isDestroyed()) return;
  try {
    rowPopupRef.webContents.send("hsp-zoom-sync", zoomFactor);
  } catch (_) {}
}

function applyZoomToMainWindow(factor) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  zoomFactor = clampZoomFactor(factor);
  try {
    win.webContents.setZoomFactor(zoomFactor);
  } catch (e) {
    log(`[zoom] setZoomFactor failed: ${e?.message || e}`);
  }
  saveZoomFactor(zoomFactor);
  broadcastZoomToPopup();
}

function adjustZoom(delta) {
  applyZoomToMainWindow(zoomFactor + delta);
}

function resetZoom() {
  applyZoomToMainWindow(1);
}

function hideRowPopup() {
  if (!rowPopupRef || rowPopupRef.isDestroyed()) return;
  try {
    rowPopupRef.hide();
  } catch (_) {}
}

function destroyRowPopup() {
  if (!rowPopupRef || rowPopupRef.isDestroyed()) return;
  try {
    rowPopupRef.destroy();
  } catch (_) {}
  rowPopupRef = null;
}

function estimateViewZoomRowControlsPoint(width) {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return screen.getCursorScreenPoint();
  const content = main.getContentBounds();
  const menuBarH = process.platform === "win32" ? 28 : 22;
  const viewDropWidth = 220;
  const x = content.x + viewDropWidth - width - 10;
  const y = content.y + menuBarH + 28 * 3 + 1;
  return { x, y };
}

function estimateViewZoomRowScreenPoint(width) {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return screen.getCursorScreenPoint();
  const content = main.getContentBounds();
  const menuBarH = process.platform === "win32" ? 28 : 22;
  const viewMenuX = content.x + 88;
  const zoomRowY = content.y + menuBarH + 28 * 3 + 2;
  return { x: viewMenuX, y: zoomRowY, width };
}

function positionRowPopup(bounds) {
  if (!rowPopupRef || rowPopupRef.isDestroyed()) return;
  const width = bounds.width || ROW_FULL_W;
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const work = display.workArea;
  let x = bounds.x;
  let y = bounds.y;
  if (x + width > work.x + work.width) x = work.x + work.width - width;
  if (y + ROW_H > work.y + work.height) y = work.y + work.height - ROW_H;
  if (x < work.x) x = work.x;
  if (y < work.y) y = work.y;
  rowPopupRef.setBounds({ x: Math.round(x), y: Math.round(y), width, height: ROW_H });
}

function ensureRowPopup(width = ROW_FULL_W) {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return null;

  if (rowPopupRef && !rowPopupRef.isDestroyed()) {
    if (rowPopupRef.getBounds().width !== width) {
      destroyRowPopup();
    } else {
      return rowPopupRef;
    }
  }

  const htmlPath = path.join(__dirname, "zoom-menu-row.html");
  if (!fs.existsSync(htmlPath)) {
    log(`[zoom] FATAL: zoom-menu-row.html missing at ${htmlPath}`);
    return null;
  }

  rowPopupRef = new BrowserWindow({
    width,
    height: ROW_H,
    useContentSize: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#111111",
    parent: main,
    modal: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });

  rowPopupRef.setMenuBarVisibility(false);
  rowPopupRef.loadFile(htmlPath);

  rowPopupRef.on("blur", () => {
    hideRowPopup();
  });
  rowPopupRef.on("closed", () => {
    rowPopupRef = null;
  });

  return rowPopupRef;
}

function showRowPopup(anchorPoint, options = {}) {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return;

  const extension = options.extension !== false;
  const width = extension ? ROW_EXT_W : ROW_FULL_W;
  const popup = ensureRowPopup(width);
  if (!popup) return;

  let anchor;
  if (anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y)) {
    anchor = { x: anchorPoint.x, y: anchorPoint.y, width };
  } else if (extension) {
    const pt = estimateViewZoomRowControlsPoint(width);
    anchor = { x: pt.x, y: pt.y, width };
  } else {
    const pt = estimateViewZoomRowScreenPoint(width);
    anchor = { x: pt.x, y: pt.y, width };
  }
  positionRowPopup(anchor);

  const reveal = () => {
    if (!rowPopupRef || rowPopupRef.isDestroyed()) return;
    try {
      rowPopupRef.webContents.send("hsp-zoom-mode", extension ? "extension" : "full");
    } catch (_) {}
    broadcastZoomToPopup();
    rowPopupRef.show();
    rowPopupRef.focus();
  };

  if (popup.webContents.isLoading()) {
    popup.webContents.once("did-finish-load", reveal);
  } else {
    reveal();
  }
}

function registerZoomIpc() {
  ipcMain.handle("hsp-zoom-get-factor", () => zoomFactor);
  ipcMain.on("hsp-zoom-adjust", (_event, delta) => {
    const step = Number(delta);
    if (!Number.isFinite(step)) return;
    adjustZoom(step);
  });
  ipcMain.on("hsp-zoom-set-factor", (_event, factor) => {
    applyZoomToMainWindow(factor);
  });
  ipcMain.on("hsp-zoom-popup-close", () => {
    hideRowPopup();
  });
}

function attachMainWindowZoomHooks(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  } catch (_) {}
  mainWindow.webContents.on("zoom-changed", () => {
    try {
      const next = clampZoomFactor(mainWindow.webContents.getZoomFactor());
      if (Math.abs(next - zoomFactor) > 0.001) {
        zoomFactor = next;
        saveZoomFactor(zoomFactor);
        broadcastZoomToPopup();
      }
    } catch (_) {}
  });
}

/**
 * @param {{ getMainWindow: () => import('electron').BrowserWindow | null, log?: (msg: string) => void }} opts
 */
function registerZoomMenu(opts) {
  getMainWindow = opts.getMainWindow;
  log = typeof opts.log === "function" ? opts.log : () => {};
  loadStoredZoomFactor();
  registerZoomIpc();

  return {
    showRowPopup,
    hideRowPopup,
    applyZoomToMainWindow: () => applyZoomToMainWindow(zoomFactor),
    attachMainWindowZoomHooks,
    adjustZoom,
    resetZoom,
    getZoomFactor: () => zoomFactor,
    destroyRowPopup,
  };
}

module.exports = { registerZoomMenu, ZOOM_STEP };
