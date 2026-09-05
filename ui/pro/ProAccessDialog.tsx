import { useEffect, useMemo, useState } from "react";
import { Platform, Text, useWindowDimensions, View } from "react-native";

import { useAppStrings } from "../../locales/AppStringsContext";
import type { AppStringKey } from "../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { useColors } from "../theme";
import { useTelegram } from "../components/Telegram";
import { FloatingDialogShell } from "../components/FloatingDialogShell";
import { FloatingDialogBody } from "../components/FloatingDialogBody";
import { FloatingDialogStickyHeader } from "../components/FloatingDialogStickyHeader";
import { resolveFloatingDialogInsets } from "../components/floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../components/floatingDialogGeometry";
import { FloatingDialogScrollChromeProvider } from "../components/floatingDialogScrollChrome";
import { HspScrollColumn } from "../components/HspScrollColumn";
import { SmartGradientDivider } from "../components/smart/SmartGradientDivider";
import {
  formatUsd,
  PRO_ACCESS_FEATURES,
  PRO_ACCESS_PLANS,
  type ProAccessPlanId,
} from "./proAccessStore";
import { resolveProAccessMaterials } from "./proAccessMaterials";
import { ProFeatureIcon } from "./ProFeatureIcon";
import { ProTariffCarousel } from "./ProTariffCarousel";
import { ProSubscribeButton } from "./ProSubscribeButton";
import { ProPaymentMethodsDialog } from "./ProPaymentMethodsDialog";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function ProAccessDialog({ visible, onClose }: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const lightTheme = colorScheme === "light";
  const materials = useMemo(
    () => resolveProAccessMaterials(colors, lightTheme),
    [colors, lightTheme],
  );
  const { t, tf } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [planId, setPlanId] = useState<ProAccessPlanId>("month");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [headerExtendPx, setHeaderExtendPx] = useState(0);

  useEffect(() => {
    if (!visible) setPaymentOpen(false);
  }, [visible]);

  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "pro"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const selected = PRO_ACCESS_PLANS.find((p) => p.id === planId) ?? PRO_ACCESS_PLANS[0]!;

  const tariffsVisible = visible && !paymentOpen;

  const onSubscribe = () => {
    setPaymentOpen(true);
  };

  const onCloseAll = () => {
    setPaymentOpen(false);
    onClose();
  };

  const onBackToTariffs = () => {
    setPaymentOpen(false);
  };

  const ink = materials.ink;
  const muted = materials.muted;

  return (
    <>
      <FloatingDialogShell
        visible={tariffsVisible}
        zIndex={12050}
        defaultSize={defaultSize}
        minSize={{ width: 340, height: 420 }}
        sizeStorageKey="hsp.proAccess.size.v1"
        onRequestClose={onCloseAll}
        testId="pro-access"
      >
        <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
          <FloatingDialogBody>
            <FloatingDialogStickyHeader
              insets={dialogInsets}
              onClose={onCloseAll}
              closeLabel={t("common.close")}
              title={t("pro.sale.title")}
              onHeightChange={setHeaderExtendPx}
            />

            <HspScrollColumn
              style={{ flex: 1, minHeight: 0 }}
              containOverscroll
              scrollIndicatorOverlaySeam
              scrollIndicatorExtendTopPx={0}
              contentContainerStyle={{
                paddingTop: 14,
                paddingBottom: 22,
                gap: 22,
              }}
              scrollbarRightInsetPx={0}
              indicatorColor={colors.scrollIndicator}
            >
              <View style={{ paddingHorizontal: dialogInsets.padX, gap: 6 }}>
                <Text
                  style={{
                    color: ink,
                    fontSize: 22,
                    lineHeight: 28,
                    fontWeight: "700",
                    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                  }}
                >
                  {t("pro.sale.headline")}
                </Text>
                <Text
                  style={{
                    color: muted,
                    fontSize: 14,
                    lineHeight: 20,
                    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                  }}
                >
                  {t("pro.sale.subtitle")}
                </Text>
              </View>

              <ProTariffCarousel
                planId={planId}
                onSelectPlan={setPlanId}
                contentPadX={dialogInsets.padX}
              />

              <View style={{ paddingHorizontal: dialogInsets.padX, gap: 16 }}>
                {PRO_ACCESS_FEATURES.map((feature) => (
                  <View
                    key={feature.id}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
                  >
                    <View
                      style={{
                        width: 26,
                        height: 24,
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: 0,
                      }}
                    >
                      <ProFeatureIcon
                        id={feature.id}
                        color={lightTheme ? materials.accent : colors.primary}
                        size={24}
                      />
                    </View>
                    <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                      <Text
                        style={{
                          color: ink,
                          fontSize: 14,
                          lineHeight: 24,
                          fontWeight: "700",
                          fontFamily:
                            Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                        }}
                      >
                        {t(feature.titleKey as AppStringKey)}
                      </Text>
                      <Text
                        style={{
                          color: muted,
                          fontSize: 13,
                          lineHeight: 18,
                          fontFamily:
                            Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                        }}
                      >
                        {t(feature.bodyKey as AppStringKey)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </HspScrollColumn>

            <View
              style={{
                flexShrink: 0,
                backgroundColor: colors.background,
                zIndex: 4,
              }}
            >
              <SmartGradientDivider bleedPastContentInset={false} horizontalPaddingPx={0} />
              <View
                style={{
                  paddingHorizontal: dialogInsets.padX,
                  paddingTop: 14,
                  paddingBottom: dialogInsets.headerPadBottom + 6,
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <ProSubscribeButton
                  label={tf("pro.sale.subscribe", { price: formatUsd(selected.priceUsd) })}
                  onPress={onSubscribe}
                />
                <Text
                  style={{
                    color: muted,
                    fontSize: 12,
                    lineHeight: 17,
                    textAlign: "center",
                    alignSelf: "stretch",
                  }}
                >
                  {t("pro.sale.footer")}
                </Text>
              </View>
            </View>
          </FloatingDialogBody>
        </FloatingDialogScrollChromeProvider>
      </FloatingDialogShell>

      <ProPaymentMethodsDialog
        visible={visible && paymentOpen}
        planId={planId}
        onClose={onCloseAll}
        onBackToTariffs={onBackToTariffs}
      />
    </>
  );
}
