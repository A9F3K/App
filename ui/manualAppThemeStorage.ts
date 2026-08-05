import type { ThemeName } from "./theme";

const STORAGE_KEY = "hyperlinks_app_manual_theme_v1";

function isStoredTheme(s: string): s is ThemeName {
  return s === "dark" || s === "light";
}

/** Web: `localStorage`. Native: not available (returns null); override is session-only. */
export function readStoredManualAppTheme(): ThemeName | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY);
      if (raw != null && isStoredTheme(raw)) return raw;
    }
  } catch {
    /* private mode / SSR */
  }
  return null;
}

export function writeStoredManualAppTheme(theme: ThemeName | null): void {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      if (theme == null) ls.removeItem(STORAGE_KEY);
      else ls.setItem(STORAGE_KEY, theme);
    }
  } catch {
    /* ignore */
  }
}
