import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useAppStrings } from "../../locales/AppStringsContext";
import {
  buildChooseCurrencyDllrRow,
  type ChooseCurrencyRow,
} from "../components/swap/chooseCurrencyTableTypes";
import { swapTonTokenImage } from "../components/swap/swapFormAssets";
import { getTonBalance } from "../ton/getTonBalance";
import { fetchSwapMarketStats } from "../swap/fetchSwapChart";
import { fetchAccountSwapJettons } from "../swap/fetchSwapJettons";
import {
  formatSwapJettonBalance,
  formatSwapTokenPriceUsd,
} from "../swap/formatSwapTokenMarketValue";
import { TON_JETTON_ADDRESS } from "../swap/swapChartConstants";
import { SWAP_GRAM_TOKEN, SWAP_TON_ZERO_ADDRESS } from "../swap/swapPairTypes";
import type { SwapJetton } from "../swap/swapJettonsTypes";
import {
  getWalletBalanceRefreshNonce,
  subscribeWalletBalanceRefresh,
} from "./walletBalanceRefresh";

const DLLR_SYMBOL = "DLLR";

function isDllrJetton(jetton: SwapJetton): boolean {
  return jetton.symbol?.trim().toUpperCase() === DLLR_SYMBOL;
}

function hasNonZeroRawBalance(balanceRaw: string): boolean {
  try {
    return BigInt(balanceRaw) > 0n;
  } catch {
    return false;
  }
}

function jettonRowIcon(jetton: SwapJetton) {
  const upper = jetton.symbol?.trim().toUpperCase();
  if (upper === "TON" || upper === "GRAM") return swapTonTokenImage;
  if (jetton.image_url) return { uri: jetton.image_url } as const;
  return null;
}

function buildHeldRow(
  rowKey: string,
  name: string,
  ticker: string,
  icon: ChooseCurrencyRow["currency"]["icon"],
  balance: string,
  priceUsd: number | null | undefined,
): ChooseCurrencyRow {
  return {
    rowKey,
    currency: { name, ticker, icon },
    balance,
    rate: formatSwapTokenPriceUsd(priceUsd),
    networks: "TON",
    marketCapUsd: 0,
    marketCap: "—",
    volume: "—",
    lastYearKind: "stable",
  };
}

function formatNativeBalanceDisplay(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const fixed = value.toFixed(7).replace(/\.?0+$/, "");
  const [whole, frac] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function parseUsdValue(row: ChooseCurrencyRow): number {
  const balance = Number.parseFloat(row.balance.replace(/,/g, ""));
  const rate = Number.parseFloat(row.rate.replace(/[^0-9.eE+-]/g, ""));
  if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return 0;
  }
  return balance * rate;
}

/** Header balance line — matches legacy `1$` style but uses live totals when available. */
export function formatHeaderWalletBalanceLabel(totalUsd: number, isLoading: boolean): string {
  if (isLoading) return "…";
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return "0$";
  if (totalUsd < 0.01) return "<0.01$";
  if (totalUsd < 1_000) {
    const rounded = totalUsd >= 10 ? totalUsd.toFixed(0) : totalUsd.toFixed(2).replace(/\.?0+$/, "");
    return `${rounded}$`;
  }
  if (totalUsd < 1_000_000) return `${Math.round(totalUsd / 1_000)}K$`;
  if (totalUsd < 1_000_000_000) return `${(totalUsd / 1_000_000).toFixed(1).replace(/\.0$/, "")}M$`;
  return `${(totalUsd / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B$`;
}

export type WalletHeldCurrencyRowsState = {
  rows: readonly ChooseCurrencyRow[];
  isLoading: boolean;
  error: string | null;
  headerBalanceLabel: string;
};

/** Jettons and native GRAM with a non-zero on-chain balance for one wallet address. */
export function useWalletHeldCurrencyRows(
  walletAddress: string | null | undefined,
  enabled = true,
): WalletHeldCurrencyRowsState {
  const { locale } = useAppStrings();
  const refreshNonce = useSyncExternalStore(
    subscribeWalletBalanceRefresh,
    getWalletBalanceRefreshNonce,
    getWalletBalanceRefreshNonce,
  );
  const accountCreationDllrRow = useMemo(() => buildChooseCurrencyDllrRow(locale), [locale]);
  const [heldRows, setHeldRows] = useState<readonly ChooseCurrencyRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const withoutDllr = heldRows.filter(
      (row) =>
        row.rowKey !== accountCreationDllrRow.rowKey &&
        row.currency.ticker.trim().toUpperCase() !== DLLR_SYMBOL,
    );
    return [accountCreationDllrRow, ...withoutDllr];
  }, [accountCreationDllrRow, heldRows]);

  const headerBalanceLabel = useMemo(() => {
    const totalUsd = heldRows.reduce((sum, row) => sum + parseUsdValue(row), 0);
    return formatHeaderWalletBalanceLabel(totalUsd, isLoading);
  }, [heldRows, isLoading]);

  useEffect(() => {
    if (!enabled) return;

    const trimmed = walletAddress?.trim() ?? "";
    if (!trimmed) {
      setHeldRows([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [nativeBalance, accountResponse, gramStats] = await Promise.all([
          getTonBalance(trimmed),
          fetchAccountSwapJettons(trimmed),
          fetchSwapMarketStats(TON_JETTON_ADDRESS),
        ]);
        if (cancelled) return;

        const next: ChooseCurrencyRow[] = [];

        if (nativeBalance > 0) {
          next.push(
            buildHeldRow(
              SWAP_TON_ZERO_ADDRESS,
              SWAP_GRAM_TOKEN.name,
              SWAP_GRAM_TOKEN.symbol,
              swapTonTokenImage,
              formatNativeBalanceDisplay(nativeBalance),
              gramStats.priceUsd,
            ),
          );
        }

        for (const item of accountResponse.items ?? []) {
          if (!hasNonZeroRawBalance(item.balance)) continue;
          const jetton = item.jetton;
          if (jetton && isDllrJetton(jetton)) continue;
          const addressKey = (jetton?.address ?? item.jetton_address)?.toLowerCase();
          if (!addressKey || !jetton?.symbol?.trim()) continue;
          if (addressKey === SWAP_TON_ZERO_ADDRESS.toLowerCase()) continue;

          const decimals = typeof jetton.decimals === "number" ? jetton.decimals : 9;
          const symbol = jetton.symbol.trim();
          const name = (jetton.name ?? symbol).trim() || symbol;
          next.push(
            buildHeldRow(
              addressKey,
              name,
              symbol,
              jettonRowIcon(jetton),
              formatSwapJettonBalance(item.balance, decimals),
              jetton.market_stats?.price_usd,
            ),
          );
        }

        next.sort((a, b) => {
          const delta = parseUsdValue(b) - parseUsdValue(a);
          if (delta !== 0) return delta;
          return a.currency.ticker.localeCompare(b.currency.ticker);
        });

        setHeldRows(next);
      } catch (err) {
        if (cancelled) return;
        setHeldRows([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    const id = setInterval(() => void load(), 30_000);

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, refreshNonce, walletAddress]);

  return { rows, isLoading, error, headerBalanceLabel };
}
