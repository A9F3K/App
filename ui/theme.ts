import { Platform, type TextStyle } from "react-native";
import { FONT_AEROPORT_REGULAR, FONT_UI_SANS_SEMIBOLD, WEB_AEROPORT_STACK, WEB_UI_MONO_STACK } from "./fonts";
import {
  getThemeColorsFromLaunchThemeParams,
  getThemeColorsFromTelegramCssVars,
  getThemeColorsFromWebAppThemeParams,
} from "./components/telegramWebApp";
import { isWelcomeLayoutRoute } from "./isWelcomeLayoutRoute";

export const dark = {
  background: "#010101",
  primary: "#FFFFFF",
  /** Muted text + icons (content, not chrome). */
  secondary: "#A1A1A1",
  /** Borders + divider strokes (chrome). */
  highlight: "#5A5A5A",
  undercover: "#323232",
  /** Scroll thumbs, email field stroke, and other accent chrome. */
  accent: "#818181",
  /** Scroll thumbs on divider seams — white on dark chrome. */
  scrollIndicator: "#FFFFFF",
} as const;

export const light = {
  background: "#F1F1F1",
  primary: "#000000",
  secondary: "#717171",
  /**
   * Borders + divider strokes (chrome). Keep much lighter than dark-theme `#5A5A5A`
   * so scroll thumbs remain readable when they overlay column seams.
   */
  highlight: "#D0D0D0",
  undercover: "#dadada",
  /** Scroll thumbs, email field stroke, and other accent chrome. */
  accent: "#818181",
  /** Scroll thumbs on divider seams — green for high contrast vs light grey chrome (not black). */
  scrollIndicator: "#00B33C",
} as const;

export type ThemeName = "dark" | "light";
export type ThemeColors = {
  background: string;
  primary: string;
  secondary: string;
  highlight: string;
  /** Filled surfaces / buttons (theme `undercover` in Dart palette). */
  undercover: string;
  /** Welcome email field border and similar accent chrome. */
  accent: string;
  /** Custom scroll thumbs (column seams, fields, nav strip). */
  scrollIndicator: string;
};

/** Home wide strip / stroke-driven glyphs: `primary` vs `highlight` / `inactive` theme colors. */
export type MenuIconVariant = "primary" | "highlight" | "inactive";

export function menuIconStrokeColor(colors: ThemeColors, variant: MenuIconVariant): string {
  if (variant === "primary") {
    return colors.primary;
  }
  // `highlight` (pressed) and `inactive` (dimmed menu item) use secondary stroke.
  return colors.secondary;
}

/** `assets/menu/*.svg` viewBox. */
export const MENU_ICON_DEFAULT_SIZE = 30;

export function getColorsForTheme(name: ThemeName | undefined | null): ThemeColors {
  if (name === "light") return light;
  return dark;
}

function tryParseRgb888(hex: string): [number, number, number] | null {
  const s = hex.trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const n = parseInt(m6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m3) {
    const t = m3[1];
    return [
      parseInt(t[0] + t[0], 16),
      parseInt(t[1] + t[1], 16),
      parseInt(t[2] + t[2], 16),
    ];
  }
  return null;
}

