import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppStringKey } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, type ThemeColors } from "../../theme";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  ChatMenuArchiveIcon,
  ChatMenuBlockIcon,
  ChatMenuClearHistoryIcon,
  ChatMenuDeleteIcon,
  ChatMenuGroupInfoIcon,
  ChatMenuLeaveIcon,
  ChatMenuMarkReadIcon,
  ChatMenuMarkUnreadIcon,
  ChatMenuOpenWindowIcon,
  ChatMenuPinIcon,
  ChatMenuProfileIcon,
  ChatMenuUnmuteIcon,
  ChatMenuUnpinIcon,
} from "./MessageChatListContextMenuIcons";

export type ChatListMenuAnchor = {
  x: number;
  y: number;
};

type MenuIcon = ComponentType<{ color: string; size?: number }>;

type ChatListMenuItem = {
  key: string;
  label: string;
  Icon: MenuIcon;
  disabled?: boolean;
  destructive?: boolean;
  dividerAfter?: boolean;
  onPress?: () => void;
};

const MENU_PADDING_PX = 8;
const MENU_ITEM_HEIGHT_PX = 32;
const MENU_ICON_PX = 18;
const MENU_DIVIDER_BLOCK_PX = 9;
const MENU_MIN_WIDTH_PX = 220;
const MENU_VIEWPORT_MARGIN_PX = 8;
const DESTRUCTIVE_COLOR = "#e53935";
const DISABLED_OPACITY = 0.55;

type Props = {
  visible: boolean;
  anchor: ChatListMenuAnchor | null;
  colors: ThemeColors;
  row: MessageChatRowData | null;
  onClose: () => void;
  onTogglePin: (row: MessageChatRowData) => void;
  onViewProfile: (row: MessageChatRowData) => void;
};

function isBotChat(row: MessageChatRowData): boolean {
  return (
    Boolean(row.peer_is_bot) ||
    (row.chat_kind === "private" && Boolean(row.peer_username?.toLowerCase().endsWith("bot")))
  );
}

function isGroupLikeChat(row: MessageChatRowData): boolean {
  return row.chat_kind === "group" || row.chat_kind === "supergroup" || row.chat_kind === "channel";
}

function menuHeightPx(items: ChatListMenuItem[]): number {
  let height = MENU_PADDING_PX * 2;
  for (let i = 0; i < items.length; i++) {
    height += MENU_ITEM_HEIGHT_PX;
    if (items[i]?.dividerAfter && i < items.length - 1) {
      height += MENU_DIVIDER_BLOCK_PX;
    }
  }
  return Math.max(MENU_ITEM_HEIGHT_PX + MENU_PADDING_PX * 2, height);
}

