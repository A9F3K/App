import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type TextStyle,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, useColors, type ThemeColors } from "../../theme";
import { FloatingDialogShell } from "../FloatingDialogShell";
import { HspScrollColumn } from "../HspScrollColumn";
import { useTelegram } from "../Telegram";
import { openAuthenticatedHomeChatHistory } from "../../authenticatedHomeSelectedChat";
import {
  blockTelegramUser,
  fetchTelegramUserProfile,
  unblockTelegramUser,
  type TelegramUserProfile,
} from "../../telegram/fetchTelegramUserProfile";
import { HYPERLINKS_SPACE_LOGO_GREEN } from "../HyperlinksSpaceLogo";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { formatMessageChatPresenceLabel } from "./formatMessageChatPresence";
import { formatTelegramUsernameAt } from "./formatTelegramChatRowUsername";
import type { MessageChatRowData } from "./MessageChatRow";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";
import {
  ProfileBlockIcon,
  ProfileGiftIcon,
  ProfileGifIcon,
  ProfileImagesIcon,
  ProfileLinksIcon,
  ProfileMarkedIcon,
  ProfileMessagesIcon,
  ProfileMusicNoteIcon,
  ProfilePhoneIcon,
  ProfilePhotosIcon,
} from "./MessageChatProfileIcons";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
} from "./messageListLayout";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import { MessageChatProfileMediaSheet } from "./MessageChatProfileMediaSheet";
import type { ProfileMediaKind } from "../../telegram/fetchTelegramUserProfile";
import { useProfileSheet } from "../../profile/ProfileContext";
import { getMusicPlayer, subscribeMusicPlayer } from "../../music/musicPlayerStore";

/** Layout matches the profile design sheet (≈380×740 content frame). */
const SHEET_MAX_WIDTH_PX = 380;
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

function InfoField({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemeColors;
}) {
  return (
    <View style={{ marginBottom: INFO_BLOCK_GAP_PX }}>
      <Text style={textBase(colors.secondary, { fontSize: 13, lineHeight: 16 })}>{label}</Text>
      <Text
        style={textBase(colors.primary, {
          marginTop: INFO_LABEL_GAP_PX,
        })}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function MediaRow({
  icon,
  label,
  colors,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  colors: ThemeColors;
  onPress?: () => void;
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
      <Text style={textBase(colors.primary, { marginLeft: MEDIA_ICON_GAP_PX })}>{label}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
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
  const { openMusicPlaylistSheet } = useProfileSheet();
  const [profile, setProfile] = useState<TelegramUserProfile | null>(null);
  const [blockPending, setBlockPending] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [mediaKindOpen, setMediaKindOpen] = useState<ProfileMediaKind | null>(null);
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
  const usernameAt = formatTelegramUsernameAt(
    profile?.username ?? chat?.peer_username ?? chat?.chat_username,
  );
  const statusText =
    profile?.status_text?.trim() ||
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
  const channelAvatarUrl = channel
    ? `/api/telegram-messages-avatar?chat_id=${encodeURIComponent(String(channel.chat_id))}`
    : null;
  const channelInitials = useMemo(
    () => extractChatAvatarInitials(channel?.title ?? ""),
    [channel?.title],
  );

  const mediaRows = useMemo(() => {
    if (!media) return [];
    const rows: Array<{
      key: string;
      icon: ReactNode;
      label: string;
      onPress?: () => void;
    }> = [];
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
    return rows;
  }, [colors.primary, media, tf]);

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
      style={{
        flex: 1,
        minHeight: 0,
        paddingHorizontal: PAD_X_PX,
        paddingTop: PAD_TOP_PX,
        paddingBottom: PAD_BOTTOM_PX,
      }}
      {...(Platform.OS === "web"
        ? ({
            onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            "data-profile-sheet": "1",
          } as object)
        : {})}
      onStartShouldSetResponder={() => true}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <MessageChatAvatarSlot
          iconUrl={iconUrl}
          initials={avatarInitials}
          sizePx={HEADER_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          loadEnabled
          fetchPriority="critical"
        />
        <View
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: HEADER_AVATAR_GAP_PX,
            paddingTop: 4,
            paddingRight: 36,
          }}
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
        <ProfileOpenHitTarget
          label={t("common.back")}
          onPress={onClose}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 32,
            height: 32,
          }}
        >
          <VoiceWindowCrossIcon color={colors.primary} size={15} />
        </ProfileOpenHitTarget>
      </View>

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

      {displayedMusic ? (
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

      {channel ? (
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

      {usernameAt || bio || phone ? (
        <>
          <ProfileDivider colors={colors} />
          <View>
            {usernameAt ? (
              <InfoField
                label={t("messages.profile.username")}
                value={usernameAt}
                colors={colors}
              />
            ) : null}
            {bio ? <InfoField label={t("messages.profile.bio")} value={bio} colors={colors} /> : null}
            {phone ? (
              <InfoField label={t("messages.profile.mobile")} value={phone} colors={colors} />
            ) : null}
          </View>
        </>
      ) : null}

      {mediaRows.length > 0 ? (
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

      {(chat.peer_user_id != null || profile?.user_id != null) && !chat.peer_is_bot ? (
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
        defaultSize={{ width: SHEET_MAX_WIDTH_PX, height: 560 }}
        minSize={{ width: 300, height: 320 }}
        sizeStorageKey="hsp.profileSheet.size.v1"
        offsetStorageKey="hsp.profileSheet.offset.v1"
        onRequestClose={onClose}
        testId="profile-sheet"
        sheetStyle={{ borderWidth: 0 }}
      >
        <HspScrollColumn style={{ flex: 1, minHeight: 0 }} containOverscroll>
          {sheetBody}
        </HspScrollColumn>
      </FloatingDialogShell>
      <MessageChatProfileMediaSheet
        visible={mediaKindOpen != null}
        kind={mediaKindOpen}
        chat={chat}
        onClose={() => setMediaKindOpen(null)}
        onNavigateToMessage={onClose}
      />
    </>
  );
}
