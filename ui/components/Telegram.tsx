import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { init, on, viewport } from "@tma.js/sdk-react";
import { on as onBridge } from "@tma.js/bridge";
import {
  ensureTelegramScript,
  getInitDataString,
  getInitialThemeParams,
  getPlatformFromHash,
  getThemeParamsFromLaunch,
  getWebAppVersionFromHash,
  attachFullscreenChangedListener,
  getIsExpanded,
  getIsFullscreen,
  getIsImmersiveFullscreenMerged,
  getTmaInitAndWebAppDebugSnapshot,
  parseViewportChangedFullscreenFlag,
  readTmaSdkViewportIsFullscreen,
  computeTelegramLayoutStartupSnapshot,
  getEmptyTelegramLayoutStartupSnapshot,
  isActuallyInTelegram,
  isAvailable,
  isTelegramWebAppPlatformReal,
  markMiniAppRegistrationStarted,
  readyAndExpand,
  resetTelegramLaunchCache,
  triggerHaptic as triggerHapticImpl,
} from "./telegramWebApp";
import type { TelegramLayoutStartupSnapshot } from "./telegramWebApp";
import { buildApiUrl } from "../../api/_base";
import { appError, appLog } from "../../shared/appLog";

let sdkInitialized = false;
function ensureSdkInitialized() {
  if (sdkInitialized) return;
  if (typeof window === "undefined") return;
  try {
    init();
    sdkInitialized = true;
  } catch {
    // ignore (e.g. outside Mini App when running locally)
  }
}

if (typeof window !== "undefined") {
  ensureSdkInitialized();
}

/** True if we're likely inside Telegram Mini App (avoid tma.js viewport calls when false). */
function isLikelyInTma(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!(window as unknown as { Telegram?: { WebApp?: unknown } }).Telegram?.WebApp;
  } catch {
    return false;
  }
}

/**
 * Hash / UA / launch params suggest Telegram opened this URL — does **not** treat
 * "WebApp script loaded" alone as Telegram (avoids Electron / plain browser false positives).
 */
function isTelegramLaunchHint(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (getThemeParamsFromLaunch() != null) return true;
  } catch {
    // ignore
  }
  try {
    const hash = window.location.hash ?? "";
    if (hash.includes("tgWebApp")) return true;
  } catch {
    // ignore
  }
  try {
    if (getPlatformFromHash() != null || getWebAppVersionFromHash() != null) return true;
  } catch {
    // ignore
  }
  try {
    const ua = (window.navigator?.userAgent ?? "").toLowerCase();
    if (ua.includes("telegram")) return true;
  } catch {
    // ignore
  }
  return false;
}

/** Sync signals only (hash / UA / WebApp presence). Do not use for API calls. */
function isTelegramLikelyAtStartup(): boolean {
  return isTelegramLaunchHint() || isAvailable();
}

/** Whether init data may still arrive (real client or Telegram launch URL). */
function shouldPollForInitData(): boolean {
  return isTelegramLaunchHint() || isTelegramWebAppPlatformReal();
}

function normalizeHexBg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^#([0-9a-fA-F]{6})$/.test(s)) return s;
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m3) {
    const x = m3[1];
    return `#${x[0]}${x[0]}${x[1]}${x[1]}${x[2]}${x[2]}`.toLowerCase();
  }
  return null;
}

/**
 * Only `bg_color` defines the main chat background in Telegram theme_params.
 * Do NOT fall back to secondary_bg_color / section_bg_color for light/dark app scheme:
 * those can be dark panels while the client is in light mode → false "dark" + flash.
 */
function getBgColorForScheme(tp: Record<string, string> | null | undefined): string | null {
  if (!tp) return null;
  return normalizeHexBg(tp.bg_color);
}

function classifyThemeFromBgColor(bgColor: string | undefined | null): "dark" | "light" {
  if (!bgColor || typeof bgColor !== "string") return "dark";
  const m = bgColor.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return "dark";
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const scheme = luminance < 128 ? "dark" : "light";
  appLog("[TMA theme]", "classify", { bgColor: bgColor.trim(), luminance, scheme });
  return scheme;
}

