import { Platform, Pressable, Text, View } from "react-native";
import {
  SWAP_INTERVAL_TO_RESOLUTION,
  SWAP_INTERVAL_UI_ORDER,
  type SwapIntervalKey,
} from "../swap/swapChartConstants";
import { formatSwapPrice, resolutionLabel } from "../swap/swapChartFormat";
import { typographyAeroport15, typographyAeroport20, useColors } from "../theme";

/** Width of the centered interval letter group (d h q m spaced inside). */
const INTERVAL_GROUP_WIDTH_PX = Platform.OS === "web" ? 72 : 56;

type Props = {
  intervalKey: SwapIntervalKey;
  onIntervalKeyChange: (key: SwapIntervalKey) => void;
  priceUsd: number | null;
  /** Asset ticker shown in the rate title (e.g. GRAM, NOT). */
  assetSymbol: string;
};

/**
 * Single swap summary row: asset label · interval letters (row-centered) · price.
 */
export function SwapRateRow({
  intervalKey,
  onIntervalKeyChange,
  priceUsd,
  assetSymbol,
}: Props) {
  const colors = useColors();
  const resolution = SWAP_INTERVAL_TO_RESOLUTION[intervalKey];
  const symbol = assetSymbol.trim().toUpperCase() || "TOKEN";
  const title = `${symbol} ${resolutionLabel(resolution)}`;
  const priceText = priceUsd != null ? `${formatSwapPrice(priceUsd)}$` : "…$";

  return (
    <View
      style={{
        width: "100%",
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "center",
        position: "relative",
      }}
    >
      <View style={{ flex: 1, alignItems: "flex-start", minWidth: 0, paddingRight: 8 }}>
        <Text style={[typographyAeroport20, { color: colors.primary }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: "flex-end", minWidth: 0, paddingLeft: 8 }}>
        <Text style={[typographyAeroport15, { color: colors.primary }]} numberOfLines={1}>
          {priceText}
        </Text>
      </View>
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            width: INTERVAL_GROUP_WIDTH_PX,
          }}
        >
          {SWAP_INTERVAL_UI_ORDER.map((letter) => {
            const isActive = letter === intervalKey;
            return (
              <Pressable
                key={letter}
                onPress={() => onIntervalKeyChange(letter)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={letter}
                hitSlop={6}
              >
                <Text
                  style={[
                    typographyAeroport15,
                    { color: isActive ? colors.primary : colors.secondary },
                  ]}
                >
                  {letter}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
