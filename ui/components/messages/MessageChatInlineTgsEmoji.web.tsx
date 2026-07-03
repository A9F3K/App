import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { deferRevokeObjectUrl } from "./deferRevokeObjectUrl";
import {
  fetchTelegramEmojiAsset,
  type TelegramEmojiFetchRef,
} from "./fetchTelegramEmojiBytes";
import { bytesLookLikeTgs } from "./loadTgsAnimation";
import { getCachedTgsAnimationFromBytes } from "./tgsAnimationCache";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { TgsCanvasPlayer } from "./TgsCanvasPlayer.web";
import { telegramEmojiDebug } from "./telegramEmojiDebug";
import { useElementVisible } from "./useElementVisible";
import { MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS } from "./messageChatLayout";

type Props = {
  customEmojiId?: string;
  emoji?: string;
  sizePx: number;
  fallbackText?: string;
  lowPriority?: boolean;
  /** Premium/status emoji beside usernames — always paint even when off-screen. */
  priority?: boolean;
  /** Parent can defer fetches until the row is visible. */
  fetchEnabled?: boolean;
  /** Wide sticker replacing a word (e.g. styled "Alipay") — not a square pictograph. */
  textLabel?: boolean;
};

function lottieRenderSize(animationData: object, heightPx: number): { widthPx: number; heightPx: number } {
  const w = (animationData as { w?: number }).w ?? 512;
  const h = (animationData as { h?: number }).h ?? 512;
  if (!h || h <= 0) return { widthPx: heightPx, heightPx };
  return { widthPx: Math.max(heightPx, Math.round((heightPx * w) / h)), heightPx };
}

function resolveFetchRef(props: Props): TelegramEmojiFetchRef | null {
  const customEmojiId = props.customEmojiId?.trim();
  if (customEmojiId) return { kind: "custom", customEmojiId };
  const emoji = props.emoji?.trim();
  if (emoji) return { kind: "animated", emoji };
  return null;
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isLikelyCustomEmojiPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/\p{Extended_Pictographic}/u.test(trimmed)) return false;
  if (trimmed.length <= 2) {
    const codePoint = trimmed.codePointAt(0);
    if (codePoint == null) return true;
    if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return true;
  }
  return false;
}

