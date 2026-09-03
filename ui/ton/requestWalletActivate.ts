import { buildApiUrl } from "../../api/_base";
import {
  bumpWalletBalanceRefresh,
  scheduleWalletBalanceRefreshBurst,
} from "../wallet/walletBalanceRefresh";

export type WalletActivateClientResult = {
  ok: boolean;
  alreadyActive?: boolean;
  error?: string;
};

let inflight: Promise<WalletActivateClientResult> | null = null;
let lastAttemptAt = 0;
const MIN_ATTEMPT_GAP_MS = 15_000;

/**
 * Ask the server to deploy the built-in V4 wallet if it has balance but is not active yet.
 * Safe to call repeatedly (client debounce + server already_active).
 */
export async function requestWalletActivate(opts?: {
  initDataRaw?: string | null;
  force?: boolean;
}): Promise<WalletActivateClientResult> {
  const now = Date.now();
  if (!opts?.force && now - lastAttemptAt < MIN_ATTEMPT_GAP_MS && !inflight) {
    return { ok: false, error: "debounced" };
  }
  if (inflight) return inflight;

  lastAttemptAt = now;
  const trimmedInit = typeof opts?.initDataRaw === "string" ? opts.initDataRaw.trim() : "";
  const body: Record<string, unknown> = {};
  if (trimmedInit) body.initData = trimmedInit;

  inflight = (async () => {
    try {
      const res = await fetch(buildApiUrl("/api/wallet-activate"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        alreadyActive?: boolean;
        error?: string;
      } | null;
      if (res.ok && data?.ok) {
        if (!data.alreadyActive) {
          bumpWalletBalanceRefresh();
          scheduleWalletBalanceRefreshBurst([3_000, 12_000, 30_000]);
        }
        return { ok: true, alreadyActive: Boolean(data.alreadyActive) };
      }
      return {
        ok: false,
        error: typeof data?.error === "string" ? data.error : `http_${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "activate_failed",
      };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
