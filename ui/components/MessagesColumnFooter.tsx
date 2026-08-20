import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useMessagesChatListSearch } from "../messages/MessagesChatListSearchContext";
import { useSettingsSheet } from "../settings/SettingsContext";
import { layout, typographyFixedRow40Label, useColors } from "../theme";
import { useBottomBarLayout } from "./BottomBarLayoutContext";
import { useTelegram } from "./Telegram";
import { useAuth } from "../../auth/AuthContext";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import { MenuHamburgerIcon } from "./icons/MenuHamburgerIcon";
import { SettingsIcon } from "./icons/SettingsIcon";
import { ShieldIcon } from "./icons/ShieldIcon";
import { TelegramLogoIcon } from "./icons/TelegramLogoIcon";
import { LiquidGlassShaderUndercover } from "./LiquidGlassShaderUndercover";
import { MessageChatListSearchField } from "./messages/MessageChatListSearchField";
import { MessagesSideMenu } from "./messages/MessagesSideMenu";
import { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX } from "./messages/messageListLayout";
import {
  measureTelegramConnectPillLabelLineWidthPx,
  TELEGRAM_CONNECT_PILL_LOGO_LEFT_PX,
  TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX,
  TELEGRAM_CONNECT_PILL_LOGO_TO_TEXT_GAP_PX,
  TELEGRAM_CONNECT_PILL_TEXT_RIGHT_PX,
  telegramConnectPillWidthFromLabelLinePx,
} from "./telegramConnectPillMeasure";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING } = layout.bottomBar;
const { maxContentWidth } = layout;
const MENU_BTN_PX = 30;
const LIQUID_GLASS_CHIP_PX = 40;
const LIQUID_GLASS_PILL_HEIGHT_PX = 40;
const MENU_SEARCH_GAP_PX = 10;
const SHIELD_ICON_WIDTH_PX = 20;
const SHIELD_ICON_HEIGHT_PX = 22;
const SETTINGS_ICON_SIZE_PX = 20;

type Props = {
  /** When false, only the menu button is shown (search hidden). */
  showSearch?: boolean;
};

/** Bottom-opaque → top-transparent background fade behind the narrow messages footer row. */
function NarrowFooterGradientUndercover({ height }: { height: number }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const rawId = useId();
  const gradientId = `msg-footer-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <View
      pointerEvents="none"
      onLayout={(event) => {
        const next = Math.ceil(event.nativeEvent.layout.width);
        setWidth((current) => (current === next ? current : next));
      }}
      style={[StyleSheet.absoluteFillObject, { height }]}
    >
      {width > 0 ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={colors.background} stopOpacity={0} />
              <Stop offset="100%" stopColor={colors.background} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={width} height={height} fill={`url(#${gradientId})`} />
        </Svg>
      ) : null}
    </View>
  );
}

function ColumnFooterChrome({
  children,
  /** Transparent chrome so liquid-glass chips overlay the chat list (narrow home). */
  overlayContent = false,
  /** Vertical fade underlay for narrow overlay footers (menu / search / shield row). */
  gradientUndercover = false,
}: {
  children: ReactNode;
  overlayContent?: boolean;
  gradientUndercover?: boolean;
}) {
  const colors = useColors();
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge } = useBottomBarLayout();
  const backgroundColor = overlayContent
    ? "transparent"
    : themeBgReady
      ? colors.background
      : "transparent";
  const topBorderColor = colors.highlight;
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;

  return (
    <View
      style={[
        styles.wrapper,
        {
          backgroundColor,
          borderTopWidth: overlayContent ? 0 : 1,
          borderTopColor: topBorderColor,
          borderBottomWidth: hideBottomBorder || overlayContent ? 0 : 1,
          borderBottomColor: topBorderColor,
        },
      ]}
      pointerEvents="box-none"
    >
      {gradientUndercover ? <NarrowFooterGradientUndercover height={BAR_HEIGHT} /> : null}
      {/* Do not report height here — GlobalBottomBar owns screen-edge barHeight. */}
      <View
        style={[
          styles.container,
          {
            height: BAR_HEIGHT,
            backgroundColor: overlayContent || gradientUndercover ? "transparent" : backgroundColor,
          },
        ]}
        pointerEvents="box-none"
      >
        {children}
      </View>
      {!hideBottomBorder && !overlayContent ? (
        <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
      ) : null}
    </View>
  );
}

