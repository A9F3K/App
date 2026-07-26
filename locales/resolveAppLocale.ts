import type { AppLocale } from "./appStrings";
import { APP_LOCALE_DEFAULT } from "./appStrings";

export type AppLocaleResolutionReason =
  | "telegram_language_ru"
  | "telegram_language_zh"
  | "telegram_language_en"
  | "telegram_language_other_to_en"
  | "mini_app_missing_language_code_system"
  | "system_language_ru"
  | "system_language_zh"
  | "system_language_en"
  | "system_language_other_to_en"
  | "system_language_unavailable";

export type AppLocaleResolutionMeta = {
  locale: AppLocale;
  reason: AppLocaleResolutionReason;
  /** Lowercase base tag from the language source when present (e.g. `ru`, `zh`, `en`). */
  languageBase: string | null;
};

function baseTag(tag: string): string {
  return tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/** Map a BCP-47 / Telegram `language_code` tag to an app locale; unknown → English. */
export function languageTagToAppLocale(tag: string): AppLocale {
  const base = baseTag(tag);
  if (base === "ru") return "ru";
  if (base === "zh") return "zh";
  if (base === "en") return "en";
  return APP_LOCALE_DEFAULT;
}

function reasonForMappedLocale(
  locale: AppLocale,
  source: "telegram" | "system",
  other: boolean,
): AppLocaleResolutionReason {
  if (other) {
    return source === "telegram" ? "telegram_language_other_to_en" : "system_language_other_to_en";
  }
  if (source === "telegram") {
    if (locale === "ru") return "telegram_language_ru";
    if (locale === "zh") return "telegram_language_zh";
    return "telegram_language_en";
  }
  if (locale === "ru") return "system_language_ru";
  if (locale === "zh") return "system_language_zh";
  return "system_language_en";
}

/** Browser / OS language preference (first usable tag). */
export function readSystemLanguageTag(): string | null {
  try {
    if (typeof navigator === "undefined") return null;
    const list =
      Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
    for (const item of list) {
      if (typeof item === "string" && item.trim()) return item.trim();
    }
  } catch {
    /* SSR / restricted */
  }
  return null;
}

function resolveFromLanguageTag(
  raw: string,
  source: "telegram" | "system",
): AppLocaleResolutionMeta {
  const base = baseTag(raw);
  const known = base === "ru" || base === "zh" || base === "en";
  const locale = languageTagToAppLocale(raw);
  return {
    locale,
    reason: reasonForMappedLocale(locale, source, !known),
    languageBase: base || null,
  };
}

function resolveFromSystem(systemLanguageTag: string | null | undefined): AppLocaleResolutionMeta {
  const raw = typeof systemLanguageTag === "string" ? systemLanguageTag.trim() : "";
  if (!raw) {
    return {
      locale: APP_LOCALE_DEFAULT,
      reason: "system_language_unavailable",
      languageBase: null,
    };
  }
  return resolveFromLanguageTag(raw, "system");
}

/**
 * UI locale policy:
 * - **Inside the Telegram Mini App**: use Telegram `user.language_code` when present
 *   (`ru` → Russian, `zh` → Chinese, `en` → English; any other tag → English).
 *   If `language_code` is missing, fall back to the system / browser language.
 * - **Outside the Mini App** (web, OIDC, desktop shell, native): inherit the system /
 *   browser language with the same mapping; default to English when unknown or unavailable.
 */
export function resolveAppLocaleWithMeta(opts: {
  telegramMiniApp: boolean;
  telegramLanguageCode: string | null | undefined;
  /** Override for tests; defaults to {@link readSystemLanguageTag}. */
  systemLanguageTag?: string | null;
}): AppLocaleResolutionMeta {
  const systemTag =
    opts.systemLanguageTag !== undefined ? opts.systemLanguageTag : readSystemLanguageTag();

  if (opts.telegramMiniApp) {
    const raw = typeof opts.telegramLanguageCode === "string" ? opts.telegramLanguageCode.trim() : "";
    if (!raw) {
      const fromSystem = resolveFromSystem(systemTag);
      if (fromSystem.reason === "system_language_unavailable") {
        return {
          locale: APP_LOCALE_DEFAULT,
          reason: "mini_app_missing_language_code_system",
          languageBase: null,
        };
      }
      return {
        ...fromSystem,
        reason: "mini_app_missing_language_code_system",
      };
    }
    return resolveFromLanguageTag(raw, "telegram");
  }

  return resolveFromSystem(systemTag);
}

export function resolveAppLocale(opts: {
  telegramMiniApp: boolean;
  telegramLanguageCode: string | null | undefined;
  systemLanguageTag?: string | null;
}): AppLocale {
  return resolveAppLocaleWithMeta(opts).locale;
}
