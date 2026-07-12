import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ThemeColors, ThemeName } from "../../theme";
import { ChatAvatarFallback } from "./ChatAvatarFallback";
import type { NetworkFetchPriority } from "./networkFetchQueue";
import { isMessageChatAvatarBlobCached, isMessageChatAvatarFetchFailed, MessageChatAvatarImage } from "./MessageChatAvatarImage";

/** Exact 1px stroke; divider / chrome color is `colors.highlight`. */
const AVATAR_BORDER_WIDTH_PX = 1;

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
  const border = AVATAR_BORDER_WIDTH_PX;
  const contentSizePx = Math.max(1, sizePx - border * 2);

  return (
    <View
      style={{
        width: sizePx,
        height: sizePx,
        position: "relative",
        overflow: "hidden",
        borderWidth: border,
        borderColor: colors.highlight,
        borderStyle: "solid",
        ...(Platform.OS === "web"
          ? ({ boxSizing: "border-box", lineHeight: 0 } as const)
          : null),
      }}
    >
      <ChatAvatarFallback
        initials={initials}
        sizePx={contentSizePx}
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
            sizePx={contentSizePx}
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
}
