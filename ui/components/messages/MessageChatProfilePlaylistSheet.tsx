import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { useColors, layout, type ThemeColors } from "../../theme";
import {
  resolveFloatingDialogInsets,
} from "../floatingDialogChrome";
import { FloatingDialogScrollChromeProvider } from "../floatingDialogScrollChrome";
import { FloatingDialogStickyHeader } from "../FloatingDialogStickyHeader";
import {
  FloatingDialogShell,
} from "../FloatingDialogShell";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { HspScrollColumn } from "../HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../../scrollIndicatorPx";
import {
  fetchTelegramUserProfile,
  telegramProfileAudioCoverUrl,
  type TelegramProfileAudioTrack,
} from "../../telegram/fetchTelegramUserProfile";
import {
  getMusicPlayer,
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
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import {
  MessageChatProfileAudioCoverImage,
  prefetchMessageChatProfileAudioCover,
} from "./MessageChatProfileAudioCoverImage";
import {
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_LINE_HEIGHT_PX,
} from "./messageListLayout";

const PAD_X_PX = 20;
/** Above profile sheet (10100) so playlist opens on top when launched from profile. */
const PROFILE_OVERLAY_Z = 10150;
const COVER_PX = 40;
const PLAY_BTN_PX = 28;
const ROW_GAP_PX = 10;
/** Approximate row height for viewport-based cover fetch window. */
const PLAYLIST_ROW_STRIDE_PX = 56;
const PLAYLIST_COVER_PREFETCH_ROWS = 4;

type Props = {
  visible: boolean;
  tracks: TelegramProfileAudioTrack[];
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

function trackCoverUri(track: TelegramProfileAudioTrack): string | null {
  if (track.cover_data_url) return track.cover_data_url;
  if (track.cover_file_id != null) {
    return telegramProfileAudioCoverUrl(track.user_id, track.cover_file_id);
  }
  return null;
}

function samePlaylist(tracks: TelegramProfileAudioTrack[]): boolean {
  const snap = getMusicPlayer();
  if (!snap.visible || snap.tracks.length !== tracks.length) return false;
  return snap.tracks.every((row, i) => row.file_id === tracks[i]?.file_id && row.user_id === tracks[i]?.user_id);
}

export function MessageChatProfilePlaylistSheet({
  visible,
  tracks,
  onClose,
  onBack,
}: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "profileList"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const player = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const safeTracks = Array.isArray(tracks) ? tracks : [];
  const [localTracks, setLocalTracks] = useState<TelegramProfileAudioTrack[]>(safeTracks);
  const [scrollY, setScrollY] = useState(0);
  const [scrollLayoutH, setScrollLayoutH] = useState(0);
  const [headerExtendPx, setHeaderExtendPx] = useState(0);
  const dragFromRef = useRef<number | null>(null);
  const playlistRefreshGenRef = useRef(0);

  useEffect(() => {
    const incoming = Array.isArray(tracks) ? tracks : [];
    setLocalTracks((prev) => {
      if (!visible) return incoming;
      if (
        Array.isArray(prev) &&
        prev.length > incoming.length &&
        incoming.length > 0 &&
        prev[0]?.user_id === incoming[0]?.user_id
      ) {
        return prev;
      }
      return incoming;
    });
  }, [tracks, visible]);

  useEffect(() => {
    if (!visible) return;
    const seedTracks = Array.isArray(tracks) ? tracks : [];
    const userId =
      getMusicPlayer().tracks[0]?.user_id ??
      seedTracks[0]?.user_id;
    if (userId == null || !Number.isFinite(userId) || userId === 0) return;

    const refreshGen = playlistRefreshGenRef.current + 1;
    playlistRefreshGenRef.current = refreshGen;
    let cancelled = false;

    void fetchTelegramUserProfile(0, userId, undefined, { priority: "high" }).then((result) => {
      if (cancelled || refreshGen !== playlistRefreshGenRef.current || !result.ok) return;
      const full = result.profile.playlist;
      if (!Array.isArray(full) || full.length === 0) return;
      setLocalTracks(full);
    });

    return () => {
      cancelled = true;
    };
    // Refresh once when the sheet opens; full list comes from profile API (may exceed player queue).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-once refresh keyed on visible
  }, [visible]);

  const coverFetchWindow = useMemo(() => {
    const layoutH = scrollLayoutH > 0 ? scrollLayoutH : 480;
    const start = Math.max(
      0,
      Math.floor(scrollY / PLAYLIST_ROW_STRIDE_PX) - PLAYLIST_COVER_PREFETCH_ROWS,
    );
    const end = Math.min(
      localTracks.length - 1,
      Math.ceil((scrollY + layoutH) / PLAYLIST_ROW_STRIDE_PX) + PLAYLIST_COVER_PREFETCH_ROWS,
    );
    return { start, end };
  }, [localTracks.length, scrollLayoutH, scrollY]);

  useEffect(() => {
    if (!visible) return;
    for (let i = coverFetchWindow.start; i <= coverFetchWindow.end; i += 1) {
      const track = localTracks[i];
      if (!track) continue;
      const cover = trackCoverUri(track);
      if (cover) prefetchMessageChatProfileAudioCover(cover, { priority: "high" });
    }
  }, [coverFetchWindow.end, coverFetchWindow.start, localTracks, visible]);

  const moveTrack = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setLocalTracks((prev) => {
      if (!Array.isArray(prev) || from >= prev.length || to >= prev.length) return prev;
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
      const track = localTracks[index];
      if (!track) return;
      unlockMusicAutoplay();
      const snap = getMusicPlayer();
      const current = snap.tracks[snap.index];
      const sameTrack =
        current != null &&
        current.file_id === track.file_id &&
        current.user_id === track.user_id;
      if (sameTrack && snap.playing) {
        toggleMusicPlay();
        return;
      }
      startMusicPlaylist(localTracks, index);
    },
    [localTracks],
  );

  const activeTrack = player.tracks[player.index] ?? null;

  const sheetBody = (
    <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: "column",
          overflow: "hidden",
        }}
        {...(Platform.OS === "web"
          ? ({
              dataSet: {
                profilePlaylistSheet: "1",
                hspFloatingDialogBody: "1",
              },
            } as object)
          : {})}
      >
        <FloatingDialogStickyHeader
          insets={dialogInsets}
          title={t("messages.profile.playlistTitle")}
          titleAlign="center"
          onClose={onClose}
          closeLabel={t("common.close")}
          onHeightChange={setHeaderExtendPx}
          leading={
            <ProfileOpenHitTarget
              label={t("common.back")}
              onPress={onBack}
              style={{ width: 32, height: 32 }}
            >
              <MusicBackChevronIcon color={colors.primary} size={16} />
            </ProfileOpenHitTarget>
          }
        />
        <HspScrollColumn
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            paddingTop: dialogInsets.bodyPadTop,
            paddingHorizontal: PAD_X_PX,
            paddingBottom: dialogInsets.bodyPadBottom,
          }}
        scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
        onScrollPositionChange={(metrics) => {
          setScrollY(metrics.scrollY);
          setScrollLayoutH(metrics.layoutH);
        }}
        onMetricsChange={(metrics) => {
          setScrollLayoutH(metrics.layoutH);
        }}
      >
        {localTracks.length === 0 ? (
          <Text style={[textBase(colors.secondary), { paddingTop: 8 }]}>
            {t("messages.profile.playlistEmpty")}
          </Text>
        ) : (
          localTracks.map((track, index) => {
            const active =
              activeTrack != null &&
              activeTrack.file_id === track.file_id &&
              activeTrack.user_id === track.user_id;
            const meta = [formatClock(track.duration_sec), formatSize(track.size_bytes)]
              .filter(Boolean)
              .join(", ");
            const cover = trackCoverUri(track);
            const coverLoadEnabled =
              index >= coverFetchWindow.start && index <= coverFetchWindow.end;
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
                  {...(Platform.OS === "web"
                    ? ({ "data-floating-no-drag": "1" } as object)
                    : {})}
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
                  {...(Platform.OS === "web"
                    ? ({ "data-floating-no-drag": "1" } as object)
                    : {})}
                >
                  {active && player.playing ? (
                    <MusicPauseIcon color={colors.primary} size={12} />
                  ) : (
                    <MusicPlayIcon color={colors.primary} size={12} />
                  )}
                </Pressable>
                <Pressable
                  onPress={() => playTrack(index)}
                  style={{ flex: 1, minWidth: 0 }}
                  {...(Platform.OS === "web"
                    ? ({ "data-floating-no-drag": "1" } as object)
                    : {})}
                >
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
                {cover ? (
                  <View
                    style={{
                      width: COVER_PX,
                      height: COVER_PX,
                      borderRadius: 4,
                      overflow: "hidden",
                      backgroundColor: colors.undercover,
                    }}
                  >
                    <MessageChatProfileAudioCoverImage
                      uri={cover}
                      sizePx={COVER_PX}
                      loadEnabled={coverLoadEnabled}
                      fetchPriority="high"
                    />
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </HspScrollColumn>
      </View>
    </FloatingDialogScrollChromeProvider>
  );

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={PROFILE_OVERLAY_Z}
      defaultSize={defaultSize}
      minSize={{ width: 300, height: 300 }}
      sizeStorageKey="hsp.profilePlaylistSheet.size.v4"
      offsetStorageKey="hsp.profilePlaylistSheet.offset.v4"
      onRequestClose={onBack}
      testId="profile-playlist-sheet"
      moveIgnoreSelector="[data-floating-no-drag],button,[role='button']"
    >
      {sheetBody}
    </FloatingDialogShell>
  );
}

