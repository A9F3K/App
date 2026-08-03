import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { WEB_UI_SANS_STACK } from "../../fonts";
import { MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX } from "./messageListLayout";
import { VoiceParticipantStateMicIcon } from "./MessageChatVoiceParticipantMicIcon";

export type VoiceMediaStageSource = {
  id: string;
  stream: MediaStream;
  /** Shown on mosaic / focus tiles. */
  label?: string;
  kind?: "camera" | "screen";
  /** Mic off for everyone (or local mute chrome). */
  muted?: boolean;
  /** Green border + green mic when speaking. */
  speaking?: boolean;
};

type PlaneProps = {
  stream: MediaStream;
  active: boolean;
  objectFit?: "contain" | "cover";
  onPress?: () => void;
  accessibilityLabel?: string;
  onHasFramesChange?: (hasFrames: boolean) => void;
};

const SPEAKING_BORDER = "#34C759";
const TILE_GAP_PX = 6;
const TILE_RADIUS_PX = 8;

/** Tiny canvas / SFU placeholder tracks must not become a black PiP overlay. */
export function streamLooksLikePlaceholderVideo(stream: MediaStream): boolean {
  const tracks = stream.getVideoTracks().filter((t) => t.readyState === "live");
  if (tracks.length === 0) return true;
  return tracks.every((t) => {
    if (!t.enabled) return true;
    try {
      const settings = t.getSettings?.() ?? {};
      const w = Number(settings.width) || 0;
      const h = Number(settings.height) || 0;
      if (w > 0 && h > 0 && w <= 4 && h <= 4) return true;
    } catch {
      /* ignore */
    }
    const label = (t.label || "").toLowerCase();
    if (label.includes("canvas") || label.includes("silent") || label.includes("placeholder")) {
      return true;
    }
    return false;
  });
}