/** Inline Telegram emoji sticker (.tgs / .webm / static) on web. */
export function MessageChatInlineTgsEmoji(props: Props) {
  const {
    sizePx,
    fallbackText = "",
    lowPriority = false,
    priority = false,
    fetchEnabled = true,
    textLabel = false,
  } = props;
  const fetchRef = useMemo(() => resolveFetchRef(props), [props.customEmojiId, props.emoji]);
  const { emojiFetchEpoch } = useTelegramMessagesConnection();
  const hostRef = useRef<HTMLSpanElement>(null);
  const visible = useElementVisible(hostRef as RefObject<Element | null>, {
    enabled: !priority,
    rootMargin: "96px",
  });
  const shouldFetch = priority
    ? fetchEnabled
    : lowPriority
      ? fetchEnabled || visible
      : fetchEnabled && visible;
  const [animationData, setAnimationData] = useState<object | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<"video" | "image" | null>(null);
  const [fetchSettled, setFetchSettled] = useState(false);

  const displayFallback = useMemo(() => {
    const fromEmoji = props.emoji?.trim();
    if (fromEmoji) return fromEmoji;
    const trimmed = fallbackText.trim();
    if (trimmed && !isLikelyCustomEmojiPlaceholder(trimmed)) return trimmed;
    return "🎭";
  }, [fallbackText, props.emoji]);

  useEffect(() => {
    setAnimationData(null);
    setMediaUrl((current) => {
      deferRevokeObjectUrl(current);
      return null;
    });
    setMediaKind(null);
    setFetchSettled(false);
  }, [fetchRef]);

  useEffect(() => {
    if (!fetchRef || shouldFetch || animationData || mediaUrl) return;
    if (!visible && !priority && !lowPriority) return;

    let cancelled = false;
    void fetchTelegramEmojiAsset(fetchRef, { priority: priority ? "high" : "normal" })
      .then(async (asset) => {
        if (cancelled || !asset) return;
        if (
          asset.mime === "application/x-tgsticker" ||
          asset.mime.endsWith("+tgs") ||
          bytesLookLikeTgs(asset.bytes)
        ) {
          const parsed = await getCachedTgsAnimationFromBytes(asset.bytes);
          if (!cancelled) setAnimationData(parsed);
          return;
        }
        if (isVideoMime(asset.mime)) {
          const blob = new Blob([Uint8Array.from(asset.bytes)], { type: asset.mime });
          const url = URL.createObjectURL(blob);
          if (!cancelled) {
            setMediaUrl(url);
            setMediaKind("video");
          } else {
            deferRevokeObjectUrl(url);
          }
          return;
        }
        if (isImageMime(asset.mime)) {
          const blob = new Blob([Uint8Array.from(asset.bytes)], { type: asset.mime });
          const url = URL.createObjectURL(blob);
          if (!cancelled) {
            setMediaUrl(url);
            setMediaKind("image");
          } else {
            deferRevokeObjectUrl(url);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setFetchSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [animationData, fetchRef, lowPriority, mediaUrl, priority, shouldFetch, visible]);

  useEffect(() => {
    let cancelled = false;

    if (!fetchRef) {
      telegramEmojiDebug.inlineNoRef("web", props);
      return;
    }
    if (!shouldFetch) {
      telegramEmojiDebug.fetchSkipped(fetchRef, {
        fetchEnabled,
        priority,
        lowPriority,
        visible,
      });
      return;
    }

    void fetchTelegramEmojiAsset(fetchRef, { priority: priority ? "high" : "normal" })
      .then(async (asset) => {
        if (cancelled) return;
        if (!asset) {
          telegramEmojiDebug.inlineAssetNull(fetchRef, "web");
          return;
        }
        if (
          asset.mime === "application/x-tgsticker" ||
          asset.mime.endsWith("+tgs") ||
          bytesLookLikeTgs(asset.bytes)
        ) {
          telegramEmojiDebug.inlineDecode(fetchRef, "tgs", asset.mime, asset.bytes.length);
          try {
            const parsed = await getCachedTgsAnimationFromBytes(asset.bytes);
            if (!cancelled) setAnimationData(parsed);
          } catch (err) {
            telegramEmojiDebug.inlineTgsParseFail(fetchRef, err);
          }
          return;
        }
        if (isVideoMime(asset.mime)) {
          telegramEmojiDebug.inlineDecode(fetchRef, "video", asset.mime, asset.bytes.length);
          const blob = new Blob([Uint8Array.from(asset.bytes)], { type: asset.mime });
          const url = URL.createObjectURL(blob);
          if (!cancelled) {
            setMediaUrl(url);
            setMediaKind("video");
          } else {
            deferRevokeObjectUrl(url);
          }
          return;
        }
        if (isImageMime(asset.mime)) {
          telegramEmojiDebug.inlineDecode(fetchRef, "image", asset.mime, asset.bytes.length);
          const blob = new Blob([Uint8Array.from(asset.bytes)], { type: asset.mime });
          const url = URL.createObjectURL(blob);
          if (!cancelled) {
            setMediaUrl(url);
            setMediaKind("image");
          } else {
            deferRevokeObjectUrl(url);
          }
          return;
        }
        telegramEmojiDebug.inlineDecode(fetchRef, "unsupported", asset.mime, asset.bytes.length);
      })
      .catch((err) => {
        telegramEmojiDebug.fetchNetworkError(fetchRef, err);
      })
      .finally(() => {
        if (!cancelled) setFetchSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchRef, shouldFetch, emojiFetchEpoch]);

  useEffect(() => {
    if (!fetchRef || !fetchSettled || animationData || mediaUrl) return;
    telegramEmojiDebug.inlineFallback(fetchRef, displayFallback, "web_after_fetch");
  }, [animationData, displayFallback, fetchRef, fetchSettled, mediaUrl]);

  useEffect(() => {
    return () => {
      deferRevokeObjectUrl(mediaUrl);
    };
  }, [mediaUrl]);

  const hostStyle: CSSProperties = textLabel
    ? {
        display: "inline-block",
        height: sizePx,
        width: "auto",
        maxWidth: "100%",
        verticalAlign: MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS,
        lineHeight: 1,
        position: "relative",
        flexShrink: 0,
        overflow: "visible",
      }
    : {
        display: "inline-block",
        width: sizePx,
        height: sizePx,
        verticalAlign: MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS,
        lineHeight: 1,
        position: "relative",
        flexShrink: 0,
        overflow: "visible",
      };

  const mediaReady = Boolean(animationData || mediaUrl);
  const labelFallback =
    textLabel && displayFallback && displayFallback !== "🎭" ? displayFallback : null;
  const showUnicodeFallback = Boolean(!mediaReady && displayFallback);
  const tgsSize = animationData ? lottieRenderSize(animationData, sizePx) : null;
  const rasterStyle: CSSProperties = textLabel
    ? { height: sizePx, width: "auto", display: "block", objectFit: "contain" }
    : {
        width: sizePx,
        height: sizePx,
        display: "block",
        objectFit: "contain",
        position: "relative",
        zIndex: 1,
      };

  return (
    <span ref={hostRef} style={hostStyle}>
      {showUnicodeFallback && !textLabel ? (
        <span
          aria-hidden={mediaReady}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: Math.round(sizePx * 0.88),
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          {displayFallback}
        </span>
      ) : null}
      {animationData && tgsSize ? (
        <TgsCanvasPlayer
          animationData={animationData}
          widthPx={tgsSize.widthPx}
          heightPx={tgsSize.heightPx}
          lowPriority={lowPriority}
          priority={priority || lowPriority}
          style={{
            display: "block",
            width: tgsSize.widthPx,
            height: tgsSize.heightPx,
          }}
        />
      ) : null}
      {mediaUrl && mediaKind === "video" ? (
        <video src={mediaUrl} autoPlay loop muted playsInline style={rasterStyle} />
      ) : null}
      {mediaUrl && mediaKind === "image" ? (
        <img src={mediaUrl} alt={displayFallback} style={rasterStyle} />
      ) : null}
      {showUnicodeFallback && textLabel && labelFallback ? (
        <span
          style={{
            fontSize: sizePx,
            lineHeight: `${sizePx}px`,
            whiteSpace: "nowrap",
            display: "inline-block",
            verticalAlign: MESSAGE_INLINE_EMOJI_VERTICAL_ALIGN_CSS,
          }}
        >
          {labelFallback}
        </span>
      ) : null}
    </span>
  );
}
