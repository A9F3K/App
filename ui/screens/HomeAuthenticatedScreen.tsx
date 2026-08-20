import {
  Children,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ActivityIndicator, Button, Platform, Text, View, useWindowDimensions } from "react-native";
import { GlobalBottomBar } from "../components/GlobalBottomBar";
import { AiSearchColumnEmptyState } from "../components/ai/AiSearchColumnEmptyState";
import { useBottomBarLayout } from "../components/BottomBarLayoutContext";
import { MessagesColumnFooter } from "../components/MessagesColumnFooter";
import { useMessagesChatListSearch } from "../messages/MessagesChatListSearchContext";
import { SendColumnInactiveFooter } from "../components/InactiveWelcomeColumnFooter";
import { SwapColumnFooter } from "../components/swap/SwapColumnFooter";
import { HomeAuthenticatedHeaderRow } from "../components/HomeAuthenticatedHeaderRow";
import { AuthenticatedHomeLeftNavStrip } from "../components/AuthenticatedHomeLeftNavStrip";
import { AuthenticatedHomeFeedPanel } from "../components/AuthenticatedHomeFeedPanel";
import { AuthenticatedHomeMessagesPanel } from "../components/AuthenticatedHomeMessagesPanel";
import { MessageChatPanel } from "../components/messages/MessageChatPanel";
import { MessageChatOlderHistoryLoadLine } from "../components/messages/MessageChatOlderHistoryLoadLine";
import {
  isChatListBottomLoaderActive,
  subscribeChatListBottomLoaderActive,
} from "../components/messages/chatListBottomLoaderStatus";
import { invokeChatListNearBottom } from "../components/messages/chatListNearBottom";
import { setChatListScrollMetrics } from "../components/messages/chatListScrollMetrics";
import { setChatListSearchScrollToEndHandler } from "../components/messages/chatListSearchScrollAnchor";
import { MessageChatWriteBottomBar } from "../components/messages/MessageChatWriteBottomBar";
import { GetPanelContent } from "../components/get/GetPanelContent";
import { SendPanelContent } from "../components/send/SendPanelContent";
import { AuthenticatedHomeSplitBody } from "../components/AuthenticatedHomeSplitBody";
import type { AuthenticatedHomeSplitLayoutMetrics } from "../components/AuthenticatedHomeSplitLayoutMetricsContext";
import {
  isAuthenticatedHomeTripleColumnLayoutWidthPx,
  isAuthenticatedHomeWideLayoutWidthPx,
  readAuthenticatedHomeLayoutWidthPx,
} from "../authenticatedHomeLayoutWidth";
import { AuthenticatedHomePersistedPanelSlot } from "../components/AuthenticatedHomePersistedPanelSlot";
import { HspScrollColumn, type HspScrollColumnHandle } from "../components/HspScrollColumn";
import { Address } from "@ton/core";
import { type TelegramWalletRow, useTelegram } from "../components/Telegram";
import { logPageDisplay } from "../pageDisplayLog";
import { authenticatedHomeBottomBarDock, layout, typographySansSemibold, useColors } from "../theme";
import { useResolvedPathname } from "../useResolvedPathname";
import { buildApiUrl } from "../../api/_base";
import {
  deriveAddressFromMnemonic,
  deriveMasterKeyFromMnemonic,
  generateMnemonic,
} from "../../services/wallet/tonWallet";
import { buildWalletRegisterEnvelope } from "../../services/wallet/walletEnvelopeClient";
import { useAppStrings } from "../../locales/AppStringsContext";
import { SwapPanelContent } from "../components/SwapPanelContent";
import { ChooseCurrencyPanelContent } from "../components/swap/ChooseCurrencyPanelContent";
import { SmartColumnFooter } from "../components/smart/SmartColumnFooter";
import { SmartPanelContent } from "../components/smart/SmartPanelContent";
import { TradePanelContent } from "../components/trade/TradePanelContent";
import {
  DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY,
  openAuthenticatedHomeRightPanel,
  useAuthenticatedHomeRightPanel,
} from "../authenticatedHomeRightPanel";
import {
  setAuthenticatedHomeLeftNavIndex,
  useAuthenticatedHomeLeftNavIndex,
} from "../authenticatedHomeLeftNavIndex";
import {
  clearAuthenticatedHomeSelectedChat,
  useAuthenticatedHomeMiddleColumnFocus,
  useAuthenticatedHomeSelectedChat,
} from "../authenticatedHomeSelectedChat";
import { useRouter } from "expo-router";
import {
  openSwapCurrenciesBrowse,
  shouldOpenSwapCurrenciesBrowseOnSwapScreen,
  useSwapCurrencyPicker,
} from "../swap/swapCurrencyPicker";

/**
 * Survives React Strict Mode / remount: component `useRef` resets, but two parallel
 * `createAndRegisterWalletFlow` calls still produced duplicate pre-register + `POST /api/wallet/register`
 * and stuck loading (TMA / production logs showed doubled `pre_register_done` + `register_fetch`).
 */
let walletCreateModuleInFlight = false;

function isWalletCreateFlowModuleLocked() {
  return walletCreateModuleInFlight;
}

/**
 * Provisional UI state set from async code must survive **React 18 Strict Mode remounts** and TMA
 * re-mounts. If the first `HomeAuthenticatedScreen` instance is torn down after `useLayoutEffect`
 * started `createAndRegisterWalletFlow` but before `setCreatedWalletAddress` runs, those `setState`
 * calls are dropped; the in-flight IIFE (module lock) then logs `local_wallet_address_ready` with no
 * visible address. A module store + `useSyncExternalStore` re-renders the **current** instance.
 */
type WalletHomeBootstrap = {
  provisionalAddress: string | null;
  serverRegPending: boolean;
};
let homeBootstrap: WalletHomeBootstrap = {
  provisionalAddress: null,
  serverRegPending: false,
};
let homeBootstrapVersion = 0;
const homeBootstrapListeners = new Set<() => void>();
function getHomeBootstrapVersion() {
  return homeBootstrapVersion;
}
function subscribeHomeBootstrap(on: () => void) {
  homeBootstrapListeners.add(on);
  return () => {
    homeBootstrapListeners.delete(on);
  };
}
function getHomeBootstrap(): WalletHomeBootstrap {
  return homeBootstrap;
}
function setHomeBootstrap(patch: Partial<WalletHomeBootstrap>) {
  const next: WalletHomeBootstrap = { ...homeBootstrap, ...patch };
  if (
    next.provisionalAddress === homeBootstrap.provisionalAddress &&
    next.serverRegPending === homeBootstrap.serverRegPending
  ) {
    return;
  }
  homeBootstrap = next;
  homeBootstrapVersion += 1;
  for (const l of homeBootstrapListeners) l();
}

/** Authenticated “home” main view; mounted from `app/index` at URL `/` when the user has a session. */

/**
 * Padding for authenticated home: vertical + horizontal on main body only.
 * First child (header row) is full-bleed horizontally so a divider can span the viewport;
 * {@link HomeAuthenticatedHeaderRow} applies the same horizontal inset to header content.
 * Body children are full-bleed horizontally — use `AuthenticatedHomePaddedBody` for horizontal insets, or
 * `AuthenticatedHomeSplitBody` (left column has no horizontal padding; pad sub-blocks on the home screen as needed).
 */
function AuthenticatedHomePaddedBody({ children }: { children: ReactNode }) {
  return (
    <View style={{ flex: 1, width: "100%", paddingHorizontal: layout.contentSideInsetPx }}>{children}</View>
  );
}

function AuthenticatedHomeChrome({
  children,
  /** When set (including `null`), overrides legacy first-child header slot. */
  header,
  /** Optional strip below the header (e.g. active voice dock on Swap/Trade). */
  belowHeader,
  /** When false (compact home), vertical insets live in scroll content so the indicator spans header→footer.
   *  `"wide"`: top inset matches {@link layout.authenticatedHome.headerWideSidePaddingVerticalPx}. */
  edgePadding = true,
}: {
  children: ReactNode;
  header?: ReactNode | null;
  belowHeader?: ReactNode | null;
  edgePadding?: boolean | "wide";
}) {
  const colors = useColors();
  const p = layout.authenticatedHome;
  const nodes = Children.toArray(children);
  const head = header !== undefined ? header : nodes[0];
  const body = header !== undefined ? nodes : nodes.slice(1);
  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        alignSelf: "stretch",
        backgroundColor: colors.background,
      }}
    >
      <View
        style={{
          flex: 1,
          width: "100%",
          paddingTop:
            edgePadding === "wide"
              ? 0
              : edgePadding
                ? p.contentInsetTop
                : 0,
          paddingBottom: edgePadding ? p.contentInsetBottom : 0,
        }}
      >
        {head}
        {belowHeader ?? null}
        <View style={{ flex: 1, width: "100%", minHeight: 0 }}>{body}</View>
      </View>
    </View>
  );
}

