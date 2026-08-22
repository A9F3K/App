import * as Clipboard from "expo-clipboard";
import { usePathname, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  authenticatedHomeWideMenuColumnWidthPx,
  homeHeaderProfileNameText,
  homeWideMenuItemLabel,
  homeWalletAddressHeaderText,
  homeWalletBalanceHeaderText,
  layout,
  menuIconStrokeColor,
  type ThemeColors,
  useColors,
} from "../theme";
import { readAuthenticatedHomeLayoutWidthPx } from "../authenticatedHomeLayoutWidth";
import {
  MenuSmartIcon,
  MenuGetIcon,
  MenuSendIcon,
  MenuSwapIcon,
  MenuTradeIcon,
} from "./menu/MenuIcons";
import { logPageDisplay } from "../pageDisplayLog";
import { useTelegram } from "./Telegram";
import { useAppStrings } from "../../locales/AppStringsContext";
import type { AppStringKey } from "../../locales/appStrings";
import { openAuthenticatedHomeRightPanel } from "../authenticatedHomeRightPanel";
import { openSwapCurrenciesBrowse } from "../swap/swapCurrencyPicker";
import { focusAuthenticatedHomeMiddleColumnOnHeaderPanel } from "../authenticatedHomeSelectedChat";
import {
  HeaderIconCopy,
  HeaderIconEdit,
  HeaderIconEn,
  HeaderIconExit,
  HeaderIconKey,
  HeaderIconRu,
  HeaderIconZh,
} from "./icons/HeaderActionIcons";

const AH = layout.authenticatedHome;

/** Wide multicolumn header: 15 + 30 + 10 + 30 + 15 = {@link AH.headerWideRowHeightPx}. */
const WIDE_HEADER_BAND_PX = AH.headerIconDisplaySize;
const WIDE_HEADER_PAD_PX = AH.headerWideSidePaddingVerticalPx;
const WIDE_HEADER_MID_GAP_PX = AH.headerWideSideMiddleGapPx;

const wideHeaderSideColumnStyle = {
  flex: 1,
  minWidth: 0,
  height: "100%" as const,
  paddingTop: WIDE_HEADER_PAD_PX,
  paddingBottom: WIDE_HEADER_PAD_PX,
  gap: WIDE_HEADER_MID_GAP_PX,
};

const wideHeaderBandStyle = {
  height: WIDE_HEADER_BAND_PX,
  justifyContent: "center" as const,
};

const wideHeaderTopBandStyle = wideHeaderBandStyle;
const wideHeaderBottomBandStyle = wideHeaderBandStyle;

const HEADER_ICONS_BEFORE_LANG: readonly {
  id: "copy" | "edit" | "key";
  labelKey: AppStringKey;
  Icon: (p: { color: string; size: number }) => ReactNode;
}[] = [
  { id: "copy", labelKey: "home.header.iconCopy", Icon: HeaderIconCopy },
  { id: "edit", labelKey: "home.header.iconEdit", Icon: HeaderIconEdit },
  { id: "key", labelKey: "home.header.iconKey", Icon: HeaderIconKey },
];

const HEADER_ICON_EXIT_LABEL_KEY = "home.header.iconExit" as const;

/** Brief primary flash after pointer-up so a tap is visible on web. */
const HEADER_ICON_PRESS_FLASH_MS = 180;

function HeaderActionIconButton({
  accessibilityLabel,
  onPress,
  children,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  children: (color: string) => ReactNode;
}) {
  const colors = useColors();
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={AH.headerPressableHitSlop}
      onPressIn={() => {
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          flashTimerRef.current = null;
        }
        setFlash(true);
      }}
      onPressOut={() => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setFlash(false);
          flashTimerRef.current = null;
        }, HEADER_ICON_PRESS_FLASH_MS);
      }}
      onPress={onPress}
    >
      {({ pressed }) =>
        children(menuIconStrokeColor(colors, pressed || flash ? "primary" : "highlight"))
      }
    </Pressable>
  );
}

