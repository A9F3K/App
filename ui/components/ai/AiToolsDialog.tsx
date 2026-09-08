import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSyncExternalStore } from "react";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import {
  applyAiFreeQuotaFromServer,
  getAiFreeQuotaSnapshot,
  getAiToolsModelOptions,
  refreshAiFreeQuotaFromServer,
  saveAiToolsPrefs,
  subscribeAiFreeQuota,
  type AiModelMode,
} from "../../ai/aiFreeQuotaStore";
import {
  getBuiltinDllrHotUsd,
  subscribeBuiltinDllrBalance,
} from "../../pro/dllrBalanceStore";
import { requestOpenProAccess } from "../../pro/openProAccess";
import { FloatingDialogShell } from "../FloatingDialogShell";
import { FloatingDialogBody } from "../FloatingDialogBody";
import { FloatingDialogStickyHeader } from "../FloatingDialogStickyHeader";
import { resolveFloatingDialogInsets } from "../floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { FloatingDialogScrollChromeProvider } from "../floatingDialogScrollChrome";
import { HspScrollColumn } from "../HspScrollColumn";
import { typographyRect15, useColors } from "../../theme";
import { formatDllrAmount, tokensToDllr } from "../../ai/aiConsumptionDllr";

type Props = {
  visible: boolean;
  onClose: () => void;
};

function ModeRow({
  label,
  hint,
  selected,
  onPress,
  colors,
  font,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
  font: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.highlight,
        backgroundColor: selected ? colors.undercover : "transparent",
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 8,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[typographyRect15, { color: colors.primary, fontFamily: font }]}>
          {label}
        </Text>
        {hint ? (
          <Text
            style={{
              color: colors.secondary,
              fontSize: 12,
              lineHeight: 16,
              marginTop: 2,
              fontFamily: font,
            }}
          >
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: 1.5,
          flexShrink: 0,
          borderColor: selected ? colors.primary : colors.highlight,
          backgroundColor: selected ? colors.primary : "transparent",
        }}
      />
    </Pressable>
  );
}

