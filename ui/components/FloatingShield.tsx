import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { layout, useColors } from "../theme";
import { useBottomBarLayout } from "./BottomBarLayoutContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { LiquidGlassShaderUndercover } from "./LiquidGlassShaderUndercover";
import { SettingsIcon } from "./icons/SettingsIcon";
import { ShieldIcon } from "./icons/ShieldIcon";
import { useAuth } from "../../auth/AuthContext";
import { useResolvedPathname } from "../useResolvedPathname";
import { useSettingsSheet } from "../settings/SettingsContext";
import { useMessagesChatListSearchActiveOptional } from "../messages/MessagesChatListSearchContext";

const AH = layout.authenticatedHome;
const FS = layout.floatingShield;

/** Space between the footer's top border and the bottom of this floating stack. */
const FOOTER_TOP_GAP_PX = 15;

/** One full turn of the settings cog inside the liquid-glass chip (linear). */
const SETTINGS_ICON_SPIN_MS = 28000;

function SlowRotatingSettingsIcon({ color, size }: { color: string; size: number }) {
  const spin = useRef(new Animated.Value(0)).current;
  /**
   * Drive rotation from wall-clock time via rAF — no `Animated.loop` / completion callbacks, so it
   * cannot stall after N iterations (RN-web and native driver edge cases).
   */
  useEffect(() => {
    const startMs = Date.now();
    let rafId = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startMs;
      const t = (elapsed % SETTINGS_ICON_SPIN_MS) / SETTINGS_ICON_SPIN_MS;
      spin.setValue(t);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [spin]);
  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "-360deg"],
  });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate }],
      }}
    >
      <SettingsIcon color={color} size={size} />
    </Animated.View>
  );
}

export function FloatingShield() {
  const { t } = useAppStrings();
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const pathname = useResolvedPathname();
  const { isAuthenticated } = useAuth();
  /** Match authenticated home: narrow / welcome-style width keeps the stack on the right; wide moves it to the left. */
  const shieldOnRight = windowWidth <= AH.firstBreakpoint;
  const { barHeight: bottomBarHeight, footerDockedToScreenEdge } = useBottomBarLayout();
  const isLightTheme = colors.primary === "#000000";
  const powerColor = isLightTheme ? "#000000" : "#FFFFFF";

  const isAuthenticatedHome =
    isAuthenticated && (pathname === "/" || pathname === "" || pathname == null);
  /** Wide authenticated home: Settings + Shield live in the messages column footer (right of search). */
  const iconsInMessagesColumnFooter = isAuthenticatedHome && !shieldOnRight;
  const { openSettingsSheet } = useSettingsSheet();
  const chatListSearchActive = useMessagesChatListSearchActiveOptional();

  // Hide while chat-list search is focused or has a query (root chrome shares the search provider).
  if (chatListSearchActive) {
    return null;
  }

  if (iconsInMessagesColumnFooter) {
    return null;
  }

  return (
    <View
      style={[
        styles.hostBase,
        shieldOnRight ? styles.hostRight : styles.hostLeft,
        {
          // Wide layouts embed footer bars inside columns; keep the floating stack above the first-column footer.
          bottom:
            (footerDockedToScreenEdge
              ? bottomBarHeight
              : shieldOnRight
                ? 0
                : layout.bottomBar.barMinHeight) + FOOTER_TOP_GAP_PX,
          // box-none: lightning/GL spill and chip corners pass through; only the circular Svg hit mask in each chip captures.
          pointerEvents: "box-none",
        },
      ]}
    >
      <View style={shieldOnRight ? styles.settingsSlotRight : styles.settingsSlotLeft}>
        <Pressable accessibilityRole="button" onPress={openSettingsSheet}>
          <LiquidGlassShaderUndercover
            size={FS.settingsDiameter}
            phaseOffset={0.08}
            isLightTheme={isLightTheme}
          >
            <SlowRotatingSettingsIcon color={colors.primary} size={styles.settingsIcon.width as number} />
          </LiquidGlassShaderUndercover>
        </Pressable>
      </View>
      <View style={shieldOnRight ? styles.shieldSlotRight : styles.shieldSlotLeft}>
        <LiquidGlassShaderUndercover
          size={FS.shieldDiameter}
          phaseOffset={0.41}
          isLightTheme={isLightTheme}
          contentAlign="top"
        >
          <View style={styles.iconWrap}>
            <ShieldIcon powerColor={powerColor} />
          </View>
          <Text style={[styles.label, { color: colors.primary }]}>{t("floating.shield.label")}</Text>
        </LiquidGlassShaderUndercover>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hostBase: {
    position: "absolute",
    zIndex: 1000,
    elevation: 1000,
    overflow: "visible",
  },
  /** At or below {@link layout.authenticatedHome.firstBreakpoint}: original right inset. */
  hostRight: {
    right: FS.edgeInsetPx,
    alignItems: "flex-end",
  },
  /** Wider than `firstBreakpoint`: mirrored inset on the left. */
  hostLeft: {
    left: FS.edgeInsetPx,
    alignItems: "flex-start",
  },
  settingsSlotRight: {
    marginBottom: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsSlotLeft: {
    marginBottom: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  shieldSlotRight: {
    marginRight: FS.shieldExtraInsetPx,
  },
  shieldSlotLeft: {
    marginLeft: FS.shieldExtraInsetPx,
  },
  settingsIcon: {
    width: 20,
    height: 20,
  },
  iconWrap: {
    marginTop: 6,
    width: 20,
    height: 22,
  },
  label: {
    marginTop: 4,
    fontSize: 10,
    lineHeight: 10,
    fontWeight: "400",
    includeFontPadding: false,
  },
});
