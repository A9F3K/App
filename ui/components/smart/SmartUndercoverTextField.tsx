import { Platform, StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import { hairlineBorderWidthPx } from "../../scrollIndicatorPx";
import { undercoverHairlineRingStyle } from "../../undercoverHairlineRing";
import { typographyRect15, useColors, typographyFixedRow40Label } from "../../theme";

/** Matches welcome email field row height (`WelcomeAuthButtons`). */
export const SMART_UNDERCOVER_FIELD_HEIGHT_PX = 40;
const ROW_LINE_HEIGHT_PX = 21;
const TEXT_INSET_LEFT_PX = 10;
const TEXT_INSET_RIGHT_PX = 20;

type Props = {
  value: string;
  onChangeText: (next: string) => void;
  /** Web: stable id for autofill / UA outline overrides in `global.css`. */
  nativeID?: string;
} & Pick<TextInputProps, "placeholder" | "placeholderTextColor" | "autoCapitalize" | "autoCorrect">;

/** Single-row undercover field with divider-colored hairline — matches navigation search. */
export function SmartUndercoverTextField({
  value,
  onChangeText,
  nativeID,
  placeholder,
  placeholderTextColor,
  autoCapitalize = "none",
  autoCorrect = false,
}: Props) {
  const colors = useColors();
  const borderWidth = hairlineBorderWidthPx();

  return (
    <View
      {...(Platform.OS === "web"
        ? ({ className: "smart-undercover-text-field" } as Record<string, string>)
        : {})}
      style={[
        styles.shell,
        {
          backgroundColor: colors.undercover,
          ...undercoverHairlineRingStyle(colors.highlight, borderWidth),
          ...(Platform.OS === "web"
            ? ({
                "--smart-field-autofill-bg": colors.undercover,
                "--smart-field-autofill-fg": colors.primary,
              } as Record<string, string>)
            : {}),
        },
      ]}
    >
      <TextInput
        {...(Platform.OS === "web" && nativeID ? { id: nativeID } : {})}
        nativeID={nativeID}
        {...(Platform.OS === "web"
          ? ({ className: "smart-undercover-text-input" } as Record<string, string>)
          : {})}
        style={[styles.input, { color: colors.primary }]}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor ?? colors.secondary}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    width: "100%",
    alignSelf: "stretch",
    height: SMART_UNDERCOVER_FIELD_HEIGHT_PX,
    overflow: "hidden",
    ...Platform.select({
      web: {
        boxSizing: "border-box",
        minHeight: SMART_UNDERCOVER_FIELD_HEIGHT_PX,
        maxHeight: SMART_UNDERCOVER_FIELD_HEIGHT_PX,
      },
      default: {},
    }),
  },
  input: {
    ...typographyRect15,
    ...Platform.select({
      web: typographyFixedRow40Label,
      default: {},
    }),
    flex: 1,
    alignSelf: "stretch",
    width: "100%",
    minHeight: SMART_UNDERCOVER_FIELD_HEIGHT_PX,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingLeft: TEXT_INSET_LEFT_PX,
    paddingRight: TEXT_INSET_RIGHT_PX,
    margin: 0,
    ...Platform.select({
      web: {
        paddingTop: (SMART_UNDERCOVER_FIELD_HEIGHT_PX - ROW_LINE_HEIGHT_PX) / 2,
        paddingBottom: (SMART_UNDERCOVER_FIELD_HEIGHT_PX - ROW_LINE_HEIGHT_PX) / 2,
        outlineWidth: 0,
        boxSizing: "border-box",
      },
      default: {
        paddingVertical: 0,
      },
    }),
  },
});
