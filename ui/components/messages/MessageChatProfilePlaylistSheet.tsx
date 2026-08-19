import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Image,
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type TextStyle,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useColors, layout, type ThemeColors } from "../../theme";
import { HspScrollColumn } from "../HspScrollColumn";
import { appModalSheetStyles } from "../AppModalSheet";
import {
  telegramProfileAudioCoverUrl,
  type TelegramProfileAudioTrack,
} from "../../telegram/fetchTelegramUserProfile";
import {
  getMusicPlayer,
  playMusicIndex,
  setMusicTracks,
  startMusicPlaylist,
  subscribeMusicPlayer,
  toggleMusicPlay,
} from "../../music/musicPlayerStore";
import { unlockMusicAutoplay } from "../../music/musicAudioElement";
import {
  MusicBackChevronIcon,
  MusicPauseIcon,
  MusicPlayIcon,
  MusicReorderIcon,
} from "../music/MusicControlIcons";
import { VoiceWindowCrossIcon } from "./MessageChatVoiceControlIcons";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
} from "./messageListLayout";

const SHEET_MAX_WIDTH_PX = 380;
const PAD_X_PX = 20;
const PAD_TOP_PX = 20;
const PROFILE_OVERLAY_Z = 10070;
const COVER_PX = 40;
const PLAY_BTN_PX = 28;
const ROW_GAP_PX = 10;

