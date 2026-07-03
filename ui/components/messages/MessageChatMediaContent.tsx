import { useEffect, useRef, useState } from "react";
import { createElement } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Image } from "expo-image";
import type { ThemeColors } from "../../theme";
import type { MessageChatContentKind } from "./messageChatHistoryTypes";
import {
  MESSAGE_BUBBLE_GIF_MAX_PX,
  MESSAGE_BUBBLE_MEDIA_MAX_WIDTH_PX,
  MESSAGE_BUBBLE_MEDIA_PREVIEW_PROGRESS_HEIGHT_PX,
  MESSAGE_BUBBLE_MEDIA_PROGRESS_HEIGHT_PX,
  MESSAGE_BUBBLE_MEDIA_PROGRESS_SLOT_HEIGHT_PX,
  MESSAGE_BUBBLE_STICKER_MAX_PX,
} from "./messageChatLayout";
import { bytesLookLikeTgs, bytesLookLikeVideo } from "./loadTgsAnimation";
import { deferRevokeObjectUrl } from "./deferRevokeObjectUrl";
import { MessageChatTgsSticker } from "./MessageChatTgsSticker";
import {
  logMessageMediaDebug,
  logMessageMediaFetchError,
  logMessageMediaFetchResult,
} from "./messageMediaDebug";

