import { type ReactNode } from "react";
import { View, type ViewStyle } from "react-native";

type Props = {
  active: boolean;
  children: ReactNode;
  /** When false, the active slot sizes to content instead of filling the parent. */
  fillActive?: boolean;
};

const hiddenStyle = { display: "none" } as ViewStyle;

/**
 * Keeps children mounted while hidden so images, scroll position, and form state
 * survive header menu / tab switches on authenticated home.
 *
 * `fillActive` (default true): active slot uses flex:1. Set false for scroll-hosted
 * panels that must size to content (e.g. one-column chat search — avoids a tall empty gap).
 */
export function AuthenticatedHomePersistedPanelSlot({
  active,
  children,
  fillActive = true,
}: Props) {
  return (
    <View
      style={
        active
          ? {
              ...(fillActive ? { flex: 1, minHeight: 0 } : null),
              width: "100%",
              alignSelf: "stretch",
            }
          : hiddenStyle
      }
      pointerEvents={active ? "auto" : "none"}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
    >
      {children}
    </View>
  );
}
