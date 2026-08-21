import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { hairlineBorderWidthPx } from "../../scrollIndicatorPx";
import { undercoverHairlineRingStyle } from "../../undercoverHairlineRing";
import { typographyRect15, uiTextVerticalCompensationTransform, useColors } from "../../theme";

const CIRCLE_SIZE_PX = 30;
const PILL_WIDTH_PX = 70;
const PILL_HEIGHT_PX = 30;
const PILL_RADIUS_PX = PILL_HEIGHT_PX / 2;
const PILL_LINE_HEIGHT_PX = 18;
const STEP_GAP_PX = 10;
const FOUNDER_COUNT_INPUT_NATIVE_ID = "smart-company-founder-count";

const MIN_FOUNDERS = 1;
const MAX_FOUNDERS = 99;

type Props = {
  value: number;
  onChange: (next: number) => void;
  accessibilityLabel?: string;
};

function clampFounderCount(n: number): number {
  return Math.min(MAX_FOUNDERS, Math.max(MIN_FOUNDERS, n));
}

function parseFounderCountDraft(text: string): number | null {
  if (text === "") return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function CircleStepButton({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={[styles.circle, { backgroundColor: colors.undercover }]}
    >
      <View style={styles.circleTextArea}>
        <Text style={[typographyRect15, styles.circleGlyph, { color: colors.primary }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** [ − ] [ count ] [ + ] founder count control; center field accepts typed digits (1–99). */
export function SmartFounderCountStepper({ value, onChange, accessibilityLabel }: Props) {
  const colors = useColors();
  const borderWidth = hairlineBorderWidthPx();
  const [isFocused, setIsFocused] = useState(false);
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    if (!isFocused) {
      setDraft(String(value));
    }
  }, [isFocused, value]);

  const commitDraft = useCallback(
    (text: string) => {
      const parsed = parseFounderCountDraft(text);
      const next = parsed == null ? MIN_FOUNDERS : clampFounderCount(parsed);
      onChange(next);
      setDraft(String(next));
    },
    [onChange],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      const digits = text.replace(/\D/g, "").slice(0, 2);
      setDraft(digits);
      const parsed = parseFounderCountDraft(digits);
      if (parsed != null) {
        onChange(clampFounderCount(parsed));
      }
    },
    [onChange],
  );

  return (
    <View style={styles.row}>
      <CircleStepButton
        label="−"
        accessibilityLabel="Decrease founder count"
        onPress={() => onChange(clampFounderCount(value - 1))}
      />
      <View
        style={[
          styles.pill,
          {
            backgroundColor: colors.undercover,
            ...undercoverHairlineRingStyle(colors.highlight, borderWidth),
          },
        ]}
      >
        <TextInput
          {...(Platform.OS === "web" ? { id: FOUNDER_COUNT_INPUT_NATIVE_ID } : {})}
          nativeID={FOUNDER_COUNT_INPUT_NATIVE_ID}
          {...(Platform.OS === "web"
            ? ({ className: "smart-undercover-text-input" } as Record<string, string>)
            : {})}
          accessibilityLabel={accessibilityLabel ?? "Number of founders"}
          value={draft}
          onChangeText={handleChangeText}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            commitDraft(draft);
          }}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={2}
          selectTextOnFocus
          autoCorrect={false}
          autoCapitalize="none"
          style={[typographyRect15, uiTextVerticalCompensationTransform, styles.pillInput, { color: colors.primary }]}
        />
      </View>
      <CircleStepButton
        label="+"
        accessibilityLabel="Increase founder count"
        onPress={() => onChange(clampFounderCount(value + 1))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: STEP_GAP_PX,
  },
  circle: {
    width: CIRCLE_SIZE_PX,
    height: CIRCLE_SIZE_PX,
    borderRadius: CIRCLE_SIZE_PX / 2,
    overflow: "hidden",
  },
  circleTextArea: {
    width: CIRCLE_SIZE_PX,
    height: CIRCLE_SIZE_PX,
    alignItems: "center",
    justifyContent: "center",
  },
  circleGlyph: {
    fontSize: 15,
    lineHeight: PILL_LINE_HEIGHT_PX,
    textAlign: "center",
  },
  pill: {
    width: PILL_WIDTH_PX,
    height: PILL_HEIGHT_PX,
    borderRadius: PILL_RADIUS_PX,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      web: {
        boxSizing: "border-box",
      },
      default: {},
    }),
  },
  pillInput: {
    width: "100%",
    height: PILL_HEIGHT_PX,
    minHeight: PILL_HEIGHT_PX,
    fontSize: 15,
    lineHeight: PILL_LINE_HEIGHT_PX,
    textAlign: "center",
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 4,
    margin: 0,
    ...Platform.select({
      web: {
        outlineWidth: 0,
        boxSizing: "border-box",
        paddingTop: (PILL_HEIGHT_PX - PILL_LINE_HEIGHT_PX) / 2,
        paddingBottom: (PILL_HEIGHT_PX - PILL_LINE_HEIGHT_PX) / 2,
      },
      default: {
        paddingVertical: 0,
      },
    }),
  },
});
