import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAppStrings } from "../../locales/AppStringsContext";
import {
  buildChooseCurrencyDllrRow,
  type ChooseCurrencyRow,
} from "../components/swap/chooseCurrencyTableTypes";
import { fetchAccountSwapJettons } from "./fetchSwapJettons";
import {
  buildBalanceByJettonAddress,
  mapJettonToChooseCurrencyRow,
} from "./mapJettonToChooseCurrencyRow";
import {
  ensureSwapJettonsCatalogLoading,
  getSwapJettonsCatalogSnapshot,
  requestSwapJettonsNextPage,
  subscribeSwapJettonsCatalog,
} from "./swapJettonsCatalogCache";
import type { SwapAccountJettonBalance, SwapJetton } from "./swapJettonsTypes";

function jettonMarketCapUsd(jetton: SwapJetton): number {
  const stats = jetton.market_stats;
  const value = stats?.mcap ?? stats?.fdmc;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mergeAccountJettons(
  catalog: readonly SwapJetton[],
  accountItems: readonly SwapAccountJettonBalance[] | undefined,
): SwapJetton[] {
  const seen = new Set(catalog.map((j) => j.address.toLowerCase()));
  const extra: SwapJetton[] = [];
  for (const item of accountItems ?? []) {
    const jetton = item.jetton;
    const address = item.jetton_address?.toLowerCase();
    if (!jetton || !address || seen.has(address)) continue;
    seen.add(address);
    extra.push({ ...jetton, address: jetton.address ?? item.jetton_address });
  }
  return extra.length > 0 ? [...catalog, ...extra] : [...catalog];
}

export type ChooseCurrencyRowsState = {
  rows: readonly ChooseCurrencyRow[];
  isLoading: boolean;
  isFetchingMore: boolean;
  error: string | null;
  totalJettons: number;
  loadMore: () => void;
};

export function useChooseCurrencyRows(
  walletAddress: string | null | undefined,
  enabled = true,
): ChooseCurrencyRowsState {
  const { locale } = useAppStrings();
  const catalog = useSyncExternalStore(
    subscribeSwapJettonsCatalog,
    getSwapJettonsCatalogSnapshot,
    getSwapJettonsCatalogSnapshot,
  );

  const [balanceByAddress, setBalanceByAddress] = useState<Map<string, string>>(new Map());
  const [accountItems, setAccountItems] = useState<readonly SwapAccountJettonBalance[]>([]);
  const accountLoadIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    ensureSwapJettonsCatalogLoading();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const trimmedWallet = walletAddress?.trim() ?? "";
    if (!trimmedWallet) {
      setBalanceByAddress(new Map());
      setAccountItems([]);
      return;
    }

    const loadId = ++accountLoadIdRef.current;
    let cancelled = false;

    void fetchAccountSwapJettons(trimmedWallet)
      .then((response) => {
        if (cancelled || loadId !== accountLoadIdRef.current) return;
        setBalanceByAddress(buildBalanceByJettonAddress(response.items ?? []));
        setAccountItems(response.items ?? []);
      })
      .catch(() => {
        if (cancelled || loadId !== accountLoadIdRef.current) return;
        setBalanceByAddress(new Map());
        setAccountItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress, enabled]);

  const jettons = useMemo(
    () => mergeAccountJettons(catalog.jettons, accountItems),
    [catalog.jettons, accountItems],
  );

  const dllrRow = useMemo(() => buildChooseCurrencyDllrRow(locale), [locale]);

  const rows = useMemo(() => {
    const ranked = [...jettons].sort((a, b) => jettonMarketCapUsd(b) - jettonMarketCapUsd(a));
    const apiRows: ChooseCurrencyRow[] = [];
    for (const jetton of ranked) {
      const row = mapJettonToChooseCurrencyRow(jetton, balanceByAddress, locale);
      if (!row) continue;
      apiRows.push(row);
    }
    return [dllrRow, ...apiRows];
  }, [balanceByAddress, dllrRow, jettons, locale]);

  const loadMore = useCallback(() => {
    requestSwapJettonsNextPage();
  }, []);

  return {
    rows,
    isLoading: enabled && catalog.isLoading && rows.length <= 1,
    isFetchingMore: enabled && catalog.isFetchingMore,
    error: catalog.error,
    totalJettons: jettons.length,
    loadMore,
  };
}
