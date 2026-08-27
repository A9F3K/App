import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import type { TelegramProfilePhotoMarkup } from "../../../shared/telegramProfilePhoto";
import {
  profilePhotoFillCss,
  profilePhotoFillFallbackColor,
} from "../../../shared/telegramProfilePhoto";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import type { NetworkFetchPriority } from "./networkFetchQueue";
import {
  isMessageChatAvatarBlobCached,
  isMessageChatAvatarFetchFailed,
  loadMessageChatAvatarObjectUrl,
  MessageChatAvatarImage,
} from "./MessageChatAvatarImage";
import { MessageChatInlineTgsEmoji } from "./MessageChatInlineTgsEmoji";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

/** Exact 1px stroke; divider / chrome color is `colors.highlight`. */
const AVATAR_BORDER_WIDTH_PX = 1;
/** Chat-list / voice preview: gap between face and the active ring. */
const VOICE_RING_GAP_PX = 1;
/** Chat-list / voice preview: outer active ring thickness. */
const VOICE_RING_WIDTH_PX = 1;

const VOICE_RING_STYLE_ID = "hsp-voice-active-ring-style";
/** Active voice chat ring — Telegram-style blue (call live, not joined). */
const VOICE_RING_BLUE = "#3390EC";
const VOICE_RING_BLUE_BRIGHT = "#6BB6FF";
const VOICE_RING_BLUE_DEEP = "#1A5FB4";
/** Joined voice chat ring — iOS green (same as speaking mic). */
const VOICE_RING_GREEN = "#34C759";
const VOICE_RING_GREEN_BRIGHT = "#7AE28A";
const VOICE_RING_GREEN_DEEP = "#1F8F3A";
export const MESSAGE_CHAT_ACTIVE_VOICE_RING_COLOR = VOICE_RING_BLUE;
export const MESSAGE_CHAT_JOINED_VOICE_RING_COLOR = VOICE_RING_GREEN;
/** Outward extent of the live/speaking ring past the face (gap + stroke). */
export const MESSAGE_CHAT_VOICE_RING_OUTSET_PX =
  VOICE_RING_GAP_PX + VOICE_RING_WIDTH_PX;

