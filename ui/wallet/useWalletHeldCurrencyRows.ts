import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAppStrings } from "../../locales/AppStringsContext";
import {
  buildChooseCurrencyDllrRow,
  type ChooseCurrencyRow,
} from "../components/swap/chooseCurrencyTableTypes";
import { swapTonTokenImage } from "../components/swap/swapFormAssets";
import { logPageDisplay } from "../pageDisplayLog";
import { fetchTonapiAccountHoldings } from "../ton/fetchTonapiAccountHoldings";
import { requestWalletActivate } from "../ton/requestWalletActivate";
import { postWalletTopUpFeedNotification } from "../feed/feedNotificationActions";
import {
  formatSwapJettonBalance,
  formatSwapTokenPriceUsd,
} from "../swap/formatSwapTokenMarketValue";
import { SWAP_GRAM_TOKEN, SWAP_TON_ZERO_ADDRESS } from "../swap/swapPairTypes";
import {
  getWalletBalanceRefreshNonce,
  subscribeWalletBalanceRefresh,
} from "./walletBalanceRefresh";
import {
  getBuiltinDllrBalanceUsd,
  subscribeBuiltinDllrBalance,
} from "../pro/dllrBalanceStore";

const DLLR_SYMBOL = "DLLR";
/** Pinned baseline shown in header and wallet dialog until real DLLR balances ship. */
export const PINNED_DLLR_USD_BASELINE = 1;

function hasNonZeroRawBalance(balanceRaw: string): boolean {
  try {
    return BigInt(balanceRaw) > 0n;
  } catch {
    return false;
  }
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

/** Header balance line — pinned 1 DLLR plus live holdings. */
export function formatHeaderWalletBalanceLabel(totalUsd: number): string {
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

/** Jettons and native GRAM with a non-zero on-chain balance for one wallet address (TonAPI). */
export function useWalletHeldCurrencyRows(
  walletAddress: string | null | undefined,
  enabled = true,
  /** Telegram initData for authenticated calls (e.g. wallet activation). */
  initDataRaw?: string | null,
): WalletHeldCurrencyRowsState {
  const { locale, t, tf } = useAppStrings();
  const refreshNonce = useSyncExternalStore(
    subscribeWalletBalanceRefresh,
    getWalletBalanceRefreshNonce,
    getWalletBalanceRefreshNonce,
  );
  const dllrBalanceUsd = useSyncExternalStore(
    subscribeBuiltinDllrBalance,
    getBuiltinDllrBalanceUsd,
    getBuiltinDllrBalanceUsd,
  );
  const accountCreationDllrRow = useMemo(() => {
    const base = buildChooseCurrencyDllrRow(locale);
    const bal =
      dllrBalanceUsd >= 10
        ? dllrBalanceUsd.toFixed(0)
        : dllrBalanceUsd.toFixed(2).replace(/\.?0+$/, "");
    return { ...base, balance: bal || "0" };
  }, [dllrBalanceUsd, locale]);
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
    const heldUsd = heldRows.reduce((sum, row) => sum + parseUsdValue(row), 0);
    const totalUsd = dllrBalanceUsd + heldUsd;
    const label = formatHeaderWalletBalanceLabel(totalUsd);
    logPageDisplay("wallet_header_total", {
      baselineUsd: dllrBalanceUsd,
      heldUsd,
      totalUsd,
      heldRowCount: heldRows.length,
      label,
    });
    return label;
  }, [dllrBalanceUsd, heldRows]);

  const prevNativeBalanceRef = useRef<number | null>(null);

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
        const holdings = await fetchTonapiAccountHoldings(trimmed);
        if (cancelled) return;

        logPageDisplay("wallet_held_balances", {
          source: "tonapi",
          addressPreview: `${trimmed.slice(0, 8)}…${trimmed.slice(-6)}`,
          status: holdings.status,
          nativeBalance: holdings.nativeBalance,
          jettonCount: holdings.jettons.length,
          tonPriceUsd: holdings.tonPriceUsd,
        });

        const statusLc = (holdings.status ?? "").toLowerCase();
        if (
          holdings.nativeBalance >= 0.005 &&
          statusLc &&
          statusLc !== "active"
        ) {
          void requestWalletActivate({ initDataRaw: initDataRaw ?? undefined, force: true });
        }

        // Detect incoming transfer: balance increased since last poll.
        const prevBal = prevNativeBalanceRef.current;
        if (
          prevBal !== null &&
          holdings.nativeBalance > prevBal &&
          holdings.nativeBalance - prevBal >= 0.0001
        ) {
          const delta = holdings.nativeBalance - prevBal;
          const symbol = SWAP_GRAM_TOKEN.symbol;
          const deltaStr = delta.toFixed(7).replace(/\.?0+$/, "");
          const sourceId = `incoming:${Date.now()}:${deltaStr}:${symbol}:${trimmed.slice(-8)}`;
          void postWalletTopUpFeedNotification({
            initDataRaw: initDataRaw ?? undefined,
            sourceId,
            amount: deltaStr,
            symbol,
            title: t("feed.incomingTransfer.title"),
            subtitle: tf("feed.incomingTransfer.subtitle", { amount: deltaStr, symbol }),
            trailingLabel: tf("feed.incomingTransfer.trailing", { amount: deltaStr, symbol }),
          });
        }
        prevNativeBalanceRef.current = holdings.nativeBalance;

        const next: ChooseCurrencyRow[] = [];

        if (holdings.nativeBalance > 0) {
          next.push(
            buildHeldRow(
              SWAP_TON_ZERO_ADDRESS,
              SWAP_GRAM_TOKEN.name,
              SWAP_GRAM_TOKEN.symbol,
              swapTonTokenImage,
              formatNativeBalanceDisplay(holdings.nativeBalance),
              holdings.tonPriceUsd,
            ),
          );
        }

        for (const item of holdings.jettons) {
          if (!hasNonZeroRawBalance(item.balance)) continue;
          const jetton = item.jetton;
          if (jetton.symbol.trim().toUpperCase() === DLLR_SYMBOL) continue;
          const addressKey = jetton.address.toLowerCase();
          if (addressKey === SWAP_TON_ZERO_ADDRESS.toLowerCase()) continue;

          const decimals = typeof jetton.decimals === "number" ? jetton.decimals : 9;
          const symbol = jetton.symbol.trim();
          const name = (jetton.name ?? symbol).trim() || symbol;
          next.push(
            buildHeldRow(
              addressKey,
              name,
              symbol,
              jetton.image ? ({ uri: jetton.image } as const) : null,
              formatSwapJettonBalance(item.balance, decimals),
              item.priceUsd,
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
