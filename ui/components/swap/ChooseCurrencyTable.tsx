import { Image } from "expo-image";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { useObservedWidth } from "../../smart/useObservedWidth";
import { resolveWebRefElement } from "../../smart/resolveWebLayoutElement";
import { isBrowserZoomWheelEvent } from "../../browserZoom";
import {
  SCROLL_INDICATOR_SCROLL_EPS,
  readScrollportOverflowPx,
  readShellFlexAvailableHeightPx,
  scrollContentOverflowsViewport,
  scrollIndicatorHairlineBorderWidthPx,
  scrollIndicatorThumbSpanAndOffset,
} from "../../scrollIndicatorPx";
import {
  aiPromptButtonActiveBackground,
  aiPromptButtonHoverBackground,
  layout,
  typographyAeroport15,
  typographySansSemibold,
  useColors,
} from "../../theme";
import { useTelegram } from "../Telegram";
import { HspVerticalScrollIndicator } from "../HspVerticalScrollIndicator";
import { SmartGradientDivider } from "../smart/SmartGradientDivider";
import {
  LIST_ROW_GAP_PX,
  LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX,
} from "../messages/messageListLayout";
import { ChooseCurrencyLastYearMiniChart } from "./ChooseCurrencyLastYearMiniChart";
import {
  CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
  CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
  CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX,
  CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
  CHOOSE_CURRENCY_CURRENCY_TICKER_LINE_HEIGHT_PX,
  CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX,
  CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX,
  CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX,
  CHOOSE_CURRENCY_TABLE_SCROLL_INDICATOR_THUMB_MIN_PX,
} from "./chooseCurrencyTableConstants";
import {
  clearChooseCurrencyYearChartVisibleWindow,
  prefetchChooseCurrencyYearChartsForRowWindow,
  syncChooseCurrencyYearChartListOrder,
  syncChooseCurrencyYearChartVisibleWindow,
} from "../../swap/chooseCurrencyYearChartCache";
import { resolveChooseCurrencyColumnLayout } from "./chooseCurrencyTableLayout";
import type { ChooseCurrencyVisibleColumn } from "./chooseCurrencyTableLayout";
import { buildChooseCurrencyColumnMetrics } from "./chooseCurrencyTableMeasure";
import {
  buildChooseCurrencyDllrRow,
  type ChooseCurrencyColumnKey,
  type ChooseCurrencyRow,
} from "./chooseCurrencyTableTypes";
import { CrossTokenNameplate, CROSS_NAMEPLATE_GAP_PX, isDllrCurrencyRow } from "./CrossTokenNameplate";

/** Match {@link SwapColumnFooter} / deal row: same side inset as `layout.bottomBar.horizontalPadding`. */
const CONTENT_INSET_PX = layout.bottomBar.horizontalPadding;
const SCROLLBAR_RIGHT_INSET_PX = layout.scrollIndicatorRightInsetPx;
const HEADER_DIVIDER_HEIGHT_PX = scrollIndicatorHairlineBorderWidthPx();
const HEADER_BLOCK_HEIGHT_PX = CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX + HEADER_DIVIDER_HEIGHT_PX;
const SCROLL_ATTACH_RETRY_FRAMES = 24;
const SPARKLINE_ROW_STRIDE_PX =
  CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX +
  2 * LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX +
  LIST_ROW_GAP_PX;

/** RN-web FlatList scroll node — API first, then DOM walk inside the shell. */
function findFlatListScrollElement(
  flatListRef: RefObject<FlatList<ChooseCurrencyRow> | null>,
  shellRef: RefObject<View | null>,
): HTMLElement | null {
  if (Platform.OS !== "web") return null;
  const instance = flatListRef.current as unknown as {
    getScrollableNode?: () => HTMLElement | null | undefined;
  } | null;
  const fromApi = instance?.getScrollableNode?.();
  if (fromApi) return fromApi;

  const shellDom = resolveWebRefElement(shellRef.current);
  if (!shellDom) return null;

  const all = shellDom.querySelectorAll<HTMLElement>("div");
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]!;
    const oy = window.getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
  }
  return null;
}

