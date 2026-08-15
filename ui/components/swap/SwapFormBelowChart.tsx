import { Image } from "expo-image";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { SWAP_BUY_AMOUNT_TON } from "../../swap/fetchSwapAmount";
import { formatSwapPrice, formatSwapTokenAmount } from "../../swap/swapChartFormat";
import { navigateToSwapCurrencyPicker } from "../../swap/navigateToSwapCurrencyPicker";
import { rotateSwapPair, useSwapPairState } from "../../swap/swapPairStore";
import {
  swapTokenDisplaySymbol,
  swapUnitAmountSide,
} from "../../swap/swapPairTypes";
import { layout, typographyAeroport15, typographyAeroport20, useColors } from "../../theme";
import { useResolvedPathname } from "../../useResolvedPathname";
import { SmartGradientDivider } from "../smart/SmartGradientDivider";
import { SwapActionRow } from "./SwapActionRow";
import { SwapRotateIcon, SwapSelectChevron } from "./SwapFormIcons";
import { SwapSampleTokenStrip } from "./SwapSampleTokenStrip";
import { swapDllrTokenImage, swapTonTokenImage } from "./swapFormAssets";

const SWAP_MUTED = "#818181";
const SECTION_GAP_PX = 15;

const amountTextStyle = [typographyAeroport20, { fontWeight: "500" as const }];
const muted15 = [typographyAeroport15, { color: SWAP_MUTED }];

type Props = {
  effectivePriceUsd: number | null;
  /** @deprecated Use {@link effectivePriceUsd}. */
  effectiveTonPriceUsd?: number | null;
};

function tokenIconSource(token: {
  icon?: unknown;
  imageUrl?: string | null;
  symbol: string;
}) {
  if (token.icon) return token.icon as never;
  if (token.imageUrl) return { uri: token.imageUrl };
  const upper = token.symbol.trim().toUpperCase();
  if (upper === "DLLR") return swapDllrTokenImage;
  if (upper === "TON" || upper === "GRAM") return swapTonTokenImage;
  return null;
}

/**
 * Sell / max·rotate·wallet / Buy / insufficient-amount blocks below the chart (prev-main).
 */
export function SwapFormBelowChart({
  effectivePriceUsd,
  effectiveTonPriceUsd,
}: Props) {
  const priceUsd = effectivePriceUsd ?? effectiveTonPriceUsd ?? null;
  const colors = useColors();
  const router = useRouter();
  const pathname = useResolvedPathname();
  const { width: windowWidth } = useWindowDimensions();
  const { sellToken, buyToken } = useSwapPairState();
  const showSwapActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  // whatswap-style: keep "1" on the chart asset side; priced DLLR amount on the other.
  const unitSide = swapUnitAmountSide(sellToken, buyToken);
  const pricedAmount =
    priceUsd != null ? priceUsd * SWAP_BUY_AMOUNT_TON : null;

  const openBuyCurrency = () =>
    navigateToSwapCurrencyPicker(router, "buy", windowWidth, pathname);
  const openSellCurrency = () =>
    navigateToSwapCurrencyPicker(router, "sell", windowWidth, pathname);

  const unitAmountText = formatSwapTokenAmount(SWAP_BUY_AMOUNT_TON);
  const pricedAmountText =
    pricedAmount != null ? formatSwapTokenAmount(pricedAmount) : "…";
  const sellAmountText = unitSide === "sell" ? unitAmountText : pricedAmountText;
  const buyAmountText = unitSide === "buy" ? unitAmountText : pricedAmountText;
  // Both sides of a DLLR pair share ~the same USD notional (asset unit × chart price).
  const pairUsdText =
    priceUsd != null ? `${formatSwapPrice(priceUsd)}$` : "…";
  const sellPriceText = pairUsdText;
  const buyPriceText = pairUsdText;

  const sellIcon = tokenIconSource(sellToken);
  const buyIcon = tokenIconSource(buyToken);
  const sellLabel = swapTokenDisplaySymbol(sellToken).toLowerCase();
  const buyLabel = swapTokenDisplaySymbol(buyToken).toLowerCase();
  const buyNetworkLabel = swapTokenDisplaySymbol(buyToken);

  return (
    <View style={{ width: "100%", alignSelf: "stretch" }}>
      <View style={{ paddingTop: 20 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={[typographyAeroport20, { color: colors.primary }]}>Sell</Text>
          <SwapSampleTokenStrip onPress={openSellCurrency} />
        </View>
        <View style={{ height: 15 }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={[amountTextStyle, { color: colors.primary }]}>{sellAmountText}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={openSellCurrency}
            style={{ flexDirection: "row", alignItems: "center" }}
          >
            {sellIcon ? (
              <Image source={sellIcon} style={{ width: 20, height: 20 }} contentFit="contain" />
            ) : (
              <View style={{ width: 20, height: 20, backgroundColor: colors.secondary }} />
            )}
            <View style={{ width: 8 }} />
            <Text style={[amountTextStyle, { color: colors.primary }]}>{sellLabel}</Text>
            <View style={{ width: 8 }} />
            <SwapSelectChevron />
          </Pressable>
        </View>
        <View style={{ height: 15 }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={muted15}>{sellPriceText}</Text>
          <Text style={muted15}>{buyNetworkLabel}</Text>
        </View>
      </View>

      <View style={{ height: 10 }} />

      <View style={{ paddingVertical: 10 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={muted15}>max.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Swap sell and buy currencies"
            hitSlop={8}
            onPress={rotateSwapPair}
          >
            <SwapRotateIcon />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center" }}
          >
            <Text style={muted15}>Sendal Rodriges</Text>
            <View style={{ width: 5 }} />
            <Text style={muted15}>1$</Text>
            <View style={{ width: 5 }} />
            <SwapSelectChevron />
          </Pressable>
        </View>
      </View>

      <View style={{ paddingTop: 15, paddingBottom: 15 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={[typographyAeroport20, { color: colors.primary }]}>Buy</Text>
          <SwapSampleTokenStrip onPress={openBuyCurrency} />
        </View>
        <View style={{ height: 15 }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={[amountTextStyle, { color: colors.primary }]}>{buyAmountText}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={openBuyCurrency}
            style={{ flexDirection: "row", alignItems: "center" }}
          >
            {buyIcon ? (
              <Image source={buyIcon} style={{ width: 20, height: 20 }} contentFit="contain" />
            ) : (
              <View style={{ width: 20, height: 20, backgroundColor: colors.secondary }} />
            )}
            <View style={{ width: 8 }} />
            <Text style={[amountTextStyle, { color: colors.primary }]}>{buyLabel}</Text>
            <View style={{ width: 8 }} />
            <SwapSelectChevron />
          </Pressable>
        </View>
        <View style={{ height: 15 }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={muted15}>{buyPriceText}</Text>
          <Text style={muted15}>{buyNetworkLabel}</Text>
        </View>
      </View>

      {showSwapActionBlock ? (
        <>
          <View style={{ height: SECTION_GAP_PX }} />
          <SmartGradientDivider />
          <View style={{ height: SECTION_GAP_PX }} />
          <SwapActionRow />
          <View style={{ height: SECTION_GAP_PX }} />
        </>
      ) : null}
    </View>
  );
}
