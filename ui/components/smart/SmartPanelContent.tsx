import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { useAuthenticatedHomeSplitLayoutMetrics } from "../AuthenticatedHomeSplitLayoutMetricsContext";
import { logPageDisplay } from "../../pageDisplayLog";
import { useObservedWidth } from "../../smart/useObservedWidth";
import {
  smartLeadEnImage,
  smartLeadRuImage,
  SMART_LEAD_HEIGHT_COMPACT_PX,
  SMART_LEAD_WIDTH_BREAKPOINT_PX,
  smartLeadHeightPxForWidth,
} from "../../smart/smartAssets";
import { layout, typographyAeroport20, typographyRect15, useColors } from "../../theme";
import { HspScrollColumn } from "../HspScrollColumn";
import { PanelGradientCtaBlock } from "../PanelGradientCtaBlock";
import { SmartActionRow } from "./SmartActionRow";
import { SmartLeadImage } from "./SmartLeadImage";
import { SmartPurposeSection } from "./SmartPurposeSection";

const TOP_INSET_PX = 30;
const BOTTOM_INSET_PX = 30;
const SECTION_GAP_PX = 15;
const LEAD_TO_TITLE_GAP_PX = 30;
const TITLE_FONT_SIZE_PX = 40;
const TITLE_LINE_HEIGHT_PX = 55;
const TITLE_TO_INTRO_GAP_PX = 15;
const INTRO_FONT_SIZE_PX = 15;
const INTRO_LINE_HEIGHT_PX = 30;
const INTRO_TO_PURPOSE_GAP_PX = 20;

/** Smart panel body: deploy flow (wide split column + narrow `/smart`). */
export function SmartPanelContent() {
  const colors = useColors();
  const { t, locale } = useAppStrings();
  const { width: windowWidth } = useWindowDimensions();
  const showSmartActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  const [ctaHeightPx, setCtaHeightPx] = useState(0);
  const onCtaHeightChange = useCallback((heightPx: number) => {
    setCtaHeightPx((current) => (current === heightPx ? current : heightPx));
  }, []);
  const splitMetrics = useAuthenticatedHomeSplitLayoutMetrics();
  const leadSource = locale === "ru" ? smartLeadRuImage : smartLeadEnImage;
  const contentInset = layout.contentSideInsetPx;
  const scrollShellBleed = { marginHorizontal: -contentInset };
  const scrollContentPadding = {
    paddingTop: TOP_INSET_PX,
    paddingHorizontal: contentInset,
    paddingBottom: BOTTOM_INSET_PX,
  };
  const { widthPx: observedPanelWidthPx, onLayout: onPanelLayout, onRef: onPanelRef } =
    useObservedWidth("smart_panel_root");

  const splitPanelWidthPx = useMemo(() => {
    const middleColumnWidthPx = splitMetrics?.middleColumnWidthPx ?? 0;
    if (middleColumnWidthPx <= 0) {
      return 0;
    }
    return Math.max(0, middleColumnWidthPx - 2 * contentInset);
  }, [contentInset, splitMetrics?.middleColumnWidthPx]);

  const panelWidthPx =
    observedPanelWidthPx > 0
      ? observedPanelWidthPx
      : splitPanelWidthPx > 0
        ? splitPanelWidthPx
        : 0;
  const panelWidthSource =
    observedPanelWidthPx > 0
      ? "observed_panel_root"
      : splitPanelWidthPx > 0
        ? "split_middle_column"
        : "none";
  const leadHeightPx = smartLeadHeightPxForWidth(panelWidthPx);
  const lastLoggedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = [
      panelWidthPx,
      panelWidthSource,
      splitMetrics?.middleColumnWidthPx ?? 0,
      observedPanelWidthPx,
      leadHeightPx,
    ].join("|");
    if (lastLoggedKeyRef.current === key) {
      return;
    }
    lastLoggedKeyRef.current = key;
    logPageDisplay("smart_panel_layout_width", {
      panelWidthPx,
      panelWidthSource,
      leadHeightPx,
      compactLead: leadHeightPx === SMART_LEAD_HEIGHT_COMPACT_PX,
      breakpointPx: SMART_LEAD_WIDTH_BREAKPOINT_PX,
      observedPanelWidthPx: observedPanelWidthPx > 0 ? observedPanelWidthPx : null,
      splitMiddleColumnWidthPx: splitMetrics?.middleColumnWidthPx ?? null,
      splitPanelWidthPx: splitPanelWidthPx > 0 ? splitPanelWidthPx : null,
      splitRowWidthPx: splitMetrics?.splitRowWidthPx ?? null,
      splitColumnCount: splitMetrics?.columnCount ?? null,
      contentInsetPx: contentInset,
    });
  }, [
    contentInset,
    leadHeightPx,
    observedPanelWidthPx,
    panelWidthPx,
    panelWidthSource,
    splitMetrics?.columnCount,
    splitMetrics?.middleColumnWidthPx,
    splitMetrics?.splitRowWidthPx,
    splitPanelWidthPx,
  ]);

  return (
    <View
      ref={onPanelRef ? (node) => onPanelRef(node) : undefined}
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
      onLayout={onPanelLayout}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        contentContainerStyle={scrollContentPadding}
        scrollIndicatorExtendBottomPx={showSmartActionBlock ? ctaHeightPx : 0}
        indicatorColor={colors.primary}
      >
        <SmartLeadImage source={leadSource} layoutWidthPx={panelWidthPx} />
        <View style={{ height: LEAD_TO_TITLE_GAP_PX }} />
        <Text
          style={[
            typographyAeroport20,
            {
              fontSize: TITLE_FONT_SIZE_PX,
              lineHeight: TITLE_LINE_HEIGHT_PX,
              color: colors.primary,
            },
          ]}
        >
          {t("smart.deployTitle")}
        </Text>

        <View style={{ height: TITLE_TO_INTRO_GAP_PX }} />
        <Text
          style={[
            typographyRect15,
            {
              fontSize: INTRO_FONT_SIZE_PX,
              lineHeight: INTRO_LINE_HEIGHT_PX,
              color: colors.primary,
            },
          ]}
        >
          {t("smart.intro")}
        </Text>

        <View style={{ height: INTRO_TO_PURPOSE_GAP_PX }} />
        <SmartPurposeSection purposeSubtitle={t("smart.purposeSubtitle")} />
      </HspScrollColumn>
      {showSmartActionBlock ? (
        <PanelGradientCtaBlock onHeightChange={onCtaHeightChange}>
          <SmartActionRow />
        </PanelGradientCtaBlock>
      ) : null}
    </View>
  );
}