function ConnectTelegramFooterButton({
  label,
  onPress,
  narrow,
}: {
  label: string;
  onPress: () => void;
  narrow: boolean;
}) {
  const colors = useColors();
  const isLightTheme = colors.primary === "#000000";
  const [rowWidth, setRowWidth] = useState(0);
  const [nativeLabelLineWidth, setNativeLabelLineWidth] = useState(0);

  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.width);
    setRowWidth((current) => (current === next ? current : next));
  }, []);

  const onNativeLabelTextLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    const lineWidth = Math.ceil(event.nativeEvent.lines[0]?.width ?? 0);
    setNativeLabelLineWidth((current) => (current === lineWidth ? current : lineWidth));
  }, []);

  useEffect(() => {
    setNativeLabelLineWidth(0);
  }, [label]);

  const webLabelLineWidth = useMemo(
    () => (Platform.OS === "web" ? measureTelegramConnectPillLabelLineWidthPx(label) : 0),
    [label],
  );

  const labelLineWidth = Platform.OS === "web" ? webLabelLineWidth : nativeLabelLineWidth;
  const maxPillWidthPx = Math.max(0, rowWidth);
  const pillWidth = useMemo(() => {
    if (!label || rowWidth <= 0 || labelLineWidth <= 0) return 0;
    return telegramConnectPillWidthFromLabelLinePx(labelLineWidth, maxPillWidthPx);
  }, [label, rowWidth, labelLineWidth, maxPillWidthPx]);

  if (narrow) {
    return (
      <ColumnFooterChrome overlayContent gradientUndercover>
        {Platform.OS !== "web" ? (
          <Text
            key={label}
            style={[typographyFixedRow40Label, styles.pillLabelMeasure]}
            numberOfLines={1}
            onTextLayout={onNativeLabelTextLayout}
          >
            {label}
          </Text>
        ) : null}
        <View onLayout={onRowLayout} style={[styles.row, { height: BAR_HEIGHT, justifyContent: "center" }]}>
          {pillWidth > 0 ? (
            <Pressable accessibilityRole="button" onPress={onPress} style={styles.connectPillPressable}>
              <LiquidGlassShaderUndercover
                key={`${label}-${pillWidth}`}
                shape="pill"
                width={pillWidth}
                height={LIQUID_GLASS_PILL_HEIGHT_PX}
                contentInsetPx={0}
                phaseOffset={0.22}
                isLightTheme={isLightTheme}
                capturePointerEvents={false}
              >
                <View style={[styles.connectPillContent, { width: pillWidth }]}>
                  <View style={styles.connectPillLogo}>
                    <TelegramLogoIcon size={TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX} />
                  </View>
                  <Text
                    style={[typographyFixedRow40Label, styles.connectPillLabel, { color: colors.primary }]}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </View>
              </LiquidGlassShaderUndercover>
            </Pressable>
          ) : null}
        </View>
      </ColumnFooterChrome>
    );
  }

  return (
    <ColumnFooterChrome>
      <View style={[styles.row, { height: BAR_HEIGHT, justifyContent: "center" }]}>
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={[styles.wideConnectButton, { backgroundColor: colors.undercover }]}
        >
          <Text style={[typographyFixedRow40Label, { color: colors.primary }]} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      </View>
    </ColumnFooterChrome>
  );
}

/**
 * Left-column footer: Menu + Search (+ Settings + Shield).
 * Narrow: liquid-glass chips with gradient underlay. Wide: undercover circles for settings/shield.
 */
