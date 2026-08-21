import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { formatSwapTokenAmount } from "../../swap/swapChartFormat";
import {
  useSwapDealActionState,
  type SwapDealButtonNotice,
} from "../../swap/useSwapDealActionState";
import {
  layout,
  typographyFixedRow30Label,
  useColors,
} from "../../theme";

const FIT_EPSILON_PX = 1;
const { textToSendIconGapPx: TEXT_TO_BUTTON_GAP_PX } = layout.bottomBar;
/** Small indent between the button notice and the Swap button. */
const NOTICE_TO_BUTTON_GAP_PX = 8;

type Density = "compact" | "bar";

type Props = {
  /**
   * `compact` — 30px inline row under the swap form (≤2 columns).
   * `bar` — bottom-bar footer content (3-column layout).
   */
  density?: Density;
  /** When set, skip the shared hook (tests / custom footers). */
  dllrAmount?: number | null;
  buySymbol?: string;
  buttonNotice?: SwapDealButtonNotice;
  buttonActive?: boolean;
};

function useResolvedDealProps(props: Props) {
  const hooked = useSwapDealActionState();
  return {
    dllrAmount: props.dllrAmount !== undefined ? props.dllrAmount : hooked.dllrAmount,
    buySymbol: props.buySymbol ?? hooked.buySymbol,
    dealSide: hooked.dealSide,
    buttonNotice: props.buttonNotice ?? hooked.buttonNotice,
    buttonActive: props.buttonActive ?? hooked.buttonActive,
  };
}

/**
 * Swap deal controls:
 * - Far left: Buy 1 {symbol} for {amount} dllr (Gram offer on Currencies screens)
 * - Just left of Swap (small indent): “DLLR Frozen” / “No pool” / “No amount” / “Low amount”
 * - Far right: Swap (inactive undercover when not actionable)
 *
 * Prefer the full notice (e.g. “DLLR заморожен”) whenever short deal + notice + button fit the row.
 * The deal summary then uses leftover width for full vs short.
 */
