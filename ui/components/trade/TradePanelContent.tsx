import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { HspScrollColumn, type HspScrollMetrics } from "../HspScrollColumn";
import { TradeCollectionColumn } from "./TradeCollectionColumn";
import { TradeFeedRow } from "./TradeFeedRow";
import { tradeApIcon, tradeFeedItemImages } from "../../trade/tradeAssets";
import { resolveTradeCollectionColumnCount } from "../../trade/tradeCollectionLayout";
import { TRADE_SAMPLE_COLLECTIONS, TRADE_SAMPLE_FEED_ITEMS } from "../../trade/tradeSampleData";
import { layout, typographyRect15, useColors } from "../../theme";

const TOP_INSET_PX = 15;
const SECTION_GAP_PX = 22;
const TAB_GAP_PX = 15;
const FILTER_ICON_GAP_PX = 3;
const FILTER_ROW_GAP_PX = 13;
const PAGINATION_DOT_PX = 11;
const PAGINATION_DOT_GAP_PX = 11;
const TABS_AFTER_DOTS_GAP_PX = 33;
const TABS_TO_FILTERS_GAP_PX = 19;

function TradePaginationDots({
  activeIndex,
  count,
  onPressIndex,
}: {
  activeIndex: number;
  count: number;
  onPressIndex: (index: number) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ height: PAGINATION_DOT_PX, alignItems: "center", justifyContent: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {Array.from({ length: count }).map((_, i) => {
          const isActive = i === activeIndex;
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "center" }}>
              {i > 0 ? <View style={{ width: PAGINATION_DOT_GAP_PX }} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Trade slide ${i + 1}`}
                onPress={() => onPressIndex(i)}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <View
                  style={{
                    width: PAGINATION_DOT_PX,
                    height: PAGINATION_DOT_PX,
                    backgroundColor: isActive ? colors.primary : "transparent",
                    borderWidth: isActive ? 0 : 1,

                    borderColor: colors.secondary,
                  }}
                />
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TradeFilterChip({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Text style={[typographyRect15, { fontSize: 15, lineHeight: 21, color: colors.primary }]}>
        {label}
      </Text>
      <View style={{ width: FILTER_ICON_GAP_PX }} />
      <Image source={tradeApIcon} style={{ width: 11, height: 11 }} contentFit="contain" />
    </View>
  );
}

/** Trade panel body (prev-main `TradePage`): collections, tabs, filters, and sample feed rows. */
export function TradePanelContent() {
  const colors = useColors();
  const contentInset = layout.contentSideInsetPx;
  const [viewportH, setViewportH] = useState(0);
  const [collectionsRowWidth, setCollectionsRowWidth] = useState(0);
  const [needsScroll, setNeedsScroll] = useState<boolean | null>(null);
  const scrollLayoutReady = needsScroll !== null;

  const collectionColumnCount = useMemo(
    () => resolveTradeCollectionColumnCount(collectionsRowWidth, contentInset),
    [collectionsRowWidth, contentInset],
  );

  const slidesCount = 2;
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);

  // Start auto-sliding only while this screen is mounted/visible.
  useEffect(() => {
    const id = setInterval(() => {
      setActiveSlideIndex((v) => (v + 1) % slidesCount);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const visibleCollections = useMemo(() => {
    const baseIndex = activeSlideIndex * 4; // per slide uses 4 items
    return TRADE_SAMPLE_COLLECTIONS.slice(baseIndex, baseIndex + collectionColumnCount);
  }, [activeSlideIndex, collectionColumnCount]);

  const onViewportLayout = useCallback((e: LayoutChangeEvent) => {
    setViewportH(e.nativeEvent.layout.height);
  }, []);

  const onCollectionsRowLayout = useCallback((e: LayoutChangeEvent) => {
    setCollectionsRowWidth(e.nativeEvent.layout.width);
  }, []);

  const onScrollMetrics = useCallback(
    (metrics: Omit<HspScrollMetrics, "scrollY">) => {
      if (needsScroll !== null) return;
      const overflow = metrics.layoutH > 0 && metrics.contentH > metrics.layoutH + 0.5;
      setNeedsScroll(overflow);
    },
    [needsScroll],
  );

  const scrollShellBleed = { marginHorizontal: -contentInset };
  const scrollContentPadding = {
    paddingTop: TOP_INSET_PX,
    paddingHorizontal: contentInset,
    paddingBottom: TOP_INSET_PX,
  };

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
      onLayout={onViewportLayout}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        onMetricsChange={onScrollMetrics}
        contentContainerStyle={
          scrollLayoutReady && !needsScroll
            ? {
                ...scrollContentPadding,
                flexGrow: 1,
                ...(viewportH > 0 ? { minHeight: viewportH } : {}),
              }
            : scrollContentPadding
        }
      >
        <View
          style={{ flexDirection: "row", alignItems: "flex-start", width: "100%" }}
          onLayout={onCollectionsRowLayout}
        >
          {visibleCollections.map((collection, index) => (
            <Fragment key={`${collection.title}-${index}`}>
              {index > 0 ? <View style={{ width: contentInset }} /> : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <TradeCollectionColumn
                  image={collection.image}
                  title={collection.title}
                  subtitle={collection.subtitle}
                  colors={colors}
                />
              </View>
            </Fragment>
          ))}
        </View>

        <View style={{ height: SECTION_GAP_PX }} />
        <TradePaginationDots
          activeIndex={activeSlideIndex}
          count={slidesCount}
          onPressIndex={setActiveSlideIndex}
        />

        <View style={{ height: TABS_AFTER_DOTS_GAP_PX }} />
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <Text style={[typographyRect15, { fontSize: 20, lineHeight: 15, color: colors.primary }]}>
            Trending
          </Text>
          <View style={{ width: TAB_GAP_PX }} />
          <Text style={[typographyRect15, { fontSize: 20, lineHeight: 15, color: colors.secondary }]}>
            Cap
          </Text>
          <View style={{ width: TAB_GAP_PX }} />
          <Text style={[typographyRect15, { fontSize: 20, lineHeight: 15, color: colors.secondary }]}>
            Reach
          </Text>
        </View>

        <View style={{ height: TABS_TO_FILTERS_GAP_PX }} />
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TradeFilterChip label="24h" />
          <View style={{ width: FILTER_ROW_GAP_PX }} />
          <TradeFilterChip label="Any chain" />
        </View>

        <View style={{ height: SECTION_GAP_PX }} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", width: "100%" }}>
          <Text style={{ fontSize: 11, lineHeight: 21, color: colors.secondary }}>COLLECTION / FLOOR</Text>
          <Text style={{ fontSize: 11, lineHeight: 21, color: colors.secondary }}>PLACE / VOL</Text>
        </View>

        <View style={{ height: SECTION_GAP_PX }} />
        {TRADE_SAMPLE_FEED_ITEMS.map((item, index) => (
          <TradeFeedRow
            key={item.timestamp}
            item={item}
            icon={tradeFeedItemImages[index]!}
            colors={colors}
            isLast={index === TRADE_SAMPLE_FEED_ITEMS.length - 1}
          />
        ))}
        <View style={{ height: SECTION_GAP_PX }} />
      </HspScrollColumn>
    </View>
  );
}

