/**
 * Built-in wallet Dollars (DLLR) ledger — client store until server balances ship.
 *
 * - Frozen: registration residual (not 1:1 swappable for USDT).
 * - Hot: top-ups + cashback.
 * Subscription may debit hot first, then frozen, when total covers the plan.
 */
import { Platform } from "react-native";

const STORAGE_KEY_V2 = "hsp_builtin_dllr_ledger_v2";
/** Legacy single-number total. */
const STORAGE_KEY_V1 = "hsp_builtin_dllr_usd_v1";

/** Registration gift — frozen until product rules change. */
export const DLLR_REGISTRATION_FROZEN_USD = 1;
/** Pro Access cashback credited to hot balance on successful subscribe. */
export const PRO_CASHBACK_DLLR_USD = 3;

type DllrLedger = {
  hotUsd: number;
  frozenUsd: number;
};

const listeners = new Set<() => void>();
let ledger: DllrLedger = {
  hotUsd: 0,
  frozenUsd: DLLR_REGISTRATION_FROZEN_USD,
};
let hydrated = false;

function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY_V2,
      JSON.stringify({ hotUsd: ledger.hotUsd, frozenUsd: ledger.frozenUsd }),
    );
  } catch {
    /* ignore */
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const v2 = localStorage.getItem(STORAGE_KEY_V2);
    if (v2) {
      const parsed = JSON.parse(v2) as Partial<DllrLedger>;
      const hot = Number(parsed.hotUsd);
      const frozen = Number(parsed.frozenUsd);
      ledger = {
        hotUsd: Number.isFinite(hot) && hot >= 0 ? roundUsd(hot) : 0,
        frozenUsd:
          Number.isFinite(frozen) && frozen >= 0
            ? roundUsd(frozen)
            : DLLR_REGISTRATION_FROZEN_USD,
      };
      return;
    }
    const v1 = localStorage.getItem(STORAGE_KEY_V1);
    if (v1 != null && v1.trim()) {
      const n = Number(v1);
      if (Number.isFinite(n) && n >= 0) {
        // Prefer keeping the registration frozen dollar when migrating.
        const frozen = Math.min(DLLR_REGISTRATION_FROZEN_USD, n);
        ledger = { frozenUsd: roundUsd(frozen), hotUsd: roundUsd(n - frozen) };
        persist();
        return;
      }
    }
  } catch {
    /* ignore */
  }
}

export function getBuiltinDllrHotUsd(): number {
  hydrate();
  return ledger.hotUsd;
}

export function getBuiltinDllrFrozenUsd(): number {
  hydrate();
  return ledger.frozenUsd;
}

/** Total DLLR (hot + frozen) — used for header totals and Pro affordability. */
export function getBuiltinDllrBalanceUsd(): number {
  hydrate();
  return roundUsd(ledger.hotUsd + ledger.frozenUsd);
}

export function subscribeBuiltinDllrBalance(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Credit top-ups / payments into hot (spendable) balance. */
export function creditBuiltinDllrUsd(amountUsd: number): number {
  hydrate();
  const add = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
  ledger = { ...ledger, hotUsd: roundUsd(ledger.hotUsd + add) };
  persist();
  notify();
  return getBuiltinDllrBalanceUsd();
}

/**
 * Debit DLLR for subscription / paid AI: hot first, then frozen.
 * Returns false when total balance is insufficient.
 */
export function debitBuiltinDllrUsd(amountUsd: number): boolean {
  hydrate();
  const need = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
  const total = ledger.hotUsd + ledger.frozenUsd;
  if (total + 1e-9 < need) return false;
  let left = need;
  const fromHot = Math.min(ledger.hotUsd, left);
  left = roundUsd(left - fromHot);
  const fromFrozen = left > 0 ? Math.min(ledger.frozenUsd, left) : 0;
  ledger = {
    hotUsd: roundUsd(ledger.hotUsd - fromHot),
    frozenUsd: roundUsd(ledger.frozenUsd - fromFrozen),
  };
  persist();
  notify();
  return true;
}

/** Grant Pro cashback to hot balance after a successful subscribe. */
export function creditProCashbackDllrUsd(
  amountUsd: number = PRO_CASHBACK_DLLR_USD,
): number {
  return creditBuiltinDllrUsd(amountUsd);
}

/** Minimum Dollars needed to cover a plan from total balance (0 if already covered). */
export function remainingDllrForPlanUsd(planPriceUsd: number): number {
  hydrate();
  const total = ledger.hotUsd + ledger.frozenUsd;
  return Math.max(0, Math.round((planPriceUsd - total) * 100) / 100);
}
