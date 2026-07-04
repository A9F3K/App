import { useEffect, useRef, type RefObject } from "react";
import { View } from "react-native";
import { debounceLeading } from "../../util/debounceLeading";
import { useElementVisible } from "./useElementVisible";

const CHAT_LIST_SENTINEL_ROOT_MARGIN_PX = "800px";
const CHAT_LIST_SENTINEL_DEBOUNCE_MS = 600;

type Props = {
  enabled: boolean;
  onNearBottom: () => void;
};

/** Intersection-observer sentinel for chat-list near-bottom expansion (telegram-tt style). */
export function ChatListBottomSentinel({ enabled, onNearBottom }: Props) {
  const ref = useRef<View>(null);
  const onNearBottomRef = useRef(onNearBottom);
  const debouncedRef = useRef(
    debounceLeading(() => {
      onNearBottomRef.current();
    }, CHAT_LIST_SENTINEL_DEBOUNCE_MS),
  );

  useEffect(() => {
    onNearBottomRef.current = onNearBottom;
  }, [onNearBottom]);

  const visible = useElementVisible(ref as RefObject<Element | null>, {
    rootMargin: CHAT_LIST_SENTINEL_ROOT_MARGIN_PX,
    enabled,
  });

  useEffect(() => {
    if (!enabled || !visible) return;
    debouncedRef.current();
  }, [enabled, visible]);

  return (
    <View
      ref={ref}
      style={{ width: "100%", height: 1, opacity: 0 }}
      pointerEvents="none"
    />
  );
}
