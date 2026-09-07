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

/** Bumped so stub activations from `hsp_pro_access_v1` are dropped for every client. */
const STORAGE_KEY = "hsp_pro_access_v2";
const LEGACY_STORAGE_KEYS = ["hsp_pro_access_v1"] as const;
/** One-shot revoke of stub entitlements after payment UI replaced free activate. */
const STUB_REVOKE_FLAG = "hsp_pro_access_stub_revoked_v1";
const listeners = new Set<() => void>();
let state: ProState = {
  active: false,
  planId: null,
  expiresAt: null,
  cancelAtPeriodEnd: false,
};
let hydrated = false;

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
    }
    // Do not push local Pro to the server on hydrate — that undoes founder revoke
    // when the client still has a stale entitlement in localStorage.
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

export function activateProAccess(planId: ProAccessPlanId): void {
  hydrate();
  const plans = getProAccessPlans();
  const plan = plans.find((p) => p.id === planId) ?? plans[0]!;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + plan.months);
  state = {
    active: true,
    planId: plan.id,
    expiresAt: expires.toISOString(),
    cancelAtPeriodEnd: false,
  };
  persist();
  notify();
  void syncProAccessQuotaToServer(state.expiresAt, {
    planId: plan.id,
    priceUsd: plan.priceUsd,
    months: plan.months,
    recordSale: true,
  });
  // Cashback is granted by the payment flow after a successful debit (hot balance).
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
  notify();
  void syncProAccessQuotaToServer(null);
}

/** When the server reports Pro inactive (e.g. founder revoke), drop local entitlement. */
export function reconcileProAccessFromServer(serverProActive: boolean): void {
  hydrate();
  if (!serverProActive && state.active) {
    state = {
      active: false,
      planId: null,
      expiresAt: null,
      cancelAtPeriodEnd: false,
    };
    persist();
    notify();
  }
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0";
  const fixed = amount.toFixed(2).replace(/\.?0+$/, "");
  return `$${fixed}`;
}
