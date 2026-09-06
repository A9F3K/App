import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";

import { useAppStrings } from "../../locales/AppStringsContext";
import type { AppStringKey } from "../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import {
  scrollIndicatorThumbSpanAndOffset,
  snapScrollIndicatorCoordPx,
} from "../scrollIndicatorPx";
import { useColors } from "../theme";
import { useTelegram } from "../components/Telegram";
import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import { ScrollIndicatorDragHandle } from "../components/ScrollIndicatorDragHandle";
import { ProTariffCardFace } from "./ProTariffCardFace";
import { ProTariffUndercoverCanvas } from "./ProTariffUndercoverCanvas";
import {
  PRO_ACCESS_LIGHT_FIELD_MID,
  resolveProAccessMaterials,
  type ProAccessMaterials,
} from "./proAccessMaterials";
import {
  formatUsd,
  PRO_ACCESS_PLANS,
  type ProAccessPlan,
  type ProAccessPlanId,
} from "./proAccessStore";

const CARD_GAP_PX = 10;
const CARD_MIN_W_PX = 156;
const CARD_H_PX = 148;
const SCROLL_EPS = 2;

function planLabelKey(id: ProAccessPlanId): AppStringKey {
  if (id === "month") return "pro.plan.month";
  if (id === "quarter") return "pro.plan.quarter";
  return "pro.plan.year";
}

function scrollSpanFromContentSize(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (Platform.OS === "web") return Math.max(w, h);
  return w;
}

function pickWebHorizontalScrollEl(root: Element | null): HTMLElement | null {
  if (!root) return null;
  const candidates: HTMLElement[] = [];
  const walk = (el: Element) => {
    const h = el as HTMLElement;
    if (h.scrollWidth - h.clientWidth > 2 && h.clientWidth > 0) candidates.push(h);
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]!);
  };
  walk(root);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.scrollWidth >= b.scrollWidth ? a : b));
}

function findParentVerticalScrollEl(from: HTMLElement): HTMLElement | null {
  let n: HTMLElement | null = from.parentElement;
  while (n) {
    const style = typeof window !== "undefined" ? window.getComputedStyle(n) : null;
    const oy = style?.overflowY ?? "";
    const canScroll =
      n.scrollHeight > n.clientHeight + 2 &&
      (oy === "auto" ||
        oy === "scroll" ||
        oy === "overlay" ||
        n.classList.contains("hsp-scroll-column-overscroll-contain"));
    if (canScroll) return n;
    n = n.parentElement;
  }
  return null;
}

type Props = {
  planId: ProAccessPlanId;
  onSelectPlan: (id: ProAccessPlanId) => void;
  contentPadX: number;
};

/**
 * Full-bleed tariff band: horizontal cards only on horizontal wheel/gesture;
 * vertical wheel is forwarded to the dialog body scroller.
 */
