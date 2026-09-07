/**
 * Payment memo locks the DLLR credit so TON/USD rate moves cannot shrink the top-up.
 * Format: HSP-{planId}-{dllrCents}-{nonce}
 */

/** Extra TON to send so a brief rate dip still covers the locked DLLR credit. */
export const PRO_PAYMENT_TON_RATE_BUFFER = 1.03;

/** Leave this many Dollars frozen on the built-in wallet after auto-subscribing. */
export const PRO_TOPUP_RESIDUAL_DLLR_USD = 1;

/** How long a TON/USD quote stays fixed after choosing a rate-sensitive method. */
export const PRO_PAYMENT_QUOTE_TTL_MS = 15 * 60 * 1000;

export function createProPaymentMemo(planId: string, dllrUsd: number): string {
  const cents = Math.max(1, Math.round(dllrUsd * 100));
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HSP-${planId}-${cents}-${nonce}`;
}

/** Parse locked DLLR amount from a payment memo; null if not an HSP memo. */
export function parseDllrUsdFromProPaymentMemo(memo: string): number | null {
  const m = memo.trim().match(/^HSP-[a-z0-9]+-(\d+)-[A-Z0-9]+$/i);
  if (!m?.[1]) return null;
  const cents = Number.parseInt(m[1], 10);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents) / 100;
}

/** Minimum DLLR top-up so total balance reaches plan price + residual (e.g. 20 when balance is 1). */
export function minDllrTopUpForPlanUsd(planPriceUsd: number, balanceUsd: number): number {
  const target = planPriceUsd + PRO_TOPUP_RESIDUAL_DLLR_USD;
  return Math.max(0.01, Math.round((target - balanceUsd) * 100) / 100);
}

export function formatQuoteCountdown(remainingMs: number): string {
  const ms = Math.max(0, remainingMs);
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
