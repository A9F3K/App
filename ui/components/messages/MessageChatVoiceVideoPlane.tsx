import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX } from "./messageListLayout";

export type VoiceMediaStageSource = {
  id: string;
  stream: MediaStream;
};

type PlaneProps = {
  stream: MediaStream;
  active: boolean;
  objectFit?: "contain" | "cover";
  onPress?: () => void;
  accessibilityLabel?: string;
  onHasFramesChange?: (hasFrames: boolean) => void;
};

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
      if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        setHasFrames(true);
      }
    };

    const onTrackUnmute = () => {
      markFrames();
      window.setTimeout(markFrames, 120);
      window.setTimeout(markFrames, 400);
    };

    for (const track of stream.getVideoTracks()) {
      track.addEventListener("unmute", onTrackUnmute);
      if (!track.muted) onTrackUnmute();
    }

    if (el) {
      el.addEventListener("loadeddata", markFrames);
      el.addEventListener("resize", markFrames);
      el.addEventListener("playing", markFrames);
      markFrames();
    }

    return () => {
      for (const track of stream.getVideoTracks()) {
        track.removeEventListener("unmute", onTrackUnmute);
      }
      if (el) {
        el.removeEventListener("loadeddata", markFrames);
        el.removeEventListener("resize", markFrames);
        el.removeEventListener("playing", markFrames);
      }
    };
  }, [active, stream]);

  if (Platform.OS !== "web" || !active || !stream) {
    return null;
  }

  const videoNode = createElement("video", {
    ref: setVideoNode,
    autoPlay: true,
    playsInline: true,
    muted: true,
    controls: false,
    style: hasFrames
      ? {
          width: "100%",
          height: "100%",
          objectFit,
          backgroundColor: "#000000",
          display: "block",
        }
      : {
          width: 1,
          height: 1,
          opacity: 0,
          position: "absolute",
          pointerEvents: "none",
        },
  });

  if (!hasFrames) {
    return <View style={{ width: 1, height: 1, opacity: 0 }}>{videoNode}</View>;
  }

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
 * Main + optional PiP stage for camera / screen-share.
 * With two sources, the second sits top-right; click swaps main ↔ PiP.
 */
function MessageChatVoiceMediaStageInner({
  sources,
  active,
  maxHeightPx = MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  horizontalInsetPx = 0,
  marginBottomPx = 0,
  fillHeight = false,
}: StageProps) {
  const [swapped, setSwapped] = useState(false);
  const [mainHasFrames, setMainHasFrames] = useState(false);
  const liveSources = useMemo(
    () => sources.filter((row) => row.stream.getVideoTracks().some((t) => t.readyState === "live")),
    [sources],
  );

  const sourceKey = liveSources.map((row) => row.id).join("|");

  useEffect(() => {
    if (liveSources.length < 2) setSwapped(false);
  }, [liveSources.length]);

  useEffect(() => {
    setMainHasFrames(false);
  }, [sourceKey, swapped]);

  if (Platform.OS !== "web" || !active || liveSources.length === 0) return null;

  const main = liveSources.length >= 2 && swapped ? liveSources[1]! : liveSources[0]!;
  const pip =
    liveSources.length >= 2 ? (swapped ? liveSources[0]! : liveSources[1]!) : null;

  return (
    <View
      style={
        mainHasFrames
          ? fillHeight
            ? {
                flex: 1,
                alignSelf: "stretch",
                width: "100%",
                minHeight: 0,
                paddingHorizontal: horizontalInsetPx,
                marginBottom: marginBottomPx,
                backgroundColor: "#000000",
                overflow: "hidden",
                position: "relative",
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
            }
          : {
              width: 1,
              height: 1,
              opacity: 0,
              overflow: "hidden",
              alignSelf: "flex-start",
            }
      }
    >
      <VoiceVideoElement
        key={`main:${main.id}`}
        stream={main.stream}
        active={active}
        objectFit="contain"
        accessibilityLabel="Voice chat video"
        onHasFramesChange={setMainHasFrames}
      />
      {pip && mainHasFrames ? (
        <View
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: "28%",
            aspectRatio: 16 / 9,
            minWidth: 96,
            maxWidth: 180,
            backgroundColor: "#000000",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.35)",
            overflow: "hidden",
            zIndex: 2,
          }}
        >
          <VoiceVideoElement
            key={`pip:${pip.id}`}
            stream={pip.stream}
            active={active}
            objectFit="cover"
            accessibilityLabel="Swap video layout"
            onPress={() => setSwapped((prev) => !prev)}
          />
        </View>
      ) : pip ? (
        <VoiceVideoElement
          key={`pip-warm:${pip.id}`}
          stream={pip.stream}
          active={active}
          objectFit="cover"
        />
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
    if (!stream) return [];
    const tracks = stream.getVideoTracks().filter((t) => t.readyState === "live");
    if (tracks.length <= 1) {
      return stream ? [{ id: "remote", stream }] : [];
    }
    return tracks.map((track, index) => ({
      id: `remote:${track.id || index}`,
      stream: new MediaStream([track]),
    }));
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
