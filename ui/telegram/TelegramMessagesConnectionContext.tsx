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
  connectAuthState: MtprotoAuthState;
  connectAuthMethod: MtprotoAuthMethod;
  connectQrLink: string | null;
  connectError: string | null;
  connectCodeDelivery: ConnectCodeDeliveryInfo | null;
  openConnectSheet: () => void;
  closeConnectSheet: () => void;
  refreshStatus: () => Promise<void>;
  beginMtprotoConnect: (options?: {
    fresh?: boolean;
    authMethod?: MtprotoAuthMethod;
    /** Phone switch: keep code/phone UI instead of QR loading spinner */
    soft?: boolean;
  }) => Promise<void>;
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
  const [connectAuthState, setConnectAuthState] = useState<MtprotoAuthState>("idle");
  const [connectAuthMethod, setConnectAuthMethod] = useState<MtprotoAuthMethod>("qr");
  const [connectQrLink, setConnectQrLink] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectCodeDelivery, setConnectCodeDelivery] = useState<ConnectCodeDeliveryInfo | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const connectAuthStateRef = useRef<MtprotoAuthState>("idle");
  const connectAuthMethodRef = useRef<MtprotoAuthMethod>("qr");
  const pollGenerationRef = useRef(0);
  const connectStartGenerationRef = useRef(0);
  const lastCodeDeliveryLogRef = useRef<string | null>(null);
  const connectStartAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const warmupInFlightRef = useRef(false);
  const wasTelegramConnectedRef = useRef(false);

  const bumpEmojiFetchEpoch = useCallback(() => {
    resetTelegramEmojiFetchCaches();
    setEmojiFetchEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (isTelegramMessagesConnected && !wasTelegramConnectedRef.current) {
      bumpEmojiFetchEpoch();
    }
    wasTelegramConnectedRef.current = isTelegramMessagesConnected;
  }, [bumpEmojiFetchEpoch, isTelegramMessagesConnected]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshStatusInner = useCallback(async (): Promise<boolean> => {
    logTelegramConnect("refresh_status_start", { isAuthenticated, authReady });
    if (!isAuthenticated) {
      setConnected(false);
      setConnectedTelegramUserId(null);
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
      const connected = response.ok && json.ok === true && json.connected === true;
      setConnected(connected);
      const userIdRaw = Number(json.telegram_user_id);
      setConnectedTelegramUserId(
        connected && Number.isFinite(userIdRaw) && userIdRaw > 0 ? Math.trunc(userIdRaw) : null,
      );
      logTelegramConnect("refresh_status_ok", { connected, status: response.status, url: statusUrl });
      logPageDisplay("telegram_messages_status", { connected, status: response.status });
      return connected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("refresh_status_error", { message, url: statusUrl });
      setConnected(false);
      setConnectedTelegramUserId(null);
      return false;
    }
  }, [isAuthenticated, authReady]);

  const silentWarmupSession = useCallback(async () => {
    if (warmupInFlightRef.current) return;
    warmupInFlightRef.current = true;
    logTelegramConnect("silent_warmup_start");
    try {
      const maxAttempts = 5;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        if (json.needsReconnect || json.connected === false) {
          setConnected(false);
          return;
        }
        if (json.gatewayReady) {
          setConnected(true);
          logPageDisplay("telegram_messages_gateway_ready");
          void import("../authenticatedHomeSelectedChat").then(({ getAuthenticatedHomeSelectedChatSnapshot }) => {
            const chat = getAuthenticatedHomeSelectedChatSnapshot();
            if (!chat) return;
            void import("../messageChatHistoryPrefetch").then(({ prefetchChatHistoryPriority }) => {
              prefetchChatHistoryPriority(chat);
            });
          });
          return;
        }
        if (
          (json.warming || json.error === "session_restoring") &&
          attempt + 1 < maxAttempts
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, json.error === "session_restoring" ? 1_200 : 800),
          );
          continue;
        }
        if (json.connected !== false) {
          setConnected(true);
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTelegramConnect("silent_warmup_error", { message });
    } finally {
      warmupInFlightRef.current = false;
    }
  }, []);

  const applyConnectSnapshot = useCallback(
    (json: {
      ok?: boolean;
      authState?: string;
      qrLink?: string | null;
      error?: string | null;
      attemptId?: string | null;
      chatCount?: number | null;
      codeDelivery?: ConnectCodeDeliveryInfo | null;
    }) => {
      if (json.attemptId) attemptIdRef.current = json.attemptId;
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
      if (json.qrLink) {
        setConnectQrLink(json.qrLink);
      } else if (state === "ready" || state === "failed" || state === "idle") {
        setConnectQrLink(null);
      }
      setConnectError(json.error ?? (json.ok === false ? "connect_failed" : null));

      if (state === "ready") {
        setConnected(true);
        setConnectSheetVisible(false);
        stopPolling();
        clearStoredMtprotoConnect();
        setConnectCodeDelivery(null);
        logTelegramConnect("connect_success", { chatCount: json.chatCount ?? null });
        logPageDisplay("telegram_messages_connected");
        void refreshStatusInner();
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
    [stopPolling, refreshStatusInner],
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

  const refreshStatus = useCallback(async (): Promise<void> => {
    await refreshStatusInner();
  }, [refreshStatusInner]);

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
    startPolling();
  }, [startPolling]);

  useEffect(() => {
    if (!isAuthenticated) {
      setConnected(false);
      return;
    }
    if (sessionTelegramMessagesConnected === true) {
      setConnected(true);
      void silentWarmupSession();
    }
  }, [isAuthenticated, sessionTelegramMessagesConnected, silentWarmupSession]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    void (async () => {
      const connected = await refreshStatusInner();
      if (connected) {
        void silentWarmupSession();
      }
    })();
  }, [authReady, isAuthenticated, refreshStatusInner, silentWarmupSession]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const beginMtprotoConnect = useCallback(async (options?: {
    fresh?: boolean;
    authMethod?: MtprotoAuthMethod;
    soft?: boolean;
  }) => {
    const authMethod: MtprotoAuthMethod = options?.authMethod === "phone" ? "phone" : "qr";
    const softPhoneStart = Boolean(options?.soft) && authMethod === "phone";
    const current = connectAuthStateRef.current;
    if (
      !options?.fresh &&
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
      fresh: Boolean(options?.fresh),
      authMethod,
      resume: !options?.fresh,
    });
    setConnectPending(true);
    setConnectError(null);
    if (softPhoneStart) {
      setConnectQrLink(null);
    } else if (!options?.fresh && attemptIdRef.current && isMidConnectAuth(current)) {
      setConnectQrLink(null);
    } else {
      setConnectAuthState("initializing");
      connectAuthStateRef.current = "initializing";
      setConnectQrLink(null);
    }
    if (options?.fresh) {
      attemptIdRef.current = null;
    }
    try {
      const body: Record<string, unknown> = options?.fresh
        ? { fresh: true, authMethod }
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
        debug?: Record<string, unknown>;
      };
      logTelegramConnect("connect_response", {
        status: response.status,
        authState: json.authState ?? null,
        error: json.error ?? null,
        debug: json.debug ?? null,
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
            await beginMtprotoConnect({ fresh: true, authMethod: "phone", soft: true });
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

  const openConnectSheet = useCallback(() => {
    logTelegramConnect("open_connect_sheet");
    setConnectSheetVisible(true);
    const current = connectAuthStateRef.current;
    if (!isMidConnectAuth(current)) {
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

  const closeConnectSheet = useCallback(() => {
    logTelegramConnect("close_connect_sheet");
    stopPolling();
    setConnectSheetVisible(false);
    const current = connectAuthStateRef.current;
    if (!isMidConnectAuth(current)) {
      setConnectAuthState("idle");
      connectAuthStateRef.current = "idle";
      setConnectAuthMethod("qr");
      connectAuthMethodRef.current = "qr";
      setConnectError(null);
      setConnectQrLink(null);
      attemptIdRef.current = null;
    }
  }, [stopPolling]);

  const disconnectTelegramMessages = useCallback(async () => {
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
    setConnected(false);
    setConnectedTelegramUserId(null);
    await refreshStatusInner();
  }, [refreshStatusInner]);

  const value = useMemo(
    (): TelegramMessagesConnectionCtx => ({
      isTelegramMessagesConnected,
      connectedTelegramUserId,
      emojiFetchEpoch,
      connectPending,
      connectSheetVisible,
      connectAuthState,
      connectAuthMethod,
      connectQrLink,
      connectError,
      connectCodeDelivery,
      openConnectSheet,
      closeConnectSheet,
      refreshStatus,
      beginMtprotoConnect,
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
      connectAuthState,
      connectAuthMethod,
      connectQrLink,
      connectError,
      connectCodeDelivery,
      openConnectSheet,
      closeConnectSheet,
      refreshStatus,
      beginMtprotoConnect,
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
