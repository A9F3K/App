import { useEffect, useRef } from "react";
import { logPageDisplay } from "../../pageDisplayLog";
import { resolveTelegramLiveStreamUrl } from "../../telegram/resolveTelegramLiveStreamUrl";

type Options = {
  enabled: boolean;
  getSinceRevision: () => number | null;
  onRevision: (revision: number) => void;
};

const STREAM_RECONNECT_MS = 3_000;

/** SSE push — prefers direct gateway; falls back to Vercel proxy. */
export function useTelegramMessagesChatListStream(options: Options): void {
  const { enabled, getSinceRevision, onRevision } = options;
  const onRevisionRef = useRef(onRevision);
  const getSinceRevisionRef = useRef(getSinceRevision);

  useEffect(() => {
    onRevisionRef.current = onRevision;
  }, [onRevision]);

  useEffect(() => {
    getSinceRevisionRef.current = getSinceRevision;
  }, [getSinceRevision]);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let mintAbort: AbortController | null = null;

    const connect = () => {
      if (cancelled) return;
      eventSource?.close();
      mintAbort?.abort();
      mintAbort = new AbortController();

      const sinceRevision = getSinceRevisionRef.current();
      const proxyParams = new URLSearchParams();
      if (sinceRevision != null && sinceRevision > 0) {
        proxyParams.set("since_revision", String(sinceRevision));
      }
      const proxyQuery = proxyParams.toString();
      const proxyPath = proxyQuery
        ? `/api/telegram-messages-chats-stream?${proxyQuery}`
        : "/api/telegram-messages-chats-stream";

      void resolveTelegramLiveStreamUrl({
        stream: "chats",
        proxyPath,
        sinceRevision,
        signal: mintAbort.signal,
      }).then(({ url, mode }) => {
        if (cancelled) return;
        eventSource = new EventSource(url);
        logPageDisplay("messages_chats_stream_connect", {
          sinceRevision: sinceRevision ?? null,
          mode,
        });

        eventSource.addEventListener("revision", (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data) as { revision?: number };
            if (typeof data.revision === "number" && data.revision > 0) {
              onRevisionRef.current(data.revision);
            }
          } catch {
            /* ignore malformed event */
          }
        });

        eventSource.addEventListener("ready", () => {
          logPageDisplay("messages_chats_stream_ready", {
            sinceRevision: getSinceRevisionRef.current(),
            mode,
          });
        });

        eventSource.onerror = () => {
          eventSource?.close();
          eventSource = null;
          if (cancelled) return;
          if (reconnectTimer != null) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, STREAM_RECONNECT_MS);
        };
      });
    };

    connect();

    return () => {
      cancelled = true;
      mintAbort?.abort();
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      eventSource?.close();
    };
  }, [enabled]);
}
