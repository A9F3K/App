import type { AppLocale } from "../../locales/appStrings";
import type { ChooseCurrencyRow } from "../components/swap/chooseCurrencyTableTypes";
import { swapTonTokenImage } from "../components/swap/swapFormAssets";
import {
  formatSwapHoldingUsd,
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
import { SWAP_TON_ZERO_ADDRESS } from "./swapPairTypes";
import type { SwapAccountJettonBalance, SwapJetton } from "./swapJettonsTypes";

const DLLR_SYMBOL = "DLLR";

function isNativeZeroAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  return (
    addr === SWAP_TON_ZERO_ADDRESS ||
    /^0:0+$/.test(addr) ||
    addr.includes("00000000000000000000000000000000000000000000000000000000")
  );
}

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
  if (isNativeZeroAddress(jetton.address ?? "")) return swapTonTokenImage;
  const upper = jetton.symbol?.trim().toUpperCase();
  if (upper === "TON" || upper === "GRAM") return swapTonTokenImage;
  if (jetton.image_url) return { uri: jetton.image_url } as const;
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
  const address = jetton.address?.toLowerCase();
  if (!address || !jetton.symbol?.trim()) return null;
  const isNative = isNativeZeroAddress(address);
  // Catalog still returns "TON" for the zero-address native; UI shows Gram.
  const symbol = isNative
    ? "GRAM"
    : normalizeJettonLabel(jetton.symbol ?? "");
  if (!symbol || symbol.toUpperCase() === DLLR_SYMBOL) return null;
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
  const name = isNative
    ? "Gram"
    : normalizeJettonLabel(jetton.name ?? "") || symbol;
  const balance =
    balanceRaw != null
      ? formatSwapJettonBalance(balanceRaw, jetton.decimals ?? 9)
      : "—";
  const priceUsd = stats?.price_usd;
  const balanceNum = Number.parseFloat(balance.replace(/,/g, ""));
  const holdingUsd =
    Number.isFinite(balanceNum) &&
    balanceNum > 0 &&
    priceUsd != null &&
    Number.isFinite(priceUsd) &&
    priceUsd > 0
      ? balanceNum * priceUsd
      : 0;

  return {
    rowKey: address,
    currency: {
      name,
      ticker: symbol,
      icon: jettonIcon(jetton),
    },
    balance,
    value: formatSwapHoldingUsd(holdingUsd),
    rate: formatSwapTokenPriceUsd(priceUsd),
    networks: "TON",
    marketCapUsd,
    marketCap: formatSwapUsdCompact(resolvedCap, locale),
    volume: formatSwapUsdCompact(stats?.volume_usd_24h, locale),
    lastYearKind: "sparkline",
  };
}