export function MessagesColumnFooter({ showSearch = true }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { width: windowWidth } = useWindowDimensions();
  const { sessionTelegramMessagesConnected } = useAuth();
  const { isTelegramMessagesConnected, openConnectSheet } = useTelegramMessagesConnection();
  const { openSettingsSheet } = useSettingsSheet();
  const {
    chatListSearchQuery,
    setChatListSearchQuery,
    chatListSearchFocused,
    setChatListSearchFocused,
    dismissChatListSearch,
    listSearchActive,
  } = useMessagesChatListSearch();
  const [menuOpen, setMenuOpen] = useState(false);

  const isNarrow = windowWidth <= layout.authenticatedHome.firstBreakpoint;
  const isLightTheme = colors.primary === "#000000";
  const powerColor = isLightTheme ? "#000000" : "#FFFFFF";
  const searchExpanded = isNarrow && listSearchActive;

  if (!isTelegramMessagesConnected && sessionTelegramMessagesConnected !== true) {
    return (
      <ConnectTelegramFooterButton
        narrow={isNarrow}
        label={t("home.mainColumnFooter.telegramMessages")}
        onPress={openConnectSheet}
      />
    );
  }

  const menuButton = isNarrow ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("messages.sideMenu.openMenu")}
      onPress={() => setMenuOpen(true)}
      style={styles.liquidGlassChipPressable}
    >
      <LiquidGlassShaderUndercover
        size={LIQUID_GLASS_CHIP_PX}
        phaseOffset={0.41}
        isLightTheme={isLightTheme}
        capturePointerEvents={false}
      >
        <MenuHamburgerIcon color={colors.secondary} size={13} />
      </LiquidGlassShaderUndercover>
    </Pressable>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("messages.sideMenu.openMenu")}
      onPress={() => setMenuOpen(true)}
      style={({ pressed }) => ({
        width: MENU_BTN_PX,
        height: MENU_BTN_PX,
        backgroundColor: colors.undercover,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.75 : 1,
        flexShrink: 0,
      })}
    >
      <MenuHamburgerIcon color={colors.secondary} size={13} />
    </Pressable>
  );

  const settingsButtonNarrow = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("settings.sheetTitle")}
      onPress={openSettingsSheet}
      style={styles.liquidGlassChipPressable}
    >
      <LiquidGlassShaderUndercover
        size={LIQUID_GLASS_CHIP_PX}
        phaseOffset={0.08}
        isLightTheme={isLightTheme}
        capturePointerEvents={false}
      >
        <SettingsIcon color={colors.primary} size={SETTINGS_ICON_SIZE_PX} />
      </LiquidGlassShaderUndercover>
    </Pressable>
  );

  const shieldChipNarrow = (
    <View style={styles.liquidGlassChipPressable} pointerEvents="none">
      <LiquidGlassShaderUndercover
        size={LIQUID_GLASS_CHIP_PX}
        phaseOffset={0.41}
        isLightTheme={isLightTheme}
        capturePointerEvents={false}
      >
        <ShieldIcon
          powerColor={powerColor}
          width={SHIELD_ICON_WIDTH_PX}
          height={SHIELD_ICON_HEIGHT_PX}
        />
      </LiquidGlassShaderUndercover>
    </View>
  );

  const settingsButtonWide = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("settings.sheetTitle")}
      onPress={openSettingsSheet}
      style={({ pressed }) => [
        styles.wideCircleChip,
        { backgroundColor: colors.undercover, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <SettingsIcon color={colors.primary} size={SETTINGS_ICON_SIZE_PX} />
    </Pressable>
  );

  const shieldChipWide = (
    <View style={[styles.wideCircleChip, { backgroundColor: colors.undercover }]} pointerEvents="none">
      <ShieldIcon
        powerColor={powerColor}
        width={SHIELD_ICON_WIDTH_PX}
        height={SHIELD_ICON_HEIGHT_PX}
      />
    </View>
  );

  const searchField = showSearch ? (
    <View style={{ flex: 1, minWidth: isNarrow ? 72 : 0 }}>
      <MessageChatListSearchField
        value={chatListSearchQuery}
        onChangeText={setChatListSearchQuery}
        onFocus={() => setChatListSearchFocused(true)}
        onBlur={() => setChatListSearchFocused(false)}
        onDismiss={dismissChatListSearch}
        showClear={chatListSearchFocused || chatListSearchQuery.trim().length > 0}
        placeholder={t("messages.search.placeholder")}
        clearAccessibilityLabel={t("messages.search.clear")}
        marginBottomPx={0}
        variant={isNarrow ? "liquidGlass" : "undercover"}
        isLightTheme={isLightTheme}
      />
    </View>
  ) : (
    <View style={{ flex: 1, minWidth: 0 }} />
  );

  return (
    <>
      <ColumnFooterChrome overlayContent={isNarrow} gradientUndercover={isNarrow}>
        <View style={[styles.row, { height: BAR_HEIGHT, gap: MENU_SEARCH_GAP_PX }]}>
          {isNarrow ? (
            searchExpanded ? (
              searchField
            ) : (
              <>
                {menuButton}
                {settingsButtonNarrow}
                {shieldChipNarrow}
                {searchField}
              </>
            )
          ) : (
            <>
              {menuButton}
              {searchField}
              {settingsButtonWide}
              {shieldChipWide}
            </>
          )}
        </View>
      </ColumnFooterChrome>
      <MessagesSideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
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
    maxWidth: maxContentWidth,
    alignSelf: "center",
    paddingHorizontal: HORIZONTAL_PADDING,
  },
  row: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
  },
  liquidGlassChipPressable: {
    width: LIQUID_GLASS_CHIP_PX,
    height: LIQUID_GLASS_CHIP_PX,
    flexShrink: 0,
  },
  wideCircleChip: {
    width: MENU_BTN_PX,
    height: MENU_BTN_PX,
    borderRadius: MENU_BTN_PX / 2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  },
  connectPillPressable: {
    height: LIQUID_GLASS_PILL_HEIGHT_PX,
    minHeight: LIQUID_GLASS_PILL_HEIGHT_PX,
    flexShrink: 0,
  },
  connectPillContent: {
    flexDirection: "row",
    alignItems: "center",
    height: LIQUID_GLASS_PILL_HEIGHT_PX,
    minHeight: LIQUID_GLASS_PILL_HEIGHT_PX,
    paddingLeft: TELEGRAM_CONNECT_PILL_LOGO_LEFT_PX,
    paddingRight: TELEGRAM_CONNECT_PILL_TEXT_RIGHT_PX,
    gap: TELEGRAM_CONNECT_PILL_LOGO_TO_TEXT_GAP_PX,
  },
  connectPillLogo: {
    width: TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX,
    height: TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX,
    flexShrink: 0,
  },
  connectPillLabel: {
    flexShrink: 1,
    minWidth: 0,
  },
  pillLabelMeasure: {
    position: "absolute",
    opacity: 0,
    top: -10_000,
    left: 0,
    pointerEvents: "none",
    flexShrink: 0,
  },
  wideConnectButton: {
    alignSelf: "center",
    height: LIQUID_GLASS_PILL_HEIGHT_PX,
    paddingHorizontal: 30,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
});

export { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX, MENU_BTN_PX, MENU_SEARCH_GAP_PX };
