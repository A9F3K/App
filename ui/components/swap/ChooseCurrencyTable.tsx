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
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { useObservedWidth } from "../../smart/useObservedWidth";
import {
  SCROLL_INDICATOR_SCROLL_EPS,
  scrollIndicatorHairlineBorderWidthPx,
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../../scrollIndicatorPx";
import {
  layout,
  typographyAeroport15,
  typographySansSemibold,
  useColors,
} from "../../theme";
import { ScrollIndicatorDragHandle } from "../ScrollIndicatorDragHandle";
import { SmartGradientDivider } from "../smart/SmartGradientDivider";
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
  CHOOSE_CURRENCY_TABLE_ROW_PADDING_VERTICAL_PX,
  CHOOSE_CURRENCY_TABLE_SCROLL_INDICATOR_THUMB_MIN_PX,
} from "./chooseCurrencyTableConstants";
import { resolveChooseCurrencyColumnLayout } from "./chooseCurrencyTableLayout";
import type { ChooseCurrencyVisibleColumn } from "./chooseCurrencyTableLayout";
import { buildChooseCurrencyColumnMetrics } from "./chooseCurrencyTableMeasure";
import {
  buildChooseCurrencyDllrRow,
  type ChooseCurrencyColumnKey,
  type ChooseCurrencyRow,
} from "./chooseCurrencyTableTypes";

const CONTENT_INSET_PX = layout.contentSideInsetPx;
const SCROLLBAR_RIGHT_INSET_PX = layout.scrollIndicatorRightInsetPx;
const HEADER_DIVIDER_HEIGHT_PX = scrollIndicatorHairlineBorderWidthPx();
const HEADER_BLOCK_HEIGHT_PX = CHOOSE_CURRENCY_TABLE_ROW_HEIGHT_PX + HEADER_DIVIDER_HEIGHT_PX;

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

  return (
    <View style={styles.currencyCell}>
      <CurrencyIcon row={row} />
      <View style={{ width: CHOOSE_CURRENCY_TABLE_CURRENCY_ICON_TEXT_GAP_PX }} />
      <View style={styles.currencyTextStack}>
        <Text
          style={[
            typographyAeroport15,
            typographySansSemibold,
            styles.truncatedText,
            styles.currencyNameText,
            { color: colors.primary },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.currency.name}
        </Text>
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
}: {
  columnKey: ChooseCurrencyColumnKey;
  row: ChooseCurrencyRow;
  rank: string;
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
      return <ChooseCurrencyLastYearMiniChart row={row} />;
    default:
      return null;
  }
}

