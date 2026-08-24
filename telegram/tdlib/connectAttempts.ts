import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Client } from "tdl";
import * as tdl from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import { getTdlibDbRoot, getTdlibRestoreMode, getTdlibStorageMode, getTelegramApiCredentials, getTdlibUserDir } from "./env.js";
import {
  clearGatewayUserIdleState,
  pinGatewayUserSession,
  registerClientIdleHooks,
  touchGatewayUserActivity,
  unpinGatewayUserSession,
  waitForGatewayUserUnload,
} from "./clientIdle.js";
import { logGateway } from "./gatewayLog.js";
import { classifyTdlibSendError } from "../../shared/telegramSendError.js";
import { TELEGRAM_THREAD_NO_AVATAR } from "../../shared/telegramThreadConstants.js";
import {
  persistMtprotoConnection,
  readChatAvatarBytes,
  readUserAvatarBytes,
  refreshLiveChats,
  syncChatThreads,
  scheduleBackgroundChatSync,
  scheduleTier3ChatSync,
  isBackgroundChatSyncInProgress,
  isTier3ChatSyncInProgress,
} from "./syncChats.js";
import { fetchChatHistory, fetchChatHistoryAroundMessage, fetchChatHistoryAroundUnread, fetchChatHistorySince, sendChatTextMessage, sendChatPhotoMessage, editChatTextMessage, deleteChatMessages, viewChatInboxMessagesUpTo } from "./chatHistory.js";
import { readUserAvatarAnimationBytes } from "./chatPhoto.js";
import { attachLiveChatSync, detachLiveChatSync } from "./liveChatSync.js";
import { ingestChatFoldersUpdate } from "./chatFolderCache.js";
import { isPositionedComplete } from "./chatListSyncState.js";
import { getLiveChatList, getLiveChatListRevision, patchLiveChatMemberMeta, patchLiveChatVideoChat } from "./liveChatCache.js";
import { normalizeTelegramGroupCallId } from "../../shared/telegramGroupCallSdp.js";
import { type TdChat } from "./chatPreview.js";
import { verifyGroupCallLiveState } from "./voiceParticipants.js";
import {
  getPrivateCallMediaLoadError,
  isPrivateCallMediaAvailable,
} from "./privateCallMedia.js";

export type ConnectAuthMethod = "qr" | "phone";

export type ConnectAuthState =
  | "initializing"
  | "wait_qr"
  | "wait_phone"
  | "wait_code"
  | "wait_password"
  | "ready"
  | "failed";

export type ConnectCodeDelivery = {
  type: string;
  nextType: string | null;
  timeoutSec: number | null;
  phoneMasked: string | null;
};

export type ConnectAttemptSnapshot = {
  attemptId: string;
  telegramUsername: string;
  authState: ConnectAuthState;
  qrLink: string | null;
  error: string | null;
  chatCount: number | null;
  codeDelivery: ConnectCodeDelivery | null;
};

type AttemptRecord = ConnectAttemptSnapshot & {
  client: Client | null;
  passwordResolve: ((password: string) => void) | null;
  createdAt: number;
  connectionState: string | null;
  qrRequested: boolean;
  authMethod: ConnectAuthMethod;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
};

let tdlConfigured = false;

function ensureTdlConfigured(): void {
  if (tdlConfigured) return;
  tdl.configure({ tdjson: getTdjson() });
  tdlConfigured = true;
}

function ensureUserDirs(telegramUsername: string): { databaseDirectory: string; filesDirectory: string } {
  const base = getTdlibUserDir(telegramUsername);
  const databaseDirectory = path.join(base, "db");
  const filesDirectory = path.join(base, "files");
  fs.mkdirSync(databaseDirectory, { recursive: true });
  fs.mkdirSync(filesDirectory, { recursive: true });
  return { databaseDirectory, filesDirectory };
}

function createTdlibClient(telegramUsername: string, hook?: (client: Client) => void): Client {
  const creds = getTelegramApiCredentials();
  if (!creds) {
    throw new Error("telegram_api_credentials_missing");
  }
  ensureTdlConfigured();
  const { databaseDirectory, filesDirectory } = ensureUserDirs(telegramUsername);
  const storageMode = getTdlibStorageMode();
  // Slim: auth keys stay on disk; chats/messages are fetched from Telegram into RAM
  // (and our short-lived liveChatCache), not duplicated into multi-GB SQLite.
  const useLocalCaches = storageMode === "full";
  const client = tdl.createClient({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    databaseDirectory,
    filesDirectory,
    useTestDc: false,
    tdlibParameters: {
      use_message_database: useLocalCaches,
      use_chat_info_database: useLocalCaches,
      use_file_database: useLocalCaches,
      use_secret_chats: false,
      system_language_code: "en",
      application_version: "1.0",
      device_model: "HyperlinksSpaceProgram",
      system_version: "gateway",
    },
  });
  hook?.(client);
  return client;
}

const attempts = new Map<string, AttemptRecord>();
const activeByUser = new Map<string, string>();

function maskPhoneNumber(phone: string | undefined | null): string | null {
  if (!phone?.trim()) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 4) return trimmed;
  const prefix = trimmed.startsWith("+") ? "+" : "";
  return `${prefix}***${digits.slice(-4)}`;
}

type TdCodeInfo = {
  type?: { _?: string };
  next_type?: { _?: string };
  timeout?: number;
  phone_number?: string;
};

function applyCodeInfo(record: AttemptRecord, codeInfo: TdCodeInfo | undefined): void {
  if (!codeInfo) return;
  record.codeDelivery = {
    type: codeInfo.type?._ ?? "unknown",
    nextType: codeInfo.next_type?._ ?? null,
    timeoutSec: typeof codeInfo.timeout === "number" ? codeInfo.timeout : null,
    phoneMasked: maskPhoneNumber(codeInfo.phone_number),
  };
}

async function syncCodeDeliveryFromClient(record: AttemptRecord): Promise<void> {
  if (!record.client || record.authState !== "wait_code") return;
  try {
    const state = (await record.client.invoke({ _: "getAuthorizationState" })) as {
      _?: string;
      code_info?: TdCodeInfo;
    };
    if (state._ === "authorizationStateWaitCode") {
      applyCodeInfo(record, state.code_info);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logConnectEvent(record, "connect_code_info_sync_failed", { message });
  }
}

function snapshot(record: AttemptRecord): ConnectAttemptSnapshot {
  return {
    attemptId: record.attemptId,
    telegramUsername: record.telegramUsername,
    authState: record.authState,
    qrLink: record.qrLink,
    error: record.error,
    chatCount: record.chatCount,
    codeDelivery: record.codeDelivery,
  };
}

function logConnectEvent(record: AttemptRecord, event: string, extra?: Record<string, unknown>): void {
  logGateway(event, {
    attemptId: record.attemptId,
    telegramUsername: record.telegramUsername,
    authState: record.authState,
    connectionState: record.connectionState,
    ...extra,
  });
}

const QR_INVOKE_TIMEOUT_MS = 30_000;
const CONNECT_WATCHDOG_MS = 45_000;

function failAttempt(record: AttemptRecord, error: string): void {
  if (record.authState === "ready" || record.authState === "failed") return;
  record.authState = "failed";
  record.error = error;
  clearConnectWatchdog(record);
  unpinConnectAuth(record.telegramUsername);
  logConnectEvent(record, "connect_failed", { error });
}

function clearConnectWatchdog(record: AttemptRecord): void {
  if (record.watchdogTimer) {
    clearTimeout(record.watchdogTimer);
    record.watchdogTimer = null;
  }
}

const WATCHDOG_WAIT_STATES: ConnectAuthState[] = [
  "initializing",
  "wait_qr",
  "wait_phone",
  "wait_code",
];

function startConnectWatchdog(record: AttemptRecord): void {
  clearConnectWatchdog(record);
  record.watchdogTimer = setTimeout(() => {
    if (!WATCHDOG_WAIT_STATES.includes(record.authState)) return;
    if (record.qrLink) return;
    if (record.authMethod === "phone" && (record.authState === "wait_phone" || record.authState === "wait_code")) {
      return;
    }
    const stuckConnecting =
      record.connectionState === "connectionStateConnecting" ||
      record.connectionState === "connectionStateWaitingForNetwork";
    if (stuckConnecting || (record.authMethod === "qr" && !record.qrRequested)) {
      failAttempt(record, "telegram_network_unreachable");
    }
  }, CONNECT_WATCHDOG_MS);
}

function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  return `+${digits.replace(/^\+/, "")}`;
}

async function requestQrCode(record: AttemptRecord): Promise<void> {
  const client = record.client;
  if (!client || record.qrRequested) return;
  record.qrRequested = true;
  logConnectEvent(record, "connect_qr_request");
  try {
    await Promise.race([
      client.invoke({ _: "requestQrCodeAuthentication", other_user_ids: [] }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("telegram_network_unreachable")), QR_INVOKE_TIMEOUT_MS);
      }),
    ]);
    logConnectEvent(record, "connect_qr_request_ok");
  } catch (err) {
    failAttempt(record, err instanceof Error ? err.message : "qr_request_failed");
  }
}

