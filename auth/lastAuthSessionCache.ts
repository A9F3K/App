/**
 * In-memory copy of the latest `GET /api/auth/session` payload so Telegram
 * browser hydrate can reuse AuthContext's response instead of a second round-trip.
 */

export type CachedAuthSessionPayload = {
  authenticated: boolean;
  telegram_username?: string;
  display_name?: string;
  has_wallet?: boolean;
  wallet_required?: boolean;
  wallet?: {
    id?: string | number;
    wallet_address?: string;
    wallet_blockchain?: string;
    wallet_net?: string;
    type?: string;
    label?: string | null;
    is_default?: boolean;
    source?: string;
  } | null;
  fetchedAt: number;
};

let last: CachedAuthSessionPayload | null = null;
const waiters = new Set<() => void>();

const FRESH_MS = 15_000;

function notifyWaiters(): void {
  if (waiters.size === 0) return;
  const pending = [...waiters];
  waiters.clear();
  for (const w of pending) w();
}

export function rememberAuthSessionPayload(
  payload: Omit<CachedAuthSessionPayload, "fetchedAt">,
): void {
  last = { ...payload, fetchedAt: Date.now() };
  notifyWaiters();
}

export function takeFreshAuthSessionPayload(
  maxAgeMs = FRESH_MS,
): CachedAuthSessionPayload | null {
  if (!last) return null;
  if (Date.now() - last.fetchedAt > maxAgeMs) return null;
  return last;
}

/** Resolve when AuthContext finishes its session GET (or after timeout). */
export function waitForAuthSessionCache(
  timeoutMs = 3_000,
): Promise<CachedAuthSessionPayload | null> {
  const existing = takeFreshAuthSessionPayload();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(onUpdate);
      resolve(takeFreshAuthSessionPayload());
    }, timeoutMs);
    const onUpdate = () => {
      clearTimeout(timer);
      waiters.delete(onUpdate);
      resolve(takeFreshAuthSessionPayload());
    };
    waiters.add(onUpdate);
  });
}

export function clearAuthSessionPayloadCache(): void {
  last = null;
}
