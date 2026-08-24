import { useCallback, useEffect, useMemo, useState } from "react";
import { Image } from "expo-image";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextStyle,
} from "react-native";
import { buildApiUrl } from "../../../api/_base";
import { useAppStrings } from "../../../locales/AppStringsContext";
import type { AppStringKey } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useColors, type ThemeColors } from "../../theme";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import { FloatingDialogShell } from "../FloatingDialogShell";
import { HspScrollColumn } from "../HspScrollColumn";
import { openAuthenticatedHomeChatHistoryAtMessage } from "../../authenticatedHomeSelectedChat";
import {
  fetchTelegramChatMedia,
  type ProfileMediaKind,
  type TelegramChatMediaItem,
} from "../../telegram/fetchTelegramUserProfile";
import type { MessageChatRowData } from "./MessageChatRow";
import { ProfileMarkedIcon } from "./MessageChatProfileIcons";
import { MusicBackChevronIcon, MusicPlayIcon } from "../music/MusicControlIcons";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
} from "./messageListLayout";

const SHEET_MAX_WIDTH_PX = 380;
const PAD_X_PX = 20;
const PAD_TOP_PX = 20;
const HEADER_ROW_H_PX = 32;
/** Above profile sheet (10100). */
const PROFILE_OVERLAY_Z = 10120;
const GRID_COLS = 4;
const GRID_GAP_PX = 1;

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

const GRID_KINDS = new Set<ProfileMediaKind>(["photos", "images", "gifs"]);

type Props = {
  visible: boolean;
  kind: ProfileMediaKind | null;
  chat: MessageChatRowData | null;
  onClose: () => void;
  /** Close media sheet and the profile sheet (header X). */
  onDismissAll?: () => void;
  /** Called after jumping to a media message (closes profile + list). */
  onNavigateToMessage?: () => void;
};

