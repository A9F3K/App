import type { AppLocale } from "./appStrings";

/** Locales stored in `feed_default_messages.locale` (extend when adding catalogue languages). */
export type FeedCatalogLocale = "en" | "ru";

export const FEED_CATALOG_LOCALES: readonly FeedCatalogLocale[] = ["en", "ru"] as const;

/** Catalogue row used when a requested locale has no translation for a key. */
export const FEED_CATALOG_FALLBACK_LOCALE: FeedCatalogLocale = "en";

export function isFeedCatalogLocale(raw: unknown): raw is FeedCatalogLocale {
  return raw === "en" || raw === "ru";
}

/**
 * Map a BCP-47 / Telegram `language_code` tag to a feed catalogue locale.
 * Russian → `ru`; Chinese and everything else → `en` until a `zh` catalogue exists.
 */
export function resolveFeedCatalogLocaleFromLanguageTag(
  raw: string | null | undefined,
): FeedCatalogLocale {
  if (!raw || typeof raw !== "string") return FEED_CATALOG_FALLBACK_LOCALE;
  const base = raw.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
  if (base === "ru") return "ru";
  return FEED_CATALOG_FALLBACK_LOCALE;
}

/**
 * Locale used when rendering welcome-bundle feed copy from `feed_default_messages`.
 * When manual welcome translation is off, follows Telegram language policy only.
 * When on, follows the effective UI locale (header / welcome switcher included);
 * Chinese UI falls back to the English catalogue until `zh` rows exist.
 */
export function resolveWelcomeFeedDisplayLocale(opts: {
  telegramLanguageCode: string | null | undefined;
  uiLocale: AppLocale;
  manualWelcomeTranslationEnabled: boolean;
}): FeedCatalogLocale {
  if (opts.manualWelcomeTranslationEnabled) {
    return opts.uiLocale === "ru" ? "ru" : FEED_CATALOG_FALLBACK_LOCALE;
  }
  return resolveFeedCatalogLocaleFromLanguageTag(opts.telegramLanguageCode);
}

/** Parse `?catalog_locale=` / JSON body hint from the client (must be a known catalogue locale). */
export function parseFeedCatalogLocaleHint(raw: unknown): FeedCatalogLocale | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return isFeedCatalogLocale(t) ? t : null;
}