type CreateStep = "idle" | "saving" | "done";

/** Wallet mnemonic ciphertext + KMS-wrapped DEK live on the server (`wallets` row); no TMA SecureStorage path. */
export type WalletMasterKeyStorageTier = "server";
/** Serverless/cold DB can exceed 45s; client abort must not cut off a slow but successful register. */
const WALLET_REGISTER_TIMEOUT_MS = 90_000;
/** TMA: `POST /api/wallet/register` may never resolve even when the server wrote the row; poll `/api/wallet/status` in parallel. */
const WALLET_REGISTER_POLL_INTERVAL_MS = 2_000;
const WALLET_REGISTER_STATUS_FETCH_MS = 8_000;
/** Vercel 502/503/504: Lambda may be killed before the response while DB commit still completes. */
const REGISTER_AFTER_GATEWAY_POLL_BUDGET_MS = 120_000;
/**
 * `POST /api/wallet/status` is cheap. If the first register 504d **before** any DB write, status stays
 * empty forever — the UI must re-`POST /api/wallet/register` (idempotent `ON CONFLICT` upsert) on a
 * slower cadence. Interval = ticks × `WALLET_REGISTER_POLL_INTERVAL_MS` (2s per tick).
 */
const SIDE_REGISTER_RETRY_INTERVAL_TICKS = 5;
const SIDE_REGISTER_POST_TIMEOUT_MS = 90_000;
/** Mnemonic + address + key derivation; some TMA WebViews hang in WebCrypto without rejecting. */
const WALLET_PRE_REGISTER_TIMEOUT_MS = 30_000;
/** Covers pre-register (≤30s) + register race (≤90s) + gateway status recovery (≤120s) + slack. */
const WALLET_FLOW_BUDGET_MS = 250_000;

/**
 * If `POST /api/wallet/register` times out (504) or the network blips, the server row may still appear
 * shortly after. The home `useEffect` polls `POST /api/wallet/status` only while `serverRegPending` is
 * true — we must not clear that flag on these errors or "Finishing on the server" never completes.
 */
function isRetryableRegistrationError(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  const m = e.message;
  if (m.includes("Wallet server timed out") || m.includes("busy or cold")) {
    return true;
  }
  if (m.includes("Wallet registration: could not reach the app or the server in time")) {
    return true;
  }
  if (m.includes("Wallet registration request timed out") || m.includes("Wallet registration request failed")) {
    return true;
  }
  if (m.includes("Network request failed") || m.includes("Failed to fetch") || m.toLowerCase().includes("load failed")) {
    return true;
  }
  return false;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const f =
    typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis) as typeof fetch
      : fetch;
  const controller = new AbortController();
  return new Promise<Response>((resolve, reject) => {
    const hardFuse = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("Wallet registration request timed out"));
    }, timeoutMs);
    void f(url, { ...init, signal: controller.signal }).then(
      (response) => {
        clearTimeout(hardFuse);
        resolve(response);
      },
      (e) => {
        clearTimeout(hardFuse);
        if (e instanceof Error && e.name === "AbortError") {
          reject(new Error("Wallet registration request timed out"));
        } else {
          reject(e);
        }
      },
    );
  });
}

/**
 * TON user-friendly forms can differ (e.g. bounceable `EQ` vs non-`UQ` for the same v4 key). String
 * compare and naive lowercasing are unsafe; `Address.equals` normalizes the underlying cell.
 */
function sameTonAddressForPoll(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, "").trim();
  const y = b.replace(/\s+/g, "").trim();
  if (x === y) {
    return true;
  }
  try {
    return Address.parse(x).equals(Address.parse(y));
  } catch {
    return x.toLowerCase() === y.toLowerCase();
  }
}

/**
 * `POST /api/wallet/status` — same initData as register; use to detect a wallet the server
 * already stored when the register `fetch` is stuck in Telegram WebView.
 */
async function fetchDefaultWalletStatusRow(
  initData: string | null,
  timeoutMs: number,
): Promise<TelegramWalletRow | null> {
  try {
    const body =
      initData != null && initData.trim() !== "" ? { initData } : {};
    const r = await fetchWithTimeout(
      buildApiUrl("/api/wallet/status"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      has_wallet?: boolean;
      wallet?: unknown;
    };
    if (!r.ok || !j?.ok || !j?.has_wallet || !j?.wallet) {
      return null;
    }
    return registerWalletFromJson(j.wallet);
  } catch {
    return null;
  }
}

/** After `POST /api/wallet/register` returns 502/503/504, keep matching the status endpoint. */
async function tryRecoverAfterRegisterGatewayError(
  initData: string | null,
  expectedWalletAddress: string,
): Promise<TelegramWalletRow | null> {
  const matchExpected = (row: TelegramWalletRow) =>
    sameTonAddressForPoll(row.wallet_address, expectedWalletAddress);
  const deadline = Date.now() + REGISTER_AFTER_GATEWAY_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    const row = await fetchDefaultWalletStatusRow(initData, WALLET_REGISTER_STATUS_FETCH_MS);
    if (row && matchExpected(row)) {
      return row;
    }
    await new Promise((r) => setTimeout(r, WALLET_REGISTER_POLL_INTERVAL_MS));
  }
  return null;
}

type RegisterRaceOutcome =
  | { from: "fetch"; response: Response }
  | { from: "poll"; row: TelegramWalletRow };

/**
 * TMA: register `POST` and server-side confirmation race. Whichever indicates success first wins.
 * Poll only accepts a row whose `wallet_address` matches `expectedWalletAddress` (this flow’s key).
 */
function raceRegisterPostWithStatusPoll(
  registerUrl: string,
  registerInit: RequestInit,
  initData: string | null,
  expectedWalletAddress: string,
): Promise<RegisterRaceOutcome> {
  const matchExpected = (row: TelegramWalletRow) => sameTonAddressForPoll(row.wallet_address, expectedWalletAddress);

  return new Promise<RegisterRaceOutcome>((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + WALLET_REGISTER_TIMEOUT_MS;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let pollInFlight = false;

    const finish = (o: RegisterRaceOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      resolve(o);
    };

    const fail = (e: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      reject(e);
    };

    void fetchWithTimeout(registerUrl, registerInit, WALLET_REGISTER_TIMEOUT_MS).then(
      (response) => {
        if (settled) {
          return;
        }
        finish({ from: "fetch", response });
      },
      (e) => {
        fail(e instanceof Error ? e : new Error("Wallet registration request failed"));
      },
    );

    const pollOnce = async () => {
      if (settled) {
        return;
      }
      if (Date.now() > deadline) {
        fail(
          new Error(
            "Wallet registration: could not reach the app or the server in time. Try again, or open the app once more (your wallet may already be saved).",
          ),
        );
        return;
      }
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;
      try {
        const row = await fetchDefaultWalletStatusRow(initData, WALLET_REGISTER_STATUS_FETCH_MS);
        if (settled) {
          return;
        }
        if (row && matchExpected(row)) {
          logPageDisplay("wallet_create_flow", { flow: "register_detected_via_status_poll" });
          finish({ from: "poll", row });
        }
      } finally {
        pollInFlight = false;
      }
    };

    void pollOnce();
    intervalId = setInterval(() => {
      void pollOnce();
    }, WALLET_REGISTER_POLL_INTERVAL_MS);
  });
}

