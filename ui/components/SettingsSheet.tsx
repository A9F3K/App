import { Platform, Pressable, Text, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { useAppStrings } from "../../locales/AppStringsContext";
import { typographyRect15, useColors, type ThemeName } from "../theme";
import { getDeployVersion, getVercelDeploymentId } from "../vercelDeployId";
import { useTelegram } from "./Telegram";
import { AppModalSheet, appModalSheetStyles } from "./AppModalSheet";
import { useSettingsSheet } from "../settings/SettingsContext";

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
  const deployMetaStyle = {
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 12,
    textAlign: "left" as const,
  };

  const selectTheme = (choice: ThemeChoice) => {
    setManualTheme(choice === "auto" ? null : choice);
  };

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
