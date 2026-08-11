import type { AppLocale } from "../../locales/appStrings";
import type { ChooseCurrencyRow } from "../components/swap/chooseCurrencyTableTypes";
import { swapTonTokenImage } from "../components/swap/swapFormAssets";
import {
  formatSwapJettonBalance,
  formatSwapTokenPriceUsd,
  formatSwapUsdCompact,
} from "./formatSwapTokenMarketValue";
import { jettonImpersonatesKnownBrand } from "./jettonImpersonatesKnownBrand";
import { jettonUsesStolenUsdtBranding } from "./jettonStolenUsdtBranding";
import {
  jettonFailsVolumeToMcapFilter,
  resolveJettonMarketCapRankUsd,
  resolveJettonMarketCapUsd,
} from "./resolveJettonMarketCapUsd";
import type { SwapAccountJettonBalance, SwapJetton } from "./swapJettonsTypes";

const DLLR_SYMBOL = "DLLR";

export function buildBalanceByJettonAddress(
  items: readonly SwapAccountJettonBalance[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const key = item.jetton_address?.toLowerCase();
    if (key) map.set(key, item.balance);
  }
  return map;
}

function jettonIcon(jetton: SwapJetton) {
  if (jettonUsesStolenUsdtBranding(jetton)) return null;
  if (jetton.image_url) return { uri: jetton.image_url } as const;
  if (jetton.symbol?.trim().toUpperCase() === "TON") return swapTonTokenImage;
  return null;
}

function normalizeJettonLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function mapJettonToChooseCurrencyRow(
  jetton: SwapJetton,
  balanceByAddress: Map<string, string>,
  locale: AppLocale = "en",
): ChooseCurrencyRow | null {
  const symbol = normalizeJettonLabel(jetton.symbol ?? "");
  const address = jetton.address?.toLowerCase();
  if (!symbol || !address || symbol.toUpperCase() === DLLR_SYMBOL) return null;
  // Brand lookalikes (e.g. preOPENAI) — hide entirely, do not merely demote.
  if (jettonImpersonatesKnownBrand(jetton)) return null;

  const stolenUsdt = jettonUsesStolenUsdtBranding(jetton);
  // Extreme mcap/volume fantasies — hide; soft demotion handles thinner books.
  if (
    !stolenUsdt &&
    jettonFailsVolumeToMcapFilter({
      verification: jetton.verification,
      market_stats: jetton.market_stats,
    })
  ) {
    return null;
  }

  const stats = jetton.market_stats;
  const balanceRaw = balanceByAddress.get(address);
  const resolvedCap = stolenUsdt ? null : resolveJettonMarketCapUsd(jetton);
  // Sort by volume-adjusted rank (target ≈ 1% daily turnover); display stays trusted mcap.
  const marketCapUsd = stolenUsdt ? 0 : resolveJettonMarketCapRankUsd(jetton);
  const name = normalizeJettonLabel(jetton.name ?? "") || symbol;

  return {
    rowKey: address,
    currency: {
      name,
      ticker: symbol,
      icon: jettonIcon(jetton),
    },
    balance:
      balanceRaw != null
        ? formatSwapJettonBalance(balanceRaw, jetton.decimals ?? 9)
        : "—",
    rate: formatSwapTokenPriceUsd(stats?.price_usd),
    networks: "TON",
    marketCapUsd,
    marketCap: formatSwapUsdCompact(resolvedCap, locale),
    volume: formatSwapUsdCompact(stats?.volume_usd_24h, locale),
    lastYearKind: "sparkline",
  };
}
