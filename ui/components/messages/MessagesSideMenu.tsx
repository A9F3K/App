import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
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
import type { TelegramProfilePhotoMarkup } from "../../../shared/telegramProfilePhoto";
import {
  clearSelfTelegramProfileCache,
  getCachedSelfTelegramProfile,
  rememberSelfTelegramProfile,
} from "../../telegram/selfTelegramProfileCache";
import { useTelegram } from "../Telegram";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import {
  allocateFloatingSurfaceId,
  bringFloatingSurfaceToFront,
  FLOATING_SURFACE_BASE_Z,
  registerFloatingSurface,
  unregisterFloatingSurface,
} from "../floatingSurfaceStack";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { MessageChatDownIcon } from "./MessageChatDownIcon";
import { MessageChatProfilePhotoViewer } from "./MessageChatProfilePhotoViewer";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { formatTelegramUsernameAt } from "./formatTelegramChatRowUsername";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import { MESSAGE_LIST_INLINE_EMOJI_SIZE_PX } from "./messageListLayout";
import {
  SideMenuAddAccountIcon,
  SideMenuCallsIcon,
  SideMenuChannelIcon,
  SideMenuContactsIcon,
  SideMenuGroupIcon,
  SideMenuMessengerSettingsIcon,
  SideMenuProfileIcon,
  SideMenuSavedIcon,
  SideMenuWalletIcon,
} from "./MessagesSideMenuIcons";
import { HspScrollColumn } from "../HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../../scrollIndicatorPx";
import {
  MessagesMenuDialogs,
  type MessagesMenuDialogKind,
} from "./MessagesMenuDialogs";

const SIDE_MENU_WIDTH_PX = 300;
const SIDE_MENU_MIN_Z = FLOATING_SURFACE_BASE_Z + 10;
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
  const iconColor = active ? colors.primary : colors.secondary;
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

  if (onPress) {
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

function AccountLogoutText({
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
      onPress={(e) => {
        (e as { stopPropagation?: () => void }).stopPropagation?.();
        onPress?.();
      }}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : 1,
        paddingVertical: 2,
      })}
    >
      <Text
        style={{
          color: colors.secondary,
          fontSize: 13,
          lineHeight: 18,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function AccountsExpandChevron({
  colors,
  expanded,
  expandLabel,
  collapseLabel,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  expanded: boolean;
  expandLabel: string;
  collapseLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={expanded ? collapseLabel : expandLabel}
      accessibilityState={{ expanded }}
      hitSlop={8}
      onPress={(e) => {
        (e as { stopPropagation?: () => void }).stopPropagation?.();
        onPress();
      }}
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
        transform: [{ rotate: expanded ? "180deg" : "0deg" }],
      })}
    >
      <MessageChatDownIcon color={colors.secondary} />
    </Pressable>
  );
}

