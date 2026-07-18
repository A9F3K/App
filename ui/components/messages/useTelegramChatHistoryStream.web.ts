import { useEffect, useRef } from "react";
import { buildApiUrl } from "../../../api/_base";
import { logPageDisplay } from "../../pageDisplayLog";

type Options = {
  enabled: boolean;
  chatId: number;
  getSinceRevision: () => number | null;
  onRevision: (revision: number) => void;
  onStreamActiveChange?: (active: boolean) => void;
};

const STREAM_RECONNECT_MS = 3_000;

/** SSE push from gateway — open-chat history invalidation without waiting on poll. */
export function useTelegramChatHistoryStream(options: Options): void {
  const { enabled, chatId, getSinceRevision, onRevision, onStreamActiveChange } = options;
  const onRevisionRef = useRef(onRevision);
  const getSinceRevisionRef = useRef(getSinceRevision);
  const onStreamActiveChangeRef = useRef(onStreamActiveChange);

  useEffect(() => {
    onRevisionRef.current = onRevision;
  }, [onRevision]);

  useEffect(() => {
    getSinceRevisionRef.current = getSinceRevision;
  }, [getSinceRevision]);

  useEffect(() => {
    onStreamActiveChangeRef.current = onStreamActiveChange;
  }, [onStreamActiveChange]);

  useEffect(() => {
    if (!enabled || !Number.isFinite(chatId) || chatId === 0 || typeof EventSource === "undefined") {
      onStreamActiveChangeRef.current?.(false);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let streamActive = false;

    const setActive = (active: boolean) => {
      if (streamActive === active) return;
      streamActive = active;
      onStreamActiveChangeRef.current?.(active);
    };

    const connect = () => {
      if (cancelled) return;
      eventSource?.close();
      setActive(false);

      const params = new URLSearchParams({ chat_id: String(Math.trunc(chatId)) });
      const sinceRevision = getSinceRevisionRef.current();
      if (sinceRevision != null && sinceRevision > 0) {
        params.set("since_revision", String(sinceRevision));
      }
      const url = buildApiUrl(`/api/telegram-messages-history-stream?${params.toString()}`);

      eventSource = new EventSource(url);
      logPageDisplay("messages_history_stream_connect", {
        chatId,
        sinceRevision: sinceRevision ?? null,
      });

      eventSource.addEventListener("revision", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { revision?: number };
          if (typeof data.revision === "number" && data.revision > 0) {
            setActive(true);
            onRevisionRef.current(data.revision);
          }
        } catch {
          /* ignore malformed event */
        }
      });

      eventSource.addEventListener("ready", () => {
        setActive(true);
        logPageDisplay("messages_history_stream_ready", { chatId });
      });

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        setActive(false);
        if (cancelled) return;
        if (reconnectTimer != null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, STREAM_RECONNECT_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      eventSource?.close();
      setActive(false);
    };
  }, [enabled, chatId]);
}