export function ProTariffCarousel({ planId, onSelectPlan, contentPadX }: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const lightTheme = colorScheme === "light";
  const materials = useMemo(
    () => resolveProAccessMaterials(colors, lightTheme),
    [colors, lightTheme],
  );
  const { t, tf } = useAppStrings();
  const scrollRef = useRef<ScrollView>(null);
  const bandRef = useRef<View>(null);
  const [viewportW, setViewportW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [scrollX, setScrollX] = useState(0);

  const cardW = Math.max(
    CARD_MIN_W_PX,
    Math.min(200, Math.round((viewportW || 320) * 0.58)),
  );
  const estimatedContentW =
    PRO_ACCESS_PLANS.length * cardW + (PRO_ACCESS_PLANS.length - 1) * CARD_GAP_PX + contentPadX * 2;
  const contentSpan = Math.max(contentW, estimatedContentW);
  const scrollRange = Math.max(0, contentSpan - viewportW);
  const overflows = scrollRange > SCROLL_EPS;

  const { thumbSpan, thumbOffset } = useMemo(
    () =>
      scrollIndicatorThumbSpanAndOffset(
        viewportW,
        viewportW,
        contentSpan,
        scrollX,
        scrollRange,
      ),
    [viewportW, contentSpan, scrollX, scrollRange],
  );
  const thumbSnapW = snapScrollIndicatorCoordPx(thumbSpan);
  const thumbSnapLeft = snapScrollIndicatorCoordPx(thumbOffset);

  const onViewportLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setViewportW((prev) => (prev === w ? prev : w));
  }, []);

  const onContentSizeChange = useCallback((w: number) => {
    const next = Math.round(w);
    setContentW((prev) => (prev === next ? prev : next));
  }, []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = Math.max(0, Math.round(e.nativeEvent.contentOffset.x));
    setScrollX(x);
    const cw = scrollSpanFromContentSize(
      e.nativeEvent.contentSize.width,
      e.nativeEvent.contentSize.height,
    );
    if (cw > 0) setContentW((prev) => Math.max(prev, Math.round(cw)));
  }, []);

  const scrollToX = useCallback(
    (x: number) => {
      const clamped = Math.max(0, Math.min(Math.round(x), scrollRange));
      scrollRef.current?.scrollTo({ x: clamped, animated: false });
      setScrollX(clamped);
    },
    [scrollRange],
  );

  /** Axis-lock wheel: horizontal → cards; vertical → parent dialog scroller. */
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const root = bandRef.current as unknown as HTMLElement | null;
    if (!root) return;

    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      if (absX < 0.5 && absY < 0.5) return;

      const horizontalIntent = e.shiftKey || absX > absY + 0.25;
      const hScroll = pickWebHorizontalScrollEl(root);

      if (horizontalIntent && overflows && hScroll) {
        const delta = e.shiftKey && absX <= absY ? e.deltaY : absX > 0.5 ? e.deltaX : e.deltaY;
        const max = Math.max(0, hScroll.scrollWidth - hScroll.clientWidth);
        const next = Math.max(0, Math.min(max, hScroll.scrollLeft + delta));
        if (next !== hScroll.scrollLeft) {
          e.preventDefault();
          e.stopPropagation();
          hScroll.scrollLeft = next;
          setScrollX(Math.round(next));
        } else {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // Vertical (or no horizontal overflow): never let the card strip consume it.
      const parent = findParentVerticalScrollEl(root);
      if (!parent) return;
      e.preventDefault();
      e.stopPropagation();
      parent.scrollTop += e.deltaY !== 0 ? e.deltaY : e.deltaX;
    };

    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => root.removeEventListener("wheel", onWheel, true);
  }, [overflows]);

  const undercoverStyle = useMemo((): ViewStyle => {
    return {
      borderRadius: 0,
      position: "relative",
      width: "100%",
      alignSelf: "stretch",
      backgroundColor: materials.field,
      // Visible so the bottom scroll thumb is not clipped; cards clip inside an inner shell.
      overflow: "visible",
      ...(lightTheme
        ? {
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderTopColor: "rgba(0,0,0,0.16)",
            borderBottomColor: "rgba(0,0,0,0.12)",
          }
        : null),
    };
  }, [materials.field, lightTheme]);

  /** Match dialog chrome stroke (1 CSS px). */
  const trackH = 1;

  return (
    <View style={{ gap: 10, width: "100%", alignSelf: "stretch" }}>
      <Text
        style={{
          color: materials.ink,
          fontSize: 14,
          fontWeight: "600",
          letterSpacing: 0.2,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          paddingHorizontal: contentPadX,
        }}
      >
        {t("pro.sale.choosePlan")}
      </Text>

      <View ref={bandRef} onLayout={onViewportLayout} style={undercoverStyle}>
        <View
          style={{
            overflow: "hidden",
            position: "relative",
            width: "100%",
            borderRadius: 0,
          }}
        >
          <ProTariffUndercoverCanvas
            undercover={materials.field}
            background={lightTheme ? PRO_ACCESS_LIGHT_FIELD_MID : materials.plate}
            highlight={materials.chrome}
            primary={materials.metalInk}
            lightTheme={lightTheme}
          />

          <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={overflows}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={onContentSizeChange}
            style={{ width: "100%", zIndex: 2 }}
            contentContainerStyle={{
              paddingHorizontal: contentPadX,
              paddingTop: 14,
              paddingBottom: overflows ? 14 : 14,
              flexDirection: "row",
              alignItems: "stretch",
              gap: CARD_GAP_PX,
              flexGrow: 1,
              justifyContent: overflows ? "flex-start" : "center",
            }}
            decelerationRate="fast"
            snapToInterval={overflows ? cardW + CARD_GAP_PX : undefined}
            snapToAlignment="start"
            disableIntervalMomentum={overflows}
            {...(Platform.OS === "web"
              ? ({
                  // Prefer pointer/trackpad gestures; wheel is owned by the axis-lock handler.
                  dataSet: { hspTariffCards: "1" },
                } as object)
              : null)}
          >
            {PRO_ACCESS_PLANS.map((plan) => (
              <TariffCard
                key={plan.id}
                plan={plan}
                selected={plan.id === planId}
                widthPx={cardW}
                materials={materials}
                lightTheme={lightTheme}
                title={t(planLabelKey(plan.id))}
                perMonth={tf("pro.plan.perMonth", { price: formatUsd(plan.monthlyUsd) })}
                bestValueLabel={plan.highlight ? t("pro.plan.bestValue") : null}
                selectedLabel={t("pro.sale.selected")}
                tapLabel={t("pro.sale.tapToSelect")}
                onPress={() => onSelectPlan(plan.id)}
              />
            ))}
          </ScrollView>
        </View>

        {overflows && viewportW > 0 && thumbSnapW > 0 ? (
          <View
            pointerEvents="box-none"
            collapsable={false}
            {...(Platform.OS === "web"
              ? ({ dataSet: { hspTariffScrollIndicator: "1" } } as object)
              : null)}
            style={{
              width: "100%",
              height: trackH,
              marginTop: 0,
              backgroundColor: colors.highlight,
              overflow: "visible",
            }}
          >
            <ScrollIndicatorDragHandle
              axis="horizontal"
              trackSpan={viewportW}
              thumbSpan={thumbSnapW}
              thumbOffset={thumbSnapLeft}
              scrollRange={scrollRange}
              onScrollTo={scrollToX}
              crossAxisVisualSpan={trackH}
            >
              <View
                pointerEvents="none"
                collapsable={false}
                style={{
                  width: thumbSnapW,
                  height: trackH,
                  backgroundColor: colors.scrollIndicator,
                  flexGrow: 0,
                  flexShrink: 0,
                }}
              />
            </ScrollIndicatorDragHandle>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TariffCard({
  plan,
  selected,
  widthPx,
  materials,
  lightTheme,
  title,
  perMonth,
  bestValueLabel,
  selectedLabel,
  tapLabel,
  onPress,
}: {
  plan: ProAccessPlan;
  selected: boolean;
  widthPx: number;
  materials: ProAccessMaterials;
  lightTheme: boolean;
  title: string;
  perMonth: string;
  bestValueLabel: string | null;
  selectedLabel: string;
  tapLabel: string;
  onPress: () => void;
}) {
  const [hover, setHover] = useState(false);

  const web3d =
    Platform.OS === "web"
      ? ({
          transform: selected || hover
            ? "perspective(900px) rotateY(-1deg) rotateX(0.8deg) translateZ(1px)"
            : "perspective(900px) rotateY(0deg) rotateX(0deg) translateZ(0px)",
          transformStyle: "preserve-3d",
          transition: "transform 180ms ease, box-shadow 180ms ease, border-color 160ms ease",
          boxShadow: lightTheme
            ? selected
              ? `0 3px 12px rgba(0,0,0,0.28), 0 0 0 2px ${HYPERLINKS_SPACE_LOGO_GREEN}, inset 0 1px 0 rgba(255,255,255,0.1)`
              : hover
                ? `0 2px 8px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.55)`
                : `0 2px 6px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.4)`
            : selected
              ? `0 4px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)`
              : hover
                ? `0 3px 8px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)`
                : `0 2px 6px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.03)`,
        } as object)
      : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      onHoverIn={Platform.OS === "web" ? () => setHover(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => setHover(false) : undefined}
      style={({ pressed }) => ({
        width: widthPx,
        height: CARD_H_PX,
        borderRadius: 12,
        overflow: "hidden",
        opacity: pressed ? 0.94 : 1,
        zIndex: selected ? 3 : 2,
        backgroundColor: materials.plate,
        borderWidth: selected ? (lightTheme ? 2 : 1.5) : 1,
        borderColor: selected
          ? lightTheme
            ? HYPERLINKS_SPACE_LOGO_GREEN
            : "#FFFFFF"
          : materials.chrome,
        ...web3d,
      })}
    >
      <ProTariffCardFace
        selected={selected}
        undercover={materials.plate}
        background={selected ? materials.porcelain : materials.plate}
        highlight={materials.chrome}
        primary={lightTheme && selected ? HYPERLINKS_SPACE_LOGO_GREEN : materials.metalInk}
        lightTheme={lightTheme}
      />

      <View style={{ flex: 1, padding: 14, justifyContent: "space-between", zIndex: 1 }}>
        <View style={{ gap: 5 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text
              style={{
                color: materials.metalInk,
                fontSize: 14,
                fontWeight: "600",
                letterSpacing: 0.15,
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {title}
            </Text>
            {bestValueLabel ? (
              <View
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 6,
                  backgroundColor: materials.porcelain,
                  borderWidth: 1,
                  borderColor: materials.chrome,
                  flexShrink: 0,
                  ...(Platform.OS === "web"
                    ? ({
                        boxShadow: `inset 0 1px 0 ${materials.chrome}66`,
                      } as object)
                    : null),
                }}
              >
                <Text
                  style={{
                    color: materials.metalMuted,
                    fontSize: 10,
                    fontWeight: "700",
                    letterSpacing: 0.3,
                  }}
                >
                  {bestValueLabel}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={{ gap: 2 }}>
          <Text
            style={{
              color: materials.metalMuted,
              fontSize: 12,
              lineHeight: 16,
              fontWeight: "600",
              fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
            }}
          >
            {perMonth}
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {plan.listPriceUsd != null && plan.listPriceUsd > plan.priceUsd ? (
              <Text
                style={{
                  color: materials.metalMuted,
                  fontSize: 16,
                  lineHeight: 30,
                  fontWeight: "600",
                  fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                  textDecorationLine: "line-through",
                  ...(Platform.OS === "web"
                    ? ({ textDecorationColor: materials.metalMuted } as object)
                    : null),
                }}
              >
                {formatUsd(plan.listPriceUsd)}
              </Text>
            ) : null}
            <Text
              style={{
                color: materials.metalInk,
                fontSize: 26,
                lineHeight: 30,
                fontWeight: "700",
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
              }}
            >
              {formatUsd(plan.priceUsd)}
            </Text>
          </View>
          <Text
            style={{
              color: selected ? materials.metalInk : materials.metalMuted,
              fontSize: 11,
              fontWeight: "600",
              letterSpacing: 0.4,
            }}
          >
            {selected ? selectedLabel : tapLabel}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
