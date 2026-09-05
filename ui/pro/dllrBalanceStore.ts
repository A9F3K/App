/**
 * Built-in wallet Dollars (DLLR) ledger — client store until server balances ship.
 * Credited when the user confirms a direct Pro/top-up payment.
 */
import { Platform } from "react-native";

const STORAGE_KEY = "hsp_builtin_dllr_usd_v1";
/** Default baseline until the user tops up / pays. */
const DEFAULT_DLLR_USD = 1;
const listeners = new Set<() => void>();
let balanceUsd = DEFAULT_DLLR_USD;
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(balanceUsd));
  } catch {
    /* ignore */
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null || !raw.trim()) return;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) balanceUsd = n;
  } catch {
    /* ignore */
  }
}

export function getBuiltinDllrBalanceUsd(): number {
  hydrate();
  return balanceUsd;
}

export function subscribeBuiltinDllrBalance(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function creditBuiltinDllrUsd(amountUsd: number): number {
  hydrate();
  const add = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
  balanceUsd = Math.round((balanceUsd + add) * 1e6) / 1e6;
  persist();
  notify();
  return balanceUsd;
}

export function debitBuiltinDllrUsd(amountUsd: number): boolean {
  hydrate();
  const need = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
  if (balanceUsd + 1e-9 < need) return false;
  balanceUsd = Math.round((balanceUsd - need) * 1e6) / 1e6;
  persist();
  notify();
  return true;
}

/** Minimum Dollars needed to cover a plan given current balance (0 if already covered). */
export function remainingDllrForPlanUsd(planPriceUsd: number): number {
  hydrate();
  return Math.max(0, Math.round((planPriceUsd - balanceUsd) * 100) / 100);
}
