import { useEffect } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useSyncExternalStore } from "react";

import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { typographyRect15, useColors, type ThemeName } from "../theme";
import { getDeployVersion, getVercelDeploymentId } from "../vercelDeployId";
import { useTelegram } from "./Telegram";
import { AppModalSheet, appModalSheetStyles } from "./AppModalSheet";
import { useSettingsSheet } from "../settings/SettingsContext";
import {
  getAiFreeQuotaSnapshot,
  refreshAiFreeQuotaFromServer,
  saveAiToolsPrefs,
  subscribeAiFreeQuota,
} from "../ai/aiFreeQuotaStore";
import { formatDllrAmount } from "../ai/aiConsumptionDllr";
import { requestOpenProAccess } from "../pro/openProAccess";
import { isProAccessActive, subscribeProAccess } from "../pro/proAccessStore";

type ThemeChoice = "auto" | ThemeName;

function ThemeOptionRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}
      {...(Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {})}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderWidth: 1,
          borderColor: colors.highlight,
          borderRadius: 8,
          marginRight: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: selected ? colors.undercover : "transparent",
        }}
      >
        {selected ? (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: colors.primary,
            }}
          />
        ) : null}
      </View>
      <Text style={[typographyRect15, { color: colors.secondary, flex: 1, textAlign: "left" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SettingsSheet() {
  const colors = useColors();
  const { isAuthenticated } = useAuth();
  const { t, tf, welcomeFeedManualTranslation, setWelcomeFeedManualTranslation } = useAppStrings();
  const { telegramUsername, manualTheme, setManualTheme } = useTelegram();
  const { settingsSheetVisible, closeSettingsSheet } = useSettingsSheet();
  const vercelDeploymentId = getVercelDeploymentId();
  const deployVersion = getDeployVersion();
  const themeChoice: ThemeChoice = manualTheme ?? "auto";
  const quota = useSyncExternalStore(
    subscribeAiFreeQuota,
    getAiFreeQuotaSnapshot,
    getAiFreeQuotaSnapshot,
  );
  const proActive = useSyncExternalStore(subscribeProAccess, isProAccessActive, () => false);
  const deployMetaStyle = {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 12,
    textAlign: "left" as const,
  };

  useEffect(() => {
    if (!settingsSheetVisible || !isAuthenticated) return;
    void refreshAiFreeQuotaFromServer();
  }, [settingsSheetVisible, isAuthenticated]);

  const selectTheme = (choice: ThemeChoice) => {
    setManualTheme(choice === "auto" ? null : choice);
  };

  const dllrRatio =
    quota.dllrLimit > 0 ? Math.min(1, Math.max(0, quota.dllrUsed / quota.dllrLimit)) : 0;
  const allowanceExhausted = quota.limitReached;
  const usedPercent = Math.round(dllrRatio * 100);
  const showAntiDdos = isAuthenticated && !proActive;

  return (
    <AppModalSheet
      visible={settingsSheetVisible}
      onClose={closeSettingsSheet}
      title={t("settings.sheetTitle")}
    >
      {telegramUsername ? (
        <Text
          style={[
            typographyRect15,
            appModalSheetStyles.body,
            { color: colors.secondary, textAlign: "left" },
          ]}
        >
          {tf("home.wallet.loggedInAs", { username: telegramUsername })}
        </Text>
      ) : null}

      {isAuthenticated ? (
        <>
          <Text
            style={[appModalSheetStyles.section, { color: colors.primary, marginTop: 4 }]}
            accessibilityRole="header"
          >
            {showAntiDdos ? t("settings.antiDdos") : t("settings.consumption")}
          </Text>
          <Text
            style={{
              color: colors.secondary,
              fontSize: 12,
              lineHeight: 16,
              marginBottom: 8,
              textAlign: "left",
            }}
          >
            {showAntiDdos ? t("settings.antiDdosHint") : t("settings.consumptionHint")}
          </Text>
          <View
            style={{
              height: 8,
              borderRadius: 4,
              overflow: "hidden",
              backgroundColor: colors.undercover,
              marginBottom: 6,
            }}
          >
            <View
              style={{
                height: "100%",
                width: `${usedPercent}%`,
                backgroundColor: colors.primary,
                borderRadius: 4,
              }}
            />
          </View>
          <Text
            style={[
              typographyRect15,
              { color: colors.primary, textAlign: "left", marginBottom: 8 },
            ]}
          >
            {showAntiDdos
              ? tf("settings.antiDdosPercent", { percent: usedPercent })
              : tf("ai.tools.usageValues", {
                  used: formatDllrAmount(quota.dllrUsed),
                  limit: formatDllrAmount(quota.dllrLimit),
                })}
          </Text>
          {!proActive && allowanceExhausted ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                closeSettingsSheet();
                requestOpenProAccess();
              }}
              style={({ pressed }) => ({
                alignSelf: "stretch",
                alignItems: "center",
                paddingVertical: 10,
                marginBottom: 8,
                borderRadius: 10,
                backgroundColor: colors.primary,
                opacity: pressed ? 0.88 : 1,
              })}
            >
              <Text style={{ color: colors.background, fontWeight: "700", fontSize: 14 }}>
                {t("ai.tools.buyProCta")}
              </Text>
            </Pressable>
          ) : null}
          {proActive && allowanceExhausted && !quota.onDemandEnabled ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void saveAiToolsPrefs({ onDemandEnabled: true });
              }}
              style={({ pressed }) => ({
                alignSelf: "stretch",
                alignItems: "center",
                paddingVertical: 10,
                marginBottom: 8,
                borderRadius: 10,
                backgroundColor: colors.primary,
                opacity: pressed ? 0.88 : 1,
              })}
            >
              <Text style={{ color: colors.background, fontWeight: "700", fontSize: 14 }}>
                {t("ai.tools.enableOnDemandCta")}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      <Text
        style={[appModalSheetStyles.section, { color: colors.primary, marginTop: 4 }]}
        accessibilityRole="header"
      >
        {t("settings.theme")}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("settings.themeA11y")}>
        <ThemeOptionRow
          label={t("settings.themeAuto")}
          selected={themeChoice === "auto"}
          onPress={() => selectTheme("auto")}
        />
        <ThemeOptionRow
          label={t("settings.themeLight")}
          selected={themeChoice === "light"}
          onPress={() => selectTheme("light")}
        />
        <ThemeOptionRow
          label={t("settings.themeDark")}
          selected={themeChoice === "dark"}
          onPress={() => selectTheme("dark")}
        />
      </View>

      {isAuthenticated ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: welcomeFeedManualTranslation }}
          accessibilityLabel={t("feed.manualWelcomeTranslationA11y")}
          onPress={() => setWelcomeFeedManualTranslation(!welcomeFeedManualTranslation)}
          style={{ flexDirection: "row", alignItems: "center", marginBottom: 4, marginTop: 12 }}
          {...(Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {})}
        >
          <View
            style={{
              width: 16,
              height: 16,
              borderWidth: 1,
              borderColor: colors.highlight,
              marginRight: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: welcomeFeedManualTranslation ? colors.undercover : "transparent",
            }}
          >
            {welcomeFeedManualTranslation ? (
              <Text style={{ color: colors.primary, fontSize: 11, lineHeight: 14 }}>✓</Text>
            ) : null}
          </View>
          <Text style={[typographyRect15, { color: colors.secondary, flex: 1, textAlign: "left" }]}>
            {t("feed.manualWelcomeTranslation")}
          </Text>
        </Pressable>
      ) : null}

      {vercelDeploymentId ? (
        <Text style={deployMetaStyle}>Deploy: {vercelDeploymentId}</Text>
      ) : null}
      {deployVersion != null ? (
        <Text style={{ ...deployMetaStyle, marginTop: vercelDeploymentId ? 4 : 12 }}>
          Version: {deployVersion}
        </Text>
      ) : null}
    </AppModalSheet>
  );
}
