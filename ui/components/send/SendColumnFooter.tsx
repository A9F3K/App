import { StyleSheet, View } from "react-native";

import { SendActionRow } from "./SendActionRow";
import { BottomBarHeightReporter, useBottomBarLayout } from "../BottomBarLayoutContext";
import { useTelegram } from "../Telegram";
import { layout, useColors } from "../../theme";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING } = layout.bottomBar;

/** Triple-column Send footer: summary + Send button (swap-style). */
export function SendColumnFooter() {
  const colors = useColors();
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
          <SendActionRow density="bar" />
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
    justifyContent: "center",
  },
});