/** Parse wallet object from `/api/wallet/status` or register response JSON. */
function registerWalletFromJson(raw: unknown): TelegramWalletRow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const idRaw = w.id;
  const id =
    typeof idRaw === "number" && Number.isFinite(idRaw)
      ? idRaw
      : typeof idRaw === "string" && /^\d+$/.test(idRaw)
        ? Number(idRaw)
        : NaN;
  if (
    !Number.isFinite(id) ||
    typeof w.wallet_address !== "string" ||
    typeof w.wallet_blockchain !== "string" ||
    typeof w.wallet_net !== "string" ||
    typeof w.type !== "string"
  ) {
    return null;
  }
  return {
    id,
    wallet_address: w.wallet_address,
    wallet_blockchain: w.wallet_blockchain,
    wallet_net: w.wallet_net,
    type: w.type,
    label: w.label == null || typeof w.label === "string" ? (w.label as string | null) : null,
    is_default: Boolean(w.is_default),
    source: w.source == null || typeof w.source === "string" ? (w.source as string | null) : null,
  };
}

type PendingServerWalletRegPayload = {
  initData: string | null;
  walletAddress: string;
  mnemonic: string[];
  masterKey: string;
  registerUrl: string;
  registerInit: RequestInit;
  registerBody: string;
};

/**
 * Mirrors `pendingServerRegRef` for the in-flight create flow. Refs reset on remount; the
 * `await executeWalletServerRegistration` + inner status poll can stay wedged in a no-longer-active
 * instance, so the UI `serverRegPending` flag never clears. Module copy lets the *current* instance
 * poll `POST /api/wallet/status` and finish when the server row exists.
 */
let pendingServerRegModule: PendingServerWalletRegPayload | null = null;
let lastKeyBackgroundForWalletAddress: string | null = null;

function setPendingServerRegModuleStore(p: PendingServerWalletRegPayload) {
  pendingServerRegModule = p;
}
function clearPendingServerRegModuleStore() {
  pendingServerRegModule = null;
}

/** Set when the home-side `POST /api/wallet/status` poll recovers; lets the outer `catch` ignore a late error from a wedged in-flight `execute`. */
let walletRegSatisfiedBySideStatusPoll = false;

type SetCreateStep = (s: CreateStep) => void;

/**
 * TMA: register race + response handling. Caller should show the local derived address in the UI
 * before awaiting this (provisional UX); this finishes server + React wallet row application.
 */
async function executeWalletServerRegistration(
  initData: string | null,
  walletAddress: string,
  registerUrl: string,
  registerInit: RequestInit,
  apply: (r: TelegramWalletRow) => void,
  setCreated: (a: string) => void,
  setStep: SetCreateStep,
): Promise<void> {
  logPageDisplay("wallet_create_flow", { flow: "register_fetch", transport: "fetch_plus_status_poll" });
  const first = await raceRegisterPostWithStatusPoll(registerUrl, registerInit, initData, walletAddress);

  if (first.from === "poll") {
    apply(first.row);
    setCreated(first.row.wallet_address);
    setStep("done");
    logPageDisplay("wallet_create_flow", { flow: "register_ok", hasServerWallet: true, via: "status_poll" });
  } else {
    const response = first.response;
    logPageDisplay("wallet_create_flow", { flow: "register_response", httpStatus: response.status });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json?.ok) {
      const errStr = json?.error != null ? String(json.error) : null;
      logPageDisplay("wallet_create_flow", { flow: "register_rejected", status: response.status, err: errStr });
      if (errStr === "kms_wrap_failed" || errStr === "kms_encrypt_failed") {
        throw new Error(
          "Wallet encryption service (Cloud KMS) failed. Billing or KMS access may be disabled — check GCP, then tap Retry.",
        );
      }
      const gateway = response.status >= 502 && response.status <= 504;
      if (gateway) {
        logPageDisplay("wallet_create_flow", { flow: "register_retry_status_after_gateway", status: response.status });
        const recovered = await tryRecoverAfterRegisterGatewayError(initData, walletAddress);
        if (recovered) {
          apply(recovered);
          setCreated(recovered.wallet_address);
          setStep("done");
          logPageDisplay("wallet_create_flow", { flow: "register_ok", hasServerWallet: true, via: "status_after_gateway" });
        } else {
          const msg =
            errStr || "Wallet server timed out (busy or cold). Tap Retry, or try again in a few seconds.";
          throw new Error(msg);
        }
      } else {
        throw new Error(errStr || `HTTP ${response.status}`);
      }
    } else {
      const serverWallet = registerWalletFromJson(json.wallet);
      if (serverWallet) {
        apply(serverWallet);
      }
      setCreated(walletAddress);
      setStep("done");
      logPageDisplay("wallet_create_flow", { flow: "register_ok", hasServerWallet: Boolean(serverWallet), via: "register_post" });
    }
  }
}

/** Mnemonic secret is persisted only via `POST /api/wallet/register` (Neon + KMS-wrapped DEK). */
function markWalletSecretStoredOnServer(
  setMasterKeyStorageTier: (t: WalletMasterKeyStorageTier) => void,
  dedupeByWalletAddress?: string,
): void {
  if (dedupeByWalletAddress != null && lastKeyBackgroundForWalletAddress === dedupeByWalletAddress) {
    return;
  }
  if (dedupeByWalletAddress != null) {
    lastKeyBackgroundForWalletAddress = dedupeByWalletAddress;
  }
  setMasterKeyStorageTier("server");
}

export function HomeAuthenticatedScreen() {
  return <HomeAuthenticatedScreenMain />;
}

