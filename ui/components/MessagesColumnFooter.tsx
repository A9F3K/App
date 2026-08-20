import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useAppStrings } from "../../locales/AppStringsContext";
import { useMessagesChatListSearch } from "../messages/MessagesChatListSearchContext";
import { layout, typographyFixedRow40Label, useColors } from "../theme";
import { BottomBarHeightReporter, useBottomBarLayout } from "./BottomBarLayoutContext";
import { useTelegram } from "./Telegram";
import { useAuth } from "../../auth/AuthContext";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";
import { MenuHamburgerIcon } from "./icons/MenuHamburgerIcon";
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

type Props = {
  /** When false, only the menu button is shown (search hidden). */
  showSearch?: boolean;
};

function ColumnFooterChrome({ children }: { children: ReactNode }) {
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
        {children}
      </View>
      {!hideBottomBorder ? (
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
      <ColumnFooterChrome>
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
 * Left-column footer: menu chip + optional messages search field (wide), or liquid-glass menu + search (single column).
 * When Telegram is disconnected, shows Connect Telegram instead of menu/search.
 */
export function MessagesColumnFooter({ showSearch = true }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { width: windowWidth } = useWindowDimensions();
  const { sessionTelegramMessagesConnected } = useAuth();
  const { isTelegramMessagesConnected, openConnectSheet } = useTelegramMessagesConnection();
  const {
    chatListSearchQuery,
    setChatListSearchQuery,
    chatListSearchFocused,
    setChatListSearchFocused,
    dismissChatListSearch,
  } = useMessagesChatListSearch();
  const [menuOpen, setMenuOpen] = useState(false);

  const isNarrow = windowWidth <= layout.authenticatedHome.firstBreakpoint;
  const isLightTheme = colors.primary === "#000000";

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
      <LiquidGlassShaderUndercover size={LIQUID_GLASS_CHIP_PX} phaseOffset={0.41} isLightTheme={isLightTheme}>
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

  return (
    <>
      <ColumnFooterChrome>
        <View style={[styles.row, { height: BAR_HEIGHT, gap: MENU_SEARCH_GAP_PX }]}>
          {menuButton}
          {showSearch ? (
            <View style={{ flex: 1, minWidth: 0 }}>
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
