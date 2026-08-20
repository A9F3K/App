import { useMemo } from "react";
import {
  Platform,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { layout, useColors } from "../../theme";
import { CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX } from "../swap/ChooseCurrencySubheader";

const STRIP_PADDING_PX = layout.contentSideInsetPx;
const INNER_ROW_HEIGHT_PX = CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX - STRIP_PADDING_PX * 2;
const TAB_HEIGHT_PX = 30;
const TAB_PAD_X_PX = 10;
const TAB_GAP_PX = 8;
const ICON_SIZE_PX = 14;
const CLOSE_HIT_PX = 18;
const ADD_HIT_PX = 30;

export type AiAgentTab = {
  id: string;
};

type Props = {
  tabs: AiAgentTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: () => void;
};

function menuStripRuleThickness(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

function AgentBubbleIcon({ color, size = ICON_SIZE_PX }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4.5 14v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function AgentPlusIcon({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path d="M7 1.5v11M1.5 7h11" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

function AgentCloseIcon({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <Path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke={color} strokeWidth={1.25} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * Third-column agent tab strip — same height + bottom hairline as swap / currencies headers.
 */
export function AiAgentsColumnHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
}: Props) {
  const { t } = useAppStrings();
  const colors = useColors();
  const lineT = menuStripRuleThickness();

  const borderLineStyle = useMemo((): ViewStyle => {
    return {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: lineT,
      backgroundColor: colors.highlight,
      zIndex: 1,
    };
  }, [colors.highlight, lineT]);

  return (
    <View style={styles.strip}>
      <View style={styles.row}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsContent}
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            return (
              <View key={tab.id} style={styles.tabCluster}>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={t("ai.agents.newAgent")}
                  onPress={() => onSelectTab(tab.id)}
                  style={[
                    styles.tab,
                    {
                      backgroundColor: active ? colors.undercover : "transparent",
                    },
                  ]}
                >
                  <AgentBubbleIcon color={colors.primary} />
                  <Text
                    style={[
                      styles.tabLabel,
                      { color: colors.primary },
                    ]}
                    numberOfLines={1}
                  >
                    {t("ai.agents.newAgent")}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("ai.agents.closeTab")}
                    hitSlop={6}
                    onPress={(event) => {
                      // Avoid selecting the tab when closing.
                      event?.stopPropagation?.();
                      onCloseTab(tab.id);
                    }}
                    style={styles.closeHit}
                  >
                    <AgentCloseIcon color={colors.secondary} />
                  </Pressable>
                </Pressable>
                {/* Only between tabs — never after the last (reads like a text cursor). */}
                {index < tabs.length - 1 ? (
                  <View style={[styles.tabRule, { backgroundColor: colors.highlight }]} />
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("ai.agents.addTab")}
          onPress={onAddTab}
          style={styles.addHit}
        >
          <AgentPlusIcon color={colors.primary} />
        </Pressable>
      </View>
      <View pointerEvents="none" style={borderLineStyle} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: "100%",
    alignSelf: "stretch",
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
    paddingTop: STRIP_PADDING_PX,
    paddingBottom: STRIP_PADDING_PX,
    position: "relative",
    overflow: "visible",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: INNER_ROW_HEIGHT_PX,
    width: "100%",
    paddingLeft: STRIP_PADDING_PX,
    paddingRight: STRIP_PADDING_PX - 4,
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
  },
  tabCluster: {
    flexDirection: "row",
    alignItems: "center",
  },
  tab: {
    height: TAB_HEIGHT_PX,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: TAB_PAD_X_PX,
    paddingRight: 6,
    gap: TAB_GAP_PX,
    maxWidth: 200,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: "400",
    includeFontPadding: false,
  },
  closeHit: {
    width: CLOSE_HIT_PX,
    height: CLOSE_HIT_PX,
    alignItems: "center",
    justifyContent: "center",
  },
  tabRule: {
    width: StyleSheet.hairlineWidth,
    height: TAB_HEIGHT_PX,
    marginHorizontal: 2,
  },
  addHit: {
    width: ADD_HIT_PX,
    height: ADD_HIT_PX,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
});
