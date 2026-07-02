import { useEffect, useState } from "react";
import { View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import type { NetworkFetchPriority } from "./networkFetchQueue";
import { isMessageChatAvatarBlobCached, MessageChatAvatarImage } from "./MessageChatAvatarImage";

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

  const tryImage = Boolean(iconUrl) && !loadFailed;

  return (
    <View
      style={{
        width: sizePx,
        height: sizePx,
        position: "relative",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ChatAvatarFallback initials={initials} sizePx={sizePx} colors={colors} scheme={scheme} />
      {tryImage ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: sizePx,
            height: sizePx,
            opacity: imageReady ? 1 : 0,
          }}
        >
          <MessageChatAvatarImage
            uri={iconUrl!}
            sizePx={sizePx}
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
}
