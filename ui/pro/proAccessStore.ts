/**
 * Pro Access plans and entitlement.
 *
 * Pricing comes from the Pro catalog (per-feature $ + launch flags):
 * - Month charge = sum(enabled features) + profit margin $
 * - Launch: AI only → AI feature price; enabling features raises the sum
 * - Consumption economics (screen-time + AI) use derived margin % on COGS
 */

import { Platform } from "react-native";

import { syncProAccessQuotaToServer } from "../ai/aiFreeQuotaStore";
import {
  DEFAULT_PRO_CATALOG,
  buildProPlansFromCatalog,
  type ProCatalogPlan,
  type ProFeatureId,
} from "../../shared/proCatalog";
import { getProCatalogPlans, isProFeatureEnabled, subscribeProCatalog } from "./proCatalogStore";

export type ProAccessPlanId = "month" | "quarter" | "year";

export type ProAccessPlan = ProCatalogPlan;

/** Live plans from catalog (defaults to AI-only $5 until /api/pro-catalog loads). */
export function getProAccessPlans(): readonly ProAccessPlan[] {
  return getProCatalogPlans();
}

/** @deprecated Prefer {@link getProAccessPlans} — kept for static imports; mirrors current catalog. */
export const PRO_ACCESS_PLANS: readonly ProAccessPlan[] = buildProPlansFromCatalog(DEFAULT_PRO_CATALOG);

export const PRO_ACCESS_FEATURES = [
  {
    id: "aiModels" as const satisfies ProFeatureId,
    titleKey: "pro.feature.aiModels",
    bodyKey: "pro.feature.aiModels.body",
  },
  {
    id: "proxyVpn" as const satisfies ProFeatureId,
    titleKey: "pro.feature.proxyVpn",
    bodyKey: "pro.feature.proxyVpn.body",
  },
  {
    id: "blockchainChat" as const satisfies ProFeatureId,
    titleKey: "pro.feature.blockchainChat",
    bodyKey: "pro.feature.blockchainChat.body",
  },
  {
    id: "menuCustomization" as const satisfies ProFeatureId,
    titleKey: "pro.feature.menuCustomization",
    bodyKey: "pro.feature.menuCustomization.body",
  },
  {
    id: "cashback" as const satisfies ProFeatureId,
    titleKey: "pro.feature.cashback",
    bodyKey: "pro.feature.cashback.body",
  },
  {
    id: "nftCollection" as const satisfies ProFeatureId,
    titleKey: "pro.feature.nftCollection",
    bodyKey: "pro.feature.nftCollection.body",
  },
  {
    id: "unlimitedAccounts" as const satisfies ProFeatureId,
    titleKey: "pro.feature.unlimitedAccounts",
    bodyKey: "pro.feature.unlimitedAccounts.body",
  },
] as const;

/** Features currently launched (visible in the Pro sale dialog). */
let launchedProFeaturesCache: (typeof PRO_ACCESS_FEATURES)[number][] = [];

function rebuildLaunchedProFeaturesCache(): void {
  launchedProFeaturesCache = PRO_ACCESS_FEATURES.filter((f) => isProFeatureEnabled(f.id));
}

// Keep a stable snapshot for useSyncExternalStore (new arrays every read → React #185).
subscribeProCatalog(rebuildLaunchedProFeaturesCache);
rebuildLaunchedProFeaturesCache();

export function getLaunchedProFeatures(): readonly (typeof PRO_ACCESS_FEATURES)[number][] {
  return launchedProFeaturesCache;
}

/** True when Pro is active and the feature has been launched by the founder. */
export function hasProFeature(id: ProFeatureId): boolean {
  return isProAccessActive() && isProFeatureEnabled(id);
}

/** @deprecated Prefer {@link PRO_ACCESS_FEATURES}. */
export const PRO_ACCESS_FEATURE_KEYS = PRO_ACCESS_FEATURES.map((f) => f.titleKey);

type ProState = {
  active: boolean;
  planId: ProAccessPlanId | null;
  expiresAt: string | null;
  /** Soft cancel: entitlement stays until expiresAt; UI treats renewal as stopped. */
  cancelAtPeriodEnd: boolean;
};

type PendingProServerSync = {
  expiresAt: string;
  planId: ProAccessPlanId;
  priceUsd: number;
  months: number;
  recordSale: boolean;
  paymentMemo?: string;
};