function HomeAuthenticatedScreenMain() {
  const colors = useColors();
  const router = useRouter();
  const { t, tf, translateFlowError } = useAppStrings();
  const homeNavIndex = useAuthenticatedHomeLeftNavIndex();
  const { listSearchActive } = useMessagesChatListSearch();
  const messagesSearchScrollMode = homeNavIndex === 1 && listSearchActive;
  const chatListBottomLoaderActive = useSyncExternalStore(
    subscribeChatListBottomLoaderActive,
    isChatListBottomLoaderActive,
    () => false,
  );
  const showChatListBottomLoader = chatListBottomLoaderActive && homeNavIndex === 1;
  const homeLeftScrollRef = useRef<HspScrollColumnHandle | null>(null);
  useEffect(() => {
    setChatListSearchScrollToEndHandler(() => {
      homeLeftScrollRef.current?.scrollToEnd();
    });
    return () => setChatListSearchScrollToEndHandler(null);
  }, []);
  useEffect(() => {
    if (!messagesSearchScrollMode) {
      homeLeftScrollRef.current?.scrollToY(0);
      return;
    }
    const frame = requestAnimationFrame(() => {
      homeLeftScrollRef.current?.scrollToEnd();
    });
    return () => cancelAnimationFrame(frame);
  }, [messagesSearchScrollMode]);
  const handleHomeLeftScrollNearBottom = useCallback(() => {
    if (homeNavIndex !== 1) return;
    // Search/recents use bottom-anchored lists — do not page the main chat list.
    if (listSearchActive) return;
    invokeChatListNearBottom();
    requestAnimationFrame(() => {
      homeLeftScrollRef.current?.clearNearBottomLatch();
    });
  }, [homeNavIndex, listSearchActive]);
  const handleHomeLeftScrollPositionChange = useCallback(
    (metrics: { scrollY: number; layoutH: number; contentH: number }) => {
      if (homeNavIndex !== 1) return;
      setChatListScrollMetrics({ scrollY: metrics.scrollY, layoutH: metrics.layoutH });
    },
    [homeNavIndex],
  );
  const selectedMessageChat = useAuthenticatedHomeSelectedChat();
  const middleColumnFocus = useAuthenticatedHomeMiddleColumnFocus();
  const rightPanel = useAuthenticatedHomeRightPanel();
  const swapCurrencySide = useSwapCurrencyPicker();
  const {
    status,
    telegramUsername,
    displayName,
    hasWallet,
    walletRequired,
    wallet,
    initData,
    error,
    debug,
    applyServerWalletAfterRegister,
    browserSessionChecked,
  } = useTelegram();
  const pathname = useResolvedPathname();
  const { width: windowWidth } = useWindowDimensions();
  const [splitLayoutMetrics, setSplitLayoutMetrics] =
    useState<AuthenticatedHomeSplitLayoutMetrics | null>(null);
  const onSplitLayoutMetricsChange = useCallback((metrics: AuthenticatedHomeSplitLayoutMetrics) => {
    setSplitLayoutMetrics((current) =>
      current?.splitRowWidthPx === metrics.splitRowWidthPx &&
      current.columnCount === metrics.columnCount &&
      current.middleColumnWidthPx === metrics.middleColumnWidthPx
        ? current
        : metrics,
    );
  }, []);
  const fallbackLayoutWidthPx = readAuthenticatedHomeLayoutWidthPx(windowWidth);
  const isWideHome = splitLayoutMetrics
    ? splitLayoutMetrics.columnCount >= 2
    : isAuthenticatedHomeWideLayoutWidthPx(fallbackLayoutWidthPx);
  const isTripleColumn = splitLayoutMetrics
    ? splitLayoutMetrics.columnCount === 3
    : isAuthenticatedHomeTripleColumnLayoutWidthPx(fallbackLayoutWidthPx);
  const aiBarDock = authenticatedHomeBottomBarDock(pathname, windowWidth, true);
  const swapActiveOnWide = isWideHome && rightPanel === "swap";
  const tradeActiveOnWide = isWideHome && rightPanel === "trade";
  const smartActiveOnWide = isWideHome && rightPanel === "smart";
  const sendActiveOnWide = isWideHome && rightPanel === "send";
  const getActiveOnWide = isWideHome && rightPanel === "get";
  const headerPanelVisibleOnWide = isWideHome && middleColumnFocus === "headerPanel";
  const messagesChatOpen =
    isWideHome && selectedMessageChat != null && middleColumnFocus === "chat";
  const tradePanelActive =
    !messagesChatOpen && headerPanelVisibleOnWide && rightPanel === "trade";
  // Left nav only switches the first column; chat pane is independent until header menu is used.
  const leftNavSelectedIndex = homeNavIndex;

  useEffect(() => {
    if (!isWideHome) {
      clearAuthenticatedHomeSelectedChat();
    }
  }, [isWideHome]);

  useEffect(() => {
    // Wide home (2- or 3-column): ensure a right pane is open (defaults to Swap).
    if (isWideHome && rightPanel == null) {
      openAuthenticatedHomeRightPanel(DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY);
    }
  }, [isWideHome, rightPanel]);

  useEffect(() => {
    // Swap entry surface is Currencies until the user opens a pair form.
    if (!isWideHome || rightPanel !== "swap") return;
    if (shouldOpenSwapCurrenciesBrowseOnSwapScreen()) {
      openSwapCurrenciesBrowse();
    }
  }, [isWideHome, rightPanel]);

  useEffect(() => {
    if (!isWideHome || rightPanel !== "swap") return;
    logPageDisplay("swap_panel_visible", {
      windowWidth,
      isTripleColumn,
      rightPanel,
      pathname,
    });
  }, [isWideHome, rightPanel, isTripleColumn, windowWidth, pathname]);

  const prevIsWideHomeRef = useRef(isWideHome);
  useEffect(() => {
    const wasWide = prevIsWideHomeRef.current;
    prevIsWideHomeRef.current = isWideHome;
    if (!wasWide || isWideHome) {
      return;
    }
    // Single-column home: main screen follows left-nav (feed/messages/…), not the wide right pane.
    const onHomePath =
      pathname == null || pathname === "" || pathname === "/" || pathname === "/home";
    if (!onHomePath) {
      router.replace("/" as any);
    }
  }, [isWideHome, pathname, router]);
  const { barHeight: bottomBarHeight, footerDockedToScreenEdge } = useBottomBarLayout();
  const embeddedAiBar = aiBarDock === "screenFooter" ? null : <GlobalBottomBar />;
  const aiSearchColumnContent =
    aiBarDock === "splitColumn3" ? <AiSearchColumnEmptyState /> : null;
  const mainColumnFooter = <MessagesColumnFooter showSearch={homeNavIndex === 1} />;
  const swapColumnFooter = <SwapColumnFooter />;
  const sendColumnFooter = <SendColumnInactiveFooter />;
  const smartColumnFooter = <SmartColumnFooter />;
  const [step, setStep] = useState<CreateStep>("idle");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [createdWalletAddress, setCreatedWalletAddress] = useState<string | null>(null);
  const [masterKeyStorageTier, setMasterKeyStorageTier] = useState<WalletMasterKeyStorageTier | null>(null);
  /** After a provisional address + server error, offer "Retry server registration" (same keys) instead of a new mnemonic. */
  const [serverOnlyRetry, setServerOnlyRetry] = useState(false);
  const provisionalWalletVisibleRef = useRef(false);
  const pendingServerRegRef = useRef<PendingServerWalletRegPayload | null>(null);
  const homeBootstrapVersion = useSyncExternalStore(
    subscribeHomeBootstrap,
    getHomeBootstrapVersion,
    getHomeBootstrapVersion,
  );
  const { provisionalAddress: provFromModule, serverRegPending: isServerRegPendingFromModule } = getHomeBootstrap();
  const applyCreatedForRegister = useCallback((a: string) => {
    setHomeBootstrap({ provisionalAddress: a });
    setCreatedWalletAddress(a);
  }, []);
  const effectiveWalletAddress =
    wallet?.wallet_address ?? createdWalletAddress ?? provFromModule;
  void homeBootstrapVersion;
  /** True only when we can actually show a wallet string (avoids "has_wallet" with no row / stale flags). */
  const hasDisplayAddress = Boolean(effectiveWalletAddress);
  const effectiveHasWallet = hasWallet || hasDisplayAddress;
  const headerDisplayName = displayName?.trim() || t("common.emDash");
  const isBrowserSessionHydrating = status === "dev" && !browserSessionChecked && !initData;
  const homePhase =
    status === "idle" || status === "loading" || isBrowserSessionHydrating
      ? "telegram_loading_or_polling"
      : status === "error"
        ? "telegram_error"
        : status === "dev"
          ? "telegram_dev_mode"
          : walletRequired && !hasDisplayAddress
            ? "wallet_setup"
            : "home_ready";

  const clearProvisionalRegistration = useCallback(() => {
    provisionalWalletVisibleRef.current = false;
    pendingServerRegRef.current = null;
    clearPendingServerRegModuleStore();
    setHomeBootstrap({ provisionalAddress: null, serverRegPending: false });
    setServerOnlyRetry(false);
  }, []);

  const createAndRegisterWalletFlow = useCallback(async () => {
    if (walletCreateModuleInFlight) {
      logPageDisplay("wallet_create_flow", { flow: "dedup_skip" });
      return;
    }
    const initDataOk = Boolean(initData && (typeof initData !== "string" || initData.trim() !== ""));
    const browserSessionOk = Boolean(telegramUsername?.trim()) && !initDataOk;
    if (!initDataOk && !browserSessionOk) {
      setFlowError("Missing sign-in credentials.");
      return;
    }
    walletCreateModuleInFlight = true;
    setFlowError(null);
    setServerOnlyRetry(false);
    lastKeyBackgroundForWalletAddress = null;
    walletRegSatisfiedBySideStatusPoll = false;
    setHomeBootstrap({ provisionalAddress: null, serverRegPending: false });
    setStep("saving");
    logPageDisplay("wallet_create_flow", { flow: "start" });
    let budgetTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const flowPromise = (async () => {
        const preRegTimeout = (label: string) =>
          new Promise<never>((_, r) => {
            setTimeout(
              () =>
                r(
                  new Error(
                    `${label} is taking too long. Update Telegram, try a different client, or tap Retry.`,
                  ),
                ),
              WALLET_PRE_REGISTER_TIMEOUT_MS,
            );
          });
        const { mnemonic, walletAddress, masterKey, envelope } = await Promise.race([
          (async () => {
            const mnemonic0 = await generateMnemonic();
            const wAddr = await deriveAddressFromMnemonic({ mnemonic: mnemonic0, testnet: false });
            const mKey = await deriveMasterKeyFromMnemonic(mnemonic0);
            const envelope0 = await buildWalletRegisterEnvelope(mnemonic0);
            return {
              mnemonic: mnemonic0,
              walletAddress: wAddr,
              masterKey: mKey,
              envelope: envelope0,
            };
          })(),
          preRegTimeout("Wallet key generation"),
        ]);
        logPageDisplay("wallet_create_flow", { flow: "pre_register_done" });

        const registerBodyPayload: Record<string, unknown> = {
          wallet_address: walletAddress,
          wallet_blockchain: "ton",
          wallet_net: "mainnet",
          type: "internal",
          label: "Main wallet",
          source: initDataOk ? "miniapp" : "browser",
          wallet_payload_ciphertext: envelope.wallet_payload_ciphertext,
          wallet_payload_nonce: envelope.wallet_payload_nonce,
          dek: envelope.dek,
        };
        if (initDataOk) {
          registerBodyPayload.initData = initData;
        }
        const registerBody = JSON.stringify(registerBodyPayload);
        const registerUrl = buildApiUrl("/api/wallet/register");
        const registerInit: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: registerBody,
        };

        const pendingPayload: PendingServerWalletRegPayload = {
          initData: initDataOk ? (initData as string) : null,
          walletAddress,
          mnemonic,
          masterKey,
          registerUrl,
          registerInit,
          registerBody,
        };
        pendingServerRegRef.current = pendingPayload;
        setPendingServerRegModuleStore(pendingPayload);
        provisionalWalletVisibleRef.current = true;
        setHomeBootstrap({ provisionalAddress: walletAddress, serverRegPending: true });
        setCreatedWalletAddress(walletAddress);
        setStep("done");
        logPageDisplay("wallet_create_flow", { flow: "local_wallet_address_ready" });

        await executeWalletServerRegistration(
          initData as string,
          walletAddress,
          registerUrl,
          registerInit,
          applyServerWalletAfterRegister,
          applyCreatedForRegister,
          setStep,
        );
        walletRegSatisfiedBySideStatusPoll = false;
        provisionalWalletVisibleRef.current = false;
        pendingServerRegRef.current = null;
        clearPendingServerRegModuleStore();
        setHomeBootstrap({ serverRegPending: false });
        setServerOnlyRetry(false);

        markWalletSecretStoredOnServer(setMasterKeyStorageTier, walletAddress);
      })();

      const budgetP = new Promise<never>((_, r) => {
        budgetTimeoutId = setTimeout(() => {
          r(
            new Error(
              "Wallet setup is taking too long. Check your connection, update Telegram, or try again.",
            ),
          );
        }, WALLET_FLOW_BUDGET_MS);
      });
      try {
        await Promise.race([flowPromise, budgetP]);
      } finally {
        if (budgetTimeoutId !== undefined) {
          clearTimeout(budgetTimeoutId);
        }
      }
    } catch (e) {
      if (walletRegSatisfiedBySideStatusPoll) {
        walletRegSatisfiedBySideStatusPoll = false;
        logPageDisplay("wallet_create_flow", {
          flow: "flow_catch_ignored",
          reason: "register_already_satisfied_by_ui_status_poll",
          message: e instanceof Error ? e.message : String(e),
        });
      } else if (provisionalWalletVisibleRef.current && isRetryableRegistrationError(e)) {
        logPageDisplay("wallet_create_flow", {
          flow: "flow_catch_keep_pending",
          message: e instanceof Error ? e.message : String(e),
          reason: "side_status_poll_continues",
        });
        /* Keep `serverRegPending` + refs so the `useEffect` status poll can finish the row. */
      } else {
        logPageDisplay("wallet_create_flow", {
          flow: "flow_catch",
          message: e instanceof Error ? e.message : String(e),
        });
        setFlowError(e instanceof Error ? e.message : "Wallet registration failed");
        setHomeBootstrap({ serverRegPending: false });
        if (provisionalWalletVisibleRef.current) {
          setStep("done");
          setServerOnlyRetry(true);
        } else {
          setStep("idle");
          setServerOnlyRetry(false);
        }
      }
    } finally {
      walletCreateModuleInFlight = false;
    }
  }, [initData, telegramUsername, applyServerWalletAfterRegister, applyCreatedForRegister]);

  const retryServerRegistrationOnly = useCallback(async () => {
    const p = pendingServerRegRef.current ?? pendingServerRegModule;
    if (!p) {
      void createAndRegisterWalletFlow();
      return;
    }
    if (walletCreateModuleInFlight) {
      logPageDisplay("wallet_create_flow", { flow: "retry_server_dedup_skip" });
      return;
    }
    walletCreateModuleInFlight = true;
    setFlowError(null);
    setHomeBootstrap({ serverRegPending: true });
    try {
      await executeWalletServerRegistration(
        p.initData,
        p.walletAddress,
        p.registerUrl,
        p.registerInit,
        applyServerWalletAfterRegister,
        applyCreatedForRegister,
        setStep,
      );
      markWalletSecretStoredOnServer(setMasterKeyStorageTier, p.walletAddress);
      clearProvisionalRegistration();
    } catch (e) {
      if (provisionalWalletVisibleRef.current && isRetryableRegistrationError(e)) {
        logPageDisplay("wallet_create_flow", {
          flow: "retry_server_catch_keep_pending",
          message: e instanceof Error ? e.message : String(e),
        });
      } else {
        logPageDisplay("wallet_create_flow", {
          flow: "retry_server_catch",
          message: e instanceof Error ? e.message : String(e),
        });
        setFlowError(e instanceof Error ? e.message : "Wallet registration failed");
        if (provisionalWalletVisibleRef.current) {
          setStep("done");
          setServerOnlyRetry(true);
        } else {
          setStep("idle");
          setServerOnlyRetry(false);
        }
        setHomeBootstrap({ serverRegPending: false });
      }
    } finally {
      walletCreateModuleInFlight = false;
    }
  }, [applyServerWalletAfterRegister, clearProvisionalRegistration, createAndRegisterWalletFlow, applyCreatedForRegister]);

  useEffect(() => {
    if (wallet?.wallet_address) {
      setHomeBootstrap({ provisionalAddress: null, serverRegPending: false });
    }
  }, [wallet?.wallet_address]);

  /**
   * `serverRegPending` is normally cleared when `executeWalletServerRegistration` resolves. The
   * underlying race can be owned by a remounted instance so it never completes even after the server
   * has the row — the “Finishing on the server” line would stick forever. Poll from the **current**
   * tree: `/api/wallet/status` (fast) plus throttled `POST /api/wallet/register` when the first
   * request 504d with no row (status alone can never “create” the row).
   */
  useEffect(() => {
    if (status !== "ok") {
      return;
    }
    if (!getHomeBootstrap().serverRegPending) {
      return;
    }
    const init = typeof initData === "string" && initData.trim() !== "" ? initData : null;
    const hasSidePollAuth = init != null || Boolean(telegramUsername?.trim());
    if (!hasSidePollAuth) {
      return;
    }
    const expectAddr = getHomeBootstrap().provisionalAddress;
    if (!expectAddr) {
      return;
    }
    logPageDisplay("wallet_create_flow", {
      flow: "side_poll_effect_armed",
      note: "status_and_throttled_register_until_row_matches",
    });

    let cancelled = false;
    let recovered = false;
    let sidePollTick = 0;
    let sidePollInFlight = false;

    const applyRecoveredRow = (row: TelegramWalletRow, via: "ui_side_status_poll" | "ui_side_register_post_retry") => {
      recovered = true;
      walletRegSatisfiedBySideStatusPoll = true;
      logPageDisplay("wallet_create_flow", {
        flow: "register_ok",
        hasServerWallet: true,
        via,
      });
      applyServerWalletAfterRegister(row);
      applyCreatedForRegister(row.wallet_address);
      const mod = pendingServerRegModule;
      if (mod && sameTonAddressForPoll(mod.walletAddress, expectAddr)) {
        markWalletSecretStoredOnServer(setMasterKeyStorageTier, mod.walletAddress);
      }
      clearPendingServerRegModuleStore();
      pendingServerRegRef.current = null;
      setHomeBootstrap({ serverRegPending: false, provisionalAddress: null });
      provisionalWalletVisibleRef.current = false;
    };

    const tick = async () => {
      if (cancelled || recovered) {
        return;
      }
      if (sidePollInFlight) {
        return;
      }
      if (!getHomeBootstrap().serverRegPending) {
        return;
      }
      sidePollInFlight = true;
      try {
        sidePollTick += 1;
        if (sidePollTick === 1) {
          logPageDisplay("wallet_create_flow", { flow: "side_poll_first_tick" });
        }

        const row = await fetchDefaultWalletStatusRow(init, WALLET_REGISTER_STATUS_FETCH_MS);
        if (cancelled || recovered) {
          return;
        }
        if (row && sameTonAddressForPoll(row.wallet_address, expectAddr)) {
          applyRecoveredRow(row, "ui_side_status_poll");
          return;
        }
        if (row && !sameTonAddressForPoll(row.wallet_address, expectAddr) && sidePollTick === 1) {
          logPageDisplay("wallet_create_flow", {
            flow: "side_status_row_other_address",
            note: "default_wallet_does_not_match_provisional",
          });
        }

        const mod = pendingServerRegModule;
        /**
         * After a gateway outage remount, `pendingServerRegModule` is often null while the UI still
         * shows the provisional address + “Finishing on the server”. Status alone cannot recreate
         * the envelope — drop the stuck pending flag so `useLayoutEffect` can start a fresh create.
         */
        if (!mod && sidePollTick >= 3) {
          logPageDisplay("wallet_create_flow", {
            flow: "side_poll_abandon_no_pending_payload",
            tick: sidePollTick,
            note: "status_reachable_but_register_payload_lost",
          });
          recovered = true;
          provisionalWalletVisibleRef.current = false;
          pendingServerRegRef.current = null;
          clearPendingServerRegModuleStore();
          setCreatedWalletAddress(null);
          setStep("idle");
          setServerOnlyRetry(false);
          setHomeBootstrap({ serverRegPending: false, provisionalAddress: null });
          return;
        }
        const shouldPostRegister =
          mod != null &&
          sameTonAddressForPoll(mod.walletAddress, expectAddr) &&
          (sidePollTick === 1 || sidePollTick % SIDE_REGISTER_RETRY_INTERVAL_TICKS === 0);
        if (!shouldPostRegister) {
          return;
        }
        if (cancelled || recovered) {
          return;
        }
        if (!getHomeBootstrap().serverRegPending) {
          return;
        }
        try {
          logPageDisplay("wallet_create_flow", {
            flow: "side_register_retry_post",
            tick: sidePollTick,
          });
          const response = await fetchWithTimeout(
            mod.registerUrl,
            mod.registerInit,
            SIDE_REGISTER_POST_TIMEOUT_MS,
          );
          const json = (await response.json().catch(() => ({}))) as {
            ok?: boolean;
            wallet?: unknown;
            error?: unknown;
          };
          if (cancelled || recovered) {
            return;
          }
          if (response.ok && json?.ok) {
            const w = registerWalletFromJson(json.wallet);
            if (w && sameTonAddressForPoll(w.wallet_address, expectAddr)) {
              applyRecoveredRow(w, "ui_side_register_post_retry");
              return;
            }
            if (w) {
              logPageDisplay("wallet_create_flow", {
                flow: "side_register_address_mismatch",
                tick: sidePollTick,
              });
            }
          }
          const errStr =
            json && typeof json === "object" && "error" in json && json.error != null
              ? String(json.error)
              : null;
          if (errStr === "kms_wrap_failed" || errStr === "kms_encrypt_failed") {
            logPageDisplay("wallet_create_flow", {
              flow: "side_register_kms_failed",
              tick: sidePollTick,
            });
            recovered = true;
            provisionalWalletVisibleRef.current = false;
            pendingServerRegRef.current = null;
            clearPendingServerRegModuleStore();
            setHomeBootstrap({ serverRegPending: false });
            setServerOnlyRetry(true);
            setFlowError(
              "Wallet encryption service (Cloud KMS) failed. Billing or KMS access may be disabled — check GCP, then tap Retry.",
            );
            setStep("done");
            return;
          }
          logPageDisplay("wallet_create_flow", {
            flow: "side_register_retry_response",
            httpStatus: response.status,
          });
        } catch {
          /* same cadence as main flow: network/timeout; next tick retries */
        }
      } finally {
        sidePollInFlight = false;
      }
    };

    const id = setInterval(() => {
      void tick();
    }, WALLET_REGISTER_POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    homeBootstrapVersion,
    initData,
    telegramUsername,
    status,
    applyServerWalletAfterRegister,
    applyCreatedForRegister,
    setMasterKeyStorageTier,
  ]);

  /** useLayoutEffect: start as soon as the home shell commits (before paint) so the flow is less likely to race hydration recovery (#418) or sit on idle+spinner. */
  useLayoutEffect(() => {
    const initDataOk = Boolean(initData && (typeof initData !== "string" || initData.trim() !== ""));
    const browserSessionOk = Boolean(telegramUsername?.trim()) && !initDataOk;
    const walletAuthOk = initDataOk || browserSessionOk;
    const guard = {
      hasFlowError: Boolean(flowError),
      status,
      walletRequired,
      hasDisplayAddress,
      step,
      initDataLen: initData == null ? 0 : typeof initData === "string" ? initData.length : -1,
      initDataOk,
      browserSessionOk,
      walletAuthOk,
    } as const;

    if (flowError) {
      logPageDisplay("wallet_start_guard", { ...guard, action: "skip_flow_error" });
      return;
    }
    if (
      status === "ok" &&
      walletRequired &&
      !hasDisplayAddress &&
      step === "idle" &&
      walletAuthOk
    ) {
      logPageDisplay("wallet_start_guard", { ...guard, action: "start" });
      void createAndRegisterWalletFlow();
    } else {
      const reasons: string[] = [];
      if (status !== "ok") {
        reasons.push("status_not_ok");
      }
      if (!walletRequired) {
        reasons.push("wallet_not_required");
      }
      if (hasDisplayAddress) {
        reasons.push("has_address");
      }
      if (step !== "idle") {
        reasons.push(`step_${step}`);
      }
      if (!walletAuthOk) {
        reasons.push("wallet_auth_missing");
      }
      logPageDisplay("wallet_start_guard", { ...guard, action: "skip_conditions", reasons });
    }
  }, [flowError, status, walletRequired, hasDisplayAddress, step, initData, telegramUsername, createAndRegisterWalletFlow]);

  /**
   * If the layout effect never started the flow (e.g. timing with deferred web root mount), kick once
   * on the next tick. Second call is a no-op while `walletCreateModuleInFlight` is true.
   */
  useEffect(() => {
    if (flowError) {
      return;
    }
    if (isWalletCreateFlowModuleLocked()) {
      return;
    }
    const initDataOk = Boolean(initData && (typeof initData !== "string" || initData.trim() !== ""));
    const browserSessionOk = Boolean(telegramUsername?.trim()) && !initDataOk;
    const walletAuthOk = initDataOk || browserSessionOk;
    if (status !== "ok" || !walletRequired || hasDisplayAddress || !walletAuthOk || step !== "idle") {
      return;
    }
    const kickTimer = setTimeout(() => {
      if (flowError) {
        return;
      }
      if (isWalletCreateFlowModuleLocked()) {
        return;
      }
      if (status !== "ok" || !walletRequired || hasDisplayAddress || !walletAuthOk || step !== "idle") {
        return;
      }
      logPageDisplay("wallet_create_flow", { flow: "effect_fallback" });
      void createAndRegisterWalletFlow();
    }, 0);
    return () => {
      clearTimeout(kickTimer);
    };
  }, [flowError, status, walletRequired, hasDisplayAddress, step, initData, telegramUsername, createAndRegisterWalletFlow]);

  useEffect(() => {
    logPageDisplay("home_authenticated_phase", {
      phase: homePhase,
      status,
      walletRequired,
      hasWallet,
      effectiveHasWallet,
      hasInitData: Boolean(initData),
      debug: {
        webAppPollCount: debug.webAppPollCount,
        initDataPollCount: debug.initDataPollCount,
        apiStatus: debug.apiStatus,
        apiMessage: debug.apiMessage,
        fetchDurationMs: debug.fetchDurationMs,
      },
    });
  }, [
    homePhase,
    status,
    walletRequired,
    hasWallet,
    effectiveHasWallet,
    initData,
    debug.webAppPollCount,
    debug.initDataPollCount,
    debug.apiStatus,
    debug.apiMessage,
    debug.fetchDurationMs,
  ]);

  if (isBrowserSessionHydrating) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (status === "idle" || status === "loading") {
    return (
      <AuthenticatedHomeChrome edgePadding={isWideHome ? "wide" : false}>
        <HomeAuthenticatedHeaderRow
          walletAddress={effectiveWalletAddress ?? ""}
          displayName={headerDisplayName}
        />
        <AuthenticatedHomePaddedBody>
          <Text style={{ marginBottom: 12, color: colors.primary }}>{t("common.loading")}</Text>
          <View
          style={{
            padding: 8,
            borderRadius: 8,
            alignSelf: "stretch",
            borderWidth: 1,
            borderColor: colors.highlight,
          }}
        >
          <Text style={[typographySansSemibold, { fontSize: 12, color: colors.primary }]}>{t("common.debug")}</Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.hasWebAppLine", { has: String(debug.hasWebAppApi), in: String(debug.inTelegramClient) })}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.webAppPollLine", { count: debug.webAppPollCount })}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.initData")}{" "}
            {debug.initDataLength != null ? String(debug.initDataLength) : t("common.emDash")}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.initDataPoll")} {debug.initDataPollCount}
          </Text>
          <Text style={{ fontSize: 10, color: colors.secondary, marginTop: 4 }}>
            {t("debug.initDataPollNoteLoading")}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.api")} {debug.apiStatus ?? t("common.emDash")} {debug.apiMessage ?? ""}
          </Text>
          {debug.apiUrl != null && (
            <Text style={{ fontSize: 10, color: colors.primary }}>
              {t("debug.url")} {debug.apiUrl}
            </Text>
          )}
          {debug.fetchDurationMs != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.fetchMs")} {debug.fetchDurationMs}
            </Text>
          )}
          {debug.lastLog != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.lastLog")} {debug.lastLog}
            </Text>
          )}
        </View>
        </AuthenticatedHomePaddedBody>
      </AuthenticatedHomeChrome>
    );
  }

  if (status === "error") {
    return (
      <AuthenticatedHomeChrome edgePadding={isWideHome ? "wide" : false}>
        <HomeAuthenticatedHeaderRow
          walletAddress={effectiveWalletAddress ?? ""}
          displayName={headerDisplayName}
        />
        <AuthenticatedHomePaddedBody>
        <Text style={[typographySansSemibold, { marginBottom: 8, color: colors.primary }]}>
          {t("home.errors.telegramRegistrationFailed")}
        </Text>
        <Text style={{ textAlign: "center", marginBottom: 12, color: colors.primary }}>{error}</Text>
        <View
          style={{
            marginTop: 8,
            padding: 8,
            borderRadius: 8,
            alignSelf: "stretch",
            borderWidth: 1,
            borderColor: colors.highlight,
          }}
        >
          <Text style={[typographySansSemibold, { fontSize: 12, color: colors.primary }]}>{t("common.debug")}</Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.hasWebAppLine", { has: String(debug.hasWebAppApi), in: String(debug.inTelegramClient) })} ·{" "}
            {t("debug.initData")}{" "}
            {debug.initDataLength ?? t("common.emDash")}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.webAppInitLine", { web: String(debug.webAppPollCount), init: String(debug.initDataPollCount) })}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.api")} {debug.apiStatus ?? t("common.emDash")} {debug.apiMessage ?? ""}
          </Text>
          {debug.apiUrl != null && (
            <Text style={{ fontSize: 10, color: colors.primary }}>
              {t("debug.url")} {debug.apiUrl}
            </Text>
          )}
          {debug.fetchDurationMs != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.fetchMs")} {debug.fetchDurationMs}
            </Text>
          )}
          {debug.lastLog != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.lastLog")} {debug.lastLog}
            </Text>
          )}
        </View>
        </AuthenticatedHomePaddedBody>
      </AuthenticatedHomeChrome>
    );
  }

  if (status === "dev") {
    return (
      <AuthenticatedHomeChrome edgePadding={isWideHome ? "wide" : false}>
        <HomeAuthenticatedHeaderRow
          walletAddress={effectiveWalletAddress ?? ""}
          displayName={headerDisplayName}
        />
        <AuthenticatedHomePaddedBody>
        <Text style={[typographySansSemibold, { marginBottom: 8, color: colors.primary }]}>
          {t("home.dev.productTitle")}
        </Text>
        <Text style={{ textAlign: "center", marginBottom: 12, color: colors.primary }}>
          {t("home.dev.outsideTelegram")}
        </Text>
        <View
          style={{
            marginTop: 8,
            padding: 8,
            borderRadius: 8,
            alignSelf: "stretch",
            borderWidth: 1,
            borderColor: colors.highlight,
          }}
        >
          <Text style={[typographySansSemibold, { fontSize: 12, color: colors.primary }]}>{t("common.debug")}</Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.hasWebAppLine", { has: String(debug.hasWebAppApi), in: String(debug.inTelegramClient) })}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {tf("debug.webAppPollLine", { count: debug.webAppPollCount })}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.initData")}{" "}
            {debug.initDataLength != null ? String(debug.initDataLength) : t("common.emDash")}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.initDataPoll")} {debug.initDataPollCount}
          </Text>
          <Text style={{ fontSize: 10, color: colors.secondary, marginTop: 4 }}>
            {t("debug.initDataPollNoteError")}
          </Text>
          <Text style={{ fontSize: 11, color: colors.primary }}>
            {t("debug.api")} {debug.apiStatus ?? t("common.emDash")} {debug.apiMessage ?? ""}
          </Text>
          {debug.apiUrl != null && (
            <Text style={{ fontSize: 10, color: colors.primary }}>
              {t("debug.url")} {debug.apiUrl}
            </Text>
          )}
          {debug.fetchDurationMs != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.fetchMs")} {debug.fetchDurationMs}
            </Text>
          )}
          {debug.lastLog != null && (
            <Text style={{ fontSize: 11, color: colors.primary }}>
              {t("debug.lastLog")} {debug.lastLog}
            </Text>
          )}
        </View>
        </AuthenticatedHomePaddedBody>
      </AuthenticatedHomeChrome>
    );
  }

  /**
   * Spinner only during local key generation (before the derived address is set). Server registration
   * runs with the address already on screen and uses the module `serverRegPending` flag for a secondary hint.
   */
  const showWalletProvisioning =
    status === "ok" &&
    !flowError &&
    !hasDisplayAddress &&
    walletRequired &&
    step === "saving";

  const homeMainColumnInsetStyle = {
    paddingHorizontal: layout.contentSideInsetPx,
    paddingBottom: layout.contentSideInsetPx,
  } as const;
  /** Wide left column: list panels own top inset; no extra scroll padding. */
  const homeWideScrollContentStyle = {
    ...homeMainColumnInsetStyle,
    paddingTop: 0,
  } as const;
  /** Compact: vertical chrome insets scroll with the main column. */
  const homeCompactScrollContentStyle = {
    flexGrow: 0,
    // Header/nav are pinned above the scroll in one-column mode — no extra top inset here.
    paddingTop: 0,
    paddingBottom:
      layout.authenticatedHome.contentInsetBottom +
      (!isWideHome
        ? // Messages footer + AI bar overlay the scroll; keep last rows clear of both.
          layout.bottomBar.barMinHeight * 2
        : 0),
    // Do not flexGrow during search — that stretched the list and left a large gap
    // between results and the search field.
  } as const;
  const homeLeftScrollContentStyle = isWideHome
    ? {
        ...homeWideScrollContentStyle,
      }
    : homeCompactScrollContentStyle;

  const homeMainColumnBlocks = (
    <>
      <AuthenticatedHomePersistedPanelSlot active={homeNavIndex === 0} fillActive={!messagesSearchScrollMode}>
        <AuthenticatedHomeFeedPanel colors={colors} scrollable={false} />
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={homeNavIndex === 1} fillActive={!messagesSearchScrollMode}>
        <AuthenticatedHomeMessagesPanel colors={colors} scrollable={false} />
      </AuthenticatedHomePersistedPanelSlot>
      {flowError ? (
        <View style={{ width: "100%", alignItems: "center", alignSelf: "stretch", marginTop: 8, gap: 8 }}>
          <Text style={{ textAlign: "center", color: "#b00020", lineHeight: 22 }}>
            {translateFlowError(flowError)}
          </Text>
          {serverOnlyRetry ? (
            <Button title={t("home.wallet.retryServerRegistration")} onPress={retryServerRegistrationOnly} />
          ) : (
            <Button title={t("home.wallet.retryWalletCreation")} onPress={createAndRegisterWalletFlow} />
          )}
        </View>
      ) : null}
      {showWalletProvisioning ? (
        <View
          style={{ marginTop: 12, marginBottom: 4, maxWidth: 360, alignItems: "center", gap: 8, alignSelf: "center" }}
        >
          <ActivityIndicator size="small" color={colors.primary} />
          <Text
            style={{
              textAlign: "center",
              fontSize: 13,
              lineHeight: 20,
              color: colors.secondary,
            }}
          >
            {t("home.wallet.generatingKeys")}
          </Text>
        </View>
      ) : null}
      {!flowError && isServerRegPendingFromModule && effectiveWalletAddress ? (
        <View style={{ marginTop: 10, maxWidth: 360, alignItems: "center", alignSelf: "center" }}>
          <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: 6 }} />
          <Text style={{ textAlign: "center", fontSize: 12, lineHeight: 18, color: colors.secondary }}>
            {t("home.wallet.finishingServer")}
          </Text>
        </View>
      ) : null}
      {masterKeyStorageTier === "server" ? (
        <Text
          style={{
            marginTop: 14,
            fontSize: 12,
            color: colors.secondary,
            textAlign: "center",
            paddingHorizontal: 8,
          }}
        >
          {t("home.wallet.backupKmsNote")}
        </Text>
      ) : null}
    </>
  );

  const homeLeftNavStrip = (
    <AuthenticatedHomeLeftNavStrip
      colors={colors}
      selectedIndex={leftNavSelectedIndex}
      onSelectIndex={setAuthenticatedHomeLeftNavIndex}
    />
  );

  const homeHeaderRow = (
    <HomeAuthenticatedHeaderRow
      walletAddress={effectiveWalletAddress ?? ""}
      displayName={headerDisplayName}
      layoutIsWide={isWideHome}
        activeHeaderMenuKey={
          messagesChatOpen
            ? null
            : headerPanelVisibleOnWide && swapActiveOnWide
            ? "swap"
            : headerPanelVisibleOnWide && smartActiveOnWide
              ? "smart"
              : headerPanelVisibleOnWide && tradeActiveOnWide
                ? "trade"
                : headerPanelVisibleOnWide && sendActiveOnWide
                  ? "send"
                  : headerPanelVisibleOnWide && getActiveOnWide
                    ? "get"
                    : null
        }
    />
  );

  /**
   * Compact: wallet header → nav strip → feed scroll inside one column (header/nav pinned above scroll).
   * Wide: header pinned in chrome; nav pinned; feed scrolls in the left column only.
   */
  const homeLeftScrollShell = (scrollColumn: ReactNode) => (
    <View style={{ flex: 1, minHeight: 0, position: "relative" }}>
      {scrollColumn}
      {showChatListBottomLoader ? (
        <MessageChatOlderHistoryLoadLine active edge="bottom" color={colors.accent} />
      ) : null}
    </View>
  );

  /**
   * Compact: pin wallet header + nav above the scroll so search results move under them.
   * Wide: nav pinned beside the scroll; panels stay the sole scroll child so wide↔narrow
   * does not remount feed/messages state.
   */
  const homeLeftColumn = (
    <>
      {isWideHome ? homeLeftNavStrip : null}
      {!isWideHome ? (
        <View style={{ paddingTop: layout.authenticatedHome.contentInsetTop, width: "100%" }}>
          {homeHeaderRow}
        </View>
      ) : null}
      {!isWideHome ? homeLeftNavStrip : null}
      {homeLeftScrollShell(
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={homeLeftScrollContentStyle}
          initialScrollPosition={messagesSearchScrollMode ? "bottom" : "top"}
          stickToBottomOnResize={messagesSearchScrollMode}
          nearBottomThresholdPx={240}
          onNearBottom={handleHomeLeftScrollNearBottom}
          onScrollPositionChange={handleHomeLeftScrollPositionChange}
          scrollControllerRef={homeLeftScrollRef}
          // Wide: thumb sits on the column seam divider (music-bar style overlay).
          scrollbarRightInsetPx={isWideHome ? 0 : layout.scrollIndicatorRightInsetPx}
          indicatorColor={colors.accent}
        >
          <View style={isWideHome ? undefined : homeMainColumnInsetStyle}>{homeMainColumnBlocks}</View>
        </HspScrollColumn>,
      )}
    </>
  );

  const homeWideRightColumn = (
    <View
      style={{
        flex: 1,
        width: "100%",
        alignSelf: "stretch",
        minHeight: 0,
      }}
    >
      <AuthenticatedHomePersistedPanelSlot active={messagesChatOpen}>
        {selectedMessageChat ? (
          <MessageChatPanel chat={selectedMessageChat} colors={colors} visible={messagesChatOpen} />
        ) : null}
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={!messagesChatOpen && headerPanelVisibleOnWide && rightPanel === "swap"}>
        <View
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "stretch",
            minHeight: 0,
          }}
        >
          <AuthenticatedHomePersistedPanelSlot active={swapCurrencySide == null}>
            <SwapPanelContent />
          </AuthenticatedHomePersistedPanelSlot>
          <AuthenticatedHomePersistedPanelSlot active={swapCurrencySide != null}>
            <ChooseCurrencyPanelContent walletAddress={effectiveWalletAddress ?? null} />
          </AuthenticatedHomePersistedPanelSlot>
        </View>
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={tradePanelActive}>
        <View
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "stretch",
            minHeight: 0,
          }}
        >
          <TradePanelContent isActive={tradePanelActive} />
        </View>
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={!messagesChatOpen && headerPanelVisibleOnWide && rightPanel === "smart"}>
        <View
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "stretch",
            minHeight: 0,
          }}
        >
          <SmartPanelContent />
        </View>
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={!messagesChatOpen && headerPanelVisibleOnWide && rightPanel === "send"}>
        <View
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "stretch",
            minHeight: 0,
          }}
        >
          <SendPanelContent />
        </View>
      </AuthenticatedHomePersistedPanelSlot>
      <AuthenticatedHomePersistedPanelSlot active={!messagesChatOpen && headerPanelVisibleOnWide && rightPanel === "get"}>
        <View
          style={{
            flex: 1,
            width: "100%",
            alignSelf: "stretch",
            minHeight: 0,
          }}
        >
          <GetPanelContent
            showTitleRow={!isWideHome}
            walletAddress={effectiveWalletAddress ?? ""}
            displayName={headerDisplayName}
          />
        </View>
      </AuthenticatedHomePersistedPanelSlot>
    </View>
  );

  return (
    <>
      <AuthenticatedHomeChrome
        header={isWideHome ? homeHeaderRow : null}
        belowHeader={null}
        edgePadding={isWideHome ? "wide" : false}
      >
        <AuthenticatedHomeSplitBody
          onSplitLayoutMetricsChange={onSplitLayoutMetricsChange}
          leftColumnFooter={isWideHome ? mainColumnFooter : null}
          farRight={aiSearchColumnContent}
          left={homeLeftColumn}
          right={homeWideRightColumn}
          middleColumnFooter={
            messagesChatOpen
              ? isTripleColumn && selectedMessageChat?.chat_kind !== "channel"
                ? <MessageChatWriteBottomBar />
                : !isTripleColumn
                  ? embeddedAiBar
                  : null
              : headerPanelVisibleOnWide && sendActiveOnWide
              ? isTripleColumn
                ? sendColumnFooter
                : embeddedAiBar
              : headerPanelVisibleOnWide && tradeActiveOnWide
                ? isTripleColumn
                  ? null
                  : embeddedAiBar
              : headerPanelVisibleOnWide && swapActiveOnWide
                ? isTripleColumn
                  ? swapColumnFooter
                  : embeddedAiBar
                : headerPanelVisibleOnWide && smartActiveOnWide
                  ? isTripleColumn
                    ? smartColumnFooter
                    : embeddedAiBar
                  : aiBarDock === "splitColumn2"
                    ? embeddedAiBar
                    : null
          }
          thirdColumnFooter={aiBarDock === "splitColumn3" ? embeddedAiBar : null}
        />
      </AuthenticatedHomeChrome>
      {!isWideHome ? (
        <View
          pointerEvents="box-none"
          style={{
            position: Platform.OS === "web" ? ("fixed" as unknown as "absolute") : "absolute",
            left: 0,
            right: 0,
            bottom:
              bottomBarHeight +
              layout.bottomBar.topRuleHeightPx +
              (footerDockedToScreenEdge ? layout.bottomBar.bottomRuleHeightPx : 0),
            width: "100%",
            zIndex: 998,
          }}
        >
          {mainColumnFooter}
        </View>
      ) : null}
    </>
  );
}