function VoiceVideoElement({
  stream,
  active,
  objectFit = "contain",
  onPress,
  accessibilityLabel,
  onHasFramesChange,
}: PlaneProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasFrames, setHasFrames] = useState(false);
  const trackKey = stream
    .getVideoTracks()
    .map((t) => `${t.id}:${t.readyState}:${t.muted ? "m" : "u"}:${t.enabled ? "e" : "d"}`)
    .join("|");

  const attachStream = useCallback((el: HTMLVideoElement | null, next: MediaStream | null, on: boolean) => {
    if (!el) return;
    if (!on || !next) {
      el.srcObject = null;
      el.pause();
      return;
    }
    if (el.srcObject !== next) {
      el.srcObject = next;
    }
    el.muted = true;
    el.playsInline = true;
    void el.play().catch(() => undefined);
  }, []);

  const setVideoNode = useCallback(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      attachStream(node, stream, active);
    },
    [active, attachStream, stream],
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    attachStream(videoRef.current, stream, active);
  }, [active, attachStream, stream]);

  useEffect(() => {
    onHasFramesChange?.(hasFrames);
  }, [hasFrames, onHasFramesChange]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    setHasFrames(false);
    if (!active || !stream) return;

    const el = videoRef.current;
    let stopped = false;
    let poll = 0;
    let stopPoll = 0;
    let frameCallbackId = 0;
    const videoEl = el as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
          cancelVideoFrameCallback?: (id: number) => void;
        })
      | null;

    const stopFrameWatch = () => {
      stopped = true;
      if (poll) window.clearInterval(poll);
      if (stopPoll) window.clearTimeout(stopPoll);
      poll = 0;
      stopPoll = 0;
      if (videoEl?.cancelVideoFrameCallback && frameCallbackId) {
        videoEl.cancelVideoFrameCallback(frameCallbackId);
        frameCallbackId = 0;
      }
    };

    const markFrames = () => {
      if (stopped) return;
      const video = videoRef.current;
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      if (video.videoWidth <= 4 && video.videoHeight <= 4) return;
      setHasFrames(true);
      // Stop frame polling once we have real pixels — rVFC every frame during
      // screen decode was contributing to voice-dialog main-thread stalls.
      stopFrameWatch();
    };

    const onTrackUnmute = () => {
      markFrames();
      window.setTimeout(markFrames, 120);
      window.setTimeout(markFrames, 400);
      window.setTimeout(markFrames, 1200);
    };
    // Do not drop opacity on brief WebRTC mute flaps — that made a live stage
    // look black/frozen while currentTime still advanced.
    let muteHideTimer = 0;
    const onTrackMute = () => {
      if (muteHideTimer) window.clearTimeout(muteHideTimer);
      muteHideTimer = window.setTimeout(() => {
        muteHideTimer = 0;
        if (stopped) return;
        const stillMuted = stream
          .getVideoTracks()
          .some((t) => t.readyState === "live" && t.muted);
        if (stillMuted) setHasFrames(false);
      }, 700);
    };

    for (const track of stream.getVideoTracks()) {
      track.addEventListener("unmute", onTrackUnmute);
      track.addEventListener("mute", onTrackMute);
      if (track.muted) onTrackMute();
      else onTrackUnmute();
    }

    if (el) {
      el.addEventListener("loadeddata", markFrames);
      el.addEventListener("resize", markFrames);
      el.addEventListener("playing", markFrames);
      markFrames();
    }

    poll = window.setInterval(markFrames, 250);
    stopPoll = window.setTimeout(() => {
      if (poll) window.clearInterval(poll);
      poll = 0;
    }, 20_000);

    const onVideoFrame = () => {
      if (stopped) return;
      markFrames();
      if (!stopped && videoEl?.requestVideoFrameCallback) {
        frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
      }
    };
    if (videoEl?.requestVideoFrameCallback) {
      frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
    }

    return () => {
      stopFrameWatch();
      if (muteHideTimer) window.clearTimeout(muteHideTimer);
      for (const track of stream.getVideoTracks()) {
        track.removeEventListener("unmute", onTrackUnmute);
        track.removeEventListener("mute", onTrackMute);
      }
      if (el) {
        el.removeEventListener("loadeddata", markFrames);
        el.removeEventListener("resize", markFrames);
        el.removeEventListener("playing", markFrames);
      }
    };
  }, [active, stream, trackKey]);

  if (Platform.OS !== "web" || !active || !stream) {
    return null;
  }

  const videoNode = createElement("video", {
    ref: setVideoNode,
    autoPlay: true,
    playsInline: true,
    muted: true,
    controls: false,
    style: {
      width: "100%",
      height: "100%",
      objectFit,
      backgroundColor: "#000000",
      display: "block",
      opacity: hasFrames ? 1 : 0.02,
    },
  });

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={{ width: "100%", height: "100%" }}
      >
        {videoNode}
      </Pressable>
    );
  }

  return (
    <View accessibilityLabel={accessibilityLabel} style={{ width: "100%", height: "100%" }}>
      {videoNode}
    </View>
  );
}

/**
 * Thin: singleton rows prefer the top (1+2 for three).
 * Wide: singleton rows prefer the bottom (2+1 for three).
 */
export function mosaicRowSizes(count: number, wide: boolean): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  if (count === 2) return wide ? [2] : [1, 1];
  if (count === 3) return wide ? [2, 1] : [1, 2];
  const rows: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    if (remaining === 3) {
      if (wide) {
        rows.push(2, 1);
      } else {
        rows.push(1, 2);
      }
      break;
    }
    const take = Math.min(2, remaining);
    rows.push(take);
    remaining -= take;
  }
  return rows;
}

type TileChromeProps = {
  source: VoiceMediaStageSource;
  active: boolean;
  speaking: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Compact chrome for sidebar thumbs. */
  compact?: boolean;
};

