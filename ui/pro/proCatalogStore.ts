/**
 * Client Pro catalog: plans + enabled features from /api/pro-catalog (fallback = AI-only $5).
 */
import { Platform } from "react-native";

import { buildApiUrl } from "../../api/_base";
import {
  buildProPlansFromCatalog,
  DEFAULT_PRO_CATALOG,
  enabledProFeatureIds,
  normalizeProCatalog,
  type ProCatalogConfig,
  type ProCatalogPlan,
  type ProFeatureId,
} from "../../shared/proCatalog";

const STORAGE_KEY = "hsp.pro_catalog.v1";
const listeners = new Set<() => void>();

let catalog: ProCatalogConfig = { ...DEFAULT_PRO_CATALOG };
let plans: ProCatalogPlan[] = buildProPlansFromCatalog(catalog);
let enabledFeatureIds: ProFeatureId[] = enabledProFeatureIds(catalog);
let hydrated = false;
let fetchInflight: Promise<void> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ catalog, plans, enabledFeatureIds }),
    );
  } catch {
    /* ignore */
  }
}

function applyCatalog(next: ProCatalogConfig): void {
  catalog = normalizeProCatalog(next);
  plans = buildProPlansFromCatalog(catalog);
  enabledFeatureIds = enabledProFeatureIds(catalog);
  persist();
  notify();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { catalog?: Partial<ProCatalogConfig> };
    if (parsed.catalog) applyCatalog(normalizeProCatalog(parsed.catalog));
  } catch {
    /* ignore */
  }
}

export function getProCatalogSnapshot(): ProCatalogConfig {
  hydrate();
  return catalog;
}

export function getProCatalogPlans(): readonly ProCatalogPlan[] {
  hydrate();
  return plans;
}

export function getEnabledProFeatureIds(): readonly ProFeatureId[] {
  hydrate();
  return enabledFeatureIds;
}

export function isProFeatureEnabled(id: ProFeatureId): boolean {
  return getEnabledProFeatureIds().includes(id);
}

export function subscribeProCatalog(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshProCatalogFromServer(): Promise<ProCatalogConfig> {
  if (fetchInflight) {
    await fetchInflight;
    return getProCatalogSnapshot();
  }
  fetchInflight = (async () => {
    try {
      const res = await fetch(buildApiUrl("/api/pro-catalog"), {
        method: "GET",
        credentials: "include",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        catalog?: Partial<ProCatalogConfig>;
      };
      if (res.ok && json.ok && json.catalog) {
        applyCatalog(normalizeProCatalog(json.catalog));
      }
    } catch {
      /* keep cached / defaults */
    } finally {
      fetchInflight = null;
    }
  })();
  await fetchInflight;
  return getProCatalogSnapshot();
}