/** Linear RGB mix `from` → `to` (t=0..1). Falls back to `from` if hex parse fails. */
function mixRgbHex(from: string, to: string, t: number): string {
  const A = tryParseRgb888(from);
  const B = tryParseRgb888(to);
  if (!A || !B) return from;
  const u = Math.min(1, Math.max(0, t));
  const r = Math.round(A[0] + (B[0] - A[0]) * u);
  const g = Math.round(A[1] + (B[1] - A[1]) * u);
  const b = Math.round(A[2] + (B[2] - A[2]) * u);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Welcome OAuth rows + email “Sign in”: hover fill (web `Pressable` `hovered`).
 * Mixes `undercover` toward `primary` — dark lifts ~11% toward white; light deepens ~5.5% toward black
 * so the step matches human contrast on each background.
 */
export function welcomeAuthButtonHoverBackground(colors: ThemeColors, scheme: ThemeName): string {
  const t = scheme === "light" ? 0.055 : 0.11;
  return mixRgbHex(colors.undercover, colors.primary, t);
}

/** Slightly stronger than hover — pointer / touch active. */
export function welcomeAuthButtonActiveBackground(colors: ThemeColors, scheme: ThemeName): string {
  const t = scheme === "light" ? 0.095 : 0.175;
  return mixRgbHex(colors.undercover, colors.primary, t);
}

/** AI example prompt hover — slightly darkens `undercover`. */
export function aiPromptButtonHoverBackground(colors: ThemeColors, scheme: ThemeName): string {
  const toward = scheme === "light" ? colors.primary : colors.background;
  const t = scheme === "light" ? 0.07 : 0.14;
  return mixRgbHex(colors.undercover, toward, t);
}

/** AI example prompt press — a step darker than hover. */
export function aiPromptButtonActiveBackground(colors: ThemeColors, scheme: ThemeName): string {
  const toward = scheme === "light" ? colors.primary : colors.background;
  const t = scheme === "light" ? 0.11 : 0.22;
  return mixRgbHex(colors.undercover, toward, t);
}

/** Same on SSR and first client paint — never app dark (#111); Telegram bg shows through CSS vars. */
const TELEGRAM_PRE_READY_FALLBACK: ThemeColors = {
  ...dark,
  background: "transparent",
};

export function useColors(): ThemeColors {
  // Lazy require so importers of only `dark` / `light` do not load the TMA / Telegram module graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const { useTelegram } = require("./components/Telegram") as {
    useTelegram: () => {
      colorScheme: ThemeName;
      manualTheme: ThemeName | null;
      isInTelegram: boolean;
      useTelegramTheme: boolean;
      themeBgReady: boolean;
      clientHydrated: boolean;
    };
  };
  const { colorScheme, manualTheme, useTelegramTheme, themeBgReady, clientHydrated } =
    useTelegram();

  // SSR has no `window`, so `useTelegramTheme` is false and we use `dark`. On the client, TMA would
  // otherwise take the branch below with `transparent` before `clientHydrated` — different from
  // server HTML and triggers React #418 on web (e.g. index bootstrap `backgroundColor`).
  if (!clientHydrated) {
    return getColorsForTheme("dark");
  }

  // Manual override skips Telegram pre-ready CSS so light/dark paint immediately from settings.
  if (useTelegramTheme && !themeBgReady && manualTheme == null) {
    const preReady =
      getThemeColorsFromTelegramCssVars() ??
      getThemeColorsFromWebAppThemeParams() ??
      getThemeColorsFromLaunchThemeParams();
    if (preReady) {
      return { ...dark, ...preReady, highlight: dark.highlight, secondary: dark.secondary };
    }
    return TELEGRAM_PRE_READY_FALLBACK;
  }

  // `colorScheme` is already effective (manual ?? Telegram / plain-web auto).
  return getColorsForTheme(colorScheme);
}

/**
 * Authenticated home (`/` signed-in): first viewport width (px) where layout leaves the compact regime.
 * Compare as `width > firstBreakpoint` for wide header menu and other responsive pieces; add more breakpoints beside this.
 */
const authenticatedHomeFirstBreakpointPx = 724;
/** Authenticated home: viewport width (px) where a third split column appears (`width > secondBreakpoint`). */
const authenticatedHomeSecondBreakpointPx = 1280;

/** Horizontal inset from viewport or column inner edge to main content (not divider hit strips). */
const contentSideInsetPx = 15;