function attachAuthListener(record: AttemptRecord): void {
  const client = record.client;
  if (!client) return;

  client.on("error", (err: Error) => {
    if (!attempts.has(record.attemptId)) return;
    logConnectEvent(record, "connect_client_error", { message: err.message });
    failAttempt(record, err.message || "tdlib_client_error");
  });

  client.on("update", (update: {
    _?: string;
    authorization_state?: { _?: string; link?: string };
    state?: { _?: string };
    chat_folders?: Array<{ id?: number }>;
  }) => {
    if (!attempts.has(record.attemptId)) return;
    if (update._ === "updateConnectionState") {
      record.connectionState = update.state?._ ?? null;
      logConnectEvent(record, "connect_connection_state", { connectionState: record.connectionState });
      return;
    }
    if (update._ === "updateChatFolders") {
      const folderIds = ingestChatFoldersUpdate(record.telegramUsername, update);
      logConnectEvent(record, "connect_chat_folders", { folderCount: folderIds.length, folderIds });
      return;
    }

    if (update._ !== "updateAuthorizationState") return;
    const state = update.authorization_state?._;
    if (!state) return;
    logConnectEvent(record, "connect_auth_state", { tdlibAuthState: state });

    if (state === "authorizationStateWaitPhoneNumber") {
      if (record.authMethod === "phone" || readStoredAuthMethod(record.telegramUsername) === "phone") {
        record.authMethod = "phone";
        clearConnectWatchdog(record);
        record.authState = "wait_phone";
        logConnectEvent(record, "connect_wait_phone");
      } else {
        void requestQrCode(record);
      }
      return;
    }

    if (state === "authorizationStateWaitCode") {
      clearConnectWatchdog(record);
      record.authMethod = "phone";
      writeStoredAuthMethod(record.telegramUsername, "phone");
      record.authState = "wait_code";
      applyCodeInfo(
        record,
        (update.authorization_state as { code_info?: TdCodeInfo })?.code_info,
      );
      logConnectEvent(record, "connect_wait_code", {
        codeType: record.codeDelivery?.type ?? null,
        nextCodeType: record.codeDelivery?.nextType ?? null,
        codeTimeoutSec: record.codeDelivery?.timeoutSec ?? null,
        phoneMasked: record.codeDelivery?.phoneMasked ?? null,
        codeLength:
          (update.authorization_state as { code_info?: { type?: { length?: number } } })?.code_info
            ?.type?.length ?? null,
      });
      return;
    }

    if (state === "authorizationStateWaitOtherDeviceConfirmation") {
      clearConnectWatchdog(record);
      record.authState = "wait_qr";
      record.qrLink = update.authorization_state?.link ?? null;
      logConnectEvent(record, "connect_qr_ready", { hasQrLink: Boolean(record.qrLink) });
      return;
    }

    if (state === "authorizationStateWaitPassword") {
      clearConnectWatchdog(record);
      record.authState = "wait_password";
      return;
    }

    if (state === "authorizationStateReady") {
      clearConnectWatchdog(record);
      void finalizeReady(record);
    }

    if (state === "authorizationStateClosed") {
      failAttempt(record, "authorization_closed");
    }
  });
}

async function finalizeReady(record: AttemptRecord): Promise<void> {
  if (record.authState === "ready") return;
  const client = record.client;
  if (!client) {
    record.authState = "failed";
    record.error = "client_missing";
    return;
  }

  try {
    await persistMtprotoConnection(client, record.telegramUsername);
    logConnectEvent(record, "connect_session_persisted");
  } catch (err) {
    const message = err instanceof Error ? err.message : "session_persist_failed";
    record.authState = "failed";
    record.error = message;
    logConnectEvent(record, "connect_persist_failed", { message });
    return;
  }

  // Mark ready before the initial chat sync. Large TDLib DBs (multi-GB) can take longer
  // than restore timeouts; streams/API need the session usable during warm-up.
  record.authState = "ready";
  record.qrLink = null;
  record.error = null;
  clearStoredAuthMethod(record.telegramUsername);
  unpinConnectAuth(record.telegramUsername);
  attachLiveChatSync(record);
  logConnectEvent(record, "connect_ready", {
    chatCount: record.chatCount ?? 0,
    syncPending: true,
  });

  try {
    record.chatCount = await syncChatThreads(client, record.telegramUsername, {
      maxMainChats: null,
      includeArchive: true,
      includeSupplementarySearch: false,
      skipMemberCounts: true,
      replaceCache: true,
    });
    logConnectEvent(record, "connect_initial_sync_done", { chatCount: record.chatCount ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync_failed";
    logConnectEvent(record, "connect_sync_warning", { message });
    record.chatCount = 0;
  }

  scheduleBackgroundChatSync(client, record.telegramUsername);
}

async function waitForAuthState(
  record: AttemptRecord,
  targets: ConnectAuthState[],
  timeoutMs: number,
): Promise<ConnectAuthState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (targets.includes(record.authState)) return record.authState;
    if (record.authState === "failed") return record.authState;
    await new Promise((r) => setTimeout(r, 250));
  }
  return record.authState;
}

async function waitForConnectionReady(record: AttemptRecord, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (record.authState === "failed") return false;
    if (record.connectionState === "connectionStateReady") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return record.connectionState === "connectionStateReady";
}

export async function purgeTdlibUserData(telegramUsername: string): Promise<void> {
  detachLiveChatSync(telegramUsername);
  const existingId = activeByUser.get(telegramUsername);
  if (existingId) await disposeAttemptAsync(existingId);
  const base = getTdlibUserDir(telegramUsername);
  if (fs.existsSync(base)) {
    fs.rmSync(base, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, 400));
  logGateway("connect_purge_user_data", { telegramUsername });
}

const AUTH_METHOD_MARKER = "connect-auth-method.json";

function authMethodMarkerPath(telegramUsername: string): string {
  return path.join(getTdlibUserDir(telegramUsername), AUTH_METHOD_MARKER);
}

function readStoredAuthMethod(telegramUsername: string): ConnectAuthMethod | null {
  try {
    const markerPath = authMethodMarkerPath(telegramUsername);
    if (!fs.existsSync(markerPath)) return null;
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { authMethod?: string };
    if (raw.authMethod === "phone") return "phone";
    if (raw.authMethod === "qr") return "qr";
    return null;
  } catch {
    return null;
  }
}

function writeStoredAuthMethod(telegramUsername: string, authMethod: ConnectAuthMethod): void {
  const base = getTdlibUserDir(telegramUsername);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(authMethodMarkerPath(telegramUsername), JSON.stringify({ authMethod }));
}

function clearStoredAuthMethod(telegramUsername: string): void {
  const markerPath = authMethodMarkerPath(telegramUsername);
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
}

function resolveConnectAuthMethod(
  telegramUsername: string,
  requested: ConnectAuthMethod,
  fresh?: boolean,
): ConnectAuthMethod {
  if (fresh) return requested;
  const stored = readStoredAuthMethod(telegramUsername);
  if (stored === "phone" && requested === "qr") {
    logGateway("connect_auth_method_override", { telegramUsername, requested, stored });
    return "phone";
  }
  return requested;
}

const IN_PROGRESS_PHONE_STATES = new Set<ConnectAuthState>([
  "initializing",
  "wait_phone",
  "wait_code",
  "wait_password",
]);

const MID_CONNECT_STATES = new Set<ConnectAuthState>([
  "initializing",
  "wait_qr",
  "wait_phone",
  "wait_code",
  "wait_password",
]);

function isInProgressPhoneAttempt(record: AttemptRecord): boolean {
  return record.authMethod === "phone" && IN_PROGRESS_PHONE_STATES.has(record.authState);
}

function isMidConnectAttempt(record: AttemptRecord): boolean {
  return MID_CONNECT_STATES.has(record.authState);
}

function pinConnectAuth(record: AttemptRecord): void {
  pinGatewayUserSession(record.telegramUsername, "connect_auth");
  touchGatewayUserActivity(record.telegramUsername);
}

function unpinConnectAuth(telegramUsername: string): void {
  unpinGatewayUserSession(telegramUsername, "connect_auth");
}

export async function startConnectAttempt(
  telegramUsername: string,
  options?: { fresh?: boolean; authMethod?: ConnectAuthMethod },
): Promise<ConnectAttemptSnapshot> {
  const authMethod = resolveConnectAuthMethod(
    telegramUsername,
    options?.authMethod === "phone" ? "phone" : "qr",
    options?.fresh,
  );

  if (options?.fresh) {
    await purgeTdlibUserData(telegramUsername);
  } else {
    const existingId = activeByUser.get(telegramUsername);
    if (existingId) {
      const existing = attempts.get(existingId);
      if (existing && existing.authState !== "failed") {
        // Never clobber an in-flight QR / phone / 2FA attempt (unless fresh=true).
        // Concurrent warmup/resume used to dispose mid-connect → client poll 404 attempt_not_found.
        if (isMidConnectAttempt(existing)) {
          pinConnectAuth(existing);
          logConnectEvent(existing, "connect_reuse_mid_auth", {
            requestedAuthMethod: authMethod,
            ageMs: Date.now() - existing.createdAt,
          });
          return snapshot(existing);
        }
        if (Date.now() - existing.createdAt < 15 * 60_000) {
          if (isInProgressPhoneAttempt(existing) && authMethod === "qr") {
            return snapshot(existing);
          }
          if (existing.authMethod === authMethod) {
            if (existing.authState === "ready") attachLiveChatSync(existing);
            return snapshot(existing);
          }
        }
      }
      disposeAttempt(existingId);
    }
  }

  if (!getTelegramApiCredentials()) {
    return {
      attemptId: "",
      telegramUsername,
      authState: "failed",
      qrLink: null,
      error: "telegram_api_credentials_missing",
      chatCount: null,
      codeDelivery: null,
    };
  }

  const attemptId = randomUUID();
  const record: AttemptRecord = {
    attemptId,
    telegramUsername,
    authState: "initializing",
    qrLink: null,
    error: null,
    chatCount: null,
    codeDelivery: null,
    client: null,
    passwordResolve: null,
    createdAt: Date.now(),
    connectionState: null,
    qrRequested: false,
    authMethod,
    watchdogTimer: null,
  };

  attempts.set(attemptId, record);
  activeByUser.set(telegramUsername, attemptId);
  pinConnectAuth(record);
  if (authMethod === "phone") {
    writeStoredAuthMethod(telegramUsername, "phone");
  }

  try {
    const client = createTdlibClient(telegramUsername, (created) => {
      record.client = created;
      attachAuthListener(record);
    });
    record.client = client;
    startConnectWatchdog(record);
    // Return immediately; auth listener + client poll pick up QR / password / ready.
    return snapshot(record);
  } catch (err) {
    record.authState = "failed";
    record.error = err instanceof Error ? err.message : "connect_failed";
    return snapshot(record);
  }
}

export function getConnectAttempt(attemptId: string): ConnectAttemptSnapshot | null {
  const record = attempts.get(attemptId);
  if (!record) return null;
  if (isMidConnectAttempt(record)) {
    pinConnectAuth(record);
  } else {
    touchGatewayUserActivity(record.telegramUsername);
  }
  return snapshot(record);
}