type Props = {
  uri: string;
  contentKind: MessageChatContentKind;
  widthPx: number;
  heightPx: number;
  /** Column cap — used to pixel-fit GIFs/stickers from intrinsic file dimensions. */
  maxWidthPx?: number;
  colors: ThemeColors;
  onDisplaySizeChange?: (widthPx: number, heightPx: number) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PHOTO_MIN_LAYOUT_WIDTH_PX = 120;
const PHOTO_FULL_MAX_ATTEMPTS = 1;
const VIDEO_FULL_MAX_ATTEMPTS = 8;

function photoMetadataLooksLikeThumbnail(width: number, height: number): boolean {
  return width < PHOTO_MIN_LAYOUT_WIDTH_PX && height < PHOTO_MIN_LAYOUT_WIDTH_PX;
}

function photoIntrinsicLooksLikeThumbnail(
  intrinsic: { width: number; height: number },
  layoutCapPx: number,
): boolean {
  return (
    intrinsic.width < PHOTO_MIN_LAYOUT_WIDTH_PX &&
    intrinsic.height < PHOTO_MIN_LAYOUT_WIDTH_PX &&
    layoutCapPx >= PHOTO_MIN_LAYOUT_WIDTH_PX
  );
}

function photoIntrinsicIsFullSize(intrinsic: { width: number; height: number }): boolean {
  return (
    intrinsic.width >= PHOTO_MIN_LAYOUT_WIDTH_PX || intrinsic.height >= PHOTO_MIN_LAYOUT_WIDTH_PX
  );
}

function photoBytesLookFullSize(
  bytes: Uint8Array,
  intrinsic: { width: number; height: number } | null,
): boolean {
  if (intrinsic && photoIntrinsicIsFullSize(intrinsic)) return true;
  // Minithumbnails are tiny; full Telegram photos are usually much larger.
  return bytes.length >= 12_000;
}

function isPixelPerfectMediaKind(contentKind: MessageChatContentKind): boolean {
  return contentKind === "animation" || contentKind === "sticker";
}

function shouldMeasureIntrinsicMediaSize(contentKind: MessageChatContentKind): boolean {
  return isPixelPerfectMediaKind(contentKind) || contentKind === "photo" || contentKind === "video";
}

function measureWebMediaIntrinsicSize(
  url: string,
  kind: ResolvedMediaKind,
): Promise<{ width: number; height: number } | null> {
  if (Platform.OS !== "web") return Promise.resolve(null);

  return new Promise((resolve) => {
    if (kind === "video") {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      const finish = (width: number, height: number) => {
        video.removeAttribute("src");
        video.load();
        video.remove();
        resolve(width > 0 && height > 0 ? { width, height } : null);
      };
      video.onloadedmetadata = () => finish(video.videoWidth, video.videoHeight);
      video.onerror = () => finish(0, 0);
      video.src = url;
      return;
    }

    const img = document.createElement("img");
    const finish = (width: number, height: number) => {
      img.removeAttribute("src");
      img.remove();
      resolve(width > 0 && height > 0 ? { width, height } : null);
    };
    img.onload = () => finish(img.naturalWidth, img.naturalHeight);
    img.onerror = () => finish(0, 0);
    img.src = url;
  });
}

type ResolvedMediaKind = "tgs" | "video" | "gif" | "image";

function isStreamableVideoContentKind(contentKind: MessageChatContentKind): boolean {
  return contentKind === "video" || contentKind === "animation";
}

export function resolvePreviewMediaUrl(uri: string): string {
  if (/[?&]preview=1(?:&|$)/.test(uri)) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}preview=1`;
}

async function fetchMediaBlob(
  uri: string,
  phase: "preview" | "full",
  debugContext?: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; mime: string; response: Response }> {
  logMessageMediaDebug("fetch_start", { phase, uri, ...debugContext });
  let response: Response;
  try {
    response = await fetch(uri, { method: "GET", credentials: "include" });
  } catch (err) {
    logMessageMediaFetchError(phase, uri, err, debugContext);
    throw err;
  }
  if (!response.ok) {
    logMessageMediaFetchError(phase, uri, new Error(`HTTP_${response.status}`), {
      httpStatus: response.status,
      ...debugContext,
    });
    throw new Error(`HTTP_${response.status}`);
  }
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const mime = (blob.type || response.headers.get("Content-Type") || "").trim();
  logMessageMediaFetchResult(phase, uri, response, bytes, debugContext);
  return { bytes, mime, response };
}

function createObjectUrl(bytes: Uint8Array, mime: string, kind: ResolvedMediaKind): string {
  const blobType =
    kind === "video"
      ? mime.startsWith("video/")
        ? mime
        : "video/mp4"
      : kind === "tgs"
        ? "application/x-tgsticker"
        : mime || "application/octet-stream";
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: blobType }));
}

export function messageMediaShowsProgressBar(contentKind: MessageChatContentKind): boolean {
  return contentKind === "video" || contentKind === "animation";
}

function MediaProgressBar({
  widthPx,
  progress,
  colors,
  heightPx = MESSAGE_BUBBLE_MEDIA_PROGRESS_HEIGHT_PX,
}: {
  widthPx: number;
  progress: number;
  colors: ThemeColors;
  heightPx?: number;
}) {
  const clamped = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return (
    <View
      style={{
        width: widthPx,
        height: heightPx,
        backgroundColor: colors.highlight,
      }}
    >
      <View
        style={{
          width: widthPx * clamped,
          height: heightPx,
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}

function resolveMediaKind(
  bytes: Uint8Array,
  contentKind: MessageChatContentKind,
  mime: string,
): ResolvedMediaKind {
  const normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime === "application/x-tgsticker" || bytesLookLikeTgs(bytes)) {
    return "tgs";
  }
  if (
    normalizedMime.startsWith("video/") ||
    bytesLookLikeVideo(bytes) ||
    ((contentKind === "video" || contentKind === "animation") && bytesLookLikeVideo(bytes))
  ) {
    return "video";
  }
  if (normalizedMime === "image/gif") return "gif";
  if (contentKind === "sticker" && bytesLookLikeVideo(bytes)) return "video";
  return "image";
}

function WebMessageChatVideo({
  src,
  posterSrc,
  widthPx,
  heightPx,
  colors,
  loop,
  showProgress,
  pixelPerfect,
}: {
  src?: string | null;
  posterSrc?: string | null;
  widthPx: number;
  heightPx: number;
  colors: ThemeColors;
  loop: boolean;
  showProgress: boolean;
  pixelPerfect?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [posterVisible, setPosterVisible] = useState(Boolean(posterSrc));

  useEffect(() => {
    setPosterVisible(Boolean(posterSrc));
  }, [posterSrc, src]);

  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || !src) return;

    const playIfVisible = () => {
      video.muted = true;
      const rect = container.getBoundingClientRect();
      const viewportH = window.innerHeight || document.documentElement.clientHeight;
      const visible =
        rect.bottom > 0 &&
        rect.top < viewportH &&
        rect.width > 0 &&
        rect.height > 0;
      if (visible) {
        void video.play().catch(() => {});
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: [0, 0.05, 0.15, 0.35, 0.6, 1] },
    );
    observer.observe(container);

    const syncProgress = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        setProgress(0);
        return;
      }
      setProgress(Math.max(0, Math.min(1, video.currentTime / duration)));
    };

    const onPlaying = () => {
      setPosterVisible(false);
    };
    const onLoadedData = () => {
      playIfVisible();
    };
    const onLoadedMetadata = () => {
      setProgress(0);
      playIfVisible();
    };
    const onCanPlay = () => {
      playIfVisible();
    };
    const onEnded = () => {
      if (loop) setProgress(0);
    };

    video.defaultMuted = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("canplaythrough", onCanPlay);
    video.addEventListener("timeupdate", syncProgress);
    video.addEventListener("seeking", syncProgress);
    video.addEventListener("ended", onEnded);
    video.load();
    playIfVisible();

    return () => {
      observer.disconnect();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("canplaythrough", onCanPlay);
      video.removeEventListener("timeupdate", syncProgress);
      video.removeEventListener("seeking", syncProgress);
      video.removeEventListener("ended", onEnded);
    };
  }, [src, loop]);

  return createElement(
    "div",
    {
      key: src ?? posterSrc ?? "video",
      ref: containerRef,
      style: {
        width: widthPx,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      },
    },
    posterVisible && posterSrc
      ? createElement("img", {
          src: posterSrc,
          alt: "",
          width: widthPx,
          height: heightPx,
          style: {
            width: widthPx,
            height: heightPx,
            display: "block",
            position: src ? ("absolute" as const) : ("relative" as const),
            inset: src ? 0 : undefined,
            zIndex: 1,
            pointerEvents: "none",
            borderRadius: 0,
            ...(pixelPerfect
              ? ({ objectFit: "cover", imageRendering: "crisp-edges" } as object)
              : ({ objectFit: "cover" } as object)),
          },
        })
      : null,
    src
      ? createElement("video", {
          key: src,
          ref: videoRef,
          src,
          playsInline: true,
          muted: true,
          defaultMuted: true,
          loop,
          autoPlay: true,
          preload: "auto",
          disablePictureInPicture: true,
          style: {
            width: widthPx,
            height: heightPx,
            display: "block",
            position: "relative",
            zIndex: 0,
            borderRadius: 0,
            ...(pixelPerfect
              ? ({ imageRendering: "crisp-edges" } as object)
              : ({ objectFit: "cover" } as object)),
          },
        })
      : null,
    showProgress
      ? createElement(
          "div",
          {
            style: {
              width: widthPx,
              height: MESSAGE_BUBBLE_MEDIA_PROGRESS_SLOT_HEIGHT_PX,
              backgroundColor: colors.highlight,
              position: "relative",
              overflow: "hidden",
              flexShrink: 0,
            },
          },
          createElement("div", {
            style: {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              width: `${Math.max(0, Math.min(100, progress * 100))}%`,
              height: posterVisible
                ? MESSAGE_BUBBLE_MEDIA_PREVIEW_PROGRESS_HEIGHT_PX
                : MESSAGE_BUBBLE_MEDIA_PROGRESS_HEIGHT_PX,
              backgroundColor: colors.accent,
            },
          }),
        )
      : null,
  );
}

function WebMessageChatPhotoImage({
  src,
  widthPx,
  heightPx,
  fillFrame = false,
}: {
  src: string;
  widthPx: number;
  heightPx: number;
  /** Upscale tiny preview thumbs to fill the layout frame (no blur). */
  fillFrame?: boolean;
}) {
  return createElement("img", {
    src,
    alt: "",
    style: {
      width: widthPx,
      height: heightPx,
      maxWidth: widthPx,
      display: "block",
      borderRadius: 0,
      objectFit: fillFrame ? "cover" : "contain",
      ...(fillFrame ? ({ imageRendering: "pixelated" } as object) : null),
    },
  });
}

function WebMessageChatGifImage({
  src,
  widthPx,
  heightPx,
}: {
  src: string;
  widthPx: number;
  heightPx: number;
}) {
  return createElement("img", {
    src,
    alt: "",
    width: widthPx,
    height: heightPx,
    style: {
      width: widthPx,
      height: heightPx,
      display: "block",
      borderRadius: 0,
      imageRendering: "crisp-edges",
    },
  });
}

export function MessageChatMediaContent({
  uri,
  contentKind,
  widthPx,
  heightPx,
  maxWidthPx,
  colors,
  onDisplaySizeChange,
}: Props) {
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [mediaBytes, setMediaBytes] = useState<Uint8Array | null>(null);
  const [mediaKind, setMediaKind] = useState<ResolvedMediaKind | null>(null);
  const [displayWidthPx, setDisplayWidthPx] = useState(widthPx);
  const [displayHeightPx, setDisplayHeightPx] = useState(heightPx);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const showProgress = messageMediaShowsProgressBar(contentKind);
  const pixelPerfect = isPixelPerfectMediaKind(contentKind);
  const usesVideoPreview = isStreamableVideoContentKind(contentKind);

  useEffect(() => {
    onDisplaySizeChange?.(displayWidthPx, displayHeightPx);
  }, [displayWidthPx, displayHeightPx, onDisplaySizeChange]);

  useEffect(() => {
    if (mediaUri) return;
    setDisplayWidthPx(widthPx);
    setDisplayHeightPx(heightPx);
  }, [widthPx, heightPx, maxWidthPx, mediaUri]);

  useEffect(() => {
    let cancelled = false;
    let mediaObjectUrl: string | null = null;
    let previewObjectUrl: string | null = null;
    setLoading(true);
    setFailed(false);
    setMediaUri(null);
    setPreviewUri(null);
    setMediaBytes(null);
    setMediaKind(null);
    setDisplayWidthPx(widthPx);
    setDisplayHeightPx(heightPx);

    const layoutCapPx = Math.max(maxWidthPx ?? widthPx, widthPx, PHOTO_MIN_LAYOUT_WIDTH_PX);
    const debugContext = {
      contentKind,
      layoutWidthPx: widthPx,
      layoutHeightPx: heightPx,
      layoutCapPx,
      maxWidthPx: maxWidthPx ?? null,
    };
    logMessageMediaDebug("mount", { uri, ...debugContext });

    const applyIntrinsicDimensions = async (
      objectUrl: string,
      measureKind: ResolvedMediaKind,
    ) => {
      if (!shouldMeasureIntrinsicMediaSize(contentKind)) return;
      const intrinsic = await measureWebMediaIntrinsicSize(objectUrl, measureKind);
      if (cancelled || !intrinsic) return;
      if (
        contentKind === "photo" &&
        photoIntrinsicLooksLikeThumbnail(intrinsic, layoutCapPx) &&
        widthPx >= PHOTO_MIN_LAYOUT_WIDTH_PX
      ) {
        return;
      }
      const fitted = scaleMediaDimensions(
        intrinsic.width,
        intrinsic.height,
        layoutCapPx,
        contentKind,
      );
      setDisplayWidthPx(fitted.widthPx);
      setDisplayHeightPx(fitted.heightPx);
    };

    void (async () => {
      let photoLoadSettled = false;
      try {
        if (usesVideoPreview) {
          const hasPreviewRef = { current: false };

          void (async () => {
            try {
              const { bytes, mime } = await fetchMediaBlob(
                resolvePreviewMediaUrl(uri),
                "preview",
                debugContext,
              );
              if (cancelled) return;
              previewObjectUrl = createObjectUrl(bytes, mime, "image");
              hasPreviewRef.current = true;
              setPreviewUri(previewObjectUrl);
              await applyIntrinsicDimensions(previewObjectUrl, "image");
              if (!cancelled) setLoading(false);
            } catch {
              /* preview is optional */
            }
          })();

          const loadFullVideo = async (): Promise<void> => {
            for (let attempt = 0; attempt < VIDEO_FULL_MAX_ATTEMPTS && !cancelled; attempt++) {
              try {
                const { bytes, mime } = await fetchMediaBlob(uri, "full", debugContext);
                if (cancelled) return;
                const kind = resolveMediaKind(bytes, contentKind, mime);
                if (kind !== "video") throw new Error("VIDEO_NOT_READY");
                mediaObjectUrl = createObjectUrl(bytes, mime, kind);
                await applyIntrinsicDimensions(mediaObjectUrl, "video");
                if (cancelled) return;
                setMediaBytes(bytes);
                setMediaKind(kind);
                setMediaUri(mediaObjectUrl);
                setLoading(false);
                return;
              } catch {
                await sleep(Math.min(500 * (attempt + 1), 3000));
              }
            }
            if (!cancelled && !hasPreviewRef.current) setFailed(true);
          };

          void loadFullVideo();
          return;
        }

        if (contentKind === "photo") {
          const previewPromise = (async () => {
            try {
              const { bytes, mime } = await fetchMediaBlob(
                resolvePreviewMediaUrl(uri),
                "preview",
                debugContext,
              );
              if (cancelled) return;
              previewObjectUrl = createObjectUrl(bytes, mime, "image");
              setPreviewUri(previewObjectUrl);
              await applyIntrinsicDimensions(previewObjectUrl, "image");
            } catch (previewError) {
              logMessageMediaDebug("fetch_error", {
                phase: "preview",
                uri: resolvePreviewMediaUrl(uri),
                error:
                  previewError instanceof Error ? previewError.message : String(previewError),
                ...debugContext,
              });
            }
          })();

          for (let attempt = 0; attempt < PHOTO_FULL_MAX_ATTEMPTS && !cancelled; attempt++) {
            try {
              const { bytes, mime } = await fetchMediaBlob(uri, "full", {
                ...debugContext,
                attempt: attempt + 1,
              });
              if (cancelled) return;
              const kind = resolveMediaKind(bytes, contentKind, mime);
              if (mediaObjectUrl) deferRevokeObjectUrl(mediaObjectUrl);
              mediaObjectUrl = createObjectUrl(bytes, mime, kind);
              const intrinsic = await measureWebMediaIntrinsicSize(
                mediaObjectUrl,
                kind === "video" ? "video" : "image",
              );
              if (cancelled) return;
              if (photoBytesLookFullSize(bytes, intrinsic)) {
                logMessageMediaDebug("photo_full_accepted", {
                  uri,
                  attempt: attempt + 1,
                  intrinsicWidth: intrinsic?.width ?? null,
                  intrinsicHeight: intrinsic?.height ?? null,
                  byteLength: bytes.length,
                  ...debugContext,
                });
                await applyIntrinsicDimensions(
                  mediaObjectUrl,
                  kind === "video" ? "video" : kind === "gif" ? "gif" : "image",
                );
                if (cancelled) return;
                setMediaBytes(bytes);
                setMediaKind(kind);
                setMediaUri(mediaObjectUrl);
                break;
              }
              logMessageMediaDebug(
                "photo_full_rejected_thumbnail",
                {
                  uri,
                  attempt: attempt + 1,
                  intrinsicWidth: intrinsic?.width ?? null,
                  intrinsicHeight: intrinsic?.height ?? null,
                  byteLength: bytes.length,
                  ...debugContext,
                },
                "warn",
              );
              deferRevokeObjectUrl(mediaObjectUrl);
              mediaObjectUrl = null;
              logMessageMediaDebug(
                "photo_full_give_up_thumbnail_only",
                { uri, byteLength: bytes.length, attempt: attempt + 1, ...debugContext },
                "warn",
              );
              break;
            } catch (fullError) {
              logMessageMediaDebug("fetch_error", {
                phase: "full",
                uri,
                error: fullError instanceof Error ? fullError.message : String(fullError),
                attempt: attempt + 1,
                ...debugContext,
              });
              break;
            }
          }

          await previewPromise;
          if (cancelled) return;
          if (!mediaObjectUrl && !previewObjectUrl) {
            setFailed(true);
          }
          setLoading(false);
          photoLoadSettled = true;
        } else {
          const { bytes, mime } = await fetchMediaBlob(uri, "full", debugContext);
          if (cancelled) return;
          const kind = resolveMediaKind(bytes, contentKind, mime);
          mediaObjectUrl = createObjectUrl(bytes, mime, kind);
          await applyIntrinsicDimensions(
            mediaObjectUrl,
            kind === "video" ? "video" : kind === "gif" ? "gif" : "image",
          );
          if (cancelled) return;
          setMediaBytes(bytes);
          setMediaKind(kind);
          setMediaUri(mediaObjectUrl);
        }
      } catch {
        if (!cancelled && contentKind !== "photo") setFailed(true);
      } finally {
        if (!cancelled && !photoLoadSettled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      deferRevokeObjectUrl(mediaObjectUrl);
      deferRevokeObjectUrl(previewObjectUrl);
    };
  }, [contentKind, uri, usesVideoPreview]);

  const frameStyle = {
    width: displayWidthPx,
    height: displayHeightPx,
    overflow: "hidden" as const,
    backgroundColor: "transparent",
    borderRadius: 0,
  };

  if (loading && !previewUri) {
    return (
      <View>
        <View style={[frameStyle, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
        {usesVideoPreview && showProgress ? (
          <View
            style={{
              width: displayWidthPx,
              height: MESSAGE_BUBBLE_MEDIA_PROGRESS_SLOT_HEIGHT_PX,
              backgroundColor: colors.highlight,
            }}
          />
        ) : null}
      </View>
    );
  }

  if (
    contentKind === "photo" &&
    Platform.OS === "web" &&
    (previewUri || mediaUri)
  ) {
    const showingPreviewOnly = Boolean(previewUri && !mediaUri);
    return (
      <View style={[frameStyle, { overflow: "hidden" }]}>
        {showingPreviewOnly ? (
          <WebMessageChatPhotoImage
            src={previewUri!}
            widthPx={displayWidthPx}
            heightPx={displayHeightPx}
            fillFrame
          />
        ) : (
          <WebMessageChatPhotoImage
            src={mediaUri!}
            widthPx={displayWidthPx}
            heightPx={displayHeightPx}
          />
        )}
      </View>
    );
  }

  if (failed && !previewUri && (!mediaUri || !mediaKind)) {
    return (
      <View>
        <View style={[frameStyle, { backgroundColor: colors.highlight }]} />
        {showProgress ? (
          <MediaProgressBar widthPx={displayWidthPx} progress={0} colors={colors} />
        ) : null}
      </View>
    );
  }

  if (usesVideoPreview && Platform.OS === "web" && (previewUri || mediaUri)) {
    return (
      <WebMessageChatVideo
        src={mediaUri}
        posterSrc={previewUri}
        widthPx={displayWidthPx}
        heightPx={displayHeightPx}
        colors={colors}
        loop
        showProgress={showProgress}
        pixelPerfect={pixelPerfect}
      />
    );
  }

  if (contentKind === "photo" && previewUri && !mediaUri) {
    return (
      <View>
        <Image
          source={{ uri: previewUri }}
          accessibilityIgnoresInvertColors
          style={{
            width: displayWidthPx,
            height: displayHeightPx,
          }}
          contentFit="contain"
        />
      </View>
    );
  }

  if (!mediaUri || !mediaKind) {
    return (
      <View>
        <View style={[frameStyle, { backgroundColor: colors.highlight }]} />
        {showProgress ? (
          <MediaProgressBar widthPx={displayWidthPx} progress={0} colors={colors} />
        ) : null}
      </View>
    );
  }

  if (mediaKind === "tgs" && mediaBytes) {
    return (
      <MessageChatTgsSticker
        data={mediaBytes}
        widthPx={displayWidthPx}
        heightPx={displayHeightPx}
      />
    );
  }

  if (mediaKind === "gif" && Platform.OS === "web") {
    return (
      <View>
        <WebMessageChatGifImage
          src={mediaUri}
          widthPx={displayWidthPx}
          heightPx={displayHeightPx}
        />
        {showProgress ? (
          <MediaProgressBar widthPx={displayWidthPx} progress={0} colors={colors} />
        ) : null}
      </View>
    );
  }

  if (mediaKind === "image" && contentKind === "photo" && Platform.OS === "web") {
    return (
      <View>
        <WebMessageChatPhotoImage
          src={mediaUri}
          widthPx={displayWidthPx}
          heightPx={displayHeightPx}
        />
      </View>
    );
  }

  return (
    <View>
      <Image
        source={{ uri: mediaUri }}
        accessibilityIgnoresInvertColors
        style={{
          width: displayWidthPx,
          height: displayHeightPx,
        }}
        contentFit={contentKind === "photo" ? "contain" : pixelPerfect ? "fill" : "cover"}
      />
      {showProgress ? (
        <MediaProgressBar widthPx={displayWidthPx} progress={0} colors={colors} />
      ) : null}
    </View>
  );
}

function scaleMediaDimensions(
  sourceW: number,
  sourceH: number,
  maxWidthPx: number,
  contentKind?: MessageChatContentKind,
): { widthPx: number; heightPx: number } {
  const pixelPerfect = isPixelPerfectMediaKind(contentKind ?? "other");
  let maxW = Math.min(maxWidthPx, MESSAGE_BUBBLE_MEDIA_MAX_WIDTH_PX);
  if (contentKind === "sticker") {
    maxW = Math.min(maxW, MESSAGE_BUBBLE_STICKER_MAX_PX);
  } else if (contentKind === "animation") {
    maxW = Math.min(maxW, MESSAGE_BUBBLE_GIF_MAX_PX);
  }

  const nativeW = Math.max(1, Math.round(sourceW));
  const nativeH = Math.max(1, Math.round(sourceH));

  if (pixelPerfect || contentKind === "photo") {
    let fitW = nativeW;
    let fitH = nativeH;
    if (contentKind === "photo" && fitH > 480) {
      const scale = 480 / fitH;
      fitW = Math.max(1, Math.round(fitW * scale));
      fitH = 480;
    }
    if (fitW <= maxW) {
      return { widthPx: fitW, heightPx: fitH };
    }
    const scale = maxW / fitW;
    return {
      widthPx: Math.max(1, Math.round(fitW * scale)),
      heightPx: Math.max(1, Math.round(fitH * scale)),
    };
  }

  if (contentKind === "video") {
    if (nativeW <= maxW) {
      return { widthPx: nativeW, heightPx: nativeH };
    }
    const scale = maxW / nativeW;
    return {
      widthPx: Math.max(1, Math.round(nativeW * scale)),
      heightPx: Math.max(1, Math.round(nativeH * scale)),
    };
  }

  let widthPx = nativeW;
  let heightPx = nativeH;
  if (widthPx > maxW) {
    const scale = maxW / widthPx;
    widthPx = Math.max(1, Math.round(nativeW * scale));
    heightPx = Math.max(1, Math.round(nativeH * scale));
  }
  return { widthPx, heightPx };
}

function mediaLoadingPlaceholderDimensions(
  maxWidthPx: number,
  contentKind?: MessageChatContentKind,
): { widthPx: number; heightPx: number } {
  let maxW = Math.min(maxWidthPx, MESSAGE_BUBBLE_MEDIA_MAX_WIDTH_PX);
  if (contentKind === "sticker") {
    maxW = Math.min(maxW, MESSAGE_BUBBLE_STICKER_MAX_PX);
    return { widthPx: maxW, heightPx: maxW };
  }
  if (contentKind === "animation") {
    maxW = Math.min(maxW, MESSAGE_BUBBLE_GIF_MAX_PX);
  } else if (contentKind === "photo" || contentKind === "video") {
    maxW = Math.min(maxW, 320);
  }
  if (contentKind === "video") {
    return { widthPx: maxW, heightPx: Math.max(1, Math.round((maxW * 9) / 16)) };
  }
  return { widthPx: maxW, heightPx: Math.max(1, Math.round(maxW * 0.75)) };
}

export function resolveMessageMediaDimensions(
  maxWidthPx: number,
  mediaWidth: number | null | undefined,
  mediaHeight: number | null | undefined,
  contentKind?: MessageChatContentKind,
): { widthPx: number; heightPx: number } {
  const sourceW = Math.round(Number(mediaWidth));
  const sourceH = Math.round(Number(mediaHeight));
  if (
    Number.isFinite(sourceW) &&
    Number.isFinite(sourceH) &&
    sourceW > 0 &&
    sourceH > 0 &&
    !(contentKind === "photo" && photoMetadataLooksLikeThumbnail(sourceW, sourceH))
  ) {
    return scaleMediaDimensions(sourceW, sourceH, maxWidthPx, contentKind);
  }
  const pixelPerfect = isPixelPerfectMediaKind(contentKind ?? "other");
  if (pixelPerfect || contentKind === "photo" || contentKind === "video") {
    return mediaLoadingPlaceholderDimensions(maxWidthPx, contentKind);
  }
  let widthPx = Math.min(maxWidthPx, MESSAGE_BUBBLE_MEDIA_MAX_WIDTH_PX);
  if (contentKind === "sticker") {
    widthPx = Math.min(widthPx, MESSAGE_BUBBLE_STICKER_MAX_PX);
  } else if (contentKind === "animation") {
    widthPx = Math.min(widthPx, MESSAGE_BUBBLE_GIF_MAX_PX);
  }
  const fallbackHeight = Math.round(widthPx * 0.75);
  return { widthPx, heightPx: fallbackHeight };
}

export function messageMediaBlockHeightPx(
  mediaHeightPx: number,
  contentKind: MessageChatContentKind,
): number {
  return (
    mediaHeightPx +
    (messageMediaShowsProgressBar(contentKind) ? MESSAGE_BUBBLE_MEDIA_PROGRESS_HEIGHT_PX : 0)
  );
}
