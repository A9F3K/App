/**
 * Wait for TON settlement + TonAPI index lag before treating a Pro USDT payment as confirmed.
 *
 * TON masterchain finality is typically under ~1s (Catchain 2.0), but public indexers
 * (TonAPI) often lag a few seconds. Soft window ~8s; hard timeout ~25s with polling.
 */
import { tonapiFetch } from "../ton/tonapiClient";
import { SWAP_USDT_TOKEN } from "../swap/swapPairTypes";

export const PRO_PAYMENT_CONFIRM_POLL_MS = 1_500;
export const PRO_PAYMENT_CONFIRM_SOFT_MS = 8_000;
export const PRO_PAYMENT_CONFIRM_HARD_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function usdtMasterAddress(): string {
  const raw = (SWAP_USDT_TOKEN as { address?: string }).address ?? "";
  return raw.trim();
}

/**
 * Poll TonAPI account events for an incoming USDT jetton transfer of ~expectedUsd
 * to `paymentAddress` since `sinceUnix` (seconds).
 */
export async function findRecentUsdtCredit(opts: {
  paymentAddress: string;
  expectedUsd: number;
  sinceUnix: number;
}): Promise<boolean> {
  const addr = opts.paymentAddress.trim();
  const master = usdtMasterAddress();
  if (!addr || !(opts.expectedUsd > 0)) return false;
  try {
    const res = await tonapiFetch(
      `/accounts/${encodeURIComponent(addr)}/events?limit=30`,
    );
    if (!res.ok) return false;
    const json = (await res.json()) as {
      events?: Array<{
        timestamp?: number;
        actions?: Array<{
          type?: string;
          JettonTransfer?: {
            amount?: string | number;
            jetton?: { address?: string };
            recipient?: { address?: string };
          };
        }>;
      }>;
    };
    const events = Array.isArray(json.events) ? json.events : [];
    const expectedNano = Math.round(opts.expectedUsd * 1e6); // USDT 6 decimals
    const tol = Math.max(1, Math.round(expectedNano * 0.002)); // 0.2%
    for (const ev of events) {
      const ts = typeof ev.timestamp === "number" ? ev.timestamp : 0;
      if (ts + 5 < opts.sinceUnix) continue;
      for (const action of ev.actions ?? []) {
        if (action.type !== "JettonTransfer" || !action.JettonTransfer) continue;
        const jt = action.JettonTransfer;
        const jettonAddr = (jt.jetton?.address ?? "").toLowerCase();
        if (master && jettonAddr && !jettonAddr.includes(master.slice(0, 48).toLowerCase()) && jettonAddr !== master.toLowerCase()) {
          // Loose match: some APIs return raw vs friendly; accept if master substring matches.
          const m = master.toLowerCase().replace(/^0:/, "");
          if (!jettonAddr.includes(m.slice(0, 40))) continue;
        }
        const amtRaw = jt.amount;
        const amt =
          typeof amtRaw === "number"
            ? amtRaw
            : typeof amtRaw === "string"
              ? Number(amtRaw)
              : NaN;
        if (!Number.isFinite(amt)) continue;
        if (Math.abs(amt - expectedNano) <= tol) return true;
      }
    }
  } catch {
    /* indexer miss — caller still applies soft wait */
  }
  return false;
}

/**
 * Wait for payment confirmation. Resolves `{ confirmed: true }` if TonAPI sees the
 * transfer, or after the soft window when polling is inconclusive (manual Check path).
 * Rejects after the hard timeout only when `requireIndexed` is true.
 */
export async function waitForProUsdtPayment(opts: {
  paymentAddress: string;
  expectedUsd: number;
  requireIndexed?: boolean;
  onTick?: (elapsedMs: number) => void;
}): Promise<{ confirmed: boolean; elapsedMs: number }> {
  const started = Date.now();
  const sinceUnix = Math.floor(started / 1000) - 30;
  let confirmed = false;
  while (Date.now() - started < PRO_PAYMENT_CONFIRM_HARD_MS) {
    const elapsed = Date.now() - started;
    opts.onTick?.(elapsed);
    confirmed = await findRecentUsdtCredit({
      paymentAddress: opts.paymentAddress,
      expectedUsd: opts.expectedUsd,
      sinceUnix,
    });
    if (confirmed) {
      return { confirmed: true, elapsedMs: Date.now() - started };
    }
    if (!opts.requireIndexed && elapsed >= PRO_PAYMENT_CONFIRM_SOFT_MS) {
      // Soft confirm: allow Check Payment / post-TonConnect to proceed after indexer lag window.
      return { confirmed: false, elapsedMs: elapsed };
    }
    await sleep(PRO_PAYMENT_CONFIRM_POLL_MS);
  }
  return { confirmed, elapsedMs: Date.now() - started };
}