function MediaTile({
  source,
  active,
  speaking,
  onPress,
  accessibilityLabel,
  compact = false,
}: TileChromeProps) {
  const muted = Boolean(source.muted);
  const label = (source.label || "").trim();
  const micSize = compact ? 14 : 18;

  const body = (
    <>
      <VoiceVideoElement
        key={`tile:${source.id}`}
        stream={source.stream}
        active={active}
        objectFit="contain"
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: compact ? 6 : 8,
          paddingVertical: compact ? 4 : 6,
          backgroundColor: "rgba(0,0,0,0.55)",
          gap: 6,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            color: "#ffffff",
            fontSize: compact ? 11 : 13,
            lineHeight: compact ? 14 : 16,
            fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : undefined,
          }}
        >
          {label || " "}
        </Text>
        <VoiceParticipantStateMicIcon
          speaking={speaking && !muted}
          muted={muted}
          color={muted ? "#FF1111" : speaking ? SPEAKING_BORDER : "#ffffff"}
          size={micSize}
        />
      </View>
    </>
  );

  const shellStyle = {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: "#000000",
    borderRadius: TILE_RADIUS_PX,
    overflow: "hidden" as const,
    borderWidth: speaking ? 2 : 1,
    borderColor: speaking ? SPEAKING_BORDER : "rgba(255,255,255,0.12)",
    position: "relative" as const,
  };

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={shellStyle}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View accessibilityLabel={accessibilityLabel} style={shellStyle}>
      {body}
    </View>
  );
}

type MosaicProps = {
  sources: VoiceMediaStageSource[];
  active: boolean;
  wide: boolean;
  onSelect: (id: string) => void;
  /** Parent sizes the stage (e.g. single-tile aspect box) — fill it instead of flex-grow. */
  fillParent?: boolean;
};