type Props = {
  visible: boolean;
  tracks: TelegramProfileAudioTrack[];
  fallbackCoverUrl: string | null;
  onClose: () => void;
  onBack: () => void;
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

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (!(bytes > 0)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function trackCoverUri(track: TelegramProfileAudioTrack, fallback: string | null): string | null {
  if (track.cover_data_url) return track.cover_data_url;
  if (track.cover_file_id != null) {
    return telegramProfileAudioCoverUrl(track.user_id, track.cover_file_id);
  }
  return fallback;
}

function samePlaylist(tracks: TelegramProfileAudioTrack[]): boolean {
  const snap = getMusicPlayer();
  if (!snap.visible || snap.tracks.length !== tracks.length) return false;
  return snap.tracks.every((row, i) => row.file_id === tracks[i]?.file_id && row.user_id === tracks[i]?.user_id);
}

export function MessageChatProfilePlaylistSheet({
  visible,
  tracks,
  fallbackCoverUrl,
  onClose,
  onBack,
}: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { height: windowHeight } = useWindowDimensions();
  const player = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const [localTracks, setLocalTracks] = useState(tracks);
  const dragFromRef = useRef<number | null>(null);

  useEffect(() => {
    setLocalTracks(tracks);
  }, [tracks, visible]);

  const hairline =
    Platform.OS === "web"
      ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
      : 1;

  const moveTrack = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setLocalTracks((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(from, 1);
      if (!row) return prev;
      next.splice(to, 0, row);
      if (samePlaylist(prev)) {
        const current = getMusicPlayer().tracks[getMusicPlayer().index];
        setMusicTracks(next, current?.file_id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof document === "undefined") return;
    const onMove = (event: PointerEvent) => {
      const from = dragFromRef.current;
      if (from == null) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const row = el?.closest?.("[data-playlist-index]") as HTMLElement | null;
      if (!row) return;
      const to = Number(row.dataset.playlistIndex);
      if (!Number.isFinite(to) || to === from) return;
      moveTrack(from, to);
      dragFromRef.current = to;
    };
    const onUp = () => {
      dragFromRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [moveTrack, visible]);

  const playTrack = useCallback(
    (index: number) => {
      unlockMusicAutoplay();
      if (samePlaylist(localTracks) && player.index === index && player.playing) {
        toggleMusicPlay();
        return;
      }
      if (samePlaylist(localTracks)) {
        playMusicIndex(index);
        return;
      }
      startMusicPlaylist(localTracks, index);
    },
    [localTracks, player.index, player.playing],
  );

  const activeFileId = useMemo(() => {
    if (!samePlaylist(localTracks)) return null;
    return player.tracks[player.index]?.file_id ?? null;
  }, [localTracks, player.index, player.tracks, player.visible]);

  if (!visible) return null;

  const sheetHeightPx = Math.min(windowHeight * 0.82, 640);

  const sheetBody = (
    <View
      style={[
        appModalSheetStyles.sheet,
        {
          maxWidth: SHEET_MAX_WIDTH_PX,
          width: "100%",
          height: sheetHeightPx,
          maxHeight: sheetHeightPx,
          backgroundColor: colors.background,
          borderColor: colors.highlight,
          paddingTop: PAD_TOP_PX,
          paddingBottom: 0,
          zIndex: 1,
          flexDirection: "column",
          overflow: "hidden",
        },
      ]}
      {...(Platform.OS === "web"
        ? ({
            onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
            "data-profile-playlist-sheet": "1",
          } as object)
        : {})}
      onStartShouldSetResponder={() => true}
    >
      <View style={{ paddingHorizontal: PAD_X_PX }}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
          <ProfileOpenHitTarget
            label={t("common.back")}
            onPress={onBack}
            style={{ width: 32, height: 32 }}
          >
            <MusicBackChevronIcon color={colors.primary} size={16} />
          </ProfileOpenHitTarget>
          <Text
            style={[
              textBase(colors.primary, { textAlign: "center", flex: 1, fontWeight: "600" as const }),
            ]}
          >
            {t("messages.profile.playlistTitle")}
          </Text>
          <ProfileOpenHitTarget
            label={t("common.close")}
            onPress={onClose}
            style={{ width: 32, height: 32 }}
          >
            <VoiceWindowCrossIcon color={colors.primary} size={15} />
          </ProfileOpenHitTarget>
        </View>
      </View>
      <View
        style={{
          height: hairline,
          width: "100%",
          alignSelf: "stretch",
          backgroundColor: colors.accent,
        }}
      />
      <View
        style={{
          flex: 1,
          minHeight: 0,
          marginTop: 4,
        }}
      >
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingHorizontal: PAD_X_PX, paddingBottom: 0 }}
          scrollbarRightInsetPx={layout.scrollIndicatorRightInsetPx}
          containOverscroll
        >
          {localTracks.length === 0 ? (
            <Text style={[textBase(colors.secondary), { paddingTop: 8 }]}>
              {t("messages.profile.playlistEmpty")}
            </Text>
          ) : (
            localTracks.map((track, index) => {
              const active = activeFileId === track.file_id;
              const meta = [formatClock(track.duration_sec), formatSize(track.size_bytes)]
                .filter(Boolean)
                .join(", ");
              const cover = trackCoverUri(track, fallbackCoverUrl);
              const isLast = index === localTracks.length - 1;
              return (
                <View
                  key={`${track.user_id}:${track.file_id}`}
                  {...(Platform.OS === "web"
                    ? ({ "data-playlist-index": String(index) } as object)
                    : {})}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 8,
                    gap: ROW_GAP_PX,
                    marginBottom: isLast ? 0 : 0,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("messages.music.reorder")}
                    onPressIn={() => {
                      dragFromRef.current = index;
                    }}
                    style={({ pressed }) => ({
                      width: 22,
                      height: 30,
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: pressed ? 0.6 : 1,
                      cursor: Platform.OS === "web" ? ("grab" as never) : undefined,
                    })}
                  >
                    <MusicReorderIcon color={colors.primary} size={16} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      active && player.playing
                        ? t("messages.music.pause")
                        : t("messages.music.play")
                    }
                    onPress={() => playTrack(index)}
                    style={({ pressed }) => ({
                      width: PLAY_BTN_PX,
                      height: PLAY_BTN_PX,
                      borderRadius: PLAY_BTN_PX / 2,
                      backgroundColor: colors.undercover,
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: pressed ? 0.75 : 1,
                    })}
                  >
                    {active && player.playing ? (
                      <MusicPauseIcon color={colors.primary} size={12} />
                    ) : (
                      <MusicPlayIcon color={colors.primary} size={12} />
                    )}
                  </Pressable>
                  <Pressable onPress={() => playTrack(index)} style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={textBase(colors.primary)}>
                      {track.artist}
                      {track.title ? (
                        <Text style={{ color: colors.secondary }}>{` – ${track.title}`}</Text>
                      ) : null}
                    </Text>
                    {meta ? (
                      <Text
                        numberOfLines={1}
                        style={textBase(colors.secondary, {
                          fontSize: 12,
                          lineHeight: 15,
                          marginTop: 2,
                        })}
                      >
                        {meta}
                      </Text>
                    ) : null}
                  </Pressable>
                  <View
                    style={{
                      width: COVER_PX,
                      height: COVER_PX,
                      borderRadius: 4,
                      overflow: "hidden",
                      backgroundColor: colors.undercover,
                    }}
                  >
                    {cover ? (
                      <Image source={{ uri: cover }} style={{ width: COVER_PX, height: COVER_PX }} />
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </HspScrollColumn>
      </View>
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
        onPress={onBack}
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
    <Modal visible transparent animationType="fade" onRequestClose={onBack}>
      {overlay}
    </Modal>
  );
}