export const layout = {
  maxContentWidth: 600,
  contentSideInsetPx,
  /**
   * 1px vertical scroll thumb inset (px) from the viewport or column edge.
   * `0` = flush to the column seam (portaled above the divider overlay on web).
   */
  scrollIndicatorRightInsetPx: 0,
  /**
   * Authenticated home (`/` signed-in): padding inside the root scroll column (same outer scroll as welcome).
   * Central place to tune per breakpoint/platform later (e.g. `Platform.select` or responsive hook).
   */
  authenticatedHome: {
    contentInsetTop: 22,
    contentInsetBottom: 22,
    /** Top inset (px) before the first swap rate row (narrow `/swap` page and wide split column). */
    swapFirstRowTopInsetPx: 20,
    /** Vertical gap (px) between the swap rate row and the seven-column stats row. */
    swapStatsRowTopGapPx: 20,
    /** Vertical gap (px) between stats row and chart (prev-main SizedBox 15). */
    swapChartTopGapPx: 15,
    /**
     * Horizontal inset for header row and padded bodies. Same value as root `layout.contentSideInsetPx`; unrelated to split-pane divider hit width.
     */
    contentInsetHorizontal: contentSideInsetPx,
    /**
     * Outer `marginBottom` (px) on the authenticated-home header wrapper in
     * {@link HomeAuthenticatedHeaderRow}: vertical gap between the **bottom of the whole header block**
     * (content row **and** the optional full-bleed divider) and the **next** content in the scroll.
     * Does not affect tap targets or inner padding — only spacing below the header strip.
     */
    headerRowMarginBottom: 0,
    /**
     * Uniform expansion (px) of the **touch target** for header `Pressable`s (address row, icon cluster,
     * wide-menu items). React Native draws nothing here: bounds stay visually the same, but taps register
     * this far outside the visible bounds on each side — easier to hit small icons and text on touch devices.
     */
    headerPressableHitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
    /** Full-bleed divider stroke height (px) under the wide header row. */
    headerDividerHeight: 1,
    /** Character count taken from the end of the wallet string for the snippet (after `walletAddressSnippetPrefix`). */
    walletAddressSnippetTailLength: 8,
    /** Prefix before the visible wallet tail on the authenticated home header. */
    walletAddressSnippetPrefix: "..",
    /** Placeholder when the wallet address is empty (authenticated home header snippet). */
    walletAddressSnippetPlaceholder: "…",
    /** Inlined `assets/header/right.svg` width / height (px). */
    headerProfileChevronWidth: 5,
    headerProfileChevronHeight: 11,
    /** Matches `assets/header/right.svg` coordinate system with width/height above. */
    headerProfileChevronViewBox: "0 0 5 11",
    /** `zIndex` for the absolutely positioned wide-menu overlay above side columns. */
    wideMenuOverlayZIndex: 1,
    /** Horizontal gap between truncated address and the header icon cluster. */
    addressRowGap: 15,
    /** Gap between adjacent icons from `assets/header/*.svg`. */
    headerIconGap: 15,
    /** Tap/visual size for header icons (`assets/header/*.svg` viewBoxes are 30×30). */
    headerIconDisplaySize: 30,
    /** First authenticated-home layout breakpoint (px): wide menu and other elements use `viewportWidth > firstBreakpoint`. */
    firstBreakpoint: authenticatedHomeFirstBreakpointPx,
    /** Second layout breakpoint (px): three-column split body uses `rowWidth > secondBreakpoint` (with two draggable dividers). */
    secondBreakpoint: authenticatedHomeSecondBreakpointPx,
    /** Wide menu column width (px) at `wideMenuColumnExpandViewportMin` viewport width. */
    wideMenuColumnWidthMin: 59,
    /** Wide menu column width (px) at `wideMenuColumnExpandViewportMax` viewport width and above. */
    wideMenuColumnWidthMax: 79,
    /** Viewport width (px) where wide-menu column width starts at `wideMenuColumnWidthMin` (linear ramp); equals {@link layout.authenticatedHome.firstBreakpoint}. */
    wideMenuColumnExpandViewportMin: authenticatedHomeFirstBreakpointPx,
    /** Viewport width (px) where column width reaches `wideMenuColumnWidthMax`. */
    wideMenuColumnExpandViewportMax: 1240,
    /** Space between icon and label under it (px). */
    wideMenuIconLabelGap: 10,
    /** Vertical gap (px) between wallet address snippet and balance text on authenticated home header. */
    walletBalanceBelowAddressGap: 22,
    /** Vertical gap (px) between header row content and full-width divider below (wide layout only). */
    headerDividerTopGap: 22,
    /** Wide multicolumn header row height (px): 15 + 30 + {@link headerWideSideMiddleGapPx} + 30 + 15. */
    headerWideRowHeightPx: 100,
    /** Top/bottom inset (px) for left/right header columns in wide multicolumn layout. */
    headerWideSidePaddingVerticalPx: 15,
    /** Vertical gap (px) between the two 30px side bands in wide multicolumn header. */
    headerWideSideMiddleGapPx: 10,
    /** Horizontal gap (px) between profile name and chevron on authenticated home header (`assets/header/right.svg`). */
    headerProfileChevronAfterNameGap: 5,
    /** Two-column body under header: default first column width (px) when `width > firstBreakpoint`. */
    splitPaneDefaultFirstColumnPx: (364 + 15 + 30),
    /** Two-column body: minimum first column width (px) while dragging the divider. */
    splitPaneMinFirstColumnPx: 280,
    /** Two-column body: minimum width (px) kept for the second column. */
    splitPaneMinSecondColumnPx: 320,
    /** Three-column body: minimum width (px) for the third (rightmost) tunable column. */
    splitPaneMinThirdColumnPx: 360,
    /** Three-column body: initial width (px) of the third column; user adjusts via the second divider. */
    splitPaneDefaultThirdColumnPx: 360,
    /**
     * Split-pane: draggable divider total hit width (px). Strip is centered on the column seam (overlapping padding);
     * `splitPaneDividerStrokePx` stroke is inset inside the strip — does not add flex width between columns.
     */
    splitPaneDividerHitWidthPx: 12,
    /**
     * Two-column body: vertical split line width (px). Prefer {@link hairlineBorderWidthPx} at paint time
     * so the stroke matches scroll thumbs on retina; this constant is the 1 CSS-px fallback only.
     */
    splitPaneDividerStrokePx: 1,
    /**
     * Split-pane divider hit + painted seam `zIndex`.
     * Must stay above sticky column footers so vertical edges run through the bottom bars.
     * Vertical scroll thumbs use {@link scrollIndicatorOverlayZIndex} and portal above this on web when flush.
     */
    splitPaneDividerOverlayZIndex: 5,
    /**
     * Two-column body: first column cannot be dragged wider than this (px). Matches {@link firstBreakpoint}
     * so the layout stays consistent with the compact single-column regime.
     */
    splitPaneMaxFirstColumnPx: authenticatedHomeFirstBreakpointPx,
    /**
     * Left column text nav strip: vertical gap (px) below the authenticated header in **compact** layout only
     * (`viewportWidth <= firstBreakpoint`). Wide layouts (`width > firstBreakpoint`) use 0 for this gap.
     */
    leftNavStripMarginTopPx: 10,
    /**
     * Left column top nav strip: gap (px) between the horizontal scroll thumb and the bottom rule (strip width).
     */
    /**
     * Gap (px) between the Feed/Messages/… horizontal scroll thumb and the strip bottom hairline.
     * `0` = thumb overlays the divider (music progress-bar style).
     */
    leftNavStripScrollbarAboveBorderPx: 0,
    /** Left column nav strip: width (px) of each horizontal edge fade (15px; mirrors `contentSideInsetPx`). */
    leftNavStripRightFadeWidthPx: contentSideInsetPx,
    /** Vertical scroll thumb layer inside {@link HspScrollColumn}; above {@link splitPaneDividerOverlayZIndex} at column seams. */
    scrollIndicatorOverlayZIndex: 10,
  },
  /** FloatingShield glass discs — diameters match original `settingsCircle` / `circle` (dp). */
  floatingShield: {
    settingsDiameter: 30,
    shieldDiameter: 50,
    /** Standard horizontal inset (px) from the column/screen edge (glow/lightning may overflow). */
    edgeInsetPx: contentSideInsetPx,
    /** Shield chip sits an extra 10px inward vs settings. */
    shieldExtraInsetPx: 10,
  },
  bottomBar: {
    /** One-line bar: `verticalPadding` + 40px control column + `verticalPadding` (send sits in 40×40 undercover). */
    barMinHeight: 59,
    lineHeight: 20,
    verticalPadding: 20,
    /** Bottom inset for send control above the bar edge; unchanged when the bar grows vertically. */
    applyIconBottom: 15,
    maxLinesBeforeScroll: 7,
    maxBarHeight: 190,
    /** Horizontal inset (px) from column edge: textarea left, send icon right (`GlobalBottomBar` inner row). */
    horizontalPadding: contentSideInsetPx,
    /** Horizontal gap (px) between the text field and the send icon on all platforms. */
    textToSendIconGapPx: 15,
    /**
     * Undercover action chip height (px) — Get TonConnect / Top Up, Swap, Send, Connect Telegram,
     * Smart deploy, and all column-footer action buttons share this (Get-page density).
     */
    undercoverButtonHeightPx: 30,
    /**
     * Horizontal padding inside undercover action chips.
     * Keep one value so footer/action buttons share the Get-page density.
     */
    undercoverButtonPaddingHorizontalPx: 10,
    /** Custom 1px scroll-thumb in the AI bar — flush to the field edge so it overlays the hairline border. */
    scrollbarRightInsetPx: 0,
    /** 1px highlight rule above the bar (`GlobalBottomBar` / column footers). */
    topRuleHeightPx: 1,
    /** 1px highlight rule at the screen edge when the footer is full-bleed. */
    bottomRuleHeightPx: 1,
  },
};

