import * as Clipboard from "expo-clipboard";
import { usePathname, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, Platform, type LayoutRectangle } from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  authenticatedHomeWideMenuColumnWidthPx,
  homeWideMenuItemLabel,
  displayAmountTextProps,
  homeHeaderProfileNameText,
  homeWalletAddressHeaderText,
  homeWalletBalanceHeaderText,
  layout,
  menuIconStrokeColor,
  type ThemeColors,
  uiIconButtonVerticalCompensationTransform,
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
import { TonviewerExplorerButton } from "./TonviewerExplorerButton";
import { SwitchWalletMenu } from "./wallet/SwitchWalletMenu";
import { UndercoverProButton, UndercoverWalletButton } from "./swap/SwapFormIcons";
import { ProAccessDialog } from "../pro/ProAccessDialog";
import { subscribeOpenProAccess } from "../pro/openProAccess";
import { isProAccessActive, subscribeProAccess } from "../pro/proAccessStore";
import { trimWalletAddress, walletAddressHeaderSnippet } from "../wallet/walletAddressFormat";
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
const HEADER_CONTROL_ROW_PX = layout.bottomBar.undercoverButtonHeightPx;
/**
 * Wallet is a circle; balance digits have left sidebearing. Same CSS gap as PRO↔wallet
 * reads larger here — pull the label toward the wallet to optically match.
 */
const WALLET_TO_BALANCE_OPTICAL_PULL_PX = 10;
/**
 * 30px balance digits sit optically low in the line box vs the wallet/PRO chips.
 * Replaces the global Text −1px nudge with a stronger lift for this size only.
 */
const BALANCE_OPTICAL_NUDGE_Y_PX = -2;
/** Below this width, show only the first name token in the header identity line. */
const HEADER_FIRST_NAME_ONLY_MAX_WIDTH_PX = 460;

/** Horizontal switch-wallet glyph (two opposing arrows). */
function HeaderSwitchWalletIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8h12.5M13.5 4.5 17.5 8l-4 3.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20 16H7.5M10.5 19.5 6.5 16l4-3.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Wide multicolumn header: 15 + 30 + 10 + 30 + 15 = {@link AH.headerWideRowHeightPx}. */
const WIDE_HEADER_BAND_PX = AH.headerIconDisplaySize;
const WIDE_HEADER_PAD_PX = AH.headerWideSidePaddingVerticalPx;
const WIDE_HEADER_MID_GAP_PX = AH.headerWideSideMiddleGapPx;

