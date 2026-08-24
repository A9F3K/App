import { createElement, type ReactNode } from "react";
import { Platform, Pressable } from "react-native";
import { useColors } from "../theme";
import { VoiceWindowCrossIcon } from "./messages/MessageChatVoiceControlIcons";

export const FLOATING_DIALOG_CLOSE_HIT_PX = 28;
export const FLOATING_DIALOG_CLOSE_ICON_PX = 15;

type Props = {
  label: string;
  onPress: () => void;
  /** Optional absolute / layout overrides (e.g. `position: "absolute", top: 0, right: 0`). */
  style?: object;
  /** When false, skip theme primary and use {@link color}. */
  color?: string;
};

/**
 * Dialog close control matching the messages side menu:
 * 28×28 hit target, 15px X, primary color, pressed opacity 0.7.
 */
export function FloatingDialogCloseButton({
  label,
  onPress,
  style,
  color,
}: Props) {
  const colors = useColors();
  const iconColor = color ?? colors.primary;
  const icon = (
    <VoiceWindowCrossIcon color={iconColor} size={FLOATING_DIALOG_CLOSE_ICON_PX} />
  );

  if (Platform.OS === "web") {
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": label,
        title: label,
        "data-floating-no-drag": "1",
        "data-floating-close": "1",
        onPointerDown: (e: {
          stopPropagation?: () => void;
          preventDefault?: () => void;
          button?: number;
        }) => {
          e.stopPropagation?.();
          e.preventDefault?.();
          if (e.button == null || e.button === 0) onPress();
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
          width: FLOATING_DIALOG_CLOSE_HIT_PX,
          height: FLOATING_DIALOG_CLOSE_HIT_PX,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
          WebkitAppearance: "none",
          appearance: "none",
          touchAction: "manipulation",
          ...(style ?? {}),
        },
      },
      createElement("span", { style: { pointerEvents: "none", display: "flex" } }, icon),
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={(e) => {
        (e as { stopPropagation?: () => void }).stopPropagation?.();
        onPress();
      }}
      style={({ pressed }) => ({
        width: FLOATING_DIALOG_CLOSE_HIT_PX,
        height: FLOATING_DIALOG_CLOSE_HIT_PX,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
        ...(style as object),
      })}
    >
      {icon}
    </Pressable>
  );
}

/** Optional wrapper when a dialog needs a non-X close child with the same hit box. */
export function FloatingDialogChromeHitTarget({
  label,
  onPress,
  children,
  style,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  style?: object;
}) {
  if (Platform.OS === "web") {
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": label,
        title: label,
        "data-floating-no-drag": "1",
        onPointerDown: (e: {
          stopPropagation?: () => void;
          preventDefault?: () => void;
          button?: number;
        }) => {
          e.stopPropagation?.();
          e.preventDefault?.();
          if (e.button == null || e.button === 0) onPress();
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
          width: FLOATING_DIALOG_CLOSE_HIT_PX,
          height: FLOATING_DIALOG_CLOSE_HIT_PX,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
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
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({
        width: FLOATING_DIALOG_CLOSE_HIT_PX,
        height: FLOATING_DIALOG_CLOSE_HIT_PX,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
        ...(style as object),
      })}
    >
      {children}
    </Pressable>
  );
}
