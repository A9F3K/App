import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Platform, Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import {
  FIXED_ROW_30_HEIGHT_PX,
  layout,
  typographyFixedRow30Label,
  type ThemeColors,
} from "../../theme";
import {
  closeMusicPlayer,
  cycleMusicLoopMode,
  cycleMusicSpeed,
  formatMusicSpeedLabel,
  getMusicPlayer,
  MUSIC_CONTROL_BAR_HEIGHT_PX,
  playMusicNext,
  playMusicPrev,
  seekMusicRatio,
  setMusicVolume,
  subscribeMusicPlayer,
  toggleMusicPlay,
  toggleMusicShuffle,
} from "../../music/musicPlayerStore";
import { unlockMusicAutoplay } from "../../music/musicAudioElement";
import { useProfileSheet } from "../../profile/ProfileContext";
import {
  MusicCloseIcon,
  MusicLoopIcon,
  MusicNextIcon,
  MusicPauseIcon,
  MusicPlayIcon,
  MusicPrevIcon,
  MusicShuffleIcon,
  MusicVolumeIcon,
} from "./MusicControlIcons";

type Props = {
  colors: ThemeColors;
};

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function iconHit(pressed: boolean) {
  return {
    width: 22,
    height: MUSIC_CONTROL_BAR_HEIGHT_PX,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    opacity: pressed ? 0.65 : 1,
  };
}