/**
 * Mini App when launch URL / UA says so, or we already have verified init data.
 * Do not treat `Telegram.WebApp` stub alone (Electron / desktop browser with script loaded) as TMA.
 */
function isMiniAppContext(): boolean {
  return isTelegramLaunchHint() || isActuallyInTelegram();
}

function initialColorSchemeFromBootstrap(): "dark" | "light" {
  // Real scheme comes from Telegram.WebApp in runTmaFlow — never from launch hash (hash bg_color
  // can disagree with WebApp and flash dark before "initial themeParams bg: #ffffff").
  return "dark";
}

function initialThemeBgReadyFromBootstrap(): boolean {
  // Must match server + client — always false here. Root layout uses `themeBgReady || !useTelegramTheme`
  // so plain browser (no TMA palette) is visible without a hydration mismatch.
  return false;
}

/** Merge debug patch and refresh `inTelegramClient` from live WebApp state. */
function patchTelegramDebug(
  prev: TelegramDebugInfo,
  patch: Partial<TelegramDebugInfo>,
): TelegramDebugInfo {
  return {
    ...prev,
    ...patch,
    inTelegramClient: isActuallyInTelegram(),
  };
}

type TelegramStatus = "idle" | "loading" | "ok" | "error" | "dev";

export type TelegramDebugInfo = {
  /** True after `window.Telegram.WebApp` exists (script loaded; may be true in Electron without Telegram). */
  hasWebAppApi: boolean;
  /** True when WebApp has a real Telegram user session (not a stub). */
  inTelegramClient: boolean;
  /** Poll ticks waiting for `Telegram.WebApp` (script injection). */
  webAppPollCount: number;
  initDataLength: number | null;
  /** Poll ticks waiting for init data string (every 100ms after WebApp attach). */
  initDataPollCount: number;
  apiStatus: number | null;
  apiMessage: string | null;
  /** URL we POST to (to verify origin/routing). */
  apiUrl: string | null;
  /** Ms from fetch start to response or timeout. */
  fetchDurationMs: number | null;
  /** Last client log line for investigation. */
  lastLog: string | null;
};

/** Public wallet row from /api/telegram and /api/wallet/register. */
export type TelegramWalletRow = {
  id: number;
  wallet_address: string;
  wallet_blockchain: string;
  wallet_net: string;
  type: string;
  label: string | null;
  is_default: boolean;
  source: string | null;
};

/** Mirrors `/api/telegram` → `feed_items` (same shape as `/api/feed` → `items`). */
export type TelegramFeedBootstrapRow = {
  id: number;
  sent_at: string | null;
  source_type: string;
  card_type: string;
  layout_variant: string | null;
  payload: unknown;
  read_at: string | null;
};

export type TelegramContextValue = {
  status: TelegramStatus;
  telegramUsername: string | null;
  /** App profile label from `users.display_name` (random on first registration). */
  displayName: string | null;
  hasWallet: boolean | null;
  walletRequired: boolean;
  wallet: TelegramWalletRow | null;
  initData: string | null;
  error: string | null;
  isInTelegram: boolean;
  /**
   * Use Telegram palette (launch + colorScheme) — true when in Mini App context OR status is not dev.
   * Differs from isInTelegram when status is "dev" but tgWebApp hash/init data exists (theme.ts must not force dark).
   */
  useTelegramTheme: boolean;
  /** "dark" | "light" per Telegram theme; dark is default/fallback. */
  colorScheme: "dark" | "light";
  /** True once we have a valid Telegram theme bg_color and can safely paint our custom palette. */
  themeBgReady: boolean;
  /** False on SSR/first paint, true after client mount — keeps useColors in sync with server HTML (hydration). */
  clientHydrated: boolean;
  triggerHaptic: (style: string) => void;
  safeAreaInsetTop: number;
  contentSafeAreaInsetTop: number;
  /**
   * Immersive fullscreen (requestFullscreen / Bot API 8.0+). Not the same as expanded mini-app height.
   */
  isFullscreen: boolean;
  /** Mini app expanded to full viewport height (WebApp.isExpanded). */
  isExpanded: boolean;
  /** Start param from launch (query or hash). Valid per Telegram: A-Za-z0-9_- up to 512 chars. */
  startParam: string | null;
  /** Hash + WebApp + UA + viewport flags for layout — see {@link computeTelegramLayoutStartupSnapshot}. */
  layoutStartup: TelegramLayoutStartupSnapshot;
  /** On-screen debug (no console needed in TMA). */
  debug: TelegramDebugInfo;
  /**
   * Rows from the last successful `POST /api/telegram`: welcome delivery + list (real `sent_at`).
   * Avoids relying on `/api/feed` completing before first paint during cold Mini App launches.
   */
  telegramBootstrapFeed: TelegramFeedBootstrapRow[] | null;
  /**
   * After successful POST /api/wallet/register, apply the returned `wallet` row so UI matches the
   * server without waiting for a full /api/telegram or local storage.
   */
  applyServerWalletAfterRegister: (wallet: TelegramWalletRow) => void;
  /** Outside TMA: hydrate account fields from `GET /api/auth/session` (browser OAuth / email OTP). */
  hydrateBrowserSessionFromCookie: () => Promise<boolean>;
};

