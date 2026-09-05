/**
 * Pro Access plans and entitlement.
 *
 * Unit economics (single power user today → must profit from month 1):
 * - Railway TDLib gateway 24/7 ≈ $8–15
 * - Vercel serverless + bandwidth ≈ $5–20
 * - AI model usage ≈ $8–20
 * Worst-case COGS ≈ $40 / user / month at n=1; falls toward ~$6–10 as users share infra.
 *
 * Longer terms use a modest per-month discount vs month-to-month.
 */

import { Platform } from "react-native";

export type ProAccessPlanId = "month" | "quarter" | "year";

export type ProAccessPlan = {
  id: ProAccessPlanId;
  months: number;
  /** Total billed for the full term. */
  priceUsd: number;
  /** Per-month equivalent (shown above the billed total). */
  monthlyUsd: number;
  /** Full-term list price before discount (strikethrough on multi-month cards). */
  listPriceUsd?: number;
  highlight?: boolean;
};

export const PRO_ACCESS_PLANS: readonly ProAccessPlan[] = [
  { id: "month", months: 1, priceUsd: 20, monthlyUsd: 20 },
  { id: "quarter", months: 3, priceUsd: 55.5, monthlyUsd: 18.5, listPriceUsd: 60 },
  { id: "year", months: 12, priceUsd: 204, monthlyUsd: 17, listPriceUsd: 240, highlight: true },
] as const;

export const PRO_ACCESS_FEATURES = [
  {
    id: "aiModels",
    titleKey: "pro.feature.aiModels",
    bodyKey: "pro.feature.aiModels.body",
  },
  {
    id: "proxyVpn",
    titleKey: "pro.feature.proxyVpn",
    bodyKey: "pro.feature.proxyVpn.body",
  },
  {
    id: "nftCollection",
    titleKey: "pro.feature.nftCollection",
    bodyKey: "pro.feature.nftCollection.body",
  },
  {
    id: "cashback",
    titleKey: "pro.feature.cashback",
    bodyKey: "pro.feature.cashback.body",
  },
  {
    id: "blockchainChat",
    titleKey: "pro.feature.blockchainChat",
    bodyKey: "pro.feature.blockchainChat.body",
  },
  {
    id: "unlimitedAccounts",
    titleKey: "pro.feature.unlimitedAccounts",
    bodyKey: "pro.feature.unlimitedAccounts.body",
  },
  {
    id: "menuCustomization",
    titleKey: "pro.feature.menuCustomization",
    bodyKey: "pro.feature.menuCustomization.body",
  },
] as const;

/** @deprecated Prefer {@link PRO_ACCESS_FEATURES}. */
export const PRO_ACCESS_FEATURE_KEYS = PRO_ACCESS_FEATURES.map((f) => f.titleKey);

type ProState = {
  active: boolean;
  planId: ProAccessPlanId | null;
  expiresAt: string | null;
};

/** Bumped so stub activations from `hsp_pro_access_v1` are dropped for every client. */
const STORAGE_KEY = "hsp_pro_access_v2";
const LEGACY_STORAGE_KEYS = ["hsp_pro_access_v1"] as const;
/** One-shot revoke of stub entitlements after payment UI replaced free activate. */
const STUB_REVOKE_FLAG = "hsp_pro_access_stub_revoked_v1";
const listeners = new Set<() => void>();
let state: ProState = { active: false, planId: null, expiresAt: null };
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
      state = { active: false, planId: null, expiresAt: null };
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
    };
    if (state.active && state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
      state = { active: false, planId: null, expiresAt: null };
      persist();
    }
  } catch {
    /* ignore */
  }
}

export function isProAccessActive(): boolean {
  hydrate();
  if (!state.active) return false;
  if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
    state = { active: false, planId: null, expiresAt: null };
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
  const plan = PRO_ACCESS_PLANS.find((p) => p.id === planId) ?? PRO_ACCESS_PLANS[0]!;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + plan.months);
  state = {
    active: true,
    planId: plan.id,
    expiresAt: expires.toISOString(),
  };
  persist();
  notify();
}

/** Revoke Pro Access for this client (all messenger accounts share one entitlement). */
export function clearProAccess(): void {
  hydrate();
  if (!state.active && !state.planId && !state.expiresAt) return;
  state = { active: false, planId: null, expiresAt: null };
  persist();
  notify();
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0";
  const fixed = amount.toFixed(2).replace(/\.?0+$/, "");
  return `$${fixed}`;
}
