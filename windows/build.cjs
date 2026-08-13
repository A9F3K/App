const {
  app,
  BrowserWindow,
  Menu,
  protocol,
  net,
  dialog,
  Notification,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  session,
  clipboard,
} = require("electron");

/** Must match package.json `build.appId`. Call synchronously before `ready` on Windows (Electron + shell taskbar expectations). */
const WIN_APP_USER_MODEL_ID = "com.sraibaby.app";
if (process.platform === "win32") {
  try {
    app.setAppUserModelId(WIN_APP_USER_MODEL_ID);
  } catch (_) {}
}

// Optional: set HSP_DISABLE_GPU=1 to test whether GPU stack affects shortcuts (e.g. Print Screen) on Windows.
if (process.platform === "win32" && process.env.HSP_DISABLE_GPU === "1") {
  try {
    app.disableHardwareAcceleration();
  } catch (_) {}
}
const path = require("path");
const { registerOAuthIpc } = require("./oauth-window.cjs");
const {
  registerSwapCoffeeFetchIpc,
  installSwapCoffeeRendererFetchShim,
} = require("./swap-coffee-fetch.cjs");
const { registerZoomMenu } = require("./zoom-menu-row.cjs");
const {
  registerOsScreenshotPassthrough,
  ensureBrowserWindowAllowsOsCapture,
  ensureWebContentsAllowsOsCapture,
} = require("./os-screenshot.cjs");
const { registerDisplayMediaHandler } = require("./display-media.cjs");
const preloadPath = path.join(__dirname, "preload.cjs");
let mainWindowRef = null;
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");
const { spawn, spawnSync } = require("child_process");
const brand = require("./product-brand.cjs");

const UPDATE_GITHUB_OWNER = "HyperlinksSpace";
/** Must match `build.publish.repo` and the repo where CI uploads releases. */
const UPDATE_GITHUB_REPO = "HyperlinksSpaceProgram";
const ZIP_LATEST_YML = "zip-latest.yml";
/** Same pattern as package.json build.win.artifactName for the zip target. */
const WIN_PORTABLE_ZIP_PREFIX = brand.portableZipPrefix;
const LATEST_YML = "latest.yml";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `app://` static export: avoid `net.fetch(file:)` caching stale bundles after in-place updates. */
function guessAppAssetMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * After a Windows zip apply, `app.getVersion()` changes but Chromium may still serve cached `app://`
 * responses from the previous session. Clear cache + web caches once per version transition.
 */
async function clearStaleClientCacheIfNeeded() {
  if (process.env.NODE_ENV === "development" || !app.isPackaged) return;
  const marker = path.join(app.getPath("userData"), "hsp-client-cache-version.txt");
  const ver = app.getVersion();
  let prev = "";
  try {
    prev = fs.readFileSync(marker, "utf8").trim();
  } catch (_) {}
  if (prev === ver) return;
  log(`[cache] version changed (${prev || "(none)"} → ${ver}); clearing session cache / web caches`);
  try {
    await session.defaultSession.clearCache();
  } catch (e) {
    log(`[cache] clearCache failed: ${e?.message || e}`);
  }
  try {
    await session.defaultSession.clearStorageData({
      storages: ["cachestorage", "serviceworkers"],
    });
  } catch (e) {
    log(`[cache] clearStorageData failed: ${e?.message || e}`);
  }
  try {
    fs.writeFileSync(marker, `${ver}\n`, "utf8");
  } catch (e) {
    log(`[cache] write marker failed: ${e?.message || e}`);
  }
}

/** GitHub / Electron net layer: transient errors worth retrying (backoff in checkForUpdatesWithRetry). */
function isTransientGithubUpdateError(err) {
  if (!err) return false;
  const code = err.statusCode ?? err.status;
  if (code === 502 || code === 503 || code === 504) return true;
  const msg = String(err.message || err);
  if (
    /\b502\b|\b503\b|\b504\b|Bad Gateway|Service Unavailable|Gateway Timeout|taking too long|ECONNRESET|ETIMEDOUT/i.test(
      msg,
    )
  )
    return true;
  // Electron reports URL loader failures as net::ERR_* (not Node ECONNRESET).
  if (/net::ERR_CONNECTION_RESET|net::ERR_CONNECTION_TIMED_OUT|net::ERR_NETWORK_CHANGED/i.test(msg))
    return true;
  return false;
}

/** Ring buffer for the updater dialog (last lines only). */
const UPDATER_DIALOG_LOG_MAX = 120;
const updaterDialogLogBuffer = [];

/** Set in setupAutoUpdater: sends a fully formatted log line (with ISO time) to the dialog. */
let updaterLogToDialog = null;

function appendUpdaterDialogLogLine(messageBody) {
  const line = `[${new Date().toISOString()}] ${messageBody}`;
  updaterDialogLogBuffer.push(line);
  if (updaterDialogLogBuffer.length > UPDATER_DIALOG_LOG_MAX) {
    updaterDialogLogBuffer.splice(0, updaterDialogLogBuffer.length - UPDATER_DIALOG_LOG_MAX);
  }
  try {
    updaterLogToDialog?.(line);
  } catch (_) {}
}

/** Structured lines in userData/main.log and updater dialog: `[updater:tag] message` */
function logUpdater(tag, msg) {
  const body = `[updater:${tag}] ${msg}`;
  log(body);
  appendUpdaterDialogLogLine(body);
}

function safeJson(obj, maxLen = 800) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch (_) {
    return String(obj);
  }
}