function HeaderLabel({ columnKey, label }: { columnKey: ChooseCurrencyColumnKey; label: string }) {
  const colors = useColors();

  if (columnKey === "rank") {
    return (
      <Text
        style={[typographyAeroport15, styles.rankCellText, styles.truncatedText, { color: colors.primary }]}
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

function columnVariantStyle(columnKey: ChooseCurrencyColumnKey) {
  if (columnKey === "rank") return styles.rankColumn;
  if (columnKey === "currency") return styles.currencyColumn;
  return styles.centeredColumn;
}

function ColumnShell({
  column,
  children,
}: {
  column: ChooseCurrencyVisibleColumn;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.column,
        columnVariantStyle(column.key),
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

function DataRow({
  row,
  rank,
  visibleColumns,
}: {
  row: ChooseCurrencyRow;
  rank: string;
  visibleColumns: readonly ChooseCurrencyVisibleColumn[];
}) {
  return (
    <View
      style={{
        paddingTop: CHOOSE_CURRENCY_TABLE_ROW_PADDING_VERTICAL_PX,
        paddingBottom: CHOOSE_CURRENCY_TABLE_ROW_PADDING_VERTICAL_PX,
        paddingHorizontal: CONTENT_INSET_PX,
      }}
    >
      <View style={styles.bodyRow}>
        {visibleColumns.map((column) => (
          <ColumnShell key={column.key} column={column}>
            <CellContent columnKey={column.key} row={row} rank={rank} />
          </ColumnShell>
        ))}
      </View>
    </View>
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
    prev.row.rate === next.row.rate &&
    prev.rank === next.rank &&
    prev.visibleColumns === next.visibleColumns,
);

type Props = {
  rows?: readonly ChooseCurrencyRow[];
  isLoading?: boolean;
  isFetchingMore?: boolean;
  loadError?: string | null;
  onLoadMore?: () => void;
  /** Measured middle split-column width (px); authoritative on wide home. */
  columnShellWidthPx?: number;
};

export function ChooseCurrencyTable({
  rows: rowsProp,
  isLoading = false,
  isFetchingMore = false,
  loadError = null,
  onLoadMore,
  columnShellWidthPx = 0,
}: Props) {
  const { t, tf, locale } = useAppStrings();
  const defaultRows = useMemo(() => [buildChooseCurrencyDllrRow(locale)] as const, [locale]);
  const rows = rowsProp ?? defaultRows;
  const colors = useColors();
  const { widthPx, onLayout, onRef } = useObservedWidth("choose_currency_table");
  const flatListRef = useRef<FlatList<ChooseCurrencyRow>>(null);
  const [scroll, setScroll] = useState({ layoutH: 0, contentH: 0, scrollY: 0 });
  const [shellLayoutH, setShellLayoutH] = useState(0);

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

  const layoutReferenceRows = useMemo(() => [buildChooseCurrencyDllrRow(locale)] as const, [locale]);

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
        : Math.max(0, shellWidthPx - CONTENT_INSET_PX * 2);
    return resolveChooseCurrencyColumnLayout(contentWidthPx, metrics);
  }, [columnShellWidthPx, headers, layoutReferenceRows, widthPx]);

  const onShellLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayout(e);
      const lh = e.nativeEvent.layout.height;
      setShellLayoutH((current) => (current === lh ? current : lh));
    },
    [onLayout],
  );

  const syncScrollMetricsFromDom = useCallback(() => {
    if (Platform.OS !== "web") return;
    const instance = flatListRef.current as unknown as {
      getScrollableNode?: () => HTMLElement | null | undefined;
    } | null;
    const el = instance?.getScrollableNode?.();
    if (!el) return;
    const layoutH = el.clientHeight;
    const contentH = el.scrollHeight;
    const scrollYRaw = el.scrollTop;
    const scrollY = scrollYRaw <= SCROLL_INDICATOR_SCROLL_EPS ? 0 : scrollYRaw;
    if (layoutH <= 0) return;
    setScroll((prev) => ({
      ...prev,
      layoutH,
      scrollY,
      ...(contentH > 0 ? { contentH } : {}),
    }));
  }, []);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      const instance = flatListRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (!el?.style) return;
      el.classList.add("hsp-main-scroll-hide-native-scrollbar");
      el.classList.add("hsp-scroll-column-overscroll-contain");
      el.style.setProperty("scrollbar-width", "none");
      el.style.setProperty("-ms-overflow-style", "none");
      el.style.setProperty("overscroll-behavior", "contain");
    };
    const id = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    return () => cancelAnimationFrame(id);
  }, [rows.length, visibleColumns]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return;
    let ro: ResizeObserver | null = null;
    const id = requestAnimationFrame(() => {
      const instance = flatListRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const scrollEl = instance?.getScrollableNode?.();
      if (!scrollEl) return;
      ro = new ResizeObserver(() => syncScrollMetricsFromDom());
      ro.observe(scrollEl);
      const inner = scrollEl.firstElementChild;
      if (inner) ro.observe(inner);
    });
    return () => {
      cancelAnimationFrame(id);
      ro?.disconnect();
    };
  }, [syncScrollMetricsFromDom, rows.length, visibleColumns]);

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
      const lh = e.nativeEvent.layout.height;
      setScroll((prev) => ({ ...prev, layoutH: lh }));
      if (Platform.OS === "web") {
        requestAnimationFrame(syncScrollMetricsFromDom);
      }
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
      const instance = flatListRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (el) el.scrollTop = clamped;
    }
    flatListRef.current?.scrollToOffset({ offset: clamped, animated: false });
    setScroll((prev) => ({ ...prev, scrollY: clamped }));
  }, []);

  const indicator = useMemo(() => {
    const trackH = shellLayoutH > 0 ? shellLayoutH : scroll.layoutH;
    const viewH = scroll.layoutH;
    const contentH = scroll.contentH;
    const y = scroll.scrollY;
    if (trackH <= 0 || viewH <= 0 || contentH <= 0 || contentH <= viewH + 0.5) {
      return { show: false as const, thumbH: 0, thumbTop: 0, trackH: 0 };
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
    return { show: true as const, thumbH, thumbTop, maxScroll, trackH };
  }, [scroll, shellLayoutH]);

  const listHeader = useMemo(
    () => (
      <View style={[styles.headerBlock, { backgroundColor: colors.background }]}>
        <View style={[styles.headerRow, { paddingHorizontal: CONTENT_INSET_PX }]}>
          {visibleColumns.map((column) => (
            <ColumnShell key={column.key} column={column}>
              <HeaderLabel columnKey={column.key} label={headers[column.key]} />
            </ColumnShell>
          ))}
        </View>
        <SmartGradientDivider />
      </View>
    ),
    [colors.background, headers, visibleColumns],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ChooseCurrencyRow; index: number }) => (
      <MemoDataRow row={item} rank={String(index + 1)} visibleColumns={visibleColumns} />
    ),
    [visibleColumns],
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

  return (
    <View style={styles.shell} onLayout={onShellLayout} ref={onRef as never}>
      <FlatList
        ref={flatListRef}
        data={rows as ChooseCurrencyRow[]}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        extraData={visibleColumns}
        style={styles.list}
        contentContainerStyle={[styles.listContent, { paddingTop: HEADER_BLOCK_HEIGHT_PX }]}
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
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.35}
        ListFooterComponent={listFooter}
      />
      <View style={styles.headerOverlay} pointerEvents="box-none">
        {listHeader}
      </View>
      {indicator.show ? (
        <View
          style={[
            styles.scrollIndicatorWrap,
            { right: snapScrollIndicatorCoordPx(SCROLLBAR_RIGHT_INSET_PX) },
          ]}
        >
          <ScrollIndicatorDragHandle
            axis="vertical"
            trackSpan={indicator.trackH}
            thumbSpan={indicator.thumbH}
            thumbOffset={indicator.thumbTop}
            scrollRange={indicator.maxScroll}
            onScrollTo={scrollToY}
            crossAxisVisualSpan={scrollIndicatorHairlineBorderWidthPx()}
          >
            <View
              {...(Platform.OS === "web"
                ? ({ className: "hsp-scroll-indicator-thumb" } as Record<string, string>)
                : {})}
              style={[
                styles.scrollIndicatorThumb,
                {
                  top: 0,
                  height: indicator.thumbH,
                  width: 0,
                  borderLeftWidth: scrollIndicatorHairlineBorderWidthPx(),
                  borderLeftColor: colors.accent,
                  borderStyle: "solid",
                },
              ]}
            />
          </ScrollIndicatorDragHandle>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    alignSelf: "stretch",
  },
  list: {
    flex: 1,
    width: "100%",
    minHeight: 0,
  },
  listContent: {
    flexGrow: 0,
    width: "100%",
    maxWidth: "100%",
    paddingBottom: 8,
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
    zIndex: 1,
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
  currencyColumn: {
    alignItems: "flex-start",
    paddingHorizontal: CHOOSE_CURRENCY_TABLE_CELL_PADDING_HORIZONTAL_PX,
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
  currencyNameText: {
    fontSize: 15,
    lineHeight: CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
    height: CHOOSE_CURRENCY_CURRENCY_NAME_LINE_HEIGHT_PX,
    // Cancel Aeroport global translateY so name/ticker line boxes stack flush with the chart.
    transform: [{ translateY: 0 }],
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
  scrollIndicatorWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0,
    overflow: "visible",
    zIndex: layout.authenticatedHome.scrollIndicatorOverlayZIndex,
    pointerEvents: "box-none",
  },
  scrollIndicatorThumb: {
    position: "absolute",
    right: 0,
    top: 0,
  },
});
