import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { formatSwapTokenAmount } from "../../swap/swapChartFormat";
import {
  useSwapDealActionState,
  type SwapDealLeftMode,
} from "../../swap/useSwapDealActionState";
import {
  layout,
  typographyFixedRow30Label,
  typographyFixedRow40Label,
  useColors,
} from "../../theme";

const FIT_EPSILON_PX = 1;
const { textToSendIconGapPx: TEXT_TO_BUTTON_GAP_PX } = layout.bottomBar;

type Density = "compact" | "bar";

type Props = {
  /**
   * `compact` — 30px inline row under the swap form (≤2 columns).
   * `bar` — 40px bottom-bar type (3-column column footer content).
   */
  density?: Density;
  /** When set, skip the shared hook (tests / custom footers). */
  dllrAmount?: number | null;
  buySymbol?: string;
  leftMode?: SwapDealLeftMode;
  buttonActive?: boolean;
};

function useResolvedDealProps(props: Props) {
  const hooked = useSwapDealActionState();
  return {
    dllrAmount: props.dllrAmount !== undefined ? props.dllrAmount : hooked.dllrAmount,
    buySymbol: props.buySymbol ?? hooked.buySymbol,
    leftMode: props.leftMode ?? hooked.leftMode,
    buttonActive: props.buttonActive ?? hooked.buttonActive,
  };
}

/**
 * Swap deal controls: summary / Low amount on the left, Swap on the right.
 * Inactive = undercover chip + secondary labels (“Low amount” on the left).
 */
export function SwapDealActionRow({ density = "compact", ...props }: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const { dllrAmount, buySymbol, leftMode, buttonActive } = useResolvedDealProps(props);

  const isBar = density === "bar";
  const labelStyle = isBar ? typographyFixedRow40Label : typographyFixedRow30Label;
  const buttonHeight = isBar ? 40 : 30;
  const buttonPadX = 30;

  const symbol = buySymbol.trim().toLowerCase() || "gram";
  const dealShort = tf("swap.action.summary", { symbol });
  const dealFull =
    dllrAmount != null
      ? tf("swap.action.summaryWithAmount", {
          amount: formatSwapTokenAmount(dllrAmount),
          symbol,
        })
      : dealShort;
  const lowAmountLabel = t("swap.action.lowAmount");

  const fullSummaryLabel = leftMode === "lowAmount" ? lowAmountLabel : dealFull;
  const shortSummaryLabel = leftMode === "lowAmount" ? lowAmountLabel : dealShort;

  const [labelSlotWidth, setLabelSlotWidth] = useState(0);
  const [fullLabelWidth, setFullLabelWidth] = useState(0);

  const labelMeasured = labelSlotWidth > 0 && fullLabelWidth > 0;
  const canShowFullSummaryLabel =
    leftMode === "lowAmount" ||
    (labelMeasured && fullLabelWidth <= labelSlotWidth + FIT_EPSILON_PX);
  const summaryLabel = canShowFullSummaryLabel ? fullSummaryLabel : shortSummaryLabel;

  const onLabelSlotLayout = useCallback((width: number) => {
    setLabelSlotWidth((current) => (current === width ? current : width));
  }, []);

  const onFullLabelMeasureLayout = useCallback((width: number) => {
    setFullLabelWidth((current) => (current === width ? current : width));
  }, []);

  useEffect(() => {
    setFullLabelWidth(0);
  }, [fullSummaryLabel]);

  const summaryColor = buttonActive ? colors.primary : colors.secondary;
  const buttonLabelColor = buttonActive ? colors.primary : colors.secondary;

  const buttonInner = (
    <Text style={[labelStyle, { color: buttonLabelColor, textAlign: "center" }]} numberOfLines={1}>
      {t("swap.action.button")}
    </Text>
  );

  const buttonStyle = [
    styles.actionButton,
    {
      height: buttonHeight,
      paddingHorizontal: buttonPadX,
      backgroundColor: colors.undercover,
    },
  ];

  return (
    <View style={styles.wrapper}>
      <Text
        style={[labelStyle, styles.fullLabelMeasure, { color: summaryColor }]}
        onLayout={(event) => onFullLabelMeasureLayout(Math.ceil(event.nativeEvent.layout.width))}
      >
        {fullSummaryLabel}
      </Text>
      <View style={[styles.row, { height: buttonHeight }]}>
        <View
          style={styles.summaryLabelSlot}
          onLayout={(event) => onLabelSlotLayout(Math.round(event.nativeEvent.layout.width))}
        >
          <Text
            style={[labelStyle, styles.summaryLabel, { color: summaryColor }]}
            numberOfLines={1}
            accessibilityLabel={fullSummaryLabel}
          >
            {summaryLabel}
          </Text>
        </View>
        {buttonActive ? (
          <Pressable accessibilityRole="button" style={buttonStyle}>
            {buttonInner}
          </Pressable>
        ) : (
          <View
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            style={buttonStyle}
          >
            {buttonInner}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    position: "relative",
  },
  row: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: TEXT_TO_BUTTON_GAP_PX,
  },
  summaryLabelSlot: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  summaryLabel: {
    minWidth: 0,
  },
  fullLabelMeasure: {
    position: "absolute",
    opacity: 0,
    top: 0,
    left: 0,
    zIndex: -1,
    flexShrink: 0,
    ...Platform.select({
      web: {
        whiteSpace: "nowrap" as const,
        width: "max-content" as const,
        pointerEvents: "none" as const,
      },
      default: {},
    }),
  },
  actionButton: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
});
