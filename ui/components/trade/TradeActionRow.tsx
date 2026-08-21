import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import {
  layout,
  typographyFixedRow30Label,
  useColors,
} from "../../theme";

const FIT_EPSILON_PX = 1;
const { textToSendIconGapPx: TEXT_TO_BUTTON_GAP_PX } = layout.bottomBar;
const ACTION_BUTTON_TEXT_INSET_PX = layout.bottomBar.undercoverButtonPaddingHorizontalPx;

type Density = "compact" | "bar";

type Props = {
  density?: Density;
};

/** Trade CTA: summary left, Trade button right. */
export function TradeActionRow({ density = "compact" }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const isBar = density === "bar";
  const labelStyle = typographyFixedRow30Label;
  const buttonHeight = layout.bottomBar.undercoverButtonHeightPx;

  const fullSummaryLabel = t("trade.action.summary");
  const shortSummaryLabel = t("trade.action.summaryShort");
  const [labelSlotWidth, setLabelSlotWidth] = useState(0);
  const [fullLabelWidth, setFullLabelWidth] = useState(0);

  const labelMeasured = labelSlotWidth > 0 && fullLabelWidth > 0;
  const canShowFull =
    labelMeasured && fullLabelWidth <= labelSlotWidth + FIT_EPSILON_PX;
  const summaryLabel = canShowFull ? fullSummaryLabel : shortSummaryLabel;

  const onLabelSlotLayout = useCallback((width: number) => {
    setLabelSlotWidth((current) => (current === width ? current : width));
  }, []);

  const onFullLabelMeasureLayout = useCallback((width: number) => {
    setFullLabelWidth((current) => (current === width ? current : width));
  }, []);

  useEffect(() => {
    setFullLabelWidth(0);
  }, [fullSummaryLabel]);

  return (
    <View style={styles.wrapper}>
      <Text
        style={[labelStyle, styles.fullLabelMeasure, { color: colors.primary }]}
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
            style={[labelStyle, styles.summaryLabel, { color: colors.primary }]}
            numberOfLines={1}
            accessibilityLabel={fullSummaryLabel}
          >
            {summaryLabel}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          style={[
            styles.actionButton,
            {
              height: buttonHeight,
              paddingHorizontal: ACTION_BUTTON_TEXT_INSET_PX,
              backgroundColor: colors.undercover,
            },
          ]}
        >
          <Text style={[labelStyle, { color: colors.primary, textAlign: "center" }]} numberOfLines={1}>
            {t("trade.action.button")}
          </Text>
        </Pressable>
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
