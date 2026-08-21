import { StyleSheet, Text, View } from "react-native";

import { BottomBarHeightReporter, useBottomBarLayout } from "../BottomBarLayoutContext";
import { useTelegram } from "../Telegram";
import { layout, typographyFixedRow40Label, useColors } from "../../theme";
import { useGetActionSummary } from "./useGetActionSummary";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING } = layout.bottomBar;

/** Triple-column Get footer: centered transfer summary (no button). */
export function GetColumnFooter() {
  const colors = useColors();
  const summary = useGetActionSummary();
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge } = useBottomBarLayout();

  const backgroundColor = themeBgReady ? colors.background : "transparent";
  const topBorderColor = colors.highlight;
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;

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
      <BottomBarHeightReporter height={BAR_HEIGHT} />
      <View style={[styles.container, { height: BAR_HEIGHT, backgroundColor }]}>
        <View style={[styles.row, { height: BAR_HEIGHT }]}>
          <Text
            style={[typographyFixedRow40Label, { color: colors.primary, textAlign: "center" }]}
            numberOfLines={1}
          >
            {summary}
          </Text>
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
    justifyContent: "center",
  },
  row: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});
