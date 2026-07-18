import { createElement, memo, useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX } from "./messageListLayout";

type Props = {
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
 *
 * SFU often delivers muted placeholder tracks before the first keyframe. We keep
 * the element attached but only paint the plane once real frames arrive — avoids
 * a black 16:9 box that also thrash-layouts the voice sheet.
 */
function MessageChatVoiceVideoPlaneInner({
  stream,
  active,
  maxHeightPx = MESSAGE_CHAT_VOICE_VIDEO_MAX_HEIGHT_PX,
  horizontalInsetPx = 0,
  marginBottomPx = 0,
}: Props) {
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

    // Track unmute often lands before decoded frames — still re-check size.
    const onTrackUnmute = () => {
      markFrames();
      // Retry briefly; first keyframe can lag unmute by a few frames.
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

  if (Platform.OS !== "web" || !active || !stream) return null;

  // Keep a zero-size decoding element until frames exist so srcObject stays warm
  // without painting a black sheet that freezes layout in the voice dialog.
  const showPlane = hasFrames;

  return (
    <View
      accessibilityLabel={showPlane ? "Voice chat video" : undefined}
      pointerEvents={showPlane ? "auto" : "none"}
      style={
        showPlane
          ? {
              alignSelf: "stretch",
              width: "100%",
              paddingHorizontal: horizontalInsetPx,
              marginBottom: marginBottomPx,
              aspectRatio: 16 / 9,
              maxHeight: maxHeightPx,
              backgroundColor: "#000000",
              overflow: "hidden",
            }
          : {
              // Non-zero size so the browser still decodes; no layout footprint.
              width: 1,
              height: 1,
              opacity: 0,
              overflow: "hidden",
              alignSelf: "flex-start",
            }
      }
    >
      {createElement("video", {
        ref: setVideoNode,
        autoPlay: true,
        playsInline: true,
        muted: true,
        controls: false,
        style: {
          width: "100%",
          height: "100%",
          objectFit: "contain",
          backgroundColor: "#000000",
          display: "block",
        },
      })}
    </View>
  );
}

export const MessageChatVoiceVideoPlane = memo(MessageChatVoiceVideoPlaneInner);