/** Where `GlobalBottomBar` mounts on signed-in `/` at different viewport widths (see {@link authenticatedHomeBottomBarDock}). */
export type AuthenticatedHomeBottomBarDock = "screenFooter" | "splitColumn2" | "splitColumn3";

/**
 * AI & search bar placement on authenticated home only. Welcome `/` stays `screenFooter`.
 * Use {@link useResolvedPathname} + `useWindowDimensions().width` + `useAuth().isAuthenticated`.
 */
function usesAuthenticatedSplitChrome(
  pathname: string | null | undefined,
  isAuthenticated: boolean,
): boolean {
  if (!isAuthenticated) return false;
  if (pathname === "/swap" || pathname === "/swap/currency") return true;
  return pathname === "/" || pathname === "" || pathname == null;
}

export function authenticatedHomeBottomBarDock(
  pathname: string | null | undefined,
  windowWidth: number,
  isAuthenticated: boolean,
): AuthenticatedHomeBottomBarDock {
  if (!usesAuthenticatedSplitChrome(pathname, isAuthenticated)) return "screenFooter";
  const ah = layout.authenticatedHome;
  if (windowWidth <= ah.firstBreakpoint) return "screenFooter";
  if (windowWidth <= ah.secondBreakpoint) return "splitColumn2";
  return "splitColumn3";
}