export async function submitConnectPhoneNumber(
  attemptId: string,
  phoneNumber: string,
  options?: { isCurrentPhoneNumber?: boolean },
): Promise<ConnectAttemptSnapshot | null> {
  const record = attempts.get(attemptId);
  if (!record) return null;
  if (!record.client) {
    await waitForAuthState(record, ["wait_phone", "failed"], 45_000);
  }
  if (!record.client) return snapshot(record);
  if (record.authState === "ready") return snapshot(record);
  if (record.authMethod !== "phone") {
    record.error = "wrong_auth_method";
    return snapshot(record);
  }
  if (record.authState === "initializing") {
    await waitForAuthState(record, ["wait_phone", "failed"], 45_000);
  }
  if (record.authState !== "wait_phone") {
    if (record.authState === "wait_code" || record.authState === "wait_password") {
      return snapshot(record);
    }
    record.error = "session_not_ready";
    return snapshot(record);
  }

  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized || normalized.length < 8) {
    record.error = "invalid_phone_number";
    return snapshot(record);
  }

  record.error = null;
  const useCurrentPhone = Boolean(options?.isCurrentPhoneNumber);
  const invokePhone = async (): Promise<void> => {
    await record.client!.invoke({
      _: "setAuthenticationPhoneNumber",
      phone_number: normalized,
      settings: {
        _: "phoneNumberAuthenticationSettings",
        allow_flash_call: false,
        allow_missed_call: false,
        is_current_phone_number: useCurrentPhone,
        has_unknown_phone_number: false,
        allow_sms_retriever_api: false,
        firebase_authentication_settings: null,
        authentication_tokens: [],
      },
    });
  };

  try {
    await waitForConnectionReady(record, 30_000);
    let lastError: Error | null = null;
    for (let tryNum = 0; tryNum < 4; tryNum++) {
      try {
        if (record.authState === "wait_code" || record.authState === "wait_password") {
          lastError = null;
          break;
        }
        await invokePhone();
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (record.authState === "wait_code" || record.authState === "wait_password") {
          lastError = null;
          break;
        }
        const retryable = /another authorization query|call_flood|wait/i.test(lastError.message);
        if (!retryable || tryNum === 3) throw lastError;
        logConnectEvent(record, "connect_phone_retry", {
          message: lastError.message,
          tryNum: tryNum + 1,
        });
        await new Promise((r) => setTimeout(r, 800 * (tryNum + 1)));
        await waitForConnectionReady(record, 15_000);
      }
    }
    await waitForAuthState(record, ["wait_code", "wait_password", "ready", "failed"], 30_000);
    if (record.authState === "wait_code") {
      await syncCodeDeliveryFromClient(record);
      record.error = null;
      logConnectEvent(record, "connect_phone_code_sent", {
        isCurrentPhone: useCurrentPhone,
        codeType: record.codeDelivery?.type ?? null,
        phoneMasked: record.codeDelivery?.phoneMasked ?? null,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "phone_rejected";
    if (record.authState === "wait_code") {
      await syncCodeDeliveryFromClient(record);
      record.error = null;
      logConnectEvent(record, "connect_phone_code_sent_after_error", {
        message,
        codeType: record.codeDelivery?.type ?? null,
        phoneMasked: record.codeDelivery?.phoneMasked ?? null,
      });
      return snapshot(record);
    }
    if (/not found|authorization_closed|session/i.test(message)) {
      record.authState = "failed";
      record.error = "session_expired_restart";
    } else {
      record.authState = "wait_phone";
      record.error = message;
    }
    logConnectEvent(record, "connect_phone_rejected", { message });
  }
  return snapshot(record);
}

export async function resendConnectCode(attemptId: string): Promise<ConnectAttemptSnapshot | null> {
  const record = attempts.get(attemptId);
  if (!record?.client) return record ? snapshot(record) : null;
  if (record.authState !== "wait_code") return snapshot(record);
  record.error = null;
  try {
    await record.client.invoke({ _: "resendAuthenticationCode" });
    await syncCodeDeliveryFromClient(record);
    logConnectEvent(record, "connect_code_resent", {
      codeType: record.codeDelivery?.type ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "resend_failed";
    record.error = message;
    logConnectEvent(record, "connect_code_resend_failed", { message });
  }
  return snapshot(record);
}

export async function submitConnectCode(
  attemptId: string,
  code: string,
): Promise<ConnectAttemptSnapshot | null> {
  const record = attempts.get(attemptId);
  if (!record?.client) return record ? snapshot(record) : null;
  if (record.authState === "ready") return snapshot(record);
  if (record.authMethod !== "phone") {
    record.error = "wrong_auth_method";
    return snapshot(record);
  }

  const trimmed = code.trim();
  if (!trimmed) {
    record.error = "code_required";
    return snapshot(record);
  }

  record.error = null;
  try {
    await record.client.invoke({ _: "checkAuthenticationCode", code: trimmed });
    await waitForAuthState(record, ["wait_password", "ready", "failed"], 30_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : "code_rejected";
    if (/not found|authorization_closed|session/i.test(message)) {
      record.authState = "failed";
      record.error = "session_expired_restart";
    } else {
      record.authState = "wait_code";
      record.error = message;
    }
    logConnectEvent(record, "connect_code_rejected", { message });
  }
  return snapshot(record);
}

export async function submitConnectPassword(
  attemptId: string,
  password: string,
): Promise<ConnectAttemptSnapshot | null> {
  const record = attempts.get(attemptId);
  if (!record?.client) return record ? snapshot(record) : null;
  if (record.authState === "ready") return snapshot(record);

  try {
    await record.client.invoke({ _: "checkAuthenticationPassword", password });
    await waitForAuthState(record, ["ready", "failed"], 30_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : "password_rejected";
    if (/not found|authorization_closed|session/i.test(message)) {
      record.authState = "failed";
      record.error = "session_expired_restart";
    } else {
      record.authState = "wait_password";
      record.error = message;
    }
    logConnectEvent(record, "connect_password_rejected", { message });
  }
  return snapshot(record);
}

export function disposeAttempt(attemptId: string): void {
  void disposeAttemptAsync(attemptId);
}

async function disposeAttemptAsync(attemptId: string): Promise<void> {
  const record = attempts.get(attemptId);
  if (!record) return;
  detachLiveChatSync(record.telegramUsername);
  clearConnectWatchdog(record);
  unpinConnectAuth(record.telegramUsername);
  attempts.delete(attemptId);
  if (activeByUser.get(record.telegramUsername) === attemptId) {
    activeByUser.delete(record.telegramUsername);
  }
  if (record.client) {
    try {
      await record.client.close();
    } catch {
      /* ignore */
    }
    record.client = null;
  }
  await new Promise((r) => setTimeout(r, 300));
}

/** Soft-close in-memory TDLib client; keep on-disk auth for later wake. */
export async function softUnloadGatewayUserSession(telegramUsername: string): Promise<void> {
  const attemptId = activeByUser.get(telegramUsername);
  if (!attemptId) {
    clearGatewayUserIdleState(telegramUsername);
    return;
  }
  const record = attempts.get(attemptId);
  // Mid-QR / 2FA must never be idle-unloaded even if a pin was missed.
  if (record && isMidConnectAttempt(record)) {
    pinConnectAuth(record);
    logConnectEvent(record, "connect_idle_unload_skipped_mid_auth", {});
    return;
  }
  await disposeAttemptAsync(attemptId);
  clearGatewayUserIdleState(telegramUsername);
}

export async function disconnectUserSession(telegramUsername: string): Promise<void> {
  const attemptId = activeByUser.get(telegramUsername);
  if (attemptId) await disposeAttemptAsync(attemptId);
  clearGatewayUserIdleState(telegramUsername);

  const base = getTdlibUserDir(telegramUsername);
  if (fs.existsSync(base)) {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function getActiveRecord(telegramUsername: string): AttemptRecord | null {
  const attemptId = activeByUser.get(telegramUsername);
  if (!attemptId) return null;
  return attempts.get(attemptId) ?? null;
}

/** On-disk TDLib database exists for this app user (survives gateway process restarts when volume mounted). */
export function hasPersistedTdlibSession(telegramUsername: string): boolean {
  return fs.existsSync(path.join(getTdlibUserDir(telegramUsername), "db"));
}

/** Usernames with a persisted TDLib `db` directory under {@link getTdlibDbRoot}. */
export function listPersistedSessionUsernames(): string[] {
  const root = getTdlibDbRoot();
  if (!fs.existsSync(root)) return [];
  const usernames: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(root, entry.name, "db"))) usernames.push(entry.name);
  }
  return usernames;
}

const sessionRestoreInflight = new Map<string, Promise<AttemptRecord | null>>();

/**
 * Ensure TDLib is loaded for a user — restores from on-disk session after gateway redeploy.
 * Deduplicates concurrent restore attempts for the same username.
 */
export async function ensureGatewayUserSession(
  telegramUsername: string,
  timeoutMs: number,
): Promise<AttemptRecord | null> {
  await waitForGatewayUserUnload(telegramUsername);

  const active = getActiveRecord(telegramUsername);
  if (active?.client && active.authState === "ready") {
    touchGatewayUserActivity(telegramUsername);
    return active;
  }
  // Do not kick off a restore/replace while the user is scanning QR or entering 2FA.
  if (active && isMidConnectAttempt(active)) {
    pinConnectAuth(active);
    touchGatewayUserActivity(telegramUsername);
    return active;
  }

  if (!hasPersistedTdlibSession(telegramUsername)) {
    return active;
  }

  const inflight = sessionRestoreInflight.get(telegramUsername);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      let record = getActiveRecord(telegramUsername);
      if (record?.client && record.authState === "ready") {
        touchGatewayUserActivity(telegramUsername);
        return record;
      }
      if (!record || record.authState === "failed") {
        await startConnectAttempt(telegramUsername);
      }
      const ready = await waitForUserSessionReady(telegramUsername, timeoutMs);
      if (ready?.client && ready.authState === "ready") {
        touchGatewayUserActivity(telegramUsername);
      }
      return ready;
    } finally {
      sessionRestoreInflight.delete(telegramUsername);
    }
  })();

  sessionRestoreInflight.set(telegramUsername, promise);
  return promise;
}

async function requireReadySession(
  telegramUsername: string,
  timeoutMs: number,
): Promise<AttemptRecord | null> {
  const record = await ensureGatewayUserSession(telegramUsername, timeoutMs);
  if (!record?.client || record.authState !== "ready") return null;
  return record;
}

async function requireReadySessionFast(
  telegramUsername: string,
): Promise<AttemptRecord | null> {
  const active = getActiveRecord(telegramUsername);
  if (active?.client && active.authState === "ready") return active;
  return requireReadySession(telegramUsername, 8_000);
}

/** Resolve the live group call id for SSE (prefer getChat over stale client ids). */
export async function resolveVoiceStreamGroupCallId(
  telegramUsername: string,
  chatId: number,
  preferredGroupCallId?: number | null,
): Promise<number | null> {
  const record = await requireReadySessionFast(telegramUsername);
  if (!record?.client) {
    return normalizeTelegramGroupCallId(preferredGroupCallId);
  }
  try {
    const { resolveBoundGroupCallId } = await import("./voiceParticipants.js");
    const resolved = await resolveBoundGroupCallId(
      record.client,
      Math.trunc(chatId),
      preferredGroupCallId,
      { allowHistoryProbe: false },
    );
    if (resolved.callId > 0) return resolved.callId;
  } catch {
    /* fall through */
  }
  return normalizeTelegramGroupCallId(preferredGroupCallId);
}

type AvatarImageResult = { data: Buffer; mime: string } | "no_avatar" | null;
type CachedAvatarEntry = { value: AvatarImageResult; atMs: number };
const userAvatarCache = new Map<string, CachedAvatarEntry>();
const userAvatarAnimationCache = new Map<string, CachedAvatarEntry>();
/** Cold getUser often lacks profile_photo — keep miss TTL short so hydration can recover. */
const USER_NO_AVATAR_TTL_MS = 15_000;
const USER_AVATAR_OK_TTL_MS = 10 * 60_000;
const chatAvatarCache = new Map<string, AvatarImageResult>();

function avatarCacheKey(telegramUsername: string, id: number): string {
  return `${telegramUsername}:${id}`;
}

/** Active in-memory connect attempt for a user, if any. */
export function getUserConnectSnapshot(telegramUsername: string): ConnectAttemptSnapshot | null {
  const record = getActiveRecord(telegramUsername);
  return record ? snapshot(record) : null;
}

async function waitForUserSessionReady(
  telegramUsername: string,
  timeoutMs: number,
): Promise<AttemptRecord | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = getActiveRecord(telegramUsername);
    if (record?.client && record.authState === "ready") return record;
    if (record?.authState === "failed") return record;
    await new Promise((r) => setTimeout(r, 250));
  }
  return getActiveRecord(telegramUsername);
}

