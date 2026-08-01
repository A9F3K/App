import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type TextStyle,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppStringKey } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useColors, type ThemeColors } from "../../theme";
import { HspScrollColumn } from "../HspScrollColumn";
import { appModalSheetStyles } from "../AppModalSheet";
import { openAuthenticatedHomeChatHistoryAtMessage } from "../../authenticatedHomeSelectedChat";
import {
  fetchTelegramChatMedia,
  type ProfileMediaKind,
  type TelegramChatMediaItem,
} from "../../telegram/fetchTelegramUserProfile";
import type { MessageChatRowData } from "./MessageChatRow";
import {
  ProfileGifIcon,
  ProfileImagesIcon,
  ProfileLinksIcon,
  ProfileMarkedIcon,
  ProfilePhotosIcon,
} from "./MessageChatProfileIcons";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
} from "./messageListLayout";

const SHEET_MAX_WIDTH_PX = 380;
const PAD_X_PX = 20;
const PAD_TOP_PX = 20;
const PAD_BOTTOM_PX = 24;
const PROFILE_OVERLAY_Z = 10060;
const HEADER_ICON_PX = 18;

const MEDIA_TITLE_KEY: Record<ProfileMediaKind, AppStringKey> = {
  marked: "messages.profile.mediaTitle.marked",
  images: "messages.profile.mediaTitle.images",
  photos: "messages.profile.mediaTitle.photos",
  links: "messages.profile.mediaTitle.links",
  gifs: "messages.profile.mediaTitle.gifs",
};

const MEDIA_EMPTY_KEY: Record<ProfileMediaKind, AppStringKey> = {
  marked: "messages.profile.mediaEmpty.marked",
  images: "messages.profile.mediaEmpty.images",
  photos: "messages.profile.mediaEmpty.photos",
  links: "messages.profile.mediaEmpty.links",
  gifs: "messages.profile.mediaEmpty.gifs",
};