/**
 * Wide authenticated-home header menu: each column width ramps linearly with viewport width between
 * {@link layout.authenticatedHome.firstBreakpoint} / `wideMenuColumnWidthMin` and
 * {@link layout.authenticatedHome.wideMenuColumnExpandViewportMax} / `wideMenuColumnWidthMax`.
 */
export function authenticatedHomeWideMenuColumnWidthPx(windowWidth: number): number {
  const ah = layout.authenticatedHome;
  const lo = ah.wideMenuColumnExpandViewportMin;
  const hi = ah.wideMenuColumnExpandViewportMax;
  const span = hi - lo;
  const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (windowWidth - lo) / span));
  return Math.round(ah.wideMenuColumnWidthMin + t * (ah.wideMenuColumnWidthMax - ah.wideMenuColumnWidthMin));
}

export const icons = {
  apply: {
    width: 15,
    height: 10,
  },
};

/**
 * Single optical vertical shift for Noto Sans (px). Tune here only.
 *
 * RN `Text` / `TextInput` pick this up via `ensureUiSansFontFamilyDefaults()` as
 * `uiTextVerticalCompensationTransform`. For plain DOM (e.g. web `textarea`) use
 * `translateY(${uiTextVerticalCompensationY}px)`. Icons beside that text use the smaller
 * **`uiIconButtonVerticalCompensationTransform`** (see `uiIconButtonVerticalCompensationY`). Do **not**
 * put `uiTextVerticalCompensationTransform` on `TextStyle` tokens like `typographyRect15` — that would
 * double-apply on `Text`.
 */