/** Resume an existing on-disk TDLib session (fast — client polls for QR/ready). */
export async function resumeExistingSession(
  telegramUsername: string,
  options?: { authMethod?: ConnectAuthMethod },
): Promise<ConnectAttemptSnapshot> {
  const base = getTdlibUserDir(telegramUsername);
  if (!fs.existsSync(path.join(base, "db"))) {
    return {
      attemptId: "",
      telegramUsername,
      authState: "failed",
      qrLink: null,
      error: "no_session",
      chatCount: null,
      codeDelivery: null,
    };
  }
  const active = getActiveRecord(telegramUsername);
  if (active && active.authState !== "failed") {
    return snapshot(active);
  }
  return startConnectAttempt(telegramUsername, { authMethod: options?.authMethod });
}

export async function listContactsForUser(
  telegramUsername: string,
): Promise<
  Array<{
    userId: number;
    firstName: string;
    lastName: string;
    username: string | null;
    chatId: number | null;
  }>
> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];

  try {
    const result = (await record.client.invoke({ _: "getContacts" })) as { user_ids?: number[] };
    const rows: Array<{
      userId: number;
      firstName: string;
      lastName: string;
      username: string | null;
      chatId: number | null;
    }> = [];
    for (const userId of result.user_ids ?? []) {
      if (!Number.isFinite(userId) || userId <= 0) continue;
      const user = (await record.client.invoke({ _: "getUser", user_id: userId })) as {
        first_name?: string;
        last_name?: string;
        username?: string;
      };
      let chatId: number | null = null;
      try {
        const chat = (await record.client.invoke({
          _: "createPrivateChat",
          user_id: userId,
          force: true,
        })) as { id?: number };
        chatId = typeof chat.id === "number" ? chat.id : null;
      } catch {
        chatId = null;
      }
      rows.push({
        userId,
        firstName: typeof user.first_name === "string" ? user.first_name : "",
        lastName: typeof user.last_name === "string" ? user.last_name : "",
        username: typeof user.username === "string" ? user.username : null,
        chatId,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export type ChatSearchHit = {
  chatId: number;
  title: string;
  peerUserId: number | null;
  peerUsername: string | null;
  chatUsername: string | null;
  chatKind: "private" | "group" | "supergroup" | "channel" | null;
};

async function collectChatSearchHit(
  client: Client,
  chatId: number,
  collected: Map<number, ChatSearchHit>,
  usernameHint?: string | null,
): Promise<void> {
  if (!Number.isFinite(chatId) || chatId === 0 || collected.has(chatId)) return;
  try {
    const chatPreview = await import("./chatPreview.js");
    const messageHistoryMap = await import("./messageHistoryMap.js");
    const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
    const hint = usernameHint?.trim().replace(/^@+/, "") || null;
    const peerUserId = chatPreview.peerUserIdFromChat(chat);
    let peerUsername = chatPreview.peerUsernameFromChat(chat);
    // Private chats store username on the User object, not chat.type.
    if (!peerUsername && peerUserId != null && peerUserId !== 0) {
      try {
        const user = (await client.invoke({ _: "getUser", user_id: peerUserId })) as {
          username?: string;
          usernames?: { active_usernames?: string[]; editable_username?: string };
        };
        peerUsername = chatPreview.usernameFromTdUser(user);
      } catch {
        /* keep null */
      }
    }
    collected.set(chatId, {
      chatId,
      title: chatPreview.chatTitle(chat),
      peerUserId,
      peerUsername: peerUsername ?? (hint && peerUserId != null ? hint : null),
      chatUsername: chatPreview.chatUsernameFromChat(chat) ?? (peerUserId == null ? hint : null),
      chatKind: messageHistoryMap.chatKindFromTdChat(chat),
    });
  } catch {
    /* skip unavailable chat */
  }
}

/** Strip leading @ for TDLib public/username queries; keep multi-word titles intact. */
function normalizeGlobalSearchQuery(query: string): {
  trimmed: string;
  bare: string;
  looksLikeUsername: boolean;
} {
  const trimmed = query.trim();
  const bare = trimmed.replace(/^@+/, "").trim();
  // Telegram public usernames are 5–32 chars; allow 4+ so short prefixes still try exact resolve.
  const looksLikeUsername = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(bare);
  return { trimmed, bare, looksLikeUsername };
}

export type CategorizedChatSearchBuckets = {
  direct: ChatSearchHit[];
  global: ChatSearchHit[];
};

async function collectCategorizedChatSearchBuckets(
  client: Client,
  query: string,
): Promise<{ direct: Map<number, ChatSearchHit>; global: Map<number, ChatSearchHit> }> {
  const { trimmed, bare, looksLikeUsername } = normalizeGlobalSearchQuery(query);
  const direct = new Map<number, ChatSearchHit>();
  const global = new Map<number, ChatSearchHit>();
  if (!trimmed) return { direct, global };

  const textQuery = trimmed.startsWith("@") ? bare : trimmed;

  // tdesktop: top section — local + server-known chats (with message previews).
  try {
    const result = (await client.invoke({
      _: "searchChats",
      query: textQuery,
      limit: 50,
    })) as { chat_ids?: number[] };
    for (const chatId of result.chat_ids ?? []) {
      await collectChatSearchHit(client, chatId, direct);
    }
  } catch {
    /* skip */
  }

  try {
    const result = (await client.invoke({
      _: "searchChatsOnServer",
      query: textQuery,
      limit: 40,
    })) as { chat_ids?: number[] };
    for (const chatId of result.chat_ids ?? []) {
      await collectChatSearchHit(client, chatId, direct);
    }
  } catch {
    /* optional method / older TDLib */
  }

  // tdesktop: "Global search results" — recents + public directory.
  try {
    const result = (await client.invoke({
      _: "searchRecentlyFoundChats",
      query: textQuery,
      limit: 30,
    })) as { chat_ids?: number[] };
    for (const chatId of result.chat_ids ?? []) {
      await collectChatSearchHit(client, chatId, global);
    }
  } catch {
    /* optional / older TDLib */
  }

  try {
    const publicQuery = looksLikeUsername ? bare : textQuery;
    if (publicQuery.length > 0) {
      const result = (await client.invoke({
        _: "searchPublicChats",
        query: publicQuery,
      })) as { chat_ids?: number[] };
      for (const chatId of (result.chat_ids ?? []).slice(0, 40)) {
        await collectChatSearchHit(client, chatId, global, looksLikeUsername ? bare : null);
      }
    }
  } catch {
    /* optional */
  }

  if (looksLikeUsername) {
    try {
      const chat = (await client.invoke({
        _: "searchPublicChat",
        username: bare,
      })) as TdChat;
      if (typeof chat?.id === "number") {
        await collectChatSearchHit(client, chat.id, global, bare);
      }
    } catch {
      /* username not found / private */
    }
  }

  for (const chatId of direct.keys()) {
    global.delete(chatId);
  }

  return { direct, global };
}

export async function searchChatsCategorizedForUser(
  telegramUsername: string,
  query: string,
): Promise<CategorizedChatSearchBuckets> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return { direct: [], global: [] };

  const { trimmed } = normalizeGlobalSearchQuery(query);
  if (!trimmed) return { direct: [], global: [] };

  const { direct, global } = await collectCategorizedChatSearchBuckets(record.client, query);
  return {
    direct: [...direct.values()],
    global: [...global.values()],
  };
}

export async function searchChatsForUser(
  telegramUsername: string,
  query: string,
): Promise<ChatSearchHit[]> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];

  const { trimmed } = normalizeGlobalSearchQuery(query);
  if (!trimmed) return [];

  const { direct, global } = await collectCategorizedChatSearchBuckets(record.client, query);
  return [...direct.values(), ...global.values()];
}

export type MessageSearchResult = {
  chatIds: number[];
  messageCount: number;
};

/** Global message search — distinct chat ids plus total message hit count (tdesktop footer). */
export async function searchMessagesForUser(
  telegramUsername: string,
  query: string,
): Promise<MessageSearchResult> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return { chatIds: [], messageCount: 0 };

  const trimmed = query.trim().replace(/^@+/, "").trim();
  if (!trimmed) return { chatIds: [], messageCount: 0 };

  const collected = new Set<number>();
  let messageCount = 0;
  for (const chatList of [{ _: "chatListMain" as const }, { _: "chatListArchive" as const }]) {
    try {
      const result = (await record.client.invoke({
        _: "searchMessages",
        chat_list: chatList,
        query: trimmed,
        offset_date: 0,
        offset_chat_id: 0,
        offset_message_id: 0,
        limit: 40,
        filter: { _: "searchMessagesFilterEmpty" },
        min_date: 0,
        max_date: 0,
      })) as { messages?: Array<{ chat_id?: number }>; total_count?: number };
      const total =
        typeof result.total_count === "number" && Number.isFinite(result.total_count)
          ? Math.trunc(result.total_count)
          : (result.messages?.length ?? 0);
      messageCount += total;
      for (const message of result.messages ?? []) {
        const chatId = typeof message.chat_id === "number" ? message.chat_id : 0;
        if (Number.isFinite(chatId) && chatId !== 0) collected.add(Math.trunc(chatId));
      }
    } catch {
      /* skip list */
    }
  }
  return { chatIds: [...collected], messageCount };
}

