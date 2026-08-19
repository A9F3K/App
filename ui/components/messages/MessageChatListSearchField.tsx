import { useRef } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";

import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyFixedRow30Label, useColors } from "../../theme";
import { MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX } from "./messageListLayout";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";

const TEXT_INSET_X_PX = 12;
const CLEAR_HIT_PX = 30;

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
}: Props) {
  const colors = useColors();
  const inputRef = useRef<TextInput>(null);
  const hasText = value.trim().length > 0;
  const clearVisible = showClear ?? hasText;

  return (
    <View
      style={[
        styles.field,
        {
          height: MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX,
          marginBottom: marginBottomPx,
          backgroundColor: colors.undercover,
        },
      ]}
    >
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
            ...(Platform.OS === "web"
              ? ({ outlineStyle: "none" } as Record<string, string>)
              : {}),
          },
        ]}
      />
      {clearVisible ? (
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
          style={({ pressed }) => [styles.clear, { opacity: pressed ? 0.65 : 1 }]}
        >
          <VoiceWindowCrossIcon color={colors.secondary} size={13} />
        </Pressable>
      ) : null}
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
  input: {
    flex: 1,
    minWidth: 0,
    height: "100%",
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
    height: MESSAGE_CHAT_LIST_SEARCH_FIELD_HEIGHT_PX,
    alignItems: "center",
    justifyContent: "center",
  },
});
