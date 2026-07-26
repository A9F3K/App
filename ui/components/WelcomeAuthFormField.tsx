import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";
import {
  typographyFixedRow40Label,
  typographyRect15,
  uiTextVerticalCompensationTransform,
  useColors,
  welcomeAuthButtonActiveBackground,
  welcomeAuthButtonHoverBackground,
} from "../theme";
import { useTelegram } from "./Telegram";

export const WELCOME_AUTH_MAX_WIDTH = 360;

const BUTTON_HEIGHT = 40;
const EMAIL_ROW_LINE_HEIGHT = 21;
const BUTTON_H_PADDING = 20;
const EMAIL_LABEL_TO_INPUT_GAP = 10;
const INPUT_TO_BUTTON_GAP = 20;
const INPUT_TO_BUTTON_GAP_WITH_ERROR = 10;
const ERROR_LINE_HEIGHT = 30;
const INPUT_TEXT_INSET_LEFT = 10;

type Props = {
  label?: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  keyboardType?: "default" | "email-address" | "phone-pad" | "number-pad";
  textContentType?: "telephoneNumber" | "oneTimeCode" | "password" | "none";
  secureTextEntry?: boolean;
  errorText?: string | null;
  submitLabel: string;
  onSubmit: () => void;
  submitDisabled?: boolean;
  submitting?: boolean;
  inputId?: string;
};

export function WelcomeAuthFormField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  textContentType,
  secureTextEntry,
  errorText,
  submitLabel,
  onSubmit,
  submitDisabled,
  submitting,
  inputId,
}: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hoverSubmit, setHoverSubmit] = useState(false);

  return (
    <View style={styles.block}>
      {label ? (
        <Text style={[styles.label, { color: colors.primary }]}>{label}</Text>
      ) : null}
      <View
        style={[
          styles.inputShell,
          {
            backgroundColor: colors.undercover,
            borderColor: colors.accent,
            marginTop: label ? EMAIL_LABEL_TO_INPUT_GAP : 0,
            ...(Platform.OS === "web"
              ? ({
                  "--welcome-email-autofill-bg": colors.undercover,
                  "--welcome-email-autofill-fg": colors.primary,
                } as Record<string, string>)
              : {}),
          },
        ]}
      >
        <TextInput
          {...(Platform.OS === "web" && inputId ? { id: inputId } : {})}
          style={[styles.inputInner, { color: colors.primary }]}
          placeholder={placeholder}
          placeholderTextColor={colors.secondary}
          keyboardType={keyboardType}
          textContentType={textContentType}
          secureTextEntry={secureTextEntry}
          autoCapitalize="none"
          autoCorrect={false}
          value={value}
          onChangeText={onChangeText}
        />
      </View>
      {errorText ? (
        <Text style={[styles.errorText, { color: "#FF0000" }]}>{errorText}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={onSubmit}
        onHoverIn={Platform.OS === "web" ? () => setHoverSubmit(true) : undefined}
        onHoverOut={Platform.OS === "web" ? () => setHoverSubmit(false) : undefined}
        style={({ pressed }) => {
          const webHover = Platform.OS === "web" && hoverSubmit;
          let backgroundColor = colors.undercover;
          if (pressed) {
            backgroundColor = welcomeAuthButtonActiveBackground(colors, colorScheme);
          } else if (webHover) {
            backgroundColor = welcomeAuthButtonHoverBackground(colors, colorScheme);
          }
          return [
            styles.submitButton,
            {
              backgroundColor,
              marginTop: errorText ? INPUT_TO_BUTTON_GAP_WITH_ERROR : INPUT_TO_BUTTON_GAP,
              opacity: pressed ? 0.92 : 1,
            },
          ];
        }}
        disabled={submitDisabled || submitting}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Text style={[styles.submitLabel, { color: colors.primary }]}>{submitLabel}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    width: "100%",
    maxWidth: WELCOME_AUTH_MAX_WIDTH,
    alignSelf: "center",
  },
  label: {
    fontSize: 15,
    lineHeight: 30,
    fontWeight: "400",
    textAlign: "left",
  },
  inputShell: {
    width: "100%",
    maxWidth: WELCOME_AUTH_MAX_WIDTH,
    height: BUTTON_HEIGHT,
    borderWidth: 1,
    borderStyle: "solid",
    overflow: "hidden",
    ...Platform.select({
      web: {
        boxSizing: "border-box",
        minHeight: BUTTON_HEIGHT,
        maxHeight: BUTTON_HEIGHT,
      },
      default: {},
    }),
  },
  inputInner: {
    ...typographyRect15,
    ...Platform.select({
      web: typographyFixedRow40Label,
      default: uiTextVerticalCompensationTransform,
    }),
    flex: 1,
    alignSelf: "stretch",
    width: "100%",
    minHeight: BUTTON_HEIGHT,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingLeft: INPUT_TEXT_INSET_LEFT,
    paddingRight: BUTTON_H_PADDING,
    margin: 0,
    ...Platform.select({
      web: {
        paddingTop: (BUTTON_HEIGHT - EMAIL_ROW_LINE_HEIGHT) / 2,
        paddingBottom: (BUTTON_HEIGHT - EMAIL_ROW_LINE_HEIGHT) / 2,
        outlineWidth: 0,
        boxSizing: "border-box",
      },
      default: {
        paddingVertical: 0,
      },
    }),
  },
  errorText: {
    lineHeight: ERROR_LINE_HEIGHT,
    fontSize: 15,
    fontWeight: "400",
    textAlign: "center",
  },
  submitButton: {
    width: "100%",
    maxWidth: WELCOME_AUTH_MAX_WIDTH,
    height: BUTTON_HEIGHT,
    paddingHorizontal: BUTTON_H_PADDING,
    alignItems: "center",
    justifyContent: "center",
  },
  submitLabel: {
    ...typographyFixedRow40Label,
    flexShrink: 1,
  },
});
