import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { buildApiUrl } from "../../../api/_base";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppStringKey } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import {
  getMusicPlayer,
  MUSIC_CONTROL_BAR_HEIGHT_PX,
  subscribeMusicPlayer,
} from "../../music/musicPlayerStore";
import { useProfileSheet } from "../../profile/ProfileContext";
import { layout, typographyFixedRow30Label, useColors } from "../../theme";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { fetchTelegramUserProfile } from "../../telegram/fetchTelegramUserProfile";
import { useTelegram } from "../Telegram";
import { appModalSheetStyles } from "../AppModalSheet";
import { SettingsIcon } from "../icons/SettingsIcon";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { formatTelegramUsernameAt } from "./formatTelegramChatRowUsername";
import {
  SideMenuAddAccountIcon,
  SideMenuCallsIcon,
  SideMenuChannelIcon,
  SideMenuContactsIcon,
  SideMenuGroupIcon,
  SideMenuProfileIcon,
  SideMenuSavedIcon,
  SideMenuWalletIcon,
} from "./MessagesSideMenuIcons";
import { HspScrollColumn } from "../HspScrollColumn";

const SIDE_MENU_WIDTH_PX = 300;
const SIDE_MENU_Z = 10060;
const AVATAR_PX = 54;
const ACCOUNT_AVATAR_PX = 36;
const ROW_ICON_PX = 22;
const ROW_MIN_H = 44;
const PAD_X = layout.contentSideInsetPx;

type MenuRow = {
  key: string;
  labelKey: AppStringKey;
  Icon: (p: { color: string; size?: number }) => ReactElement;
  active?: boolean;
  onPress?: () => void;
};

type Props = {
  visible: boolean;
  onClose: () => void;
};

function SideMenuRow({
  label,
  Icon,
  colors,
  active = false,
  onPress,
}: {
  label: string;
  Icon: MenuRow["Icon"];
  colors: ReturnType<typeof useColors>;
  active?: boolean;
  onPress?: () => void;
}) {
  const iconColor = colors.primary;
  const labelColor = active ? colors.primary : colors.secondary;
  const body = (
    <>
      <View style={{ width: 28, alignItems: "center", justifyContent: "center" }}>
        <Icon color={iconColor} size={ROW_ICON_PX} />
      </View>
      <Text
        style={[
          typographyFixedRow30Label,
          {
            color: labelColor,
            flex: 1,
            fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </>
  );

  if (active && onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          minHeight: ROW_MIN_H,
          paddingHorizontal: PAD_X,
          gap: 14,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: ROW_MIN_H,
        paddingHorizontal: PAD_X,
        gap: 14,
        opacity: 0.55,
      }}
      accessibilityState={{ disabled: true }}
    >
      {body}
    </View>
  );
}

function AccountLogoutCross({
  colors,
  label,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.65 : onPress ? 0.75 : 0.45,
      })}
    >
      <VoiceWindowCrossIcon color={colors.secondary} size={12} />
    </Pressable>
  );
}