const defaultDebug: TelegramDebugInfo = {
  hasWebAppApi: false,
  inTelegramClient: false,
  webAppPollCount: 0,
  initDataLength: null,
  initDataPollCount: 0,
  apiStatus: null,
  apiMessage: null,
  apiUrl: null,
  fetchDurationMs: null,
  lastLog: null,
};

const WEBAPP_POLL_MS = 100;
const WEBAPP_POLL_MAX = 50; // 5s wait for Telegram to inject WebApp
/** Same window: init data should appear once WebApp is real; cap avoids infinite wait on odd clients. */
const INIT_DATA_POLL_MAX = WEBAPP_POLL_MAX;

const defaultContext: TelegramContextValue = {
  status: "idle",
  telegramUsername: null,
  displayName: null,
  hasWallet: null,
  walletRequired: false,
  wallet: null,
  initData: null,
  error: null,
  isInTelegram: false,
  useTelegramTheme: false,
  colorScheme: "dark",
  themeBgReady: false,
  clientHydrated: false,
  triggerHaptic: () => {},
  safeAreaInsetTop: 0,
  contentSafeAreaInsetTop: 0,
  isFullscreen: false,
  isExpanded: true,
  startParam: null,
  layoutStartup: getEmptyTelegramLayoutStartupSnapshot(),
  debug: defaultDebug,
  telegramBootstrapFeed: null,
  applyServerWalletAfterRegister: () => {},
  hydrateBrowserSessionFromCookie: async () => false,
};

const TelegramContext = createContext<TelegramContextValue>(defaultContext);

export function useTelegram() {
  return useContext(TelegramContext);
}

