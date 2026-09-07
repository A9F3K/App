import { Platform, Pressable, Text, View } from "react-native";
import { useSyncExternalStore } from "react";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { requestOpenProAccess } from "../../pro/openProAccess";
import { isProAccessActive, subscribeProAccess } from "../../pro/proAccessStore";
import { useColors } from "../../theme";
import {
  getAiFreeQuotaSnapshot,
  isAiFreeLimitReached,
  saveAiToolsPrefs,
  subscribeAiFreeQuota,
} from "../../ai/aiFreeQuotaStore";
import { formatDllrAmount } from "../../ai/aiConsumptionDllr";

/** Compact notice above the AI & Search field when the active DLLR allowance is exhausted. */
export function AiFreeLimitBanner({ visible }: { visible: boolean }) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const proActive = useSyncExternalStore(subscribeProAccess, isProAccessActive, () => false);
  const quota = useSyncExternalStore(
    subscribeAiFreeQuota,
    getAiFreeQuotaSnapshot,
    getAiFreeQuotaSnapshot,
  );
  const limitReached = useSyncExternalStore(
    subscribeAiFreeQuota,
    isAiFreeLimitReached,
    () => false,
  );

  if (!visible || !limitReached) return null;

  const font = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;
  const usageLabel = tf("ai.tools.usageValues", {
    used: formatDllrAmount(quota.dllrUsed),
    limit: formatDllrAmount(quota.dllrLimit),
  });

  if (proActive) {
    if (quota.onDemandEnabled) {
      return (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.highlight,
            backgroundColor: colors.undercover,
          }}
        >
          <Text
            style={{
              flex: 1,
              color: colors.primary,
              fontSize: 13,
              lineHeight: 18,
              fontFamily: font,
            }}
          >
            {t("ai.proLimit.noDllr")}
          </Text>
        </View>
      );
    }
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.highlight,
          backgroundColor: colors.undercover,
        }}
      >
        <Text
          style={{
            flex: 1,
            color: colors.primary,
            fontSize: 13,
            lineHeight: 18,
            fontFamily: font,
          }}
        >
          {`${t("ai.proLimit.body")} (${usageLabel})`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("ai.tools.enableOnDemandCta")}
          onPress={() => {
            void saveAiToolsPrefs({ onDemandEnabled: true });
          }}
          style={({ pressed }) => ({
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            backgroundColor: colors.primary,
            opacity: pressed ? 0.88 : 1,
            flexShrink: 0,
          })}
        >
          <Text
            style={{
              color: colors.background,
              fontSize: 13,
              fontWeight: "700",
              fontFamily: font,
            }}
          >
            {t("ai.tools.enableOnDemandCta")}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 0,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.highlight,
        backgroundColor: colors.undercover,
      }}
    >
      <Text
        style={{
          flex: 1,
          color: colors.primary,
          fontSize: 13,
          lineHeight: 18,
          fontFamily: font,
        }}
      >
        {`${t("ai.freeLimit.body")} (${usageLabel})`}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("ai.freeLimit.cta")}
        onPress={() => requestOpenProAccess()}
        style={({ pressed }) => ({
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 10,
          backgroundColor: colors.primary,
          opacity: pressed ? 0.88 : 1,
          flexShrink: 0,
        })}
      >
        <Text
          style={{
            color: colors.background,
            fontSize: 13,
            fontWeight: "700",
            fontFamily: font,
          }}
        >
          {t("ai.freeLimit.cta")}
        </Text>
      </Pressable>
    </View>
  );
}