export function SwapDealActionRow({ density = "compact", ...props }: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const { dllrAmount, buySymbol, dealSide, buttonNotice, buttonActive } =
    useResolvedDealProps(props);

  const labelStyle = typographyFixedRow30Label;
  const buttonHeight = layout.bottomBar.undercoverButtonHeightPx;
  const buttonPadX = layout.bottomBar.undercoverButtonPaddingHorizontalPx;

  const symbol = buySymbol.trim().toLowerCase() || "gram";
  const summaryKey =
    dealSide === "sell" ? "swap.action.summarySell" : "swap.action.summary";
  const summaryWithAmountKey =
    dealSide === "sell"
      ? "swap.action.summarySellWithAmount"
      : "swap.action.summaryWithAmount";
  const dealShort = tf(summaryKey, { symbol });
  const dealFull =
    dllrAmount != null
      ? tf(summaryWithAmountKey, {
          amount: formatSwapTokenAmount(dllrAmount),
          symbol,
        })
      : dealShort;

  const noticeFull =
    buttonNotice === "dllrFrozen"
      ? t("swap.action.dllrFrozen")
      : buttonNotice === "noPool"
        ? t("swap.action.noPool")
        : buttonNotice === "noAmount"
          ? t("swap.action.noAmount")
          : buttonNotice === "lowAmount"
            ? t("swap.action.lowAmount")
            : null;
  const noticeShort =
    buttonNotice === "dllrFrozen"
      ? t("swap.action.dllrFrozenShort")
      : noticeFull;
  const hasNotice = noticeFull != null;

  const [rowWidth, setRowWidth] = useState(0);
  const [buttonWidth, setButtonWidth] = useState(0);
  const [shortDealWidth, setShortDealWidth] = useState(0);
  const [labelSlotWidth, setLabelSlotWidth] = useState(0);
  const [fullLabelWidth, setFullLabelWidth] = useState(0);
  const [fullNoticeWidth, setFullNoticeWidth] = useState(0);

  // Prefer full notice when short deal + notice + button fit; do not size the notice
  // slot from the short label (that chicken-egg always forced “Заморожен”).
  const noticeFitReady =
    hasNotice &&
    rowWidth > 0 &&
    buttonWidth > 0 &&
    shortDealWidth > 0 &&
    fullNoticeWidth > 0;
  const canShowFullNotice =
    !hasNotice ||
    !noticeFitReady ||
    shortDealWidth + fullNoticeWidth + NOTICE_TO_BUTTON_GAP_PX + buttonWidth <=
      rowWidth + FIT_EPSILON_PX;
  const noticeLabel = hasNotice
    ? canShowFullNotice
      ? noticeFull
      : noticeShort
    : null;

  const labelMeasured = labelSlotWidth > 0 && fullLabelWidth > 0;
  const canShowFullDealLabel =
    labelMeasured && fullLabelWidth <= labelSlotWidth + FIT_EPSILON_PX;
  const dealLabel = canShowFullDealLabel ? dealFull : dealShort;

  const onRowLayout = useCallback((width: number) => {
    setRowWidth((current) => (current === width ? current : width));
  }, []);

  const onButtonLayout = useCallback((width: number) => {
    setButtonWidth((current) => (current === width ? current : width));
  }, []);

  const onShortDealMeasureLayout = useCallback((width: number) => {
    setShortDealWidth((current) => (current === width ? current : width));
  }, []);

  const onLabelSlotLayout = useCallback((width: number) => {
    setLabelSlotWidth((current) => (current === width ? current : width));
  }, []);

  const onFullLabelMeasureLayout = useCallback((width: number) => {
    setFullLabelWidth((current) => (current === width ? current : width));
  }, []);

  const onFullNoticeMeasureLayout = useCallback((width: number) => {
    setFullNoticeWidth((current) => (current === width ? current : width));
  }, []);

  useEffect(() => {
    setFullLabelWidth(0);
  }, [dealFull]);

  useEffect(() => {
    setShortDealWidth(0);
  }, [dealShort]);

  useEffect(() => {
    setFullNoticeWidth(0);
  }, [noticeFull]);

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
        style={[labelStyle, styles.fullLabelMeasure, { color: colors.primary }]}
        onLayout={(event) => onFullLabelMeasureLayout(Math.ceil(event.nativeEvent.layout.width))}
      >
        {dealFull}
      </Text>
      <Text
        style={[labelStyle, styles.fullLabelMeasure, { color: colors.primary, top: 24 }]}
        onLayout={(event) => onShortDealMeasureLayout(Math.ceil(event.nativeEvent.layout.width))}
      >
        {dealShort}
      </Text>
      {noticeFull ? (
        <Text
          style={[labelStyle, styles.fullLabelMeasure, { color: colors.secondary, top: 48 }]}
          onLayout={(event) => onFullNoticeMeasureLayout(Math.ceil(event.nativeEvent.layout.width))}
        >
          {noticeFull}
        </Text>
      ) : null}
      <View
        style={[styles.row, { height: buttonHeight }]}
        onLayout={(event) => onRowLayout(Math.round(event.nativeEvent.layout.width))}
      >
        <View
          style={styles.summaryLabelSlot}
          onLayout={(event) => onLabelSlotLayout(Math.round(event.nativeEvent.layout.width))}
        >
          <Text
            style={[labelStyle, styles.summaryLabel, { color: colors.primary }]}
            numberOfLines={1}
            accessibilityLabel={dealFull}
          >
            {dealLabel}
          </Text>
        </View>
        {hasNotice && noticeLabel ? (
          <View style={styles.noticeLabelSlot}>
            <Text
              style={[
                labelStyle,
                styles.noticeLabel,
                { color: colors.secondary, marginRight: NOTICE_TO_BUTTON_GAP_PX },
              ]}
              numberOfLines={1}
              accessibilityLabel={noticeFull ?? undefined}
            >
              {noticeLabel}
            </Text>
          </View>
        ) : null}
        {buttonActive ? (
          <Pressable
            accessibilityRole="button"
            style={[buttonStyle, { marginLeft: hasNotice ? 0 : TEXT_TO_BUTTON_GAP_PX }]}
            onLayout={(event) => onButtonLayout(Math.round(event.nativeEvent.layout.width))}
          >
            {buttonInner}
          </Pressable>
        ) : (
          <View
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            style={[buttonStyle, { marginLeft: hasNotice ? 0 : TEXT_TO_BUTTON_GAP_PX }]}
            onLayout={(event) => onButtonLayout(Math.round(event.nativeEvent.layout.width))}
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
  },
  summaryLabelSlot: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  summaryLabel: {
    minWidth: 0,
  },
  noticeLabelSlot: {
    flexShrink: 0,
  },
  noticeLabel: {
    flexShrink: 0,
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