type MonthGroup = {
  key: string;
  label: string;
  items: TelegramChatMediaItem[];
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

function mediaPreviewUrl(chatId: number, messageId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-media?chat_id=${encodeURIComponent(String(chatId))}&message_id=${encodeURIComponent(String(messageId))}`,
  );
}

function monthKey(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return d.toLocaleString(locale, { month: "long" });
  } catch {
    return d.toLocaleString(undefined, { month: "long" });
  }
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

function groupItemsByMonth(
  items: TelegramChatMediaItem[],
  locale: string,
): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const item of items) {
    const key = monthKey(item.date);
    const label = monthLabel(item.date, locale);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label, items: [item] });
    }
  }
  return groups;
}

function ProfileMediaSheetHeader({
  title,
  colors,
  onBack,
  onCloseAll,
  backLabel,
  closeLabel,
}: {
  title: string;
  colors: ThemeColors;
  onBack: () => void;
  onCloseAll: () => void;
  backLabel: string;
  closeLabel: string;
}) {
  const hairline =
    Platform.OS === "web"
      ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
      : 1;
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: HEADER_ROW_H_PX,
          paddingHorizontal: PAD_X_PX,
          paddingTop: PAD_TOP_PX,
          paddingBottom: 10,
        }}
      >
        <ProfileOpenHitTarget
          label={backLabel}
          onPress={onBack}
          style={{ width: 32, height: 32 }}
        >
          <MusicBackChevronIcon color={colors.primary} size={16} />
        </ProfileOpenHitTarget>
        <Text
          style={[
            textBase(colors.primary, {
              flex: 1,
              textAlign: "center",
              fontWeight: "600",
              paddingHorizontal: 8,
            }),
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        <FloatingDialogCloseButton label={closeLabel} onPress={onCloseAll} />
      </View>
      <View
        style={{
          height: hairline,
          backgroundColor: colors.accent,
          alignSelf: "stretch",
        }}
      />
    </View>
  );
}

function MediaGrid({
  chatId,
  items,
  colors,
  showVideoPlay,
  cellSizePx,
  onPressItem,
}: {
  chatId: number;
  items: TelegramChatMediaItem[];
  colors: ThemeColors;
  showVideoPlay?: boolean;
  cellSizePx: number;
  onPressItem: (item: TelegramChatMediaItem) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: GRID_GAP_PX,
      }}
    >
      {items.map((item) => (
        <Pressable
          key={`${item.telegram_message_id}:${item.url}`}
          accessibilityRole="button"
          onPress={() => onPressItem(item)}
          style={{
            width: cellSizePx,
            height: cellSizePx,
            backgroundColor: colors.undercover,
            overflow: "hidden",
          }}
        >
          <Image
            source={{ uri: mediaPreviewUrl(chatId, item.telegram_message_id) }}
            style={{ width: "100%", height: "100%" }}
            contentFit="cover"
            recyclingKey={`profile-media:${chatId}:${item.telegram_message_id}`}
          />
          {showVideoPlay ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(0,0,0,0.18)",
              }}
            >
              <MusicPlayIcon color="#FFFFFF" size={14} />
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

function LinkRow({
  item,
  colors,
  onPress,
}: {
  item: TelegramChatMediaItem;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const title = item.text?.trim() || item.url || "…";
  const url = item.url?.trim() || "";
  const dateLabel = formatItemDate(item.date);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text numberOfLines={2} style={textBase(colors.primary, { fontWeight: "600" as const })}>
        {title}
      </Text>
      {url ? (
        <Text
          numberOfLines={2}
          style={textBase(colors.secondary, {
            marginTop: 4,
            color: "#2AABEE",
          })}
        >
          {url}
        </Text>
      ) : null}
      {dateLabel ? (
        <Text
          numberOfLines={1}
          style={textBase(colors.secondary, { marginTop: 4, fontSize: 12, lineHeight: 15 })}
        >
          {dateLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

function MarkedRow({
  item,
  colors,
  onPress,
}: {
  item: TelegramChatMediaItem;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const dateLabel = formatItemDate(item.date);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        gap: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: colors.undercover,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ProfileMarkedIcon color={colors.primary} size={14} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={textBase(colors.primary)}>
          {item.text?.trim() || "…"}
        </Text>
        {dateLabel ? (
          <Text
            numberOfLines={1}
            style={textBase(colors.secondary, { marginTop: 2, fontSize: 12, lineHeight: 15 })}
          >
            {dateLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Shared sheet for profile media rows (marked / images / photos / links / gifs). */
export function MessageChatProfileMediaSheet({
  visible,
  kind,
  chat,
  onClose,
  onDismissAll,
  onNavigateToMessage,
}: Props) {
  const colors = useColors();
  const { t, locale } = useAppStrings();
  const [items, setItems] = useState<TelegramChatMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [sheetWidthPx, setSheetWidthPx] = useState(SHEET_MAX_WIDTH_PX);

  useEffect(() => {
    if (!visible || !chat || !kind) {
      setItems([]);
      setHasMore(false);
      setError(null);
      setLinkQuery("");
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

  const filteredItems = useMemo(() => {
    if (kind !== "links" || !linkQuery.trim()) return items;
    const q = linkQuery.trim().toLowerCase();
    return items.filter(
      (row) =>
        row.text.toLowerCase().includes(q) || row.url.toLowerCase().includes(q),
    );
  }, [items, kind, linkQuery]);

  const monthGroups = useMemo(
    () => (kind && GRID_KINDS.has(kind) ? groupItemsByMonth(filteredItems, locale) : []),
    [filteredItems, kind, locale],
  );

  const gridCellSizePx = useMemo(() => {
    const usable = Math.max(0, sheetWidthPx - GRID_GAP_PX * (GRID_COLS - 1));
    return Math.floor(usable / GRID_COLS);
  }, [sheetWidthPx]);

  const title = kind ? t(MEDIA_TITLE_KEY[kind]) : "";
  const closeAll = onDismissAll ?? onClose;

  const listBody = (() => {
    if (!kind) return null;
    if (items.length === 0 && !loading) {
      return (
        <Text style={[textBase(colors.secondary), { paddingHorizontal: PAD_X_PX, paddingTop: 12 }]}>
          {error ? error : t(MEDIA_EMPTY_KEY[kind])}
        </Text>
      );
    }

    if (GRID_KINDS.has(kind) && chat) {
      return (
        <View style={{ paddingTop: 8, paddingBottom: 8 }}>
          {monthGroups.map((group) => (
            <View key={group.key}>
              {group.label ? (
                <Text
                  style={[
                    textBase(colors.secondary, {
                      paddingHorizontal: PAD_X_PX,
                      paddingTop: 8,
                      paddingBottom: 6,
                      fontWeight: "600",
                    }),
                  ]}
                >
                  {group.label}
                </Text>
              ) : null}
              <MediaGrid
                chatId={chat.telegram_chat_id}
                items={group.items}
                colors={colors}
                showVideoPlay={kind === "images"}
                cellSizePx={gridCellSizePx}
                onPressItem={openItemMessage}
              />
            </View>
          ))}
        </View>
      );
    }

    if (kind === "links") {
      return (
        <View style={{ paddingHorizontal: PAD_X_PX, paddingTop: 4 }}>
          {filteredItems.map((item) => (
            <LinkRow
              key={`${item.telegram_message_id}:${item.url}`}
              item={item}
              colors={colors}
              onPress={() => openItemMessage(item)}
            />
          ))}
        </View>
      );
    }

    return (
      <View style={{ paddingHorizontal: PAD_X_PX, paddingTop: 4 }}>
        {filteredItems.map((item) => (
          <MarkedRow
            key={`${item.telegram_message_id}:${item.text}`}
            item={item}
            colors={colors}
            onPress={() => openItemMessage(item)}
          />
        ))}
      </View>
    );
  })();

  const sheetBody = (
    <View
      style={{ flex: 1, minHeight: 0 }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && Math.abs(w - sheetWidthPx) > 0.5) setSheetWidthPx(w);
      }}
      {...(Platform.OS === "web"
        ? ({ "data-profile-media-sheet": kind ?? undefined } as object)
        : {})}
    >
      <HspScrollColumn
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        scrollbarRightInsetPx={0}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
        onNearBottom={hasMore && !loading ? loadMore : undefined}
        nearBottomThresholdPx={120}
      >
        <ProfileMediaSheetHeader
          title={title}
          colors={colors}
          onBack={onClose}
          onCloseAll={closeAll}
          backLabel={t("common.back")}
          closeLabel={t("common.close")}
        />

        {kind === "links" ? (
          <View style={{ paddingHorizontal: PAD_X_PX, paddingTop: 10, paddingBottom: 4 }}>
            <TextInput
              value={linkQuery}
              onChangeText={setLinkQuery}
              placeholder={t("messages.profile.mediaSearch")}
              placeholderTextColor={colors.secondary}
              style={{
                color: colors.primary,
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                fontSize: 15,
                lineHeight: 20,
                paddingVertical: 8,
                paddingHorizontal: 0,
                borderBottomWidth:
                  Platform.OS === "web"
                    ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
                    : 1,
                borderBottomColor: colors.highlight,
              }}
              {...(Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {})}
            />
          </View>
        ) : null}

        {listBody}
        {loading && items.length > 0 ? (
          <Text
            style={[textBase(colors.secondary), { textAlign: "center", paddingVertical: 12 }]}
          >
            …
          </Text>
        ) : null}
      </HspScrollColumn>
    </View>
  );

  return (
    <FloatingDialogShell
      visible={Boolean(chat && visible && kind)}
      zIndex={PROFILE_OVERLAY_Z}
      defaultSize={{ width: SHEET_MAX_WIDTH_PX, height: 480 }}
      minSize={{ width: 280, height: 260 }}
      sizeStorageKey="hsp.profileMediaSheet.size.v3"
      offsetStorageKey="hsp.profileMediaSheet.offset.v3"
      onRequestClose={onClose}
      testId={kind ? `profile-media-sheet-${kind}` : "profile-media-sheet"}
    >
      {sheetBody}
    </FloatingDialogShell>
  );
}
