import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import { hairlineBorderWidthPx } from "../../scrollIndicatorPx";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import type { NetworkFetchPriority } from "./networkFetchQueue";
import { isMessageChatAvatarBlobCached, isMessageChatAvatarFetchFailed, MessageChatAvatarImage } from "./MessageChatAvatarImage";

type Props = {
  iconUrl: string | null;
  initials: string[];
  sizePx: number;
  colors: ThemeColors;
  scheme: ThemeName;
  /** When false, skip proxy fetch (e.g. row off-screen). */
  loadEnabled?: boolean;
  fetchPriority?: NetworkFetchPriority;
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

  const tryImage =
    Boolean(iconUrl) && !loadFailed && !isMessageChatAvatarFetchFailed(iconUrl ?? "");
  const avatarBorderWidth = hairlineBorderWidthPx();
  // Web: inset shadow draws on top of full-size content (no layout inset).
  // Native: border consumes inner space — size content to the padding box.
  const contentSizePx =
    Platform.OS === "web"
      ? sizePx
      : Math.max(1, sizePx - avatarBorderWidth * 2);

  return (
    <View
      style={{
        width: sizePx,
        height: sizePx,
        position: "relative",
        overflow: "hidden",
        ...(Platform.OS === "web"
          ? { boxShadow: `inset 0 0 0 ${avatarBorderWidth}px ${colors.highlight}` }
          : {
              borderWidth: avatarBorderWidth,
              borderColor: colors.highlight,
              borderStyle: "solid",
            }),
      }}
    >
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: contentSizePx,
          height: contentSizePx,
        }}
      >
        <ChatAvatarFallback
          initials={initials}
          sizePx={contentSizePx}
          colors={colors}
          scheme={scheme}
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
              sizePx={contentSizePx}
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
    </View>
  );
}
