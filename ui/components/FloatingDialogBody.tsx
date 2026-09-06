import { type ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Flex column for floating-dialog chrome: sticky header + scroll body + optional footer.
 * Marks the host so scroll-indicator math stops here (does not walk up to the full sheet height).
 *
 * `overflow: hidden` is required so the body keeps a flex-bounded height; otherwise RN-web
 * grows with content and {@link HspScrollColumn} never sees overflow (no thumb).
 * Keep the scroll thumb inside the shell (`scrollbarRightInsetPx` ≥ 0) so it is not clipped.
 */
export function FloatingDialogBody({ children, style }: Props) {
  return (
    <View
      collapsable={false}
      style={[
        {
          flex: 1,
          minHeight: 0,
          ...(Platform.OS === "web" ? ({ overflow: "hidden" } as object) : null),
        },
        style,
      ]}
      {...(Platform.OS === "web"
        ? ({
            "data-hsp-floating-dialog-body": "1",
            className: "hsp-floating-dialog-body",
          } as object)
        : {})}
    >
      {children}
    </View>
  );
}
