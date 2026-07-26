import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  APP_LOCALES,
  APP_LOCALE_SWITCHER_LABELS,
  type AppLocale,
  type AppStringKey,
} from "../../locales/appStrings";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useColors } from "../theme";

const SEGMENT_MIN_WIDTH = 56;
const SEGMENT_HEIGHT = 32;
const SWITCHER_BORDER_WIDTH = 1;

const LOCALE_A11Y_KEY: Record<AppLocale, AppStringKey> = {
  en: "home.header.languageIconSwitchToEn",
  ru: "home.header.languageIconSwitchToRu",
  zh: "home.header.languageIconSwitchToZh",
};

/**
 * Welcome-page language control: EN / РУ / 中文 segmented row (AbraKadaVra layout,
 * welcome theme colors). Shares {@link useAppStrings}.setUiLocale with the signed-in header.
 */
export function WelcomeLanguageSwitcher() {
  const colors = useColors();
  const { locale, setUiLocale, t } = useAppStrings();

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t("welcome.language.switcherA11y")}
      style={[
        styles.row,
        {
          borderColor: colors.highlight,
          backgroundColor: colors.background,
        },
      ]}
    >
      {APP_LOCALES.map((code, index) => {
        const active = locale === code;
        const isLast = index === APP_LOCALES.length - 1;
        return (
          <Pressable
            key={code}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t(LOCALE_A11Y_KEY[code])}
            onPress={() => setUiLocale(code)}
            style={[
              styles.segment,
              {
                backgroundColor: active ? colors.undercover : "transparent",
                borderRightWidth: isLast ? 0 : SWITCHER_BORDER_WIDTH,
                borderRightColor: colors.highlight,
              },
            ]}
          >
            <Text
              style={[
                styles.label,
                { color: active ? colors.primary : colors.secondary },
              ]}
            >
              {APP_LOCALE_SWITCHER_LABELS[code]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    alignSelf: "center",
    borderWidth: SWITCHER_BORDER_WIDTH,
    overflow: "hidden",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  segment: {
    minWidth: SEGMENT_MIN_WIDTH,
    height: SEGMENT_HEIGHT,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  label: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "400",
    textAlign: "center",
    includeFontPadding: false,
  },
});
