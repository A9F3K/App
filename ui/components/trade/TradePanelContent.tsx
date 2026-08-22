import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { SCROLL_INDICATOR_SCROLL_EPS } from "../../scrollIndicatorPx";
import { HspScrollColumn, type HspScrollMetrics } from "../HspScrollColumn";
import {
  MessageChatVoiceMoreMenu,
  type VoiceMoreMenuAnchor,
  type VoiceMoreMenuItem,
} from "../messages/MessageChatVoiceMoreMenu";
import { PanelGradientCtaBlock } from "../PanelGradientCtaBlock";
import { TradeActionRow } from "./TradeActionRow";
import { TradeCollectionCarousel } from "./TradeCollectionCarousel";
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
const COLLECTION_AUTO_SLIDE_MS = 5000;
const COLLECTION_ITEMS_PER_SLIDE = 4;
const MENU_BELOW_CHIP_GAP_PX = 6;

type TradeFeedTab = "trending" | "cap" | "reach";
type TradeFilterMenuKind = "period" | "chain";

type TradePeriodKey = "24h" | "1w" | "1m" | "3m" | "6m" | "1y" | "all";
type TradeChainKey = "ton" | "eth";

const TRADE_FEED_TABS: { key: TradeFeedTab; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "cap", label: "Cap" },
  { key: "reach", label: "Reach" },
];

const TRADE_PERIOD_OPTIONS: { key: TradePeriodKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "1w", label: "1w" },
  { key: "1m", label: "1m" },
  { key: "3m", label: "3m" },
  { key: "6m", label: "6m" },
  { key: "1y", label: "1y" },
  { key: "all", label: "All" },
];

const TRADE_CHAIN_OPTIONS: { key: TradeChainKey; label: string }[] = [
  { key: "ton", label: "TON" },
  { key: "eth", label: "ETH" },
];

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

function TradeFilterChip({
  label,
  onPress,
  chipRef,
}: {
  label: string;
  onPress: () => void;
  chipRef: RefObject<View | null>;
}) {
  const colors = useColors();
  return (
    <View ref={chipRef} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={[typographyRect15, { fontSize: 15, lineHeight: 21, color: colors.primary }]}>
          {label}
        </Text>
        <View style={{ width: FILTER_ICON_GAP_PX }} />
        <Image source={tradeApIcon} style={{ width: 11, height: 11 }} contentFit="contain" />
      </Pressable>
    </View>
  );
}