/** Global message search — returns distinct chat ids with matching message text. */
export async function searchMessagesChatIdsForUser(
  telegramUsername: string,
  query: string,
): Promise<number[]> {
  const result = await searchMessagesForUser(telegramUsername, query);
  return result.chatIds;
}

/** Hydrate chat ids (e.g. message-search hits) into displayable search stubs. */
export async function hydrateChatSearchHitsForUser(
  telegramUsername: string,
  chatIds: number[],
): Promise<ChatSearchHit[]> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];
  const collected = new Map<number, ChatSearchHit>();
  for (const raw of chatIds) {
    await collectChatSearchHit(record.client, raw, collected);
  }
  return [...collected.values()];
}

/** Empty-query recents — TDLib `searchRecentlyFoundChats` (search history), not all known chats. */
export async function searchRecentlyFoundChatsForUser(
  telegramUsername: string,
  limit = 50,
): Promise<ChatSearchHit[]> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];
  let chatIds: number[] = [];
  try {
    const result = (await record.client.invoke({
      _: "searchRecentlyFoundChats",
      query: "",
      limit,
    })) as { chat_ids?: number[] };
    chatIds = (result.chat_ids ?? [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id !== 0)
      .map((id) => Math.trunc(id));
  } catch {
    // Older TDLib / transient: fall back to empty rather than dumping all known chats.
    return [];
  }
  return hydrateChatSearchHitsForUser(telegramUsername, chatIds);
}

export async function removeRecentlyFoundChatForUser(
  telegramUsername: string,
  chatId: number,
): Promise<boolean> {
  if (!Number.isFinite(chatId) || chatId === 0) return false;
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return false;
  try {
    await record.client.invoke({
      _: "removeRecentlyFoundChat",
      chat_id: Math.trunc(chatId),
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearRecentlyFoundChatsForUser(telegramUsername: string): Promise<boolean> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return false;
  try {
    await record.client.invoke({ _: "clearRecentlyFoundChats" });
    return true;
  } catch {
    return false;
  }
}

export async function addRecentlyFoundChatForUser(
  telegramUsername: string,
  chatId: number,
): Promise<boolean> {
  if (!Number.isFinite(chatId) || chatId === 0) return false;
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return false;
  try {
    await record.client.invoke({
      _: "addRecentlyFoundChat",
      chat_id: Math.trunc(chatId),
    });
    return true;
  } catch {
    return false;
  }
}

export async function searchContactsForUser(
  telegramUsername: string,
  query: string,
): Promise<
  Array<{
    userId: number;
    firstName: string;
    lastName: string;
    username: string | null;
    chatId: number | null;
  }>
> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];

  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const chatPreview = await import("./chatPreview.js");
    const searchQuery = trimmed.replace(/^@+/, "").trim() || trimmed;
    const result = (await record.client.invoke({
      _: "searchContacts",
      query: searchQuery,
      limit: 30,
    })) as { user_ids?: number[] };
    const rows: Array<{
      userId: number;
      firstName: string;
      lastName: string;
      username: string | null;
      chatId: number | null;
    }> = [];
    for (const userId of result.user_ids ?? []) {
      if (!Number.isFinite(userId) || userId <= 0) continue;
      const user = (await record.client.invoke({ _: "getUser", user_id: userId })) as {
        first_name?: string;
        last_name?: string;
        username?: string;
        usernames?: { active_usernames?: string[]; editable_username?: string };
      };
      let chatId: number | null = null;
      try {
        const chat = (await record.client.invoke({
          _: "createPrivateChat",
          user_id: userId,
          force: true,
        })) as { id?: number };
        chatId = typeof chat.id === "number" ? chat.id : null;
      } catch {
        chatId = null;
      }
      rows.push({
        userId,
        firstName: typeof user.first_name === "string" ? user.first_name : "",
        lastName: typeof user.last_name === "string" ? user.last_name : "",
        username: chatPreview.usernameFromTdUser(user),
        chatId,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

const RESYNC_HTTP_SESSION_WAIT_MS = 10_000;
const RESYNC_RESTORE_SESSION_WAIT_MS = 90_000;

export { RESYNC_HTTP_SESSION_WAIT_MS, RESYNC_RESTORE_SESSION_WAIT_MS };

/** Re-sync chat list + avatars for an already-authorized user (no QR). */
export async function resyncUserChats(
  telegramUsername: string,
  options?: { chatIds?: number[]; maxWaitMs?: number },
): Promise<{ chatCount: number; backfillCount: number; error: string | null }> {
  logGateway("connect_resync_start", {
    telegramUsername,
    hasActiveRecord: Boolean(getActiveRecord(telegramUsername)),
    backfillOnly: Boolean(options?.chatIds?.length),
    backfillTargets: options?.chatIds?.length ?? 0,
  });

  let record = getActiveRecord(telegramUsername);
  if (!record?.client || record.authState !== "ready") {
    if (!hasPersistedTdlibSession(telegramUsername)) {
      logGateway("connect_resync_no_session", { telegramUsername });
      return { chatCount: 0, backfillCount: 0, error: "no_session" };
    }
    const maxWaitMs = options?.maxWaitMs ?? RESYNC_RESTORE_SESSION_WAIT_MS;
    record = await ensureGatewayUserSession(telegramUsername, maxWaitMs);
  }

  if (!record?.client || record.authState !== "ready") {
    const error = record?.authState === "failed" ? (record.error ?? "session_not_ready") : "session_not_ready";
    logGateway("connect_resync_not_ready", {
      telegramUsername,
      authState: record?.authState ?? null,
      error,
    });
    return { chatCount: 0, backfillCount: 0, error };
  }

  attachLiveChatSync(record);
  try {
    if (options?.chatIds?.length) {
      const backfillCount = await refreshLiveChats(record.client, telegramUsername, options.chatIds);
      logConnectEvent(record, "connect_backfill_ok", { backfillCount });
      return { chatCount: record.chatCount ?? 0, backfillCount, error: null };
    }

    const count = await syncChatThreads(record.client, telegramUsername, {
      maxMainChats: null,
      includeArchive: true,
      includeSupplementarySearch: false,
      skipMemberCounts: true,
      replaceCache: true,
    });
    record.chatCount = count;
    scheduleBackgroundChatSync(record.client, telegramUsername);
    logConnectEvent(record, "connect_resync_ok", { chatCount: count });
    return { chatCount: count, backfillCount: 0, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync_failed";
    logConnectEvent(record, "connect_resync_failed", { message });
    return { chatCount: 0, backfillCount: 0, error: message };
  }
}

/** Nudge background chat paging (idempotent — no-op if already running). */
export function requestBackgroundChatSync(
  telegramUsername: string,
  tier: "positioned" | "unpositioned" = "positioned",
): {
  started: boolean;
  inProgress: boolean;
  warming?: boolean;
} {
  const record = getActiveRecord(telegramUsername);
  const tierInProgress =
    tier === "unpositioned"
      ? isTier3ChatSyncInProgress(telegramUsername)
      : isBackgroundChatSyncInProgress(telegramUsername);

  if (!record?.client || record.authState !== "ready") {
    if (!tierInProgress) {
      void ensureGatewayUserSession(telegramUsername, 20_000).then((restored) => {
        if (restored?.client && restored.authState === "ready") {
          if (tier === "unpositioned") {
            scheduleTier3ChatSync(restored.client, telegramUsername);
          } else {
            scheduleBackgroundChatSync(restored.client, telegramUsername);
          }
        }
      });
    }
    return { started: false, inProgress: tierInProgress, warming: true };
  }

  if (tier === "unpositioned") {
    if (!isPositionedComplete(telegramUsername)) {
      const wasInProgress = isBackgroundChatSyncInProgress(telegramUsername);
      scheduleBackgroundChatSync(record.client, telegramUsername);
      return { started: !wasInProgress, inProgress: true };
    }
    const wasInProgress = isTier3ChatSyncInProgress(telegramUsername);
    scheduleTier3ChatSync(record.client, telegramUsername);
    return { started: !wasInProgress, inProgress: true };
  }

  const wasInProgress = isBackgroundChatSyncInProgress(telegramUsername);
  scheduleBackgroundChatSync(record.client, telegramUsername);
  return { started: !wasInProgress, inProgress: true };
}

/** After gateway restart: lazy = remember disks only; eager = open every session now. */
export function restorePersistedGatewaySessions(): void {
  const usernames = listPersistedSessionUsernames();
  const restoreMode = getTdlibRestoreMode();

  registerClientIdleHooks({
    listLiveUsernames: () => [...activeByUser.keys()],
    softUnloadUser: softUnloadGatewayUserSession,
    isSessionRestoreInflight: (telegramUsername) => sessionRestoreInflight.has(telegramUsername),
  });

  if (usernames.length === 0) {
    logGateway("connect_restore_sessions_none", { tdlibDbRoot: getTdlibDbRoot(), restoreMode });
    return;
  }

  if (restoreMode === "lazy") {
    logGateway("connect_restore_sessions_lazy", {
      count: usernames.length,
      note: "Clients open on demand; auth remains on disk.",
      sample: usernames.slice(0, 8),
    });
    return;
  }

  logGateway("connect_restore_sessions_start", { count: usernames.length, restoreMode });

  for (const telegramUsername of usernames) {
    void (async () => {
      try {
        const record = await ensureGatewayUserSession(telegramUsername, RESYNC_RESTORE_SESSION_WAIT_MS);
        if (!record?.client || record.authState !== "ready") {
          logGateway("connect_restore_session_not_ready", {
            telegramUsername,
            authState: record?.authState ?? null,
            error: record?.error ?? null,
          });
          return;
        }
        attachLiveChatSync(record);
        const chatCount = await syncChatThreads(record.client, telegramUsername, {
          maxMainChats: null,
          includeArchive: true,
          includeSupplementarySearch: false,
          skipMemberCounts: true,
          replaceCache: true,
        });
        scheduleBackgroundChatSync(record.client, telegramUsername);
        logGateway("connect_restore_session_done", {
          telegramUsername,
          chatCount,
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logGateway("connect_restore_session_error", { telegramUsername, message });
      }
    })();
  }
}

export async function getChatAvatarImageForUser(
  telegramUsername: string,
  chatId: number,
): Promise<{ data: Buffer; mime: string } | "no_avatar" | null> {
  const cacheKey = avatarCacheKey(telegramUsername, chatId);
  const cached = chatAvatarCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const record = await requireReadySessionFast(telegramUsername);
  if (!record) return null;
  const result = await readChatAvatarBytes(record.client, chatId);
  const resolved: AvatarImageResult =
    result === TELEGRAM_THREAD_NO_AVATAR ? "no_avatar" : result;
  chatAvatarCache.set(cacheKey, resolved);
  return resolved;
}

export async function getUserAvatarImageForUser(
  telegramUsername: string,
  userId: number,
): Promise<{ data: Buffer; mime: string } | "no_avatar" | null> {
  const cacheKey = avatarCacheKey(telegramUsername, userId);
  const cached = userAvatarCache.get(cacheKey);
  if (cached !== undefined) {
    const ttl =
      cached.value === "no_avatar" || cached.value == null
        ? USER_NO_AVATAR_TTL_MS
        : USER_AVATAR_OK_TTL_MS;
    if (Date.now() - cached.atMs < ttl) return cached.value;
    userAvatarCache.delete(cacheKey);
  }

  const record = await requireReadySessionFast(telegramUsername);
  if (!record) return null;
  const result = await readUserAvatarBytes(record.client, userId);
  const resolved: AvatarImageResult =
    result === TELEGRAM_THREAD_NO_AVATAR ? "no_avatar" : result;
  userAvatarCache.set(cacheKey, { value: resolved, atMs: Date.now() });
  return resolved;
}

export async function getUserAvatarAnimationForUser(
  telegramUsername: string,
  userId: number,
): Promise<{ data: Buffer; mime: string } | "no_avatar" | null> {
  const cacheKey = `${avatarCacheKey(telegramUsername, userId)}:anim`;
  const cached = userAvatarAnimationCache.get(cacheKey);
  if (cached !== undefined) {
    const ttl =
      cached.value === "no_avatar" || cached.value == null
        ? USER_NO_AVATAR_TTL_MS
        : USER_AVATAR_OK_TTL_MS;
    if (Date.now() - cached.atMs < ttl) return cached.value;
    userAvatarAnimationCache.delete(cacheKey);
  }

  const record = await requireReadySessionFast(telegramUsername);
  if (!record) return null;
  const result = await readUserAvatarAnimationBytes(record.client, userId);
  const resolved: AvatarImageResult = result === "no_avatar" ? "no_avatar" : result;
  userAvatarAnimationCache.set(cacheKey, { value: resolved, atMs: Date.now() });
  return resolved;
}

export async function getUserProfileForUser(
  telegramUsername: string,
  chatId: number,
  peerUserId: number | null,
): Promise<
  | { ok: true; profile: Awaited<ReturnType<typeof import("./userProfile.js").fetchTelegramUserProfile>> }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    if (peerUserId == null || !Number.isFinite(peerUserId) || peerUserId === 0) {
      return { ok: false, error: "chat_id_or_user_id_required" };
    }
  }
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { fetchTelegramUserProfile } = await import("./userProfile.js");
  const profile = await fetchTelegramUserProfile(
    record.client,
    Math.trunc(chatId),
    peerUserId != null && Number.isFinite(peerUserId) ? Math.trunc(peerUserId) : null,
  );
  return { ok: true, profile };
}

export async function getProfileAudioFileForUser(
  telegramUsername: string,
  userId: number,
  fileId: number,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!Number.isFinite(userId) || userId === 0) return null;
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return null;
  const { readProfileAudioBytes } = await import("./profileMusic.js");
  return readProfileAudioBytes(record.client, Math.trunc(userId), Math.trunc(fileId));
}

export async function getProfileAudioCoverForUser(
  telegramUsername: string,
  userId: number,
  fileId: number,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!Number.isFinite(userId) || userId === 0) return null;
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return null;
  const { readProfileAudioCoverBytes } = await import("./profileMusic.js");
  return readProfileAudioCoverBytes(record.client, Math.trunc(userId), Math.trunc(fileId));
}

export async function blockUserForUser(
  telegramUsername: string,
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { blockTelegramUser } = await import("./userProfile.js");
  return blockTelegramUser(record.client, userId);
}

export async function unblockUserForUser(
  telegramUsername: string,
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { unblockTelegramUser } = await import("./userProfile.js");
  return unblockTelegramUser(record.client, userId);
}

export async function searchChatLinksForUser(
  telegramUsername: string,
  chatId: number,
  options?: { fromMessageId?: number | null; limit?: number },
): Promise<
  | { ok: true; links: Awaited<ReturnType<typeof import("./userProfile.js").searchChatLinks>>["links"]; has_more: boolean }
  | { ok: false; error: string }
> {
  const result = await searchChatMediaForUser(telegramUsername, chatId, "links", options);
  if (!result.ok) return result;
  return { ok: true, links: result.items, has_more: result.has_more };
}

export async function searchChatMediaForUser(
  telegramUsername: string,
  chatId: number,
  kind: import("./userProfile.js").ProfileMediaKind,
  options?: { fromMessageId?: number | null; limit?: number },
): Promise<
  | {
      ok: true;
      items: Awaited<ReturnType<typeof import("./userProfile.js").searchChatMedia>>["items"];
      has_more: boolean;
    }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "chat_id_required" };
  }
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { searchChatMedia } = await import("./userProfile.js");
  const result = await searchChatMedia(record.client, chatId, kind, options);
  return { ok: true, ...result };
}

export async function createPrivateCallForSession(
  telegramUsername: string,
  userId: number,
  options?: { isVideo?: boolean },
): Promise<
  | { ok: true; call: import("./privateCall.js").PrivateCallSnapshot }
  | { ok: false; error: string }
> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { createPrivateCallForUser } = await import("./privateCall.js");
  const result = await createPrivateCallForUser(record.client, telegramUsername, userId, options);
  if (result.ok) pinGatewayUserSession(telegramUsername, "private_call");
  return result;
}