/** Web: animate gradient stop colors in place — no transform/rotation on the ring. */
function ensureActiveVoiceRingCss(): void {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  if (document.getElementById(VOICE_RING_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = VOICE_RING_STYLE_ID;
  el.textContent = `
@property --hsp-vr-a { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_BLUE}; }
@property --hsp-vr-b { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_BLUE_BRIGHT}; }
@property --hsp-vr-c { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_BLUE_DEEP}; }
@keyframes hsp-voice-ring-colors {
  0%   { --hsp-vr-a: ${VOICE_RING_BLUE}; --hsp-vr-b: ${VOICE_RING_BLUE_BRIGHT}; --hsp-vr-c: ${VOICE_RING_BLUE_DEEP}; }
  33%  { --hsp-vr-a: ${VOICE_RING_BLUE_BRIGHT}; --hsp-vr-b: ${VOICE_RING_BLUE_DEEP}; --hsp-vr-c: ${VOICE_RING_BLUE}; }
  66%  { --hsp-vr-a: ${VOICE_RING_BLUE_DEEP}; --hsp-vr-b: ${VOICE_RING_BLUE}; --hsp-vr-c: ${VOICE_RING_BLUE_BRIGHT}; }
  100% { --hsp-vr-a: ${VOICE_RING_BLUE}; --hsp-vr-b: ${VOICE_RING_BLUE_BRIGHT}; --hsp-vr-c: ${VOICE_RING_BLUE_DEEP}; }
}
@keyframes hsp-voice-ring-colors-joined {
  0%   { --hsp-vr-a: ${VOICE_RING_GREEN}; --hsp-vr-b: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-c: ${VOICE_RING_GREEN_DEEP}; }
  33%  { --hsp-vr-a: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-b: ${VOICE_RING_GREEN_DEEP}; --hsp-vr-c: ${VOICE_RING_GREEN}; }
  66%  { --hsp-vr-a: ${VOICE_RING_GREEN_DEEP}; --hsp-vr-b: ${VOICE_RING_GREEN}; --hsp-vr-c: ${VOICE_RING_GREEN_BRIGHT}; }
  100% { --hsp-vr-a: ${VOICE_RING_GREEN}; --hsp-vr-b: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-c: ${VOICE_RING_GREEN_DEEP}; }
}
[data-hsp-voice-ring="1"],
[data-hsp-voice-ring="joined"] {
  background-image: conic-gradient(
    from 0deg,
    var(--hsp-vr-a),
    var(--hsp-vr-b),
    var(--hsp-vr-c),
    var(--hsp-vr-a)
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  box-sizing: border-box;
  pointer-events: none;
}
[data-hsp-voice-ring="1"] {
  --hsp-vr-a: ${VOICE_RING_BLUE};
  --hsp-vr-b: ${VOICE_RING_BLUE_BRIGHT};
  --hsp-vr-c: ${VOICE_RING_BLUE_DEEP};
  animation: hsp-voice-ring-colors 2.2s linear infinite;
}
[data-hsp-voice-ring="joined"] {
  --hsp-vr-a: ${VOICE_RING_GREEN};
  --hsp-vr-b: ${VOICE_RING_GREEN_BRIGHT};
  --hsp-vr-c: ${VOICE_RING_GREEN_DEEP};
  animation: hsp-voice-ring-colors-joined 2.2s linear infinite;
}
`;
  document.head.appendChild(el);
}

type Props = {
  iconUrl: string | null;
  initials: string[];
  sizePx: number;
  colors: ThemeColors;
  scheme: ThemeName;
  /** When false, skip proxy fetch (e.g. row off-screen). */
  loadEnabled?: boolean;
  fetchPriority?: NetworkFetchPriority;
  /** Override avatar ring (e.g. active voice → logo green). */
  borderColor?: string;
  /**
   * Live voice in chat list / voice preview: keep the face at `sizePx`, then
   * 1px transparent gap, then a 1px ring outside (does not shrink the avatar).
   * On web the ring is a fixed conic gradient whose stop colors animate
   * (no border rotation).
   */
  activeVoiceRing?: boolean;
  /** Participating in the live call — green ring instead of blue. */
  joinedVoiceRing?: boolean;
  onLoad?: () => void;
  onError?: (error?: unknown) => void;
  /** Default `cover`; use `contain` for decorative preset / SVG feed icons. */
  imageContentFit?: "cover" | "contain";
  /** Custom-emoji profile photo on a Telegram-generated background. */
  profilePhoto?: TelegramProfilePhotoMarkup | null;
  /** MPEG4/WebM loop from `chatPhoto.animation` (`/api/telegram-messages-avatar?animated=1`). */
  animatedIconUrl?: string | null;
  emojiFetchEnabled?: boolean;
  /** When false, omit the 1px highlight frame (e.g. fullscreen photo viewer). */
  framed?: boolean;
};

/** Telegram: custom-emoji chat photos occupy at most 67% of the generated fill. */
const PROFILE_PHOTO_EMOJI_RATIO = 0.67;

function AvatarAnimationLayer({
  uri,
  loadEnabled,
  onReady,
  onError,
}: {
  uri: string;
  loadEnabled: boolean;
  onReady: () => void;
  onError: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!loadEnabled) return;
    if (isMessageChatAvatarFetchFailed(uri)) {
      onErrorRef.current();
      return;
    }
    let cancelled = false;
    void loadMessageChatAvatarObjectUrl(uri).then((next) => {
      if (cancelled) return;
      if (next) {
        setSrc(next);
        return;
      }
      onErrorRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [loadEnabled, uri]);

  if (!src || Platform.OS !== "web") return null;
  return createElement("video", {
    src,
    autoPlay: true,
    loop: true,
    muted: true,
    playsInline: true,
    ref: (node: { play?: () => Promise<void> } | null) => {
      if (node?.play) void node.play().catch(() => {});
    },
    onLoadedData: () => onReadyRef.current(),
    onError: () => onErrorRef.current(),
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
    },
  });
}

/** Letter fallback always visible; proxy / data URL image overlays when loaded. */
export function MessageChatAvatarSlot({
  iconUrl,
  initials,
  sizePx,
  colors,
  scheme,
  loadEnabled = true,
  fetchPriority = "normal",
  borderColor,
  activeVoiceRing = false,
  joinedVoiceRing = false,
  onLoad,
  onError,
  imageContentFit = "cover",
  profilePhoto = null,
  animatedIconUrl = null,
  emojiFetchEnabled = true,
  framed = true,
}: Props) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [imageReady, setImageReady] = useState(
    () => Boolean(iconUrl && isMessageChatAvatarBlobCached(iconUrl)),
  );
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [stickerMediaReady, setStickerMediaReady] = useState(false);

  const customEmojiId = profilePhoto?.custom_emoji_id?.trim() || null;
  const fill = profilePhoto?.fill ?? null;
  const hasAnimation = Boolean(profilePhoto?.has_animation && animatedIconUrl);
  const useStickerPhoto = Boolean(customEmojiId);
  const markStickerReady = useCallback(() => setStickerMediaReady(true), []);

  useEffect(() => {
    setLoadFailed(false);
    setImageReady(Boolean(iconUrl && isMessageChatAvatarBlobCached(iconUrl)));
    setVideoReady(false);
    setVideoFailed(false);
    setStickerMediaReady(false);
  }, [animatedIconUrl, customEmojiId, iconUrl]);

  useEffect(() => {
    if (activeVoiceRing) ensureActiveVoiceRingCss();
  }, [activeVoiceRing]);

  useEffect(() => {
    if (!customEmojiId && !hasAnimation) return;
    telegramEmojiDebug.profilePhotoAvatar({
      context: "avatar_slot",
      customEmojiId,
      fillKind: fill?.kind ?? null,
      hasAnimation,
    });
  }, [customEmojiId, fill?.kind, hasAnimation]);

  const tryVideo = hasAnimation && !videoFailed && Boolean(animatedIconUrl);
  const animationPainted = videoReady || stickerMediaReady;
  /** Keep the static JPEG visible until the animated face (emoji or MPEG4) is ready. */
  const tryImage =
    Boolean(iconUrl) &&
    !loadFailed &&
    !isMessageChatAvatarFetchFailed(iconUrl ?? "") &&
    !animationPainted;
  const webBox = Platform.OS === "web"
    ? ({ boxSizing: "border-box", lineHeight: 0 } as const)
    : null;

  const showFrame = framed && !activeVoiceRing;
  const faceContentSizePx = showFrame
    ? Math.max(1, sizePx - AVATAR_BORDER_WIDTH_PX * 2)
    : sizePx;
  const emojiSizePx = Math.max(12, Math.round(faceContentSizePx * PROFILE_PHOTO_EMOJI_RATIO));

  const showFallback =
    !imageReady && !animationPainted && (!tryImage || loadFailed) && !useStickerPhoto;

  const face = (
    <View
      style={{
        width: sizePx,
        height: sizePx,
        position: "relative",
        overflow: "hidden",
        ...(showFrame
          ? {
              borderWidth: AVATAR_BORDER_WIDTH_PX,
              borderColor: borderColor ?? colors.highlight,
              borderStyle: "solid" as const,
            }
          : null),
        ...webBox,
      }}
    >
      {showFallback ? (
        <ChatAvatarFallback
          initials={initials}
          sizePx={faceContentSizePx}
          colors={colors}
          scheme={scheme}
          fill
        />
      ) : null}
      {tryImage ? (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              zIndex: 1,
              opacity: imageReady ? 1 : 0,
              backgroundColor: imageReady ? colors.undercover : "transparent",
            },
          ]}
        >
          <MessageChatAvatarImage
            key={iconUrl ?? "no-avatar"}
            uri={iconUrl!}
            sizePx={faceContentSizePx}
            fill
            loadEnabled={loadEnabled}
            fetchPriority={fetchPriority}
            onLoad={() => {
              setImageReady(true);
              onLoad?.();
            }}
            onError={(error) => {
              setLoadFailed(true);
              onError?.(error);
            }}
            contentFit={imageContentFit}
          />
        </View>
      ) : null}
      {tryVideo && animatedIconUrl ? (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { zIndex: 2, opacity: videoReady ? 1 : 0 },
          ]}
        >
          <AvatarAnimationLayer
            uri={animatedIconUrl}
            loadEnabled={loadEnabled}
            onReady={() => {
              setVideoReady(true);
              onLoad?.();
            }}
            onError={() => setVideoFailed(true)}
          />
        </View>
      ) : null}
      {useStickerPhoto && customEmojiId && !videoReady ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            {
              zIndex: 3,
              alignItems: "center",
              justifyContent: "center",
              opacity: stickerMediaReady ? 1 : 0,
            },
          ]}
        >
          {stickerMediaReady && fill
            ? Platform.OS === "web"
              ? createElement("div", {
                  style: {
                    position: "absolute",
                    inset: 0,
                    zIndex: 0,
                    pointerEvents: "none",
                    backgroundImage: profilePhotoFillCss(fill),
                    backgroundColor: profilePhotoFillFallbackColor(fill),
                    backgroundRepeat: "no-repeat",
                    backgroundSize: "cover",
                  },
                })
              : (
                  <View
                    pointerEvents="none"
                    style={[
                      StyleSheet.absoluteFillObject,
                      { zIndex: 0, backgroundColor: profilePhotoFillFallbackColor(fill) },
                    ]}
                  />
                )
            : null}
          <MessageChatInlineTgsEmoji
            customEmojiId={customEmojiId}
            sizePx={emojiSizePx}
            priority
            fetchEnabled={emojiFetchEnabled && loadEnabled}
            suppressFallback
            onMediaReady={markStickerReady}
          />
        </View>
      ) : null}
    </View>
  );

  if (!activeVoiceRing) {
    return face;
  }

  const ringColor = borderColor ?? (joinedVoiceRing ? VOICE_RING_GREEN : VOICE_RING_BLUE);
  const outerPx =
    sizePx + (VOICE_RING_GAP_PX + VOICE_RING_WIDTH_PX) * 2;
  const inset = -(VOICE_RING_GAP_PX + VOICE_RING_WIDTH_PX);
  const gapOuterPx = sizePx + VOICE_RING_GAP_PX * 2;
  const useGradientAnim = Platform.OS === "web";

  return (
    <View
      style={{
        width: outerPx,
        height: outerPx,
        margin: inset,
        position: "relative",
        overflow: "visible",
        ...(useGradientAnim
          ? null
          : {
              borderWidth: VOICE_RING_WIDTH_PX,
              borderColor: ringColor,
              borderStyle: "solid" as const,
            }),
        ...webBox,
      }}
    >
      {useGradientAnim ? (
        <View
          pointerEvents="none"
          // RN-web: data-* for CSS ring mask + color-stop animation (no rotate).
          {...({ dataSet: { hspVoiceRing: joinedVoiceRing ? "joined" : "1" } } as object)}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: outerPx,
            height: outerPx,
            padding: VOICE_RING_WIDTH_PX,
            ...webBox,
          }}
        />
      ) : null}
      <View
        style={{
          width: gapOuterPx,
          height: gapOuterPx,
          margin: useGradientAnim ? VOICE_RING_WIDTH_PX : 0,
          borderWidth: VOICE_RING_GAP_PX,
          borderColor: "rgba(0,0,0,0)",
          borderStyle: "solid",
          ...webBox,
        }}
      >
        {face}
      </View>
    </View>
  );
}