type Props = {
  visible: boolean;
  kind: ProfileMediaKind | null;
  chat: MessageChatRowData | null;
  onClose: () => void;
  /** Called after jumping to a media message (closes profile + list). */
  onNavigateToMessage?: () => void;
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

function formatItemDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function MediaKindIcon({
  kind,
  color,
}: {
  kind: ProfileMediaKind;
  color: string;
}): ReactNode {
  switch (kind) {
    case "marked":
      return <ProfileMarkedIcon color={color} size={HEADER_ICON_PX} />;
    case "images":
      return <ProfileImagesIcon color={color} size={HEADER_ICON_PX} />;
    case "photos":
      return <ProfilePhotosIcon color={color} size={HEADER_ICON_PX} />;
    case "gifs":
      return <ProfileGifIcon color={color} size={HEADER_ICON_PX} />;
    case "links":
    default:
      return <ProfileLinksIcon color={color} size={HEADER_ICON_PX} />;
  }
}

function MediaItemRow({
  item,
  kind,
  colors,
  onPress,
}: {
  item: TelegramChatMediaItem;
  kind: ProfileMediaKind;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const primary =
    kind === "links" ? item.url || item.text : item.text || item.url || "…";
  const secondary =
    kind === "links" && item.text && item.text !== item.url ? item.text : null;
  const dateLabel = formatItemDate(item.date);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        borderBottomWidth:
          Platform.OS === "web"
            ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
            : 1,
        borderBottomColor: colors.highlight,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text numberOfLines={2} style={textBase(colors.primary, { fontWeight: "600" as const })}>
        {primary}
      </Text>
      {secondary ? (
        <Text
          numberOfLines={2}
          style={textBase(colors.secondary, { marginTop: 4, fontSize: 13, lineHeight: 16 })}
        >
          {secondary}
        </Text>
      ) : null}
      {dateLabel || item.sender_name ? (
        <Text
          numberOfLines={1}
          style={textBase(colors.secondary, { marginTop: 4, fontSize: 12, lineHeight: 15 })}
        >
          {[item.sender_name, dateLabel].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Shared list sheet for profile media rows (marked / images / photos / links / gifs). */
export function MessageChatProfileMediaSheet({
  visible,
  kind,
  chat,
  onClose,
  onNavigateToMessage,
}: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { height: windowHeight } = useWindowDimensions();
  const [items, setItems] = useState<TelegramChatMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !chat || !kind) {
      setItems([]);
      setHasMore(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchTelegramChatMedia(chat.telegram_chat_id, kind, {
      limit: 50,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        setItems([]);
        setHasMore(false);
        return;
      }
      setItems(result.items);
      setHasMore(result.has_more);
    });
    return () => controller.abort();
  }, [visible, chat, kind]);

  const loadMore = useCallback(() => {
    if (!chat || !kind || loading || !hasMore || items.length === 0) return;
    const fromId = items[items.length - 1]?.telegram_message_id;
    if (fromId == null) return;
    setLoading(true);
    void fetchTelegramChatMedia(chat.telegram_chat_id, kind, {
      fromMessageId: fromId,
      limit: 50,
    }).then((result) => {
      setLoading(false);
      if (!result.ok) return;
      setItems((prev) => {
        const seen = new Set(prev.map((row) => row.telegram_message_id));
        const next = [...prev];
        for (const row of result.items) {
          if (seen.has(row.telegram_message_id)) continue;
          seen.add(row.telegram_message_id);
          next.push(row);
        }
        return next;
      });
      setHasMore(result.has_more);
    });
  }, [chat, hasMore, items, kind, loading]);

  const openItemMessage = useCallback(
    (item: TelegramChatMediaItem) => {
      if (!chat) return;
      openAuthenticatedHomeChatHistoryAtMessage(chat, item.telegram_message_id);
      onNavigateToMessage?.();
      onClose();
    },
    [chat, onClose, onNavigateToMessage],
  );

  if (!chat || !visible || !kind) return null;

  const sheetBody = (
    <View
      style={[
        appModalSheetStyles.sheet,
        {
          maxWidth: SHEET_MAX_WIDTH_PX,
          width: "100%",
          backgroundColor: colors.background,
          borderColor: colors.highlight,
          paddingHorizontal: PAD_X_PX,
          paddingTop: PAD_TOP_PX,
          paddingBottom: PAD_BOTTOM_PX,
          maxHeight: Math.min(windowHeight * 0.82, 640),
          zIndex: 1,
        },
      ]}
      {...(Platform.OS === "web"
        ? ({
            onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            "data-profile-media-sheet": kind,
          } as object)
        : {})}
      onStartShouldSetResponder={() => true}
    >
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
        <MediaKindIcon kind={kind} color={colors.primary} />
        <Text style={[textBase(colors.primary), { marginLeft: 10, flex: 1 }]}>
          {t(MEDIA_TITLE_KEY[kind])}
        </Text>
        <ProfileOpenHitTarget
          label={t("common.back")}
          onPress={onClose}
          style={{ width: 32, height: 32 }}
        >
          <VoiceWindowCrossIcon color={colors.primary} size={15} />
        </ProfileOpenHitTarget>
      </View>

      <HspScrollColumn
        style={{ flex: 1, minHeight: 120, maxHeight: Math.min(windowHeight * 0.65, 520) }}
        contentContainerStyle={{ paddingBottom: 8 }}
        containOverscroll
      >
        {items.length === 0 && !loading ? (
          <Text style={textBase(colors.secondary)}>
            {error ? error : t(MEDIA_EMPTY_KEY[kind])}
          </Text>
        ) : (
          items.map((item) => (
            <MediaItemRow
              key={`${kind}:${item.telegram_message_id}:${item.url}`}
              item={item}
              kind={kind}
              colors={colors}
              onPress={() => openItemMessage(item)}
            />
          ))
        )}
        {hasMore ? (
          <Pressable
            onPress={loadMore}
            disabled={loading}
            style={({ pressed }) => ({
              paddingVertical: 14,
              alignItems: "center",
              opacity: loading ? 0.5 : pressed ? 0.7 : 1,
            })}
          >
            <Text style={textBase(colors.secondary)}>{loading ? "…" : "↓"}</Text>
          </Pressable>
        ) : null}
      </HspScrollColumn>
    </View>
  );

  const overlay = (
    <View
      pointerEvents="box-none"
      style={{
        position: Platform.OS === "web" ? ("fixed" as unknown as "absolute") : "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        height: windowHeight,
        zIndex: PROFILE_OVERLAY_Z,
        elevation: PROFILE_OVERLAY_Z,
        justifyContent: "center",
        alignItems: "center",
        ...(Platform.OS === "web"
          ? ({ width: "100vw", height: "100vh", pointerEvents: "auto" } as object)
          : {}),
      }}
    >
      <Pressable
        style={[appModalSheetStyles.backdropFill, { zIndex: 0 }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("common.back")}
      />
      <View style={[appModalSheetStyles.overlayBlock, { minHeight: 0, flexGrow: 0, zIndex: 1 }]}>
        {sheetBody}
      </View>
    </View>
  );

  if (Platform.OS === "web" && typeof document !== "undefined") {
    return createPortal(overlay, document.body);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {overlay}
    </Modal>
  );
}