export async function getPrivateCallForSession(
  telegramUsername: string,
  callId?: number | null,
): Promise<
  | { ok: true; call: import("./privateCall.js").PrivateCallSnapshot | null }
  | { ok: false; error: string }
> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { refreshPrivateCallForUser, getCachedPrivateCall } = await import("./privateCall.js");
  const call =
    (await refreshPrivateCallForUser(record.client, telegramUsername, callId)) ??
    getCachedPrivateCall(telegramUsername);
  return { ok: true, call };
}

export async function discardPrivateCallForSession(
  telegramUsername: string,
  callId?: number | null,
  durationSec?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { discardPrivateCallForUser } = await import("./privateCall.js");
  const result = await discardPrivateCallForUser(record.client, telegramUsername, callId, durationSec);
  if (result.ok) unpinGatewayUserSession(telegramUsername, "private_call");
  return result;
}

export async function acceptPrivateCallForSession(
  telegramUsername: string,
  callId: number,
): Promise<
  | { ok: true; call: import("./privateCall.js").PrivateCallSnapshot }
  | { ok: false; error: string }
> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { acceptPrivateCallForUser } = await import("./privateCall.js");
  const result = await acceptPrivateCallForUser(record.client, telegramUsername, callId);
  if (result.ok) pinGatewayUserSession(telegramUsername, "private_call");
  return result;
}

export async function sendPrivateCallSignalingForSession(
  telegramUsername: string,
  callId: number,
  dataBase64: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }
  const { sendPrivateCallSignalingData } = await import("./privateCall.js");
  return sendPrivateCallSignalingData(record.client, callId, dataBase64);
}

export async function getChatHistoryForUser(
  telegramUsername: string,
  chatId: number,
  limit = 50,
  beforeMessageId?: number | null,
  sinceMessageId?: number | null,
  aroundUnread = false,
  aroundMessageId?: number | null,
  olderAbove?: number | null,
  newerBelow?: number | null,
): Promise<{
  chat_kind: Awaited<ReturnType<typeof fetchChatHistory>>["chat_kind"];
  self_user_id: number | null;
  messages: Awaited<ReturnType<typeof fetchChatHistory>>["messages"];
  has_more_older: boolean;
  next_before_message_id: number | null;
  last_read_outbox_message_id: number | null;
  last_read_inbox_message_id: number | null;
  member_count: number | null;
  error: string | null;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return {
      chat_kind: "private",
      self_user_id: null,
      messages: [],
      has_more_older: false,
      next_before_message_id: null,
      last_read_outbox_message_id: null,
      last_read_inbox_message_id: null,
      member_count: null,
      error: "session_not_ready",
    };
  }
  try {
    const liveRow = getLiveChatList(telegramUsername)?.find((row) => row.telegram_chat_id === chatId);
    const loadSince =
      typeof sinceMessageId === "number" &&
      Number.isFinite(sinceMessageId) &&
      sinceMessageId > 0;
    const loadAroundMessage =
      typeof aroundMessageId === "number" &&
      Number.isFinite(aroundMessageId) &&
      aroundMessageId > 0;
    const result = loadSince
      ? await fetchChatHistorySince(record.client, chatId, sinceMessageId!, limit)
      : loadAroundMessage
        ? await fetchChatHistoryAroundMessage(
            record.client,
            chatId,
            aroundMessageId!,
            limit,
            typeof olderAbove === "number" && Number.isFinite(olderAbove) ? olderAbove : undefined,
            typeof newerBelow === "number" && Number.isFinite(newerBelow) ? newerBelow : undefined,
          )
      : aroundUnread
        ? await fetchChatHistoryAroundUnread(
            record.client,
            chatId,
            limit,
            liveRow?.last_read_inbox_message_id ?? null,
          )
        : await fetchChatHistory(record.client, chatId, limit, beforeMessageId);
    const memberCount =
      typeof result.member_count === "number" && result.member_count > 0
        ? result.member_count
        : typeof liveRow?.member_count === "number" && liveRow.member_count > 0
          ? liveRow.member_count
          : null;
    if (
      memberCount != null &&
      memberCount > 0 &&
      (liveRow?.member_count == null || liveRow.member_count !== memberCount)
    ) {
      patchLiveChatMemberMeta(telegramUsername, chatId, {
        member_count: memberCount,
        chat_kind: liveRow?.chat_kind ?? result.chat_kind,
      });
    }
    return {
      chat_kind: liveRow?.chat_kind ?? result.chat_kind,
      self_user_id: result.self_user_id,
      messages: result.messages,
      has_more_older: loadSince ? false : result.has_more_older,
      next_before_message_id: loadSince ? null : result.next_before_message_id,
      last_read_outbox_message_id: result.last_read_outbox_message_id,
      last_read_inbox_message_id: result.last_read_inbox_message_id ?? null,
      member_count: memberCount,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "history_failed";
    return {
      chat_kind: "private",
      self_user_id: null,
      messages: [],
      has_more_older: false,
      next_before_message_id: null,
      last_read_outbox_message_id: null,
      last_read_inbox_message_id: null,
      member_count: null,
      error: message,
    };
  }
}

