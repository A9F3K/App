import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import { MESSAGE_CHAT_READ_CHECK_COLOR } from "./messageChatLayout";
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
const VOICE_RING_GREEN = MESSAGE_CHAT_READ_CHECK_COLOR;
const VOICE_RING_GREEN_BRIGHT = "#7CFF6B";
const VOICE_RING_GREEN_DEEP = "#0A6E0A";

/** Web: animate gradient stop colors in place — no transform/rotation on the ring. */
function ensureActiveVoiceRingCss(): void {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  if (document.getElementById(VOICE_RING_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = VOICE_RING_STYLE_ID;
  el.textContent = `
@property --hsp-vr-a { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_GREEN}; }
@property --hsp-vr-b { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_GREEN_BRIGHT}; }
@property --hsp-vr-c { syntax: '<color>'; inherits: false; initial-value: ${VOICE_RING_GREEN_DEEP}; }
@keyframes hsp-voice-ring-colors {
  0%   { --hsp-vr-a: ${VOICE_RING_GREEN}; --hsp-vr-b: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-c: ${VOICE_RING_GREEN_DEEP}; }
  33%  { --hsp-vr-a: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-b: ${VOICE_RING_GREEN_DEEP}; --hsp-vr-c: ${VOICE_RING_GREEN}; }
  66%  { --hsp-vr-a: ${VOICE_RING_GREEN_DEEP}; --hsp-vr-b: ${VOICE_RING_GREEN}; --hsp-vr-c: ${VOICE_RING_GREEN_BRIGHT}; }
  100% { --hsp-vr-a: ${VOICE_RING_GREEN}; --hsp-vr-b: ${VOICE_RING_GREEN_BRIGHT}; --hsp-vr-c: ${VOICE_RING_GREEN_DEEP}; }
}
[data-hsp-voice-ring="1"] {
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
  animation: hsp-voice-ring-colors 2.2s linear infinite;
  box-sizing: border-box;
  pointer-events: none;
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
  onLoad?: () => void;
  onError?: (error?: unknown) => void;
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
  onLoad,
  onError,
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
      <ChatAvatarFallback
        initials={initials}
        sizePx={faceContentSizePx}
        colors={colors}
        scheme={scheme}
        fill
      />
      {tryImage ? (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { opacity: imageReady ? 1 : 0 },
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
          />
        </View>
      ) : null}
    </View>
  );

  if (!activeVoiceRing) {
    return face;
  }

  const ringColor = borderColor ?? colors.highlight;
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
          {...({ dataSet: { hspVoiceRing: "1" } } as object)}
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