function SideMenuSectionDivider({ color }: { color: string }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: color,
        alignSelf: "stretch",
      }}
    />
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
    openConnectSheet,
  } = useTelegramMessagesConnection();
  const { openProfileSheet } = useProfileSheet();
  const { height: windowHeight } = useWindowDimensions();
  const musicSnap = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const musicTopInset = musicSnap.visible ? MUSIC_CONTROL_BAR_HEIGHT_PX : 0;
  const [mounted, setMounted] = useState(visible);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  /** Telegram first + last name (and username) from TDLib profile — not the app display_name. */
  const [telegramDisplayName, setTelegramDisplayName] = useState<string | null>(null);
  const [telegramProfileUsername, setTelegramProfileUsername] = useState<string | null>(null);
  const [emojiStatusCustomEmojiId, setEmojiStatusCustomEmojiId] = useState<string | null>(null);
  const [profilePhoto, setProfilePhoto] = useState<TelegramProfilePhotoMarkup | null>(null);
  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
  const [menuDialogKind, setMenuDialogKind] = useState<MessagesMenuDialogKind>(null);
  const surfaceIdRef = useRef(allocateFloatingSurfaceId("side-menu"));
  const [stackZ, setStackZ] = useState(() =>
    registerFloatingSurface(surfaceIdRef.current, SIDE_MENU_MIN_Z),
  );
  const raiseToFront = useCallback(() => {
    setStackZ(bringFloatingSurfaceToFront(surfaceIdRef.current, SIDE_MENU_MIN_Z));
  }, []);

  useEffect(() => {
    const id = surfaceIdRef.current;
    return () => unregisterFloatingSurface(id);
  }, []);

  useEffect(() => {
    if (!visible) {
      setDrawerOpen(false);
      setAccountsExpanded(false);
      const timer = setTimeout(() => setMounted(false), 220);
      return () => clearTimeout(timer);
    }
    setMounted(true);
    raiseToFront();
    const frame = requestAnimationFrame(() => setDrawerOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [raiseToFront, visible]);

  useEffect(() => {
    if (!isTelegramMessagesConnected || connectedTelegramUserId == null) {
      setTelegramDisplayName(null);
      setTelegramProfileUsername(null);
      setEmojiStatusCustomEmojiId(null);
      setProfilePhoto(null);
      if (!isTelegramMessagesConnected) {
        clearSelfTelegramProfileCache();
      }
      return;
    }

    const cached = getCachedSelfTelegramProfile(connectedTelegramUserId);
    if (cached) {
      setTelegramDisplayName(cached.title);
      setTelegramProfileUsername(cached.username);
      setEmojiStatusCustomEmojiId(cached.emojiStatusCustomEmojiId);
      setProfilePhoto(cached.profilePhoto);
    }

    const controller = new AbortController();
    void fetchTelegramUserProfile(0, connectedTelegramUserId, controller.signal, {
      priority: "critical",
    }).then((result) => {
      if (controller.signal.aborted || !result.ok) return;
      const title = result.profile.title?.trim() || null;
      const username = result.profile.username?.trim() || null;
      const statusId = result.profile.emoji_status_custom_emoji_id?.trim() || null;
      const nextPhoto = result.profile.profile_photo ?? null;
      if (title) setTelegramDisplayName(title);
      if (username) setTelegramProfileUsername(username);
      setEmojiStatusCustomEmojiId(statusId);
      setProfilePhoto(nextPhoto);
      if (title) {
        rememberSelfTelegramProfile(connectedTelegramUserId, {
          title,
          username,
          emojiStatusCustomEmojiId: statusId,
          profilePhoto: nextPhoto,
        });
      }
    });
    return () => controller.abort();
  }, [connectedTelegramUserId, isTelegramMessagesConnected]);

  const resolvedUsername = telegramProfileUsername ?? telegramUsername;
  const usernameAt = formatTelegramUsernameAt(resolvedUsername);
  /** Telegram first + last name only — username stays on the subtitle line. */
  const profileTitle = telegramDisplayName?.trim() || t("messages.sideMenu.myProfile");
  const avatarInitials = useMemo(() => extractChatAvatarInitials(profileTitle), [profileTitle]);
  const selfAvatarUrl = useMemo(() => {
    if (connectedTelegramUserId == null) return null;
    return buildApiUrl(
      `/api/telegram-messages-avatar?user_id=${encodeURIComponent(String(connectedTelegramUserId))}`,
    );
  }, [connectedTelegramUserId]);
  const selfAnimatedAvatarUrl = useMemo(() => {
    if (connectedTelegramUserId == null || !profilePhoto?.has_animation) return null;
    return `${selfAvatarUrl}&animated=1`;
  }, [connectedTelegramUserId, profilePhoto?.has_animation, selfAvatarUrl]);

  const handleDisconnect = useCallback(() => {
    // Logout only — never close the side menu from this control.
    void disconnectTelegramMessages();
  }, [disconnectTelegramMessages]);

  const toggleAccountsExpanded = useCallback(() => {
    setAccountsExpanded((prev) => !prev);
  }, []);

  const handleAddAccount = useCallback(() => {
    openConnectSheet();
  }, [openConnectSheet]);

  const openMyProfile = useCallback(() => {
    if (connectedTelegramUserId == null && !isTelegramMessagesConnected) return;
    onClose();
    // Close drawer first; profile sheet then raises itself on open.
    requestAnimationFrame(() => {
      openProfileSheet({
        telegram_chat_id: connectedTelegramUserId ?? 0,
        title: profileTitle,
        peer_user_id: connectedTelegramUserId,
        peer_username: resolvedUsername,
        chat_kind: "private",
        avatar_url: selfAvatarUrl,
        peer_emoji_status_custom_emoji_id: emojiStatusCustomEmojiId,
      });
    });
  }, [
    connectedTelegramUserId,
    emojiStatusCustomEmojiId,
    isTelegramMessagesConnected,
    onClose,
    openProfileSheet,
    profileTitle,
    resolvedUsername,
    selfAvatarUrl,
  ]);

  const openSelfProfilePhoto = useCallback(() => {
    if (!selfAvatarUrl && !profilePhoto) return;
    setPhotoViewerOpen(true);
  }, [profilePhoto, selfAvatarUrl]);

  const openMenuDialog = useCallback(
    (kind: Exclude<MessagesMenuDialogKind, null>) => {
      onClose();
      setMenuDialogKind(kind);
    },
    [onClose],
  );

  /** Connected Telegram sessions listed in the expandable switcher (one is fine). */
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
  const showAccountsSection = accountsExpanded;

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
        onPress: () => openMenuDialog("newGroup"),
      },
      {
        key: "newChannel",
        labelKey: "messages.sideMenu.newChannel",
        Icon: SideMenuChannelIcon,
        onPress: () => openMenuDialog("newChannel"),
      },
      {
        key: "contacts",
        labelKey: "messages.sideMenu.contacts",
        Icon: SideMenuContactsIcon,
        onPress: () => openMenuDialog("contacts"),
      },
      {
        key: "calls",
        labelKey: "messages.sideMenu.calls",
        Icon: SideMenuCallsIcon,
        onPress: () => openMenuDialog("calls"),
      },
      {
        key: "saved",
        labelKey: "messages.sideMenu.savedMessages",
        Icon: SideMenuSavedIcon,
      },
      {
        key: "settings",
        labelKey: "messages.sideMenu.messengerSettings",
        Icon: SideMenuMessengerSettingsIcon,
        onPress: () => openMenuDialog("settings"),
      },
    ],
    [openMenuDialog, openMyProfile],
  );

  const menuDialogs = (
    <MessagesMenuDialogs
      kind={menuDialogKind}
      onClose={() => setMenuDialogKind(null)}
      settingsProfile={{
        title: profileTitle,
        phone: null,
        usernameAt,
        avatarUrl: selfAvatarUrl,
        initials: avatarInitials.join(""),
      }}
    />
  );

  if (!mounted) {
    return (
      <>
        <MessageChatProfilePhotoViewer
          visible={photoViewerOpen}
          onClose={() => setPhotoViewerOpen(false)}
          title={profileTitle}
          iconUrl={selfAvatarUrl}
          animatedIconUrl={selfAnimatedAvatarUrl}
          profilePhoto={profilePhoto}
          addedAt={profilePhoto?.added_at ?? null}
        />
        {menuDialogs}
      </>
    );
  }

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
        zIndex: stackZ,
        elevation: stackZ,
        ...(Platform.OS === "web"
          ? ({ width: "100vw", pointerEvents: "none" } as object)
          : {}),
      }}
    >
      <View
        pointerEvents="auto"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: SIDE_MENU_WIDTH_PX,
          height: panelHeight,
          backgroundColor: colors.background,
          borderRightWidth: 1,
          borderRightColor: colors.highlight,
          // Visible so the scroll thumb can paint onto the 1px right border.
          overflow: "visible",
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
              onPointerDown: () => raiseToFront(),
            } as object)
          : {})}
      >
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
          scrollIndicatorOverlaySeam={false}
          containOverscroll
        >
          <View style={{ paddingHorizontal: PAD_X, paddingTop: 18, paddingBottom: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("messages.profile.photoOpenA11y")}
                onPress={openSelfProfilePhoto}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <MessageChatAvatarSlot
                  iconUrl={selfAvatarUrl}
                  initials={avatarInitials}
                  sizePx={AVATAR_PX}
                  colors={colors}
                  scheme={colorScheme}
                  loadEnabled={visible && connectedTelegramUserId != null}
                  fetchPriority="critical"
                  profilePhoto={profilePhoto}
                  animatedIconUrl={selfAnimatedAvatarUrl}
                  emojiFetchEnabled={visible}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("messages.sideMenu.myProfile")}
                onPress={openMyProfile}
                style={({ pressed }) => ({
                  flex: 1,
                  minWidth: 0,
                  paddingTop: 2,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <SpecialTelegramUserName
                  name={profileTitle}
                  telegramUserId={connectedTelegramUserId}
                  emojiStatusCustomEmojiId={emojiStatusCustomEmojiId}
                  emojiStatusPriority
                  emojiStatusStatic
                  inlineEmojiFetchEnabled={visible}
                  inlineEmojiFetchPriority
                  inlineEmojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
                  textAlign="left"
                  numberOfLines={1}
                  textStyle={{
                    ...typographyFixedRow30Label,
                    color: colors.primary,
                    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                    fontWeight: "600",
                  }}
                />
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
              </Pressable>
              <View
                style={{
                  alignItems: "center",
                  gap: 4,
                  paddingTop: 2,
                }}
              >
                <FloatingDialogCloseButton
                  label={t("common.close")}
                  onPress={onClose}
                />
                <AccountsExpandChevron
                  colors={colors}
                  expanded={accountsExpanded}
                  expandLabel={t("messages.sideMenu.expandAccounts")}
                  collapseLabel={t("messages.sideMenu.collapseAccounts")}
                  onPress={toggleAccountsExpanded}
                />
              </View>
            </View>
          </View>

          {showAccountsSection ? (
            <>
              <SideMenuSectionDivider color={colors.highlight} />
              <View style={{ paddingTop: 8, paddingBottom: 8 }}>
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
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("messages.profile.photoOpenA11y")}
                      onPress={openSelfProfilePhoto}
                      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
                    >
                      <MessageChatAvatarSlot
                        iconUrl={account.avatarUrl}
                        initials={account.initials}
                        sizePx={ACCOUNT_AVATAR_PX}
                        colors={colors}
                        scheme={colorScheme}
                        loadEnabled={visible}
                        fetchPriority="high"
                        profilePhoto={profilePhoto}
                        animatedIconUrl={selfAnimatedAvatarUrl}
                        emojiFetchEnabled={visible}
                      />
                    </Pressable>
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
                    {isTelegramMessagesConnected ? (
                      <AccountLogoutText
                        colors={colors}
                        label={t("messages.sideMenu.logOut")}
                        onPress={handleDisconnect}
                      />
                    ) : null}
                  </View>
                ))}
                <SideMenuRow
                  label={t("messages.sideMenu.addAccount")}
                  Icon={SideMenuAddAccountIcon}
                  colors={colors}
                  onPress={handleAddAccount}
                />
              </View>
              <SideMenuSectionDivider color={colors.highlight} />
            </>
          ) : (
            <SideMenuSectionDivider color={colors.highlight} />
          )}

          <View style={{ paddingTop: showAccountsSection ? 4 : 8 }}>
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
          </View>
        </HspScrollColumn>
      </View>
    </View>
  );

  const photoViewer = (
    <MessageChatProfilePhotoViewer
      visible={photoViewerOpen}
      onClose={() => setPhotoViewerOpen(false)}
      title={profileTitle}
      iconUrl={selfAvatarUrl}
      animatedIconUrl={selfAnimatedAvatarUrl}
      profilePhoto={profilePhoto}
      addedAt={profilePhoto?.added_at ?? null}
    />
  );

  if (Platform.OS === "web" && typeof document !== "undefined") {
    return (
      <>
        {createPortal(drawer, document.body)}
        {photoViewer}
        {menuDialogs}
      </>
    );
  }

  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        {drawer}
      </Modal>
      {photoViewer}
      {menuDialogs}
    </>
  );
}