export const uiTextVerticalCompensationY = -1;

export const uiTextVerticalCompensationTransform = {
  transform: [{ translateY: uiTextVerticalCompensationY }],
} satisfies Pick<TextStyle, "transform">;

/** Icons in buttons: upward correction magnitude (px). RN uses negative `translateY`. */
export const uiIconButtonVerticalCompensationPx = 1;

export const uiIconButtonVerticalCompensationY = -uiIconButtonVerticalCompensationPx;

export const uiIconButtonVerticalCompensationTransform = {
  transform: [{ translateY: uiIconButtonVerticalCompensationY }],
} satisfies Pick<TextStyle, "transform">;

/** Welcome OAuth buttons only: Apple asset sits low — extra upward correction (px). */
export const uiWelcomeAppleOAuthIconExtraCompensationPx = 1;

/**
 * Single-line labels in fixed-height rows (auth buttons, undercover strips, etc.).
 *
 * Pairs with global `uiTextVerticalCompensationY` on `Text`. `lineHeight` slightly above `fontSize`
 * avoids descender clipping; ~18px tracks Noto for 40px-tall rows without blowing up the line box.
 */
export const typographyRect15: TextStyle = {
  fontSize: 15,
  lineHeight: 18,
  fontWeight: "400",
  includeFontPadding: false,
  textAlignVertical: "center",
  paddingVertical: 0,
};

/** Standard 40px-tall button / glass-pill row height. */
export const FIXED_ROW_40_HEIGHT_PX = 40;

/** Line box for 15px labels in {@link FIXED_ROW_40_HEIGHT_PX} rows (Cyrillic/Latin descenders). */
export const FIXED_ROW_40_LABEL_LINE_HEIGHT_PX = 21;

/** Standard 30px-tall action button row height. */
export const FIXED_ROW_30_HEIGHT_PX = 30;

/** Line box for 15px labels in {@link FIXED_ROW_30_HEIGHT_PX} rows. */
export const FIXED_ROW_30_LABEL_LINE_HEIGHT_PX = 18;

/**
 * Labels in fixed-height button rows (40px auth buttons, modal actions, Telegram connect pill, etc.).
 *
 * Pairs with global `uiTextVerticalCompensationY` on `Text`, but on web we reset `translateY` inside
 * `[role="button"]` / overflow-hidden chips — otherwise `numberOfLines={1}` clips descenders.
 */
export const typographyFixedRow40Label: TextStyle = {
  fontSize: 15,
  lineHeight: FIXED_ROW_40_LABEL_LINE_HEIGHT_PX,
  fontWeight: "400",
  includeFontPadding: false,
  textAlignVertical: "center",
  paddingVertical: 0,
  ...Platform.select({
    web: { transform: [{ translateY: 0 }] },
    default: {},
  }),
};

