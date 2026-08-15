import { useSyncExternalStore } from "react";

/** Right split column content on authenticated home (wide layout only). */
export type AuthenticatedHomeRightPanelKey = "swap" | "smart" | "trade" | "send" | "get";

export const DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY: AuthenticatedHomeRightPanelKey = "swap";

const STORAGE_KEY = "hyperlinks_authenticated_home_right_panel_v2";

const PANEL_KEYS: readonly AuthenticatedHomeRightPanelKey[] = [
  "swap",
  "smart",
  "trade",
  "send",
  "get",
] as const;

function isStoredPanelKey(raw: string | null | undefined): raw is AuthenticatedHomeRightPanelKey {
  return raw != null && (PANEL_KEYS as readonly string[]).includes(raw);
}

function readStoredPanelKey(): AuthenticatedHomeRightPanelKey | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY);
      if (isStoredPanelKey(raw)) return raw;
    }
  } catch {
    /* private mode / SSR */
  }
  return null;
}

function writeStoredPanelKey(key: AuthenticatedHomeRightPanelKey | null): void {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      if (key == null) ls.removeItem(STORAGE_KEY);
      else ls.setItem(STORAGE_KEY, key);
    }
  } catch {
    /* ignore */
  }
}

let activePanel: AuthenticatedHomeRightPanelKey | null =
  DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY;
let hydratedFromStorage = false;
const listeners = new Set<() => void>();

function hydrateFromStorageIfNeeded() {
  if (hydratedFromStorage) return;
  hydratedFromStorage = true;
  const stored = readStoredPanelKey();
  activePanel = stored ?? DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY;
}

function emit() {
  for (const l of listeners) {
    l();
  }
}

export function openAuthenticatedHomeRightPanel(key: AuthenticatedHomeRightPanelKey) {
  hydrateFromStorageIfNeeded();
  if (activePanel === key) {
    return;
  }
  activePanel = key;
  writeStoredPanelKey(key);
  emit();
}

export function closeAuthenticatedHomeRightPanel() {
  hydrateFromStorageIfNeeded();
  if (activePanel === null) {
    return;
  }
  activePanel = null;
  writeStoredPanelKey(null);
  emit();
}

function getSnapshot() {
  hydrateFromStorageIfNeeded();
  return activePanel;
}

function getServerSnapshot() {
  return DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useAuthenticatedHomeRightPanel(): AuthenticatedHomeRightPanelKey | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
