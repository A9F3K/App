import type { ImageSource } from "expo-image";

import type { AppLocale } from "../../../locales/appStrings";
import { formatSwapUsdCompact } from "../../swap/formatSwapTokenMarketValue";
import { swapDllrTokenImage } from "./swapFormAssets";

export type ChooseCurrencyIconSource = ImageSource | { uri: string };

export type ChooseCurrencyColumnKey =
  | "rank"
  | "currency"
  | "balance"
  | "rate"
  | "networks"
  | "marketCap"
  | "volume"
  | "lastYear";

export type ChooseCurrencyColumnPriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type ChooseCurrencyRow = {
  /** Stable list key (jetton address). */
  rowKey: string;
  currency: {
    name: string;
    ticker: string;
    icon: ChooseCurrencyIconSource | null;
  };
  balance: string;
  rate: string;
  networks: string;
  marketCap: string;
  volume: string;
  /** Stablecoin rows use a flat horizontal line in the mini chart slot. */
  lastYearKind: "stable";
};

export const CHOOSE_CURRENCY_COLUMN_ORDER: readonly ChooseCurrencyColumnKey[] = [
  "rank",
  "currency",
  "balance",
  "rate",
  "marketCap",
  "networks",
  "volume",
  "lastYear",
] as const;

export const CHOOSE_CURRENCY_COLUMN_PRIORITY: Record<ChooseCurrencyColumnKey, ChooseCurrencyColumnPriority> =
  {
    rank: 5,
    currency: 1,
    balance: 4,
    rate: 2,
    marketCap: 3,
    networks: 6,
    volume: 7,
    lastYear: 8,
  };

/** Locale-aware DLLR placeholder stats for the pinned first row. */
export function buildChooseCurrencyDllrRow(locale: AppLocale): ChooseCurrencyRow {
  return {
    rowKey: "jetton:dllr",
    currency: {
      name: "Dollar",
      ticker: "DLLR",
      icon: swapDllrTokenImage,
    },
    balance: "1",
    rate: "$1",
    networks: "TON, ETH...",
    marketCap: formatSwapUsdCompact(3_000_000_000_000, locale),
    volume: formatSwapUsdCompact(123_000_000, locale),
    lastYearKind: "stable",
  };
}

/** Hardcoded first row — always pinned at top of the choose-currency list (English defaults). */
export const CHOOSE_CURRENCY_DLLR_ROW: ChooseCurrencyRow = buildChooseCurrencyDllrRow("en");

/** Fallback when live API rows are unavailable. */
export const CHOOSE_CURRENCY_SAMPLE_ROWS: readonly ChooseCurrencyRow[] = [CHOOSE_CURRENCY_DLLR_ROW];