export function MessagesSideMenu({ visible, onClose }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { telegramUsername, colorScheme } = useTelegram();
  const {
    isTelegramMessagesConnected,
    connectedTelegramUserId,
    disconnectTelegramMessages,
  } = useTelegramMessagesConnection();
  const { openProfileSheet } = useProfileSheet();
  const { height: windowHeight } = useWindowDimensions();
  const musicSnap = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const musicTopInset = musicSnap.visible ? MUSIC_CONTROL_BAR_HEIGHT_PX : 0;
  const [mounted, setMounted] = useState(visible);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Telegram first + last name (and username) from TDLib profile — not the app display_name. */
  const [telegramDisplayName, setTelegramDisplayName] = useState<string | null>(null);
  const [telegramProfileUsername, setTelegramProfileUsername] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setDrawerOpen(true));
      return () => cancelAnimationFrame(frame);
    }
    setDrawerOpen(false);
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible || !isTelegramMessagesConnected || connectedTelegramUserId == null) {
      if (!isTelegramMessagesConnected) {
        setTelegramDisplayName(null);
        setTelegramProfileUsername(null);
      }
      return;
    }
    const controller = new AbortController();
    void fetchTelegramUserProfile(0, connectedTelegramUserId, controller.signal, {
      priority: "critical",
    }).then((result) => {
      if (controller.signal.aborted || !result.ok) return;
      const title = result.profile.title?.trim() || null;
      if (title) setTelegramDisplayName(title);
      if (result.profile.username?.trim()) {
        setTelegramProfileUsername(result.profile.username.trim());
      }
    });
    return () => controller.abort();
  }, [visible, isTelegramMessagesConnected, connectedTelegramUserId]);

  const resolvedUsername = telegramProfileUsername ?? telegramUsername;
  const usernameAt = formatTelegramUsernameAt(resolvedUsername);
  const profileTitle =
    telegramDisplayName?.trim() ||
    usernameAt?.replace(/^@+/, "") ||
    t("messages.sideMenu.myProfile");
  const avatarInitials = useMemo(() => extractChatAvatarInitials(profileTitle), [profileTitle]);
  const selfAvatarUrl = useMemo(() => {
    if (connectedTelegramUserId == null) return null;
    return buildApiUrl(
      `/api/telegram-messages-avatar?user_id=${encodeURIComponent(String(connectedTelegramUserId))}`,
    );
  }, [connectedTelegramUserId]);

  const handleDisconnect = useCallback(() => {
    onClose();
    void disconnectTelegramMessages();
  }, [disconnectTelegramMessages, onClose]);

  const openMyProfile = useCallback(() => {
    if (!isTelegramMessagesConnected) return;
    openProfileSheet({
      telegram_chat_id: 0,
      title: profileTitle,
      peer_user_id: connectedTelegramUserId,
      peer_username: resolvedUsername,
      chat_kind: "private",
      avatar_url: selfAvatarUrl,
    });
    onClose();
  }, [
    connectedTelegramUserId,
    isTelegramMessagesConnected,
    onClose,
    openProfileSheet,
    profileTitle,
    resolvedUsername,
    selfAvatarUrl,
  ]);

  /** Multi-account switcher appears only when two or more sessions are connected. */
  const connectedAccounts: Array<{
    key: string;
    title: string;
    usernameAt: string | null;
    avatarUrl: string | null;
    initials: string[];
  }> = useMemo(() => {
    if (!isTelegramMessagesConnected) return [];
    return [
      {
        key: "primary",
        title: profileTitle,
        usernameAt,
        avatarUrl: selfAvatarUrl,
        initials: avatarInitials,
      },
    ];
  }, [avatarInitials, isTelegramMessagesConnected, profileTitle, selfAvatarUrl, usernameAt]);
  const showAccountSwitcher = connectedAccounts.length >= 2;

  const navRows: MenuRow[] = useMemo(
    () => [
      {
        key: "profile",
        labelKey: "messages.sideMenu.myProfile",
        Icon: SideMenuProfileIcon,
        active: true,
        onPress: openMyProfile,
      },
      {
        key: "wallet",
        labelKey: "messages.sideMenu.wallet",
        Icon: SideMenuWalletIcon,
      },
      {
        key: "newGroup",
        labelKey: "messages.sideMenu.newGroup",
        Icon: SideMenuGroupIcon,
      },
      {
        key: "newChannel",
        labelKey: "messages.sideMenu.newChannel",
        Icon: SideMenuChannelIcon,
      },
      {
        key: "contacts",
        labelKey: "messages.sideMenu.contacts",
        Icon: SideMenuContactsIcon,
      },
      {
        key: "calls",
        labelKey: "messages.sideMenu.calls",
        Icon: SideMenuCallsIcon,
      },
      {
        key: "saved",
        labelKey: "messages.sideMenu.savedMessages",
        Icon: SideMenuSavedIcon,
      },
      {
        key: "settings",
        labelKey: "messages.sideMenu.messengerSettings",
        Icon: SettingsIcon,
      },
    ],
    [openMyProfile],
  );

  if (!mounted) return null;

  const panelHeight = Math.max(0, windowHeight - musicTopInset);
  const translateX = drawerOpen ? 0 : -SIDE_MENU_WIDTH_PX;

  const drawer = (
    <View
      pointerEvents="box-none"
      style={{
        position: Platform.OS === "web" ? ("fixed" as unknown as "absolute") : "absolute",
        left: 0,
        top: musicTopInset,
        right: 0,
        height: panelHeight,
        zIndex: SIDE_MENU_Z,
        elevation: SIDE_MENU_Z,
        ...(Platform.OS === "web"
          ? ({ width: "100vw", pointerEvents: "auto" } as object)
          : {}),
      }}
    >
      <Pressable
        style={[appModalSheetStyles.backdropFill, { zIndex: 0 }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
      />
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: SIDE_MENU_WIDTH_PX,
          height: panelHeight,
          backgroundColor: colors.background,
          borderRightWidth: 1,
          borderRightColor: colors.highlight,
          zIndex: 1,
          transform: [{ translateX }],
          ...(Platform.OS === "web"
            ? ({
                transitionProperty: "transform",
                transitionDuration: "220ms",
                transitionTimingFunction: "ease-out",
              } as object)
            : {}),
        }}
        {...(Platform.OS === "web"
          ? ({
              onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            } as object)
          : {})}
      >
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          containOverscroll
        >
          <View style={{ paddingHorizontal: PAD_X, paddingTop: 18, paddingBottom: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <MessageChatAvatarSlot
                iconUrl={selfAvatarUrl}
                initials={avatarInitials}
                sizePx={AVATAR_PX}
                colors={colors}
                scheme={colorScheme}
                loadEnabled={visible && isTelegramMessagesConnected}
                fetchPriority="critical"
              />
              <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text
                    style={[
                      typographyFixedRow30Label,
                      {
                        color: colors.primary,
                        fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                        fontWeight: "600",
                        flex: 1,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {profileTitle}
                  </Text>
                  {isTelegramMessagesConnected ? (
                    <AccountLogoutCross
                      colors={colors}
                      label={t("messages.sideMenu.logoutAccount")}
                      onPress={handleDisconnect}
                    />
                  ) : null}
                </View>
                {usernameAt ? (
                  <Text
                    style={{
                      marginTop: 2,
                      color: colors.secondary,
                      fontSize: 13,
                      lineHeight: 18,
                    }}
                    numberOfLines={1}
                  >
                    {usernameAt}
                  </Text>
                ) : null}
                <Text
                  style={{
                    marginTop: 4,
                    color: colors.secondary,
                    fontSize: 13,
                    lineHeight: 18,
                  }}
                >
                  {t("messages.sideMenu.changeEmojiStatus")}
                </Text>
              </View>
            </View>
          </View>

          <View
            style={{
              height: 1,
              backgroundColor: colors.accent,
              alignSelf: "stretch",
              marginBottom: 8,
            }}
          />

          {showAccountSwitcher ? (
            <View style={{ paddingBottom: 8 }}>
              {connectedAccounts.map((account) => (
                <View
                  key={account.key}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    minHeight: ROW_MIN_H,
                    paddingHorizontal: PAD_X,
                    gap: 12,
                  }}
                >
                  <MessageChatAvatarSlot
                    iconUrl={account.avatarUrl}
                    initials={account.initials}
                    sizePx={ACCOUNT_AVATAR_PX}
                    colors={colors}
                    scheme={colorScheme}
                    loadEnabled={visible}
                    fetchPriority="high"
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={[typographyFixedRow30Label, { color: colors.primary }]}
                      numberOfLines={1}
                    >
                      {account.title}
                    </Text>
                    {account.usernameAt ? (
                      <Text
                        style={{ color: colors.secondary, fontSize: 12, lineHeight: 16 }}
                        numberOfLines={1}
                      >
                        {account.usernameAt}
                      </Text>
                    ) : null}
                  </View>
                  <AccountLogoutCross
                    colors={colors}
                    label={t("messages.sideMenu.logoutAccount")}
                    onPress={handleDisconnect}
                  />
                </View>
              ))}
              <SideMenuRow
                label={t("messages.sideMenu.addAccount")}
                Icon={SideMenuAddAccountIcon}
                colors={colors}
              />
            </View>
          ) : null}

          {showAccountSwitcher ? (
            <View
              style={{
                height: 1,
                backgroundColor: colors.accent,
                alignSelf: "stretch",
                marginBottom: 4,
              }}
            />
          ) : null}

          {navRows.map((row) => (
            <SideMenuRow
              key={row.key}
              label={t(row.labelKey)}
              Icon={row.Icon}
              colors={colors}
              active={row.active}
              onPress={row.onPress}
            />
          ))}
        </HspScrollColumn>
      </View>
    </View>
  );

  if (Platform.OS === "web" && typeof document !== "undefined") {
    return createPortal(drawer, document.body);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {drawer}
    </Modal>
  );
}
