import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";

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
import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import {
  cancelProAccessAtPeriodEnd,
  formatUsd,
  getLaunchedProFeatures,
  getProAccessPlans,
  getProAccessState,
  isProAccessActive,
  PRO_ACCESS_FEATURES,
  resumeProAccessRenewal,
  subscribeProAccess,
  type ProAccessPlanId,
} from "./proAccessStore";
import { refreshProCatalogFromServer, subscribeProCatalog } from "./proCatalogStore";
import { refreshAiFreeQuotaFromServer } from "../ai/aiFreeQuotaStore";
import { resolveProAccessMaterials } from "./proAccessMaterials";
import { ProFeatureIcon } from "./ProFeatureIcon";
import { ProSoonNameplate, PRO_SOON_NAMEPLATE_GAP_PX } from "./ProSoonNameplate";
import { ProTariffCarousel } from "./ProTariffCarousel";
import { ProSubscribeButton } from "./ProSubscribeButton";
import { ProPaymentMethodsDialog } from "./ProPaymentMethodsDialog";

type Props = {
  visible: boolean;
  onClose: () => void;
};

const labelFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;

function planLabelKey(id: ProAccessPlanId): AppStringKey {
  if (id === "quarter") return "pro.plan.quarter";
  if (id === "year") return "pro.plan.year";
  return "pro.plan.month";
}

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
  const [footerExtendPx, setFooterExtendPx] = useState(0);
  const plans = useSyncExternalStore(subscribeProCatalog, getProAccessPlans, getProAccessPlans);
  const launchedFeatures = useSyncExternalStore(
    subscribeProCatalog,
    getLaunchedProFeatures,
    getLaunchedProFeatures,
  );
  const proActive = useSyncExternalStore(subscribeProAccess, isProAccessActive, () => false);
  const proState = useSyncExternalStore(subscribeProAccess, getProAccessState, getProAccessState);
  const launchedIds = useMemo(
    () => new Set(launchedFeatures.map((f) => f.id)),
    [launchedFeatures],
  );

  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setFooterExtendPx(h);
  }, []);

  useEffect(() => {
    if (!visible) setPaymentOpen(false);
    else {
      void refreshProCatalogFromServer();
      void refreshAiFreeQuotaFromServer();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !proActive || !proState.planId) return;
    setPlanId(proState.planId);
  }, [visible, proActive, proState.planId]);

  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "pro"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const selected = plans.find((p) => p.id === planId) ?? plans[0]!;
  const activePlan =
    proActive && proState.planId
      ? plans.find((p) => p.id === proState.planId) ?? selected
      : selected;
  const activePlanLabel = t(planLabelKey(activePlan.id));
  const selectedPlanLabel = t(planLabelKey(selected.id));
  const switchingPlan = proActive && proState.planId != null && planId !== proState.planId;
  const expiresLabel = proState.expiresAt
    ? new Date(proState.expiresAt).toLocaleDateString()
    : "";

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
  const cancelRed = lightTheme ? "#C62828" : "#FF6B6B";
  const cancelChipBg = lightTheme ? "rgba(198,40,40,0.1)" : "rgba(255,107,107,0.14)";

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
        <FloatingDialogScrollChromeProvider
          headerExtendPx={headerExtendPx}
          footerExtendPx={footerExtendPx}
        >
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
              scrollbarRightInsetPx={2}
              scrollIndicatorOverlaySeam={false}
              contentContainerStyle={{
                paddingTop: 14,
                paddingBottom: 22,
                gap: 22,
              }}
              indicatorColor={colors.scrollIndicator}
            >
              {proActive ? (
                <View style={{ paddingHorizontal: dialogInsets.padX }}>
                  <View
                    style={{
                      backgroundColor: colors.undercover,
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: lightTheme
                        ? "rgba(0,0,0,0.08)"
                        : "rgba(255,255,255,0.08)",
                      paddingHorizontal: 16,
                      paddingVertical: 16,
                      gap: 10,
                      ...(Platform.OS === "web"
                        ? ({
                            boxShadow: lightTheme
                              ? "inset 0 1px 0 rgba(255,255,255,0.65), 0 1px 0 rgba(0,0,0,0.04)"
                              : "inset 0 1px 0 rgba(255,255,255,0.06)",
                          } as object)
                        : null),
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <View
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 8,
                          backgroundColor: lightTheme
                            ? "rgba(0,200,80,0.14)"
                            : "rgba(0,224,90,0.18)",
                          borderWidth: 1,
                          borderColor: HYPERLINKS_SPACE_LOGO_GREEN,
                        }}
                      >
                        <Text
                          style={{
                            color: lightTheme ? "#007A32" : HYPERLINKS_SPACE_LOGO_GREEN,
                            fontSize: 11,
                            fontWeight: "700",
                            letterSpacing: 0.4,
                            fontFamily: labelFont,
                          }}
                        >
                          {proState.cancelAtPeriodEnd
                            ? tf("pro.sale.cancelledBadge", { date: expiresLabel })
                            : t("pro.sale.activeBadge")}
                        </Text>
                      </View>
                      <Text
                        style={{
                          color: ink,
                          fontSize: 13,
                          fontWeight: "600",
                          fontFamily: labelFont,
                        }}
                      >
                        {t("pro.sale.manageTitle")}
                      </Text>
                    </View>

                    <Text
                      style={{
                        color: ink,
                        fontSize: 20,
                        lineHeight: 26,
                        fontWeight: "700",
                        fontFamily: labelFont,
                      }}
                    >
                      {tf("pro.sale.managePlanLine", {
                        plan: activePlanLabel,
                        price: formatUsd(activePlan.priceUsd),
                      })}
                    </Text>

                    <Text
                      style={{
                        color: muted,
                        fontSize: 14,
                        lineHeight: 20,
                        fontFamily: labelFont,
                      }}
                    >
                      {proState.cancelAtPeriodEnd
                        ? tf("pro.sale.cancelledHint", { date: expiresLabel })
                        : tf("pro.sale.activatedHint", { plan: activePlanLabel })}
                    </Text>

                    {expiresLabel ? (
                      <Text
                        style={{
                          color: muted,
                          fontSize: 13,
                          lineHeight: 18,
                          fontFamily: labelFont,
                        }}
                      >
                        {tf("pro.sale.activeUntil", { date: expiresLabel })}
                      </Text>
                    ) : null}

                    <View style={{ gap: 6, marginTop: 4, alignItems: "flex-start" }}>
                      {proState.cancelAtPeriodEnd ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("pro.sale.resume")}
                          hitSlop={4}
                          onPress={() => resumeProAccessRenewal()}
                          style={({ pressed }) => ({
                            height: 16,
                            paddingHorizontal: 6,
                            borderRadius: 8,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: pressed ? colors.highlight : colors.background,
                            flexShrink: 0,
                          })}
                        >
                          <Text
                            style={{
                              color: ink,
                              fontSize: 10,
                              lineHeight: 12,
                              fontWeight: "400",
                              fontFamily: labelFont,
                              ...(Platform.OS === "android"
                                ? { includeFontPadding: false }
                                : null),
                            }}
                            numberOfLines={1}
                          >
                            {t("pro.sale.resume")}
                          </Text>
                        </Pressable>
                      ) : (
                        <>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t("pro.sale.cancel")}
                            hitSlop={4}
                            onPress={() => cancelProAccessAtPeriodEnd()}
                            style={({ pressed }) => ({
                              height: 16,
                              paddingHorizontal: 6,
                              borderRadius: 8,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: pressed
                                ? lightTheme
                                  ? "rgba(198,40,40,0.18)"
                                  : "rgba(255,107,107,0.22)"
                                : cancelChipBg,
                              flexShrink: 0,
                            })}
                          >
                            <Text
                              style={{
                                color: cancelRed,
                                fontSize: 10,
                                lineHeight: 12,
                                fontWeight: "400",
                                fontFamily: labelFont,
                                ...(Platform.OS === "android"
                                  ? { includeFontPadding: false }
                                  : null),
                              }}
                              numberOfLines={1}
                            >
                              {t("pro.sale.cancel")}
                            </Text>
                          </Pressable>
                          {expiresLabel ? (
                            <Text
                              style={{
                                color: muted,
                                fontSize: 12,
                                lineHeight: 16,
                                fontFamily: labelFont,
                              }}
                            >
                              {tf("pro.sale.cancelHint", { date: expiresLabel })}
                            </Text>
                          ) : null}
                        </>
                      )}
                    </View>
                  </View>
                </View>
              ) : (
                <View style={{ paddingHorizontal: dialogInsets.padX, gap: 6 }}>
                  <Text
                    style={{
                      color: ink,
                      fontSize: 22,
                      lineHeight: 28,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.sale.headline")}
                  </Text>
                  <Text
                    style={{
                      color: muted,
                      fontSize: 14,
                      lineHeight: 20,
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.sale.subtitle")}
                  </Text>
                </View>
              )}

              {proActive ? (
                <View style={{ paddingHorizontal: dialogInsets.padX, gap: 4 }}>
                  <Text
                    style={{
                      color: ink,
                      fontSize: 15,
                      fontWeight: "700",
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.sale.changePlan")}
                  </Text>
                  <Text
                    style={{
                      color: muted,
                      fontSize: 13,
                      lineHeight: 18,
                      fontFamily: labelFont,
                    }}
                  >
                    {t("pro.sale.changePlanHint")}
                  </Text>
                </View>
              ) : null}

              <ProTariffCarousel
                planId={planId}
                onSelectPlan={setPlanId}
                contentPadX={dialogInsets.padX}
                activePlanId={proActive ? proState.planId : null}
              />

              <View style={{ paddingHorizontal: dialogInsets.padX, gap: 16 }}>
                {PRO_ACCESS_FEATURES.map((feature) => {
                  const soon = !launchedIds.has(feature.id);
                  return (
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
                          color={
                            soon
                              ? muted
                              : lightTheme
                                ? materials.accent
                                : colors.primary
                          }
                          size={24}
                        />
                      </View>
                      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: PRO_SOON_NAMEPLATE_GAP_PX,
                            minHeight: 24,
                          }}
                        >
                          <Text
                            style={{
                              color: soon ? muted : ink,
                              fontSize: 14,
                              lineHeight: 24,
                              fontWeight: "700",
                              fontFamily: labelFont,
                            }}
                          >
                            {t(feature.titleKey as AppStringKey)}
                          </Text>
                          {soon ? (
                            <ProSoonNameplate color={colors.secondary} lineHeightPx={24} />
                          ) : null}
                        </View>
                        <Text
                          style={{
                            color: muted,
                            fontSize: 13,
                            lineHeight: 18,
                            fontFamily: labelFont,
                          }}
                        >
                          {t(feature.bodyKey as AppStringKey)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </HspScrollColumn>

            <View
              onLayout={onFooterLayout}
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
                {proActive ? (
                  switchingPlan ? (
                    <ProSubscribeButton
                      label={tf("pro.sale.switch", {
                        plan: selectedPlanLabel,
                        price: formatUsd(selected.priceUsd),
                      })}
                      onPress={onSubscribe}
                    />
                  ) : (
                    <Text
                      style={{
                        color: muted,
                        fontSize: 12,
                        lineHeight: 17,
                        textAlign: "center",
                        alignSelf: "stretch",
                        fontFamily: labelFont,
                      }}
                    >
                      {expiresLabel
                        ? tf("pro.sale.activeUntil", { date: expiresLabel })
                        : t("pro.sale.activated")}
                    </Text>
                  )
                ) : (
                  <>
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
                        fontFamily: labelFont,
                      }}
                    >
                      {t("pro.sale.soonFooter")}
                    </Text>
                    <Text
                      style={{
                        color: muted,
                        fontSize: 12,
                        lineHeight: 17,
                        textAlign: "center",
                        alignSelf: "stretch",
                        fontFamily: labelFont,
                      }}
                    >
                      {t("pro.sale.footer")}
                    </Text>
                  </>
                )}
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
