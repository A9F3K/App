import type { ImageSource } from "expo-image";

import type { AppLocale } from "../../../locales/appStrings";
import { formatSwapUsdCompact } from "../../swap/formatSwapTokenMarketValue";
import { swapDllrTokenImage } from "./swapFormAssets";

export type ChooseCurrencyIconSource = ImageSource | { uri: string };

export type ChooseCurrencyColumnKey =
  | "rank"
  | "currency"
  | "balance"
  | "value"
  | "rate"
  | "networks"
  | "marketCap"
  | "volume"
  | "lastYear";

export type ChooseCurrencyColumnPriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type ChooseCurrencyRow = {
  /** Stable list key (jetton address). */
  rowKey: string;
  currency: {
    name: string;
    ticker: string;
    icon: ChooseCurrencyIconSource | null;
  };
  balance: string;
  /**
   * DLLR-only ledger shown inside the wallet-dialog expand panel (not under the balance cell).
   */
  dllrLedger?: { hot: string; frozen: string };
  /** USD equivalent of the held balance (balance × rate). */
  value: string;
  rate: string;
  networks: string;
  marketCap: string;
  /** Volume-adjusted USD rank score for descending sort (0 when unknown / excluded). */
  marketCapUsd: number;
  volume: string;
  /**
   * `stable` — flat line (DLLR).
   * `sparkline` — last-year price plot (trade chart style, no legend).
   */
  lastYearKind: "stable" | "sparkline";
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
    value: 3,
    rate: 2,
    marketCap: 3,
    networks: 6,
    volume: 7,
    lastYear: 8,
  };

/** Locale-aware DLLR placeholder stats for the pinned first row. */
export function buildChooseCurrencyDllrRow(locale: AppLocale): ChooseCurrencyRow {
  const marketCapUsd = 3_000_000_000_000;
  return {
    rowKey: "jetton:dllr",
    currency: {
      name: "Dollar",
      ticker: "DLLR",
      icon: swapDllrTokenImage,
    },
    balance: "1",
    value: "$1",
    rate: "$1",
    networks: "TON, ETH...",
    marketCapUsd,
    marketCap: formatSwapUsdCompact(marketCapUsd, locale),
    volume: formatSwapUsdCompact(2_000_000_000, locale),
    lastYearKind: "stable",
  };
}

/** Hardcoded first row — always pinned at top of the choose-currency list (English defaults). */
export const CHOOSE_CURRENCY_DLLR_ROW: ChooseCurrencyRow = buildChooseCurrencyDllrRow("en");

/** Fallback when live API rows are unavailable. */
export const CHOOSE_CURRENCY_SAMPLE_ROWS: readonly ChooseCurrencyRow[] = [CHOOSE_CURRENCY_DLLR_ROW];
