import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { BottomBarHeightReporter, useBottomBarLayout } from "./BottomBarLayoutContext";
import { useTelegram } from "./Telegram";
import { layout, typographyFixedRow30Label, useColors } from "../theme";
import { useTelegramMessagesConnection } from "../telegram/TelegramMessagesConnectionContext";

const { barMinHeight: BAR_HEIGHT, horizontalPadding: HORIZONTAL_PADDING } = layout.bottomBar;
const { maxContentWidth } = layout;

const FOOTER_BUTTON_HEIGHT_PX = layout.bottomBar.undercoverButtonHeightPx;
/** Horizontal inset from label to button edge (both sides). */
const FOOTER_BUTTON_TEXT_INSET_PX = layout.bottomBar.undercoverButtonPaddingHorizontalPx;

type Props = {
  label: string;
  /** Active footer actions use primary label color; inactive use secondary. */
  active?: boolean;
  onPress?: () => void;
};

/**
 * Column / screen footer chrome matching {@link GlobalBottomBar} (top rule, min height, insets),
 * with a single centered inactive welcome-style button.
 */
export function InactiveWelcomeColumnFooter({ label, active = false, onPress }: Props) {
  const colors = useColors();
  const labelColor = active ? colors.primary : colors.secondary;
  const { themeBgReady, isInTelegram, layoutStartup } = useTelegram();
  const { footerDockedToScreenEdge } = useBottomBarLayout();
  const backgroundColor = themeBgReady ? colors.background : "transparent";
  const topBorderColor = colors.highlight;
  const hideBottomBorder =
    (isInTelegram && !layoutStartup.isTelegramMiniAppDesktop) || !footerDockedToScreenEdge;

  const buttonInner = (
    <Text style={[typographyFixedRow30Label, { color: labelColor, textAlign: "center" }]} numberOfLines={1}>
      {label}
    </Text>
  );

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
          {onPress ? (
            <Pressable
              accessibilityRole="button"
              onPress={onPress}
              style={[styles.footerButton, { backgroundColor: colors.undercover }]}
            >
              {buttonInner}
            </Pressable>
          ) : (
            <View
              accessibilityRole="button"
              accessibilityState={{ disabled: !active }}
              style={[styles.footerButton, { backgroundColor: colors.undercover }]}
            >
              {buttonInner}
            </View>
          )}
        </View>
      </View>
      {!hideBottomBorder ? (
        <View style={[styles.bottomDivider, { backgroundColor: topBorderColor }]} />
      ) : null}
    </View>
  );
}

export function MainColumnInactiveFooter() {
  const { t } = useAppStrings();
  const { isTelegramMessagesConnected, openConnectSheet, disconnectTelegramMessages } =
    useTelegramMessagesConnection();

  const label = isTelegramMessagesConnected
    ? t("home.mainColumnFooter.telegramMessagesDisconnect")
    : t("home.mainColumnFooter.telegramMessages");

  const onPress = () => {
    if (isTelegramMessagesConnected) {
      void disconnectTelegramMessages();
    } else {
      openConnectSheet();
    }
  };

  return <InactiveWelcomeColumnFooter active label={label} onPress={onPress} />;
}

export function SendColumnInactiveFooter() {
  const { t } = useAppStrings();
  return <InactiveWelcomeColumnFooter label={t("send.footer.submit")} />;
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
    alignItems: "center",
    justifyContent: "center",
  },
  footerButton: {
    alignSelf: "center",
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
