import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import type { NetworkFetchPriority } from "./networkFetchQueue";
import { isMessageChatAvatarBlobCached, isMessageChatAvatarFetchFailed, MessageChatAvatarImage } from "./MessageChatAvatarImage";

/** Exact 1px stroke; divider / chrome color is `colors.highlight`. */
const AVATAR_BORDER_WIDTH_PX = 1;
/** Chat-list live voice: gap between face and the active ring. */
const VOICE_RING_GAP_PX = 1;
/** Chat-list live voice: outer active ring thickness. */
const VOICE_RING_WIDTH_PX = 2;

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
   * Live voice in chat list: keep the face at `sizePx`, then 1px transparent
   * gap, then a 2px ring outside (does not shrink the avatar). On web the ring
   * is a fixed conic gradient whose stop colors animate (no border rotation).
   */
  activeVoiceRing?: boolean;
  /** Participating in the live call — green ring instead of blue. */
  joinedVoiceRing?: boolean;
  onLoad?: () => void;
  onError?: (error?: unknown) => void;
  /** Default `cover`; use `contain` for decorative preset / SVG feed icons. */
  imageContentFit?: "cover" | "contain";
};

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
}: Props) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [imageReady, setImageReady] = useState(
    () => Boolean(iconUrl && isMessageChatAvatarBlobCached(iconUrl)),
  );

  useEffect(() => {
    setLoadFailed(false);
    setImageReady(Boolean(iconUrl && isMessageChatAvatarBlobCached(iconUrl)));
  }, [iconUrl]);

  useEffect(() => {
    if (activeVoiceRing) ensureActiveVoiceRingCss();
  }, [activeVoiceRing]);

  const tryImage =
    Boolean(iconUrl) && !loadFailed && !isMessageChatAvatarFetchFailed(iconUrl ?? "");
  const webBox = Platform.OS === "web"
    ? ({ boxSizing: "border-box", lineHeight: 0 } as const)
    : null;

  const faceContentSizePx = activeVoiceRing
    ? sizePx
    : Math.max(1, sizePx - AVATAR_BORDER_WIDTH_PX * 2);

  // Unmount letter fallback once the photo is ready — Reanimated transforms on
  // the fallback can otherwise paint above the image (stacking / translateZ).
  const showFallback = !imageReady || !tryImage;

  const face = (
    <View
      style={{
        width: sizePx,
        height: sizePx,
        position: "relative",
        overflow: "hidden",
        ...(activeVoiceRing
          ? null
          : {
              borderWidth: AVATAR_BORDER_WIDTH_PX,
              borderColor: borderColor ?? colors.highlight,
              borderStyle: "solid" as const,
            }),
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
