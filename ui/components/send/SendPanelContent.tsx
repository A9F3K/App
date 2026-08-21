import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useCallback, useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { setSendFormAddress, setSendFormComment, useSendFormState } from "../../send/sendFormStore";
import { SCROLL_INDICATOR_SCROLL_EPS } from "../../scrollIndicatorPx";
import { HspScrollColumn, type HspScrollMetrics } from "../HspScrollColumn";
import { PanelGradientCtaBlock } from "../PanelGradientCtaBlock";
import { SendGetTitleRow } from "../transfer/SendGetTitleRow";
import { SwapSelectChevron } from "../swap/SwapFormIcons";
import { swapDllrTokenImage } from "../swap/swapFormAssets";
import {
  layout,
  typographyAeroport15,
  typographyAeroport20,
  useColors,
} from "../../theme";
import { SendActionRow } from "./SendActionRow";

const TOP_INSET_PX = 15;
const TITLE_TO_SEND_GAP_PX = 20;
const SECTION_GAP_PX = 15;
const ADDRESS_SECTION_GAP_PX = 30;
const SEND_MUTED = "#818181";

const amountTextStyle = [typographyAeroport20, { fontWeight: "500" as const }];
const muted15 = [typographyAeroport15, { color: SEND_MUTED }];
const label20 = typographyAeroport20;
const action15 = [typographyAeroport15, { fontWeight: "400" as const }];

function SendLabelActionRow({
  label,
  action,
  onActionPress,
}: {
  label: string;
  action: string;
  onActionPress?: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
    >
      <Text style={[label20, { color: colors.primary }]}>{label}</Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onActionPress}>
        <Text style={[action15, { color: colors.primary }]}>{action}</Text>
      </Pressable>
    </View>
  );
}

/** Send panel body (prev-main `SendPage`). */
export function SendPanelContent() {
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const showWalletTitleRow = windowWidth <= layout.authenticatedHome.firstBreakpoint;
  const showSendActionBlock = windowWidth <= layout.authenticatedHome.secondBreakpoint;
  const contentInset = layout.contentSideInsetPx;
  const scrollShellBleed = { marginHorizontal: -contentInset };
  const scrollContentPadding = {
    paddingTop: TOP_INSET_PX,
    paddingHorizontal: contentInset,
    paddingBottom: TOP_INSET_PX,
  };

  const [needsScroll, setNeedsScroll] = useState<boolean | null>(null);
  const scrollLayoutReady = needsScroll !== null;
  const { address, comment } = useSendFormState();
  const [ctaHeightPx, setCtaHeightPx] = useState(0);

  const onScrollMetrics = useCallback((metrics: Omit<HspScrollMetrics, "scrollY">) => {
    if (!(metrics.layoutH > 0)) return;
    const overflow = metrics.contentH > metrics.layoutH + SCROLL_INDICATOR_SCROLL_EPS;
    setNeedsScroll((prev) => {
      if (overflow) return true;
      if (prev === true) return true;
      return false;
    });
  }, []);

  const pasteIntoAddress = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setSendFormAddress(text.trim());
  }, []);

  const pasteIntoComment = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setSendFormComment(text.trim());
  }, []);

  const onCtaHeightChange = useCallback((heightPx: number) => {
    setCtaHeightPx((current) => (current === heightPx ? current : heightPx));
  }, []);

  const inputStyle = [
    typographyAeroport15,
    {
      fontWeight: "500" as const,
      lineHeight: 30,
      color: colors.primary,
      width: "100%" as const,
      ...(Platform.OS === "web"
        ? ({ outlineStyle: "none" } as Record<string, string>)
        : {}),
    },
  ];

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        onMetricsChange={onScrollMetrics}
        scrollIndicatorExtendBottomPx={showSendActionBlock ? ctaHeightPx : 0}
        contentContainerStyle={
          scrollLayoutReady && !needsScroll
            ? {
                ...scrollContentPadding,
                flexGrow: 1,
              }
            : scrollContentPadding
        }
      >
        {showWalletTitleRow ? (
          <>
            <SendGetTitleRow />
            <View style={{ height: TITLE_TO_SEND_GAP_PX }} />
          </>
        ) : null}

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <Text style={[label20, { color: colors.primary }]}>Send</Text>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Image source={swapDllrTokenImage} style={{ width: 20, height: 20 }} contentFit="contain" />
            <View style={{ width: 8 }} />
            <Text style={[amountTextStyle, { color: colors.primary }]}>dllr</Text>
            <View style={{ width: 8 }} />
            <SwapSelectChevron />
          </View>
        </View>

        <View style={{ height: SECTION_GAP_PX }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <Text style={[amountTextStyle, { color: colors.primary }]}>1</Text>
          <Text style={[action15, { color: colors.primary }]}>max.</Text>
        </View>

        <View style={{ height: SECTION_GAP_PX }} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <Text style={muted15}>1$</Text>
          <Text style={muted15}>having 1 dllr on ton</Text>
        </View>

        <View style={{ height: ADDRESS_SECTION_GAP_PX }} />
        <SendLabelActionRow label="Address" action="paste." onActionPress={() => void pasteIntoAddress()} />
        <View style={{ height: SECTION_GAP_PX }} />
        <TextInput
          value={address}
          onChangeText={setSendFormAddress}
          placeholder="Enter address"
          placeholderTextColor={colors.secondary}
          style={inputStyle}
          cursorColor={colors.primary}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={{ height: ADDRESS_SECTION_GAP_PX }} />
        <SendLabelActionRow
          label="Comment / Memo"
          action="paste."
          onActionPress={() => void pasteIntoComment()}
        />
        <View style={{ height: SECTION_GAP_PX }} />
        <TextInput
          value={comment}
          onChangeText={setSendFormComment}
          placeholder="Enter comment / memo"
          placeholderTextColor={colors.secondary}
          style={inputStyle}
          cursorColor={colors.primary}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={{ height: TOP_INSET_PX }} />
      </HspScrollColumn>
      {showSendActionBlock ? (
        <PanelGradientCtaBlock onHeightChange={onCtaHeightChange}>
          <SendActionRow density="compact" />
        </PanelGradientCtaBlock>
      ) : null}
    </View>
  );
}