const WIDE_MENU_ITEM_KEYS = [
  { key: "get", labelKey: "home.menu.get" as const, Icon: MenuGetIcon },
  { key: "swap", labelKey: "home.menu.swap" as const, Icon: MenuSwapIcon },
  { key: "smart", labelKey: "home.menu.smart" as const, Icon: MenuSmartIcon },
  { key: "trade", labelKey: "home.menu.trade" as const, Icon: MenuTradeIcon },
  { key: "send", labelKey: "home.menu.send" as const, Icon: MenuSendIcon },
] as const;

import { trimWalletAddress, walletAddressHeaderSnippet } from "../wallet/walletAddressFormat";

/** Chevron from `assets/header/right.svg`; fill uses theme `highlight`. */
function HeaderProfileChevronIcon({ color }: { color: string }) {
  return (
    <Svg
      width={AH.headerProfileChevronWidth}
      height={AH.headerProfileChevronHeight}
      viewBox={AH.headerProfileChevronViewBox}
      fill="none"
    >
      <Path
        d="M1.79003 7.58886C2.98576 6.27528 2.98578 4.38625 1.79006 3.07266L0.205486 1.3319C-0.0684974 1.03091 -0.0684952 0.598063 0.205492 0.297075C0.569221 -0.102499 1.24895 -0.102496 1.61268 0.297078L4.07529 3.00239C5.30824 4.35685 5.30823 6.30469 4.07527 7.65914L1.61268 10.3644C1.24895 10.764 0.569223 10.764 0.205495 10.3644C-0.0684934 10.0634 -0.0684931 9.63054 0.205496 9.32955L1.79003 7.58886Z"
        fill={color}
      />
    </Svg>
  );
}