/** Bumped so stub activations from `hsp_pro_access_v1` are dropped for every client. */
const STORAGE_KEY = "hsp_pro_access_v2";
const LEGACY_STORAGE_KEYS = ["hsp_pro_access_v1"] as const;
/** One-shot revoke of stub entitlements after payment UI replaced free activate. */
const STUB_REVOKE_FLAG = "hsp_pro_access_stub_revoked_v1";
/** Survives disconnect after success so we can finish sync_pro without wiping local Pro. */
const PENDING_SERVER_SYNC_KEY = "hsp_pro_access.server_sync_pending.v1";
const listeners = new Set<() => void>();
let state: ProState = {
  active: false,
  planId: null,
  expiresAt: null,
  cancelAtPeriodEnd: false,
};
let hydrated = false;
let flushInFlight: Promise<boolean> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function readPendingServerSync(): PendingProServerSync | null {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_SERVER_SYNC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingProServerSync>;
    if (
      typeof parsed.expiresAt !== "string" ||
      !parsed.expiresAt ||
      (parsed.planId !== "month" && parsed.planId !== "quarter" && parsed.planId !== "year") ||
      typeof parsed.priceUsd !== "number" ||
      typeof parsed.months !== "number"
    ) {
      return null;
    }
    return {
      expiresAt: parsed.expiresAt,
      planId: parsed.planId,
      priceUsd: parsed.priceUsd,
      months: parsed.months,
      recordSale: Boolean(parsed.recordSale),
      ...(typeof parsed.paymentMemo === "string" && parsed.paymentMemo.trim()
        ? { paymentMemo: parsed.paymentMemo.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function writePendingServerSync(pending: PendingProServerSync | null): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    if (!pending) {
      localStorage.removeItem(PENDING_SERVER_SYNC_KEY);
      return;
    }
    localStorage.setItem(PENDING_SERVER_SYNC_KEY, JSON.stringify(pending));
  } catch {
    /* ignore */
  }
}

export function hasPendingProServerSync(): boolean {
  return readPendingServerSync() != null;
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    for (const key of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    const stubRevoked = localStorage.getItem(STUB_REVOKE_FLAG) === "1";
    if (!stubRevoked) {
      localStorage.setItem(STUB_REVOKE_FLAG, "1");
      localStorage.removeItem(STORAGE_KEY);
      state = {
        active: false,
        planId: null,
        expiresAt: null,
        cancelAtPeriodEnd: false,
      };
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ProState;
    state = {
      active: Boolean(parsed.active),
      planId:
        parsed.planId === "month" || parsed.planId === "quarter" || parsed.planId === "year"
          ? parsed.planId
          : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      cancelAtPeriodEnd: Boolean(parsed.cancelAtPeriodEnd),
    };
    if (state.active && state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
      state = {
        active: false,
        planId: null,
        expiresAt: null,
        cancelAtPeriodEnd: false,
      };
      persist();
      writePendingServerSync(null);
    }
    // Pending sync_pro is flushed on auth bootstrap / payment — not here —
    // so a founder revoke is not undone by stale localStorage alone.
  } catch {
    /* ignore */
  }
}

export function isProAccessActive(): boolean {
  hydrate();
  if (!state.active) return false;
  if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
    state = {
      active: false,
      planId: null,
      expiresAt: null,
      cancelAtPeriodEnd: false,
    };
    persist();
    writePendingServerSync(null);
    notify();
    return false;
  }
  return true;
}

export function getProAccessState(): ProState {
  hydrate();
  return state;
}

export function subscribeProAccess(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Retry sync_pro until the server acknowledges entitlement (or clear pending).
 * Prevents “success dialog then disconnect” from losing Pro on next login.
 */
export async function flushProAccessServerSync(): Promise<boolean> {
  hydrate();
  const pending = readPendingServerSync();
  if (!pending) return true;
  if (!state.active || !state.expiresAt || Date.parse(state.expiresAt) <= Date.now()) {
    writePendingServerSync(null);
    return true;
  }
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      const ok = await syncProAccessQuotaToServer(pending.expiresAt, {
        planId: pending.planId,
        priceUsd: pending.priceUsd,
        months: pending.months,
        recordSale: pending.recordSale && i === 0,
        ...(pending.paymentMemo ? { paymentMemo: pending.paymentMemo } : {}),
      });
      if (ok) {
        writePendingServerSync(null);
        return true;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return false;
  })();
  try {
    return await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

/** Activate locally, queue durable server sync, wait for acknowledgment when possible. */
export async function activateProAccessAsync(
  planId: ProAccessPlanId,
  opts?: { recordSale?: boolean; paymentMemo?: string },
): Promise<boolean> {
  hydrate();
  const plans = getProAccessPlans();
  const plan = plans.find((p) => p.id === planId) ?? plans[0]!;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + plan.months);
  const expiresAt = expires.toISOString();
  state = {
    active: true,
    planId: plan.id,
    expiresAt,
    cancelAtPeriodEnd: false,
  };
  persist();
  notify();
  writePendingServerSync({
    expiresAt,
    planId: plan.id,
    priceUsd: plan.priceUsd,
    months: plan.months,
    recordSale: opts?.recordSale !== false,
    ...(opts?.paymentMemo?.trim() ? { paymentMemo: opts.paymentMemo.trim() } : {}),
  });
  return flushProAccessServerSync();
}

export function activateProAccess(planId: ProAccessPlanId): void {
  void activateProAccessAsync(planId);
}

/**
 * Soft-cancel: keep Pro through the paid period; do not start another after expiry.
 * (Prepaid product — no server charge is scheduled today; this is the user-facing cancel.)
 */
export function cancelProAccessAtPeriodEnd(): void {
  hydrate();
  if (!isProAccessActive() || state.cancelAtPeriodEnd) return;
  state = { ...state, cancelAtPeriodEnd: true };
  persist();
  notify();
}

/** Undo a soft cancel while the period is still active. */
export function resumeProAccessRenewal(): void {
  hydrate();
  if (!isProAccessActive() || !state.cancelAtPeriodEnd) return;
  state = { ...state, cancelAtPeriodEnd: false };
  persist();
  notify();
}

/** Revoke Pro Access for this client (all messenger accounts share one entitlement). */
export function clearProAccess(): void {
  hydrate();
  if (!state.active && !state.planId && !state.expiresAt && !state.cancelAtPeriodEnd) return;
  state = {
    active: false,
    planId: null,
    expiresAt: null,
    cancelAtPeriodEnd: false,
  };
  persist();
  writePendingServerSync(null);
  notify();
  void syncProAccessQuotaToServer(null);
}

/**
 * Mirror server Pro onto local entitlement UI.
 * - Server inactive → clear local (unless a paid sync is still pending).
 * - Server active → apply expiry so founder grants / other-device purchases show as subscribed.
 */
export function reconcileProAccessFromServer(
  serverProActive: boolean,
  opts?: { expiresAt?: string | null; planId?: ProAccessPlanId | null },
): void {
  hydrate();
  if (!serverProActive) {
    if (!state.active) return;
    // Paid unlock still waiting on sync_pro — do not wipe; retry instead.
    if (readPendingServerSync()) {
      void flushProAccessServerSync();
      return;
    }
    state = {
      active: false,
      planId: null,
      expiresAt: null,
      cancelAtPeriodEnd: false,
    };
    persist();
    notify();
    return;
  }

  const expiresAt =
    typeof opts?.expiresAt === "string" &&
    opts.expiresAt.trim() &&
    Date.parse(opts.expiresAt) > Date.now()
      ? opts.expiresAt.trim()
      : null;
  if (!expiresAt) return;

  const planId: ProAccessPlanId =
    opts?.planId === "month" || opts?.planId === "quarter" || opts?.planId === "year"
      ? opts.planId
      : state.planId === "month" || state.planId === "quarter" || state.planId === "year"
        ? state.planId
        : "month";

  const already =
    state.active &&
    state.expiresAt === expiresAt &&
    state.planId === planId;
  if (already) return;

  state = {
    active: true,
    planId,
    expiresAt,
    cancelAtPeriodEnd: state.active ? state.cancelAtPeriodEnd : false,
  };
  persist();
  notify();
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0";
  const abs = Math.abs(amount);
  const digits = abs > 0 && abs < 0.01 ? 3 : 2;
  const fixed = amount.toFixed(digits).replace(/\.?0+$/, "");
  return `$${fixed || "0"}`;
}