export async function sendChatMessageForUser(
  telegramUsername: string,
  chatId: number,
  text: string,
  replyToMessageId?: number | null,
): Promise<{ message: Awaited<ReturnType<typeof sendChatTextMessage>>; error: string | null }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { message: null, error: "text_required" };
  }
  if (trimmed.length > 4096) {
    return { message: null, error: "text_too_long" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { message: null, error: "session_not_ready" };
  }

  try {
    const message = await sendChatTextMessage(record.client, chatId, trimmed, replyToMessageId);
    if (!message) {
      return { message: null, error: "send_failed" };
    }
    return { message, error: null };
  } catch (err) {
    return { message: null, error: classifyTdlibSendError(err, chatId) };
  }
}

export async function sendChatPhotoForUser(
  telegramUsername: string,
  chatId: number,
  photoBase64: string,
  options?: {
    caption?: string | null;
    mime?: string | null;
    replyToMessageId?: number | null;
  },
): Promise<{ message: Awaited<ReturnType<typeof sendChatPhotoMessage>>; error: string | null }> {
  const raw = typeof photoBase64 === "string" ? photoBase64.trim() : "";
  if (!raw) {
    return { message: null, error: "photo_required" };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.replace(/^data:[^;]+;base64,/, ""), "base64");
  } catch {
    return { message: null, error: "invalid_photo" };
  }
  if (bytes.length === 0) {
    return { message: null, error: "photo_required" };
  }
  if (bytes.length > 8 * 1024 * 1024) {
    return { message: null, error: "photo_too_large" };
  }

  const caption = typeof options?.caption === "string" ? options.caption.trim() : "";
  if (caption.length > 4096) {
    return { message: null, error: "text_too_long" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { message: null, error: "session_not_ready" };
  }

  try {
    const message = await sendChatPhotoMessage(record.client, chatId, bytes, {
      caption,
      mime: options?.mime ?? null,
      replyToMessageId: options?.replyToMessageId ?? null,
    });
    if (!message) {
      return { message: null, error: "send_failed" };
    }
    return { message, error: null };
  } catch (err) {
    return { message: null, error: classifyTdlibSendError(err, chatId) };
  }
}

export async function resolvePublicChatForUser(
  telegramUsername: string,
  username: string,
): Promise<{ chat: Record<string, unknown> | null; error: string | null }> {
  const name = username.trim().replace(/^@+/, "");
  if (!name) {
    return { chat: null, error: "username_required" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { chat: null, error: "session_not_ready" };
  }

  try {
    const chatPreview = await import("./chatPreview.js");
    const messageHistoryMap = await import("./messageHistoryMap.js");
    const chat = (await record.client.invoke({
      _: "searchPublicChat",
      username: name,
    })) as chatPreview.TdChat;

    return {
      chat: {
        telegram_chat_id: chat.id,
        title: chatPreview.chatTitle(chat),
        subtitle: "",
        avatar_url: null,
        last_message_at: chatPreview.lastMessageAtIso(chat),
        unread_count: chatPreview.normalizeUnreadCount(chat),
        peer_user_id: chatPreview.peerUserIdFromChat(chat),
        peer_username: name,
        chat_username: chatPreview.chatUsernameFromChat(chat) ?? name,
        chat_kind: messageHistoryMap.chatKindFromTdChat(chat),
        member_count: null,
      },
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve_failed";
    return { chat: null, error: message };
  }
}

export async function editChatMessageForUser(
  telegramUsername: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<{ message: Awaited<ReturnType<typeof editChatTextMessage>>; error: string | null }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { message: null, error: "text_required" };
  }
  if (trimmed.length > 4096) {
    return { message: null, error: "text_too_long" };
  }
  const telegramMessageId = Number(messageId);
  if (!Number.isFinite(telegramMessageId) || telegramMessageId <= 0) {
    return { message: null, error: "message_id_required" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { message: null, error: "session_not_ready" };
  }

  try {
    const message = await editChatTextMessage(
      record.client,
      chatId,
      telegramMessageId,
      trimmed,
    );
    if (!message) {
      return { message: null, error: "edit_failed" };
    }
    return { message, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "edit_failed";
    return { message: null, error: message };
  }
}

export async function deleteChatMessagesForUser(
  telegramUsername: string,
  chatId: number,
  messageIds: number[],
): Promise<{ deleted_message_ids: number[]; error: string | null }> {
  const ids = [
    ...new Set(
      messageIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id)),
    ),
  ];
  if (ids.length === 0) {
    return { deleted_message_ids: [], error: "message_id_required" };
  }
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { deleted_message_ids: [], error: "chat_id_required" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { deleted_message_ids: [], error: "session_not_ready" };
  }

  try {
    const result = await deleteChatMessages(record.client, chatId, ids);
    if (!result.ok) {
      return { deleted_message_ids: [], error: "delete_failed" };
    }
    const { noteLiveChatMessageDeletes } = await import("./liveChatDeletedMessages.js");
    const { bumpLiveChatRevision } = await import("./liveChatCache.js");
    if (noteLiveChatMessageDeletes(telegramUsername, chatId, result.deleted_message_ids)) {
      bumpLiveChatRevision(telegramUsername);
    }
    return { deleted_message_ids: result.deleted_message_ids, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "delete_failed";
    return { deleted_message_ids: [], error: message };
  }
}

export async function focusChatForUser(
  telegramUsername: string,
  chatId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(chatId)) {
    return { ok: false, error: "invalid_chat_id" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }

  try {
    await record.client.invoke({ _: "openChat", chat_id: chatId });
    const chatPreview = await import("./chatPreview.js");
    const chat = (await record.client.invoke({ _: "getChat", chat_id: chatId })) as chatPreview.TdChat;
    const { patchLiveChatFromTdlib } = await import("./liveChatCache.js");
    patchLiveChatFromTdlib(telegramUsername, chat, {});
    const { resolveBoundGroupCallId } = await import("./voiceParticipants.js");
    const resolved = await resolveBoundGroupCallId(record.client, chatId, null, {
      allowHistoryProbe: true,
    });
    // Always patch — including inactive clears — so stale rings / Join strip die.
    patchLiveChatVideoChat(telegramUsername, chatId, {
      ...resolved.voice,
      voice_chat_is_joined: false,
    });
    logGateway("chat_focus_video_chat", {
      telegramUsername,
      chatId,
      videoChat: resolved.videoChatRaw,
      hasActiveVoiceChat: resolved.voice.has_active_voice_chat,
      groupCallId: resolved.voice.voice_chat_group_call_id,
      resolveSource: resolved.source,
    });
    const peerUserId = chatPreview.peerUserIdFromChat(chat);
    if (peerUserId != null) {
      const { refreshPeerEmojiStatus } = await import("./syncChats.js");
      await refreshPeerEmojiStatus(record.client, telegramUsername, peerUserId);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "open_chat_failed";
    return { ok: false, error: message };
  }
}

export async function viewChatInboxMessagesForUser(
  telegramUsername: string,
  chatId: number,
  messageId: number,
): Promise<{
  unread_count: number;
  last_read_inbox_message_id: number | null;
  error: string | null;
}> {
  if (!Number.isFinite(chatId)) {
    return { unread_count: 0, last_read_inbox_message_id: null, error: "invalid_chat_id" };
  }
  const mid = Math.trunc(messageId);
  if (!Number.isFinite(mid) || mid <= 0) {
    return { unread_count: 0, last_read_inbox_message_id: null, error: "message_id_required" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { unread_count: 0, last_read_inbox_message_id: null, error: "session_not_ready" };
  }

  try {
    const result = await viewChatInboxMessagesUpTo(record.client, chatId, mid);
    const { patchLiveChatReadInbox } = await import("./liveChatCache.js");
    patchLiveChatReadInbox(
      telegramUsername,
      chatId,
      result.unread_count,
      result.last_read_inbox_message_id,
    );
    return { ...result, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "view_messages_failed";
    return { unread_count: 0, last_read_inbox_message_id: null, error: message };
  }
}

export async function toggleChatPinnedForUser(
  telegramUsername: string,
  chatId: number,
  isPinned: boolean,
): Promise<{ ok: boolean; is_pinned: boolean; error?: string }> {
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, is_pinned: false, error: "invalid_chat_id" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, is_pinned: false, error: "session_not_ready" };
  }

  const nextPinned = Boolean(isPinned);
  try {
    const chatPreview = await import("./chatPreview.js");
    const chat = (await record.client.invoke({
      _: "getChat",
      chat_id: chatId,
    })) as TdChat;
    const archiveOnly =
      chatPreview.isChatInArchiveList(chat) && !chatPreview.isChatInMainList(chat);
    const chatList = archiveOnly
      ? ({ _: "chatListArchive" } as const)
      : ({ _: "chatListMain" } as const);
    await record.client.invoke({
      _: "toggleChatIsPinned",
      chat_list: chatList,
      chat_id: chatId,
      is_pinned: nextPinned,
    });
    const refreshed = (await record.client.invoke({
      _: "getChat",
      chat_id: chatId,
    })) as TdChat;
    const { patchLiveChatFromTdlib } = await import("./liveChatCache.js");
    patchLiveChatFromTdlib(telegramUsername, refreshed, {});
    const pinned = archiveOnly
      ? (refreshed.positions ?? []).some(
          (row) => row.list?._ === "chatListArchive" && row.is_pinned === true,
        )
      : chatPreview.isChatPinnedInMainList(refreshed);
    return { ok: true, is_pinned: pinned };
  } catch (err) {
    const message = err instanceof Error ? err.message : "pin_failed";
    return { ok: false, is_pinned: nextPinned, error: message };
  }
}

/**
 * Reorder pinned chats via Telegram (`setPinnedChats`).
 * `chatIds` must be the full pinned list in display order (top → bottom).
 */
export async function setPinnedChatsOrderForUser(
  telegramUsername: string,
  chatIds: number[],
  options?: { archive?: boolean },
): Promise<{ ok: boolean; chat_ids: number[]; error?: string }> {
  const ordered = chatIds
    .map((id) => Math.trunc(Number(id)))
    .filter((id, index, arr) => Number.isFinite(id) && id !== 0 && arr.indexOf(id) === index);
  if (ordered.length === 0) {
    return { ok: false, chat_ids: [], error: "chat_ids_required" };
  }

  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, chat_ids: ordered, error: "session_not_ready" };
  }

  const chatList = options?.archive
    ? ({ _: "chatListArchive" } as const)
    : ({ _: "chatListMain" } as const);

  try {
    await record.client.invoke({
      _: "setPinnedChats",
      chat_list: chatList,
      chat_ids: ordered,
    });
    const { patchLiveChatFromTdlib } = await import("./liveChatCache.js");
    for (const chatId of ordered) {
      try {
        const refreshed = (await record.client.invoke({
          _: "getChat",
          chat_id: chatId,
        })) as TdChat;
        patchLiveChatFromTdlib(telegramUsername, refreshed, {});
      } catch {
        // Best-effort refresh; live stream will catch up.
      }
    }
    return { ok: true, chat_ids: ordered };
  } catch (err) {
    const message = err instanceof Error ? err.message : "reorder_pinned_failed";
    return { ok: false, chat_ids: ordered, error: message };
  }
}

export async function getMessageMediaForUser(
  telegramUsername: string,
  chatId: number,
  messageId: number,
  mode: "full" | "preview" = "full",
): Promise<{ data: Buffer; mime: string } | null> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return null;
  const { readMessageMediaBytes } = await import("./messageMedia.js");
  return readMessageMediaBytes(record.client, chatId, messageId, mode);
}

