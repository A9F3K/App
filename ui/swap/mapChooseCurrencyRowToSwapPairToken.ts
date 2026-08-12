import type { ChooseCurrencyRow } from "../components/swap/chooseCurrencyTableTypes";
import { findSwapJettonByAddress } from "./swapJettonsCatalogCache";
import {
  isNativeTonToken,
  SWAP_DLLR_ROW_KEY,
  SWAP_DLLR_TOKEN,
  SWAP_GRAM_TOKEN,
  type SwapPairToken,
} from "./swapPairTypes";

/** Map a Currencies / Choose-currency row into a swap-pair token. */
export function mapChooseCurrencyRowToSwapPairToken(
  row: ChooseCurrencyRow,
): SwapPairToken {
  const ticker = row.currency.ticker.trim();
  const upper = ticker.toUpperCase();
  if (row.rowKey === SWAP_DLLR_ROW_KEY || upper === "DLLR") {
    return { ...SWAP_DLLR_TOKEN, icon: row.currency.icon ?? SWAP_DLLR_TOKEN.icon };
  }

  const jetton = findSwapJettonByAddress(row.rowKey);
  const symbol = (jetton?.symbol ?? ticker).trim() || "TOKEN";
  const name = (jetton?.name ?? row.currency.name).trim() || symbol;
  const decimals =
    typeof jetton?.decimals === "number" && Number.isFinite(jetton.decimals)
      ? jetton.decimals
      : 9;
  const imageUrl = jetton?.image_url ?? null;
  const token: SwapPairToken = {
    address: jetton?.address ?? row.rowKey,
    symbol,
    name,
    decimals,
    imageUrl,
    icon: row.currency.icon,
    isNative: false,
  };
  if (isNativeTonToken(token) || isZeroAddress(token.address)) {
    return {
      ...SWAP_GRAM_TOKEN,
      icon: row.currency.icon ?? SWAP_GRAM_TOKEN.icon,
      imageUrl: imageUrl ?? SWAP_GRAM_TOKEN.imageUrl,
    };
  }
  return token;
}

function isZeroAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  return (
    addr === "native" ||
    addr === SWAP_GRAM_TOKEN.address.toLowerCase() ||
    /^0:0+$/.test(addr)
  );
}