export function AiToolsDialog({ visible, onClose }: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const font = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const quota = useSyncExternalStore(
    subscribeAiFreeQuota,
    getAiFreeQuotaSnapshot,
    getAiFreeQuotaSnapshot,
  );
  const dllrHot = useSyncExternalStore(
    subscribeBuiltinDllrBalance,
    getBuiltinDllrHotUsd,
    () => 0,
  );
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState(getAiToolsModelOptions);
  const [headerExtendPx, setHeaderExtendPx] = useState(0);

  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "modal"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);

  useEffect(() => {
    if (!visible) return;
    void refreshAiFreeQuotaFromServer().then(() => {
      setModels(getAiToolsModelOptions());
    });
  }, [visible]);

  const rate = quota.onDemandUsdPer1kTokens;
  const dllrUsed =
    typeof quota.dllrUsed === "number" && Number.isFinite(quota.dllrUsed)
      ? quota.dllrUsed
      : tokensToDllr(quota.proActive ? quota.proTokensUsedMonth : quota.tokensUsed, rate);
  const dllrLimit =
    typeof quota.dllrLimit === "number" && Number.isFinite(quota.dllrLimit) && quota.dllrLimit > 0
      ? quota.dllrLimit
      : tokensToDllr(quota.proActive ? quota.proMonthlyLimit : quota.tokenLimit, rate);
  const ratio = dllrLimit > 0 ? Math.min(1, dllrUsed / dllrLimit) : 0;
  const allowanceExhausted =
    quota.limitReached || (dllrLimit > 0 && dllrUsed + 1e-9 >= dllrLimit);

  const persist = useCallback(
    async (patch: {
      modelMode?: AiModelMode;
      modelId?: string | null;
      onDemandEnabled?: boolean;
    }) => {
      setSaving(true);
      try {
        const next = await saveAiToolsPrefs(patch);
        applyAiFreeQuotaFromServer(next);
        setModels(getAiToolsModelOptions());
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={12070}
      defaultSize={defaultSize}
      minSize={{ width: 340, height: 420 }}
      sizeStorageKey="hsp.aiTools.size.v1"
      onRequestClose={onClose}
      testId="ai-tools"
    >
      <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
        <FloatingDialogBody>
          <FloatingDialogStickyHeader
            insets={dialogInsets}
            onClose={onClose}
            closeLabel={t("common.close")}
            title={t("ai.tools.title")}
            subtitle={t("ai.tools.subtitle")}
            onHeightChange={setHeaderExtendPx}
          />

          <HspScrollColumn
            style={{ flex: 1, minHeight: 0 }}
            containOverscroll
            scrollbarRightInsetPx={2}
            scrollIndicatorOverlaySeam={false}
            indicatorColor={colors.scrollIndicator}
            contentContainerStyle={{
              paddingHorizontal: dialogInsets.padX,
              paddingTop: 12,
              paddingBottom: 20,
              gap: 0,
            }}
          >
            <Text
              style={{
                color: colors.secondary,
                fontSize: 11,
                letterSpacing: 0.4,
                marginBottom: 8,
                fontFamily: font,
                textTransform: "uppercase",
              }}
            >
              {quota.proActive ? t("ai.tools.usagePro") : t("ai.tools.usageFree")}
            </Text>
            <View
              style={{
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                backgroundColor: colors.undercover,
              }}
            >
              <View
                style={{
                  height: "100%",
                  borderRadius: 4,
                  width: `${Math.round(ratio * 100)}%`,
                  backgroundColor: colors.primary,
                }}
              />
            </View>
            <Text
              style={{
                color: colors.primary,
                fontSize: 13,
                marginTop: 6,
                marginBottom: 10,
                fontFamily: font,
              }}
            >
              {quota.proActive
                ? tf("ai.tools.usageValues", {
                    used: formatDllrAmount(dllrUsed),
                    limit: formatDllrAmount(dllrLimit),
                  })
                : tf("ai.tools.usagePercent", { percent: Math.round(ratio * 100) })}
            </Text>

            {!quota.proActive && allowanceExhausted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("ai.tools.buyProCta")}
                onPress={() => {
                  onClose();
                  requestOpenProAccess();
                }}
                style={({ pressed }) => ({
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  marginBottom: 14,
                  borderRadius: 12,
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.88 : 1,
                })}
              >
                <Text
                  style={{
                    color: colors.background,
                    fontSize: 14,
                    fontWeight: "700",
                    fontFamily: font,
                  }}
                >
                  {t("ai.tools.buyProCta")}
                </Text>
              </Pressable>
            ) : null}

            {quota.proActive && allowanceExhausted && !quota.onDemandEnabled ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("ai.tools.enableOnDemandCta")}
                disabled={saving}
                onPress={() => void persist({ onDemandEnabled: true })}
                style={({ pressed }) => ({
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  marginBottom: 14,
                  borderRadius: 12,
                  backgroundColor: colors.primary,
                  opacity: saving ? 0.55 : pressed ? 0.88 : 1,
                })}
              >
                <Text
                  style={{
                    color: colors.background,
                    fontSize: 14,
                    fontWeight: "700",
                    fontFamily: font,
                  }}
                >
                  {t("ai.tools.enableOnDemandCta")}
                </Text>
              </Pressable>
            ) : null}

            {quota.proActive ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: colors.highlight,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <View style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                  <Text style={[typographyRect15, { color: colors.primary, fontFamily: font }]}>
                    {t("ai.tools.onDemand")}
                  </Text>
                  <Text
                    style={{
                      color: colors.secondary,
                      fontSize: 12,
                      lineHeight: 16,
                      marginTop: 2,
                      fontFamily: font,
                    }}
                  >
                    {tf("ai.tools.onDemandHint", {
                      rate: quota.onDemandUsdPer1kTokens.toFixed(4),
                      balance: dllrHot.toFixed(2),
                    })}
                  </Text>
                </View>
                <Switch
                  value={quota.onDemandEnabled}
                  disabled={saving}
                  onValueChange={(v) => void persist({ onDemandEnabled: v })}
                  trackColor={{ false: colors.highlight, true: colors.primary }}
                  thumbColor={colors.background}
                />
              </View>
            ) : null}

            <Text
              style={{
                color: colors.secondary,
                fontSize: 11,
                letterSpacing: 0.4,
                marginTop: 8,
                marginBottom: 8,
                fontFamily: font,
                textTransform: "uppercase",
              }}
            >
              {t("ai.tools.modelSection")}
            </Text>

            <ModeRow
              label={t("ai.tools.modeAuto")}
              hint={t("ai.tools.modeAutoHint")}
              selected={quota.modelMode === "auto"}
              onPress={() => void persist({ modelMode: "auto", modelId: null })}
              colors={colors}
              font={font}
            />
            <ModeRow
              label={t("ai.tools.modeTiny")}
              hint={t("ai.tools.modeTinyHint")}
              selected={quota.modelMode === "tinymodel"}
              onPress={() => void persist({ modelMode: "tinymodel", modelId: null })}
              colors={colors}
              font={font}
            />

            {(models.length > 0 ? models : []).map((m) => (
              <ModeRow
                key={m.id}
                label={m.label}
                hint={m.backend === "openai" ? t("ai.tools.viaOpenAi") : t("ai.tools.viaGateway")}
                selected={quota.modelMode === "model" && quota.modelId === m.id}
                onPress={() => void persist({ modelMode: "model", modelId: m.id })}
                colors={colors}
                font={font}
              />
            ))}
          </HspScrollColumn>
        </FloatingDialogBody>
      </FloatingDialogScrollChromeProvider>
    </FloatingDialogShell>
  );
}
