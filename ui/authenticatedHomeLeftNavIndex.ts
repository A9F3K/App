import { useSyncExternalStore } from "react";

/** Left nav tab on authenticated home: Feed, Messages, Tasks, Items, Coins. */
export const AUTHENTICATED_HOME_LEFT_NAV_ITEM_COUNT = 5;

const STORAGE_KEY = "hyperlinks_authenticated_home_left_nav_v1";

function isValidNavIndex(raw: number): boolean {
  return Number.isInteger(raw) && raw >= 0 && raw < AUTHENTICATED_HOME_LEFT_NAV_ITEM_COUNT;
}

function readStoredNavIndex(): number {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY);
      if (raw != null) {
        const index = Number(raw);
        if (isValidNavIndex(index)) return index;
      }
    }
  } catch {
    /* private mode / SSR */
  }
  return 0;
}

function writeStoredNavIndex(index: number): void {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(STORAGE_KEY, String(index));
    }
  } catch {
    /* ignore */
  }
}

let activeIndex = 0;
let hydratedFromStorage = false;
const listeners = new Set<() => void>();

function hydrateFromStorageIfNeeded() {
  if (hydratedFromStorage) return;
  hydratedFromStorage = true;
  activeIndex = readStoredNavIndex();
}

/** Re-read localStorage after app account logout/login (module state may have reset). */
export function rehydrateAuthenticatedHomeLeftNavFromStorage(): void {
  const stored = readStoredNavIndex();
  hydratedFromStorage = true;
  if (activeIndex === stored) return;
  activeIndex = stored;
  emit();
}

function emit() {
  for (const l of listeners) {
    l();
  }
}

export function setAuthenticatedHomeLeftNavIndex(index: number) {
  hydrateFromStorageIfNeeded();
  if (!isValidNavIndex(index) || activeIndex === index) return;
  activeIndex = index;
  writeStoredNavIndex(index);
  emit();
}

function getSnapshot() {
  hydrateFromStorageIfNeeded();
  return activeIndex;
}

function getServerSnapshot() {
  return 0;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useAuthenticatedHomeLeftNavIndex(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
