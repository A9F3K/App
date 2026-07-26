import type { AppLocale } from "./appStrings";

const STORAGE_KEY = "hyperlinks_app_manual_locale_v1";

function isStoredLocale(s: string): s is AppLocale {
  return s === "en" || s === "ru" || s === "zh";
}

/** Web: `localStorage`. Native: not available (returns null); override is session-only. */
export function readStoredManualAppLocale(): AppLocale | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY);
      if (raw != null && isStoredLocale(raw)) return raw;
    }
  } catch {
    /* private mode / SSR */
  }
  return null;
}

export function writeStoredManualAppLocale(locale: AppLocale | null): void {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      if (locale == null) ls.removeItem(STORAGE_KEY);
      else ls.setItem(STORAGE_KEY, locale);
    }
  } catch {
    /* ignore */
  }
}
