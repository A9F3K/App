import { useRef, useState, type LayoutChangeEvent } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";

import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyFixedRow30Label, useColors } from "../../theme";
import { LiquidGlassShaderUndercover } from "../LiquidGlassShaderUndercover";
import { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX } from "./messageListLayout";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";

const TEXT_INSET_X_PX = 12;
const CLEAR_HIT_PX = 30;
const LIQUID_GLASS_FIELD_HEIGHT_PX = 40;

type Props = {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  clearAccessibilityLabel: string;
  /** Gap below the field to the first chat hover top edge. */
  marginBottomPx: number;
  onFocus?: () => void;
  onBlur?: () => void;
  onDismiss?: () => void;
  showClear?: boolean;
  /** Undercover fill (wide column) or liquid-glass pill (single-column footer). */
  variant?: "undercover" | "liquidGlass";
  isLightTheme?: boolean;
};

/** Chat-list search rectangle — Join-button height/fill (`undercover`), secondary placeholder. */
export function MessageChatListSearchField({
  value,
  onChangeText,
  placeholder,
  clearAccessibilityLabel,
  marginBottomPx,
  onFocus,
  onBlur,
  onDismiss,
  showClear,
  variant = "undercover",
  isLightTheme = false,
}: Props) {
  const colors = useColors();
  const inputRef = useRef<TextInput>(null);
  const hasText = value.trim().length > 0;
  const clearVisible = showClear ?? hasText;
  const fieldHeightPx =
    variant === "liquidGlass" ? LIQUID_GLASS_FIELD_HEIGHT_PX : MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX;
  const [liquidGlassWidth, setLiquidGlassWidth] = useState(0);

  const onLiquidGlassLayout = (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.width);
    setLiquidGlassWidth((current) => (current === next ? current : next));
  };

  const inputNode = (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      placeholderTextColor={colors.secondary}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      returnKeyType="search"
      accessibilityRole="search"
      accessibilityLabel={placeholder}
      style={[
        styles.input,
        typographyFixedRow30Label,
        {
          color: colors.primary,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          paddingRight: clearVisible ? CLEAR_HIT_PX : TEXT_INSET_X_PX,
          height: fieldHeightPx,
          ...(Platform.OS === "web"
            ? ({ outlineStyle: "none" } as Record<string, string>)
            : {}),
        },
      ]}
    />
  );

  const clearNode = clearVisible ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={clearAccessibilityLabel}
      hitSlop={8}
      onPress={() => {
        if (hasText) {
          onChangeText("");
          return;
        }
        inputRef.current?.blur();
        onDismiss?.();
      }}
      {...(Platform.OS === "web"
        ? {
            onMouseDown: (event: { preventDefault?: () => void }) => {
              if (hasText) event.preventDefault?.();
            },
          }
        : {})}
      style={({ pressed }) => [
        styles.clear,
        { height: fieldHeightPx, opacity: pressed ? 0.65 : 1 },
      ]}
    >
      <VoiceWindowCrossIcon color={colors.secondary} size={13} />
    </Pressable>
  ) : null;

  if (variant === "liquidGlass") {
    return (
      <View
        onLayout={onLiquidGlassLayout}
        style={[
          styles.liquidGlassShell,
          {
            height: fieldHeightPx,
            marginBottom: marginBottomPx,
          },
        ]}
      >
        {liquidGlassWidth > 0 ? (
          <LiquidGlassShaderUndercover
            key={liquidGlassWidth}
            shape="pill"
            width={liquidGlassWidth}
            height={fieldHeightPx}
            contentInsetPx={0}
            phaseOffset={0.22}
            isLightTheme={isLightTheme}
            capturePointerEvents={false}
          >
            <View style={[styles.liquidGlassInner, { width: liquidGlassWidth, height: fieldHeightPx }]}>
              {inputNode}
              {clearNode}
            </View>
          </LiquidGlassShaderUndercover>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.field,
        {
          height: fieldHeightPx,
          marginBottom: marginBottomPx,
          backgroundColor: colors.undercover,
        },
      ]}
    >
      {inputNode}
      {clearNode}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    width: "100%",
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  liquidGlassShell: {
    width: "100%",
    alignSelf: "stretch",
    flex: 1,
    minWidth: 0,
  },
  liquidGlassInner: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: TEXT_INSET_X_PX,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  clear: {
    position: "absolute",
    right: 0,
    top: 0,
    width: CLEAR_HIT_PX,
    alignItems: "center",
    justifyContent: "center",
  },
});