function CurrencyIcon({ row }: { row: ChooseCurrencyRow }) {
  const colors = useColors();
  const icon = row.currency.icon;

  if (icon) {
    return (
      <View style={styles.currencyIconSlot}>
        <Image
          source={icon}
          recyclingKey={row.rowKey}
          cachePolicy="memory-disk"
          style={{
            width: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
            height: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
          }}
          contentFit="contain"
        />
      </View>
    );
  }

  const initials = row.currency.ticker.slice(0, 2).toUpperCase();
  return (
    <View style={styles.currencyIconSlot}>
      <View
        style={{
          width: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
          height: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX,
          borderRadius: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_SIZE_PX / 2,
          backgroundColor: colors.secondary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={[typographyAeroport15, typographySansSemibold, { color: colors.primary, fontSize: 9 }]}>
          {initials}
        </Text>
      </View>
    </View>
  );
}

function CurrencyCell({ row }: { row: ChooseCurrencyRow }) {
  const colors = useColors();
  const showCrossPlate = isDllrCurrencyRow(row);

  return (
    <View style={styles.currencyCell}>
      <CurrencyIcon row={row} />
      <View style={{ width: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX }} />
      <View style={styles.currencyTextStack}>
        <View style={styles.currencyNameRow}>
          <Text
            style={[
              typographyAeroport15,
              typographySansSemibold,
              styles.truncatedText,
              styles.currencyNameText,
              {
                color: colors.primary,
                // Never shrink/ellipsis “Dollar” when CROSS sits beside it.
                flexShrink: showCrossPlate ? 0 : 1,
              },
            ]}
            numberOfLines={1}
            ellipsizeMode={showCrossPlate ? undefined : "tail"}
          >
            {row.currency.name}
          </Text>
          {showCrossPlate ? (
            <View style={{ marginLeft: CROSS_NAMEPLATE_GAP_PX, flexShrink: 0, justifyContent: "center" }}>
              <CrossTokenNameplate lineHeightPx={CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX} />
            </View>
          ) : null}
        </View>
        <Text
          style={[
            typographyAeroport15,
            styles.truncatedText,
            styles.currencyTickerText,
            { color: colors.secondary },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.currency.ticker}
        </Text>
      </View>
    </View>
  );
}

function CellContent({
  columnKey,
  row,
  rank,
  prefetchCharts,
}: {
  columnKey: ChooseCurrencyColumnKey;
  row: ChooseCurrencyRow;
  rank: string;
  prefetchCharts: boolean;
}) {
  const colors = useColors();

  switch (columnKey) {
    case "rank":
      return (
        <Text
          style={[typographyAeroport15, styles.rankCellText, styles.truncatedText, { color: colors.primary }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {rank}
        </Text>
      );
    case "currency":
      return <CurrencyCell row={row} />;
    case "balance":
      return (
        <Text
          style={[typographyAeroport15, styles.centeredCellText, styles.truncatedText, { color: colors.primary }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.balance}
        </Text>
      );
    case "rate":
    case "networks":
    case "marketCap":
    case "volume":
      return (
        <Text
          style={[typographyAeroport15, styles.centeredCellText, styles.truncatedText, { color: colors.primary }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row[columnKey]}
        </Text>
      );
    case "lastYear":
      return <ChooseCurrencyLastYearMiniChart row={row} chartsEnabled={prefetchCharts} />;
    default:
      return null;
  }
}

function HeaderLabel({ columnKey, label }: { columnKey: ChooseCurrencyColumnKey; label: string }) {
  const colors = useColors();

  if (columnKey === "rank" || columnKey === "currency") {
    return (
      <Text
        style={[
          typographyAeroport15,
          styles.rankCellText,
          styles.truncatedText,
          { color: colors.primary, width: "100%" },
        ]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
    );
  }

  return (
    <Text
      style={[typographyAeroport15, styles.centeredCellText, styles.truncatedText, { color: colors.primary }]}
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {label}
    </Text>
  );
}

function columnVariantStyle(
  columnKey: ChooseCurrencyColumnKey,
  edge: "first" | "last" | "middle",
) {
  // Currency keeps its own left padding so the legend lines up with the icon,
  // even when it is the first visible column (wallet / held-only tables).
  if (columnKey === "currency") {
    return edge === "first" ? styles.currencyColumnFirst : styles.currencyColumn;
  }
  if (columnKey === "rank" || edge === "first") {
    return edge === "first" ? styles.firstColumn : styles.rankColumn;
  }
  if (edge === "last") return styles.lastColumn;
  return styles.centeredColumn;
}

function ColumnShell({
  column,
  edge,
  children,
}: {
  column: ChooseCurrencyVisibleColumn;
  edge: "first" | "last" | "middle";
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.column,
        columnVariantStyle(column.key, edge),
        {
          width: column.widthPx,
          maxWidth: column.widthPx,
          flexShrink: 0,
          flexGrow: 0,
        },
      ]}
    >
      {children}
    </View>
  );
}

function WalletRowExpandPanel({
  row,
  onAction,
}: {
  row: ChooseCurrencyRow;
  onAction: (action: "send" | "swap" | "get", row: ChooseCurrencyRow) => void;
}) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const ledger = row.dllrLedger;

  return (
    <View
      style={{
        marginTop: 8,
        paddingTop: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.highlight,
        gap: 10,
      }}
    >
      {ledger ? (
        <Text
          style={[
            typographyAeroport15,
            { color: colors.secondary, fontSize: 13, lineHeight: 18 },
          ]}
        >
          {tf("wallet.dllr.hotFrozenDetail", {
            hot: ledger.hot,
            frozen: ledger.frozen,
          })}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(
          [
            ["send", "home.menu.send"],
            ["swap", "home.menu.swap"],
            ["get", "home.menu.get"],
          ] as const
        ).map(([action, labelKey]) => (
          <Pressable
            key={action}
            accessibilityRole="button"
            accessibilityLabel={t(labelKey)}
            onPress={() => onAction(action, row)}
            style={({ pressed }) => ({
              paddingHorizontal: 14,
              paddingVertical: 9,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.highlight,
              backgroundColor: colors.undercover,
              opacity: pressed ? 0.88 : 1,
            })}
          >
            <Text
              style={[
                typographyAeroport15,
                typographySansSemibold,
                { color: colors.primary, fontSize: 13 },
              ]}
            >
              {t(labelKey)}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function DataRow({
  row,
  rank,
  visibleColumns,
  isLast,
  onPress,
  prefetchCharts,
  contentInsetPx,
  expanded,
  onToggleExpand,
  onWalletAction,
}: {
  row: ChooseCurrencyRow;
  rank: string;
  visibleColumns: readonly ChooseCurrencyVisibleColumn[];
  isLast: boolean;
  onPress?: (row: ChooseCurrencyRow) => void;
  prefetchCharts: boolean;
  contentInsetPx: number;
  expanded?: boolean;
  onToggleExpand?: (row: ChooseCurrencyRow) => void;
  onWalletAction?: (action: "send" | "swap" | "get", row: ChooseCurrencyRow) => void;
}) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const { width: windowWidth } = useWindowDimensions();
  const widePressHighlight = windowWidth > layout.authenticatedHome.firstBreakpoint;
  const expandable = Boolean(onToggleExpand && onWalletAction);
  const handlePress = expandable
    ? () => onToggleExpand?.(row)
    : onPress
      ? () => onPress(row)
      : undefined;

  const body = (
    <View style={styles.bodyRow}>
      {visibleColumns.map((column, columnIndex) => {
        const edge =
          columnIndex === 0
            ? "first"
            : columnIndex === visibleColumns.length - 1
              ? "last"
              : "middle";
        return (
          <ColumnShell key={column.key} column={column} edge={edge}>
            <CellContent
              columnKey={column.key}
              row={row}
              rank={rank}
              prefetchCharts={prefetchCharts}
            />
          </ColumnShell>
        );
      })}
    </View>
  );

  const expand =
    expandable && expanded && onWalletAction ? (
      <WalletRowExpandPanel row={row} onAction={onWalletAction} />
    ) : null;

  if (!widePressHighlight) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded: Boolean(expanded) } : undefined}
        onPress={handlePress}
        style={{
          width: "100%",
          alignSelf: "stretch",
          paddingHorizontal: contentInsetPx,
          marginBottom: isLast ? 0 : LIST_ROW_GAP_PX,
        }}
      >
        {body}
        {expand}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={expandable ? { expanded: Boolean(expanded) } : undefined}
      onPress={handlePress}
      style={({ pressed, hovered }) => {
        let backgroundColor = "transparent";
        if (pressed) {
          backgroundColor = aiPromptButtonActiveBackground(colors, colorScheme);
        } else if (hovered || expanded) {
          backgroundColor = aiPromptButtonHoverBackground(colors, colorScheme);
        }
        return {
          width: "100%",
          alignSelf: "stretch",
          paddingHorizontal: contentInsetPx,
          paddingVertical: LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX,
          backgroundColor,
        };
      }}
    >
      {body}
      {expand}
    </Pressable>
  );
}

const MemoDataRow = memo(
  DataRow,
  (prev, next) =>
    prev.row.rowKey === next.row.rowKey &&
    prev.row.marketCap === next.row.marketCap &&
    prev.row.marketCapUsd === next.row.marketCapUsd &&
    prev.row.volume === next.row.volume &&
    prev.row.balance === next.row.balance &&
    prev.row.dllrLedger?.hot === next.row.dllrLedger?.hot &&
    prev.row.dllrLedger?.frozen === next.row.dllrLedger?.frozen &&
    prev.row.rate === next.row.rate &&
    prev.rank === next.rank &&
    prev.isLast === next.isLast &&
    prev.onPress === next.onPress &&
    prev.prefetchCharts === next.prefetchCharts &&
    prev.visibleColumns === next.visibleColumns &&
    prev.contentInsetPx === next.contentInsetPx &&
    prev.expanded === next.expanded &&
    prev.onToggleExpand === next.onToggleExpand &&
    prev.onWalletAction === next.onWalletAction,
);

type Props = {
  rows?: readonly ChooseCurrencyRow[];
  isLoading?: boolean;
  isFetchingMore?: boolean;
  loadError?: string | null;
  onLoadMore?: () => void;
  onSelectRow?: (row: ChooseCurrencyRow) => void;
  /**
   * Wallet dialog: tap row to expand Send / Swap / Get (and DLLR Hot/Frozen).
   * When set, overrides {@link onSelectRow} for row presses.
   */
  onWalletAction?: (action: "send" | "swap" | "get", row: ChooseCurrencyRow) => void;
  /** Measured middle split-column width (px); authoritative on wide home. */
  columnShellWidthPx?: number;
  /** When false, skip DYOR sparkline prefetch (panel hidden via display:none). */
  prefetchCharts?: boolean;
  /** When set, show only these columns instead of responsive market-browser layout. */
  visibleColumnKeys?: readonly ChooseCurrencyColumnKey[];
  /** Shown when `rows` is empty and not loading. */
  listEmptyMessage?: string | null;
  /**
   * Height of a pinned gradient CTA under this table; scroll thumb travels through it.
   */
  scrollIndicatorExtendBottomPx?: number;
  /**
   * Horizontal inset for legend + rows. Defaults to page `contentSideInset` (15).
   * Floating dialogs should pass the same padX as {@link FloatingDialogStickyHeader}.
   */
  contentInsetPx?: number;
};

export function ChooseCurrencyTable({
  rows: rowsProp,
  isLoading = false,
  isFetchingMore = false,
  loadError = null,
  onLoadMore,
  onSelectRow,
  onWalletAction,
  columnShellWidthPx = 0,
  prefetchCharts = true,
  visibleColumnKeys,
  listEmptyMessage = null,
  scrollIndicatorExtendBottomPx = 0,
  contentInsetPx = CONTENT_INSET_PX,
}: Props) {
  const insetX = Number.isFinite(contentInsetPx) && contentInsetPx >= 0 ? contentInsetPx : CONTENT_INSET_PX;
  const { t, tf, locale } = useAppStrings();
  const defaultRows = useMemo(() => [buildChooseCurrencyDllrRow(locale)] as const, [locale]);
  const rows = rowsProp ?? defaultRows;
  const colors = useColors();
  const { widthPx, onLayout, onRef } = useObservedWidth("choose_currency_table");
  const flatListRef = useRef<FlatList<ChooseCurrencyRow>>(null);
  const shellRef = useRef<View>(null);
  const [scroll, setScroll] = useState({ layoutH: 0, contentH: 0, scrollY: 0 });
  const [shellLayoutH, setShellLayoutH] = useState(0);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  const onToggleExpand = useCallback((row: ChooseCurrencyRow) => {
    setExpandedRowKey((current) => (current === row.rowKey ? null : row.rowKey));
  }, []);

  useEffect(() => {
    if (!onWalletAction) setExpandedRowKey(null);
  }, [onWalletAction]);

  useEffect(() => {
    if (!expandedRowKey) return;
    if (!rows.some((row) => row.rowKey === expandedRowKey)) {
      setExpandedRowKey(null);
    }
  }, [expandedRowKey, rows]);

  const setShellNodeRef = useCallback(
    (node: View | null) => {
      shellRef.current = node;
      onRef?.(node as never);
    },
    [onRef],
  );

  const headers = useMemo(
    () =>
      ({
        rank: t("swap.chooseCurrency.col.rank"),
        currency: t("swap.chooseCurrency.col.currency"),
        balance: t("swap.chooseCurrency.col.balance"),
        rate: t("swap.chooseCurrency.col.rate"),
        networks: t("swap.chooseCurrency.col.networks"),
        marketCap: t("swap.chooseCurrency.col.marketCap"),
        volume: t("swap.chooseCurrency.col.volume"),
        lastYear: t("swap.chooseCurrency.col.lastYear"),
      }) as const,
    [t],
  );

  const layoutReferenceRows = useMemo(() => {
    if (rows.length > 0) return rows;
    return [buildChooseCurrencyDllrRow(locale)] as const;
  }, [locale, rows]);

  const visibleColumns = useMemo(() => {
    const metrics = buildChooseCurrencyColumnMetrics(headers, layoutReferenceRows);
    const shellWidthPx =
      columnShellWidthPx > 0
        ? columnShellWidthPx
        : widthPx > 0
          ? widthPx
          : Number.POSITIVE_INFINITY;
    const contentWidthPx =
      shellWidthPx === Number.POSITIVE_INFINITY
        ? shellWidthPx
        : Math.max(0, shellWidthPx - insetX * 2);

    if (visibleColumnKeys?.length) {
      const byKey = new Map(metrics.map((entry) => [entry.key, entry]));
      const ordered = visibleColumnKeys
        .map((key) => byKey.get(key))
        .filter((entry): entry is NonNullable<typeof entry> => entry != null);
      return resolveChooseCurrencyColumnLayout(contentWidthPx, ordered);
    }

    return resolveChooseCurrencyColumnLayout(contentWidthPx, metrics);
  }, [columnShellWidthPx, headers, insetX, layoutReferenceRows, visibleColumnKeys, widthPx]);

  const syncScrollMetricsFromDom = useCallback(() => {
    if (Platform.OS !== "web") return;
    const el = findFlatListScrollElement(flatListRef, shellRef);
    const shellDom = resolveWebRefElement(shellRef.current);
    const live = readScrollportOverflowPx(el, shellDom);
    if (!live) return;
    const scrollYRaw = el!.scrollTop;
    const scrollY = scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : scrollYRaw;
    setScroll((prev) => ({
      ...prev,
      layoutH: live.layoutH,
      scrollY,
      contentH: live.contentH > 0 ? live.contentH : prev.contentH,
    }));
  }, []);

  const onShellLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayout(e);
      const lh = e.nativeEvent.layout.height;
      setShellLayoutH((current) => (current === lh ? current : lh));
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollMetricsFromDom);
      }
    },
    [onLayout, syncScrollMetricsFromDom],
  );

  const sparklineViewStart = Math.max(
    0,
    Math.floor(scroll.scrollY / SPARKLINE_ROW_STRIDE_PX),
  );
  const sparklineViewCount = Math.max(
    5,
    Math.ceil((scroll.layoutH || shellLayoutH || 480) / SPARKLINE_ROW_STRIDE_PX) + 1,
  );

  useEffect(() => {
    if (!prefetchCharts) {
      clearChooseCurrencyYearChartVisibleWindow();
      return;
    }
    const allSparkline: string[] = [];
    for (const row of rows) {
      if (row.lastYearKind === "sparkline") allSparkline.push(row.rowKey);
    }
    const end = Math.min(rows.length, sparklineViewStart + sparklineViewCount);
    const visible: string[] = [];
    for (let i = sparklineViewStart; i < end; i++) {
      const row = rows[i];
      if (row?.lastYearKind === "sparkline") visible.push(row.rowKey);
    }
    syncChooseCurrencyYearChartListOrder(allSparkline);
    syncChooseCurrencyYearChartVisibleWindow(visible);
    prefetchChooseCurrencyYearChartsForRowWindow(rows, sparklineViewStart, sparklineViewCount);
  }, [prefetchCharts, rows, sparklineViewCount, sparklineViewStart]);

  useEffect(() => {
    if (prefetchCharts) return;
    clearChooseCurrencyYearChartVisibleWindow();
  }, [prefetchCharts]);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      const el = findFlatListScrollElement(flatListRef, shellRef);
      if (!el?.style) return;
      el.classList.add("hsp-main-scroll-hide-native-scrollbar");
      el.classList.add("hsp-scroll-column-overscroll-contain");
      el.style.setProperty("scrollbar-width", "none");
      el.style.setProperty("-ms-overflow-style", "none");
      el.style.setProperty("overscroll-behavior", "contain");
      el.style.setProperty("overflow", "auto");
    };
    let frame = 0;
    let cancelled = false;
    const pump = () => {
      if (cancelled) return;
      run();
      frame += 1;
      if (frame < SCROLL_ATTACH_RETRY_FRAMES) requestAnimationFrame(pump);
    };
    pump();
    return () => {
      cancelled = true;
    };
  }, [rows.length, visibleColumns, shellLayoutH, widthPx]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    let cancelled = false;
    let attempts = 0;
    let rafId = 0;
    let ro: ResizeObserver | null = null;
    let scrollEl: HTMLElement | null = null;

    const bindShellBox = (shellDom: HTMLElement) => {
      shellDom.style.setProperty("min-height", "0");
      shellDom.style.setProperty("flex", "1 1 0px");
      shellDom.style.setProperty("align-self", "stretch");
      const avail = readShellFlexAvailableHeightPx(shellDom);
      if (avail > 0) {
        shellDom.style.setProperty("height", `${avail}px`);
        shellDom.style.setProperty("max-height", `${avail}px`);
        shellDom.style.setProperty("overflow", "hidden");
      } else {
        shellDom.style.removeProperty("height");
        shellDom.style.setProperty("max-height", "100%");
      }
    };

    const bindScrollportBox = (el: HTMLElement) => {
      el.style.setProperty("min-height", "0");
      el.style.setProperty("flex", "1 1 0px");
      el.style.setProperty("align-self", "stretch");
      el.style.setProperty("height", "0px");
      const shellDom = resolveWebRefElement(shellRef.current);
      if (shellDom) bindShellBox(shellDom);
      const shellH = shellDom?.clientHeight ?? 0;
      if (shellH > 0) {
        el.style.setProperty("max-height", `${shellH}px`);
      } else {
        el.style.setProperty("max-height", "100%");
      }
      el.style.setProperty("overflow", "auto");
    };

    const onResize = () => {
      const shellDom = resolveWebRefElement(shellRef.current);
      if (shellDom) bindShellBox(shellDom);
      const nextScroll = findFlatListScrollElement(flatListRef, shellRef);
      if (nextScroll) {
        scrollEl = nextScroll;
        bindScrollportBox(nextScroll);
      }
      syncScrollMetricsFromDom();
    };

    const onZoomWheel = (e: WheelEvent) => {
      if (!isBrowserZoomWheelEvent(e)) return;
      requestAnimationFrame(() => {
        onResize();
        requestAnimationFrame(onResize);
      });
    };

    const attach = (): boolean => {
      ro?.disconnect();
      ro = null;
      const next = findFlatListScrollElement(flatListRef, shellRef);
      if (!next) return false;
      scrollEl = next;
      bindScrollportBox(next);
      ro = new ResizeObserver(onResize);
      ro.observe(next);
      const inner = next.firstElementChild;
      if (inner) ro.observe(inner);
      const shellDom = resolveWebRefElement(shellRef.current);
      if (shellDom && shellDom !== next) {
        ro.observe(shellDom);
        const shellParent = shellDom.parentElement;
        if (shellParent && shellParent !== next && shellParent !== shellDom) {
          ro.observe(shellParent);
        }
      }
      onResize();
      return true;
    };

    const pump = () => {
      if (cancelled) return;
      if (attach()) return;
      attempts += 1;
      if (attempts < SCROLL_ATTACH_RETRY_FRAMES) rafId = requestAnimationFrame(pump);
    };
    rafId = requestAnimationFrame(pump);

    window.addEventListener("resize", onResize);
    window.addEventListener("wheel", onZoomWheel, { passive: true });
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onResize);
    visualViewport?.addEventListener("scroll", onResize);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", onZoomWheel);
      visualViewport?.removeEventListener("resize", onResize);
      visualViewport?.removeEventListener("scroll", onResize);
      ro?.disconnect();
    };
  }, [syncScrollMetricsFromDom, rows.length, visibleColumns, widthPx, shellLayoutH]);

  // After split 2↔3 remounts, FlatList may skip content-size events; re-pull DOM metrics.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      syncScrollMetricsFromDom();
      raf2 = requestAnimationFrame(syncScrollMetricsFromDom);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [syncScrollMetricsFromDom, widthPx, shellLayoutH, visibleColumns]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const ne = e.nativeEvent;
      const ch = ne.contentSize?.height ?? 0;
      const yRaw = ne.contentOffset.y;
      const y = yRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : yRaw;
      setScroll((prev) => ({
        ...prev,
        scrollY: y,
        ...(ch > 0 ? { contentH: ch } : {}),
      }));
      if (Platform.OS === "web") {
        syncScrollMetricsFromDom();
      }
    },
    [syncScrollMetricsFromDom],
  );

  const onListLayout = useCallback(
    (e: LayoutChangeEvent) => {
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollMetricsFromDom);
        return;
      }
      const lh = e.nativeEvent.layout.height;
      setScroll((prev) => ({ ...prev, layoutH: lh }));
    },
    [syncScrollMetricsFromDom],
  );

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      setScroll((prev) => ({ ...prev, contentH: h }));
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollMetricsFromDom);
      }
    },
    [syncScrollMetricsFromDom],
  );

  const scrollToY = useCallback((y: number) => {
    const clamped = Math.max(0, y);
    if (Platform.OS === "web") {
      const el = findFlatListScrollElement(flatListRef, shellRef);
      if (el) el.scrollTop = clamped;
    }
    flatListRef.current?.scrollToOffset({ offset: clamped, animated: false });
    setScroll((prev) => ({ ...prev, scrollY: clamped }));
  }, []);

  const indicator = useMemo(() => {
    const shellH = shellLayoutH > 0 ? shellLayoutH : scroll.layoutH;
    /** Track includes the sticky legend header — thumb travels through it. */
    const trackTop = 0;
    const extendBottom = Math.max(0, scrollIndicatorExtendBottomPx);
    const trackH = Math.max(0, shellH + extendBottom);
    const viewH = scroll.layoutH > 0 ? scroll.layoutH : shellH;
    const contentH = scroll.contentH;
    const y = scroll.scrollY;
    if (trackH <= 0 || viewH <= 0 || contentH <= 0 || !scrollContentOverflowsViewport(contentH, viewH)) {
      return { show: false as const, thumbH: 0, thumbTop: 0, trackH: 0, trackTop };
    }
    const maxScroll = Math.max(1e-6, contentH - viewH);
    const { thumbSpan } = scrollIndicatorThumbSpanAndOffset(
      trackH,
      viewH,
      contentH,
      y,
      maxScroll,
    );
    const hairline = scrollIndicatorHairlineBorderWidthPx();
    const thumbH = Math.max(
      hairline,
      CHOOSE_CURRENCY_TABLE_SCROLL_INDICATOR_THUMB_MIN_PX,
      thumbSpan,
    );
    const maxTravel = Math.max(0, trackH - thumbH);
    const scrollClamped = Math.max(0, Math.min(y, maxScroll));
    let thumbTop = (scrollClamped / maxScroll) * maxTravel;
    if (scrollClamped <= SCROLL_INDICATOR_SCROLL_EPS) thumbTop = 0;
    if (scrollClamped >= maxScroll - SCROLL_INDICATOR_SCROLL_EPS) thumbTop = maxTravel;
    thumbTop = Math.max(0, Math.min(thumbTop, maxTravel));
    return { show: true as const, thumbH, thumbTop, maxScroll, trackH, trackTop };
  }, [scroll, shellLayoutH, scrollIndicatorExtendBottomPx]);

  const listHeader = useMemo(
    () => (
      <View style={[styles.headerBlock, { backgroundColor: colors.background }]}>
        <View style={[styles.headerRow, { paddingHorizontal: insetX }]}>
          {visibleColumns.map((column, columnIndex) => {
            const edge =
              columnIndex === 0
                ? "first"
                : columnIndex === visibleColumns.length - 1
                  ? "last"
                  : "middle";
            return (
              <ColumnShell key={column.key} column={column} edge={edge}>
                <HeaderLabel columnKey={column.key} label={headers[column.key]} />
              </ColumnShell>
            );
          })}
        </View>
        <SmartGradientDivider
          bleedPastContentInset={false}
          horizontalPaddingPx={insetX}
        />
      </View>
    ),
    [colors.background, headers, insetX, visibleColumns],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ChooseCurrencyRow; index: number }) => (
      <MemoDataRow
        row={item}
        rank={String(index + 1)}
        visibleColumns={visibleColumns}
        isLast={index >= rows.length - 1}
        onPress={onWalletAction ? undefined : onSelectRow}
        onToggleExpand={onWalletAction ? onToggleExpand : undefined}
        onWalletAction={onWalletAction}
        expanded={onWalletAction ? expandedRowKey === item.rowKey : false}
        prefetchCharts={prefetchCharts}
        contentInsetPx={insetX}
      />
    ),
    [
      expandedRowKey,
      insetX,
      onSelectRow,
      onToggleExpand,
      onWalletAction,
      prefetchCharts,
      rows.length,
      visibleColumns,
    ],
  );

  const keyExtractor = useCallback((item: ChooseCurrencyRow) => item.rowKey, []);

  const handleEndReached = useCallback(() => {
    onLoadMore?.();
  }, [onLoadMore]);

  const listFooter = useMemo(() => {
    if (isLoading || isFetchingMore) {
      return (
        <View style={styles.footerState}>
          <ActivityIndicator size="small" color={colors.accent} />
          <View style={{ width: 8 }} />
          <Text style={[typographyAeroport15, { color: colors.secondary }]}>
            {isLoading
              ? t("swap.chooseCurrency.loading")
              : tf("swap.chooseCurrency.loadingMore", { count: rows.length })}
          </Text>
        </View>
      );
    }

    if (loadError && rows.length <= 1) {
      return (
        <View style={styles.footerState}>
          <Text style={[typographyAeroport15, { color: colors.secondary }]}>{loadError}</Text>
        </View>
      );
    }

    return null;
  }, [colors.accent, colors.secondary, isFetchingMore, isLoading, loadError, rows.length, t]);

  const listEmpty = useMemo(() => {
    if (!listEmptyMessage || isLoading || rows.length > 0) return null;
    return (
      <View style={styles.footerState}>
        <Text style={[typographyAeroport15, { color: colors.secondary }]}>{listEmptyMessage}</Text>
      </View>
    );
  }, [colors.secondary, isLoading, listEmptyMessage, rows.length]);

  return (
    <View style={styles.shell} onLayout={onShellLayout} ref={setShellNodeRef} collapsable={false}>
      <FlatList
        ref={flatListRef}
        data={rows as ChooseCurrencyRow[]}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        extraData={{ visibleColumns, expandedRowKey }}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingTop:
              HEADER_BLOCK_HEIGHT_PX + LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX,
          },
        ]}
        showsVerticalScrollIndicator={false}
        initialNumToRender={14}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={50}
        windowSize={9}
        removeClippedSubviews={Platform.OS !== "web"}
        onScroll={onScroll}
        onLayout={onListLayout}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        onEndReached={onLoadMore ? handleEndReached : undefined}
        onEndReachedThreshold={0.35}
        ListFooterComponent={listFooter}
        ListEmptyComponent={listEmpty}
      />
      <View style={styles.headerOverlay} pointerEvents="box-none">
        {listHeader}
      </View>
      <HspVerticalScrollIndicator
        show={indicator.show}
        shellRef={shellRef}
        trackH={indicator.trackH}
        thumbH={indicator.thumbH}
        thumbTop={indicator.thumbTop}
        maxScroll={indicator.show ? indicator.maxScroll : 0}
        thumbColor={colors.scrollIndicator}
        scrollbarRightInsetPx={SCROLLBAR_RIGHT_INSET_PX}
        scrollIndicatorExtendBottomPx={scrollIndicatorExtendBottomPx}
        onScrollTo={scrollToY}
        style={indicator.show ? { top: indicator.trackTop } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    alignSelf: "stretch",
    overflow: "visible",
  },
  list: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    height: 0,
    alignSelf: "stretch",
  },
  listContent: {
    flexGrow: 0,
    width: "100%",
    maxWidth: "100%",
    paddingBottom: LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX + 8,
  },
  headerBlock: {
    width: "100%",
    maxWidth: "100%",
  },
  headerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    /** Below the scroll thumb so the indicator can travel through the legend. */
    zIndex: 1,
    ...Platform.select({
      web: {
        userSelect: "none",
        WebkitUserSelect: "none",
      } as Record<string, string>,
      default: {},
    }),
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    height: CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX,
    width: "100%",
    maxWidth: "100%",
    overflow: "hidden",
  },
  bodyRow: {
    flexDirection: "row",
    alignItems: "center",
    height: CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX,
    width: "100%",
    maxWidth: "100%",
    overflow: "hidden",
  },
  column: {
    justifyContent: "center",
    minHeight: CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX,
    overflow: "hidden",
  },
  rankColumn: {
    alignItems: "flex-start",
    paddingRight: CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX,
  },
  /** Outer edge flush to the page inset (matches deal-row left edge). */
  firstColumn: {
    alignItems: "flex-start",
    paddingLeft: 0,
    paddingRight: CHOOSE_CURRENCY_TABLE_RANK_CELL_PADDING_RIGHT_PX,
  },
  /** Outer edge flush to the page inset (matches deal-row / Swap button right edge). */
  lastColumn: {
    alignItems: "stretch",
    justifyContent: "center",
    paddingLeft: CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
    paddingRight: 0,
  },
  currencyColumn: {
    alignItems: "flex-start",
    paddingHorizontal: CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
  },
  /** First visible column is currency — flush left to the page inset; icon starts at the edge. */
  currencyColumnFirst: {
    alignItems: "flex-start",
    paddingLeft: 0,
    paddingRight: CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
  },
  centeredColumn: {
    alignItems: "center",
    paddingHorizontal: CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
  },
  rankCellText: {
    textAlign: "left",
  },
  centeredCellText: {
    textAlign: "center",
    width: "100%",
  },
  truncatedText: {
    minWidth: 0,
    ...(Platform.OS === "web" ? ({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as object) : null),
  },
  currencyCell: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    width: "100%",
    maxWidth: "100%",
    height: CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX,
    overflow: "hidden",
  },
  currencyIconSlot: {
    flexShrink: 0,
  },
  currencyTextStack: {
    justifyContent: "center",
    minWidth: 0,
    flexShrink: 1,
    flex: 1,
    height: CHOOSE_CURRENCY_TABLE_MINI_CHART_HEIGHT_PX,
  },
  currencyNameRow: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    height: CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
  },
  currencyNameText: {
    fontSize: 15,
    lineHeight: CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
    height: CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
    // Cancel Aeroport global translateY so name/ticker line boxes stack flush with the chart.
    transform: [{ translateY: 0 }],
  },
  currencyTickerRow: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    height: CHOOSE_CURRENCY_CURRENCY_TICKER_LINE_HEIGHT_PX,
  },
  currencyTickerText: {
    fontSize: 15,
    lineHeight: CHOOSE_CURRENCY_CURRENCY_TICKER_LINE_HEIGHT_PX,
    height: CHOOSE_CURRENCY_CURRENCY_TICKER_LINE_HEIGHT_PX,
    transform: [{ translateY: 0 }],
  },
  footerState: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    width: "100%",
  },
});
