import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type TextStyle,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, useColors, type ThemeColors } from "../../theme";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import { FloatingDialogBody } from "../FloatingDialogBody";
import {
  FloatingDialogShell,
  floatingDialogDragHandleDomProps,
  floatingDialogDragHandleWebStyle,
  useFloatingDialogContentSizing,
} from "../FloatingDialogShell";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { HspScrollColumn } from "../HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../../scrollIndicatorPx";
import { useTelegram } from "../Telegram";
import { openAuthenticatedHomeChatHistory } from "../../authenticatedHomeSelectedChat";
import { buildApiUrl } from "../../../api/_base";
import {
  blockTelegramUser,
  fetchTelegramUserProfile,
  unblockTelegramUser,
  type TelegramChannelProfileRole,
  type TelegramUserProfile,
} from "../../telegram/fetchTelegramUserProfile";
import { HYPERLINKS_SPACE_LOGO_GREEN } from "../HyperlinksSpaceLogo";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { formatMessageChatPresenceLabel } from "./formatMessageChatPresence";
import { formatTelegramUsernameAt } from "./formatTelegramChatRowUsername";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  ProfileAdminsIcon,
  ProfileBlockIcon,
  ProfileDiscussIcon,
  ProfileGiftIcon,
  ProfileGiftsRowIcon,
  ProfileGifIcon,
  ProfileGroupsIcon,
  ProfileImagesIcon,
  ProfileLeaveIcon,
  ProfileLinksIcon,
  ProfileManageIcon,
  ProfileMarkedIcon,
  ProfileMessagesIcon,
  ProfileMoreIcon,
  ProfileMusicNoteIcon,
  ProfileMuteIcon,
  ProfilePhoneIcon,
  ProfilePhotosIcon,
  ProfileReportIcon,
  ProfileSubscribersIcon,
} from "./MessageChatProfileIcons";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
} from "./messageListLayout";
import { MessageChatProfileMediaSheet } from "./MessageChatProfileMediaSheet";
import { MessageChatProfilePhotoViewer } from "./MessageChatProfilePhotoViewer";
import type { ProfileMediaKind } from "../../telegram/fetchTelegramUserProfile";
import { useProfileSheet } from "../../profile/ProfileContext";
import { getMusicPlayer, subscribeMusicPlayer } from "../../music/musicPlayerStore";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import { openMessageLinkUrl } from "./openMessageLinkUrl";

const PAD_X_PX = 20;
const PAD_TOP_PX = 20;
const PAD_BOTTOM_PX = 24;
const HEADER_AVATAR_PX = 70;
const HEADER_AVATAR_GAP_PX = 14;
const ACTION_BTN_PX = 50;
const ACTION_GAP_PX = 15;
const SECTION_GAP_PX = 16;
const DIVIDER_MARGIN_Y_PX = 16;
const CHANNEL_AVATAR_PX = 36;
const CHANNEL_GAP_PX = 12;
const INFO_LABEL_GAP_PX = 2;
const INFO_BLOCK_GAP_PX = 14;
const MEDIA_ICON_PX = 18;
const MEDIA_ICON_GAP_PX = 12;
const MEDIA_ROW_GAP_PX = 14;
const BLOCK_COLOR = "#FF1111";
const UNBLOCK_COLOR = HYPERLINKS_SPACE_LOGO_GREEN;
/** Above side menu (zIndex 10060) and voice dialog portal (zIndex 9000). */
const PROFILE_OVERLAY_Z = 10100;

type Props = {
  visible: boolean;
  chat: MessageChatRowData | null;
  onClose: () => void;
  onMessages?: () => void;
  onCall?: () => void;
};

function textBase(color: string, extra?: TextStyle): TextStyle {
  return {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
    color,
    ...extra,
  };
}

function ProfileDivider({ colors }: { colors: ThemeColors }) {
  return (
    <View
      style={{
        height:
          Platform.OS === "web"
            ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
            : 1,
        minHeight: 1,
        backgroundColor: colors.highlight,
        marginVertical: DIVIDER_MARGIN_Y_PX,
        alignSelf: "stretch",
      }}
    />
  );
}

