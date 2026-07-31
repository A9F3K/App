import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { WEB_UI_SANS_STACK } from "../../fonts";
import { MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX } from "./messageListLayout";

export type VoiceMediaStageSource = {
  id: string;
  stream: MediaStream;
  /** Shown on the full (main) tile only. */
  label?: string;
  kind?: "camera" | "screen";
};

type PlaneProps = {
  stream: MediaStream;
  active: boolean;
  objectFit?: "contain" | "cover";
  onPress?: () => void;
  accessibilityLabel?: string;
  onHasFramesChange?: (hasFrames: boolean) => void;
};

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
    const markFrames = () => {
      const video = videoRef.current;
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      // Treat 2×2 silent canvas as non-content so it never paints a black tile.
      if (video.videoWidth <= 4 && video.videoHeight <= 4) return;
      setHasFrames(true);
    };

    const onTrackUnmute = () => {
      markFrames();
      window.setTimeout(markFrames, 120);
      window.setTimeout(markFrames, 400);
      window.setTimeout(markFrames, 1200);
    };
    const onTrackMute = () => {
      setHasFrames(false);
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

    // WebRTC often reports videoWidth only after several decoded frames —
    // short timeouts alone left the stage at 1×1 despite inbound RTP.
    const poll = window.setInterval(markFrames, 250);
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 20_000);

    const videoEl = el as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
          cancelVideoFrameCallback?: (id: number) => void;
        })
      | null;
    let frameCallbackId = 0;
    const onVideoFrame = () => {
      markFrames();
      if (videoEl?.requestVideoFrameCallback) {
        frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
      }
    };
    if (videoEl?.requestVideoFrameCallback) {
      frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
    }

    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stopPoll);
      if (videoEl?.cancelVideoFrameCallback && frameCallbackId) {
        videoEl.cancelVideoFrameCallback(frameCallbackId);
      }
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

  // Always size the <video> to the tile — a 1×1 element never decodes frames
  // (inbound RTP present, media stage stuck invisible). Opacity gates paint.
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
    <View
      accessibilityLabel={accessibilityLabel}
      style={{ width: "100%", height: "100%" }}
    >
      {videoNode}
    </View>
  );
}

/** Inset of minimized thumbs inside the extended (main) video frame. */
const PIP_INSET_TOP_PX = 12;
const PIP_INSET_RIGHT_PX = 12;
/** Gap between stacked minimized thumbs. */
const PIP_STACK_GAP_PX = 8;

type PipTileProps = {
  source: VoiceMediaStageSource;
  active: boolean;
  onPromote: () => void;
  onHasFramesChange: (id: string, hasFrames: boolean) => void;
  /** Last thumb in the stack — no bottom gap. */
  isLast?: boolean;
};

function PipTile({
  source,
  active,
  onPromote,
  onHasFramesChange,
  isLast = false,
}: PipTileProps) {
  const [hasFrames, setHasFrames] = useState(false);

  useEffect(() => {
    onHasFramesChange(source.id, hasFrames);
  }, [hasFrames, onHasFramesChange, source.id]);

  useEffect(() => {
    setHasFrames(false);
  }, [source.id, source.stream]);

  return (
    <View
      style={{
        width: "100%",
        aspectRatio: 16 / 9,
        backgroundColor: "#000000",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.35)",
        borderRadius: 6,
        overflow: "hidden",
        marginBottom: isLast ? 0 : PIP_STACK_GAP_PX,
        opacity: hasFrames ? 1 : 0.35,
      }}
    >
      <VoiceVideoElement
        key={`pip:${source.id}`}
        stream={source.stream}
        active={active}
        // Fit the whole stream into the thumb box (letterbox if needed).
        objectFit="contain"
        accessibilityLabel="Show this video full size"
        onPress={onPromote}
        onHasFramesChange={setHasFrames}
      />
    </View>
  );
}

type StageProps = {
  sources: VoiceMediaStageSource[];
  active: boolean;
  maxHeightPx?: number;
  horizontalInsetPx?: number;
  marginBottomPx?: number;
  /** Fill the parent height (side-by-side voice dialog) instead of 16:9 stack. */
  fillHeight?: boolean;
};

/**
 * Main + PiP stage for camera / screen-share.
 * Multiple live sources: one full tile + clickable minimized thumbs (promote on press).
 * Name label only on the full tile.
 */
