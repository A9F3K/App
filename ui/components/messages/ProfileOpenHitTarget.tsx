/**
 * Web-safe hit target for opening profiles.
 * Nested RN `Pressable` inside list-row `Pressable` often swallows clicks on web;
 * a native `<button>` with stopPropagation matches the voice-dialog chrome pattern.
 */
import { createElement, type ReactNode } from "react";
import { Platform, Pressable } from "react-native";

type Props = {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
  hitSlopPx?: number;
  style?: object;
};

export function ProfileOpenHitTarget({
  label,
  onPress,
  children,
  disabled,
  hitSlopPx = 4,
  style,
}: Props) {
  if (Platform.OS === "web") {
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": label,
        title: label,
        "data-profile-open": "1",
        disabled: Boolean(disabled),
        onPointerDown: (e: {
          stopPropagation?: () => void;
          button?: number;
        }) => {
          e.stopPropagation?.();
          if (disabled) return;
          if (e.button == null || e.button === 0) {
            onPress();
          }
        },
        onClick: (e: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          e.stopPropagation?.();
          e.preventDefault?.();
        },
        style: {
          margin: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          flexShrink: 0,
          WebkitAppearance: "none",
          appearance: "none",
          touchAction: "manipulation",
          ...(style ?? {}),
        },
      },
      createElement("span", { style: { pointerEvents: "none", display: "flex" } }, children),
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlopPx}
      style={({ pressed }) => ({
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        ...(style as object),
      })}
    >
      {children}
    </Pressable>
  );
}