function ProfileActionButton({
  label,
  onPress,
  children,
  colors,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  colors: ThemeColors;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: ACTION_BTN_PX,
        height: ACTION_BTN_PX,
        borderRadius: ACTION_BTN_PX / 2,
        borderWidth: 1,
        borderColor: colors.highlight,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

/** Rectangular action chip used for channel profile (Mute / Discuss / Manage / …). */
function ChannelActionButton({
  label,
  onPress,
  children,
  colors,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  colors: ThemeColors;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        borderRadius: 12,
        backgroundColor: colors.undercover,
        paddingVertical: 10,
        paddingHorizontal: 4,
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {children}
      <Text
        numberOfLines={1}
        style={textBase(colors.primary, { fontSize: 11, lineHeight: 14, textAlign: "center" })}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function formatChannelJoinedWhen(joinedUnix: number | null, locale: string): string | null {
  if (joinedUnix == null || !Number.isFinite(joinedUnix) || joinedUnix <= 0) return null;
  const d = new Date(joinedUnix * 1000);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const datePart = d.toLocaleString(locale, { month: "long", day: "numeric" });
    const timePart = d.toLocaleString(locale, { hour: "numeric", minute: "2-digit" });
    return `${datePart} at ${timePart}`;
  } catch {
    return d.toLocaleString();
  }
}

function channelPublicLinkLabel(username: string | null, inviteLink: string | null): string | null {
  const cleanUser = username?.trim().replace(/^@+/, "") || null;
  if (cleanUser) return `t.me/${cleanUser}`;
  if (inviteLink?.trim()) {
    try {
      const u = new URL(inviteLink.trim());
      return `${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return inviteLink.trim().replace(/^https?:\/\//i, "");
    }
  }
  return null;
}

function roleShowsManage(role: TelegramChannelProfileRole | null | undefined): boolean {
  return role === "creator" || role === "admin";
}

function roleShowsStaffRows(role: TelegramChannelProfileRole | null | undefined): boolean {
  return role === "creator" || role === "admin" || role === "moderator";
}

function InfoField({
  label,
  value,
  colors,
  onPress,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
  onPress?: () => void;
}) {
  const body = (
    <View style={{ marginBottom: INFO_BLOCK_GAP_PX }}>
      <Text style={textBase(colors.secondary, { fontSize: 13, lineHeight: 16 })}>{label}</Text>
      <Text
        style={textBase(colors.primary, {
          marginTop: INFO_LABEL_GAP_PX,
          ...(onPress ? { color: "#3390ec" } : null),
        })}
        selectable
      >
        {value}
      </Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={value}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}

function MediaRow({
  icon,
  label,
  colors,
  onPress,
  labelColor,
}: {
  icon: ReactNode;
  label: string;
  colors: ThemeColors;
  onPress?: () => void;
  labelColor?: string;
}) {
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginBottom: MEDIA_ROW_GAP_PX,
      }}
    >
      <View
        style={{
          width: MEDIA_ICON_PX,
          height: MEDIA_ICON_PX,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </View>
      <Text style={textBase(labelColor ?? colors.primary, { marginLeft: MEDIA_ICON_GAP_PX })}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <ProfileOpenHitTarget
      label={label}
      onPress={onPress}
      style={{
        width: "100%",
        alignItems: "stretch",
        justifyContent: "flex-start",
        cursor: "pointer",
      }}
    >
      {body}
    </ProfileOpenHitTarget>
  );
}

export function MessageChatProfileSheet({
  visible,
  chat,
  onClose,
  onMessages,
  onCall,
}: Props) {
  const colors = useColors();
  const { t, tf, locale } = useAppStrings();
  const { colorScheme } = useTelegram();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "profile"),
    [windowHeight, windowWidth],
  );
  const { openMusicPlaylistSheet } = useProfileSheet();
  const [profile, setProfile] = useState<TelegramUserProfile | null>(null);
  const [blockPending, setBlockPending] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [mediaKindOpen, setMediaKindOpen] = useState<ProfileMediaKind | null>(null);
  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
  const musicPlayer = useSyncExternalStore(
    subscribeMusicPlayer,
    getMusicPlayer,
    getMusicPlayer,
  );

  useEffect(() => {
    if (!visible || !chat) {
      setProfile(null);
      setIsBlocked(false);
      setMediaKindOpen(null);
      setPhotoViewerOpen(false);
      return;
    }
    const controller = new AbortController();
    void fetchTelegramUserProfile(
      chat.telegram_chat_id,
      chat.peer_user_id ?? null,
      controller.signal,
      { priority: "critical" },
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setProfile(result.profile);
        setIsBlocked(Boolean(result.profile.is_blocked));
      }
    });
    return () => controller.abort();
  }, [visible, chat]);

  const title = (profile?.title || chat?.title || "").trim();
  const usernameHandles = useMemo(() => {
    const fromProfile = Array.isArray(profile?.usernames)
      ? profile.usernames
          .filter((u): u is string => typeof u === "string" && Boolean(u.trim()))
          .map((u) => u.trim().replace(/^@+/, ""))
      : [];
    if (fromProfile.length > 0) return fromProfile;
    const fallback = (
      profile?.username ??
      chat?.peer_username ??
      chat?.chat_username ??
      ""
    )
      .trim()
      .replace(/^@+/, "");
    return fallback ? [fallback] : [];
  }, [chat?.chat_username, chat?.peer_username, profile?.username, profile?.usernames]);
  const usernameAt = formatTelegramUsernameAt(usernameHandles[0] ?? null);
  const alsoUsernamesLabel =
    usernameHandles.length > 1
      ? tf("messages.profile.alsoUsernames", {
          list: usernameHandles
            .slice(1)
            .map((u) => `@${u}`)
            .join(", "),
        })
      : null;
  const membership = profile?.membership ?? null;
  const isChannelProfile =
    chat?.chat_kind === "channel" || Boolean(membership?.is_channel);
  const channelRole = membership?.role ?? null;
  const channelLinkLabel = channelPublicLinkLabel(
    profile?.username ?? chat?.chat_username ?? chat?.peer_username ?? null,
    membership?.invite_link ?? null,
  );
  const channelJoinedWhen = formatChannelJoinedWhen(membership?.joined_date ?? null, locale);
  const channelSubscriberLabel = (() => {
    const count =
      membership?.member_count ??
      (chat?.member_count != null && Number.isFinite(chat.member_count)
        ? Math.trunc(chat.member_count)
        : null);
    if (count == null) return null;
    return tf("messages.profile.channel.subscribers", { count: String(count) });
  })();
  const statusText = isChannelProfile
    ? channelSubscriberLabel ||
      profile?.status_text?.trim() ||
      ""
    : profile?.status_text?.trim() ||
      (chat ? formatMessageChatPresenceLabel(chat, locale) : "") ||
      "";
  const bio = profile?.bio?.trim() || null;
  const phone = profile?.phone_number?.trim() || null;
  const music = profile?.music ?? null;
  const playlist = profile?.playlist ?? [];
  const channel = profile?.channel ?? null;
  const media = profile?.media ?? null;
  const iconUrl = chat ? resolveTelegramThreadAvatarUrl(chat) : null;
  const avatarInitials = useMemo(() => extractChatAvatarInitials(title), [title]);
  const profilePhoto = profile?.profile_photo ?? null;
  const animatedIconUrl = useMemo(() => {
    if (!profilePhoto?.has_animation) return null;
    const userId = profile?.user_id ?? chat?.peer_user_id ?? null;
    if (userId == null || !Number.isFinite(userId) || userId === 0) return null;
    return buildApiUrl(
      `/api/telegram-messages-avatar?user_id=${encodeURIComponent(String(userId))}&animated=1`,
    );
  }, [chat?.peer_user_id, profile?.user_id, profilePhoto?.has_animation]);
  const channelAvatarUrl = channel
    ? `/api/telegram-messages-avatar?chat_id=${encodeURIComponent(String(channel.chat_id))}`
    : null;
  const channelInitials = useMemo(
    () => extractChatAvatarInitials(channel?.title ?? ""),
    [channel?.title],
  );

  const mediaRows = useMemo(() => {
    if (!media && !(profile?.gift_count || profile?.group_in_common_count)) return [];
    const rows: Array<{
      key: string;
      icon: ReactNode;
      label: string;
      onPress?: () => void;
    }> = [];
    const giftCount = profile?.gift_count ?? 0;
    if (giftCount > 0) {
      rows.push({
        key: "gifts",
        icon: <ProfileGiftsRowIcon color={colors.primary} size={MEDIA_ICON_PX} />,
        label:
          giftCount === 1
            ? tf("messages.profile.media.gifts", { count: String(giftCount) })
            : tf("messages.profile.media.gifts_plural", { count: String(giftCount) }),
      });
    }
    if (media) {
      if (media.marked > 0) {
        rows.push({
          key: "marked",
          icon: <ProfileMarkedIcon color={colors.primary} size={MEDIA_ICON_PX} />,
          label: tf("messages.profile.media.marked", { count: String(media.marked) }),
          onPress: () => setMediaKindOpen("marked"),
        });
      }
      if (media.images > 0) {
        rows.push({
          key: "images",
          icon: <ProfileImagesIcon color={colors.primary} size={MEDIA_ICON_PX} />,
          label: tf("messages.profile.media.images", { count: String(media.images) }),
          onPress: () => setMediaKindOpen("images"),
        });
      }
      if (media.photos > 0) {
        rows.push({
          key: "photos",
          icon: <ProfilePhotosIcon color={colors.primary} size={MEDIA_ICON_PX} />,
          label: tf("messages.profile.media.photos", { count: String(media.photos) }),
          onPress: () => setMediaKindOpen("photos"),
        });
      }
      if (media.links > 0) {
        rows.push({
          key: "links",
          icon: <ProfileLinksIcon color={colors.primary} size={MEDIA_ICON_PX} />,
          label: tf("messages.profile.media.links", { count: String(media.links) }),
          onPress: () => setMediaKindOpen("links"),
        });
      }
      if (media.gifs > 0) {
        rows.push({
          key: "gifs",
          icon: <ProfileGifIcon color={colors.primary} size={MEDIA_ICON_PX} />,
          label: tf("messages.profile.media.gifs", { count: String(media.gifs) }),
          onPress: () => setMediaKindOpen("gifs"),
        });
      }
    }
    const groupsCount = profile?.group_in_common_count ?? 0;
    if (groupsCount > 0) {
      rows.push({
        key: "groups",
        icon: <ProfileGroupsIcon color={colors.primary} size={MEDIA_ICON_PX} />,
        label:
          groupsCount === 1
            ? tf("messages.profile.media.groupsInCommon", { count: String(groupsCount) })
            : tf("messages.profile.media.groupsInCommon_plural", {
                count: String(groupsCount),
              }),
      });
    }
    return rows;
  }, [colors.primary, media, profile?.gift_count, profile?.group_in_common_count, tf]);

  const handleMessages = () => {
    if (chat) openAuthenticatedHomeChatHistory(chat);
    onMessages?.();
    onClose();
  };

  const handleCall = () => {
    onCall?.();
  };

  const handleChannelPress = () => {
    if (!channel) return;
    openAuthenticatedHomeChatHistory({
      id: 0,
      telegram_chat_id: channel.chat_id,
      title: channel.title,
      subtitle: channel.subtitle ?? "",
      avatar_url: null,
      last_message_at: null,
      unread_count: 0,
      chat_kind: "channel",
      peer_user_id: null,
    });
    onClose();
  };

  const handleDiscuss = () => {
    const linkedId = membership?.linked_chat_id;
    if (linkedId == null || !Number.isFinite(linkedId) || linkedId === 0) return;
    openAuthenticatedHomeChatHistory({
      id: 0,
      telegram_chat_id: Math.trunc(linkedId),
      title: t("messages.profile.actions.discuss"),
      subtitle: "",
      avatar_url: null,
      last_message_at: null,
      unread_count: 0,
      chat_kind: "supergroup",
      peer_user_id: null,
    });
    onClose();
  };

  const handleViewChannel = () => {
    if (chat) openAuthenticatedHomeChatHistory(chat);
    onClose();
  };

  const handleChannelLinkPress = () => {
    // Prefer the chat already open in this sheet — never bounce to Telegram.
    if (chat) {
      openAuthenticatedHomeChatHistory(chat);
      onClose();
      return;
    }
    if (!channelLinkLabel) return;
    const href = channelLinkLabel.startsWith("http")
      ? channelLinkLabel
      : `https://${channelLinkLabel}`;
    void openMessageLinkUrl(href);
  };

  const handleUsernamePress = () => {
    if (chat) {
      openAuthenticatedHomeChatHistory(chat);
      onClose();
      return;
    }
    const raw =
      profile?.username ?? chat?.peer_username ?? chat?.chat_username ?? null;
    const clean = typeof raw === "string" ? raw.trim().replace(/^@+/, "") : "";
    if (!clean) return;
    void openMessageLinkUrl(`@${clean}`);
  };

  const handleBlockToggle = () => {
    const userId = profile?.user_id ?? chat?.peer_user_id ?? null;
    if (userId == null || blockPending) return;
    const nextBlocked = !isBlocked;
    setBlockPending(true);
    setIsBlocked(nextBlocked);
    const action = nextBlocked
      ? blockTelegramUser(userId)
      : unblockTelegramUser(userId);
    void action.then((result) => {
      if (!result.ok) {
        setIsBlocked(!nextBlocked);
      } else {
        setProfile((prev) => (prev ? { ...prev, is_blocked: nextBlocked } : prev));
      }
    }).finally(() => {
      setBlockPending(false);
    });
  };

  const handleOpenPlaylist = () => {
    if (playlist.length === 0) return;
    openMusicPlaylistSheet(playlist);
  };

  if (!chat || !visible) return null;

  const displayedMusic = (() => {
    const uid = profile?.user_id;
    if (uid != null && musicPlayer.visible) {
      const current = musicPlayer.tracks[musicPlayer.index];
      if (current && current.user_id === uid) {
        return { artist: current.artist, title: current.title };
      }
    }
    if (playlist[0]) {
      return { artist: playlist[0].artist, title: playlist[0].title };
    }
    return music;
  })();
  const blockAccent = isBlocked ? UNBLOCK_COLOR : BLOCK_COLOR;
  const blockLabel = isBlocked
    ? t("messages.profile.unblock")
    : t("messages.profile.block");

  const sheetBody = (
    <View
      style={{ flex: 1, minHeight: 0 }}
      {...(Platform.OS === "web"
        ? ({
            onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            "data-profile-sheet": "1",
          } as object)
        : {})}
      onStartShouldSetResponder={() => true}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          ...floatingDialogDragHandleWebStyle,
        }}
        {...floatingDialogDragHandleDomProps}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.profile.photoOpenA11y")}
          onPress={() => {
            if (iconUrl || profilePhoto) setPhotoViewerOpen(true);
          }}
          style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
        >
          <MessageChatAvatarSlot
            iconUrl={iconUrl}
            initials={avatarInitials}
            sizePx={HEADER_AVATAR_PX}
            colors={colors}
            scheme={colorScheme}
            loadEnabled
            fetchPriority="critical"
            profilePhoto={profilePhoto}
            animatedIconUrl={animatedIconUrl}
            emojiFetchEnabled={visible}
          />
        </Pressable>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: HEADER_AVATAR_GAP_PX,
            paddingTop: 4,
            paddingRight: 36,
          }}
          {...(Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {})}
        >
          <SpecialTelegramUserName
            name={title}
            telegramUserId={chat.peer_user_id ?? null}
            telegramChatId={chat.telegram_chat_id}
            emojiStatusCustomEmojiId={
              profile?.emoji_status_custom_emoji_id ??
              chat.peer_emoji_status_custom_emoji_id ??
              null
            }
            emojiStatusPriority
            emojiStatusStatic
            inlineEmojiFetchEnabled
            inlineEmojiFetchPriority
            inlineEmojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
            textAlign="left"
            numberOfLines={1}
            textStyle={textBase(colors.primary)}
          />
          {statusText ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={textBase(colors.secondary, { marginTop: 2 })}
            >
              {statusText}
            </Text>
          ) : null}
        </View>
        <FloatingDialogCloseButton
          label={t("common.close")}
          onPress={onClose}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
          }}
        />
      </View>

      {isChannelProfile ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "stretch",
            gap: 8,
            marginTop: SECTION_GAP_PX + 4,
          }}
        >
          <ChannelActionButton
            label={t("messages.profile.actions.mute")}
            onPress={() => undefined}
            colors={colors}
          >
            <ProfileMuteIcon color={colors.primary} size={22} />
          </ChannelActionButton>
          <ChannelActionButton
            label={t("messages.profile.actions.discuss")}
            onPress={handleDiscuss}
            colors={colors}
            disabled={
              membership?.linked_chat_id == null ||
              !Number.isFinite(membership.linked_chat_id) ||
              membership.linked_chat_id === 0
            }
          >
            <ProfileDiscussIcon color={colors.primary} size={22} />
          </ChannelActionButton>
          {roleShowsManage(channelRole) ? (
            <ChannelActionButton
              label={t("messages.profile.actions.manage")}
              onPress={() => undefined}
              colors={colors}
            >
              <ProfileManageIcon color={colors.primary} size={22} />
            </ChannelActionButton>
          ) : channelRole === "member" || channelRole === "left" || channelRole == null ? (
            <ChannelActionButton
              label={t("messages.profile.actions.gift")}
              onPress={() => undefined}
              colors={colors}
            >
              <ProfileGiftIcon color={colors.primary} size={22} />
            </ChannelActionButton>
          ) : null}
          <ChannelActionButton
            label={t("messages.profile.actions.more")}
            onPress={() => undefined}
            colors={colors}
          >
            <ProfileMoreIcon color={colors.primary} size={22} />
          </ChannelActionButton>
        </View>
      ) : (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: ACTION_GAP_PX,
            marginTop: SECTION_GAP_PX + 4,
          }}
        >
          <ProfileActionButton
            label={t("messages.profile.actions.messages")}
            onPress={handleMessages}
            colors={colors}
          >
            <ProfileMessagesIcon color={colors.primary} size={ACTION_BTN_PX} />
          </ProfileActionButton>
          <ProfileActionButton
            label={t("messages.profile.actions.call")}
            onPress={handleCall}
            colors={colors}
          >
            <ProfilePhoneIcon color={colors.primary} size={ACTION_BTN_PX} />
          </ProfileActionButton>
          <ProfileActionButton
            label={t("messages.profile.actions.gift")}
            onPress={() => undefined}
            colors={colors}
          >
            <ProfileGiftIcon color={colors.primary} size={ACTION_BTN_PX} />
          </ProfileActionButton>
        </View>
      )}

      {!isChannelProfile && displayedMusic ? (
        <>
          <ProfileDivider colors={colors} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("messages.profile.playlistTitle")}
            onPress={playlist.length > 0 ? handleOpenPlaylist : undefined}
            disabled={playlist.length === 0}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 8,
              opacity: pressed && playlist.length > 0 ? 0.7 : 1,
            })}
          >
            <ProfileMusicNoteIcon color={colors.primary} size={14} />
            <Text
              numberOfLines={1}
              style={textBase(colors.primary, { marginLeft: 8, flexShrink: 1 })}
            >
              {displayedMusic.artist}
              {displayedMusic.title ? (
                <Text style={{ color: colors.secondary }}>{` – ${displayedMusic.title}`}</Text>
              ) : null}
            </Text>
          </Pressable>
          <ProfileDivider colors={colors} />
        </>
      ) : null}

      {!isChannelProfile && channel ? (
        <>
          {displayedMusic ? null : <ProfileDivider colors={colors} />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={channel.title}
            onPress={handleChannelPress}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <MessageChatAvatarSlot
              iconUrl={channelAvatarUrl}
              initials={channelInitials}
              sizePx={CHANNEL_AVATAR_PX}
              colors={colors}
              scheme={colorScheme}
              loadEnabled
            />
            <View style={{ flex: 1, minWidth: 0, marginLeft: CHANNEL_GAP_PX }}>
              <Text numberOfLines={1} style={textBase(colors.primary)}>
                {channel.title}
              </Text>
              {channel.subtitle ? (
                <Text numberOfLines={1} style={textBase(colors.secondary, { marginTop: 1 })}>
                  {channel.subtitle}
                </Text>
              ) : null}
            </View>
          </Pressable>
        </>
      ) : null}

      {isChannelProfile ? (
        <>
          <ProfileDivider colors={colors} />
          <View>
            {channelLinkLabel ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={channelLinkLabel}
                onPress={handleChannelLinkPress}
                style={({ pressed }) => ({
                  marginBottom: INFO_BLOCK_GAP_PX,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={textBase(colors.primary)} selectable>
                  {channelLinkLabel}
                </Text>
                <Text style={textBase(colors.secondary, { fontSize: 13, lineHeight: 16, marginTop: INFO_LABEL_GAP_PX })}>
                  {t("messages.profile.channel.link")}
                </Text>
              </Pressable>
            ) : null}
            {channelRole === "member" && channelJoinedWhen ? (
              <Text
                style={textBase(colors.secondary, {
                  fontStyle: "italic",
                  marginBottom: INFO_BLOCK_GAP_PX,
                })}
              >
                {tf("messages.profile.channel.joined", { when: channelJoinedWhen })}
              </Text>
            ) : null}
            {bio ? (
              <InfoField
                label={t("messages.profile.channel.description")}
                value={bio}
                colors={colors}
              />
            ) : (
              <Text style={textBase(colors.secondary, { fontSize: 13, lineHeight: 16, marginBottom: INFO_BLOCK_GAP_PX })}>
                {t("messages.profile.channel.description")}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("messages.profile.channel.viewChannel")}
              onPress={handleViewChannel}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                opacity: pressed ? 0.7 : 1,
                marginTop: 4,
              })}
            >
              <Text
                style={textBase(colors.secondary, {
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                })}
              >
                {t("messages.profile.channel.viewChannel")}
              </Text>
            </Pressable>
          </View>
        </>
      ) : usernameAt || bio || phone ? (
        <>
          <ProfileDivider colors={colors} />
          <View>
            {usernameAt ? (
              <View style={{ marginBottom: INFO_BLOCK_GAP_PX }}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={usernameAt}
                  onPress={handleUsernamePress}
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                  <Text style={textBase(colors.secondary, { fontSize: 13, lineHeight: 16 })}>
                    {t("messages.profile.username")}
                  </Text>
                  <Text
                    style={textBase("#3390ec", { marginTop: INFO_LABEL_GAP_PX })}
                    selectable
                  >
                    {usernameAt}
                  </Text>
                </Pressable>
                {alsoUsernamesLabel ? (
                  <Text
                    style={textBase(colors.secondary, {
                      fontSize: 13,
                      lineHeight: 16,
                      marginTop: INFO_LABEL_GAP_PX,
                    })}
                  >
                    {alsoUsernamesLabel}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {bio ? <InfoField label={t("messages.profile.bio")} value={bio} colors={colors} /> : null}
            {phone ? (
              <InfoField label={t("messages.profile.mobile")} value={phone} colors={colors} />
            ) : null}
          </View>
        </>
      ) : null}

      {isChannelProfile ? (
        <>
          <ProfileDivider colors={colors} />
          <View style={{ marginBottom: -MEDIA_ROW_GAP_PX }}>
            {(media?.links ?? 0) > 0 ? (
              <MediaRow
                icon={<ProfileLinksIcon color={colors.primary} size={MEDIA_ICON_PX} />}
                label={
                  (media?.links ?? 0) === 1
                    ? tf("messages.profile.channel.sharedLinks", {
                        count: String(media?.links ?? 0),
                      })
                    : tf("messages.profile.channel.sharedLinks_plural", {
                        count: String(media?.links ?? 0),
                      })
                }
                colors={colors}
                onPress={() => setMediaKindOpen("links")}
              />
            ) : null}
            {roleShowsStaffRows(channelRole) && channelSubscriberLabel ? (
              <MediaRow
                icon={<ProfileSubscribersIcon color={colors.primary} size={MEDIA_ICON_PX} />}
                label={channelSubscriberLabel}
                colors={colors}
                onPress={() => undefined}
              />
            ) : null}
            {roleShowsStaffRows(channelRole) &&
            membership?.administrator_count != null &&
            membership.administrator_count > 0 ? (
              <MediaRow
                icon={<ProfileAdminsIcon color={colors.primary} size={MEDIA_ICON_PX} />}
                label={tf("messages.profile.channel.administrators", {
                  count: String(membership.administrator_count),
                })}
                colors={colors}
                onPress={() => undefined}
              />
            ) : null}
            {channelRole !== "left" ? (
              <MediaRow
                icon={<ProfileLeaveIcon color={colors.primary} size={MEDIA_ICON_PX} />}
                label={t("messages.profile.channel.leave")}
                colors={colors}
                onPress={() => undefined}
              />
            ) : null}
            {(channelRole === "member" || channelRole === "left" || channelRole == null) &&
            !roleShowsStaffRows(channelRole) ? (
              <MediaRow
                icon={<ProfileReportIcon color={BLOCK_COLOR} size={MEDIA_ICON_PX} />}
                label={t("messages.profile.channel.report")}
                colors={colors}
                labelColor={BLOCK_COLOR}
                onPress={() => undefined}
              />
            ) : null}
          </View>
        </>
      ) : mediaRows.length > 0 ? (
        <>
          <ProfileDivider colors={colors} />
          <View style={{ marginBottom: -MEDIA_ROW_GAP_PX }}>
            {mediaRows.map((row) => (
              <MediaRow
                key={row.key}
                icon={row.icon}
                label={row.label}
                colors={colors}
                onPress={row.onPress}
              />
            ))}
          </View>
        </>
      ) : null}

      {!isChannelProfile &&
      (chat.peer_user_id != null || profile?.user_id != null) &&
      !chat.peer_is_bot ? (
        <>
          <ProfileDivider colors={colors} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={blockLabel}
            onPress={handleBlockToggle}
            disabled={blockPending}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              opacity: blockPending ? 0.5 : pressed ? 0.7 : 1,
              gap: 8,
            })}
          >
            <View
              style={{
                transform: [{ rotate: isBlocked ? "90deg" : "0deg" }],
                ...(Platform.OS === "web"
                  ? ({
                      transition: "transform 220ms ease, color 220ms ease",
                    } as object)
                  : {}),
              }}
            >
              <ProfileBlockIcon color={blockAccent} size={20} />
            </View>
            <Text style={[typographyRect15, { color: blockAccent }]}>{blockLabel}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );

  return (
    <>
      <FloatingDialogShell
        visible={Boolean(chat && visible)}
        zIndex={PROFILE_OVERLAY_Z}
        defaultSize={defaultSize}
        minSize={{ width: 300, height: 240 }}
        offsetStorageKey="hsp.profileSheet.offset.v6"
        fitContentHeight
        contentFitKey={
          profile
            ? `p:${profile.gift_count}:${profile.group_in_common_count}:${mediaRows.length}:${usernameHandles.length}:${bio ? 1 : 0}:${phone ? 1 : 0}`
            : "loading"
        }
        onRequestClose={onClose}
        testId="profile-sheet"
        moveIgnoreSelector="[data-floating-no-drag],button,[role='button'],a,input,textarea"
      >
        <ProfileSheetScrollBody>{sheetBody}</ProfileSheetScrollBody>
      </FloatingDialogShell>
      <MessageChatProfileMediaSheet
        visible={mediaKindOpen != null}
        kind={mediaKindOpen}
        chat={chat}
        resolvedChatId={profile?.chat_id ?? null}
        onClose={() => setMediaKindOpen(null)}
        onDismissAll={onClose}
        onNavigateToMessage={onClose}
      />
      <MessageChatProfilePhotoViewer
        visible={photoViewerOpen}
        onClose={() => setPhotoViewerOpen(false)}
        title={title}
        iconUrl={iconUrl}
        animatedIconUrl={animatedIconUrl}
        profilePhoto={profilePhoto}
        addedAt={profilePhoto?.added_at ?? null}
      />
    </>
  );
}

function ProfileSheetScrollBody({ children }: { children: ReactNode }) {
  const contentSizing = useFloatingDialogContentSizing();
  const paddingStyle = {
    paddingHorizontal: PAD_X_PX,
    paddingTop: PAD_TOP_PX,
    paddingBottom: PAD_BOTTOM_PX,
  };

  // Intrinsic fit must not use a flex scroll column (height collapses to 0).
  if (contentSizing) {
    return <View style={paddingStyle}>{children}</View>;
  }

  return (
    <FloatingDialogBody>
      <HspScrollColumn
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={paddingStyle}
        scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
      >
        {children}
      </HspScrollColumn>
    </FloatingDialogBody>
  );
}
