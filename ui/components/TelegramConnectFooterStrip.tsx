import { useCallback, useId, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import {
  authenticatedHomeBottomBarDock,
  layout,
  useColors,
} from "../theme";
import { useAuth } from "../../auth/AuthContext";
import { useResolvedPathname } from "../useResolvedPathname";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import { useSettingsSheet } from "../settings/SettingsContext";
import { useBottomBarLayout } from "./BottomBarLayoutContext";
import { useTelegram } from "./Telegram";
import { useMessagesChatListSearchActiveOptional } from "../messages/MessagesChatListSearchContext";
import { SettingsIcon } from "./icons/SettingsIcon";
import { ShieldIcon } from "./icons/ShieldIcon";
import { LiquidGlassShaderUndercover } from "./LiquidGlassShaderUndercover";

const STRIP_HEIGHT_PX = 60;
const CHIP_SIZE_PX = 40;
const ICON_SIZE_PX = 20;
const SHIELD_ICON_WIDTH_PX = 20;
const SHIELD_ICON_HEIGHT_PX = 22;
const PILL_HEIGHT_PX = 40;

type Props = {
  onPowerPress?: () => void;
  onSettingsPress?: () => void;
};

function StripBackgroundGradient({
  width,
  height,
  backgroundColor,
}: {
  width: number;
  height: number;
  backgroundColor: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  if (width <= 0) return null;

  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <Stop offset="0%" stopColor={backgroundColor} stopOpacity={0} />
          <Stop offset="100%" stopColor={backgroundColor} stopOpacity={1} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} fill={`url(#${gradientId})`} />
    </Svg>
  );
}

/**
 * Floating overlay above the messages footer on narrow home when Telegram is connected:
 * shield + settings liquid-glass chips (connect lives in {@link MessagesColumnFooter}).
 */
export function TelegramConnectFooterStrip({ onPowerPress, onSettingsPress }: Props) {
  const colors = useColors();
  const pathname = useResolvedPathname();
  const { isAuthenticated } = useAuth();
  const { width: windowWidth } = useWindowDimensions();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const { openSettingsSheet } = useSettingsSheet();
  const { barHeight: bottomBarHeight, footerDockedToScreenEdge } = useBottomBarLayout();
  const { isInTelegram, layoutStartup } = useTelegram();
  const chatListSearchActive = useMessagesChatListSearchActiveOptional();
  const bottomBarDock = authenticatedHomeBottomBarDock(pathname, windowWidth, isAuthenticated);

  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;
  const stripBottomOffsetPx =
    bottomBarHeight +
    layout.bottomBar.topRuleHeightPx +
    (hideBottomBorder ? 0 : layout.bottomBar.bottomRuleHeightPx);

  const isAuthenticatedHome =
    isAuthenticated && (pathname === "/" || pathname === "" || pathname == null);
  const isNarrowHome =
    isAuthenticatedHome && bottomBarDock === "screenFooter" && windowWidth <= layout.authenticatedHome.firstBreakpoint;
  const isLightTheme = colors.primary === "#000000";
  const iconColor = colors.primary;
  const powerColor = isLightTheme ? "#000000" : "#FFFFFF";
  const [stripWidth, setStripWidth] = useState(0);

  const onStripLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.width);
    setStripWidth((current) => (current === next ? current : next));
  }, []);

  if (!isNarrowHome || !footerDockedToScreenEdge || !isTelegramMessagesConnected) {
    return null;
  }

  const handleSettingsPress = () => {
    if (onSettingsPress) {
      onSettingsPress();
    } else {
      openSettingsSheet();
    }
  };

  return (
    <View pointerEvents="box-none" style={[styles.overlayHost, { bottom: stripBottomOffsetPx }]}>
      <View onLayout={onStripLayout} style={styles.strip} pointerEvents="box-none">
        <View style={styles.blockUndercover} pointerEvents="none">
          <StripBackgroundGradient
            width={stripWidth}
            height={STRIP_HEIGHT_PX}
            backgroundColor={colors.background}
          />
        </View>

        <View style={[styles.row, { paddingHorizontal: layout.contentSideInsetPx }]}>
          {!chatListSearchActive ? (
            <Pressable accessibilityRole="button" onPress={onPowerPress} style={styles.chipPressable}>
              <LiquidGlassShaderUndercover size={CHIP_SIZE_PX} phaseOffset={0.41} isLightTheme={isLightTheme}>
                <ShieldIcon
                  powerColor={powerColor}
                  width={SHIELD_ICON_WIDTH_PX}
                  height={SHIELD_ICON_HEIGHT_PX}
                />
              </LiquidGlassShaderUndercover>
            </Pressable>
          ) : (
            <View style={styles.chipSpacer} />
          )}

          <View style={styles.centerSpacer} />

          {!chatListSearchActive ? (
            <Pressable accessibilityRole="button" onPress={handleSettingsPress} style={styles.chipPressable}>
              <LiquidGlassShaderUndercover size={CHIP_SIZE_PX} phaseOffset={0.08} isLightTheme={isLightTheme}>
                <SettingsIcon color={iconColor} size={ICON_SIZE_PX} />
              </LiquidGlassShaderUndercover>
            </Pressable>
          ) : (
            <View style={styles.chipSpacer} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlayHost: {
    position: "absolute",
    left: 0,
    right: 0,
    width: "100%",
    height: STRIP_HEIGHT_PX,
    zIndex: 999,
    elevation: 999,
  },
  strip: {
    width: "100%",
    height: STRIP_HEIGHT_PX,
    maxHeight: STRIP_HEIGHT_PX,
    position: "relative",
    justifyContent: "center",
    overflow: "hidden",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  blockUndercover: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: PILL_HEIGHT_PX,
    zIndex: 1,
  },
  centerSpacer: {
    flex: 1,
    minWidth: 0,
  },
  chipPressable: {
    width: CHIP_SIZE_PX,
    height: CHIP_SIZE_PX,
    flexShrink: 0,
  },
  chipSpacer: {
    width: CHIP_SIZE_PX,
    height: CHIP_SIZE_PX,
    flexShrink: 0,
  },
});
