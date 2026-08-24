import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  appLocaleToBcp47,
  type AppLocale,
} from "../../../locales/appStrings";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useColors } from "../../theme";
import type { TelegramProfilePhotoMarkup } from "../../../shared/telegramProfilePhoto";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import { useTelegram } from "../Telegram";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import { loadMessageChatAvatarObjectUrl } from "./MessageChatAvatarImage";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";

/** Above profile media sheet (10120) and playlist (10150). */
const PROFILE_PHOTO_VIEWER_Z = 10200;
const CHROME_PAD_PX = 20;

export type MessageChatProfilePhotoViewerProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  iconUrl: string | null;
  animatedIconUrl?: string | null;
  profilePhoto?: TelegramProfilePhotoMarkup | null;
  /** ISO timestamp from `profile_photo.added_at` when known. */
  addedAt?: string | null;
};

function formatProfilePhotoAddedAt(
  iso: string | null | undefined,
  locale: AppLocale,
  atWord: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const tag = appLocaleToBcp47(locale);
  const day = date.toLocaleDateString(tag, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const time = date.toLocaleTimeString(tag, {
    hour: "numeric",
    minute: "2-digit",
  });
  return atWord.trim() ? `${day} ${atWord} ${time}` : `${day} ${time}`;
}

function ProfilePhotoDownloadIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3v12m0 0l4-4m-4 4l-4-4M5 19h14"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

async function downloadAvatarUri(uri: string, filename: string): Promise<void> {
  const objectUrl = await loadMessageChatAvatarObjectUrl(uri);
  if (!objectUrl) return;
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export function MessageChatProfilePhotoViewer({
  visible,
  onClose,
  title,
  iconUrl,
  animatedIconUrl = null,
  profilePhoto = null,
  addedAt = null,
}: MessageChatProfilePhotoViewerProps) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const { t, locale } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  const resolvedAddedAt = addedAt ?? profilePhoto?.added_at ?? null;
  const addedLabel = useMemo(
    () => formatProfilePhotoAddedAt(resolvedAddedAt, locale, t("messages.profile.photoAt")),
    [locale, resolvedAddedAt, t],
  );
  const initials = useMemo(() => extractChatAvatarInitials(title), [title]);
  const photoSizePx = Math.max(
    160,
    Math.min(Math.floor(windowWidth * 0.72), Math.floor(windowHeight * 0.72), 640),
  );
  const metaLine = [t("messages.profile.photoTitle"), title.trim() || null, addedLabel]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    if (typeof document !== "undefined") setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, visible]);

  const handleDownload = useCallback(() => {
    if (!iconUrl) return;
    const safe = title.trim().replace(/[^\w.-]+/g, "_").slice(0, 48) || "profile";
    void downloadAvatarUri(iconUrl, `${safe}-profile-photo.jpg`);
  }, [iconUrl, title]);

  if (!visible) return null;

  const body = (
    <View
      style={{
        position: Platform.OS === "web" ? ("fixed" as unknown as "absolute") : "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: PROFILE_PHOTO_VIEWER_Z,
        elevation: PROFILE_PHOTO_VIEWER_Z,
        backgroundColor: "rgba(0,0,0,0.82)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={onClose}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
      />
      <View pointerEvents="box-none" style={{ alignItems: "center", justifyContent: "center" }}>
        {iconUrl || profilePhoto ? (
          <MessageChatAvatarSlot
            iconUrl={iconUrl}
            initials={initials}
            sizePx={photoSizePx}
            colors={colors}
            scheme={colorScheme}
            loadEnabled
            fetchPriority="critical"
            profilePhoto={profilePhoto}
            animatedIconUrl={animatedIconUrl}
            emojiFetchEnabled
            framed={false}
          />
        ) : (
          <ChatAvatarFallback
            initials={initials}
            sizePx={photoSizePx}
            colors={colors}
            scheme={colorScheme}
          />
        )}
      </View>
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: CHROME_PAD_PX,
          paddingBottom: CHROME_PAD_PX,
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            color: "#FFFFFF",
            fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
            fontSize: 13,
            lineHeight: 18,
            textShadowColor: "rgba(0,0,0,0.55)",
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 3,
          }}
          numberOfLines={2}
        >
          {metaLine}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {iconUrl ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("messages.profile.photoDownloadA11y")}
              onPress={handleDownload}
              style={({ pressed }) => ({
                width: 28,
                height: 28,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <ProfilePhotoDownloadIcon color="#FFFFFF" />
            </Pressable>
          ) : null}
          <FloatingDialogCloseButton
            label={t("common.close")}
            onPress={onClose}
            color="#FFFFFF"
          />
        </View>
      </View>
    </View>
  );

  if (Platform.OS === "web") {
    if (!portalTarget) return null;
    return createPortal(body, portalTarget);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}