/** Trade panel body (prev-main `TradePage`): collections, tabs, filters, and sample feed rows. */
export function TradePanelContent({ isActive = true }: { isActive?: boolean }) {
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const showTradeActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  const contentInset = layout.contentSideInsetPx;
  const [collectionsRowWidth, setCollectionsRowWidth] = useState(0);
  const [needsScroll, setNeedsScroll] = useState<boolean | null>(null);
  const scrollLayoutReady = needsScroll !== null;
  const [ctaHeightPx, setCtaHeightPx] = useState(0);

  const collectionColumnCount = useMemo(
    () => resolveTradeCollectionColumnCount(collectionsRowWidth, contentInset),
    [collectionsRowWidth, contentInset],
  );

  const slidesCount = Math.max(
    1,
    Math.ceil(TRADE_SAMPLE_COLLECTIONS.length / COLLECTION_ITEMS_PER_SLIDE),
  );
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [autoSlidePausedByUser, setAutoSlidePausedByUser] = useState(false);
  const [activeFeedTab, setActiveFeedTab] = useState<TradeFeedTab>("trending");
  const [period, setPeriod] = useState<TradePeriodKey>("24h");
  const [chain, setChain] = useState<TradeChainKey | null>(null);
  const [openMenu, setOpenMenu] = useState<TradeFilterMenuKind | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<VoiceMoreMenuAnchor | null>(null);
  const periodChipRef = useRef<View | null>(null);
  const chainChipRef = useRef<View | null>(null);

  const periodLabel =
    TRADE_PERIOD_OPTIONS.find((option) => option.key === period)?.label ?? "24h";
  const chainLabel =
    TRADE_CHAIN_OPTIONS.find((option) => option.key === chain)?.label ?? "Any chain";

  const closeFilterMenu = useCallback(() => {
    setOpenMenu(null);
    setMenuAnchor(null);
  }, []);

  const openFilterMenu = useCallback(
    (kind: TradeFilterMenuKind, chip: View | null) => {
      const node = chip as unknown as {
        measureInWindow?: (
          cb: (x: number, y: number, width: number, height: number) => void,
        ) => void;
      } | null;
      const show = (anchor: VoiceMoreMenuAnchor) => {
        setMenuAnchor(anchor);
        setOpenMenu(kind);
      };
      if (node && typeof node.measureInWindow === "function") {
        node.measureInWindow((x, y, _width, height) => {
          show({
            x: Math.round(x),
            y: Math.round(y + height + MENU_BELOW_CHIP_GAP_PX),
          });
        });
        return;
      }
      show({ x: contentInset, y: 120 });
    },
    [contentInset],
  );

  const periodMenuItems = useMemo((): VoiceMoreMenuItem[] => {
    return TRADE_PERIOD_OPTIONS.map((option) => ({
      key: option.key,
      label: option.label,
      onPress: () => {
        setPeriod(option.key);
        closeFilterMenu();
      },
    }));
  }, [closeFilterMenu]);

  const chainMenuItems = useMemo((): VoiceMoreMenuItem[] => {
    return TRADE_CHAIN_OPTIONS.map((option) => ({
      key: option.key,
      label: option.label,
      onPress: () => {
        setChain(option.key);
        closeFilterMenu();
      },
    }));
  }, [closeFilterMenu]);

  const onSelectSlide = useCallback((index: number) => {
    setAutoSlidePausedByUser(true);
    setActiveSlideIndex(index);
  }, []);

  const pauseAutoSlide = useCallback(() => {
    setAutoSlidePausedByUser(true);
  }, []);

  // Leaving trade clears a manual dot selection so auto-slide resumes on return.
  useEffect(() => {
    if (isActive) return;
    setAutoSlidePausedByUser(false);
    closeFilterMenu();
  }, [closeFilterMenu, isActive]);

  const collectionAutoSlideRunning = isActive && !autoSlidePausedByUser;

  // First auto-advance waits COLLECTION_AUTO_SLIDE_MS; later ones repeat on that interval.
  useEffect(() => {
    if (!collectionAutoSlideRunning) return;

    let intervalId: ReturnType<typeof setInterval> | undefined;
    const timeoutId = setTimeout(() => {
      setActiveSlideIndex((v) => (v + 1) % slidesCount);
      intervalId = setInterval(() => {
        setActiveSlideIndex((v) => (v + 1) % slidesCount);
      }, COLLECTION_AUTO_SLIDE_MS);
    }, COLLECTION_AUTO_SLIDE_MS);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId != null) clearInterval(intervalId);
    };
  }, [collectionAutoSlideRunning, slidesCount]);

  const onScrollMetrics = useCallback((metrics: Omit<HspScrollMetrics, "scrollY">) => {
    if (!(metrics.layoutH > 0)) return;
    const overflow = metrics.contentH > metrics.layoutH + SCROLL_INDICATOR_SCROLL_EPS;
    setNeedsScroll((prev) => {
      if (overflow) return true;
      if (prev === true) return true;
      return false;
    });
  }, []);

  const onCtaHeightChange = useCallback((heightPx: number) => {
    setCtaHeightPx((current) => (current === heightPx ? current : heightPx));
  }, []);

  const scrollShellBleed = { marginHorizontal: -contentInset };
  const scrollContentPadding = {
    paddingTop: TOP_INSET_PX,
    paddingHorizontal: contentInset,
    paddingBottom: TOP_INSET_PX,
  };

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        onMetricsChange={onScrollMetrics}
        scrollIndicatorExtendBottomPx={showTradeActionBlock ? ctaHeightPx : 0}
        contentContainerStyle={
          scrollLayoutReady && !needsScroll
            ? {
                ...scrollContentPadding,
                flexGrow: 1,
              }
            : scrollContentPadding
        }
      >
        <TradeCollectionCarousel
          collections={TRADE_SAMPLE_COLLECTIONS}
          itemsPerSlide={COLLECTION_ITEMS_PER_SLIDE}
          columnCount={collectionColumnCount}
          gapPx={contentInset}
          activeIndex={activeSlideIndex}
          colors={colors}
          onActiveIndexChange={onSelectSlide}
          onUserInteract={pauseAutoSlide}
          onWidthChange={setCollectionsRowWidth}
        />

        <View style={{ height: SECTION_GAP_PX }} />
        <TradePaginationDots
          activeIndex={activeSlideIndex}
          count={slidesCount}
          onPressIndex={onSelectSlide}
        />

        <View style={{ height: TABS_AFTER_DOTS_GAP_PX }} />
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          {TRADE_FEED_TABS.map((tab, index) => (
            <Fragment key={tab.key}>
              {index > 0 ? <View style={{ width: TAB_GAP_PX }} /> : null}
              <Pressable
                onPress={() => setActiveFeedTab(tab.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: activeFeedTab === tab.key }}
              >
                <Text
                  selectable={false}
                  style={[
                    typographyRect15,
                    {
                      fontSize: 20,
                      lineHeight: 15,
                      color: activeFeedTab === tab.key ? colors.primary : colors.secondary,
                    },
                  ]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            </Fragment>
          ))}
        </View>

        <View style={{ height: TABS_TO_FILTERS_GAP_PX }} />
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TradeFilterChip
            label={periodLabel}
            chipRef={periodChipRef}
            onPress={() => openFilterMenu("period", periodChipRef.current)}
          />
          <View style={{ width: FILTER_ROW_GAP_PX }} />
          <TradeFilterChip
            label={chainLabel}
            chipRef={chainChipRef}
            onPress={() => openFilterMenu("chain", chainChipRef.current)}
          />
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
      {showTradeActionBlock ? (
        <PanelGradientCtaBlock onHeightChange={onCtaHeightChange}>
          <TradeActionRow density="compact" />
        </PanelGradientCtaBlock>
      ) : null}

      <MessageChatVoiceMoreMenu
        visible={openMenu != null}
        anchor={menuAnchor}
        colors={colors}
        items={openMenu === "chain" ? chainMenuItems : periodMenuItems}
        onClose={closeFilterMenu}
      />
    </View>
  );
}
