import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useMessagesChatListSearch } from "../messages/MessagesChatListSearchContext";
import { layout, useColors } from "../theme";
import { BottomBarHeightReporter, useBottomBarLayout } from "./BottomBarLayoutContext";
import { useTelegram } from "./Telegram";
import { MenuHamburgerIcon } from "./icons/MenuHamburgerIcon";
import { MessageChatListSearchField } from "./messages/MessageChatListSearchField";
import { MessagesSideMenu } from "./messages/MessagesSideMenu";
import { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX } from "./messages/messageListLayout";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING } = layout.bottomBar;
const { maxContentWidth } = layout;
const MENU_BTN_PX = 30;
const MENU_SEARCH_GAP_PX = 10;

type Props = {
  /** When false, only the menu button is shown (search hidden). */
  showSearch?: boolean;
};

/**
 * Left-column footer: 30×30 menu chip + optional messages search field.
 * Replaces the former Telegram disconnect footer button.
 */
export function MessagesColumnFooter({ showSearch = true }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge } = useBottomBarLayout();
  const {
    chatListSearchQuery,
    setChatListSearchQuery,
    chatListSearchFocused,
    setChatListSearchFocused,
    dismissChatListSearch,
  } = useMessagesChatListSearch();
  const [menuOpen, setMenuOpen] = useState(false);

  const backgroundColor = themeBgReady ? colors.background : "transparent";
  const topBorderColor = colors.highlight;
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;

  return (
    <>
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
          <View style={[styles.row, { height: BAR_HEIGHT, gap: MENU_SEARCH_GAP_PX }]}>
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
                />
              </View>
            ) : (
              <View style={{ flex: 1, minWidth: 0 }} />
            )}
          </View>
        </View>
        {!hideBottomBorder ? (
          <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
        ) : null}
      </View>
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
});

export { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX, MENU_BTN_PX, MENU_SEARCH_GAP_PX };