export async function getTelegramEmojiForUser(
  telegramUsername: string,
  options: { customEmojiId?: string; emoji?: string },
): Promise<{ data: Buffer; mime: string } | null> {
  const record = await requireReadySessionFast(telegramUsername);
  if (!record) return null;
  const { readTelegramEmojiBytes } = await import("./customEmoji.js");
  return readTelegramEmojiBytes(record.client, options);
}

export async function ensureLiveChatPeerEmojiStatuses(telegramUsername: string): Promise<number> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return 0;
  const { refreshMissingPeerEmojiStatuses } = await import("./syncChats.js");
  return refreshMissingPeerEmojiStatuses(record.client, telegramUsername);
}

export async function ensureLiveChatMemberCounts(telegramUsername: string): Promise<number> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return 0;
  const { refreshMissingMemberCounts } = await import("./syncChats.js");
  return refreshMissingMemberCounts(record.client, telegramUsername);
}

export async function getCustomEmojiForUser(
  telegramUsername: string,
  customEmojiId: string,
): Promise<{ data: Buffer; mime: string } | null> {
  return getTelegramEmojiForUser(telegramUsername, { customEmojiId });
}

export async function getChatVoiceParticipantsForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
  options?: { forceReload?: boolean },
): Promise<{
  ok: boolean;
  error: string | null;
  participant_count: number;
  participants: Array<{
    user_id: number | null;
    chat_id: number | null;
    title: string;
    description: string;
    emoji_status_custom_emoji_id: string | null;
    is_speaking: boolean;
    is_muted: boolean;
    is_self: boolean;
  }>;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
  voice_chat_is_joined: boolean;
  voice_resolve_source: string;
}> {
  // Presence polls every ~0.8–2s. Do not block 30s on restore — that piles up
  // overlapping waits and returns session_not_ready storms after reconnect.
  const record = await requireReadySessionFast(telegramUsername);
  if (!record) {
    return {
      ok: false,
      error: "session_not_ready",
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_chat_is_joined: false,
      voice_resolve_source: "none",
    };
  }

  try {
    const { fetchChatVoiceParticipants } = await import("./voiceParticipants.js");
    const result = await fetchChatVoiceParticipants(record.client, chatId, groupCallId, {
      forceReload: Boolean(options?.forceReload),
      telegramUsername,
    });
    patchLiveChatVideoChat(telegramUsername, chatId, {
      has_active_voice_chat: result.has_active_voice_chat,
      voice_chat_group_call_id: result.voice_chat_group_call_id,
      voice_chat_is_joined: Boolean(result.voice_chat_is_joined),
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "participants_failed";
    return {
      ok: false,
      error: message,
      participant_count: 0,
      participants: [],
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
      voice_chat_is_joined: false,
      voice_resolve_source: "none",
    };
  }
}

export async function setChatVoiceParticipantSpeakingForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  audioSourceId: number,
  isSpeaking: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }

  try {
    const { setChatVoiceParticipantSpeaking } = await import("./voiceSpeaking.js");
    return await setChatVoiceParticipantSpeaking(
      record.client,
      chatId,
      groupCallId,
      audioSourceId,
      isSpeaking,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "speaking_failed";
    return { ok: false, error: message };
  }
}

export async function setChatVoiceMicMutedForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  isMuted: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }

  try {
    const { setChatVoiceMicMuted } = await import("./voiceMute.js");
    return await setChatVoiceMicMuted(record.client, chatId, groupCallId, isMuted);
  } catch (err) {
    const message = err instanceof Error ? err.message : "mute_failed";
    return { ok: false, error: message };
  }
}

export async function setChatVoiceParticipantVolumeForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  participant: { userId?: number | null; chatId?: number | null },
  volumePercent: number,
): Promise<{ ok: boolean; error: string | null; volume_percent: number }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready", volume_percent: volumePercent };
  }

  try {
    const { setChatVoiceParticipantVolume } = await import("./voiceVolume.js");
    return await setChatVoiceParticipantVolume(
      record.client,
      chatId,
      groupCallId,
      participant,
      volumePercent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "volume_failed";
    return { ok: false, error: message, volume_percent: volumePercent };
  }
}

export async function joinChatVoiceForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  joinParameters: {
    audio_source_id: number;
    payload: string;
    is_muted: boolean;
    is_my_video_enabled?: boolean;
  },
): Promise<{
  ok: boolean;
  error: string | null;
  join_payload: string;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready", join_payload: "" };
  }

  try {
    const { joinChatVoiceForUser: joinVoice } = await import("./voiceJoin.js");
    const result = await joinVoice(record.client, chatId, groupCallId, joinParameters);
    if (result.ok) pinGatewayUserSession(telegramUsername, "voice");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "join_failed";
    return { ok: false, error: message, join_payload: "" };
  }
}

export async function startChatVoiceScreenShareForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  joinParameters: {
    audio_source_id: number;
    payload: string;
  },
): Promise<{
  ok: boolean;
  error: string | null;
  join_payload: string;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready", join_payload: "" };
  }

  try {
    const { startChatVoiceScreenShare } = await import("./voiceScreenShare.js");
    return await startChatVoiceScreenShare(record.client, chatId, groupCallId, joinParameters);
  } catch (err) {
    const message = err instanceof Error ? err.message : "screen_share_start_failed";
    return { ok: false, error: message, join_payload: "" };
  }
}

export async function endChatVoiceScreenShareForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
): Promise<{ ok: boolean; error: string | null }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready" };
  }

  try {
    const { endChatVoiceScreenShare } = await import("./voiceScreenShare.js");
    return await endChatVoiceScreenShare(record.client, chatId, groupCallId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "screen_share_end_failed";
    return { ok: false, error: message };
  }
}

export async function sendChatVoiceCallMessageForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId: number | null | undefined,
  text: string,
): Promise<{
  ok: boolean;
  error: string | null;
  message: import("./voiceCallMessages.js").VoiceCallMessageRow | null;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return { ok: false, error: "session_not_ready", message: null };
  }

  try {
    const { sendChatVoiceCallMessage } = await import("./voiceCallMessages.js");
    return await sendChatVoiceCallMessage(
      record.client,
      chatId,
      groupCallId,
      text,
      telegramUsername,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "voice_call_message_failed";
    return { ok: false, error: message, message: null };
  }
}

export async function startChatVoiceForUser(
  telegramUsername: string,
  chatId: number,
): Promise<{
  ok: boolean;
  error: string | null;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return {
      ok: false,
      error: "session_not_ready",
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
    };
  }

  try {
    const { startChatVoiceForUser: startVoice } = await import("./voiceStart.js");
    const result = await startVoice(record.client, chatId);
    if (result.ok) {
      patchLiveChatVideoChat(telegramUsername, chatId, {
        has_active_voice_chat: result.has_active_voice_chat,
        voice_chat_group_call_id: result.voice_chat_group_call_id,
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "start_failed";
    return {
      ok: false,
      error: message,
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
    };
  }
}

export async function leaveChatVoiceForUser(
  telegramUsername: string,
  chatId: number,
  groupCallId?: number | null,
): Promise<{
  ok: boolean;
  error: string | null;
  has_active_voice_chat: boolean;
  voice_chat_group_call_id: number | null;
}> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) {
    return {
      ok: false,
      error: "session_not_ready",
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
    };
  }

  try {
    // Prefer live TDLib state — client-cached call ids can be stale (e.g. Number(true) → 1).
    let callId = 0;
    try {
      const chat = (await record.client.invoke({ _: "getChat", chat_id: chatId })) as TdChat;
      callId = normalizeTelegramGroupCallId(chat.video_chat?.group_call_id) ?? 0;
    } catch {
      callId = 0;
    }
    if (callId <= 0) {
      callId = normalizeTelegramGroupCallId(groupCallId) ?? 0;
    }
    if (callId <= 0) {
      return {
        ok: true,
        error: null,
        has_active_voice_chat: false,
        voice_chat_group_call_id: null,
      };
    }

    // Idempotent: if we are not in the call, skip leaveGroupCall (avoids 502/hangs
    // when the UI cleans up a phantom self row from a stale presence snapshot).
    let alreadyOut = false;
    try {
      const groupCall = (await record.client.invoke({
        _: "getGroupCall",
        group_call_id: callId,
      })) as { is_joined?: boolean };
      alreadyOut = !Boolean(groupCall.is_joined);
    } catch {
      alreadyOut = false;
    }
    if (!alreadyOut) {
      await record.client.invoke({
        _: "leaveGroupCall",
        group_call_id: callId,
      });
    }

    // Re-check live after leave — getChat metadata alone can still look "bound"
    // while participant_count=0 (false rings / Join strip).
    const verified = await verifyGroupCallLiveState(record.client, callId, {
      chatId,
    });
    const voice = {
      has_active_voice_chat: verified.live,
      voice_chat_group_call_id: callId,
      voice_chat_is_joined: false,
    };
    patchLiveChatVideoChat(telegramUsername, chatId, voice);
    unpinGatewayUserSession(telegramUsername, "voice");
    return {
      ok: true,
      error: null,
      has_active_voice_chat: verified.live,
      voice_chat_group_call_id: callId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "leave_failed";
    return {
      ok: false,
      error: message,
      has_active_voice_chat: false,
      voice_chat_group_call_id: null,
    };
  }
}

export function gatewayHealth(): {
  ok: boolean;
  tdlibConfigured: boolean;
  hasApiCredentials: boolean;
  privateCallMediaAvailable: boolean;
  privateCallMediaLoadError: string | null;
} {
  return {
    ok: true,
    tdlibConfigured: tdlConfigured,
    hasApiCredentials: Boolean(getTelegramApiCredentials()),
    privateCallMediaAvailable: isPrivateCallMediaAvailable(),
    privateCallMediaLoadError: getPrivateCallMediaLoadError(),
  };
}

export { getLiveChatList, getLiveChatListRevision };
