import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import {
  bottomBarLabelFitsSlot,
  bottomBarSummarySlotWidthPx,
} from "../bottomBarRowFit";
import { BottomBarHeightReporter, useBottomBarLayout } from "../BottomBarLayoutContext";
import { useTelegram } from "../Telegram";
import { layout, typographyFixedRow30Label, useColors } from "../../theme";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING, textToSendIconGapPx: TEXT_TO_BUTTON_GAP_PX } =
  layout.bottomBar;

const FOOTER_BUTTON_HEIGHT_PX = layout.bottomBar.undercoverButtonHeightPx;
const FOOTER_BUTTON_TEXT_INSET_PX = layout.bottomBar.undercoverButtonPaddingHorizontalPx;

/** Smart panel footer: deploy cost on the left, deploy action on the right. */
export function SmartColumnFooter() {
  const colors = useColors();
  const { t } = useAppStrings();
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge } = useBottomBarLayout();
  const backgroundColor = themeBgReady ? colors.background : "transparent";
  const topBorderColor = colors.highlight;
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;

  const fullDeployCostLabel = t("smart.footer.deployCost");
  const shortDeployCostLabel = t("smart.footer.deployCostShort");
  const [rowWidth, setRowWidth] = useState(0);
  const [buttonWidth, setButtonWidth] = useState(0);
  const [fullLabelWidth, setFullLabelWidth] = useState(0);

  const labelSlotWidth = useMemo(
    () =>
      bottomBarSummarySlotWidthPx({
        rowWidthPx: rowWidth,
        buttonWidthPx: buttonWidth,
        summaryTrailingGapPx: TEXT_TO_BUTTON_GAP_PX,
      }),
    [buttonWidth, rowWidth],
  );
  const canShowFullDeployCostLabel = bottomBarLabelFitsSlot(fullLabelWidth, labelSlotWidth);
  const deployCostLabel = canShowFullDeployCostLabel ? fullDeployCostLabel : shortDeployCostLabel;

  const onRowLayout = useCallback((width: number) => {
    setRowWidth((current) => (current === width ? current : width));
  }, []);

  const onButtonLayout = useCallback((width: number) => {
    setButtonWidth((current) => (current === width ? current : width));
  }, []);

  const onFullLabelMeasureLayout = useCallback((width: number) => {
    setFullLabelWidth((current) => (current === width ? current : width));
  }, []);

  useEffect(() => {
    setFullLabelWidth(0);
  }, [fullDeployCostLabel]);

  return (
    <View
      style={[
        styles.wrapper,
        {
          backgroundColor,
          borderTopWidth: 1,
          borderTopColor: topBorderColor,
          borderBottomWidth: hideBottomBorder ? 0 : 1,
          borderBottomColor: topBorderColor,
        },
      ]}
    >
      <Text
        style={[typographyFixedRow30Label, styles.fullLabelMeasure, { color: colors.primary }]}
        onLayout={(event) => onFullLabelMeasureLayout(Math.ceil(event.nativeEvent.layout.width))}
      >
        {fullDeployCostLabel}
      </Text>
      <BottomBarHeightReporter height={BAR_HEIGHT} />
      <View style={[styles.container, { height: BAR_HEIGHT, backgroundColor }]}>
        <View
          style={[styles.row, { height: BAR_HEIGHT }]}
          onLayout={(event) => onRowLayout(Math.round(event.nativeEvent.layout.width))}
        >
          <View style={styles.costLabelSlot}>
            <Text
              style={[typographyFixedRow30Label, styles.costLabel, { color: colors.primary }]}
              numberOfLines={1}
              accessibilityLabel={fullDeployCostLabel}
            >
              {deployCostLabel}
            </Text>
          </View>
          <View
            accessibilityRole="button"
            style={[styles.footerButton, { backgroundColor: colors.undercover }]}
            onLayout={(event) => onButtonLayout(Math.round(event.nativeEvent.layout.width))}
          >
            <Text style={[typographyFixedRow30Label, { color: colors.primary, textAlign: "center" }]} numberOfLines={1}>
              {t("smart.footer.deployButton")}
            </Text>
          </View>
        </View>
      </View>
      {!hideBottomBorder ? (
        <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    position: "relative",
  },
  bottomDivider: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    pointerEvents: "none",
  },
  container: {
    width: "100%",
    alignSelf: "stretch",
    paddingHorizontal: HORIZONTAL_PADDING,
  },
  row: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: TEXT_TO_BUTTON_GAP_PX,
  },
  costLabelSlot: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  costLabel: {
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
  footerButton: {
    flexShrink: 0,
    height: FOOTER_BUTTON_HEIGHT_PX,
    paddingHorizontal: FOOTER_BUTTON_TEXT_INSET_PX,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
});
