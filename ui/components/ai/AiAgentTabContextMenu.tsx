/**
 * Context menu for AI agent tabs — Rename / Delete (message-menu chrome).
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, type ThemeColors } from "../../theme";

export type AiAgentTabMenuAnchor = { x: number; y: number };

const MENU_PADDING_PX = 15;
const MENU_ITEM_HEIGHT_PX = 15;
const MENU_ITEM_GAP_PX = 20;
const MENU_MIN_WIDTH_PX = 120;
const MENU_VIEWPORT_MARGIN_PX = 8;

type Props = {
  visible: boolean;
  anchor: AiAgentTabMenuAnchor | null;
  colors: ThemeColors;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
};

function menuHeightPx(): number {
  return MENU_PADDING_PX * 2 + MENU_ITEM_HEIGHT_PX * 2 + MENU_ITEM_GAP_PX;
}

function clampMenuPosition(
  anchor: AiAgentTabMenuAnchor,
  menuWidth: number,
  menuHeight: number,
  windowWidth: number,
  windowHeight: number,
): { left: number; top: number } {
  let left = anchor.x;
  let top = anchor.y;
  if (left + menuWidth > windowWidth - MENU_VIEWPORT_MARGIN_PX) {
    left = Math.max(MENU_VIEWPORT_MARGIN_PX, windowWidth - menuWidth - MENU_VIEWPORT_MARGIN_PX);
  }
  if (top + menuHeight > windowHeight - MENU_VIEWPORT_MARGIN_PX) {
    top = Math.max(MENU_VIEWPORT_MARGIN_PX, windowHeight - menuHeight - MENU_VIEWPORT_MARGIN_PX);
  }
  return {
    left: Math.max(MENU_VIEWPORT_MARGIN_PX, left),
    top: Math.max(MENU_VIEWPORT_MARGIN_PX, top),
  };
}

function ContextMenuDivider({ color }: { color: string }) {
  const gradientId = useId();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <View
      style={{
        height: MENU_ITEM_GAP_PX,
        justifyContent: "center",
        alignSelf: "stretch",
      }}
      onLayout={onLayout}
    >
      {width > 0 ? (
        <Svg width={width} height={1} viewBox={`0 0 ${width} 1`}>
          <Defs>
            <LinearGradient id={gradientId} x1="0%" y1="0" x2="100%" y2="0">
              <Stop offset="0%" stopColor={color} stopOpacity={0} />
              <Stop offset="50%" stopColor={color} stopOpacity={1} />
              <Stop offset="100%" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={width} height={1} fill={`url(#${gradientId})`} />
        </Svg>
      ) : null}
    </View>
  );
}

function Panel({
  colors,
  onRename,
  onDelete,
  onLayout,
}: {
  colors: ThemeColors;
  onRename: () => void;
  onDelete: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useAppStrings();
  const textStyle = useMemo(
    () => [
      typographyRect15,
      {
        color: colors.primary,
        height: MENU_ITEM_HEIGHT_PX,
        lineHeight: MENU_ITEM_HEIGHT_PX,
        fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        includeFontPadding: false,
        textAlign: "left" as const,
      },
    ],
    [colors.primary],
  );

  return (
    <View
      onLayout={onLayout}
      style={{
        minWidth: MENU_MIN_WIDTH_PX,
        padding: MENU_PADDING_PX,
        backgroundColor: colors.undercover,
        borderWidth: 1,
        borderColor: colors.highlight,
        alignSelf: "flex-start",
        ...Platform.select({
          web: { boxSizing: "border-box" as const },
          default: {},
        }),
      }}
    >
      <Pressable
        onPress={onRename}
        style={({ pressed }) => ({
          height: MENU_ITEM_HEIGHT_PX,
          justifyContent: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={textStyle}>{t("ai.agents.rename")}</Text>
      </Pressable>
      <ContextMenuDivider color={colors.highlight} />
      <Pressable
        onPress={onDelete}
        style={({ pressed }) => ({
          height: MENU_ITEM_HEIGHT_PX,
          justifyContent: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={textStyle}>{t("ai.agents.delete")}</Text>
      </Pressable>
    </View>
  );
}

function MenuNative(props: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuSize, setMenuSize] = useState({ w: MENU_MIN_WIDTH_PX, h: menuHeightPx() });
  if (!props.visible || !props.anchor) return null;
  const pos = clampMenuPosition(
    props.anchor,
    menuSize.w,
    menuSize.h,
    windowWidth,
    windowHeight,
  );
  return (
    <Modal visible transparent animationType="none" onRequestClose={props.onClose}>
      <Pressable style={{ flex: 1 }} onPress={props.onClose}>
        <View
          style={{ position: "absolute", left: pos.left, top: pos.top }}
          onStartShouldSetResponder={() => true}
        >
          <Panel
            colors={props.colors}
            onRename={() => {
              props.onRename();
              props.onClose();
            }}
            onDelete={() => {
              props.onDelete();
              props.onClose();
            }}
            onLayout={(e) =>
              setMenuSize({
                w: e.nativeEvent.layout.width,
                h: e.nativeEvent.layout.height,
              })
            }
          />
        </View>
      </Pressable>
    </Modal>
  );
}

function MenuWeb(props: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuSize, setMenuSize] = useState({ w: MENU_MIN_WIDTH_PX, h: menuHeightPx() });

  useEffect(() => {
    if (!props.visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.visible, props.onClose]);

  if (!props.visible || !props.anchor || typeof document === "undefined") return null;
  const pos = clampMenuPosition(
    props.anchor,
    menuSize.w,
    menuSize.h,
    windowWidth,
    windowHeight,
  );

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div
        style={{
          position: "absolute",
          left: pos.left,
          top: pos.top,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Panel
          colors={props.colors}
          onRename={() => {
            props.onRename();
            props.onClose();
          }}
          onDelete={() => {
            props.onDelete();
            props.onClose();
          }}
          onLayout={(e) =>
            setMenuSize({
              w: e.nativeEvent.layout.width,
              h: e.nativeEvent.layout.height,
            })
          }
        />
      </div>
    </div>,
    document.body,
  );
}

export function AiAgentTabContextMenu(props: Props) {
  if (Platform.OS === "web") return <MenuWeb {...props} />;
  return <MenuNative {...props} />;
}
