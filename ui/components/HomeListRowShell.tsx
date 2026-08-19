import { Pressable, View, useWindowDimensions, type ReactNode } from "react-native";
import {
  layout,
  type ThemeColors,
  type ThemeName,
  aiPromptButtonActiveBackground,
  aiPromptButtonHoverBackground,
} from "../theme";
import { useTelegram } from "./Telegram";
import {
  LIST_ROW_GAP_PX,
  LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX,
} from "./messages/messageListLayout";

type Props = {
  isLast: boolean;
  isActive?: boolean;
  colors: ThemeColors;
  onPress?: () => void;
  onLongPress?: () => void;
  onHoverIn?: () => void;
  children: ReactNode;
};

function rowShellBackground(
  colors: ThemeColors,
  scheme: ThemeName,
  state: { pressed: boolean; hovered: boolean },
  isActive: boolean,
): string {
  if (isActive) return colors.undercover;
  if (state.pressed) return aiPromptButtonActiveBackground(colors, scheme);
  if (state.hovered) return aiPromptButtonHoverBackground(colors, scheme);
  return "transparent";
}

/**
 * Feed / Messages row chrome. Narrow: 15px gaps between rows. Wide (`> firstBreakpoint`):
 * 7.5px vertical pad per row (adjacent pads = 15px gap), no inter-row margin;
 * list shell top/bottom inset is also 7.5px so the first/last row match inter-row rhythm.
 */
export function HomeListRowShell({
  isLast,
  isActive = false,
  colors,
  onPress,
  onLongPress,
  onHoverIn,
  children,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const { colorScheme } = useTelegram();
  const widePressHighlight = windowWidth > layout.authenticatedHome.firstBreakpoint;
  const columnBleedPx = layout.contentSideInsetPx;

  if (!widePressHighlight) {
    return (
      <View
        style={{
          width: "100%",
          alignSelf: "stretch",
          marginBottom: isLast ? 0 : LIST_ROW_GAP_PX,
        }}
      >
        {children}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      onLongPress={onLongPress}
      onHoverIn={onHoverIn}
      style={({ pressed, hovered }) => ({
        marginHorizontal: -columnBleedPx,
        paddingHorizontal: columnBleedPx,
        paddingVertical: LIST_ROW_PRESS_HIGHLIGHT_PADDING_Y_PX,
        marginBottom: 0,
        alignSelf: "stretch",
        backgroundColor: rowShellBackground(
          colors,
          colorScheme,
          { pressed, hovered: hovered ?? false },
          isActive,
        ),
      })}
    >
      {children}
    </Pressable>
  );
}
