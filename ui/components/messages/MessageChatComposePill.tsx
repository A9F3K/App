import { useCallback, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, uiTextVerticalCompensationY, useColors } from "../../theme";
import { BottomBarSendCircleButton } from "../BottomBarSendCircleButton";
import {
  MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_PADDING_LEFT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_PADDING_RIGHT_PX,
  MESSAGE_CHAT_COMPOSE_PILL_RADIUS_PX,
} from "./messageChatLayout";

type Props = {
  placeholder: string;
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: (text: string) => void;
  sendAccessibilityLabel: string;
  canSend: boolean;
};

const INPUT_FONT_SIZE_PX = 15;
const INPUT_LINE_HEIGHT_PX = 20;

/** Pill compose field — same height and border as the scroll-to-bottom FAB. */
export function MessageChatComposePill({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  sendAccessibilityLabel,
  canSend,
}: Props) {
  const colors = useColors();
  const [isFocused, setIsFocused] = useState(false);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || !canSend) return;
    onSubmit(text);
  }, [canSend, onSubmit, value]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: MESSAGE_CHAT_COMPOSE_PILL_HEIGHT_PX,
        borderRadius: MESSAGE_CHAT_COMPOSE_PILL_RADIUS_PX,
        borderWidth: 1,
        borderColor: colors.highlight,
        backgroundColor: colors.background,
        paddingLeft: MESSAGE_CHAT_COMPOSE_PILL_PADDING_LEFT_PX,
        paddingRight: MESSAGE_CHAT_COMPOSE_PILL_PADDING_RIGHT_PX,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        {Platform.OS === "web" ? (
          <textarea
            value={value}
            rows={1}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
              e.preventDefault();
              submit();
            }}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={isFocused ? "" : placeholder}
            style={{
              width: "100%",
              height: INPUT_LINE_HEIGHT_PX,
              resize: "none",
              border: "none",
              outline: "none",
              margin: 0,
              padding: 0,
              boxSizing: "border-box",
              fontSize: INPUT_FONT_SIZE_PX,
              lineHeight: `${INPUT_LINE_HEIGHT_PX}px`,
              color: colors.primary,
              backgroundColor: "transparent",
              caretColor: colors.primary,
              fontFamily: WEB_UI_SANS_STACK,
              fontWeight: 400,
              transform: `translateY(${uiTextVerticalCompensationY}px)`,
              overflow: "hidden",
            }}
          />
        ) : (
          <TextInput
            value={value}
            onChangeText={onChangeText}
            onSubmitEditing={submit}
            returnKeyType="send"
            blurOnSubmit={false}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={isFocused ? "" : placeholder}
            placeholderTextColor={colors.secondary}
            style={[
              typographyRect15,
              {
                height: INPUT_LINE_HEIGHT_PX,
                paddingVertical: 0,
                paddingHorizontal: 0,
                color: colors.primary,
              },
            ]}
          />
        )}
      </View>
      <BottomBarSendCircleButton
        iconColor={colors.primary}
        undercoverColor={colors.undercover}
        onPress={submit}
        iconRotationDeg={-45}
        accessibilityLabel={sendAccessibilityLabel}
      />
    </View>
  );
}