export function GlobalMusicControlBar({ colors }: Props) {
  const { t } = useAppStrings();
  const { openMusicPlaylistSheet } = useProfileSheet();
  const snap = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayer, getMusicPlayer);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeAnchorRef = useRef<View>(null);
  const [volumeBox, setVolumeBox] = useState<{ right: number; top: number } | null>(null);
  const seekRef = useRef<View>(null);
  const seekingRef = useRef(false);

  const track = snap.tracks[snap.index] ?? null;
  const progress =
    snap.duration > 0 ? Math.max(0, Math.min(1, snap.currentTime / snap.duration)) : 0;

  const applySeekFromClientX = useCallback((clientX: number) => {
    const node = seekRef.current as unknown as { getBoundingClientRect?: () => DOMRect } | null;
    const rect = node?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    seekMusicRatio((clientX - rect.left) / rect.width);
  }, []);

  useEffect(() => {
    if (!snap.visible) setVolumeOpen(false);
  }, [snap.visible]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const node = seekRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      seekingRef.current = true;
      node.setPointerCapture?.(event.pointerId);
      applySeekFromClientX(event.clientX);
    };
    const onMove = (event: PointerEvent) => {
      if (!seekingRef.current) return;
      applySeekFromClientX(event.clientX);
    };
    const onUp = (event: PointerEvent) => {
      if (!seekingRef.current) return;
      seekingRef.current = false;
      try {
        node.releasePointerCapture?.(event.pointerId);
      } catch {
        // ignore
      }
    };
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [applySeekFromClientX, snap.visible]);

  const openVolume = useCallback(() => {
    const node = volumeAnchorRef.current as unknown as {
      getBoundingClientRect?: () => DOMRect;
    } | null;
    const rect = node?.getBoundingClientRect?.();
    if (rect) {
      setVolumeBox({
        right: Math.max(8, window.innerWidth - rect.right),
        top: rect.bottom + 6,
      });
    }
    setVolumeOpen((open) => !open);
  }, []);

  if (!snap.visible || !track) return null;

  const title =
    track.title && track.artist !== track.title
      ? `${track.artist} – ${track.title}`
      : track.artist || track.title;
  const font = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;
  const hairline =
    Platform.OS === "web"
      ? 1 / (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
      : 1;

  const bar = (
    <View
      style={{
        alignSelf: "stretch",
        width: "100%",
        height: FIXED_ROW_30_HEIGHT_PX,
        backgroundColor: colors.background,
        zIndex: 20,
      }}
      {...({ "data-music-global-bar": "1" } as object)}
    >
      <View
        style={{
          height: MUSIC_CONTROL_BAR_HEIGHT_PX,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: layout.contentSideInsetPx,
          gap: 6,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.music.prev")}
          onPress={() => {
            unlockMusicAutoplay();
            playMusicPrev();
          }}
          style={({ pressed }) => iconHit(pressed)}
        >
          <MusicPrevIcon color={colors.primary} size={14} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            snap.playing ? t("messages.music.pause") : t("messages.music.play")
          }
          onPress={() => {
            unlockMusicAutoplay();
            toggleMusicPlay();
          }}
          style={({ pressed }) => iconHit(pressed)}
        >
          {snap.playing ? (
            <MusicPauseIcon color={colors.primary} size={14} />
          ) : (
            <MusicPlayIcon color={colors.primary} size={14} />
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.music.next")}
          onPress={() => {
            unlockMusicAutoplay();
            playMusicNext();
          }}
          style={({ pressed }) => iconHit(pressed)}
        >
          <MusicNextIcon color={colors.primary} size={14} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.profile.playlistTitle")}
          onPress={openMusicPlaylistSheet}
          style={({ pressed }) => ({
            flex: 1,
            minWidth: 0,
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text
            numberOfLines={1}
            style={[
              typographyFixedRow30Label,
              { color: colors.primary, fontFamily: font },
            ]}
          >
            {title}
          </Text>
        </Pressable>
        <Text
          style={[
            typographyFixedRow30Label,
            { color: colors.secondary, fontFamily: font, marginRight: 2 },
          ]}
        >
          {formatClock(snap.currentTime)}
        </Text>
        <View ref={volumeAnchorRef} collapsable={false}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("messages.music.volume")}
            onPress={openVolume}
            style={({ pressed }) => iconHit(pressed)}
          >
            <MusicVolumeIcon color={colors.primary} size={14} />
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.music.shuffle")}
          onPress={toggleMusicShuffle}
          style={({ pressed }) => iconHit(pressed)}
        >
          <MusicShuffleIcon
            color={snap.shuffle ? colors.primary : colors.secondary}
            size={14}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            snap.loopMode === "off"
              ? t("messages.music.loopOff")
              : snap.loopMode === "one"
                ? t("messages.music.loopOne")
                : t("messages.music.loopAll")
          }
          onPress={cycleMusicLoopMode}
          style={({ pressed }) => iconHit(pressed)}
        >
          <MusicLoopIcon color={colors.primary} size={14} mode={snap.loopMode} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.music.speed")}
          onPress={cycleMusicSpeed}
          style={({ pressed }) => ({
            ...iconHit(pressed),
            width: 28,
            flexDirection: "column",
            gap: 2,
          })}
        >
          <View
            style={{
              width: 16,
              height: hairline,
              borderStyle: "dashed",
              borderTopWidth: hairline,
              borderColor: colors.primary,
            }}
          />
          <Text
            style={{
              color: colors.primary,
              fontFamily: font,
              fontSize: 9,
              lineHeight: 10,
              fontWeight: "600",
            }}
          >
            {formatMusicSpeedLabel(snap.speed)}
          </Text>
          <View
            style={{
              width: 16,
              height: hairline,
              borderStyle: "dashed",
              borderTopWidth: hairline,
              borderColor: colors.primary,
            }}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("messages.music.close")}
          onPress={closeMusicPlayer}
          style={({ pressed }) => iconHit(pressed)}
        >
          <MusicCloseIcon color={colors.primary} size={14} />
        </Pressable>
      </View>
      <View
        ref={seekRef}
        accessibilityRole="adjustable"
        accessibilityLabel={t("messages.music.seek")}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 10,
          justifyContent: "flex-end",
          cursor: Platform.OS === "web" ? ("pointer" as never) : undefined,
        }}
      >
        <View style={{ height: 1, backgroundColor: colors.highlight, width: "100%" }}>
          <View
            style={{
              height: 1,
              width: `${progress * 100}%`,
              backgroundColor: colors.primary,
            }}
          />
        </View>
      </View>
      {volumeOpen && volumeBox && Platform.OS === "web" && typeof document !== "undefined"
        ? createPortal(
            <View
              pointerEvents="box-none"
              style={{
                position: "fixed" as unknown as "absolute",
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 11100,
              }}
            >
              <Pressable
                style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
                onPress={() => setVolumeOpen(false)}
              />
              <View
                style={{
                  position: "absolute" as unknown as "relative",
                  top: volumeBox.top,
                  right: volumeBox.right,
                  width: 36,
                  height: 120,
                  borderRadius: 8,
                  backgroundColor: colors.undercover,
                  alignItems: "center",
                  paddingTop: 8,
                  paddingBottom: 10,
                  zIndex: 1,
                }}
              >
                <MusicVolumeIcon color={colors.secondary} size={14} />
                <MusicVolumeSlider
                  colors={colors}
                  value={snap.muted ? 0 : snap.volume}
                  onChange={setMusicVolume}
                />
              </View>
            </View>,
            document.body,
          )
        : null}
    </View>
  );

  if (Platform.OS !== "web" || typeof document === "undefined") {
    return bar;
  }

  return bar;
}

function MusicVolumeSlider({
  colors,
  value,
  onChange,
}: {
  colors: ThemeColors;
  value: number;
  onChange: (next: number) => void;
}) {
  const trackRef = useRef<View>(null);

  const applyFromClientY = useCallback(
    (clientY: number) => {
      const node = trackRef.current as unknown as {
        getBoundingClientRect?: () => DOMRect;
      } | null;
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.height <= 0) return;
      const ratio = 1 - (clientY - rect.top) / rect.height;
      onChange(Math.max(0, Math.min(1, ratio)));
    },
    [onChange],
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = trackRef.current as unknown as HTMLElement | null;
    if (!node) return;
    let dragging = false;
    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      node.setPointerCapture?.(event.pointerId);
      applyFromClientY(event.clientY);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      applyFromClientY(event.clientY);
    };
    const onUp = () => {
      dragging = false;
    };
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [applyFromClientY]);

  const TRACK_H = 80;
  const thumbTop = (1 - Math.max(0, Math.min(1, value))) * TRACK_H - 6;

  return (
    <View
      ref={trackRef}
      style={{
        width: 16,
        height: TRACK_H,
        marginTop: 8,
        alignItems: "center",
        cursor: Platform.OS === "web" ? ("ns-resize" as never) : undefined,
      }}
    >
      <View
        style={{
          width: 2,
          height: TRACK_H,
          backgroundColor: colors.highlight,
          borderRadius: 1,
          position: "relative",
        }}
      >
        <View
          style={{
            position: "absolute",
            left: -5,
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: colors.secondary,
            top: thumbTop,
          }}
        />
      </View>
    </View>
  );
}