function MosaicGrid({ sources, active, wide, onSelect, fillParent = false }: MosaicProps) {
  const rows = mosaicRowSizes(sources.length, wide);
  let cursor = 0;
  const rowSources = rows.map((size) => {
    const slice = sources.slice(cursor, cursor + size);
    cursor += size;
    return slice;
  });

  return (
    <View
      style={{
        flex: fillParent ? undefined : 1,
        width: "100%",
        height: fillParent ? "100%" : undefined,
        minHeight: fillParent ? undefined : 0,
        gap: TILE_GAP_PX,
      }}
    >
      {rowSources.map((row, rowIndex) => (
        <View
          key={`mosaic-row:${rowIndex}`}
          style={{
            flex: 1,
            minHeight: 0,
            flexDirection: "row",
            gap: TILE_GAP_PX,
          }}
        >
          {row.map((source) => (
            <MediaTile
              key={`mosaic:${source.id}`}
              source={source}
              active={active}
              speaking={Boolean(source.speaking) && !source.muted}
              onPress={() => onSelect(source.id)}
              accessibilityLabel={
                source.label
                  ? `Expand ${source.label}`
                  : "Expand screen share"
              }
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export type VoiceMediaPipColumnProps = {
  sources: VoiceMediaStageSource[];
  active: boolean;
  onSelect: (id: string) => void;
};

/** Right-column thumbs when a wide-stage tile is expanded. */
export function MessageChatVoiceMediaPipColumn({
  sources,
  active,
  onSelect,
}: VoiceMediaPipColumnProps) {
  if (Platform.OS !== "web" || !active || sources.length === 0) return null;
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingBottom: 8,
        gap: TILE_GAP_PX,
        maxHeight: 220,
        overflow: "hidden",
      }}
    >
      {sources.map((source) => (
        <View
          key={`sidebar-pip:${source.id}`}
          style={{
            width: "100%",
            aspectRatio: 16 / 9,
            maxHeight: 100,
          }}
        >
          <MediaTile
            source={source}
            active={active}
            speaking={Boolean(source.speaking) && !source.muted}
            compact
            onPress={() => onSelect(source.id)}
            accessibilityLabel={
              source.label ? `Show ${source.label}` : "Show this screen share"
            }
          />
        </View>
      ))}
    </View>
  );
}

type StageProps = {
  sources: VoiceMediaStageSource[];
  active: boolean;
  maxHeightPx?: number;
  horizontalInsetPx?: number;
  marginBottomPx?: number;
  /** Fill the parent height (side-by-side voice dialog) instead of capped stack. */
  fillHeight?: boolean;
  /**
   * Wide sheet (video docked left of roster). Thin = stacked mosaic like pic 1.
   * Wide mosaic = pic 2; wide + focusedId = pic 3 main pane.
   */
  wideLayout?: boolean;
  /** Controlled focus — null = mosaic gallery. */
  focusedId?: string | null;
  onFocusedIdChange?: (id: string | null) => void;
  /**
   * When focused on a wide sheet, hide in-pane PiPs so the parent can render
   * them in the roster column (Discord-style).
   */
  externalPips?: boolean;
  /**
   * When a single tile is showing, size the stage to the video aspect ratio
   * (capped by maxHeight) instead of a fixed empty band with letterbox gaps.
   */
  fitSingleToContent?: boolean;
};

function aspectRatioFromSource(source: VoiceMediaStageSource): number {
  for (const track of source.stream.getVideoTracks()) {
    try {
      const settings = track.getSettings?.() ?? {};
      const w = Number(settings.width) || 0;
      const h = Number(settings.height) || 0;
      if (w > 4 && h > 4) return w / h;
    } catch {
      /* ignore */
    }
  }
  return source.kind === "camera" ? 3 / 4 : 16 / 9;
}

/**
 * Screenshare / camera stage:
 * - Thin: combined mosaic (1+2 for three).
 * - Wide unfocused: mosaic (2+1 for three).
 * - Wide focused: one large tile; other thumbs via external pip column.
 */
function MessageChatVoiceMediaStageInner({
  sources,
  active,
  maxHeightPx = MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  horizontalInsetPx = 0,
  marginBottomPx = 0,
  fillHeight = false,
  wideLayout = false,
  focusedId: focusedIdProp,
  onFocusedIdChange,
  externalPips = false,
  fitSingleToContent = false,
}: StageProps) {
  const [focusedIdState, setFocusedIdState] = useState<string | null>(null);
  const focusedId = focusedIdProp !== undefined ? focusedIdProp : focusedIdState;
  const setFocusedId = useCallback(
    (id: string | null) => {
      onFocusedIdChange?.(id);
      if (focusedIdProp === undefined) setFocusedIdState(id);
    },
    [focusedIdProp, onFocusedIdChange],
  );
  const [stageWidthPx, setStageWidthPx] = useState(0);

  const liveSources = useMemo(
    () =>
      sources.filter(
        (row) =>
          !streamLooksLikePlaceholderVideo(row.stream) &&
          row.stream
            .getVideoTracks()
            .some((t) => t.readyState === "live" && t.enabled && !t.muted),
      ),
    [sources],
  );

  const sourceKey = liveSources.map((row) => row.id).join("|");

  useEffect(() => {
    if (liveSources.length === 0) {
      setFocusedId(null);
      return;
    }
    if (focusedId && !liveSources.some((row) => row.id === focusedId)) {
      setFocusedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-validate on roster churn
  }, [sourceKey]);

  if (Platform.OS !== "web" || !active || liveSources.length === 0) return null;

  const allowFocus = wideLayout;
  const focused =
    allowFocus && focusedId
      ? liveSources.find((row) => row.id === focusedId) ?? null
      : null;
  const showFocus = Boolean(focused);
  const pips = focused ? liveSources.filter((row) => row.id !== focused.id) : [];
  const fitSingle =
    fitSingleToContent && !fillHeight && !showFocus && liveSources.length === 1;
  const singleAspect = fitSingle ? aspectRatioFromSource(liveSources[0]!) : 16 / 9;
  const fittedHeightPx =
    fitSingle && stageWidthPx > 0
      ? Math.min(maxHeightPx, Math.max(1, Math.round(stageWidthPx / singleAspect)))
      : null;

  const shellStyle = fillHeight
    ? {
        flex: 1,
        alignSelf: "stretch" as const,
        width: "100%" as const,
        minHeight: 120,
        paddingHorizontal: horizontalInsetPx,
        marginBottom: marginBottomPx,
        overflow: "hidden" as const,
      }
    : fitSingle
      ? {
          alignSelf: "stretch" as const,
          width: "100%" as const,
          paddingHorizontal: horizontalInsetPx,
          marginBottom: marginBottomPx,
          height: fittedHeightPx ?? undefined,
          maxHeight: maxHeightPx,
          aspectRatio: fittedHeightPx == null ? singleAspect : undefined,
          overflow: "hidden" as const,
        }
      : {
          alignSelf: "stretch" as const,
          width: "100%" as const,
          paddingHorizontal: horizontalInsetPx,
          marginBottom: marginBottomPx,
          height: maxHeightPx,
          maxHeight: maxHeightPx,
          overflow: "hidden" as const,
        };

  return (
    <View
      style={shellStyle}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== stageWidthPx) setStageWidthPx(w);
      }}
    >
      {showFocus && focused ? (
        <View style={{ flex: 1, minHeight: 0, width: "100%", position: "relative" }}>
          <MediaTile
            source={focused}
            active={active}
            speaking={Boolean(focused.speaking) && !focused.muted}
            onPress={() => setFocusedId(null)}
            accessibilityLabel={
              focused.label
                ? `${focused.label} — tap to show all shares`
                : "Tap to show all screen shares"
            }
          />
          {!externalPips && pips.length > 0 ? (
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                width: "22%",
                minWidth: 88,
                maxWidth: 140,
                maxHeight: "78%",
                zIndex: 2,
                gap: TILE_GAP_PX,
                overflow: "auto" as const,
              }}
            >
              {pips.map((pip) => (
                <View
                  key={`focus-pip:${pip.id}`}
                  style={{ width: "100%", aspectRatio: 16 / 9 }}
                >
                  <MediaTile
                    source={pip}
                    active={active}
                    speaking={Boolean(pip.speaking) && !pip.muted}
                    compact
                    onPress={() => setFocusedId(pip.id)}
                    accessibilityLabel={
                      pip.label ? `Show ${pip.label}` : "Show this screen share"
                    }
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
        <MosaicGrid
          sources={liveSources}
          active={active}
          wide={wideLayout}
          fillParent={fitSingle}
          onSelect={(id) => {
            if (allowFocus) setFocusedId(id);
          }}
        />
      )}
    </View>
  );
}

type LegacyProps = {
  stream: MediaStream | null;
  active: boolean;
  maxHeightPx?: number;
  horizontalInsetPx?: number;
  marginBottomPx?: number;
};

function MessageChatVoiceVideoPlaneInner({
  stream,
  active,
  maxHeightPx = MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  horizontalInsetPx = 0,
  marginBottomPx = 0,
}: LegacyProps) {
  const sources = useMemo<VoiceMediaStageSource[]>(() => {
    if (!stream || streamLooksLikePlaceholderVideo(stream)) return [];
    const tracks = stream.getVideoTracks().filter((t) => t.readyState === "live" && t.enabled);
    if (tracks.length <= 1) {
      return [{ id: "remote", stream, kind: "screen" }];
    }
    return tracks
      .map((track, index) => {
        const single = new MediaStream([track]);
        if (streamLooksLikePlaceholderVideo(single)) return null;
        return {
          id: `remote:${track.id || index}`,
          stream: single,
          kind: "screen" as const,
        };
      })
      .filter((row): row is VoiceMediaStageSource => row != null);
  }, [stream]);

  return (
    <MessageChatVoiceMediaStageInner
      sources={sources}
      active={active}
      maxHeightPx={maxHeightPx}
      horizontalInsetPx={horizontalInsetPx}
      marginBottomPx={marginBottomPx}
    />
  );
}

export const MessageChatVoiceVideoPlane = memo(MessageChatVoiceVideoPlaneInner);
export const MessageChatVoiceMediaStage = memo(MessageChatVoiceMediaStageInner);
export const MessageChatVoiceMediaPipColumnMemo = memo(MessageChatVoiceMediaPipColumn);
