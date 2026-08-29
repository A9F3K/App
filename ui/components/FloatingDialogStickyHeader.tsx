import { useCallback, type ReactNode } from "react";
import { Platform, Text, View, type LayoutChangeEvent } from "react-native";

import { useColors } from "../theme";
import { FloatingDialogCloseButton } from "./FloatingDialogCloseButton";
import {
  floatingDialogDragHandleDomProps,
  floatingDialogDragHandleWebStyle,
  useFloatingDialogDragHandle,
} from "./FloatingDialogShell";
import {
  floatingDialogTitleTextStyle,
  resolveFloatingDialogInsets,
} from "./floatingDialogChrome";
import { SmartGradientDivider } from "./smart/SmartGradientDivider";

type Insets = ReturnType<typeof resolveFloatingDialogInsets>;

type Props = {
  insets: Insets;
  onClose: () => void;
  closeLabel: string;
  title?: string;
  hideTitle?: boolean;
  leading?: ReactNode;
  titleAlign?: "left" | "center";
  onHeightChange?: (heightPx: number) => void;
};

/** Sticky dialog title row, close control, and gradient rule below. */
export function FloatingDialogStickyHeader({
  insets,
  onClose,
  closeLabel,
  title,
  hideTitle = false,
  leading,
  titleAlign = "left",
  onHeightChange,
}: Props) {
  const colors = useColors();
  const moveDrag = useFloatingDialogDragHandle();

  const onBlockLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      if (h > 0) onHeightChange?.(h);
    },
    [onHeightChange],
  );

  return (
    <View
      pointerEvents="auto"
      onLayout={onBlockLayout}
      style={{
        flexShrink: 0,
        backgroundColor: colors.background,
        zIndex: 4,
        ...(Platform.OS === "web"
          ? ({
              position: "relative",
              cursor: moveDrag?.movingSheet ? "grabbing" : "grab",
              userSelect: "none",
              touchAction: "none",
            } as object)
          : floatingDialogDragHandleWebStyle),
      }}
      {...floatingDialogDragHandleDomProps}
      {...(Platform.OS === "web" && moveDrag
        ? ({ onPointerDown: moveDrag.onDragHandlePointerDown } as object)
        : {})}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
          paddingHorizontal: insets.padX,
          paddingTop: insets.headerPadTop,
          paddingBottom: insets.headerPadBottom,
        }}
      >
        {leading}
        {hideTitle || !title ? (
          <View style={{ flex: 1, minWidth: 0, minHeight: 28 }} />
        ) : (
          <Text
            style={[
              floatingDialogTitleTextStyle,
              {
                color: colors.primary,
                flex: 1,
                minWidth: 0,
                paddingRight: 8,
                textAlign: titleAlign,
              },
            ]}
            numberOfLines={titleAlign === "center" ? 1 : undefined}
          >
            {title}
          </Text>
        )}
        <FloatingDialogCloseButton label={closeLabel} onPress={onClose} />
      </View>
      <SmartGradientDivider bleedPastContentInset={false} horizontalPaddingPx={0} />
    </View>
  );
}