/** Get/Swap/… row: wide = fixed `columnWidth` per item; narrow = equal `flex` columns (under profile). */
function AuthenticatedHomeMenuItems({
  colors,
  narrow,
  columnWidth,
  t,
  onMenuKeyPress,
  activeMenuKey,
}: {
  colors: ThemeColors;
  narrow: boolean;
  /** Used when `narrow` is false (centered strip). */
  columnWidth: number;
  t: (key: AppStringKey) => string;
  onMenuKeyPress: (key: (typeof WIDE_MENU_ITEM_KEYS)[number]["key"]) => void;
  /** When set, matching item stays primary; others use inactive (secondary) styling until pressed. */
  activeMenuKey?: (typeof WIDE_MENU_ITEM_KEYS)[number]["key"] | null;
}) {
  return WIDE_MENU_ITEM_KEYS.map(({ key, labelKey, Icon }) => {
    const label = t(labelKey);
    const menuActive = activeMenuKey == null || key === activeMenuKey;
    return (
    <View
      key={key}
      style={
        narrow
          ? { flex: 1, minWidth: 0, alignItems: "center" as const }
          : {
              width: columnWidth,
              minWidth: AH.wideMenuColumnWidthMin,
              alignItems: "center" as const,
            }
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={AH.headerPressableHitSlop}
        onPress={() => onMenuKeyPress(key)}
      >
        {({ pressed }) => {
          const iconVariant = pressed ? "highlight" : menuActive ? "primary" : "inactive";
          const labelColor = pressed
            ? menuIconStrokeColor(colors, "highlight")
            : menuActive
              ? menuIconStrokeColor(colors, "primary")
              : colors.secondary;
          return (
            <View style={{ alignItems: "center" }}>
              <Icon
                variant={iconVariant}
                width={AH.headerIconDisplaySize}
                height={AH.headerIconDisplaySize}
              />
              <Text
                style={[
                  homeWideMenuItemLabel,
                  {
                    marginTop: AH.wideMenuIconLabelGap,
                    color: labelColor,
                  },
                ]}
              >
                {label}
              </Text>
            </View>
          );
        }}
      </Pressable>
    </View>
    );
  });
}

type HeaderMenuKey = (typeof WIDE_MENU_ITEM_KEYS)[number]["key"];

type Props = {
  /** Raw wallet address; clipboard receives trimmed original casing. */
  walletAddress: string;
  /** Profile label from `users.display_name`. */
  displayName: string;
  /** Wide layout: highlight this header menu item; others use secondary (inactive) styling. */
  activeHeaderMenuKey?: HeaderMenuKey | null;
  /** When set, overrides width breakpoint inference (split-pane column count is authoritative). */
  layoutIsWide?: boolean;
};

/**
 * Top row on authenticated home: truncated address (highlight) + header icons, space-between cluster.
 * Breakpoint uses the header shell width from `onLayout` (not only `useWindowDimensions`) so web layout matches the real column width.
 * At `firstBreakpoint` and above: centered Get/Swap/… strip overlay (painted after side columns so it is not covered on web); below: same strip under balance + profile.
 */
export function HomeAuthenticatedHeaderRow({
  walletAddress,
  displayName,
  activeHeaderMenuKey,
  layoutIsWide,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { signOut } = useAuth();
  const colors = useColors();
  const { t, tf, toggleUiLanguage, headerLanguageToggleShows } = useAppStrings();
  const { triggerHaptic } = useTelegram();
  const { width: windowWidth } = useWindowDimensions();
  /** Measured shell width — matches the header column, not always the browser window (`useWindowDimensions` can stay wide on web). */
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const widthForLayout = measuredWidth ?? readAuthenticatedHomeLayoutWidthPx(windowWidth);
  const atOrAboveFirstBreakpoint =
    layoutIsWide ?? widthForLayout > AH.firstBreakpoint;
  const headerMenuActiveKey =
    atOrAboveFirstBreakpoint && activeHeaderMenuKey ? activeHeaderMenuKey : null;
  const trimmed = trimWalletAddress(walletAddress);
  const displaySnippet = walletAddressHeaderSnippet(trimmed);

  const copyFullWalletAddress = useCallback(async () => {
    if (!trimmed) return;
    await Clipboard.setStringAsync(trimmed);
  }, [trimmed]);

  const handleMenuKeyPress = useCallback(
    (key: (typeof WIDE_MENU_ITEM_KEYS)[number]["key"]) => {
      if (atOrAboveFirstBreakpoint) {
        openAuthenticatedHomeRightPanel(key);
        if (key === "swap") {
          openSwapCurrenciesBrowse();
        }
        focusAuthenticatedHomeMiddleColumnOnHeaderPanel();
        if (pathname !== "/" && pathname !== "" && pathname != null) {
          router.replace("/");
        }
        return;
      }
      if (key === "swap") {
        openSwapCurrenciesBrowse();
      }
      const route = `/${key}`;
      if (pathname !== route) {
        router.push(route as any);
      } else if (key === "swap") {
        openSwapCurrenciesBrowse();
      }
    },
    [atOrAboveFirstBreakpoint, pathname, router],
  );

  const handleSignOut = useCallback(() => {
    if (Platform.OS !== "web") {
      triggerHaptic("light");
    }
    logPageDisplay("home_header_sign_out");
    signOut();
    router.replace("/");
  }, [router, signOut, triggerHaptic]);

  const wideMenuColumnWidth = authenticatedHomeWideMenuColumnWidthPx(widthForLayout);

  /** Total strip width scales with viewport via {@link authenticatedHomeWideMenuColumnWidthPx}. */
  const wideMenuStripWidth = atOrAboveFirstBreakpoint
    ? wideMenuColumnWidth * WIDE_MENU_ITEM_KEYS.length
    : 0;

  const wideMenuStrip = atOrAboveFirstBreakpoint ? (
    <View
      pointerEvents="box-none"
      style={[
        StyleSheet.absoluteFillObject,
        {
          justifyContent: "center",
          alignItems: "center",
          zIndex: AH.wideMenuOverlayZIndex,
        },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          width: wideMenuStripWidth,
        }}
      >
        <AuthenticatedHomeMenuItems
          colors={colors}
          narrow={false}
          columnWidth={wideMenuColumnWidth}
          t={t}
          onMenuKeyPress={handleMenuKeyPress}
          activeMenuKey={headerMenuActiveKey}
        />
      </View>
    </View>
  ) : null;

  useEffect(() => {
    logPageDisplay("home_authenticated_header_layout", {
      windowWidth,
      measuredWidth,
      widthForLayout,
      firstBreakpointPx: AH.firstBreakpoint,
      atOrAboveFirstBreakpoint,
      menuVariant: atOrAboveFirstBreakpoint ? "wide_overlay" : "narrow_below_profile",
      wideMenuColumnWidth,
      wideMenuStripWidth,
      usingMeasuredWidth: measuredWidth != null,
    });
  }, [
    windowWidth,
    measuredWidth,
    widthForLayout,
    atOrAboveFirstBreakpoint,
    wideMenuColumnWidth,
    wideMenuStripWidth,
  ]);

  return (
    /* Outer shell: full width; marginBottom = gap under header+divider before body (see theme `headerRowMarginBottom`). */
    <View
      style={{ width: "100%", marginBottom: AH.headerRowMarginBottom }}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        setMeasuredWidth((prev) => {
          if (prev === w) return prev;
          logPageDisplay("home_authenticated_header_onlayout", {
            shellWidth: w,
            windowWidth,
            firstBreakpointPx: AH.firstBreakpoint,
          });
          return w;
        });
      }}
    >
      <View style={{ width: "100%", paddingHorizontal: layout.contentSideInsetPx }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: atOrAboveFirstBreakpoint ? "stretch" : "flex-start",
            width: "100%",
            ...(atOrAboveFirstBreakpoint
              ? {
                  position: "relative" as const,
                  height: AH.headerWideRowHeightPx,
                  overflow: "visible" as const,
                }
              : {}),
          }}
        >
      <View
        style={
          atOrAboveFirstBreakpoint
            ? { ...wideHeaderSideColumnStyle, alignItems: "flex-start" }
            : {
                flex: 1,
                minWidth: 0,
                alignItems: "flex-start",
                justifyContent: "center",
                marginRight: AH.addressRowGap,
              }
        }
      >
        {atOrAboveFirstBreakpoint ? (
          <>
            <View style={wideHeaderTopBandStyle}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tf("home.header.walletAddressA11y", { snippet: displaySnippet })}
                accessibilityHint={t("home.header.copyWalletHint")}
                disabled={!trimmed}
                hitSlop={AH.headerPressableHitSlop}
                onPress={() => {
                  void copyFullWalletAddress();
                }}
              >
                <Text
                  style={[homeWalletAddressHeaderText, { color: colors.secondary }]}
                >
                  {displaySnippet}
                </Text>
              </Pressable>
            </View>
            <View style={wideHeaderBottomBandStyle}>
              <Text
                style={[homeWalletBalanceHeaderText, { color: colors.primary }]}
                accessibilityLabel={t("home.header.balanceA11y")}
              >
                1$
              </Text>
            </View>
          </>
        ) : (
          <View style={{ flex: 1, alignSelf: "stretch", minWidth: 0 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tf("home.header.walletAddressA11y", { snippet: displaySnippet })}
              accessibilityHint={t("home.header.copyWalletHint")}
              disabled={!trimmed}
              hitSlop={AH.headerPressableHitSlop}
              onPress={() => {
                void copyFullWalletAddress();
              }}
              style={{ alignSelf: "stretch" }}
            >
              <Text style={[homeWalletAddressHeaderText, { color: colors.secondary }]}>
                {displaySnippet}
              </Text>
            </Pressable>
            <Text
              style={[
                homeWalletBalanceHeaderText,
                {
                  marginTop: AH.walletBalanceBelowAddressGap,
                  color: colors.primary,
                },
              ]}
              accessibilityLabel={t("home.header.balanceA11y")}
            >
              1$
            </Text>
          </View>
        )}
      </View>
      <View
        style={{
          flexDirection: "column",
          alignItems: "flex-end",
          ...(atOrAboveFirstBreakpoint
            ? { ...wideHeaderSideColumnStyle, alignItems: "flex-end" }
            : { flexShrink: 0, marginLeft: ("auto" as const) }),
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: AH.headerIconGap,
            justifyContent: "flex-end",
            ...(atOrAboveFirstBreakpoint
              ? ({
                  ...wideHeaderTopBandStyle,
                  position: "relative" as const,
                  zIndex: 2,
                } as const)
              : {}),
          }}
        >
          {HEADER_ICONS_BEFORE_LANG.map(({ id, Icon, labelKey }) => {
            const accessibilityLabel = t(labelKey);
            return (
              <HeaderActionIconButton
                key={id}
                accessibilityLabel={accessibilityLabel}
                onPress={() => {
                  if (id === "copy") {
                    void copyFullWalletAddress();
                    return;
                  }
                  if (id === "key") {
                    router.push("/key" as any);
                    return;
                  }
                  /* Wired when flows land */
                }}
              >
                {(color) => <Icon color={color} size={AH.headerIconDisplaySize} />}
              </HeaderActionIconButton>
            );
          })}
          <HeaderActionIconButton
            accessibilityLabel={
              headerLanguageToggleShows === "en"
                ? t("home.header.languageIconSwitchToEn")
                : headerLanguageToggleShows === "ru"
                  ? t("home.header.languageIconSwitchToRu")
                  : t("home.header.languageIconSwitchToZh")
            }
            onPress={() => {
              if (Platform.OS !== "web") {
                triggerHaptic("light");
              }
              toggleUiLanguage();
            }}
          >
            {(color) =>
              headerLanguageToggleShows === "en" ? (
                <HeaderIconEn color={color} size={AH.headerIconDisplaySize} />
              ) : headerLanguageToggleShows === "ru" ? (
                <HeaderIconRu color={color} size={AH.headerIconDisplaySize} />
              ) : (
                <HeaderIconZh color={color} size={AH.headerIconDisplaySize} />
              )
            }
          </HeaderActionIconButton>
          <HeaderActionIconButton
            accessibilityLabel={t(HEADER_ICON_EXIT_LABEL_KEY)}
            onPress={handleSignOut}
          >
            {(color) => (
              <HeaderIconExit color={color} size={AH.headerIconDisplaySize} />
            )}
          </HeaderActionIconButton>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            ...(atOrAboveFirstBreakpoint
              ? wideHeaderBottomBandStyle
              : { marginTop: AH.walletBalanceBelowAddressGap }),
          }}
        >
          <Text
            style={[homeHeaderProfileNameText, { color: colors.primary }]}
            accessibilityLabel={displayName}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <View
            style={{
              marginLeft: AH.headerProfileChevronAfterNameGap,
            }}
          >
            <HeaderProfileChevronIcon color={menuIconStrokeColor(colors, "highlight")} />
          </View>
        </View>
      </View>
      {wideMenuStrip}
      </View>
      {!atOrAboveFirstBreakpoint ? (
        <View style={{ marginTop: AH.headerDividerTopGap, width: "100%" }}>
          <View style={{ flexDirection: "row", alignItems: "center", width: "100%" }}>
            <AuthenticatedHomeMenuItems
              colors={colors}
              narrow
              columnWidth={0}
              t={t}
              onMenuKeyPress={handleMenuKeyPress}
              activeMenuKey={headerMenuActiveKey}
            />
          </View>
        </View>
      ) : null}
      </View>
      {atOrAboveFirstBreakpoint ? (
        <View
          pointerEvents="none"
          style={{
            height: AH.headerDividerHeight,
            width: "100%",
            backgroundColor: colors.highlight,
            flexShrink: 0,
          }}
        />
      ) : null}
    </View>
  );
}
