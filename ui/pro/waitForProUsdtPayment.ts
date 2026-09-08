/**
 * Wait for TON settlement + TonAPI index lag before treating a Pro USDT payment as confirmed.
 *
 * Requires a fresh indexed transfer. When a memo is provided, the on-chain comment must
 * include it, and that memo can only unlock Pro once (survives founder revoke).
 */
import { Platform } from "react-native";

import { tonapiFetch } from "../ton/tonapiClient";
import { SWAP_USDT_TOKEN } from "../swap/swapPairTypes";

export const PRO_PAYMENT_CONFIRM_POLL_MS = 1_500;
export const PRO_PAYMENT_CONFIRM_HARD_MS = 60_000;

const CONSUMED_MEMOS_KEY = "hsp.pro.consumed_payment_memos.v1";
const MAX_CONSUMED = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readConsumedMemos(): Set<string> {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(CONSUMED_MEMOS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeConsumedMemos(set: Set<string>): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const arr = [...set].slice(-MAX_CONSUMED);
    localStorage.setItem(CONSUMED_MEMOS_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

export function isProPaymentMemoConsumed(memo: string): boolean {
  const m = memo.trim();
  if (!m) return false;
  return readConsumedMemos().has(m);
}

/** Call after a successful Pro unlock so the same on-chain transfer cannot re-activate. */
export function markProPaymentMemoConsumed(memo: string): void {
  const m = memo.trim();
  if (!m) return;
  const set = readConsumedMemos();
  set.add(m);
  writeConsumedMemos(set);
}

function usdtMasterAddress(): string {
  const raw = (SWAP_USDT_TOKEN as { address?: string }).address ?? "";
  return raw.trim();
}

function jettonMatchesMaster(jettonAddr: string, master: string): boolean {
  if (!master) return true;
  const j = jettonAddr.toLowerCase();
  const m = master.toLowerCase();
  if (!j) return true;
  if (j === m || j.includes(m.slice(0, 48))) return true;
  const raw = m.replace(/^0:/, "");
  return j.includes(raw.slice(0, 40));
}

function extractEventComment(action: Record<string, unknown>): string {
  const jt = action.JettonTransfer as Record<string, unknown> | undefined;
  if (jt) {
    for (const key of ["comment", "forward_payload", "payload"]) {
      const v = jt[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  const simple = action.simple_preview as { description?: string } | undefined;
  if (typeof simple?.description === "string") return simple.description;
  return "";
}

/**
 * Poll TonAPI for an incoming USDT credit matching amount (+ memo when provided).
 * Skips memos already used for a prior activation.
 */
export async function findRecentUsdtCredit(opts: {
  paymentAddress: string;
  expectedUsd: number;
  sinceUnix: number;
  memo?: string;
}): Promise<boolean> {
  const addr = opts.paymentAddress.trim();
  const master = usdtMasterAddress();
  const memoNeedle = opts.memo?.trim() ?? "";
  if (!addr || !(opts.expectedUsd > 0)) return false;
  if (memoNeedle && isProPaymentMemoConsumed(memoNeedle)) return false;

  try {
    const res = await tonapiFetch(
      `/accounts/${encodeURIComponent(addr)}/events?limit=40`,
    );
    if (!res.ok) return false;
    const json = (await res.json()) as {
      events?: Array<{
        timestamp?: number;
        actions?: Array<Record<string, unknown>>;
      }>;
    };
    const events = Array.isArray(json.events) ? json.events : [];
    const expectedNano = Math.round(opts.expectedUsd * 1e6); // USDT 6 decimals
    const tol = Math.max(1, Math.round(expectedNano * 0.002)); // 0.2%

    for (const ev of events) {
      const ts = typeof ev.timestamp === "number" ? ev.timestamp : 0;
      if (ts + 2 < opts.sinceUnix) continue;
      for (const action of ev.actions ?? []) {
        if (action.type !== "JettonTransfer" || !action.JettonTransfer) continue;
        const jt = action.JettonTransfer as {
          amount?: string | number;
          jetton?: { address?: string };
        };
        if (!jettonMatchesMaster(jt.jetton?.address ?? "", master)) continue;
        const amtRaw = jt.amount;
        const amt =
          typeof amtRaw === "number"
            ? amtRaw
            : typeof amtRaw === "string"
              ? Number(amtRaw)
              : NaN;
        if (!Number.isFinite(amt)) continue;
        if (Math.abs(amt - expectedNano) > tol) continue;
        const comment = extractEventComment(action);
        if (memoNeedle) {
          // Fresh subscription after revoke must use a new memo; never amount-only.
          if (comment.includes(memoNeedle)) return true;
          continue;
        }
        // No memo (legacy): accept amount match in the lookback window only.
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Wait until TonAPI indexes a fresh USDT credit.
 * Prefer passing `sinceUnix` from just before the user sent / started waiting.
 */
export async function waitForProUsdtPayment(opts: {
  paymentAddress: string;
  expectedUsd: number;
  memo?: string;
  /** Unix seconds — only events at/after this time count. Default: ~20s ago. */
  sinceUnix?: number;
  /** @deprecated Ignored — confirmation always requires an indexed transfer. */
  requireIndexed?: boolean;
  hardTimeoutMs?: number;
  signal?: AbortSignal;
  onTick?: (elapsedMs: number) => void;
}): Promise<{ confirmed: boolean; elapsedMs: number }> {
  const started = Date.now();
  const sinceUnix =
    typeof opts.sinceUnix === "number" && Number.isFinite(opts.sinceUnix)
      ? opts.sinceUnix
      : Math.floor(started / 1000) - 20;
  const hardMs = opts.hardTimeoutMs ?? PRO_PAYMENT_CONFIRM_HARD_MS;
  while (Date.now() - started < hardMs) {
    if (opts.signal?.aborted) {
      return { confirmed: false, elapsedMs: Date.now() - started };
    }
    const elapsed = Date.now() - started;
    opts.onTick?.(elapsed);
    const confirmed = await findRecentUsdtCredit({
      paymentAddress: opts.paymentAddress,
      expectedUsd: opts.expectedUsd,
      sinceUnix,
      memo: opts.memo,
    });
    if (confirmed) {
      return { confirmed: true, elapsedMs: Date.now() - started };
    }
    await sleep(PRO_PAYMENT_CONFIRM_POLL_MS);
  }
  return { confirmed: false, elapsedMs: Date.now() - started };
}