/** Escape for a PowerShell single-quoted literal (only ' is doubled). */
function escapePsSingleQuotedPath(p) {
  return String(p).replace(/'/g, "''");
}

/**
 * Detached `powershell -File script.ps1 -PlanPath ...` often drops or misparses args on Windows.
 * Use a short UTF-16LE -EncodedCommand that writes %TEMP%\\hsp-apply-trace.log then invokes the script.
 */
function buildWindowsApplyLauncherCommand(ps1Path, planPath) {
  const qPs1 = escapePsSingleQuotedPath(ps1Path);
  const qPlan = escapePsSingleQuotedPath(planPath);
  return (
    `$ErrorActionPreference='Stop';` +
    `try{$t=Join-Path $env:TEMP 'hsp-apply-trace.log';` +
    `$ts=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');` +
    `Add-Content -LiteralPath $t -Encoding UTF8 -Value ('['+$ts+'] launcher start pid='+$PID)}catch{};` +
    `& '${qPs1}' -PlanPath '${qPlan}'`
  );
}

/**
 * Prefer zip-latest.yml (has sha512 for the zip). If missing (404), use latest.yml + inferred zip name.
 * @returns {{ version: string, fileName: string, sha512: string | null, source: string }}
 */
async function resolveWindowsZipSidecarMeta(netFetch, currentVersion) {
  logUpdater("meta", `resolve sidecar manifests (current=${currentVersion})`);
  const zipLatestUrl = githubLatestAssetUrl(ZIP_LATEST_YML);
  const zlRes = await netFetch(zipLatestUrl);
  if (zlRes.ok) {
    const text = await zlRes.text();
    const meta = parseSimpleUpdateYml(text);
    if (meta.version && meta.fileName && meta.sha512) {
      if (compareSemverLike(meta.version, currentVersion) <= 0) {
        throw new Error("zip-latest.yml version is not newer than current app");
      }
      logUpdater("meta", `using zip-latest.yml version=${meta.version} file=${meta.fileName}`);
      return { version: meta.version, fileName: meta.fileName, sha512: meta.sha512, source: "zip-latest.yml" };
    }
    log("[updater] zip-latest.yml incomplete; falling back to latest.yml + inferred zip name");
  } else {
    log(
      `[updater] zip-latest.yml HTTP ${zlRes.status} — using latest.yml and inferred ${WIN_PORTABLE_ZIP_PREFIX}<version>.zip`,
    );
  }

  const lyUrl = githubLatestAssetUrl(LATEST_YML);
  const lyRes = await netFetch(lyUrl);
  if (!lyRes.ok) {
    throw new Error(`latest.yml HTTP ${lyRes.status} (need a GitHub release with latest.yml)`);
  }
  const lyText = await lyRes.text();
  const ly = parseSimpleUpdateYml(lyText);
  if (!ly.version) {
    throw new Error("latest.yml has no version");
  }
  if (compareSemverLike(ly.version, currentVersion) <= 0) {
    throw new Error("latest.yml version is not newer than current app");
  }
  const fileName = `${WIN_PORTABLE_ZIP_PREFIX}${ly.version}.zip`;
  logUpdater("meta", `using latest.yml+inferred version=${ly.version} file=${fileName}`);
  return {
    version: ly.version,
    fileName,
    sha512: null,
    source: "latest.yml+inferred",
  };
}

function compareSemverLike(a, b) {
  const pa = String(a || "0")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * NSIS install: INSTDIR\versions\<semver>\… plus INSTDIR\current → junction (exe is …\current\<name>.exe).
 * Legacy installs: exe lives directly in the install folder (no `current`). Returns the app root (parent of `current`, or the folder that contains the exe for legacy).
 */
function getWindowsAppRootFromExecPath(execPath) {
  const dir = path.dirname(execPath);
  if (path.basename(dir).toLowerCase() === "current") {
    return path.dirname(dir);
  }
  return dir;
}

/** Program Files (per-machine NSIS) needs elevation for in-place zip apply. */
function installPathNeedsElevation(targetPath) {
  if (process.platform !== "win32") return false;
  const norm = path.normalize(String(targetPath || "")).toLowerCase();
  if (norm.includes(`${path.sep}program files`) || norm.includes(`${path.sep}program files (x86)`)) {
    return true;
  }
  try {
    const probeDir = path.join(targetPath, `.hsp-write-probe-${process.pid}`);
    fs.mkdirSync(probeDir, { recursive: true });
    const probeFile = path.join(probeDir, "probe.txt");
    fs.writeFileSync(probeFile, "1");
    fs.unlinkSync(probeFile);
    fs.rmdirSync(probeDir);
    return false;
  } catch (_) {
    return true;
  }
}

const HSP_FROM_CURRENT_ENV = "HSP_FROM_CURRENT_JUNCTION";
const APPLIED_VERSION_MARKER = "last-applied-version.txt";

function getAppliedVersionMarkerPath() {
  return path.join(app.getPath("userData"), APPLIED_VERSION_MARKER);
}

function readAppliedVersionMarker() {
  try {
    const p = getAppliedVersionMarkerPath();
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch (_) {
    return null;
  }
}

function clearAppliedVersionMarkerIfMatched() {
  try {
    const marker = readAppliedVersionMarker();
    if (!marker) return;
    if (compareSemverLike(app.getVersion(), marker) >= 0) {
      fs.unlinkSync(getAppliedVersionMarkerPath());
    }
  } catch (_) {}
}

/** True when install-root `current` junction has newer app.asar than the running binary (flat shortcut after zip apply). */
function windowsCurrentJunctionHasNewerBuild() {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  const execDir = path.dirname(process.execPath);
  if (path.basename(execDir).toLowerCase() === "current") return false;

  const appRoot = getWindowsAppRootFromExecPath(process.execPath);
  const currentDir = path.join(appRoot, "current");
  if (!fs.existsSync(currentDir)) return false;

  const relAsar = path.join("resources", "app.asar");
  const currentAsar = path.join(currentDir, relAsar);
  if (!fs.existsSync(currentAsar)) {
    for (const name of brand.allKnownExeBaseNames()) {
      if (fs.existsSync(path.join(currentDir, name))) return true;
    }
    return false;
  }

  const runningAsar = path.join(execDir, relAsar);
  if (!fs.existsSync(runningAsar)) return true;
  try {
    const c = fs.statSync(currentAsar);
    const r = fs.statSync(runningAsar);
    return c.mtimeMs > r.mtimeMs || c.size !== r.size;
  } catch (_) {
    return true;
  }
}

function resolveWindowsCurrentLaunchExe() {
  const appRoot = getWindowsAppRootFromExecPath(process.execPath);
  const currentDir = path.join(appRoot, "current");
  if (!fs.existsSync(currentDir)) return null;

  const tries = new Set([path.basename(process.execPath), ...brand.allKnownExeBaseNames()]);
  for (const name of tries) {
    const exeName = /\.exe$/i.test(name) ? name : `${name}.exe`;
    const candidate = path.join(currentDir, exeName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

/** Resolve INSTDIR\current junction target without following into the version tree. */
function resolveWindowsCurrentJunctionTarget(appRoot) {
  const currentLink = path.join(appRoot, "current");
  try {
    const st = fs.lstatSync(currentLink);
    if (!st.isSymbolicLink() && !st.isDirectory()) return null;
    try {
      const target = fs.readlinkSync(currentLink);
      return target ? path.resolve(path.dirname(currentLink), target) : null;
    } catch (_) {
      // Non-reparse directory named current (legacy) — treat as itself.
      return st.isDirectory() ? currentLink : null;
    }
  } catch (_) {
    return null;
  }
}

function windowsVersionDirIsComplete(versionDir, preferredExeName) {
  try {
    if (!fs.existsSync(path.join(versionDir, "resources", "app.asar"))) return false;
    const tries = new Set(
      [preferredExeName, path.basename(process.execPath), ...brand.allKnownExeBaseNames()].filter(Boolean),
    );
    for (const name of tries) {
      const exeName = /\.exe$/i.test(name) ? name : `${name}.exe`;
      if (fs.existsSync(path.join(versionDir, exeName))) return true;
    }
  } catch (_) {}
  return false;
}

/** Highest complete versions/<semver> under the install root (null if none). */
function findNewestCompleteWindowsVersionDir(appRoot) {
  const versionsRoot = path.join(appRoot, "versions");
  let names = [];
  try {
    names = fs.readdirSync(versionsRoot);
  } catch (_) {
    return null;
  }
  let best = null;
  for (const name of names) {
    const full = path.join(versionsRoot, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch (_) {
      continue;
    }
    if (!windowsVersionDirIsComplete(full)) continue;
    if (!best || compareSemverLike(name, best.version) > 0) {
      best = { version: name, dir: full };
    }
  }
  return best;
}

/**
 * After zip apply, shortcuts may still launch the flat install exe while `current` points at the new build.
 * Re-exec from `current` once so app.getVersion() and UI bundle match the applied update.
 * @returns {boolean} true when this process is quitting to hand off to `current`
 */
function tryRelaunchFromCurrentJunction() {
  if (process.platform !== "win32" || !app.isPackaged || isDev) return false;
  if (process.env[HSP_FROM_CURRENT_ENV] === "1") return false;

  const execDir = path.dirname(process.execPath);
  if (path.basename(execDir).toLowerCase() === "current") return false;

  const marker = readAppliedVersionMarker();
  const runningVer = app.getVersion();
  const markerNewer = marker && compareSemverLike(marker, runningVer) > 0;
  const junctionNewer = windowsCurrentJunctionHasNewerBuild();
  if (!markerNewer && !junctionNewer) return false;

  const currentExe = resolveWindowsCurrentLaunchExe();
  if (!currentExe) {
    try {
      log(
        `[startup] update handoff skipped: current junction newer (marker=${marker} running=${runningVer}) but exe missing`,
      );
    } catch (_) {}
    return false;
  }

  try {
    log(
      `[startup] relaunch from current junction exe=${currentExe} running=${runningVer} marker=${marker || "none"} junctionNewer=${junctionNewer}`,
    );
  } catch (_) {}

  try {
    const child = spawn(currentExe, [], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(currentExe),
      env: { ...process.env, [HSP_FROM_CURRENT_ENV]: "1" },
    });
    child.unref();
  } catch (e) {
    try {
      log(`[startup] relaunch from current failed: ${e?.message || e}`);
    } catch (_) {}
    return false;
  }

  app.quit();
  return true;
}

/**
 * If robocopy finished into versions/<semver> but the apply helper died before flipping
 * `current` (classic: hung Remove-Item on the junction), finish the junction + relaunch.
 * @returns {boolean} true when this process is quitting after spawning recovery
 */
function tryFinishIncompleteWindowsVersionedApply() {
  if (process.platform !== "win32" || !app.isPackaged || isDev) return false;
  if (process.env.HSP_SKIP_INCOMPLETE_APPLY_RECOVERY === "1") return false;
  if (process.env[HSP_FROM_CURRENT_ENV] === "1") return false;

  const appRoot = getWindowsAppRootFromExecPath(process.execPath);
  const newest = findNewestCompleteWindowsVersionDir(appRoot);
  if (!newest) return false;

  const currentTarget = resolveWindowsCurrentJunctionTarget(appRoot);
  const currentVer = currentTarget ? path.basename(currentTarget) : null;
  if (currentVer && compareSemverLike(newest.version, currentVer) <= 0) return false;

  const runningVer = app.getVersion();
  const marker = readAppliedVersionMarker();
  const markerPointsAtNewest = marker && compareSemverLike(marker, newest.version) === 0;
  // Only auto-finish when the copied tree is clearly ahead of what we are running, or a
  // prior apply wrote the marker but never flipped the junction.
  if (!markerPointsAtNewest && compareSemverLike(newest.version, runningVer) <= 0) return false;

  const exeName = path.basename(process.execPath);
  const applyLogPath = path.join(app.getPath("userData"), "hsp-update-apply.log");
  const markerPath = getAppliedVersionMarkerPath();
  const currentLink = path.join(appRoot, "current");
  const needsElevation = installPathNeedsElevation(appRoot);

  try {
    log(
      `[startup] incomplete versioned apply: newest=${newest.version} current=${currentVer || "none"} running=${runningVer} marker=${marker || "none"} — finishing junction`,
    );
  } catch (_) {}

  const ps1Path = path.join(app.getPath("temp"), `hsp-finish-incomplete-${Date.now()}.ps1`);
  const ps1Body = [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${JSON.stringify(applyLogPath)}`,
    "function W([string]$m) {",
    "  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
    '  try { Add-Content -LiteralPath $log -Encoding UTF8 -Value ("[$ts] [recovery] " + $m) } catch {}',
    "}",
    "try {",
    "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "    $_.Name -match 'powershell|pwsh' -and $_.CommandLine -and (",
    "      $_.CommandLine -like '*hsp-apply-versions*' -or $_.CommandLine -like '*hsp-finish-*'",
    "    ) -and $_.ProcessId -ne $PID",
    "  } | ForEach-Object {",
    "    try { W ('killing hung apply helper pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}",
    "  }",
    `  $current = ${JSON.stringify(currentLink)}`,
    `  $target = ${JSON.stringify(newest.dir)}`,
    `  $exeName = ${JSON.stringify(exeName)}`,
    `  $markerPath = ${JSON.stringify(markerPath)}`,
    `  $appliedVersion = ${JSON.stringify(newest.version)}`,
    '  W ("finish incomplete apply -> " + $target)',
    "  if ([System.IO.Directory]::Exists($current)) {",
    '    W ("removing old current via cmd rmdir: " + $current)',
    "    $rm = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c','rmdir',('\"' + $current + '\"')) -Wait -PassThru -WindowStyle Hidden",
    "    if ($rm.ExitCode -ne 0 -and [System.IO.Directory]::Exists($current)) { throw ('rmdir failed exit=' + $rm.ExitCode) }",
    '    W "removed old current"',
    "  }",
    '  W ("creating junction via mklink: " + $current + " -> " + $target)',
    "  $mk = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c','mklink','/J',('\"' + $current + '\"'),('\"' + $target + '\"')) -Wait -PassThru -WindowStyle Hidden",
    "  if ($mk.ExitCode -ne 0) { throw ('mklink failed exit=' + $mk.ExitCode) }",
    "  try {",
    "    $md = Split-Path -Parent $markerPath",
    "    if ($md) { $null = New-Item -ItemType Directory -Force -Path $md }",
    "    Set-Content -LiteralPath $markerPath -Value $appliedVersion -Encoding UTF8 -NoNewline",
    '    W ("wrote applied version marker: " + $appliedVersion)',
    "  } catch { W ('marker failed: ' + $_.Exception.Message) }",
    "  $launch = Join-Path $current $exeName",
    "  if (-not [System.IO.File]::Exists($launch)) { throw ('launch exe missing: ' + $launch) }",
    '  W ("relaunch " + $launch)',
    `  $cmd = 'set ${HSP_FROM_CURRENT_ENV}=1&& start "" ' + [char]34 + $launch + [char]34`,
    "  Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $cmd -WorkingDirectory $current -WindowStyle Hidden",
    '  W "recovery apply done"',
    "} catch {",
    '  W ("FATAL: " + $_.Exception.Message)',
    "  exit 1",
    "}",
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(ps1Path, `\uFEFF${ps1Body}`, "utf8");
  } catch (e) {
    try {
      log(`[startup] incomplete-apply recovery write failed: ${e?.message || e}`);
    } catch (_) {}
    return false;
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const psExe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path];
  try {
    if (needsElevation) {
      // Start elevated without waiting (UAC); quit so we do not keep running the stale binary.
      const psSq = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const argList = args.map(psSq).join(",");
      spawnSync(
        psExe,
        [
          "-NoProfile",
          "-Command",
          `Start-Process -FilePath ${psSq(psExe)} -Verb RunAs -WindowStyle Hidden -ArgumentList @(${argList})`,
        ],
        { windowsHide: true, timeout: 60000 },
      );
    } else {
      spawn(psExe, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
  } catch (e) {
    try {
      log(`[startup] incomplete-apply recovery spawn failed: ${e?.message || e}`);
    } catch (_) {}
    return false;
  }

  app.quit();
  return true;
}

function parseSimpleUpdateYml(text) {
  const versionM = text.match(/^version:\s*(.+)$/m);
  const version = versionM ? versionM[1].trim() : null;
  const pathM = text.match(/^path:\s*(.+)$/m);
  let fileName = pathM ? pathM[1].trim() : null;
  if (!fileName) {
    const urlM = text.match(/^\s*url:\s*(.+)$/m);
    fileName = urlM ? urlM[1].trim() : null;
  }
  const shaM = text.match(/^sha512:\s*(.+)$/m);
  const sha512 = shaM ? shaM[1].trim() : null;
  const sizeM = text.match(/^\s*size:\s*(\d+)\s*$/m);
  const size = sizeM ? parseInt(sizeM[1], 10) : null;
  return { version, fileName, sha512, size };
}

function githubLatestAssetUrl(fileName) {
  const enc = encodeURIComponent(fileName).replace(/%20/g, "%20");
  return `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest/download/${enc}`;
}

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${brand.productSlug}/electron-updater`,
};

/**
 * When /releases/latest/download/<name>.zip returns 404, find the portable zip on the latest release
 * via the GitHub API (asset names may differ slightly from artifactName).
 * @returns {Promise<string|null>} browser_download_url or null
 */
async function fetchPortableZipBrowserUrlFromGitHubApi(netFetch, version, preferredFileName) {
  logUpdater(
    "github-api",
    `resolve zip URL via API (version=${version} preferred=${preferredFileName})`,
  );
  const apiUrl = `https://api.github.com/repos/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`;
  const res = await netFetch(apiUrl, { headers: GITHUB_API_HEADERS });
  if (!res.ok) {
    log(`[updater] GitHub API GET releases/latest: HTTP ${res.status}`);
    return null;
  }
  let data;
  try {
    data = await res.json();
  } catch (_) {
    return null;
  }
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const zips = assets.filter((a) => a && typeof a.name === "string" && /\.zip$/i.test(a.name));
  const skipName = (n) =>
    /blockmap|\.7z\.|\.delta/i.test(n) || /-ia32-|arm64|\.msi$/i.test(n);
  const candidates = zips.filter((a) => !skipName(a.name));

  const exact = candidates.find((a) => a.name === preferredFileName);
  if (exact?.browser_download_url) {
    log(`[updater] GitHub API: exact zip match ${exact.name}`);
    logUpdater("github-api", `picked exact asset url=${exact.browser_download_url.slice(0, 120)}…`);
    return exact.browser_download_url;
  }

  const verLoose = String(version).trim();
  const withVersion = candidates.filter((a) => a.name.includes(verLoose));
  if (withVersion.length === 1 && withVersion[0].browser_download_url) {
    log(`[updater] GitHub API: single zip matching version ${verLoose}: ${withVersion[0].name}`);
    logUpdater("github-api", `picked version-match url=${withVersion[0].browser_download_url.slice(0, 120)}…`);
    return withVersion[0].browser_download_url;
  }

  const prefixed = candidates.find(
    (a) =>
      a.name.startsWith(WIN_PORTABLE_ZIP_PREFIX) ||
      brand.portableZipAssetPattern().test(a.name) ||
      /Hyperlinks\s*Space/i.test(a.name),
  );
  if (prefixed?.browser_download_url) {
    log(`[updater] GitHub API: portable-like zip ${prefixed.name}`);
    logUpdater("github-api", `picked portable-like url=${prefixed.browser_download_url.slice(0, 120)}…`);
    return prefixed.browser_download_url;
  }

  if (candidates.length === 1 && candidates[0].browser_download_url) {
    log(`[updater] GitHub API: only zip on release: ${candidates[0].name}`);
    logUpdater("github-api", `picked sole zip url=${candidates[0].browser_download_url.slice(0, 120)}…`);
    return candidates[0].browser_download_url;
  }

  log(
    `[updater] GitHub API: could not pick zip (candidates: ${candidates.map((c) => c.name).join(", ") || "none"})`,
  );
  return null;
}

async function downloadToFile(netFetch, url, destPath, onProgress) {
  logUpdater("download", `start → ${destPath}`);
  logUpdater("download", `GET ${url.length > 200 ? `${url.slice(0, 200)}…` : url}`);
  const res = await netFetch(url);
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} ${url}`);
  }
  const total =
    parseInt(res.headers.get("content-length") || res.headers.get("Content-Length") || "0", 10) || 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (onProgress) onProgress(buf.length, total || buf.length);
    fs.writeFileSync(destPath, buf);
    logUpdater("download", `done bytes=${buf.length} (buffer path) → ${destPath}`);
    return;
  }
  const ws = fs.createWriteStream(destPath);
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        received += value.length;
        if (!ws.write(Buffer.from(value))) {
          await new Promise((res) => ws.once("drain", res));
        }
        if (onProgress) onProgress(received, total);
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
  }
  let sizeOnDisk = received;
  try {
    sizeOnDisk = fs.statSync(destPath).size;
  } catch (_) {}
  logUpdater("download", `done bytes=${sizeOnDisk} streamed=${received} totalHdr=${total || "?"} → ${destPath}`);
}

/**
 * Unpack portable app .zip. On Windows, prefer system tar.exe (native I/O; avoids long
 * apparent stalls streaming huge files through Node). Fall back to extract-zip.
 * Pulse callback keeps the updater UI moving during large single-file writes (e.g. app.asar).
 */
/**
 * @param {object} [opts]
 * @param {string} [opts.verifyExeBase] If set, after system tar succeeds we require resolveZipAppContentRoot
 *   to find the app; otherwise we clear and fall back to extract-zip (tar can exit 0 with a bad tree for some zips).
 */
async function extractPortableZipToDir(zipPath, extractDir, logFn, pulse, unpackLo, unpackHi, opts = {}) {
  const verifyExeBase = opts.verifyExeBase;
  const runExtractZip = async () => {
    logUpdater("extract", `extract-zip (yauzl) → ${extractDir}`);
    const extractZip = require("extract-zip");
    let unpackEntryCount = 0;
    let unpackLastName = "";
    const pulseUnpack = () => {
      const span = Math.max(1, unpackHi - unpackLo);
      const bump = Math.min(span, 4 + Math.floor(unpackEntryCount / 30));
      const pct = Math.min(unpackHi, unpackLo + bump);
      pulse({
        text:
          unpackEntryCount > 0
            ? `${pct}% — Unpacking… ${unpackEntryCount} files${unpackLastName ? ` — ${unpackLastName.slice(-56)}` : ""}`
            : `${pct}% — Unpacking… starting`,
        percent: pct,
      });
    };
    const unpackHeartbeat = setInterval(pulseUnpack, 2800);
    const t0 = Date.now();
    logFn(`[updater] extract-zip begin → ${extractDir}`);
    try {
      await extractZip(zipPath, {
        dir: extractDir,
        onEntry: (entry) => {
          unpackEntryCount += 1;
          unpackLastName = entry.fileName || "";
          if (unpackEntryCount <= 4 || unpackEntryCount % 40 === 0) {
            setImmediate(() => pulseUnpack());
          }
        },
      });
    } finally {
      clearInterval(unpackHeartbeat);
    }
    pulse({
      text: `${unpackHi}% — Unpacking… (done)`,
      percent: unpackHi,
    });
    logFn(`[updater] extract-zip done in ${Date.now() - t0}ms (${unpackEntryCount} entries)`);
  };

  if (process.platform === "win32") {
    const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(tarExe)) {
      logUpdater("extract", `try system tar first ${tarExe}`);
      try {
        const t0 = Date.now();
        logFn(`[updater] extracting with ${tarExe}`);
        let tarPct = unpackLo;
        const hb = setInterval(() => {
          tarPct = Math.min(
            unpackHi,
            tarPct + Math.max(1, Math.round((unpackHi - unpackLo) / 35)),
          );
          pulse({
            text: `${tarPct}% — Unpacking… (system archiver)`,
            percent: tarPct,
          });
        }, 450);
        try {
          await new Promise((resolve, reject) => {
            const child = spawn(tarExe, ["-xf", zipPath, "-C", extractDir], {
              windowsHide: true,
              stdio: ["ignore", "ignore", "pipe"],
            });
            logUpdater(
              "extract",
              `system tar pid=${child.pid} cmd=tar -xf <zip> -C <extractDir> zip=${path.basename(zipPath)}`,
            );
            let errBuf = "";
            child.stderr?.on("data", (d) => {
              errBuf += d.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
              logUpdater("extract", `system tar pid=${child.pid} exit=${code}`);
              if (code === 0) resolve();
              else reject(new Error(`tar.exe exited ${code}${errBuf ? `: ${errBuf.slice(-500)}` : ""}`));
            });
          });
        } finally {
          clearInterval(hb);
        }
        pulse({
          text: `${unpackHi}% — Unpacking… (done)`,
          percent: unpackHi,
        });
        logFn(`[updater] system tar done in ${Date.now() - t0}ms`);
        if (verifyExeBase) {
          const root = resolveZipAppContentRoot(extractDir, verifyExeBase);
          if (!root) {
            logFn(
              `[updater] system tar left no recognizable main exe (wanted basename like ${verifyExeBase}); clearing extract dir and using extract-zip`,
            );
            logUpdater("extract", "tar output verification failed → extract-zip");
            try {
              fs.rmSync(extractDir, { recursive: true, force: true });
            } catch (_) {}
            fs.mkdirSync(extractDir, { recursive: true });
            await runExtractZip();
            return;
          }
        }
        return;
      } catch (e) {
        logFn(`[updater] system tar failed (${e?.message || e}); clearing partial extract, retrying with extract-zip`);
        try {
          fs.rmSync(extractDir, { recursive: true, force: true });
        } catch (_) {}
        fs.mkdirSync(extractDir, { recursive: true });
      }
    } else {
      logUpdater("extract", `tar.exe not present (${tarExe}) → extract-zip`);
    }
  } else {
    logUpdater("extract", "non-Windows → extract-zip only");
  }

  await runExtractZip();
}

function sha512Base64OfFile(filePath) {
  const hash = crypto.createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

/**
 * Portable zip main exe name may differ from the running process (spaced vs compact).
 * Must match resolveZipAppContentRoot / apply relaunch candidates.
 */
function winStagingDirHasMainExe(stagingDir, exeBaseName) {
  const alt = new Set([exeBaseName, ...brand.allKnownExeBaseNames()]);
  for (const name of alt) {
    const p = path.join(stagingDir, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return true;
    } catch (_) {}
  }
  return false;
}

function resolveZipAppContentRoot(extractDir, exeBaseName) {
  const direct = path.join(extractDir, exeBaseName);
  if (fs.existsSync(direct)) return extractDir;

  /** Names to treat as the main app exe (portable zip vs running binary name can differ). */
  const altNames = new Set([exeBaseName]);
  if (process.platform === "win32") {
    for (const n of brand.allKnownExeBaseNames()) altNames.add(n);
  }

  const matchesMainExe = (fileName) => {
    const lower = fileName.toLowerCase();
    for (const n of altNames) {
      if (lower === n.toLowerCase()) return true;
    }
    return false;
  };

  /** Prefer shallowest match; skip common subtrees that are not the main exe. */
  const hits = [];
  const MAX_DEPTH = 6;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.exe$/i.test(ent.name)) continue;
      if (matchesMainExe(ent.name)) hits.push({ root: dir, depth });
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const n = ent.name.toLowerCase();
      if (n === "resources" || n === "locales") continue;
      walk(path.join(dir, ent.name), depth + 1);
    }
  };
  walk(extractDir, 0);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.depth - b.depth || a.root.length - b.root.length);
  return hits[0].root;
}

/**
 * After a successful version switch, remove staged builds older than the running app
 * (and same-version leftovers if the apply script already removed the folder).
 */
function scheduleVersionsFolderCleanup() {
  if (isDev || !app.isPackaged || process.platform !== "win32") return;
  const current = app.getVersion();
  setTimeout(() => {
    try {
      logUpdater("cleanup", `versions folder sweep (current=${current})`);
      const sweep = (versionsRoot, label) => {
        if (!fs.existsSync(versionsRoot)) return;
        for (const name of fs.readdirSync(versionsRoot)) {
          const full = path.join(versionsRoot, name);
          let st;
          try {
            st = fs.statSync(full);
          } catch (_) {
            continue;
          }
          if (!st.isDirectory()) continue;
          // Staging for builds older than the running app (previous releases).
          if (compareSemverLike(name, current) < 0) {
            fs.rmSync(full, { recursive: true, force: true });
            log(`[updater] removed old staged folder (${label}): ${name}`);
          }
        }
      };
      sweep(path.join(app.getPath("userData"), "pending-update-versions"), "userData");
      sweep(path.join(getWindowsAppRootFromExecPath(process.execPath), "versions"), "installDir versions");
    } catch (e) {
      log(`[updater] versions cleanup: ${e?.message || e}`);
    }
  }, 5000);
}

const isDev = process.env.NODE_ENV === "development";
const updaterMenuApi = {
  checkNow: null,
};
const updateDialogState = {
  window: null,
  installEnabled: false,
  ipcBound: false,
};
/** When true, skip app.quit() from window closed handlers so quitAndInstall can run first (avoids race + long hang). */
let suppressQuitForUpdateInstall = false;

/** Real path to icon.ico (prefer asar-unpacked so Windows can load it for the window/taskbar). */
function resolveAppIconIcoPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "assets", "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "assets", "icon.ico"),
    app.getAppPath && path.join(app.getAppPath(), "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.ico"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/** All existing .ico paths (packaged app may have the file only inside app.asar — see nativeImage note below). */
function collectAppIconIcoCandidates() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "assets", "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "assets", "icon.ico"),
    app.getAppPath && path.join(app.getAppPath(), "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.ico"),
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const n = path.normalize(p);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    } catch (_) {}
  }
  return out;
}

/**
 * Paths under app.asar\... are real for Node (readFileSync) but not for nativeImage.createFromPath /
 * app.getFileIcon (shell/GDI cannot read inside the asar archive). Always prefer readFileSync + createFromBuffer for .ico.
 */
function nativeImageFromIcoFilePath(p) {
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? null : img;
  } catch (_) {
    return null;
  }
}

function nativeImageFromAppIcon() {
  const paths = collectAppIconIcoCandidates();
  for (const p of paths) {
    const img = nativeImageFromIcoFilePath(p);
    if (img) return img;
  }
  for (const p of paths) {
    try {
      const inAsarArchive = p.includes("app.asar") && !p.includes("app.asar.unpacked");
      if (inAsarArchive) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch (_) {}
  }
  if (process.platform === "win32" && app.isPackaged) {
    try {
      const img = nativeImage.createFromPath(process.execPath);
      if (!img.isEmpty()) return img;
    } catch (_) {}
  }
  return undefined;
}

function resolveNotificationIcon() {
  const candidates = [
    resolveAppIconIcoPath(),
    process.resourcesPath && path.join(process.resourcesPath, "icon.ico"),
    path.join(process.resourcesPath || "", "assets", "icon.ico"),
    path.join(app.getAppPath(), "assets", "icon.ico"),
    app.getPath("exe"),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch (_) {
      return false;
    }
  });
}

// One running instance on Windows: avoids two Electron processes during NSIS upgrade.
if (!isDev && process.platform === "win32") {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function setupAutoUpdater() {
  if (isDev || !app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    // Without this, checkForUpdates reads resources/app-update.yml (embedded by electron-builder, absent in Forge installs).
    autoUpdater.setFeedURL({
      provider: "github",
      owner: UPDATE_GITHUB_OWNER,
      repo: UPDATE_GITHUB_REPO,
    });
    let manualCheckInProgress = false;
    let manualDownloadInProgress = false;
    let updaterCheckRetrying = false;

    const checkForUpdatesWithRetry = async (attempts = 4) => {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        try {
          logUpdater("check", `checkForUpdates attempt ${i + 1}/${attempts}`);
          const result = await autoUpdater.checkForUpdates();
          const u = result?.updateInfo ?? result;
          logUpdater(
            "check",
            `checkForUpdates ok version=${u?.version ?? "?"} release=${u?.releaseDate ?? "?"} ` +
              `downloadURL=${u?.downloadUrl ?? u?.path ?? "?"}`,
          );
          return result;
        } catch (e) {
          lastErr = e;
          logUpdater("check", `checkForUpdates error attempt ${i + 1}: ${e?.message || e}`);
          if (!isTransientGithubUpdateError(e) || i === attempts - 1) throw e;
          const delayMs = 1500 * 2 ** i;
          log(
            `[updater] transient GitHub/update error (${i + 1}/${attempts}), retry in ${delayMs}ms: ${e?.message || e}`,
          );
          await sleep(delayMs);
        }
      }
      throw lastErr;
    };
    const currentVersion = app.getVersion();
    const applyUserLogPath = path.join(app.getPath("userData"), "hsp-update-apply.log");

    /** Prefer transferred/total when known; Windows often keeps percent at 0 until late. */
    const progressPercent = (progress) => {
      if (!progress || typeof progress !== "object") return 0;
      const total = progress.total;
      const transferred = progress.transferred ?? 0;
      if (typeof total === "number" && total > 0) {
        return Math.max(0, Math.min(100, (100 * transferred) / total));
      }
      const p = progress.percent;
      if (typeof p === "number" && !Number.isNaN(p)) {
        if (p > 0 && p <= 1) {
          return Math.max(0, Math.min(100, p * 100));
        }
        return Math.max(0, Math.min(100, p));
      }
      return 0;
    };

    // Single content height: always leave room for the activity log so it is not clipped when progress/actions hide.
    const UPDATER_LOG_PANEL = 108;
    const UPDATER_DIALOG_H = 198 + UPDATER_LOG_PANEL;

    const sendUpdaterLogInitToDialog = () => {
      const w = updateDialogState.window;
      if (!w || w.isDestroyed()) return;
      try {
        w.webContents.send("updater-log-init", updaterDialogLogBuffer.slice());
      } catch (_) {}
    };

    updaterLogToDialog = (line) => {
      const w = updateDialogState.window;
      if (!w || w.isDestroyed()) return;
      const wc = w.webContents;
      const send = () => {
        try {
          wc.send("updater-log", line);
        } catch (_) {}
      };
      if (wc.isLoading()) wc.once("did-finish-load", send);
      else send();
    };

    /** Set after syncZipReadyUi / stagingHasMainExe; enables main-process installEnabled when opening the dialog. */
    let refreshUpdaterDialogIfStagedReady = () => {};

    const openOrFocusUpdateDialog = () => {
      if (updateDialogState.window && !updateDialogState.window.isDestroyed()) {
        updateDialogState.window.show();
        updateDialogState.window.focus();
        sendUpdaterLogInitToDialog();
        refreshUpdaterDialogIfStagedReady();
        return;
      }
      updateDialogState.window = new BrowserWindow({
        width: 420,
        height: UPDATER_DIALOG_H,
        useContentSize: true,
        title: "Updater",
        resizable: false,
        minimizable: false,
        maximizable: false,
        show: false,
        autoHideMenuBar: true,
        // No parent: a child window + showMessageBox(modal to child) often leaves alerts behind the main frame.
        modal: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      });
      const updaterHtmlPath = path.join(__dirname, "updater-dialog.html");
      if (!fs.existsSync(updaterHtmlPath)) {
        log(`[updater] FATAL: updater-dialog.html missing at ${updaterHtmlPath}`);
      }
      updateDialogState.window.loadFile(updaterHtmlPath);
      updateDialogState.window.webContents.once("did-finish-load", () => {
        const w = updateDialogState.window;
        if (!w || w.isDestroyed()) return;
        const wc = w.webContents;
        const cvText = `Current version: ${currentVersion}`;
        wc.executeJavaScript(`document.getElementById('cv').textContent = ${JSON.stringify(cvText)}`).catch(() => {});
        sendUpdaterLogInitToDialog();
        refreshUpdaterDialogIfStagedReady();
      });
      updateDialogState.window.once("ready-to-show", () => {
        if (updateDialogState.window && !updateDialogState.window.isDestroyed()) updateDialogState.window.show();
      });
      updateDialogState.window.on("closed", () => {
        updateDialogState.window = null;
      });
    };
    /**
     * @param {object} opts
     * @param {string} opts.text
     * @param {number} [opts.percent]
     * @param {boolean} [opts.showProgress]
     * @param {boolean} [opts.showActions] Update button row (when false: version + text only; dismiss via title bar X)
     * @param {boolean} [opts.installEnabled]
     */
    const updateDialogUi = ({ text, percent = 0, showProgress = false, showActions = false, installEnabled = false }) => {
      if (!updateDialogState.window || updateDialogState.window.isDestroyed()) return;
      const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      updateDialogState.installEnabled = Boolean(installEnabled);
      try {
        updateDialogState.window.setSize(420, UPDATER_DIALOG_H);
      } catch (_) {}
      const payload = {
        text,
        percent: safe,
        showProgress,
        showActions,
        installEnabled: Boolean(installEnabled),
      };
      const wc = updateDialogState.window.webContents;
      const send = () => {
        try {
          wc.send("updater-ui", payload);
        } catch (e) {
          log(`[updater] updateDialogUi send: ${e?.message || e}`);
        }
      };
      // IPC survives rapid download-progress; executeJavaScript could drop or race with load state.
      if (wc.isLoading()) {
        wc.once("did-finish-load", send);
      } else {
        send();
      }
    };
    const closeUpdateDialog = () => {
      if (updateDialogState.window && !updateDialogState.window.isDestroyed()) updateDialogState.window.close();
      updateDialogState.window = null;
      updateDialogState.installEnabled = false;
    };

    /** Prefer main/browser window so native dialogs are not hidden behind a frame owned as child. */
    const focusMainWindowForDialog = () => {
      const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      const mainLike = all.find((w) => w !== updateDialogState.window) ?? all[0];
      try {
        if (mainLike) {
          if (mainLike.isMinimized()) mainLike.restore();
          mainLike.focus();
        }
      } catch (_) {}
      return mainLike ?? null;
    };

    if (!updateDialogState.ipcBound) {
      updateDialogState.ipcBound = true;
      // invoke/handle is more reliable than send for click→main from file:// updater pages on some Electron builds.
      ipcMain.handle("updater-install-now", () => {
        logUpdater("ipc", "updater-install-now (invoke)");
        try {
          requestInstallNow();
          return { ok: true };
        } catch (e) {
          const m = e?.message || String(e);
          log(`[updater] requestInstallNow threw: ${m}`);
          return { ok: false, err: m };
        }
      });
      ipcMain.on("updater-install-click", () => {
        logUpdater("ipc", "updater-install-click received (legacy send)");
        requestInstallNow();
      });
      ipcMain.on("updater-renderer-error", (_e, msg) => {
        log(`[updater] renderer: ${typeof msg === "string" ? msg : String(msg)}`);
      });
    }
    const logUpdaterChannel = (m) => {
      const body = `[updater] ${typeof m === "string" ? m : JSON.stringify(m)}`;
      log(body);
      appendUpdaterDialogLogLine(body);
    };
    autoUpdater.logger = {
      info: logUpdaterChannel,
      warn: logUpdaterChannel,
      error: logUpdaterChannel,
      debug: logUpdaterChannel,
    };

    const useWinVersionsSidecar = process.platform === "win32";
    let zipPrepareInFlight = false;
    let zipReadyVersion = null;
    let zipStagingContentPath = null;

    autoUpdater.autoDownload = !useWinVersionsSidecar;
    // Windows: never install a downloaded NSIS on quit — in-app Update uses staged zip + robocopy only.
    autoUpdater.autoInstallOnAppQuit = !useWinVersionsSidecar;
    autoUpdater.autoRunAppAfterInstall = true;
    log(
      `[updater] initialized (github, winVersions=${useWinVersionsSidecar}, autoDownload=${autoUpdater.autoDownload})`,
    );
    logUpdater(
      "init",
      `repo=${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO} app=${currentVersion} platform=${process.platform} ` +
        `winZipSidecar=${useWinVersionsSidecar} autoDownload=${autoUpdater.autoDownload} autoInstallOnQuit=${autoUpdater.autoInstallOnAppQuit}`,
    );

    let installRequested = false;
    logUpdaterStateSnapshot("init");

    const syncZipReadyUi = (v) => {
      if (!updateDialogState.window || updateDialogState.window.isDestroyed()) return;
      updateDialogUi({
        text: `Update ${v} is ready. Click "Update with reload" to close and open the new version.`,
        percent: 100,
        showProgress: true,
        showActions: true,
        installEnabled: true,
      });
    };

    const stagingHasMainExe = (stagingDir) => {
      const exeBase = path.basename(process.execPath);
      if (process.platform === "win32") {
        return winStagingDirHasMainExe(stagingDir, exeBase);
      }
      const direct = path.join(stagingDir, exeBase);
      if (fs.existsSync(direct)) return true;
      try {
        const want = exeBase.toLowerCase();
        return fs.readdirSync(stagingDir).some((n) => n.toLowerCase() === want);
      } catch (_) {
        return false;
      }
    };

    refreshUpdaterDialogIfStagedReady = () => {
      if (!useWinVersionsSidecar || !zipReadyVersion || !zipStagingContentPath) return;
      if (!stagingHasMainExe(zipStagingContentPath)) return;
      syncZipReadyUi(zipReadyVersion);
    };

    const getVersionsStagingRoot = () => path.join(app.getPath("userData"), "pending-update-versions");
    function logUpdaterStateSnapshot(reason, extra = {}) {
      let stagedVersions = [];
      try {
        const root = getVersionsStagingRoot();
        if (fs.existsSync(root)) {
          stagedVersions = fs
            .readdirSync(root)
            .filter((name) => {
              try {
                return fs.statSync(path.join(root, name)).isDirectory();
              } catch (_) {
                return false;
              }
            })
            .sort((a, b) => compareSemverLike(a, b));
        }
      } catch (_) {}
      const state = {
        reason,
        currentVersion,
        manualCheckInProgress,
        manualDownloadInProgress,
        updaterCheckRetrying,
        zipPrepareInFlight,
        zipReadyVersion,
        zipStagingContentPath,
        stagedExeOk: zipStagingContentPath ? stagingHasMainExe(zipStagingContentPath) : false,
        stagedVersions,
        installRequested,
        dialogOpen: Boolean(updateDialogState.window && !updateDialogState.window.isDestroyed()),
        installEnabled: Boolean(updateDialogState.installEnabled),
        ...extra,
      };
      logUpdater("state", safeJson(state, 1600));
    }

    const restoreVersionsStagingFromDisk = () => {
      const root = getVersionsStagingRoot();
      logUpdater("staging", `restore scan root=${root}`);
      if (!fs.existsSync(root)) {
        logUpdater("staging", "restore skip (root missing)");
        return;
      }
      const exeBase = path.basename(process.execPath);
      let bestVer = null;
      let bestContent = null;
      for (const name of fs.readdirSync(root)) {
        const full = path.join(root, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch (_) {
          continue;
        }
        if (!st.isDirectory()) continue;
        if (compareSemverLike(name, currentVersion) <= 0) {
          try {
            fs.rmSync(full, { recursive: true, force: true });
            logUpdater("staging", `removed stale staging folder ${name} (current=${currentVersion})`);
          } catch (_) {}
          continue;
        }
        const extractDir = path.join(full, "extract");
        if (!fs.existsSync(extractDir)) continue;
        const contentRoot = resolveZipAppContentRoot(extractDir, exeBase);
        if (!contentRoot || !stagingHasMainExe(contentRoot)) continue;
        if (!bestVer || compareSemverLike(name, bestVer) > 0) {
          bestVer = name;
          bestContent = contentRoot;
        }
      }
      if (bestVer && bestContent) {
        zipReadyVersion = bestVer;
        zipStagingContentPath = bestContent;
        log(`[updater] restored staging from disk: ${bestVer} -> ${bestContent}`);
        logUpdater("staging", `restore picked version=${bestVer} contentRoot=${bestContent}`);
        logUpdaterStateSnapshot("restore/picked");
      } else {
        logUpdater("staging", "restore no valid staged build found");
        logUpdaterStateSnapshot("restore/none");
      }
    };

    restoreVersionsStagingFromDisk();

    const tryBeginVersionsPrepare = async (info, opts) => {
      const remoteV = info?.version;
      logUpdater(
        "prepare",
        `tryBeginVersionsPrepare enter remote=${remoteV || "?"} feed=${safeJson(info)} opts=${safeJson(opts)}`,
      );
      logUpdaterStateSnapshot("prepare/enter", { remoteVersion: remoteV || null });
      if (!useWinVersionsSidecar) {
        logUpdater("prepare", "skip (not Windows zip sidecar mode)");
        return;
      }
      if (!remoteV || compareSemverLike(remoteV, currentVersion) <= 0) {
        logUpdater("prepare", `skip (no remote or not newer remote=${remoteV} current=${currentVersion})`);
        return;
      }
      if (zipPrepareInFlight) {
        logUpdater("prepare", "skip (zipPrepareInFlight)");
        return;
      }
      const exeBase = path.basename(process.execPath);
      if (zipReadyVersion === remoteV && zipStagingContentPath && stagingHasMainExe(zipStagingContentPath)) {
        logUpdater("prepare", `skip (already staged ${remoteV})`);
        if (!updateDialogState.window || updateDialogState.window.isDestroyed()) {
          openOrFocusUpdateDialog();
        }
        syncZipReadyUi(remoteV);
        manualDownloadInProgress = false;
        return;
      }
      zipPrepareInFlight = true;
      logUpdater("prepare", `start pipeline → ${remoteV} exeBase=${exeBase}`);
      const uiManual = Boolean(opts?.uiManual);
      const uiActive =
        uiManual || (updateDialogState.window && !updateDialogState.window.isDestroyed());
      /** Overall 0–100: 0–81 download, 81–100 verify/unpack/finalize (single bar, monotonic). */
      let prepareProgressCeiling = 0;
      const pushUi = (partial) => {
        if (!uiActive) return;
        const raw = partial.percent;
        const n = typeof raw === "number" && !Number.isNaN(raw) ? raw : Number(raw);
        const next =
          typeof n === "number" && !Number.isNaN(n)
            ? Math.max(prepareProgressCeiling, Math.round(Math.max(0, Math.min(100, n))))
            : prepareProgressCeiling;
        prepareProgressCeiling = next;
        updateDialogUi({
          showProgress: true,
          showActions: true,
          installEnabled: false,
          percent: 0,
          text: "",
          ...partial,
          percent: next,
        });
      };
      let versionsPrepareOk = false;
      try {
        const meta = await resolveWindowsZipSidecarMeta((u) => net.fetch(u), currentVersion);
        if (meta.version !== remoteV) {
          log(`[updater] sidecar version ${meta.version} vs feed ${remoteV} (using sidecar manifest)`);
        }
        log(`[updater] sidecar source: ${meta.source} → ${meta.fileName}`);

        // One bar: 81% for download, 19% for verify + unpack + finalize (overall 0–100).
        const PREP_PCT_DOWNLOAD_MAX = 81;
        const PREP_PCT_VERIFY_END = 87;
        const PREP_UNPACK_LO = 87;
        const PREP_UNPACK_HI = 99;
        pushUi({ text: "0% — Downloading update…", percent: 0 });

        const versionsRoot = getVersionsStagingRoot();
        const versionDir = path.join(versionsRoot, meta.version);
        const extractDir = path.join(versionDir, "extract");
        logUpdater("prepare", `paths versionDir=${versionDir} extractDir=${extractDir}`);
        try {
          fs.rmSync(versionDir, { recursive: true, force: true });
        } catch (_) {}
        fs.mkdirSync(extractDir, { recursive: true });

        const zipPath = path.join(versionDir, meta.fileName);
        const primaryZipUrl = githubLatestAssetUrl(meta.fileName);
        logUpdater("prepare", `download primaryURL asset=${meta.fileName}`);
        let lastZipPush = 0;
        const onZipProgress = (received, total) => {
          const now = Date.now();
          const hasTotal = typeof total === "number" && total > 0;
          if (hasTotal && now - lastZipPush < 100 && received < total) return;
          if (!hasTotal && lastZipPush > 0 && now - lastZipPush < 150) return;
          lastZipPush = now;
          const mb = received / (1024 * 1024);
          let overall;
          if (hasTotal) {
            const dl = received / total;
            overall = Math.min(
              PREP_PCT_DOWNLOAD_MAX,
              Math.round(PREP_PCT_DOWNLOAD_MAX * dl),
            );
          } else {
            overall = Math.min(
              PREP_PCT_DOWNLOAD_MAX - 1,
              Math.round(PREP_PCT_DOWNLOAD_MAX * (1 - Math.exp(-mb / 55))),
            );
          }
          pushUi({
            text: hasTotal
              ? `${overall}% — Downloading update…`
              : `${overall}% — Downloading update… (~${mb.toFixed(1)} MB, size unknown)`,
            percent: overall,
          });
        };
        try {
          await downloadToFile((u) => net.fetch(u), primaryZipUrl, zipPath, onZipProgress);
        } catch (e) {
          const msg = String(e?.message || e);
          if (!/404/.test(msg)) throw e;
          const altUrl = await fetchPortableZipBrowserUrlFromGitHubApi(
            (u, init) => net.fetch(u, init),
            meta.version,
            meta.fileName,
          );
          if (!altUrl) throw e;
          log(`[updater] primary zip 404; downloading from GitHub API URL`);
          logUpdater("prepare", `download fallbackURL (API) → ${altUrl.length > 160 ? `${altUrl.slice(0, 160)}…` : altUrl}`);
          await downloadToFile((u) => net.fetch(u), altUrl, zipPath, onZipProgress);
        }

        pushUi({ text: `${PREP_PCT_DOWNLOAD_MAX}% — Download finished`, percent: PREP_PCT_DOWNLOAD_MAX });

        let verifyHb = null;
        try {
          let vPct = PREP_PCT_DOWNLOAD_MAX + 1;
          verifyHb = setInterval(() => {
            vPct = Math.min(PREP_PCT_VERIFY_END - 1, vPct + 1);
            pushUi({ text: `${vPct}% — Verifying update…`, percent: vPct });
          }, 350);
          pushUi({ text: `${PREP_PCT_DOWNLOAD_MAX + 1}% — Verifying update…`, percent: PREP_PCT_DOWNLOAD_MAX + 1 });

          if (meta.sha512) {
            logUpdater("verify", "sha512 check (zip-latest)");
            const hash = sha512Base64OfFile(zipPath);
            if (hash !== meta.sha512) throw new Error("zip sha512 mismatch");
            logUpdater("verify", "sha512 ok");
          } else {
            log(
              "[updater] no sha512 manifest for zip (optional: add zip-latest.yml from cleanup for integrity check)",
            );
          }
        } finally {
          if (verifyHb) clearInterval(verifyHb);
        }
        pushUi({ text: `${PREP_PCT_VERIFY_END}% — Verifying update…`, percent: PREP_PCT_VERIFY_END });

        pushUi({
          text: `${PREP_UNPACK_LO}% — Unpacking update…`,
          percent: PREP_UNPACK_LO,
        });

        await extractPortableZipToDir(zipPath, extractDir, log, pushUi, PREP_UNPACK_LO, PREP_UNPACK_HI, {
          verifyExeBase: exeBase,
        });

        pushUi({ text: "99% — Finalizing…", percent: 99 });

        const contentRoot = resolveZipAppContentRoot(extractDir, exeBase);
        if (!contentRoot) throw new Error("extracted update has no app executable");
        logUpdater("prepare", `resolveZipAppContentRoot ok contentRoot=${contentRoot}`);

        try {
          fs.unlinkSync(zipPath);
        } catch (_) {}
        logUpdater("prepare", `removed cached zip ${zipPath}`);

        zipStagingContentPath = contentRoot;
        zipReadyVersion = meta.version;
        manualDownloadInProgress = false;
        log(`[updater] staged update at ${contentRoot}`);
        logUpdater("prepare", `COMPLETE readyVersion=${meta.version} staging=${contentRoot}`);
        logUpdaterStateSnapshot("prepare/complete", { preparedVersion: meta.version });
        // syncZipReadyUi needs an open dialog; background checks used uiActive=false and would skip UI.
        if (!uiActive) {
          openOrFocusUpdateDialog();
        }
        syncZipReadyUi(meta.version);
        if (!uiActive && process.platform === "win32" && Notification.isSupported()) {
          try {
            new Notification({
              title: brand.productDisplayName,
              body: `Update ${meta.version} is ready. Open Updates → Check for updates.`,
            }).show();
          } catch (_) {}
        }
        versionsPrepareOk = true;
      } catch (e) {
        const errMsg = e?.message || e;
        const errStack = typeof e?.stack === "string" ? e.stack : "";
        logUpdater("prepare", `FAILED ${errMsg}`);
        log(`[updater] versions sidecar failed: ${errMsg}`);
        if (errStack) log(`[updater] versions sidecar stack: ${errStack.split("\n").slice(0, 8).join(" | ")}`);
        log(
          `[updater] Ensure latest GitHub release includes latest.yml, ${WIN_PORTABLE_ZIP_PREFIX}<version>.zip (zip build), and optionally zip-latest.yml from cleanup for sha512.`,
        );
        zipStagingContentPath = null;
        zipReadyVersion = null;
        manualDownloadInProgress = false;
        const hint =
          `Update prepare failed: ${e?.message || String(e)}. ` +
          `Publish the Windows zip (${WIN_PORTABLE_ZIP_PREFIX}<version>.zip) on https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest — latest.yml is enough; add zip-latest.yml from cleanup for checksum verification.`;
        if (uiActive) {
          openOrFocusUpdateDialog();
          updateDialogUi({
            text: hint,
            percent: 0,
            showProgress: false,
            showActions: true,
            installEnabled: false,
          });
        }
        logUpdaterStateSnapshot("prepare/failed", { error: String(errMsg) });
      } finally {
        zipPrepareInFlight = false;
        logUpdater(
          "prepare",
          versionsPrepareOk
            ? "zipPrepareInFlight=false (success)"
            : "zipPrepareInFlight=false (incomplete — look for prepare FAILED above)",
        );
      }
    };

    const applyVersionsStagedUpdate = () => {
      const execPath = process.execPath;
      const installDir = path.dirname(execPath);
      const exeName = path.basename(execPath);
      const appRoot = getWindowsAppRootFromExecPath(execPath);
      // Always apply into versions/<semver> + current junction (avoids locked flat exe / partial overwrite).
      const useVersionedLayout = true;
      // Start Menu / desktop shortcuts often still point at INSTDIR\<exe> (flat), not
      // INSTDIR\current\. If we skip flat refresh when applying from `current`, the next
      // shortcut launch returns to an old flat build (prod: current=1425, flat stayed 1412).
      let cleanupLegacyFlat = false;
      try {
        cleanupLegacyFlat =
          fs.existsSync(path.join(appRoot, exeName)) ||
          fs.existsSync(path.join(appRoot, "resources", "app.asar"));
      } catch (_) {
        cleanupLegacyFlat = path.basename(installDir).toLowerCase() !== "current";
      }
      const needsElevation = installPathNeedsElevation(appRoot);
      const applyLogPath = applyUserLogPath;
      logUpdater(
        "apply",
        `applyVersionsStagedUpdate installDir=${installDir} appRoot=${appRoot} versioned=${useVersionedLayout} cleanupLegacyFlat=${cleanupLegacyFlat} needsElevation=${needsElevation} exe=${exeName} staging=${zipStagingContentPath} version=${zipReadyVersion} pid=${process.pid}`,
      );
      logUpdater("apply", `helper log (next run): ${applyLogPath}`);
      const planPath = path.join(app.getPath("temp"), `hsp-update-plan-${Date.now()}.json`);
      const stagingVersionDirToRemove = zipReadyVersion
        ? path.join(getVersionsStagingRoot(), zipReadyVersion)
        : null;
      const targetVersionDir =
        useVersionedLayout && zipReadyVersion ? path.join(appRoot, "versions", zipReadyVersion) : null;
      const currentLink = useVersionedLayout ? path.join(appRoot, "current") : null;
      const appliedVersionMarker = getAppliedVersionMarkerPath();
      const plan = {
        stagingContent: zipStagingContentPath,
        installDir,
        exeName,
        waitPid: process.pid,
        appliedVersion: zipReadyVersion,
        appliedVersionMarker,
        stagingVersionDirToRemove,
        logPath: applyLogPath,
        useVersionedLayout,
        appRoot,
        targetVersionDir,
        currentLink,
        cleanupLegacyFlat,
        needsElevation,
        elevated: false,
      };
      fs.writeFileSync(planPath, JSON.stringify(plan), "utf8");
      logUpdater("apply", `wrote plan ${planPath} ${safeJson(plan)}`);

      const ps1Path = path.join(app.getPath("temp"), `hsp-apply-versions-${Date.now()}.ps1`);
      /**
       * Apply script uses no fixed sleeps: wait for parent via Wait-Process, kill stragglers, copy, relaunch.
       * Robocopy: /R:0 /W:0 (no retry delay), /MT:64 /J (throughput on SSD/large files), staging tree delete is async after relaunch.
       */
      const ps1Body = [
        "param([string]$PlanPath, [string]$LogPath)",
        '$ErrorActionPreference = "Stop"',
        "if (-not $PlanPath) { $PlanPath = $env:HSP_UPDATE_PLAN }",
        "if (-not $LogPath) { $LogPath = $env:HSP_UPDATE_LOG }",
        "try {",
        "  $trace = Join-Path $env:TEMP 'hsp-apply-trace.log'",
        "  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
        "  Add-Content -LiteralPath $trace -Encoding UTF8 -Value (\"[$ts] ps1 -File started pid=$PID\")",
        "  if ($LogPath) {",
        "    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (\"[$ts] [ps1] bootstrap (before plan JSON)\")",
        "  }",
        "} catch {}",
        'if (-not $PlanPath) { throw "Plan path missing (pass -PlanPath to this script or set HSP_UPDATE_PLAN)" }',
        "try {",
        "  $plan = Get-Content -LiteralPath $PlanPath -Encoding UTF8 -Raw | ConvertFrom-Json",
        "} catch {",
        "  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
        "  $m = \"FATAL: plan JSON read/parse failed: \" + $_.Exception.Message",
        "  if ($LogPath) { try { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (\"[$ts] \" + $m) } catch {} }",
        "  throw",
        "}",
        "$LogFile = $plan.logPath",
        "function Write-ApplyLog([string]$m) {",
        "  try {",
        "    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
        '    Add-Content -LiteralPath $LogFile -Value ("[$ts] " + $m) -Encoding UTF8',
        "  } catch {}",
        "}",
        "if ($plan.needsElevation -and -not $plan.elevated) {",
        '  Write-ApplyLog "needsElevation=true; relaunching apply helper elevated"',
        "  $plan.elevated = $true",
        "  ($plan | ConvertTo-Json -Compress) | Set-Content -LiteralPath $PlanPath -Encoding UTF8",
        "  $psExe = (Get-Command powershell.exe).Source",
        "  Start-Process -FilePath $psExe -Verb RunAs -WindowStyle Hidden -ArgumentList @(",
        "    '-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-PlanPath',$PlanPath,'-LogPath',$LogPath",
        "  )",
        "  exit 0",
        "}",
        "function Write-FileProbe([string]$label, [string]$path) {",
        "  try {",
        "    if (-not (Test-Path -LiteralPath $path)) {",
        '      Write-ApplyLog ($label + ": missing " + $path)',
        "      return",
        "    }",
        "    $fi = Get-Item -LiteralPath $path -ErrorAction Stop",
        "    $utc = $fi.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
        '    Write-ApplyLog ($label + ": size=" + $fi.Length + " mtimeUtc=" + $utc + " path=" + $path)',
        "  } catch {",
        '    Write-ApplyLog ($label + ": probe failed " + $_.Exception.Message + " path=" + $path)',
        "  }",
        "}",
        "try {",
        '  Write-ApplyLog "apply start waitPid=$($plan.waitPid) exe=$($plan.exeName) versioned=$($plan.useVersionedLayout)"',
        "  $pp = Get-Process -Id $plan.waitPid -ErrorAction SilentlyContinue",
        "  if ($pp) { Wait-Process -InputObject $pp -ErrorAction SilentlyContinue }",
        '  Write-ApplyLog "parent process ended (Wait-Process)"',
        "  $stem = [System.IO.Path]::GetFileNameWithoutExtension($plan.exeName)",
        "  $killNames = @($stem, ($stem + \" Helper\"), ($stem + \" Helper (GPU)\"), ($stem + \" Helper (Renderer)\"), ($stem + \" Helper (Plugin)\"))",
        "  foreach ($kn in $killNames) {",
        "    try { Get-Process -Name $kn -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}",
        "  }",
        "  $root = [string]$plan.appRoot",
        "  if ($root) {",
        "    $rootNorm = $root.TrimEnd('\\').ToLower()",
        "    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
        "      $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($rootNorm)",
        "    } | ForEach-Object {",
        "      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}",
        "    }",
        "  }",
        "  Start-Sleep -Milliseconds 1500",
        '  Write-ApplyLog "stopped app processes under install root"',
        "  # Prior applies using Remove-Item on the junction can hang elevated forever and",
        "  # block cmd rmdir / Test-Path on the same reparse point (prod: 1422/1423).",
        "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
        "    $_.Name -match 'powershell|pwsh' -and $_.CommandLine -and (",
        "      $_.CommandLine -like '*hsp-apply-versions*' -or $_.CommandLine -like '*hsp-finish-*'",
        "    ) -and $_.ProcessId -ne $PID",
        "  } | ForEach-Object {",
        "    try {",
        '      Write-ApplyLog ("killing hung apply helper pid=" + $_.ProcessId)',
        "      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
        "    } catch {}",
        "  }",
        "  $src = $plan.stagingContent",
        "  if (-not $plan.useVersionedLayout -or -not $plan.targetVersionDir) {",
        '    throw "versioned apply target missing"',
        "  }",
        "  $dst = $plan.targetVersionDir",
        "  $null = New-Item -ItemType Directory -Force -Path $dst",
        '  Write-ApplyLog "mirror target (versioned): $dst"',
        "  $srcAsar = Join-Path $src 'resources\\app.asar'",
        "  $srcExe = Join-Path $src $plan.exeName",
        "  $dstAsar = Join-Path $dst 'resources\\app.asar'",
        "  $dstExe = Join-Path $dst $plan.exeName",
        "  Write-FileProbe 'pre-copy src asar' $srcAsar",
        "  Write-FileProbe 'pre-copy src exe' $srcExe",
        "  Write-FileProbe 'pre-copy dst asar' $dstAsar",
        "  Write-FileProbe 'pre-copy dst exe' $dstExe",
        '  Write-ApplyLog "copy staging -> dest (robocopy /MIR into versions/<semver>)"',
        "  $robocopyExe = Join-Path $env:SystemRoot 'System32\\robocopy.exe'",
        "  & $robocopyExe $src $dst /MIR /E /MT:64 /J /R:0 /W:0 /NFL /NDL /NJH /NJS",
        "  $mirrorExit = $LASTEXITCODE",
        "  Write-ApplyLog (\"robocopy mirror exit=\" + $mirrorExit)",
        "  if ($mirrorExit -gt 7) {",
        '    Write-ApplyLog "robocopy mirror failed; Copy-Item full tree fallback"',
        "    Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force",
        '    Write-ApplyLog "Copy-Item fallback done"',
        "  }",
        "  Write-FileProbe 'post-copy src asar' $srcAsar",
        "  Write-FileProbe 'post-copy src exe' $srcExe",
        "  Write-FileProbe 'post-copy dst asar' $dstAsar",
        "  Write-FileProbe 'post-copy dst exe' $dstExe",
        '  Write-ApplyLog "post-copy probes done; beginning junction switch"',
        "  if ($plan.useVersionedLayout) {",
        "    # Never Remove-Item / Test-Path a Program Files junction — both can hang",
        "    # (esp. while a prior elevated apply is stuck on Remove-Item). Use cmd only.",
        '    Write-ApplyLog ("switching current junction -> " + $plan.targetVersionDir)',
        "    if ([System.IO.Directory]::Exists([string]$plan.currentLink)) {",
        '      Write-ApplyLog ("removing old current via cmd rmdir: " + $plan.currentLink)',
        "      $rm = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c','rmdir',('\"' + $plan.currentLink + '\"')) -Wait -PassThru -WindowStyle Hidden",
        "      if ($rm.ExitCode -ne 0 -and [System.IO.Directory]::Exists([string]$plan.currentLink)) {",
        "        throw (\"failed to remove current junction exit=\" + $rm.ExitCode)",
        "      }",
        '      Write-ApplyLog "removed old current junction/link"',
        "    }",
        '    Write-ApplyLog ("creating junction via mklink /J: $($plan.currentLink) -> $($plan.targetVersionDir)")',
        "    $mk = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c','mklink','/J',('\"' + $plan.currentLink + '\"'),('\"' + $plan.targetVersionDir + '\"')) -Wait -PassThru -WindowStyle Hidden",
        "    if ($mk.ExitCode -ne 0) { throw (\"mklink /J failed exit=\" + $mk.ExitCode) }",
        '    Write-ApplyLog ("junction: $($plan.currentLink) -> $($plan.targetVersionDir)")',
        "  }",
        "  if ($plan.appliedVersionMarker -and $plan.appliedVersion) {",
        "    try {",
        "      $md = Split-Path -Parent $plan.appliedVersionMarker",
        "      if ($md) { $null = New-Item -ItemType Directory -Force -Path $md }",
        "      Set-Content -LiteralPath $plan.appliedVersionMarker -Value $plan.appliedVersion -Encoding UTF8 -NoNewline",
        '      Write-ApplyLog ("wrote applied version marker: " + $plan.appliedVersion)',
        "    } catch {",
        '      Write-ApplyLog ("applied version marker failed: " + $_.Exception.Message)',
        "    }",
        "  }",
        "  $workDir = if ($plan.useVersionedLayout) { $plan.currentLink } else { $dst }",
        `  $candidates = @($plan.exeName, ${brand.allKnownExeBaseNames().map((n) => `"${n}"`).join(", ")}) | Select-Object -Unique`,
        "  $exePath = $null",
        "  foreach ($c in $candidates) {",
        "    $tryExe = Join-Path $workDir $c",
        "    if ([System.IO.File]::Exists($tryExe)) { $exePath = $tryExe; Write-ApplyLog (\"picked exe: \" + $c); break }",
        "  }",
        "  if (-not $exePath) { throw (\"main exe missing after apply under \" + $workDir + \" (tried \" + ($candidates -join \", \") + \")\") }",
        '  Write-ApplyLog ("relaunch " + $exePath + " (wd=" + $workDir + ")")',
        `  $relaunchEnv = @{ '${HSP_FROM_CURRENT_ENV}' = '1' }`,
        "  if ($PSVersionTable.PSVersion.Major -ge 6) {",
        "    Start-Process -FilePath $exePath -WorkingDirectory $workDir -Environment $relaunchEnv",
        "  } else {",
        `    $cmd = 'set ${HSP_FROM_CURRENT_ENV}=1&& start "" ' + [char]34 + $exePath + [char]34`,
        "    Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $cmd -WorkingDirectory $workDir -WindowStyle Hidden",
        "  }",
        '  Write-ApplyLog "Start-Process returned (GUI may take a moment)"',
        "  # Flat-root refresh is best-effort and MUST NOT block relaunch. Never Remove-Item",
        "  # the Program Files tree (can hang forever on locked files).",
        "  if ($plan.cleanupLegacyFlat -and $plan.appRoot) {",
        '    Write-ApplyLog "scheduling async legacy flat robocopy (no Remove-Item)"',
        "    $flatSrc = $src",
        "    $flatDst = [string]$plan.appRoot",
        "    $flatLog = $LogFile",
        "    Start-Process -FilePath $robocopyExe -ArgumentList @(",
        "      $flatSrc, $flatDst, '/E', '/MT:8', '/J', '/R:0', '/W:0', '/XD', 'versions', 'current', '/NFL', '/NDL', '/NJH', '/NJS'",
        "    ) -WindowStyle Hidden",
        "    try {",
        "      $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
        '      Add-Content -LiteralPath $flatLog -Encoding UTF8 -Value ("[$ts] scheduled async legacy flat robocopy")',
        "    } catch {}",
        "  }",
        "  if ($plan.stagingVersionDirToRemove -and [System.IO.Directory]::Exists([string]$plan.stagingVersionDirToRemove)) {",
        "    $sdRm = $plan.stagingVersionDirToRemove",
        "    $rdArg = 'rd /s /q \"' + $sdRm.Replace('\"', '\"\"') + '\"'",
        "    Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $rdArg -WindowStyle Hidden",
        '    Write-ApplyLog "scheduled async staging dir cleanup (after relaunch)"',
        "  }",
        "  try { Remove-Item -LiteralPath $PlanPath -Force } catch {}",
        '  Write-ApplyLog "apply done"',
        "} catch {",
        '  $err = "FATAL: " + $_.Exception.Message',
        "  if ($LogFile) { try { Write-ApplyLog $err } catch {} }",
        "  elseif ($plan -and $plan.logPath) { try { Add-Content -LiteralPath $plan.logPath -Value (\"[\" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + \"] \" + $err) -Encoding UTF8 } catch {} }",
        "  try { Remove-Item -LiteralPath $PlanPath -Force } catch {}",
        "  exit 1",
        "}",
        "",
      ].join("\r\n");
      // UTF-8 BOM so Windows PowerShell 5.1 parses multi-byte literals reliably in .ps1 files.
      fs.writeFileSync(ps1Path, `\uFEFF${ps1Body}`, "utf8");
      logUpdater(
        "apply",
        `wrote ps1 ${ps1Path} (Wait-Process; Stop-Process by name; robocopy mirror + Copy-Item fallback)`,
      );

      try {
        fs.appendFileSync(
          applyLogPath,
          `[${new Date().toISOString()}] [main] spawning apply via spawnSync Start-Process inner -File ps1=${ps1Path} plan=${planPath} log=${applyLogPath} trace=%TEMP%\\hsp-apply-trace.log\n`,
          "utf8",
        );
      } catch (_) {}

      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const psExe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // Async spawn (cmd or PowerShell) can lose the race: app.quit() runs before the apply script starts.
      // Run a one-shot outer PowerShell that Start-Process'es the real script synchronously (spawnSync) so
      // the inner process exists before we return and quit. Pass -PlanPath/-LogPath on argv (no env required).
      const psSq = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const argList = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Path,
        "-PlanPath",
        planPath,
        "-LogPath",
        applyLogPath,
      ]
        .map(psSq)
        .join(",");
      const startCmd = `Start-Process -WindowStyle Hidden -FilePath ${psSq(psExe)} -ArgumentList ${argList}`;

      let syncResult;
      try {
        syncResult = spawnSync(
          psExe,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", startCmd],
          {
            env: {
              ...process.env,
              HSP_UPDATE_PLAN: planPath,
              HSP_UPDATE_LOG: applyLogPath,
            },
            windowsHide: true,
            timeout: 20000,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (e) {
        const msg = e?.message || String(e);
        logUpdater("apply", `spawnSync launcher threw: ${msg}`);
        try {
          fs.appendFileSync(applyLogPath, `[${new Date().toISOString()}] [main] spawnSync launcher threw: ${msg}\n`, "utf8");
        } catch (_) {}
        throw e;
      }

      if (syncResult.error) {
        const msg = syncResult.error.message || String(syncResult.error);
        logUpdater("apply", `spawnSync launcher error: ${msg}`);
        try {
          fs.appendFileSync(applyLogPath, `[${new Date().toISOString()}] [main] spawnSync launcher error: ${msg}\n`, "utf8");
        } catch (_) {}
      }
      const combinedOut = `${syncResult.stderr || ""}${syncResult.stdout || ""}`.trim();
      const exitCode = syncResult.status;
      if (exitCode !== 0) {
        logUpdater(
          "apply",
          `spawnSync Start-Process launcher exit=${exitCode} output=${combinedOut.slice(0, 2000)}`,
        );
        try {
          fs.appendFileSync(
            applyLogPath,
            `[${new Date().toISOString()}] [main] spawnSync launcher exit=${exitCode} ${combinedOut.slice(0, 1500)}\n`,
            "utf8",
          );
        } catch (_) {}
      } else {
        logUpdater("apply", "spawnSync Start-Process launcher ok (inner apply.ps1 should be running)");
      }
      if (syncResult.error || exitCode !== 0) {
        throw new Error(
          `apply launcher failed (exit=${exitCode}): ${syncResult.error?.message || combinedOut.slice(0, 600) || "unknown"}`,
        );
      }
    };

    /** True when versions/ staging is ready; preferred over NSIS even if installer also downloaded. */
    const canApplyVersionsStaging = () => {
      if (!useWinVersionsSidecar || !zipStagingContentPath || !zipReadyVersion) return false;
      if (compareSemverLike(zipReadyVersion, currentVersion) <= 0) return false;
      return stagingHasMainExe(zipStagingContentPath);
    };

    const requestInstallNow = () => {
      try {
        fs.appendFileSync(
          applyUserLogPath,
          `[${new Date().toISOString()}] [main] requestInstallNow (Update with reload clicked)\n`,
          "utf8",
        );
      } catch (_) {}

      installRequested = true;
      log("[updater] user accepted update install");
      logUpdater("ipc", "requestInstallNow (Update with reload)");

      suppressQuitForUpdateInstall = true;

      const useVersionsApply = canApplyVersionsStaging();
      const semverNewer =
        zipReadyVersion && compareSemverLike(zipReadyVersion, currentVersion) > 0;
      const exeOk =
        Boolean(zipStagingContentPath) &&
        stagingHasMainExe(zipStagingContentPath);
      logUpdaterStateSnapshot("install/requested", {
        useVersionsApply,
        semverNewer: Boolean(semverNewer),
        exeOk: Boolean(exeOk),
      });
      logUpdater(
        "ipc",
        `requestInstallNow useVersionsApply=${useVersionsApply} zipReady=${zipReadyVersion} path=${zipStagingContentPath}`,
      );

      if (useVersionsApply) {
        closeUpdateDialog();
        try {
          applyVersionsStagedUpdate();
        } catch (e) {
          log(`[updater] applyVersionsStagedUpdate failed: ${e?.message || e}`);
          suppressQuitForUpdateInstall = false;
          const mw = focusMainWindowForDialog();
          const errOpts = {
            type: "error",
            title: brand.productDisplayName,
            message: `Could not apply update: ${e?.message || String(e)}`,
            buttons: ["OK"],
          };
          void (mw ? dialog.showMessageBox(mw, errOpts) : dialog.showMessageBox(errOpts));
          return;
        }
        for (const win of BrowserWindow.getAllWindows()) {
          try {
            win.removeAllListeners("close");
            win.destroy();
          } catch (_) {}
        }
        logUpdater("ipc", "requestInstallNow app.quit after staging apply spawn");
        app.quit();
        return;
      }

      // Windows packaged: only the staged-zip path — never launch the NSIS wizard from this button.
      if (useWinVersionsSidecar) {
        suppressQuitForUpdateInstall = false;
        logUpdater("ipc", "requestInstallNow blocked: no staged zip build ready");
        log(
          `[updater] Update click ignored: no staged build (ready=${zipReadyVersion} path=${zipStagingContentPath})`,
        );
        try {
          fs.appendFileSync(
            applyUserLogPath,
            `[${new Date().toISOString()}] [main] blocked: cannot apply zip staging ` +
              `(readyVer=${zipReadyVersion} stagingPath=${zipStagingContentPath} ` +
              `semverNewer=${Boolean(semverNewer)} exeOk=${Boolean(exeOk)} current=${currentVersion})\n`,
            "utf8",
          );
        } catch (_) {}
        const boxOpts = {
          type: "info",
          title: brand.productDisplayName,
          message:
            `The quick update is not ready yet. Keep the app open until download and unpack finish, or ensure the latest GitHub release includes zip-latest.yml and ${WIN_PORTABLE_ZIP_PREFIX}<version>.zip from your Windows build (cleanup folder).`,
          buttons: ["OK"],
        };
        try {
          if (updateDialogState.window && !updateDialogState.window.isDestroyed()) {
            updateDialogState.window.hide();
          }
        } catch (_) {}
        const mw = focusMainWindowForDialog();
        void (mw ? dialog.showMessageBox(mw, boxOpts) : dialog.showMessageBox(boxOpts));
        return;
      }

      closeUpdateDialog();

      try {
        if (process.platform === "win32" && Notification.isSupported()) {
          const n = new Notification({
            title: brand.productDisplayName,
            body: "Installing update… The app will restart when finished.",
          });
          n.show();
        }
      } catch (_) {}

      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.removeAllListeners("close");
          win.destroy();
        } catch (_) {}
      }

      try {
        log("[updater] invoking quitAndInstall(isSilent=false, isForceRunAfter=true)");
        autoUpdater.quitAndInstall(false, true);
      } catch (e) {
        log(`quitAndInstall failed: ${e?.message || e}`);
        suppressQuitForUpdateInstall = false;
        app.quit();
      }
    };

    autoUpdater.on("update-downloaded", () => {
      log("[updater] update-downloaded");
      logUpdater("event", "update-downloaded (NSIS installer file ready on disk)");
      manualDownloadInProgress = false;
      // Windows uses zip sidecar only; ignore NSIS installer download for in-app UX.
      if (useWinVersionsSidecar) {
        log("[updater] update-downloaded: ignored on Windows (NSIS not used for Update button)");
        logUpdater("event", "update-downloaded ignored (Windows uses zip sidecar only)");
        return;
      }
      openOrFocusUpdateDialog();
      updateDialogUi({
        text: 'Update is ready. Click "Update with reload".',
        percent: 100,
        showProgress: true,
        showActions: true,
        installEnabled: true,
      });
    });

    autoUpdater.on("checking-for-update", () => {
      log("[updater] checking-for-update");
      logUpdater("event", `checking-for-update manual=${manualCheckInProgress}`);
      if (manualCheckInProgress) {
        log("[updater] manual check started");
      }
    });

    autoUpdater.on("update-available", (info) => {
      log(`[updater] update-available version=${info?.version || "unknown"}`);
      logUpdater("event", `update-available ${safeJson({ version: info?.version, path: info?.path })}`);
      logUpdaterStateSnapshot("event/update-available", { remoteVersion: info?.version || null });
      const wasManual = manualCheckInProgress;
      if (manualCheckInProgress) {
        manualCheckInProgress = false;
        manualDownloadInProgress = true;
        openOrFocusUpdateDialog();
        updateDialogUi({
          text: useWinVersionsSidecar
            ? `Downloading and preparing version ${info?.version || "new"}…`
            : `Downloading version ${info?.version || "new"}...`,
          percent: 0,
          showProgress: true,
          showActions: true,
          installEnabled: false,
        });
      }
      if (useWinVersionsSidecar) {
        void tryBeginVersionsPrepare(info, { uiManual: wasManual });
      }
    });

    autoUpdater.on("update-not-available", () => {
      log("[updater] update-not-available");
      logUpdater("event", `update-not-available current=${currentVersion}`);
      if (manualCheckInProgress) {
        manualCheckInProgress = false;
        manualDownloadInProgress = false;
        openOrFocusUpdateDialog();
        updateDialogUi({
          text: "You are already on the latest version.",
          percent: 0,
          showProgress: false,
          showActions: true,
          installEnabled: false,
        });
      }
    });
    let downloadProgressLoggedSample = false;
    autoUpdater.on("download-progress", (progress) => {
      if (useWinVersionsSidecar) return;
      if (!updateDialogState.window || updateDialogState.window.isDestroyed()) return;
      if (!downloadProgressLoggedSample) {
        downloadProgressLoggedSample = true;
        try {
          log(`[updater] download-progress sample: ${JSON.stringify(progress)}`);
        } catch (_) {}
      }
      const pct = progressPercent(progress);
      updateDialogUi({
        text: `Downloading update... ${Math.round(pct)}%`,
        percent: pct,
        showProgress: true,
        showActions: true,
        installEnabled: false,
      });
    });

    autoUpdater.on("error", (err) => {
      log(`[updater] error: ${err?.message || String(err)}`);
      if (updaterCheckRetrying && isTransientGithubUpdateError(err)) {
        logUpdater("event", `error suppressed (retry) ${err?.message || err}`);
        return;
      }
      logUpdater("event", `error manualCheck=${manualCheckInProgress} download=${manualDownloadInProgress} ${err?.message || err}`);
      logUpdaterStateSnapshot("event/error", { error: err?.message || String(err) });
      if (manualCheckInProgress || manualDownloadInProgress) {
        manualCheckInProgress = false;
        manualDownloadInProgress = false;
        openOrFocusUpdateDialog();
        updateDialogUi({
          text: `Update check failed: ${err?.message || String(err)}`,
          percent: 0,
          showProgress: false,
          showActions: false,
          installEnabled: false,
        });
      }
    });

    updaterMenuApi.checkNow = async () => {
      try {
        log("[updater] manual check requested from menu");
        logUpdater("ipc", "checkNow from menu");
        logUpdaterStateSnapshot("checkNow/start");
        downloadProgressLoggedSample = false;
        if (
          useWinVersionsSidecar &&
          zipReadyVersion &&
          zipStagingContentPath &&
          stagingHasMainExe(zipStagingContentPath)
        ) {
          logUpdater("ipc", `checkNow short-circuit already staged ${zipReadyVersion}`);
          openOrFocusUpdateDialog();
          syncZipReadyUi(zipReadyVersion);
          return;
        }
        manualCheckInProgress = true;
        manualDownloadInProgress = false;
        openOrFocusUpdateDialog();
        updateDialogUi({
          text: "Checking for updates...",
          percent: 0,
          showProgress: false,
          showActions: false,
          installEnabled: false,
        });
        updaterCheckRetrying = true;
        try {
          await checkForUpdatesWithRetry();
          logUpdaterStateSnapshot("checkNow/checkForUpdates resolved");
        } finally {
          updaterCheckRetrying = false;
        }
      } catch (e) {
        manualCheckInProgress = false;
        manualDownloadInProgress = false;
        openOrFocusUpdateDialog();
        updateDialogUi({
          text: `Update check failed: ${e?.message || String(e)}`,
          percent: 0,
          showProgress: false,
          showActions: false,
          installEnabled: false,
        });
      }
    };

    app.on("before-quit", () => {
      if (installRequested) {
        log("[updater] before-quit for update install");
      }
    });
    autoUpdater.on("before-quit-for-update", () => {
      log("[updater] before-quit-for-update emitted");
    });

    let lastCheckAt = 0;
    const markAndCheck = () => {
      lastCheckAt = Date.now();
      log("[updater] scheduled checkForUpdates()");
      logUpdater("schedule", "periodic/startup checkForUpdates");
      void (async () => {
        updaterCheckRetrying = true;
        try {
          await checkForUpdatesWithRetry();
        } catch (e) {
          log(`[updater] checkForUpdates failed after retries: ${e?.message || e}`);
          logUpdater("schedule", `check failed after retries: ${e?.message || e}`);
        } finally {
          updaterCheckRetrying = false;
        }
      })();
    };

    // 1) On startup (each app launch)
    markAndCheck();

    // 2) While running: every 1 minute (temporary aggressive polling)
    const periodicMs = 1 * 60 * 1000;
    setInterval(markAndCheck, periodicMs);

    // 3) When user brings the app back to foreground (throttled: at most once per 30 min)
    const minFocusGapMs = 30 * 60 * 1000;
    app.on("browser-window-focus", () => {
      if (Date.now() - lastCheckAt < minFocusGapMs) return;
      log("[updater] check (window focus)");
      logUpdater("schedule", "window focus → checkForUpdates");
      markAndCheck();
    });

    scheduleVersionsFolderCleanup();
  } catch (e) {
    log(`autoUpdater failed: ${e?.message || e}`);
  }
}

function setupAppMenu() {
  const template = [
    {
      label: "File",
      submenu: [{ role: "quit", label: "Exit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Zoom",
          click: () => {
            if (zoomMenuApi) zoomMenuApi.showRowPopup(null, { extension: true });
          },
        },
      ],
    },
    {
      label: "Updates",
      submenu: [
        {
          label: "Check for updates now",
          click: () => {
            if (typeof updaterMenuApi.checkNow === "function") {
              void updaterMenuApi.checkNow();
            } else {
              void dialog.showMessageBox({
                type: "info",
                title: "Updates unavailable",
                message: "Updater is not available in development mode.",
              });
            }
          },
        },
        { type: "separator" },
        {
          label: "Open update data folder…",
          click: () => {
            const dir = app.getPath("userData");
            void shell.openPath(dir).then((err) => {
              if (err) {
                void dialog.showMessageBox({
                  type: "error",
                  title: "Could not open folder",
                  message: err,
                });
              }
            });
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, supportFetchAPI: true } },
]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    const logPath = path.join(app.getPath("userData"), "main.log");
    // Cap runaway logs (EPIPE/uncaughtException loops previously grew this to multi-GB).
    try {
      const st = fs.statSync(logPath);
      if (st.size > 32 * 1024 * 1024) {
        fs.writeFileSync(
          logPath,
          `${line}\n[log truncated — previous file was ${(st.size / (1024 * 1024)).toFixed(0)}MB]\n`,
        );
        return;
      }
    } catch (_) {}
    fs.appendFileSync(logPath, line + "\n");
  } catch (_) {}
  // Packaged Windows: never touch console.error — a broken stdout/stderr pipe
  // used to throw EPIPE → uncaughtException → log → console.error → death spiral
  // (prod: app quit while joining a voice call before the mix was audible).
  if (app.isPackaged && process.platform === "win32") return;
  try {
    console.error(line);
  } catch (_) {}
}

registerOAuthIpc({
  ipcMain,
  getMainWindow: () => mainWindowRef,
  log,
});

registerSwapCoffeeFetchIpc({ ipcMain, net, log });

const zoomMenuApi = registerZoomMenu({
  getMainWindow: () => mainWindowRef,
  log,
});

/** Windows: resolve before the first show(); omit `icon` if empty so the shell can fall back to the exe. */
async function resolveBrowserWindowIcon() {
  const fromFile = nativeImageFromAppIcon();
  if (fromFile && !fromFile.isEmpty()) return fromFile;
  if (process.platform !== "win32" || !app.isPackaged) return fromFile;

  const thumbSize = { width: 256, height: 256 };
  const inAsarOnly = (p) => p.includes("app.asar") && !p.includes("app.asar.unpacked");

  // Shell-backed extraction: often works for the packaged .exe (embedded rcedit icon) when ICO buffer decode fails.
  try {
    if (fs.existsSync(process.execPath)) {
      const img = await nativeImage.createThumbnailFromPath(process.execPath, thumbSize);
      if (img && !img.isEmpty()) return img;
    }
  } catch (e) {
    try {
      log(`createThumbnailFromPath(exe): ${e?.message || e}`);
    } catch (_) {}
  }

  for (const p of collectAppIconIcoCandidates()) {
    if (!p || !fs.existsSync(p) || inAsarOnly(p)) continue;
    try {
      const img = await nativeImage.createThumbnailFromPath(p, thumbSize);
      if (img && !img.isEmpty()) return img;
    } catch (e) {
      try {
        log(`createThumbnailFromPath(${p}): ${e?.message || e}`);
      } catch (_) {}
    }
  }

  const shellPaths = [process.execPath, ...collectAppIconIcoCandidates()].filter((p) => {
    if (!p || !fs.existsSync(p)) return false;
    return !inAsarOnly(p);
  });
  for (const p of shellPaths) {
    for (const size of ["large", "normal", "small"]) {
      try {
        const img = await app.getFileIcon(p, { size });
        if (!img.isEmpty()) return img;
      } catch (e) {
        try {
          log(`getFileIcon(${p}, ${size}): ${e?.message || e}`);
        } catch (_) {}
      }
    }
  }
  return fromFile;
}

const WINDOWS_USERDATA_ICON = "window-icon.ico";

/**
 * Absolute path to a real .ico on disk for Windows shell APIs. Prefer loose/unpacked files; if the only
 * copy is inside app.asar, copy bytes with readFileSync/writeFileSync (copyFileSync can fail for asar).
 */
function ensureWindowsIcoFileOnDiskSync() {
  if (process.platform !== "win32" || !app.isPackaged) return null;
  const inAsarOnly = (p) => p.includes("app.asar") && !p.includes("app.asar.unpacked");
  const dest = path.join(app.getPath("userData"), WINDOWS_USERDATA_ICON);
  for (const p of collectAppIconIcoCandidates()) {
    if (!p || !fs.existsSync(p) || !/\.ico$/i.test(p)) continue;
    if (!inAsarOnly(p)) return path.resolve(p);
  }
  for (const p of collectAppIconIcoCandidates()) {
    if (!p || !fs.existsSync(p) || !/\.ico$/i.test(p)) continue;
    try {
      const buf = fs.readFileSync(p);
      if (buf.length < 32) continue;
      fs.writeFileSync(dest, buf);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return path.resolve(dest);
    } catch (e) {
      try {
        log(`ensureWindowsIcoFileOnDiskSync: ${e?.message || e}`);
      } catch (_) {}
    }
  }
  return null;
}

/**
 * Set `HSP_DEBUG_ICON=1` before starting the app to append full `[icon:debug]` lines to userData/main.log
 * (candidate paths, setAppDetails). Deploy builds always log `[icon] probe(always): ...` without this flag.
 */
function iconDebugEnabled() {
  const v = process.env.HSP_DEBUG_ICON;
  return v === "1" || v === "true" || v === "yes";
}

function logIconDebug(line) {
  if (!iconDebugEnabled()) return;
  log(`[icon:debug] ${line}`);
}

function icoPathStatLine(p) {
  if (!p) return "(null)";
  try {
    if (!fs.existsSync(p)) return `${p} (missing)`;
    return `${p} (size=${fs.statSync(p).size})`;
  } catch (e) {
    return `${p} (stat err: ${e?.message || e})`;
  }
}

function describeWindowIconForLog(w) {
  if (w == null) return "none";
  if (typeof w === "string") return `path:${w}`;
  try {
    return `NativeImage isEmpty=${w.isEmpty ? w.isEmpty() : "?"}`;
  } catch (_) {
    return "NativeImage";
  }
}

/** Always logged on packaged Windows: Chromium decode of chosen .ico and of the .exe (deploy diagnostics). */
function logWindowsIconProbeAlways(windowIcon) {
  if (process.platform !== "win32" || !app.isPackaged) return;
  if (typeof windowIcon === "string") {
    try {
      if (!fs.existsSync(windowIcon)) {
        log(`[icon] probe(always): chosen path missing: ${windowIcon}`);
      } else {
        const buf = fs.readFileSync(windowIcon);
        const niPath = nativeImage.createFromPath(windowIcon);
        const niBuf = nativeImage.createFromBuffer(buf);
        log(
          `[icon] probe(always): ico createFromPath isEmpty=${niPath.isEmpty()} createFromBuffer isEmpty=${niBuf.isEmpty()} bytes=${buf.length}`,
        );
      }
    } catch (e) {
      log(`[icon] probe(always): ico ${e?.message || e}`);
    }
  } else {
    log(`[icon] probe(always): chosen=${describeWindowIconForLog(windowIcon)}`);
  }
  try {
    if (fs.existsSync(process.execPath)) {
      const niExe = nativeImage.createFromPath(process.execPath);
      log(`[icon] probe(always): execPath createFromPath isEmpty=${niExe.isEmpty()}`);
    }
  } catch (e) {
    log(`[icon] probe(always): execPath ${e?.message || e}`);
  }
}

/**
 * Path for setAppDetails (taskbar / Jump List): prefer the .exe when Chromium can decode an embedded
 * icon — Windows shell uses the exe for the taskbar more reliably than a loose .ico in that case.
 * Otherwise use resources\\icon.ico (see embed-windows-exe-icon.cjs + afterSign).
 */
function resolveWindowsTaskbarDetailsIconPath() {
  if (process.platform !== "win32" || !app.isPackaged) return null;
  const exe = process.execPath;
  const ico = ensureWindowsIcoFileOnDiskSync();
  try {
    if (fs.existsSync(exe)) {
      const niFromExe = nativeImage.createFromPath(exe);
      if (!niFromExe.isEmpty()) return exe;
    }
  } catch (_) {}
  if (ico && fs.existsSync(ico)) return ico;
  return fs.existsSync(exe) ? exe : ico;
}

/** Logs once per main window: summary + probe(always); full dump when HSP_DEBUG_ICON=1. */
function logWindowsIconEnvironment(windowIcon) {
  if (process.platform !== "win32" || !app.isPackaged) return;
  log(`[icon] win32 packaged: ${describeWindowIconForLog(windowIcon)} resourcesPath=${process.resourcesPath}`);
  logWindowsIconProbeAlways(windowIcon);
  if (!iconDebugEnabled()) return;
  logIconDebug(`__dirname=${__dirname}`);
  logIconDebug(`app.getAppPath=${app.getAppPath()}`);
  logIconDebug(`execPath=${process.execPath}`);
  const raw = [
    process.resourcesPath && path.join(process.resourcesPath, "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "app.asar.unpacked", "assets", "icon.ico"),
    process.resourcesPath && path.join(process.resourcesPath, "assets", "icon.ico"),
    app.getAppPath && path.join(app.getAppPath(), "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.ico"),
  ].filter(Boolean);
  for (const p of raw) {
    logIconDebug(`candidate ${icoPathStatLine(p)}`);
  }
  logIconDebug(`existing only: ${collectAppIconIcoCandidates().join(" | ") || "(none)"}`);
  const disk = ensureWindowsIcoFileOnDiskSync();
  logIconDebug(`ensureWindowsIcoFileOnDiskSync => ${disk || "null"}`);
}

/** NativeImage for the main window: prefer createFromPath on real disk .ico; buffer decode as fallback. */
function windowsPackagedWindowNativeIcon() {
  const p = ensureWindowsIcoFileOnDiskSync();
  if (!p) return null;
  try {
    let img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
    img = nativeImage.createFromBuffer(fs.readFileSync(p));
    return img.isEmpty() ? null : img;
  } catch (e) {
    try {
      log(`windowsPackagedWindowNativeIcon: ${e?.message || e}`);
    } catch (_) {}
    return null;
  }
}

async function createWindow() {
  const appPath = app.getAppPath();
  const distPath = path.join(appPath, "dist");
  const indexHtml = path.join(distPath, "index.html");

  if (!isDev && !fs.existsSync(indexHtml)) {
    log(`ERROR: index.html not found at ${indexHtml}`);
    log(`appPath=${appPath}`);
    return;
  }
  if (!isDev && fs.existsSync(indexHtml)) {
    try {
      const st = fs.statSync(indexHtml);
      log(
        `[ui-bundle] index.html bytes=${st.size} mtimeUtc=${st.mtime.toISOString()} appVersion=${app.getVersion()}`,
      );
    } catch (_) {}
  }

  /** `string` = absolute .ico path (preferred on Windows packaged builds; Chromium loads reliably). Else NativeImage. */
  let windowIcon;
  if (process.platform === "win32" && app.isPackaged) {
    const icoPath = ensureWindowsIcoFileOnDiskSync();
    if (icoPath) {
      windowIcon = icoPath;
    } else {
      const native = windowsPackagedWindowNativeIcon();
      if (native && !native.isEmpty()) {
        windowIcon = native;
      } else {
        const img = await resolveBrowserWindowIcon();
        windowIcon = img && !img.isEmpty() ? img : undefined;
      }
    }
  } else {
    const img = await resolveBrowserWindowIcon();
    windowIcon = img && !img.isEmpty() ? img : undefined;
  }

  if (process.platform === "win32" && app.isPackaged && !windowIcon) {
    try {
      log(
        `warn: window icon unresolved; resourcesPath=${process.resourcesPath} ico=${collectAppIconIcoCandidates().join(" | ")} exe=${process.execPath}`,
      );
    } catch (_) {}
  }

  try {
    logWindowsIconEnvironment(windowIcon);
  } catch (e) {
    log(`[icon] logWindowsIconEnvironment failed: ${e?.message || e}`);
  }

  const applyWindowIcon = () => {
    if (!windowIcon || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setIcon(windowIcon);
      logIconDebug(`setIcon applied type=${typeof windowIcon}`);
    } catch (e) {
      log(`[icon] setIcon failed: ${e?.message || e}`);
    }
  };

  // NSIS close-app uses PRODUCT_NAME (package.json → build.productName). The window title must
  // match that string, not a URL — otherwise the installer cannot find/close the running app.
  // Keep in sync with package.json "build.productName".
  const windowTitle = isDev ? "http://www.hyperlinks.space/" : brand.productDisplayName;

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: windowTitle,
    ...(windowIcon ? { icon: windowIcon } : {}),
    // Match app dark background (theme.ts); reduces flash and helps menu/client seam blend on Windows.
    backgroundColor: "#111111",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      ...(fs.existsSync(preloadPath) ? { preload: preloadPath } : {}),
    },
    show: false,
  });
  mainWindowRef = mainWindow;
  if (!isDev) {
    installSwapCoffeeRendererFetchShim(mainWindow.webContents, log);
  }
  zoomMenuApi.attachMainWindowZoomHooks(mainWindow);
  ensureBrowserWindowAllowsOsCapture(mainWindow, log);

  try {
    mainWindow.webContents.setIgnoreMenuShortcuts(false);
  } catch (_) {}

  mainWindow.once("ready-to-show", () => {
    // Win32: ties this HWND to AppUserModelID + icon for the taskbar button (see Electron BrowserWindow.setAppDetails).
    if (process.platform === "win32" && fs.existsSync(process.execPath)) {
      try {
        const detailsIcon = resolveWindowsTaskbarDetailsIconPath();
        if (detailsIcon && fs.existsSync(detailsIcon)) {
          mainWindow.setAppDetails({
            appId: WIN_APP_USER_MODEL_ID,
            appIconPath: detailsIcon,
            appIconIndex: 0,
          });
          logIconDebug(`setAppDetails ok appIconPath=${detailsIcon}`);
        } else {
          logIconDebug(`setAppDetails skipped (missing path) detailsIcon=${detailsIcon || "null"}`);
        }
      } catch (e) {
        try {
          log(`setAppDetails: ${e?.message || e}`);
        } catch (_) {}
      }
    }
    applyWindowIcon();
    try {
      mainWindow.maximize();
      mainWindow.show();
    } catch (_) {}
  });

  mainWindow.webContents.once("did-finish-load", applyWindowIcon);

  mainWindow.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow.setTitle(windowTitle);
  });

  const openHttpUrlExternally = (targetUrl) => {
    try {
      if (typeof targetUrl === "string" && /^https?:/i.test(targetUrl)) {
        void shell.openExternal(targetUrl);
        return true;
      }
    } catch (e) {
      log(`openExternal: ${e?.message || e}`);
    }
    return false;
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openHttpUrlExternally(url)) return { action: "deny" };
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      const current = mainWindow.webContents.getURL();
      const leavingAppShell =
        typeof current === "string" &&
        (current.startsWith("app:") || current.startsWith("file:") || current.startsWith("http://localhost:8081"));
      if (leavingAppShell && /^https?:/i.test(targetUrl) && targetUrl !== current) {
        event.preventDefault();
        openHttpUrlExternally(targetUrl);
      }
    } catch (e) {
      log(`will-navigate: ${e?.message || e}`);
    }
  });

  mainWindow.webContents.on("did-fail-load", (event, code, errMsg, url, isMainFrame) => {
    log(`did-fail-load: code=${code} ${errMsg} ${url} mainFrame=${isMainFrame}`);
    if (isDev || !isMainFrame || mainWindow.isDestroyed()) return;
    if (typeof mainWindow.__hspLoadFailRetries !== "number") mainWindow.__hspLoadFailRetries = 0;
    if (mainWindow.__hspLoadFailRetries >= 2) return;
    mainWindow.__hspLoadFailRetries += 1;
    try {
      event?.preventDefault?.();
    } catch (_) {}
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return;
      try {
        log(`[ui] did-fail-load retry ${mainWindow.__hspLoadFailRetries} → app://./`);
        mainWindow.loadURL("app://./");
      } catch (e) {
        log(`[ui] did-fail-load retry failed: ${e?.message || e}`);
      }
    }, 400);
  });

  // Mirror selected renderer console lines into userData/main.log (swap/jettons, page-display, errors).
  // Electron 41+: prefer event fields; positional level/message remain for compatibility.
  mainWindow.webContents.on("console-message", (event, level, message) => {
    try {
      const text =
        typeof message === "string"
          ? message
          : typeof event?.message === "string"
            ? event.message
            : String(message ?? event?.message ?? "");
      if (!text) return;
      const lvl = typeof level === "number" ? level : Number(event?.level ?? 0);
      const interesting =
        text.includes("[page-display]") ||
        text.includes("swap_jettons") ||
        text.includes("swap_chart") ||
        text.includes("swap_account_jettons") ||
        lvl >= 2;
      if (!interesting) return;
      const levelName = lvl >= 3 ? "error" : lvl === 2 ? "warn" : "log";
      log(`[renderer:${levelName}] ${text.slice(0, 2000)}`);
    } catch (_) {}
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const reason = details?.reason ?? "unknown";
    const exitCode = details?.exitCode ?? "?";
    log(`[ui] render-process-gone reason=${reason} exitCode=${exitCode}`);
    if (mainWindow.isDestroyed()) return;
    if (typeof mainWindow.__hspRendererRecoveryCount !== "number") {
      mainWindow.__hspRendererRecoveryCount = 0;
    }
    if (mainWindow.__hspRendererRecoveryCount >= 2) {
      const errOpts = {
        type: "error",
        title: brand.productDisplayName,
        message:
          "The window stopped responding and could not recover. Please close and reopen the app.",
        buttons: ["OK"],
      };
      void (mainWindow.isDestroyed()
        ? dialog.showMessageBox(errOpts)
        : dialog.showMessageBox(mainWindow, errOpts));
      return;
    }
    mainWindow.__hspRendererRecoveryCount += 1;
    try {
      log(`[ui] render-process-gone reload attempt ${mainWindow.__hspRendererRecoveryCount}`);
      mainWindow.loadURL(isDev ? "http://localhost:8081" : "app://./");
    } catch (e) {
      log(`[ui] render-process-gone reload failed: ${e?.message || e}`);
    }
  });

  mainWindow.webContents.on("unresponsive", () => {
    log("[ui] webContents unresponsive");
  });

  mainWindow.webContents.on("responsive", () => {
    log("[ui] webContents responsive");
  });

  // Expo static export may navigate to index.html; serve SPA root once (avoid reload loops).
  let indexHtmlRedirected = false;
  mainWindow.webContents.on("did-start-loading", (_, url) => {
    if (isDev || indexHtmlRedirected || !url) return;
    if (!/\/index\.html(?:$|[?#])/i.test(url)) return;
    const root = url.replace(/\/index\.html(?:[?#].*)?$/i, "/");
    if (root === url) return;
    indexHtmlRedirected = true;
    try {
      mainWindow.loadURL(root);
    } catch (e) {
      log(`[ui] index.html redirect failed: ${e?.message || e}`);
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:8081");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL("app://./");
  }

  mainWindow.on("closed", () => {
    zoomMenuApi.destroyRowPopup();
    mainWindowRef = null;
    if (suppressQuitForUpdateInstall) return;
    app.quit();
  });
}

process.on("uncaughtException", (err) => {
  try {
    // console.error → EPIPE when stdout/stderr is closed; logging that again loops forever and fills the disk.
    if (err && (err.code === "EPIPE" || /EPIPE/i.test(String(err.message || "")))) return;
    log(`uncaughtException: ${err.message}\n${err.stack}`);
  } catch (_) {}
});

process.on("unhandledRejection", (reason) => {
  try {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
    if (/EPIPE/i.test(msg)) return;
    log(`unhandledRejection: ${msg}`);
  } catch (_) {}
});

registerOsScreenshotPassthrough(app, { BrowserWindow, clipboard }, log);

/**
 * tokens.swap.coffee returns Access-Control-Allow-Origin: *. Chromium rejects that
 * when fetch credentials mode is include (desktop auth fetch used to force include on
 * any URL containing "/api/"). Reflect app://. so credentialed requests still work,
 * and preflights succeed from the Electron shell.
 */
function installSwapCoffeeCorsReflect() {
  try {
    const filter = {
      urls: ["https://tokens.swap.coffee/*", "https://backend.swap.coffee/*"],
    };
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      try {
        const headers = { ...(details.requestHeaders || {}) };
        const drop = ["Cookie", "Authorization"];
        for (const name of drop) {
          const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
          if (key) delete headers[key];
        }
        callback({ requestHeaders: headers });
      } catch (_) {
        callback({ requestHeaders: details.requestHeaders });
      }
    });
    session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
      try {
        const headers = { ...(details.responseHeaders || {}) };
        const findKey = (name) =>
          Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
        const setHeader = (name, value) => {
          const prev = findKey(name);
          if (prev) delete headers[prev];
          headers[name] = Array.isArray(value) ? value : [value];
        };
        const acaoKey = findKey("Access-Control-Allow-Origin");
        const acaoRaw = acaoKey ? headers[acaoKey] : null;
        const acao = Array.isArray(acaoRaw) ? acaoRaw[0] : acaoRaw;
        if (!acao || acao === "*") {
          setHeader("Access-Control-Allow-Origin", "app://.");
          setHeader("Access-Control-Allow-Credentials", "true");
        }
        setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Api-Key, Authorization");
        setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        callback({ responseHeaders: headers });
      } catch (_) {
        callback({ responseHeaders: details.responseHeaders });
      }
    });
    log("[net] swap.coffee CORS reflect for app://. installed");
  } catch (e) {
    log(`[net] swap.coffee CORS reflect failed: ${e?.message || e}`);
  }
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    // Dark native chrome (title bar / menu area) so the OS-drawn separator under the menu reads closer to #111111.
    nativeTheme.themeSource = "dark";
  }
  installSwapCoffeeCorsReflect();
  // Voice chat screen share — Chromium getDisplayMedia needs an Electron handler.
  try {
    registerDisplayMediaHandler({
      session: session.defaultSession,
      getMainWindow: () => mainWindowRef,
      log,
    });
  } catch (e) {
    log(`display-media register: ${e?.message || e}`);
  }
  if (tryFinishIncompleteWindowsVersionedApply()) return;
  if (tryRelaunchFromCurrentJunction()) return;
  clearAppliedVersionMarkerIfMatched();
  setupAppMenu();
  await clearStaleClientCacheIfNeeded();
  if (!isDev) {
    const appPath = app.getAppPath();
    const distPath = path.join(appPath, "dist");
    protocol.handle("app", async (request) => {
      const method = (request.method || "GET").toUpperCase();
      let urlPath = request.url.slice("app://".length).replace(/^\.?\//, "") || "index.html";
      const q = urlPath.indexOf("?");
      if (q !== -1) urlPath = urlPath.slice(0, q);
      try {
        urlPath = decodeURIComponent(urlPath);
      } catch (_) {
        /* keep encoded segment if malformed */
      }
      const filePath = path.join(distPath, urlPath);
      const resolved = path.normalize(filePath);
      const distNorm = path.normalize(distPath);
      if (!resolved.startsWith(distNorm)) {
        return new Response("Not Found", { status: 404 });
      }
      let st;
      try {
        st = fs.statSync(resolved);
      } catch (_) {
        return new Response("Not Found", { status: 404 });
      }
      if (!st.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
      const headers = {
        "Content-Type": guessAppAssetMime(resolved),
        "Cache-Control": "no-store, max-age=0, must-revalidate",
      };
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      if (method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers });
      }
      try {
        const nodeStream = fs.createReadStream(resolved);
        return new Response(Readable.toWeb(nodeStream), { status: 200, headers });
      } catch (e) {
        try {
          log(`[app-protocol] stream open failed ${resolved}: ${e?.message || e}`);
        } catch (_) {}
        return new Response("Not Found", { status: 404 });
      }
    });
  }
  createWindow().catch((e) => {
    try {
      log(`createWindow: ${e?.message || e}`);
    } catch (_) {}
  });
  setupAutoUpdater();
});

app.on("window-all-closed", () => {
  if (suppressQuitForUpdateInstall) return;
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => {
      try {
        log(`createWindow (activate): ${e?.message || e}`);
      } catch (_) {}
    });
  }
});