function clampMenuPosition(
  anchor: ChatListMenuAnchor,
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

function buildChatListMenuItems(
  row: MessageChatRowData,
  t: (key: AppStringKey) => string,
  onTogglePin: (row: MessageChatRowData) => void,
  onViewProfile: (row: MessageChatRowData) => void,
): ChatListMenuItem[] {
  const pinned = Boolean(row.is_pinned);
  const unread = (row.unread_count ?? 0) > 0;
  const pinItem: ChatListMenuItem = {
    key: pinned ? "unpin" : "pin",
    label: t(pinned ? "messages.chatMenu.unpin" : "messages.chatMenu.pin"),
    Icon: pinned ? ChatMenuUnpinIcon : ChatMenuPinIcon,
    onPress: () => onTogglePin(row),
  };
  const viewProfileItem: ChatListMenuItem = {
    key: "viewProfile",
    label: t("messages.chatMenu.viewProfile"),
    Icon: ChatMenuProfileIcon,
    onPress: () => onViewProfile(row),
  };
  const viewGroupItem: ChatListMenuItem = {
    key: "viewGroupInfo",
    label: t("messages.chatMenu.viewGroupInfo"),
    Icon: ChatMenuGroupInfoIcon,
    onPress: () => onViewProfile(row),
  };
  const openWindow: ChatListMenuItem = {
    key: "openInNewWindow",
    label: t("messages.chatMenu.openInNewWindow"),
    Icon: ChatMenuOpenWindowIcon,
    disabled: true,
    dividerAfter: true,
  };
  const archive: ChatListMenuItem = {
    key: "archive",
    label: t("messages.chatMenu.archive"),
    Icon: ChatMenuArchiveIcon,
    disabled: true,
  };

  if (isBotChat(row)) {
    return [
      openWindow,
      archive,
      pinItem,
      viewProfileItem,
      {
        key: "stopAndBlockBot",
        label: t("messages.chatMenu.stopAndBlockBot"),
        Icon: ChatMenuBlockIcon,
        disabled: true,
      },
      {
        key: "clearHistory",
        label: t("messages.chatMenu.clearHistory"),
        Icon: ChatMenuClearHistoryIcon,
        disabled: true,
      },
      {
        key: "deleteChat",
        label: t("messages.chatMenu.deleteChat"),
        Icon: ChatMenuDeleteIcon,
        disabled: true,
        destructive: true,
      },
    ];
  }

  if (isGroupLikeChat(row)) {
    return [
      openWindow,
      archive,
      pinItem,
      viewGroupItem,
      {
        key: "unmute",
        label: t("messages.chatMenu.unmute"),
        Icon: ChatMenuUnmuteIcon,
        disabled: true,
      },
      {
        key: unread ? "markAsRead" : "markAsUnread",
        label: t(unread ? "messages.chatMenu.markAsRead" : "messages.chatMenu.markAsUnread"),
        Icon: unread ? ChatMenuMarkReadIcon : ChatMenuMarkUnreadIcon,
        disabled: true,
      },
      {
        key: "leaveGroup",
        label: t("messages.chatMenu.leaveGroup"),
        Icon: ChatMenuLeaveIcon,
        disabled: true,
        destructive: true,
      },
    ];
  }

  return [
    openWindow,
    archive,
    pinItem,
    viewProfileItem,
    {
      key: "unmute",
      label: t("messages.chatMenu.unmute"),
      Icon: ChatMenuUnmuteIcon,
      disabled: true,
    },
    {
      key: unread ? "markAsRead" : "markAsUnread",
      label: t(unread ? "messages.chatMenu.markAsRead" : "messages.chatMenu.markAsUnread"),
      Icon: unread ? ChatMenuMarkReadIcon : ChatMenuMarkUnreadIcon,
      disabled: true,
    },
    {
      key: "blockUser",
      label: t("messages.chatMenu.blockUser"),
      Icon: ChatMenuBlockIcon,
      disabled: true,
    },
    {
      key: "clearHistory",
      label: t("messages.chatMenu.clearHistory"),
      Icon: ChatMenuClearHistoryIcon,
      disabled: true,
    },
    {
      key: "deleteChat",
      label: t("messages.chatMenu.deleteChat"),
      Icon: ChatMenuDeleteIcon,
      disabled: true,
      destructive: true,
    },
  ];
}

function ChatListMenuPanel({
  colors,
  items,
  onLayout,
  onClose,
}: {
  colors: ThemeColors;
  items: ChatListMenuItem[];
  onLayout?: (event: LayoutChangeEvent) => void;
  onClose: () => void;
}) {
  const textStyle = useMemo(
    () => [
      typographyRect15,
      {
        flex: 1,
        fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        includeFontPadding: false,
        textAlign: "left" as const,
      },
    ],
    [],
  );

  return (
    <View
      onLayout={onLayout}
      style={{
        minWidth: MENU_MIN_WIDTH_PX,
        paddingVertical: MENU_PADDING_PX,
        paddingHorizontal: 10,
        backgroundColor: colors.undercover,
        borderWidth: 1,
        borderColor: colors.highlight,
        alignSelf: "flex-start",
        ...Platform.select({
          web: {
            boxSizing: "border-box" as const,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          },
          default: {},
        }),
      }}
    >
      {items.map((item) => {
        const color = item.destructive ? DESTRUCTIVE_COLOR : colors.primary;
        const body = (
          <>
            <View style={{ width: 22, alignItems: "center", justifyContent: "center" }}>
              <item.Icon color={color} size={MENU_ICON_PX} />
            </View>
            <Text numberOfLines={1} style={[textStyle, { color }]}>
              {item.label}
            </Text>
          </>
        );
        return (
          <View key={item.key}>
            {item.disabled || !item.onPress ? (
              <View
                style={{
                  minHeight: MENU_ITEM_HEIGHT_PX,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  opacity: DISABLED_OPACITY,
                }}
                accessibilityState={{ disabled: true }}
              >
                {body}
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  item.onPress?.();
                }}
                style={({ pressed }) => ({
                  minHeight: MENU_ITEM_HEIGHT_PX,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {body}
              </Pressable>
            )}
            {item.dividerAfter ? (
              <View style={{ height: MENU_DIVIDER_BLOCK_PX, justifyContent: "center" }}>
                <View style={{ height: 1, backgroundColor: colors.highlight, opacity: 0.7 }} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function MessageChatListContextMenuNative({
  visible,
  anchor,
  colors,
  items,
  onClose,
}: {
  visible: boolean;
  anchor: ChatListMenuAnchor | null;
  colors: ThemeColors;
  items: ChatListMenuItem[];
  onClose: () => void;
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuWidth, setMenuWidth] = useState(MENU_MIN_WIDTH_PX);
  const menuHeight = menuHeightPx(items);
  const position =
    anchor != null
      ? clampMenuPosition(anchor, menuWidth, menuHeight, windowWidth, windowHeight)
      : { left: MENU_VIEWPORT_MARGIN_PX, top: MENU_VIEWPORT_MARGIN_PX };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: position.left,
            top: position.top,
          }}
        >
          <ChatListMenuPanel
            colors={colors}
            items={items}
            onClose={onClose}
            onLayout={(event) => {
              const next = Math.ceil(event.nativeEvent.layout.width);
              if (next > 0) setMenuWidth(next);
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

function MessageChatListContextMenuWeb({
  visible,
  anchor,
  colors,
  items,
  onClose,
}: {
  visible: boolean;
  anchor: ChatListMenuAnchor | null;
  colors: ThemeColors;
  items: ChatListMenuItem[];
  onClose: () => void;
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuWidth, setMenuWidth] = useState(MENU_MIN_WIDTH_PX);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const menuHeight = menuHeightPx(items);

  useEffect(() => {
    if (typeof document !== "undefined") {
      setPortalTarget(document.body);
    }
  }, []);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, visible]);

  if (!visible || !anchor || !portalTarget) return null;

  const position = clampMenuPosition(anchor, menuWidth, menuHeight, windowWidth, windowHeight);

  return createPortal(
    <View
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 10050,
      }}
      pointerEvents="box-none"
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View
        pointerEvents="box-none"
        style={{
          position: "fixed",
          left: position.left,
          top: position.top,
        }}
      >
        <ChatListMenuPanel
          colors={colors}
          items={items}
          onClose={onClose}
          onLayout={(event) => {
            const next = Math.ceil(event.nativeEvent.layout.width);
            if (next > 0) setMenuWidth(next);
          }}
        />
      </View>
    </View>,
    portalTarget,
  );
}

export function MessageChatListContextMenu({
  visible,
  anchor,
  colors,
  row,
  onClose,
  onTogglePin,
  onViewProfile,
}: Props) {
  const { t } = useAppStrings();
  const items = useMemo(
    () => (row ? buildChatListMenuItems(row, t, onTogglePin, onViewProfile) : []),
    [onTogglePin, onViewProfile, row, t],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (Platform.OS === "web") {
    return (
      <MessageChatListContextMenuWeb
        visible={visible && items.length > 0}
        anchor={anchor}
        colors={colors}
        items={items}
        onClose={handleClose}
      />
    );
  }
  return (
    <MessageChatListContextMenuNative
      visible={visible && items.length > 0}
      anchor={anchor}
      colors={colors}
      items={items}
      onClose={handleClose}
    />
  );
}
