import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buildApiUrl } from "../../api/_base";
import { resetTelegramEmojiFetchCaches } from "../components/messages/fetchTelegramEmojiBytes";
import { useAuth } from "../../auth/AuthContext";
import { logPageDisplay } from "../pageDisplayLog";
import { TelegramConnectSheet } from "../components/TelegramConnectSheet";
import { getApiBaseUrl } from "../../api/_base";
import { logTelegramConnect } from "./telegramConnectDebug";
import { mtprotoUseCurrentPhoneNumberForCode } from "./mtprotoPhoneCodeDelivery";
import { type ConnectCodeDeliveryInfo } from "./formatConnectCodeDelivery";
import {
  clearStoredMtprotoConnect,
  readStoredMtprotoConnect,
  writeStoredMtprotoConnect,
  type StoredMtprotoConnect,
} from "./mtprotoConnectSessionStorage";

export type MtprotoAuthMethod = "qr" | "phone";

export type MtprotoAuthState =
  | "idle"
  | "initializing"
  | "wait_qr"
  | "wait_phone"
  | "wait_code"
  | "wait_password"
  | "ready"
  | "failed";

type TelegramMessagesConnectionCtx = {
  isTelegramMessagesConnected: boolean;
  /** TDLib `getMe` user id when messages are connected. */
  connectedTelegramUserId: number | null;
  /** Bumps when Telegram connects so inline emoji components refetch sticker bytes. */
  emojiFetchEpoch: number;
  connectPending: boolean;
  connectSheetVisible: boolean;
  /** True after MTProto auth succeeds — sheet shows checkmark until chats are loaded. */
  connectSuccessSyncing: boolean;
  connectAuthState: MtprotoAuthState;
  connectAuthMethod: MtprotoAuthMethod;
  connectQrLink: string | null;
  connectError: string | null;
  connectCodeDelivery: ConnectCodeDeliveryInfo | null;
  openConnectSheet: (opts?: { addAccount?: boolean }) => void;
  closeConnectSheet: () => void;
  refreshStatus: () => Promise<void>;
  /**
   * When chats/resync return `not_connected`, silently resume the on-disk TDLib
   * session and re-mark the product link (avoids empty chat list after tab hops).
   */
  recoverTelegramMessagesSession: () => Promise<boolean>;
  beginMtprotoConnect: (options?: {
    fresh?: boolean;
    addAccount?: boolean;
    authMethod?: MtprotoAuthMethod;
    /** Phone switch: keep code/phone UI instead of QR loading spinner */
    soft?: boolean;
  }) => Promise<void>;
  switchMessengerAccount: (slot: number) => Promise<boolean>;
  /** Current TDLib messenger slot after connect / switch. */
  activeMessengerSlot: number;
  submitMtprotoPhone: (phoneNumber: string) => Promise<void>;
  submitMtprotoCode: (code: string) => Promise<void>;
  resendMtprotoCode: () => Promise<void>;
  submitMtprotoPassword: (password: string) => Promise<void>;
  switchToQrConnect: () => Promise<void>;
  disconnectTelegramMessages: () => Promise<void>;
};

const TelegramMessagesConnectionContext = createContext<TelegramMessagesConnectionCtx | null>(null);

function phoneAuthState(state: MtprotoAuthState): boolean {
  return state === "wait_phone" || state === "wait_code" || state === "wait_password";
}

function normalizeRestoredConnectSession(stored: StoredMtprotoConnect): StoredMtprotoConnect {
  if (phoneAuthState(stored.authState) && stored.authMethod !== "phone") {
    return { ...stored, authMethod: "phone" };
  }
  return stored;
}

const POLL_MS = 2000;
const GATEWAY_WARMUP_FAIL_BACKOFF_MS = 45_000;

function isPhoneAuthRegression(current: MtprotoAuthState, next: MtprotoAuthState): boolean {
  if (next === "failed" || next === "ready") return false;
  const advanced = new Set<MtprotoAuthState>(["wait_code", "wait_password"]);
  const regressions = new Set<MtprotoAuthState>(["idle", "initializing", "wait_qr"]);
  return advanced.has(current) && regressions.has(next);
}

function isMidConnectAuth(state: MtprotoAuthState): boolean {
  return (
    state === "initializing" ||
    state === "wait_qr" ||
    state === "wait_phone" ||
    state === "wait_code" ||
    state === "wait_password"
  );
}

export function TelegramMessagesConnectionProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, authReady, sessionTelegramMessagesConnected } = useAuth();
  const [isTelegramMessagesConnected, setConnected] = useState(false);
  const [connectedTelegramUserId, setConnectedTelegramUserId] = useState<number | null>(null);
  const [emojiFetchEpoch, setEmojiFetchEpoch] = useState(0);
  const [connectPending, setConnectPending] = useState(false);
  const [connectSheetVisible, setConnectSheetVisible] = useState(false);
  const [connectSuccessSyncing, setConnectSuccessSyncing] = useState(false);
  const [connectAuthState, setConnectAuthState] = useState<MtprotoAuthState>("idle");
  const [connectAuthMethod, setConnectAuthMethod] = useState<MtprotoAuthMethod>("qr");
  const [connectQrLink, setConnectQrLink] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectCodeDelivery, setConnectCodeDelivery] = useState<ConnectCodeDeliveryInfo | null>(null);
  const connectAddAccountRef = useRef(false);
  const lastMessengerSlotRef = useRef<number>(0);
  const [activeMessengerSlot, setActiveMessengerSlot] = useState(0);
  const attemptIdRef = useRef<string | null>(null);
  const connectAuthStateRef = useRef<MtprotoAuthState>("idle");
  const connectAuthMethodRef = useRef<MtprotoAuthMethod>("qr");
  const pollGenerationRef = useRef(0);
  const connectStartGenerationRef = useRef(0);
  const lastCodeDeliveryLogRef = useRef<string | null>(null);
  const connectStartAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const warmupInFlightRef = useRef(false);
  const reconnectInFlightRef = useRef(false);
  const wasTelegramConnectedRef = useRef(false);
  /** Mirrors `isTelegramMessagesConnected` for async recover/warmup without stale closures. */
  const connectedRef = useRef(false);
  const connectSheetVisibleRef = useRef(false);
  const connectSuccessSyncingRef = useRef(false);
  const connectSuccessShownAtRef = useRef(0);
  const connectSuccessDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** After status confirms DB link is gone, back off silent warmup (avoids 403 spam loops). */
  const notConnectedBackoffUntilRef = useRef(0);
  /** Blocks silent resume until auth session reflects logout. */
  const explicitDisconnectRef = useRef(false);
  const sessionTelegramMessagesConnectedRef = useRef(sessionTelegramMessagesConnected);

  useEffect(() => {
    sessionTelegramMessagesConnectedRef.current = sessionTelegramMessagesConnected;
    if (sessionTelegramMessagesConnected === false) {
      explicitDisconnectRef.current = false;
    }
  }, [sessionTelegramMessagesConnected]);

  const bumpEmojiFetchEpoch = useCallback(() => {
    resetTelegramEmojiFetchCaches();
    setEmojiFetchEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    connectedRef.current = isTelegramMessagesConnected;
    if (isTelegramMessagesConnected && !wasTelegramConnectedRef.current) {
      bumpEmojiFetchEpoch();
    }
    wasTelegramConnectedRef.current = isTelegramMessagesConnected;
  }, [bumpEmojiFetchEpoch, isTelegramMessagesConnected]);

  useEffect(() => {
    connectSheetVisibleRef.current = connectSheetVisible;
  }, [connectSheetVisible]);

  useEffect(() => {
    connectSuccessSyncingRef.current = connectSuccessSyncing;
  }, [connectSuccessSyncing]);

  const clearConnectSuccessDismissTimer = useCallback(() => {
    if (connectSuccessDismissTimerRef.current) {
      clearTimeout(connectSuccessDismissTimerRef.current);
      connectSuccessDismissTimerRef.current = null;
    }
  }, []);

  const dismissConnectSuccessSheet = useCallback(() => {
    clearConnectSuccessDismissTimer();
    connectSuccessSyncingRef.current = false;
    setConnectSuccessSyncing(false);
    setConnectSheetVisible(false);
    connectAuthStateRef.current = "idle";
    setConnectAuthState("idle");
    logTelegramConnect("connect_success_sheet_dismissed");
  }, [clearConnectSuccessDismissTimer]);

  const scheduleConnectSuccessDismiss = useCallback(
    (delayMs: number) => {
      clearConnectSuccessDismissTimer();
      connectSuccessDismissTimerRef.current = setTimeout(() => {
        connectSuccessDismissTimerRef.current = null;
        if (connectSuccessSyncingRef.current) {
          dismissConnectSuccessSheet();
        }
      }, delayMs);
    },
    [clearConnectSuccessDismissTimer, dismissConnectSuccessSheet],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChatsLoaded = (event: Event) => {
      if (!connectSuccessSyncingRef.current) return;
      const count = Number((event as CustomEvent<{ count?: number }>).detail?.count ?? 0);
      if (count <= 0) return;
      const elapsed = Date.now() - connectSuccessShownAtRef.current;
      const minVisibleMs = 1200;
      scheduleConnectSuccessDismiss(Math.max(0, minVisibleMs - elapsed));
      logTelegramConnect("connect_success_chats_ready", { count, elapsedMs: elapsed });
    };
    document.addEventListener("hsp-telegram-chats-loaded", onChatsLoaded);
    return () => document.removeEventListener("hsp-telegram-chats-loaded", onChatsLoaded);
  }, [scheduleConnectSuccessDismiss]);

  useEffect(() => () => clearConnectSuccessDismissTimer(), [clearConnectSuccessDismissTimer]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const lastKnownTelegramUserIdRef = useRef<number | null>(null);

  const refreshStatusInner = useCallback(async (): Promise<boolean> => {
    logTelegramConnect("refresh_status_start", { isAuthenticated, authReady });
    if (!isAuthenticated) {
      setConnected(false);
      setConnectedTelegramUserId(null);
      lastKnownTelegramUserIdRef.current = null;
      return false;
    }
    const statusUrl = buildApiUrl("/api/telegram-messages-status");
    try {
      const response = await fetch(statusUrl, { method: "GET", credentials: "include" });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        connected?: boolean;
        telegram_user_id?: number | null;
      };
      const linked = response.ok && json.ok === true && json.connected === true;
      // Only demote here. Promoting to connected requires gatewayReady (silent warmup)
      // or a successful MTProto connect — otherwise empty chats + Menu footer appear while
      // the gateway is still dead (504 / session_not_ready).
      if (!linked) {
        setConnected(false);
      }
      const userIdRaw = Number(json.telegram_user_id);
      const nextUserId =
        Number.isFinite(userIdRaw) && userIdRaw > 0 ? Math.trunc(userIdRaw) : null;
      if (linked && nextUserId != null) {
        lastKnownTelegramUserIdRef.current = nextUserId;
        setConnectedTelegramUserId(nextUserId);
      } else if (linked) {
        setConnectedTelegramUserId(lastKnownTelegramUserIdRef.current);
      } else if (sessionTelegramMessagesConnectedRef.current === true) {
        // Keep last known id for side-menu avatar while silent resume runs.
        setConnectedTelegramUserId(lastKnownTelegramUserIdRef.current);
      } else {
        lastKnownTelegramUserIdRef.current = null;
        setConnectedTelegramUserId(null);
      }
      logTelegramConnect("refresh_status_ok", { connected: linked, status: response.status, url: statusUrl });
      logPageDisplay("telegram_messages_status", { connected: linked, status: response.status });
      return linked;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("refresh_status_error", { message, url: statusUrl });
      // Transient network errors must not drop a live link (TMA tab hops).
      return false;
    }
  }, [isAuthenticated, authReady]);

  const attemptSilentMtprotoResumeRef = useRef<(() => Promise<boolean>) | null>(null);

  const markGatewayWarmupFailed = useCallback((reason: string) => {
    logTelegramConnect("silent_warmup_give_up", { reason });
    notConnectedBackoffUntilRef.current = Date.now() + GATEWAY_WARMUP_FAIL_BACKOFF_MS;
    setConnected(false);
  }, []);

  const silentWarmupSession = useCallback(async (): Promise<boolean> => {
    if (warmupInFlightRef.current) return connectedRef.current;
    if (explicitDisconnectRef.current || sessionTelegramMessagesConnectedRef.current !== true) {
      return false;
    }
    if (Date.now() < notConnectedBackoffUntilRef.current) return connectedRef.current;
    // Do not fight an open QR/password sheet — resume/warmup restarts hide Connect.
    if (connectSheetVisibleRef.current || isMidConnectAuth(connectAuthStateRef.current)) {
      logTelegramConnect("silent_warmup_skip_mid_connect", {
        sheetVisible: connectSheetVisibleRef.current,
        authState: connectAuthStateRef.current,
      });
      return connectedRef.current;
    }
    warmupInFlightRef.current = true;
    logTelegramConnect("silent_warmup_start");
    try {
      const maxAttempts = 5;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (connectSheetVisibleRef.current || isMidConnectAuth(connectAuthStateRef.current)) {
          logTelegramConnect("silent_warmup_abort_mid_connect", {
            attempt: attempt + 1,
            authState: connectAuthStateRef.current,
          });
          return connectedRef.current;
        }
        const response = await fetch(buildApiUrl("/api/telegram-messages-warmup"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const json = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          connected?: boolean;
          gatewayReady?: boolean;
          needsReconnect?: boolean;
          warming?: boolean;
          authState?: string;
          error?: string | null;
        };
        logTelegramConnect("silent_warmup_done", {
          attempt: attempt + 1,
          ok: json.ok ?? false,
          gatewayReady: json.gatewayReady ?? false,
          warming: json.warming ?? false,
          authState: json.authState ?? null,
          error: json.error ?? null,
          status: response.status,
        });
        // Vercel/proxy timeouts leave an empty body — never treat that as connected.
        if (response.status >= 500) {
          logTelegramConnect("silent_warmup_gateway_timeout", {
            attempt: attempt + 1,
            status: response.status,
          });
          if (attempt + 1 < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            continue;
          }
          markGatewayWarmupFailed("http_5xx");
          return false;
        }
        if (json.needsReconnect) {
          logTelegramConnect("silent_warmup_needs_reconnect", { error: json.error ?? null });
          const resumed = await attemptSilentMtprotoResumeRef.current?.();
          if (resumed && attempt + 1 < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            continue;
          }
          markGatewayWarmupFailed(json.error ?? "needs_reconnect");
          return false;
        }
        if (response.status === 403 && json.error === "not_connected") {
          // Only silent-resume when the product session still says linked.
          // Otherwise a fresh QR attempt starts (wait_qr) with the sheet closed
          // and the Connect footer never appears.
          if (sessionTelegramMessagesConnected === true && attempt + 1 < maxAttempts) {
            const stillLinked = await refreshStatusInner();
            if (stillLinked) {
              await new Promise((resolve) => setTimeout(resolve, 800));
              continue;
            }
            logTelegramConnect("silent_warmup_not_connected_try_resume", {
              attempt: attempt + 1,
            });
            const resumed = await attemptSilentMtprotoResumeRef.current?.();
            if (resumed) {
              notConnectedBackoffUntilRef.current = 0;
              await new Promise((resolve) => setTimeout(resolve, 800));
              continue;
            }
          }
          logTelegramConnect("silent_warmup_not_connected_confirmed", {
            attempt: attempt + 1,
          });
          notConnectedBackoffUntilRef.current = Date.now() + 60_000;
          setConnected(false);
          return false;
        }
        if (json.connected === false) {
          setConnected(false);
          return false;
        }
        if (json.gatewayReady) {
          notConnectedBackoffUntilRef.current = 0;
          setConnected(true);
          connectedRef.current = true;
          logPageDisplay("telegram_messages_gateway_ready");
          void import("../authenticatedHomeSelectedChat").then(({ getAuthenticatedHomeSelectedChatSnapshot }) => {
            const chat = getAuthenticatedHomeSelectedChatSnapshot();
            if (!chat) return;
            void import("../messageChatHistoryPrefetch").then(({ prefetchChatHistoryPriority }) => {
              prefetchChatHistoryPriority(chat);
            });
          });
          return true;
        }
        if (
          (json.warming ||
            json.error === "session_restoring" ||
            json.error === "warmup_timeout" ||
            json.error === "session_not_ready") &&
          attempt + 1 < maxAttempts
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, json.error === "session_restoring" ? 1_200 : 800),
          );
          continue;
        }
        // Linked in DB but gateway never became ready — try one silent resume, then Connect.
        logTelegramConnect("silent_warmup_try_resume_after_timeout", {
          attempt: attempt + 1,
          error: json.error ?? null,
        });
        const resumed = await attemptSilentMtprotoResumeRef.current?.();
        if (resumed) {
          notConnectedBackoffUntilRef.current = 0;
          setConnected(true);
          connectedRef.current = true;
          return true;
        }
        markGatewayWarmupFailed(json.error ?? "session_not_ready");
        return false;
      }
      // Exhausted warming polls — last-chance silent resume before Connect CTA.
      const resumed = await attemptSilentMtprotoResumeRef.current?.();
      if (resumed) {
        notConnectedBackoffUntilRef.current = 0;
        setConnected(true);
        connectedRef.current = true;
        return true;
      }
      markGatewayWarmupFailed("warmup_exhausted");
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("silent_warmup_error", { message });
      markGatewayWarmupFailed("warmup_exception");
      return false;
    } finally {
      warmupInFlightRef.current = false;
    }
  }, [markGatewayWarmupFailed, refreshStatusInner, sessionTelegramMessagesConnected]);

  const applyConnectSnapshot = useCallback(
    (json: {
      ok?: boolean;
      authState?: string;
      qrLink?: string | null;
      error?: string | null;
      attemptId?: string | null;
      chatCount?: number | null;
      messengerSlot?: number | null;
      codeDelivery?: ConnectCodeDeliveryInfo | null;
    }) => {
      if (json.attemptId) attemptIdRef.current = json.attemptId;
      if (typeof json.messengerSlot === "number" && Number.isFinite(json.messengerSlot)) {
        const slot = Math.floor(json.messengerSlot);
        lastMessengerSlotRef.current = slot;
        setActiveMessengerSlot(slot);
      }
      const state = json.authState ? (json.authState as MtprotoAuthState) : null;
      if (json.codeDelivery) {
        setConnectCodeDelivery(json.codeDelivery);
        const deliveryKey = JSON.stringify(json.codeDelivery);
        if (deliveryKey !== lastCodeDeliveryLogRef.current) {
          lastCodeDeliveryLogRef.current = deliveryKey;
          logTelegramConnect("connect_code_delivery", json.codeDelivery);
        }
      } else if (state !== "wait_code" && state !== "wait_password") {
        setConnectCodeDelivery(null);
        lastCodeDeliveryLogRef.current = null;
      }
      if (state) {
        const current = connectAuthStateRef.current;
        if (
          isPhoneAuthRegression(current, state) &&
          connectAuthMethodRef.current === "phone"
        ) {
          logTelegramConnect("connect_snapshot_ignored_regression", { current, next: state });
          return;
        }
        setConnectAuthState(state);
        connectAuthStateRef.current = state;
      }
      if (json.qrLink && connectAuthMethodRef.current === "qr") {
        setConnectQrLink(json.qrLink);
      } else if (state === "ready" || state === "failed" || state === "idle") {
        setConnectQrLink(null);
      }
      setConnectError(json.error ?? (json.ok === false ? "connect_failed" : null));

      if (state === "ready") {
        if (explicitDisconnectRef.current) {
          logTelegramConnect("connect_success_ignored_after_disconnect");
          stopPolling();
          attemptIdRef.current = null;
          clearStoredMtprotoConnect();
          connectAuthStateRef.current = "idle";
          setConnectAuthState("idle");
          return;
        }
        notConnectedBackoffUntilRef.current = 0;
        explicitDisconnectRef.current = false;
        connectedRef.current = true;
        setConnected(true);
        const userInitiatedConnect =
          connectSheetVisibleRef.current || isMidConnectAuth(connectAuthStateRef.current);
        if (userInitiatedConnect) {
          connectSuccessShownAtRef.current = Date.now();
          setConnectSuccessSyncing(true);
          setConnectSheetVisible(true);
          scheduleConnectSuccessDismiss(45_000);
        } else {
          setConnectSheetVisible(false);
        }
        stopPolling();
        clearStoredMtprotoConnect();
        setConnectCodeDelivery(null);
        logTelegramConnect("connect_success", { chatCount: json.chatCount ?? null });
        logPageDisplay("telegram_messages_connected");
        if (typeof document !== "undefined") {
          document.dispatchEvent(new CustomEvent("hsp-auth-session-updated"));
        }
        void refreshStatusInner();
        if (!userInitiatedConnect) {
          connectAuthStateRef.current = "idle";
          setConnectAuthState("idle");
        }
      } else if (state === "failed") {
        stopPolling();
        clearStoredMtprotoConnect();
      } else if (state && isMidConnectAuth(state) && attemptIdRef.current) {
        writeStoredMtprotoConnect({
          attemptId: attemptIdRef.current,
          authState: state,
          authMethod: connectAuthMethodRef.current,
        });
      }
    },
    [stopPolling, refreshStatusInner, scheduleConnectSuccessDismiss],
  );

  const pollConnectStatus = useCallback(async () => {
    const generation = pollGenerationRef.current;
    const attemptId = attemptIdRef.current;
    if (!attemptId) return;
    const url = buildApiUrl(
      `/api/telegram-mtproto-connect-status?attemptId=${encodeURIComponent(attemptId)}`,
    );
    try {
      const response = await fetch(url, { method: "GET", credentials: "include" });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authState?: string;
        qrLink?: string | null;
        error?: string | null;
        chatCount?: number | null;
      };
      logTelegramConnect("connect_poll", {
        status: response.status,
        authState: json.authState ?? null,
        error: json.error ?? null,
      });
      if (generation !== pollGenerationRef.current) return;
      // Gateway lost the in-memory attempt (restart / race). Do not keep polling a dead id.
      if (
        response.status === 404 ||
        json.error === "attempt_not_found" ||
        json.error === "not_found"
      ) {
        logTelegramConnect("connect_poll_attempt_lost", {
          attemptId,
          status: response.status,
          error: json.error ?? null,
        });
        attemptIdRef.current = null;
        clearStoredMtprotoConnect();
        applyConnectSnapshot({
          ok: false,
          authState: "failed",
          error: "gateway_attempt_lost",
          attemptId: null,
        });
        return;
      }
      applyConnectSnapshot({ ...json, attemptId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("connect_poll_error", { message });
    }
  }, [applyConnectSnapshot]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setInterval(() => {
      void pollConnectStatus();
    }, POLL_MS);
  }, [pollConnectStatus, stopPolling]);

  const clearSilentMidConnect = useCallback(() => {
    stopPolling();
    attemptIdRef.current = null;
    clearStoredMtprotoConnect();
    connectAuthStateRef.current = "idle";
    setConnectAuthState("idle");
    setConnectAuthMethod("qr");
    connectAuthMethodRef.current = "qr";
    setConnectQrLink(null);
    setConnectError(null);
    setConnected(false);
  }, [stopPolling]);

  const attemptSilentMtprotoResume = useCallback(async (): Promise<boolean> => {
    if (
      reconnectInFlightRef.current ||
      !isAuthenticated ||
      explicitDisconnectRef.current ||
      sessionTelegramMessagesConnectedRef.current !== true
    ) {
      return false;
    }
    reconnectInFlightRef.current = true;
    logTelegramConnect("silent_resume_start");
    try {
      const response = await fetch(buildApiUrl("/api/telegram-mtproto-connect-start"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true, authMethod: "qr" }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authState?: string;
        error?: string | null;
        attemptId?: string | null;
        chatCount?: number | null;
      };
      logTelegramConnect("silent_resume_done", {
        status: response.status,
        authState: json.authState ?? null,
        error: json.error ?? null,
      });
      if (json.authState === "ready") {
        applyConnectSnapshot({ ...json, attemptId: json.attemptId ?? undefined });
        return true;
      }
      // Mid-connect (wait_qr / phone) means there is no restorable session — do not
      // background-poll with the sheet closed; that hides the Connect footer.
      if (json.authState && isMidConnectAuth(json.authState as MtprotoAuthState)) {
        logTelegramConnect("silent_resume_needs_user_connect", {
          authState: json.authState,
        });
        clearSilentMidConnect();
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("silent_resume_error", { message });
      return false;
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [applyConnectSnapshot, clearSilentMidConnect, isAuthenticated]);

  attemptSilentMtprotoResumeRef.current = attemptSilentMtprotoResume;

  const recoverTelegramMessagesSession = useCallback(async (): Promise<boolean> => {
    if (connectedRef.current) return true;
    if (connectSheetVisibleRef.current || isMidConnectAuth(connectAuthStateRef.current)) {
      logTelegramConnect("recover_session_skip_mid_connect", {
        authState: connectAuthStateRef.current,
      });
      return false;
    }
    if (Date.now() < notConnectedBackoffUntilRef.current) {
      logTelegramConnect("recover_session_backoff", {
        remainingMs: notConnectedBackoffUntilRef.current - Date.now(),
      });
      return false;
    }
    if (reconnectInFlightRef.current || warmupInFlightRef.current) {
      // Another recovery is already running — wait briefly, then report real gateway state.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return connectedRef.current;
    }
    logTelegramConnect("recover_session_start", {
      sessionLinked: sessionTelegramMessagesConnected === true,
    });
    const linked = await refreshStatusInner();
    if (linked) {
      // Await warmup: returning true on DB-link alone caused loadChats→recover thrash
      // while gateway stayed session_not_ready / warmup_timeout.
      return silentWarmupSession();
    }
    // No product link — show Connect; do not start a silent QR attempt.
    if (sessionTelegramMessagesConnected !== true) {
      clearSilentMidConnect();
      return false;
    }
    const resumed = await attemptSilentMtprotoResume();
    if (resumed) {
      notConnectedBackoffUntilRef.current = 0;
      return silentWarmupSession();
    }
    // Resume may have re-marked DB while authState wasn't "ready" yet.
    return silentWarmupSession();
  }, [
    attemptSilentMtprotoResume,
    clearSilentMidConnect,
    refreshStatusInner,
    sessionTelegramMessagesConnected,
    silentWarmupSession,
  ]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const linked = await refreshStatusInner();
    if (!linked && sessionTelegramMessagesConnected === true) {
      void recoverTelegramMessagesSession();
    } else if (linked && !connectedRef.current) {
      void silentWarmupSession();
    }
  }, [
    recoverTelegramMessagesSession,
    refreshStatusInner,
    sessionTelegramMessagesConnected,
    silentWarmupSession,
  ]);

  useEffect(() => {
    logTelegramConnect("provider_mount", { apiBase: getApiBaseUrl(), isAuthenticated, authReady });
    const storedRaw = readStoredMtprotoConnect();
    const stored = storedRaw ? normalizeRestoredConnectSession(storedRaw) : null;
    if (stored?.attemptId && isMidConnectAuth(stored.authState)) {
      attemptIdRef.current = stored.attemptId;
      setConnectAuthState(stored.authState);
      connectAuthStateRef.current = stored.authState;
      setConnectAuthMethod(stored.authMethod);
      connectAuthMethodRef.current = stored.authMethod;
      logTelegramConnect("connect_session_restored", {
        authState: stored.authState,
        authMethod: stored.authMethod,
      });
    }
  }, []);

  useEffect(() => {
    if (!attemptIdRef.current || !isMidConnectAuth(connectAuthStateRef.current)) return;
    // Only poll while the connect sheet is open — silent background wait_qr hides Connect.
    if (!connectSheetVisible) return;
    startPolling();
  }, [connectSheetVisible, startPolling]);

  useEffect(() => {
    if (!isAuthenticated) {
      setConnected(false);
      return;
    }
    if (sessionTelegramMessagesConnected === true) {
      void silentWarmupSession();
    } else if (sessionTelegramMessagesConnected === false) {
      setConnected(false);
    }
  }, [isAuthenticated, sessionTelegramMessagesConnected, silentWarmupSession]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    void (async () => {
      const connected = await refreshStatusInner();
      if (connected || sessionTelegramMessagesConnected === true) {
        void silentWarmupSession();
      }
    })();
  }, [
    authReady,
    isAuthenticated,
    refreshStatusInner,
    silentWarmupSession,
    sessionTelegramMessagesConnected,
  ]);

  useEffect(() => {
    if (!authReady || !isAuthenticated || sessionTelegramMessagesConnected !== true) return;
    if (isTelegramMessagesConnected) return;
    const timer = setInterval(() => {
      if (warmupInFlightRef.current || reconnectInFlightRef.current) return;
      void silentWarmupSession();
    }, 15_000);
    return () => clearInterval(timer);
  }, [
    authReady,
    isAuthenticated,
    isTelegramMessagesConnected,
    sessionTelegramMessagesConnected,
    silentWarmupSession,
  ]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const beginMtprotoConnect = useCallback(async (options?: {
    fresh?: boolean;
    addAccount?: boolean;
    authMethod?: MtprotoAuthMethod;
    soft?: boolean;
  }) => {
    const authMethod: MtprotoAuthMethod = options?.authMethod === "phone" ? "phone" : "qr";
    const softPhoneStart = Boolean(options?.soft) && authMethod === "phone";
    const addAccount = Boolean(options?.addAccount) || connectAddAccountRef.current;
    const useFresh =
      addAccount ||
      Boolean(options?.fresh) ||
      (sessionTelegramMessagesConnectedRef.current !== true && !softPhoneStart);
    const current = connectAuthStateRef.current;
    if (
      !useFresh &&
      !addAccount &&
      authMethod === "qr" &&
      connectAuthMethodRef.current === "phone" &&
      (current === "wait_code" || current === "wait_phone" || current === "wait_password")
    ) {
      logTelegramConnect("connect_start_skipped_phone_in_progress", { current, authMethod });
      if (attemptIdRef.current) startPolling();
      return;
    }
    connectStartGenerationRef.current += 1;
    const startGeneration = connectStartGenerationRef.current;
    connectStartAbortRef.current?.abort();
    const abortController = new AbortController();
    connectStartAbortRef.current = abortController;
    pollGenerationRef.current += 1;
    setConnectAuthMethod(authMethod);
    connectAuthMethodRef.current = authMethod;
    const startUrl = buildApiUrl("/api/telegram-mtproto-connect-start");
    logTelegramConnect("connect_start", {
      url: startUrl,
      isAuthenticated,
      fresh: useFresh,
      addAccount,
      authMethod,
      resume: !useFresh && !addAccount,
    });
    setConnectPending(true);
    setConnectError(null);
    if (softPhoneStart) {
      // Keep QR and current step visible while the phone session starts.
    } else if (!useFresh && attemptIdRef.current && isMidConnectAuth(current)) {
      setConnectQrLink(null);
    } else {
      setConnectAuthState("initializing");
      connectAuthStateRef.current = "initializing";
      setConnectQrLink(null);
    }
    if (useFresh || addAccount) {
      attemptIdRef.current = null;
    }
    try {
      const body: Record<string, unknown> = addAccount
        ? { addAccount: true, fresh: true, authMethod }
        : useFresh
          ? { fresh: true, authMethod }
          : softPhoneStart
            ? { fresh: false, authMethod }
            : { resume: true, authMethod };
      const response = await fetch(startUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      if (startGeneration !== connectStartGenerationRef.current) return;
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        attemptId?: string;
        authState?: string;
        qrLink?: string | null;
        error?: string | null;
        chatCount?: number | null;
        messengerSlot?: number | null;
        debug?: Record<string, unknown>;
      };
      logTelegramConnect("connect_response", {
        status: response.status,
        authState: json.authState ?? null,
        error: json.error ?? null,
        debug: json.debug ?? null,
        messengerSlot: json.messengerSlot ?? null,
      });
      if (startGeneration !== connectStartGenerationRef.current) return;
      applyConnectSnapshot(json);
      if (
        json.attemptId ||
        json.authState === "wait_qr" ||
        json.authState === "wait_phone" ||
        json.authState === "wait_code" ||
        json.authState === "initializing" ||
        json.authState === "wait_password"
      ) {
        startPolling();
      }
      if (!response.ok && json.authState !== "wait_qr" && json.authState !== "wait_phone") {
        setConnectAuthState("failed");
        connectAuthStateRef.current = "failed";
        setConnectError(
          json.error ||
            (response.status === 504 ? "gateway_timeout_retry" : `HTTP_${response.status}`),
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logTelegramConnect("connect_aborted");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setConnectAuthState("failed");
      connectAuthStateRef.current = "failed";
      setConnectError(message);
      logTelegramConnect("connect_error", { message });
    } finally {
      if (startGeneration === connectStartGenerationRef.current) {
        setConnectPending(false);
        logTelegramConnect("connect_finished");
      }
    }
  }, [applyConnectSnapshot, isAuthenticated, startPolling]);

  const waitForPhoneGatewayReady = useCallback(
    async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (connectAuthStateRef.current === "failed") return false;
        if (attemptIdRef.current) {
          await pollConnectStatus();
          if (connectAuthStateRef.current === "wait_phone") return true;
          if (connectAuthStateRef.current === "failed") return false;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return (
        Boolean(attemptIdRef.current) && connectAuthStateRef.current === "wait_phone"
      );
    },
    [pollConnectStatus],
  );

  const submitMtprotoPhone = useCallback(
    async (phoneNumber: string) => {
      if (!phoneNumber.trim()) return;
      if (connectAuthStateRef.current === "wait_code" || connectAuthStateRef.current === "wait_password") {
        return;
      }
      logTelegramConnect("connect_phone_submit", {
        authState: connectAuthStateRef.current,
        authMethod: connectAuthMethodRef.current,
        hasAttemptId: Boolean(attemptIdRef.current),
      });
      setConnectPending(true);
      setConnectError(null);
      try {
        const hasLivePhoneSession =
          Boolean(attemptIdRef.current) &&
          (connectAuthStateRef.current === "wait_phone" ||
            (connectAuthStateRef.current === "initializing" && connectAuthMethodRef.current === "phone"));
        if (hasLivePhoneSession) {
          connectAuthMethodRef.current = "phone";
          setConnectAuthMethod("phone");
        } else {
          const needsPhoneSession =
            !attemptIdRef.current ||
            connectAuthStateRef.current === "idle" ||
            connectAuthStateRef.current === "failed" ||
            connectAuthStateRef.current === "wait_qr";
          if (needsPhoneSession) {
            stopPolling();
            setConnectAuthMethod("phone");
            connectAuthMethodRef.current = "phone";
            const switchingFromQr = connectAuthStateRef.current === "wait_qr";
            await beginMtprotoConnect({
              fresh: switchingFromQr || !attemptIdRef.current || connectAuthStateRef.current === "failed",
              authMethod: "phone",
              soft: true,
            });
            if (connectAuthStateRef.current === "wait_qr") {
              logTelegramConnect("connect_phone_retry_force_fresh_after_qr_reuse");
              await beginMtprotoConnect({ fresh: true, authMethod: "phone", soft: true });
            }
            if (connectAuthStateRef.current === "wait_qr") {
              setConnectError("telegram_network_unreachable");
              return;
            }
            setConnectPending(true);
            const ready = await waitForPhoneGatewayReady(45_000);
            if (!ready) {
              setConnectError(
                connectAuthStateRef.current === "failed"
                  ? "session_expired_restart"
                  : "telegram_network_unreachable",
              );
              return;
            }
          }
        }

        const attemptId = attemptIdRef.current;
        if (!attemptId) {
          setConnectError("session_expired_restart");
          return;
        }

        const response = await fetch(buildApiUrl("/api/telegram-mtproto-connect-phone"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attemptId,
            phoneNumber,
            isCurrentPhoneNumber: mtprotoUseCurrentPhoneNumberForCode(),
          }),
        });
        const json = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          authState?: string;
          error?: string | null;
          chatCount?: number | null;
        };
        if (!json.authState) {
          setConnectError(json.error || `HTTP_${response.status}`);
          startPolling();
          return;
        }
        if (!response.ok || json.ok === false) {
          setConnectError(json.error || `HTTP_${response.status}`);
          applyConnectSnapshot({ ...json, attemptId });
          return;
        }
        applyConnectSnapshot({ ...json, attemptId });
        if (json.authState !== "ready" && json.authState !== "failed") {
          startPolling();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setConnectError(message.includes("Failed to fetch") ? "network_error" : message);
        startPolling();
      } finally {
        setConnectPending(false);
      }
    },
    [applyConnectSnapshot, startPolling, beginMtprotoConnect, waitForPhoneGatewayReady, stopPolling],
  );

  const submitMtprotoCode = useCallback(
    async (code: string) => {
      const attemptId = attemptIdRef.current;
      if (!attemptId || !code.trim()) return;
      setConnectPending(true);
      setConnectError(null);
      try {
        const response = await fetch(buildApiUrl("/api/telegram-mtproto-connect-code"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId, code }),
        });
        const json = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          authState?: string;
          error?: string | null;
          chatCount?: number | null;
        };
        if (!json.authState) {
          setConnectError(json.error || `HTTP_${response.status}`);
          startPolling();
          return;
        }
        applyConnectSnapshot({ ...json, attemptId });
        if (json.authState !== "ready" && json.authState !== "failed") {
          startPolling();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setConnectError(message.includes("Failed to fetch") ? "network_error" : message);
        startPolling();
      } finally {
        setConnectPending(false);
      }
    },
    [applyConnectSnapshot, startPolling],
  );

  const resendMtprotoCode = useCallback(async () => {
    const attemptId = attemptIdRef.current;
    if (!attemptId || connectAuthStateRef.current !== "wait_code") return;
    setConnectPending(true);
    setConnectError(null);
    try {
      const response = await fetch(buildApiUrl("/api/telegram-mtproto-connect-resend-code"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authState?: string;
        error?: string | null;
      };
      logTelegramConnect("connect_resend_response", {
        status: response.status,
        authState: json.authState ?? null,
        error: json.error ?? null,
      });
      if (json.error) {
        setConnectError(json.error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectError(message.includes("Failed to fetch") ? "network_error" : message);
    } finally {
      setConnectPending(false);
    }
  }, []);

  const switchToQrConnect = useCallback(async () => {
    stopPolling();
    setConnectPending(true);
    setConnectError(null);
    setConnectCodeDelivery(null);
    lastCodeDeliveryLogRef.current = null;
    setConnectAuthMethod("qr");
    connectAuthMethodRef.current = "qr";
    try {
      await beginMtprotoConnect({ fresh: true, authMethod: "qr" });
    } finally {
      setConnectPending(false);
    }
  }, [beginMtprotoConnect, stopPolling]);

  const submitMtprotoPassword = useCallback(
    async (password: string) => {
      const attemptId = attemptIdRef.current;
      if (!attemptId || !password.trim()) return;
      setConnectPending(true);
      setConnectError(null);
      try {
        const response = await fetch(buildApiUrl("/api/telegram-mtproto-connect-password"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId, password }),
        });
        const json = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          authState?: string;
          error?: string | null;
          chatCount?: number | null;
        };
        logTelegramConnect("connect_password_response", {
          status: response.status,
          authState: json.authState ?? null,
          error: json.error ?? null,
          ok: json.ok ?? null,
        });
        if (!json.authState) {
          setConnectError(json.error || `HTTP_${response.status}`);
          startPolling();
          return;
        }
        applyConnectSnapshot({ ...json, attemptId });
        if (json.authState !== "ready" && json.authState !== "failed") {
          startPolling();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setConnectError(message.includes("Failed to fetch") ? "network_error" : message);
        logTelegramConnect("connect_password_error", { message });
        startPolling();
      } finally {
        setConnectPending(false);
      }
    },
    [applyConnectSnapshot, startPolling],
  );

  const openConnectSheet = useCallback((opts?: { addAccount?: boolean }) => {
    logTelegramConnect("open_connect_sheet", { addAccount: Boolean(opts?.addAccount) });
    connectAddAccountRef.current = Boolean(opts?.addAccount);
    notConnectedBackoffUntilRef.current = 0;
    setConnectSheetVisible(true);
    const current = connectAuthStateRef.current;
    if (!isMidConnectAuth(current) || opts?.addAccount) {
      setConnectAuthState("idle");
      connectAuthStateRef.current = "idle";
      setConnectAuthMethod("qr");
      connectAuthMethodRef.current = "qr";
      setConnectError(null);
      setConnectQrLink(null);
    } else if (attemptIdRef.current) {
      startPolling();
    }
  }, [startPolling]);

  const switchMessengerAccount = useCallback(async (slot: number): Promise<boolean> => {
    const startUrl = buildApiUrl("/api/telegram-mtproto-connect-start");
    logTelegramConnect("switch_messenger_slot", { slot });
    try {
      const response = await fetch(startUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ switchSlot: slot }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        authState?: string;
        error?: string | null;
        messengerSlot?: number | null;
      };
      if (typeof json.messengerSlot === "number") {
        lastMessengerSlotRef.current = Math.floor(json.messengerSlot);
        setActiveMessengerSlot(Math.floor(json.messengerSlot));
      }
      if (json.authState === "ready" || response.ok) {
        setConnected(true);
        connectedRef.current = true;
        bumpEmojiFetchEpoch();
        if (typeof document !== "undefined") {
          document.dispatchEvent(new CustomEvent("hsp-auth-session-updated"));
        }
        void refreshStatusInner();
        return true;
      }
      logTelegramConnect("switch_messenger_slot_failed", { error: json.error ?? null });
      return false;
    } catch (error) {
      logTelegramConnect("switch_messenger_slot_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [bumpEmojiFetchEpoch, refreshStatusInner]);

  const closeConnectSheet = useCallback(() => {
    logTelegramConnect("close_connect_sheet");
    stopPolling();
    connectStartAbortRef.current?.abort();
    connectStartGenerationRef.current += 1;
    pollGenerationRef.current += 1;
    clearConnectSuccessDismissTimer();
    connectSuccessSyncingRef.current = false;
    setConnectSuccessSyncing(false);
    setConnectSheetVisible(false);
    setConnectPending(false);
    setConnectAuthState("idle");
    connectAuthStateRef.current = "idle";
    setConnectAuthMethod("qr");
    connectAuthMethodRef.current = "qr";
    setConnectError(null);
    setConnectQrLink(null);
    setConnectCodeDelivery(null);
    attemptIdRef.current = null;
    clearStoredMtprotoConnect();
  }, [clearConnectSuccessDismissTimer, stopPolling]);

  // Reset add-account mode when the sheet closes.
  useEffect(() => {
    if (!connectSheetVisible) connectAddAccountRef.current = false;
  }, [connectSheetVisible]);

  const disconnectTelegramMessages = useCallback(async () => {
    logTelegramConnect("disconnect_start");
    explicitDisconnectRef.current = true;
    notConnectedBackoffUntilRef.current = Date.now() + 120_000;
    warmupInFlightRef.current = false;
    reconnectInFlightRef.current = false;
    stopPolling();
    connectStartAbortRef.current?.abort();
    connectStartGenerationRef.current += 1;
    pollGenerationRef.current += 1;
    clearConnectSuccessDismissTimer();
    connectSuccessSyncingRef.current = false;
    setConnectSuccessSyncing(false);
    setConnectSheetVisible(false);
    setConnectPending(false);
    attemptIdRef.current = null;
    clearStoredMtprotoConnect();
    connectAuthStateRef.current = "idle";
    setConnectAuthState("idle");
    setConnectAuthMethod("qr");
    connectAuthMethodRef.current = "qr";
    setConnectQrLink(null);
    setConnectError(null);
    setConnectCodeDelivery(null);
    lastKnownTelegramUserIdRef.current = null;
    connectedRef.current = false;
    setConnected(false);
    setConnectedTelegramUserId(null);

    try {
      await fetch(buildApiUrl("/api/telegram-messages-disconnect"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      /* ignore */
    }

    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("hsp-auth-session-updated"));
    }
    await refreshStatusInner();
    logTelegramConnect("disconnect_done");
  }, [clearConnectSuccessDismissTimer, refreshStatusInner, stopPolling]);

  const value = useMemo(
    (): TelegramMessagesConnectionCtx => ({
      isTelegramMessagesConnected,
      connectedTelegramUserId,
      emojiFetchEpoch,
      connectPending,
      connectSheetVisible,
      connectSuccessSyncing,
      connectAuthState,
      connectAuthMethod,
      connectQrLink,
      connectError,
      connectCodeDelivery,
      openConnectSheet,
      closeConnectSheet,
      refreshStatus,
      recoverTelegramMessagesSession,
      beginMtprotoConnect,
      switchMessengerAccount,
      activeMessengerSlot,
      submitMtprotoPhone,
      submitMtprotoCode,
      resendMtprotoCode,
      submitMtprotoPassword,
      switchToQrConnect,
      disconnectTelegramMessages,
    }),
    [
      isTelegramMessagesConnected,
      connectedTelegramUserId,
      emojiFetchEpoch,
      connectPending,
      connectSheetVisible,
      connectSuccessSyncing,
      connectAuthState,
      connectAuthMethod,
      connectQrLink,
      connectError,
      connectCodeDelivery,
      openConnectSheet,
      closeConnectSheet,
      refreshStatus,
      recoverTelegramMessagesSession,
      beginMtprotoConnect,
      switchMessengerAccount,
      activeMessengerSlot,
      submitMtprotoPhone,
      submitMtprotoCode,
      resendMtprotoCode,
      submitMtprotoPassword,
      switchToQrConnect,
      disconnectTelegramMessages,
    ],
  );

  return (
    <TelegramMessagesConnectionContext.Provider value={value}>
      {children}
      <TelegramConnectSheet />
    </TelegramMessagesConnectionContext.Provider>
  );
}

export function useTelegramMessagesConnection(): TelegramMessagesConnectionCtx {
  const ctx = useContext(TelegramMessagesConnectionContext);
  if (!ctx) {
    throw new Error("useTelegramMessagesConnection must be used within TelegramMessagesConnectionProvider");
  }
  return ctx;
}
