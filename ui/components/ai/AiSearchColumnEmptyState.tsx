import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { layout, typographyRect15, useColors } from "../../theme";
import { useBottomBarLayout } from "../BottomBarLayoutContext";
import { HspScrollColumn } from "../HspScrollColumn";
import { AiAgentsColumnHeader, type AiAgentTab } from "./AiAgentsColumnHeader";
import { AiSearchPromptButton } from "./AiSearchPromptButton";

const TOP_GAP_PX = 20;
const PARAGRAPH_GAP_PX = 15;
const BODY_TO_PROMPTS_GAP_PX = 15;
const PROMPT_BUTTON_GAP_PX = 15;

const BODY_FONT_SIZE_PX = 15;
const BODY_LINE_HEIGHT_PX = 25;

const PREMADE_PROMPT_KEYS = [
  "global.bottomBar.premade1",
  "global.bottomBar.premade2",
  "global.bottomBar.premade3",
] as const;

let nextAgentTabSeq = 1;
function createAgentTabId(): string {
  nextAgentTabSeq += 1;
  return `agent-${nextAgentTabSeq}`;
}

/** Default empty-state body shared by every agent tab (no title — title lives in the tab). */
function AiAgentTabEmptyBody({
  columnWidth,
  onPromptPress,
}: {
  columnWidth: number;
  onPromptPress: (prompt: string) => void;
}) {
  const colors = useColors();
  const { t } = useAppStrings();
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
    <>
      <View style={{ height: TOP_GAP_PX }} />
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
            onPress={() => onPromptPress(prompt)}
          />
        </View>
      ))}
    </>
  );
}

/**
 * Triple-column AI pane: agent tabs header (swap/currencies chrome) + per-tab default empty content.
 */
export function AiSearchColumnEmptyState() {
  const colors = useColors();
  const { draftText, setDraftText } = useBottomBarLayout();
  const chatStarted = draftText.trim().length > 0;
  const showEmptyBody = !chatStarted;
  const [columnWidth, setColumnWidth] = useState(0);
  const [tabs, setTabs] = useState<AiAgentTab[]>(() => [{ id: "agent-1" }]);
  const [activeTabId, setActiveTabId] = useState("agent-1");
  const contentInset = layout.contentSideInsetPx;
  const scrollShellBleed = { marginHorizontal: -contentInset };
  /** Hide close on a lone idle tab; show when there are several tabs or the sole chat has started. */
  const showCloseButtons = tabs.length > 1 || chatStarted;

  const onColumnLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setColumnWidth((current) => (current === next ? current : next));
  }, []);

  const onAddTab = useCallback(() => {
    const id = createAgentTabId();
    setTabs((current) => [...current, { id }]);
    setActiveTabId(id);
  }, []);

  const onCloseTab = useCallback(
    (id: string) => {
      setTabs((current) => {
        if (current.length <= 1) {
          // Sole started chat → reset to default empty state (close control hides again).
          setDraftText("");
          const fresh = createAgentTabId();
          setActiveTabId(fresh);
          return [{ id: fresh }];
        }
        const index = current.findIndex((tab) => tab.id === id);
        if (index < 0) return current;
        const next = current.filter((tab) => tab.id !== id);
        setActiveTabId((active) => {
          if (active !== id) return active;
          const fallback = next[Math.min(index, next.length - 1)];
          return fallback?.id ?? active;
        });
        return next;
      });
    },
    [setDraftText],
  );

  return (
    <View
      style={{ flex: 1, width: "100%", alignSelf: "stretch", minHeight: 0 }}
      onLayout={onColumnLayout}
    >
      <View style={scrollShellBleed}>
        <AiAgentsColumnHeader
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={onCloseTab}
          onAddTab={onAddTab}
          showCloseButtons={showCloseButtons}
        />
      </View>
      {showEmptyBody ? (
        <HspScrollColumn
          style={{ flex: 1, ...scrollShellBleed }}
          contentContainerStyle={{
            paddingHorizontal: contentInset,
            paddingBottom: contentInset,
          }}
          indicatorColor={colors.primary}
        >
          {/* Remount body when switching tabs so each tab starts from the default empty state. */}
          <AiAgentTabEmptyBody
            key={activeTabId}
            columnWidth={columnWidth}
            onPromptPress={setDraftText}
          />
        </HspScrollColumn>
      ) : (
        <View style={{ flex: 1, minHeight: 0 }} />
      )}
    </View>
  );
}
