import { useEffect, useRef, type RefObject } from "react";
import { View } from "react-native";
import { debounceLeading } from "../../util/debounceLeading";
import {
  MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX,
  MESSAGE_LIST_SENSITIVE_AREA_PX,
} from "./messageChatLayout";
import { useElementVisible } from "./useElementVisible";

const MESSAGE_HISTORY_SENTINEL_DEBOUNCE_MS = 1000;

type Props = {
  edge: "top" | "bottom";
  enabled: boolean;
  onTrigger: () => void;
  /**
   * IntersectionObserver rootMargin (px). Top defaults to older-prefetch floor;
   * pass `chatEdgePrefetchPx(layoutH)` from the parent for 3-screen prefetch.
   */
  rootMarginPx?: number;
};

/** Zero-height sentinel for open-chat history pagination (telegram-tt useScrollHooks). */
export function MessageHistoryLoadSentinel({
  edge,
  enabled,
  onTrigger,
  rootMarginPx,
}: Props) {
  const ref = useRef<View>(null);
  const onTriggerRef = useRef(onTrigger);
  const debouncedRef = useRef(
    debounceLeading(() => {
      onTriggerRef.current();
    }, MESSAGE_HISTORY_SENTINEL_DEBOUNCE_MS),
  );

  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);

  // Top: prefetch older pages before the hard edge. Bottom: keep tight.
  const resolvedMarginPx =
    rootMarginPx ??
    (edge === "top"
      ? MESSAGE_CHAT_LOAD_OLDER_PREFETCH_PX
      : MESSAGE_LIST_SENSITIVE_AREA_PX);

  const visible = useElementVisible(ref as RefObject<Element | null>, {
    rootMargin: `${resolvedMarginPx}px`,
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
      accessibilityElementsHidden
    />
  );
}
