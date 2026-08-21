import { useCallback, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { layout, typographyFixedRow30Label, typographyRect15, useColors } from "../../theme";
import { SmartFormBottomTextLane } from "./SmartFormBottomTextLane";
import { SmartFounderBlock } from "./SmartFounderBlock";
import { SmartFounderCountStepper } from "./SmartFounderCountStepper";
import { SmartTitleTextSection } from "./SmartTitleTextSection";
import { createFounderFields, type FounderFieldState } from "./smartFounderUtils";

const TEXT_FORM_TO_LOGO_GAP_PX = 30;
const LOGO_LABEL_TO_BUTTON_GAP_PX = 15;
const BUTTON_TO_FOUNDERS_GAP_PX = 30;
const FOUNDERS_TITLE_TO_SUBTITLE_GAP_PX = 15;
const FOUNDERS_SUBTITLE_TO_COUNT_LABEL_GAP_PX = 30;
const FOUNDERS_COUNT_LABEL_TO_STEPPER_GAP_PX = 15;
const STEPPER_TO_FOUNDER_BLOCKS_GAP_PX = 30;
const FOUNDER_BLOCK_GAP_PX = 40;

const DEFAULT_FOUNDER_COUNT = 1;

/** Matches {@link SmartColumnFooter} deploy control. */
const PANEL_ACTION_BUTTON_HEIGHT_PX = layout.bottomBar.undercoverButtonHeightPx;
const PANEL_ACTION_BUTTON_TEXT_INSET_PX = layout.bottomBar.undercoverButtonPaddingHorizontalPx;

const SECTION_LABEL_FONT_SIZE_PX = 25;
const SECTION_LABEL_LINE_HEIGHT_PX = 40;

const SMART_COMPANY_TITLE_INPUT_ID = "smart-company-title-input";
const SMART_COMPANY_TEXT_INPUT_ID = "smart-company-text-input";

const sectionLabelStyle = (color: string) => [
  typographyRect15,
  {
    fontSize: SECTION_LABEL_FONT_SIZE_PX,
    lineHeight: SECTION_LABEL_LINE_HEIGHT_PX,
    fontWeight: "400" as const,
    color,
  },
];

/** Company purpose fields below the deal version row. */
export function SmartCompanySection() {
  const colors = useColors();
  const { t } = useAppStrings();
  const [title, setTitle] = useState(() => t("smart.company.titleDefault"));
  const [bodyText, setBodyText] = useState("");
  const [founderCount, setFounderCount] = useState(DEFAULT_FOUNDER_COUNT);
  const [founders, setFounders] = useState<FounderFieldState[]>(() => createFounderFields(DEFAULT_FOUNDER_COUNT));

  const handleFounderCountChange = useCallback((next: number) => {
    setFounderCount(next);
    setFounders((previous) => createFounderFields(next, previous));
  }, []);

  const handleFounderChange = useCallback((index: number, patch: Partial<FounderFieldState>) => {
    setFounders((previous) =>
      previous.map((founder, founderIndex) => (founderIndex === index ? { ...founder, ...patch } : founder)),
    );
  }, []);

  return (
    <>
      <SmartTitleTextSection
        title={title}
        text={bodyText}
        titleLabel={t("smart.company.titleLabel")}
        textLabel={t("smart.company.textLabel")}
        textPlaceholder={t("smart.company.textPlaceholder")}
        titleInputId={SMART_COMPANY_TITLE_INPUT_ID}
        textInputId={SMART_COMPANY_TEXT_INPUT_ID}
        onChangeTitle={setTitle}
        onChangeText={setBodyText}
      />

      <View style={{ height: TEXT_FORM_TO_LOGO_GAP_PX }} />

      <Text style={sectionLabelStyle(colors.primary)}>{t("smart.company.logoLabel")}</Text>

      <View style={{ height: LOGO_LABEL_TO_BUTTON_GAP_PX }} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("smart.company.addImageButton")}
        style={[styles.panelActionButton, { backgroundColor: colors.undercover }]}
        onPress={() => {
          /* wired when image upload lands */
        }}
      >
        <Text style={[typographyFixedRow30Label, { color: colors.primary, textAlign: "center" }]} numberOfLines={1}>
          {t("smart.company.addImageButton")}
        </Text>
      </Pressable>

      <View style={{ height: BUTTON_TO_FOUNDERS_GAP_PX }} />

      <Text style={sectionLabelStyle(colors.primary)}>{t("smart.company.foundersTitle")}</Text>

      <View style={{ height: FOUNDERS_TITLE_TO_SUBTITLE_GAP_PX }} />

      <SmartFormBottomTextLane color={colors.primary}>{t("smart.company.foundersSubtitle")}</SmartFormBottomTextLane>

      <View style={{ height: FOUNDERS_SUBTITLE_TO_COUNT_LABEL_GAP_PX }} />

      <SmartFormBottomTextLane color={colors.primary} style={{ fontWeight: "500" }}>
        {t("smart.company.foundersCountLabel")}
      </SmartFormBottomTextLane>

      <View style={{ height: FOUNDERS_COUNT_LABEL_TO_STEPPER_GAP_PX }} />

      <SmartFounderCountStepper
        value={founderCount}
        onChange={handleFounderCountChange}
        accessibilityLabel={t("smart.company.foundersCountLabel")}
      />

      <View style={{ height: STEPPER_TO_FOUNDER_BLOCKS_GAP_PX }} />

      {founders.map((founder, index) => (
        <View key={`founder-${index}`}>
          {index > 0 ? <View style={{ height: FOUNDER_BLOCK_GAP_PX }} /> : null}
          <SmartFounderBlock
            index={index}
            field={founder}
            onChange={(patch) => handleFounderChange(index, patch)}
          />
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  panelActionButton: {
    alignSelf: "flex-start",
    flexShrink: 0,
    height: PANEL_ACTION_BUTTON_HEIGHT_PX,
    paddingHorizontal: PANEL_ACTION_BUTTON_TEXT_INSET_PX,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
});
