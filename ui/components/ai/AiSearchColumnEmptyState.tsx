import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { layout, typographyRect15, useColors } from "../../theme";
import { useBottomBarLayout } from "../BottomBarLayoutContext";
import { HspScrollColumn } from "../HspScrollColumn";
import { AiSearchPromptButton } from "./AiSearchPromptButton";

const TOP_GAP_PX = 20;
const TITLE_TO_BODY_GAP_PX = 15;
const PARAGRAPH_GAP_PX = 15;
const BODY_TO_PROMPTS_GAP_PX = 15;
const PROMPT_BUTTON_GAP_PX = 15;

const TITLE_FONT_SIZE_PX = 25;
const TITLE_LINE_HEIGHT_PX = 40;
const BODY_FONT_SIZE_PX = 15;
const BODY_LINE_HEIGHT_PX = 25;

const PREMADE_PROMPT_KEYS = [
  "global.bottomBar.premade1",
  "global.bottomBar.premade2",
  "global.bottomBar.premade3",
] as const;

/** Third-column copy and sample prompts when the AI field is empty. */
export function AiSearchColumnEmptyState() {
  const colors = useColors();
  const { t } = useAppStrings();
  const { setDraftText } = useBottomBarLayout();
  const [columnWidth, setColumnWidth] = useState(0);
  const contentInset = layout.contentSideInsetPx;
  /** Same as swap/smart: bleed past column padding so the thumb sits at {@link layout.scrollIndicatorRightInsetPx}. */
  const scrollShellBleed = { marginHorizontal: -contentInset };

  const onColumnLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setColumnWidth((current) => (current === next ? current : next));
  }, []);

  const prompts = useMemo(() => PREMADE_PROMPT_KEYS.map((key) => t(key)), [t]);

  const bodyStyle = [
    typographyRect15,
    {
      fontSize: BODY_FONT_SIZE_PX,
      lineHeight: BODY_LINE_HEIGHT_PX,
      fontWeight: "400" as const,
      color: colors.primary,
    },
  ];

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
      onLayout={onColumnLayout}
    >
      <HspScrollColumn
        style={{ flex: 1, ...scrollShellBleed }}
        contentContainerStyle={{
          paddingHorizontal: contentInset,
          paddingBottom: contentInset,
        }}
        indicatorColor={colors.accent}
      >
        <View style={{ height: TOP_GAP_PX }} />

        <Text
          style={[
            typographyRect15,
            {
              fontSize: TITLE_FONT_SIZE_PX,
              lineHeight: TITLE_LINE_HEIGHT_PX,
              fontWeight: "400",
              color: colors.primary,
            },
          ]}
        >
          {t("ai.search.emptyTitle")}
        </Text>

        <View style={{ height: TITLE_TO_BODY_GAP_PX }} />

        <Text style={bodyStyle}>{t("ai.search.emptyIntro")}</Text>

        <View style={{ height: PARAGRAPH_GAP_PX }} />

        <Text style={bodyStyle}>{t("ai.search.emptyList")}</Text>

        <View style={{ height: PARAGRAPH_GAP_PX }} />

        <Text style={bodyStyle}>{t("ai.search.emptyTryPrompts")}</Text>

        <View style={{ height: BODY_TO_PROMPTS_GAP_PX }} />

        {prompts.map((prompt, index) => (
          <View key={PREMADE_PROMPT_KEYS[index]}>
            {index > 0 ? <View style={{ height: PROMPT_BUTTON_GAP_PX }} /> : null}
            <AiSearchPromptButton
              label={prompt}
              columnWidth={columnWidth}
              onPress={() => setDraftText(prompt)}
            />
          </View>
        ))}
      </HspScrollColumn>
    </View>
  );
}
