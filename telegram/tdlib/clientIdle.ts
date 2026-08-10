import {
  getTdlibClientIdleCheckMs,
  getTdlibClientIdleMs,
  isTdlibClientIdleEnabled,
} from "./env.js";
import { logGateway } from "./gatewayLog.js";

const lastUsedAtByUser = new Map<string, number>();
const pinReasonsByUser = new Map<string, Set<string>>();
const unloadInflight = new Map<string, Promise<void>>();

let idleTimer: ReturnType<typeof setInterval> | null = null;

type IdleHooks = {
  listLiveUsernames: () => string[];
  softUnloadUser: (telegramUsername: string) => Promise<void>;
  isSessionRestoreInflight: (telegramUsername: string) => boolean;
};

let hooks: IdleHooks | null = null;

export function registerClientIdleHooks(next: IdleHooks): void {
  hooks = next;
}

export function touchGatewayUserActivity(telegramUsername: string): void {
  const key = telegramUsername.trim();
  if (!key) return;
  lastUsedAtByUser.set(key, Date.now());
}

export function pinGatewayUserSession(telegramUsername: string, reason: string): void {
  const key = telegramUsername.trim();
  const pin = reason.trim();
  if (!key || !pin) return;
  let set = pinReasonsByUser.get(key);
  if (!set) {
    set = new Set();
    pinReasonsByUser.set(key, set);
  }
  set.add(pin);
  touchGatewayUserActivity(key);
}

export function unpinGatewayUserSession(telegramUsername: string, reason: string): void {
  const key = telegramUsername.trim();
  const pin = reason.trim();
  if (!key || !pin) return;
  const set = pinReasonsByUser.get(key);
  if (!set) return;
  set.delete(pin);
  if (set.size === 0) pinReasonsByUser.delete(key);
  touchGatewayUserActivity(key);
}

export function clearGatewayUserIdleState(telegramUsername: string): void {
  const key = telegramUsername.trim();
  if (!key) return;
  lastUsedAtByUser.delete(key);
  pinReasonsByUser.delete(key);
}

export function isGatewayUserPinned(telegramUsername: string): boolean {
  const set = pinReasonsByUser.get(telegramUsername.trim());
  return Boolean(set && set.size > 0);
}

export async function waitForGatewayUserUnload(
  telegramUsername: string,
): Promise<void> {
  const inflight = unloadInflight.get(telegramUsername.trim());
  if (inflight) await inflight;
}

function pinSnapshot(telegramUsername: string): string[] {
  return [...(pinReasonsByUser.get(telegramUsername) ?? [])];
}

async function unloadOne(telegramUsername: string, idleMs: number): Promise<void> {
  if (!hooks) return;
  if (unloadInflight.has(telegramUsername)) return;
  if (hooks.isSessionRestoreInflight(telegramUsername)) return;
  if (isGatewayUserPinned(telegramUsername)) return;

  const lastUsed = lastUsedAtByUser.get(telegramUsername) ?? 0;
  if (Date.now() - lastUsed < idleMs) return;

  const promise = (async () => {
    try {
      logGateway("client_idle_unload", {
        telegramUsername,
        idleMs,
        lastUsedAt: lastUsed || null,
        pins: pinSnapshot(telegramUsername),
      });
      await hooks!.softUnloadUser(telegramUsername);
      clearGatewayUserIdleState(telegramUsername);
    } catch (err) {
      logGateway("client_idle_unload_failed", {
        telegramUsername,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unloadInflight.delete(telegramUsername);
    }
  })();

  unloadInflight.set(telegramUsername, promise);
  await promise;
}

export function sweepIdleGatewayClients(): void {
  if (!hooks || !isTdlibClientIdleEnabled()) return;
  const idleMs = getTdlibClientIdleMs();
  const usernames = hooks.listLiveUsernames();
  for (const telegramUsername of usernames) {
    void unloadOne(telegramUsername, idleMs);
  }
}

export function startClientIdleSweeper(): void {
  if (idleTimer) return;
  if (!isTdlibClientIdleEnabled()) {
    logGateway("client_idle_disabled", {
      idleMs: getTdlibClientIdleMs(),
      flag: process.env.TDLIB_CLIENT_IDLE || "auto",
    });
    return;
  }
  const checkMs = getTdlibClientIdleCheckMs();
  const idleMs = getTdlibClientIdleMs();
  logGateway("client_idle_sweeper_start", { idleMs, checkMs });
  idleTimer = setInterval(() => {
    sweepIdleGatewayClients();
  }, checkMs);
  // Avoid keeping the event loop alive solely for idle sweeps in tests.
  idleTimer.unref?.();
}
