import { useSyncExternalStore } from "react";

/** Right split column content on authenticated home (wide layout only). */
export type AuthenticatedHomeRightPanelKey = "swap" | "smart" | "trade" | "send" | "get";

/** Cold start / hard reload always opens Swap; in-session switches stay in memory only. */
export const DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY: AuthenticatedHomeRightPanelKey = "swap";

let activePanel: AuthenticatedHomeRightPanelKey | null =
  DEFAULT_AUTHENTICATED_HOME_RIGHT_PANEL_KEY;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) {
    l();
  }
}

export function openAuthenticatedHomeRightPanel(key: AuthenticatedHomeRightPanelKey) {
  if (activePanel === key) {
    return;
  }
  activePanel = key;
  emit();
}

export function closeAuthenticatedHomeRightPanel() {
  if (activePanel === null) {
    return;
  }
  activePanel = null;
  emit();
}

function getSnapshot() {
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