/** Labels in 30px-tall action rows (swap/send/smart footer chips). */
export const typographyFixedRow30Label: TextStyle = {
  fontSize: 15,
  lineHeight: FIXED_ROW_30_LABEL_LINE_HEIGHT_PX,
  fontWeight: "400",
  includeFontPadding: false,
  textAlignVertical: "center",
  paddingVertical: 0,
  ...Platform.select({
    web: { transform: [{ translateY: 0 }] },
    default: {},
  }),
};

/** @deprecated Use {@link typographyFixedRow30Label}. */
export const typographyTelegramConnectPillLabel: TextStyle = typographyFixedRow30Label;

/** Wide home menu labels under SVG icons (15 / 15 — tight line box). */
export const homeWideMenuItemLabel: TextStyle = {
  fontSize: 15,
  lineHeight: 15,
  fontWeight: "400",
  textAlign: "center",
  includeFontPadding: false,
  paddingVertical: 0,
};

/** Noto Sans Semibold file — use **`fontWeight: "400"`** (RN separate families per weight). */
export const typographySansSemibold: TextStyle = {
  fontFamily: FONT_UI_SANS_SEMIBOLD,
  fontWeight: "400",
  includeFontPadding: false,
  textAlignVertical: "center",
  paddingVertical: 0,
};

/** Truncated wallet address row on authenticated home (`highlight` color from palette). */
export const homeWalletAddressHeaderText: TextStyle = {
  fontFamily: WEB_UI_MONO_STACK,
  fontSize: 15,
  /** 30px line box matches {@link layout.authenticatedHome.headerIconDisplaySize}; centers single-line mono with address row. */
  lineHeight: 30,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
};

/**
 * Static copy that must not look like a field (no I-beam / caret on web).
 * Pair with {@link displayAmountTextProps} on the `Text`.
 */
export const webNonEditableTextStyle: TextStyle =
  Platform.OS === "web"
    ? ({
        userSelect: "none",
        cursor: "default",
        caretColor: "transparent",
      } as TextStyle)
    : {};

/** Placeholder amounts (header “1$”, send/swap figures) — display only, never an input. */
export const displayAmountTextProps = {
  selectable: false as const,
  ...(Platform.OS === "web" ? ({ dataSet: { hspDisplayAmount: "true" } } as object) : {}),
};

/** Balance line under wallet address on authenticated home header (placeholder “1$”). */
export const homeWalletBalanceHeaderText: TextStyle = {
  fontSize: 30,
  lineHeight: 30,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
  ...webNonEditableTextStyle,
};

/** Profile / display name under header icons on authenticated home. */
export const homeHeaderProfileNameText: TextStyle = {
  fontSize: 15,
  lineHeight: 30,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
};

/** Aeroport regular 20 / 20 — swap and similar market rows. */
export const typographyAeroport20: TextStyle = {
  fontFamily: Platform.OS === "web" ? WEB_AEROPORT_STACK : FONT_AEROPORT_REGULAR,
  fontSize: 20,
  lineHeight: 20,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
  ...uiTextVerticalCompensationTransform,
};

/** Aeroport regular 10 / 20 — swap stats grid labels and values. */
export const typographyAeroport10: TextStyle = {
  fontFamily: Platform.OS === "web" ? WEB_AEROPORT_STACK : FONT_AEROPORT_REGULAR,
  fontSize: 10,
  lineHeight: 20,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
  ...uiTextVerticalCompensationTransform,
};

/** Aeroport regular 15 / 20 — swap rate and interval letters. */
export const typographyAeroport15: TextStyle = {
  fontFamily: Platform.OS === "web" ? WEB_AEROPORT_STACK : FONT_AEROPORT_REGULAR,
  fontSize: 15,
  lineHeight: 20,
  fontWeight: "400",
  includeFontPadding: false,
  paddingVertical: 0,
  textAlignVertical: "center",
  ...uiTextVerticalCompensationTransform,
};