export function TelegramProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<TelegramStatus>("idle");
  const [telegramUsername, setTelegramUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [walletRequired, setWalletRequired] = useState(false);
  const [wallet, setWallet] = useState<TelegramContextValue["wallet"]>(null);
  const [initData, setInitData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<TelegramDebugInfo>(defaultDebug);
  const [telegramBootstrapFeed, setTelegramBootstrapFeed] = useState<
    TelegramFeedBootstrapRow[] | null
  >(null);
  const hasRegisteredRef = useRef(false);
  const registerWithBackendRef = useRef<(initData: string) => void>(() => {});
  const browserSessionHydratedRef = useRef(false);
  const initPollCleanupRef = useRef<(() => void) | null>(null);
  /** Block SDK/bridge theme events until runTmaFlow has applied WebApp theme (avoids stale dark WebApp). */
  const tmaInitialThemeResolvedRef = useRef(false);

  const [safeAreaInsetTop, setSafeAreaInsetTop] = useState(0);
  const [contentSafeAreaInsetTop, setContentSafeAreaInsetTop] = useState(0);
  // Always start false (matches SSR / pre-hydration). Reading `window` here caused React #418 when
  // the client snapshot differed from server HTML; `runTmaFlow` / viewport sync set the real value.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [colorScheme, setColorScheme] = useState<"dark" | "light">(initialColorSchemeFromBootstrap);

  // Client starts hidden (themeBgReady false) until plain-web unlock (useLayoutEffect) or TMA runTmaFlow.
  const [themeBgReady, setThemeBgReady] = useState<boolean>(initialThemeBgReadyFromBootstrap);
  const [clientHydrated, setClientHydrated] = useState(false);
  // SSR/client parity: start with empty snapshot and compute after mount.
  const [layoutStartup, setLayoutStartup] = useState<TelegramLayoutStartupSnapshot>(
    getEmptyTelegramLayoutStartupSnapshot(),
  );
  useEffect(() => {
    setClientHydrated(true);
  }, []);

  const applyServerWalletAfterRegister = useCallback((w: TelegramWalletRow) => {
    setWallet(w);
    setHasWallet(true);
    setWalletRequired(false);
  }, []);

  const hydrateBrowserSessionFromCookie = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || isMiniAppContext()) return false;
    try {
      const response = await fetch(buildApiUrl("/api/auth/session"), {
        method: "GET",
        credentials: "include",
      });
      const json = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        telegram_username?: string;
        display_name?: string;
        has_wallet?: boolean;
        wallet_required?: boolean;
        wallet?: TelegramContextValue["wallet"];
      };
      if (!response.ok || !json?.authenticated) return false;
      setTelegramUsername(json.telegram_username ?? null);
      setDisplayName(
        typeof json.display_name === "string" && json.display_name.trim()
          ? json.display_name.trim()
          : null,
      );
      setHasWallet(typeof json.has_wallet === "boolean" ? json.has_wallet : null);
      setWalletRequired(Boolean(json.wallet_required));
      setWallet(json.wallet ?? null);
      setStatus("ok");
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onSignedOut = () => {
      hasRegisteredRef.current = false;
    };
    const onSignedIn = () => {
      if (isMiniAppContext()) {
        hasRegisteredRef.current = false;
        const initDataStr = getInitDataString();
        if (initDataStr) {
          registerWithBackendRef.current(initDataStr);
        }
        return;
      }
      void hydrateBrowserSessionFromCookie();
    };
    document.addEventListener("hsp-auth-signed-out", onSignedOut);
    document.addEventListener("hsp-auth-signed-in", onSignedIn);
    return () => {
      document.removeEventListener("hsp-auth-signed-out", onSignedOut);
      document.removeEventListener("hsp-auth-signed-in", onSignedIn);
    };
  }, [hydrateBrowserSessionFromCookie]);

  const refreshLayoutStartup = useCallback(() => {
    setLayoutStartup(computeTelegramLayoutStartupSnapshot());
  }, []);

  useLayoutEffect(() => {
    refreshLayoutStartup();
  }, [refreshLayoutStartup]);

  // Plain web: unlock immediately. TMA: do NOT paint from launch hash — it can mismatch WebApp
  // (dark classify in hash vs bg #ffffff in WebApp); only runTmaFlow uses WebApp.themeParams.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    function unlockPlainWebIfNeeded(): void {
      resetTelegramLaunchCache();
      if (isMiniAppContext()) return;
      setThemeBgReady(true);
    }
    unlockPlainWebIfNeeded();
    const raf = requestAnimationFrame(() => unlockPlainWebIfNeeded());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Hash changes: refresh layout snapshot + (TMA) re-read theme from WebApp / hash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      resetTelegramLaunchCache();
      refreshLayoutStartup();
      if (!isMiniAppContext()) return;
      const bg = getBgColorForScheme(getInitialThemeParams());
      if (bg) {
        setColorScheme(classifyThemeFromBgColor(bg));
        setThemeBgReady(true);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [refreshLayoutStartup]);

  // Live theme updates: SDK + bridge + native WebApp (no polling).
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cleanupSdk: (() => void) | undefined;
    let cleanupBridge: (() => void) | undefined;
    let cleanupNative: (() => void) | undefined;
    let nativeAttached = false;

    function updateScheme(next: "dark" | "light") {
      setColorScheme((prev) => {
        if (prev === next) return prev;
        appLog("[TMA theme]", "update_colorScheme", { from: prev, to: next });
        return next;
      });
    }

    function markThemeBgReady(): void {
      setThemeBgReady((prev) => {
        if (prev) return prev;
        appLog("[TMA theme]", "themeBgReady");
        return true;
      });
    }

    function applyFromWebApp(): void {
      if (!tmaInitialThemeResolvedRef.current) return;
      const tp = getInitialThemeParams();
      const bg = getBgColorForScheme(tp);
      if (!bg) return;
      const scheme = classifyThemeFromBgColor(bg);
      updateScheme(scheme);
      markThemeBgReady();
    }

    function computeSchemeFromPayload(payload: unknown): void {
      if (!tmaInitialThemeResolvedRef.current) return;
      const anyPayload = payload as unknown as {
        color_scheme?: string;
        theme_params?: Record<string, string>;
      } | null;

      const explicit = anyPayload?.color_scheme;
      if (explicit === "dark" || explicit === "light") {
        updateScheme(explicit);
        markThemeBgReady();
        return;
      }

      const tp = anyPayload?.theme_params;
      const bg = getBgColorForScheme(tp);
      if (!bg) return;
      const scheme = classifyThemeFromBgColor(bg);
      updateScheme(scheme);
      markThemeBgReady();
    }

    function tryAttachNativeThemeOnce(): void {
      if (nativeAttached) return;
      try {
        const app = (window as Window).Telegram?.WebApp as unknown as {
          onEvent?: (eventType: string, cb: () => void) => void;
          offEvent?: (eventType: string, cb: () => void) => void;
        } | null;
        if (!app || typeof app.onEvent !== "function") return;

        const handler = () => applyFromWebApp();
        app.onEvent("themeChanged", handler);
        nativeAttached = true;
        cleanupNative = () => {
          try {
            if (typeof app.offEvent === "function") {
              app.offEvent("themeChanged", handler);
            }
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }

    try {
      ensureSdkInitialized();
      cleanupSdk = on("theme_changed", (payload) => computeSchemeFromPayload(payload));
    } catch {
      // ignore
    }

    try {
      cleanupBridge = onBridge("theme_changed", (payload) =>
        computeSchemeFromPayload(payload),
      );
    } catch {
      // ignore
    }

    if (isTelegramLikelyAtStartup()) {
      tryAttachNativeThemeOnce();
      ensureTelegramScript(() => tryAttachNativeThemeOnce());
    }

    return () => {
      try {
        cleanupSdk?.();
      } catch {
        // ignore
      }
      try {
        cleanupBridge?.();
      } catch {
        // ignore
      }
      try {
        cleanupNative?.();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    if (!isLikelyInTma()) return;
    try {
      ensureSdkInitialized();
      viewport.mount?.();
      setSafeAreaInsetTop(viewport.safeAreaInsetTop ?? 0);
      setContentSafeAreaInsetTop(viewport.contentSafeAreaInsetTop ?? 0);
      setIsFullscreen(getIsImmersiveFullscreenMerged(readTmaSdkViewportIsFullscreen()));
      setIsExpanded(getIsExpanded());
    } catch {
      // outside Mini App (e.g. local dev) — leave defaults
    }
  }, []);

  // WebApp may set isFullscreen after SDK viewport; listen for authoritative updates.
  useEffect(() => {
    if (typeof window === "undefined" || !isLikelyInTma()) return;

    function applyMergedFullscreen(): void {
      try {
        const sdkFs = readTmaSdkViewportIsFullscreen();
        const merged = getIsImmersiveFullscreenMerged(sdkFs);
        setIsFullscreen(merged);
        appLog("[TMA fullscreen]", "sync", {
          webAppIsFullscreen: getIsFullscreen(),
          sdkViewportIsFullscreen: sdkFs,
          mergedImmersiveFullscreen: merged,
        });
      } catch {
        // ignore
      }
    }

    let detach: (() => void) | undefined;
    ensureTelegramScript(() => {
      applyMergedFullscreen();
      detach = attachFullscreenChangedListener(applyMergedFullscreen);
    });

    return () => {
      detach?.();
    };
  }, []);

  // TMA-only: layout height and scroll come from TMA. When keyboard opens,
  // nothing changes until TMA sends viewport_changed; theme updates are
  // handled via useThemeParams above.
  useEffect(() => {
    if (typeof window === "undefined" || !isLikelyInTma()) return;

    // iOS: viewport-fit=cover avoids white gap at bottom when keyboard opens
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      const c = meta.getAttribute("content") ?? "";
      if (!c.includes("viewport-fit=cover")) {
        meta.setAttribute("content", [c, "viewport-fit=cover"].filter(Boolean).join(", "));
      }
    }

    function lockScroll() {
      if (window.scrollY > 0) window.scrollTo(0, 0);
    }
    window.addEventListener("scroll", lockScroll, { passive: false });

    function syncViewportFromSdk(
      viewportPayload?: {
        height?: number;
        width?: number;
        is_expanded?: boolean;
        isExpanded?: boolean;
        is_state_stable?: boolean;
        isStateStable?: boolean;
        fullscreen?: boolean;
        isFullscreen?: boolean;
        is_fullscreen?: boolean;
      },
    ): void {
      try {
        setSafeAreaInsetTop(viewport.safeAreaInsetTop ?? 0);
        setContentSafeAreaInsetTop(viewport.contentSafeAreaInsetTop ?? 0);
        const sdkFs = readTmaSdkViewportIsFullscreen();
        const bridgeFs = parseViewportChangedFullscreenFlag(viewportPayload);
        const merged = getIsImmersiveFullscreenMerged(sdkFs, bridgeFs);
        setIsFullscreen(merged);
        const expandedFromEvent =
          viewportPayload?.is_expanded ?? viewportPayload?.isExpanded;
        if (typeof expandedFromEvent === "boolean") {
          setIsExpanded(expandedFromEvent);
        } else {
          setIsExpanded(getIsExpanded());
        }
        appLog("[TMA viewport]", "sync", {
          sdkViewportIsFullscreen: sdkFs,
          bridgeViewportChangedFullscreen: bridgeFs,
          webAppIsFullscreen: getIsFullscreen(),
          mergedImmersiveFullscreen: merged,
          isExpanded: typeof expandedFromEvent === "boolean" ? expandedFromEvent : getIsExpanded(),
          payloadKeys:
            viewportPayload && typeof viewportPayload === "object"
              ? Object.keys(viewportPayload as object)
              : [],
        });
      } catch {
        // ignore
      }
    }

    let tmaCleanup: (() => void) | null = null;
    viewport.mount?.().then(() => {
      try {
        syncViewportFromSdk();
        const unbindCss = viewport.bindCssVars?.();
        // viewport_changed (height, width?, is_expanded, is_state_stable). Only reset scroll when state is stable.
        const removeViewportListener = on(
          "viewport_changed",
          (payload: {
            height: number;
            width?: number;
            is_expanded?: boolean;
            is_state_stable?: boolean;
            isExpanded?: boolean;
            isStateStable?: boolean;
            fullscreen?: boolean;
            isFullscreen?: boolean;
            is_fullscreen?: boolean;
          }) => {
            syncViewportFromSdk(payload);
            const stable = payload.is_state_stable ?? payload.isStateStable ?? false;
            if (stable) window.scrollTo(0, 0);
          }
        );

        tmaCleanup = () => {
          unbindCss?.();
          removeViewportListener?.();
        };
      } catch {
        // ignore
      }
    });

    return () => {
      window.removeEventListener("scroll", lockScroll);
      tmaCleanup?.();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      setDebug((d) => patchTelegramDebug(d, { hasWebAppApi: false, apiMessage: "no window" }));
      setStatus("dev");
      return;
    }

    if (!isMiniAppContext()) {
      setDebug((d) =>
        patchTelegramDebug(d, {
          hasWebAppApi: false,
          apiMessage: "outside_telegram_context",
          lastLog: "skipped_tma_polling",
        }),
      );
      setStatus("dev");
      return;
    }

    setStatus("loading");
    ensureTelegramScript();

    const API_TIMEOUT_MS = 30000;

    function registerWithBackend(initData: string) {
      if (hasRegisteredRef.current) return;
      hasRegisteredRef.current = true;
      markMiniAppRegistrationStarted();
      setInitData(initData);

      const url = buildApiUrl("/api/telegram");
      const fetchStartedAt = Date.now();

      setDebug((d) =>
        patchTelegramDebug(d, {
          initDataLength: initData.length,
          apiUrl: url,
          fetchDurationMs: null,
          lastLog: "fetch start",
        }),
      );
      appLog("[TMA register]", "fetch_start", { url, initDataLength: initData.length });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ initData }),
        signal: controller.signal,
      })
        .then(async (res) => {
          clearTimeout(timeoutId);
          const durationMs = Date.now() - fetchStartedAt;
          const json = await res.json().catch(() => ({}));
          const apiMsg = json?.error ?? (json?.ok ? "ok" : String(res.status));

          setDebug((d) =>
            patchTelegramDebug(d, {
              apiStatus: res.status,
              apiMessage: apiMsg,
              fetchDurationMs: durationMs,
              lastLog: `status ${res.status} ${durationMs}ms`,
            }),
          );
          appLog("[TMA register]", "response", { status: res.status, ms: durationMs, body: apiMsg });

          if (!res.ok || !json?.ok) {
            throw new Error(json?.error || `HTTP ${res.status}`);
          }
          setTelegramUsername(json.telegram_username ?? null);
          setDisplayName(
            typeof json.display_name === "string" && json.display_name.trim()
              ? json.display_name.trim()
              : null,
          );
          setHasWallet(typeof json.has_wallet === "boolean" ? json.has_wallet : null);
          setWalletRequired(Boolean(json.wallet_required));
          setWallet(json?.wallet ?? null);
          const fiRaw = (json as { feed_items?: unknown }).feed_items;
          setTelegramBootstrapFeed(
            Array.isArray(fiRaw) && fiRaw.length > 0 ? (fiRaw as TelegramFeedBootstrapRow[]) : null,
          );
          setStatus("ok");
          if (typeof document !== "undefined") {
            document.dispatchEvent(new CustomEvent("hsp-auth-session-updated"));
          }
        })
        .catch((e) => {
          clearTimeout(timeoutId);
          const durationMs = Date.now() - fetchStartedAt;
          const isTimeout = e?.name === "AbortError";
          const msg = isTimeout ? "timeout" : e?.message ?? "fetch error";
          const lastLog = isTimeout
            ? `timeout after ${durationMs}ms`
            : `error ${durationMs}ms: ${msg}`;

          setDebug((d) =>
            patchTelegramDebug(d, {
              apiStatus: null,
              apiMessage: msg,
              fetchDurationMs: durationMs,
              lastLog,
            }),
          );
          appError("[TMA register]", "failed", { step: lastLog }, e);

          setError(isTimeout ? "Request timed out" : (e?.message ?? "Failed to register Telegram user"));
          setStatus("error");
        });
    }

    registerWithBackendRef.current = registerWithBackend;

    function runTmaFlow(): () => void {
      readyAndExpand();

      // Initial theme + WebApp viewport flags in one snapshot (hash theme JSON has colors only).
      try {
        const launchTp = getThemeParamsFromLaunch();
        const webTp = getInitialThemeParams();
        const bg = getBgColorForScheme(webTp) ?? getBgColorForScheme(launchTp);

        const viewportFs = readTmaSdkViewportIsFullscreen();
        const mergedImmersive = getIsImmersiveFullscreenMerged(viewportFs);
        setIsFullscreen(mergedImmersive);
        setIsExpanded(getIsExpanded());

        appLog("[TMA init]", "snapshot", getTmaInitAndWebAppDebugSnapshot());
        appLog("[TMA theme]", "initial_themeParams", {
          launch: launchTp,
          web: webTp,
          webAppIsFullscreen: getIsFullscreen(),
          viewportSdkIsFullscreen: viewportFs,
          mergedImmersiveFullscreen: mergedImmersive,
          isExpanded: getIsExpanded(),
          bg,
        });
        if (bg) {
          setColorScheme(classifyThemeFromBgColor(bg));
        }
      } catch {
        // ignore; keep default "dark"
      } finally {
        tmaInitialThemeResolvedRef.current = true;
        // Always unlock after snapshot — missing bg_color or a thrown helper would otherwise leave
        // themeBgReady false forever (opacity:0 root).
        setThemeBgReady((prev) => {
          if (prev) return prev;
          appLog("[TMA theme]", "themeBgReady");
          return true;
        });
      }

      let initDataStr = getInitDataString();
      if (initDataStr) {
        registerWithBackend(initDataStr);
        return () => {};
      }
      // Do not poll forever when init data cannot arrive (Electron / browser stub: platform "unknown", no launch hash).
      if (!shouldPollForInitData()) {
        setDebug((d) =>
          patchTelegramDebug(d, {
            apiMessage: "no init data (not in Telegram client)",
            initDataPollCount: 0,
          }),
        );
        setStatus("dev");
        return () => {};
      }
      let initDataPollCount = 0;
      const initInterval = setInterval(() => {
        initDataPollCount += 1;
        setDebug((d) => patchTelegramDebug(d, { initDataPollCount }));
        initDataStr = getInitDataString();
        if (initDataStr) {
          clearInterval(initInterval);
          registerWithBackend(initDataStr);
          return;
        }
        if (initDataPollCount >= INIT_DATA_POLL_MAX) {
          clearInterval(initInterval);
          setDebug((d) => patchTelegramDebug(d, { apiMessage: "no init data (timeout)" }));
          setStatus("dev");
        }
      }, WEBAPP_POLL_MS);
      return () => clearInterval(initInterval);
    }

    let webAppPollCount = 0;
    let webAppInterval: ReturnType<typeof setInterval> | undefined;

    function tryAttachWebApp(): boolean {
      if (!isAvailable()) return false;
      if (webAppInterval != null) {
        clearInterval(webAppInterval);
        webAppInterval = undefined;
      }
      setDebug((d) => patchTelegramDebug(d, { hasWebAppApi: true }));
      initPollCleanupRef.current = runTmaFlow();
      return true;
    }

    // Run once immediately — avoids extra 100ms dark frame while waiting for first interval tick.
    if (!tryAttachWebApp()) {
      webAppInterval = setInterval(() => {
        webAppPollCount += 1;
        setDebug((d) => patchTelegramDebug(d, { webAppPollCount }));

        if (tryAttachWebApp()) return;

        if (webAppPollCount >= WEBAPP_POLL_MAX) {
          if (webAppInterval != null) clearInterval(webAppInterval);
          webAppInterval = undefined;
          setDebug((d) => patchTelegramDebug(d, { apiMessage: "no WebApp (timeout)" }));
          setStatus("dev");
        }
      }, WEBAPP_POLL_MS);
    }

    return () => {
      if (webAppInterval != null) clearInterval(webAppInterval);
      initPollCleanupRef.current?.();
    };
  }, []);

  // Plain web only: after WebApp poll times out we set status "dev" — ensure UI is visible.
  // Do not force themeBgReady in Mini App (would show dark before runTmaFlow applies launch theme).
  useEffect(() => {
    if (status !== "dev") return;
    if (isMiniAppContext()) return;
    setThemeBgReady(true);
  }, [status]);

  // Browser OIDC / email session bootstrap (outside TMA).
  useEffect(() => {
    if (status !== "dev") return;
    if (isMiniAppContext()) return;
    if (browserSessionHydratedRef.current) return;
    browserSessionHydratedRef.current = true;
    void hydrateBrowserSessionFromCookie();
  }, [status, hydrateBrowserSessionFromCookie]);

  const miniAppContext = typeof window !== "undefined" && isMiniAppContext();
  const isInTelegram = status !== "dev" && miniAppContext;
  const useTelegramTheme = miniAppContext;

  useEffect(() => {
    refreshLayoutStartup();
  }, [isFullscreen, isExpanded, status, refreshLayoutStartup]);

  const value: TelegramContextValue = {
    status,
    telegramUsername,
    displayName,
    hasWallet,
    walletRequired,
    wallet,
    initData,
    error,
    isInTelegram,
    useTelegramTheme,
    colorScheme,
    themeBgReady,
    clientHydrated,
    triggerHaptic: triggerHapticImpl,
    safeAreaInsetTop,
    contentSafeAreaInsetTop,
    isFullscreen,
    isExpanded,
    startParam: layoutStartup.startParam,
    layoutStartup,
    debug,
    telegramBootstrapFeed,
    applyServerWalletAfterRegister,
    hydrateBrowserSessionFromCookie,
  };

  return (
    <TelegramContext.Provider value={value}>
      {children}
    </TelegramContext.Provider>
  );
}
