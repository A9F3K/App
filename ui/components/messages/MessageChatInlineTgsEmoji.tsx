import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  fetchTelegramEmojiAsset,
  type TelegramEmojiFetchRef,
} from "./fetchTelegramEmojiBytes";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

type Props = {
  customEmojiId?: string;
  emoji?: string;
  sizePx: number;
  fallbackText?: string;
  lowPriority?: boolean;
  priority?: boolean;
  fetchEnabled?: boolean;
  suppressFallback?: boolean;
  preferStatic?: boolean;
  onMediaReady?: () => void;
};

function resolveFetchRef(props: Props): TelegramEmojiFetchRef | null {
  const customEmojiId = props.customEmojiId?.trim();
  if (customEmojiId) {
    return {
      kind: "custom",
      customEmojiId,
      ...(props.preferStatic ? { preferStatic: true } : {}),
    };
  }
  const emoji = props.emoji?.trim();
  if (emoji) return { kind: "animated", emoji };
  return null;
}

/** Native fallback: Unicode placeholder until TGS/WebM playback is implemented. */
export function MessageChatInlineTgsEmoji({
  customEmojiId,
  emoji,
  sizePx,
  fallbackText = "",
  preferStatic = false,
  suppressFallback = false,
  onMediaReady,
}: Props) {
  const fetchRef = useMemo(
    () => resolveFetchRef({ customEmojiId, emoji, sizePx, fallbackText, preferStatic }),
    [customEmojiId, emoji, sizePx, fallbackText, preferStatic],
  );
  const [loadedFallback, setLoadedFallback] = useState(fallbackText);

  useEffect(() => {
    let cancelled = false;
    if (!fetchRef) {
      telegramEmojiDebug.inlineNoRef("native", { customEmojiId, emoji });
      return;
    }
    void fetchTelegramEmojiAsset(fetchRef)
      .then((asset) => {
        if (cancelled) return;
        if (!asset) {
          telegramEmojiDebug.inlineAssetNull(fetchRef, "native");
          return;
        }
        telegramEmojiDebug.inlineDecode(fetchRef, "unsupported", asset.mime, asset.bytes.length);
        setLoadedFallback(fallbackText || emoji || "🎭");
        onMediaReady?.();
      })
      .catch((err) => {
        telegramEmojiDebug.fetchNetworkError(fetchRef, err);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRef, fallbackText, emoji, onMediaReady]);

  if (suppressFallback) {
    return <View style={{ width: sizePx, height: sizePx }} />;
  }
  if (loadedFallback) {
    return (
      <Text style={{ fontSize: Math.round(sizePx * 0.85), lineHeight: sizePx }}>
        {loadedFallback}
      </Text>
    );
  }
  return <View style={{ width: sizePx, height: sizePx }} />;
}