/** One header band: left + right controls share a single vertical center. */
const headerControlRowStyle = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  height: WIDE_HEADER_BAND_PX,
  width: "100%" as const,
  gap: AH.addressRowGap,
};

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
      style={{
        width: AH.headerIconDisplaySize,
        height: AH.headerIconDisplaySize,
        alignItems: "center",
        justifyContent: "center",
        // Match global Text −1px optical lift so icons share a center with “Switch wallet”.
        ...uiIconButtonVerticalCompensationTransform,
      }}
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
  /** Live built-in wallet total for the header balance line. */
  headerBalanceLabel?: string;
  /** Opens the built-in wallet currencies dialog. */
  onBalancePress?: () => void;
  /** Wallet currencies dialog is open — inverts chip colors on the wallet control. */
  walletCurrenciesOpen?: boolean;
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
  headerBalanceLabel = "1$",
  onBalancePress,
  walletCurrenciesOpen = false,
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
  const [proDialogOpen, setProDialogOpen] = useState(false);
  const [switchWalletOpen, setSwitchWalletOpen] = useState(false);
  const [switchWalletAnchor, setSwitchWalletAnchor] = useState<LayoutRectangle | null>(null);
  const switchWalletRef = useRef<View>(null);
  const proSubscribed = useSyncExternalStore(
    subscribeProAccess,
    isProAccessActive,
    () => false,
  );

  useEffect(() => {
    return subscribeOpenProAccess(() => setProDialogOpen(true));
  }, []);

  const openSwitchWalletMenu = useCallback(() => {
    switchWalletRef.current?.measureInWindow((x, y, width, height) => {
      setSwitchWalletAnchor({ x, y, width, height });
      setSwitchWalletOpen(true);
    });
  }, []);
  const liveViewportWidthPx = readAuthenticatedHomeLayoutWidthPx(windowWidth);
  const widthForLayout = Math.min(
    measuredWidth ?? liveViewportWidthPx,
    liveViewportWidthPx > 0 ? liveViewportWidthPx : Number.POSITIVE_INFINITY,
  );
  const atOrAboveFirstBreakpoint =
    widthForLayout > AH.firstBreakpoint && (layoutIsWide ?? true);
  const headerMenuActiveKey =
    atOrAboveFirstBreakpoint && activeHeaderMenuKey ? activeHeaderMenuKey : null;
  const trimmed = trimWalletAddress(walletAddress);
  const displaySnippet = walletAddressHeaderSnippet(trimmed);
  const walletNameLabel = (() => {
    const name = displayName.trim();
    const emDash = t("common.emDash");
    if (!name || name === emDash) return null;
    if (widthForLayout < HEADER_FIRST_NAME_ONLY_MAX_WIDTH_PX) {
      const first = name.split(/\s+/)[0]?.trim();
      return first || name;
    }
    return name;
  })();

  const copyFullWalletAddress = useCallback(async () => {
    if (!trimmed) return;
    await Clipboard.setStringAsync(trimmed);
  }, [trimmed]);

  const balanceButton = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: HEADER_CONTROL_ROW_PX,
        gap: 0,
      }}
    >
      <UndercoverProButton
        accessibilityLabel={t("pro.buyCta")}
        active={proDialogOpen}
        subscribed={proSubscribed}
        onPress={() => setProDialogOpen((open) => !open)}
      />
      <View style={{ width: AH.headerIconGap, flexShrink: 0 }} />
      <UndercoverWalletButton
        accessibilityLabel={t("home.header.balanceExpandHint")}
        active={walletCurrenciesOpen}
        disabled={!onBalancePress}
        onPress={onBalancePress}
      />
      <View
        style={{
          width: Math.max(0, AH.headerIconGap - WALLET_TO_BALANCE_OPTICAL_PULL_PX),
          flexShrink: 0,
        }}
      />
      <View
        style={{
          height: HEADER_CONTROL_ROW_PX,
          justifyContent: "center",
          alignItems: "flex-start",
          flexShrink: 0,
        }}
      >
        <Text
          {...displayAmountTextProps}
          style={[
            homeWalletBalanceHeaderText,
            {
              color: colors.primary,
              lineHeight: HEADER_CONTROL_ROW_PX,
              // Stronger than global Text −1px: large digits center below the wallet/PRO chips.
              transform: [{ translateY: BALANCE_OPTICAL_NUDGE_Y_PX }],
            },
          ]}
        >
          {headerBalanceLabel}
        </Text>
      </View>
    </View>
  );

  const headerMonoLineStyle = [
    homeWalletAddressHeaderText,
    {
      color: colors.secondary,
      lineHeight: HEADER_CONTROL_ROW_PX,
    },
  ];

  const walletAddressRow = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        flexShrink: 1,
        height: HEADER_CONTROL_ROW_PX,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tf("home.header.walletAddressA11y", { snippet: displaySnippet })}
        accessibilityHint={t("home.header.copyWalletHint")}
        disabled={!trimmed}
        hitSlop={AH.headerPressableHitSlop}
        onPress={() => {
          void copyFullWalletAddress();
        }}
        style={{
          flexShrink: 0,
          height: HEADER_CONTROL_ROW_PX,
          justifyContent: "center",
        }}
      >
        <Text numberOfLines={1} style={headerMonoLineStyle}>
          {displaySnippet}
        </Text>
      </Pressable>
      {trimmed ? (
        <TonviewerExplorerButton
          address={trimmed}
          accessibilityLabel={t("home.header.openTonviewerA11y")}
        />
      ) : null}
      {walletNameLabel ? (
        <Text numberOfLines={1} style={[...headerMonoLineStyle, { flexShrink: 1, minWidth: 0 }]}>
          {walletNameLabel}
        </Text>
      ) : null}
    </View>
  );

  const switchWalletRow = (
    <View ref={switchWalletRef} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("home.header.switchWalletA11y")}
        accessibilityState={{ expanded: switchWalletOpen }}
        hitSlop={AH.headerPressableHitSlop}
        onPress={openSwitchWalletMenu}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 6,
          flexShrink: 1,
          minWidth: 0,
          height: HEADER_CONTROL_ROW_PX,
        }}
      >
        <Text
          numberOfLines={1}
          style={[
            homeHeaderProfileNameText,
            {
              color: colors.primary,
              lineHeight: HEADER_CONTROL_ROW_PX,
              textAlign: "left",
            },
          ]}
        >
          {t("home.header.switchWallet")}
        </Text>
        <View
          style={{
            width: 16,
            height: HEADER_CONTROL_ROW_PX,
            alignItems: "center",
            justifyContent: "center",
            ...uiIconButtonVerticalCompensationTransform,
          }}
        >
          <HeaderSwitchWalletIcon color={menuIconStrokeColor(colors, "highlight")} size={16} />
        </View>
      </Pressable>
    </View>
  );

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

  const headerActionIconsRow = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: HEADER_CONTROL_ROW_PX,
        gap: AH.headerIconGap,
        justifyContent: "flex-end",
        flexShrink: 0,
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
  );

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
    <>
    {/* Outer shell: full width; marginBottom = gap under header+divider before body (see theme `headerRowMarginBottom`). */}
    <View
      style={{ width: "100%", marginBottom: AH.headerRowMarginBottom, overflow: "visible" }}
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
        {atOrAboveFirstBreakpoint ? (
          <View
            style={{
              flexDirection: "column",
              justifyContent: "center",
              width: "100%",
              position: "relative",
              height: AH.headerWideRowHeightPx,
              paddingTop: WIDE_HEADER_PAD_PX,
              paddingBottom: WIDE_HEADER_PAD_PX,
              gap: WIDE_HEADER_MID_GAP_PX,
              overflow: "visible",
            }}
          >
            {/*
              Shared rows (not side columns): left+right on each band share one vertical center.
              Top: balance · address/name · Bottom: switch wallet · action icons.
            */}
            <View style={headerControlRowStyle}>
              {balanceButton}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  minWidth: 0,
                  flexShrink: 1,
                  height: HEADER_CONTROL_ROW_PX,
                  position: "relative",
                  zIndex: 2,
                }}
              >
                {walletAddressRow}
              </View>
            </View>
            <View style={headerControlRowStyle}>
              {switchWalletRow}
              {headerActionIconsRow}
            </View>
            {wideMenuStrip}
          </View>
        ) : (
          <View style={{ width: "100%", flexDirection: "column" }}>
            <View style={headerControlRowStyle}>
              {balanceButton}
              {walletAddressRow}
            </View>
            <View style={{ ...headerControlRowStyle, marginTop: WIDE_HEADER_MID_GAP_PX }}>
              {switchWalletRow}
              {headerActionIconsRow}
            </View>
          </View>
        )}
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
    <ProAccessDialog visible={proDialogOpen} onClose={() => setProDialogOpen(false)} />
    <SwitchWalletMenu
      visible={switchWalletOpen}
      anchor={switchWalletAnchor}
      builtinAddress={trimmed}
      onClose={() => setSwitchWalletOpen(false)}
    />
    </>
  );
}