function MessageChatVoiceMediaStageInner({
  sources,
  active,
  maxHeightPx = MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  horizontalInsetPx = 0,
  marginBottomPx = 0,
  fillHeight = false,
}: StageProps) {
  const [mainId, setMainId] = useState<string | null>(null);
  const [mainHasFrames, setMainHasFrames] = useState(false);

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
      setMainId(null);
      return;
    }
    setMainId((prev) => {
      // Local screencast must win — remote muted placeholders used to stick as
      // main and keep the whole stage at 1×1 (PiPs never paint without main frames).
      const localScreen = liveSources.find((row) => row.id === "local-screen");
      if (localScreen) return localScreen.id;
      const localCam = liveSources.find((row) => row.id === "local-camera");
      if (localCam && (!prev || prev.startsWith("remote:"))) return localCam.id;
      if (prev && liveSources.some((row) => row.id === prev)) return prev;
      const screen = liveSources.find((row) => row.kind === "screen");
      return screen?.id ?? liveSources[0]!.id;
    });
  }, [liveSources, sourceKey]);

  useEffect(() => {
    setMainHasFrames(false);
  }, [sourceKey, mainId]);

  if (Platform.OS !== "web" || !active || liveSources.length === 0) return null;

  const main =
    liveSources.find((row) => row.id === mainId) ?? liveSources[0]!;
  const pips = liveSources.filter((row) => row.id !== main.id);
  // Show the stage as soon as we have live unmuted tracks — waiting for
  // videoWidth left a black 1×1 hole despite inboundVideoPackets > 0.
  const mainExpectsFrames = main.stream
    .getVideoTracks()
    .some((t) => t.readyState === "live" && t.enabled && !t.muted);
  const showStage = mainHasFrames || mainExpectsFrames;

  return (
    <View
      style={
        fillHeight
          ? {
              flex: 1,
              alignSelf: "stretch",
              width: "100%",
              minHeight: showStage ? 120 : 0,
              paddingHorizontal: horizontalInsetPx,
              marginBottom: marginBottomPx,
              backgroundColor: "#000000",
              overflow: "hidden",
              position: "relative",
              opacity: showStage ? 1 : 0,
            }
          : {
              alignSelf: "stretch",
              width: "100%",
              paddingHorizontal: horizontalInsetPx,
              marginBottom: marginBottomPx,
              aspectRatio: 16 / 9,
              maxHeight: maxHeightPx,
              backgroundColor: "#000000",
              overflow: "hidden",
              position: "relative",
              opacity: showStage ? 1 : 0,
              // Keep layout space once RTP is live so decoding is not 1×1.
              ...(showStage ? null : { height: 0, marginBottom: 0, maxHeight: 0 }),
            }
      }
    >
      <VoiceVideoElement
        key={`main:${main.id}`}
        stream={main.stream}
        active={active}
        objectFit="contain"
        accessibilityLabel={main.label ? `${main.label} video` : "Voice chat video"}
        onHasFramesChange={setMainHasFrames}
      />
      {showStage && main.label ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            maxWidth: "70%",
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 4,
            backgroundColor: "rgba(0,0,0,0.55)",
            zIndex: 3,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: "#ffffff",
              fontSize: 13,
              lineHeight: 16,
              fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : undefined,
            }}
          >
            {main.label}
          </Text>
        </View>
      ) : null}
      {pips.length > 0 ? (
        <View
          pointerEvents="box-none"
          style={
            showStage
              ? {
                  // Overlay inside the extended main video box — top/right indent.
                  position: "absolute",
                  top: PIP_INSET_TOP_PX,
                  right: PIP_INSET_RIGHT_PX,
                  width: "26%",
                  minWidth: 104,
                  maxWidth: 168,
                  maxHeight: "42%",
                  zIndex: 2,
                  overflow: "hidden",
                }
              : {
                  position: "absolute",
                  width: 1,
                  height: 1,
                  opacity: 0,
                  overflow: "hidden",
                }
          }
        >
          {pips.map((pip, index) => (
            <PipTile
              key={`pip-wrap:${pip.id}`}
              source={pip}
              active={active}
              onPromote={() => setMainId(pip.id)}
              onHasFramesChange={() => undefined}
              isLast={index === pips.length - 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

type LegacyProps = {
  stream: MediaStream | null;
  /** When false (left call / panel hidden), hide the plane. */
  active: boolean;
  /** Override max height (e.g. tighter fit inside the voice dialog). */
  maxHeightPx?: number;
  /** Horizontal inset when embedded in the dialog (default 0 = full-bleed under bar). */
  horizontalInsetPx?: number;
  /** Bottom margin under the plane. */
  marginBottomPx?: number;
};

/**
 * Remote camera / screen-share plane (muted video element — audio uses the session sink).
 * Used under the voice strip and inside the voice dialog.
 */
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
