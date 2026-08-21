import { useCallback, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";

import { layout } from "../theme";
import { SmartGradientDivider } from "./smart/SmartGradientDivider";

const DEFAULT_PAD_V_PX = 15;

type Props = {
  children: ReactNode;
  /** Vertical padding around the CTA row (below the gradient). */
  paddingVerticalPx?: number;
  /** Reports total block height (divider + padded row) for scroll-thumb extension. */
  onHeightChange?: (heightPx: number) => void;
};

/**
 * Content-padded gradient “semi-divider” + call-to-action row.
 * Scroll indicators should extend through this block (see `scrollIndicatorExtendBottomPx`).
 */
export function PanelGradientCtaBlock({
  children,
  paddingVerticalPx = DEFAULT_PAD_V_PX,
  onHeightChange,
}: Props) {
  const contentInset = layout.contentSideInsetPx;

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeightChange?.(Math.round(event.nativeEvent.layout.height));
    },
    [onHeightChange],
  );

  return (
    <View style={{ width: "100%", alignSelf: "stretch" }} onLayout={onLayout}>
      <SmartGradientDivider horizontalPaddingPx={contentInset} />
      <View style={{ width: "100%", paddingVertical: paddingVerticalPx }}>{children}</View>
    </View>
  );
}
