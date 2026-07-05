import { useEffect, useRef, type RefObject } from "react";
import { View } from "react-native";
import { debounceLeading } from "../../util/debounceLeading";
import { MESSAGE_LIST_SENSITIVE_AREA_PX } from "./messageChatLayout";
import { useElementVisible } from "./useElementVisible";

const MESSAGE_HISTORY_SENTINEL_DEBOUNCE_MS = 300;

type Props = {
  edge: "top" | "bottom";
  enabled: boolean;
  onTrigger: () => void;
};

/** Zero-height sentinel for open-chat history pagination (telegram-tt useScrollHooks). */
export function MessageHistoryLoadSentinel({ edge, enabled, onTrigger }: Props) {
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

  const visible = useElementVisible(ref as RefObject<Element | null>, {
    rootMargin: `${MESSAGE_LIST_SENSITIVE_AREA_PX}px`,
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
